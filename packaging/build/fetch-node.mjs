// 下载各目标平台的独立 Node 运行时到 packaging/vendor/node/<key>/。构建机联网执行一次；
// 产物随安装包分发，目标机零下载。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NODE_VERSION, TARGETS, LOCAL_TARGET } from "./targets.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VENDOR = path.join(REPO_ROOT, "packaging", "vendor", "node");

function download(url, dest) {
  console.log(`[node] 下载 ${url}`);
  execFileSync("curl", ["-fsSL", "-o", dest, url], { stdio: "inherit", timeout: 300_000 });
}

// 取出目标平台的 node 可执行文件，放到 vendor/node/<key>/（win 为 node.exe，unix 为 bin/node）。
export function fetchNode(target) {
  const outDir = path.join(VENDOR, target.key);
  const finalBin = path.join(outDir, target.node.bin);
  if (fs.existsSync(finalBin)) {
    console.log(`[node] ${target.key} 已存在，跳过。`);
    return outDir;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const base = `node-${NODE_VERSION}-${target.node.dist}`;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${base}.${target.node.ext}`;
  const tmp = path.join(outDir, `dl.${target.node.ext}`);
  download(url, tmp);

  if (target.node.ext === "zip") {
    execFileSync("unzip", ["-oq", tmp, "-d", outDir], { stdio: "inherit" });
    fs.copyFileSync(path.join(outDir, base, "node.exe"), path.join(outDir, "node.exe"));
    fs.rmSync(path.join(outDir, base), { recursive: true, force: true });
  } else {
    execFileSync("tar", ["-xf", tmp, "-C", outDir], { stdio: "inherit" });
    fs.mkdirSync(path.join(outDir, "bin"), { recursive: true });
    fs.copyFileSync(path.join(outDir, base, "bin", "node"), path.join(outDir, "bin", "node"));
    fs.chmodSync(path.join(outDir, "bin", "node"), 0o755);
    fs.rmSync(path.join(outDir, base), { recursive: true, force: true });
  }
  fs.rmSync(tmp, { force: true });
  console.log(`[node] ${target.key}: ${finalBin}`);
  return outDir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv[2];
  const list = [...TARGETS, LOCAL_TARGET].filter((t) => !only || t.key === only);
  for (const t of list) fetchNode(t);
}
