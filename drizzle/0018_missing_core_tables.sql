-- 补齐此前只在运行时创建、迁移未覆盖的核心表。
-- 定义逐字取自各表的权威写入方，保证迁移建出的结构与运行时一致。

CREATE TABLE IF NOT EXISTS frontend_users (email TEXT PRIMARY KEY,display_name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT '启用',email_verified_at TEXT DEFAULT '',last_login_at TEXT DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS login_sessions (token TEXT PRIMARY KEY,email TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS user_security (email TEXT PRIMARY KEY,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS email_verification_codes (email TEXT PRIMARY KEY,code_hash TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mail_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,subject TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS data_collection_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,source_id INTEGER NOT NULL,source_name TEXT NOT NULL,actor TEXT NOT NULL,status TEXT NOT NULL,http_status INTEGER NOT NULL DEFAULT 0,row_count INTEGER NOT NULL DEFAULT 0,content_type TEXT NOT NULL DEFAULT '',preview TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',model_used TEXT NOT NULL DEFAULT '',target_store TEXT NOT NULL DEFAULT 'personal',output_format TEXT NOT NULL DEFAULT 'markdown',collector_mode TEXT NOT NULL DEFAULT 'direct',created_at TEXT NOT NULL,published_at TEXT);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS data_source_details (source_id INTEGER PRIMARY KEY,request_method TEXT NOT NULL DEFAULT 'GET',content_selector TEXT NOT NULL DEFAULT '',extract_fields TEXT NOT NULL DEFAULT '',target_category TEXT NOT NULL DEFAULT '数据采集',visibility TEXT NOT NULL DEFAULT '全员',publish_mode TEXT NOT NULL DEFAULT 'auto',sample_data TEXT NOT NULL DEFAULT '',model_mode TEXT NOT NULL DEFAULT 'auto',target_store TEXT NOT NULL DEFAULT 'personal',output_format TEXT NOT NULL DEFAULT 'markdown',collector_mode TEXT NOT NULL DEFAULT 'direct',created_by TEXT NOT NULL DEFAULT '');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS user_model_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,connection_name TEXT NOT NULL,provider TEXT NOT NULL,base_url TEXT NOT NULL,model_name TEXT NOT NULL,encrypted_api_key TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS user_image_model_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,connection_name TEXT NOT NULL,provider TEXT NOT NULL,base_url TEXT NOT NULL,model_name TEXT NOT NULL,encrypted_api_key TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS generated_images (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,model_profile_id INTEGER,provider TEXT NOT NULL,model_name TEXT NOT NULL,prompt TEXT NOT NULL,optimized_prompt TEXT NOT NULL,size TEXT NOT NULL,quality TEXT NOT NULL,image_url TEXT,image_data_url TEXT,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS contract_templates (id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',content TEXT NOT NULL,variables TEXT NOT NULL,sections TEXT NOT NULL DEFAULT '[]',created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS contract_documents (id INTEGER PRIMARY KEY AUTOINCREMENT,template_id INTEGER NOT NULL,template_title TEXT NOT NULL DEFAULT '',title TEXT NOT NULL,filled_values TEXT NOT NULL,content TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS monitoring_reports (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_email TEXT NOT NULL,title TEXT NOT NULL,platform TEXT NOT NULL,raw_rows TEXT NOT NULL,report TEXT NOT NULL,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `login_sessions_email_idx` ON `login_sessions` (`email`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `login_sessions_expires_idx` ON `login_sessions` (`expires_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `data_collection_runs_actor_idx` ON `data_collection_runs` (`actor`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `contract_documents_creator_idx` ON `contract_documents` (`created_by`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `monitoring_reports_owner_idx` ON `monitoring_reports` (`owner_email`, `id`);
