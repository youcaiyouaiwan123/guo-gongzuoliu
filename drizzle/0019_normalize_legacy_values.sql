-- 历史脏数据一次性规范化。
-- 这些修复此前写在 _auth.ts 的 ensureAuthTables 里，每次 API 认证都会全表扫描并逐行写回，
-- 属于清单要求移除的“请求链路中的全表修复”。乱码值来自早期 GBK/UTF-8 混淆，
-- 新写入的数据取自代码常量不会再产生，因此一次性修复即可；
-- 读取路径仍有 normalizeRoleValue / normalizeStatusValue 兜底。

-- role_permissions 存在 UNIQUE(role,capability)：若多行乱码 role 归一后重复，
-- 直接 UPDATE 会触发唯一约束错误（既有实现正是如此，会导致认证接口整体失败）。
-- 因此先按归一后的键去重，保留每组最新一行。
DELETE FROM role_permissions WHERE id NOT IN (
  SELECT MAX(id) FROM role_permissions GROUP BY
    CASE WHEN role LIKE '%管理%' OR lower(role) LIKE '%admin%' OR lower(role) LIKE '%owner%' OR role LIKE '%绠＄悊%'
      THEN '管理员' ELSE '普通员工' END,
    capability
);
--> statement-breakpoint
UPDATE role_permissions SET role='管理员'
  WHERE role<>'管理员' AND (role LIKE '%管理%' OR lower(role) LIKE '%admin%' OR lower(role) LIKE '%owner%' OR role LIKE '%绠＄悊%');
--> statement-breakpoint
UPDATE role_permissions SET role='普通员工' WHERE role<>'管理员' AND role<>'普通员工';
--> statement-breakpoint
UPDATE role_permissions SET decision='允许'
  WHERE decision<>'允许' AND (decision LIKE '%允许%' OR lower(decision) LIKE '%allow%' OR decision LIKE '%鍏佽%' OR decision LIKE '%通过%');
--> statement-breakpoint
UPDATE role_permissions SET decision='需审批'
  WHERE decision<>'允许' AND decision<>'需审批' AND (decision LIKE '%审批%' OR lower(decision) LIKE '%review%' OR decision LIKE '%瀹℃壒%');
--> statement-breakpoint
UPDATE role_permissions SET decision='拒绝' WHERE decision NOT IN ('允许','需审批');
--> statement-breakpoint
UPDATE user_roles SET role='管理员'
  WHERE role<>'管理员' AND (role LIKE '%管理%' OR lower(role) LIKE '%admin%' OR lower(role) LIKE '%owner%' OR role LIKE '%绠＄悊%');
--> statement-breakpoint
UPDATE user_roles SET role='普通员工' WHERE role<>'管理员' AND role<>'普通员工';
--> statement-breakpoint
UPDATE frontend_users SET status='禁用'
  WHERE status<>'禁用' AND (status LIKE '%禁用%' OR lower(status) LIKE '%disabled%' OR status LIKE '%绂佺敤%');
--> statement-breakpoint
UPDATE frontend_users SET status='启用' WHERE status<>'禁用' AND status<>'启用';
