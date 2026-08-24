// 跨平台路径解析：区分「程序目录」（升级时整体覆盖）与「数据目录」（永不覆盖）。
// 程序目录 = 本文件所在 packaging/ 的上一级；开发态即仓库根 /root/guo-gongzuoliu。
// 数据目录 = 用户级目录（桌面版免管理员）；可被环境变量 HAIXIN_DATA_DIR 覆盖（构建冒烟/开发用）。
//
// 桌面版（联网首启下载运行环境）拓扑：
//   程序目录（安装器铺开，仅应用码）：dist / drizzle / services / packaging / version.txt
//   数据目录（用户级，首启生成/下载）：config.env / state / logs / tmp
//                                     + runtime/（下载的 Node）+ node_modules/（下载的 wrangler 闭包）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 本文件位于 <程序目录>/packaging/lib/paths.mjs，故上溯两级得到程序目录（开发态即仓库根）。
export const PROGRAM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function defaultDataDir() {
  if (process.env.HAIXIN_DATA_DIR) return path.resolve(process.env.HAIXIN_DATA_DIR);
  switch (process.platform) {
    case "win32":
      // 用户级目录：免管理员即可写。旧版曾用 %ProgramData%（需管理员+装服务），已弃用。
      return path.join(
        process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "C:\\Users\\Default", "AppData", "Local"),
        "HaixinAI",
      );
    case "darwin":
      return path.join(process.env.HOME || "", "Library", "Application Support", "HaixinAI");
    default:
      // Linux（开发/联调）：默认落在仓库内，避免污染系统目录，可用 HAIXIN_DATA_DIR 覆盖。
      return path.join(PROGRAM_DIR, ".haixin-data");
  }
}

export const DATA_DIR = defaultDataDir();
export const STATE_DIR = path.join(DATA_DIR, "state"); // = wrangler --persist-to，miniflare v3 树落这里
export const LOGS_DIR = path.join(DATA_DIR, "logs");
export const TMP_DIR = path.join(DATA_DIR, "tmp"); // 固定 workerd 的临时目录到可写位置
export const CONFIG_FILE = path.join(DATA_DIR, "config.env");
export const CREDENTIALS_FILE = path.join(DATA_DIR, "FIRST-RUN-CREDENTIALS.txt");
export const PIDFILE = path.join(DATA_DIR, "haixin.pid"); // 桌面版：记录守护 pid，供"退出"停止

// 运行时闭包（Node + wrangler/workerd）所在根：
//   桌面版 = 数据目录（首启下载解压到此）；开发/冒烟 = 程序目录（组装树里自带 node_modules）。
//   可用 HAIXIN_RUNTIME_DIR 显式指定。
const RUNTIME_ROOT =
  (process.env.HAIXIN_RUNTIME_DIR && path.resolve(process.env.HAIXIN_RUNTIME_DIR)) ||
  (fs.existsSync(path.join(DATA_DIR, "node_modules", "wrangler")) ? DATA_DIR : PROGRAM_DIR);

export const RUNTIME_DIR = path.join(RUNTIME_ROOT, "runtime"); // 下载的独立 Node
export const NODE_BIN =
  process.platform === "win32"
    ? path.join(RUNTIME_DIR, "node.exe")
    : path.join(RUNTIME_DIR, "bin", "node");

// 各服务/构建产物位置：wrangler 闭包在 RUNTIME_ROOT，应用码在 PROGRAM_DIR。
export const WRANGLER_BIN = path.join(RUNTIME_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
export const WRANGLER_CONFIG = path.join(PROGRAM_DIR, "dist", "server", "wrangler.json");
export const DRIZZLE_DIR = path.join(PROGRAM_DIR, "drizzle");
export const MODEL_RELAY_ENTRY = path.join(PROGRAM_DIR, "services", "model-relay", "server.mjs");
export const GATEWAY_ENTRY = path.join(PROGRAM_DIR, "services", "channel-gateway", "index.mjs");
export const PROXY_ENTRY = path.join(PROGRAM_DIR, "packaging", "proxy.mjs");
export const MIGRATE_ENTRY = path.join(PROGRAM_DIR, "packaging", "migrate.mjs");
export const SUPERVISOR_ENTRY = path.join(PROGRAM_DIR, "packaging", "supervisor.mjs");

// 是否已具备运行时（Node + wrangler 闭包）——桌面版据此决定要不要先下载。
export function runtimeReady() {
  return fs.existsSync(NODE_BIN) && fs.existsSync(WRANGLER_BIN);
}

export const D1_DATABASE_NAME = "site-creator-d1"; // 与 dist/server/wrangler.json 的 database_name 一致
