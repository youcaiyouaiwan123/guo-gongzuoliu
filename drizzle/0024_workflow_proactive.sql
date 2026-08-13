-- 主动制（事件触发）持续任务所需的五列。
--
-- 此前主动制只把 "事件触发" 写进 trigger_type，既没有事件源、没有触发条件，
-- 也没有任何代码消费它：建完显示 "已启用"，实际永远不会自己运行（见 Console 表单里
-- "主动制暂未接入事件源" 的静态说明）。这套字段让主动制真正激活。
--
-- watch_source_type   事件源类型：data_source（周期轮询某数据源）/ inbound_message（渠道入站消息）/
--                     free（通用 AI 观察，不绑定具体源）。空串=非主动制。
-- watch_source_ref    事件源引用：data_source 存数据源 id；inbound_message 存平台(feishu/dingtalk/wecom)；free 留空。
-- trigger_condition   自然语言触发条件，由 AI（judgeTrigger）判定是否命中。
-- check_interval_min  轮询间隔（分钟，仅 data_source/free 用）。tick 复用 next_run_at 作为"下次检查时刻"。
-- last_triggered_at   上次命中触发时刻（UTC ISO）。命中后进入冷却，避免每次心跳重复触发同一事件。
--
-- 复用 0023 已有的 enabled / next_run_at / created_by：
--   Lane A（轮询）把 next_run_at 当"下次该检查的时刻"，enabled=1 才被 tick 捞；
--   Lane B（入站消息）next_run_at 恒为 NULL，由 platform 消息入口即时评估。
-- 存量数据一律取默认：它们本来就不是主动制，升级后不该突然开始自己运行。
ALTER TABLE `workflows` ADD COLUMN `watch_source_type` text NOT NULL DEFAULT '';
ALTER TABLE `workflows` ADD COLUMN `watch_source_ref` text NOT NULL DEFAULT '';
ALTER TABLE `workflows` ADD COLUMN `trigger_condition` text NOT NULL DEFAULT '';
ALTER TABLE `workflows` ADD COLUMN `check_interval_min` integer NOT NULL DEFAULT 10;
ALTER TABLE `workflows` ADD COLUMN `last_triggered_at` text;

-- tick 的轮询车道按 (enabled, watch_source_type, next_run_at) 捞到期主动制任务。
CREATE INDEX IF NOT EXISTS `workflows_proactive_idx` ON `workflows` (`enabled`, `watch_source_type`, `next_run_at`);
