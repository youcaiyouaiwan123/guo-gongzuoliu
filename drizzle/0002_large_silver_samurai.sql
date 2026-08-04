CREATE TABLE `user_roles` (
	`email` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT '普通员工' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
