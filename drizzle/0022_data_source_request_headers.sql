-- 采集任务的自定义请求头（每行 Key: Value）。
-- 企业自有 API 基本都要带 Authorization / X-Api-Key，之前无处可填，
-- "JSON 抓取失败"里有相当一部分是接口直接返回 401/403。
-- 值属于凭据，审计日志只记录头名称，不落值。
ALTER TABLE `data_source_details` ADD COLUMN `request_headers` text NOT NULL DEFAULT '';
