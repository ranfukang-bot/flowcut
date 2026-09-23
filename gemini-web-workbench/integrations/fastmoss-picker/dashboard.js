import { workflowPickCell, workflowIdCell, mountWorkflowTransfer, selectedProducts } from './workflow-transfer.js';
import {groups,csv,validListUrl,parseBound,validateBounds} from './core.mjs';
import {readPage} from './reader.js';
import {Runner} from './runner.mjs';
import {productCell} from './product-view.js';
import {readApi} from './api-reader.js';
import {apiList,apiDetail} from './api-core.mjs';
const resultPages=new Map(),tableCache=new Map();
const $=id=>document.getElementById(id);
let scopes=[],sources=[],workerId=null, busy=false;
let apiLastStarted=0;
let filterError='';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function message(s){$('status').textContent=s;}
function diagnostic(r){$('diagnostic').hidden=false;$('diagnostic').textContent=JSON.stringify(r,null,2);}
async function inject(tabId,kind) {
  if(kind==='detail' && runner.state?.settings.boardType==='new')kind='detailOptional';
  const r=await chrome.scripting.executeScript({target:{tabId},func:readPage,args:[kind]});
  if(!r[0]?.result) throw new Error('页面未返回数据');
  return r[0].result;
}
async function read(url,kind,delay,options={}) {
  if(runner.state?.settings.mode==='api')return readFast(url,kind);
  if(workerId) {
    try {await chrome.tabs.get(workerId);} catch {workerId=null;}
  }
  if(!workerId) {const t=await chrome.tabs.create({url,active:false});workerId=t.id;}
  else if(options.refresh&&(await chrome.tabs.get(workerId)).url===url)await chrome.tabs.reload(workerId);
  else await chrome.tabs.update(workerId,{url});
  const quickList=runner.state?.settings.boardType==='new' && runner.state?.settings.mode==='api';
  if(!quickList)await sleep(delay*1000);
  const deadline=Date.now()+40000;
  let last=null,stable='';
  while(Date.now()<deadline) {
    if(runner.stop) throw new Error('用户暂停');
    const tab=await chrome.tabs.get(workerId);
    const expected=new URL(url),actual=new URL(tab.url||url);
    if(actual.hostname!==expected.hostname || actual.pathname!==expected.pathname) {
      if(tab.status==='complete') throw Object.assign(new Error('页面跳转到了登录或其他地址，请查看扫描页'),{blocked:true});
    } else if(tab.status==='complete') {
      try {last=await inject(workerId,kind);} catch(e) {last={error:e.message};}
      if(last.blocked) return last;
      if(!last.error) {
        if(kind==='list' && new URL(last.url).searchParams.get('page')!==expected.searchParams.get('page')) throw new Error('网站未保留请求页码，停止扫描');
        const value=JSON.stringify(kind==='list'?last.rows:[last.creatorsRaw,last.priceRaw,last.stock,last.commission]);
        if(value===stable) return last;
        stable=value;
      } else stable='';
    }
    await sleep(quickList?350:1200);
  }
  diagnostic(last);
  throw new Error(last?.error || '页面等待超时，请查看扫描页后重试');
}
async function callApi(tabId,kind,input) {
  const result=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:readApi,args:[kind,input]});
  const value=result[0]?.result;
  if(!value)throw Object.assign(new Error('接口页面未返回数据，请刷新所选榜单后继续'),{blocked:true});
  if(value.error)throw Object.assign(new Error(value.error),{blocked:!!value.blocked});
  return value;
}
async function readFast(url,kind) {
  const s=runner.state, context=s.apiContext;
  if(!context)throw Object.assign(new Error('请重新选择已登录的 FastMoss 榜单后继续'),{blocked:true});
  try {
    const tab=await chrome.tabs.get(context.tabId);
    if(tab.url!==context.sourceUrl)throw new Error('所选榜单地址已改变');
  } catch(e) {throw Object.assign(new Error(e.message+'；请重新选择榜单并开始新扫描'),{blocked:true});}
  // One request at a time, ~3 starts per second; no full-page waits.
  await sleep(Math.max(0,300-(Date.now()-apiLastStarted)));
  if(runner.stop)throw Object.assign(new Error('用户暂停'),{cancelled:true});
  apiLastStarted=Date.now();
  const target=new URL(url),page=Number(target.searchParams.get('page')||1);
  const r=await callApi(context.tabId,kind,kind==='list'?{params:context.params,page,boardType:s.settings.boardType,isNew:s.settings.boardType==='new'}:{productId:target.pathname.match(/\/detail\/(\d+)\/?$/)?.[1]});
  s.apiStats??={requests:0,elapsedMs:0};s.apiStats.requests++;s.apiStats.elapsedMs+=r.elapsedMs;
  if(kind==='list'){
    const listRes=apiList(r.data,url,page);
    if(context.params?.start_date && context.params?.end_date){
      listRes.dates=[context.params.start_date,context.params.end_date];
    }
    return listRes;
  }
  return apiDetail(r.data);
}
const runner=new Runner({
  read,
  save:state=>chrome.storage.local.set({scan:state}),
  update:()=>render()
});

function link(row){const a=document.createElement('a');a.textContent='查看商品 ↗';a.className='product-button';a.href=row.url;a.target='_blank';a.rel='noopener noreferrer';return a;}
function table(id,rows){
  const isNew=runner.state?.settings.boardType==='new';
  const host=$(id),total=rows.length,pageCount=Math.max(1,Math.ceil(total/30));
  const page=Math.min(resultPages.get(id)||1,pageCount);resultPages.set(id,page);
  const visibleRows=rows.slice((page-1)*30,page*30);
  const signature=JSON.stringify([page,total,visibleRows]);if(tableCache.get(id)===signature)return;tableCache.set(id,signature);
  host.replaceChildren();
  if(total>30){const pager=document.createElement('div');pager.className='result-pager';
    const prev=document.createElement('button'),next=document.createElement('button'),label=document.createElement('span');prev.textContent='上一页';next.textContent='下一页';prev.disabled=page===1;next.disabled=page===pageCount;label.textContent='结果第 '+page+' / '+pageCount+' 页 · 共 '+total+' 件 · 每页30件（与来源榜单页码不同）';
    prev.onclick=()=>{resultPages.set(id,page-1);render();};next.onclick=()=>{resultPages.set(id,page+1);render();};pager.append(prev,label,next);host.append(pager);
  }
  if(!rows.length){const e=document.createElement('div');e.className='empty';e.textContent=runner.state?'目前没有符合条件的商品；筛选过程中会陆续显示。':'点击上方“开始筛选”，结果会直接显示在这里。';host.append(e);return;}
  const t=document.createElement('table'),head=document.createElement('thead'),hr=document.createElement('tr');
  for(const title of (isNew?['选择','产品 ID','商品','佣金率','库存','带货人数（参考）','商品分类','来源页 / 页内位置','操作']:['选择','产品 ID','商品','价格','销量环比','带货人数','商品分类','库存','佣金率','来源页 / 页内位置','操作'])){const th=document.createElement('th');th.textContent=title;hr.append(th);}head.append(hr);t.append(head);
  const body=document.createElement('tbody');
  for(const row of visibleRows){const tr=document.createElement('tr');tr.append(workflowPickCell(row),workflowIdCell(row),productCell(row));const position=row.page?('第 '+row.page+' 页'+(row.pagePosition?' · 第 '+row.pagePosition+' 件':'')):'未知';const values=isNew?[row.commission||'未读取',row.stock||'未读取',row.creatorsRaw||'未读取',row.category||row.scope,position]:[row.priceRaw||'未读取',row.growthRaw||'未读取',row.creatorsRaw??row.creators??'未读取',row.category||row.scope,row.stock||'—',row.commission||'—',position];for(const value of values){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}const action=document.createElement('td');action.append(link(row));if(row.error){const error=document.createElement('p');error.className='muted';error.textContent=row.error;action.append(error);}tr.append(action);body.append(tr);}t.append(body);host.append(t);
}
function currentGroups(){const s=runner.state;if(filterError)return {main:[],zero:[],dash:[],failed:[]};return groups(s?.rows||[],$('sort').value,s?.resultSettings||s?.settings||{});}
async function refilter(){
  const s=runner.state;if(!s||runner.running||busy)return;
  try {
    const settings={...s.settings};
    for(const [min,max,kind,label] of [['priceMin','priceMax','price','价格'],['commissionMin','commissionMax','commission','佣金比例'],['stockMin','stockMax','stock','库存'],['growthMin','growthMax','growth','销量环比'],['creatorMin','max','creators','带货人数']]){
      if(settings.boardType==='new'&&!['commission','stock'].includes(kind)){settings[min]=null;settings[max]=null;continue;}
      settings[min]=parseBound($(min).value,kind);settings[max]=parseBound($(max).value,kind);validateBounds(settings[min],settings[max],label);
    }
    filterError='';s.resultSettings=settings;render();
    message('已按当前条件重筛已有 '+s.rows.length+' 件商品，无需重新读取。扩大榜单范围需点击开始筛选。');
    await chrome.storage.local.set({scan:s});
  }catch(e){filterError=e.message;render();message('条件无效：'+e.message);}
}
function render(){
  const s=runner.state,g=currentGroups();if(s)message(s.status);
  const applied=s?.resultSettings||s?.settings;
  const isNew=s?.settings.boardType==='new';
  $('mainTitle').textContent=(isNew?'符合佣金和库存条件的新品':'符合条件的商品（带货人数非零）')+' · '+g.main.length+' 件';
  for(const id of ['zeroTitle','zeroResults','dashTitle','dashResults'])$(id).hidden=!!isNew;
  $('dashTitle').textContent='带货人数显示“-” · '+g.dash.length+' 件（不当作 0 人）';
  $('zeroTitle').textContent='带货人数为 0 · '+g.zero.length+' 件（单独列出）';
  $('failedTitle').textContent='需要人工核对 · '+g.failed.length+' 件';
  if(g.failed.length)$('failedSection').open=true;
  table('mainResults',g.main);table('zeroResults',g.zero);table('dashResults',g.dash);table('failedResults',g.failed);
  $('counts').textContent=s?'已读取榜单 '+s.pagesDone+'/'+s.settings.pages+' 页（失败跳过 '+(s.failedPages?.length||0)+' 页） · 收集 '+s.rows.length+' 件 · 已处理 '+s.detailIndex+' 件（读取失败跳过 '+s.rows.filter(r=>r.autoSkipped).length+' 件，万字跳过 '+s.rows.filter(r=>r.status==='skipped').length+' 件） · 合格 '+(g.main.length+g.zero.length+g.dash.length)+' 件':'';
  $('progress').max=s?(s.phase==='lists'?s.settings.pages:Math.max(1,s.rows.length)):1;
  $('progress').value=s?(s.complete?$('progress').max:s.phase==='lists'?s.pagesDone+(s.failedPages?.length||0):s.detailIndex):0;
  table('failedPages',(s?.failedPages||[]).map(p=>({name:p.scope+' · 第 '+p.page+' 页',url:p.url,error:'刷新两次后仍失败，已跳过：'+p.error})));
  $('failedPagesSection').hidden=!(s?.failedPages?.length);
  $('pause').disabled=!runner.running;$('resume').disabled=busy||runner.running||!s||s.complete;
  for(const id of ['start','refresh','probe','source','pages','priceMin','priceMax','commissionMin','commissionMax','stockMin','stockMax','growthMin','growthMax','creatorMin','max','delay','mode'])$(id).disabled=busy||runner.running;
  $('resultRule').textContent=s?'本次条件：带货人数少于 '+(s.settings.max??'不限')+'；价格 '+(s.settings.priceMin??'不限')+' 至 '+(s.settings.priceMax??'不限')+'（当地货币）；佣金 '+(s.settings.commissionMin??'不限')+' 至 '+(s.settings.commissionMax??'不限')+' %；库存 '+(s.settings.stockMin??'不限')+' 至 '+(s.settings.stockMax??'不限')+' 件；销量环比 '+(s.settings.growthMin??'不限')+' 至 '+(s.settings.growthMax??'不限')+' %；带货人数至少 '+(s.settings.creatorMin??'不限')+'。零人数与“-”单列。':'按带货人数、价格、销量环比、佣金比例和库存筛选，零人数与“-”单列。';
  if(isNew)$('resultRule').textContent='本次新品榜条件：佣金 '+(s.settings.commissionMin??'不限')+' 至 '+(s.settings.commissionMax??'不限')+' %；库存 '+(s.settings.stockMin??'不限')+' 至 '+(s.settings.stockMax??'不限')+' 件。带货人数仅供参考，不影响入选。';
  $('appliedRule').textContent=filterError?'条件无效，暂不显示合格结果：'+filterError:applied?'当前结果实际条件：佣金 '+(applied.commissionMin??'不限')+' 至 '+(applied.commissionMax??'不限')+' %；库存 '+(applied.stockMin??'不限')+' 至 '+(applied.stockMax??'不限')+' 件。数据范围：'+s.settings.pages+' 页；修改页数须重新开始。':'修改佣金和库存后，会立即重筛已读取的商品。';
  if(isNew)$('resultRule').textContent=$('appliedRule').textContent+' 带货人数仅供参考。';
}
function selectedNew(){return /\/newProducts\/?(?:\?|$)/.test(sources.find(t=>String(t.id)===$('source').value)?.url||'');}
function sourceHint(){const item=sources.find(t=>String(t.id)===$('source').value),isNew=selectedNew();$('sourceHint').textContent=item?'将筛选：'+item.label+'。点击开始后自动从第 1 页读取。':'没有找到榜单。请先在同一个浏览器打开 FastMoss 销量榜或新品榜，再点击“重新读取已打开的榜单”。';
  for(const id of ['priceMin','priceMax','growthMin','growthMax','creatorMin','max'])$(id).closest('label').hidden=isNew;
  for(const el of document.querySelectorAll('[data-sales-only]'))el.hidden=isNew;
  $('newHint').hidden=!isNew;
  $('pages').max=isNew?'50':'25';
}
async function refresh(){
  const selected=$('source').value;
  sources=(await chrome.tabs.query({url:['https://www.fastmoss.com/*','https://fastmoss.com/*']})).filter(t=>{try{validListUrl(t.url);return t.id!==workerId;}catch{return false;}});
  $('source').replaceChildren();
  for(const t of sources){let meta;try{meta=await inject(t.id,'meta');}catch{}const u=new URL(t.url);t.label=(u.pathname.includes('/newProducts')?'新品榜 · ':'销量榜 · ')+(meta?.category?meta.country+' · '+meta.category+'（网站当前第 '+meta.page+' 页）':(u.searchParams.get('region')==='MY'?'马来西亚':'当前国家')+' · '+(u.searchParams.get('l1_cid')==='11'?'厨房用品':'网站当前分类')+'（点击右侧按钮核对）');const o=document.createElement('option');o.value=t.id;o.textContent=t.label;$('source').append(o);}
  if(sources.some(t=>String(t.id)===selected))$('source').value=selected;sourceHint();
}
async function action(fn){try{await fn();}catch(e){message(e.message);}}
$('refresh').onclick=()=>action(refresh);$('source').onchange=sourceHint;
$('showSource').onclick=()=>action(async()=>{if(!$('source').value)throw new Error('请先打开并选择 FastMoss 商品销量榜或新品榜');await chrome.tabs.update(Number($('source').value),{active:true});});
$('probe').onclick=()=>action(async()=>{if(!$('source').value)throw new Error('请先选择商品榜单');const r=await inject(Number($('source').value),'list');diagnostic(r);message(r.error||'检测成功，可以读取本页 '+r.rows.length+' 件商品。');});
async function exclusive(fn){await navigator.locks.request('fastmoss-picker-run',{ifAvailable:true},async lock=>{if(!lock)throw new Error('另一个助手页面正在筛选，请先在那里暂停');busy=true;render();try{await fn();}finally{busy=false;render();}});}
$('start').onclick=()=>action(()=>exclusive(async()=>{
  const id=Number($('source').value);if(!id)throw new Error('请先打开 FastMoss 商品销量榜或新品榜，再点击重新读取');
  const tab=await chrome.tabs.get(id),u=validListUrl(tab.url);u.searchParams.set('page','1');
  const settings={pages:Number($('pages').value),delay:Number($('delay').value),mode:$('mode').value,boardType:u.pathname.includes('/newProducts')?'new':'sales'};
  const pageLimit=settings.boardType==='new'?50:25;
  if(!Number.isInteger(settings.pages)||settings.pages<1||settings.pages>pageLimit||!Number.isFinite(settings.delay)||settings.delay<3||settings.delay>60)throw new Error('页数为 1–'+pageLimit+'，间隔为 3–60 秒');
  for(const [min,max,kind,label] of [['priceMin','priceMax','price','价格'],['commissionMin','commissionMax','commission','佣金比例'],['stockMin','stockMax','stock','库存'],['growthMin','growthMax','growth','销量环比'],['creatorMin','max','creators','带货人数']]) {
    if(settings.boardType==='new'&&!['commission','stock'].includes(kind)){settings[min]=null;settings[max]=null;continue;}
    try{settings[min]=parseBound($(min).value,kind);settings[max]=parseBound($(max).value,kind);validateBounds(settings[min],settings[max],label);}catch(e){throw new Error(label+'：'+e.message);}
  }
  const meta=await inject(id,'meta');if(meta.error)throw new Error(meta.error);
  if(settings.boardType==='new'){
    if(meta.dates?.length!==2)throw new Error('请等待新品榜上架日期区间加载完成，再开始筛选');
    settings.listDates=meta.dates;
  }
  const apiContext=settings.mode==='api'?{...await callApi(id,'context',{}),tabId:id}:null;
  scopes=[{url:u.href,name:meta.country+' · '+meta.category}];
  const old=await chrome.storage.local.get('scan');if(old.scan)await chrome.storage.local.set({previousScan:old.scan});
  resultPages.clear();tableCache.clear();
  filterError='';
  await runner.begin(scopes,settings,apiContext);
}));
$('pause').onclick=()=>{runner.pause();message('正在暂停，保留已完成的结果…');};
$('resume').onclick=()=>action(()=>exclusive(async()=>{const saved=await chrome.storage.local.get('scan');if(saved.scan?.schema!==2)throw new Error('旧版曾按销量环比漏掉部分商品，请点击开始筛选重新扫描');
  if(saved.scan.settings.mode==='api'){
    const id=Number($('source').value);if(!id)throw new Error('请重新读取并选择本次扫描使用的榜单');
    const context={...await callApi(id,'context',{}),tabId:id};
    const canonical=p=>JSON.stringify(Object.entries(p).filter(([k])=>k!=='page').sort(([a],[b])=>a.localeCompare(b)));
    if(new URL(context.sourceUrl).pathname!==new URL(saved.scan.apiContext.sourceUrl).pathname || canonical(context.params)!==canonical(saved.scan.apiContext.params))throw new Error('所选榜单与上次扫描的国家、分类、日期或排序不同，请恢复原榜单或开始新扫描');
    saved.scan.apiContext=context;
  }
  runner.state=saved.scan;await runner.run();}));
$('worker').onclick=()=>action(async()=>{const s=runner.state;const id=s?.settings.mode==='api'?s.apiContext?.tabId:workerId;if(!id)throw new Error('请先开始筛选');await chrome.tabs.update(id,{active:true});});
$('sort').onchange=()=>{resultPages.clear();render();};
for(const id of ['priceMin','priceMax','commissionMin','commissionMax','stockMin','stockMax','growthMin','growthMax','creatorMin','max'])$(id).oninput=()=>refilter();
function download(name,data,type){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
$('export').onclick=()=>action(async()=>{const g=currentGroups();if(!g.main.length&&!g.zero.length&&!g.dash.length&&!g.failed.length)throw new Error('暂无可下载的结果');download('FastMoss选品结果.csv',csv([...g.main.map(r=>({...r,group:runner.state?.settings.boardType==='new'?'合格新品':'非零达人'})),...g.zero.map(r=>({...r,group:'零达人'})),...g.dash.map(r=>({...r,group:'带货人数为-'})),...g.failed.map(r=>({...r,group:'待核对'}))]),'text/csv;charset=utf-8');});
$('backup').onclick=()=>action(async()=>download('FastMoss全部记录.json',JSON.stringify(await chrome.storage.local.get(['scan','previousScan','legacyScan']),null,2),'application/json'));
await action(async()=>{
  const saved=await chrome.storage.local.get('scan');
  if(saved.scan?.schema===2){runner.state=saved.scan;if(!runner.state.complete)runner.state.status='已恢复上次进度，点击“继续上次筛选”即可';}
  else if(saved.scan){await chrome.storage.local.set({legacyScan:saved.scan});message('已更新筛选规则，请点击“开始筛选”重新扫描。旧版记录已保留在备份中。');}
  const settings=runner.state?.settings;
  const resultSettings=runner.state?.resultSettings;
  const effective=resultSettings||settings;
  if(effective)for(const id of ['pages','max','delay','priceMin','priceMax','commissionMin','commissionMax','stockMin','stockMax','growthMin','growthMax','creatorMin']){if(effective[id]!=null)$(id).value=effective[id];}
  await refresh();render();
});

mountWorkflowTransfer(()=>{const g=currentGroups();return [...g.main,...g.zero,...g.dash];},()=>{tableCache.clear();render();},()=>runner.state?.apiContext?.params?.region || new URL(runner.state?.scopes?.[0]?.url || 'https://www.fastmoss.com').searchParams.get('region') || '');
