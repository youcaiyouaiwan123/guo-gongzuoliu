ALTER TABLE `workflows` ADD `loop_type` text DEFAULT '单次' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD `review_mode` text DEFAULT '明确标准' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD `review_standard` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD `stop_condition` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD `max_loops` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD `final_action` text DEFAULT '人工确认' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD `failure_action` text DEFAULT '通知负责人' NOT NULL;