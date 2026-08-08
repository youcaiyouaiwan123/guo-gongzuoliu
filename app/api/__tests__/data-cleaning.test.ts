import { describe, expect, it } from "vitest";

// CollectionPanel 清洗逻辑的行为验证（从组件源码提取纯函数，避免改动组件结构）。

const WHITESPACE = "[ \\t\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";

function maskSensitive(input: string) {
  let text = input
    .replace(/(\+?86[-\s]?)(1[3-9]\d)[-\s]?(\d{4})[-\s]?(\d{4})(?!\d)/g, (_p, pre, a, _sep, d) => `${pre}${a}****${d}`)
    .replace(/(?<![\d+])(1[3-9]\d)[-\s](\d{4})[-\s](\d{4})(?!\d)/g, "$1****$3")
    .replace(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, "$1****$2");
  return text
    .replace(/(?<![\dXx])(\d{6})\d{8}(\d{3}[\dXx])(?![\dXx])/g, "$1********$2")
    .replace(/(?<!\d)(\d{6})\d{6}(\d{3})(?!\d)/g, "$1******$2")
    .replace(/([\w.+-]{1,2})[\w.+-]*(@[\w.-]+\.[A-Za-z]{2,})/g, "$1***$2")
    .replace(/(?<!\d)(\d{4})\d{8,11}(\d{4})(?!\d)/g, "$1********$2");
}

function clean(text: string, rules: string[]): string {
  if (rules.includes("html")) {
    text = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"");
  }
  if (rules.includes("format")) {
    text = text.replace(/[，；：]/g, m => ({ "，": ",", "；": ";", "：": ":" }[m] || m))
      .replace(/(\d{4})[/.年-](\d{1,2})[/.月-](\d{1,2})日?/g, (_y, y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (rules.includes("trim")) {
    const edge = new RegExp(`^${WHITESPACE}+|${WHITESPACE}+$`, "g");
    const inner = new RegExp(`${WHITESPACE}{2,}`, "g");
    lines = lines.map(l => l.replace(edge, "").replace(inner, " "));
  }
  if (rules.includes("blank")) {
    const blank = new RegExp(`^${WHITESPACE}*$`);
    lines = lines.filter(l => !blank.test(l) && !/^(null|undefined|n\/a|nan|无|-)$/i.test(l.trim()));
  }
  if (rules.includes("dedupe")) {
    const seen = new Set<string>();
    lines = lines.filter(l => {
      const key = l
        .replace(new RegExp(WHITESPACE, "g"), "")
        .replace(/(1[3-9]\d)[-](\d{4})[-](\d{4})/g, "$1$2$3")
        .toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  text = lines.join("\n");
  if (rules.includes("mask")) text = maskSensitive(text);
  return text;
}

describe("① 手机号脱敏覆盖各种写法", () => {
  it("纯 11 位手机号", () => expect(maskSensitive("联系13812345678")).toBe("联系138****5678"));
  it("CSV 中紧贴逗号的手机号列", () => expect(maskSensitive("张三,13812345678,北京")).toBe("张三,138****5678,北京"));
  it("带横线分隔符", () => expect(maskSensitive("138-1234-5678")).toBe("138****5678"));
  it("带空格分隔符", () => expect(maskSensitive("138 1234 5678")).toBe("138****5678"));
  it("带 +86 前缀（旧实现漏掉）", () => expect(maskSensitive("+8613812345678")).toBe("+86138****5678"));
  it("带 86 前缀无加号", () => expect(maskSensitive("8613912345678")).toBe("86139****5678"));
  it("一行多个手机号全部脱敏", () => expect(maskSensitive("13812345678 和 13987654321")).toBe("138****5678 和 139****4321"));
  it("非手机号的 11 位数字不误伤", () => expect(maskSensitive("12345678901")).toBe("12345678901"));
  it("身份证与邮箱同时脱敏", () => expect(maskSensitive("110101199003074567 zhangsan@example.com")).toBe("110101********4567 zh***@example.com"));
});

describe("② 首尾空格清净", () => {
  it("清掉全角空格 U+3000", () => expect(clean("　订单编号　", ["trim"])).toBe("订单编号"));
  it("清掉不换行空格 U+00A0", () => expect(clean(" 数据 ", ["trim"])).toBe("数据"));
  it("混合空白全部清掉", () => expect(clean(" \t　 内容　\t ", ["trim"])).toBe("内容"));
  it("中间连续全角空格压成一个半角空格", () => expect(clean("姓名　　　电话", ["trim"])).toBe("姓名 电话"));
  it("只含全角空格的行被判为空行删除", () => expect(clean("A\n　　\nB", ["blank"])).toBe("A\nB"));
});

describe("③ 清标签与去空格顺序正确", () => {
  it("标签替换出的空格被随后的 trim 收拾干净", () => expect(clean("<p>  标题  </p>", ["html", "trim"])).toBe("标题"));
  it("标签造成的空行被删除", () => expect(clean("<div>\n<span></span>\n正文</div>", ["html", "trim", "blank"])).toBe("正文"));
  it("HTML 实体被还原", () => expect(clean("<p>A&nbsp;&amp;&nbsp;B</p>", ["html", "trim"])).toBe("A & B"));
  it("script/style 内容整块移除", () => expect(clean("<style>.a{color:red}</style><p>正文</p><script>x=1</script>", ["html", "trim"])).toBe("正文"));
  it("标准化在去重之前：只差全角逗号的重复行被去掉", () => expect(clean("张三，北京\n张三,北京", ["format", "dedupe"])).toBe("张三,北京"));
  it("标准化在去重之前：只差日期格式的重复行被去掉", () => expect(clean("2024年3月7日\n2024/03/07", ["format", "dedupe"])).toBe("2024-03-07"));
  it("去重忽略空白差异", () => expect(clean("A　B\nA B", ["dedupe"])).toBe("A　B"));
  it("完整链路：清标签→标准化→去空格→删空行→去重→脱敏", () => {
    expect(clean("<p>　张三，13812345678　</p>\n<p>张三,138-1234-5678</p>\n<div></div>", ["html", "format", "trim", "blank", "dedupe", "mask"])).toBe("张三,138****5678");
  });
});

describe("源码防回归", () => {
  it("format 规则出现在 dedupe 之前", () => {
    const src = require("node:fs").readFileSync("app/features/collection/CollectionPanel.tsx", "utf8");
    expect(src.indexOf('cleaningRules.includes("format")')).toBeLessThan(src.indexOf('cleaningRules.includes("dedupe")'));
    expect(src.indexOf('cleaningRules.includes("html")')).toBeLessThan(src.indexOf('cleaningRules.includes("trim")'));
  });
});
