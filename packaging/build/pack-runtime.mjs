// 把某目标的「运行环境」（runtime/ 下载的 Node + node_modules/ 裁剪的 wrangler 闭包）
// 打成一个 zip，供桌面版首次启动时联网下载解压到用户数据目录。
// 产物：packaging/build/dist/haixin-runtime-<key>.zip + 返回 { url, sha256, version, size }。
// zip 顶层为 runtime/ 与 node_modules/（从 out/<key> 目录内打包，保证解压即得该结构）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(REPO_ROOT, "packaging", "build", "out");
const DIST = path.join(REPO_ROOT, "packaging", "build", "dist");

function sha256(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

function version() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;
}

// baseUrl：运行环境 zip 将被托管的基址（末尾不带斜杠），如 http://45.59.185.39:8899
export function packRuntime(target, baseUrl) {
  const stage = path.join(OUT, target.key);
  for (const d of ["runtime", "node_modules"]) {
    if (!fs.existsSync(path.join(stage, d))) {
      throw new Error(`[pack-runtime] 缺少 ${path.join(stage, d)}，请先 node packaging/build/build.mjs ${target.key}`);
    }
  }
  fs.mkdirSync(DIST, { recursive: true });
  const zipName = `haixin-runtime-${target.key}.zip`;
  const zipPath = path.join(DIST, zipName);
  fs.rmSync(zipPath, { force: true });

  console.log(`[pack-runtime] 打包 ${target.key} 运行环境 → ${zipName} …`);
  // 从 stage 目录内打包，使 zip 顶层为 runtime/ 与 node_modules/
  execFileSync("zip", ["-9", "-r", "-q", zipPath, "runtime", "node_modules"], {
    cwd: stage,
    stdio: "inherit",
  });

  const sha = sha256(zipPath);
  const size = fs.statSync(zipPath).size;
  const ver = version();
  const url = `${(baseUrl || "").replace(/\/+$/, "")}/${zipName}`;
  const manifest = { url, sha256: sha, version: ver, size, key: target.key };

  // 同时落一份 .sha256 便于人工核对
  fs.writeFileSync(`${zipPath}.sha256`, `${sha}  ${zipName}\n`);
  console.log(`[pack-runtime] ✓ ${zipName}  ${(size / 1048576).toFixed(1)}MB  sha256=${sha.slice(0, 16)}…`);
  return { ...manifest, zipPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const key = process.argv[2] || "win-x64";
  const baseUrl = process.argv[3] || process.env.HAIXIN_RUNTIME_BASE_URL || "";
  const { findTarget } = await import("./targets.mjs");
  const t = findTarget(key);
  if (!t) throw new Error(`未知目标：${key}`);
  const m = packRuntime(t, baseUrl);
  console.log(JSON.stringify(m, null, 2));
}
