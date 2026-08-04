CREATE TABLE `platform_identities` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `platform` text NOT NULL,
  `platform_user_id` text NOT NULL,
  `email` text NOT NULL,
  `display_name` text DEFAULT '' NOT NULL,
  `created_at` text NOT NULL,
  UNIQUE(`platform`,`platform_user_id`)
);
--> statement-breakpoint
CREATE TABLE `platform_messages` (
  `event_id` text PRIMARY KEY NOT NULL,
  `platform` text NOT NULL,
  `platform_user_id` text DEFAULT '' NOT NULL,
  `status` text NOT NULL,
  `reply` text DEFAULT '' NOT NULL,
  `error` text DEFAULT '' NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `platform_identity_email_idx` ON `platform_identities` (`email`);
--> statement-breakpoint
CREATE INDEX `platform_message_created_idx` ON `platform_messages` (`created_at`);
