CREATE TABLE IF NOT EXISTS personal_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_email TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT '手动创建',
  conversation_id INTEGER,
  sync_status TEXT NOT NULL DEFAULT '仅个人',
  enterprise_document_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS personal_knowledge_owner_idx ON personal_knowledge(owner_email,updated_at);
