import { env } from "cloudflare:workers";
import { createApp, auth, fail, ADMIN_ROLE } from "../../_app";

type RuntimeEnv = { DB: D1Database };
const runtimeEnv = env as unknown as RuntimeEnv;

function pdfTextHex(value: string) {
  const bytes = [0xfe, 0xff];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    bytes.push((code >> 8) & 255, code & 255);
  }
  return bytes.map(byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function wrapContractText(value: string, limit = 36) {
  const lines: string[] = [];
  for (const rawLine of value.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim() || " ";
    for (let index = 0; index < line.length; index += limit) {
      lines.push(line.slice(index, index + limit));
    }
  }
  return lines.slice(0, 65);
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

function buildContractPdf(title: string, content: string) {
  const footer = `嘉兴海芯博创科技有限公司\n生成时间：${new Date().toLocaleString("zh-CN")}`;
  const lines = wrapContractText(`${title}\n\n${content}\n\n${footer}`);
  const stream = [
    "BT",
    "/F1 12 Tf",
    "50 790 Td",
    "18 TL",
    ...lines.map(line => `<${pdfTextHex(line)}> Tj T*`),
    "ET"
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>",
    `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 7 0 R >>",
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

const app = createApp();
app.use("*", auth());

// GET /api/contracts/pdf — 下载合同 PDF
app.get("*", async (c) => {
  const { user } = c.var;
  const db = runtimeEnv.DB;
  const id = Number(new URL(c.req.url).searchParams.get("id"));
  const doc = await db.prepare("SELECT title,content,created_by AS createdBy FROM contract_documents WHERE id=?").bind(id).first<{ title: string; content: string; createdBy: string }>();
  if (!doc) return fail("合同不存在。", 404);
  if (user.role !== ADMIN_ROLE && doc.createdBy !== user.email) return fail("只能下载自己生成的合同。", 403);
  return new Response(buildContractPdf(doc.title, doc.content), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.title)}.pdf`
    }
  });
});

export const GET = (request: Request) => app.fetch(request);