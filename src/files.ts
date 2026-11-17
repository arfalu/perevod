// Извлечение текста из загруженных файлов. Тяжёлые библиотеки грузятся только при необходимости.

export const ACCEPT = ".txt,.md,.markdown,.text,.docx,.pdf,.fb2,.html,.htm,.rtf";

export async function readFileAsText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  const ext = name.slice(name.lastIndexOf(".") + 1);

  switch (ext) {
    case "docx":
      return readDocx(file);
    case "pdf":
      return readPdf(file);
    case "fb2":
      return readFb2(await file.text());
    case "html":
    case "htm":
      return htmlToText(await file.text());
    case "rtf":
      return rtfToText(await file.text());
    case "doc":
      throw new Error("Старый формат .doc не поддерживается — сохраните файл как .docx или .txt.");
    default:
      return normalize(await file.text());
  }
}

async function readDocx(file: File): Promise<string> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return normalize(value);
}

async function readPdf(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let out = "";
    let lastY: number | null = null;
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > item.height * 1.8) out += "\n\n";
      else if (lastY !== null && y !== lastY) out += "\n";
      out += item.str;
      if (item.hasEOL) out += "\n";
      lastY = y;
    }
    pages.push(out);
  }
  if (!pages.join("").trim()) {
    throw new Error("В этом PDF нет текстового слоя (похоже, это скан). Нужен PDF с текстом или .docx/.txt.");
  }
  // Склеиваем строки внутри абзацев, сохраняя пустые строки между абзацами.
  const joined = pages
    .join("\n\n")
    .replace(/-\n(?=[a-z])/g, "")
    .replace(/([^\n])\n(?!\n)/g, "$1 ");
  return normalize(joined);
}

function readFb2(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const body = doc.getElementsByTagName("body")[0];
  if (!body) throw new Error("Не удалось прочитать FB2-файл.");
  const out: string[] = [];
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.localName;
      if (tag === "p" || tag === "v" || tag === "subtitle" || tag === "text-author") {
        out.push(child.textContent?.trim() ?? "");
      } else if (tag === "title") {
        out.push("## " + (child.textContent ?? "").replace(/\s+/g, " ").trim());
      } else if (tag === "empty-line") {
        // разделитель — пропускаем
      } else if (tag !== "binary") {
        walk(child);
      }
    }
  };
  walk(body);
  return normalize(out.filter(Boolean).join("\n\n"));
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,nav,header,footer").forEach((n) => n.remove());
  const blocks = doc.body.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,blockquote,pre");
  if (!blocks.length) return normalize(doc.body.textContent ?? "");
  return normalize(
    Array.from(blocks)
      .map((b) => {
        const t = (b.textContent ?? "").replace(/\s+/g, " ").trim();
        const m = /^h([1-6])$/i.exec(b.tagName);
        return m && t ? "#".repeat(Number(m[1])) + " " + t : t;
      })
      .filter(Boolean)
      .join("\n\n"),
  );
}

function rtfToText(rtf: string): string {
  // Простой разбор RTF: достаточно для текстов, сохранённых из Word/TextEdit.
  let text = rtf
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((Number(n) + 65536) % 65536))
    .replace(/\{\\\*[^{}]*\}/g, "")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "");
  text = text.replace(/\n(?!\n)/g, "\n\n");
  return normalize(text);
}

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
