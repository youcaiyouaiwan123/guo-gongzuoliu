import { env } from "cloudflare:workers";
import { ADMIN_ROLE } from "../_roles";
import { createApp, auth, success, fail } from "../_app";

export const runtime = "edge";

type Env = { DB: D1Database };
const runtimeEnv = env as unknown as Env;
const db = runtimeEnv.DB;

async function ensureTables() {
  await db.prepare("CREATE TABLE IF NOT EXISTS saved_artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,title TEXT NOT NULL,artifact_type TEXT NOT NULL,source_type TEXT NOT NULL,content TEXT NOT NULL,config TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS saved_artifacts_owner_idx ON saved_artifacts(owner_email)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL,result TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)").run();
}

async function readDeleteIds(request: Request) {
  const urlId = Number(new URL(request.url).searchParams.get("id"));
  const body = await request.json().catch(() => ({})) as { ids?: unknown[]; id?: unknown };
  const values = Array.isArray(body.ids) ? body.ids : [body.id, Number.isInteger(urlId) ? urlId : undefined];
  return Array.from(new Set(values.map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0)));
}

const app = createApp();
app.use("*", auth());

// GET /api/artifacts — 获取沉淀列表
app.get("*", async (c) => {
  const { user } = c.var;
  await ensureTables();
  const query = user.role === ADMIN_ROLE
    ? db.prepare("SELECT id,owner_email AS ownerEmail,title,artifact_type AS artifactType,source_type AS sourceType,content,config,created_at AS createdAt,updated_at AS updatedAt FROM saved_artifacts ORDER BY id DESC")
    : db.prepare("SELECT id,owner_email AS ownerEmail,title,artifact_type AS artifactType,source_type AS sourceType,content,config,created_at AS createdAt,updated_at AS updatedAt FROM saved_artifacts WHERE owner_email=? ORDER BY id DESC").bind(user.email);
  const result = await query.all();
  return success({ artifacts: result.results || [] });
});

// POST /api/artifacts — 创建沉淀
app.post("*", async (c) => {
  const { user } = c.var;
  await ensureTables();
  const body = await c.req.json<Record<string, unknown>>();
  const title = String(body.title || "").trim();
  const content = String(body.content || "").trim();
  const artifactType = String(body.artifactType || "");
  const sourceType = String(body.sourceType || "");
  const config = typeof body.config === "string" ? body.config : JSON.stringify(body.config || {});
  if (!title || !content) return fail("请填写沉淀名称和内容。", 400);
  if (!["markdown", "skill"].includes(artifactType) || !["chat", "loop", "upload"].includes(sourceType)) {
    return fail("沉淀类型不正确。", 400);
  }

  const now = new Date().toISOString();
  const saved = await db.prepare("INSERT INTO saved_artifacts(owner_email,title,artifact_type,source_type,content,config,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) RETURNING id")
    .bind(user.email, title, artifactType, sourceType, content, config, now, now).first<{ id: number }>();
  const action = sourceType === "upload" ? "上传沉淀文件" : sourceType === "loop" ? "沉淀 Loop" : "沉淀聊天";
  await db.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(user.email, action, title, "成功", artifactType === "skill" ? "保存为可复用 Skill" : "保存为 Markdown", now).run();
  return success({ id: saved?.id, message: "沉淀已保存。" });
});

// DELETE /api/artifacts — 删除沉淀
app.delete("*", async (c) => {
  const { user } = c.var;
  await ensureTables();
  const ids = await readDeleteIds(c.req.raw);
  if (!ids.length) return fail("请选择要删除的沉淀。", 400);

  const items: Array<{ id: number; ownerEmail: string; title: string }> = [];
  for (const id of ids) {
    const item = await db.prepare("SELECT id,owner_email AS ownerEmail,title FROM saved_artifacts WHERE id=?").bind(id).first<{ id: number; ownerEmail: string; title: string }>();
    if (!item) continue;
    if (user.role !== ADMIN_ROLE && item.ownerEmail !== user.email) {
      return fail("只能删除自己的沉淀。", 403);
    }
    items.push(item);
  }
  if (!items.length) return fail("没有找到可删除的沉淀。", 404);

  for (const item of items) {
    await db.prepare("DELETE FROM saved_artifacts WHERE id=?").bind(item.id).run();
  }
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(user.email, items.length > 1 ? "批量删除沉淀" : "删除沉淀", items.map(item => item.title).join(","), "成功", `删除数量：${items.length}`, now).run();
  return success({ message: `已删除 ${items.length} 条沉淀。`, deleted: items.length });
});

export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);
export const DELETE = (request: Request) => app.fetch(request);