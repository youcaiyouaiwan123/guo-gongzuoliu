// 守护进程：系统服务的唯一入口（Windows 服务 / macOS launchd 都 exec 本文件）。
// 职责：迁移 → 按序拉起四个子进程 → 崩溃退避重启 → 内存上限（Node 堆 + workerd RSS）
//        → 健康探测 → 优雅关闭。无第三方依赖。
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import {
  PROGRAM_DIR,
  STATE_DIR,
  LOGS_DIR,
  TMP_DIR,
  DATA_DIR,
  CONFIG_FILE,
  WRANGLER_BIN,
  WRANGLER_CONFIG,
  MODEL_RELAY_ENTRY,
  GATEWAY_ENTRY,
  PROXY_ENTRY,
} from "./lib/paths.mjs";
import { RotatingLog } from "./lib/logrotate.mjs";
import { sampleTreeRss, descendantsAndSelf } from "./lib/procmon.mjs";
import { ensureConfig, loadConfig, assertRequired, appVars, gatewayEnv } from "./lib/config.mjs";
import { runMigrations } from "./migrate.mjs";

const PROBE_INTERVAL = 15_000;
const HEALTH_FAIL_LIMIT = 3; // 连续失败次数达到即重启
const RSS_OVER_LIMIT = 2; // RSS 连续超限次数达到即重启 app
const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
const APP_RSS_CAP = num(process.env.HAIXIN_APP_RSS_CAP_MB, 1536) * 1024 * 1024;

let shuttingDown = false;
const runLog = new RotatingLog(path.join(LOGS_DIR, "supervisor.log"));
function log(msg) {
  const line = `[supervisor] ${msg}`;
  console.log(line);
  runLog.line(line);
}

// ---- 探测工具 ----
function tcpProbe(port, host = "127.0.0.1", timeout = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

function httpProbe(port, pathname = "/", host = "127.0.0.1", timeout = 4000) {
  // 任意 HTTP 响应即视为「存活」（网关 /healthz 无账号 200、有离线账号 503，都算活着）。
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: pathname, method: "GET", timeout }, (res) => {
      res.resume();
      resolve(true);
    });
    req.once("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.once("error", () => resolve(false));
    req.end();
  });
}

// ---- 跨平台杀进程树 ----
// POSIX 上 process.kill 只作用于单个 pid，故需枚举后代逐一杀掉，避免 wrangler 被杀后残留 workerd 孤儿。
function killTree(pid, signal = "SIGTERM") {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
    return;
  }
  let targets = [{ pid }];
  try {
    targets = descendantsAndSelf(pid);
  } catch {}
  // 先杀子后杀父，减少父进程重拉子进程的窗口。
  for (const p of targets.reverse()) {
    try {
      process.kill(p.pid, signal);
    } catch {}
  }
}

// ---- 被守护的单个服务 ----
class Service {
  constructor(spec) {
    Object.assign(this, spec); // { name, spawn:()=>{command,args,env}, health, maxOldSpaceMB, rssCap }
    this.out = new RotatingLog(path.join(LOGS_DIR, `${this.name}.log`));
    this.err = new RotatingLog(path.join(LOGS_DIR, `${this.name}.err`));
    this.child = null;
    this.fails = 0; // 连续崩溃次数（退避用）
    this.restartTimes = []; // 60s 滚动窗口内的重启时刻
    this.startedAt = 0;
    this.healthFails = 0;
    this.rssOver = 0;
    this.stopped = false;
  }

  start() {
    if (this.stopped || shuttingDown) return;
    const { command, args, env } = this.spawn();
    const child = spawn(command, args, {
      cwd: PROGRAM_DIR,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.startedAt = Date.now();
    this.healthFails = 0;
    this.rssOver = 0;
    child.stdout.on("data", (d) => this.out.write(d));
    child.stderr.on("data", (d) => this.err.write(d));
    child.once("exit", (code, signal) => this.onExit(code, signal));
    child.once("error", (e) => this.err.line(`spawn error: ${e.message}`));
    log(`${this.name} 已启动 pid=${child.pid}`);
  }

  onExit(code, signal) {
    if (this.stopped || shuttingDown) return;
    const uptime = Date.now() - this.startedAt;
    if (uptime > 60_000) this.fails = 0; // 稳定超过 60s 视为健康，复位退避
    this.fails++;

    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < 60_000);
    this.restartTimes.push(now);

    let delay = Math.min(1000 * 2 ** (this.fails - 1), 30_000);
    if (this.restartTimes.length > 5) {
      // 1 分钟内重启过频：进入降级，固定 30s 慢速重试并高声告警。
      delay = 30_000;
      log(`⚠ ${this.name} 一分钟内重启超过 5 次（code=${code} signal=${signal}），降级慢速重试。`);
    } else {
      log(`${this.name} 退出（code=${code} signal=${signal}），${delay}ms 后重启。`);
    }
    setTimeout(() => this.start(), delay);
  }

  async probe() {
    if (this.stopped || !this.child || !this.health) return;
    if (Date.now() - this.startedAt < (this.health.graceMs || 20_000)) return; // 启动宽限期
    const ok =
      this.health.type === "tcp"
        ? await tcpProbe(this.health.port)
        : await httpProbe(this.health.port, this.health.path || "/");
    if (ok) {
      this.healthFails = 0;
      return;
    }
    this.healthFails++;
    if (this.healthFails >= HEALTH_FAIL_LIMIT) {
      log(`${this.name} 健康检查连续失败 ${this.healthFails} 次，强制重启。`);
      this.healthFails = 0;
      this.restart();
    }
  }

  // app 专用：workerd 是子进程，Node 堆上限管不到，按整棵进程树 RSS 兜底。
  monitorRss() {
    if (this.stopped || !this.child || !this.rssCap) return;
    if (Date.now() - this.startedAt < 30_000) return;
    let rss = 0;
    try {
      rss = sampleTreeRss(this.child.pid);
    } catch {
      return;
    }
    if (rss > this.rssCap) {
      this.rssOver++;
      log(`${this.name} 内存 ${(rss / 1048576) | 0}MB 超过上限 ${(this.rssCap / 1048576) | 0}MB（${this.rssOver}/${RSS_OVER_LIMIT}）。`);
      if (this.rssOver >= RSS_OVER_LIMIT) {
        this.rssOver = 0;
        log(`${this.name} 内存持续超限，重启该服务。`);
        this.restart();
      }
    } else {
      this.rssOver = 0;
    }
  }

  restart() {
    if (this.child) killTree(this.child.pid); // exit 事件会触发退避重启
  }

  async stop() {
    this.stopped = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    killTree(child.pid, "SIGTERM");
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) {
      log(`${this.name} 未在 10s 内退出，强制杀死。`);
      killTree(child.pid, "SIGKILL");
    }
  }
}

// ---- 服务定义 ----
function nodeArgs(maxOldSpaceMB, entry, extra = []) {
  const flags = maxOldSpaceMB ? [`--max-old-space-size=${maxOldSpaceMB}`] : [];
  return [...flags, entry, ...extra];
}

function buildServices(config) {
  const baseEnv = { TMPDIR: TMP_DIR, TMP: TMP_DIR, TEMP: TMP_DIR };

  const relay = new Service({
    name: "model-relay",
    spawn: () => ({ command: process.execPath, args: nodeArgs(256, MODEL_RELAY_ENTRY), env: baseEnv }),
    health: { type: "tcp", port: 8789 },
  });

  const appVarArgs = Object.entries(appVars(config)).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
  const app = new Service({
    name: "app",
    spawn: () => ({
      command: process.execPath,
      args: [
        WRANGLER_BIN, "dev", "--local",
        "--config", WRANGLER_CONFIG,
        "--persist-to", STATE_DIR,
        "--ip", "127.0.0.1", "--port", "3000",
        "--log-level", "warn", "--no-show-interactive-dev-session",
        ...appVarArgs,
      ],
      env: { ...baseEnv, WRANGLER_SEND_METRICS: "false" },
    }),
    health: { type: "http", port: 3000, path: "/", graceMs: 45_000 },
    rssCap: APP_RSS_CAP,
  });

  const gateway = new Service({
    name: "channel-gateway",
    spawn: () => ({ command: process.execPath, args: nodeArgs(384, GATEWAY_ENTRY), env: { ...baseEnv, ...gatewayEnv(config) } }),
    health: { type: "http", port: 8788, path: "/healthz" },
  });

  const proxy = new Service({
    name: "proxy",
    spawn: () => ({ command: process.execPath, args: nodeArgs(128, PROXY_ENTRY), env: baseEnv }),
    health: { type: "tcp", port: num(process.env.PROXY_PORT, 8799) },
  });

  return { relay, app, gateway, proxy };
}

async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown) return false;
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  log(`⚠ 等待 ${label} 就绪超时（${timeoutMs}ms），继续启动其余服务。`);
  return false;
}

async function main() {
  for (const dir of [DATA_DIR, STATE_DIR, LOGS_DIR, TMP_DIR]) fs.mkdirSync(dir, { recursive: true });

  ensureConfig();
  const config = loadConfig();
  assertRequired(config); // 必填缺失 → 抛出 → 进程退出（由系统服务重启，但会持续失败并记录）

  // 对外控制台端口：命令行环境变量优先，其次 config.env 的 HTTP_PORT，默认 80。
  // 统一写回 process.env.PROXY_PORT，使 proxy 子进程与健康检查取到同一端口。
  const httpPort = num(process.env.PROXY_PORT || config.HTTP_PORT, 8799);
  process.env.PROXY_PORT = String(httpPort);
  // 启动前预探测：此刻 proxy 尚未起，若端口已通 = 被其它程序占用，提前给出人话告警。
  if (await tcpProbe(httpPort, "127.0.0.1", 1500)) {
    log(`⚠ 端口 ${httpPort} 疑似已被其它程序占用。若装完打不开控制台，请在 ${CONFIG_FILE} 设置 HTTP_PORT=<空闲端口>（如 8080）后重启服务。`);
  }

  log("执行数据库迁移…");
  runMigrations(); // 迁移失败会抛出，守护随之退出——绝不带半初始化状态启动 app

  const svc = buildServices(config);
  const order = [svc.relay, svc.app, svc.gateway, svc.proxy];

  svc.relay.start();
  svc.app.start();
  await waitFor("app :3000", () => httpProbe(3000, "/"), 120_000);
  svc.gateway.start();
  svc.proxy.start();

  const services = Object.values(svc);
  setInterval(() => {
    for (const s of services) void s.probe();
    svc.app.monitorRss();
  }, PROBE_INTERVAL).unref();

  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${sig}，开始优雅关闭…`);
    for (const s of [...order].reverse()) await s.stop();
    log("已全部停止。");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGBREAK", () => void shutdown("SIGBREAK")); // Windows 服务停止

  log(`守护就绪。程序目录 ${PROGRAM_DIR}，数据目录 ${DATA_DIR}。`);
}

main().catch((err) => {
  log(`致命错误：${err.message || err}`);
  process.exit(1);
});
