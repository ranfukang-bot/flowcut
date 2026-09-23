export const selectedProducts=new Set();
const pid=r=>r.productId||r.url?.match(/\/detail\/(\d+)/)?.[1]||'';
let update=()=>{};
export function workflowPickCell(row) {
  const td=document.createElement('td'),input=document.createElement('input');input.type='checkbox';input.checked=selectedProducts.has(row.url);input.disabled=row.status!=='ok';input.setAttribute('aria-label','选择 '+row.name);
  input.onchange=()=>{if(input.checked)selectedProducts.add(row.url);else selectedProducts.delete(row.url);update();};td.append(input);return td;
}
export function workflowIdCell(row) {
  const td=document.createElement('td'),code=document.createElement('code'),button=document.createElement('button');code.textContent=pid(row)||'未读取';code.style.display='block';button.textContent='复制 ID';button.disabled=!pid(row);button.onclick=async()=>{try{await navigator.clipboard.writeText(pid(row));button.textContent='已复制';}catch{button.textContent='请选中上方 ID 复制';}};td.append(code,button);return td;
}
export function mountWorkflowTransfer(getRows,refresh,getRegion) {
  const panel=document.createElement('section');panel.style.cssText='position:sticky;top:0;z-index:20;border:2px solid #16866a;background:#f2fff8;padding:15px';
  panel.innerHTML='<h2>送入FlowCut</h2><div class="line"><label>国家 <select id="wf-country"><option value="">沿用榜单国家</option><option value="ID">印尼 ID</option><option value="MY">马来 MY</option><option value="PH">菲律宾 PH</option><option value="TH">泰国 TH</option><option value="VN">越南 VN</option><option value="US">美国 US</option><option value="GB">英国 GB</option></select></label><button id="wf-all">全选合格商品</button><button id="wf-clear">清空选择</button><button id="wf-send" class="primary">发送所选商品</button><button id="wf-json">导出所选 JSON</button><button id="wf-open">打开工作台</button></div><p id="wf-info" role="status">请选择需要制作的商品，发送后到 FlowCut 商品库选择商品制作。</p>';
  document.querySelector('main').insertBefore(panel,document.querySelector('main section'));
  const q=id=>panel.querySelector('#'+id);
  update=()=>{q('wf-info').textContent=`已选择 ${getRows().filter(r=>selectedProducts.has(r.url)).length} 件商品`;};
  const payload=()=>{const region=q('wf-country').value||getRegion();if(!region)throw new Error('请在本栏选择国家，避免将不同市场的商品混在一起');const rows=getRows().filter(r=>selectedProducts.has(r.url)).map(r=>({...r,productId:pid(r),region}));if(!rows.length)throw new Error('请先勾选商品');return rows;};
  q('wf-all').onclick=()=>{getRows().forEach(r=>selectedProducts.add(r.url));refresh();update();};q('wf-clear').onclick=()=>{selectedProducts.clear();refresh();update();};
  const config=()=>fetch(chrome.runtime.getURL('bridge-config.json')).then(r=>{if(!r.ok)throw new Error('请先启动工作台，再重新加载这个扩展');return r.json();});
  q('wf-open').onclick=async()=>{try{const c=await config();await fetch(c.origin+'/api/flowcut/open',{method:'POST',headers:{'X-Workflow-Key':c.key}});}catch(e){q('wf-info').textContent=e.message;}};
  q('wf-send').onclick=async()=>{q('wf-send').disabled=true;try{const rows=payload(),c=await config();const response=await fetch(c.origin+'/api/workflow/products/import',{method:'POST',headers:{'Content-Type':'application/json','X-Workflow-Key':c.key},body:JSON.stringify({rows})});const result=await response.json();if(!response.ok)throw new Error(result.error);q('wf-info').textContent=`已发送 ${result.total} 件商品，新增 ${result.added} 件。请到 FlowCut 商品库查看。${result.results?.filter(r=>r.warning).length?" 部分商品图未读取，请在 FlowCut 补充图片。":""}`;}catch(e){q('wf-info').textContent=e.message.includes('fetch')?'工作台未连接，请先双击启动工作台':e.message;}finally{q('wf-send').disabled=false;}};
  q('wf-json').onclick=()=>{try{const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify({schema:1,rows:payload()},null,2)],{type:'application/json'}));a.href=url;a.download='选品制作清单.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);}catch(e){q('wf-info').textContent=e.message;}};
}
