// 配置与密钥管理：加载 DATA/config.env，首次运行生成必备密钥，
// 并按服务拼装环境变量（等价于 docker-compose.server.yml 的 env 接线，服务名改 127.0.0.1）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, CREDENTIALS_FILE, DATA_DIR } from "./paths.mjs";
import { readEnvFile, serializeEnv } from "./dotenv.mjs";

// 应用层必填项（缺失则拒绝启动，等同 selfhost-entrypoint.sh 的前置校验）。
export const REQUIRED_KEYS = [
  "PLATFORM_CREDENTIALS_KEY",
  "HAIXIN_GATEWAY_ADMIN_SECRET",
  "DEFAULT_ADMIN_USERNAME",
  "DEFAULT_ADMIN_PASSWORD",
];

const DEFAULTS = {
  MODEL_BASE_URL: "https://claudecc.top",
  MODEL_NAME: "gpt-5.5",
  MAIL_PORT: "465",
  HAIXIN_ACCOUNTS_JSON: "[]",
  HTTP_PORT: "8799", // 桌面版控制台端口（高位、免管理员、避与 IIS/80 冲突）；被占时改这里即可（proxy 读 PROXY_PORT，由守护接线）
};

// 首次运行：若 config.env 不存在，生成随机密钥 + 默认管理员，写入数据目录。
// 已存在则原样返回（升级绝不覆盖用户凭据/密钥）。
export function ensureConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_FILE)) return readEnvFile(CONFIG_FILE);

  const adminPassword =
    process.env.HAIXIN_INSTALL_ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");
  const adminUser = process.env.HAIXIN_INSTALL_ADMIN_USER || "admin";
  const config = {
    PLATFORM_CREDENTIALS_KEY: crypto.randomBytes(32).toString("hex"),
    HAIXIN_GATEWAY_ADMIN_SECRET: crypto.randomBytes(32).toString("hex"),
    DEFAULT_ADMIN_USERNAME: adminUser,
    DEFAULT_ADMIN_PASSWORD: adminPassword,
    MODEL_API_KEY: "",
    MODEL_BASE_URL: DEFAULTS.MODEL_BASE_URL,
    MODEL_NAME: DEFAULTS.MODEL_NAME,
    MAIL_HOST: "",
    MAIL_PORT: DEFAULTS.MAIL_PORT,
    MAIL_USER: "",
    MAIL_PASS: "",
    MAIL_FROM: "",
    HAIXIN_ACCOUNTS_JSON: DEFAULTS.HAIXIN_ACCOUNTS_JSON,
    HTTP_PORT: DEFAULTS.HTTP_PORT,
  };
  fs.writeFileSync(CONFIG_FILE, serializeEnv(config), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600); // Windows 上 mode 近似忽略，安装器另用 ACL 收紧
  } catch {}

  // 仅当管理员密码是自动生成时，落一份首启凭据文件方便管理员首次登录。
  if (!process.env.HAIXIN_INSTALL_ADMIN_PASSWORD) {
    fs.writeFileSync(
      CREDENTIALS_FILE,
      `海芯 AI 平台 首次安装凭据\n管理员账号: ${adminUser}\n管理员密码: ${adminPassword}\n\n登录后请立即修改密码。本文件可安全删除。\n`,
      { mode: 0o600 },
    );
  }
  return config;
}

export function loadConfig() {
  return { ...DEFAULTS, ...readEnvFile(CONFIG_FILE) };
}

export function assertRequired(config) {
  const missing = REQUIRED_KEYS.filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(`启动失败：config.env 缺少必填项 ${missing.join("、")}（位于 ${CONFIG_FILE}）。`);
  }
}

// 内部服务一律走本机回环；只有反代对外监听。
const RELAY_URL = "http://127.0.0.1:8789/v1/chat/completions";
const COLLECTOR_URL = "http://127.0.0.1:8789/collector/fetch";
const ACCOUNTS_URL = "http://127.0.0.1:3000/api/gateway/accounts";

// 传给 wrangler dev 的 --var 覆盖（对应 selfhost-entrypoint.sh 末尾那串 --var）。
export function appVars(config) {
  return {
    PLATFORM_CREDENTIALS_KEY: config.PLATFORM_CREDENTIALS_KEY,
    HAIXIN_GATEWAY_ADMIN_SECRET: config.HAIXIN_GATEWAY_ADMIN_SECRET,
    DEFAULT_ADMIN_USERNAME: config.DEFAULT_ADMIN_USERNAME,
    DEFAULT_ADMIN_PASSWORD: config.DEFAULT_ADMIN_PASSWORD,
    MODEL_API_KEY: config.MODEL_API_KEY || "",
    MODEL_BASE_URL: config.MODEL_BASE_URL || DEFAULTS.MODEL_BASE_URL,
    MODEL_NAME: config.MODEL_NAME || DEFAULTS.MODEL_NAME,
    MODEL_RELAY_URL: RELAY_URL,
    COLLECTOR_PROXY_URL: COLLECTOR_URL,
    MAIL_HOST: config.MAIL_HOST || "",
    MAIL_SENDER: config.MAIL_USER || "",
  };
}

// channel-gateway 进程的环境变量（对应 compose 的 channel-gateway 段）。
export function gatewayEnv(config) {
  return {
    HAIXIN_ACCOUNTS_JSON: config.HAIXIN_ACCOUNTS_JSON || DEFAULTS.HAIXIN_ACCOUNTS_JSON,
    HAIXIN_GATEWAY_ACCOUNTS_URL: ACCOUNTS_URL,
    HAIXIN_GATEWAY_ADMIN_SECRET: config.HAIXIN_GATEWAY_ADMIN_SECRET,
    PORT: "8788",
    MAIL_HOST: config.MAIL_HOST || "",
    MAIL_PORT: config.MAIL_PORT || DEFAULTS.MAIL_PORT,
    MAIL_USER: config.MAIL_USER || "",
    MAIL_PASS: config.MAIL_PASS || "",
    MAIL_FROM: config.MAIL_FROM || "",
  };
}
