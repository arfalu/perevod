import Anthropic from "@anthropic-ai/sdk";
import {
  STYLE_ANALYSIS_SYSTEM,
  editUserMessage,
  editorSystem,
  translateUserMessage,
  translatorSystem,
  type Fidelity,
} from "./prompts";

export type ModelId = "claude-opus-5-5" | "claude-fable-5-2" | "claude-sonnet-5-5";
export type Effort = "medium" | "high" | "xhigh" | "max";

export const MODELS: Record<
  ModelId,
  { label: string; hint: string; input: number; output: number; cacheRead: number }
> = {
  "claude-opus-5-5": {
    label: "Claude Opus 5.5",
    hint: "Рекомендуется: отличное качество и разумная цена",
    input: 4,
    output: 20,
    cacheRead: 0.2,
  },
  "claude-fable-5-2": {
    label: "Claude Fable 5.2",
    hint: "Самая сильная модель — для самых сложных текстов, дороже вдвое",
    input: 8,
    output: 40,
    cacheRead: 0.2,
  },
  "claude-sonnet-5-5": {
    label: "Claude Sonnet 5.5",
    hint: "Быстрее и дешевле, качество чуть проще",
    input: 2,
    output: 10,
    cacheRead: 0.1,
  },
};

export interface Settings {
  apiKey: string;
  model: ModelId;
  effort: Effort;
  fidelity: Fidelity;
  analyzeStyle: boolean;
  editPass: boolean;
  chunkSize: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export class TranslationError extends Error {}

/** Максимум текста, который отправляем на анализ стиля целиком (~100 тыс. токенов). */
export const ANALYSIS_LIMIT = 350_000;

export function makeClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    // Ключ принадлежит самому пользователю и хранится только в его браузере.
    dangerouslyAllowBrowser: true,
    maxRetries: 4,
  });
}

/**
 * Один потоковый запрос к Claude. onText получает текст по мере генерации.
 * Возвращает полный текст ответа.
 */
async function streamText(
  client: Anthropic,
  s: Settings,
  system: string,
  user: string,
  onText: (full: string) => void,
  signal: AbortSignal,
  usage: Usage,
): Promise<string> {
  const stream = client.beta.messages.stream(
    {
      model: s.model,
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      output_config: { effort: s.effort },
      // Если модель по ошибке откажется от текста (бывает на острых темах),
      // запрос автоматически продолжит резервная модель.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    },
    { signal },
  );

  let text = "";
  stream.on("text", (delta) => {
    text += delta;
    onText(text);
  });

  const msg = await stream.finalMessage();
  addUsage(usage, s.model, msg.usage);

  if (msg.stop_reason === "refusal") {
    const why = msg.stop_details?.explanation;
    throw new TranslationError(
      "Модель отказалась переводить этот фрагмент" + (why ? `: ${why}` : ".") +
        " Попробуйте другую модель в настройках.",
    );
  }
  if (msg.stop_reason === "max_tokens") {
    throw new TranslationError(
      "Ответ модели оборвался по лимиту длины. Уменьшите размер фрагмента в настройках и нажмите «Продолжить».",
    );
  }
  return text.trim();
}

function addUsage(
  u: Usage,
  model: ModelId,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  },
) {
  const p = MODELS[model];
  const cr = usage.cache_read_input_tokens ?? 0;
  const cw = usage.cache_creation_input_tokens ?? 0;
  u.input += usage.input_tokens;
  u.output += usage.output_tokens;
  u.cacheRead += cr;
  u.cacheWrite += cw;
  u.cost +=
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      cr * p.cacheRead +
      cw * p.input * 1.25) /
    1_000_000;
}

export function analyzeStyle(
  client: Anthropic,
  s: Settings,
  source: string,
  notes: string,
  onText: (t: string) => void,
  signal: AbortSignal,
  usage: Usage,
): Promise<string> {
  const truncated = source.length > ANALYSIS_LIMIT;
  const text = truncated ? source.slice(0, ANALYSIS_LIMIT) : source;
  const user = [
    truncated
      ? "Ниже — начало произведения (оно очень длинное, остальная часть не поместилась). Составь паспорт стиля по этой части."
      : "Ниже — произведение целиком.",
    `<текст>\n${text}\n</текст>`,
    notes.trim() ? `Пожелания заказчика перевода, учти их:\n${notes.trim()}` : "",
    "Составь паспорт стиля и глоссарий.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return streamText(client, s, STYLE_ANALYSIS_SYSTEM, user, onText, signal, usage);
}

export function translateChunk(
  client: Anthropic,
  s: Settings,
  ctx: {
    chunk: string;
    index: number;
    total: number;
    prevSource: string;
    prevTranslation: string;
    passport: string;
    notes: string;
  },
  onText: (t: string) => void,
  signal: AbortSignal,
  usage: Usage,
): Promise<string> {
  const system = translatorSystem({ fidelity: s.fidelity, passport: ctx.passport, notes: ctx.notes });
  const user = translateUserMessage({
    chunk: ctx.chunk,
    index: ctx.index,
    total: ctx.total,
    prevSource: tail(ctx.prevSource, 2500),
    prevTranslation: tail(ctx.prevTranslation, 2500),
  });
  return streamText(client, s, system, user, onText, signal, usage);
}

export function editChunk(
  client: Anthropic,
  s: Settings,
  ctx: { chunk: string; draft: string; prevTranslation: string; passport: string; notes: string },
  onText: (t: string) => void,
  signal: AbortSignal,
  usage: Usage,
): Promise<string> {
  const system = editorSystem({ fidelity: s.fidelity, passport: ctx.passport, notes: ctx.notes });
  const user = editUserMessage({
    chunk: ctx.chunk,
    draft: ctx.draft,
    prevTranslation: tail(ctx.prevTranslation, 2000),
  });
  return streamText(client, s, system, user, onText, signal, usage);
}

/** Последние ~n символов, обрезанные по границе абзаца или предложения. */
function tail(text: string, n: number): string {
  if (text.length <= n) return text;
  const cut = text.slice(text.length - n);
  const para = cut.indexOf("\n");
  if (para !== -1 && para < n / 2) return cut.slice(para + 1).trimStart();
  const sentence = cut.search(/[.!?…]\s/);
  if (sentence !== -1 && sentence < n / 2) return cut.slice(sentence + 2);
  return "…" + cut;
}

/**
 * Делит текст на фрагменты по границам абзацев, чтобы каждый был не длиннее maxChars.
 * Слишком длинные абзацы режутся по предложениям.
 */
export function splitIntoChunks(text: string, maxChars: number): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const hasBlankLines = /\n\s*\n/.test(normalized);
  const paragraphs = normalized.split(hasBlankLines ? /\n\s*\n/ : /\n/);
  const sep = hasBlankLines ? "\n\n" : "\n";

  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= maxChars) {
      pieces.push(p);
      continue;
    }
    // Абзац-гигант — режем по предложениям.
    const sentences = p.match(/[^.!?…]+(?:[.!?…]+["'»”’)\]]*\s*|$)/g) ?? [p];
    let buf = "";
    for (const sent of sentences) {
      if (buf && buf.length + sent.length > maxChars) {
        pieces.push(buf.trim());
        buf = "";
      }
      buf += sent;
    }
    if (buf.trim()) pieces.push(buf.trim());
  }

  const chunks: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    if (cur && cur.length + sep.length + piece.length > maxChars) {
      chunks.push(cur);
      cur = piece;
    } else {
      cur = cur ? cur + sep + piece : piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function describeError(e: unknown): string {
  if (e instanceof TranslationError) return e.message;
  if (e instanceof Anthropic.APIUserAbortError) return "Остановлено.";
  if (e instanceof Anthropic.AuthenticationError)
    return "Неверный API-ключ. Проверьте его в настройках (⚙).";
  if (e instanceof Anthropic.PermissionDeniedError)
    return "У этого ключа нет доступа к выбранной модели. Выберите другую модель в настройках.";
  if (e instanceof Anthropic.NotFoundError)
    return "Модель не найдена. Выберите другую модель в настройках.";
  if (e instanceof Anthropic.RateLimitError)
    return "Превышен лимит запросов к API. Подождите минуту и нажмите «Продолжить».";
  if (e instanceof Anthropic.BadRequestError) {
    const m = e.message.toLowerCase();
    if (m.includes("credit") || m.includes("balance"))
      return "На балансе API закончились средства. Пополните его на platform.claude.com.";
    return "Запрос отклонён API: " + e.message;
  }
  if (e instanceof Anthropic.InternalServerError)
    return "Сервер Claude временно перегружен. Нажмите «Продолжить» через минуту.";
  if (e instanceof Anthropic.APIConnectionError)
    return "Нет соединения с API. Проверьте интернет и нажмите «Продолжить».";
  if (e instanceof Anthropic.APIError) return "Ошибка API: " + e.message;
  return e instanceof Error ? e.message : String(e);
}
