-- 定时任务调度所需的四列。
--
-- 此前界面上的"定时制/每日定时"只是写进 loop_type 和 trigger_type 的两个字符串：
-- 没有调度器、没有"下次几点跑"、也没记创建者，到点不会有任何事发生，
-- 而新建的任务却直接显示成"已启用"，看不出它其实永远不会自己运行。
--
-- created_by   定时触发时没有登录用户，用创建者的身份跑。调模型的密钥是按用户
--              存在 user_model_profiles 里的，没有身份就取不到密钥，第一步就会失败。
-- schedule_time 每天几点，北京时间 "HH:MM"，空串表示不定时。
-- next_run_at  下次该跑的时刻，UTC ISO 串。库里一律 UTC，界面一律北京时间。
-- enabled      调度开关。status 一列同时承担"已启用/停用"和"已完成/运行失败"两种语义，
--              跑完一次就变成"已完成"，无法据此判断还该不该继续调度，所以单独拆一列。
--              存量数据一律 0：它们本来就没有排期，不该在升级后突然开始自己运行。
ALTER TABLE `workflows` ADD COLUMN `created_by` text NOT NULL DEFAULT '';
ALTER TABLE `workflows` ADD COLUMN `schedule_time` text NOT NULL DEFAULT '';
ALTER TABLE `workflows` ADD COLUMN `next_run_at` text;
ALTER TABLE `workflows` ADD COLUMN `enabled` integer NOT NULL DEFAULT 0;

-- tick 每分钟按 (enabled, next_run_at) 捞到期任务。
CREATE INDEX IF NOT EXISTS `workflows_schedule_idx` ON `workflows` (`enabled`, `next_run_at`);
