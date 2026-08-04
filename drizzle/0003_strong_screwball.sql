CREATE TABLE `approval_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requester` text NOT NULL,
	`request_type` text NOT NULL,
	`title` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT '待审批' NOT NULL,
	`approver` text,
	`comment` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`role` text NOT NULL,
	`capability` text NOT NULL,
	`decision` text NOT NULL,
	`updated_at` text NOT NULL
);
