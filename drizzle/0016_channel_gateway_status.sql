CREATE TABLE IF NOT EXISTS `platform_gateway_status` (
  `owner_email` text NOT NULL,
  `platform` text NOT NULL,
  `instance_id` text NOT NULL DEFAULT '',
  `state` text NOT NULL DEFAULT 'offline',
  `last_heartbeat_at` text NOT NULL DEFAULT '',
  `last_connected_at` text NOT NULL DEFAULT '',
  `last_error` text NOT NULL DEFAULT '',
  `inbound_count` integer NOT NULL DEFAULT 0,
  `outbound_count` integer NOT NULL DEFAULT 0,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`owner_email`, `platform`)
);
