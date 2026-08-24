import { runtime, askModel, askModelWithSkills, audit } from "./_shared";
import { assertPublicCollectionUrl } from "../_urlGuard";
import { crawlPages, htmlToText, decodeHtml, applyContentSelector, looksLikeBlockedPage, looksLikeEmptyShellContent } from "../_crawler";
import { detectSeparator, looksLikeCsv, parseCsv, splitCsvLine, splitCsvRecords } from "../_csv";
import { decryptSecret } from "../_crypto";

function normalizeCollectionUrlInput(value = "") {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("请填写采集地址");
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error("采集地址格式不正确，请填写完整网址，例如 https://example.com/page");
  }
  assertPublicCollectionUrl(url);
  url.hash = "";
  return url;
}

function ensureUsableCollectedContent(raw: string, httpStatus: number, contentType = "") {
  if (httpStatus < 200 || httpStatus >= 300) {
    const excerpt = htmlToText(raw).slice(0, 180);
    throw new Error(`\u8fdc\u7a0b\u8fd4\u56de ${httpStatus}${excerpt ? `\uff1a${excerpt}` : ""}`);
  }
  if (looksLikeBlockedPage(raw, httpStatus, contentType)) {
    throw new Error("\u76ee\u6807\u9875\u9762\u9700\u8981\u767b\u5f55\u3001\u9a8c\u8bc1\u7801\u3001\u4eba\u673a\u9a8c\u8bc1\u6216\u62d2\u7edd\u670d\u52a1\u5668\u91c7\u96c6\u3002\u8bf7\u6539\u7528\u6388\u6743 API/MCP\u3001\u5e73\u53f0\u5bfc\u51fa\u540e\u4e0a\u4f20/\u7c98\u8d34\uff0c\u6216\u5728\u6570\u636e\u6e90\u91cc\u586b\u5199\u53ef\u8bbf\u95ee\u7684\u516c\u5f00\u9875\u9762/API\u3002");
  }
  if (looksLikeEmptyShellContent(raw, contentType)) {
    throw new Error("\u672a\u91c7\u96c6\u5230\u6709\u6548\u6b63\u6587\uff0c\u76ee\u6807\u9875\u9762\u53ea\u8fd4\u56de\u7a7a\u58f3/\u5360\u4f4d\u5185\u5bb9\u3002\u8bf7\u6539\u7528\u53ef\u8fd4\u56de\u6570\u636e\u7684 API\u3001JS \u6e32\u67d3\u91c7\u96c6\u3001MCP\u3001\u5bfc\u51fa\u4e0a\u4f20\u6216\u7c98\u8d34\u6b63\u6587\u5165\u5e93\u3002");
  }
}

const targetStoreLabels: Record<string, string> = {
  personal: "\u4e2a\u4eba\u77e5\u8bc6\u5e93",
  enterprise: "\u4f01\u4e1a\u77e5\u8bc6\u5e93",
  both: "\u4e2a\u4eba\u77e5\u8bc6\u5e93 + \u4f01\u4e1a\u77e5\u8bc6\u5e93",
};

const outputFormatLabels: Record<string, string> = {
  markdown: "Markdown",
  document: "\u6587\u6863",
  table: "\u8868\u683c",
  json: "JSON",
  raw: "\u539f\u59cb\u6587\u672c",
};

const collectorModeLabels: Record<string, string> = {
  direct: "\u7f51\u9875\u76f4\u91c7",
  api: "API\u91c7\u96c6",
  crawler: "\u722c\u866b\u91c7\u96c6",
  mcp: "MCP\u7ed3\u679c",
  screenshot: "\u622a\u56fe\u8bc6\u522b",
  paste: "\u624b\u52a8\u7c98\u8d34",
  ai: "AI \u667a\u80fd\u91c7\u96c6",
};

function normalizeTargetStore(value?: string) {
  return ["personal", "enterprise", "both"].includes(value || "") ? value! : "personal";
}

function normalizeOutputFormat(value?: string) {
  return ["markdown", "document", "table", "json", "raw"].includes(value || "") ? value! : "markdown";
}

function normalizeCollectorMode(value?: string) {
  return ["direct", "api", "crawler", "mcp", "screenshot", "paste"].includes(value || "") ? value! : "direct";
}

function normalizePublishMode(value?: string) {
  return value === "record_only" || value === "仅保存采集记录" ? "record_only" : "auto";
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function normalizePlatform(value?: string) {
  return ["web", "xiaohongshu", "douyin", "kuaishou", "bilibili", "weibo", "zhihu", "wechat", "custom_api", "mcp", "screenshot", "manual_export"].includes(value || "") ? value! : "web";
}

function platformLabel(value?: string) {
  return ({
    web: "\u516c\u5f00\u7f51\u7ad9",
    xiaohongshu: "\u5c0f\u7ea2\u4e66",
    douyin: "\u6296\u97f3",
    kuaishou: "\u5feb\u624b",
    bilibili: "B\u7ad9",
    weibo: "\u5fae\u535a",
    zhihu: "\u77e5\u4e4e",
    wechat: "\u516c\u4f17\u53f7/\u89c6\u9891\u53f7",
    custom_api: "\u4f01\u4e1a\u81ea\u6709 API",
    mcp: "MCP",
    screenshot: "\u622a\u56fe/OCR",
    manual_export: "\u5e73\u53f0\u5bfc\u51fa\u6587\u4ef6",
  } as Record<string, string>)[normalizePlatform(value)];
}

function normalizeYesNo(value?: string) {
  return value === "yes" ? "yes" : "no";
}

async function crawlWebsite(seed: URL, options: { method: string; maxPages: number; depth: number; includePattern?: string; excludePattern?: string; platform?: string; keyword?: string; includeComments?: string; contentSelector?: string }) {
  // \u6293\u53d6\u5faa\u73af\u5728 _crawler \u91cc\u4e0e AI \u6280\u80fd\u5171\u7528\uff1b\u8fd9\u91cc\u6ce8\u5165\u7684\u662f\u5e26\u91c7\u96c6\u4ee3\u7406\u548c\u9010\u8df3 SSRF \u6821\u9a8c\u7684\u51fa\u7f51\u5b9e\u73b0\u3002
  const { pages, firstStatus } = await crawlPages(
    seed,
    { maxPages: options.maxPages, depth: options.depth, includePattern: options.includePattern, excludePattern: options.excludePattern, contentSelector: options.contentSelector },
    url => fetchForCollection(url, options.method),
  );
  if (!pages.length) throw new Error("\u722c\u866b\u672a\u91c7\u96c6\u5230\u53ef\u7528\u9875\u9762\uff0c\u8bf7\u68c0\u67e5 URL\u3001\u6293\u53d6\u8303\u56f4\u6216\u7f51\u7ad9\u6743\u9650\u3002");
  const usablePages = pages.filter(page => !looksLikeEmptyShellContent(page.text, "text/plain"));
  if (!usablePages.length) throw new Error("\u672a\u91c7\u96c6\u5230\u6709\u6548\u6b63\u6587\uff0c\u76ee\u6807\u9875\u9762\u53ea\u8fd4\u56de\u7a7a\u58f3/\u5360\u4f4d\u5185\u5bb9\u3002\u8bf7\u6539\u7528\u53ef\u8fd4\u56de\u6570\u636e\u7684 API\u3001JS \u6e32\u67d3\u91c7\u96c6\u3001MCP\u3001\u5bfc\u51fa\u4e0a\u4f20\u6216\u7c98\u8d34\u6b63\u6587\u5165\u5e93\u3002");
  const records = usablePages.map((page, index) => [
    `# ${page.title || `Page ${index + 1}`}`,
    `\u6765\u6e90\uff1a${page.url}`,
    "",
    page.text,
  ].join("\n")).join("\n\n---\n\n");
  return {
    httpStatus: firstStatus,
    contentType: "text/crawl-content",
    raw: records,
    rowCount: usablePages.length,
  };
}

function isInlineSource(sourceType = "") {
  if (/\u7c98\u8d34|\u622a\u56fe|\u56fe\u7247|OCR|MCP|CSV\/JSON/i.test(sourceType)) return true;
  return sourceType.includes("\u7c98\u8d34") || sourceType.includes("\u622a\u56fe") || sourceType.includes("\u56fe\u7247") || sourceType.includes("MCP");
}

function jsonToMarkdownTable(value: string) {
  const parsed = JSON.parse(value);
  // 信封式响应要先拆到明细数组，否则表格只会渲染出 code/message/data 三列。
  const objects = (unwrapJsonRecords(parsed) || []).slice(0, 50);
  if (!objects.length) return "```json\n" + JSON.stringify(parsed, null, 2).slice(0, 12000) + "\n```";
  const headers = Array.from(new Set(objects.flatMap(item => Object.keys(item)))).slice(0, 12);
  const body = objects.map(item => `| ${headers.map(key => String(item[key] ?? "").replace(/\|/g, "\\|").slice(0, 120)).join(" | ")} |`).join("\n");
  return `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${body}`;
}

function csvToMarkdownTable(value: string) {
  const records = splitCsvRecords(value).slice(0, 51);
  if (!records.length) return "";
  const separator = detectSeparator(records[0]);
  const rows = records.map(record => splitCsvLine(record, separator));
  const headers = rows[0];
  const body = rows.slice(1).map(row => `| ${headers.map((_, index) => (row[index] || "").replace(/\|/g, "\\|").slice(0, 120)).join(" | ")} |`).join("\n");
  return `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${body}`;
}

function safeKnowledgeFilename(title: string, extension: string) {
  const base = (title || "collection").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 80) || "collection";
  return `${base}.${extension}`;
}

function collectionFileMeta(title: string, outputFormat: string) {
  if (outputFormat === "json") return { filename: safeKnowledgeFilename(title, "json"), mimeType: "application/json;charset=utf-8" };
  if (outputFormat === "raw") return { filename: safeKnowledgeFilename(title, "txt"), mimeType: "text/plain;charset=utf-8" };
  return { filename: safeKnowledgeFilename(title, "md"), mimeType: "text/markdown;charset=utf-8" };
}

function normalizeJsonForKnowledge(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2).slice(0, 12000);
  } catch {
    return JSON.stringify({ content: value.slice(0, 12000) }, null, 2);
  }
}

/**
 * 判断这份响应到底是不是 CSV。
 *
 * 只看 content-type 或 sourceType 是不够的：CSV 下载地址常被服务端标成
 * application/octet-stream、text/plain，或者只在 content-disposition 里带文件名，
 * 结果表格数据被当成纯文本原样入库。这里补上按地址后缀与内容结构的嗅探。
 */
function looksLikeCsvContent(normalized: string, contentType: string, sourceType: string, sourceUrl = "") {
  if (contentType.includes("csv") || contentType.includes("tab-separated")) return true;
  if (sourceType.includes("CSV") || sourceType.includes("TSV")) return true;
  if (/\.(csv|tsv)(\?|#|$)/i.test(sourceUrl)) return true;
  if (contentType.includes("html") || contentType.includes("json")) return false;
  return looksLikeCsv(normalized);
}

function formatCollectionOutput(normalized: string, contentType: string, sourceType: string, outputFormat: string, aiSummary = "", sourceUrl = "") {
  if (outputFormat === "raw") return normalized.slice(0, 12000);
  if (outputFormat === "json") {
    return normalizeJsonForKnowledge(normalized);
  }
  if (outputFormat === "table") {
    if (contentType.includes("json") || sourceType.includes("JSON") || /^\s*[[{]/.test(normalized)) {
      try { return jsonToMarkdownTable(normalized).slice(0, 12000); } catch {}
    }
    if (looksLikeCsvContent(normalized, contentType, sourceType, sourceUrl)) return csvToMarkdownTable(normalized).slice(0, 12000);
  }
  return (aiSummary || normalized).slice(0, 12000);
}

function parseExtractFields(value = "") {
  const normalized = value
    .replace(/以及|还有|并且|同时|和/g, "、")
    .replace(/我想要|我要|帮我|请你|请|需要|采集|抓取|抓|提取|获取|拿到|字段|内容|数据|信息|列表|表格|输出|整理/g, " ")
    .replace(/这个网页|该网页|这个页面|该页面|页面里|网页里|里面的|里的/g, " ");
  return normalized
    .split(/[\n,，、;；|]+/)
    .map(item => item.trim().replace(/^的+/, "").replace(/即可$|就行$|就可以$/g, ""))
    .filter(item => item.length >= 2)
    .filter(item => !/^(全部|所有|某个|一个|这个|那个|商品|产品|页面|网页)$/.test(item))
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 20);
}

function markdownCell(value: unknown) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function extractJsonBlock(value: string) {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : value;
  const startArray = candidate.indexOf("[");
  const endArray = candidate.lastIndexOf("]");
  if (startArray >= 0 && endArray > startArray) return candidate.slice(startArray, endArray + 1);
  const startObject = candidate.indexOf("{");
  const endObject = candidate.lastIndexOf("}");
  if (startObject >= 0 && endObject > startObject) return `[${candidate.slice(startObject, endObject + 1)}]`;
  return candidate;
}

function guessFieldValue(text: string, field: string, sourceUrl = "") {
  const compact = text.replace(/\s+/g, " ").trim();
  const lower = field.toLowerCase();
  if (/价|price|金额|售价|现价|到手价|费用|cost|amount/.test(field) || /price|cost|amount/.test(lower)) {
    const patterns = [
      /(?:价格|售价|现价|到手价|活动价|优惠价|price|sale price|amount|cost)\s*[:：]?\s*((?:¥|￥|RMB|\$|USD)?\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
      /((?:¥|￥|RMB|\$|USD)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
    ];
    for (const pattern of patterns) {
      const matched = compact.match(pattern);
      if (matched?.[1]) return matched[1].replace(/\s+/g, " ").trim();
    }
  }
  if (/链接|地址|url|link/i.test(field)) return sourceUrl;
  if (/名称|标题|商品名|产品名|name|title/i.test(field)) {
    const line = text.split(/\r?\n/).map(item => item.trim()).find(Boolean);
    return line?.slice(0, 160) || "";
  }
  const label = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matched = compact.match(new RegExp(`${label}\\s*[:：]\\s*([^|。；;，,]{1,160})`, "i"));
  return matched?.[1]?.trim() || "";
}

function formatExtractedRows(rows: Record<string, string>[], fields: string[], outputFormat: string) {
  if (outputFormat === "json") return JSON.stringify(rows, null, 2);
  const headers = ["来源", ...fields];
  const body = rows.map(row => `| ${headers.map(header => markdownCell(row[header])).join(" | ")} |`).join("\n");
  const table = `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${body}`;
  if (outputFormat === "raw") return rows.map((row, index) => [`#${index + 1}`, ...headers.map(header => `${header}: ${row[header] || ""}`)].join("\n")).join("\n\n");
  return table;
}

/** 尝试按 CSV 表头解析提取字段 */
function extractFromCsv(text: string, fields: string[]): Record<string, string>[] {
  // 走共享解析器：支持逗号/制表符/分号分隔、引号内换行与转义引号。
  // 旧实现用 line.split(",") 硬切，遇到 Excel 导出的引号字段就会整行错列。
  if (!looksLikeCsv(text)) return [];
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = Object.keys(rows[0]);
  const columns = fields.map(field => {
    const lowerField = field.toLowerCase();
    return header.find(name =>
      name.toLowerCase() === lowerField
      || name.toLowerCase().includes(lowerField)
      || lowerField.includes(name.toLowerCase()),
    ) || "";
  });
  if (columns.every(name => !name)) return [];
  return rows.map(row => {
    const result: Record<string, string> = { 来源: "" };
    fields.forEach((field, index) => {
      result[field] = columns[index] ? String(row[columns[index]] ?? "").trim() : "";
    });
    return result;
  });
}

/**
 * 从信封式响应里取出明细数组。
 *
 * 国内接口的默认形状是 {code:0,message:"ok",data:{list:[...]}}，
 * 之前只看顶层数组或顶层对象的字段，这类响应一条都提取不到，最终报"未提取到你要求的内容"。
 */
export function unwrapJsonRecords(value: unknown, depth = 0): Record<string, unknown>[] | null {
  if (depth > 5 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    const objects = value.filter(item => item && typeof item === "object" && !Array.isArray(item));
    return objects.length ? (objects as Record<string, unknown>[]) : null;
  }
  const record = value as Record<string, unknown>;
  // 先按常见的数据字段名找，找不到再遍历其余字段，避免误取 meta/pagination 之类的数组。
  const preferred = ["data", "list", "items", "records", "rows", "result", "results", "content", "dataList"];
  for (const key of preferred) {
    if (key in record) {
      const found = unwrapJsonRecords(record[key], depth + 1);
      if (found) return found;
    }
  }
  for (const [key, item] of Object.entries(record)) {
    if (preferred.includes(key)) continue;
    const found = unwrapJsonRecords(item, depth + 1);
    if (found) return found;
  }
  return null;
}

/** 支持 a.b.c 点号路径取值：接口字段常嵌在 goods.title 这类结构里。 */
function readFieldPath(item: Record<string, unknown>, field: string): unknown {
  if (field in item) return item[field];
  if (!field.includes(".")) return undefined;
  let cursor: unknown = item;
  for (const segment of field.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** 尝试按 JSON 数组解析提取字段 */
function extractFromJson(text: string, fields: string[]): Record<string, string>[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return [];
  try {
    const list = unwrapJsonRecords(JSON.parse(trimmed));
    if (!list) return [];
    const rows: Record<string, string>[] = [];
    for (const item of list) {
      const row: Record<string, string> = { 来源: "" };
      let hasAny = false;
      for (const field of fields) {
        const val = readFieldPath(item, field);
        row[field] = val !== undefined && val !== null && typeof val !== "object" ? String(val).trim() : "";
        if (row[field]) hasAny = true;
      }
      if (hasAny) rows.push(row);
    }
    return rows;
  } catch {
    return [];
  }
}

async function extractRequestedFields(actor: string, normalized: string, fields: string[], modelMode: string, outputFormat: string, sourceUrl = "") {
  // 先尝试 JSON 解析
  const jsonRows = extractFromJson(normalized, fields);
  if (jsonRows.length > 0) {
    jsonRows.forEach(r => r["来源"] = sourceUrl);
    return {
      normalized: formatExtractedRows(jsonRows, fields, outputFormat),
      rowCount: jsonRows.length,
    };
  }

  // 再尝试 CSV 解析
  const csvRows = extractFromCsv(normalized, fields);
  if (csvRows.length > 0) {
    csvRows.forEach(r => r["来源"] = sourceUrl);
    return {
      normalized: formatExtractedRows(csvRows, fields, outputFormat),
      rowCount: csvRows.length,
    };
  }

  const baseRow: Record<string, string> = { 来源: sourceUrl };
  for (const field of fields) baseRow[field] = guessFieldValue(normalized, field, sourceUrl);
  let rows = Object.values(baseRow).some(Boolean) ? [baseRow] : [];

  const hasBusinessValue = (items: Record<string, string>[]) => items.some(row => fields.some(field => String(row[field] || "").trim()));
  if (!hasBusinessValue(rows) && modelMode !== "none") {
    const prompt = [
      "你是严谨的数据提取器。只从用户提供的采集正文中提取用户要求的内容，不允许编造。",
      `用户自定义采集内容：${fields.join("、")}`,
      "输出要求：只返回 JSON 数组；每个对象必须包含这些字段；没有找到的字段填空字符串；如果整页都没有任何字段值，返回空数组 []；不要输出解释、报告或采集过程。",
    ].join("\n");
    const answer = await askModel(actor, prompt, normalized.slice(0, 20000), modelMode);
    try {
      const parsed = JSON.parse(extractJsonBlock(answer));
      const list = Array.isArray(parsed) ? parsed : [parsed];
      rows = list
        .filter(item => item && typeof item === "object" && !Array.isArray(item))
        .map(item => {
          const row: Record<string, string> = { 来源: sourceUrl };
          for (const field of fields) row[field] = String((item as Record<string, unknown>)[field] ?? "").trim();
          return row;
        })
        .filter(row => fields.some(field => row[field]));
    } catch {
      rows = [];
    }
  }

  if (!hasBusinessValue(rows)) {
    throw new Error(`未提取到你要求的内容：${fields.join("、")}。请确认目标页面正文里确实包含这些内容；如果页面依赖登录、JS渲染或反爬，请改用截图识别、授权API、MCP或手动粘贴。`);
  }

  return {
    normalized: formatExtractedRows(rows, fields, outputFormat),
    rowCount: rows.length,
  };
}

function explainCollectionError(error: unknown, httpStatus = 0) {
  const message = error instanceof Error ? error.message : "\u91c7\u96c6\u5931\u8d25";
  if (/\u76ee\u6807\u9875\u9762|\u6388\u6743 API|\u8fdc\u7a0b\u8fd4\u56de/.test(message)) return message;
  if (httpStatus === 401 || httpStatus === 403 || /403|401|forbidden|unauthorized/i.test(message)) {
    return "\u76ee\u6807\u5730\u5740\u62d2\u7edd\u8bbf\u95ee\u6216\u9700\u8981\u767b\u5f55/\u9274\u6743\u3002\u8bf7\u6539\u7528\u6388\u6743 API\u3001MCP\u3001\u5e73\u53f0\u5bfc\u51fa\u4e0a\u4f20\u6216\u7c98\u8d34\u5165\u5e93\u3002";
  }
  if (httpStatus === 404 || /404/.test(message)) return "\u76ee\u6807\u5730\u5740\u4e0d\u5b58\u5728\u6216\u8def\u5f84\u5199\u9519\uff0c\u8bf7\u68c0\u67e5\u91c7\u96c6 URL\u3002";
  if (/timeout|aborted/i.test(message)) return "\u91c7\u96c6\u8d85\u65f6\uff0c\u76ee\u6807\u7ad9\u54cd\u5e94\u8fc7\u6162\u6216\u9650\u5236\u8bbf\u95ee\uff1b\u53ef\u6539\u7528 API\u3001\u4ee3\u7406\u91c7\u96c6\u6216\u624b\u52a8\u4e0a\u4f20\u3002";
  if (/fetch failed|ENOTFOUND|certificate|SSL|network/i.test(message)) return "\u670d\u52a1\u5668\u65e0\u6cd5\u8bbf\u95ee\u8be5\u5730\u5740\uff0c\u53ef\u80fd\u662f DNS\u3001\u8bc1\u4e66\u3001\u7f51\u7edc\u6216\u76ee\u6807\u7ad9\u9632\u62a4\u9650\u5236\u3002";
  return message;
}

const MAX_COLLECT_BYTES = 500_000;

/**
 * 按响应实际字符集解码。平台导出的 CSV/TXT 常见 GBK/GB18030，
 * response.text() 一律按 UTF-8 解会得到整片乱码，用户看到的是"获取失败/没有有效正文"。
 */
function decodeCollectedBody(buffer: ArrayBuffer, contentType = "") {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  const charset = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)?.[1]?.toLowerCase();
  if (!charset || charset === "utf-8" || charset === "utf8") return new TextDecoder("utf-8").decode(bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// HTTP 头的取值范围：名称是 token，值只能是可见 ASCII 加空格/制表符。
// 含中文的头值会被运行时静默丢弃（实测 workerd 就是这样），表现为"明明配了鉴权却还是 401"，
// 所以这里显式识别出来，交由保存路径直接报错。
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;
// 逐跳/连接控制类头由运行时管理，用户覆盖会让请求直接失败。
const RESERVED_HEADER = /^(host|content-length|connection|transfer-encoding)$/i;

function splitHeaderLine(line: string) {
  const index = line.indexOf(":");
  if (index <= 0) return null;
  const name = line.slice(0, index).trim();
  const value = line.slice(index + 1).trim();
  return name && value ? { name, value } : null;
}

/** 把"每行 Key: Value"的自定义请求头文本解析成对象；企业自有 API 基本都要带鉴权头。 */
export function parseRequestHeaders(text = "") {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const parsed = splitHeaderLine(line);
    if (!parsed) continue;
    if (RESERVED_HEADER.test(parsed.name)) continue;
    if (!HEADER_NAME.test(parsed.name) || !HEADER_VALUE.test(parsed.value)) continue;
    headers[parsed.name] = parsed.value;
  }
  return headers;
}

// 截图识别的入参上限：图片会整段进入模型请求体，不设上限会打爆上下文与网关。
export const MAX_OCR_IMAGES = 4;
export const MAX_OCR_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * 校验截图识别的入参。
 * 抽成纯函数是为了能在没有视觉模型的环境里也把这几道闸门测死——
 * 真实识别效果测不了，但"传 10 张""传 PDF""传 20MB"这些必须拦得住。
 */
export function validateOcrImages(input: unknown): { error: string } | { dataUrls: string[] } {
  const images = Array.isArray(input) ? input : [];
  if (!images.length) return { error: "请先选择或粘贴截图。" };
  if (images.length > MAX_OCR_IMAGES) return { error: `一次最多识别 ${MAX_OCR_IMAGES} 张截图，请分批处理。` };
  const dataUrls: string[] = [];
  for (const item of images) {
    const url = typeof item === "string" ? item.trim() : "";
    if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(url)) return { error: "只支持 PNG、JPG、WebP 格式的截图。" };
    // base64 每 4 个字符还原 3 字节，据此估算原图大小，避免先解码再判断。
    if (url.length * 0.75 > MAX_OCR_IMAGE_BYTES) return { error: `单张截图不能超过 ${MAX_OCR_IMAGE_BYTES / 1024 / 1024}MB，请裁剪后再试。` };
    dataUrls.push(url);
  }
  return { dataUrls };
}

/** 保存前校验：返回不合法的请求头说明，空数组表示全部可用。 */
export function invalidRequestHeaders(text = "") {
  const problems: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = splitHeaderLine(line);
    if (!parsed) {
      problems.push(`「${line.trim().slice(0, 40)}」不是 Key: Value 格式`);
      continue;
    }
    if (RESERVED_HEADER.test(parsed.name)) {
      problems.push(`${parsed.name} 由系统管理，不能自定义`);
    } else if (!HEADER_NAME.test(parsed.name)) {
      problems.push(`${parsed.name.slice(0, 40)} 不是合法的请求头名称`);
    } else if (!HEADER_VALUE.test(parsed.value)) {
      problems.push(`${parsed.name} 的值含中文或其他非 ASCII 字符，会被网络层丢弃`);
    }
  }
  return problems;
}

/** 审计与日志里只保留头名称，绝不写出 token 值。 */
function describeRequestHeaders(headers: Record<string, string>) {
  const names = Object.keys(headers);
  return names.length ? `自定义请求头：${names.join("、")}` : "";
}

async function fetchForCollection(url: URL, method: string, extraHeaders: Record<string, string> = {}) {
  const requestMethod = method === "POST" ? "POST" : "GET";
  const baseHeaders: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Haixin-Collector/2.0",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/csv,text/plain;q=0.8,*/*;q=0.7",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
  };
  const browserHeaders = { ...baseHeaders, ...extraHeaders };
  // 每次出网前重新校验：调用方可能传入爬虫新发现的链接。
  assertPublicCollectionUrl(url);
  if (runtime.COLLECTOR_PROXY_URL) {
    const proxyResponse = await fetch(runtime.COLLECTOR_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url: url.toString(), method: requestMethod, headers: browserHeaders, extraHeaders }),
      signal: AbortSignal.timeout(20000),
    });
    const payload = await proxyResponse.json().catch(() => null) as null | { ok?: boolean; httpStatus?: number; contentType?: string; body?: string; error?: string; truncated?: boolean };
    if (!proxyResponse.ok || !payload?.ok) throw new Error(payload?.error || `采集代理返回 ${proxyResponse.status}`);
    return {
      httpStatus: Number(payload.httpStatus || 0),
      contentType: payload.contentType || "text/plain",
      raw: String(payload.body || "").slice(0, MAX_COLLECT_BYTES),
      truncated: Boolean(payload.truncated),
    };
  }
  // 手动跟随重定向：默认的自动跟随会绕过上面的校验，把 302 指向内网的地址直接取回。
  let current = url;
  let headers: Record<string, string> = browserHeaders;
  let response: Response | null = null;
  for (let hop = 0; hop < 5; hop += 1) {
    response = await fetch(current.toString(), { method: requestMethod, headers, redirect: "manual", signal: AbortSignal.timeout(20000) });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) break;
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error("采集地址重定向目标无法解析");
    }
    assertPublicCollectionUrl(next);
    // 跨站跳转丢弃自定义鉴权头，避免把 token 泄漏给跳转目标。
    if (next.origin !== current.origin) headers = baseHeaders;
    current = next;
    response = null;
  }
  if (!response) throw new Error("采集地址重定向次数过多");
  const contentType = response.headers.get("content-type") || "text/plain";
  const buffer = await response.arrayBuffer();
  return {
    httpStatus: response.status,
    contentType,
    raw: decodeCollectedBody(buffer, contentType).slice(0, MAX_COLLECT_BYTES),
    truncated: buffer.byteLength > MAX_COLLECT_BYTES,
  };
}

export async function collectSource(sourceId: number, actor: string, testOnly = false) {
  const source = await runtime.DB.prepare("SELECT s.id,s.name,s.source_type AS sourceType,s.source_url AS sourceUrl,d.request_method AS requestMethod,d.request_headers AS requestHeaders,d.sample_data AS sampleData,d.content_selector AS contentSelector,d.extract_fields AS extractFields,d.target_category AS targetCategory,d.visibility,d.publish_mode AS publishMode,d.model_mode AS modelMode,d.target_store AS targetStore,d.output_format AS outputFormat,d.collector_mode AS collectorMode,d.platform,d.keyword,d.crawl_depth AS crawlDepth,d.max_pages AS maxPages,d.url_pattern AS urlPattern,d.exclude_pattern AS excludePattern,d.include_comments AS includeComments,d.export_profile AS exportProfile,d.respect_robots AS respectRobots FROM data_sources s LEFT JOIN data_source_details d ON d.source_id=s.id WHERE s.id=?").bind(sourceId).first<{ id: number; name: string; sourceType: string; sourceUrl: string; requestMethod: string; requestHeaders?: string; sampleData: string; contentSelector?: string; extractFields?: string; targetCategory?: string; visibility?: string; publishMode?: string; modelMode?: string; targetStore?: string; outputFormat?: string; collectorMode?: string; platform?: string; keyword?: string; crawlDepth?: number; maxPages?: number; urlPattern?: string; excludePattern?: string; includeComments?: string; exportProfile?: string; respectRobots?: string }>();
  if (!source) throw new Error("\u6570\u636e\u6e90\u4e0d\u5b58\u5728");
  const started = new Date().toISOString();
  let httpStatus = 0, contentType = "text/plain", raw = "";
  let collectedRows = 0;
  let truncated = false;
  const targetStore = normalizeTargetStore(source.targetStore);
  const outputFormat = normalizeOutputFormat(source.outputFormat);
  const collectorMode = normalizeCollectorMode(source.collectorMode);
  const publishMode = normalizePublishMode(source.publishMode);
  // 请求头里是 Authorization / X-Api-Key 等凭据，落库时已加密，这里解开再用。
  // 解不开（密钥缺失或被更换）时必须报错而不是静默丢头，否则表现为目标接口 401，很难查。
  let requestHeaders: Record<string, string> = {};
  if (source.requestHeaders?.trim()) {
    const plain = await decryptSecret(source.requestHeaders);
    if (plain === null) throw new Error("采集任务的自定义请求头无法解密，可能是平台凭证密钥（PLATFORM_CREDENTIALS_KEY）缺失或已更换，请重新填写请求头。");
    requestHeaders = parseRequestHeaders(plain);
  }
  const inlineCollector = ["paste", "screenshot", "mcp"].includes(collectorMode);
  try {
    if (inlineCollector || isInlineSource(source.sourceType)) {
      raw = source.sampleData?.trim() || "";
      if (!raw) {
        const hint = collectorMode === "screenshot"
          ? "\u8bf7\u5148\u7c98\u8d34\u622a\u56fe/OCR\u8bc6\u522b\u540e\u7684\u6587\u5b57\u6216\u8868\u683c\uff1b\u7cfb\u7edf\u53ea\u4fdd\u5b58\u7ed3\u6784\u5316\u6570\u636e\uff0c\u4e0d\u4fdd\u5b58\u56fe\u7247\u539f\u4ef6\u3002"
          : collectorMode === "mcp"
            ? "\u8bf7\u5148\u7c98\u8d34 MCP \u8fd4\u56de\u6570\u636e\uff0c\u6216\u901a\u8fc7\u5e73\u53f0\u63a5\u5165\u628a MCP \u7ed3\u679c\u5199\u5165\u672c\u91c7\u96c6\u4efb\u52a1\u3002"
            : "\u8bf7\u5148\u7c98\u8d34 CSV\u3001JSON\u3001\u5e73\u53f0\u5bfc\u51fa\u6587\u672c\u6216\u5df2\u6388\u6743\u91c7\u96c6\u7ed3\u679c\u3002";
        throw new Error(hint);
      }
      const firstLine = raw.split(/\r?\n/)[0] || "";
      const looksJson = raw.startsWith("{") || raw.startsWith("[");
      // 仅根据实际内容判断格式，不依赖 sourceType 预设。
      // 分隔符判断交给共享嗅探：之前只认逗号，从 Excel 粘贴的制表符表格会被当成纯文本。
      const looksCsv = looksLikeCsv(raw) || /^[^,\n]+,[^,\n]+/.test(firstLine);
      contentType = looksJson ? "application/json" : looksCsv ? "text/csv" : "text/plain";
    } else {
      const url = normalizeCollectionUrlInput(source.sourceUrl);
      const platform = normalizePlatform(source.platform);
      const shouldCrawl = collectorMode === "crawler" || source.sourceType.includes("\u4e07\u80fd");
      if (platform !== "web" && platform !== "custom_api" && !source.sampleData?.trim() && collectorMode !== "api" && collectorMode !== "mcp") {
        throw new Error(`${platformLabel(platform)} \u9700\u8981\u6388\u6743 API\u3001MCP\u3001\u8d26\u53f7\u5bfc\u51fa\u6570\u636e\u6216\u7c98\u8d34 OCR/\u5bfc\u51fa\u6587\u672c\u3002\u7cfb\u7edf\u4e0d\u4f1a\u7ed5\u8fc7\u767b\u5f55\u3001\u9a8c\u8bc1\u7801\u6216\u5e73\u53f0\u53cd\u6ee5\u7528\u4fdd\u62a4\u3002`);
      }
      const fetched = shouldCrawl ? await crawlWebsite(url, {
        method: source.requestMethod,
        maxPages: clampNumber(source.maxPages, 5, 1, 50),
        depth: clampNumber(source.crawlDepth, 1, 0, 3),
        includePattern: source.urlPattern || "",
        excludePattern: source.excludePattern || "",
        platform,
        keyword: source.keyword || "",
        includeComments: normalizeYesNo(source.includeComments),
        contentSelector: source.contentSelector || "",
      }) : await fetchForCollection(url, source.requestMethod, requestHeaders);
      httpStatus = fetched.httpStatus;
      contentType = fetched.contentType;
      raw = fetched.raw;
      truncated = "truncated" in fetched ? Boolean(fetched.truncated) : false;
      collectedRows = "rowCount" in fetched ? Number(fetched.rowCount || 0) : 0;
      ensureUsableCollectedContent(raw, httpStatus, contentType);
      if (contentType.includes("text/html")) raw = applyContentSelector(raw, source.contentSelector || "");
    }

    let normalized = contentType.includes("text/html") ? htmlToText(decodeHtml(raw)) : raw.trim();
    if (!normalized) throw new Error("\u91c7\u96c6\u6210\u529f\uff0c\u4f46\u6ca1\u6709\u5f97\u5230\u53ef\u7528\u5185\u5bb9");

    let rowCount = 1;
    if (contentType.includes("json")) {
      try {
        const parsed = JSON.parse(normalized);
        // \u4fe1\u5c01\u5f0f\u54cd\u5e94\uff08{code,data:{list}}\uff09\u6309\u660e\u7ec6\u6761\u6570\u7edf\u8ba1\uff0c\u5426\u5219\u4e00\u5f8b\u8bb0\u6210 1 \u6761\uff0c\u770b\u4e0d\u51fa\u5230\u5e95\u91c7\u5230\u591a\u5c11\u3002
        rowCount = unwrapJsonRecords(parsed)?.length ?? (Array.isArray(parsed) ? parsed.length : 1);
      } catch {
        // \u622a\u65ad\u5bfc\u81f4\u7684\u89e3\u6790\u5931\u8d25\u8981\u8bf4\u6e05\u695a\uff0c\u5426\u5219\u7528\u6237\u4ee5\u4e3a\u662f\u63a5\u53e3\u8fd4\u56de\u4e86\u975e\u6cd5 JSON\u3002
        throw new Error(truncated
          ? `\u54cd\u5e94\u8d85\u8fc7 ${Math.round(MAX_COLLECT_BYTES / 1000)}KB \u5df2\u88ab\u622a\u65ad\uff0cJSON \u4e0d\u5b8c\u6574\u3002\u8bf7\u5728\u63a5\u53e3\u4e0a\u52a0\u5206\u9875\u6216\u65f6\u95f4\u8303\u56f4\u53c2\u6570\uff0c\u6216\u7f29\u5c0f\u91c7\u96c6\u8303\u56f4\u3002`
          : "\u8fd4\u56de\u5185\u5bb9\u4e0d\u662f\u6709\u6548 JSON");
      }
    } else if (contentType.includes("csv")) {
      rowCount = Math.max(0, splitCsvRecords(normalized).length - 1);
    } else if (contentType === "text/crawl-content" || contentType === "text/crawl-report") {
      rowCount = Math.max(1, collectedRows);
    } else {
      // 普通文本：按行数估算
      rowCount = Math.max(1, normalized.split(/\r?\n/).filter(Boolean).length);
    }

    const modelMode = source.modelMode || "auto";
    const extractFields = parseExtractFields(source.extractFields || "");
    if (extractFields.length) {
      const extracted = await extractRequestedFields(actor, normalized, extractFields, modelMode, outputFormat, source.sourceUrl || "");
      normalized = extracted.normalized;
      rowCount = extracted.rowCount;
      contentType = outputFormat === "json" ? "application/json; extracted-fields" : "text/extracted-fields";
    }
    let preview = formatCollectionOutput(normalized, contentType, source.sourceType, outputFormat, "", source.sourceUrl || "");
    let modelUsed = modelMode === "none" ? "\u672a\u8c03\u7528\u6a21\u578b" : modelMode;
    if (!extractFields.length && modelMode !== "none" && normalized.trim()) {
      try {
        const summary = await askModel(actor, `\u8bf7\u628a\u4e0b\u9762\u91c7\u96c6\u5230\u7684\u6b63\u6587\u6570\u636e\u6574\u7406\u6210\u7ed3\u6784\u6e05\u6670\u3001\u53ef\u5165\u5e93\u7684\u4e2d\u6587\u5185\u5bb9\u3002\u8981\u6c42\uff1a1. \u53ea\u8f93\u51fa\u91c7\u96c6\u5230\u7684\u5185\u5bb9\u672c\u8eab\uff0c\u4e0d\u8981\u8f93\u51fa\u91c7\u96c6\u8fc7\u7a0b\u3001\u914d\u7f6e\u4fe1\u606f\u3001\u6210\u529f\u5931\u8d25\u62a5\u544a\u6216\u5f02\u5e38\u5206\u6790\uff1b2. \u5fc5\u987b\u4fdd\u7559\u539f\u59cb\u4e8b\u5b9e\uff0c\u4e0d\u8981\u7f16\u9020\uff1b3. \u5982\u679c\u662f\u8868\u683c\u6216\u5217\u8868\uff0c\u53ea\u6574\u7406\u5b57\u6bb5\u542b\u4e49\u548c\u5b9e\u9645\u8bb0\u5f55\uff1b4. \u8f93\u51fa\u683c\u5f0f\u6309\u201c${outputFormatLabels[outputFormat]}\u201d\u7ec4\u7ec7\u3002`, normalized.slice(0, 16000), modelMode);
        preview = formatCollectionOutput(normalized, contentType, source.sourceType, outputFormat, summary, source.sourceUrl || "");
      } catch {
        modelUsed = `${modelMode}\uff08\u6574\u7406\u5931\u8d25\uff0c\u5df2\u4fdd\u7559\u539f\u59cb\uff09`;
        preview = formatCollectionOutput(normalized, contentType, source.sourceType, outputFormat, "", source.sourceUrl || "");
      }
    }

    if (testOnly) return { ok: true, httpStatus, contentType, rowCount, modelUsed, targetStore, outputFormat, collectorMode, publishMode, preview: preview.slice(0, 1200) };

    if (publishMode === "record_only") {
      const recorded = await runtime.DB.prepare("INSERT INTO data_collection_runs(source_id,source_name,actor,status,http_status,row_count,content_type,preview,model_used,target_store,output_format,collector_mode,created_at,published_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id")
        .bind(source.id, source.name, actor, "\u5df2\u91c7\u96c6", httpStatus, rowCount, contentType, preview, modelUsed, targetStore, outputFormat, collectorMode, started, null).first<{ id: number }>();
      await runtime.DB.prepare("UPDATE data_sources SET status='\u5df2\u91c7\u96c6',last_run_at=? WHERE id=?").bind(started, source.id).run();
      await audit(actor, "\u8fd0\u884c\u91c7\u96c6", source.name, "\u6210\u529f", `\u91c7\u96c6${rowCount}\u6761\uff0c\u5df2\u4fdd\u5b58\u4e3a\u91c7\u96c6\u8bb0\u5f55#${recorded!.id}\uff1b\u672a\u81ea\u52a8\u5199\u5165\u77e5\u8bc6\u5e93`);
      return { ok: true, runId: recorded!.id, httpStatus, contentType, rowCount, modelUsed, targetStore, outputFormat, collectorMode, publishMode, preview: preview.slice(0, 1200) };
    }

    const autoTitle = `${source.name} ${new Date().toLocaleDateString("zh-CN")}`;
    const fileMeta = collectionFileMeta(autoTitle, outputFormat);
    let autoEnterpriseDocumentId: number | null = null;
    let insertedKnowledge = false;
    // \u53bb\u91cd\uff1a\u91c7\u96c6\u6b63\u6587\u4e0e\u8be5\u7528\u6237\u5df2\u6709\u77e5\u8bc6\u5b8c\u5168\u4e00\u81f4\u65f6\u4e0d\u518d\u91cd\u590d\u5165\u5e93\uff0c
    // \u907f\u514d\u5b9a\u65f6/\u91cd\u590d\u8fd0\u884c\u540c\u4e00\uff08\u5c24\u5176\u662f\u9759\u6001\u7c98\u8d34\uff09\u6570\u636e\u6e90\u65f6\u628a\u76f8\u540c\u5185\u5bb9\u5806\u6210\u4e0a\u767e\u6761\u3002
    if (targetStore === "enterprise" || targetStore === "both") {
      const existingDoc = await runtime.DB.prepare("SELECT id FROM knowledge_documents WHERE created_by=? AND category=? AND content=? ORDER BY id DESC LIMIT 1")
        .bind(actor, source.targetCategory || "\u6570\u636e\u91c7\u96c6", preview).first<{ id: number }>();
      if (existingDoc) {
        autoEnterpriseDocumentId = existingDoc.id;
      } else {
        const createdDoc = await runtime.DB.prepare("INSERT INTO knowledge_documents(title,content,visibility,filename,mime_type,file_key,category,tags,version,update_mode,update_schedule,status,size_bytes,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id")
          .bind(autoTitle, preview, source.visibility || "\u5168\u5458", fileMeta.filename, fileMeta.mimeType, "", source.targetCategory || "\u6570\u636e\u91c7\u96c6", `\u81ea\u52a8\u91c7\u96c6,${collectorModeLabels[collectorMode]},${outputFormatLabels[outputFormat]}`, 1, "\u624b\u52a8\u91c7\u96c6", "", "\u5df2\u7d22\u5f15", new TextEncoder().encode(preview).length, actor, started, started).first<{ id: number }>();
        autoEnterpriseDocumentId = createdDoc?.id || null;
        insertedKnowledge = true;
      }
    }
    if (targetStore === "personal" || targetStore === "both") {
      const existingPersonal = await runtime.DB.prepare("SELECT id FROM personal_knowledge WHERE owner_email=? AND content=? ORDER BY id DESC LIMIT 1")
        .bind(actor, preview).first<{ id: number }>();
      if (!existingPersonal) {
        await runtime.DB.prepare("INSERT INTO personal_knowledge(owner_email,title,content,source_type,conversation_id,sync_status,enterprise_document_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
          .bind(actor, autoTitle, preview, `\u6570\u636e\u91c7\u96c6/${outputFormatLabels[outputFormat]} \u00b7 ${collectorModeLabels[collectorMode]}`, null, targetStore === "both" ? "\u5df2\u540c\u6b65\u4f01\u4e1a\u77e5\u8bc6" : "\u4ec5\u4e2a\u4eba", autoEnterpriseDocumentId, started, started).run();
        insertedKnowledge = true;
      }
    }
    const autoRunStatus = insertedKnowledge ? "\u5df2\u5165\u77e5\u8bc6\u5e93" : "\u5df2\u8df3\u8fc7\u00b7\u65e0\u65b0\u589e";
    const autoCreated = await runtime.DB.prepare("INSERT INTO data_collection_runs(source_id,source_name,actor,status,http_status,row_count,content_type,preview,model_used,target_store,output_format,collector_mode,created_at,published_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id").bind(source.id, source.name, actor, autoRunStatus, httpStatus, rowCount, contentType, preview, modelUsed, targetStore, outputFormat, collectorMode, started, started).first<{ id: number }>();
    await runtime.DB.prepare("UPDATE data_sources SET status='\u5df2\u5165\u5e93',last_run_at=? WHERE id=?").bind(started, source.id).run();
    await audit(actor, "\u8fd0\u884c\u91c7\u96c6", source.name, "\u6210\u529f", insertedKnowledge
      ? `\u91c7\u96c6${rowCount}\u6761\uff0c\u5df2\u81ea\u52a8\u8fdb\u5165${targetStoreLabels[targetStore]}\uff1b\u8fd0\u884c#${autoCreated!.id}\uff1b\u683c\u5f0f\uff1a${outputFormatLabels[outputFormat]}\uff1b\u65b9\u5f0f\uff1a${collectorModeLabels[collectorMode]}${describeRequestHeaders(requestHeaders) ? `\uff1b${describeRequestHeaders(requestHeaders)}` : ""}`
      : `\u91c7\u96c6${rowCount}\u6761\uff0c\u5185\u5bb9\u4e0e\u5df2\u6709\u77e5\u8bc6\u4e00\u81f4\uff0c\u53bb\u91cd\u8df3\u8fc7\u672a\u65b0\u589e\uff1b\u8fd0\u884c#${autoCreated!.id}`);
    return { ok: true, runId: autoCreated!.id, httpStatus, contentType, rowCount, modelUsed, targetStore, outputFormat, collectorMode, publishMode, preview: preview.slice(0, 1200) };
  } catch (error) {
    const message = explainCollectionError(error, httpStatus);
    if (!testOnly) {
      await runtime.DB.prepare("INSERT INTO data_collection_runs(source_id,source_name,actor,status,http_status,error,model_used,target_store,output_format,collector_mode,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(source.id, source.name, actor, "\u5931\u8d25", httpStatus, message, source.modelMode || "auto", targetStore, outputFormat, collectorMode, started).run();
      await runtime.DB.prepare("UPDATE data_sources SET status='\u91c7\u96c6\u5931\u8d25',last_run_at=? WHERE id=?").bind(started, source.id).run();
      await audit(actor, "\u8fd0\u884c\u91c7\u96c6", source.name, "\u5931\u8d25", message);
    }
    throw new Error(message);
  }
}

// ─── AI 驱动采集 ───────────────────────────────────────

/**
 * 估算 AI 产出里的数据条数
 *
 * row_count 这一列在列表里显示为"采集 N 条"。AI 采集拿到的是自由文本，没有真正的行概念，
 * 只有输出成 Markdown 表格时"条数"才有意义——认表头分隔行（| --- |）之后的数据行。
 * 认不出表格就返回 0，不拿行数、字数之类的近似值冒充条数。
 */
function countMarkdownTableRows(text: string) {
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const separator = lines.findIndex(line => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line));
  if (separator < 0) return 0;
  let rows = 0;
  for (let i = separator + 1; i < lines.length; i += 1) {
    if (!lines[i].startsWith("|")) break;
    rows += 1;
  }
  return rows;
}

/**
 * 使用 AI + Skills 进行智能数据采集
 *
 * 用户只需用自然语言描述采集需求（如"帮我采集这个网页的标题和价格"），
 * AI 会自动选择合适的技能（fetchUrl、htmlToText、extractFromCsv 等）来执行。
 */
export async function collectWithAI(
  actor: string,
  prompt: string,
  options: {
    url?: string;
    modelMode?: string;
    targetStore?: string;
    outputFormat?: string;
  } = {},
) {
  const targetStore = normalizeTargetStore(options.targetStore);
  const outputFormat = normalizeOutputFormat(options.outputFormat);
  const modelMode = options.modelMode || "auto";

  const systemPrompt = [
    "你是智能数据采集助手。你可以使用以下工具来采集和处理数据：",
    "",
    "【网页/API 采集】",
    "1. fetchUrl - 获取网页或 API 内容",
    "2. crawlWebsite - 爬取整个网站（支持递归深度和 URL 规则）",
    "3. readWebPage - 使用 Jina AI Reader 将 URL 内容转换为干净 Markdown（自动去广告/导航）",
    "4. extractContentBySelector - 按 CSS 选择器提取内容",
    "5. extractLinks - 提取页面链接",
    "",
    "【内容处理】",
    "6. htmlToText - 将 HTML 转换为纯文本",
    "7. extractFromJson - 从 JSON 提取字段",
    "8. extractFromCsv - 从 CSV 提取列",
    "9. convertToMarkdownTable - 转换数据为 Markdown 表格",
    "",
    "【跨平台社区搜索】",
    "10. searchReddit - 搜索 Reddit 社区热门/最新帖子",
    "11. searchV2EX - 获取 V2EX 社区热门主题和回复",
    "12. searchGitHub - 搜索 GitHub 仓库、代码、Issue 和用户",
    "13. searchHackerNews - 搜索 Hacker News 热门故事和讨论",
    "14. readRSS - 读取 RSS/Atom 订阅源文章",
    "",
    "请根据用户需求自主选择工具，分步执行。",
    "采集完成后，整理结果为结构化格式，便于存入知识库。",
    "不要输出工具调用过程，只输出采集结果。",
  ].join("\n");

  const userMessage = options.url
    ? `采集目标：${options.url}\n\n需求：${prompt}\n\n输出格式：${outputFormat}\n存储目标：${targetStore}`
    : `需求：${prompt}\n\n输出格式：${outputFormat}\n存储目标：${targetStore}`;

  const started = new Date().toISOString();
  // AI 采集是即席任务，没有对应的 data_sources 行，而 data_collection_runs.source_id 是 NOT NULL，
  // 因此用 0 作哨兵：运行记录、数据清洗、确认入库、删除日志都能直接复用常规采集那一套，
  // approveSourceRun 里的 LEFT JOIN 只会拿到 NULL，那边本来就有 `|| "数据采集"` 之类的兜底。
  const trimmedPrompt = prompt.trim();
  const runName = `AI采集：${trimmedPrompt.slice(0, 40)}${trimmedPrompt.length > 40 ? "…" : ""}`;

  try {
    const { text, toolCalls } = await askModelWithSkills(actor, systemPrompt, userMessage, modelMode);
    const preview = text.slice(0, 12000);
    // 空结果不能当成功记下：入库后会在知识库里留一条空文档，比直接报错更难排查。
    if (!preview.trim()) throw new Error("AI 未产出可入库的内容，请补充采集需求或指定目标网址后重试");

    // 工具调用次数原先只在前端一闪而过，落到 model_used 里才追得回这次采集到底做了什么。
    const modelUsed = `${modelMode}（调用${toolCalls.length}次工具）`;
    const recorded = await runtime.DB.prepare("INSERT INTO data_collection_runs(source_id,source_name,actor,status,http_status,row_count,content_type,preview,model_used,target_store,output_format,collector_mode,created_at,published_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id")
      .bind(0, runName, actor, "已采集", 0, countMarkdownTableRows(preview), "text/ai-collect", preview, modelUsed, targetStore, outputFormat, "ai", started, null)
      .first<{ id: number }>();

    await audit(actor, "AI驱动采集", runName, "成功", `调用${toolCalls.length}次工具，产出${text.length}字符；已存为采集记录#${recorded!.id}，待确认入库`);

    return {
      ok: true,
      runId: recorded!.id,
      status: "已采集",
      text: preview,
      toolCalls: toolCalls.length,
      modelMode,
      modelUsed,
      targetStore,
      outputFormat,
      createdAt: started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "采集失败";
    // 失败同样落库：否则一次 AI 采集失败后，界面上什么痕迹都不剩，只能去翻审计日志。
    await runtime.DB.prepare("INSERT INTO data_collection_runs(source_id,source_name,actor,status,http_status,error,model_used,target_store,output_format,collector_mode,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .bind(0, runName, actor, "失败", 0, message, modelMode, targetStore, outputFormat, "ai", started).run();
    await audit(actor, "AI驱动采集", runName, "失败", message);
    throw new Error(message);
  }
}

export {
  targetStoreLabels,
  outputFormatLabels,
  collectorModeLabels,
  normalizeTargetStore,
  normalizeOutputFormat,
  normalizeCollectorMode,
  normalizePublishMode,
  clampNumber,
  normalizePlatform,
  normalizeYesNo,
  isInlineSource,
  collectionFileMeta,
};
