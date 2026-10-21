"use client";
import type { Task } from './studio-types';

export function FissionBatchPanel({task,statusLabel,onOpenTask}:{task:Task;statusLabel:(task:Task)=>string;onOpenTask:(task:Task)=>void}){
  return <section className="fission-batch-panel" aria-label="多品裂变商品进度">
    <h3>同一份母版 · 每个商品一条视频</h3>
    <div className="fission-children">
      {(task.children||[]).map(child=><div className="fission-child" key={child.id}>
        {child.product_image_key && <img alt={child.product_name||'商品'} src={`/api/media?key=${encodeURIComponent(child.product_image_key)}`} />}
        <span><b>{child.product_name||child.title}</b><small>商品 ID：{child.product_external_id}</small></span>
        <span className="status">{statusLabel(child)}</span>
        <button className="secondary" onClick={()=>onOpenTask(child)}>查看商品任务</button>
      </div>)}
    </div>
    {task.prompt && <details><summary>共用母版提示词</summary><pre>{task.prompt}</pre></details>}
    {task.variant_request_text && <details><summary>发送给变体 Gem 的文字</summary><pre>{task.variant_request_text}</pre></details>}
    {task.gemini_raw_reply && <details><summary>母版原始回复</summary><pre>{task.gemini_raw_reply}</pre></details>}
  </section>;
}
