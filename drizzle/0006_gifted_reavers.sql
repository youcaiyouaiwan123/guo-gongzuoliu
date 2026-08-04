ALTER TABLE `knowledge_documents` ADD `filename` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_documents` ADD `mime_type` text DEFAULT 'text/plain' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_documents` ADD `file_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_documents` ADD `category` text DEFAULT '未分类' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_documents` ADD `tags` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_documents` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_documents` ADD `update_mode` text DEFAULT '手动更新' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_documents` ADD `update_schedule` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_documents` ADD `status` text DEFAULT '已索引' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_documents` ADD `size_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_documents` ADD `updated_at` text DEFAULT '' NOT NULL;