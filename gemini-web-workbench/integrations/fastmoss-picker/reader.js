// Runs in the isolated extension world; reads only rendered page content.
// Keep self-contained: chrome.scripting serializes this function.
export function readPage(kind) {
  const text = el => (el?.innerText ?? el?.textContent ?? '').replace(/\u00a0/g, ' ').trim();
  const compact = el => text(el).replace(/\s+/g, '');
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const body = text(document.body);
  const problem = /访问过于频繁|请求过于频繁|操作过于频繁|请完成.{0,8}验证|安全验证|滑动.{0,8}验证|Access denied|Verify you are human/i;
  if (problem.test(body)) return {error:'网站要求验证或限制访问，请在扫描页处理后继续', blocked:true};
  if (/\/login(?:[/?]|$)/.test(location.href) || /登录后(?:即可)?查看|请先登录|登录后解锁/.test(body)) return {error:'需要在 FastMoss 登录后继续', blocked:true};
  const dates = [...document.querySelectorAll('input')].map(e=>e.value).filter(v=>/^\d{4}-\d{2}-\d{2}$/.test(v));
  const result = {url:location.href, title:document.title, dates};
  if (kind === 'meta') {
    const u = new URL(location.href), checked = [...document.querySelectorAll('input[type="radio"]:checked')];
    const selected = key => checked.find(e => e.value === u.searchParams.get(key))?.closest('label');
    return {...result,category:text(selected('l1_cid')) || (u.searchParams.has('l1_cid')?'当前已选分类':'全部分类'),country:text(selected('region')) || u.searchParams.get('region') || '当前国家',page:Number(u.searchParams.get('page')||1)};
  }
  if (kind === 'list') {
    const tables = [...document.querySelectorAll('table,[role="table"]')].filter(visible);
    let best = null;
    for (const table of tables) {
      const headers = [...table.querySelectorAll('thead th,[role="columnheader"]')].map(compact);
      const categoryIndex = headers.findIndex(t => t === '商品分类');
      const growthIndex = headers.findIndex(t=>t.startsWith('销量环比'));
      const commissionIndex = headers.findIndex(t=>t==='佣金比例');
      const productIndex = headers.findIndex(t => t === '商品');
      if (productIndex < 0) continue;
      const rows = [], unreadable = [];
      for (const row of table.querySelectorAll('tbody tr,[role="row"]')) {
        if (row.classList.contains('ant-table-measure-row') || row.getAttribute('aria-hidden') === 'true') continue;
        const cells = [...row.querySelectorAll(':scope > td,:scope > [role="cell"]')];
        if (!visible(row) || cells.length <= productIndex || !text(row)) continue;
        const links = [...row.querySelectorAll('a[href]')].map(a=>({a,u:new URL(a.getAttribute('href'),location.href)})).filter(x=>['www.fastmoss.com','fastmoss.com'].includes(x.u.hostname) && /\/e-commerce\/detail\/\d+/.test(x.u.pathname));
        const item = links.find(x=>text(x.a)) || links[0];
        if (!item) { unreadable.push({reason:'未识别到商品详情链接',text:text(row).slice(0,180)}); continue; }
        const name = text(item.a.querySelector('h3')) || item.a.getAttribute('title') || text(item.a).split(/售价[：:]/)[0].trim() || item.u.pathname;
        const priceRaw = text(cells[productIndex]).match(/售价\s*[：:]\s*([^\n]+)/)?.[1]?.trim() || '';
        const picture=item.a.querySelector('img');let imageUrl='';
        for(const raw of [picture?.currentSrc,picture?.getAttribute('data-src'),picture?.getAttribute('src')]) {
          if(!raw)continue;
          try{const u=new URL(raw,location.href);if(['https:','http:'].includes(u.protocol)){imageUrl=u.href;break;}}catch{}
        }
        item.u.search = ''; item.u.hash = '';
        rows.push({name,url:item.u.href,imageUrl,priceRaw,growthRaw:growthIndex>=0?text(cells[growthIndex]):'',commission:commissionIndex>=0?text(cells[commissionIndex]):'',category:categoryIndex>=0 ? text(cells[categoryIndex]) : ''});
      }
      const candidate = {...result,headers,rows,unreadable};
      if (!best || rows.length > best.rows.length) best = candidate;
    }
    if (!best || !best.rows.length) return {...result,error:best?.unreadable.length ? '商品行读取失败，请检查页面结构' : '未找到商品表格；请使用中文销量榜并等待加载', diagnostics:best};
    if (best.unreadable.length) return {...best,error:`有 ${best.unreadable.length} 行无法完整读取，已暂停以免遗漏商品`};
    // Active pagination is an extra guard against query parameters being ignored.
    const active = document.querySelector('.ant-pagination-item-active,.el-pager .is-active,.el-pager .active,[aria-current="page"]');
    best.activePage = active && /^\d+$/.test(text(active)) ? Number(text(active)) : null;
    return best;
  }
  const nodes = [...document.querySelectorAll('div,span,p,dt,dd,strong')];
  const cutoff = nodes.findIndex(el=>el.id==='overview');
  const labels = (cutoff<0?nodes:nodes.slice(0,cutoff)).filter(visible);
  function metric(names, optional = false) {
    const matches = labels.filter(el => names.includes(compact(el)) && ![...el.children].some(c=>names.includes(compact(c))));
    const found = [];
    for (const label of matches) {
      let box = label.parentElement;
      for (let depth=0; box && depth<6; depth++,box=box.parentElement) {
        const s = text(box);
        if (s.length > 160) break;
        const rest = s.replace(text(label),'').replace(/[：:]/g,'').trim();
        if (/^(?:[\d,]+(?:\.\d+)?\s*(?:人|万|k|K|m|M|%)?\+?|[-—–])$/.test(rest)) { found.push(rest); break; }
      }
    }
    const unique = [...new Set(found)];
    return unique.length === 1 ? unique[0] : null;
  }
  const creatorsRaw = metric(['带货达人数','带货人数']);
  if (creatorsRaw === null && kind!=='detailOptional') return {...result,error:'未能唯一识别顶部“带货达人数”，请检查登录/会员权限或页面结构'};
  const field = name => {
    const label=labels.find(el=>compact(el)===name+'：'||compact(el)===name+':');
    if(label&&text(label.nextElementSibling))return text(label.nextElementSibling);
    const re = new RegExp(name + '\\s*[：:]\\s*([\\d,.]+(?:\\s*[万亿kKmM%％])?\\+?|[-—–])');
    const summary=cutoff<0?body:nodes.slice(0,cutoff).filter(el=>!el.querySelector('#overview')).map(text).join('\n');
    return summary.match(re)?.[1] ?? metric([name], true) ?? '';
  };
  const priceLabel=labels.find(el=>/^价格[：:]$/.test(compact(el)));
  const priceRaw=priceLabel ? text(priceLabel.nextElementSibling) : '';
  return {...result,creatorsRaw,priceRaw,stock:field('库存'),commission:field('佣金率')};
}
