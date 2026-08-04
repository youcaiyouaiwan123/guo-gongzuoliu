import { createApp, auth, fail } from "../_app";
import { extractTextFromFile } from "../_fileText";

const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const app = createApp();
app.use("*", auth());

// POST /api/extract-file — 解析上传文件内容
app.post("*", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return fail(
      "上传内容过大或格式不正确。聊天窗口单个附件请控制在 10MB 内；较大的资料请先上传到个人知识库或企业知识库。",
      413,
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return fail("请选择要解析的文件。", 400);
  }

  if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
    return fail(
      `《${file.name}》超过聊天附件上限 10MB。请压缩后上传，或先上传到个人知识库/企业知识库再调用。`,
      413,
    );
  }

  const extracted = await extractTextFromFile(file);
  return Response.json(extracted);
});

export const POST = (request: Request) => app.fetch(request);