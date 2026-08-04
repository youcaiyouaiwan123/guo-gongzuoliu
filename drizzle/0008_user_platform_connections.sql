CREATE TABLE IF NOT EXISTS user_platform_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_email TEXT NOT NULL,
  platform TEXT NOT NULL,
  encrypted_credentials TEXT NOT NULL,
  connection_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_email, platform)
);
