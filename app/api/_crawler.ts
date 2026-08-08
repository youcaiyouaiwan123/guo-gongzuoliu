// 爬虫内核：HTML 清洗、链接抽取、页面质量判定与 BFS 抓取循环。
//
// 这些逻辑原本在 _collection.ts 和 modules/_skills.ts 里各有一份拷贝，且已经开始分叉——
// _collection 那份支持多条 include/exclude 规则、能识别验证码/空壳页面，_skills 那份还停留在
// 单条正则 + "文本少于 20 字就跳过"。两边同时改的成本和漏改的风险都不小，这里合并为一份。
//
// 本模块刻意不依赖 cloudflare:workers 与 _shared：
// _shared → _skills 已经存在依赖，_skills 若再反向依赖 _collection 就会成环。
// 出网动作一律由调用方以 fetchPage 注入，采集侧注入带采集代理的实现，技能侧注入直连实现，
// 两边各自的 SSRF 校验也就都保留在自己的 fetch 里。

export type CrawlPageFetch = (url: URL) => Promise<{ httpStatus: number; contentType: string; raw: string }>;

export type CrawlOptions = {
  maxPages: number;
  depth: number;
  includePattern?: string;
  excludePattern?: string;
  contentSelector?: string;
};

export type CrawledPage = {
  url: string;
  title: string;
  text: string;
  status: number;
  contentType: string;
  /** 非 2xx、验证码墙、登录墙——正文不可用，但保留下来让调用方能告诉用户"为什么没采到"。 */
  blocked: boolean;
};

export function htmlToText(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeHtml(value: string) {
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

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ruleMatches(value: string, rule: string) {
  if (rule.includes("*")) return new RegExp(`^${escapeRegExp(rule).replace(/\\\*/g, ".*")}$`, "i").test(value);
  return value.toLowerCase().includes(rule.toLowerCase());
}

function splitRules(pattern = "") {
  return pattern.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
}

/** 无规则时视为全部命中；有规则时任一命中即可。 */
export function patternMatches(value: string, pattern = "") {
  const rules = splitRules(pattern);
  if (!rules.length) return true;
  return rules.some(rule => ruleMatches(value, rule));
}

export function patternExcluded(value: string, pattern = "") {
  return splitRules(pattern).some(rule => ruleMatches(value, rule));
}

export function isSkippableCrawlUrl(url: URL) {
  return /\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf|zip|rar|7z|mp4|mp3|wav|avi|mov|xlsx?|docx?|pptx?)$/i.test(url.pathname);
}

/** 支持 #id、.class、tagName 三种选择器；取不到就退回整页，不要把内容清空。 */
export function applyContentSelector(html: string, selector = "") {
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

/** 只跟进同源链接：跨站跳出去既不是用户要的范围，也会让 SSRF 校验面无限扩大。 */
export function extractLinks(html: string, base: URL, includePattern = "", excludePattern = "") {
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
    } catch { /* 跳过非法 URL */ }
  }
  return Array.from(links);
}

export function extractTitle(html: string, fallback = "") {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || fallback;
  return htmlToText(decodeHtml(title)).slice(0, 120);
}

/** 验证码墙、登录墙、Cloudflare 拦截页都会返回 200 + 一段提示文案，光看状态码识别不出来。 */
export function looksLikeBlockedPage(raw: string, httpStatus: number, contentType = "") {
  if ([401, 403, 429].includes(httpStatus)) return true;
  if (!contentType.toLowerCase().includes("html")) return false;
  const sample = `${raw.slice(0, 3000)} ${htmlToText(raw).slice(0, 3000)}`.toLowerCase();
  return /(captcha|access denied|forbidden|enable javascript|cloudflare|安全验证|人机验证|登录后|请登录|访问受限|风险验证)/i.test(sample);
}

/** 前端渲染的站点首屏常常只有一个 <div id="root">，正文要等 JS 跑完才有。 */
export function looksLikeEmptyShellContent(raw: string, contentType = "") {
  const text = (contentType.toLowerCase().includes("html") ? htmlToText(decodeHtml(raw)) : raw)
    .replace(/\s+/g, " ")
    .trim();
  const compact = text.toLowerCase().replace(/[\s"'`.,;:|#*_~\-—。，：；！？]/g, "");
  if (!compact) return true;
  if (/^(client|loading|load|app|root|ok|null|undefined|success|error)$/.test(compact)) return true;
  if (compact.length <= 12 && /^(client|loading|app|root|ok|api)$/.test(compact)) return true;
  return false;
}

/**
 * 广度优先抓取。
 *
 * 只负责"抓哪些页、每页留下什么"，不负责出网方式，也不抛业务错误：
 * 一页都没抓到算不算失败、失败该说什么，由调用方结合自己的场景决定。
 */
export async function crawlPages(seed: URL, options: CrawlOptions, fetchPage: CrawlPageFetch) {
  const maxPages = Math.max(options.maxPages, 1);
  const queue: Array<{ url: URL; depth: number }> = [{ url: seed, depth: 0 }];
  const visited = new Set<string>();
  const pages: CrawledPage[] = [];
  let firstStatus = 0;

  while (queue.length && pages.length < maxPages) {
    const current = queue.shift()!;
    const key = current.url.toString();
    if (visited.has(key)) continue;
    const isSeed = visited.size === 0;
    visited.add(key);

    let fetched: { httpStatus: number; contentType: string; raw: string };
    try {
      fetched = await fetchPage(current.url);
    } catch (error) {
      // 种子页失败要原样抛出：连不上、被重定向拦截、超时，这些精确原因比后面那句
      // "未采集到可用页面"有用得多。跟进链接失败则跳过，不让一条坏链接毁掉整轮抓取。
      if (isSeed) throw error;
      continue;
    }
    if (!firstStatus) firstStatus = fetched.httpStatus;

    const isHtml = fetched.contentType.includes("text/html");
    if (fetched.httpStatus < 200 || fetched.httpStatus >= 300) {
      pages.push({ url: key, title: `HTTP ${fetched.httpStatus}`, text: htmlToText(fetched.raw).slice(0, 1200), status: fetched.httpStatus, contentType: fetched.contentType, blocked: true });
      continue;
    }
    if (looksLikeBlockedPage(fetched.raw, fetched.httpStatus, fetched.contentType)) {
      pages.push({ url: key, title: "访问受限", text: htmlToText(fetched.raw).slice(0, 1200), status: fetched.httpStatus, contentType: fetched.contentType, blocked: true });
      continue;
    }

    const selectedRaw = isHtml ? applyContentSelector(fetched.raw, options.contentSelector) : fetched.raw;
    const text = isHtml ? htmlToText(decodeHtml(selectedRaw)) : selectedRaw.trim();
    if (looksLikeEmptyShellContent(text, "text/plain")) continue;

    pages.push({ url: key, title: extractTitle(fetched.raw, current.url.pathname || current.url.hostname), text: text.slice(0, 12000), status: fetched.httpStatus, contentType: fetched.contentType, blocked: false });

    if (current.depth < options.depth && isHtml) {
      for (const link of extractLinks(fetched.raw, current.url, options.includePattern, options.excludePattern)) {
        if (!visited.has(link) && queue.length + pages.length < maxPages * 3) {
          queue.push({ url: new URL(link), depth: current.depth + 1 });
        }
      }
    }
  }

  // 只回报事实，不替调用方决定哪些页面算"采到了"：
  // 采集侧要把受限页的提示文案一起留给用户看，技能侧则希望直接剔除，语义不同。
  return { pages, firstStatus };
}
