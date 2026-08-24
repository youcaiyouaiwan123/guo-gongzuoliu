#!/bin/bash
# 海芯 AI 平台 — 在 macOS 上产出离线安装包 .pkg。
# 用法：packaging/macos/build-pkg.sh [mac-arm64|mac-x64]   （默认 mac-arm64）
#
# 必须在 macOS 上运行（依赖 pkgbuild/productbuild）；构建机需先联网跑过组装步骤：
#   node packaging/build/build.mjs <arch>      # 下载对应 Node、裁剪 darwin workerd、组装程序目录树
# 本脚本把组装好的 packaging/build/out/<arch> 作为 payload（安装到 /Applications/HaixinAI），
# 附 preinstall/postinstall 脚本，产出 packaging/build/dist/HaixinAI-<ver>-<arch>.pkg。
#
# 目标机完全离线：所有运行时（Node/workerd/依赖）都在 payload 内。
# 未签名/未公证的 .pkg 会触发 Gatekeeper——放行方法见 packaging/README.md。
set -euo pipefail

ARCH="${1:-mac-arm64}"
case "${ARCH}" in
  mac-arm64|mac-x64) ;;
  *) echo "错误：arch 必须是 mac-arm64 或 mac-x64（收到 ${ARCH}）"; exit 1 ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  echo "错误：.pkg 必须在 macOS 上构建（当前 $(uname -s)）。请在 Mac 或 macOS CI 上运行本脚本。"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE="${REPO_ROOT}/packaging/build/out/${ARCH}"
SCRIPTS="${REPO_ROOT}/packaging/macos/scripts"
DIST="${REPO_ROOT}/packaging/build/dist"
IDENT="com.haixin.ai"
VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"

if [ ! -x "${STAGE}/runtime/bin/node" ]; then
  echo "未发现已组装的 ${ARCH} 程序目录（${STAGE}）。请先运行："
  echo "    node packaging/build/build.mjs ${ARCH}"
  exit 1
fi

chmod +x "${SCRIPTS}/preinstall" "${SCRIPTS}/postinstall"
mkdir -p "${DIST}"

COMPONENT="$(mktemp -d)/HaixinAI-component.pkg"
OUT_PKG="${DIST}/HaixinAI-${VERSION}-${ARCH}.pkg"

echo "[pkg] pkgbuild（payload → /Applications/HaixinAI）…"
pkgbuild \
  --root "${STAGE}" \
  --install-location "/Applications/HaixinAI" \
  --scripts "${SCRIPTS}" \
  --identifier "${IDENT}" \
  --version "${VERSION}" \
  --ownership recommended \
  "${COMPONENT}"

echo "[pkg] productbuild（可分发安装包）…"
productbuild \
  --package "${COMPONENT}" \
  --identifier "${IDENT}.installer" \
  --version "${VERSION}" \
  "${OUT_PKG}"

# 如设置了 Developer ID 证书，可选签名（否则输出未签名包）：
#   productsign --sign "Developer ID Installer: <NAME> (<TEAMID>)" "${OUT_PKG}" "${OUT_PKG%.pkg}-signed.pkg"
#   xcrun notarytool submit ... && xcrun stapler staple "${OUT_PKG}"

echo "[pkg] ✓ 产出：${OUT_PKG}"
ls -lh "${OUT_PKG}"
