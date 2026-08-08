// 投放监控报表的纯计算逻辑。
//
// 单独成文件有两个原因：
// 1) route.ts 顶部 import "cloudflare:workers"，vitest 无法直接导入，纯函数留在里面就测不到；
// 2) 这里的字段识别与数值解析是"看起来对、实际全是 0"的重灾区，必须有回归测试兜底。

import { parseCsv } from "../_csv";

export type Row = Record<string, unknown>;
export type Totals = { cost: number; impressions: number; clicks: number; conversions: number; revenue: number };
export type DroppedGroup = { reason: string; count: number };
export type CleanResult = { rows: Row[]; dropped: DroppedGroup[] };

export const aliases = {
  cost: ["cost", "spend", "花费", "消耗", "费用"],
  impressions: ["impression", "show", "曝光", "展示"],
  clicks: ["click", "点击"],
  conversions: ["conversion", "转化", "订单"],
  revenue: ["revenue", "sales", "gmv", "成交", "销售额", "收入"],
  date: ["date", "day", "日期", "时间"],
  campaign: ["campaign", "计划", "商品", "账号", "平台"],
};

// 衍生列不能参与原始指标匹配：表头"点击率"含"点击"、"点击单价"也含"点击"，
// 纯 substring 匹配会把 CTR 或 CPC 的数值当成点击数累加，指标全线失真。
const DERIVED_HEADER = /(率|占比|平均|单价|千次|per\b|rate|ratio|avg|ctr|cpc|cpm|cpa|roas|roi)/i;

// 导出文件常见的汇总行：直接参与求和会让所有指标翻倍。
const SUMMARY_CELL = /^(合计|总计|小计|汇总|总和|total|totals|sum|grand\s*total|subtotal)$/i;

const EMPTY_VALUE = /^(|-+|–+|—+|n\/a|na|null|undefined|无|未知)$/i;

/** 表头归一：去空格、去括号单位、转小写，让"花费（元）"与"花费"能对上 */
function normalizeHeader(value: string) {
  return value
    .replace(/[\s 　]/g, "")
    .replace(/[（(【\[].*?[)）】\]]/g, "")
    .toLowerCase();
}

/**
 * 解析平台导出的数值写法。
 *
 * 旧实现是 Number(String(v).replace(/[,￥元% ]/g, ""))：
 * 半角 ¥、$、全角空格、"次/个"单位、"3.2万"、会计式括号负数、"--" 全都会变成 NaN → 归零，
 * 这正是"衍生指标全是 0"的第二个来源（分母被清成 0）。
 */
export function parseMetricValue(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  let text = String(raw ?? "").trim();
  if (EMPTY_VALUE.test(text)) return 0;

  let sign = 1;
  const parenthesized = text.match(/^\((.*)\)$/);
  if (parenthesized) {
    sign = -1;
    text = parenthesized[1];
  }
  if (text.startsWith("-")) {
    sign = -1;
    text = text.slice(1);
  }

  let multiplier = 1;
  const unit = text.match(/(万亿|亿|万)\s*$/);
  if (unit) {
    multiplier = unit[1] === "万亿" ? 1e12 : unit[1] === "亿" ? 1e8 : 1e4;
    text = text.slice(0, unit.index);
  }

  const digits = text.replace(/[^\d.]/g, "");
  const value = Number(digits);
  if (!Number.isFinite(value) || !digits) return 0;
  return sign * value * multiplier;
}

/**
 * 找列：先精确匹配表头，再退回包含匹配。
 * 精确优先很重要——同时存在"点击数"和"点击率"时，包含匹配的命中顺序取决于列顺序，结果不稳定。
 */
export function findField(row: Row, keys: string[], skipDerived = true) {
  const entries = Object.entries(row).map(([key, value]) => ({ key, value, normalized: normalizeHeader(key) }));
  // 注意不要在过滤为空时回退到全部列：那等于把衍生列重新放回来，"只有点击率没有点击数"
  // 的表格会再次把 CTR 当点击数累加，正是这里要防的问题。
  const pool = skipDerived ? entries.filter(item => !DERIVED_HEADER.test(item.key)) : entries;
  const targets = keys.map(key => key.toLowerCase());
  const exact = pool.find(item => targets.includes(item.normalized));
  if (exact) return [exact.key, exact.value] as [string, unknown];
  const partial = pool.find(item => targets.some(target => item.normalized.includes(target)));
  return partial ? ([partial.key, partial.value] as [string, unknown]) : undefined;
}

export function asNumber(row: Row, keys: string[]) {
  const found = findField(row, keys);
  return found ? parseMetricValue(found[1]) : 0;
}

export function textValue(row: Row, keys: string[]) {
  const found = findField(row, keys, false);
  return found ? String(found[1] ?? "") : "";
}

export function parseRows(text: string): Row[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as Row[];
    // 接口导出的 JSON 往往是 {code,data:{list:[...]}} 这类信封，直接当单行会丢掉全部明细。
    const nested = findFirstObjectArray(parsed);
    return nested || [parsed as Row];
  }
  return parseCsv(trimmed);
}

function findFirstObjectArray(value: unknown, depth = 0): Row[] | null {
  if (depth > 4 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    return value.some(item => item && typeof item === "object" && !Array.isArray(item)) ? (value as Row[]) : null;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = findFirstObjectArray(item, depth + 1);
    if (found) return found;
  }
  return null;
}

function isBlankRow(row: Row) {
  return Object.values(row).every(value => EMPTY_VALUE.test(String(value ?? "").trim()));
}

function isRepeatedHeaderRow(row: Row) {
  const entries = Object.entries(row).filter(([, value]) => String(value ?? "").trim());
  if (entries.length < 2) return false;
  return entries.every(([key, value]) => normalizeHeader(key) === normalizeHeader(String(value)));
}

function isSummaryRow(row: Row) {
  return Object.values(row).some(value => SUMMARY_CELL.test(String(value ?? "").trim()));
}

const METRIC_GROUPS = [aliases.cost, aliases.impressions, aliases.clicks, aliases.conversions, aliases.revenue];

/**
 * 聚合前剔除异常行。只做确定性规则，不做统计离群值过滤——
 * 投放数据里的极端值经常是真实的大促日，自动剔掉会掩盖业务事实。
 */
export function cleanRows(rows: Row[]): CleanResult {
  const hasMetricColumn = rows.some(row => METRIC_GROUPS.some(keys => findField(row, keys)));
  const counters = new Map<string, number>();
  const kept: Row[] = [];
  for (const row of rows) {
    let reason = "";
    if (isBlankRow(row)) reason = "空行";
    else if (isSummaryRow(row)) reason = "合计行";
    else if (isRepeatedHeaderRow(row)) reason = "重复表头行";
    else if (hasMetricColumn && METRIC_GROUPS.every(keys => asNumber(row, keys) === 0)) reason = "全零行";
    if (reason) {
      counters.set(reason, (counters.get(reason) || 0) + 1);
      continue;
    }
    kept.push(row);
  }
  return { rows: kept, dropped: [...counters.entries()].map(([reason, count]) => ({ reason, count })) };
}

export function buildReport(rows: Row[], platformHint = "自动识别") {
  const cleaned = cleanRows(rows);
  const usable = cleaned.rows;
  const totals = usable.reduce<Totals>((acc, row) => {
    acc.cost += asNumber(row, aliases.cost);
    acc.impressions += asNumber(row, aliases.impressions);
    acc.clicks += asNumber(row, aliases.clicks);
    acc.conversions += asNumber(row, aliases.conversions);
    acc.revenue += asNumber(row, aliases.revenue);
    return acc;
  }, { cost: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 });

  const trendMap = new Map<string, { date: string; cost: number; clicks: number; revenue: number }>();
  const barMap = new Map<string, number>();
  for (const row of usable) {
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

  const indicators = {
    ctr: totals.impressions ? totals.clicks / totals.impressions : 0,
    cpc: totals.clicks ? totals.cost / totals.clicks : 0,
    conversionRate: totals.clicks ? totals.conversions / totals.clicks : 0,
    roas: totals.cost ? totals.revenue / totals.cost : 0,
  };

  return {
    platform: platformHint,
    rowCount: usable.length,
    totals,
    indicators,
    // 前端历史上从 summary 取指标，后端却只给 totals/indicators，导致 CTR/CPC/ROAS 恒为 0。
    // 这里直接给出合并后的 summary，新旧前端都能取到正确数值。
    summary: { ...totals, ...indicators },
    cleaning: { inputRows: rows.length, usedRows: usable.length, dropped: cleaned.dropped },
    trend: Array.from(trendMap.values()).slice(0, 60),
    bars: Array.from(barMap.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 20),
  };
}
