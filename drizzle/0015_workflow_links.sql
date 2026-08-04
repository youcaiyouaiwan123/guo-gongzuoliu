ALTER TABLE `workflow_runs` ADD COLUMN `conversation_id` integer;
--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD COLUMN `source_channel` text NOT NULL DEFAULT '工作流中心';
--> statement-breakpoint
ALTER TABLE `approval_requests` ADD COLUMN `workflow_run_id` integer;
--> statement-breakpoint
ALTER TABLE `approval_requests` ADD COLUMN `workflow_step_index` integer;
