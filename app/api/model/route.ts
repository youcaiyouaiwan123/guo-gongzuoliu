// 模型管理：个人模型连接管理。
import { env } from "cloudflare:workers";
import { createApp, auth, success, fail, authorizeCapability } from "../_app";
import { callModel } from "../_modelProvider";
import { encryptSecret, decryptSecret } from "../_crypto";

type RuntimeEnv = { DB: D1Database; PLATFORM_CREDENTIALS_KEY?: string; MODEL_BASE_URL?: string };
const runtime = env as unknown as RuntimeEnv;
const RELAY_BASE_URL = runtime.MODEL_BASE_URL?.trim() || "https://claudecc.top";
type ModelRow = { id: number; connectionName: string; provider: string; baseUrl: string; model: string; encryptedApiKey: string; updatedAt: string };

function inferModelProvider(model = "") {
  const name = model.toLowerCase();
  if (name.includes("claude")) return "Anthropic Claude";
  if (name.includes("gemini")) return "Google Gemini";
  if (name.includes("deepseek")) return "DeepSeek";
  if (name.includes("glm")) return "Zhipu AI";
  if (name.includes("qwen")) return "Tongyi Qianwen";
  if (name.includes("kimi")) return "Moonshot AI";
  if (name.includes("minimax")) return "MiniMax";
  if (name.includes("gpt")) return "OpenAI";
  return "Third-party Model";
}

function hasDirtyDisplayText(value = "") {
  const text = value.trim();
  return !text || text.includes("?") || text.includes("\ufffd") || /[鏅閫鏈绗妯鍑浼绠澶璇鈥俙銆]/.test(text);
}

function cleanProvider(provider = "", model = "") {
  return hasDirtyDisplayText(provider) ? inferModelProvider(model) : provider.trim();
}

function cleanConnectionName(connectionName = "", model = "") {
  const modelName = model.trim();
  const provider = inferModelProvider(modelName);
  const text = connectionName.trim();
  if (hasDirtyDisplayText(text)) return `${provider} · ${modelName}`;
  return text;
}

async function encrypt(value: string) {
  return encryptSecret(value);
}

async function decrypt(value: string) {
  const result = await decryptSecret(value);
  if (result === null) throw new Error("模型凭证解析失败");
  return result;
}

async function schema() {
  await runtime.DB.batch([
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS user_model_connections (owner_email TEXT PRIMARY KEY,provider TEXT NOT NULL,base_url TEXT NOT NULL,model_name TEXT NOT NULL,encrypted_api_key TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS user_model_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,connection_name TEXT NOT NULL,provider TEXT NOT NULL,base_url TEXT NOT NULL,model_name TEXT NOT NULL,encrypted_api_key TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_user_model_profile_name ON user_model_profiles(owner_email,connection_name)"),
  ]);
  await runtime.DB.prepare("INSERT INTO user_model_profiles(owner_email,connection_name,provider,base_url,model_name,encrypted_api_key,created_at,updated_at) SELECT owner_email,'我的第三方模型',provider,base_url,model_name,encrypted_api_key,created_at,updated_at FROM user_model_connections legacy WHERE NOT EXISTS (SELECT 1 FROM user_model_profiles profile WHERE profile.owner_email=legacy.owner_email)").run();
  await runtime.DB.prepare("UPDATE user_model_profiles SET base_url='https://claudecc.top' WHERE base_url<>'https://claudecc.top'").run();
  await runtime.DB.prepare(`UPDATE user_model_profiles
    SET provider = CASE
      WHEN lower(model_name) LIKE '%claude%' THEN 'Anthropic Claude'
      WHEN lower(model_name) LIKE '%gemini%' THEN 'Google Gemini'
      WHEN lower(model_name) LIKE '%deepseek%' THEN 'DeepSeek'
      WHEN lower(model_name) LIKE '%glm%' THEN 'Zhipu AI'
      WHEN lower(model_name) LIKE '%qwen%' THEN 'Tongyi Qianwen'
      WHEN lower(model_name) LIKE '%kimi%' THEN 'Moonshot AI'
      WHEN lower(model_name) LIKE '%minimax%' THEN 'MiniMax'
      WHEN lower(model_name) LIKE '%gpt%' THEN 'OpenAI'
      ELSE 'Third-party Model'
    END
    WHERE provider='' OR provider LIKE '%?%' OR provider LIKE '%' || char(65533) || '%'`).run();
  await runtime.DB.prepare(`UPDATE user_model_profiles
    SET connection_name = provider || ' · ' || model_name
    WHERE connection_name='' OR connection_name LIKE '%?%' OR connection_name LIKE '%' || char(65533) || '%'`).run();
}

async function records(email: string) {
  return runtime.DB.prepare("SELECT id,connection_name AS connectionName,provider,base_url AS baseUrl,model_name AS model,encrypted_api_key AS encryptedApiKey,updated_at AS updatedAt FROM user_model_profiles WHERE owner_email=? ORDER BY updated_at DESC,id DESC").bind(email).all<ModelRow>();
}

async function record(email: string, id?: number) {
  if (id) return runtime.DB.prepare("SELECT id,connection_name AS connectionName,provider,base_url AS baseUrl,model_name AS model,encrypted_api_key AS encryptedApiKey,updated_at AS updatedAt FROM user_model_profiles WHERE owner_email=? AND id=?").bind(email, id).first<ModelRow>();
  return runtime.DB.prepare("SELECT id,connection_name AS connectionName,provider,base_url AS baseUrl,model_name AS model,encrypted_api_key AS encryptedApiKey,updated_at AS updatedAt FROM user_model_profiles WHERE owner_email=? ORDER BY updated_at DESC,id DESC LIMIT 1").bind(email).first<ModelRow>();
}

const app = createApp();
app.use("*", auth());

// GET /api/model — 获取模型连接列表
app.get("*", async (c) => {
  await schema();
  const { user } = c.var;
  const result = await records(user.email);
  const connections = result.results.map(item => {
    const provider = cleanProvider(item.provider, item.model);
    return { id: item.id, connectionName: cleanConnectionName(item.connectionName, item.model), provider, baseUrl: "https://claudecc.top", model: item.model, keyStatus: "API Key 已加密保存", updatedAt: item.updatedAt };
  });
  const latest = connections[0];
  return success({ configured: connections.length > 0, provider: latest?.provider || "尚未选择", baseUrl: latest?.baseUrl || "", model: latest?.model || "尚未指定", keyStatus: latest ? `已保存 ${connections.length} 个独立连接` : "尚未填写我的 API Key", connections });
});

// POST /api/model — 保存/测试模型连接
app.post("*", async (c) => {
  const { user } = c.var;
  const denied = await authorizeCapability(runtime.DB, user, "manage_personal_models");
  if (denied) return denied;
  await schema();
  const body = await c.req.json().catch(() => ({})) as { action?: string; id?: number; connectionName?: string; provider?: string; baseUrl?: string; model?: string; apiKey?: string };

  if (body.action === "save") {
    const provider = cleanProvider(body.provider || "", body.model || "");
    const existing = body.id ? await record(user.email, Number(body.id)) : null;
    if (!body.connectionName?.trim() || !provider || !body.model?.trim() || (!existing && !body.apiKey?.trim())) return fail("请完整填写连接名称、供应商、模型名称和 API Key。");
    const normalizedBaseUrl = RELAY_BASE_URL;
    let url: URL; try { url = new URL(normalizedBaseUrl); } catch { return fail("接口地址格式不正确。"); }
    if (url.protocol !== "https:") return fail("模型接口必须使用 HTTPS。");
    const now = new Date().toISOString();
    const encryptedApiKey = body.apiKey?.trim() ? await encrypt(body.apiKey.trim()) : existing!.encryptedApiKey;
    const connectionName = cleanConnectionName(body.connectionName || "", body.model || "");
    if (existing) {
      await runtime.DB.prepare("UPDATE user_model_profiles SET connection_name=?,provider=?,base_url=?,model_name=?,encrypted_api_key=?,updated_at=? WHERE id=? AND owner_email=?").bind(connectionName, provider, normalizedBaseUrl, body.model.trim(), encryptedApiKey, now, existing.id, user.email).run();
    } else {
      await runtime.DB.prepare("INSERT INTO user_model_profiles(owner_email,connection_name,provider,base_url,model_name,encrypted_api_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_email,connection_name) DO UPDATE SET provider=excluded.provider,base_url=excluded.base_url,model_name=excluded.model_name,encrypted_api_key=excluded.encrypted_api_key,updated_at=excluded.updated_at").bind(user.email, connectionName, provider, normalizedBaseUrl, body.model.trim(), encryptedApiKey, now, now).run();
    }
    return success({ message: `模型连接"${connectionName}"已保存，可在聊天中单独选择。` });
  }

  // 测试连接
  const item = await record(user.email, Number(body.id) || undefined);
  if (!item) return fail("没有找到要测试的模型连接。");
  const started = Date.now();
  try {
    const reply = await callModel({ provider: item.provider, baseUrl: item.baseUrl, model: item.model, apiKey: await decrypt(item.encryptedApiKey) }, [{ role: "user", content: "只回复：连接成功" }], { maxTokens: 16, temperature: 0 });
    if (!reply.trim()) throw new Error("接口没有返回可读文字");
    return success({ message: `"${item.connectionName}"连接成功，响应耗时 ${Date.now() - started}ms。` });
  } catch (error) {
    return fail(`无法连接"${item.connectionName}"：${error instanceof Error ? error.message : "请检查接口地址或网络策略"}`, 502);
  }
});

// DELETE /api/model — 删除模型连接
app.delete("*", async (c) => {
  const { user } = c.var;
  const denied = await authorizeCapability(runtime.DB, user, "manage_personal_models");
  if (denied) return denied;
  await schema();
  const id = Number(c.req.query("id"));
  if (!id) return fail("缺少连接编号。");
  await runtime.DB.prepare("DELETE FROM user_model_profiles WHERE id=? AND owner_email=?").bind(id, user.email).run();
  return success({ message: "模型连接已删除。" });
});

// vinext 文件路由桥接
export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);
export const DELETE = (request: Request) => app.fetch(request);