-- 日志表纳入版本化迁移。
--
-- system_logs / frontend_logs 此前只在运行时按需建表（app/api/_logger.ts 的 setLogDb、
-- app/api/frontend-logs/route.ts 的 ensureSchema），迁移未覆盖。空库部署若某条日志写入
-- 尚未触发建表，读取端就会撞上"表不存在"。这里把两张表补进迁移，成为唯一事实来源；
-- 运行时的 CREATE TABLE IF NOT EXISTS 保持幂等，两边并存也不冲突。
--
-- 列定义与运行时建表逐字一致：
--   system_logs   服务端结构化日志：level/message/meta/url/method/status/duration_ms/created_at
--   frontend_logs 前端上报日志：level/message/meta/url/user_agent/created_at
CREATE TABLE IF NOT EXISTS `system_logs` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `level` text NOT NULL,
  `message` text NOT NULL,
  `meta` text NOT NULL DEFAULT '{}',
  `url` text NOT NULL DEFAULT '',
  `method` text NOT NULL DEFAULT '',
  `status` integer NOT NULL DEFAULT 0,
  `duration_ms` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `frontend_logs` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `level` text NOT NULL,
  `message` text NOT NULL,
  `meta` text NOT NULL DEFAULT '{}',
  `url` text NOT NULL DEFAULT '',
  `user_agent` text NOT NULL DEFAULT '',
  `created_at` text NOT NULL
);
