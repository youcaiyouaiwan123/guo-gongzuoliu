-- 部门同级重名冲突：接口层在 org_units 建/改时已用 findDuplicateUnit 拦截，
-- 这里补一道数据库兜底，防止旧版本客户端、脚本或并发写入绕过应用层校验。
--
-- 判重口径与接口一致：同一 parent_id 下名称唯一，parent 为空视为挂在老板节点下（IFNULL 归 0）。
-- 数据库只比较原始字符串，接口层还会额外做去空格/全角归一，两者是"宽索引 + 严校验"的组合。

-- 先处理存量重名，否则唯一索引创建会直接失败、整个部署卡住。
-- 后缀用节点 id 而不是序号：id 唯一，改名结果一定不会二次冲突，管理员看到"重名待处理"也知道要跟进。
UPDATE org_units SET name = name || '（重名待处理#' || id || '）'
WHERE EXISTS (
  SELECT 1 FROM org_units AS earlier
  WHERE earlier.id < org_units.id
    AND earlier.name = org_units.name
    AND IFNULL(earlier.parent_id, 0) = IFNULL(org_units.parent_id, 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `org_units_name_parent_unique` ON `org_units` (`name`, IFNULL(`parent_id`, 0));
