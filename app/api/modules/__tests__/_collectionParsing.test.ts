import { describe, it, expect } from "vitest";
import { invalidRequestHeaders, parseRequestHeaders, unwrapJsonRecords, validateOcrImages, MAX_OCR_IMAGES } from "../_collection";

// 截图识别的真实效果依赖视觉模型，在没有模型的环境里测不了；
// 但入参这几道闸门必须锁死，否则一张 20MB 的图或十张截图能直接打爆模型请求。
describe("validateOcrImages", () => {
  const png = (kb = 1) => `data:image/png;base64,${"A".repeat(kb * 1024)}`;

  it("接受 PNG / JPG / WebP", () => {
    for (const type of ["png", "jpeg", "jpg", "webp"]) {
      const result = validateOcrImages([`data:image/${type};base64,AAAA`]);
      expect(result, type).toHaveProperty("dataUrls");
    }
  });

  it("空输入与非数组都要求先选图", () => {
    for (const input of [[], undefined, null, "not-an-array", {}]) {
      expect(validateOcrImages(input)).toEqual({ error: "请先选择或粘贴截图。" });
    }
  });

  it("超过张数上限被拦下", () => {
    const result = validateOcrImages(Array.from({ length: MAX_OCR_IMAGES + 1 }, () => png()));
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain(`最多识别 ${MAX_OCR_IMAGES} 张`);
  });

  it("恰好达到上限仍然放行", () => {
    expect(validateOcrImages(Array.from({ length: MAX_OCR_IMAGES }, () => png()))).toHaveProperty("dataUrls");
  });

  it("非图片格式被拦下（PDF、SVG、外链）", () => {
    for (const bad of ["data:application/pdf;base64,AAAA", "data:image/svg+xml;base64,AAAA", "https://example.com/a.png", "", 123]) {
      expect(validateOcrImages([bad]), String(bad)).toHaveProperty("error");
    }
  });

  it("超过体积上限被拦下", () => {
    const result = validateOcrImages([png(8 * 1024)]);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("不能超过");
  });

  it("一批里只要有一张不合规就整批拒绝", () => {
    expect(validateOcrImages([png(), "data:application/pdf;base64,AAAA"])).toHaveProperty("error");
  });
});

describe("unwrapJsonRecords", () => {
  it("顶层就是对象数组时直接返回", () => {
    expect(unwrapJsonRecords([{ id: 1 }, { id: 2 }])).toHaveLength(2);
  });

  it("拆开 {code,data:{list}} 信封——国内接口的默认形状", () => {
    const payload = { code: 0, message: "ok", data: { total: 2, list: [{ 商品: "A" }, { 商品: "B" }] } };
    expect(unwrapJsonRecords(payload)?.map(item => item["商品"])).toEqual(["A", "B"]);
  });

  it("支持 data 直接是数组", () => {
    expect(unwrapJsonRecords({ code: 0, data: [{ id: 1 }] })).toHaveLength(1);
  });

  it("优先取 data/list 等业务字段，不会误取 meta 里的数组", () => {
    const payload = { meta: [{ page: 1 }], data: { records: [{ id: 9 }] } };
    expect(unwrapJsonRecords(payload)).toEqual([{ id: 9 }]);
  });

  it("纯标量数组不算明细", () => {
    expect(unwrapJsonRecords({ data: [1, 2, 3] })).toBeNull();
  });

  it("完全没有明细数组时返回 null", () => {
    expect(unwrapJsonRecords({ code: 500, message: "服务异常" })).toBeNull();
  });
});

describe("parseRequestHeaders", () => {
  it("解析每行 Key: Value", () => {
    expect(parseRequestHeaders("Authorization: Bearer abc\nX-Api-Key: k1")).toEqual({
      Authorization: "Bearer abc",
      "X-Api-Key": "k1",
    });
  });

  it("值里含冒号不会被截断", () => {
    expect(parseRequestHeaders("X-Trace: a:b:c")).toEqual({ "X-Trace": "a:b:c" });
  });

  it("忽略空行与缺少冒号的行", () => {
    expect(parseRequestHeaders("\n乱写一行\nAccept: application/json\n")).toEqual({ Accept: "application/json" });
  });

  it("拒绝由运行时管理的连接类请求头", () => {
    expect(parseRequestHeaders("Host: evil.com\nContent-Length: 10\nConnection: close\nX-Ok: 1")).toEqual({ "X-Ok": "1" });
  });

  it("丢弃含非 ASCII 值的头——网络层本来就会静默丢掉它们", () => {
    expect(parseRequestHeaders("Authorization: Bearer 我的密钥\nX-Ok: 1")).toEqual({ "X-Ok": "1" });
  });

  it("空输入返回空对象", () => {
    expect(parseRequestHeaders("")).toEqual({});
  });
});

describe("invalidRequestHeaders", () => {
  it("合法请求头没有问题项", () => {
    expect(invalidRequestHeaders("Authorization: Bearer abc-123\nX-Api-Key: k1")).toEqual([]);
    expect(invalidRequestHeaders("")).toEqual([]);
  });

  it("点名中文值——这是「配了鉴权仍然 401」的真实来源", () => {
    const problems = invalidRequestHeaders("Authorization: Bearer 我的密钥");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Authorization");
    expect(problems[0]).toContain("非 ASCII");
  });

  it("点名格式错误与保留头", () => {
    expect(invalidRequestHeaders("乱写一行")[0]).toContain("不是 Key: Value 格式");
    expect(invalidRequestHeaders("Host: evil.com")[0]).toContain("由系统管理");
  });
});
