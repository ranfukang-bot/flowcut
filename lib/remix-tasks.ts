import { clipStart, clipTaskId } from './task-batches';
import { getProviderConfig } from './provider-config';
import { validateRemixAdaptation, validateRemixAnalysis, type RemixSegment } from './remix-segments';
import { getDb } from './storage';

export type RemixTask = Record<string, unknown> & { id: string; status: string; batch_round: number; batch_size: number; bridge_worker_id: string; remix_analysis_blocks: string; remix_video_seconds: number | null; remix_plan_json: string; remix_rewrite_index: number | null; remix_raw_replies: string };
export const REMIX_ACTIVE = ['remix_queued','remix_analyzing','remix_adapting','remix_rewrite_queued','remix_rewriting'];
export function isRemixKind(kind: unknown) { return kind === 'remix-segments' || kind === 'remix-rewrite'; }
export function savedRemixSegments(task: RemixTask): RemixSegment[] {
  return validateRemixAnalysis(JSON.parse(task.remix_analysis_blocks || '[]'), task.remix_video_seconds, JSON.parse(task.remix_plan_json || '[]'));
}
export async function getRemix(db: ReturnType<typeof getDb>, id: string) {
  return db.prepare("SELECT * FROM tasks WHERE id=? AND task_role='remix'").bind(id).first<RemixTask>();
}
export async function selectedRemixClips(db: ReturnType<typeof getDb>, parent: RemixTask) {
  const rows = await db.prepare("SELECT * FROM tasks WHERE batch_parent_id=? AND task_role='clip' ORDER BY batch_round DESC,created_at DESC,id DESC").bind(parent.id).all<Record<string, unknown> & { id: string; batch_index: number }>();
  const explicit = JSON.parse(String(parent.remix_selected_json || '{}')) as Record<string,string>;
  return Array.from({length:Number(parent.batch_size || 0)},(_,i) => {
    const versions=rows.results.filter(r=>Number(r.batch_index)===i+1);
    return versions.find(r=>r.id===explicit[i+1]) || versions.find(r=>['video_ready','scheduled'].includes(String(r.status)) && r.download_path && !['merged','merging','deleting','replaced'].includes(String(r.review_status))) || versions[0];
  });
}

// Both the clip inserts and the parent transition use the same lease and round.
// A stale renderer, replayed outbox result, or failed validation inserts nothing.
export async function finishRemixRound(db: ReturnType<typeof getDb>, task: RemixTask, blocks: string[], workerId: string, round: number, rawReplies: unknown, now: string) {
  const expected=savedRemixSegments(task);
  const segments=validateRemixAdaptation(blocks,expected,task.remix_rewrite_index || undefined);
  const seedance=await getProviderConfig('seedance');
  const start=clipStart(Boolean(task.auto_queue),{mode:seedance.config.mode,secretConfigured:seedance.secretConfigured});
  const active=task.remix_rewrite_index ? 'remix_rewriting' : 'remix_adapting';
  const guard="id=? AND task_role='remix' AND provider='gemini-web' AND status=? AND bridge_worker_id=? AND batch_round=?";
  const replies=JSON.stringify(Array.isArray(rawReplies)?rawReplies:[]);
  const inserts=segments.map(segment=>db.prepare(`INSERT OR IGNORE INTO tasks
    (id,product_id,gem_id,title,status,prompt,provider,progress,duration,region,shooting_style,callback_token,auto_queue,
     gemini_account_id,tiktok_account_name,archive_directory,gem_content_snapshot,product_external_id_snapshot,gemini_request_text,image_keys_snapshot,
     task_role,batch_parent_id,batch_index,batch_round,batch_size,remix_segment_script,remix_segment_start,remix_segment_end,created_at,updated_at)
    SELECT ?,product_id,gem_id,title || ' · 第 ' || ? || ' 段',?,?,?,?,?,region,shooting_style,?,auto_queue,
     gemini_account_id,tiktok_account_name,archive_directory,gem_content_snapshot,product_external_id_snapshot,gemini_request_text,image_keys_snapshot,
     'clip',id,?,?,batch_size,?,?,?,?,? FROM tasks WHERE ${guard}`).bind(
    clipTaskId(task.id,round,segment.index),segment.index,start.status,segment.text,start.provider,start.progress,segment.duration,crypto.randomUUID(),
    segment.index,round,expected.find(s=>s.index===segment.index)!.text,segment.start,segment.end,now,now,task.id,active,workerId,round));
  const results=await db.batch([...inserts,db.prepare(`UPDATE tasks SET status='remix_segmented',progress=70,
    remix_adaptation_raw=?,gemini_raw_reply=?,remix_raw_replies=json_insert(COALESCE(remix_raw_replies,'[]'),'$[#]',json(?)),
    bridge_worker_id=NULL,bridge_claimed_at=NULL,gemini_retry_at=NULL,gemini_failures=0,error=NULL,remix_rewrite_index=NULL,remix_rewrite_note=NULL,
    updated_at=? WHERE ${guard}`).bind(segments.map(s=>s.text).join('\n\n'),segments.map(s=>s.text).join('\n\n'),replies,now,task.id,active,workerId,round)]);
  return Boolean(results.at(-1)?.meta.changes);
}

export async function remixAction(db: ReturnType<typeof getDb>, body: {id:string;action?:string;clipId?:string;index?:number;note?:string}, now=new Date().toISOString()) {
  const task=await getRemix(db,body.id);
  if (!task) return Response.json({error:'分段复刻任务不存在；旧版记录只支持查看和删除'},{status:404});
  if (task.status==='remix_done' || REMIX_ACTIVE.includes(task.status) || await db.prepare("SELECT id FROM tasks WHERE batch_parent_id=? AND (status='concat_running' OR review_status IN ('merging','approving'))").bind(task.id).first())
    return Response.json({error:'任务正在处理或已放行，请等当前操作结束'},{status:409});
  if (['retry','reanalyze','readapt','rewrite'].includes(body.action || '')) {
    if(body.action==='rewrite' && (!Number.isInteger(body.index)||Number(body.index)<1||Number(body.index)>Number(task.batch_size))) return Response.json({error:'分段序号无效'},{status:400});
    if(['rewrite','readapt'].includes(body.action || '') && !task.remix_analysis_blocks) return Response.json({error:'没有已校验的原脚本，请先拆解'},{status:409});
    const rewrite=body.action==='rewrite';
    await db.prepare(`UPDATE tasks SET status=?,provider='gemini-web',progress=5,batch_round=batch_round+1,
      remix_script=CASE WHEN ? THEN NULL ELSE remix_script END,remix_analysis_blocks=CASE WHEN ? THEN NULL ELSE remix_analysis_blocks END,
      remix_rewrite_index=?,remix_rewrite_note=?,bridge_worker_id=NULL,bridge_claimed_at=NULL,gemini_failures=0,gemini_retry_at=NULL,error=NULL,updated_at=?
      WHERE id=? AND status=? AND batch_round=?`).bind(rewrite?'remix_rewrite_queued':'remix_queued',body.action==='reanalyze',body.action==='reanalyze',rewrite?body.index:null,rewrite?String(body.note || '').trim().slice(0,4000):null,now,task.id,task.status,task.batch_round).run();
    return Response.json({ok:true});
  }
  if(body.action==='select' || body.action==='check') {
    const clip=await db.prepare("SELECT * FROM tasks WHERE id=? AND batch_parent_id=? AND task_role='clip' AND status IN ('video_ready','scheduled') AND download_path IS NOT NULL AND review_status='pending'").bind(body.clipId,task.id).first<{id:string;batch_index:number}>();
    if(!clip) return Response.json({error:'此版本尚无可检查的视频'},{status:409});
    await db.batch([
      db.prepare("UPDATE tasks SET remix_selected_json=json_set(COALESCE(remix_selected_json,'{}'),?,?),updated_at=? WHERE id=? AND status='remix_segmented'").bind(`$."${clip.batch_index}"`,clip.id,now,task.id),
      ...(body.action==='check'?[db.prepare("UPDATE tasks SET segment_checked_at=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM tasks p WHERE p.id=? AND p.status='remix_segmented')").bind(now,now,clip.id,task.id)]:[]),
    ]);
    return Response.json({ok:true});
  }
  return Response.json({error:'不支持的分段复刻操作'},{status:400});
}
