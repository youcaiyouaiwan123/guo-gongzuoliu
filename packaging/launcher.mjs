// 桌面版启动器（双击"海芯 AI"图标最终跑到这里；用下载好的 Node 执行）。
// 用法：node launcher.mjs <start|stop|open>
//   start —— 若已在运行则直接开浏览器；否则后台(detached)拉起 supervisor，写 pid，
//            轮询控制台端口就绪后开浏览器；首次安装顺带打开管理员凭据。
//   stop  —— 读 pid，连同子进程树一起结束（"退出海芯"图标）。
//   open  —— 只开浏览器（不改变运行状态）。
// 与系统服务无关：supervisor 以当前用户身份后台常驻，直到用户点"退出海芯"或关机。
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import {
  DATA_DIR,
  LOGS_DIR,
  STATE_DIR,
  TMP_DIR,
  CONFIG_FILE,
  CREDENTIALS_FILE,
  PIDFILE,
  SUPERVISOR_ENTRY,
  runtimeReady,
} from "./lib/paths.mjs";

// 守护启动全过程（含 import 期崩溃、致命异常）都会写进这里——供启动失败时回读定位。
const BOOT_LOG = path.join(LOGS_DIR, "supervisor-boot.log");

// 打印某日志文件末尾若干行到控制台（启动失败时把真实原因直接摆到用户面前）。
function printTail(file, n = 30) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.length);
    const tail = lines.slice(-n);
    if (tail.length) {
      console.error(`----- ${path.basename(file)}（末 ${tail.length} 行）-----`);
      for (const l of tail) console.error(l);
      console.error("--------------------------------------------------");
    }
  } catch {}
}
import { ensureConfig, loadConfig } from "./lib/config.mjs";

const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);

function consolePort() {
  const cfg = loadConfig();
  return num(process.env.PROXY_PORT || cfg.HTTP_PORT, 8799);
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // 存在但无权发信号，也算活着
  }
}

function readPid() {
  try {
    const pid = parseInt(fs.readFileSync(PIDFILE, "utf8").trim(), 10);
    return Number.isFinite(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

function probePort(port, timeout = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
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

function httpReady(port, timeout = 2500) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/", method: "GET", timeout }, (res) => {
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

function openUrl(url) {
  const cmd =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const c = spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore", windowsHide: true });
    c.unref();
  } catch {}
}

function openFile(file) {
  if (!fs.existsSync(file)) return;
  const cmd =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", file]]
      : process.platform === "darwin"
        ? ["open", [file]]
        : ["xdg-open", [file]];
  try {
    const c = spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore", windowsHide: true });
    c.unref();
  } catch {}
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
    } catch {}
    return;
  }
  // POSIX：detached 启动的 supervisor 是进程组组长，负号杀整组。
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start() {
  const port = consolePort();

  // 已在运行？直接开浏览器。
  const pid = readPid();
  if (isAlive(pid) && (await probePort(port))) {
    console.log("海芯 AI 已在运行，正在打开控制台…");
    openUrl(`http://localhost:${port}`);
    return 0;
  }

  if (!runtimeReady()) {
    console.error("运行环境缺失（Node/wrangler 未就绪）。请重新运行 haixin.cmd 触发下载，或重装。");
    return 1;
  }

  for (const dir of [DATA_DIR, STATE_DIR, LOGS_DIR, TMP_DIR]) fs.mkdirSync(dir, { recursive: true });
  const firstRun = !fs.existsSync(CONFIG_FILE);
  ensureConfig(); // 生成密钥 + 管理员凭据（幂等）

  console.log("正在启动海芯 AI（后台）…");
  // 把守护的 stdout/stderr 接到 supervisor-boot.log：即便它在 import 期就崩，也能留下原因。
  const bootFd = fs.openSync(BOOT_LOG, "w");
  const child = spawn(process.execPath, [SUPERVISOR_ENTRY], {
    detached: true,
    stdio: ["ignore", bootFd, bootFd],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  try {
    fs.closeSync(bootFd); // 子进程已各自持有句柄，父进程可关闭
  } catch {}
  fs.writeFileSync(PIDFILE, String(child.pid));

  // 轮询控制台端口就绪（首启含数据库迁移，给足 3 分钟）。
  const deadline = Date.now() + 180_000;
  let up = false;
  while (Date.now() < deadline) {
    if (!isAlive(child.pid)) {
      console.error("\n海芯 AI 启动进程意外退出。真实原因如下（也保存在 " + BOOT_LOG + "）：\n");
      printTail(BOOT_LOG, 40);
      printTail(path.join(LOGS_DIR, "supervisor.log"), 20);
      return 1;
    }
    if (await httpReady(port)) {
      up = true;
      break;
    }
    process.stdout.write(firstRun ? "首次启动，正在初始化数据库…\r" : "正在启动…\r");
    await sleep(2000);
  }

  if (!up) {
    console.error("\n等待控制台就绪超时。海芯仍在后台尝试启动，可稍后再双击图标，或查看日志：" + LOGS_DIR);
    return 1;
  }

  console.log("\n海芯 AI 已就绪，正在打开控制台…");
  openUrl(`http://localhost:${port}`);
  if (firstRun && fs.existsSync(CREDENTIALS_FILE)) {
    console.log("首次安装：管理员账号密码见弹出的记事本（也保存在 " + CREDENTIALS_FILE + "）。");
    openFile(CREDENTIALS_FILE);
  }
  return 0;
}

async function stop() {
  const pid = readPid();
  if (!isAlive(pid)) {
    console.log("海芯 AI 未在运行。");
    try {
      fs.unlinkSync(PIDFILE);
    } catch {}
    return 0;
  }
  console.log("正在退出海芯 AI…");
  killTree(pid);
  // 等它真正退出
  for (let i = 0; i < 15 && isAlive(pid); i++) await sleep(1000);
  try {
    fs.unlinkSync(PIDFILE);
  } catch {}
  console.log(isAlive(pid) ? "未能完全退出，请在任务管理器结束 node 进程。" : "已退出。");
  return 0;
}

async function main() {
  const mode = (process.argv[2] || "start").toLowerCase();
  if (mode === "stop") return stop();
  if (mode === "open") {
    openUrl(`http://localhost:${consolePort()}`);
    return 0;
  }
  return start();
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error("启动器错误：" + (err?.message || err));
    process.exit(1);
  });
