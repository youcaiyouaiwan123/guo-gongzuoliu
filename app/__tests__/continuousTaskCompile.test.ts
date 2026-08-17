import { describe, it, expect } from "vitest";

// 持续任务（定时制/主动制）创建时"把选中的数据源接进真正要执行的步骤"这条逻辑的单测。
// 与 _proactiveTick.test.ts 同思路：不拉起 React 组件，而是原样重放 Console.tsx
// createContinuousTask 里的节点编译逻辑，锁住三件事：
//   1. 不选数据源时，节点与改造前逐字节一致（input → ai → [review] → output）；
//   2. 选了数据源时，在"设定目标"之后、"执行任务"之前插入一个 data 采集节点；
//   3. 主动制·指定数据源时默认复用所监测的源（watchSourceRef），显式选择可覆盖。

type Continuous = {
  loopType: string;
  reviewMode: string;
  goal: string;
  reviewStandard: string;
  watchSourceType: string;
  watchSourceRef: string;
  dataSourceRef: string;
};

type Node = { id: string; type: string; name: string; config?: string; inputMode?: string; promptGuide?: { task?: string } };

/** 与 app/Console.tsx createContinuousTask 中的节点编译保持一致的重放。 */
function compileContinuousNodes(continuous: Continuous): Node[] {
  const goal = continuous.goal.trim();
  const standard = continuous.reviewStandard.trim();
  const execSourceId = continuous.dataSourceRef
    || (continuous.loopType === "主动制" && continuous.watchSourceType === "data_source" ? continuous.watchSourceRef : "");
  return [
    { id: "loop-input", type: "input", name: "设定目标", inputMode: "direct", config: goal },
    ...(Number(execSourceId) > 0
      ? [{ id: "loop-data", type: "data", name: "采集数据", config: String(execSourceId) }]
      : []),
    { id: "loop-exec", type: "ai", name: "执行任务", promptGuide: { task: goal } },
    ...(continuous.reviewMode === "明确标准" && standard
      ? [{ id: "loop-review", type: "review", name: "审查结果", config: standard }]
      : []),
    { id: "loop-output", type: "output", name: "输出结果" },
  ];
}

function base(over: Partial<Continuous> = {}): Continuous {
  return { loopType: "定时制", reviewMode: "明确标准", goal: "整理新增客户", reviewStandard: "字段完整", watchSourceType: "free", watchSourceRef: "", dataSourceRef: "", ...over };
}

describe("持续任务节点编译 · 接数据源", () => {
  it("不选数据源：定时制沿用 input → ai → review → output，无 data 节点", () => {
    const nodes = compileContinuousNodes(base({ dataSourceRef: "" }));
    expect(nodes.map(n => n.type)).toEqual(["input", "ai", "review", "output"]);
    expect(nodes.some(n => n.type === "data")).toBe(false);
  });

  it("探索标准且无数据源：省掉 review 节点", () => {
    const nodes = compileContinuousNodes(base({ reviewMode: "探索标准" }));
    expect(nodes.map(n => n.type)).toEqual(["input", "ai", "output"]);
  });

  it("定时制选了数据源：在 input 之后、ai 之前插入 data 采集节点", () => {
    const nodes = compileContinuousNodes(base({ dataSourceRef: "7" }));
    expect(nodes.map(n => n.type)).toEqual(["input", "data", "ai", "review", "output"]);
    const dataNode = nodes.find(n => n.type === "data");
    expect(dataNode?.config).toBe("7");
    // data 必须排在 ai 前面，否则 AI 拿不到采集结果。
    expect(nodes.findIndex(n => n.type === "data")).toBeLessThan(nodes.findIndex(n => n.type === "ai"));
  });

  it("主动制·指定数据源：默认复用所监测的源作为执行采集源", () => {
    const nodes = compileContinuousNodes(base({ loopType: "主动制", watchSourceType: "data_source", watchSourceRef: "12", dataSourceRef: "" }));
    expect(nodes.find(n => n.type === "data")?.config).toBe("12");
  });

  it("主动制·指定数据源：显式选择的数据源覆盖所监测的源", () => {
    const nodes = compileContinuousNodes(base({ loopType: "主动制", watchSourceType: "data_source", watchSourceRef: "12", dataSourceRef: "99" }));
    expect(nodes.find(n => n.type === "data")?.config).toBe("99");
  });

  it("data 节点 config 非正数（如空串）时不注入", () => {
    const nodes = compileContinuousNodes(base({ dataSourceRef: "" }));
    expect(nodes.some(n => n.type === "data")).toBe(false);
  });
});
