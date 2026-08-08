import { env } from "cloudflare:workers";
import { createApp, auth, success, fail, ADMIN_ROLE, authorizeCapability } from "../_app";
import { buildReport, parseRows } from "./_report";

type RuntimeEnv = { DB: D1Database };
const runtimeEnv = env as unknown as RuntimeEnv;

async function ensureTables(db: D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS monitoring_reports (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,title TEXT NOT NULL,platform TEXT NOT NULL,raw_rows TEXT NOT NULL,report TEXT NOT NULL,created_at TEXT NOT NULL)").run();
}

async function readDeleteIds(request: Request) {
  const urlId = Number(new URL(request.url).searchParams.get("id"));
  const body = await request.json().catch(() => ({})) as { ids?: unknown[]; id?: unknown };
  const values = Array.isArray(body.ids) ? body.ids : [body.id, Number.isInteger(urlId) ? urlId : undefined];
  return Array.from(new Set(values.map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0)));
}

const app = createApp();
app.use("*", auth());

// GET /api/monitoring — 获取报表列表
app.get("*", async (c) => {
  const { user } = c.var;
  const db = runtimeEnv.DB;
  await ensureTables(db);
  const permission = await authorizeCapability(db, user, "view_monitoring");
  if (permission) return permission;
  const result = user.role === ADMIN_ROLE
    ? await db.prepare("SELECT id,owner_email AS ownerEmail,title,platform,report AS reportJson,created_at AS createdAt FROM monitoring_reports ORDER BY id DESC LIMIT 30").all()
    : await db.prepare("SELECT id,owner_email AS ownerEmail,title,platform,report AS reportJson,created_at AS createdAt FROM monitoring_reports WHERE owner_email=? ORDER BY id DESC LIMIT 30").bind(user.email).all();
  return success({ reports: result.results || [] });
});

// POST /api/monitoring — 上传数据创建报表
app.post("*", async (c) => {
  const { user } = c.var;
  const db = runtimeEnv.DB;
  await ensureTables(db);
  const permission = await authorizeCapability(db, user, "view_monitoring");
  if (permission) return permission;
  const body = await c.req.json() as { title?: string; platform?: string; data?: string };
  let rows: ReturnType<typeof parseRows>;
  try {
    rows = parseRows(String(body.data || ""));
  } catch {
    return fail("数据看起来是 JSON，但解析失败，请检查是否被截断或缺少引号。", 400);
  }
  if (!rows.length) return fail("没有识别到可用数据，请上传 CSV、TSV 或 JSON 数据。", 400);
  const platform = body.platform?.trim() || "自动识别";
  const report = buildReport(rows, platform);
  if (!report.cleaning.usedRows) return fail("上传的数据在剔除合计行、空行和全零行后没有剩余可用记录。", 400);
  const now = new Date().toISOString();
  const saved = await db.prepare("INSERT INTO monitoring_reports(owner_email,title,platform,raw_rows,report,created_at) VALUES(?,?,?,?,?,?) RETURNING id")
    .bind(user.email, body.title?.trim() || `${platform}监控报表`, platform, JSON.stringify(rows), JSON.stringify(report), now).first<{ id: number }>();
  return success({ ok: true, id: saved?.id, report }, 201);
});

// DELETE /api/monitoring — 删除报表
app.delete("*", async (c) => {
  const { user } = c.var;
  const db = runtimeEnv.DB;
  await ensureTables(db);
  const ids = await readDeleteIds(c.req.raw);
  if (!ids.length) return fail("请选择要删除的报表。", 400);

  const reports: Array<{ id: number; ownerEmail: string }> = [];
  for (const id of ids) {
    const report = await db.prepare("SELECT id,owner_email AS ownerEmail FROM monitoring_reports WHERE id=?").bind(id).first<{ id: number; ownerEmail: string }>();
    if (!report) continue;
    if (user.role !== ADMIN_ROLE && report.ownerEmail !== user.email) return fail("只能删除自己的报表。", 403);
    reports.push(report);
  }
  for (const report of reports) await db.prepare("DELETE FROM monitoring_reports WHERE id=?").bind(report.id).run();
  return success({ message: `已删除 ${reports.length} 份报表。`, deleted: reports.length });
});

export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);
export const DELETE = (request: Request) => app.fetch(request);