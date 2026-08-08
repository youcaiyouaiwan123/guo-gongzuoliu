import { describe, it, expect, vi } from "vitest";
import {
  crawlPages,
  extractLinks,
  patternMatches,
  patternExcluded,
  applyContentSelector,
  looksLikeBlockedPage,
  looksLikeEmptyShellContent,
  htmlToText,
} from "../_crawler";

// _crawler 不依赖 cloudflare:workers，出网动作由 fetchPage 注入，可以整份直接测。

const HTML = "text/html; charset=utf-8";

/** 用一张"站点地图"造出 fetchPage：键是 URL，值是该页返回的内容。 */
function siteFetch(site: Record<string, { raw: string; httpStatus?: number; contentType?: string }>) {
  const seen: string[] = [];
  const fetchPage = vi.fn(async (url: URL) => {
    const page = site[url.toString()];
    seen.push(url.toString());
    if (!page) throw new Error(`404 ${url.toString()}`);
    return { httpStatus: page.httpStatus ?? 200, contentType: page.contentType ?? HTML, raw: page.raw };
  });
  return { fetchPage, seen };
}

function page(title: string, body: string) {
  return { raw: `<html><head><title>${title}</title></head><body>${body}</body></html>` };
}

describe("crawlPages 抓取循环", () => {
  it("depth=0 只抓种子页，不跟进链接", async () => {
    const { fetchPage } = siteFetch({
      "https://a.com/": page("首页", '正文内容足够长一些 <a href="/x">x</a>'),
      "https://a.com/x": page("X", "另一页"),
    });

    const { pages } = await crawlPages(new URL("https://a.com/"), { maxPages: 10, depth: 0 }, fetchPage);

    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe("首页");
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("depth=1 跟进同源链接，跨站链接被跳过", async () => {
    const { fetchPage, seen } = siteFetch({
      "https://a.com/": page("首页", '<a href="/in">站内</a><a href="https://b.com/out">站外</a>'),
      "https://a.com/in": page("站内页", "站内页的正文"),
    });

    const { pages } = await crawlPages(new URL("https://a.com/"), { maxPages: 10, depth: 1 }, fetchPage);

    expect(pages.map(p => p.title)).toEqual(["首页", "站内页"]);
    expect(seen.some(url => url.includes("b.com"))).toBe(false);
  });

  it("maxPages 封顶后停止", async () => {
    const site: Record<string, { raw: string }> = {
      "https://a.com/": page("首页", '<a href="/1">1</a><a href="/2">2</a><a href="/3">3</a>'),
    };
    for (const n of [1, 2, 3]) site[`https://a.com/${n}`] = page(`第${n}页`, `第${n}页的正文`);
    const { fetchPage } = siteFetch(site);

    const { pages } = await crawlPages(new URL("https://a.com/"), { maxPages: 2, depth: 1 }, fetchPage);

    expect(pages).toHaveLength(2);
  });

  it("自指链接不会造成重复抓取", async () => {
    const { fetchPage } = siteFetch({
      "https://a.com/": page("首页", '<a href="/">自己</a><a href="/#top">锚点</a>'),
    });

    const { pages } = await crawlPages(new URL("https://a.com/"), { maxPages: 10, depth: 2 }, fetchPage);

    expect(pages).toHaveLength(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("非 2xx 记为受限页，且不跟进它的链接", async () => {
    const { fetchPage } = siteFetch({
      "https://a.com/": { raw: '<a href="/deep">deep</a>', httpStatus: 500, contentType: HTML },
      "https://a.com/deep": page("深层", "不该被抓到"),
    });

    const { pages, firstStatus } = await crawlPages(new URL("https://a.com/"), { maxPages: 10, depth: 2 }, fetchPage);

    expect(firstStatus).toBe(500);
    expect(pages).toHaveLength(1);
    expect(pages[0].blocked).toBe(true);
    expect(pages[0].title).toBe("HTTP 500");
  });

  it("返回 200 的验证码墙也判为受限页", async () => {
    const { fetchPage } = siteFetch({
      "https://a.com/": page("请稍候", "<p>安全验证，请完成人机验证后继续访问</p>"),
    });

    const { pages } = await crawlPages(new URL("https://a.com/"), { maxPages: 5, depth: 0 }, fetchPage);

    expect(pages[0].blocked).toBe(true);
    expect(pages[0].title).toBe("访问受限");
  });

  it("只有空壳的前端渲染页直接丢弃，不计入结果", async () => {
    const { fetchPage } = siteFetch({
      "https://a.com/": { raw: '<html><body><div id="root"></div></body></html>' },
    });

    const { pages } = await crawlPages(new URL("https://a.com/"), { maxPages: 5, depth: 0 }, fetchPage);

    expect(pages).toHaveLength(0);
  });

  it("空壳页只要带了 <title>，现有判定就不再认为它是空壳", async () => {
    // 记录既有行为而非期望行为：looksLikeEmptyShellContent 看的是整页可见文字，
    // 而 <title> 的文字会被 htmlToText 保留下来，于是 compact 不为空、判定不成立。
    // SPA 首屏几乎都有 title，也就是说这道防线实际能挡住的情况比看上去窄。
    const { fetchPage } = siteFetch({
      "https://a.com/": page("我的应用", '<div id="root"></div>'),
    });

    const { pages } = await crawlPages(new URL("https://a.com/"), { maxPages: 5, depth: 0 }, fetchPage);

    expect(pages).toHaveLength(1);
    expect(pages[0].text).toBe("我的应用");
  });

  it("contentSelector 只取选中区域的正文", async () => {
    const { fetchPage } = siteFetch({
      "https://a.com/": page("文章", '<nav>导航栏应当被丢掉</nav><div id="main">这里才是正文内容</div>'),
    });

    const { pages } = await crawlPages(new URL("https://a.com/"), { maxPages: 5, depth: 0, contentSelector: "#main" }, fetchPage);

    expect(pages[0].text).toBe("这里才是正文内容");
  });

  it("非 HTML 内容按原文收录，且不解析其中的链接", async () => {
    const { fetchPage } = siteFetch({
      "https://a.com/data.json": { raw: '{"items":[1,2,3],"href":"/x"}', contentType: "application/json" },
    });

    const { pages } = await crawlPages(new URL("https://a.com/data.json"), { maxPages: 5, depth: 2 }, fetchPage);

    expect(pages[0].text).toBe('{"items":[1,2,3],"href":"/x"}');
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("种子页抓取失败要原样抛出，而不是退化成“没采到”", async () => {
    const fetchPage = vi.fn(async () => { throw new Error("采集地址指向内网或本机，已被安全策略拦截"); });

    await expect(crawlPages(new URL("https://a.com/"), { maxPages: 5, depth: 1 }, fetchPage))
      .rejects.toThrow("已被安全策略拦截");
  });

  it("跟进链接抓取失败只跳过该页，不影响整轮", async () => {
    const { fetchPage } = siteFetch({
      "https://a.com/": page("首页", '<a href="/good">好</a><a href="/bad">坏</a>'),
      "https://a.com/good": page("好页", "好页的正文"),
      // /bad 不在站点地图里 → fetchPage 抛错
    });

    const { pages } = await crawlPages(new URL("https://a.com/"), { maxPages: 10, depth: 1 }, fetchPage);

    expect(pages.map(p => p.title)).toEqual(["首页", "好页"]);
  });
});

describe("链接抽取与规则过滤", () => {
  const base = new URL("https://a.com/dir/");

  it("跳过锚点、javascript、mailto、tel 和静态资源", async () => {
    const html = [
      '<a href="#top">锚</a>',
      '<a href="javascript:void(0)">js</a>',
      '<a href="mailto:a@b.com">mail</a>',
      '<a href="tel:123">tel</a>',
      '<a href="/a.png">图</a>',
      '<a href="/style.css">css</a>',
      '<a href="/real">正常</a>',
    ].join("");

    expect(extractLinks(html, base)).toEqual(["https://a.com/real"]);
  });

  it("include/exclude 支持逗号与换行分隔的多条规则", () => {
    expect(patternMatches("https://a.com/news/1", "news,blog")).toBe(true);
    expect(patternMatches("https://a.com/shop/1", "news,blog")).toBe(false);
    expect(patternMatches("https://a.com/blog/1", "news\nblog")).toBe(true);
    // 没有规则时视为全部命中
    expect(patternMatches("https://a.com/any", "")).toBe(true);
    // 排除规则相反：没有规则时不排除任何东西
    expect(patternExcluded("https://a.com/any", "")).toBe(false);
    expect(patternExcluded("https://a.com/tag/x", "tag")).toBe(true);
  });

  it("带 * 的规则是整串匹配，不是子串匹配", () => {
    expect(patternMatches("https://a.com/news/1", "https://a.com/news/*")).toBe(true);
    expect(patternMatches("https://other.com/news/1", "https://a.com/news/*")).toBe(false);
  });
});

describe("页面质量判定", () => {
  it("401/403/429 一律判为受限", () => {
    for (const status of [401, 403, 429]) expect(looksLikeBlockedPage("", status)).toBe(true);
    expect(looksLikeBlockedPage("<html>正常内容</html>", 200, HTML)).toBe(false);
  });

  it("非 HTML 内容不做关键词判定，避免正文里出现“登录”就被误杀", () => {
    expect(looksLikeBlockedPage('{"msg":"请登录"}', 200, "application/json")).toBe(false);
  });

  it("空壳判定认得 root/loading 之类的占位内容", () => {
    expect(looksLikeEmptyShellContent("", "text/plain")).toBe(true);
    expect(looksLikeEmptyShellContent("   ", "text/plain")).toBe(true);
    expect(looksLikeEmptyShellContent("Loading", "text/plain")).toBe(true);
    expect(looksLikeEmptyShellContent("这是一段真正的正文", "text/plain")).toBe(false);
  });

  it("htmlToText 去掉脚本与样式，不把它们的内容留在正文里", () => {
    const html = "<style>.a{color:red}</style><script>var x=1</script><p>正文&nbsp;在此</p>";
    expect(htmlToText(html)).toBe("正文 在此");
  });

  it("选择器取不到时退回整页，而不是把内容清空", () => {
    const html = "<div id='main'>正文</div>";
    expect(applyContentSelector(html, "#nonexistent")).toBe(html);
  });
});
