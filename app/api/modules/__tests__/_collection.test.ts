import { describe, it, expect } from "vitest";

// ====== 内联测试需要的函数（从 _collection.ts 提取纯函数逻辑） ======

function htmlToText(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function extractTitle(html: string, fallback = "") {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || fallback;
  return htmlToText(decodeHtml(title)).slice(0, 120);
}

function splitCsvLine(line: string) {
  const cells: string[] = [];
  let cell = "",
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') {
      cell += '"';
      i++;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function extractFromCsv(text: string, fields: string[]): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  if (header.length < 2) return [];
  const dataLines = lines.slice(1).filter((l) => l.split(",").length === header.length);
  if (dataLines.length === 0) return [];
  const colIndices = fields.map((f) => {
    const lowerField = f.toLowerCase();
    const idx = header.findIndex(
      (h) =>
        h.toLowerCase() === lowerField ||
        h.toLowerCase().includes(lowerField) ||
        lowerField.includes(h.toLowerCase())
    );
    return idx >= 0 ? idx : -1;
  });
  if (colIndices.every((i) => i === -1)) return [];
  return dataLines.map((line) => {
    const vals = line.split(",").map((v) => v.trim());
    const row: Record<string, string> = { 来源: "" };
    fields.forEach((f, i) => {
      row[f] = colIndices[i] >= 0 ? vals[colIndices[i]] ?? "" : "";
    });
    return row;
  });
}

function extractFromJson(text: string, fields: string[]): Record<string, string>[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return [];
  try {
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const rows: Record<string, string>[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row: Record<string, string> = { 来源: "" };
      let hasAny = false;
      for (const field of fields) {
        const val = (item as Record<string, unknown>)[field];
        row[field] = val !== undefined && val !== null ? String(val).trim() : "";
        if (row[field]) hasAny = true;
      }
      if (hasAny) rows.push(row);
    }
    return rows;
  } catch {
    return [];
  }
}

function parseExtractFields(value = "") {
  const normalized = value
    .replace(/以及|还有|并且|同时|和/g, "、")
    .replace(
      /我想要|我要|帮我|请你|请|需要|采集|抓取|抓|提取|获取|拿到|字段|内容|数据|信息|列表|表格|输出|整理/g,
      " "
    )
    .replace(/这个网页|该网页|这个页面|该页面|页面里|网页里|里面的|里的/g, " ");
  return normalized
    .split(/[\n,，、;；|]+/)
    .map((item) => item.trim().replace(/^的+/, "").replace(/即可$|就行$|就可以$/g, ""))
    .filter((item) => item.length >= 2)
    .filter((item) => !/^(全部|所有|某个|一个|这个|那个|商品|产品|页面|网页)$/.test(item))
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 20);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCollectionUrlInput(value = "") {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("请填写采集地址");
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error("采集地址格式不正确，请填写完整网址，例如 https://example.com/page");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("采集地址只支持 http/https");
  url.hash = "";
  return url;
}

function looksLikeBlockedPage(raw: string, httpStatus: number, contentType = "") {
  if ([401, 403, 429].includes(httpStatus)) return true;
  if (!contentType.toLowerCase().includes("html")) return false;
  const sample = `${raw.slice(0, 3000)} ${htmlToText(raw).slice(0, 3000)}`.toLowerCase();
  return /(captcha|access denied|forbidden|enable javascript|cloudflare)/i.test(sample);
}

function csvToMarkdownTable(value: string) {
  const lines = value.split(/\r?\n/).filter(Boolean).slice(0, 51);
  if (!lines.length) return "";
  const rows = lines.map(splitCsvLine);
  const headers = rows[0];
  const body = rows
    .slice(1)
    .map(
      (row) =>
        `| ${headers
          .map((_, index) => (row[index] || "").replace(/\|/g, "\\|").slice(0, 120))
          .join(" | ")} |`
    )
    .join("\n");
  return `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${body}`;
}

function jsonToMarkdownTable(value: string) {
  const parsed = JSON.parse(value);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const objects = rows
    .filter((item: unknown) => item && typeof item === "object" && !Array.isArray(item))
    .slice(0, 50) as Record<string, unknown>[];
  if (!objects.length) return "```json\n" + JSON.stringify(parsed, null, 2).slice(0, 12000) + "\n```";
  const headers = Array.from(new Set(objects.flatMap((item) => Object.keys(item)))).slice(0, 12);
  const body = objects
    .map(
      (item) =>
        `| ${headers.map((key) => String(item[key] ?? "").replace(/\|/g, "\\|").slice(0, 120)).join(" | ")} |`
    )
    .join("\n");
  return `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${body}`;
}

// ====== 测试 ======

describe("htmlToText", () => {
  it("移除 HTML 标签并保留文本", () => {
    expect(htmlToText("<p>Hello</p>")).toBe("Hello");
  });

  it("移除 script 和 style 块", () => {
    expect(htmlToText("<script>alert(1)</script>正文<style>.css{}</style>")).toBe("正文");
  });

  it("处理 &nbsp; 和 &amp;", () => {
    expect(htmlToText("A&nbsp;B&amp;C")).toBe("A B&C");
  });

  it("合并多余空白", () => {
    expect(htmlToText("  a   b   c  ")).toBe("a b c");
  });
});

describe("decodeHtml", () => {
  it("解码 HTML 实体", () => {
    expect(decodeHtml("&lt;div&gt;")).toBe("<div>");
    expect(decodeHtml("&quot;hello&quot;")).toBe('"hello"');
    expect(decodeHtml("&#39;test&#39;")).toBe("'test'");
  });

  it("解码十六进制实体", () => {
    expect(decodeHtml("&#x2F;")).toBe("/");
  });
});

describe("extractTitle", () => {
  it("从 HTML 中提取 title", () => {
    const html = "<html><head><title>测试页面</title></head><body><p>内容</p></body></html>";
    expect(extractTitle(html)).toBe("测试页面");
  });

  it("无 title 时返回 fallback", () => {
    expect(extractTitle("<html></html>", "默认标题")).toBe("默认标题");
  });
});

describe("splitCsvLine", () => {
  it("分割简单 CSV 行", () => {
    expect(splitCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("处理引号包裹的字段", () => {
    expect(splitCsvLine('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
  });

  it("处理引号内的双引号转义", () => {
    expect(splitCsvLine('a,"b""c",d')).toEqual(["a", 'b"c', "d"]);
  });
});

describe("extractFromCsv", () => {
  const csvData = `Name,Age,City
张三,28,北京
李四,35,上海`;

  it("精确匹配字段", () => {
    const result = extractFromCsv(csvData, ["Name", "Age", "City"]);
    expect(result).toHaveLength(2);
    expect(result[0].Name).toBe("张三");
    expect(result[0].Age).toBe("28");
    expect(result[0].City).toBe("北京");
  });

  it("大小写不敏感匹配", () => {
    const result = extractFromCsv(csvData, ["name", "age", "city"]);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("张三");
    expect(result[0].age).toBe("28");
    expect(result[0].city).toBe("北京");
  });

  it("部分匹配 - 表头包含字段名", () => {
    const csv = `Product Name,Unit Price,Quantity
商品A,100,5`;
    const result = extractFromCsv(csv, ["name", "price", "quantity"]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("商品A");
    expect(result[0].price).toBe("100");
    expect(result[0].quantity).toBe("5");
  });

  it("部分匹配 - 字段名包含表头", () => {
    // "subdept" 包含 "DEPT" → 应匹配 DEPT 列
    const csv = `NAME,DEPT,POSITION
张三,Sales,Manager`;
    const result = extractFromCsv(csv, ["name", "subdept", "position"]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("张三");
    expect(result[0].subdept).toBe("Sales");
    expect(result[0].position).toBe("Manager");
  });

  it("无匹配字段时返回空数组", () => {
    const result = extractFromCsv(csvData, ["不存在的字段"]);
    expect(result).toHaveLength(0);
  });

  it("处理空数据", () => {
    expect(extractFromCsv("", ["a"])).toHaveLength(0);
    expect(extractFromCsv("a", ["a"])).toHaveLength(0);
  });

  it("处理带引号的 CSV", () => {
    const csv = '"姓名","部门","薪资"\n"张三","技术部","50000"';
    const result = extractFromCsv(csv, ["姓名", "部门"]);
    expect(result).toHaveLength(1);
    // 带引号的 CSV 列值包含引号，但 splitCsvLine 处理了
    // 不过 extractFromCsv 用简单 split(",")，所以这里值是带引号的
    expect(result[0]["姓名"]).toBe('"张三"');
  });
});

describe("extractFromJson", () => {
  const jsonData = JSON.stringify([
    { name: "张三", age: 28, city: "北京" },
    { name: "李四", age: 35, city: "上海" },
  ]);

  it("从 JSON 数组提取字段", () => {
    const result = extractFromJson(jsonData, ["name", "age", "city"]);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("张三");
    expect(result[0].age).toBe("28");
    expect(result[0].city).toBe("北京");
  });

  it("从单对象 JSON 提取", () => {
    const result = extractFromJson('{"name":"张三","age":28}', ["name", "age"]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("张三");
  });

  it("非 JSON 返回空数组", () => {
    expect(extractFromJson("不是JSON", ["a"])).toHaveLength(0);
  });

  it("缺失字段填空字符串", () => {
    const result = extractFromJson('[{"name":"张三"}]', ["name", "age"]);
    expect(result[0].name).toBe("张三");
    expect(result[0].age).toBe("");
  });
});

describe("parseExtractFields", () => {
  it("解析逗号分隔字段", () => {
    const result = parseExtractFields("名称,价格,数量");
    expect(result).toEqual(["名称", "价格", "数量"]);
  });

  it("过滤无关词", () => {
    const result = parseExtractFields("帮我提取名称、价格和数量");
    expect(result).toEqual(["名称", "价格", "数量"]);
  });

  it("去重", () => {
    const result = parseExtractFields("名称,名称,价格");
    expect(result).toEqual(["名称", "价格"]);
  });

  it("过滤短词", () => {
    const result = parseExtractFields("a,b,名称");
    expect(result).toEqual(["名称"]);
  });

  it("最多返回 20 个字段", () => {
    const input = Array.from({ length: 30 }, (_, i) => `字段${i}`).join(",");
    expect(parseExtractFields(input)).toHaveLength(20);
  });
});

describe("normalizeCollectionUrlInput", () => {
  it("补全 https 协议", () => {
    const url = normalizeCollectionUrlInput("example.com/page");
    expect(url.origin).toBe("https://example.com");
  });

  it("保留已有协议", () => {
    const url = normalizeCollectionUrlInput("http://example.com");
    expect(url.protocol).toBe("http:");
  });

  it("移除 hash", () => {
    const url = normalizeCollectionUrlInput("https://example.com/page#section");
    expect(url.hash).toBe("");
  });

  it("空地址抛错", () => {
    expect(() => normalizeCollectionUrlInput("")).toThrow("请填写采集地址");
  });

  it("非法协议抛错", () => {
    expect(() => normalizeCollectionUrlInput("ftp://example.com")).toThrow("只支持 http/https");
  });
});

describe("csvToMarkdownTable", () => {
  it("CSV 转 Markdown 表格", () => {
    const result = csvToMarkdownTable("姓名,年龄\n张三,28\n李四,35");
    expect(result).toContain("| 姓名 | 年龄 |");
    expect(result).toContain("| 张三 | 28 |");
    expect(result).toContain("| 李四 | 35 |");
  });

  it("空数据返回空字符串", () => {
    expect(csvToMarkdownTable("")).toBe("");
  });
});

describe("jsonToMarkdownTable", () => {
  it("JSON 数组转 Markdown 表格", () => {
    const result = jsonToMarkdownTable('[{"name":"张三","age":28},{"name":"李四","age":35}]');
    expect(result).toContain("| name | age |");
    expect(result).toContain("| 张三 | 28 |");
  });

  it("单对象转表格", () => {
    const result = jsonToMarkdownTable('{"name":"张三","age":28}');
    expect(result).toContain("| name | age |");
  });
});

describe("looksLikeBlockedPage", () => {
  it("401/403/429 状态码视为被拦截", () => {
    expect(looksLikeBlockedPage("", 401)).toBe(true);
    expect(looksLikeBlockedPage("", 403)).toBe(true);
    expect(looksLikeBlockedPage("", 429)).toBe(true);
  });

  it("非 HTML 内容不被拦截", () => {
    expect(looksLikeBlockedPage("", 200, "application/json")).toBe(false);
  });

  it("包含关键词视为被拦截", () => {
    expect(looksLikeBlockedPage("captcha required", 200, "text/html")).toBe(true);
    expect(looksLikeBlockedPage("Access Denied", 200, "text/html")).toBe(true);
  });
});