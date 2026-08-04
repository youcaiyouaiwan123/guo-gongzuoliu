// 登出：清除会话。
import { createApp } from "../../_app";
import { env } from "cloudflare:workers";
import { ensureAuthTables, getCookie } from "../../_auth";

export const runtime = "edge";

const runtimeEnv = env as unknown as { DB: D1Database };

const app = createApp();

// POST /api/auth/logout — 登出并清除会话 cookie
app.post("*", async (c) => {
  await ensureAuthTables(runtimeEnv.DB);
  const token = getCookie(c.req.raw, "haixin_session");
  if (token) await runtimeEnv.DB.prepare("DELETE FROM login_sessions WHERE token=?").bind(token).run();
  const secure = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https" || new URL(c.req.url).protocol === "https:";
  return c.json(
    { ok: true },
    200,
    { "Set-Cookie": `haixin_session=; Path=/;${secure ? " Secure;" : ""} HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT` },
  );
});

export const POST = (request: Request) => app.fetch(request);