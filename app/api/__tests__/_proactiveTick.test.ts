import { describe, it, expect, beforeEach } from "vitest";

// 主动制轮询车道（Lane A）的决策逻辑单测。
// 与 _scheduleTick.test.ts 同思路：不拉起整个 tick 路由，而是用同一段纯函数 + 一份可控的
// 数据桩，重放"抢占 → 冷却 → AI 判定 → 命中触发"这条决策链，锁住四件容易错的事：
// 抢占并发只触发一次、冷却期内不触发、未命中不触发、命中才跑工作流。
import { nextCheckAt, withinCooldown, clampCheckInterval } from "../_schedule";

type Task = {
  id: number;
  createdBy: string;
  triggerCondition: string;
  checkIntervalMin: number;
  nextRunAt: string;
  lastTriggeredAt: string | null;
};

const COOLDOWN_MIN = 60;

/** 与 app/api/gateway/tick/route.ts 主动制那段保持一致的决策重放。 */
async function runProactiveTick(
  tasks: Task[],
  now: Date,
  deps: {
    claim: (id: number, upcoming: string, expected: string) => Promise<number>;
    judge: (task: Task) => Promise<{ trigger: boolean; reason: string }>;
    run: (task: Task, reason: string) => Promise<void>;
  },
) {
  const handled: Array<{ id: number; result: string }> = [];
  for (const task of tasks) {
    const upcoming = nextCheckAt(task.checkIntervalMin, now);
    const changes = await deps.claim(task.id, upcoming, task.nextRunAt);
    if (!changes) { handled.push({ id: task.id, result: "已被其他心跳领走，跳过" }); continue; }
    if (!task.createdBy) { handled.push({ id: task.id, result: "缺少创建者，已跳过" }); continue; }
    if (withinCooldown(task.lastTriggeredAt, COOLDOWN_MIN, now)) { handled.push({ id: task.id, result: "冷却中，跳过" }); continue; }
    const verdict = await deps.judge(task);
    if (!verdict.trigger) { handled.push({ id: task.id, result: "未命中" }); continue; }
    await deps.run(task, verdict.reason);
    handled.push({ id: task.id, result: "已触发" });
  }
  return handled;
}

const NOW = new Date("2026-08-08T02:00:00.000Z");

function task(over: Partial<Task> = {}): Task {
  return { id: 1, createdBy: "her@example.com", triggerCondition: "出现负面反馈", checkIntervalMin: 10, nextRunAt: "2026-08-08T01:55:00.000Z", lastTriggeredAt: null, ...over };
}

describe("_schedule 主动制轮询辅助函数", () => {
  it("nextCheckAt = from + 间隔分钟", () => {
    expect(nextCheckAt(10, NOW)).toBe("2026-08-08T02:10:00.000Z");
    expect(nextCheckAt(1, NOW)).toBe("2026-08-08T02:01:00.000Z");
  });

  it("clampCheckInterval 夹到 [1,1440]，非法值回落 10", () => {
    expect(clampCheckInterval(0)).toBe(1);
    expect(clampCheckInterval(5000)).toBe(1440);
    expect(clampCheckInterval("abc")).toBe(10);
    expect(clampCheckInterval(30)).toBe(30);
  });

  it("withinCooldown：从未触发不算冷却；刚触发算冷却；超窗口不算", () => {
    expect(withinCooldown(null, 60, NOW)).toBe(false);
    expect(withinCooldown("2026-08-08T01:30:00.000Z", 60, NOW)).toBe(true); // 30 分钟前
    expect(withinCooldown("2026-08-08T00:30:00.000Z", 60, NOW)).toBe(false); // 90 分钟前
  });
});

describe("主动制轮询决策流程", () => {
  let ran: Array<{ id: number; reason: string }>;

  beforeEach(() => {
    ran = [];
  });

  function deps(over: Partial<Parameters<typeof runProactiveTick>[2]> = {}) {
    return {
      claim: async () => 1,
      judge: async () => ({ trigger: true, reason: "发现一条差评" }),
      run: async (t: Task, reason: string) => { ran.push({ id: t.id, reason }); },
      ...over,
    };
  }

  it("命中触发条件才跑工作流，并带上判定依据", async () => {
    const handled = await runProactiveTick([task()], NOW, deps());
    expect(handled).toEqual([{ id: 1, result: "已触发" }]);
    expect(ran).toEqual([{ id: 1, reason: "发现一条差评" }]);
  });

  it("未命中不跑工作流", async () => {
    const handled = await runProactiveTick([task()], NOW, deps({ judge: async () => ({ trigger: false, reason: "" }) }));
    expect(handled).toEqual([{ id: 1, result: "未命中" }]);
    expect(ran).toHaveLength(0);
  });

  it("冷却期内直接跳过，连模型判定都不发起", async () => {
    let judged = 0;
    const handled = await runProactiveTick(
      [task({ lastTriggeredAt: "2026-08-08T01:30:00.000Z" })],
      NOW,
      deps({ judge: async () => { judged++; return { trigger: true, reason: "x" }; } }),
    );
    expect(handled).toEqual([{ id: 1, result: "冷却中，跳过" }]);
    expect(judged).toBe(0);
    expect(ran).toHaveLength(0);
  });

  it("并发两次心跳，同一条命中任务只会触发一次", async () => {
    let current = "2026-08-08T01:55:00.000Z";
    const shared = deps({
      claim: async (_id: number, upcoming: string, expected: string) => {
        if (current !== expected) return 0;
        current = upcoming;
        return 1;
      },
    });
    const [a, b] = await Promise.all([
      runProactiveTick([task()], NOW, shared),
      runProactiveTick([task()], NOW, shared),
    ]);
    const triggered = [...a, ...b].filter(x => x.result === "已触发");
    expect(triggered).toHaveLength(1);
    expect(ran).toHaveLength(1);
  });

  it("缺少创建者的任务跳过（拿不到模型密钥）", async () => {
    const handled = await runProactiveTick([task({ createdBy: "" })], NOW, deps());
    expect(handled).toEqual([{ id: 1, result: "缺少创建者，已跳过" }]);
    expect(ran).toHaveLength(0);
  });
});
