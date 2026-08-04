// 会话：获取当前登录用户信息。
import { env } from "cloudflare:workers";
import { createApp, auth, success } from "../_app";
import { log } from "../_logger";

const runtime = env as unknown as { DB: D1Database };

const app = createApp();
app.use("*", auth());

app.get("*", async (c) => {
  const { user } = c.var;
  log.info("会话查询", { email: user.email, role: user.role });
  return success(user);
});

export const GET = (request: Request) => app.fetch(request);