// 出网地址安全校验：拦截指向内网、本机、云元数据的采集地址。
//
// 采集地址来自用户输入，且爬虫会自动跟进页面里发现的链接、fetch 默认会跟随重定向，
// 因此拦截必须同时覆盖：种子地址、每一个跟进链接、每一跳重定向。
//
// 已知局限：运行在 Workers 上没有 DNS 解析接口，这里只能按主机名与字面量 IP 判定。
// 指向内网的公网域名（如 127.0.0.1.nip.io 这类 DNS 重绑定）无法在此层拦截，
// 需要由出口网络策略或 COLLECTOR_PROXY_URL 代理侧兜底。
//
// 本模块不依赖 cloudflare:workers，可被单元测试直接导入。

const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".localdomain", ".home.arpa"];
const ALLOWED_PORTS = ["", "80", "443", "8080", "8443"];

function ipv4Blocked(parts: number[]) {
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;            // 本机 / 私网 A 段
  if (a === 169 && b === 254) return true;                       // 链路本地，含云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;              // 私网 B 段
  if (a === 192 && b === 168) return true;                       // 私网 C 段
  if (a === 192 && b === 0) return true;                         // IETF 协议专用
  if (a === 100 && b >= 64 && b <= 127) return true;             // 运营商级 NAT
  if (a === 198 && (b === 18 || b === 19)) return true;          // 基准测试
  if (a >= 224) return true;                                     // 组播与保留段
  return false;
}

function parseIpv4(host: string) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  if (numbers.some(value => value < 0 || value > 255)) return null;
  return numbers;
}

export function isBlockedHost(rawHost: string) {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;

  // IPv6：去掉方括号后判定回环、未指定地址、唯一本地地址(fc00::/7)、链路本地(fe80::/10)。
  if (host.startsWith("[") || host.includes(":")) {
    const v6 = host.replace(/^\[|\]$/g, "");
    if (v6 === "::1" || v6 === "::") return true;
    const head = v6.split(":")[0];
    if (/^f[cd][0-9a-f]{2}$/.test(head)) return true;
    if (/^fe[89ab][0-9a-f]$/.test(head)) return true;
    const mapped = v6.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);            // ::ffff:127.0.0.1
    const mappedParts = mapped ? parseIpv4(mapped[1]) : null;
    if (mappedParts && ipv4Blocked(mappedParts)) return true;
    return false;
  }

  const ipv4 = parseIpv4(host);
  if (ipv4) return ipv4Blocked(ipv4);

  if (host === "localhost") return true;
  if (BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) return true;
  // 单标签主机名在容器网络里会解析到内部服务（app、model-relay、channel-gateway 等），
  // 同时也挡住 http://2130706433 这类整数形式的回环地址写法。
  if (!host.includes(".")) return true;
  return false;
}

export function assertPublicCollectionUrl(url: URL) {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("采集地址只支持 http/https");
  if (!ALLOWED_PORTS.includes(url.port)) throw new Error("采集地址不允许访问非常规端口");
  if (isBlockedHost(url.hostname)) throw new Error("采集地址指向内网或本机，已被安全策略拦截");
  return url;
}
