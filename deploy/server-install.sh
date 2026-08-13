#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/haixin-ai}"
RELEASE_NAME="${RELEASE_NAME:-$(date +%Y%m%d-%H%M%S)}"
ARCHIVE_PATH="${1:-}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-haixin}"

if [[ -z "$ARCHIVE_PATH" || ! -f "$ARCHIVE_PATH" ]]; then
  echo "Usage: deploy/server-install.sh /path/to/haixin-server-source.tar.gz" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required on the server." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Docker Compose is required on the server." >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate secrets and the admin password hash." >&2
  exit 1
fi

RELEASE_DIR="$APP_ROOT/releases/$RELEASE_NAME"
SHARED_DIR="$APP_ROOT/shared"
mkdir -p "$APP_ROOT/releases" "$SHARED_DIR/deploy" "$RELEASE_DIR"

tar -xzf "$ARCHIVE_PATH" -C "$RELEASE_DIR"

if [[ ! -f "$SHARED_DIR/.env" ]]; then
  if [[ -z "${DEFAULT_ADMIN_PASSWORD:-}" ]]; then
    echo "DEFAULT_ADMIN_PASSWORD is required for the first installation." >&2
    exit 1
  fi
  PLATFORM_SECRET="$(openssl rand -hex 32)"
  GATEWAY_SECRET="$(openssl rand -hex 32)"
  {
    printf 'PLATFORM_CREDENTIALS_KEY=%s\n' "$PLATFORM_SECRET"
    printf 'HAIXIN_GATEWAY_ADMIN_SECRET=%s\n' "$GATEWAY_SECRET"
    printf 'DEFAULT_ADMIN_USERNAME=%s\n' "${DEFAULT_ADMIN_USERNAME:-admin}"
    printf 'DEFAULT_ADMIN_PASSWORD=%s\n' "$DEFAULT_ADMIN_PASSWORD"
    printf 'HAIXIN_ACCOUNTS_JSON=\n'
  } > "$SHARED_DIR/.env"
  chmod 600 "$SHARED_DIR/.env"
  echo "ENV_CREATED=1"
else
  echo "ENV_EXISTS=1"
fi

ln -sfn "$SHARED_DIR/.env" "$RELEASE_DIR/.env"
ln -sfn "$RELEASE_DIR" "$APP_ROOT/current"

cd "$APP_ROOT/current"
COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" "${COMPOSE[@]}" -f docker-compose.server.yml up -d --build
COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" "${COMPOSE[@]}" -f docker-compose.server.yml ps

echo "DEPLOY_OK=1"
echo "APP_URL=http://$(hostname -I | awk '{print $1}')/"
