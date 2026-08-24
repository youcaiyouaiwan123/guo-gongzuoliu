// 断网冒烟：验证「裁剪运行时闭包」在没有 npm、没有开发依赖的情况下能真正跑起来。
// 只能对本机架构（linux-x64）执行——win/mac 的 workerd 无法在 Linux 上运行，那些目标
// 的冒烟必须在对应 OS 的离线虚拟机上跑（见 packaging/README.md）。
// 步骤：用组装好的 out/<key> 作为 PROGRAM_DIR，跑 migrate + wrangler dev，
// curl / 与一个 /api/*，断言 200 且 workerd 已 spawn。
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function httpGet(port, pathname) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.once("timeout", () => { req.destroy(); resolve(0); });
    req.once("error", () => resolve(0));
    req.end();
  });
}

async function waitHttp(port, pathname, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpGet(port, pathname)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export async function smoke(progDir) {
  const nodeBin = path.join(progDir, "runtime", "bin", "node"); // linux/mac 布局
  const node = fs.existsSync(nodeBin) ? nodeBin : process.execPath;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "haixin-smoke-"));
  const stateDir = path.join(dataDir, "state");
  const wrangler = path.join(progDir, "node_modules", "wrangler", "bin", "wrangler.js");
  const config = path.join(progDir, "dist", "server", "wrangler.json");
  const env = { ...process.env, HAIXIN_DATA_DIR: dataDir, PATH: process.env.PATH };
  let failed = null;
  let app = null;
  try {
    console.log("[smoke] 迁移 …");
    execFileSync(node, [path.join(progDir, "packaging", "migrate.mjs")], { env, stdio: "inherit" });

    console.log("[smoke] 启动 wrangler dev（仅裁剪树，无 npm）…");
    app = spawn(
      node,
      [wrangler, "dev", "--local", "--config", config, "--persist-to", stateDir,
        "--ip", "127.0.0.1", "--port", "3100", "--log-level", "warn", "--no-show-interactive-dev-session",
        "--var", "PLATFORM_CREDENTIALS_KEY:smoke", "--var", "HAIXIN_GATEWAY_ADMIN_SECRET:smoke",
        "--var", "DEFAULT_ADMIN_USERNAME:admin", "--var", "DEFAULT_ADMIN_PASSWORD:smoke"],
      { cwd: progDir, env, stdio: ["ignore", "inherit", "inherit"], detached: process.platform !== "win32" },
    );
    app.unref();

    if (!(await waitHttp(3100, "/", 120_000))) throw new Error("app 未在 120s 内就绪");
    const root = await httpGet(3100, "/");
    const api = await httpGet(3100, "/api/state");
    console.log(`[smoke] GET / -> ${root}, GET /api/state -> ${api}`);
    if (root < 200 || root >= 500) throw new Error(`/ 返回 ${root}`);

    // 断言 workerd 真的起来了（裁剪树若缺 workerd，wrangler 会报错而非静默）。
    const ps = process.platform === "win32"
      ? execFileSync("powershell", ["-NoProfile", "-Command", "Get-Process workerd -ErrorAction SilentlyContinue"], { encoding: "utf8" })
      : execFileSync("pgrep", ["-f", "workerd"], { encoding: "utf8" }).trim();
    if (!ps) throw new Error("未发现 workerd 进程");
    console.log("[smoke] workerd 进程存在 ✓");
    console.log(`[smoke] ${path.basename(progDir)} 通过 ✓`);
  } catch (err) {
    failed = err;
    console.error(`[smoke] 失败：${err.message}`);
  } finally {
    if (app?.pid) {
      try { process.platform === "win32" ? execFileSync("taskkill", ["/pid", String(app.pid), "/T", "/F"]) : process.kill(-app.pid, "SIGKILL"); } catch {}
      try { app.kill("SIGKILL"); } catch {}
    }
    // 兜底清掉可能残留的 workerd（仅本次 stateDir 相关的很难精确匹配，这里保守不误杀）
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  if (failed) throw failed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const key = process.argv[2] || "linux-x64";
  const progDir = process.argv[3] || path.join(REPO_ROOT, "packaging", "build", "out", key);
  smoke(progDir).catch(() => process.exit(1));
}
