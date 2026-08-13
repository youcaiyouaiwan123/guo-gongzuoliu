// 统一分页参数解析。所有分页接口约定：
// - 请求：?page（默认 1，下限 1）、?pageSize（默认 20，上限 maxPageSize）
// - 响应：{ ...items, total, page, pageSize }
// 供前端 <Pager> 组件消费。
export type PageParams = { page: number; pageSize: number; offset: number };

export function parsePageParams(
  url: URL,
  opts: { defaultPageSize?: number; maxPageSize?: number } = {},
): PageParams {
  const defaultPageSize = opts.defaultPageSize ?? 20;
  const maxPageSize = opts.maxPageSize ?? 100;
  const rawPage = Number(url.searchParams.get("page"));
  const rawPageSize = Number(url.searchParams.get("pageSize"));
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1
    ? Math.min(Math.floor(rawPageSize), maxPageSize)
    : defaultPageSize;
  return { page, pageSize, offset: (page - 1) * pageSize };
}
