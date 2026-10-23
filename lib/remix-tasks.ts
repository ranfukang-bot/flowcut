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
    const target=parent.remix_analysis_blocks?savedRemixSegments(parent)[i]:null;
    const versions=rows.results.filter(r=>Number(r.batch_index)===i+1 && (!target || (Number(r.remix_segment_start)===target.start && Number(r.remix_segment_end)===target.end && Number(r.duration)===target.duration)));
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

export async function remixAction(db: ReturnType<typeof getDb>, body: {id:string;action?:string;clipId?:string;index?:number;note?:string;externalId?:string}, now=new Date().toISOString()) {
  const task=await getRemix(db,body.id);
  if (!task) return Response.json({error:'分段复刻任务不存在；旧版记录只支持查看和删除'},{status:404});
  if (['remix_done','remix_finishing','remix_deleting'].includes(task.status) || REMIX_ACTIVE.includes(task.status) || await db.prepare("SELECT id FROM tasks WHERE batch_parent_id=? AND (status='concat_running' OR review_status IN ('merging','approving'))").bind(task.id).first())
    return Response.json({error:'任务正在处理或已放行，请等当前操作结束'},{status:409});
  if(body.action==='resume-segments') {
    if(task.status!=='failed' || !task.remix_analysis_blocks || !await db.prepare("SELECT id FROM tasks WHERE batch_parent_id=? AND task_role='clip'").bind(task.id).first())return Response.json({error:'没有可恢复的原分段'},{status:409});
    await db.prepare("UPDATE tasks SET status='remix_segmented',progress=70,error=NULL,bridge_worker_id=NULL,bridge_claimed_at=NULL,updated_at=? WHERE id=? AND status='failed'").bind(now,task.id).run();
    return Response.json({ok:true});
  }
  if(body.action==='product-id') {
    const externalId=String(body.externalId || '').trim();
    if(!/^\d{10,30}$/.test(externalId))return Response.json({error:'请填写 10–30 位数字商品 ID'},{status:400});
    await db.batch([
      db.prepare("UPDATE tasks SET product_external_id_snapshot=?,updated_at=? WHERE id=? AND status=?").bind(externalId,now,task.id,task.status),
      db.prepare("UPDATE tasks SET product_external_id_snapshot=? WHERE batch_parent_id=? AND review_status='pending'").bind(externalId,task.id),
    ]);
    return Response.json({ok:true});
  }
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
    if(task.status!=='remix_segmented')return Response.json({error:'请先恢复并完成当前换品任务'},{status:409});
    const clip=await db.prepare("SELECT * FROM tasks WHERE id=? AND batch_parent_id=? AND task_role='clip' AND status IN ('video_ready','scheduled') AND download_path IS NOT NULL AND review_status='pending'").bind(body.clipId,task.id).first<{id:string;batch_index:number;remix_segment_start:number;remix_segment_end:number;duration:number}>();
    if(!clip) return Response.json({error:'此版本尚无可检查的视频'},{status:409});
    const expected=savedRemixSegments(task).find(s=>s.index===clip.batch_index);
    if(!expected || clip.remix_segment_start!==expected.start || clip.remix_segment_end!==expected.end || clip.duration!==expected.duration)return Response.json({error:'这个旧版本的区间与当前原脚本不同，请使用新拆解后生成的版本'},{status:409});
    await db.batch([
      db.prepare("UPDATE tasks SET remix_selected_json=json_set(COALESCE(remix_selected_json,'{}'),?,?),updated_at=? WHERE id=? AND status='remix_segmented'").bind(`$."${clip.batch_index}"`,clip.id,now,task.id),
      ...(body.action==='check'?[db.prepare("UPDATE tasks SET segment_checked_at=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM tasks p WHERE p.id=? AND p.status='remix_segmented')").bind(now,now,clip.id,task.id)]:[]),
    ]);
    return Response.json({ok:true});
  }
  return Response.json({error:'不支持的分段复刻操作'},{status:400});
}

export async function regenerateRemixClip(db: ReturnType<typeof getDb>,id:string,requestId:string) {
  const source=await db.prepare("SELECT * FROM tasks WHERE id=? AND task_role='clip'").bind(id).first<Record<string,unknown>>();
  const parent=source?.batch_parent_id?await getRemix(db,String(source.batch_parent_id)):null;
  if(!source || !parent) return null;
  if(parent.status!=='remix_segmented' || !['video_ready','scheduled'].includes(String(source.status)) || source.review_status!=='pending') return Response.json({error:'请在分段就绪且视频检查中时重新生成'},{status:409});
  const seedance=await getProviderConfig('seedance');
  const start=clipStart(Boolean(source.auto_queue),{mode:seedance.config.mode,secretConfigured:seedance.secretConfigured});
  const now=new Date().toISOString(),round=Number(parent.batch_round)+1;
  const result=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO tasks(id,product_id,gem_id,title,status,prompt,provider,progress,duration,region,shooting_style,
      callback_token,auto_queue,gemini_account_id,tiktok_account_name,archive_directory,gem_content_snapshot,product_external_id_snapshot,
      gemini_request_text,image_keys_snapshot,task_role,batch_parent_id,batch_index,batch_round,batch_size,
      remix_segment_script,remix_segment_start,remix_segment_end,regenerated_from_task_id,created_at,updated_at)
      SELECT ?,c.product_id,c.gem_id,c.title,?,c.prompt,?,?,c.duration,c.region,c.shooting_style,?,c.auto_queue,c.gemini_account_id,
      c.tiktok_account_name,c.archive_directory,c.gem_content_snapshot,c.product_external_id_snapshot,c.gemini_request_text,c.image_keys_snapshot,
      c.task_role,c.batch_parent_id,c.batch_index,?,c.batch_size,c.remix_segment_script,c.remix_segment_start,c.remix_segment_end,c.id,?,?
      FROM tasks c JOIN tasks p ON p.id=c.batch_parent_id WHERE c.id=? AND c.review_status='pending' AND p.status='remix_segmented' AND p.batch_round=?
      AND NOT EXISTS(SELECT 1 FROM tasks active WHERE active.regenerated_from_task_id=c.id AND active.status NOT IN ('video_ready','scheduled','failed'))`)
      .bind(requestId,start.status,start.provider,start.progress,crypto.randomUUID(),round,now,now,id,parent.batch_round),
    db.prepare('UPDATE tasks SET batch_round=?,updated_at=? WHERE id=? AND batch_round=? AND EXISTS(SELECT 1 FROM tasks WHERE id=?)').bind(round,now,parent.id,parent.batch_round,requestId),
  ]);
  const created=await db.prepare('SELECT id,status FROM tasks WHERE id=? AND regenerated_from_task_id=?').bind(requestId,id).first();
  return created?Response.json({...created,created:Boolean(result[0].meta.changes),preserveSource:true},{status:201}):Response.json({error:'已有重新生成中的版本，请等待完成'},{status:409});
}
