CREATE TABLE `saved_artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_email` text NOT NULL,
	`title` text NOT NULL,
	`artifact_type` text NOT NULL,
	`source_type` text NOT NULL,
	`content` text NOT NULL,
	`config` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
