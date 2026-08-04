CREATE TABLE IF NOT EXISTS `org_units` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `unit_type` text NOT NULL DEFAULT '部门',
  `parent_id` integer,
  `manager_email` text NOT NULL DEFAULT '',
  `sort_order` integer NOT NULL DEFAULT 0,
  `created_by` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `org_members` (
  `email` text PRIMARY KEY NOT NULL,
  `unit_id` integer NOT NULL,
  `job_title` text NOT NULL DEFAULT '员工',
  `direct_manager_email` text NOT NULL DEFAULT '',
  `status` text NOT NULL DEFAULT '在岗',
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `org_transfer_requests` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `email` text NOT NULL,
  `from_unit_id` integer,
  `to_unit_id` integer NOT NULL,
  `job_title` text NOT NULL DEFAULT '员工',
  `reason` text NOT NULL DEFAULT '',
  `status` text NOT NULL DEFAULT '待审批',
  `decided_by` text NOT NULL DEFAULT '',
  `created_at` text NOT NULL,
  `decided_at` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `org_reports` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `sender_email` text NOT NULL,
  `recipient_email` text NOT NULL,
  `unit_id` integer,
  `title` text NOT NULL,
  `content` text NOT NULL,
  `ai_summary` text NOT NULL DEFAULT '',
  `importance` text NOT NULL DEFAULT '普通',
  `status` text NOT NULL DEFAULT '未读',
  `attachment_document_id` integer,
  `created_at` text NOT NULL,
  `handled_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `org_units_parent_idx` ON `org_units` (`parent_id`,`sort_order`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `org_members_unit_idx` ON `org_members` (`unit_id`,`email`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `org_reports_recipient_idx` ON `org_reports` (`recipient_email`,`status`,`id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `org_report_mentions` (
  `report_id` integer NOT NULL,
  `email` text NOT NULL,
  `status` text NOT NULL DEFAULT '未读',
  PRIMARY KEY (`report_id`,`email`)
);
--> statement-breakpoint
ALTER TABLE `knowledge_documents` ADD COLUMN `department_id` integer;
