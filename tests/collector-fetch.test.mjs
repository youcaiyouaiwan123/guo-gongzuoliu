// 采集出网层的回归测试：重定向跟随、字符集解码、体积截断、逐跳 SSRF 校验。
//
// 这四点正是"JSON 抓取失败 / CSV 地址文件获取失败"的直接成因：
// 生产环境配置了 COLLECTOR_PROXY_URL，所有 URL 采集都走这里，
// 代理不跟随 302、固定按 UTF-8 解码，下载类地址与 GBK 导出文件必然失败。
//
// 网络请求通过 options.transport 注入假实现，用例不发真实 HTTP 请求；
// 但每一跳的 assertPublicTarget 走的是真实实现（含 DNS 解析），SSRF 防护是真的被测到。
import assert from "node:assert/strict";
import test from "node:test";
import { decodeBody, requestTextFollowingRedirects } from "../services/model-relay/collector.mjs";

function fakeTransport(responses) {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, headers: options.headers });
    const response = responses[url];
    assert.ok(response, `未预置该地址的响应：${url}`);
    return { status: 200, contentType: "text/plain", headers: {}, body: "", truncated: false, ...response };
  };
  return { transport, calls };
}

test("decodeBody 按 content-type 的 charset 解码 GBK", () => {
  // "日期,消耗" 的 GBK 字节序列
  const gbk = Buffer.from([0xc8, 0xd5, 0xc6, 0xda, 0x2c, 0xcf, 0xfb, 0xba, 0xc4]);
  assert.equal(decodeBody(gbk, "text/csv; charset=GBK"), "日期,消耗");
  assert.notEqual(decodeBody(gbk, "text/csv"), "日期,消耗", "没有 charset 提示时按 UTF-8 解，用例前提是它确实会乱码");
});

test("decodeBody 优先识别 BOM", () => {
  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("日期,消耗", "utf8")]);
  assert.equal(decodeBody(utf8Bom, "text/csv; charset=GBK"), "日期,消耗");
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("日期", "utf16le")]);
  assert.equal(decodeBody(utf16le, "text/csv"), "日期");
});

test("decodeBody 遇到不认识的字符集时回落 UTF-8 而不是抛错", () => {
  assert.equal(decodeBody(Buffer.from("abc", "utf8"), "text/csv; charset=not-a-real-charset"), "abc");
});

test("跟随 302 直到拿到真实内容", async () => {
  const { transport, calls } = fakeTransport({
    "https://example.com/export.csv": { status: 302, headers: { location: "https://example.com/files/export.csv" } },
    "https://example.com/files/export.csv": { status: 200, body: "日期,消耗\n2026-07-01,100", contentType: "text/csv" },
  });
  const result = await requestTextFollowingRedirects("https://example.com/export.csv", { transport });
  assert.equal(result.status, 200);
  assert.equal(result.body, "日期,消耗\n2026-07-01,100");
  assert.equal(result.finalUrl, "https://example.com/files/export.csv");
  assert.equal(calls.length, 2);
});

test("跨站跳转丢弃自定义鉴权头", async () => {
  const { transport, calls } = fakeTransport({
    "https://example.com/api": { status: 302, headers: { location: "https://example.org/signed" } },
    "https://example.org/signed": { status: 200, body: "{}" },
  });
  await requestTextFollowingRedirects("https://example.com/api", {
    transport,
    headers: { Authorization: "Bearer secret-token" },
  });
  assert.equal(calls[0].headers.Authorization, "Bearer secret-token");
  assert.deepEqual(calls[1].headers, {}, "跳到别的站点后不能再带上原站的 token");
});

test("同站跳转保留请求头", async () => {
  const { transport, calls } = fakeTransport({
    "https://example.com/api": { status: 301, headers: { location: "/api/v2" } },
    "https://example.com/api/v2": { status: 200, body: "{}" },
  });
  await requestTextFollowingRedirects("https://example.com/api", {
    transport,
    headers: { Authorization: "Bearer secret-token" },
  });
  assert.equal(calls[1].headers.Authorization, "Bearer secret-token");
});

test("每一跳都重新校验目标，跳向内网被拦截", async () => {
  const { transport } = fakeTransport({
    "https://example.com/redirect": { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } },
  });
  await assert.rejects(
    () => requestTextFollowingRedirects("https://example.com/redirect", { transport }),
    /not allowed/,
  );
});

test("重定向次数过多时报错而不是无限跟随", async () => {
  const transport = async () => ({ status: 302, headers: { location: "https://example.com/loop" }, body: "", contentType: "text/html" });
  await assert.rejects(
    () => requestTextFollowingRedirects("https://example.com/loop", { transport }),
    /redirected too many times/,
  );
});

test("3xx 但没有 Location 时按原响应返回，不再继续跳", async () => {
  const { transport } = fakeTransport({
    "https://example.com/x": { status: 304, headers: {}, body: "" },
  });
  const result = await requestTextFollowingRedirects("https://example.com/x", { transport });
  assert.equal(result.status, 304);
});
