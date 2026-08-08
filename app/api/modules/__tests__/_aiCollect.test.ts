import { describe, it, expect, vi, beforeEach } from "vitest";

// 用可记录的 _shared 桩覆盖 tests/setup.ts 里的全局桩：
// 这里要断言的正是"到底往 data_collection_runs 写了什么"，默认桩的 first() 返回 null，拿不到 RETURNING id。
const state = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  audits: [] as Array<{ action: string; resource: string; result: string; detail: string }>,
  skillsResult: { text: "", toolCalls: [] as unknown[] },
  skillsError: null as Error | null,
}));

vi.mock("../_shared", () => {
  function statement(sql: string, params: unknown[] = []) {
    const record = () => state.calls.push({ sql, params });
    return {
      bind: (...args: unknown[]) => statement(sql, args),
      first: async () => { record(); return { id: 4242 }; },
      run: async () => { record(); return { meta: { changes: 1 } }; },
      all: async () => ({ results: [] }),
    };
  }
  return {
    runtime: { DB: { prepare: (sql: string) => statement(sql), batch: async () => [] }, COLLECTOR_PROXY_URL: "" },
    ensureSchema: async () => {},
    askModel: async () => "",
    askModelWithImages: async () => "",
    audit: async (_actor: string, action: string, resource: string, result: string, detail: string) => {
      state.audits.push({ action, resource, result, detail });
    },
    askModelWithSkills: async () => {
      if (state.skillsError) throw state.skillsError;
      return state.skillsResult;
    },
  };
});

const { collectWithAI } = await import("../_collection");

const RUN_INSERT = "INSERT INTO data_collection_runs";

function insertOf(status: "成功" | "失败") {
  const call = state.calls.find(item =>
    item.sql.startsWith(RUN_INSERT) && (status === "失败" ? item.sql.includes(",error,") : item.sql.includes(",preview,")),
  );
  return call?.params;
}

beforeEach(() => {
  state.calls = [];
  state.audits = [];
  state.skillsResult = { text: "", toolCalls: [] };
  state.skillsError = null;
});

describe("AI 采集结果落库", () => {
  it("成功时写入一条待确认的采集记录并返回 runId", async () => {
    state.skillsResult = { text: "# 采集结果\n\n正文若干", toolCalls: [{}, {}, {}] };

    const result = await collectWithAI("her@example.com", "采集某站点的公告", { url: "https://example.com" });

    expect(result.runId).toBe(4242);
    expect(result.status).toBe("已采集");

    const params = insertOf("成功")!;
    expect(params[0]).toBe(0);                       // source_id 哨兵
    expect(params[1]).toContain("采集某站点的公告");   // source_name
    expect(params[2]).toBe("her@example.com");       // actor
    expect(params[3]).toBe("已采集");                 // status：走确认入库，不直接进知识库
    expect(params[6]).toBe("text/ai-collect");       // content_type
    expect(params[7]).toBe("# 采集结果\n\n正文若干"); // preview
    expect(params[8]).toContain("调用3次工具");        // model_used 留住工具调用次数
    expect(params[11]).toBe("ai");                   // collector_mode
    expect(params[13]).toBeNull();                   // published_at：尚未入库
  });

  it("过长的采集需求在记录名里被截断", async () => {
    state.skillsResult = { text: "正文", toolCalls: [] };

    await collectWithAI("her@example.com", "很长的需求".repeat(20));

    const name = String(insertOf("成功")![1]);
    expect(name.startsWith("AI采集：")).toBe(true);
    expect(name.endsWith("…")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(50);
  });

  it("输出是 Markdown 表格时按数据行数记 row_count", async () => {
    state.skillsResult = {
      text: "| 名称 | 星标 |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n| c | 3 |\n\n以上。",
      toolCalls: [{}],
    };

    await collectWithAI("her@example.com", "采集仓库列表");

    expect(insertOf("成功")![5]).toBe(3);
  });

  it("输出不是表格时 row_count 记 0，不拿字数冒充条数", async () => {
    state.skillsResult = { text: "一段普通的说明文字，没有表格。", toolCalls: [{}] };

    await collectWithAI("her@example.com", "随便采点什么");

    expect(insertOf("成功")![5]).toBe(0);
  });

  it("模型没产出内容时报错，并落一条失败记录", async () => {
    state.skillsResult = { text: "   \n  ", toolCalls: [] };

    await expect(collectWithAI("her@example.com", "采集空内容")).rejects.toThrow("未产出可入库的内容");

    // 没有写成功记录，只写了失败记录。
    expect(insertOf("成功")).toBeUndefined();
    const params = insertOf("失败")!;
    expect(params[0]).toBe(0);
    expect(params[3]).toBe("失败");
    expect(String(params[5])).toContain("未产出可入库的内容");
    expect(params[9]).toBe("ai");
  });

  it("模型调用失败时同样落库，错误信息原样透传", async () => {
    state.skillsError = new Error("尚未配置模型API，请先到“模型接入”填写自己的API");

    await expect(collectWithAI("her@example.com", "采集点东西")).rejects.toThrow("尚未配置模型API");

    expect(String(insertOf("失败")![5])).toContain("尚未配置模型API");
    expect(state.audits.at(-1)).toMatchObject({ action: "AI驱动采集", result: "失败" });
  });

  it("审计明细里带上采集记录号，便于和运行记录对上", async () => {
    state.skillsResult = { text: "正文", toolCalls: [{}, {}] };

    await collectWithAI("her@example.com", "采集公告");

    expect(state.audits.at(-1)).toMatchObject({ action: "AI驱动采集", result: "成功" });
    expect(state.audits.at(-1)!.detail).toContain("#4242");
    expect(state.audits.at(-1)!.detail).toContain("调用2次工具");
  });
});
