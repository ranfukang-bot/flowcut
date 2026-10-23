"use client";
import { useRef, useState } from 'react';
import type { Task } from './studio-types';
import { api, desktopBridge } from './studio-client';
import { confirmAction } from './confirm-action';
import { parseSegmentHeader } from '../lib/remix-segments';
import { StageBar, taskStatusLabel, taskStatusClass } from './task-status';
import { REMIX_GEMINI_STATUSES, VIDEO_DONE_STATUSES } from '../lib/task-statuses';

export function remixSelected(task:Task) {
  const explicit=JSON.parse(task.remix_selected_json || '{}') as Record<string,string>;
  const clips=(task.children || []).filter(c=>c.task_role==='clip').sort((a,b)=>Number(b.batch_round)-Number(a.batch_round)||b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id));
  return Array.from({length:task.batch_size || 0},(_,i)=>{
    const saved=JSON.parse(task.remix_analysis_blocks || '[]') as string[];
    const target=saved[i]?parseSegmentHeader(saved[i].split('\n')[0]):null;
    const versions=clips.filter(c=>c.batch_index===i+1 && (!target||(c.remix_segment_start===target.start&&c.remix_segment_end===target.end&&c.duration===target.duration)));
    return {versions,selected:versions.find(c=>c.id===explicit[i+1]) || versions.find(c=>VIDEO_DONE_STATUSES.includes(c.status)&&c.download_path&&!['merging','merged','deleting','replaced'].includes(c.review_status || '')) || versions[0]};
  });
}
export function RemixGroupPanel({task,onUpdated}:{task:Task;onUpdated:(message:string)=>Promise<void>}) {
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[notes,setNotes]=useState<Record<number,string>>({}),[productId,setProductId]=useState(task.product_external_id || '');
  const regenerateRequests=useRef<Record<string,string>>({});
  const lock=useRef(false);
  const segments=remixSelected(task);
  const active=REMIX_GEMINI_STATUSES.includes(task.status),done=task.status==='remix_done',finishing=task.status==='remix_finishing';
  const missing=segments.filter(s=>!s.selected?.download_path || !VIDEO_DONE_STATUSES.includes(s.selected.status)).length;
  const unchecked=segments.filter(s=>s.selected?.download_path&&!s.selected.segment_checked_at).length;
  const reason=done?'已放入 TK 目录':active?'等待当前 Gemini 任务完成':!segments.length?'等待拆解出分段':missing?`还有 ${missing} 段未出片`:unchecked?`还有 ${unchecked} 段未标记「这段可以」`:!/^\d{10,30}$/.test(task.product_external_id || '')?'请先补全商品 ID':task.status!=='remix_segmented'&&!finishing?'请先恢复任务':'';
  async function run(key:string,action:()=>Promise<unknown>,message:string) {
    if(lock.current)return;lock.current=true;setBusy(key);setError('');
    try {await action();await onUpdated(message);}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{lock.current=false;setBusy('');}
  }
  const patch=(action:string,extra:object={})=>api('/api/reference-remix',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({id:task.id,action,...extra})});
  return <section className="remix-group-panel" aria-label="分段复刻详情">
    <div className="section-title"><div><h3>{task.title}</h3><p>{task.remix_video_seconds || '未知'} 秒 · {task.batch_size || '待拆解'} 段 · {task.region} · TK：{task.tiktok_account_name}</p></div><span className={`status ${taskStatusClass(task)}`}>{taskStatusLabel(task)}</span></div>
    <StageBar task={task} />
    {task.error && <p className="warning-box">{task.error}</p>}
    <details><summary>第一轮原脚本{task.remix_script?'（已保存，重试可复用）':''}</summary><pre>{task.remix_script || '等待完整拆解并校验通过'}</pre></details>
    {task.remix_raw_replies && <details><summary>查看各轮原始回复</summary><pre>{task.remix_raw_replies}</pre></details>}
    <div className="remix-segments">
      {segments.map(({versions,selected},offset)=><article className="remix-segment" key={offset}>
        <div className="section-title"><b>第 {offset+1} 段 · {selected?.remix_segment_start ?? '?'}–{selected?.remix_segment_end ?? '?'} 秒 · {selected?.duration || '?'} 秒</b>
          <label>选用版本<select aria-label={`第${offset+1}段版本`} disabled={Boolean(busy)||active||done||finishing} value={selected?.id || ''} onChange={e=>void run('select',()=>patch('select',{clipId:e.target.value}),'已切换选用版本')}>
            {!versions.length&&<option>等待生成</option>}{versions.map(v=><option key={v.id} value={v.id} disabled={!v.download_path || v.review_status!=='pending'}>第 {v.batch_round} 版 · {taskStatusLabel(v)}{v.segment_checked_at?' · 已检查':''}</option>)}
          </select></label>
        </div>
        {selected && <><StageBar task={selected} />{selected.error&&<p className="warning-box">{selected.error}</p>}
          <div className="row-actions">
            <button className="secondary" disabled={!selected.download_path||Boolean(busy)} onClick={()=>void run('preview',async()=>{const d=desktopBridge();if(!d?.openReviewVideo)throw Error('请在新版桌面程序中预览视频');await d.openReviewVideo(selected.id);},'')}>预览视频</button>
            <button className={selected.segment_checked_at?'secondary':'review-action'} disabled={!selected.download_path||Boolean(busy)||active||done||finishing} onClick={()=>void run('check',()=>patch('check',{clipId:selected.id}),'此版本已标记「这段可以」')}>{selected.segment_checked_at?'✓ 这段可以':'这段可以'}</button>
            <button className="secondary" disabled={!selected.download_path||Boolean(busy)||active||done||finishing} onClick={()=>void run('regenerate',async()=>{regenerateRequests.current[selected.id] ||= crypto.randomUUID();await api('/api/tasks/recreate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:selected.id,requestId:regenerateRequests.current[selected.id]})});delete regenerateRequests.current[selected.id];},'已用同一提示词生成新版本，原版本保留')}>重新生成视频</button>
            {selected.status==='failed'&&<button className="secondary" disabled={Boolean(busy)||active||done||finishing} onClick={()=>void run('resume-clip',async()=>{const d=desktopBridge();if(!d?.resumeRemixSeedance)throw Error('请更新桌面程序');await d.resumeRemixSeedance(selected.id);},'已按原 Seedance 任务核对恢复，未新建任务')}>恢复原 Seedance 任务</button>}
            <button className="secondary danger-text" disabled={Boolean(busy)||active||done||finishing} onClick={()=>void run('delete-clip',async()=>{if(!await confirmAction('删除这个分段版本及其临时视频？'))return;const d=desktopBridge();if(!d?.deleteRemixClip)throw Error('请在新版桌面程序中删除分段');await d.deleteRemixClip(selected.id,true);},'已删除该分段版本')}>删除此版本</button>
          </div>
          {!done && <details><summary>重新写这段提示词</summary><label>修改说明（选填）<input value={notes[offset+1] || ''} onChange={e=>setNotes({...notes,[offset+1]:e.target.value})} placeholder="例如：加快运镜，保留原区间" /></label><button className="secondary" disabled={Boolean(busy)||active||finishing||!task.remix_script} onClick={()=>void run('rewrite',()=>patch('rewrite',{index:offset+1,note:notes[offset+1] || ''}),'已排队重写这一段，旧版本保留')}>重新写这段提示词</button></details>}
        </>}
      </article>)}
    </div>
    {!done && !/^\d{10,30}$/.test(task.product_external_id || '') && <div className="remix-id-entry"><label>放行前补全商品 ID<input value={productId} onChange={e=>setProductId(e.target.value)} /></label><button className="secondary" disabled={Boolean(busy)||active||finishing} onClick={()=>void run('product-id',()=>patch('product-id',{externalId:productId}),'商品 ID 已补全')}>保存商品 ID</button></div>}
    {reason&&<p role="status">{reason}</p>}
    <div className="remix-group-actions">
      {!done&&<button className="primary" disabled={Boolean(busy)||(!finishing&&Boolean(reason))} onClick={()=>void run('finish',async()=>{if(!await confirmAction('确认全部选用分段都已检查？将按顺序拼接并放入所选 TK 目录，放行后清理未选用版本。'))return;const d=desktopBridge();if(!d?.finishRemix)throw Error('请在新版桌面程序中拼接放行');await d.finishRemix(task.id,true);},'复刻成片已放入 TK 目录')}>{busy==='finish'?'正在拼接放行…':finishing?'继续放行 / 清理':'拼接并放入 TK 目录'}</button>}
      {task.status==='failed'&&Boolean(task.remix_script)&&Boolean(task.children?.length)&&<button className="secondary" disabled={Boolean(busy)} onClick={()=>void run('resume-segments',()=>patch('resume-segments'),'已恢复原分段检查；未重新运行 Gemini 或提交视频')}>恢复已有分段检查</button>}
      {task.status==='failed'&&<button className="secondary" disabled={Boolean(busy)} onClick={()=>void run('retry',()=>patch('retry'),'已恢复任务；已保存的原脚本会复用')}>恢复任务</button>}
      {!done&&<><button className="secondary" disabled={Boolean(busy)||active||finishing||!task.remix_script} onClick={()=>void run('readapt',()=>patch('readapt'),'已用原脚本重新换品，旧段保留')}>用原脚本重新换品</button><button className="secondary" disabled={Boolean(busy)||active||finishing} onClick={()=>void run('reanalyze',async()=>{if(await confirmAction('清空原脚本并重新上传视频拆解？已有分段版本保留。'))await patch('reanalyze');},'已排队重新拆解')}>重新拆解</button></>}
      <button className="secondary danger-text" disabled={Boolean(busy)||finishing} onClick={()=>void run('delete',async()=>{if(!await confirmAction('删除整组及所有临时视频和对标视频？已放入 TK 目录的成片保留。'))return;const d=desktopBridge();if(!d?.deleteRemix)throw Error('请在新版桌面程序中删除整组');await d.deleteRemix(task.id,true);},'已删除整组和临时视频')}>删除整组</button>
    </div>
    {task.children?.filter(c=>c.review_status==='approved').map(c=><p key={c.id}>已放行：{c.approved_path}</p>)}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </section>;
}
