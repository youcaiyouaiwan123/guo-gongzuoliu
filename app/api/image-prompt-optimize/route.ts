import { env } from "cloudflare:workers";
import { callModel } from "../_modelProvider";
import { decryptSecret } from "../_crypto";
import { createApp, auth, success, fail } from "../_app";

type RuntimeEnv = {
  DB: D1Database;
  PLATFORM_CREDENTIALS_KEY?: string;
  MODEL_API_KEY?: string;
  MODEL_NAME?: string;
  MODEL_PROVIDER?: string;
  MODEL_BASE_URL?: string;
};

const runtime = env as unknown as RuntimeEnv;
const FIXED_BASE_URL = runtime.MODEL_BASE_URL?.trim() || "https://claudecc.top";

type TextModelRow = { provider: string; model: string; encryptedApiKey: string };

async function decrypt(value: string) {
  return decryptSecret(value);
}

async function ensureSchema() {
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
    WHERE provider='' OR provider LIKE '%?%' OR provider LIKE '%%'`).run();
  await runtime.DB.prepare(`UPDATE user_model_profiles
    SET connection_name = provider || ' · ' || model_name
    WHERE connection_name='' OR connection_name LIKE '%?%' OR connection_name LIKE '%%'`).run();
}

function buildPrompt(body: { prompt?: string; structured?: Record<string, string> }) {
  const fields = body.structured || {};
  const custom = String(body.prompt || "").trim();
  if (custom) return custom;
  return [
    `画面主题：${fields.subject || ""}`,
    `使用场景：${fields.scene || ""}`,
    `品牌元素：${fields.brand || ""}`,
    `风格：${fields.style || ""}`,
    `构图：${fields.composition || ""}`,
    `文字要求：${fields.text || ""}`,
    `不要出现：${fields.negative || ""}`,
  ].filter(item => !item.endsWith("：")).join("\n");
}

const app = createApp();
app.use("*", auth());

// POST /api/image-prompt-optimize — 优化图片提示词
app.post("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const body = await c.req.json<{ textModelId?: number; prompt?: string; structured?: Record<string, string> }>().catch(() => ({}));
  const sourcePrompt = buildPrompt(body);
  if (!sourcePrompt) return fail("请先填写要优化的画面需求。", 400);

  const row = body.textModelId
    ? await runtime.DB.prepare("SELECT provider,model_name AS model,encrypted_api_key AS encryptedApiKey FROM user_model_profiles WHERE owner_email=? AND id=?")
      .bind(user.email, Number(body.textModelId))
      .first<TextModelRow>()
    : await runtime.DB.prepare("SELECT provider,model_name AS model,encrypted_api_key AS encryptedApiKey FROM user_model_profiles WHERE owner_email=? ORDER BY updated_at DESC,id DESC LIMIT 1")
      .bind(user.email)
      .first<TextModelRow>();

  const connection = row
    ? { provider: row.provider, baseUrl: FIXED_BASE_URL, model: row.model, apiKey: await decrypt(row.encryptedApiKey) }
    : runtime.MODEL_API_KEY
      ? { provider: runtime.MODEL_PROVIDER || "OpenAI", baseUrl: FIXED_BASE_URL, model: runtime.MODEL_NAME || "gpt-4.1-mini", apiKey: runtime.MODEL_API_KEY }
      : null;

  if (!connection) return fail("请先在模型接入里保存一个文字模型，用来优化提示词。", 400);

  const optimized = await callModel(connection, [
    {
      role: "system",
      content: "你是商业海报与文生图提示词专家。请把用户需求优化成一段可直接给图片生成模型使用的中文提示词，只输出提示词，不要解释。",
    },
    { role: "user", content: sourcePrompt },
  ], { temperature: 0.4, maxTokens: 800 });

  return success({ optimizedPrompt: optimized.trim() });
});

export const POST = (request: Request) => app.fetch(request);