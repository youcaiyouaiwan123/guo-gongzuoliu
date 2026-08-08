import { test, expect, type Page } from "@playwright/test";

// 管理员凭据取自 .env（由 playwright.config.ts 读入 process.env）。
// 写死密码会让 e2e 只能在某一套本地数据上跑通，换环境就是一片 401。
const ADMIN_USERNAME = process.env.DEFAULT_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || "admin123456";

// 管理员登录辅助函数
async function loginAsAdmin(page: Page) {
  const loginRes = await page.request.post("/api/auth/login", {
    data: { email: ADMIN_USERNAME, password: ADMIN_PASSWORD, adminOnly: true },
  });
  expect(loginRes.status(), "管理员登录失败：请确认 .env 里的 DEFAULT_ADMIN_USERNAME / DEFAULT_ADMIN_PASSWORD 与被测服务一致").toBe(200);
  return loginRes;
}

// 验证 GET 返回 200 且包含指定属性
async function expectGetOk(page: Page, url: string, ...props: string[]) {
  const res = await page.request.get(url);
  expect(res.status()).toBe(200);
  const body = await res.json();
  for (const prop of props) {
    expect(body).toHaveProperty(prop);
  }
  return body;
}

// 验证 POST 返回 400 且包含 error 属性
async function expectPost400(page: Page, url: string, data: Record<string, unknown>) {
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
// 组织架构：部门与员工
// ============================================================
// 用例之间有先后依赖（建部门 → 分配 → 移出），声明为串行执行。
test.describe.serial("组织架构员工管理", () => {
  // 用例自带清理，避免在开发库里留下测试部门。名称带随机后缀，重复执行不会互相冲突。
  const suffix = `${Date.now()}`;
  const unitName = `E2E测试部${suffix}`;
  const memberEmail = `e2e-member-${suffix}@example.com`;
  let unitId = 0;

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsAdmin(page);
    await page.request.post("/api/organization", { data: { action: "removeMember", email: memberEmail } });
    if (unitId) await page.request.delete(`/api/organization?id=${unitId}`);
    await page.close();
  });

  test("建部门 → 分配员工 → 员工出现在所属部门", async ({ page }) => {
    const created = await page.request.post("/api/organization", {
      data: { action: "createUnit", name: unitName, unitType: "部门" },
    });
    expect(created.status()).toBe(200);

    const afterCreate = await (await page.request.get("/api/organization")).json();
    unitId = afterCreate.units.find((unit: { name: string }) => unit.name === unitName)?.id;
    expect(unitId).toBeTruthy();

    const assigned = await page.request.post("/api/organization", {
      data: { action: "assignMember", email: memberEmail, unitId: String(unitId), jobTitle: "测试岗" },
    });
    expect(assigned.status()).toBe(200);

    const body = await (await page.request.get("/api/organization")).json();
    const member = body.members.find((item: { email: string }) => item.email === memberEmail);
    expect(member).toBeTruthy();
    expect(member.unitId).toBe(unitId);
    expect(member.unitName).toBe(unitName);
    expect(member.jobTitle).toBe("测试岗");
  });

  test("同一上级下建同名部门返回 409", async ({ page }) => {
    const res = await page.request.post("/api/organization", {
      data: { action: "createUnit", name: unitName, unitType: "部门" },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toContain("同名部门");
  });

  test("加空格的同名部门同样被拦截", async ({ page }) => {
    const res = await page.request.post("/api/organization", {
      data: { action: "createUnit", name: ` ${unitName} `, unitType: "部门" },
    });
    expect(res.status()).toBe(409);
  });

  test("有成员的部门不能直接删除", async ({ page }) => {
    const res = await page.request.delete(`/api/organization?id=${unitId}`);
    expect(res.status()).toBe(409);
  });

  test("移出部门后员工从组织架构中消失", async ({ page }) => {
    const removed = await page.request.post("/api/organization", {
      data: { action: "removeMember", email: memberEmail },
    });
    expect(removed.status()).toBe(200);

    const body = await (await page.request.get("/api/organization")).json();
    expect(body.members.find((item: { email: string }) => item.email === memberEmail)).toBeFalsy();
  });
});

// ============================================================
// 管理后台
// ============================================================
test.describe("管理后台", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  // settings 只回显 system_settings 里真实存在的行，全新库里就是个空对象。
  // 因此这里只断言接口形状，smtpHost 的断言放到"保存后读回"里，避免用例依赖执行顺序与历史数据。
  test("GET /api/admin/settings 返回系统设置", async ({ page }) => {
    const body = await expectGetOk(page, "/api/admin/settings", "settings");
    expect(typeof body.settings).toBe("object");
  });

  test("POST /api/admin/settings 保存 SMTP 设置后可读回", async ({ page }) => {
    const res = await page.request.post("/api/admin/settings", {
      data: { smtpHost: "smtp.test.com", smtpPort: "587", smtpAccount: "test@test.com", smtpSender: "test@test.com" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("ok");
    expect(body.ok).toBe(true);

    const saved = await expectGetOk(page, "/api/admin/settings", "settings");
    expect(saved.settings.smtpHost).toBe("smtp.test.com");
    expect(saved.settings.smtpPort).toBe("587");
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
    // 不再断言 alwaysAllow：早期 collect_data 被无条件放行，导致权限中心对它的设置失效，
    // 该豁免已在 _auth.ts 里移除，接口相应不再返回这个字段（见 _auth.ts 的 authorizeCapability）。
    const body = await expectGetOk(page, "/api/capabilities", "capabilities", "groups", "roles");
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