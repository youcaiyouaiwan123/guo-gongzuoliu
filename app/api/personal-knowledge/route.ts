import { env } from "cloudflare:workers";
import { createApp, auth, success, fail, ADMIN_ROLE } from "../_app";
import { extractTextFromFile } from "../_fileText";
import { ensureColumn } from "../_schema";
import { askModel } from "../modules/_shared";
import { KNOWLEDGE_POLISH_INSTRUCTION, markPolished } from "../_knowledgeText";

type RuntimeEnv = { DB: D1Database };
const runtime = env as unknown as RuntimeEnv;

const fields = "id,title,content,source_type AS sourceType,conversation_id AS conversationId,sync_status AS syncStatus,enterprise_document_id AS enterpriseDocumentId,created_at AS createdAt,updated_at AS updatedAt";

async function ensureSchema() {
  await runtime.DB.batch([
    runtime.DB.prepare(`CREATE TABLE IF NOT EXISTS personal_knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_email TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT '手动创建',
      conversation_id INTEGER,
      sync_status TEXT NOT NULL DEFAULT '仅个人',
      enterprise_document_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    runtime.DB.prepare("CREATE INDEX IF NOT EXISTS personal_knowledge_owner_idx ON personal_knowledge(owner_email,updated_at)"),
    runtime.DB.prepare(`CREATE TABLE IF NOT EXISTS knowledge_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT '全员',
      department_id INTEGER,
      filename TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT 'text/plain',
      file_key TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '未分类',
      tags TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      update_mode TEXT NOT NULL DEFAULT '手动更新',
      update_schedule TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '已解析',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ''
    )`),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS org_members (email TEXT PRIMARY KEY,unit_id INTEGER NOT NULL,job_title TEXT NOT NULL DEFAULT '员工',direct_manager_email TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '在岗',updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL,result TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)"),
  ]);
  await ensureColumn(runtime.DB, "knowledge_documents", "department_id", "INTEGER");
}

function safeKnowledgeFilename(title: string, extension: string) {
  const base = (title || "personal_knowledge").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 80) || "personal_knowledge";
  return `${base}.${extension}`;
}

function inferKnowledgeFileMeta(title: string, sourceType: string, content: string) {
  if (/JSON|json/.test(sourceType)) return { filename: safeKnowledgeFilename(title, "json"), mimeType: "application/json;charset=utf-8" };
  if (/原文|原始|txt|文本/.test(sourceType) && !content.trim().startsWith("#")) return { filename: safeKnowledgeFilename(title, "txt"), mimeType: "text/plain;charset=utf-8" };
  return { filename: safeKnowledgeFilename(title, "md"), mimeType: "text/markdown;charset=utf-8" };
}

async function readDeleteIds(request: Request) {
  const url = new URL(request.url);
  const urlIds = (url.searchParams.get("ids") || "").split(",").map(Number).filter(id => Number.isInteger(id) && id > 0);
  const urlId = Number(url.searchParams.get("id"));
  const body = await request.json().catch(() => ({})) as { ids?: unknown[]; id?: unknown };
  const bodyIds = Array.isArray(body.ids) ? body.ids.map(Number) : [Number(body.id)];
  return Array.from(new Set([...urlIds, urlId, ...bodyIds].filter(id => Number.isInteger(id) && id > 0))).slice(0, 500);
}

async function getMembership(email: string) {
  // org_members 以 email 为主键，没有自增 id 列；ORDER BY id 会报 no such column: id。
  return runtime.DB.prepare("SELECT unit_id AS unitId FROM org_members WHERE email=? AND status <> '离职' AND status <> '绂昏亴' ORDER BY updated_at DESC LIMIT 1")
    .bind(email)
    .first<{ unitId: number }>();
}

const app = createApp();
app.use("*", auth());

// GET /api/personal-knowledge — 获取个人知识列表
app.get("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const rows = await runtime.DB.prepare(`SELECT ${fields} FROM personal_knowledge WHERE owner_email=? ORDER BY updated_at DESC,id DESC`)
    .bind(user.email)
    .all();
  return success({ items: rows.results || [] });
});

// POST /api/personal-knowledge — 创建个人知识（表单或 JSON）
app.post("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();

  const now = new Date().toISOString();
  const contentType = c.req.header("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const files = form.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
    if (!files.length) return fail("请选择要上传的文件。", 400);
    if (files.some(file => file.size > 30 * 1024 * 1024)) return fail("单个文件不能超过 30MB。", 400);
    const titleOverride = String(form.get("title") || "").trim();
    const sourceType = String(form.get("sourceType") || "文件上传");
    const saved = [];

    for (const file of files) {
      const extracted = await extractTextFromFile(file);
      const title = titleOverride && files.length === 1 ? titleOverride : file.name.replace(/\.[^.]+$/, "") || file.name;
      const content = extracted.content || `文件：${file.name}\n状态：${extracted.note}`;
      const row = await runtime.DB.prepare(`INSERT INTO personal_knowledge(owner_email,title,content,source_type,conversation_id,sync_status,created_at,updated_at) VALUES(?,?,?,?,?,'仅个人',?,?) RETURNING ${fields}`)
        .bind(user.email, title, content.slice(0, 500_000), `${sourceType} · ${extracted.note}`, null, now, now)
        .first();
      saved.push(row);
      await runtime.DB.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
        .bind(user.email, "上传个人知识文件", file.name, "成功", extracted.note, now)
        .run();
    }

    return success({ item: saved[0], items: saved, message: `已保存 ${saved.length} 条个人知识。` }, 201);
  }

  const body = await c.req.json() as { title?: string; content?: string; sourceType?: string; conversationId?: number; polish?: boolean };
  const title = body.title?.trim();
  const content = body.content?.trim();
  if (!title || !content) return fail("知识名称和内容不能为空。", 400);

  // 可选的 AI 整理。整理失败不该让保存整体失败——用户的原文是真数据，
  // 模型没配好只是附加能力缺失，所以退回保存原文并在来源标注里写明。
  let stored = content;
  let polishState: "done" | "failed" | "off" = "off";
  if (body.polish) {
    try {
      const polished = (await askModel(user.email, KNOWLEDGE_POLISH_INSTRUCTION, content.slice(0, 16000))).trim();
      if (polished) { stored = polished; polishState = "done"; } else { polishState = "failed"; }
    } catch {
      polishState = "failed";
    }
  }
  const sourceType = markPolished(body.sourceType || "手动创建", polishState);

  const row = await runtime.DB.prepare(`INSERT INTO personal_knowledge(owner_email,title,content,source_type,conversation_id,sync_status,created_at,updated_at) VALUES(?,?,?,?,?,'仅个人',?,?) RETURNING ${fields}`)
    .bind(user.email, title, stored.slice(0, 500_000), sourceType, body.conversationId || null, now, now)
    .first();
  await runtime.DB.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(user.email, "保存个人知识", title, "成功", sourceType, now)
    .run();
  return success({
    item: row,
    polished: polishState === "done",
    message: polishState === "done"
      ? "已用 AI 整理后保存到个人知识库。"
      : polishState === "failed"
        ? "AI 整理未成功，已按原文保存到个人知识库。"
        : "已保存到个人知识库。",
  }, 201);
});

// PATCH /api/personal-knowledge — 同步个人知识到企业知识
app.patch("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const body = await c.req.json() as { id?: number; visibility?: string; category?: string; tags?: string };
  const item = await runtime.DB.prepare("SELECT id,title,content,source_type AS sourceType,sync_status AS syncStatus FROM personal_knowledge WHERE id=? AND owner_email=?")
    .bind(Number(body.id), user.email)
    .first<{ id: number; title: string; content: string; sourceType: string; syncStatus: string }>();
  if (!item) return fail("个人知识不存在或无权操作。", 404);

  const membership = await getMembership(user.email);
  const visibility = user.role === ADMIN_ROLE ? (body.visibility || "全员") : "部门";
  if (visibility === "部门" && !membership?.unitId) return fail("请先加入部门，才能同步到企业知识。", 400);

  const now = new Date().toISOString();
  const fileMeta = inferKnowledgeFileMeta(item.title, item.sourceType, item.content);
  const created = await runtime.DB.prepare(`INSERT INTO knowledge_documents(title,content,visibility,department_id,filename,mime_type,file_key,category,tags,version,update_mode,update_schedule,status,size_bytes,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
    .bind(item.title, item.content, visibility, visibility === "部门" ? membership?.unitId : null, fileMeta.filename, fileMeta.mimeType, "", body.category || "个人知识同步", body.tags || "个人知识", 1, "手动更新", "", "已解析", new TextEncoder().encode(item.content).byteLength, user.email, now, now)
    .first<{ id: number }>();
  await runtime.DB.prepare("UPDATE personal_knowledge SET sync_status='已同步企业知识',enterprise_document_id=?,updated_at=? WHERE id=?")
    .bind(created?.id || null, now, item.id)
    .run();
  await runtime.DB.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(user.email, "同步个人知识", item.title, "成功", `同步到企业知识 · ${visibility}`, now)
    .run();
  return success({ message: "已同步到企业知识库。", enterpriseDocumentId: created?.id });
});

// DELETE /api/personal-knowledge — 删除个人知识
app.delete("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const ids = await readDeleteIds(c.req.raw);
  if (!ids.length) return fail("请选择要删除的个人知识。", 400);

  const deletedTitles: string[] = [];
  for (const id of ids) {
    const item = await runtime.DB.prepare("SELECT title FROM personal_knowledge WHERE id=? AND owner_email=?")
      .bind(id, user.email)
      .first<{ title: string }>();
    if (!item) continue;
    await runtime.DB.prepare("DELETE FROM personal_knowledge WHERE id=? AND owner_email=?").bind(id, user.email).run();
    deletedTitles.push(item.title);
  }

  if (!deletedTitles.length) return fail("个人知识不存在或无权删除。", 404);
  await runtime.DB.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(user.email, "批量删除个人知识", deletedTitles.join("、"), "成功", "仅删除个人副本，不影响已同步的企业资料。", new Date().toISOString())
    .run();
  return success({ message: `已删除 ${deletedTitles.length} 条个人知识。`, deleted: deletedTitles.length });
});

export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);
export const PATCH = (request: Request) => app.fetch(request);
export const DELETE = (request: Request) => app.fetch(request);