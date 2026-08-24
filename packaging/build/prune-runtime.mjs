// 产出「运行时裁剪版」node_modules：因 dist/server/index.js 已在 build 时内联应用依赖
// （no_bundle:true 只让 workerd 直接加载它），运行时只需 wrangler 工具链。
// 做法：在临时目录只声明 wrangler 一个依赖，用 --os/--cpu 让 npm 拉「目标平台」的
// workerd/esbuild 原生包，得到权威运行时闭包，而非手工删 1.2G 的开发树。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// 与仓库 package.json 对齐，保证与已构建产物的 wrangler 版本一致。
function wranglerVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  return (pkg.devDependencies?.wrangler || pkg.dependencies?.wrangler || "4.92.0").replace(/^[^\d]*/, "");
}

// 为某个目标产出裁剪 node_modules，返回其路径。destDir 会被清空重建。
export function pruneRuntime(target, destDir) {
  const version = wranglerVersion();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `haixin-prune-${target.key}-`));
  fs.writeFileSync(
    path.join(scratch, "package.json"),
    JSON.stringify({ name: "haixin-runtime", private: true, dependencies: { wrangler: version } }, null, 2),
  );

  console.log(`[prune] ${target.key}: npm install wrangler@${version} (--os ${target.os} --cpu ${target.cpu})`);
  execFileSync(
    "npm",
    [
      "install",
      "--os", target.os,
      "--cpu", target.cpu,
      "--omit=dev",
      "--ignore-scripts", // 跳过 host 侧 postinstall；原生包本身即含二进制文件
      "--no-audit",
      "--no-fund",
      "--loglevel=warn",
    ],
    { cwd: scratch, stdio: "inherit", timeout: 600_000 },
  );

  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(path.join(scratch, "node_modules"), destDir, { recursive: true });
  fs.rmSync(scratch, { recursive: true, force: true });

  verifyBinaries(target, destDir);
  return destDir;
}

// 断言目标平台的关键原生二进制确实落进了裁剪树——裁剪错在离线机上无法补救。
function verifyBinaries(target, modulesDir) {
  const workerdPkg =
    target.os === "win32"
      ? "workerd-windows-64"
      : `workerd-${target.os}-${target.cpu === "arm64" ? "arm64" : "64"}`;
  const workerdBin = path.join(
    modulesDir, "@cloudflare", workerdPkg, "bin", target.os === "win32" ? "workerd.exe" : "workerd",
  );
  if (!fs.existsSync(workerdBin)) {
    throw new Error(`[prune] ${target.key}: 缺少 workerd 二进制 ${workerdBin}`);
  }
  const size = (fs.statSync(workerdBin).size / 1048576) | 0;
  const esbuildPkg =
    target.os === "win32" ? "win32-x64" : `${target.os}-${target.cpu}`;
  const esbuildDir = path.join(modulesDir, "@esbuild", esbuildPkg);
  if (!fs.existsSync(esbuildDir)) {
    throw new Error(`[prune] ${target.key}: 缺少 esbuild 原生包 ${esbuildDir}`);
  }
  const wranglerBin = path.join(modulesDir, "wrangler", "bin", "wrangler.js");
  if (!fs.existsSync(wranglerBin)) {
    throw new Error(`[prune] ${target.key}: 缺少 wrangler 入口 ${wranglerBin}`);
  }
  console.log(`[prune] ${target.key}: OK workerd=${size}MB (${workerdPkg}), esbuild=${esbuildPkg}`);
}

// CLI：node prune-runtime.mjs <target-key> <destDir>
if (import.meta.url === `file://${process.argv[1]}`) {
  const { findTarget } = await import("./targets.mjs");
  const key = process.argv[2];
  const dest = process.argv[3] || path.join(REPO_ROOT, "packaging", "build", "out", key, "app", "node_modules");
  const target = findTarget(key);
  if (!target) {
    console.error(`未知目标：${key}`);
    process.exit(1);
  }
  pruneRuntime(target, dest);
}
