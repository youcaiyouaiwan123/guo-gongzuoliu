// Hono 应用工厂：统一后端路由的认证、错误处理、响应格式。
// 每个 app/api/*/route.ts 使用 createApp() 创建 Hono 实例，
// 挂载所需中间件，最后通过 app.fetch(request) 桥接到 vinext 文件路由。
//
// 使用示例：
//   import { createApp, auth, admin, success } from "../_app";
//   const app = createApp();
//   app.use("*", auth());
//   app.get("/", async (c) => {
//     const { user } = c.var;
//     return success({ data: "ok" });
//   });
//   export const GET = (req: Request) => app.fetch(req);

import { Hono } from "hono";
import { env } from "cloudflare:workers";
import { authenticate, authorizeCapability, type AppUser } from "./_auth";
import { log, logRequest, logResponse, setLogDb, setLogLevel } from "./_logger";

// ---------------------------------------------------------------------------
// 环境变量类型
// ---------------------------------------------------------------------------
type RuntimeEnv = { DB: D1Database; LOG_LEVEL?: string };
const runtime = env as unknown as RuntimeEnv;

// 初始化日志数据库连接
setLogDb(runtime.DB);
// 从环境变量读取日志级别
if (runtime.LOG_LEVEL) {
  setLogLevel(runtime.LOG_LEVEL);
}

// ---------------------------------------------------------------------------
// Hono 上下文变量 — 中间件注入的请求级数据
// ---------------------------------------------------------------------------
export type Variables = {
  user: AppUser;
};

export type Bindings = RuntimeEnv;

// ---------------------------------------------------------------------------
// 创建 Hono 应用（已挂载全局错误处理 + 请求日志中间件）
// ---------------------------------------------------------------------------
export function createApp() {
  const app = new Hono<{ Variables: Variables; Bindings: Bindings }>();

  // 请求日志中间件 — 记录每个请求的方法、URL、耗时和状态
  app.use("*", async (c, next) => {
    const start = performance.now();
    const url = new URL(c.req.url);
    const method = c.req.method;
    const path = url.pathname + url.search;

    logRequest(method, path, {
      "content-type": c.req.header("content-type") || "",
      "user-agent": c.req.header("user-agent") || "",
    });

    try {
      await next();
    } catch (err) {
      const duration = performance.now() - start;
      log.error("路由处理异常", {
        method,
        path,
        durationMs: Math.round(duration),
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 4).join(" ") : "",
      });
      throw err;
    }

    const duration = performance.now() - start;
    const status = c.res.status;
    const error = status >= 400 ? `HTTP ${status}` : undefined;
    logResponse(method, path, status, duration, error);
  });

  // 全局错误处理 — 避免每个路由重复 try/catch
  app.onError((err, c) => {
    log.error("全局错误处理", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 4).join(" ") : "",
    });
    const message = err instanceof Error ? err.message : "服务器内部错误";
    return c.json({ error: message }, 500);
  });

  // 404 兜底
  app.notFound((c) => {
    return c.json({ error: "接口不存在" }, 404);
  });

  return app;
}

// ---------------------------------------------------------------------------
// 认证中间件工厂
// ---------------------------------------------------------------------------

/** 需要登录（普通用户） */
export function auth() {
  return async (c: any, next: any) => {
    const result = await authenticate(c.req.raw, runtime.DB, false);
    if ("response" in result) return result.response;
    c.set("user", result.user);
    await next();
  };
}

/** 需要管理员权限 */
export function admin() {
  return async (c: any, next: any) => {
    const result = await authenticate(c.req.raw, runtime.DB, true);
    if ("response" in result) return result.response;
    c.set("user", result.user);
    await next();
  };
}

// ---------------------------------------------------------------------------
// 统一响应辅助函数
// ---------------------------------------------------------------------------

/** 成功响应 */
export function success(data: Record<string, unknown>, status = 200) {
  return Response.json(data, { status });
}

/** 错误响应 */
export function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

// ---------------------------------------------------------------------------
// 重新导出常用工具，减少路由文件的 import 行数
// ---------------------------------------------------------------------------
export { authorizeCapability } from "./_auth";
export type { AppUser } from "./_auth";
export { ADMIN_ROLE, STAFF_ROLE } from "./_roles";
export { ensureColumn } from "./_schema";