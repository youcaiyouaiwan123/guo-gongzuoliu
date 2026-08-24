// 企业知识库：文档管理、搜索、审计日志。
// 使用 Hono 中间件统一处理认证和错误响应。
import { env } from "cloudflare:workers";
import { createApp, auth, success, fail, authorizeCapability, ADMIN_ROLE } from "../_app";
import { extractTextFromFile } from "../_fileText";
import { ensureColumn } from "../_schema";
import { askModel } from "../modules/_shared";
import { KNOWLEDGE_POLISH_INSTRUCTION, markPolished } from "../_knowledgeText";

// R2 绑定名以构建产物 dist/server/wrangler.json 的 r2_buckets 为准，当前为 "R2"
// （由 vite.config.ts 的 VITE_R2_BINDING 默认值生成）。此前这里写作 FILES，
// 运行时取到 undefined，知识库文件的上传/下载/删除全部 500。
type RuntimeEnv = { DB: D1Database; R2: R2Bucket };
const runtime = env as unknown as RuntimeEnv;

const fields = "id,title,content,visibility,department_id AS departmentId,filename,mime_type AS mimeType,category,tags,version,update_mode AS updateMode,update_schedule AS updateSchedule,status,size_bytes AS sizeBytes,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt";

async function ensureSchema() {
  await runtime.DB.batch([
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
    runtime.DB.prepare("CREATE INDEX IF NOT EXISTS knowledge_documents_updated_idx ON knowledge_documents(updated_at)"),
    // 与 organization/governance/chat 等处保持一致：email 为主键，无自增 id。
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS org_members (email TEXT PRIMARY KEY,unit_id INTEGER NOT NULL,job_title TEXT NOT NULL DEFAULT '员工',direct_manager_email TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '在岗',updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,resource TEXT NOT NULL,result TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)"),
  ]);
  await ensureColumn(runtime.DB, "knowledge_documents", "department_id", "INTEGER");
}

function isFullVisibility(value?: string | null) {
  return value === "全员" || String(value || "").includes("鍏ㄥ憳");
}

function isDepartmentVisibility(value?: string | null) {
  return value === "部门" || String(value || "").includes("閮ㄩ棬");
}

function safeDownloadName(title: string, mimeType: string, filename = "") {
  if (filename?.trim()) return filename.trim();
  const extension = mimeType.includes("json") ? "json" : mimeType.includes("plain") ? "txt" : "md";
  const base = (title || "knowledge").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 80) || "knowledge";
  return `${base}.${extension}`;
}

function canReadKnowledge(item: { visibility?: string; departmentId?: number | null }, unitId?: number | null, role?: string, businessRole?: string) {
  if (role === ADMIN_ROLE || String(role || "").includes("绠＄悊")) return true;
  if (isFullVisibility(item.visibility)) return true;
  if (isDepartmentVisibility(item.visibility) && item.departmentId && item.departmentId === unitId) return true;
  return item.visibility === businessRole;
}

async function getMembership(email: string) {
  // org_members 以 email 为主键，没有自增 id 列；此前 ORDER BY id 会报 no such column: id，
  // 导致查询部门归属失败，进而 GET/POST /api/state 全部 500（企业知识无法上传）。
  return runtime.DB.prepare("SELECT unit_id AS unitId FROM org_members WHERE email=? AND status <> '离职' ORDER BY updated_at DESC LIMIT 1")
    .bind(email)
    .first<{ unitId: number }>();
}

function parseIdsFromUrl(url: URL) {
  return (url.searchParams.get("ids") || "")
    .split(",")
    .map(Number)
    .filter(id => Number.isInteger(id) && id > 0)
    .slice(0, 500);
}

const app = createApp();
app.use("*", auth());

// GET /api/state — 获取知识库文档列表、搜索、下载
app.get("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();

  const url = new URL(c.req.url);
  const membership = await getMembership(user.email);
  const downloadId = Number(url.searchParams.get("download"));

  if (downloadId) {
    const item = await runtime.DB.prepare(`SELECT id,title,content,filename,mime_type AS mimeType,file_key AS fileKey,visibility,department_id AS departmentId FROM knowledge_documents WHERE id=?`)
      .bind(downloadId)
      .first<{ id: number; title: string; content: string; filename: string; mimeType: string; fileKey: string; visibility: string; departmentId?: number }>();
    if (!item || !canReadKnowledge(item, membership?.unitId, user.role, user.businessRole)) {
      return new Response("无权访问或文件不存在", { status: 404 });
    }
    const mimeType = item.mimeType || "text/markdown;charset=utf-8";
    const downloadName = safeDownloadName(item.title, mimeType, item.filename);
    if (!item.fileKey && item.content) {
      return new Response(item.content, {
        headers: {
          "Content-Type": mimeType,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
        },
      });
    }
    const object = item.fileKey ? await runtime.R2.get(item.fileKey) : null;
    if (!object) return new Response("原文件不存在", { status: 404 });
    return new Response(object.body, {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
      },
    });
  }

  const q = url.searchParams.get("q")?.trim();
  const category = url.searchParams.get("category")?.trim();
  let sql = `SELECT ${fields} FROM knowledge_documents WHERE (visibility IN ('全员','鍏ㄥ憳') OR visibility=? OR (visibility IN ('部门','閮ㄩ棬') AND department_id=?) OR ?=1)`;
  const bindings: unknown[] = [user.businessRole, membership?.unitId || -1, user.role === ADMIN_ROLE ? 1 : 0];
  if (q) {
    sql += " AND (title LIKE ? OR filename LIKE ? OR tags LIKE ? OR content LIKE ?)";
    const like = `%${q}%`;
    bindings.push(like, like, like, like);
  }
  if (category && category !== "全部分类" && category !== "鍏ㄩ儴鍒嗙被") {
    sql += " AND category=?";
    bindings.push(category);
  }
  sql += " ORDER BY updated_at DESC,id DESC LIMIT 100";

  const documents = await runtime.DB.prepare(sql).bind(...bindings).all();
  // 审计日志属敏感数据：仅在通过 view_audit 能力校验时才返回，否则回落到空集合，
  // 避免任何登录用户（含普通员工）经此接口读取全员操作轨迹。
  // 删除侧本就已是管理员专属（见下方 DELETE），这里补齐读取侧的对称约束。
  const auditDenied = await authorizeCapability(runtime.DB, user, "view_audit");
  const logs = auditDenied
    ? { results: [] as unknown[] }
    : await runtime.DB.prepare("SELECT id,actor,action,resource,result,detail,created_at AS createdAt FROM audit_logs ORDER BY id DESC LIMIT 100").all();
  return success({ documents: documents.results || [], logs: logs.results || [] });
});

// POST /api/state — 添加知识库文档（表单或 JSON）
app.post("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const denied = await authorizeCapability(runtime.DB, user, "manage_knowledge");
  if (denied) return denied;

  const actor = user.email;
  const now = new Date().toISOString();
  const request = c.req.raw;
  const contentType = request.headers.get("content-type") || "";
  const membership = await getMembership(actor);

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const files = form.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
    if (!files.length) return fail("请选择文件。", 400);
    if (files.some(file => file.size > 30 * 1024 * 1024)) return fail("单个文件不能超过 30MB。", 400);

    const category = String(form.get("category") || "未分类");
    const tags = String(form.get("tags") || "");
    const visibility = String(form.get("visibility") || "全员");
    const requestedDepartmentId = Number(form.get("departmentId")) || null;
    const departmentId = user.role === ADMIN_ROLE ? requestedDepartmentId : membership?.unitId || null;
    if (visibility === "部门" && !departmentId) return fail("请先加入部门，或由管理员选择资料所属部门。", 400);
    const updateMode = String(form.get("updateMode") || "手动更新");
    const updateSchedule = String(form.get("updateSchedule") || "");
    const saved = [];

    for (const file of files) {
      const key = `knowledge/${crypto.randomUUID()}/${file.name}`;
      await runtime.R2.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
        customMetadata: { owner: actor },
      });
      const extracted = await extractTextFromFile(file);
      const title = file.name.replace(/\.[^.]+$/, "") || file.name;
      const row = await runtime.DB.prepare(`INSERT INTO knowledge_documents(title,content,visibility,department_id,filename,mime_type,file_key,category,tags,version,update_mode,update_schedule,status,size_bytes,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING ${fields}`)
        .bind(title, extracted.content, visibility, departmentId, file.name, extracted.mimeType, key, category, tags, 1, updateMode, updateSchedule, extracted.status, file.size, actor, now, now)
        .first();
      saved.push(row);
      await runtime.DB.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
        .bind(actor, "上传知识文件", file.name, "成功", `${category} · ${visibility} · ${extracted.note}`, now)
        .run();
    }
    return success({ documents: saved }, 201);
  }

  const body = await c.req.json() as { type?: string; title?: string; content?: string; visibility?: string; departmentId?: number; category?: string; tags?: string; updateMode?: string; updateSchedule?: string; polish?: boolean };
  const title = body.title?.trim();
  const content = body.content?.trim();
  if (body.type !== "document" || !title || !content) return fail("请填写资料名称和内容。", 400);

  const visibility = body.visibility || "全员";
  const departmentId = user.role === ADMIN_ROLE ? Number(body.departmentId) || null : membership?.unitId || null;
  if (visibility === "部门" && !departmentId) return fail("请先加入部门，或由管理员选择资料所属部门。", 400);

  // 可选的 AI 整理，与个人知识用同一份提示词。整理失败退回原文保存，
  // 不让附加能力的缺失（比如没配模型密钥）挡住用户存资料。
  let stored = content;
  let polishState: "done" | "failed" | "off" = "off";
  if (body.polish) {
    try {
      const polished = (await askModel(actor, KNOWLEDGE_POLISH_INSTRUCTION, content.slice(0, 16000))).trim();
      if (polished) { stored = polished; polishState = "done"; } else { polishState = "failed"; }
    } catch {
      polishState = "failed";
    }
  }
  // 整理过的内容在标签上留痕，事后才分得清哪些正文被模型动过。
  const baseTags = body.tags?.trim() || "";
  const tags = polishState === "off" ? baseTags : markPolished(baseTags, polishState).replace(/^\s*·\s*/, "");

  const saved = await runtime.DB.prepare(`INSERT INTO knowledge_documents(title,content,visibility,department_id,filename,mime_type,file_key,category,tags,version,update_mode,update_schedule,status,size_bytes,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING ${fields}`)
    .bind(title, stored, visibility, departmentId, `${title}.md`, "text/markdown", "", body.category || "未分类", tags, 1, body.updateMode || "手动更新", body.updateSchedule || "", "已解析", new TextEncoder().encode(stored).byteLength, actor, now, now)
    .first();
  await runtime.DB.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(actor, "添加知识", title, "成功", `${body.category || "未分类"} · ${visibility}${polishState === "off" ? "" : polishState === "done" ? " · AI整理" : " · AI整理失败已存原文"}`, now)
    .run();
  return success({
    document: saved,
    polished: polishState === "done",
    message: polishState === "done"
      ? "已用 AI 整理后保存。"
      : polishState === "failed"
        ? "AI 整理未成功，已按原文保存。"
        : "资料已保存。",
  }, 201);
});

// DELETE /api/state — 删除知识库文档或审计记录
app.delete("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const url = new URL(c.req.url);

  const allAuditLogs = url.searchParams.get("allAuditLogs") === "true";
  const auditLogIds = (url.searchParams.get("auditLogIds") || "").split(",").map(Number).filter(id => Number.isInteger(id) && id > 0).slice(0, 500);
  if (allAuditLogs || auditLogIds.length) {
    if (user.role !== ADMIN_ROLE) return fail("只有管理员可以删除审计记录。", 403);
    if (allAuditLogs) {
      await runtime.DB.prepare("DELETE FROM audit_logs").run();
      return success({ ok: true, message: "全部审计记录已删除。" });
    }
    const placeholders = auditLogIds.map(() => "?").join(",");
    await runtime.DB.prepare(`DELETE FROM audit_logs WHERE id IN (${placeholders})`).bind(...auditLogIds).run();
    return success({ ok: true, message: `已删除 ${auditLogIds.length} 条审计记录。` });
  }

  const auditLogId = Number(url.searchParams.get("auditLogId"));
  if (Number.isInteger(auditLogId) && auditLogId > 0) {
    if (user.role !== ADMIN_ROLE) return fail("只有管理员可以删除审计记录。", 403);
    await runtime.DB.prepare("DELETE FROM audit_logs WHERE id=?").bind(auditLogId).run();
    return success({ ok: true, message: "审计记录已删除。" });
  }

  const denied = await authorizeCapability(runtime.DB, user, "manage_knowledge");
  if (denied) return denied;

  let ids = parseIdsFromUrl(url);
  if (!ids.length) {
    const id = Number(url.searchParams.get("id"));
    if (Number.isInteger(id) && id > 0) ids = [id];
  }
  if (!ids.length) {
    const body = await c.req.json().catch(() => ({})) as { ids?: unknown[]; id?: unknown };
    ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(id => Number.isInteger(id) && id > 0).slice(0, 500) : [Number(body.id)].filter(id => Number.isInteger(id) && id > 0);
  }
  if (!ids.length) return fail("请选择要删除的知识资料。", 400);

  const deletedTitles: string[] = [];
  for (const id of ids) {
    const item = await runtime.DB.prepare("SELECT title,file_key AS fileKey,created_by AS createdBy FROM knowledge_documents WHERE id=?")
      .bind(id)
      .first<{ title: string; fileKey?: string; createdBy: string }>();
    if (!item) continue;
    if (user.role !== ADMIN_ROLE && item.createdBy !== user.email) continue;
    if (item.fileKey) await runtime.R2.delete(item.fileKey).catch(() => undefined);
    await runtime.DB.prepare("DELETE FROM knowledge_documents WHERE id=?").bind(id).run();
    deletedTitles.push(item.title);
  }

  if (!deletedTitles.length) return fail("资料不存在，或当前账号无权删除。", 404);
  await runtime.DB.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(user.email, deletedTitles.length > 1 ? "批量删除知识资料" : "删除知识资料", deletedTitles.join("、"), "成功", "资料记录和原始文件已删除。", new Date().toISOString())
    .run();
  return success({ ok: true, message: `已删除 ${deletedTitles.length} 条知识资料。`, deleted: deletedTitles.length });
});

// PATCH /api/state — 同步 / 编辑知识库文档
app.patch("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const denied = await authorizeCapability(runtime.DB, user, "manage_knowledge");
  if (denied) return denied;
  const body = await c.req.json() as { id?: number; action?: string; title?: string; content?: string; category?: string; visibility?: string; departmentId?: number; tags?: string; updateMode?: string; updateSchedule?: string };
  if (!body.id) return fail("操作无效。", 400);
  const now = new Date().toISOString();

  if (body.action === "edit") {
    const existing = await runtime.DB.prepare("SELECT version,content,created_by AS createdBy FROM knowledge_documents WHERE id=?")
      .bind(body.id)
      .first<{ version: number; content: string; createdBy: string }>();
    if (!existing) return fail("资料不存在。", 404);
    // 与 DELETE 对称：只有创建者或管理员能改这条资料。
    if (user.role !== ADMIN_ROLE && existing.createdBy !== user.email) return fail("无权编辑该资料。", 403);

    const title = body.title?.trim();
    if (title !== undefined && !title) return fail("资料名称不能为空。", 400);

    const visibility = body.visibility?.trim() || undefined;
    const membership = await getMembership(user.email);
    // 可见范围＝部门时按 POST 逻辑确定归属：管理员可指定，其余用本人部门。
    let departmentId: number | null | undefined;
    if (visibility === "部门") {
      departmentId = user.role === ADMIN_ROLE ? (Number(body.departmentId) || null) : (membership?.unitId || null);
      if (!departmentId) return fail("请先加入部门，或由管理员选择资料所属部门。", 400);
    } else if (visibility !== undefined) {
      // 切到非部门可见范围时清掉部门归属，避免残留旧部门。
      departmentId = null;
    }

    // 正文有实质变化才升版本、刷新大小与解析状态；只改元数据则版本不动。
    const contentChanged = body.content !== undefined && body.content.trim() !== (existing.content || "").trim();
    const nextContent = contentChanged ? body.content!.trim() : undefined;

    const sets: string[] = [];
    const binds: unknown[] = [];
    if (title !== undefined) { sets.push("title=?"); binds.push(title); }
    if (body.category !== undefined) { sets.push("category=?"); binds.push(body.category.trim() || "未分类"); }
    if (visibility !== undefined) { sets.push("visibility=?"); binds.push(visibility); }
    if (departmentId !== undefined) { sets.push("department_id=?"); binds.push(departmentId); }
    if (body.tags !== undefined) { sets.push("tags=?"); binds.push(body.tags.trim()); }
    if (body.updateMode !== undefined) { sets.push("update_mode=?"); binds.push(body.updateMode.trim() || "手动更新"); }
    if (body.updateSchedule !== undefined) { sets.push("update_schedule=?"); binds.push(body.updateSchedule.trim()); }
    if (contentChanged) {
      sets.push("content=?"); binds.push(nextContent);
      sets.push("size_bytes=?"); binds.push(new TextEncoder().encode(nextContent).byteLength);
      sets.push("status=?"); binds.push(nextContent ? "已解析" : "待解析");
      sets.push("version=version+1");
    }
    if (!sets.length) return fail("没有需要更新的内容。", 400);
    sets.push("updated_at=?"); binds.push(now);

    const saved = await runtime.DB.prepare(`UPDATE knowledge_documents SET ${sets.join(",")} WHERE id=? RETURNING ${fields}`)
      .bind(...binds, body.id)
      .first();
    await runtime.DB.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
      .bind(user.email, "编辑知识", String(body.id), "成功", contentChanged ? `已更新正文，版本升至 V${existing.version + 1}。` : "已更新资料信息。", now)
      .run();
    return success({ document: saved, message: contentChanged ? `已保存，版本更新为 V${existing.version + 1}。` : "已保存修改。" });
  }

  if (body.action !== "sync") return fail("操作无效。", 400);
  await runtime.DB.prepare("UPDATE knowledge_documents SET status=CASE WHEN content='' THEN '待解析' ELSE '已解析' END,updated_at=? WHERE id=?").bind(now, body.id).run();
  await runtime.DB.prepare("INSERT INTO audit_logs(actor,action,resource,result,detail,created_at) VALUES(?,?,?,?,?,?)")
    .bind(user.email, "同步知识", String(body.id), "成功", "已检查更新并刷新检索状态。", now)
    .run();
  return success({ message: "已检查更新。" });
});

export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);
export const DELETE = (request: Request) => app.fetch(request);
export const PATCH = (request: Request) => app.fetch(request);