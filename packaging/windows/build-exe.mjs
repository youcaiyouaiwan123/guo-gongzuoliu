// 在构建机上产出 Windows 桌面版安装器（小包）+ 运行环境 zip。
// 桌面版设计：
//   * 安装器只铺应用码（排除 runtime/ 与 node_modules/），体积小（~十几 MB）。
//   * 运行环境（Node + wrangler 闭包）打成 haixin-runtime-win-x64.zip，托管在 RUNTIME_BASE_URL，
//     目标机首次启动时由 haixin.cmd + fetch-runtime.ps1 联网下载解压到 %LOCALAPPDATA%\HaixinAI。
//   * 不装 Windows 服务、不需管理员：装到用户目录，双击快捷方式启动，"退出海芯"停止。
// 产物：packaging/build/dist/HaixinAI-<version>-win-x64-Setup.exe
//       packaging/build/dist/haixin-runtime-win-x64.zip (+ .sha256)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findTarget } from "../build/targets.mjs";
import { assemble } from "../build/build.mjs";
import { packRuntime } from "../build/pack-runtime.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(REPO_ROOT, "packaging", "build", "out");
const DIST = path.join(REPO_ROOT, "packaging", "build", "dist");

// 运行环境 zip 的托管基址（末尾不带斜杠）。可用环境变量覆盖为正式地址。
const RUNTIME_BASE_URL = (process.env.HAIXIN_RUNTIME_BASE_URL || "http://45.59.185.39:8899").replace(/\/+$/, "");

function has(bin) {
  try { execFileSync("which", [bin], { stdio: "ignore" }); return true; } catch { return false; }
}

function version() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;
}

function buildExe() {
  if (!has("makensis")) {
    throw new Error("未找到 makensis。请安装 NSIS：Debian/Ubuntu `apt-get install -y nsis`，macOS `brew install nsis`。");
  }
  const target = findTarget("win-x64");
  const stage = path.join(OUT, target.key);
  if (!fs.existsSync(path.join(stage, "runtime", "node.exe"))) {
    console.log("[win] 未发现已组装的 win-x64 程序目录，先组装…");
    assemble(target);
  }

  // 1) 打运行环境 zip（供首启下载）并算出 manifest。
  const manifest = packRuntime(target, RUNTIME_BASE_URL);

  // 2) 把 manifest 写进 stage 内 packaging/windows/runtime-manifest.json（随小安装包分发，供 fetch-runtime.ps1 读取）。
  const manifestPath = path.join(stage, "packaging", "windows", "runtime-manifest.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ url: manifest.url, sha256: manifest.sha256, version: manifest.version }, null, 2),
  );
  console.log(`[win] 运行环境地址写入 manifest：${manifest.url}`);

  // 3) 编译 NSIS 小安装器（File /r 时排除 runtime 与 node_modules）。
  const ver = version();
  fs.mkdirSync(DIST, { recursive: true });
  const outFile = path.join(DIST, `HaixinAI-${ver}-win-x64-Setup.exe`);
  const nsi = path.join(REPO_ROOT, "packaging", "windows", "installer.nsi");
  console.log("[win] 编译 NSIS 安装器（小包，不含运行环境）…");
  execFileSync(
    "makensis",
    [
      `-DSTAGE_DIR=${stage}`,
      `-DOUT_FILE=${outFile}`,
      `-DAPP_VERSION=${ver}`,
      "-INPUTCHARSET", "UTF8",
      nsi,
    ],
    { stdio: "inherit", cwd: REPO_ROOT },
  );
  console.log(`\n[win] ✓ 安装器：${outFile}  ${(fs.statSync(outFile).size / 1048576).toFixed(1)}MB`);
  console.log(`[win] ✓ 运行环境：${manifest.zipPath}  ${(manifest.size / 1048576).toFixed(1)}MB`);
  console.log(`[win]   → 请把 haixin-runtime-win-x64.zip 上传到 ${RUNTIME_BASE_URL}/ 使其可被下载。`);
  return { outFile, manifest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildExe();
}

export { buildExe };
