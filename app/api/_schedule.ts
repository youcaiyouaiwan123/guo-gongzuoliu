// 定时任务的时间计算。
//
// 库里一律存 UTC，界面一律北京时间——容器没有设 TZ，默认就是 UTC，
// 不把这件事定死的话，用户填的"每天 9 点"会变成下午 5 点才跑。
//
// 中国不实行夏令时，北京时间恒为 UTC+8，所以这里用固定偏移而不是 Intl 时区库。
// 本模块不依赖 cloudflare:workers，可被单元测试直接导入。

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 解析界面填的 "HH:MM"（北京时间）。格式不合法返回 null，调用方据此当作"不定时"。 */
export function parseScheduleTime(value?: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * 算出下一次该跑的时刻（UTC ISO 串），严格晚于 from。
 *
 * 服务器停机期间错过的任务，恢复后这里会直接给出"下一个未来时刻"，
 * 于是错过多少天都只补跑一次，不会把积压的每一天都补一遍。
 */
export function nextRunAt(scheduleTime?: string, from: Date = new Date()): string | null {
  const parsed = parseScheduleTime(scheduleTime);
  if (!parsed) return null;
  const beijingNow = new Date(from.getTime() + BEIJING_OFFSET_MS);
  const todayInBeijing = Date.UTC(
    beijingNow.getUTCFullYear(),
    beijingNow.getUTCMonth(),
    beijingNow.getUTCDate(),
    parsed.hour,
    parsed.minute,
    0,
    0,
  ) - BEIJING_OFFSET_MS;
  // 正好等于当前时刻也要推到明天，否则刚跑完的任务会被立刻再捞出来一次。
  return new Date(todayInBeijing > from.getTime() ? todayInBeijing : todayInBeijing + DAY_MS).toISOString();
}

/** 把 UTC ISO 串显示成北京时间的 "HH:MM"，用于审计与提示文案。 */
export function formatBeijingTime(iso?: string | null) {
  if (!iso) return "";
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "";
  const beijing = new Date(time.getTime() + BEIJING_OFFSET_MS);
  return `${String(beijing.getUTCHours()).padStart(2, "0")}:${String(beijing.getUTCMinutes()).padStart(2, "0")}`;
}

// —— 主动制（事件触发）轮询车道 ——
// 定时制按"每天几点"跑；主动制按"每隔几分钟检查一次"跑。两者都复用 workflows.next_run_at 作为
// 下次触发时刻，只是计算方式不同，所以这里给出独立的纯函数，便于单测且不依赖 cloudflare:workers。

/** 轮询间隔下限（分钟）：太短会把模型接口打满，也没有业务意义。 */
export const MIN_CHECK_INTERVAL_MIN = 1;
/** 轮询间隔上限（分钟）：一天一次足够，更久应改用定时制。 */
export const MAX_CHECK_INTERVAL_MIN = 1440;

/** 把用户填的检查间隔夹到合法区间；非数字按默认 10 分钟。 */
export function clampCheckInterval(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 10;
  return Math.min(MAX_CHECK_INTERVAL_MIN, Math.max(MIN_CHECK_INTERVAL_MIN, n));
}

/** 算出下一次该检查的时刻（UTC ISO 串），= from + interval 分钟。 */
export function nextCheckAt(intervalMin: unknown, from: Date = new Date()): string {
  const interval = clampCheckInterval(intervalMin);
  return new Date(from.getTime() + interval * 60 * 1000).toISOString();
}

/**
 * 命中后是否还在冷却期内（还不该再次触发）。
 * lastTriggeredAt 为空表示从未触发过，永远不算在冷却期。cooldownMin<=0 表示不冷却。
 */
export function withinCooldown(lastTriggeredAt: string | null | undefined, cooldownMin: number, now: Date = new Date()): boolean {
  if (!lastTriggeredAt || cooldownMin <= 0) return false;
  const last = Date.parse(lastTriggeredAt);
  if (Number.isNaN(last)) return false;
  return now.getTime() - last < cooldownMin * 60 * 1000;
}
