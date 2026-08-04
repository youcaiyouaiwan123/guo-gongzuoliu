// 图片生成：调用图片模型生成图片，管理生成记录。
// 使用 Hono 中间件统一处理认证和错误响应。
import { env } from "cloudflare:workers";
import { createApp, auth, success, fail } from "../_app";
import { callImageModel } from "../_modelProvider";
import { decryptSecret } from "../_crypto";
import { log } from "../_logger";

type RuntimeEnv = { DB: D1Database; R2: R2Bucket; PLATFORM_CREDENTIALS_KEY?: string; MODEL_BASE_URL?: string };
const runtime = env as unknown as RuntimeEnv;
const FIXED_BASE_URL = runtime.MODEL_BASE_URL?.trim() || "https://claudecc.top";

type ImageModelRow = {
  id: number;
  connectionName: string;
  provider: string;
  model: string;
  encryptedApiKey: string;
};

async function ensureSchema() {
  await runtime.DB.batch([
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS user_image_model_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,connection_name TEXT NOT NULL,provider TEXT NOT NULL,base_url TEXT NOT NULL,model_name TEXT NOT NULL,encrypted_api_key TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"),
    runtime.DB.prepare("CREATE TABLE IF NOT EXISTS generated_images (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,model_profile_id INTEGER,provider TEXT NOT NULL,model_name TEXT NOT NULL,prompt TEXT NOT NULL,optimized_prompt TEXT NOT NULL,size TEXT NOT NULL,quality TEXT NOT NULL,image_url TEXT,image_data_url TEXT,created_at TEXT NOT NULL)"),
  ]);
}

async function findModel(email: string, id: number) {
  return runtime.DB.prepare("SELECT id,connection_name AS connectionName,provider,model_name AS model,encrypted_api_key AS encryptedApiKey FROM user_image_model_profiles WHERE owner_email=? AND id=?")
    .bind(email, id)
    .first<ImageModelRow>();
}

async function listImages(email: string) {
  const result = await runtime.DB.prepare("SELECT id,provider,model_name AS model,prompt,optimized_prompt AS optimizedPrompt,size,quality,image_url AS imageUrl,image_data_url AS imageDataUrl,created_at AS createdAt FROM generated_images WHERE owner_email=? ORDER BY id DESC LIMIT 80")
    .bind(email)
    .all();
  return result.results || [];
}

const app = createApp();
app.use("*", auth());

// GET /api/image-generate — 获取图片生成记录 或 提供 R2 图片（?file=xxx.png）
app.get("*", async (c) => {
  const { user } = c.var;
  const url = new URL(c.req.url);

  // 如果传了 ?file=xxx.png 参数，从 R2 提供图片
  const filename = url.searchParams.get("file");
  if (filename) {
    if (!/^[a-f0-9-]+\.png$/i.test(filename)) {
      return new Response("无效的文件名", { status: 400 });
    }
    const object = await runtime.R2.get(`generated-images/${filename}`);
    if (!object) {
      return new Response("图片不存在", { status: 404 });
    }
    return new Response(object.body, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  await ensureSchema();
  return success({ images: await listImages(user.email) });
});

// POST /api/image-generate — 生成图片
app.post("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const body = await c.req.json().catch(() => ({})) as { imageModelId?: number; prompt?: string; optimizedPrompt?: string; size?: string; count?: number; quality?: string };
  const prompt = String(body.optimizedPrompt || body.prompt || "").trim();
  log.info("图片生成请求", { email: user.email, promptLength: prompt.length, modelId: body.imageModelId, size: body.size, count: body.count });
  if (!prompt) return fail("请填写生图提示词。", 400);
  const modelId = Number(body.imageModelId || 0);
  if (!modelId) return fail("请先选择一个已保存的图片模型。", 400);
  const model = await findModel(user.email, modelId);
  if (!model) return fail("没有找到这个图片模型，请重新选择。", 400);
  log.info("图片模型已找到", { provider: model.provider, model: model.model, connectionName: model.connectionName });

  let result: Awaited<ReturnType<typeof callImageModel>>;
  try {
    const start = performance.now();
    result = await callImageModel(
      { provider: model.provider, baseUrl: FIXED_BASE_URL, model: model.model, apiKey: await decryptSecret(model.encryptedApiKey) },
      prompt,
      { size: body.size || "1024x1024", count: Math.max(1, Math.min(Number(body.count || 1), 4)), quality: body.quality || "standard" },
    );
    log.info("图片模型调用成功", { durationMs: Math.round(performance.now() - start), imagesCount: result.images?.length || 0 });
  } catch (error) {
    log.error("图片模型调用失败", {
      email: user.email,
      provider: model.provider,
      model: model.model,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(
      error instanceof Error ? `图片模型调用失败：${error.message}` : "图片模型调用失败，请检查 Key、模型名称和第三方中转服务。",
      502,
    );
  }

  if (!result.images?.length) {
    log.warn("图片模型未返回图片", { email: user.email, provider: model.provider, model: model.model });
    return fail("图片模型没有返回图片内容，请检查该模型是否支持生图，或更换图片模型后重试。", 502);
  }

  const now = new Date().toISOString();
  const saved = [];
  for (const image of result.images) {
    let imageUrl = image.url || "";
    let imageDataUrl = "";

    // 如果有 base64 data，优先存到 R2，D1 只存 R2 引用
    if (image.dataUrl) {
      try {
        const base64Data = image.dataUrl.replace(/^data:image\/[^;]+;base64,/, "");
        const binary = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        const key = `generated-images/${crypto.randomUUID()}.png`;
        await runtime.R2.put(key, binary, {
          httpMetadata: { contentType: "image/png" },
          customMetadata: { owner: user.email, prompt: String(body.prompt || prompt).slice(0, 200) },
        });
        imageUrl = `/api/image-generate?file=${key.split("/").pop()}`;
        log.info("图片已存入 R2", { key, sizeBytes: binary.length });
      } catch (e) {
        // R2 存储失败，回退到 base64 存 D1（如果大小允许）
        log.warn("R2 存储失败，回退到 data URL", { error: e instanceof Error ? e.message : String(e) });
        imageDataUrl = image.dataUrl;
      }
    }

    try {
      const item = await runtime.DB.prepare("INSERT INTO generated_images(owner_email,model_profile_id,provider,model_name,prompt,optimized_prompt,size,quality,image_url,image_data_url,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id,provider,model_name AS model,prompt,optimized_prompt AS optimizedPrompt,size,quality,image_url AS imageUrl,image_data_url AS imageDataUrl,created_at AS createdAt")
        .bind(user.email, model.id, model.provider, model.model, String(body.prompt || prompt), prompt, body.size || "1024x1024", body.quality || "standard", imageUrl, imageDataUrl, now)
        .first();
      saved.push(item);
    } catch (e) {
      log.warn("图片存储失败", { error: e instanceof Error ? e.message : String(e), hasUrl: !!imageUrl });
    }
  }
  log.info("图片生成完成", { email: user.email, savedCount: saved.length });

  return success({ message: `已生成 ${saved.length} 张图片。`, images: saved });
});

// DELETE /api/image-generate — 删除图片生成记录
app.delete("*", async (c) => {
  const { user } = c.var;
  await ensureSchema();
  const url = new URL(c.req.url);
  const body = await c.req.json().catch(() => ({})) as { ids?: number[] };
  const ids = body.ids?.length ? body.ids.map(Number).filter(Boolean) : [Number(url.searchParams.get("id"))].filter(Boolean);
  if (!ids.length) return fail("请选择要删除的生成记录。", 400);
  for (const id of ids) {
    await runtime.DB.prepare("DELETE FROM generated_images WHERE id=? AND owner_email=?").bind(id, user.email).run();
  }
  return success({ message: `已删除 ${ids.length} 条生图记录。` });
});

export const GET = (request: Request) => app.fetch(request);
export const POST = (request: Request) => app.fetch(request);
export const DELETE = (request: Request) => app.fetch(request);