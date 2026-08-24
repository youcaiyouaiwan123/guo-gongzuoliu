// 打包目标定义：三个交付目标 + 一个本机联调目标（linux）。
// nodeSpec 用于从 nodejs.org 取对应平台的独立 Node 运行时；os/cpu 传给 npm 拉对应平台原生包。
export const NODE_VERSION = "v22.13.1"; // 满足 engines>=22.13.0 的 LTS 线；构建机一次性下载

export const TARGETS = [
  {
    key: "win-x64",
    os: "win32",
    cpu: "x64",
    node: { dist: "win-x64", ext: "zip", bin: "node.exe" },
    installer: "windows",
  },
  {
    key: "mac-x64",
    os: "darwin",
    cpu: "x64",
    node: { dist: "darwin-x64", ext: "tar.gz", bin: "bin/node" },
    installer: "macos",
  },
  {
    key: "mac-arm64",
    os: "darwin",
    cpu: "arm64",
    node: { dist: "darwin-arm64", ext: "tar.gz", bin: "bin/node" },
    installer: "macos",
  },
];

// 本机（Linux x64）：仅用于验证裁剪逻辑与断网冒烟，不产出安装包。
export const LOCAL_TARGET = {
  key: "linux-x64",
  os: "linux",
  cpu: "x64",
  node: { dist: "linux-x64", ext: "tar.xz", bin: "bin/node" },
  installer: null,
};

export function findTarget(key) {
  return [...TARGETS, LOCAL_TARGET].find((t) => t.key === key);
}
