import { describe, it, expect } from "vitest";
import { detectSeparator, looksLikeCsv, parseCsv, splitCsvLine, splitCsvRecords, stripBom } from "../_csv";

describe("detectSeparator", () => {
  it("识别逗号、制表符与分号", () => {
    expect(detectSeparator("a,b,c")).toBe(",");
    expect(detectSeparator("a\tb\tc")).toBe("\t");
    // 部分区域设置的 Excel 默认导出分号分隔
    expect(detectSeparator("a;b;c")).toBe(";");
  });

  it("没有分隔符时回退逗号", () => {
    expect(detectSeparator("单列")).toBe(",");
  });
});

describe("splitCsvLine", () => {
  it("引号内的分隔符不生效", () => {
    expect(splitCsvLine('张三,"北京市,朝阳区",30')).toEqual(["张三", "北京市,朝阳区", "30"]);
  });

  it('"" 表示一个字面量引号', () => {
    expect(splitCsvLine('a,"他说""你好""",c')).toEqual(["a", '他说"你好"', "c"]);
  });
});

describe("splitCsvRecords", () => {
  it("引号内的换行不会把一条记录拆成两条", () => {
    const records = splitCsvRecords('姓名,备注\n张三,"第一行\n第二行"\n李四,正常');
    expect(records).toHaveLength(3);
    expect(records[1]).toBe('张三,"第一行\n第二行"');
  });

  it("兼容 CRLF 并跳过空行", () => {
    expect(splitCsvRecords("a,b\r\n1,2\r\n\r\n3,4")).toEqual(["a,b", "1,2", "3,4"]);
  });
});

describe("stripBom", () => {
  it("去掉 UTF-8 BOM，避免首列表头带不可见字符匹配不上", () => {
    expect(stripBom("﻿日期")).toBe("日期");
  });
});

describe("parseCsv", () => {
  it("解析为对象数组", () => {
    expect(parseCsv("name,amount\n客户A,12000")).toEqual([{ name: "客户A", amount: "12000" }]);
  });

  it("表头缺失的列用列序号占位，不丢数据", () => {
    expect(parseCsv("name,\n客户A,备注")).toEqual([{ name: "客户A", 列2: "备注" }]);
  });
});

describe("looksLikeCsv", () => {
  it("列数一致的多行文本判定为表格", () => {
    expect(looksLikeCsv("日期,消耗,点击\n2026-07-01,100,20\n2026-07-02,200,40")).toBe(true);
    expect(looksLikeCsv("日期\t消耗\n2026-07-01\t100")).toBe(true);
  });

  it("普通含逗号的句子不会被误判", () => {
    expect(looksLikeCsv("今天天气不错，我们去公园，然后吃饭。\n明天再说。")).toBe(false);
    expect(looksLikeCsv("只有一行,两列")).toBe(false);
  });
});
