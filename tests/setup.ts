// 全局测试设置
// Cloudflare Workers 运行时依赖的全局变量 mock
import { vi } from "vitest";

// Mock Cloudflare 环境变量
process.env = {
  ...process.env,
  DEFAULT_ADMIN_USERNAME: "admin",
  DEFAULT_ADMIN_PASSWORD: "admin123456",
  HAIXIN_GATEWAY_ADMIN_SECRET: "test-secret",
};

// 全局 D1 数据库 mock
class MockD1Statement {
  private sql: string;
  private params: unknown[];
  private mockData: { results: unknown[] } = { results: [] };

  constructor(sql: string, params: unknown[]) {
    this.sql = sql;
    this.params = params;
  }

  bind(...args: unknown[]) {
    return new MockD1Statement(this.sql, args);
  }

  async run() {
    return { meta: { changes: 1, last_row_id: 1 } };
  }

  async all<T = unknown>() {
    return { results: [] as T[] };
  }

  async first<T = unknown>() {
    return null as T | null;
  }

  raw() {
    return [];
  }
}

export const mockDB = {
  prepare: (sql: string) => new MockD1Statement(sql, []),
  batch: async (statements: MockD1Statement[]) =>
    statements.map(() => ({ results: [] })),
  exec: async (_sql: string) => ({ results: [] }),
};

// 全局 runtime mock
vi.mock("../app/api/modules/_shared", () => ({
  runtime: {
    DB: mockDB,
    AI: {
      run: async () => ({ response: "" }),
    },
    COLLECTOR_PROXY_URL: "",
  },
  ensureSchema: async () => {},
  audit: async () => {},
  askModel: async () => "",
  askModelWithSkills: async () => ({ text: "", toolCalls: 0 }),
}));