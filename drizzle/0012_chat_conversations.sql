CREATE TABLE IF NOT EXISTS `chat_conversations` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_email` text NOT NULL,
  `title` text NOT NULL DEFAULT '新对话',
  `model_mode` text NOT NULL DEFAULT 'auto',
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `chat_messages` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `conversation_id` integer NOT NULL,
  `role` text NOT NULL,
  `content` text NOT NULL,
  `sources` text NOT NULL DEFAULT '[]',
  `model_used` text NOT NULL DEFAULT '',
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `chat_conversations_owner_idx` ON `chat_conversations` (`owner_email`,`updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `chat_messages_conversation_idx` ON `chat_messages` (`conversation_id`,`id`);
