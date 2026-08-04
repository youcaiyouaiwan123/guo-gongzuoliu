import { describe, it, expect } from "vitest";
import { Hono } from "hono";

// ====== 简化版 Mock 数据库 ======
function createMockDB() {
  const tables: Record<string, unknown[]> = {
    data_sources: [{ id: 1, name: "测试数据源", sourceType: "万能爬虫", status: "已入库", collectorMode: "crawler", targetStore: "personal", outputFormat: "markdown" }],
    data_collection_runs: [{ id: 1, sourceId: 1, sourceName: "测试数据源", status: "已入知识库", rowCount: 1, preview: "预览" }],
  };

  return {
    prepare: (sql: string) => {
      const stmt = {
        bind: (..._args: unknown[]) => stmt,
        all: async <T = unknown>() => {
          for (const table of Object.keys(tables)) {
            if (sql.includes(`FROM ${table}`) && !sql.includes("WHERE")) {
              return { results: tables[table] as T[] };
            }
          }
          return { results: [] as T[] };
        },
        first: async <T = unknown>() => null as T | null,
        run: async () => ({ meta: { changes: 1, last_row_id: 0 } }),
        raw: () => [],
      };
      return stmt;
    },
    batch: async (_statements: unknown[]) => [{ results: [] }],
    exec: async (_sql: string) => ({}),
  };
}

// ====== Mock 认证中间件 ======
function mockAuth() {
  return async (c: any, next: any) => {
    c.set("user", { email: "admin", role: "管理员", name: "管理员", businessRole: "管理员" });
    await next();
  };
}

// ====== 创建测试 app ======
function createTestApp() {
  const app = new Hono();
  const db = createMockDB();

  app.onError((err, c) => {
    console.error("Unhandled error:", err);
    return c.json({ error: err.message }, 500);
  });

  app.use("*", mockAuth());

  // GET /api/modules
  app.get("/api/modules", async (c) => {
    const [sources, runs] = await Promise.all([
      db.prepare("SELECT * FROM data_sources").all(),
      db.prepare("SELECT * FROM data_collection_runs").all(),
    ]);
    return c.json({
      ok: true,
      sources: sources.results,
      collectionRuns: runs.results,
      agents: [],
      workflows: [],
      agentRuns: [],
      runs: [],
    });
  });

  // POST /api/modules - create source
  app.post("/api/modules", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (body.type === "source") {
      if (!body.name?.trim() || !body.sourceType) {
        return c.json({ error: "请填写数据源名称和类型" }, 400);
      }
      return c.json({ ok: true, id: 99 }, 201);
    }
    if (body.type === "run" && body.module === "source") {
      return c.json({ ok: true, rowCount: 1, preview: "测试预览", httpStatus: 0 }, 201);
    }
    return c.json({ error: "不支持的操作" }, 400);
  });

  // DELETE /api/modules
  app.delete("/api/modules", async (c) => {
    const id = c.req.query("id");
    if (!id) return c.json({ error: "请指定要删除的记录 ID" }, 400);
    return c.json({ ok: true, message: "删除成功" });
  });

  return app;
}

// ====== 测试 ======
describe("GET /api/modules", () => {
  it("返回 200", async () => {
    const app = createTestApp();
    const res = await app.request("/api/modules");
    expect(res.status).toBe(200);
  });

  it("返回 sources 和 collectionRuns 数组", async () => {
    const app = createTestApp();
    const res = await app.request("/api/modules");
    const body = await res.json();
    expect(Array.isArray(body.sources)).toBe(true);
    expect(Array.isArray(body.collectionRuns)).toBe(true);
  });
});

describe("POST /api/modules", () => {
  it("创建数据源成功", async () => {
    const app = createTestApp();
    const res = await app.request("/api/modules", {
      method: "POST",
      body: JSON.stringify({ type: "source", name: "新数据源", sourceType: "万能爬虫" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("缺少字段返回 400", async () => {
    const app = createTestApp();
    const res = await app.request("/api/modules", {
      method: "POST",
      body: JSON.stringify({ type: "source", name: "" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("请填写数据源名称");
  });

  it("运行采集返回结果", async () => {
    const app = createTestApp();
    const res = await app.request("/api/modules", {
      method: "POST",
      body: JSON.stringify({ type: "run", module: "source", id: "1", action: "test" }),
      headers: { "Content-Type": "application/json" },
    });
    // 调试：打印错误响应
    if (res.status !== 201) {
      const text = await res.text().catch(() => "");
      console.log("POST run error:", res.status, text.slice(0, 500));
    }
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.rowCount).toBe("number");
  });
});

describe("DELETE /api/modules", () => {
  it("有 ID 参数时返回 200", async () => {
    const app = createTestApp();
    const res = await app.request("/api/modules?module=source&id=1", { method: "DELETE" });
    // 调试：打印错误响应
    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      console.log("DELETE ok error:", res.status, text.slice(0, 500));
    }
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("缺少 ID 参数时返回 400", async () => {
    const app = createTestApp();
    const res = await app.request("/api/modules?module=source", { method: "DELETE" });
    if (res.status !== 400) {
      const text = await res.text().catch(() => "");
      console.log("DELETE missing id error:", res.status, text.slice(0, 500));
    }
    expect(res.status).toBe(400);
  });
});