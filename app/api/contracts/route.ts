import { env } from "cloudflare:workers";
import { createApp, auth, success, fail, ADMIN_ROLE, STAFF_ROLE, authorizeCapability } from "../_app";
import { ensureColumn } from "../_schema";

export const runtime = "edge";

type RuntimeEnv = { DB: D1Database };
const runtimeEnv = env as unknown as RuntimeEnv;

function detectVariables(content: string) {
  const braceVariables = Array.from(content.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)).map(match => match[1].trim());
  const bracketVariables = Array.from(content.matchAll(/【\s*([^【】]+?)\s*】/g)).map(match => match[1].trim());
  return Array.from(new Set([...braceVariables, ...bracketVariables].filter(Boolean)));
}

function fillTemplate(content: string, values: Record<string, unknown>) {
  let filled = content;
  for (const key of detectVariables(content)) {
    const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const value = String(values[key] ?? "").trim();
    filled = filled
      .replace(new RegExp(`\\{\\{\\s*${safeKey}\\s*\\}\\}`, "g"), value)
      .replace(new RegExp(`【\\s*${safeKey}\\s*】`, "g"), value);
  }
  return filled;
}

async function ensureTables(db: D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS contract_templates (id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',content TEXT NOT NULL,variables TEXT NOT NULL,sections TEXT NOT NULL DEFAULT '[]',created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS contract_documents (id INTEGER PRIMARY KEY AUTOINCREMENT,template_id INTEGER NOT NULL,template_title TEXT NOT NULL DEFAULT '',title TEXT NOT NULL,filled_values TEXT NOT NULL,content TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL,result TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS role_permissions (role TEXT NOT NULL,capability TEXT NOT NULL,decision TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(role,capability))").run();
  await ensureColumn(db, "contract_templates", "sections", "TEXT NOT NULL DEFAULT '[]'");
  await ensureColumn(db, "contract_documents", "template_title", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn(db, "contract_documents", "filled_values", "TEXT NOT NULL DEFAULT '{}'");
}

async function ensureContractPermissions(db: D1Database) {
  const now = new Date().toISOString();
  const rows: Array<[string, string, string]> = [
    [ADMIN_ROLE, "view_contracts", "允许"],
    [ADMIN_ROLE, "generate_contracts", "允许"],
    [ADMIN_ROLE, "manage_contract_templates", "允许"],
    [STAFF_ROLE, "view_contracts", "允许"],
    [STAFF_ROLE, "generate_contracts", "允许"],
    [STAFF_ROLE, "manage_contract_templates", "拒绝"],
  ];
  for (const [role, capability, decision] of rows) {
    await db.prepare("INSERT OR IGNORE INTO role_permissions(role,capability,decision,updated_at) VALUES(?,?,?,?)")
      .bind(role, capability, decision, now).run();
  }
  await db.prepare("UPDATE role_permissions SET decision='允许',updated_at=? WHERE role=? AND capability IN ('view_contracts','generate_contracts','manage_contract_templates')")
    .bind(now, ADMIN_ROLE).run();
}

async function readDeleteIds(request: Request) {
  const urlId = Number(new URL(request.url).searchParams.get("id"));
  const body = await request.json().catch(() => ({})) as { ids?: unknown[]; id?: unknown };
  const values = Array.isArray(body.ids) ? body.ids : [body.id, Number.isInteger(urlId) ? urlId : undefined];
  return Array.from(new Set(values.map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0)));
}

async function audit(db: D1Database, actor: string, action: string, resource: string, result: string, detail = "") {
  await db.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(actor, action, resource, result, detail, new Date().toISOString()).run();
}

const app = createApp();
app.use("*", auth());

// GET /api/contracts — 获取合同模板和文档列表
app.get("*", async (c) => {
  const { user } = c.var;
  const db = runtimeEnv.DB;
  await ensureTables(db);
  await ensureContractPermissions(db);
  const permission = await authorizeCapability(db, user, "view_contracts");
  if (permission) return permission;

  const templates = await db.prepare("SELECT id,title,description,content,variables,sections,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt FROM contract_templates ORDER BY id DESC").all();
  const docs = user.role === ADMIN_ROLE
    ? await db.prepare("SELECT d.id,d.template_id AS templateId,COALESCE(t.title,d.template_title) AS templateTitle,d.title,d.created_by AS createdBy,d.created_at AS createdAt,('/api/contracts/pdf?id=' || d.id) AS downloadUrl FROM contract_documents d LEFT JOIN contract_templates t ON t.id=d.template_id ORDER BY d.id DESC LIMIT 100").all()
    : await db.prepare("SELECT d.id,d.template_id AS templateId,COALESCE(t.title,d.template_title) AS templateTitle,d.title,d.created_by AS createdBy,d.created_at AS createdAt,('/api/contracts/pdf?id=' || d.id) AS downloadUrl FROM contract_documents d LEFT JOIN contract_templates t ON t.id=d.template_id WHERE d.created_by=? ORDER BY d.id DESC LIMIT 100").bind(user.email).all();
  return success({ templates: templates.results || [], documents: docs.results || [], isAdmin: user.role === ADMIN_ROLE });
});

// POST /api/contracts — 保存模板或生成合同
app.post("*", async (c) => {
  const { user } = c.var;
  const db = runtimeEnv.DB;
  await ensureTables(db);
  await ensureContractPermissions(db);
  const body = await c.req.json() as {
    action?: string;
    id?: unknown;
    title?: unknown;
    description?: unknown;
    content?: unknown;
    sections?: unknown;
    templateId?: unknown;
    values?: Record<string, unknown>;
  };
  const now = new Date().toISOString();

  if (body.action === "saveTemplate") {
    const permission = await authorizeCapability(db, user, "manage_contract_templates");
    if (permission) return permission;
    const title = String(body.title || "").trim();
    const description = String(body.description || "").trim();
    const content = String(body.content || "").trim();
    if (!title || !content) return fail("请填写合同名称和模板内容。", 400);
    const variables = detectVariables(content);
    const sections = JSON.stringify(Array.isArray(body.sections) ? body.sections : []);
    if (body.id) {
      const existing = await db.prepare("SELECT id FROM contract_templates WHERE id=?").bind(Number(body.id)).first<{ id: number }>();
      if (!existing) return fail("合同模板不存在。", 404);
      await db.prepare("UPDATE contract_templates SET title=?,description=?,content=?,variables=?,sections=?,updated_at=? WHERE id=?")
        .bind(title, description, content, JSON.stringify(variables), sections, now, Number(body.id)).run();
    } else {
      await db.prepare("INSERT INTO contract_templates(title,description,content,variables,sections,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(title, description, content, JSON.stringify(variables), sections, user.email, now, now).run();
    }
    await audit(db, user.email, "保存合同模板", title, "成功", `识别变量：${variables.join("、") || "无"}`);
    return success({ ok: true, variables, message: "合同模板已保存。" });
  }

  if (body.action === "generate") {
    const permission = await authorizeCapability(db, user, "generate_contracts");
    if (permission) return permission;
    const templateId = Number(body.templateId);
    const template = await db.prepare("SELECT title,content,variables FROM contract_templates WHERE id=?").bind(templateId).first<{ title: string; content: string; variables: string }>();
    if (!template) return fail("合同模板不存在。", 404);
    const values = body.values || {};
    const variables = detectVariables(template.content);
    const missing = variables.filter(key => !String(values[key] ?? "").trim());
    if (missing.length) return fail(`请补齐变量：${missing.join("、")}`, 400);
    const content = fillTemplate(template.content, values);
    const title = `${template.title}-${new Date().toLocaleDateString("zh-CN")}`;
    const saved = await db.prepare("INSERT INTO contract_documents(template_id,template_title,title,filled_values,content,created_by,created_at) VALUES(?,?,?,?,?,?,?) RETURNING id")
      .bind(templateId, template.title, title, JSON.stringify(values), content, user.email, now).first<{ id: number }>();
    await audit(db, user.email, "生成合同", title, "成功", `模板编号：${templateId}`);
    return success({ ok: true, id: saved?.id, title, content, downloadUrl: `/api/contracts/pdf?id=${saved?.id}` });
  }

  return fail("未知操作。", 400);
});

// DELETE /api/contracts — 删除模板或文档
app.delete("*", async (c) => {
  const { user } = c.var;
  const db = runtimeEnv.DB;
  await ensureTables(db);
  await ensureContractPermissions(db);
  const ids = await readDeleteIds(c.req.raw);
  const type = new URL(c.req.url).searchParams.get("type") || "template";
  if (!ids.length) return fail("请选择要删除的记录。", 400);

  if (type === "template") {
    const permission = await authorizeCapability(db, user, "manage_contract_templates");
    if (permission) return permission;
    for (const id of ids) {
      await db.prepare("DELETE FROM contract_documents WHERE template_id=?").bind(id).run();
      await db.prepare("DELETE FROM contract_templates WHERE id=?").bind(id).run();
    }
    await audit(db, user.email, "批量删除合同模板", ids.join(","), "成功", `删除数量：${ids.length}`);
    return success({ message: `已删除 ${ids.length} 个合同模板。`, deleted: ids.length });
  }

  if (type === "document") {
    const docs: Array<{ id: number; createdBy: string; title: string }> = [];
    for (const id of ids) {
      const doc = await db.prepare("SELECT id,created_by AS createdBy,title FROM contract_documents WHERE id=?").bind(id).first<{ id: number; createdBy: string; title: string }>();
      if (!doc) continue;
      if (user.role !== ADMIN_ROLE && doc.createdBy !== user.email) return fail("只能删除自己生成的合同。", 403);
      docs.push(doc);
    }
    for (const doc of docs) await db.prepare("DELETE FROM contract_documents WHERE id=?").bind(doc.id).run();
    await audit(db, user.email, "批量删除合同文件", docs.map(doc => doc.title).join(","), "成功", `删除数量：${docs.length}`);
    return success({ message: `已删除 ${docs.length} 份合同文件。`, deleted: docs.length });
  }

  return fail("删除类型不正确。", 400);
});

export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);
export const DELETE = (request: Request) => app.fetch(request);