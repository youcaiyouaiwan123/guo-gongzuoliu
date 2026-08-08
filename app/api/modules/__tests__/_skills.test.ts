import { describe, it, expect, vi, afterEach } from "vitest";
import { executeSkill } from "../_skills";

// _skills.ts 只依赖 _urlGuard（不含 cloudflare:workers），可以直接导入真实实现。

type FakeResponse = { status: number; headers: Headers; text: () => Promise<string>; json: () => Promise<unknown> };

function fakeResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): FakeResponse {
  return {
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? { "content-type": "text/html" }),
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("采集技能的出网校验", () => {
  it("直接指向云元数据的地址会被拦下，且根本不发起请求", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await executeSkill("fetchUrl", { url: "http://169.254.169.254/latest/meta-data/" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("内网或本机");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("公网地址 302 跳内网时，重定向目标同样被拦下", async () => {
    const fetchSpy = vi.fn(async () =>
      fakeResponse("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await executeSkill("fetchUrl", { url: "https://example.com/redirect" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("内网或本机");
    // 只发出了第一跳，跳转目标没有被真正请求。
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("非常规端口会被拦下", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await executeSkill("fetchUrl", { url: "http://example.com:6379/" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("非常规端口");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("正常公网地址照常取回内容", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse("<html><body>hello</body></html>")));

    const result = await executeSkill("fetchUrl", { url: "https://example.com/page" });

    expect(result.success).toBe(true);
    expect((result.data as { content: string }).content).toContain("hello");
  });

  it("crawlWebsite 的内网种子给出明确错误，而不是“未采集到可用页面”", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await executeSkill("crawlWebsite", { url: "http://127.0.0.1:8080/admin" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("内网或本机");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("crawlWebsite 技能", () => {
  // 抓取循环已改为与"数据采集"模块共用 _crawler，这里守住技能这一侧的返回契约。
  function stubSite(site: Record<string, { body: string; status?: number; contentType?: string }>) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const hit = site[url];
      if (!hit) return fakeResponse("", { status: 404, headers: { "content-type": "text/html" } });
      return fakeResponse(hit.body, {
        status: hit.status ?? 200,
        headers: { "content-type": hit.contentType ?? "text/html" },
      });
    }));
  }

  it("抓回种子页与同源链接，返回标题和正文", async () => {
    stubSite({
      "https://example.com/": { body: '<html><head><title>首页</title></head><body>首页的正文内容<a href="/next">下一页</a></body></html>' },
      "https://example.com/next": { body: "<html><head><title>第二页</title></head><body>第二页的正文内容</body></html>" },
    });

    const result = await executeSkill("crawlWebsite", { url: "https://example.com/", depth: "1", maxPages: "5" });

    expect(result.success).toBe(true);
    const data = result.data as { pages: Array<{ url: string; title: string; text: string }>; totalPages: number };
    expect(data.totalPages).toBe(2);
    expect(data.pages.map(p => p.title)).toEqual(["首页", "第二页"]);
    expect(data.pages[1].text).toContain("第二页的正文");
  });

  it("页面全是登录墙时给出可操作的错误，而不是含糊的“未采集到”", async () => {
    stubSite({
      "https://example.com/": { body: "<html><body>请登录后查看</body></html>" },
    });

    const result = await executeSkill("crawlWebsite", { url: "https://example.com/", depth: "0" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("登录墙");
    expect(result.error).toContain("readWebPage");
  });

  it("受限页不会被当成正文交给模型", async () => {
    stubSite({
      "https://example.com/": { body: '<html><head><title>首页</title></head><body>首页的正文内容<a href="/vip">会员页</a></body></html>' },
      "https://example.com/vip": { body: "<html><body>Access Denied</body></html>", status: 403 },
    });

    const result = await executeSkill("crawlWebsite", { url: "https://example.com/", depth: "1" });

    const data = result.data as { pages: Array<{ url: string }> };
    expect(data.pages).toHaveLength(1);
    expect(data.pages.some(p => p.url.includes("/vip"))).toBe(false);
  });
});

describe("searchReddit 走公开 RSS", () => {
  // 结构照抄一次真实的 https://www.reddit.com/r/python/hot.rss 响应（Atom + HTML 转义的 content）。
  const REDDIT_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><category term="Python" label="r/Python"/><updated>2026-08-08T06:39:37+00:00</updated><id>/r/python/hot.rss</id><title>hot posts in r/Python</title>
<entry><author><name>/u/AutoModerator</name><uri>https://www.reddit.com/user/AutoModerator</uri></author><category term="Python" label="r/Python"/><content type="html">&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;Post all of your projects here.&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt; &amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/AutoModerator&quot;&gt; /u/AutoModerator &lt;/a&gt; &lt;br/&gt; &lt;span&gt;&lt;a href=&quot;https://www.reddit.com/r/Python/comments/1vfemi1/showcase_thread/&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt; &amp;#32; &lt;span&gt;&lt;a href=&quot;https://www.reddit.com/r/Python/comments/1vfemi1/showcase_thread/&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt;</content><id>t3_1vfemi1</id><link href="https://www.reddit.com/r/Python/comments/1vfemi1/showcase_thread/" /><updated>2026-08-04T16:05:25+00:00</updated><published>2026-08-04T16:05:25+00:00</published><title>Showcase Thread</title></entry>
</feed>`;

  function stubReddit(body: string, status = 200) {
    const spy = vi.fn(async () => fakeResponse(body, { status, headers: { "content-type": "application/atom+xml" } }));
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("解析 Atom 条目，并剥掉 Reddit 的 submitted by 样板", async () => {
    stubReddit(REDDIT_ATOM);

    const result = await executeSkill("searchReddit", { query: "python", mode: "hot", limit: "5" });

    expect(result.success).toBe(true);
    const data = result.data as { posts: Array<Record<string, string>> };
    expect(data.posts).toHaveLength(1);
    expect(data.posts[0]).toMatchObject({
      title: "Showcase Thread",
      url: "https://www.reddit.com/r/Python/comments/1vfemi1/showcase_thread/",
      author: "AutoModerator",       // 去掉了 /u/ 前缀
      postId: "1vfemi1",             // 去掉了 t3_ 前缀
      subreddit: "Python",
      created: "2026-08-04T16:05:25+00:00",
    });
    expect(data.posts[0].selftext).toBe("Post all of your projects here.");
  });

  it("请求的是 .rss 而不是 .json（JSON 接口从机房 IP 一律 403）", async () => {
    const spy = stubReddit(REDDIT_ATOM);

    await executeSkill("searchReddit", { query: "python", mode: "hot" });

    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("/r/python/hot.rss");
    expect(url).not.toContain(".json");
  });

  it("mode=search 且指定版块时限定在版块内搜索", async () => {
    const spy = stubReddit(REDDIT_ATOM);

    await executeSkill("searchReddit", { query: "asyncio", mode: "search", subreddit: "python" });

    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("/r/python/search.rss");
    expect(url).toContain("restrict_sr=1");
    expect(url).toContain("q=asyncio");
  });

  it("mode=search 不指定版块时走全局搜索", async () => {
    const spy = stubReddit(REDDIT_ATOM);

    await executeSkill("searchReddit", { query: "asyncio", mode: "search" });

    expect(String(spy.mock.calls[0][0])).toContain("https://www.reddit.com/search.rss?q=asyncio");
  });

  it("429 给出限流说明和替代方案，而不是一句“请稍后重试”", async () => {
    stubReddit("", 429);

    const result = await executeSkill("searchReddit", { query: "python", mode: "hot" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("429");
    expect(result.error).toContain("searchHackerNews");
  });

  it("403 提示换用其他来源", async () => {
    stubReddit("", 403);

    const result = await executeSkill("searchReddit", { query: "python", mode: "hot" });

    expect(result.error).toContain("403");
    expect(result.error).toContain("readWebPage");
  });

  it("空 feed 时说明可能是私有/成人版块，而不是笼统报错", async () => {
    stubReddit('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>empty</title></feed>');

    const result = await executeSkill("searchReddit", { query: "notexist", mode: "hot" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("私有");
  });
});

describe("readRSS 的订阅源解析", () => {  const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>示例 Atom 源</title>
  <entry>
    <title>第一篇</title>
    <link href="https://example.com/a" />
    <published>2026-08-01T00:00:00Z</published>
    <summary>摘要甲</summary>
  </entry>
  <entry>
    <title>第二篇</title>
    <link href="https://example.com/b" />
    <published>2026-08-02T00:00:00Z</published>
    <summary>摘要乙</summary>
  </entry>
</feed>`;

  const rss2 = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>示例 RSS 源</title>
  <item><title>条目一</title><link>https://example.com/1</link><pubDate>Sat, 01 Aug 2026 00:00:00 GMT</pubDate><description>说明一</description></item>
</channel></rss>`;

  it("解析 Atom 的 entry（此前 entryMatch 未声明，整支分支必抛 ReferenceError）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(atom, { headers: { "content-type": "application/atom+xml" } })));

    const result = await executeSkill("readRSS", { url: "https://example.com/feed.xml" });

    expect(result.success).toBe(true);
    const data = result.data as { items: Array<{ title: string; link: string; summary: string }> };
    expect(data.items).toHaveLength(2);
    expect(data.items[0].title).toBe("第一篇");
    expect(data.items[0].link).toBe("https://example.com/a");
    expect(data.items[1].summary).toBe("摘要乙");
  });

  it("解析 RSS 2.0 的 item", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(rss2, { headers: { "content-type": "application/rss+xml" } })));

    const result = await executeSkill("readRSS", { url: "https://example.com/rss.xml" });

    expect(result.success).toBe(true);
    const data = result.data as { items: Array<{ title: string; link: string }> };
    expect(data.items).toHaveLength(1);
    expect(data.items[0].title).toBe("条目一");
  });

  it("订阅源地址指向内网时被拦下", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await executeSkill("readRSS", { url: "http://192.168.1.1/feed.xml" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("内网或本机");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
