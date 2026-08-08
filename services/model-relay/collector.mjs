// 采集出网的底层实现：SSRF 校验、重定向跟随、字符集解码、体积上限。
//
// 从 server.mjs 拆出来有两个原因：
// 1) server.mjs 一被 import 就会 listen(8789)，测试无法安全导入；
// 2) 重定向与解码是"CSV/JSON 采集失败"的直接原因，必须能写回归测试。

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export const MAX_COLLECT_BYTES = 500_000;

export function isBlockedIpv4(address) {
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

export function isBlockedIp(address) {
  if (net.isIPv4(address)) return isBlockedIpv4(address);
  if (!net.isIPv6(address)) return true;
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return true;
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isBlockedIpv4(mappedIpv4) : false;
}

export async function assertPublicTarget(targetUrl) {
  const parsed = new URL(targetUrl);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname === "metadata.google.internal") {
    throw new Error("collection target is not allowed");
  }
  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => isBlockedIp(item.address))) {
    throw new Error("collection target is not allowed");
  }
}

/**
 * 按响应实际字符集解码。
 *
 * 之前固定 toString("utf8")：国内平台导出的 CSV/TXT 基本是 GBK/GB18030，
 * 解出来整片乱码 → 表头匹配不上 → 用户看到的就是"CSV 地址文件获取失败"。
 * 优先级：BOM > content-type 里的 charset > UTF-8。
 */
export function decodeBody(buffer, contentType = "") {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  }
  const charset = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)?.[1]?.toLowerCase();
  if (!charset || charset === "utf-8" || charset === "utf8") return buffer.toString("utf8");
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    // 运行时不认识的字符集（如 ICU 未编译进来）不能让整次采集失败，按 UTF-8 尽力而为。
    return buffer.toString("utf8");
  }
}

export function requestText(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === "https:" ? https : http;
    const body = options.body ? Buffer.from(options.body, "utf8") : null;
    const req = client.request(
      parsed,
      {
        method: options.method || "GET",
        timeout: options.timeout || 15000,
        rejectUnauthorized: true,
        ...(options.publicOnly ? {
          lookup(hostname, lookupOptions, callback) {
            // Node 调用该钩子时会带 all:true，此时 dns.lookup 回调的 address 是数组而非字符串，
            // 因此必须分别处理两种形态：数组要逐个校验（任一为内网地址即拒绝，防止 DNS 多记录绕过），
            // 字符串按单地址校验。早先只判 typeof === "string"，导致数组形态被一律当作非法，
            // 所有域名采集都失败。这里保持"解析结果全部为公网地址才放行"的 SSRF 防护强度。
            dns.lookup(hostname, lookupOptions, (error, address, family) => {
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
          },
        } : {}),
        headers: {
          "User-Agent": options.userAgent || "Haixin-Enterprise-Relay/1.0",
          Accept: options.accept || "*/*",
          ...(body ? { "Content-Type": "application/json", "Content-Length": body.length } : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        let truncated = false;
        res.on("data", (chunk) => {
          if (options.maxBytes && size >= options.maxBytes) {
            truncated = true;
            return;
          }
          const remaining = options.maxBytes ? options.maxBytes - size : chunk.length;
          if (chunk.length > remaining) truncated = true;
          const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          chunks.push(piece);
          size += piece.length;
        });
        res.on("end", () => {
          const contentType = res.headers["content-type"] || "text/plain; charset=utf-8";
          resolve({
            status: res.statusCode || 0,
            contentType,
            headers: res.headers,
            body: decodeBody(Buffer.concat(chunks), contentType),
            truncated,
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(options.timeoutMessage || "request timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 手动跟随重定向。
 *
 * 原实现完全不处理 3xx：CSV 下载地址、对象存储签名链接、API 网关几乎必然带一跳跳转，
 * 采集侧只会收到一个空 body 的 302，最终向用户报"远程返回 302"。
 * 而交给 Node 自动跟随又会绕过 SSRF 校验，因此每一跳都要重新 assertPublicTarget；
 * 跨 origin 时丢弃自定义请求头，避免把 Authorization 泄漏给跳转目标。
 *
 * options.transport 仅用于测试注入，默认走真实网络。
 */
export async function requestTextFollowingRedirects(targetUrl, options = {}, maxHops = 5) {
  const { transport = requestText, ...requestOptions } = options;
  let current = new URL(targetUrl);
  let headers = requestOptions.headers || {};
  for (let hop = 0; hop <= maxHops; hop += 1) {
    await assertPublicTarget(current.toString());
    const result = await transport(current.toString(), { ...requestOptions, headers });
    if (result.status < 300 || result.status >= 400) return { ...result, finalUrl: current.toString() };
    const location = result.headers?.location;
    if (!location) return { ...result, finalUrl: current.toString() };
    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error("collection redirect target is invalid");
    }
    if (next.origin !== current.origin) headers = {};
    current = next;
  }
  throw new Error("collection redirected too many times");
}
