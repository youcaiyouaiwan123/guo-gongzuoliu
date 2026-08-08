import { describe, it, expect } from "vitest";
import { KNOWLEDGE_POLISH_INSTRUCTION, markPolished } from "../_knowledgeText";

describe("AI 整理的提示词", () => {
  it("守住三条底线：不编造、不省略记录、不输出过程说明", () => {
    // 整理功能唯一真正的风险是模型把原始事实改掉，这三句缺一不可。
    expect(KNOWLEDGE_POLISH_INSTRUCTION).toContain("不得编造");
    expect(KNOWLEDGE_POLISH_INSTRUCTION).toContain("保留全部记录");
    expect(KNOWLEDGE_POLISH_INSTRUCTION).toContain("不要输出整理说明");
  });

  it("明确要求原文清晰时不要强行改写", () => {
    expect(KNOWLEDGE_POLISH_INSTRUCTION).toContain("不要强行改写");
  });
});

describe("markPolished 的来源标注", () => {
  it("没开整理时原样返回，不留任何痕迹", () => {
    expect(markPolished("手动创建", "off")).toBe("手动创建");
    expect(markPolished("", "off")).toBe("");
  });

  it("整理成功要留痕，否则事后分不清哪些正文被模型动过", () => {
    expect(markPolished("手动创建", "done")).toBe("手动创建 · AI整理");
  });

  it("整理失败要说明已保留原文，而不是假装成功", () => {
    expect(markPolished("手动创建", "failed")).toBe("手动创建 · AI整理失败，已保留原文");
  });
});
