CREATE TABLE IF NOT EXISTS `workflow_runs` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `workflow_id` integer NOT NULL,
  `workflow_name` text NOT NULL,
  `actor` text NOT NULL,
  `status` text NOT NULL,
  `input` text DEFAULT '' NOT NULL,
  `output` text DEFAULT '' NOT NULL,
  `current_step` integer DEFAULT 0 NOT NULL,
  `error` text DEFAULT '' NOT NULL,
  `started_at` text NOT NULL,
  `finished_at` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflow_step_runs` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `run_id` integer NOT NULL,
  `step_index` integer NOT NULL,
  `step_type` text NOT NULL,
  `step_name` text NOT NULL,
  `status` text NOT NULL,
  `input` text DEFAULT '' NOT NULL,
  `output` text DEFAULT '' NOT NULL,
  `error` text DEFAULT '' NOT NULL,
  `started_at` text NOT NULL,
  `finished_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workflow_runs_actor_idx` ON `workflow_runs` (`actor`,`id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workflow_step_runs_run_idx` ON `workflow_step_runs` (`run_id`,`step_index`);
