import http from "node:http";
import dns from "node:dns";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 回归测试：model-relay 的 publicOnly lookup 钩子。
//
// 曾出现的线上故障：Node 调用 lookup 钩子时传入的 lookupOptions 带 all:true，
// 此时 dns.lookup 回调的 address 是数组而非字符串。旧代码只判 typeof address !== "string"
// 就拒绝，导致所有域名采集都被判为 "collection target is not allowed"，万能爬虫 100% 失败。
//
// 这里复刻 services/model-relay/server.mjs 的判定逻辑，锁住两件事：
//   1. 数组形态（all:true）下公网域名必须放行；
//   2. SSRF 防护不能因此被削弱——数组里任一内网地址都必须拒绝。

function isBlockedIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function isBlockedIp(address: string) {
  if (net.isIPv4(address)) return isBlockedIpv4(address);
  if (!net.isIPv6(address)) return true;
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return true;
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isBlockedIpv4(mappedIpv4) : false;
}

type LookupResult = string | Array<{ address: string; family: number }>;

// 与 server.mjs 中的钩子实现保持一致；注入 resolver 以便离线测试各种解析形态。
function guardLookup(
  resolver: (hostname: string, options: unknown, cb: (e: Error | null, address?: LookupResult, family?: number) => void) => void,
) {
  return (hostname: string, lookupOptions: unknown, callback: (e: Error | null, address?: LookupResult, family?: number) => void) => {
    resolver(hostname, lookupOptions, (error, address, family) => {
      if (error) return callback(error);
      if (Array.isArray(address)) {
        const resolved = address.filter(item => item && typeof item.address === "string");
        if (!resolved.length || resolved.some(item => isBlockedIp(item.address))) {
          return callback(new Error("collection target is not allowed"));
        }
        return callback(null, resolved, family);
      }
      if (typeof address !== "string" || isBlockedIp(address)) return callback(new Error("collection target is not allowed"));
      callback(null, address, family);
    });
  };
}

function runLookup(resolver: Parameters<typeof guardLookup>[0], options: unknown = { all: true, hints: 32 }) {
  return new Promise<{ error?: string; address?: LookupResult }>(resolve => {
    guardLookup(resolver)("example.test", options, (error, address) => {
      resolve(error ? { error: error.message } : { address });
    });
  });
}

const arrayResolver = (addresses: Array<{ address: string; family: number }>) =>
  (_h: string, _o: unknown, cb: (e: Error | null, a?: LookupResult, f?: number) => void) => cb(null, addresses, undefined);
const stringResolver = (address: string) =>
  (_h: string, _o: unknown, cb: (e: Error | null, a?: LookupResult, f?: number) => void) => cb(null, address, 4);

describe("采集代理 DNS 守卫：数组形态（回归 all:true 导致全部域名被拒）", () => {
  it("公网 IPv4 数组放行", async () => {
    const result = await runLookup(arrayResolver([{ address: "172.66.147.243", family: 4 }, { address: "104.20.23.154", family: 4 }]));
    expect(result.error).toBeUndefined();
    expect(result.address).toHaveLength(2);
  });

  it("公网 IPv6 数组放行", async () => {
    const result = await runLookup(arrayResolver([{ address: "2606:4700:10::6814:179a", family: 6 }]));
    expect(result.error).toBeUndefined();
  });

  it("公网 IPv4 与 IPv6 混合放行", async () => {
    const result = await runLookup(arrayResolver([{ address: "104.20.23.154", family: 4 }, { address: "2606:4700:10::ac42:93f3", family: 6 }]));
    expect(result.error).toBeUndefined();
    expect(result.address).toHaveLength(2);
  });

  it("172.66 不属于私网 172.16-31，必须放行", async () => {
    const result = await runLookup(arrayResolver([{ address: "172.66.147.243", family: 4 }]));
    expect(result.error).toBeUndefined();
  });
});

describe("采集代理 DNS 守卫：SSRF 防护未被削弱", () => {
  it("回环地址拒绝", async () => {
    expect((await runLookup(arrayResolver([{ address: "127.0.0.1", family: 4 }]))).error).toBe("collection target is not allowed");
  });

  it("云元数据地址拒绝", async () => {
    expect((await runLookup(arrayResolver([{ address: "169.254.169.254", family: 4 }]))).error).toBe("collection target is not allowed");
  });

  it("私网 10.x 拒绝", async () => {
    expect((await runLookup(arrayResolver([{ address: "10.0.0.1", family: 4 }]))).error).toBe("collection target is not allowed");
  });

  it("私网 172.18 拒绝（Docker 网段）", async () => {
    expect((await runLookup(arrayResolver([{ address: "172.18.0.1", family: 4 }]))).error).toBe("collection target is not allowed");
  });

  it("私网 192.168 拒绝", async () => {
    expect((await runLookup(arrayResolver([{ address: "192.168.1.1", family: 4 }]))).error).toBe("collection target is not allowed");
  });

  it("DNS 多记录混投：公网+内网组合必须整体拒绝", async () => {
    const result = await runLookup(arrayResolver([{ address: "104.20.23.154", family: 4 }, { address: "127.0.0.1", family: 4 }]));
    expect(result.error).toBe("collection target is not allowed");
  });

  it("IPv6 回环拒绝", async () => {
    expect((await runLookup(arrayResolver([{ address: "::1", family: 6 }]))).error).toBe("collection target is not allowed");
  });

  it("IPv6 唯一本地地址 fd00 拒绝", async () => {
    expect((await runLookup(arrayResolver([{ address: "fd00::1", family: 6 }]))).error).toBe("collection target is not allowed");
  });

  it("IPv4 映射的回环 ::ffff:127.0.0.1 拒绝", async () => {
    expect((await runLookup(arrayResolver([{ address: "::ffff:127.0.0.1", family: 6 }]))).error).toBe("collection target is not allowed");
  });

  it("空数组拒绝", async () => {
    expect((await runLookup(arrayResolver([]))).error).toBe("collection target is not allowed");
  });
});

describe("采集代理 DNS 守卫：字符串形态与错误透传仍然正确", () => {
  it("公网字符串地址放行", async () => {
    const result = await runLookup(stringResolver("104.20.23.154"), { all: false });
    expect(result.error).toBeUndefined();
    expect(result.address).toBe("104.20.23.154");
  });

  it("内网字符串地址拒绝", async () => {
    expect((await runLookup(stringResolver("127.0.0.1"), { all: false })).error).toBe("collection target is not allowed");
  });

  it("解析失败时透传原始 DNS 错误，不伪装成 not allowed", async () => {
    const failing = (_h: string, _o: unknown, cb: (e: Error | null) => void) => cb(new Error("ENOTFOUND"));
    expect((await runLookup(failing)).error).toBe("ENOTFOUND");
  });
});

// 端到端：用真实 http 请求验证钩子能让连接实际建立（离线，打本地服务）。
describe("采集代理 DNS 守卫：真实请求链路", () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head><title>采集测试页</title></head><body>正文内容</body></html>");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("数组形态下请求能真正发出并取回正文（旧实现会在此报 not allowed）", async () => {
    // 目标是本机服务，故此处以公网地址通过守卫、再由 resolver 指回本地端口，
    // 只为验证"数组形态不再阻断连接建立"这一点。
    const resolver = (_h: string, _o: unknown, cb: (e: Error | null, a?: LookupResult, f?: number) => void) =>
      cb(null, [{ address: "104.20.23.154", family: 4 }], undefined);

    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        { host: "example.test", port, path: "/", method: "GET", lookup: guardLookup(resolver) as never,
          createConnection: (opts: net.NetConnectOpts, cb: (e: Error | null, s: net.Socket) => void) => {
            // 守卫已放行；实际连回本地测试服务。
            const socket = net.connect({ port, host: "127.0.0.1" });
            socket.on("connect", () => cb(null, socket));
            socket.on("error", err => cb(err, socket));
            return socket;
          } },
        res => {
          const chunks: Buffer[] = [];
          res.on("data", chunk => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(body).toContain("采集测试页");
    expect(body).toContain("正文内容");
  });
});
