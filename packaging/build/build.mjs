// 组装某目标的「程序目录」树到 packaging/build/out/<key>/。
// 树结构（与安装器铺到目标机 PROGRAM_DIR 的内容一致）：
//   runtime/node(.exe)         内置 Node 运行时（vendor）
//   dist/                      vinext build 产物（OS 无关）
//   drizzle/                   迁移
//   services/{model-relay,channel-gateway}   通道服务（gateway 含自身 node_modules）
//   packaging/{supervisor,migrate,proxy}.mjs + lib/   守护与替身
//   node_modules/              裁剪运行时闭包（wrangler+workerd+esbuild，按目标平台）
//   version.txt
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TARGETS, findTarget } from "./targets.mjs";
import { pruneRuntime } from "./prune-runtime.mjs";
import { fetchNode } from "./fetch-node.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(REPO_ROOT, "packaging", "build", "out");

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: REPO_ROOT, ...opts });
}

// dist/ 必须先由 `vinext build` 产出（OS 无关，全目标共用一次）。
function ensureDist() {
  if (fs.existsSync(path.join(REPO_ROOT, "dist", "server", "index.js"))) {
    console.log("[build] dist 已存在，跳过构建（如需重建先删 dist/）。");
    return;
  }
  console.log("[build] 运行 vinext build …");
  run("npm", ["run", "build"]);
}

// channel-gateway 的三个纯 JS SDK 依赖：OS 无关，安装一次后各目标复用。
function ensureGatewayDeps() {
  const gwDir = path.join(REPO_ROOT, "services", "channel-gateway");
  if (fs.existsSync(path.join(gwDir, "node_modules"))) {
    console.log("[build] channel-gateway 依赖已存在，跳过。");
    return;
  }
  console.log("[build] 安装 channel-gateway 依赖 …");
  run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=warn"], { cwd: gwDir });
}

const copy = (from, to) => fs.cpSync(from, to, { recursive: true, dereference: true });

export function assemble(target) {
  const dst = path.join(OUT, target.key);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });

  // 运行时 Node
  const nodeDir = fetchNode(target);
  copy(nodeDir, path.join(dst, "runtime"));

  // OS 无关部分
  copy(path.join(REPO_ROOT, "dist"), path.join(dst, "dist"));
  copy(path.join(REPO_ROOT, "drizzle"), path.join(dst, "drizzle"));
  copy(path.join(REPO_ROOT, "services", "model-relay"), path.join(dst, "services", "model-relay"));
  copy(path.join(REPO_ROOT, "services", "channel-gateway"), path.join(dst, "services", "channel-gateway"));

  // packaging 运行时代码（排除 build/ 与 vendor/，避免把构建脚本与下载物打进包）
  const pkgSrc = path.join(REPO_ROOT, "packaging");
  const pkgDst = path.join(dst, "packaging");
  fs.mkdirSync(pkgDst, { recursive: true });
  for (const entry of ["supervisor.mjs", "migrate.mjs", "proxy.mjs", "first-run.mjs", "launcher.mjs", "lib"]) {
    copy(path.join(pkgSrc, entry), path.join(pkgDst, entry));
  }
  // Windows 目标：把桌面版入口脚本打进 packaging/windows/（haixin.cmd + 首启下载器）。
  if (target.installer === "windows") {
    fs.mkdirSync(path.join(pkgDst, "windows"), { recursive: true });
    for (const f of ["haixin.cmd", "fetch-runtime.ps1"]) {
      copy(path.join(pkgSrc, "windows", f), path.join(pkgDst, "windows", f));
    }
  }
  // macOS 目标：把 LaunchDaemon plist 打进 payload（postinstall 从程序目录拷到 /Library/LaunchDaemons）。
  if (target.installer === "macos") {
    fs.mkdirSync(path.join(pkgDst, "macos"), { recursive: true });
    copy(path.join(pkgSrc, "macos", "com.haixin.ai.plist"), path.join(pkgDst, "macos", "com.haixin.ai.plist"));
  }

  // 裁剪运行时闭包（按目标平台）
  pruneRuntime(target, path.join(dst, "node_modules"));

  const version = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;
  fs.writeFileSync(
    path.join(dst, "version.txt"),
    `haixin-ai ${version}\ntarget ${target.key}\n`,
  );
  console.log(`[build] 组装完成：${dst}`);
  return dst;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv[2];
  ensureDist();
  ensureGatewayDeps();
  const list = only ? [findTarget(only)] : TARGETS;
  for (const t of list) {
    if (!t) throw new Error(`未知目标：${only}`);
    assemble(t);
  }
}
