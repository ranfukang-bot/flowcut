// Keep the same displayed-value semantics as the DOM reader. In particular,
// list totals are historical observations, not substitutes for current details.
const raw = value => value == null ? '' : String(value);
export function apiList(data, url, page) {
  const items = Array.isArray(data?.rank_list) ? data.rank_list : (Array.isArray(data?.list) ? data.list : null);
  if (!items || !items.length) throw new Error('接口未返回商品；可能已到末页或会员可读范围');
  const base = new URL(url);
  const prefix = base.pathname.replace(/(?:saleslist|newProducts)\/?$/, 'detail/');
  const ids = new Set();
  const rows = items.map(p => {
    if (typeof p.product_id !== 'string' || !/^\d+$/.test(p.product_id) || !p.title || ids.has(p.product_id)) throw new Error('接口商品标识缺失、重复或精度不可靠');
    ids.add(p.product_id);
    return {productId:p.product_id, name:p.title, url:base.origin+prefix+p.product_id, imageUrl:raw(p.cover), priceRaw:raw(p.real_price), growthRaw:raw(p.sold_count_inc_rate), commission:raw(p.commission_rate_show || p.commission_rate), category:Array.isArray(p.category_name)?p.category_name.join(' / '):'', listCreatorsRaw:raw(p.author_count_show || p.total_author_count_show), dataSource:'api'};
  });
  return {url, rows, activePage:page, totalCount:data.total_count ?? data.total};
}
export function apiDetail(data) {
  const p = data?.product;
  if (!p || typeof p !== 'object') throw new Error('接口未返回商品详情');
  return {creatorsRaw:raw(p.author_count_show || p.total_author_count_show), priceRaw:raw(p.real_price), stock:raw(p.stock_count_show || p.stock_count), commission:raw(p.commission_rate_show || p.commission_rate), dataSource:'api'};
}
