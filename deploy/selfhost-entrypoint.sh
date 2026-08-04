#!/bin/sh
set -eu
PERSIST_DIR="${PERSIST_DIR:-/data}"
CONFIG_FILE="/app/dist/server/wrangler.json"
MIGRATION_DIR="/app/drizzle"
LEGACY_MARKER="$PERSIST_DIR/.migrations-applied"

# 生产凭据缺失必须在触碰数据库之前终止，避免留下半初始化的实例。
if [ -z "${PLATFORM_CREDENTIALS_KEY:-}" ] || [ -z "${HAIXIN_GATEWAY_ADMIN_SECRET:-}" ] || [ -z "${DEFAULT_ADMIN_USERNAME:-}" ] || [ -z "${DEFAULT_ADMIN_PASSWORD:-}" ]; then
  echo "启动失败：PLATFORM_CREDENTIALS_KEY、HAIXIN_GATEWAY_ADMIN_SECRET、DEFAULT_ADMIN_USERNAME、DEFAULT_ADMIN_PASSWORD 均为必填项。" >&2
  exit 1
fi

mkdir -p "$PERSIST_DIR"

d1_command() {
  npx wrangler d1 execute site-creator-d1 --local --config "$CONFIG_FILE" --persist-to "$PERSIST_DIR" --command "$1" --yes
}

d1_file() {
  npx wrangler d1 execute site-creator-d1 --local --config "$CONFIG_FILE" --persist-to "$PERSIST_DIR" --file "$1" --yes
}

# 迁移历史表是数据库版本的唯一事实来源：逐条记录迁移名称、文件校验和与执行时间，
# 取代此前的 .migrations-applied 单一标记文件（该标记会让首启之后新增的迁移永远不被执行）。
d1_command "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)" >/dev/null

read_history() {
  npx wrangler d1 execute site-creator-d1 --local --config "$CONFIG_FILE" --persist-to "$PERSIST_DIR" \
    --command "SELECT name,checksum FROM schema_migrations" --json --yes \
    | python3 -c 'import json,sys
raw = sys.stdin.read()
start = raw.find("[")
if start < 0:
    sys.exit(3)
payload = json.loads(raw[start:])
rows = (payload[0].get("results") or []) if payload else []
for row in rows:
    print("%s %s" % (row["name"], row["checksum"]))'
}

APPLIED=$(read_history) || {
  echo "启动失败：无法读取迁移历史表，请确认数据卷 $PERSIST_DIR 可写且 D1 绑定正常。" >&2
  exit 1
}

# 旧部署只有 .migrations-applied 标记而没有历史表。drizzle 生成的 0000-0007 与 0015 是非幂等迁移，
# 重跑会直接报错，因此这里把当前迁移登记为已应用并归档旧标记，完成一次性接管。
if [ -f "$LEGACY_MARKER" ] && [ -z "$APPLIED" ]; then
  echo "检测到旧版 .migrations-applied 标记，正在将现有迁移登记进历史表（不重复执行）。" >&2
  for migration in "$MIGRATION_DIR"/*.sql; do
    [ -f "$migration" ] || continue
    name=$(basename "$migration")
    checksum=$(sha256sum "$migration" | cut -d' ' -f1)
    d1_command "INSERT OR REPLACE INTO schema_migrations(name,checksum,applied_at) VALUES('$name','$checksum','$(date -u +%Y-%m-%dT%H:%M:%SZ)')" >/dev/null
    APPLIED="$APPLIED
$name $checksum"
  done
  mv "$LEGACY_MARKER" "$LEGACY_MARKER.migrated"
  echo "接管完成。若某条迁移在旧部署中实际从未执行，请删除 schema_migrations 中对应行后重启以补跑。" >&2
fi

for migration in "$MIGRATION_DIR"/*.sql; do
  [ -f "$migration" ] || continue
  name=$(basename "$migration")
  checksum=$(sha256sum "$migration" | cut -d' ' -f1)
  recorded=$(printf '%s\n' "$APPLIED" | awk -v target="$name" '$1 == target { print $2; exit }')
  if [ -n "$recorded" ]; then
    # 校验和不一致说明已应用的迁移文件被改写，结构与记录不再对应，必须阻止此版本启动。
    if [ "$recorded" != "$checksum" ]; then
      echo "启动失败：迁移 $name 校验和不一致（记录 $recorded，实际 $checksum）。请新增迁移而不要修改已应用的迁移。" >&2
      exit 1
    fi
    continue
  fi
  echo "正在执行迁移 $name"
  # d1_file 失败会因 set -e 终止脚本，写入历史记录的语句不会执行，失败的迁移不会被标记成功。
  d1_file "$migration"
  d1_command "INSERT INTO schema_migrations(name,checksum,applied_at) VALUES('$name','$checksum','$(date -u +%Y-%m-%dT%H:%M:%SZ)')" >/dev/null
done

exec npx wrangler dev --local --config "$CONFIG_FILE" --persist-to "$PERSIST_DIR" --ip 0.0.0.0 --port 3000 --log-level warn --no-show-interactive-dev-session \
  --var "PLATFORM_CREDENTIALS_KEY:${PLATFORM_CREDENTIALS_KEY}" \
  --var "HAIXIN_GATEWAY_ADMIN_SECRET:${HAIXIN_GATEWAY_ADMIN_SECRET}" \
  --var "DEFAULT_ADMIN_USERNAME:${DEFAULT_ADMIN_USERNAME}" \
  --var "DEFAULT_ADMIN_PASSWORD:${DEFAULT_ADMIN_PASSWORD}" \
  --var "MODEL_API_KEY:${MODEL_API_KEY:-}" \
  --var "MODEL_BASE_URL:${MODEL_BASE_URL:-https://claudecc.top}" \
  --var "MODEL_NAME:${MODEL_NAME:-claude-opus-4-5-20251101}" \
  --var "MODEL_RELAY_URL:${MODEL_RELAY_URL:-}" \
  --var "COLLECTOR_PROXY_URL:${COLLECTOR_PROXY_URL:-}"
