import { describe, it, expect } from "vitest";
import { isBlockedHost, assertPublicCollectionUrl } from "../_urlGuard";

// 直接导入 _urlGuard 的真实实现（该模块不依赖 cloudflare:workers）。

describe("isBlockedHost — 内网与本机地址", () => {
  const blocked = [
    "127.0.0.1", "127.1.2.3", "0.0.0.0",
    "10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.1",
    "169.254.169.254",              // 云元数据
    "100.64.0.1",                   // CGNAT
    "192.0.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "localhost", "LOCALHOST", "localhost.",
    "app", "model-relay", "channel-gateway",   // 容器服务名（单标签）
    "2130706433",                   // 127.0.0.1 的整数写法
    "printer.local", "db.internal", "foo.localhost", "x.localdomain",
    "metadata.google.internal",
    "::1", "[::1]", "::", "fc00::1", "fd12:3456::1", "fe80::1",
    "::ffff:127.0.0.1",
    "",
  ];
  it.each(blocked)("拦截 %s", host => {
    expect(isBlockedHost(host)).toBe(true);
  });
});

describe("isBlockedHost — 正常公网地址不应被误拦", () => {
  const allowed = [
    "example.com", "www.example.com", "sub.domain.example.co.uk",
    "8.8.8.8", "1.1.1.1", "223.5.5.5",
    "172.15.0.1", "172.32.0.1",     // 紧邻私网 B 段边界之外
    "11.0.0.1", "126.0.0.1", "128.0.0.1",
    "192.169.0.1", "100.63.0.1", "100.128.0.1",
    "2001:4860:4860::8888",         // 公网 IPv6
    "xn--fiqs8s.com",
  ];
  it.each(allowed)("放行 %s", host => {
    expect(isBlockedHost(host)).toBe(false);
  });
});

describe("assertPublicCollectionUrl", () => {
  it("放行正常 https 地址", () => {
    expect(() => assertPublicCollectionUrl(new URL("https://example.com/page"))).not.toThrow();
  });

  it("拦截回环地址", () => {
    expect(() => assertPublicCollectionUrl(new URL("http://127.0.0.1/admin"))).toThrow("内网或本机");
  });

  it("拦截云元数据端点", () => {
    expect(() => assertPublicCollectionUrl(new URL("http://169.254.169.254/latest/meta-data/"))).toThrow("内网或本机");
  });

  it("拦截容器服务名", () => {
    expect(() => assertPublicCollectionUrl(new URL("http://app:3000/api/users"))).toThrow();
  });

  it("拦截非 http/https 协议", () => {
    expect(() => assertPublicCollectionUrl(new URL("file:///etc/passwd"))).toThrow("http/https");
    expect(() => assertPublicCollectionUrl(new URL("gopher://example.com/"))).toThrow("http/https");
  });

  it("拦截非常规端口", () => {
    expect(() => assertPublicCollectionUrl(new URL("http://example.com:6379/"))).toThrow("端口");
    expect(() => assertPublicCollectionUrl(new URL("http://example.com:22/"))).toThrow("端口");
  });

  it("放行常规端口", () => {
    expect(() => assertPublicCollectionUrl(new URL("https://example.com:443/"))).not.toThrow();
    expect(() => assertPublicCollectionUrl(new URL("http://example.com:8080/"))).not.toThrow();
  });
});
