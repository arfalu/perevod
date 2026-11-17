import "./style.css";
import { ACCEPT, readFileAsText } from "./files";
import {
  ANALYSIS_LIMIT,
  MODELS,
  analyzeStyle,
  describeError,
  editChunk,
  emptyUsage,
  makeClient,
  splitIntoChunks,
  translateChunk,
  type ModelId,
  type Settings,
  type Usage,
} from "./translator";

// ---------- элементы ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const sourceEl = $<HTMLTextAreaElement>("source");
const notesEl = $<HTMLTextAreaElement>("notes");
const passportEl = $<HTMLTextAreaElement>("passport");
const passportCard = $<HTMLDetailsElement>("passportCard");
const passportState = $("passportState");
const outputEl = $("output");
const fileInput = $<HTMLInputElement>("fileInput");
const dropzone = $("dropzone");
const runBtn = $<HTMLButtonElement>("runBtn");
const stopBtn = $<HTMLButtonElement>("stopBtn");
const clearBtn = $<HTMLButtonElement>("clearBtn");
const copyBtn = $<HTMLButtonElement>("copyBtn");
const txtBtn = $<HTMLButtonElement>("downloadTxtBtn");
const docBtn = $<HTMLButtonElement>("downloadDocBtn");
const progressBox = $("progress");
const progressFill = $("progressFill");
const progressText = $("progressText");
const errorEl = $("error");
const usageEl = $("usage");
const statsEl = $("sourceStats");
const estimateEl = $("estimate");

const dialog = $<HTMLDialogElement>("settingsDialog");
const form = $<HTMLFormElement>("settingsForm");
const apiKeyEl = $<HTMLInputElement>("apiKey");
const modelEl = $<HTMLSelectElement>("model");
const modelHint = $("modelHint");
const fidelityEl = $<HTMLSelectElement>("fidelity");
const effortEl = $<HTMLSelectElement>("effort");
const analyzeEl = $<HTMLInputElement>("analyzeStyle");
const editEl = $<HTMLInputElement>("editPass");
const chunkSizeEl = $<HTMLInputElement>("chunkSize");

fileInput.accept = ACCEPT;

// ---------- хранилище ----------

const SETTINGS_KEY = "perevod.settings.v1";
const STATE_KEY = "perevod.state.v1";

const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "high",
  fidelity: "literary",
  analyzeStyle: true,
  editPass: true,
  chunkSize: 12000,
};

interface Job {
  /** Отпечаток исходного текста и размера фрагмента. */
  key: string;
  chunks: string[];
  drafts: (string | null)[];
  finals: (string | null)[];
}

interface SavedState {
  source: string;
  notes: string;
  passport: string;
  passportFor: string;
  fileName: string;
  job: Job | null;
  usage: Usage;
}

function load<T>(key: string): Partial<T> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<T>;
  } catch {
    return {};
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Переполнение или приватный режим — работаем без сохранения.
  }
}

let settings: Settings = { ...DEFAULT_SETTINGS, ...load<Settings>(SETTINGS_KEY) };
if (!(settings.model in MODELS)) settings.model = DEFAULT_SETTINGS.model;

const saved = load<SavedState>(STATE_KEY);
let job: Job | null = saved.job ?? null;
let passportFor = saved.passportFor ?? "";
let fileName = saved.fileName ?? "";
let usage: Usage = { ...emptyUsage(), ...saved.usage };
sourceEl.value = saved.source ?? "";
notesEl.value = saved.notes ?? "";
passportEl.value = saved.passport ?? "";
if (passportEl.value) passportState.textContent = "· готов";

function persist() {
  save(STATE_KEY, {
    source: sourceEl.value,
    notes: notesEl.value,
    passport: passportEl.value,
    passportFor,
    fileName,
    job,
    usage,
  } satisfies SavedState);
}

// ---------- вспомогательное ----------

function hash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = (Math.imul(h2, 31) + c) | 0;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + s.length.toString(36);
}

function jobKey(source: string, chunkSize: number) {
  return hash(source.trim()) + ":" + chunkSize;
}

function countWords(s: string) {
  return (s.match(/\S+/g) ?? []).length;
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function fmtMoney(x: number) {
  return x < 0.01 ? "<$0.01" : "$" + x.toFixed(x < 1 ? 3 : 2);
}

// ---------- статистика и оценка ----------

function updateStats() {
  const text = sourceEl.value.trim();
  if (!text) {
    statsEl.textContent = "";
    estimateEl.textContent = "";
    updateRunButton();
    return;
  }
  const words = countWords(text);
  const chunks = splitIntoChunks(text, settings.chunkSize).length;
  statsEl.textContent =
    `${words.toLocaleString("ru")} ${plural(words, "слово", "слова", "слов")} · ` +
    `${text.length.toLocaleString("ru")} знаков · ${chunks} ${plural(chunks, "фрагмент", "фрагмента", "фрагментов")}` +
    (fileName ? ` · ${fileName}` : "");

  // Грубая оценка стоимости: английский ≈ 4 знака на токен, русский перевод ≈ 1,6× токенов.
  const p = MODELS[settings.model];
  const src = text.length / 4;
  const sys = 2500;
  const thinkK = settings.effort === "medium" ? 0.4 : settings.effort === "high" ? 0.8 : 1.5;
  let input = chunks * (sys + 1500) + src;
  let output = src * 1.6 + src * thinkK;
  if (settings.analyzeStyle) {
    input += Math.min(text.length, ANALYSIS_LIMIT) / 4 + 1000;
    output += 4000;
  }
  if (settings.editPass) {
    input += chunks * (sys + 1500) + src + src * 1.6;
    output += src * 1.6 + src * thinkK;
  }
  const cost = (input * p.input + output * p.output) / 1_000_000;
  estimateEl.textContent = `ориентировочно ${fmtMoney(cost)} · ${p.label}`;
  updateRunButton();
}

function updateRunButton() {
  const src = sourceEl.value.trim();
  runBtn.disabled = running || !src;
  if (!running && job && src && job.key === jobKey(src, settings.chunkSize)) {
    const done = job.finals.filter((f) => f !== null).length;
    if (done > 0 && done < job.chunks.length) {
      runBtn.textContent = `Продолжить (${done} из ${job.chunks.length} готово)`;
      return;
    }
    if (done === job.chunks.length) {
      runBtn.textContent = "Перевести заново";
      return;
    }
  }
  runBtn.textContent = "Перевести";
}

function updateUsage() {
  if (!usage.input && !usage.output) {
    usageEl.textContent = "";
    return;
  }
  const tok = usage.input + usage.cacheRead + usage.cacheWrite;
  usageEl.textContent =
    `Израсходовано: ${Math.round(tok / 1000)}k входных и ${Math.round(usage.output / 1000)}k выходных токенов ` +
    `· ≈ ${fmtMoney(usage.cost)}`;
}

// ---------- вывод перевода ----------

let streamingIndex = -1;
let streamingText = "";
let renderQueued = false;

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderOutput();
  });
}

function renderOutput() {
  if (!job) {
    return;
  }
  const nearBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 80;
  const frag = document.createDocumentFragment();
  let any = false;

  job.chunks.forEach((_, i) => {
    let main = "";
    let ghost = "";
    if (i === streamingIndex) {
      main = streamingText;
      const draft = job!.drafts[i];
      if (draft && job!.finals[i] === null) {
        // Идёт редактура: показываем ещё не отредактированный хвост черновика бледным.
        const rest = draft.slice(streamingText.length);
        const sp = rest.indexOf(" ");
        ghost = sp >= 0 ? rest.slice(sp) : "";
      }
    } else {
      main = job!.finals[i] ?? "";
      if (!main && job!.drafts[i]) ghost = job!.drafts[i]!;
    }
    if (!main && !ghost) return;
    if (any) frag.append("\n\n");
    any = true;
    if (main) frag.append(main);
    if (ghost) {
      const s = document.createElement("span");
      s.className = "draft-chunk";
      s.textContent = ghost;
      frag.append(s);
    }
  });

  if (!any) return;
  outputEl.replaceChildren(frag);
  if (nearBottom) outputEl.scrollTop = outputEl.scrollHeight;
  const hasText = !!finalText();
  copyBtn.disabled = txtBtn.disabled = docBtn.disabled = !hasText;
}

function finalText(): string {
  if (!job) return "";
  return job.chunks
    .map((_, i) => job!.finals[i] ?? job!.drafts[i] ?? "")
    .filter(Boolean)
    .join("\n\n");
}

function setProgress(done: number, total: number, label: string) {
  progressBox.hidden = false;
  progressFill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  progressText.textContent = label;
}

function showError(msg: string | null) {
  errorEl.hidden = !msg;
  errorEl.textContent = msg ?? "";
}

// ---------- основной процесс ----------

let running = false;
let controller: AbortController | null = null;

async function run() {
  const source = sourceEl.value.trim();
  if (!source) return;
  if (!settings.apiKey) {
    openSettings();
    apiKeyEl.focus();
    return;
  }

  const key = jobKey(source, settings.chunkSize);
  const isFinished = job?.key === key && job.finals.every((f) => f !== null);
  if (!job || job.key !== key || isFinished) {
    const chunks = splitIntoChunks(source, settings.chunkSize);
    job = {
      key,
      chunks,
      drafts: chunks.map(() => null),
      finals: chunks.map(() => null),
    };
    if (!isFinished) usage = emptyUsage();
    outputEl.replaceChildren();
  }

  running = true;
  controller = new AbortController();
  const signal = controller.signal;
  runBtn.disabled = true;
  stopBtn.hidden = false;
  showError(null);
  outputEl.contentEditable = "false";

  const client = makeClient(settings.apiKey);
  const s = { ...settings };
  const notes = notesEl.value;
  const total = job.chunks.length;
  // Шагов: анализ (1) + перевод (N) + редактура (N).
  const steps = (s.analyzeStyle ? 1 : 0) + total * (s.editPass ? 2 : 1);
  let step = 0;
  const textHash = hash(source);

  try {
    // 1. Паспорт стиля
    if (s.analyzeStyle && (passportFor !== textHash || !passportEl.value.trim())) {
      setProgress(0, steps, "Читаю текст целиком и составляю паспорт стиля автора…");
      passportCard.open = true;
      passportState.textContent = "· составляется…";
      passportEl.value = "";
      const passport = await analyzeStyle(
        client,
        s,
        source,
        notes,
        (t) => {
          passportEl.value = t;
          passportEl.scrollTop = passportEl.scrollHeight;
        },
        signal,
        usage,
      );
      passportEl.value = passport;
      passportFor = textHash;
      passportState.textContent = "· готов";
      passportCard.open = false;
      updateUsage();
      persist();
    }
    if (s.analyzeStyle) step++;

    // 2. Перевод и редактура по фрагментам
    for (let i = 0; i < total; i++) {
      const j = job;
      if (j.finals[i] !== null) {
        step += s.editPass ? 2 : 1;
        continue;
      }
      const prevTranslation = i > 0 ? (j.finals[i - 1] ?? j.drafts[i - 1] ?? "") : "";
      const prevSource = i > 0 ? j.chunks[i - 1] : "";
      const passport = passportEl.value;

      if (j.drafts[i] === null) {
        setProgress(step, steps, `Перевожу фрагмент ${i + 1} из ${total}…`);
        streamingIndex = i;
        streamingText = "";
        outputEl.classList.add("streaming");
        const draft = await translateChunk(
          client,
          s,
          { chunk: j.chunks[i], index: i, total, prevSource, prevTranslation, passport, notes },
          (t) => {
            streamingText = t;
            scheduleRender();
          },
          signal,
          usage,
        );
        j.drafts[i] = draft;
        if (!s.editPass) j.finals[i] = draft;
        updateUsage();
        persist();
      }
      step++;

      if (s.editPass && j.finals[i] === null) {
        setProgress(step, steps, `Редактирую фрагмент ${i + 1} из ${total}: сверяю с оригиналом, шлифую язык…`);
        streamingIndex = i;
        streamingText = "";
        const final = await editChunk(
          client,
          s,
          { chunk: j.chunks[i], draft: j.drafts[i]!, prevTranslation, passport, notes },
          (t) => {
            streamingText = t;
            scheduleRender();
          },
          signal,
          usage,
        );
        j.finals[i] = final;
        updateUsage();
        persist();
        step++;
      }
      streamingIndex = -1;
      renderOutput();
    }

    setProgress(1, 1, `Готово: ${total} ${plural(total, "фрагмент", "фрагмента", "фрагментов")} переведено.`);
    outputEl.contentEditable = "true";
  } catch (e) {
    showError(describeError(e));
    progressText.textContent = "Перевод прерван — нажмите «Продолжить», чтобы продолжить с того же места.";
    if (passportState.textContent === "· составляется…") {
      passportState.textContent = "";
      passportEl.value = "";
    }
  } finally {
    running = false;
    controller = null;
    streamingIndex = -1;
    outputEl.classList.remove("streaming");
    stopBtn.hidden = true;
    renderOutput();
    updateRunButton();
    persist();
  }
}

// Ручные правки готового перевода сохраняем как текст целиком.
outputEl.addEventListener("input", () => {
  if (running || !job) return;
  const text = outputEl.innerText.replace(/\n{3,}/g, "\n\n");
  job.finals = job.chunks.map((_, i) => (i === 0 ? text : ""));
  persist();
});

// ---------- загрузка файлов ----------

async function loadFile(file: File) {
  showError(null);
  try {
    statsEl.textContent = `Читаю «${file.name}»…`;
    const text = await readFileAsText(file);
    if (!text.trim()) throw new Error("В файле не найден текст.");
    sourceEl.value = text;
    fileName = file.name;
    persist();
  } catch (e) {
    showError(`Не удалось прочитать файл «${file.name}»: ${e instanceof Error ? e.message : e}`);
  }
  updateStats();
}

fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) void loadFile(f);
  fileInput.value = "";
});

let dragDepth = 0;
dropzone.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  dropzone.classList.add("dragging");
});
dropzone.addEventListener("dragover", (e) => e.preventDefault());
dropzone.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropzone.classList.remove("dragging");
  }
});
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove("dragging");
  const f = e.dataTransfer?.files?.[0];
  if (f) void loadFile(f);
});

// ---------- кнопки ----------

let statsTimer = 0;
sourceEl.addEventListener("input", () => {
  if (!sourceEl.value.trim()) fileName = "";
  clearTimeout(statsTimer);
  statsTimer = window.setTimeout(() => {
    updateStats();
    persist();
  }, 300);
});
notesEl.addEventListener("input", () => persist());
passportEl.addEventListener("input", () => {
  // Ручная правка паспорта — считаем его актуальным для текущего текста.
  passportFor = hash(sourceEl.value.trim());
  passportState.textContent = passportEl.value.trim() ? "· изменён вручную" : "";
  persist();
});

runBtn.addEventListener("click", () => void run());
stopBtn.addEventListener("click", () => controller?.abort());

clearBtn.addEventListener("click", () => {
  if (running) return;
  if (sourceEl.value && !confirm("Очистить оригинал, паспорт стиля и перевод?")) return;
  sourceEl.value = "";
  passportEl.value = "";
  passportState.textContent = "";
  passportFor = "";
  fileName = "";
  job = null;
  usage = emptyUsage();
  outputEl.innerHTML =
    '<p class="placeholder">Здесь появится перевод.</p>';
  progressBox.hidden = true;
  showError(null);
  copyBtn.disabled = txtBtn.disabled = docBtn.disabled = true;
  updateUsage();
  updateStats();
  persist();
});

function currentOutputText() {
  return outputEl.isContentEditable ? outputEl.innerText.trim() : finalText();
}

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentOutputText());
    copyBtn.textContent = "Скопировано ✓";
  } catch {
    copyBtn.textContent = "Не удалось";
  }
  setTimeout(() => (copyBtn.textContent = "Копировать"), 1500);
});

function baseName() {
  const n = fileName ? fileName.replace(/\.[^.]+$/, "") : "perevod";
  return `${n}_ru`;
}

function download(name: string, data: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

txtBtn.addEventListener("click", () =>
  download(baseName() + ".txt", "﻿" + currentOutputText(), "text/plain;charset=utf-8"),
);

docBtn.addEventListener("click", () => {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paras = currentOutputText()
    .split(/\n\s*\n/)
    .map((p) => {
      const h = /^(#{1,6})\s+(.*)$/.exec(p.trim());
      if (h) return `<h${h[1].length}>${esc(h[2])}</h${h[1].length}>`;
      return `<p>${esc(p).replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(baseName())}</title><style>body{font-family:"Times New Roman",serif;font-size:14pt;line-height:1.5}p{margin:0 0 0.6em;text-indent:1.25cm}</style></head><body>${paras}</body></html>`;
  download(baseName() + ".doc", "﻿" + html, "application/msword");
});

// ---------- настройки ----------

for (const [id, m] of Object.entries(MODELS)) {
  const o = document.createElement("option");
  o.value = id;
  o.textContent = `${m.label} — $${m.input} / $${m.output} за 1M токенов`;
  modelEl.append(o);
}
modelEl.addEventListener("change", () => {
  modelHint.textContent = MODELS[modelEl.value as ModelId].hint;
});

function openSettings() {
  apiKeyEl.value = settings.apiKey;
  modelEl.value = settings.model;
  modelHint.textContent = MODELS[settings.model].hint;
  fidelityEl.value = settings.fidelity;
  effortEl.value = settings.effort;
  analyzeEl.checked = settings.analyzeStyle;
  editEl.checked = settings.editPass;
  chunkSizeEl.value = String(settings.chunkSize);
  dialog.showModal();
}

$("settingsBtn").addEventListener("click", openSettings);

form.addEventListener("submit", (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "save") return;
  settings = {
    apiKey: apiKeyEl.value.trim(),
    model: modelEl.value as ModelId,
    fidelity: fidelityEl.value as Settings["fidelity"],
    effort: effortEl.value as Settings["effort"],
    analyzeStyle: analyzeEl.checked,
    editPass: editEl.checked,
    chunkSize: Math.min(40000, Math.max(2000, Number(chunkSizeEl.value) || DEFAULT_SETTINGS.chunkSize)),
  };
  save(SETTINGS_KEY, settings);
  updateStats();
});

// ---------- старт ----------

if (job && job.drafts.some((d) => d !== null)) {
  renderOutput();
  const done = job.finals.filter((f) => f !== null).length;
  if (done === job.chunks.length) outputEl.contentEditable = "true";
}
updateStats();
updateUsage();
if (!settings.apiKey) {
  estimateEl.textContent = "Для начала укажите API-ключ в настройках ⚙";
}
