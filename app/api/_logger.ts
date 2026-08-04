// 集中式日志框架：统一所有后端接口的日志输出格式和级别。
// 日志输出到终端控制台，同时异步写入数据库 system_logs 表，方便后续检索。
// 用法：
//   import { log } from "../_logger";
//   log.info("用户登录", { email });
//   log.error("数据库查询失败", { table, error: err.message });

// ---------------------------------------------------------------------------
// 日志级别
// ---------------------------------------------------------------------------
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

// 数据库实例（通过 setLogDb 初始化）
let logDb: D1Database | null = null;
let logLevel: LogLevel = "INFO";

/** 设置数据库实例，在应用启动时调用 */
export function setLogDb(db: D1Database) {
  logDb = db;
  // 确保日志表存在（只执行一次）
  db.prepare(
    "CREATE TABLE IF NOT EXISTS system_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,level TEXT NOT NULL,message TEXT NOT NULL,meta TEXT NOT NULL DEFAULT '{}',url TEXT NOT NULL DEFAULT '',method TEXT NOT NULL DEFAULT '',status INTEGER NOT NULL DEFAULT 0,duration_ms INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL)",
  ).run().catch(() => {});
}

/** 设置日志级别（从环境变量读取后调用） */
export function setLogLevel(level: string) {
  if (level in LOG_LEVELS) {
    logLevel = level as LogLevel;
  }
}

function currentLevel(): number {
  return LOG_LEVELS[logLevel] ?? LOG_LEVELS.INFO;
}

// ---------------------------------------------------------------------------
// 时间戳格式化
// ---------------------------------------------------------------------------
function timestamp(): string {
  const d = new Date();
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// 日志输出
// ---------------------------------------------------------------------------
function write(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (LOG_LEVELS[level] < currentLevel()) return;

  const line: Record<string, unknown> = {
    time: timestamp(),
    level,
    msg: message,
  };

  if (meta && Object.keys(meta).length > 0) {
    // 将 meta 拍平到行中，避免嵌套对象导致阅读困难
    for (const [key, value] of Object.entries(meta)) {
      line[key] = value;
    }
  }

  // 输出到终端
  const output = JSON.stringify(line);
  if (level === "ERROR") {
    console.error(output);
  } else if (level === "WARN") {
    console.warn(output);
  } else {
    console.log(output);
  }

  // 异步写入数据库（不阻塞主流程）
  if (logDb) {
    const metaJson = meta ? JSON.stringify(meta).slice(0, 2000) : "{}";
    const url = String(meta?.url || "");
    const method = String(meta?.method || "");
    const status = Number(meta?.status || 0);
    const durationMs = Number(meta?.durationMs || 0);
    logDb.prepare(
      "INSERT INTO system_logs(level,message,meta,url,method,status,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(level, message.slice(0, 500), metaJson, url.slice(0, 500), method.slice(0, 10), status, durationMs, timestamp())
      .run().catch(() => {
        // 静默失败，避免日志写入失败影响业务
      });
  }
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------
export const log = {
  debug: (message: string, meta?: Record<string, unknown>) => write("DEBUG", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("INFO", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("WARN", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("ERROR", message, meta),
};

// ---------------------------------------------------------------------------
// 数据库查询日志辅助
// ---------------------------------------------------------------------------
export function logQuery(sql: string, params: unknown[] = [], durationMs: number, error?: string) {
  const meta: Record<string, unknown> = {
    sql: sql.replace(/\s+/g, " ").trim(),
    durationMs: Math.round(durationMs),
  };
  if (params.length > 0) meta.params = params;
  if (error) {
    log.error("数据库查询失败", { ...meta, error });
  } else {
    log.debug("数据库查询", meta);
  }
}

// ---------------------------------------------------------------------------
// 请求日志辅助
// ---------------------------------------------------------------------------
export function logRequest(method: string, url: string, headers: Record<string, string>) {
  log.info("请求开始", {
    method,
    url,
    contentType: headers["content-type"] || "",
    userAgent: (headers["user-agent"] || "").slice(0, 80),
  });
}

export function logResponse(method: string, url: string, status: number, durationMs: number, error?: string) {
  const meta: Record<string, unknown> = {
    method,
    url,
    status,
    durationMs: Math.round(durationMs),
  };
  if (error) {
    log.error("请求失败", { ...meta, error });
  } else {
    log.info("请求完成", meta);
  }
}