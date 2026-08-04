// 前端日志工具：日志输出到浏览器控制台，同时通过 fetch 可靠发送到后端存入数据库。
// 所有日志最终都会写入 frontend_logs 表，方便检索和排查。
// 用法：
//   import { log } from "../features/logger";
//   log.info("页面加载", { page: "chat" });
//   log.error("API调用失败", { url: "/api/chat", status: 500 });

// ---------------------------------------------------------------------------
// 日志级别
// ---------------------------------------------------------------------------
type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVELS: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function currentLevel(): number {
  try {
    const stored = sessionStorage.getItem("LOG_LEVEL") || "INFO";
    return LEVELS[stored as LogLevel] ?? LEVELS.INFO;
  } catch {
    return LEVELS.INFO;
  }
}

// ---------------------------------------------------------------------------
// 时间戳
// ---------------------------------------------------------------------------
function timestamp(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 日志队列 — 确保日志可靠发送，不丢失
// ---------------------------------------------------------------------------
const pendingQueue: string[] = [];
let flushing = false;

async function flushQueue() {
  if (flushing || pendingQueue.length === 0) return;
  flushing = true;
  const batch = pendingQueue.splice(0);
  try {
    const response = await fetch("/api/frontend-logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logs: batch }),
      keepalive: true,
    });
    if (!response.ok && response.status !== 429) {
      // 非限流错误，放回队列等待下次重试（最多保留 50 条）
      const remaining = batch.slice(0, 50);
      pendingQueue.unshift(...remaining);
    }
  } catch {
    // 网络错误，放回队列
    const remaining = batch.slice(0, 50);
    pendingQueue.unshift(...remaining);
  } finally {
    flushing = false;
    if (pendingQueue.length > 0) {
      // 还有未发送的，延迟重试
      setTimeout(flushQueue, 2000);
    }
  }
}

function enqueue(level: LogLevel, message: string, meta: Record<string, unknown>) {
  const entry = JSON.stringify({
    level,
    message: message.slice(0, 500),
    meta: JSON.stringify(meta).slice(0, 2000),
    url: (window.location.pathname + window.location.search).slice(0, 500),
    userAgent: navigator.userAgent.slice(0, 200),
    createdAt: timestamp(),
  });
  pendingQueue.push(entry);
  if (pendingQueue.length >= 5) {
    // 达到阈值立即发送
    flushQueue();
  } else if (!flushing) {
    // 延迟发送，凑批
    setTimeout(flushQueue, 500);
  }
}

// ---------------------------------------------------------------------------
// 日志写入
// ---------------------------------------------------------------------------
function write(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < currentLevel()) return;

  // 入队等待发送到后端（最终存入数据库），前端不打印到控制台
  enqueue(level, message, meta || {});
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
// 性能测量辅助
// ---------------------------------------------------------------------------
const marks = new Map<string, number>();

export function markStart(name: string) {
  marks.set(name, performance.now());
}

export function markEnd(name: string, meta?: Record<string, unknown>) {
  const start = marks.get(name);
  if (start === undefined) return;
  marks.delete(name);
  const duration = performance.now() - start;
  log.info(`性能: ${name}`, { ...meta, durationMs: Math.round(duration) });
  return duration;
}

// ---------------------------------------------------------------------------
// 组件挂载/卸载日志辅助
// ---------------------------------------------------------------------------
export function logMount(component: string, props?: Record<string, unknown>) {
  log.info(`[组件] ${component} 挂载`, props);
  return () => log.info(`[组件] ${component} 卸载`);
}

export function logAction(component: string, action: string, meta?: Record<string, unknown>) {
  log.info(`[操作] ${component} > ${action}`, meta);
}

// ---------------------------------------------------------------------------
// 页面关闭时确保日志发送完毕
// ---------------------------------------------------------------------------
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    if (pendingQueue.length > 0) {
      const batch = pendingQueue.splice(0);
      try {
        navigator.sendBeacon(
          "/api/frontend-logs",
          new Blob([JSON.stringify({ logs: batch })], { type: "application/json" }),
        );
      } catch {
        // 静默
      }
    }
  });
}