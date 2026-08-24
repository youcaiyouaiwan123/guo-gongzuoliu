"use client";

import { useMemo, useState } from "react";

// 前端本地分页 hook：对已一次性拉回的全量数组做按页切片，配合 <Pager> 使用。
// 页码自动钳制在 [1, totalPages]，所以当列表因轮询刷新/本地过滤而变短时不会越界，
// 也无需在过滤变化时手动重置页码。
export function usePaged<T>(items: readonly T[], pageSize = 10) {
  const [page, setPage] = useState(1);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const pageItems = useMemo(
    () => items.slice((safePage - 1) * pageSize, safePage * pageSize),
    [items, safePage, pageSize],
  );
  return { page: safePage, pageSize, total, totalPages, setPage, pageItems };
}
