// 无依赖的 .env 解析/序列化。仅支持 KEY=VALUE，# 注释，可选双引号包裹的值。
// 不做 shell 展开——config.env 是纯配置文件，不是脚本。
import fs from "node:fs";

export function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

// 值含空白/特殊字符时用双引号包裹并转义。写出稳定排序，便于 diff。
export function serializeEnv(obj) {
  const lines = [];
  for (const key of Object.keys(obj)) {
    const value = obj[key] ?? "";
    const needsQuote = /[\s#"'=]/.test(value) || value === "";
    const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push(`${key}=${needsQuote ? `"${escaped}"` : escaped}`);
  }
  return lines.join("\n") + "\n";
}
