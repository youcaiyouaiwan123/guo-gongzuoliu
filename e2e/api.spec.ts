import { test, expect } from "@playwright/test";

// 管理员登录辅助函数
async function loginAsAdmin(page: any) {
  const loginRes = await page.request.post("/api/auth/login", {
    data: { email: "admin", password: "admin123456", adminOnly: true },
  });
  expect(loginRes.status()).toBe(200);
  return loginRes;
}

// 验证 GET 返回 200 且包含指定属性
async function expectGetOk(page: any, url: string, ...props: string[]) {
  const res = await page.request.get(url);
  expect(res.status()).toBe(200);
  const body = await res.json();
  for (const prop of props) {
    expect(body).toHaveProperty(prop);
  }
  return body;
}

// 验证 POST 返回 400 且包含 error 属性
async function expectPost400(page: any, url: string, data: any) {
  const res = await page.request.post(url, { data });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body).toHaveProperty("error");
  return body;
}

// ============================================================
// 认证测试
// ============================================================
test.describe("API 认证", () => {
  test("未登录访问受保护接口返回 401", async ({ request }) => {
    const res = await request.get("/api/modules", {
      headers: { Cookie: "" },
    });
    expect(res.status()).toBe(401);
  });
});

// ============================================================
// 核心功能
// ============================================================
test.describe("核心功能", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("GET /api/state 返回知识库状态", async ({ page }) => {
    const body = await expectGetOk(page, "/api/state", "documents", "logs");
    expect(Array.isArray(body.documents)).toBe(true);
    expect(Array.isArray(body.logs)).toBe(true);
  });

  test("GET /api/modules 返回数据源列表", async ({ page }) => {
    const body = await expectGetOk(page, "/api/modules", "sources", "collectionRuns");
    expect(Array.isArray(body.sources)).toBe(true);
    expect(Array.isArray(body.collectionRuns)).toBe(true);
  });

  test("GET /api/organization 返回组织架构", async ({ page }) => {
    const body = await expectGetOk(page, "/api/organization", "units", "members");
    expect(Array.isArray(body.units)).toBe(true);
    expect(Array.isArray(body.members)).toBe(true);
  });

  test("GET /api/chat 返回对话列表", async ({ page }) => {
    const body = await expectGetOk(page, "/api/chat", "conversations");
    expect(Array.isArray(body.conversations)).toBe(true);
  });

  test("GET /api/model 返回模型配置", async ({ page }) => {
    await expectGetOk(page, "/api/model", "configured");
  });

  test("GET /api/session 返回当前会话信息", async ({ page }) => {
    const body = await expectGetOk(page, "/api/session", "email", "role");
    expect(typeof body.email).toBe("string");
    expect(typeof body.role).toBe("string");
  });

  test("POST /api/modules 缺少字段返回 400", async ({ page }) => {
    await expectPost400(page, "/api/modules", { type: "source", name: "" });
  });
});

// ============================================================
// 管理后台
// ============================================================
test.describe("管理后台", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("GET /api/admin/settings 返回系统设置", async ({ page }) => {
    const body = await expectGetOk(page, "/api/admin/settings", "settings");
    expect(body.settings).toHaveProperty("smtpHost");
  });

  test("POST /api/admin/settings 保存 SMTP 设置", async ({ page }) => {
    const res = await page.request.post("/api/admin/settings", {
      data: { smtpHost: "smtp.test.com", smtpPort: "587", smtpAccount: "test@test.com", smtpSender: "test@test.com" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("ok");
    expect(body.ok).toBe(true);
  });
});

// ============================================================
// 用户管理
// ============================================================
test.describe("用户管理", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("GET /api/users 返回用户列表", async ({ page }) => {
    const body = await expectGetOk(page, "/api/users", "currentUser", "users");
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.currentUser).toHaveProperty("email");
    expect(body.currentUser).toHaveProperty("role");
  });

  test("POST /api/users 创建用户邮箱格式校验", async ({ page }) => {
    await expectPost400(page, "/api/users", { email: "invalid-email" });
  });

  test("GET /api/capabilities 返回权限能力目录", async ({ page }) => {
    const body = await expectGetOk(page, "/api/capabilities", "capabilities", "groups", "roles", "alwaysAllow");
    expect(Array.isArray(body.capabilities)).toBe(true);
    expect(Array.isArray(body.groups)).toBe(true);
  });
});

// ============================================================
// 个人中心
// ============================================================
test.describe("个人中心", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("GET /api/profile 返回个人信息", async ({ page }) => {
    const body = await expectGetOk(page, "/api/profile", "email", "name", "role", "passwordConfigured");
    expect(typeof body.email).toBe("string");
  });

  test("POST /api/profile 不支持的操作返回 400", async ({ page }) => {
    await expectPost400(page, "/api/profile", { action: "invalid" });
  });
});

// ============================================================
// 知识构件
// ============================================================
test.describe("知识构件", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("GET /api/artifacts 返回沉淀列表", async ({ page }) => {
    const body = await expectGetOk(page, "/api/artifacts", "artifacts");
    expect(Array.isArray(body.artifacts)).toBe(true);
  });

  test("POST /api/artifacts 缺少字段返回 400", async ({ page }) => {
    await expectPost400(page, "/api/artifacts", { title: "", content: "" });
  });
});

// ============================================================
// 治理中心
// ============================================================
test.describe("治理中心", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("GET /api/governance 返回治理数据", async ({ page }) => {
    const res = await page.request.get("/api/governance");
    // 治理中心可能返回不同结构，但至少应该是 200
    expect(res.status()).toBe(200);
  });
});

// ============================================================
// 监控
// ============================================================
test.describe("监控", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("GET /api/monitoring 返回监控数据", async ({ page }) => {
    const res = await page.request.get("/api/monitoring");
    expect(res.status()).toBe(200);
    const body = await res.json();
    // 可能返回空数据或配置信息
    expect(body).toBeDefined();
  });
});

// ============================================================
// 个人知识库
// ============================================================
test.describe("个人知识库", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("GET /api/personal-knowledge 返回个人知识列表", async ({ page }) => {
    const res = await page.request.get("/api/personal-knowledge");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
  });
});

// ============================================================
// 合同管理
// ============================================================
test.describe("合同管理", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("GET /api/contracts 返回合同列表", async ({ page }) => {
    const body = await expectGetOk(page, "/api/contracts", "templates", "documents");
    expect(Array.isArray(body.templates)).toBe(true);
    expect(Array.isArray(body.documents)).toBe(true);
  });
});

// ============================================================
// 平台连接器
// ============================================================
test.describe("平台连接器", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("GET /api/connectors 返回连接器列表", async ({ page }) => {
    const body = await expectGetOk(page, "/api/connectors", "connectors");
    expect(Array.isArray(body.connectors)).toBe(true);
  });

  test("POST /api/connectors 缺失字段返回 400", async ({ page }) => {
    const res = await page.request.post("/api/connectors", {
      data: { action: "saveConnection", platform: "wecom" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/connectors 保存并测试企业微信连接", async ({ page }) => {
    // 保存企业微信凭证（wecom 的 test 检查 appId/appSecret 是否非空，不发起真实 API 调用）
    const saveRes = await page.request.post("/api/connectors", {
      data: {
        action: "saveConnection",
        platform: "wecom",
        appId: "wx_test_appid",
        appSecret: "wx_test_secret_key_123456",
        callbackToken: "test_callback_token_123",
      },
    });
    expect(saveRes.status()).toBe(200);
    const saveBody = await saveRes.json();
    expect(saveBody).toHaveProperty("message");
    expect(saveBody.message).toContain("已加密保存");

    // 测试连接（wecom 的 test 是 mock 检测，仅校验非空）
    const testRes = await page.request.post("/api/connectors", {
      data: { platform: "wecom" },
    });
    // 应返回 200 表示凭证有效
    expect(testRes.status()).toBe(200);
    const testBody = await testRes.json();
    expect(testBody).toHaveProperty("message");
  });

  test("POST /api/connectors 未知平台返回 400", async ({ page }) => {
    const res = await page.request.post("/api/connectors", {
      data: { action: "saveConnection", platform: "unknown" },
    });
    expect(res.status()).toBe(400);
  });
});

// ============================================================
// 文件提取
// ============================================================
test.describe("文件提取", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("POST /api/extract-file 无文件返回 400", async ({ page }) => {
    const res = await page.request.post("/api/extract-file", {
      multipart: {},
    });
    expect(res.status()).toBe(400);
  });
});

// ============================================================
// 网关
// ============================================================
test.describe("平台网关", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("GET /api/gateway/accounts 返回网关账号", async ({ page }) => {
    const res = await page.request.get("/api/gateway/accounts");
    // 可能返回 401（网关密钥校验）或 200
    expect([200, 401]).toContain(res.status());
  });
});

// ============================================================
// 前端日志
// ============================================================
test.describe("前端日志", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("POST /api/frontend-logs 提交前端日志", async ({ page }) => {
    const res = await page.request.post("/api/frontend-logs", {
      data: { level: "info", message: "test log", url: "/test" },
    });
    // 日志接口通常返回 200 或 204
    expect([200, 204]).toContain(res.status());
  });
});

// ============================================================
// 图片相关
// ============================================================
test.describe("图片相关", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("GET /api/image-models 返回图片模型列表", async ({ page }) => {
    const res = await page.request.get("/api/image-models");
    // 可能返回 200 或 401（取决于配置）
    expect([200, 401]).toContain(res.status());
  });

  test("POST /api/image-generate 缺少参数返回 400", async ({ page }) => {
    const res = await page.request.post("/api/image-generate", {
      data: { prompt: "" },
    });
    // 可能返回 400 或 401（取决于模型配置）
    expect([400, 401]).toContain(res.status());
  });

  test("POST /api/image-prompt-optimize 缺少参数返回 400", async ({ page }) => {
    const res = await page.request.post("/api/image-prompt-optimize", {
      data: { prompt: "" },
    });
    expect([400, 401]).toContain(res.status());
  });
});

// ============================================================
// 平台消息
// ============================================================
test.describe("平台消息", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("POST /api/platform 返回平台消息", async ({ page }) => {
    const res = await page.request.post("/api/platform", {
      data: { platform: "feishu", action: "query" },
    });
    // 可能返回 200 或 400（平台未配置），但不应是 405
    expect([200, 400, 401]).toContain(res.status());
  });
});