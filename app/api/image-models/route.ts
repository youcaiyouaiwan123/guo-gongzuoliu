// 图片模型管理：保存、测试、删除图片模型连接。
// 使用 Hono 中间件统一处理认证和错误响应。
import { env } from "cloudflare:workers";
import { createApp, auth, success, fail, authorizeCapability } from "../_app";
import { callImageModel } from "../_modelProvider";
import { encryptSecret, decryptSecret } from "../_crypto";

type RuntimeEnv = { DB: D1Database; PLATFORM_CREDENTIALS_KEY?: string; MODEL_BASE_URL?: string };
const runtime = env as unknown as RuntimeEnv;
const FIXED_BASE_URL = runtime.MODEL_BASE_URL?.trim() || "https://claudecc.top";

type ImageModelRow = {
  id: number;
  connectionName: string;
  provider: string;
  baseUrl: string;
  model: string;
  encryptedApiKey: string;
  updatedAt: string;
};

function inferProvider(model = "") {
  const name = model.toLowerCase();
  if (name.includes("gemini") || name.includes("imagen")) return "Google Gemini 图片";
  if (name.includes("qwen") || name.includes("wanx") || name.includes("wanxiang") || name.includes("千问") || name.includes("通义")) return "通义千问/通义万相";
  if (name.includes("doubao") || name.includes("jimeng") || name.includes("seedream") || name.includes("字节") || name.includes("即梦")) return "字节豆包/即梦";
  if (name.includes("gpt") || name.includes("dall")) return "GPT 图片";
  return "自定义图片模型";
}

async function ensureSchema() {
  await runtime.DB.batch([
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS user_image_model_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,connection_name TEXT NOT NULL,provider TEXT NOT NULL,base_url TEXT NOT NULL,model_name TEXT NOT NULL,encrypted_api_key TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_user_image_model_profile_name ON user_image_model_profiles(owner_email,connection_name)"),
  ]);
}

async function findModel(email: string, id?: number) {
  if (id) {
    return runtime.DB.prepare("SELECT id,connection_name AS connectionName,provider,base_url AS baseUrl,model_name AS model,encrypted_api_key AS encryptedApiKey,updated_at AS updatedAt FROM user_image_model_profiles WHERE owner_email=? AND id=?")
      .bind(email, id)
      .first<ImageModelRow>();
  }
  return runtime.DB.prepare("SELECT id,connection_name AS connectionName,provider,base_url AS baseUrl,model_name AS model,encrypted_api_key AS encryptedApiKey,updated_at AS updatedAt FROM user_image_model_profiles WHERE owner_email=? ORDER BY updated_at DESC,id DESC LIMIT 1")
    .bind(email)
    .first<ImageModelRow>();
}

const app = createApp();
app.use("*", auth());

// GET /api/image-models — 获取图片模型列表
app.get("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const result = await runtime.DB.prepare("SELECT id,connection_name AS connectionName,provider,base_url AS baseUrl,model_name AS model,updated_at AS updatedAt FROM user_image_model_profiles WHERE owner_email=? ORDER BY updated_at DESC,id DESC")
    .bind(user.email)
    .all<Omit<ImageModelRow, "encryptedApiKey">>();
  const models = (result.results || []).map(item => ({
    ...item,
    provider: item.provider || inferProvider(item.model),
    baseUrl: FIXED_BASE_URL,
    keyStatus: "API Key 已加密保存",
  }));
  return success({ models, baseUrl: FIXED_BASE_URL });
});

// POST /api/image-models — 保存或测试图片模型
app.post("*", async (c) => {
  const { user } = c.var;
  const denied = await authorizeCapability(runtime.DB, user, "manage_personal_models");
  if (denied) return denied;
  await ensureSchema();
  const body = await c.req.json().catch(() => ({})) as { action?: string; id?: number; connectionName?: string; provider?: string; model?: string; apiKey?: string };

  if (body.action === "save") {
    const existing = body.id ? await findModel(user.email, Number(body.id)) : null;
    const model = body.model?.trim() || "";
    const provider = body.provider?.trim() || inferProvider(model);
    const connectionName = body.connectionName?.trim() || `${provider} · ${model}`;
    if (!connectionName || !model || (!existing && !body.apiKey?.trim())) {
      return fail("请填写连接名称、图片模型名称和 API Key。", 400);
    }
    const encryptedApiKey = body.apiKey?.trim() ? await encryptSecret(body.apiKey.trim()) : existing!.encryptedApiKey;
    const now = new Date().toISOString();
    if (existing) {
      await runtime.DB.prepare("UPDATE user_image_model_profiles SET connection_name=?,provider=?,base_url=?,model_name=?,encrypted_api_key=?,updated_at=? WHERE id=? AND owner_email=?")
        .bind(connectionName, provider, FIXED_BASE_URL, model, encryptedApiKey, now, existing.id, user.email)
        .run();
    } else {
      await runtime.DB.prepare("INSERT INTO user_image_model_profiles(owner_email,connection_name,provider,base_url,model_name,encrypted_api_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_email,connection_name) DO UPDATE SET provider=excluded.provider,base_url=excluded.base_url,model_name=excluded.model_name,encrypted_api_key=excluded.encrypted_api_key,updated_at=excluded.updated_at")
        .bind(user.email, connectionName, provider, FIXED_BASE_URL, model, encryptedApiKey, now, now)
        .run();
    }
    return success({ message: `图片模型「${connectionName}」已保存。` });
  }

  const item = await findModel(user.email, Number(body.id) || undefined);
  if (!item) return fail("没有找到要测试的图片模型。", 400);
  try {
    const result = await callImageModel(
      { provider: item.provider, baseUrl: FIXED_BASE_URL, model: item.model, apiKey: await decryptSecret(item.encryptedApiKey) },
      "一枚绿色圆形对勾图标，纯白背景，极简风格",
      { size: "1024x1024", count: 1 },
    );
    return success({ message: `「${item.connectionName}」已返回 ${result.images.length} 张测试图。` });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "图片模型测试失败。", 502);
  }
});

// DELETE /api/image-models — 删除图片模型
app.delete("*", async (c) => {
  const { user } = c.var;
  const denied = await authorizeCapability(runtime.DB, user, "manage_personal_models");
  if (denied) return denied;
  await ensureSchema();
  const url = new URL(c.req.url);
  const body = await c.req.json().catch(() => ({})) as { ids?: number[] };
  const ids = body.ids?.length ? body.ids.map(Number).filter(Boolean) : [Number(url.searchParams.get("id"))].filter(Boolean);
  if (!ids.length) return fail("请选择要删除的图片模型。", 400);
  for (const id of ids) {
    await runtime.DB.prepare("DELETE FROM user_image_model_profiles WHERE id=? AND owner_email=?").bind(id, user.email).run();
  }
  return success({ message: `已删除 ${ids.length} 个图片模型。` });
});

export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);
export const DELETE = (request: Request) => app.fetch(request);