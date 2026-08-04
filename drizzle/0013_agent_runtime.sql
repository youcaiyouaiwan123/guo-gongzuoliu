CREATE TABLE IF NOT EXISTS agent_configs (
  agent_id INTEGER PRIMARY KEY,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  agent_name TEXT NOT NULL,
  actor TEXT NOT NULL,
  model_used TEXT NOT NULL DEFAULT '',
  input TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_runs_agent_idx ON agent_runs(agent_id, id);
