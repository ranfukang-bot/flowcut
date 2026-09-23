// Serialized by chrome.scripting into FastMoss's MAIN world. No credentials
// leave the page: use the site's existing authenticated request client.
export async function readApi(kind, input) {
  const fail = (error, blocked = false) => ({error, blocked});
  try {
    if (!['www.fastmoss.com','fastmoss.com'].includes(location.hostname)) return fail('请在 FastMoss 榜单页读取接口', true);
    if (/访问过于频繁|请求过于频繁|安全验证|Slide to complete the puzzle|Verify you are human|请先登录/i.test(document.body.innerText)) return fail('请在所选 FastMoss 榜单页完成登录或验证后继续', true);
    if (kind === 'context') {
      const current = new URL(location.href);
      if (!/\/e-commerce\/(?:saleslist|newProducts)\/?$/.test(current.pathname)) return fail('所选页面已离开销量榜或新品榜', true);
      // Same defaults and URL precedence as FastMoss's saleslist component.
      const isNew = current.pathname.includes('/newProducts');
      const params = {page:'1', pagesize:'10', order:'1,2', ...Object.fromEntries(current.searchParams)};
      if (isNew) {
        params.rank_type = params.rank_type || '11';
        if (!params.start_date || !params.end_date) {
          const dates = [...document.querySelectorAll('input')].map(e=>e.value).filter(v=>/^\d{4}-\d{2}-\d{2}$/.test(v));
          if (dates.length >= 2) {
            params.start_date = params.start_date || dates[0];
            params.end_date = params.end_date || dates[1];
          }
        }
      }
      if (!params.region) {
        const country = [...document.querySelectorAll('input[type="radio"]:checked')].find(el => /^[A-Z]{2}$/.test(el.value));
        if (country) params.region = country.value;
      }
      delete params._time; delete params.cnonce;
      if (String(params.pagesize) !== '10') return fail('网站每页数量已改变，请先使用逐页读取模式', true);
      return {params, sourceUrl:current.href, isNew};
    }
    const chunks = window.webpackChunk_N_E;
    if (!Array.isArray(chunks)) return fail('网站请求客户端已更新，请改用逐页读取模式', true);
    const entry = chunks.flatMap(c => Object.entries(c[1] || {})).find(([,factory]) => {
      const source = String(factory);
      return source.includes('interceptors.request.use') && source.includes('fm-sign') && source.includes('withCredentials');
    });
    if (!entry) return fail('未找到网站现有请求客户端，请刷新榜单或改用逐页读取模式', true);
    let requireModule;
    const marker = 'fastmoss_picker_' + crypto.randomUUID();
    chunks.push([[marker], {}, r => { requireModule = r; }]);
    chunks.pop();
    const client = Object.values(requireModule(entry[0])).find(v => v && typeof v.get === 'function' && typeof v.request === 'function');
    if (!client) return fail('网站请求客户端不兼容，请改用逐页读取模式', true);
    let path, params;
    if (kind === 'list') {
      const isNew = input.boardType === 'new' || input.isNew || input.params?.rank_type || /\/newProducts\/?$/.test(location.pathname);
      path = isNew ? '/api/goods/newProduct' : '/api/goods/saleRank';
      params = {...input.params, page:input.page, pagesize:10};
    } else if (kind === 'detail' && /^\d+$/.test(input.productId)) {
      path = '/api/goods/v3/base'; params = {product_id:input.productId};
    } else return fail('接口参数无效', true);
    const start = performance.now();
    const response = await client.get(path, params, {timeout:15000});
    if (response?.code !== 200) return fail('FastMoss 接口返回 ' + String(response?.code ?? '空响应') + '：' + (response?.msg || '请查看所选榜单的验证、登录或会员提示'), true);
    return {data:response.data, elapsedMs:Math.round(performance.now()-start)};
  } catch (e) {
    return fail(e.message || '接口读取失败', [401,403,429].includes(e.response?.status));
  }
}
