CREATE TABLE `ai_agents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`instructions` text NOT NULL,
	`knowledge_scope` text DEFAULT '全员' NOT NULL,
	`status` text DEFAULT '草稿' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `data_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`schedule` text DEFAULT '手动' NOT NULL,
	`status` text DEFAULT '待运行' NOT NULL,
	`last_run_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`trigger_type` text NOT NULL,
	`steps` text NOT NULL,
	`status` text DEFAULT '停用' NOT NULL,
	`last_run_at` text,
	`created_at` text NOT NULL
);
