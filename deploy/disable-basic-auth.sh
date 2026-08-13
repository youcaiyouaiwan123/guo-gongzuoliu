#!/usr/bin/env bash
# 去掉 nginx 外层 Basic Auth 后的收尾脚本：
#   1) 删除已无人引用的 htpasswd 文件；
#   2) 重建 web(nginx) 容器让新配置生效。
# 在服务器上、已部署过的环境中执行。可重复运行（幂等）。
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/haixin-ai}"
SHARED_HTPASSWD="$APP_ROOT/shared/deploy/users.htpasswd"
CURRENT="$APP_ROOT/current"

# 选择 docker compose 命令
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "未找到 docker compose，请先安装。" >&2
  exit 1
fi

# 1) 清理遗留的 htpasswd
if [[ -f "$SHARED_HTPASSWD" ]]; then
  rm -f "$SHARED_HTPASSWD"
  echo "已删除遗留文件：$SHARED_HTPASSWD"
else
  echo "无遗留 htpasswd，跳过。"
fi

# 2) 重建 nginx 容器（--force-recreate 确保卷挂载变更被应用）
cd "$CURRENT"
"${COMPOSE[@]}" --env-file "$APP_ROOT/shared/.env" -f docker-compose.server.yml up -d --force-recreate web
"${COMPOSE[@]}" --env-file "$APP_ROOT/shared/.env" -f docker-compose.server.yml ps web

echo "完成：外层 Basic Auth 已移除，访问将直接进入应用登录页。"
