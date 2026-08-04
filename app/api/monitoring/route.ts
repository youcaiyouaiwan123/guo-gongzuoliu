import { env } from "cloudflare:workers";
import { createApp, auth, success, fail, ADMIN_ROLE, authorizeCapability } from "../_app";

type RuntimeEnv = { DB: D1Database };
const runtimeEnv = env as unknown as RuntimeEnv;

type Row = Record<string, string | number>;
type Totals = { cost: number; impressions: number; clicks: number; conversions: number; revenue: number };

const aliases = {
  cost: ["cost", "spend", "花费", "消耗", "费用"],
  impressions: ["impression", "show", "曝光", "展示"],
  clicks: ["click", "点击"],
  conversions: ["conversion", "转化", "订单"],
  revenue: ["revenue", "sales", "gmv", "成交", "销售额", "收入"],
  date: ["date", "day", "日期", "时间"],
  campaign: ["campaign", "计划", "商品", "账号", "平台"],
};

function splitCsvLine(line: string, separator: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (char === separator && !quoted) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current.trim());
  return values;
}

function parseRows(text: string): Row[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const separator = lines[0].includes("\t") ? "\t" : ",";
  const headers = splitCsvLine(lines[0], separator).map(item => item.trim());
  return lines.slice(1).map(line => {
    const values = splitCsvLine(line, separator);
    return Object.fromEntries(headers.map((key, index) => [key, values[index] || ""]));
  });
}

function findField(row: Row, keys: string[]) {
  return Object.entries(row).find(([key]) => keys.some(target => key.toLowerCase().includes(target.toLowerCase())));
}

function asNumber(row: Row, keys: string[]) {
  const found = findField(row, keys);
  const value = found ? Number(String(found[1]).replace(/[,￥元% ]/g, "")) : 0;
  return Number.isFinite(value) ? value : 0;
}

function textValue(row: Row, keys: string[]) {
  const found = findField(row, keys);
  return found ? String(found[1]) : "";
}

function buildReport(rows: Row[], platformHint = "自动识别") {
  const totals = rows.reduce<Totals>((acc, row) => {
    acc.cost += asNumber(row, aliases.cost);
    acc.impressions += asNumber(row, aliases.impressions);
    acc.clicks += asNumber(row, aliases.clicks);
    acc.conversions += asNumber(row, aliases.conversions);
    acc.revenue += asNumber(row, aliases.revenue);
    return acc;
  }, { cost: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 });
  const trendMap = new Map<string, { date: string; cost: number; clicks: number; revenue: number }>();
  const barMap = new Map<string, number>();
  for (const row of rows) {
    const date = textValue(row, aliases.date) || "未标日期";
    const campaign = textValue(row, aliases.campaign) || platformHint;
    const trend = trendMap.get(date) || { date, cost: 0, clicks: 0, revenue: 0 };
    trend.cost += asNumber(row, aliases.cost);
    trend.clicks += asNumber(row, aliases.clicks);
    trend.revenue += asNumber(row, aliases.revenue);
    trendMap.set(date, trend);
    const barValue = asNumber(row, aliases.revenue) || asNumber(row, aliases.cost) || asNumber(row, aliases.clicks);
    barMap.set(campaign, (barMap.get(campaign) || 0) + barValue);
  }
  return {
    platform: platformHint,
    rowCount: rows.length,
    totals,
    indicators: {
      ctr: totals.impressions ? totals.clicks / totals.impressions : 0,
      cpc: totals.clicks ? totals.cost / totals.clicks : 0,
      conversionRate: totals.clicks ? totals.conversions / totals.clicks : 0,
      roas: totals.cost ? totals.revenue / totals.cost : 0
    },
    trend: Array.from(trendMap.values()).slice(0, 60),
    bars: Array.from(barMap.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 20)
  };
}

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
  const rows = parseRows(String(body.data || ""));
  if (!rows.length) return fail("没有识别到可用数据，请上传 CSV、TSV 或 JSON 数据。", 400);
  const platform = body.platform?.trim() || "自动识别";
  const report = buildReport(rows, platform);
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