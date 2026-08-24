// 反向代理（替代 deploy/nginx-ip.conf）。零依赖，仅对外监听 80，转发到 app 的 127.0.0.1:3000。
// 复刻 nginx 行为：
//   * client_max_body_size 100m —— 超限回 413；
//   * proxy_read/send_timeout 600s —— 上游长任务不误判超时；
//   * 转发头 Host / X-Real-IP / X-Forwarded-For / X-Forwarded-Proto；
//   * 静态资源扩展名正则改写 Cache-Control: public, max-age=2592000；
//   * 不处理 websocket upgrade（与原配置一致）。
import http from "node:http";

const LISTEN_PORT = Number(process.env.PROXY_PORT || 8799);
// 桌面版默认只绑本机回环：既避免 Windows 防火墙"是否允许公网访问"弹窗，也不把控制台暴露到局域网。
// 如需局域网访问，设 PROXY_HOST=0.0.0.0。
const LISTEN_HOST = process.env.PROXY_HOST || "127.0.0.1";
const UPSTREAM_HOST = "127.0.0.1";
const UPSTREAM_PORT = 3000;
const MAX_BODY = 100 * 1024 * 1024; // 100m
const UPSTREAM_TIMEOUT = 600_000; // 600s
const STATIC_RE = /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)(?:\?|$)/i;
const STATIC_CACHE = "public, max-age=2592000";

const server = http.createServer((req, res) => {
  // body 大小上限：优先看 Content-Length，同时在流式累计时兜底。
  const declared = Number(req.headers["content-length"] || 0);
  if (declared && declared > MAX_BODY) {
    res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Request Entity Too Large");
    req.destroy();
    return;
  }

  const remote = req.socket.remoteAddress || "";
  const priorXff = req.headers["x-forwarded-for"];
  const headers = {
    ...req.headers,
    "x-real-ip": remote,
    "x-forwarded-for": priorXff ? `${priorXff}, ${remote}` : remote,
    "x-forwarded-proto": "http",
  };

  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers,
    },
    (upRes) => {
      const outHeaders = { ...upRes.headers };
      if (STATIC_RE.test(req.url || "")) {
        delete outHeaders["cache-control"];
        outHeaders["cache-control"] = STATIC_CACHE;
      }
      res.writeHead(upRes.statusCode || 502, outHeaders);
      upRes.pipe(res);
    },
  );

  upstream.setTimeout(UPSTREAM_TIMEOUT, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad Gateway");
    } else {
      res.destroy();
    }
  });

  // 流式转发请求体，超阈值即断开。
  let received = 0;
  req.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_BODY) {
      upstream.destroy(new Error("body too large"));
      if (!res.headersSent) {
        res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Request Entity Too Large");
      }
      req.destroy();
    }
  });
  req.pipe(upstream);
});

// 连接级超时对齐 nginx 的读写超时。
server.setTimeout(UPSTREAM_TIMEOUT + 30_000);

// 监听失败必须给出「人话」诊断——否则端口被占只会表现为守护无脑崩溃重启。
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[proxy] 端口 ${LISTEN_HOST}:${LISTEN_PORT} 已被其它程序占用，无法启动控制台。\n` +
      `        请在数据目录的 config.env 里设置 HTTP_PORT=<空闲端口>（如 8080）后重启服务。`,
    );
  } else if (err.code === "EACCES") {
    console.error(
      `[proxy] 无权限绑定端口 ${LISTEN_PORT}（<1024 需管理员/root）。\n` +
      `        请确认以系统服务身份运行，或在 config.env 设置 HTTP_PORT=<≥1024 的端口>。`,
    );
  } else {
    console.error(`[proxy] 监听 ${LISTEN_HOST}:${LISTEN_PORT} 失败：${err.message}`);
  }
  process.exit(1); // 交给守护退避重启；此时日志已能说清原因
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`Haixin reverse proxy listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
