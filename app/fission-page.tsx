"use client";
import { useCallback,useEffect,useMemo,useRef,useState,type FormEvent } from 'react';
import { DEFAULT_FISSION_REQUEST } from '../lib/fission';
import { DEFAULT_TASK_DURATION,DEFAULT_TASK_REGION,DEFAULT_SHOOTING_STYLE,TASK_DURATIONS,TASK_REGIONS,SHOOTING_STYLES } from '../lib/task-config';
import { validateVariantRequest } from '../lib/prompt-blocks';
import { confirmAction } from './confirm-action';
import { productIdFromImageName } from './use-image-product-id';
import type { Task,Product,Gem,TikTokAccount } from './studio-app';

type Row={key:string;mode:'library'|'new';productId:string;name:string;externalId:string;files:File[];saved?:{id:string;imageKeys:string[]}};
const emptyRow=():Row=>({key:crypto.randomUUID(),mode:'library',productId:'',name:'',externalId:'',files:[]});
function UploadPreviews({files}:{files:File[]}){
  const urls=useMemo(()=>files.map(file=>({name:file.name,url:URL.createObjectURL(file)})),[files]);
  useEffect(()=>()=>urls.forEach(item=>URL.revokeObjectURL(item.url)),[urls]);
  return <div className="fission-previews">{urls.map((item,i)=><img key={i} alt={item.name} src={item.url} />)}</div>;
}
export function FissionPage({products,gems,accounts,request,onUpload,onCreated,onOpenTask,statusLabel}:{
  products:Product[];gems:Gem[];accounts:TikTokAccount[];
  request:(path:string,init?:RequestInit)=>Promise<unknown>;
  onUpload:(files:File[],name:string,externalId:string)=>Promise<{id:string;imageKeys:string[]}>;
  onCreated:(autoQueue:boolean)=>Promise<void>;onOpenTask:(task:Task)=>void;statusLabel:(task:Task)=>string;
}){
  const [rows,setRows]=useState<Row[]>(()=>Array.from({length:4},emptyRow));
  const [source,setSource]=useState<'generate'|'paste'>('generate'),[motherRow,setMotherRow]=useState('');
  const [motherGem,setMotherGem]=useState(''),[variantGem,setVariantGem]=useState(''),[motherPrompt,setMotherPrompt]=useState('');
  const [template,setTemplate]=useState(DEFAULT_FISSION_REQUEST);
  const [duration,setDuration]=useState<number>(DEFAULT_TASK_DURATION),[region,setRegion]=useState<string>(DEFAULT_TASK_REGION),[style,setStyle]=useState<string>(DEFAULT_SHOOTING_STYLE);
  const [account,setAccount]=useState(''),[autoQueue,setAutoQueue]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [batches,setBatches]=useState<Task[]>([]),[listError,setListError]=useState('');
  const lock=useRef(false),requestId=useRef<string|null>(null);
  const load=useCallback(async()=>{const result=await request('/api/fission') as {batches:Task[]};setBatches(result.batches);setListError('');},[request]);
  useEffect(()=>{let alive=true;const refresh=()=>{if(alive)void load().catch(e=>{if(alive)setListError(e instanceof Error?e.message:'批次列表暂时无法加载');});};refresh();const timer=window.setInterval(refresh,5000);return()=>{alive=false;window.clearInterval(timer);};},[load]);
  function updateRow(key:string,value:Partial<Row>){requestId.current=null;setRows(current=>current.map(row=>row.key===key?{...row,...value,saved:undefined}:row));}
  async function submit(event:FormEvent){
    event.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');
    try{
      validateVariantRequest(template);
      if(!variantGem || (source==='generate'&&!motherGem) || !account)throw Error('请选择母版 Gem、变体 Gem 和 TK 归档账号');
      if(source==='paste'&&motherPrompt.trim().length<300)throw Error('粘贴的母版至少 300 字');
      const ids=rows.map(row=>row.mode==='library'?products.find(p=>p.id===row.productId)?.external_id?.trim():row.externalId.trim());
      if(ids.some(id=>!id))throw Error('每行必须选择商品并填写商品 ID');
      if(new Set(ids.map(id=>id!.toLowerCase())).size!==ids.length)throw Error('同一批商品不能重复');
      for(const row of rows)if(row.mode==='new'&&(!row.files.length||row.files.length>12||row.files.reduce((n,f)=>n+f.size,0)>48*1024**2))throw Error('每个新商品须上传 1–12 张图片，总大小不超过 48MB');
      const count=rows.length;
      if(!await confirmAction(`将生成 ${source==='generate'?'1 条母版':'0 条母版（使用粘贴内容）'} + ${count} 条子提示词${autoQueue?` + ${count} 条视频，消耗 ${count} 次视频额度`:'；仅生成提示词，本批不自动消耗视频额度'}。每个商品使用自己的图片和商品 ID，确认创建？`))return;
      const selected=[];
      for(const row of rows){
        let saved=row.saved;
        if(row.mode==='new'&&!saved){saved=await onUpload(row.files,row.name,row.externalId);setRows(current=>current.map(r=>r.key===row.key?{...r,saved}:r));}
        selected.push({productId:row.mode==='new'?saved!.id:row.productId,...(saved?{imageKeys:saved.imageKeys}:{})});
      }
      requestId.current ||= crypto.randomUUID();
      const masterIndex=Math.max(0,rows.findIndex(row=>row.key===motherRow));
      await request('/api/fission',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:requestId.current,products:selected,motherSource:source,motherProductId:selected[masterIndex].productId,motherGemId:motherGem,motherPrompt,variantGemId:variantGem,variantRequestText:template,duration,region,shootingStyle:style,tiktokAccountName:account,autoQueue})});
      requestId.current=null;setRows(Array.from({length:4},emptyRow));setMotherRow('');setNotice('裂变批次已创建，每个商品的图片和商品 ID 已独立保存。');
      await onCreated(autoQueue);await load();
    }catch(e){setError(e instanceof Error?e.message:'批次创建失败');}finally{lock.current=false;setBusy(false);}
  }
  return <div className="page-body fission-page">
    <section className="page-intro"><div><h2>多品裂变</h2><p>一份母版，换成不同商品。每个商品生成一条视频，分别按自己的商品 ID 归档。</p></div></section>
    <form className="fission-form" onSubmit={submit} onChange={()=>{requestId.current=null;}}>
      <fieldset disabled={busy}>
        <legend>01 · 选择 2–10 个不同商品</legend>
        <div className="fission-product-rows">{rows.map((row,index)=>{
          const product=products.find(p=>p.id===row.productId);
          return <section className="fission-product-row" key={row.key} aria-label={`商品 ${index+1}`}>
            <div className="fission-row-head"><b>商品 {index+1}</b><select aria-label={`商品 ${index+1} 来源`} value={row.mode} onChange={e=>updateRow(row.key,{mode:e.target.value as Row['mode']})}><option value="library">从商品库选</option><option value="new">上传新商品</option></select><button type="button" className="secondary" disabled={rows.length<=2} onClick={()=>{requestId.current=null;setRows(current=>current.filter(r=>r.key!==row.key));}}>移除</button></div>
            {row.mode==='library'?<>
              <select aria-label={`选择商品 ${index+1}`} value={row.productId} onChange={e=>updateRow(row.key,{productId:e.target.value})}><option value="">请选择商品</option>{products.map(p=><option key={p.id} value={p.id}>{p.external_id||'未填写 ID'} · {p.name||'未命名商品'}</option>)}</select>
              {product&&<div className="fission-selected-product">{product.images?.[0]&&<img alt={product.name||'商品图'} src={`/api/media?key=${encodeURIComponent(product.images[0].object_key)}`} />}<span>商品 ID：{product.external_id||'请先在商品库补填 ID'}<small>{product.images?.length||0} 张商品图</small></span></div>}
            </>:<>
              <label>商品 ID<input required value={row.externalId} onChange={e=>updateRow(row.key,{externalId:e.target.value})}/></label>
              <label>商品名称（选填）<input value={row.name} onChange={e=>updateRow(row.key,{name:e.target.value})}/></label>
              <label>商品图片<input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={e=>{const files=Array.from(e.target.files||[]);updateRow(row.key,{files,externalId:row.externalId||productIdFromImageName(files[0]?.name||'')});}}/></label><UploadPreviews files={row.files}/>
            </>}
          </section>;
        })}</div>
        <button type="button" className="secondary" disabled={rows.length>=10} onClick={()=>{requestId.current=null;setRows(current=>[...current,emptyRow()]);}}>＋ 增加商品</button>
      </fieldset>
      <fieldset disabled={busy}><legend>02 · 母版和变体 Gem</legend>
        <label>母版来源<select aria-label="母版来源" value={source} onChange={e=>setSource(e.target.value as typeof source)}><option value="generate">用本批一个商品生成</option><option value="paste">粘贴现成母版</option></select></label>
        {source==='generate'?<div className="fission-common-grid"><label>母版商品<select aria-label="母版商品" value={rows.some(r=>r.key===motherRow)?motherRow:rows[0].key} onChange={e=>setMotherRow(e.target.value)}>{rows.map((row,index)=><option key={row.key} value={row.key}>商品 {index+1} · {row.mode==='new'?row.externalId:products.find(p=>p.id===row.productId)?.external_id||'未选择'}</option>)}</select></label><label>母版 Gem<select aria-label="母版 Gem" required value={motherGem} onChange={e=>setMotherGem(e.target.value)}><option value="">请选择母版 Gem</option>{gems.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label></div>:<label>现成母版提示词（至少 300 字）<textarea aria-label="现成母版提示词（至少 300 字）" rows={7} value={motherPrompt} onChange={e=>setMotherPrompt(e.target.value)} minLength={300} maxLength={60000} required/></label>}
        <label>变体 Gem<select aria-label="变体 Gem" required value={variantGem} onChange={e=>setVariantGem(e.target.value)}><option value="">请选择变体 Gem</option>{gems.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
        <label>第二轮发送文字<textarea rows={6} value={template} onChange={e=>setTemplate(e.target.value)} required maxLength={12000}/><small>必须包含 {'{母版提示词}'}，支持 {'{时长}{地区}{拍摄风格}'}。</small></label>
      </fieldset>
      <fieldset disabled={busy}><legend>03 · 整批视频设置</legend><div className="fission-common-grid">
        <label>时长<select aria-label="时长" value={duration} onChange={e=>setDuration(Number(e.target.value))}>{TASK_DURATIONS.filter(n=>n!==30).map(n=><option key={n} value={n}>{n} 秒</option>)}</select></label>
        <label>地区<select aria-label="地区" value={region} onChange={e=>setRegion(e.target.value)}>{TASK_REGIONS.map(value=><option key={value}>{value}</option>)}</select></label>
        <label>拍摄风格<select aria-label="拍摄风格" value={style} onChange={e=>setStyle(e.target.value)}>{SHOOTING_STYLES.map(value=><option key={value}>{value}</option>)}</select></label>
        <label>TK 归档账号<select aria-label="TK 归档账号" required value={account} onChange={e=>setAccount(e.target.value)}><option value="">请选择归档账号</option>{accounts.map(a=><option key={a.id} value={a.name}>{a.name}</option>)}</select></label>
        <label>生成方式<select aria-label="生成方式" value={autoQueue?'video':'prompt'} onChange={e=>setAutoQueue(e.target.value==='video')}><option value="video">提示词 + 自动进 Seedance</option><option value="prompt">仅生成提示词</option></select></label>
      </div></fieldset>
      {error&&<p role="alert" className="warning-box">{error}</p>}{notice&&<p role="status">{notice}</p>}
      <button className="primary" disabled={busy}>{busy?'正在创建…':`创建 ${rows.length} 品裂变批次`}</button>
    </form>
    <section className="fission-batches"><h2>裂变批次</h2>{listError&&<p role="alert">{listError}</p>}
      {batches.map(batch=><article className="fission-batch-card" key={batch.id}><div className="fission-row-head"><h3>{batch.title}</h3><span>{statusLabel(batch)}</span><button className="secondary" onClick={()=>onOpenTask(batch)}>查看整组</button></div>
        <p>{batch.region} · {batch.duration} 秒 · TK：{batch.tiktok_account_name} · {(batch.children||[]).filter(c=>['video_ready','scheduled'].includes(c.status)).length}/{batch.children?.length||0} 条视频就绪</p>
        {(batch.children||[]).map(child=><button type="button" className="fission-child-summary" key={child.id} onClick={()=>onOpenTask(child)}><b>{child.product_name||child.title}</b><span>商品 ID：{child.product_external_id}</span><span>{statusLabel(child)}</span></button>)}
      </article>)}
      {!batches.length&&!listError&&<p>还没有裂变批次。在上方选好商品和 Gem 即可开始。</p>}
    </section>
  </div>;
}
