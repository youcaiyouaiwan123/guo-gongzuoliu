// D1 迁移执行器（移植自 deploy/selfhost-entrypoint.sh，去掉 bash/python3/sha256sum）。
// schema_migrations 表是数据库版本的唯一事实来源：逐条记录迁移名、文件校验和、执行时间。
// 语义与原脚本一致：
//   * 校验和不一致（已应用的迁移被改写）→ 中止启动；
//   * 旧版 .migrations-applied 标记 + 空历史 → 一次性登记为已应用，不重跑非幂等的 0000-0007/0015；
//   * 未记录的迁移 → 执行 --file 后写历史；执行失败即中止，不会被误标成功。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  STATE_DIR,
  WRANGLER_BIN,
  WRANGLER_CONFIG,
  DRIZZLE_DIR,
  D1_DATABASE_NAME,
} from "./lib/paths.mjs";

const LEGACY_MARKER = path.join(STATE_DIR, ".migrations-applied");

function d1(args) {
  return execFileSync(
    process.execPath,
    [
      WRANGLER_BIN,
      "d1",
      "execute",
      D1_DATABASE_NAME,
      "--local",
      "--config",
      WRANGLER_CONFIG,
      "--persist-to",
      STATE_DIR,
      ...args,
      "--yes",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 },
  );
}

const d1Command = (sql) => d1(["--command", sql]);
const d1File = (file) => d1(["--file", file]);

function extractJson(text) {
  const start = text.indexOf("[");
  if (start < 0) return [];
  // 从第一个 '[' 起做括号配对，取出平衡的 JSON 数组子串（容忍前后噪声）。
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  return [];
}

function readHistory() {
  const raw = d1Command("SELECT name,checksum FROM schema_migrations");
  const payload = extractJson(raw);
  const rows = (payload[0]?.results) || [];
  const map = new Map();
  for (const row of rows) map.set(row.name, row.checksum);
  return map;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function migrationFiles() {
  return fs
    .readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function runMigrations() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  d1Command(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)",
  );

  let applied = readHistory();
  const files = migrationFiles();

  // 旧部署只有 .migrations-applied 标记而没有历史表：把现有迁移登记为已应用（不重跑），归档旧标记。
  if (fs.existsSync(LEGACY_MARKER) && applied.size === 0) {
    console.log("检测到旧版 .migrations-applied 标记，将现有迁移登记进历史表（不重复执行）。");
    for (const name of files) {
      const checksum = sha256(path.join(DRIZZLE_DIR, name));
      d1Command(
        `INSERT OR REPLACE INTO schema_migrations(name,checksum,applied_at) VALUES('${name}','${checksum}','${nowIso()}')`,
      );
    }
    fs.renameSync(LEGACY_MARKER, `${LEGACY_MARKER}.migrated`);
    applied = readHistory();
  }

  for (const name of files) {
    const file = path.join(DRIZZLE_DIR, name);
    const checksum = sha256(file);
    const recorded = applied.get(name);
    if (recorded) {
      if (recorded !== checksum) {
        throw new Error(
          `迁移 ${name} 校验和不一致（记录 ${recorded}，实际 ${checksum}）。请新增迁移而不要修改已应用的迁移。`,
        );
      }
      continue;
    }
    console.log(`正在执行迁移 ${name}`);
    d1File(file); // 失败会抛出，历史记录不会写入，失败的迁移不会被标记成功
    d1Command(
      `INSERT INTO schema_migrations(name,checksum,applied_at) VALUES('${name}','${checksum}','${nowIso()}')`,
    );
  }
  console.log(`迁移完成，共 ${files.length} 条已就位。`);
}

// 允许作为独立脚本运行（供构建冒烟/手动排障）。
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runMigrations();
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(1);
  }
}
