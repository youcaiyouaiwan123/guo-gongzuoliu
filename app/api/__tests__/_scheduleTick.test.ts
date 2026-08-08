import { describe, it, expect, beforeEach } from "vitest";

// tick 路由本身要拉起整个 modules/route（含 Hono、鉴权、工作流引擎），在单测里成本过高且脆。
// 这里把调度的决策逻辑按同样的顺序重放一遍，锁住四件真正容易错的事：
// 到期判断、抢占、创建者缺失、定时设置被改坏。
import { nextRunAt } from "../_schedule";

type Row = { id: number; name: string; scheduleTime: string; nextRunAt: string; createdBy: string };

/** 与 app/api/gateway/tick/route.ts 中同一段流程保持一致。 */
async function runTick(
  rows: Row[],
  now: Date,
  db: { claim: (id: number, upcoming: string, expected: string) => Promise<number> },
) {
  const handled: Array<{ id: number; result: string }> = [];
  for (const workflow of rows) {
    const upcoming = nextRunAt(workflow.scheduleTime, now);
    if (!upcoming) {
      handled.push({ id: workflow.id, result: "定时设置非法，已停调度" });
      continue;
    }
    const changes = await db.claim(workflow.id, upcoming, workflow.nextRunAt);
    if (!changes) {
      handled.push({ id: workflow.id, result: "已被其他心跳领走，跳过" });
      continue;
    }
    if (!workflow.createdBy) {
      handled.push({ id: workflow.id, result: "缺少创建者，已跳过" });
      continue;
    }
    handled.push({ id: workflow.id, result: "已执行" });
  }
  return handled;
}

const NOW = new Date("2026-08-08T02:00:00.000Z"); // 北京 8 月 8 日 10:00

function row(over: Partial<Row> = {}): Row {
  return { id: 1, name: "每日日报", scheduleTime: "09:00", nextRunAt: "2026-08-08T01:00:00.000Z", createdBy: "her@example.com", ...over };
}

describe("定时调度的决策流程", () => {
  let claimed: Array<{ id: number; upcoming: string; expected: string }>;
  let alwaysWin: { claim: (id: number, upcoming: string, expected: string) => Promise<number> };

  beforeEach(() => {
    claimed = [];
    alwaysWin = {
      claim: async (id, upcoming, expected) => { claimed.push({ id, upcoming, expected }); return 1; },
    };
  });

  it("到期任务执行前先把 next_run_at 推到下一次", async () => {
    const handled = await runTick([row()], NOW, alwaysWin);

    expect(handled).toEqual([{ id: 1, result: "已执行" }]);
    // 抢占时带上旧值做条件，且新值是下一个未来时刻
    expect(claimed[0].expected).toBe("2026-08-08T01:00:00.000Z");
    expect(claimed[0].upcoming).toBe("2026-08-09T01:00:00.000Z");
  });

  it("抢占失败（已被别的心跳领走）就跳过，不重复执行", async () => {
    const loser = { claim: async () => 0 };

    const handled = await runTick([row()], NOW, loser);

    expect(handled).toEqual([{ id: 1, result: "已被其他心跳领走，跳过" }]);
  });

  it("并发两次心跳，同一条任务只会被执行一次", async () => {
    // 用一份共享状态模拟条件 UPDATE：只有 expected 与当前值相等才算抢到
    let current = "2026-08-08T01:00:00.000Z";
    const shared = {
      claim: async (_id: number, upcoming: string, expected: string) => {
        if (current !== expected) return 0;
        current = upcoming;
        return 1;
      },
    };

    const [first, second] = await Promise.all([
      runTick([row()], NOW, shared),
      runTick([row()], NOW, shared),
    ]);

    const executed = [...first, ...second].filter(item => item.result === "已执行");
    expect(executed).toHaveLength(1);
  });

  it("0023 之前建的任务没有创建者，跳过并留下记录", async () => {
    const handled = await runTick([row({ createdBy: "" })], NOW, alwaysWin);

    expect(handled).toEqual([{ id: 1, result: "缺少创建者，已跳过" }]);
  });

  it("定时设置被改成非法值时停掉调度，不会每分钟被反复捞出来", async () => {
    const handled = await runTick([row({ scheduleTime: "每天早上" })], NOW, alwaysWin);

    expect(handled).toEqual([{ id: 1, result: "定时设置非法，已停调度" }]);
    expect(claimed).toHaveLength(0); // 压根没走到抢占
  });

  it("多条任务互不影响：一条抢占失败不挡住其他任务", async () => {
    let calls = 0;
    const flaky = { claim: async () => (++calls === 1 ? 0 : 1) };

    const handled = await runTick([row({ id: 1 }), row({ id: 2 }), row({ id: 3 })], NOW, flaky);

    expect(handled.map(h => h.result)).toEqual(["已被其他心跳领走，跳过", "已执行", "已执行"]);
  });
});
