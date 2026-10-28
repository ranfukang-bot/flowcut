"use client";
import { PromptFissionForm } from './prompt-fission-form';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { PROMPT_BATCH_SETTINGS_KEY, promptBatchRequest, type PromptBatch, type PromptItem } from '../lib/prompt-batches';
import { TASK_REGIONS } from '../lib/task-config';
import { useImageProductId } from './use-image-product-id';
import { api, desktopBridge } from './studio-client';
import { confirmAction } from './confirm-action';
import { TASK_STATUS_LABELS } from '../lib/task-statuses';
import { formatTime, PageIntro } from './studio-ui';
import type { Gem } from './studio-types';

type BatchResponse = { batches: PromptBatch[]; nextCursor: string | null; hasActive: boolean };

export function PromptBatchPage({ gems }: { gems: Gem[] }) {
  const [mode, setMode] = useState<'single' | 'fission' | 'variants'>('single');
  const [variantGemId,setVariantGemId]=useState(''),[motherSource,setMotherSource]=useState('generate'),[motherPrompt,setMotherPrompt]=useState('');
  const [variantCount,setVariantCount]=useState(4),[secondCustom,setSecondCustom]=useState<string|null>(null),[moreCount,setMoreCount]=useState(4);

  const [files, setFiles] = useState<File[]>([]);
  const [externalId, editExternalId] = useImageProductId(files);
  const [name, setName] = useState('');
  const [gemId, setGemId] = useState('');
  const [region, setRegion] = useState('印尼');
  const [description, setDescription] = useState('iPhone实拍质感');
  const [count, setCount] = useState(5);
  const [customRequest, setCustomRequest] = useState<string | null>(null);
  const [settingsReady, setSettingsReady] = useState(false);
  const [batches, setBatches] = useState<PromptBatch[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasActive, setHasActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [viewId, setViewId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const pages = useRef(1), serial = useRef(0), mounted = useRef(true);
  const selectedGem = gems.find(gem => gem.id === gemId);
  const previews = useMemo(() => files.map(file => URL.createObjectURL(file)), [files]);
  useEffect(() => () => previews.forEach(url => URL.revokeObjectURL(url)), [previews]);
  const secondText=secondCustom ?? ['目标国家：'+region,'裂变条数：{条数}','已用过的开头：{已用开头}','以下是母版提示词，请按指令裂变：','{母版提示词}','不要提问，直接输出。'].join('\n');
  const requestText = customRequest ?? promptBatchRequest(region, description);

  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() => {
      if (!alive) return;
      try {
      const saved = JSON.parse(localStorage.getItem(PROMPT_BATCH_SETTINGS_KEY) || '{}');
      if (saved.mode === 'fission' || saved.mode === 'variants') setMode(saved.mode);
      if(typeof saved.variantGemId==='string')setVariantGemId(saved.variantGemId);
      if(Number.isInteger(saved.variantCount)&&saved.variantCount>=1&&saved.variantCount<=10)setVariantCount(saved.variantCount);
      if(typeof saved.secondCustom==='string')setSecondCustom(saved.secondCustom);
      if (typeof saved.gemId === 'string') setGemId(saved.gemId);
      if (TASK_REGIONS.includes(saved.region)) setRegion(saved.region);
      if (typeof saved.description === 'string') setDescription(saved.description);
      if (Number.isInteger(saved.count) && saved.count >= 1 && saved.count <= 20) setCount(saved.count);
      if (typeof saved.requestText === 'string') setCustomRequest(saved.requestText);
      } catch { /* Local storage may be disabled or contain an older invalid value. */ }
      setSettingsReady(true);
    });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (settingsReady) try { localStorage.setItem(PROMPT_BATCH_SETTINGS_KEY, JSON.stringify({ variantGemId,variantCount,secondCustom,mode, gemId, region, description, count, requestText: customRequest })); } catch { /* Generation still works without persistence. */ }
  }, [settingsReady, variantGemId,variantCount,secondCustom,mode, gemId, region, description, count, customRequest]);

  const refresh = useCallback(async (pageCount = pages.current) => {
    const current = ++serial.current;
    setLoading(true);
    try {
      let cursor: string | null = null, active = false;
      const collected: PromptBatch[] = [];
      let loaded = 0;
      for (let i = 0; i < pageCount; i++) {
        const data = await api(`/api/prompt-batches${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`) as unknown as BatchResponse;
        collected.push(...data.batches); cursor = data.nextCursor; active ||= data.hasActive; loaded++;
        if (!cursor) break;
      }
      if (mounted.current && current === serial.current) {
        pages.current = loaded; setBatches(collected); setNextCursor(cursor); setHasActive(active);
      }
    } catch (error) { if (mounted.current) setNotice(error instanceof Error ? error.message : '批次加载失败'); }
    finally { if (mounted.current && current === serial.current) setLoading(false); }
  }, []);
  useEffect(() => { mounted.current = true; void Promise.resolve().then(() => { if (mounted.current) void refresh(); }); return () => { mounted.current = false; }; }, [refresh]);
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [hasActive, refresh]);
  const viewed = batches.flatMap(batch => batch.mother ? [batch.mother, ...batch.items] : batch.items).find(item => item.id === viewId);
  const hasViewed = Boolean(viewed);
  useEffect(() => {
    if (hasViewed) dialog.current?.showModal();
    else dialog.current?.close();
  }, [viewId, hasViewed]);

  function addFiles(incoming: File[]) {
    if (incoming.some(file => !file.type.startsWith('image/') || !file.size)) { setNotice('只接受非空图片文件'); return; }
    if (files.length + incoming.length > 12) { setNotice('每批最多 12 张图片'); return; }
    if (incoming.some(file => file.size > 12 * 1024 * 1024) || [...files, ...incoming].reduce((sum, file) => sum + file.size, 0) > 48 * 1024 * 1024) { setNotice('单张图片不能超过 12MB，总大小不能超过 48MB'); return; }
    setFiles(current => [...current, ...incoming]); setNotice('');
  }
  async function startQueue() {
    try { await desktopBridge()?.setQueueRunning?.(true); }
    catch { setNotice('提示词已保存，请在账号与设置中启动 Gemini 队列'); }
  }
  const missing = [!files.length && '请先放入图片', !(mode==='variants' && motherSource==='paste') && !selectedGem && '请选择 Gem', !description.trim() && '请填写描述', !(mode==='variants' && motherSource==='paste') && !requestText.trim() && '请填写发送给 Gem 的文字', requestText.length > 12000 && '发送文字不能超过 12000 字', (!Number.isInteger(count) || count < 1 || count > 20) && '条数应为 1–20', mode==='variants' && (!gems.some(g=>g.id===variantGemId) ? '请选择裂变 Gem' : !secondText.includes('{母版提示词}') || !secondText.includes('{条数}') ? '第二轮须包含 {母版提示词} 和 {条数}' : motherSource==='paste' && (motherPrompt.trim().length<300 || motherPrompt.length>60000) ? '母版须为 300–60000 字' : variantCount<1 || variantCount>10 || !Number.isInteger(variantCount) ? '条数须为 1–10' : '')].filter(Boolean).join('；');
  async function create(event: FormEvent) {
    event.preventDefault(); if (missing || busy) return;
    setBusy('create'); setNotice('');
    try {
      const form = new FormData(); files.forEach(file => form.append('images', file));
      Object.entries({ externalId, productName: name, gemId, region, description, count: String(count), geminiRequestText: requestText }).forEach(([key, value]) => form.set(key, value));
      if(mode==='variants')Object.entries({mode,motherSource,motherGemId:gemId,variantGemId,motherPrompt,firstText:requestText,secondText,count:String(variantCount)}).forEach(([key,value])=>form.set(key,value));
      await api('/api/prompt-batches', { method: 'POST', body: form });
      await startQueue(); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : '批次创建失败'); }
    finally { setBusy(''); }
  }
  async function change(action: string, id: string) {
    if (busy) return;
    if (action.startsWith('delete') && !await confirmAction(action === 'delete-batch' ? '删除整批提示词？此操作无法撤销。' : '删除这条提示词？')) return;
    setBusy(id); setNotice('');
    try {
      await api('/api/prompt-batches', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, id, ...(action==='more'?{count:moreCount}:{}) }) });
      if (action === 'retry' || action==='more') await startQueue();
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(''); }
  }
  async function copy(item: PromptItem) {
    if (!item.prompt || busy) return;
    setBusy(item.id); setNotice('');
    let copied = false;
    const markCopied = (copiedAt: string) => {
      serial.current++; setLoading(false);
      setBatches(current => current.map(batch => ({ ...batch, ...(batch.mother?.id === item.id ? { mother: { ...batch.mother, prompt_copied_at: copiedAt } } : {}), items: batch.items.map(row => row.id === item.id ? { ...row, prompt_copied_at: copiedAt } : row) })));
    };
    try {
      await navigator.clipboard.writeText(item.prompt);
      copied = true; markCopied(new Date().toISOString());
      const result = await api('/api/prompt-batches', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'copied', id: item.id }) }) as { copiedAt?: string };
      // Invalidate older in-flight polls before marking the durable copy result.
      markCopied(result.copiedAt || new Date().toISOString());
    } catch (error) { setNotice((copied ? '已复制，但复制时间保存失败：' : '') + (error instanceof Error ? error.message : '复制失败')); }
    finally { setBusy(''); }
  }
  function copyButton(item: PromptItem) {
    return <button type="button" className="secondary" disabled={!item.prompt || Boolean(busy)} onClick={() => void copy(item)}>{item.prompt_copied_at ? '已复制' : '复制提示词'}</button>;
  }

  function fissionCard(batch: PromptBatch) {
    const mother = batch.mother!;
    const variants=batch.kind==='variants';
    const all = [mother, ...batch.items], generating = all.some(item => ['prompt_generating','variant_generating'].includes(item.status));
    const complete = batch.items.filter(item => item.status === 'prompt_ready').length;
    const copied = all.filter(item => item.prompt_copied_at).length;
    function row(item: PromptItem, isMother = false) {
      const keys: string[] = JSON.parse(item.image_keys_snapshot || '[]');
      return <li key={item.id}>
        {!isMother && keys[0] && <img className="prompt-batch-thumb" src={'/api/media?key=' + encodeURIComponent(keys[0])} alt="商品缩略图" />}
        <div><strong>{isMother ? '母版' : variants ? '第 '+(batch.items.indexOf(item)+1)+' 条 · 开头：'+(item.prompt_note || '未标注') : (item.product_name || '商品') + ' · ' + item.product_external_id_snapshot}</strong> · <span className={item.status === 'failed' ? 'prompt-batch-failed' : ''}>{item.status === 'fission_wait' ? '等待母版' : (isMother && variants ? (item.status==='variant_generating'?'正在裂变 '+mother.prompt_variant_count+' 条':item.status==='prompt_generating'?'生成母版中':item.status==='split_done'?'裂变完成':TASK_STATUS_LABELS[item.status]) : TASK_STATUS_LABELS[item.status]) || item.status}</span>
          {isMother ? <details><summary>母版预览 · {item.product_name || item.product_external_id_snapshot}</summary><p className="prompt-batch-text">{item.prompt || item.error || '等待生成母版'}</p></details> : <p>{item.prompt ? item.prompt.slice(0,60) + (item.prompt.length > 60 ? '…' : '') : item.error || '等待生成提示词'}</p>}
          {item.prompt_copied_at && <small>已复制 · {formatTime(item.prompt_copied_at)}</small>}
        </div><div className="prompt-batch-actions">
          {isMother ? <button type="button" className="secondary" disabled={!item.prompt || Boolean(busy)} onClick={() => void copy(item)}>{item.prompt_copied_at ? '已复制' : '复制母版'}</button> : copyButton(item)}
          <button className="secondary" onClick={() => setViewId(item.id)}>查看</button>
          {item.status === 'failed' && <button className="secondary" disabled={Boolean(busy)} onClick={() => void change('retry',item.id)}>重试</button>}
          {variants && !isMother && <button className="secondary" disabled={Boolean(busy)} onClick={()=>void change('delete-item',item.id)}>删除</button>}
        </div>
      </li>;
    }
    return <article className="panel prompt-batch-card" key={batch.id} aria-label="多品裂变提示词批次">
      <header className="prompt-batch-header"><div><h3>{variants?'单品裂变 · '+mother.product_name+' · '+mother.product_external_id_snapshot:'多品裂变 · '+batch.items.length+' 个商品'}</h3><p>母版 Gem：{mother.gem_name} / {variants?'裂变 Gem':'变体 Gem'}：{variants?mother.variant_gem_name:batch.items[0]?.gem_name}</p><p>{mother.region} · {formatTime(batch.created_at)} · {variants?'已出 '+batch.items.length+' 条':'已完成 '+complete+'/'+batch.items.length} · 已复制 {copied}</p></div>
      <button className="secondary" disabled={Boolean(busy) || generating} onClick={() => void change('delete-batch',batch.id)}>删除整批</button></header>
      <ol className="prompt-batch-items">{row(mother,true)}{batch.items.map(item => row(item))}</ol>{variants && <div className="prompt-batch-actions"><label>再裂变条数<input type="number" min={1} max={10} value={moreCount} onChange={e=>setMoreCount(Number(e.target.value))}/></label><button className="secondary" disabled={Boolean(busy) || mother.status!=='split_done'} onClick={()=>void change('more',mother.id)}>再裂变 {moreCount} 条</button></div>}
    </article>;
  }
  function firstEditor() { return <><details><summary>发送给 Gem 的文字{customRequest !== null ? ' · 已自定义' : ''}</summary>
        <label>实际发送内容<textarea aria-label="发送给 Gem 的文字" className="prompt-batch-text" rows={7} maxLength={12000} value={requestText} onChange={event => setCustomRequest(event.target.value)} /></label>
        <div className="prompt-batch-actions"><button type="button" className="secondary" onClick={() => setCustomRequest(null)}>恢复默认文字</button><span>{customRequest !== null ? '按你编辑的内容原样发送；更换地区或描述不会覆盖。' : '默认文字随地区、描述生成，你可以直接修改。'}</span></div>
      </details></>; }
  function regionFields() { return <div className="prompt-batch-fields">
    <label>地区<select aria-label="地区" value={region} onChange={event => setRegion(event.target.value)}>{TASK_REGIONS.map(value => <option key={value}>{value}</option>)}</select></label>
    <label>描述<input value={description} onChange={event => setDescription(event.target.value)} maxLength={1000} /></label>
  </div>; }

  return <section className="prompt-batch-page">
    <PageIntro title="提示词生成" text="为 Seedance 2.5 准备提示词，在这里逐条复制，再到需要的地方使用。" />
    <div className="prompt-batch-actions" role="group" aria-label="生成模式">{(['single','variants','fission'] as const).map(value => <button key={value} type="button" className="secondary" aria-pressed={mode === value} onClick={() => setMode(value)}>{value === 'single' ? '单个商品' : value === 'variants' ? '单品裂变' : '多品裂变'}</button>)}</div>
    {mode === 'fission' ? <PromptFissionForm gems={gems} region={region} firstText={requestText} onCreated={async () => { await startQueue(); await refresh(); }}>{paste => <>{regionFields()}{!paste && firstEditor()}</>}</PromptFissionForm> : <form className="panel prompt-batch-form" onSubmit={create}>
      <h3>本次素材与设置</h3>
      <div className="prompt-batch-drop" data-testid="prompt-batch-drop" onDragOver={event => { event.preventDefault(); }} onDrop={event => { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); }}>
        <label>拖入产品图片，或选择图片（1–12 张）<input aria-label="选择产品图片" type="file" accept="image/*" multiple onChange={event => { addFiles(Array.from(event.target.files || [])); event.target.value = ''; }} /></label>
      </div>
      {files.length > 0 && <div className="prompt-batch-images">{files.map((file, i) => <figure key={`${file.name}-${i}`}><img src={previews[i]} alt={file.name} /><button type="button" className="secondary" aria-label={`移除图片 ${i + 1}`} onClick={() => setFiles(current => current.filter((_, index) => index !== i))}>移除</button></figure>)}</div>}
      <div className="prompt-batch-fields">
        <label>商品 ID<input value={externalId} onChange={event => editExternalId(event.target.value)} maxLength={200} /></label>
        <label>商品名（选填）<input value={name} onChange={event => setName(event.target.value)} maxLength={200} /></label>
        {!(mode==='variants' && motherSource==='paste') && <label>{mode==='variants'?'母版 Gem':'Gem'}<select aria-label="Gem" value={gemId} onChange={event => setGemId(event.target.value)}><option value="">请选择 Gem</option>{gems.map(gem => <option key={gem.id} value={gem.id}>{gem.name}</option>)}</select></label>}
        <label>地区<select aria-label="地区" value={region} onChange={event => setRegion(event.target.value)}>{TASK_REGIONS.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>描述<input value={description} onChange={event => setDescription(event.target.value)} maxLength={1000} /></label>
        {mode!=='variants' && <label>条数<input type="number" min={1} max={20} step={1} value={count} onChange={event => setCount(Number(event.target.value))} /></label>}
      </div>
      {mode==='variants' && <>
        <div className="prompt-batch-fields"><label>母版来源<select value={motherSource} onChange={e=>setMotherSource(e.target.value)}><option value="generate">用本商品生成</option><option value="paste">粘贴现成母版</option></select></label><label>裂变 Gem<select aria-label="裂变 Gem" value={variantGemId} onChange={e=>setVariantGemId(e.target.value)}><option value="">请选择裂变 Gem</option>{gems.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label><label>裂变条数<input aria-label="裂变条数" type="number" min={1} max={10} value={variantCount} onChange={e=>setVariantCount(Number(e.target.value))}/><small>建议一次 4–6 条</small></label></div>
        {motherSource==='paste' && <label>母版提示词<textarea className="prompt-batch-text" value={motherPrompt} maxLength={60000} onChange={e=>setMotherPrompt(e.target.value)}/></label>}
        <details><summary>第二轮文字</summary><label>发给裂变 Gem<textarea className="prompt-batch-text" rows={8} value={secondText} maxLength={12000} onChange={e=>setSecondCustom(e.target.value)}/></label><button type="button" className="secondary" onClick={()=>setSecondCustom(null)}>恢复默认文字</button></details>
      </>}
      {!(mode==='variants' && motherSource==='paste') && firstEditor()}
      <div className="prompt-batch-actions"><button className="primary" disabled={Boolean(missing) || Boolean(busy) || !settingsReady}>{mode==='variants' ? (motherSource==='paste'?'裂变 ':'生成母版并裂变 ')+variantCount+' 条' : '生成 '+count+' 条提示词'}</button><span>{missing}</span></div>
    </form>}
    {notice && <p role="status">{notice}</p>}
    <div className="prompt-batch-actions"><h3>提示词批次</h3><button className="secondary" disabled={loading} onClick={() => void refresh()}>刷新</button></div>
    {!batches.length && <p>{loading ? '正在加载…' : '还没有提示词批次，上传图片后开始生成。'}</p>}
    {batches.map(batch => {
      const first = batch.items[0]; if (!first) return null;
      if ((batch.kind === 'fission' || batch.kind === 'variants') && batch.mother) return fissionCard(batch);
      const completed = batch.items.filter(item => item.status === 'prompt_ready').length;
      const copied = batch.items.filter(item => item.prompt_copied_at).length;
      const keys: string[] = JSON.parse(first.image_keys_snapshot || '[]');
      return <article className="panel prompt-batch-card" key={batch.id} aria-label={`${first.product_name || '图片识别商品'}提示词批次`}>
        <header className="prompt-batch-header">{keys[0] && <img src={`/api/media?key=${encodeURIComponent(keys[0])}`} alt="商品缩略图" />}<div>
          <h3>{first.product_name || '图片识别商品'}{first.product_external_id_snapshot ? ` · ${first.product_external_id_snapshot}` : ''}</h3>
          <p>{first.gem_name || '已保存的 Gem'} · {first.gemini_request_text.split('\n')[0]}</p><p>{formatTime(batch.created_at)} · 已完成 {completed}/{first.batch_size} · 已复制 {copied}</p>
        </div><button className="secondary" disabled={Boolean(busy) || batch.items.some(item => item.status === 'prompt_generating')} onClick={() => void change('delete-batch', batch.id)}>删除整批</button></header>
        <ol className="prompt-batch-items">{batch.items.map(item => <li key={item.id}>
          <div><strong>第 {item.batch_index} 条</strong> · <span className={item.status === 'failed' ? 'prompt-batch-failed' : ''}>{TASK_STATUS_LABELS[item.status] || item.status}</span>
            <p>{item.prompt ? item.prompt.slice(0, 60) + (item.prompt.length > 60 ? '…' : '') : item.error || '等待生成提示词'}</p>
            {item.prompt_copied_at && <small>已复制 · {formatTime(item.prompt_copied_at)}</small>}
          </div><div className="prompt-batch-actions">{copyButton(item)}<button className="secondary" onClick={() => setViewId(item.id)}>查看</button>
            {item.status === 'failed' && <button className="secondary" disabled={Boolean(busy)} onClick={() => void change('retry', item.id)}>重试</button>}
            <button className="secondary" disabled={item.status === 'prompt_generating' || Boolean(busy)} onClick={() => void change('delete-item', item.id)}>删除</button>
          </div>
        </li>)}</ol>
      </article>;
    })}
    {nextCursor && <button className="secondary" disabled={loading} onClick={() => void refresh(pages.current + 1)}>加载更多</button>}
    <dialog ref={dialog} className="prompt-batch-dialog" aria-label="提示词全文" onClose={() => setViewId(null)}>
      {viewed && <><div className="prompt-batch-actions"><h3>{['fission','group'].includes(viewed.task_role || '') ? '母版提示词' : '第 ' + viewed.batch_index + ' 条提示词'}</h3><button className="secondary" onClick={() => dialog.current?.close()}>关闭</button></div><pre className="prompt-batch-text">{viewed.prompt || viewed.error || '尚未生成提示词'}</pre>{copyButton(viewed)}{viewed.prompt_copied_at && <p>已复制 · {formatTime(viewed.prompt_copied_at)}</p>}</>}
    </dialog>
  </section>;
}
