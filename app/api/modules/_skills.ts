/**
 * 采集技能（工具）定义
 *
 * 将现有采集能力封装为 AI 可通过 function calling 调用的 skills。
 * 每个 skill 包含 OpenAI 兼容的 tool schema 和执行函数。
 */

import { assertPublicCollectionUrl } from "../_urlGuard";
import { crawlPages, htmlToText, decodeHtml, applyContentSelector, extractLinks } from "../_crawler";

// ─── 类型定义 ───────────────────────────────────────────

export type SkillParameter = {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
  properties?: Record<string, { type: string; description: string }>;
  required?: string[];
};

export type SkillDefinition = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, SkillParameter>;
    required: string[];
  };
};

export type SkillResult = {
  success: boolean;
  data?: unknown;
  error?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

// ─── Skill 注册表 ───────────────────────────────────────

const registry = new Map<string, (args: Record<string, unknown>) => Promise<SkillResult>>();

function register(name: string, def: SkillDefinition, handler: (args: Record<string, unknown>) => Promise<SkillResult>) {
  registry.set(name, handler);
  registryDefinitions.set(name, def);
}

const registryDefinitions = new Map<string, SkillDefinition>();

// ─── 工具函数 ───────────────────────────────────────────

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

/**
 * 出网前逐跳校验的 fetch
 *
 * 这里的 URL 由模型自行决定（用户可以在采集需求里诱导它），和用户直接填写的采集地址是同一类
 * 不可信输入，必须走 assertPublicCollectionUrl。而 fetch 默认自动跟随重定向会绕过这道校验——
 * 一个公网地址 302 到 169.254.169.254 就能把云元数据取回来，所以改成手动跟随、每一跳都重新校验。
 * 判定规则与 _collection.ts 的 fetchForCollection 保持一致。
 */
async function safeFetch(
  url: URL,
  options: { method?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
) {
  const { method = "GET", headers = {}, timeoutMs = 15000 } = options;
  assertPublicCollectionUrl(url);
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetch(current.toString(), {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status < 300 || response.status >= 400) return { response, finalUrl: current };
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current };
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error("重定向目标无法解析");
    }
    assertPublicCollectionUrl(next);
    current = next;
  }
  throw new Error("重定向次数过多");
}

// ─── Skill 1: fetchUrl ──────────────────────────────────

register("fetchUrl", {
  name: "fetchUrl",
  description: "获取指定 URL 的内容，返回 HTTP 状态码、内容类型和原始内容。支持 GET 和 POST 方法。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "要获取的完整 URL（含 https://）" },
      method: { type: "string", description: "请求方法", enum: ["GET", "POST"] },
    },
    required: ["url"],
  },
}, async (args) => {
  const urlStr = String(args.url || "");
  const method = args.method === "POST" ? "POST" : "GET";
  if (!urlStr) return { success: false, error: "请提供 URL" };
  let url: URL;
  try { url = new URL(urlStr); } catch { return { success: false, error: "URL 格式不正确" }; }
  if (!["http:", "https:"].includes(url.protocol)) return { success: false, error: "只支持 http/https 协议" };
  const browserHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/csv,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
  try {
    const { response } = await safeFetch(url, { method, headers: browserHeaders, timeoutMs: 20000 });
    const raw = (await response.text()).slice(0, 500000);
    return {
      success: true,
      data: {
        httpStatus: response.status,
        contentType: response.headers.get("content-type") || "text/plain",
        content: raw,
        contentLength: raw.length,
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "获取失败" };
  }
});

// ─── Skill 2: crawlWebsite ──────────────────────────────

register("crawlWebsite", {
  name: "crawlWebsite",
  description: "从种子 URL 开始爬取网站，可配置爬取深度、最大页面数、包含/排除 URL 模式。返回每个页面的标题、URL 和文本内容。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "种子 URL（起始页面）" },
      maxPages: { type: "string", description: "最大爬取页面数，默认 5" },
      depth: { type: "string", description: "爬取深度（0=仅首页，1=首页+链接，2=继续深入），默认 1" },
      includePattern: { type: "string", description: "URL 包含模式（支持 * 通配符），只爬取匹配的链接" },
      excludePattern: { type: "string", description: "URL 排除模式（支持 * 通配符），跳过匹配的链接" },
      contentSelector: { type: "string", description: "CSS 选择器（如 #content、.article、main），只提取匹配区域的内容" },
    },
    required: ["url"],
  },
}, async (args) => {
  const urlStr = String(args.url || "");
  const maxPages = Math.min(Math.max(Number(args.maxPages) || 5, 1), 50);
  const depth = Math.min(Math.max(Number(args.depth) || 1, 0), 3);
  const includePattern = String(args.includePattern || "");
  const excludePattern = String(args.excludePattern || "");
  const contentSelector = String(args.contentSelector || "");
  let seed: URL;
  try { seed = new URL(urlStr); } catch { return { success: false, error: "URL 格式不正确" }; }
  seed.hash = "";
  // 单页抓取失败会被循环内的 catch 吞掉，种子地址不合法必须在进入循环前就明确报错，
  // 否则内网地址只会得到一句"未采集到可用页面"。
  try {
    assertPublicCollectionUrl(seed);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "种子地址不合法" };
  }
  const pages: Array<{ url: string; title: string; text: string }> = [];
  const browserHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
  try {
    // 抓取循环与"数据采集"模块共用 _crawler：这边注入的是直连（含逐跳 SSRF 校验）的出网实现，
    // 采集那边注入的是走采集代理的实现。
    const { pages: crawled } = await crawlPages(
      seed,
      { maxPages, depth, includePattern, excludePattern, contentSelector },
      async url => {
        const { response } = await safeFetch(url, { headers: browserHeaders, timeoutMs: 15000 });
        return {
          httpStatus: response.status,
          contentType: response.headers.get("content-type") || "",
          raw: await response.text(),
        };
      },
    );
    // 受限页（验证码墙、登录墙、429）对模型没有价值，交给它只会被当成正文总结出去。
    const usable = crawled.filter(page => !page.blocked);
    if (!usable.length) {
      const blockedCount = crawled.length;
      return {
        success: false,
        error: blockedCount
          ? `采集到的 ${blockedCount} 个页面都是登录墙/验证码/错误页，未取得正文。请换用该站的 API、RSS，或改用 readWebPage。`
          : "未采集到可用页面，请检查 URL 或网站权限",
      };
    }
    pages.push(...usable.map(page => ({ url: page.url, title: page.title, text: page.text })));
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "爬取失败" };
  }
  return { success: true, data: { pages, totalPages: pages.length } };
});

// ─── Skill 3: htmlToText ────────────────────────────────

register("htmlToText", {
  name: "htmlToText",
  description: "将 HTML 转换为纯文本，去除标签、脚本和样式。",
  parameters: {
    type: "object",
    properties: {
      html: { type: "string", description: "HTML 原始内容" },
    },
    required: ["html"],
  },
}, async (args) => {
  const html = String(args.html || "");
  if (!html) return { success: false, error: "请提供 HTML 内容" };
  return { success: true, data: { text: htmlToText(decodeHtml(html)) } };
});

// ─── Skill 4: extractFromJson ───────────────────────────

register("extractFromJson", {
  name: "extractFromJson",
  description: "从 JSON 数据中提取指定字段，返回结构化表格。适用于 JSON 数组或对象列表。",
  parameters: {
    type: "object",
    properties: {
      json: { type: "string", description: "JSON 字符串（数组或对象）" },
      fields: { type: "string", description: "要提取的字段名，多个用逗号分隔" },
    },
    required: ["json", "fields"],
  },
}, async (args) => {
  const json = String(args.json || "").trim();
  const fields = String(args.fields || "").split(/[,，、]/).map(f => f.trim()).filter(Boolean);
  if (!json) return { success: false, error: "请提供 JSON 内容" };
  if (!fields.length) return { success: false, error: "请指定要提取的字段" };
  try {
    const parsed = JSON.parse(json);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const rows: Record<string, string>[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row: Record<string, string> = {};
      let hasAny = false;
      for (const field of fields) {
        const val = (item as Record<string, unknown>)[field];
        row[field] = val !== undefined && val !== null ? String(val).trim() : "";
        if (row[field]) hasAny = true;
      }
      if (hasAny) rows.push(row);
    }
    if (!rows.length) return { success: false, error: `未在 JSON 数据中找到指定字段：${fields.join("、")}` };
    return { success: true, data: { rows, totalRows: rows.length } };
  } catch {
    return { success: false, error: "JSON 格式无效" };
  }
});

// ─── Skill 5: extractFromCsv ────────────────────────────

register("extractFromCsv", {
  name: "extractFromCsv",
  description: "从 CSV 格式数据中提取指定列，返回结构化表格。自动识别表头行。",
  parameters: {
    type: "object",
    properties: {
      csv: { type: "string", description: "CSV 格式文本（首行为列名）" },
      columns: { type: "string", description: "要提取的列名，多个用逗号分隔" },
    },
    required: ["csv", "columns"],
  },
}, async (args) => {
  const csv = String(args.csv || "");
  const columns = String(args.columns || "").split(/[,，、]/).map(c => c.trim()).filter(Boolean);
  if (!csv) return { success: false, error: "请提供 CSV 内容" };
  if (!columns.length) return { success: false, error: "请指定要提取的列名" };
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { success: false, error: "CSV 至少需要标题行和一行数据" };
  const headers = splitCsvLine(lines[0]);
  const colIndices = columns.map(c => headers.findIndex(h => h.trim() === c));
  if (colIndices.every(i => i === -1)) return { success: false, error: `CSV 中未找到指定列：${columns.join("、")}。可用列：${headers.join(", ")}` };
  const dataLines = lines.slice(1).filter(l => l.trim());
  const rows = dataLines.map(line => {
    const vals = splitCsvLine(line);
    const row: Record<string, string> = {};
    columns.forEach((col, i) => { row[col] = colIndices[i] >= 0 ? vals[colIndices[i]] ?? "" : ""; });
    return row;
  });
  return { success: true, data: { rows, totalRows: rows.length } };
});

// ─── Skill 6: convertToMarkdownTable ────────────────────

register("convertToMarkdownTable", {
  name: "convertToMarkdownTable",
  description: "将 CSV 或 JSON 数据转换为 Markdown 表格格式。",
  parameters: {
    type: "object",
    properties: {
      data: { type: "string", description: "CSV 或 JSON 格式的原始数据" },
      format: { type: "string", description: "输入数据格式", enum: ["csv", "json"] },
    },
    required: ["data", "format"],
  },
}, async (args) => {
  const data = String(args.data || "");
  const format = String(args.format || "csv");
  if (!data) return { success: false, error: "请提供数据内容" };
  try {
    if (format === "json") {
      const parsed = JSON.parse(data);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const objects = rows.filter(item => item && typeof item === "object" && !Array.isArray(item)).slice(0, 50) as Record<string, unknown>[];
      if (!objects.length) return { success: true, data: { markdown: "```json\n" + JSON.stringify(parsed, null, 2).slice(0, 12000) + "\n```" } };
      const headers = Array.from(new Set(objects.flatMap(item => Object.keys(item)))).slice(0, 12);
      const body = objects.map(item => `| ${headers.map(key => String(item[key] ?? "").replace(/\|/g, "\\|").slice(0, 120)).join(" | ")} |`).join("\n");
      return { success: true, data: { markdown: `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${body}` } };
    }
    const lines = data.split(/\r?\n/).filter(Boolean).slice(0, 51);
    if (!lines.length) return { success: false, error: "CSV 内容为空" };
    const rows = lines.map(splitCsvLine);
    const headers = rows[0];
    const body = rows.slice(1).map(row => `| ${headers.map((_, i) => (row[i] || "").replace(/\|/g, "\\|").slice(0, 120)).join(" | ")} |`).join("\n");
    return { success: true, data: { markdown: `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${body}` } };
  } catch (error) {
    return { success: false, error: `转换失败：${error instanceof Error ? error.message : "格式错误"}` };
  }
});

// ─── Skill 7: extractContentBySelector ──────────────────

register("extractContentBySelector", {
  name: "extractContentBySelector",
  description: "从 HTML 中按 CSS 选择器提取内容。支持 #id、.class、tagName 三种选择器。",
  parameters: {
    type: "object",
    properties: {
      html: { type: "string", description: "HTML 原始内容" },
      selector: { type: "string", description: "CSS 选择器，如 #content、.article-body、main" },
    },
    required: ["html", "selector"],
  },
}, async (args) => {
  const html = String(args.html || "");
  const selector = String(args.selector || "");
  if (!html) return { success: false, error: "请提供 HTML 内容" };
  if (!selector) return { success: false, error: "请提供选择器" };
  const result = applyContentSelector(html, selector);
  return { success: true, data: { content: result, length: result.length } };
});

// ─── Skill 8: extractLinks ──────────────────────────────

register("extractLinks", {
  name: "extractLinks",
  description: "从 HTML 中提取所有同域链接（去除锚点、图片、CSS、JS 等资源链接）。",
  parameters: {
    type: "object",
    properties: {
      html: { type: "string", description: "HTML 原始内容" },
      baseUrl: { type: "string", description: "页面基准 URL，用于解析相对链接" },
    },
    required: ["html", "baseUrl"],
  },
}, async (args) => {
  const html = String(args.html || "");
  let baseUrl: URL;
  try { baseUrl = new URL(String(args.baseUrl || "")); } catch { return { success: false, error: "基准 URL 格式不正确" }; }
  if (!html) return { success: false, error: "请提供 HTML 内容" };
  const links = extractLinks(html, baseUrl);
  return { success: true, data: { links, totalLinks: links.length } };
});

// ─── Agent-Reach 集成 Skills ────────────────────────────
//
// 以下技能来自 Agent-Reach（https://github.com/Panniantong/Agent-Reach）
// 封装了 16+ 平台的 HTTP 可访问能力，供 AI 模型通过 function calling 调用。

// ─── Skill 9: readWebPage (Jina AI Reader) ─────────────

register("readWebPage", {
  name: "readWebPage",
  description: "使用 Jina AI Reader 将任意 URL 内容转换为干净、结构化的 Markdown 文本。自动去除广告、导航、侧边栏等干扰元素。适用于阅读文章、文档、新闻等网页内容。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "要阅读的完整 URL（含 https://）" },
    },
    required: ["url"],
  },
}, async (args) => {
  const urlStr = String(args.url || "");
  if (!urlStr) return { success: false, error: "请提供 URL" };
  let url: URL;
  try { url = new URL(urlStr); } catch { return { success: false, error: "URL 格式不正确" }; }
  if (!["http:", "https:"].includes(url.protocol)) return { success: false, error: "只支持 http/https 协议" };
  // 真正出网的是 r.jina.ai（公网固定域名），但仍要拦下内网目标：
  // 内网主机名交给第三方阅读服务本身就是一次信息泄漏。
  try {
    assertPublicCollectionUrl(url);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "目标地址不合法" };
  }
  try {
    const response = await fetch(`https://r.jina.ai/${url.toString()}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/plain,text/markdown,text/html,*/*",
        "X-Return-Format": "markdown",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (response.status !== 200) {
      return { success: false, error: `Jina Reader 返回 ${response.status}` };
    }
    const text = (await response.text()).slice(0, 100000);
    if (!text.trim() || text.trim().length < 50) {
      return { success: false, error: "未获取到有效内容，页面可能无法访问或需要登录" };
    }
    return {
      success: true,
      data: {
        title: text.split("\n")[0]?.replace(/^#+\s*/, "").trim() || url.pathname,
        content: text.slice(0, 50000),
        contentLength: text.length,
        source: url.toString(),
      },
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return { success: false, error: "请求超时（30秒），请检查 URL 是否可访问" };
    }
    return { success: false, error: error instanceof Error ? error.message : "读取失败" };
  }
});

// ─── Skill 10: searchReddit ─────────────────────────────

// Reddit 的 JSON 接口（www 和 old、任何 User-Agent）从机房 IP 一律返回 403，
// 只有 .rss 还能取到数据——它发的是 Atom，且必须带浏览器 UA，库风格的 UA 同样被挡。
// 代价是 RSS 里没有 score / num_comments，点赞数和评论数拿不到，技能描述里也不再承诺。
const REDDIT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
};

/** 去掉 Reddit 塞在正文尾部的 "submitted by /u/x [link] [comments]" 样板。 */
function stripRedditBoilerplate(summary: string) {
  return summary.replace(/\s*submitted by\s*\/u\/\S+\s*\[link\]\s*\[comments\]\s*$/i, "").trim();
}

register("searchReddit", {
  name: "searchReddit",
  description: "获取 Reddit 社区的热门帖子、最新内容或按关键词搜索，返回帖子标题、链接、作者、发布时间和正文摘要。注意：走的是 Reddit 的公开 RSS，拿不到点赞数和评论数；Reddit 对服务器 IP 限流较严，短时间连续调用可能失败。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词，或 subreddit 名称（如 'python'、'technology'）" },
      mode: { type: "string", description: "搜索模式：hot（热门）、new（最新）、search（关键词搜索）", enum: ["hot", "new", "search"] },
      limit: { type: "string", description: "返回结果数量，默认 10，最大 25" },
      subreddit: { type: "string", description: "指定 subreddit（如 'python'），不指定则全局搜索" },
    },
    required: ["query"],
  },
}, async (args) => {
  const query = String(args.query || "").trim();
  const mode = String(args.mode || "search");
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
  // mode=hot/new 且没单独给 subreddit 时，query 本身就是版块名——参数说明里就是这么讲的。
  const subreddit = String(args.subreddit || "").trim() || (mode === "hot" || mode === "new" ? query : "");
  if (!query) return { success: false, error: "请提供搜索关键词或 subreddit 名称" };
  try {
    let url: string;
    if (mode === "search") {
      url = subreddit
        ? `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.rss?q=${encodeURIComponent(query)}&restrict_sr=1&sort=relevance&limit=${limit}`
        : `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=relevance&limit=${limit}`;
    } else if (subreddit) {
      url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${mode}.rss?limit=${limit}`;
    } else {
      url = `https://www.reddit.com/${mode}.rss?limit=${limit}`;
    }

    const response = await fetch(url, { headers: REDDIT_HEADERS, signal: AbortSignal.timeout(15000) });
    if (response.status === 429) return { success: false, error: "Reddit 限流（429）。它按来源 IP 限流且窗口较长，请隔一两分钟再试，或改用 searchHackerNews、searchV2EX。" };
    if (response.status === 403) return { success: false, error: "Reddit 拒绝了本次访问（403）。该来源 IP 可能已被封禁，请改用 searchHackerNews、searchV2EX，或对具体帖子用 readWebPage。" };
    if (response.status === 404) return { success: false, error: `未找到 subreddit "${subreddit}"，请检查版块名拼写。` };
    if (response.status !== 200) return { success: false, error: `Reddit 返回 ${response.status}` };

    const raw = await response.text();
    const posts = parseAtomEntries(raw, limit)
      .filter(entry => entry.title || entry.link)
      .map(entry => ({
        title: entry.title,
        url: entry.link,
        author: entry.author,
        // <id> 形如 t3_1vfemi1，去掉 t3_ 前缀就是帖子 ID。
        postId: entry.id.replace(/^t3_/, ""),
        subreddit: entry.link.match(/reddit\.com\/r\/([^/]+)/i)?.[1] || subreddit,
        created: entry.date,
        selftext: stripRedditBoilerplate(entry.summary).slice(0, 500),
      }));
    if (!posts.length) {
      return {
        success: false,
        error: mode === "search"
          ? `未找到与 "${query}" 相关的 Reddit 帖子`
          : `未取到 subreddit "${subreddit}" 的内容，请检查版块名，或确认该版块不是私有/成人内容（需要登录的版块 RSS 为空）。`,
      };
    }
    return { success: true, data: { posts, totalPosts: posts.length, source: `Reddit ${mode}${subreddit ? ` · r/${subreddit}` : ""}` } };
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return { success: false, error: "Reddit 请求超时（15秒），请稍后重试" };
    }
    return { success: false, error: error instanceof Error ? error.message : "Reddit 搜索失败" };
  }
});

// ─── Skill 11: searchV2EX ───────────────────────────────

register("searchV2EX", {
  name: "searchV2EX",
  description: "获取 V2EX 社区的热门主题、节点主题、主题详情和回复。V2EX 是国内知名的技术社区。无需认证，使用公开 API。",
  parameters: {
    type: "object",
    properties: {
      mode: { type: "string", description: "操作模式：hot（热门）、node（节点主题）、topic（主题详情+回复）、user（用户信息）", enum: ["hot", "node", "topic", "user"] },
      nodeName: { type: "string", description: "节点名称（mode=node 时必填，如 python、tech、jobs、qna、create、share）" },
      topicId: { type: "string", description: "主题 ID（mode=topic 时必填，从 URL 获取，如 https://www.v2ex.com/t/1234567 的 1234567）" },
      username: { type: "string", description: "用户名（mode=user 时必填）" },
      limit: { type: "string", description: "返回结果数量，默认 10，最大 20" },
    },
    required: ["mode"],
  },
}, async (args) => {
  const mode = String(args.mode || "hot");
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
  const headers = { "User-Agent": "agent-reach-integration/1.0" };
  try {
    if (mode === "hot") {
      const response = await fetch("https://www.v2ex.com/api/topics/hot.json", { headers, signal: AbortSignal.timeout(10000) });
      if (response.status !== 200) return { success: false, error: `V2EX API 返回 ${response.status}` };
      const data = await response.json() as Array<Record<string, unknown>>;
      const topics = data.slice(0, limit).map(t => ({
        id: t.id,
        title: String(t.title || ""),
        url: `https://www.v2ex.com/t/${t.id}`,
        replies: Number(t.replies || 0),
        node: String((t.node as Record<string, unknown>)?.title || ""),
        author: String((t.member as Record<string, unknown>)?.username || ""),
        content: String(t.content || "").slice(0, 200),
      }));
      return { success: true, data: { topics, totalTopics: topics.length, source: "V2EX 热门" } };
    }
    if (mode === "node") {
      const nodeName = String(args.nodeName || "").trim();
      if (!nodeName) return { success: false, error: "请提供节点名称（nodeName）" };
      const response = await fetch(`https://www.v2ex.com/api/topics/show.json?node_name=${encodeURIComponent(nodeName)}&page=1`, { headers, signal: AbortSignal.timeout(10000) });
      if (response.status !== 200) return { success: false, error: `V2EX API 返回 ${response.status}` };
      const data = await response.json() as Array<Record<string, unknown>>;
      const topics = data.slice(0, limit).map(t => ({
        id: t.id,
        title: String(t.title || ""),
        url: `https://www.v2ex.com/t/${t.id}`,
        replies: Number(t.replies || 0),
        node: nodeName,
        author: String((t.member as Record<string, unknown>)?.username || ""),
        content: String(t.content || "").slice(0, 200),
      }));
      return { success: true, data: { topics, totalTopics: topics.length, source: `V2EX /go/${nodeName}` } };
    }
    if (mode === "topic") {
      const topicId = String(args.topicId || "").trim();
      if (!topicId) return { success: false, error: "请提供主题 ID（topicId）" };
      const [topicRes, repliesRes] = await Promise.all([
        fetch(`https://www.v2ex.com/api/topics/show.json?id=${encodeURIComponent(topicId)}`, { headers, signal: AbortSignal.timeout(10000) }),
        fetch(`https://www.v2ex.com/api/replies/show.json?topic_id=${encodeURIComponent(topicId)}&page=1`, { headers, signal: AbortSignal.timeout(10000) }),
      ]);
      if (topicRes.status !== 200) return { success: false, error: `V2EX API 返回 ${topicRes.status}` };
      const topicData = (await topicRes.json() as Array<Record<string, unknown>>)[0];
      if (!topicData) return { success: false, error: `未找到主题 #${topicId}` };
      const repliesData = repliesRes.status === 200 ? (await repliesRes.json() as Array<Record<string, unknown>>) : [];
      return {
        success: true,
        data: {
          topic: {
            id: topicData.id,
            title: String(topicData.title || ""),
            url: `https://www.v2ex.com/t/${topicData.id}`,
            content: String(topicData.content || "").slice(0, 5000),
            replies: Number(topicData.replies || 0),
            node: String((topicData.node as Record<string, unknown>)?.title || ""),
            author: String((topicData.member as Record<string, unknown>)?.username || ""),
          },
          replies: repliesData.slice(0, 20).map(r => ({
            author: String((r.member as Record<string, unknown>)?.username || ""),
            content: String(r.content || "").slice(0, 1000),
            created: new Date(Number(r.created || 0) * 1000).toISOString(),
          })),
        },
      };
    }
    if (mode === "user") {
      const username = String(args.username || "").trim();
      if (!username) return { success: false, error: "请提供用户名" };
      const response = await fetch(`https://www.v2ex.com/api/members/show.json?username=${encodeURIComponent(username)}`, { headers, signal: AbortSignal.timeout(10000) });
      if (response.status !== 200) return { success: false, error: `V2EX API 返回 ${response.status}` };
      const data = await response.json() as Record<string, unknown>;
      return {
        success: true,
        data: {
          username: data.username,
          bio: String(data.bio || ""),
          location: String(data.location || ""),
          github: String(data.github || ""),
          website: String(data.website || ""),
          created: new Date(Number(data.created || 0) * 1000).toISOString(),
        },
      };
    }
    return { success: false, error: `未知模式：${mode}` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "V2EX 查询失败" };
  }
});

// ─── Skill 12: searchGitHub ─────────────────────────────

register("searchGitHub", {
  name: "searchGitHub",
  description: "搜索 GitHub 上的仓库、代码、Issue 和用户。使用 GitHub 公开 REST API，无需认证即可搜索公开内容。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
      mode: { type: "string", description: "搜索类型：repos（仓库）、code（代码）、issues（Issue）、users（用户）", enum: ["repos", "code", "issues", "users"] },
      language: { type: "string", description: "过滤编程语言（如 python、javascript、rust、go）" },
      limit: { type: "string", description: "返回结果数量，默认 5，最大 10" },
      repo: { type: "string", description: "仓库全名（如 'owner/repo'），用于 mode=issues 时限定范围" },
    },
    required: ["query", "mode"],
  },
}, async (args) => {
  const query = String(args.query || "");
  const mode = String(args.mode || "repos");
  const language = String(args.language || "").trim();
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
  const repo = String(args.repo || "").trim();
  if (!query) return { success: false, error: "请提供搜索关键词" };
  try {
    let searchQuery = query;
    if (language) searchQuery += `+language:${language}`;
    let url: string;
    if (mode === "code") {
      url = `https://api.github.com/search/code?q=${encodeURIComponent(searchQuery)}&per_page=${limit}&sort=indexed`;
    } else if (mode === "issues") {
      if (repo) searchQuery += `+repo:${repo}`;
      url = `https://api.github.com/search/issues?q=${encodeURIComponent(searchQuery)}&per_page=${limit}&sort=comments&order=desc`;
    } else if (mode === "users") {
      url = `https://api.github.com/search/users?q=${encodeURIComponent(searchQuery)}&per_page=${limit}`;
    } else {
      url = `https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery)}&per_page=${limit}&sort=stars&order=desc`;
    }
    const response = await fetch(url, {
      headers: {
        "User-Agent": "agent-reach-integration/1.0",
        Accept: "application/vnd.github.v3+json",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 403) {
      return { success: false, error: "GitHub API 限流，请稍后重试" };
    }
    if (response.status !== 200) return { success: false, error: `GitHub API 返回 ${response.status}` };
    const data = await response.json() as { total_count?: number; items?: Array<Record<string, unknown>> };
    const items = (data.items || []).slice(0, limit);
    if (!items.length) return { success: false, error: `未找到与 "${query}" 相关的 GitHub ${mode}` };
    if (mode === "repos") {
      const repos = items.map(r => ({
        name: String(r.full_name || r.name || ""),
        url: String(r.html_url || ""),
        description: String(r.description || "").slice(0, 200),
        stars: Number(r.stargazers_count || 0),
        forks: Number(r.forks_count || 0),
        language: String(r.language || ""),
        topics: Array.isArray(r.topics) ? (r.topics as string[]).slice(0, 5) : [],
        updated: String(r.updated_at || ""),
      }));
      return { success: true, data: { repos, totalCount: data.total_count || repos.length } };
    }
    if (mode === "code") {
      const code = items.map(c => ({
        name: String(c.name || ""),
        path: String(c.path || ""),
        repo: String((c.repository as Record<string, unknown>)?.full_name || ""),
        url: String(c.html_url || ""),
      }));
      return { success: true, data: { code, totalCount: data.total_count || code.length } };
    }
    if (mode === "issues") {
      const issues = items.map(i => ({
        title: String(i.title || ""),
        url: String(i.html_url || ""),
        state: String(i.state || ""),
        comments: Number(i.comments || 0),
        repo: String((i.repository_url || "").replace("https://api.github.com/repos/", "")),
        created: String(i.created_at || ""),
        body: String(i.body || "").slice(0, 300),
      }));
      return { success: true, data: { issues, totalCount: data.total_count || issues.length } };
    }
    const users = items.map(u => ({
      login: String(u.login || ""),
      url: String(u.html_url || ""),
      type: String(u.type || ""),
      repos: Number(u.repos_url || 0),
    }));
    return { success: true, data: { users, totalCount: data.total_count || users.length } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "GitHub 搜索失败" };
  }
});

// ─── Skill 13: readRSS ──────────────────────────────────

register("readRSS", {
  name: "readRSS",
  description: "读取 RSS/Atom 订阅源的最新文章。返回每篇文章的标题、链接、发布时间和摘要。适用于博客、新闻站点、播客等支持 RSS 的内容源。",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "RSS/Atom 订阅源 URL" },
      limit: { type: "string", description: "返回文章数量，默认 10，最大 20" },
    },
    required: ["url"],
  },
}, async (args) => {
  const feedUrl = String(args.url || "");
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
  if (!feedUrl) return { success: false, error: "请提供 RSS 订阅源 URL" };
  let url: URL;
  try { url = new URL(feedUrl); } catch { return { success: false, error: "URL 格式不正确" }; }
  if (!["http:", "https:"].includes(url.protocol)) return { success: false, error: "只支持 http/https 协议" };
  try {
    const { response } = await safeFetch(url, {
      headers: { "User-Agent": "agent-reach-integration/1.0" },
      timeoutMs: 15000,
    });
    if (response.status !== 200) return { success: false, error: `RSS 源返回 ${response.status}` };
    const raw = await response.text();
    if (!raw.trim()) return { success: false, error: "RSS 源内容为空" };
    // 简单解析 XML 格式的 RSS/Atom
    const items: Array<{ title: string; link: string; date: string; summary: string }> = [];
    // 提取 <item> 标签（RSS 2.0）
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemRegex.exec(raw)) !== null && items.length < limit) {
      const itemXml = itemMatch[1];
      const title = extractXmlValue(itemXml, "title");
      const link = extractXmlValue(itemXml, "link");
      const date = extractXmlValue(itemXml, "pubDate") || extractXmlValue(itemXml, "dc:date");
      const description = extractXmlValue(itemXml, "description") || extractXmlValue(itemXml, "content:encoded");
      items.push({
        title: decodeHtml(title).trim().slice(0, 200) || "无标题",
        link: link.trim(),
        date: date.trim(),
        summary: htmlToText(decodeHtml(description)).slice(0, 500),
      });
    }
    // 如果没有 <item>，尝试 <entry>（Atom）——解析器与 searchReddit 共用
    if (!items.length) {
      for (const entry of parseAtomEntries(raw, limit)) {
        items.push({
          title: entry.title.slice(0, 200) || "无标题",
          link: entry.link,
          date: entry.date,
          summary: entry.summary.slice(0, 500),
        });
      }
    }
    if (!items.length) return { success: false, error: "未能从 RSS 源中解析出文章，请确认 URL 是有效的 RSS/Atom 订阅源" };
    const feedTitle = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url.hostname;
    return {
      success: true,
      data: {
        feedTitle: decodeHtml(feedTitle).trim(),
        feedUrl: feedUrl,
        items,
        totalItems: items.length,
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "RSS 读取失败" };
  }
});

/** 从 XML 片段中提取标签值 */
function extractXmlValue(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1].trim() : "";
}

type AtomEntry = { id: string; title: string; link: string; date: string; author: string; summary: string };

/** Atom 的作者是 <author><name>/u/xxx</name></author> 这种嵌套结构，直接取 name 会撞上别处的同名标签。 */
function extractAtomAuthor(entryXml: string) {
  const block = entryXml.match(/<author>([\s\S]*?)<\/author>/i)?.[1] || "";
  return extractXmlValue(block, "name").replace(/^\/u\//, "").trim();
}

/**
 * 解析 Atom 的 <entry>。
 *
 * readRSS 和 searchReddit 都要用：Reddit 的 .rss 实际发的就是 Atom。
 * 只留一份实现，省得两处对 <link href> 自闭合、<content type="html"> 这些细节各理解一遍。
 */
function parseAtomEntries(xml: string, limit: number): AtomEntry[] {
  const entries: AtomEntry[] = [];
  const regex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null && entries.length < limit) {
    const entryXml = match[1];
    entries.push({
      id: extractXmlValue(entryXml, "id"),
      title: decodeHtml(extractXmlValue(entryXml, "title")).trim().slice(0, 300),
      link: entryXml.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1]?.trim() || "",
      date: (extractXmlValue(entryXml, "published") || extractXmlValue(entryXml, "updated")).trim(),
      author: extractAtomAuthor(entryXml),
      summary: htmlToText(decodeHtml(extractXmlValue(entryXml, "summary") || extractXmlValue(entryXml, "content"))),
    });
  }
  return entries;
}

// ─── Skill 14: searchHackerNews ─────────────────────────

register("searchHackerNews", {
  name: "searchHackerNews",
  description: "搜索 Hacker News 上的热门故事、最新内容或按关键词搜索。返回故事标题、链接、分数、评论数等信息。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词，或 mode=top/new 时留空" },
      mode: { type: "string", description: "操作模式：top（当前热门）、new（最新）、best（最佳）、search（关键词搜索）", enum: ["top", "new", "best", "search"] },
      limit: { type: "string", description: "返回结果数量，默认 10，最大 30" },
    },
    required: ["mode"],
  },
}, async (args) => {
  const query = String(args.query || "");
  const mode = String(args.mode || "top");
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
  try {
    if (mode === "search" && query) {
      // 使用 Algolia HN Search API
      const response = await fetch(
        `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${limit}&tags=story`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (response.status !== 200) return { success: false, error: `HN Search API 返回 ${response.status}` };
      const data = await response.json() as { hits?: Array<Record<string, unknown>> };
      const stories = (data.hits || []).slice(0, limit).map(h => ({
        title: String(h.title || ""),
        url: String(h.url || `https://news.ycombinator.com/item?id=${h.objectID}`),
        points: Number(h.points || 0),
        comments: Number(h.num_comments || 0),
        author: String(h.author || ""),
        created: new Date(Number(h.created_at_i || 0) * 1000).toISOString(),
      }));
      if (!stories.length) return { success: false, error: `未找到与 "${query}" 相关的 HN 故事` };
      return { success: true, data: { stories, totalStories: stories.length, source: "Hacker News" } };
    }
    // 使用 Firebase API 获取 IDs
    const typeMap: Record<string, string> = { top: "topstories", new: "newstories", best: "beststories" };
    const endpoint = typeMap[mode];
    if (!endpoint) return { success: false, error: `未知模式：${mode}` };
    const idResponse = await fetch(
      `https://hacker-news.firebaseio.com/v0/${endpoint}.json`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (idResponse.status !== 200) return { success: false, error: `HN API 返回 ${idResponse.status}` };
    const ids = (await idResponse.json() as number[]).slice(0, limit);
    const stories = (await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(5000) });
          if (res.status !== 200) return null;
          return await res.json() as Record<string, unknown>;
        } catch { return null; }
      }),
    )).filter(Boolean).map((item: Record<string, unknown>) => ({
      title: String(item.title || ""),
      url: String(item.url || `https://news.ycombinator.com/item?id=${item.id}`),
      points: Number(item.score || 0),
      comments: Number(item.descendants || 0),
      author: String(item.by || ""),
      created: new Date(Number(item.time || 0) * 1000).toISOString(),
    }));
    if (!stories.length) return { success: false, error: "未获取到 HN 故事" };
    return { success: true, data: { stories, totalStories: stories.length, source: `Hacker News ${mode}` } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "HN 查询失败" };
  }
});

// ─── 公开 API ───────────────────────────────────────────

/** 获取所有已注册的 skill 定义（OpenAI function calling 格式） */
export function getAllSkills(): SkillDefinition[] {
  return Array.from(registryDefinitions.values());
}

/** 获取指定 skill 的定义 */
export function getSkill(name: string): SkillDefinition | undefined {
  return registryDefinitions.get(name);
}

/** 执行一个 skill */
export async function executeSkill(name: string, args: Record<string, unknown>): Promise<SkillResult> {
  const handler = registry.get(name);
  if (!handler) return { success: false, error: `未知技能：${name}` };
  return handler(args);
}

/** 批量执行 tool calls（AI 返回的 function calling 结果） */
export async function executeToolCalls(toolCalls: ToolCall[]): Promise<{ role: string; tool_call_id: string; content: string }[]> {
  return Promise.all(toolCalls.map(async (call) => {
    try {
      const args = JSON.parse(call.function.arguments);
      const result = await executeSkill(call.function.name, args);
      return {
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      };
    } catch (error) {
      return {
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({ success: false, error: error instanceof Error ? error.message : "执行失败" }),
      };
    }
  }));
}