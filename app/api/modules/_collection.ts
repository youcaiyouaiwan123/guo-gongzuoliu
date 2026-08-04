import { runtime, askModel, askModelWithSkills, audit } from "./_shared";

function htmlToText(value: string) {
  return value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

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
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("采集地址只支持 http/https");
  url.hash = "";
  return url;
}

function extractTitle(html: string, fallback = "") {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || fallback;
  return htmlToText(decodeHtml(title)).slice(0, 120);
}

function applyContentSelector(html: string, selector = "") {
  const rule = selector.trim();
  if (!rule || !html) return html;
  const escaped = escapeRegExp(rule.slice(1));
  let pattern: RegExp | null = null;
  if (rule.startsWith("#")) {
    pattern = new RegExp(`<([a-z0-9-]+)[^>]*\\bid=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, "i");
  } else if (rule.startsWith(".")) {
    pattern = new RegExp(`<([a-z0-9-]+)[^>]*\\bclass=["'][^"']*${escaped}[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, "i");
  } else if (/^[a-z][a-z0-9-]*$/i.test(rule)) {
    pattern = new RegExp(`<${rule}[^>]*>([\\s\\S]*?)<\\/${rule}>`, "i");
  }
  const match = pattern?.exec(html);
  return (match?.[2] || match?.[1] || html).trim();
}

function looksLikeBlockedPage(raw: string, httpStatus: number, contentType = "") {
  if ([401, 403, 429].includes(httpStatus)) return true;
  if (!contentType.toLowerCase().includes("html")) return false;
  const sample = `${raw.slice(0, 3000)} ${htmlToText(raw).slice(0, 3000)}`.toLowerCase();
  return /(captcha|access denied|forbidden|enable javascript|cloudflare|\u5b89\u5168\u9a8c\u8bc1|\u4eba\u673a\u9a8c\u8bc1|\u767b\u5f55\u540e|\u8bf7\u767b\u5f55|\u8bbf\u95ee\u53d7\u9650|\u98ce\u9669\u9a8c\u8bc1)/i.test(sample);
}

function looksLikeEmptyShellContent(raw: string, contentType = "") {
  const text = (contentType.toLowerCase().includes("html") ? htmlToText(decodeHtml(raw)) : raw)
    .replace(/\s+/g, " ")
    .trim();
  const compact = text.toLowerCase().replace(/[\s"'`.,;:|#*_~\-\u2014\u3002\uff0c\uff1a\uff1b\uff01\uff1f]/g, "");
  if (!compact) return true;
  if (/^(client|loading|load|app|root|ok|null|undefined|success|error)$/.test(compact)) return true;
  if (compact.length <= 12 && /^(client|loading|app|root|ok|api)$/.test(compact)) return true;
  return false;
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternMatches(value: string, pattern = "") {
  const rules = pattern.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
  if (!rules.length) return true;
  return rules.some(rule => {
    if (rule.includes("*")) return new RegExp(`^${escapeRegExp(rule).replace(/\\\*/g, ".*")}$`, "i").test(value);
    return value.toLowerCase().includes(rule.toLowerCase());
  });
}

function patternExcluded(value: string, pattern = "") {
  const rules = pattern.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
  return rules.some(rule => {
    if (rule.includes("*")) return new RegExp(`^${escapeRegExp(rule).replace(/\\\*/g, ".*")}$`, "i").test(value);
    return value.toLowerCase().includes(rule.toLowerCase());
  });
}

function isSkippableCrawlUrl(url: URL) {
  return /\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf|zip|rar|7z|mp4|mp3|wav|avi|mov|xlsx?|docx?|pptx?)$/i.test(url.pathname);
}

function extractLinks(html: string, base: URL, includePattern = "", excludePattern = "") {
  const links = new Set<string>();
  const regex = /href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    const href = match[1];
    if (!href || href.startsWith("#") || /^javascript:/i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href)) continue;
    try {
      const next = new URL(href, base);
      next.hash = "";
      if (next.origin !== base.origin) continue;
      if (isSkippableCrawlUrl(next)) continue;
      const value = next.toString();
      if (!patternMatches(value, includePattern)) continue;
      if (patternExcluded(value, excludePattern)) continue;
      links.add(value);
    } catch {}
  }
  return Array.from(links);
}

async function crawlWebsite(seed: URL, options: { method: string; maxPages: number; depth: number; includePattern?: string; excludePattern?: string; platform?: string; keyword?: string; includeComments?: string; contentSelector?: string }) {
  const queue: Array<{ url: URL; depth: number }> = [{ url: seed, depth: 0 }];
  const visited = new Set<string>();
  const pages: Array<{ url: string; title: string; text: string; status: number; contentType: string }> = [];
  let firstStatus = 0;
  while (queue.length && pages.length < options.maxPages) {
    const current = queue.shift()!;
    const key = current.url.toString();
    if (visited.has(key)) continue;
    visited.add(key);
    const fetched = await fetchForCollection(current.url, options.method);
    if (!firstStatus) firstStatus = fetched.httpStatus;
    if (fetched.httpStatus < 200 || fetched.httpStatus >= 300) {
      pages.push({ url: key, title: `HTTP ${fetched.httpStatus}`, text: htmlToText(fetched.raw).slice(0, 1200), status: fetched.httpStatus, contentType: fetched.contentType });
      continue;
    }
    if (looksLikeBlockedPage(fetched.raw, fetched.httpStatus, fetched.contentType)) {
      pages.push({ url: key, title: "\u8bbf\u95ee\u53d7\u9650", text: htmlToText(fetched.raw).slice(0, 1200), status: fetched.httpStatus, contentType: fetched.contentType });
      continue;
    }
    const selectedRaw = fetched.contentType.includes("text/html") ? applyContentSelector(fetched.raw, options.contentSelector) : fetched.raw;
    const text = fetched.contentType.includes("text/html") ? htmlToText(decodeHtml(selectedRaw)) : selectedRaw.trim();
    if (looksLikeEmptyShellContent(text, "text/plain")) continue;
    pages.push({ url: key, title: extractTitle(fetched.raw, current.url.pathname || current.url.hostname), text: text.slice(0, 12000), status: fetched.httpStatus, contentType: fetched.contentType });
    if (current.depth < options.depth && fetched.contentType.includes("text/html")) {
      for (const link of extractLinks(fetched.raw, current.url, options.includePattern, options.excludePattern)) {
        if (!visited.has(link) && queue.length + pages.length < options.maxPages * 3) queue.push({ url: new URL(link), depth: current.depth + 1 });
      }
    }
  }
  if (!pages.length) throw new Error("\u722c\u866b\u672a\u91c7\u96c6\u5230\u53ef\u7528\u9875\u9762\uff0c\u8bf7\u68c0\u67e5 URL\u3001\u6293\u53d6\u8303\u56f4\u6216\u7f51\u7ad9\u6743\u9650\u3002");
  const usablePages = pages.filter(page => !looksLikeEmptyShellContent(page.text, "text/plain"));
  if (!usablePages.length) throw new Error("\u672a\u91c7\u96c6\u5230\u6709\u6548\u6b63\u6587\uff0c\u76ee\u6807\u9875\u9762\u53ea\u8fd4\u56de\u7a7a\u58f3/\u5360\u4f4d\u5185\u5bb9\u3002\u8bf7\u6539\u7528\u53ef\u8fd4\u56de\u6570\u636e\u7684 API\u3001JS \u6e32\u67d3\u91c7\u96c6\u3001MCP\u3001\u5bfc\u51fa\u4e0a\u4f20\u6216\u7c98\u8d34\u6b63\u6587\u5165\u5e93\u3002");
  const records = usablePages.map((page, index) => [
    `# ${page.title || `Page ${index + 1}`}`,
    `来源：${page.url}`,
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

function splitCsvLine(line: string) {
  const cells: string[] = [];
  let cell = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') { cell += '"'; i++; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === "," && !quoted) { cells.push(cell.trim()); cell = ""; continue; }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function jsonToMarkdownTable(value: string) {
  const parsed = JSON.parse(value);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const objects = rows.filter(item => item && typeof item === "object" && !Array.isArray(item)).slice(0, 50) as Record<string, unknown>[];
  if (!objects.length) return "```json\n" + JSON.stringify(parsed, null, 2).slice(0, 12000) + "\n```";
  const headers = Array.from(new Set(objects.flatMap(item => Object.keys(item)))).slice(0, 12);
  const body = objects.map(item => `| ${headers.map(key => String(item[key] ?? "").replace(/\|/g, "\\|").slice(0, 120)).join(" | ")} |`).join("\n");
  return `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${body}`;
}

function csvToMarkdownTable(value: string) {
  const lines = value.split(/\r?\n/).filter(Boolean).slice(0, 51);
  if (!lines.length) return "";
  const rows = lines.map(splitCsvLine);
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

function formatCollectionOutput(normalized: string, contentType: string, sourceType: string, outputFormat: string, aiSummary = "") {
  if (outputFormat === "raw") return normalized.slice(0, 12000);
  if (outputFormat === "json") {
    return normalizeJsonForKnowledge(normalized);
  }
  if (outputFormat === "table") {
    if (contentType.includes("json") || sourceType.includes("JSON")) {
      try { return jsonToMarkdownTable(normalized).slice(0, 12000); } catch {}
    }
    if (contentType.includes("csv") || sourceType.includes("CSV")) return csvToMarkdownTable(normalized).slice(0, 12000);
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
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map(h => h.trim());
  if (header.length < 2) return [];
  // 检查是否真的是 CSV：第二行也包含逗号且列数匹配
  const dataLines = lines.slice(1).filter(l => l.split(",").length === header.length);
  if (dataLines.length === 0) return [];
  const colIndices = fields.map(f => {
    const lowerField = f.toLowerCase();
    const idx = header.findIndex(h =>
      h.toLowerCase() === lowerField ||
      h.toLowerCase().includes(lowerField) ||
      lowerField.includes(h.toLowerCase())
    );
    return idx >= 0 ? idx : -1;
  });
  if (colIndices.every(i => i === -1)) return [];
  return dataLines.map(line => {
    const vals = line.split(",").map(v => v.trim());
    const row: Record<string, string> = { 来源: "" };
    fields.forEach((f, i) => {
      row[f] = colIndices[i] >= 0 ? vals[colIndices[i]] ?? "" : "";
    });
    return row;
  });
}

/** 尝试按 JSON 数组解析提取字段 */
function extractFromJson(text: string, fields: string[]): Record<string, string>[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return [];
  try {
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const rows: Record<string, string>[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row: Record<string, string> = { 来源: "" };
      let hasAny = false;
      for (const field of fields) {
        const val = (item as Record<string, unknown>)[field];
        row[field] = val !== undefined && val !== null ? String(val).trim() : "";
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

async function fetchForCollection(url: URL, method: string) {
  const requestMethod = method === "POST" ? "POST" : "GET";
  const browserHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Haixin-Collector/2.0",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/csv,text/plain;q=0.8,*/*;q=0.7",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
  };
  if (runtime.COLLECTOR_PROXY_URL) {
    const proxyResponse = await fetch(runtime.COLLECTOR_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url: url.toString(), method: requestMethod, headers: browserHeaders }),
      signal: AbortSignal.timeout(20000),
    });
    const payload = await proxyResponse.json().catch(() => null) as null | { ok?: boolean; httpStatus?: number; contentType?: string; body?: string; error?: string };
    if (!proxyResponse.ok || !payload?.ok) throw new Error(payload?.error || `采集代理返回 ${proxyResponse.status}`);
    return {
      httpStatus: Number(payload.httpStatus || 0),
      contentType: payload.contentType || "text/plain",
      raw: String(payload.body || "").slice(0, 500000),
    };
  }
  const response = await fetch(url.toString(), { method: requestMethod, headers: browserHeaders, signal: AbortSignal.timeout(20000) });
  return {
    httpStatus: response.status,
    contentType: response.headers.get("content-type") || "text/plain",
    raw: (await response.text()).slice(0, 500000),
  };
}

export async function collectSource(sourceId: number, actor: string, testOnly = false) {
  const source = await runtime.DB.prepare("SELECT s.id,s.name,s.source_type AS sourceType,s.source_url AS sourceUrl,d.request_method AS requestMethod,d.sample_data AS sampleData,d.content_selector AS contentSelector,d.extract_fields AS extractFields,d.target_category AS targetCategory,d.visibility,d.publish_mode AS publishMode,d.model_mode AS modelMode,d.target_store AS targetStore,d.output_format AS outputFormat,d.collector_mode AS collectorMode,d.platform,d.keyword,d.crawl_depth AS crawlDepth,d.max_pages AS maxPages,d.url_pattern AS urlPattern,d.exclude_pattern AS excludePattern,d.include_comments AS includeComments,d.export_profile AS exportProfile,d.respect_robots AS respectRobots FROM data_sources s LEFT JOIN data_source_details d ON d.source_id=s.id WHERE s.id=?").bind(sourceId).first<{ id: number; name: string; sourceType: string; sourceUrl: string; requestMethod: string; sampleData: string; contentSelector?: string; extractFields?: string; targetCategory?: string; visibility?: string; publishMode?: string; modelMode?: string; targetStore?: string; outputFormat?: string; collectorMode?: string; platform?: string; keyword?: string; crawlDepth?: number; maxPages?: number; urlPattern?: string; excludePattern?: string; includeComments?: string; exportProfile?: string; respectRobots?: string }>();
  if (!source) throw new Error("\u6570\u636e\u6e90\u4e0d\u5b58\u5728");
  const started = new Date().toISOString();
  let httpStatus = 0, contentType = "text/plain", raw = "";
  let collectedRows = 0;
  const targetStore = normalizeTargetStore(source.targetStore);
  const outputFormat = normalizeOutputFormat(source.outputFormat);
  const collectorMode = normalizeCollectorMode(source.collectorMode);
  const publishMode = normalizePublishMode(source.publishMode);
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
      const looksCsv = /^[^,\n]+,[^,\n]+/.test(firstLine);
      // 仅根据实际内容判断格式，不依赖 sourceType 预设
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
      }) : await fetchForCollection(url, source.requestMethod);
      httpStatus = fetched.httpStatus;
      contentType = fetched.contentType;
      raw = fetched.raw;
      collectedRows = "rowCount" in fetched ? Number(fetched.rowCount || 0) : 0;
      ensureUsableCollectedContent(raw, httpStatus, contentType);
      if (contentType.includes("text/html")) raw = applyContentSelector(raw, source.contentSelector || "");
    }

    let normalized = contentType.includes("text/html") ? htmlToText(decodeHtml(raw)) : raw.trim();
    if (!normalized) throw new Error("\u91c7\u96c6\u6210\u529f\uff0c\u4f46\u6ca1\u6709\u5f97\u5230\u53ef\u7528\u5185\u5bb9");

    let rowCount = 1;
    if (contentType.includes("json")) {
      try { const parsed = JSON.parse(normalized); rowCount = Array.isArray(parsed) ? parsed.length : 1; } catch { throw new Error("\u8fd4\u56de\u5185\u5bb9\u4e0d\u662f\u6709\u6548 JSON"); }
    } else if (contentType.includes("csv")) {
      rowCount = Math.max(0, normalized.split(/\r?\n/).filter(Boolean).length - 1);
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
    let preview = formatCollectionOutput(normalized, contentType, source.sourceType, outputFormat);
    let modelUsed = modelMode === "none" ? "\u672a\u8c03\u7528\u6a21\u578b" : modelMode;
    if (!extractFields.length && modelMode !== "none" && normalized.trim()) {
      try {
        const summary = await askModel(actor, `\u8bf7\u628a\u4e0b\u9762\u91c7\u96c6\u5230\u7684\u6b63\u6587\u6570\u636e\u6574\u7406\u6210\u7ed3\u6784\u6e05\u6670\u3001\u53ef\u5165\u5e93\u7684\u4e2d\u6587\u5185\u5bb9\u3002\u8981\u6c42\uff1a1. \u53ea\u8f93\u51fa\u91c7\u96c6\u5230\u7684\u5185\u5bb9\u672c\u8eab\uff0c\u4e0d\u8981\u8f93\u51fa\u91c7\u96c6\u8fc7\u7a0b\u3001\u914d\u7f6e\u4fe1\u606f\u3001\u6210\u529f\u5931\u8d25\u62a5\u544a\u6216\u5f02\u5e38\u5206\u6790\uff1b2. \u5fc5\u987b\u4fdd\u7559\u539f\u59cb\u4e8b\u5b9e\uff0c\u4e0d\u8981\u7f16\u9020\uff1b3. \u5982\u679c\u662f\u8868\u683c\u6216\u5217\u8868\uff0c\u53ea\u6574\u7406\u5b57\u6bb5\u542b\u4e49\u548c\u5b9e\u9645\u8bb0\u5f55\uff1b4. \u8f93\u51fa\u683c\u5f0f\u6309\u201c${outputFormatLabels[outputFormat]}\u201d\u7ec4\u7ec7\u3002`, normalized.slice(0, 16000), modelMode);
        preview = formatCollectionOutput(normalized, contentType, source.sourceType, outputFormat, summary);
      } catch {
        modelUsed = `${modelMode}\uff08\u6574\u7406\u5931\u8d25\uff0c\u5df2\u4fdd\u7559\u539f\u59cb\uff09`;
        preview = formatCollectionOutput(normalized, contentType, source.sourceType, outputFormat);
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
    if (targetStore === "enterprise" || targetStore === "both") {
      const createdDoc = await runtime.DB.prepare("INSERT INTO knowledge_documents(title,content,visibility,filename,mime_type,file_key,category,tags,version,update_mode,update_schedule,status,size_bytes,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id")
        .bind(autoTitle, preview, source.visibility || "\u5168\u5458", fileMeta.filename, fileMeta.mimeType, "", source.targetCategory || "\u6570\u636e\u91c7\u96c6", `\u81ea\u52a8\u91c7\u96c6,${collectorModeLabels[collectorMode]},${outputFormatLabels[outputFormat]}`, 1, "\u624b\u52a8\u91c7\u96c6", "", "\u5df2\u7d22\u5f15", new TextEncoder().encode(preview).length, actor, started, started).first<{ id: number }>();
      autoEnterpriseDocumentId = createdDoc?.id || null;
    }
    if (targetStore === "personal" || targetStore === "both") {
      await runtime.DB.prepare("INSERT INTO personal_knowledge(owner_email,title,content,source_type,conversation_id,sync_status,enterprise_document_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(actor, autoTitle, preview, `\u6570\u636e\u91c7\u96c6/${outputFormatLabels[outputFormat]} \u00b7 ${collectorModeLabels[collectorMode]}`, null, targetStore === "both" ? "\u5df2\u540c\u6b65\u4f01\u4e1a\u77e5\u8bc6" : "\u4ec5\u4e2a\u4eba", autoEnterpriseDocumentId, started, started).run();
    }
    const autoCreated = await runtime.DB.prepare("INSERT INTO data_collection_runs(source_id,source_name,actor,status,http_status,row_count,content_type,preview,model_used,target_store,output_format,collector_mode,created_at,published_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id").bind(source.id, source.name, actor, "\u5df2\u5165\u77e5\u8bc6\u5e93", httpStatus, rowCount, contentType, preview, modelUsed, targetStore, outputFormat, collectorMode, started, started).first<{ id: number }>();
    await runtime.DB.prepare("UPDATE data_sources SET status='\u5df2\u5165\u5e93',last_run_at=? WHERE id=?").bind(started, source.id).run();
    await audit(actor, "\u8fd0\u884c\u91c7\u96c6", source.name, "\u6210\u529f", `\u91c7\u96c6${rowCount}\u6761\uff0c\u5df2\u81ea\u52a8\u8fdb\u5165${targetStoreLabels[targetStore]}\uff1b\u8fd0\u884c#${autoCreated!.id}\uff1b\u683c\u5f0f\uff1a${outputFormatLabels[outputFormat]}\uff1b\u65b9\u5f0f\uff1a${collectorModeLabels[collectorMode]}`);
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

  try {
    const { text, toolCalls } = await askModelWithSkills(actor, systemPrompt, userMessage, modelMode);

    const result = {
      ok: true,
      text: text.slice(0, 12000),
      toolCalls: toolCalls.length,
      modelMode,
      targetStore,
      outputFormat,
      createdAt: started,
    };

    // 记录审计
    await audit(actor, "AI驱动采集", prompt.slice(0, 80), "成功", `调用${toolCalls.length}次工具，输出${text.length}字符`);

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "采集失败";
    await audit(actor, "AI驱动采集", prompt.slice(0, 80), "失败", message);
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
