import { describe, it, expect } from "vitest";
import { asNumber, buildReport, cleanRows, findField, parseMetricValue, parseRows } from "../_report";

// 7 月投放日报的真实形态：中文表头、带单位与千分位的数值、末尾一行"合计"、
// 以及一列会被旧实现误当成点击数的"点击率"。
const DAILY_REPORT_CSV = [
  "日期,计划名称,消耗(元),展示数,点击数,点击率,转化数,成交金额",
  "2026-07-01,夏季大促,\"¥1,200.50\",100000,2500,2.50%,125,\"¥9,600.00\"",
  "2026-07-02,夏季大促,800,60000,1500,2.50%,75,4800",
  "2026-07-03,日常投放,\"1,000\",40000,1000,2.50%,50,3600",
  "合计,,3000.5,200000,5000,2.50%,250,18000",
].join("\n");

describe("parseMetricValue", () => {
  it("解析平台导出的各种数值写法", () => {
    expect(parseMetricValue("1,234")).toBe(1234);
    expect(parseMetricValue("¥1,234.56")).toBe(1234.56);
    expect(parseMetricValue("￥1,234")).toBe(1234);
    expect(parseMetricValue("$99")).toBe(99);
    expect(parseMetricValue("1 234 元")).toBe(1234);
    expect(parseMetricValue("3.2万")).toBe(32000);
    expect(parseMetricValue("1.5亿")).toBe(150000000);
    expect(parseMetricValue("12.5%")).toBe(12.5);
    expect(parseMetricValue("5,678次")).toBe(5678);
    expect(parseMetricValue(1234)).toBe(1234);
  });

  it("空值与占位符归零而不是 NaN", () => {
    for (const value of ["", "  ", "-", "--", "—", "N/A", "null", "无", undefined, null]) {
      expect(parseMetricValue(value)).toBe(0);
    }
  });

  it("识别负数的两种写法", () => {
    expect(parseMetricValue("-500")).toBe(-500);
    expect(parseMetricValue("(500)")).toBe(-500);
  });
});

describe("findField", () => {
  it("精确表头优先于包含匹配", () => {
    const row = { 点击率: "2.5%", 点击数: "1000" };
    expect(findField(row, ["click", "点击"])?.[0]).toBe("点击数");
  });

  it("衍生列不参与原始指标匹配", () => {
    const row = { 日期: "2026-07-01", 点击率: "2.5%", 点击单价: "0.48" };
    // 只有衍生列时不能把 CTR 当成点击数累加
    expect(asNumber(row, ["click", "点击"])).toBe(0);
  });

  it("忽略表头里的括号单位和空格", () => {
    const row = { "消耗 (元)": "1,200" };
    expect(asNumber(row, ["cost", "spend", "花费", "消耗", "费用"])).toBe(1200);
  });
});

describe("parseRows", () => {
  it("解析带引号与千分位的 CSV", () => {
    const rows = parseRows(DAILY_REPORT_CSV);
    expect(rows).toHaveLength(4);
    expect(rows[0]["成交金额"]).toBe("¥9,600.00");
  });

  it("解析制表符分隔的导出文件", () => {
    const rows = parseRows("日期\t消耗\t点击\n2026-07-01\t100\t20");
    expect(rows).toHaveLength(1);
    expect(rows[0]["消耗"]).toBe("100");
  });

  it("拆开 {code,data:{list}} 信封取明细", () => {
    const rows = parseRows(JSON.stringify({ code: 0, data: { list: [{ 日期: "2026-07-01", 消耗: 100 }] } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]["消耗"]).toBe(100);
  });
});

describe("cleanRows", () => {
  it("剔除合计行、空行、重复表头行和全零行", () => {
    const rows = parseRows([
      "日期,消耗,展示,点击,转化,成交",
      "2026-07-01,100,1000,20,2,300",
      "日期,消耗,展示,点击,转化,成交",
      ",,,,,",
      "2026-07-02,0,0,0,0,0",
      "合计,100,1000,20,2,300",
    ].join("\n"));
    const result = cleanRows(rows);
    expect(result.rows).toHaveLength(1);
    expect(Object.fromEntries(result.dropped.map(item => [item.reason, item.count]))).toEqual({
      空行: 1,
      合计行: 1,
      重复表头行: 1,
      全零行: 1,
    });
  });

  it("没有指标列时不会把整份数据当成全零行清空", () => {
    const rows = parseRows("姓名,备注\n张三,跟进中\n李四,已成交");
    expect(cleanRows(rows).rows).toHaveLength(2);
  });
});

describe("buildReport", () => {
  it("合计行不参与求和，指标不翻倍", () => {
    const report = buildReport(parseRows(DAILY_REPORT_CSV), "抖音");
    expect(report.cleaning.dropped).toEqual([{ reason: "合计行", count: 1 }]);
    expect(report.cleaning.usedRows).toBe(3);
    expect(report.totals.cost).toBeCloseTo(3000.5, 2);
    expect(report.totals.impressions).toBe(200000);
    expect(report.totals.clicks).toBe(5000);
    expect(report.totals.revenue).toBeCloseTo(18000, 2);
  });

  it("衍生指标按实际数据计算且不为 0", () => {
    const report = buildReport(parseRows(DAILY_REPORT_CSV), "抖音");
    expect(report.indicators.ctr).toBeCloseTo(5000 / 200000, 6);
    expect(report.indicators.cpc).toBeCloseTo(3000.5 / 5000, 6);
    expect(report.indicators.conversionRate).toBeCloseTo(250 / 5000, 6);
    expect(report.indicators.roas).toBeCloseTo(18000 / 3000.5, 6);
    // summary 与 indicators 必须一致，前端从任一处取值都对得上
    expect(report.summary.ctr).toBe(report.indicators.ctr);
    expect(report.summary.cost).toBe(report.totals.cost);
  });

  it("按日期聚合趋势、按计划聚合排行", () => {
    const report = buildReport(parseRows(DAILY_REPORT_CSV), "抖音");
    expect(report.trend.map(item => item.date)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    expect(report.bars[0].name).toBe("夏季大促");
    expect(report.bars[0].value).toBeCloseTo(14400, 2);
  });

  it("空数据返回全 0 且不抛异常", () => {
    const report = buildReport([], "自动识别");
    expect(report.totals).toEqual({ cost: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 });
    expect(report.indicators).toEqual({ ctr: 0, cpc: 0, conversionRate: 0, roas: 0 });
    expect(report.cleaning.usedRows).toBe(0);
  });
});
