"use client";

// 通用分页控件。配合后端 _pagination.ts 的 { total, page, pageSize } 使用。
// 观感对齐权限中心的 pager（上一页 / 当前 / 总 / 下一页）。
// 默认总数不超过一页时不渲染；传 alwaysShow 则单页也显示（按钮自动禁用）。
export interface PagerProps {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  alwaysShow?: boolean;
}

export function Pager({ page, pageSize, total, onChange, alwaysShow = false }: PagerProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize && !alwaysShow) return null;
  return (
    <div className="pagerNav">
      <button type="button" className="outline" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button>
      <span className="pagerIndicator">{page} / {totalPages}</span>
      <button type="button" className="outline" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>下一页</button>
    </div>
  );
}
