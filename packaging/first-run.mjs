// 安装期首启密钥生成（OS 中立）：调用与守护完全一致的 ensureConfig()，在系统级数据目录
// 生成 config.env（随机 PLATFORM_CREDENTIALS_KEY / HAIXIN_GATEWAY_ADMIN_SECRET + 默认管理员）。
// 幂等：config.env 已存在则原样返回，升级/重装绝不覆盖既有密钥与数据。
// 由各 OS 安装器在拷完程序文件后、启动服务前用打包内 node 执行一次，
// 使 FIRST-RUN-CREDENTIALS.txt 立即可见（无需等服务完成首轮启动）。
import fs from "node:fs";
import { ensureConfig } from "./lib/config.mjs";
import { CONFIG_FILE, CREDENTIALS_FILE, DATA_DIR } from "./lib/paths.mjs";

const existed = fs.existsSync(CONFIG_FILE);
ensureConfig();

if (existed) {
  console.log(`[first-run] 已存在 ${CONFIG_FILE}，保留原有密钥与管理员凭据（未改动）。`);
} else {
  console.log(`[first-run] 已在 ${DATA_DIR} 生成首启配置。`);
  if (fs.existsSync(CREDENTIALS_FILE)) {
    console.log(`[first-run] 首次登录凭据见：${CREDENTIALS_FILE}`);
  }
}
