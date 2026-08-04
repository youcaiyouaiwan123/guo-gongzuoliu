import { Buffer } from "node:buffer";
import * as XLSX from "xlsx";

export type ExtractedFileText = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  content: string;
  status: "parsed" | "pending";
  note: string;
  parser:
    | "text"
    | "spreadsheet"
    | "docx"
    | "pdf"
    | "pptx"
    | "unsupported"
    | "image"
    | "legacy-doc";
  aiFallback?: {
    available: boolean;
    reason: string;
  };
};

const MAX_CONTENT_CHARS = 800_000;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|json|xml|html|htm|log)$/i;
const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_PARTS = ["json", "xml", "csv", "markdown"];
const AI_FILE_FALLBACK_REASON =
  "当前模型通道是文本对话接口，暂不支持把原始 Word、PDF、图片直接交给模型解析；系统会优先使用服务器解析。后续接入支持文件或视觉的模型通道后，可自动开启 AI 兜底解析。";

function normalizeWhitespace(value: string) {
  return value
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function truncateContent(value: string) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= MAX_CONTENT_CHARS) return normalized;
  return `${normalized.slice(0, MAX_CONTENT_CHARS)}\n\n[系统提示：文件正文较长，已截取前 ${MAX_CONTENT_CHARS} 字用于本次解析。]`;
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

function stripXml(value: string) {
  return decodeXmlEntities(
    value
      .replace(/<a:t[^>]*>/g, "")
      .replace(/<\/a:t>/g, "\n")
      .replace(/<w:t[^>]*>/g, "")
      .replace(/<\/w:t>/g, "")
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br\/>|<w:cr\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function pending(
  filename: string,
  mimeType: string,
  sizeBytes: number,
  note: string,
  parser: ExtractedFileText["parser"],
): ExtractedFileText {
  return {
    filename,
    mimeType,
    sizeBytes,
    content: "",
    status: "pending",
    note,
    parser,
    aiFallback: {
      available: false,
      reason: AI_FILE_FALLBACK_REASON,
    },
  };
}

function parsed(
  filename: string,
  mimeType: string,
  sizeBytes: number,
  content: string,
  note: string,
  parser: ExtractedFileText["parser"],
): ExtractedFileText {
  const text = truncateContent(content);
  if (!text) {
    return pending(filename, mimeType, sizeBytes, "没有从文件中提取到可读正文。", parser);
  }
  return {
    filename,
    mimeType,
    sizeBytes,
    content: text,
    status: "parsed",
    note,
    parser,
  };
}

function safeError(error: unknown) {
  if (error instanceof Error && error.message) return error.message.slice(0, 180);
  return "未知错误";
}

async function extractSpreadsheet(buffer: ArrayBuffer) {
  const workbook = XLSX.read(buffer, { type: "array" });
  return workbook.SheetNames.slice(0, 12)
    .map(sheetName => {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        header: 1,
        blankrows: false,
      }) as unknown[][];
      const lines = rows
        .slice(0, 800)
        .map(row => row.map(cell => String(cell ?? "").replace(/\s+/g, " ").trim()).join(" | "))
        .filter(Boolean);
      return `## 工作表：${sheetName}\n\n${lines.join("\n") || "空表"}`;
    })
    .join("\n\n");
}

async function extractDocxXml(buffer: Buffer) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const files = Object.keys(zip.files)
    .filter(name =>
      /^word\/(document|footnotes|endnotes)\.xml$/i.test(name) ||
      /^word\/(header|footer)\d+\.xml$/i.test(name),
    )
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const parts: string[] = [];
  for (const name of files) {
    const xml = await zip.file(name)?.async("text");
    if (!xml) continue;
    const text = normalizeWhitespace(stripXml(xml).replace(/[ \t]{2,}/g, " "));
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

async function extractDocx(buffer: Buffer) {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  const rawText = normalizeWhitespace(result.value || "");
  if (rawText) return rawText;
  return extractDocxXml(buffer);
}

async function extractPdf(buffer: Buffer) {
  const mod = await import("pdf-parse");
  const pdfParse =
    (mod as unknown as { default?: (input: Buffer) => Promise<{ text?: string }> }).default ||
    (mod as unknown as (input: Buffer) => Promise<{ text?: string }>);
  const result = await pdfParse(buffer);
  return result.text || "";
}

async function extractPptx(buffer: Buffer) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const slides: string[] = [];
  for (const name of slideFiles.slice(0, 80)) {
    const xml = await zip.file(name)?.async("text");
    if (!xml) continue;
    const text = normalizeWhitespace(stripXml(xml).replace(/\s+/g, " "));
    if (text) slides.push(`## ${name.replace("ppt/slides/", "").replace(".xml", "")}\n\n${text}`);
  }
  return slides.join("\n\n");
}

export async function extractTextFromFile(file: File): Promise<ExtractedFileText> {
  const filename = file.name || "未命名文件";
  const mimeType = file.type || "application/octet-stream";
  const lowerName = filename.toLowerCase();
  const sizeBytes = file.size;

  try {
    if (/\.doc$/i.test(lowerName)) {
      return pending(
        filename,
        mimeType,
        sizeBytes,
        "旧版 .doc 是二进制格式，当前不能稳定抽取正文。请另存为 .docx 或 PDF 后上传。",
        "legacy-doc",
      );
    }

    if (/\.(xlsx|xls|docx|pdf|pptx)$/i.test(lowerName)) {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (/\.(xlsx|xls)$/i.test(lowerName)) {
        return parsed(filename, mimeType, sizeBytes, await extractSpreadsheet(arrayBuffer), "表格内容已解析。", "spreadsheet");
      }

      if (/\.docx$/i.test(lowerName)) {
        return parsed(filename, mimeType, sizeBytes, await extractDocx(buffer), "Word 正文已解析。", "docx");
      }

      if (/\.pdf$/i.test(lowerName)) {
        const result = parsed(filename, mimeType, sizeBytes, await extractPdf(buffer), "PDF 文字已解析。", "pdf");
        if (result.status === "pending") {
          return pending(filename, mimeType, sizeBytes, "PDF 未提取到文字，可能是扫描件或图片型 PDF，需要 OCR 或视觉模型。", "pdf");
        }
        return result;
      }

      return parsed(filename, mimeType, sizeBytes, await extractPptx(buffer), "PPT 内容已解析。", "pptx");
    }

    if (
      TEXT_MIME_PREFIXES.some(prefix => mimeType.startsWith(prefix)) ||
      TEXT_MIME_PARTS.some(part => mimeType.includes(part)) ||
      TEXT_EXTENSIONS.test(lowerName)
    ) {
      return parsed(filename, mimeType, sizeBytes, await file.text(), "文本内容已解析。", "text");
    }

    if (mimeType.startsWith("image/") || /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(lowerName)) {
      return pending(
        filename,
        mimeType,
        sizeBytes,
        "图片已接收；当前聊天附件不会保留图片原件。需要识别图片内容时，请使用 OCR 或支持视觉的模型通道。",
        "image",
      );
    }

    return pending(
      filename,
      mimeType,
      sizeBytes,
      "当前格式暂未自动提取正文，请转换为 PDF、Word(docx)、Excel、PPT(pptx)、Markdown、TXT 或 CSV 后上传。",
      "unsupported",
    );
  } catch (error) {
    if (/\.docx$/i.test(lowerName)) {
      return pending(filename, mimeType, sizeBytes, `Word 解析失败：${safeError(error)}。请确认文件未加密、未损坏。`, "docx");
    }
    if (/\.pdf$/i.test(lowerName)) {
      return pending(filename, mimeType, sizeBytes, `PDF 解析失败：${safeError(error)}。如果是扫描件，请使用 OCR 或视觉模型。`, "pdf");
    }
    if (/\.(xlsx|xls)$/i.test(lowerName)) {
      return pending(filename, mimeType, sizeBytes, `表格解析失败：${safeError(error)}。请确认文件未加密、未损坏。`, "spreadsheet");
    }
    if (/\.pptx$/i.test(lowerName)) {
      return pending(filename, mimeType, sizeBytes, `PPT 解析失败：${safeError(error)}。请确认文件未加密、未损坏。`, "pptx");
    }
    return pending(filename, mimeType, sizeBytes, `文件解析失败：${safeError(error)}。`, "unsupported");
  }
}
