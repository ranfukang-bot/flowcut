export function countValue(raw) {
  const s=String(raw??'').trim().replace(/,/g,'');
  if(!/^\d+(?:\.0+)?(?:\s*人)?$/.test(s))return null;
  const n=Number(s.replace(/人$/,'').trim());return Number.isSafeInteger(n)&&n>=0?n:null;
}
export const isDash=raw=>/^[-—–]$/.test(String(raw??'').trim());
export function growthValue(raw) {
  const s=String(raw??'').trim().replace(/,/g,'').replace(/％/g,'%').replace(/^−/,'-');
  if(!/^[+-]?\d+(?:\.\d+)?\s*%$/.test(s))return null;
  const n=Number(s.replace('%','').trim());return Number.isFinite(n)?n:null;
}
export function parseBound(raw,kind='price') {
  let s=String(raw??'').trim();if(!s)return null;if(isDash(s))return '-';
  s=s.replace(/,/g,'').replace(/^−/,'-');
  if(['growth','commission'].includes(kind))s=s.replace(/[%％]$/,'').trim();
  if(!/^[+-]?\d+(?:\.\d+)?$/.test(s))throw new Error('请输入数字、单独的“-”，或留空不限');
  const n=Number(s);
  if(!Number.isFinite(n)||(kind!=='growth'&&n<0)||(kind==='commission'&&n>100)||(['stock','creators'].includes(kind)&&!Number.isSafeInteger(n)))throw new Error('数值范围不正确；只有销量环比允许负数，人数和库存须为整数，佣金为 0–100');
  return n;
}
export function validateBounds(min,max,label) {
  if((max==='-'&&typeof min==='number')||(typeof min==='number'&&typeof max==='number'&&min>max))throw new Error(label+'最低值不能高于最高值；仅筛选“-”时请两端都填“-”');
}
// '-' is an explicit category, not zero and not a numeric estimate.
export function fieldDecision(raw,parsed,min,max,overlap=false) {
  if(min==null&&max==null)return true;
  if(isDash(raw))return min==='-'||max==='-';
  if(max==='-')return parsed===null?null:false;
  if(parsed===null)return null;
  const low=typeof min==='number'?min:-Infinity,high=typeof max==='number'?max:Infinity;
  if(parsed.max<low||parsed.min>high)return false;
  if(overlap)return true;
  return parsed.min>=low&&parsed.max<=high?true:null;
}
const interval=n=>n===null?null:{min:n,max:n};
export function growthDecision(raw,min,max){
  const value=growthValue(raw);
  if(min==='-'&&value!==null&&value<0)return false;
  return fieldDecision(raw,interval(value),min,max);
}
export function creatorDecision(row,settings) {
  const raw=row.creatorsRaw??String(row.creators??'');
  if(String(raw).includes('万'))return false;
  const max=settings.max===undefined?400:settings.max;
  return fieldDecision(raw,interval(countValue(raw)),settings.creatorMin,typeof max==='number'?max-1:max);
}
export function priceValue(raw) {
  const s=String(raw??'').trim().replace(/,/g,'');
  const m=s.match(/^(RM|MYR|USD|IDR|THB|VND|PHP|GBP|EUR|SGD|JPY|BRL|MXN|R\$|Rp|[$£€฿¥₱₫])?\s*(\d+(?:\.\d+)?)(?:\s*[-–—~～]\s*(?:RM|MYR|USD|\$)?\s*(\d+(?:\.\d+)?))?$/i);
  if(!m)return null;
  const min=Number(m[2]),max=Number(m[3]??m[2]);
  return Number.isFinite(min)&&Number.isFinite(max)&&min<=max?{min,max,currency:m[1]||''}:null;
}
export function eligiblePrice(raw,min=null,max=null) {
  return fieldDecision(raw,priceValue(raw),min,max,true)===true;
}
export function compare(a,b,mode='creators') {
  if(mode==='page') {
    const page=(a.page??Infinity)-(b.page??Infinity);
    return page||((a.pagePosition??a.originalIndex??0)-(b.pagePosition??b.originalIndex??0));
  }
  const c=(a.creators??Infinity)-(b.creators??Infinity);
  return (mode==='creatorsDesc'?-c:c)||a.name.localeCompare(b.name);
}
export function commissionValue(raw) {
  const s=String(raw??'').trim().replace(/％/g,'%');
  if(!/^\d+(?:\.\d+)?\s*%?$/.test(s))return null;
  const n=Number(s.replace('%','').trim());return n<=100?n:null;
}
export function stockValue(raw) {
  const m=String(raw??'').trim().replace(/[,\s]/g,'').match(/^(\d+(?:\.\d+)?)(万|亿|[kKmM])?(\+)?$/);
  if(!m)return null;
  const n=Number(m[1])*({'万':10000,'亿':100000000,k:1000,K:1000,m:1000000,M:1000000}[m[2]]||1);
  return Number.isSafeInteger(n)?{min:n,max:m[3]?Infinity:n}:null;
}
export function rangeDecision(value,min,max) {
  if(min==null&&max==null)return true;
  if(value===null)return null;
  const low=min??0,high=max??Infinity;
  if(value.max<low||value.min>high)return false;
  return value.min>=low&&value.max<=high?true:null;
}
export function extraFilters(row,settings) {
  const c=commissionValue(row.commission);
  const commission=fieldDecision(row.commission,c===null?null:{min:c,max:c},settings.commissionMin,settings.commissionMax);
  const stock=fieldDecision(row.stock,stockValue(row.stock),settings.stockMin,settings.stockMax);
  if(commission===false||stock===false)return {pass:false};
  const reasons=[];
  if(commission===null)reasons.push('佣金比例未能读取，无法确认是否符合区间');
  if(stock===null)reasons.push('库存未读取或只显示下限（如 7万+），无法确认是否符合库存区间');
  return reasons.length?{pass:null,error:reasons.join('；')}:{pass:true};
}
export function groups(rows,mode='creators',settings={}) {
  const checked=rows.map((r,originalIndex)=>({...r,originalIndex})).filter(r=>r.status==='ok').map(row=>{
    const extras=extraFilters(row,settings);
    const decisions=settings.boardType==='new'?[extras.pass]:[creatorDecision(row,settings),fieldDecision(row.priceRaw,priceValue(row.priceRaw),settings.priceMin,settings.priceMax,true),growthDecision(row.growthRaw,settings.growthMin,settings.growthMax),extras.pass];
    return {row,decision:decisions.includes(false)?{pass:false}:decisions.includes(null)?{pass:null,error:extras.error||'某项筛选字段未能读取，无法确认区间；空白读取失败不等同于网站显示“-”'}:{pass:true}};
  });
  const accepted=checked.filter(x=>x.decision.pass===true).map(x=>x.row);
  if(settings.boardType==='new')return {main:accepted.sort((a,b)=>compare(a,b,mode)),zero:[],dash:[],failed:[...rows.filter(r=>r.status==='error'),...checked.filter(x=>x.decision.pass===null).map(x=>({...x.row,status:'error',error:x.decision.error}))]};
  return {main:accepted.filter(r=>r.creators>0).sort((a,b)=>compare(a,b,mode)),zero:accepted.filter(r=>r.creators===0).sort((a,b)=>compare(a,b,mode)),dash:accepted.filter(r=>isDash(r.creatorsRaw)).sort((a,b)=>compare(a,b,mode)),failed:[...rows.filter(r=>r.status==='error'),...checked.filter(x=>x.decision.pass===null).map(x=>({...x.row,status:'error',error:x.decision.error}))]};
}
export function validListUrl(raw) {
  const u=new URL(raw);
  if(u.protocol!=='https:'||!['www.fastmoss.com','fastmoss.com'].includes(u.hostname)||!/^\/(?:[a-z-]+\/)?e-commerce\/(?:saleslist|newProducts)\/?$/.test(u.pathname))throw new Error('请先在 FastMoss 打开中文销量榜或新品榜');
  return u;
}
export function pageUrl(raw,page) {const u=validListUrl(raw);u.searchParams.set('page',String(page));return u.href;}
export function csv(rows) {
  const columns=[['产品 ID','productId'],['分组','group'],['商品','name'],['商品分类','category'],['价格','priceRaw'],['销量环比','growthRaw'],['带货达人数','creatorsRaw'],['库存','stock'],['佣金率','commission'],['来源页','page'],['页内位置','pagePosition'],['商品链接','url'],['读取状态','status'],['说明','error'],['读取时间','readAt']];
  const cell=v=>{let s=String(v??'');if(/^\s*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
  return '\ufeff'+[columns.map(c=>cell(c[0])).join(','),...rows.map(r=>columns.map(c=>cell(c[1]==='creatorsRaw'?(r.creatorsRaw??r.creators):(c[1]==='productId'?"'"+(r.productId||r.url?.match(/\/detail\/(\d+)/)?.[1]||''):r[c[1]]))).join(','))].join('\r\n');
}
