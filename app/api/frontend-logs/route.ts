// 前端日志收集接口：接收前端发送的日志（单条或批量）并存入数据库。
// 不需要认证，页面加载前即可上报日志。
// 支持两种格式：
//   单条：{ level, message, meta, url, userAgent, createdAt }
//   批量：{ logs: [{ level, message, meta, url, userAgent, createdAt }, ...] }
import { env } from "cloudflare:workers";
import { createApp, success } from "../_app";
import { log } from "../_logger";

type RuntimeEnv = { DB: D1Database; LOG_LEVEL?: string };
const runtime = env as unknown as RuntimeEnv;

const app = createApp();

// 确保日志表存在
let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  await runtime.DB.prepare(
    "CREATE TABLE IF NOT EXISTS frontend_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,level TEXT NOT NULL,message TEXT NOT NULL,meta TEXT NOT NULL DEFAULT '{}',url TEXT NOT NULL DEFAULT '',user_agent TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)",
  ).run();
  schemaEnsured = true;
}

// ---------------------------------------------------------------------------
// 单条日志写入
// ---------------------------------------------------------------------------
async function insertLog(entry: {
  level?: string;
  message?: string;
  meta?: string;
  url?: string;
  userAgent?: string;
  createdAt?: string;
}) {
  const level = entry.level || "INFO";
  const message = (entry.message || "").slice(0, 500);
  const meta = (entry.meta || "{}").slice(0, 2000);
  const url = (entry.url || "").slice(0, 500);
  const userAgent = (entry.userAgent || "").slice(0, 200);
  const createdAt = entry.createdAt || new Date().toISOString();

  await runtime.DB.prepare(
    "INSERT INTO frontend_logs(level,message,meta,url,user_agent,created_at) VALUES(?,?,?,?,?,?)",
  ).bind(level, message, meta, url, userAgent, createdAt).run();
}

// POST /api/frontend-logs — 接收前端日志（单条或批量）
app.post("*", async (c) => {
  await ensureSchema();
  const body = await c.req.json<{
    level?: string;
    message?: string;
    meta?: string;
    url?: string;
    userAgent?: string;
    createdAt?: string;
    logs?: Array<{
      level?: string;
      message?: string;
      meta?: string;
      url?: string;
      userAgent?: string;
      createdAt?: string;
    }>;
  }>().catch(() => ({}));

  if (Array.isArray(body.logs)) {
    // 批量写入
    for (const entry of body.logs) {
      await insertLog(entry);
    }
    log.debug("前端日志批量入库", { count: body.logs.length });
  } else {
    // 单条写入
    await insertLog(body);
    if (body.level === "ERROR") {
      log.error("前端错误", { message: body.message, url: body.url });
    } else if (body.level === "WARN") {
      log.warn("前端警告", { message: body.message, url: body.url });
    }
  }

  return success({ ok: true });
});

export const POST = (request: Request) => app.fetch(request);