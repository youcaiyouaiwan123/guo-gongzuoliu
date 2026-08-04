CREATE TABLE IF NOT EXISTS `auth_throttle` (
  `scope` text NOT NULL,
  `subject` text NOT NULL,
  `window_started_at` text NOT NULL,
  `attempts` integer NOT NULL DEFAULT 0,
  `locked_until` text NOT NULL DEFAULT '',
  PRIMARY KEY (`scope`, `subject`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `auth_throttle_locked_idx` ON `auth_throttle` (`locked_until`);
