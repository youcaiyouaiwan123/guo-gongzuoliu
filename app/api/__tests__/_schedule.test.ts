import { describe, it, expect } from "vitest";
import { parseScheduleTime, nextRunAt, formatBeijingTime } from "../_schedule";

// 时区换算错一次，用户填的"每天 9 点"就会变成下午 5 点跑，而且很难从现象反推原因，
// 所以这里把边界都钉死。

describe("parseScheduleTime", () => {
  it("接受 HH:MM 与 H:MM", () => {
    expect(parseScheduleTime("09:00")).toEqual({ hour: 9, minute: 0 });
    expect(parseScheduleTime("9:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseScheduleTime("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseScheduleTime(" 08:30 ")).toEqual({ hour: 8, minute: 30 });
  });

  it("非法值一律返回 null（调用方据此当作不定时）", () => {
    for (const bad of ["", undefined, "24:00", "12:60", "9", "09-00", "上午九点", "0900"]) {
      expect(parseScheduleTime(bad as string)).toBeNull();
    }
  });
});

describe("nextRunAt 的时区换算", () => {
  it("北京时间 09:00 对应 UTC 01:00", () => {
    // 当前是北京时间 8 月 8 日 08:00（UTC 00:00），今天 9 点还没到
    const from = new Date("2026-08-08T00:00:00.000Z");
    expect(nextRunAt("09:00", from)).toBe("2026-08-08T01:00:00.000Z");
  });

  it("今天的点已经过了就排到明天", () => {
    // 北京时间 8 月 8 日 10:00（UTC 02:00），今天 9 点已过
    const from = new Date("2026-08-08T02:00:00.000Z");
    expect(nextRunAt("09:00", from)).toBe("2026-08-09T01:00:00.000Z");
  });

  it("正好到点也推到明天，避免刚跑完又被立刻捞出来", () => {
    const from = new Date("2026-08-08T01:00:00.000Z");
    expect(nextRunAt("09:00", from)).toBe("2026-08-09T01:00:00.000Z");
  });

  it("北京时间凌晨的点会落到前一天的 UTC", () => {
    // 北京 8 月 8 日 07:00 = UTC 8 月 7 日 23:00；下一个北京 01:00 是 8 月 9 日 01:00（UTC 8 月 8 日 17:00）
    const from = new Date("2026-08-07T23:00:00.000Z");
    expect(nextRunAt("01:00", from)).toBe("2026-08-08T17:00:00.000Z");
  });

  it("跨月跨年不出错", () => {
    // 北京 2026-12-31 23:30（UTC 15:30），下一个 09:00 是北京 2027-01-01
    const from = new Date("2026-12-31T15:30:00.000Z");
    expect(nextRunAt("09:00", from)).toBe("2027-01-01T01:00:00.000Z");
  });

  it("停机多日后只补一次，不会把积压的每天都补一遍", () => {
    // 上次该跑是 8 月 1 日，服务器停到 8 月 8 日才恢复
    const from = new Date("2026-08-08T02:00:00.000Z");   // 北京 8 月 8 日 10:00
    const next = nextRunAt("09:00", from)!;
    // 直接给出下一个未来时刻（明天），而不是 8 月 2 日
    expect(next).toBe("2026-08-09T01:00:00.000Z");
    expect(new Date(next).getTime()).toBeGreaterThan(from.getTime());
  });

  it("不定时的任务返回 null", () => {
    expect(nextRunAt("", new Date())).toBeNull();
    expect(nextRunAt(undefined, new Date())).toBeNull();
    expect(nextRunAt("每天早上", new Date())).toBeNull();
  });
});

describe("formatBeijingTime", () => {
  it("把 UTC 串显示成北京时间", () => {
    expect(formatBeijingTime("2026-08-08T01:00:00.000Z")).toBe("09:00");
    expect(formatBeijingTime("2026-08-08T17:00:00.000Z")).toBe("01:00");
  });

  it("空值与非法值返回空串", () => {
    expect(formatBeijingTime(null)).toBe("");
    expect(formatBeijingTime("")).toBe("");
    expect(formatBeijingTime("not-a-date")).toBe("");
  });
});
