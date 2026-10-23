import { getDb } from './storage';
import { getRemix, selectedRemixClips, type RemixTask } from './remix-tasks';

type Db=ReturnType<typeof getDb>;
const conflict=(error:string)=>Response.json({error},{status:409});
export async function remixReviewQuery(db:Db,params:URLSearchParams) {
  if(params.get('remix')==='recover') return Response.json((await db.prepare("SELECT id FROM tasks WHERE task_role='remix' AND status IN ('remix_finishing','remix_done') AND remix_release_task_id IS NOT NULL").all()).results);
  if(params.get('remix')==='cleanup') {
    const rows=await db.prepare(`SELECT c.* FROM tasks c JOIN tasks p ON p.id=c.batch_parent_id JOIN tasks released ON released.id=p.remix_release_task_id
      WHERE p.id=? AND p.task_role='remix' AND released.review_status='approved' AND c.id<>released.id`).bind(params.get('group')).all();
    return Response.json(rows.results);
  }
  return null;
}
async function ready(db:Db,parent:RemixTask) {
  if(parent.status!=='remix_segmented') throw Error('请先完成当前拆解、换品或重写');
  const clips=await selectedRemixClips(db,parent);
  if(!clips.length || clips.length>10 || clips.some((c,i)=>!c || Number(c.batch_index)!==i+1 || !['video_ready','scheduled'].includes(String(c.status)) || !c.download_path || !c.segment_checked_at || c.review_status!=='pending')) throw Error('每段必须选用一个已下载的版本，并全部标记「这段可以」');
  if(!/^\d{10,30}$/.test(String(parent.product_external_id_snapshot || ''))) throw Error('商品 ID 不完整，请补全商品 ID 后再放入 TK 目录');
  return clips;
}
export async function prepareRemixRelease(db:Db,id:string) {
  const parent=await getRemix(db,id);
  if(!parent) return conflict('分段复刻任务不存在');
  if(parent.remix_release_task_id && ['remix_finishing','remix_done'].includes(parent.status)) return Response.json({releaseId:parent.remix_release_task_id});
  try { const clips=await ready(db,parent);return Response.json({sourceIds:clips.map(c=>c!.id)}); }
  catch(error) {return conflict((error as Error).message);}
}
export async function reserveRemixConcat(db:Db,parent:RemixTask,concatId:string,ids:string[]) {
  const existing=await db.prepare('SELECT * FROM tasks WHERE id=? AND batch_parent_id=?').bind(concatId,parent.id).first<{status:string;concat_source_ids:string}>();
  if(existing) {
    if(existing.status!=='concat_running' || JSON.stringify(JSON.parse(existing.concat_source_ids).sort())!==JSON.stringify([...ids].sort())) return conflict('拼接请求已存在且不匹配');
    return Response.json({ok:true,remix:true,sources:(await db.prepare("SELECT id,download_path,batch_index,batch_round FROM tasks WHERE merged_into_task_id=? AND review_status='merging' ORDER BY batch_index").bind(concatId).all()).results});
  }
  let clips;
  try {clips=await ready(db,parent);} catch(error){return conflict((error as Error).message);}
  if(clips.length!==ids.length || clips.some(c=>!ids.includes(c!.id))) return conflict('每段只能选一个版本，且必须与组里选用的版本一致');
  const ordered=clips.map(c=>c!.id),marks=ordered.map(()=>'?').join(','),now=new Date().toISOString();
  const gate=`id=? AND task_role='remix' AND status='remix_segmented' AND batch_round=? AND COALESCE(remix_selected_json,'{}')=?
    AND (SELECT COUNT(*) FROM tasks WHERE id IN (${marks}) AND batch_parent_id=? AND review_status='pending' AND segment_checked_at IS NOT NULL
      AND status IN ('video_ready','scheduled') AND download_path IS NOT NULL)=?`;
  const gateArgs=[parent.id,parent.batch_round,parent.remix_selected_json || '{}',...ordered,parent.id,ordered.length];
  await db.batch([
    db.prepare(`INSERT INTO tasks(id,product_id,gem_id,title,status,prompt,provider,progress,duration,region,shooting_style,callback_token,
      auto_queue,tiktok_account_name,archive_directory,gem_content_snapshot,product_external_id_snapshot,image_keys_snapshot,review_status,task_role,batch_parent_id,batch_size,concat_source_ids,created_at,updated_at)
      SELECT ?,product_id,gem_id,title || ' · 拼接成片','concat_running','','local-concat',80,(SELECT SUM(duration) FROM tasks WHERE id IN (${marks})),region,shooting_style,?,0,
      tiktok_account_name,archive_directory,gem_content_snapshot,product_external_id_snapshot,image_keys_snapshot,'pending','concat',id,?,?,?,? FROM tasks WHERE ${gate}`)
      .bind(concatId,...ordered,crypto.randomUUID(),ordered.length,JSON.stringify(ordered),now,now,...gateArgs),
    db.prepare("UPDATE tasks SET status='remix_finishing',remix_release_task_id=?,updated_at=? WHERE id=? AND status='remix_segmented' AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND status='concat_running')").bind(concatId,now,parent.id,concatId),
    db.prepare(`UPDATE tasks SET review_status='merging',merged_into_task_id=? WHERE id IN (${marks}) AND review_status='pending' AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND status='concat_running')`).bind(concatId,...ordered,concatId),
  ]);
  const sources=(await db.prepare("SELECT id,download_path,batch_index,batch_round FROM tasks WHERE merged_into_task_id=? AND review_status='merging' ORDER BY batch_index").bind(concatId).all()).results;
  return sources.length===ordered.length?Response.json({ok:true,remix:true,sources}):conflict('选用版本或检查状态已改变，请刷新');
}
export async function remixReviewAction(db:Db,body:{id:string;action?:string;groupId?:string}) {
  if(body.action==='remix-delete-reserve') {
    const parent=await getRemix(db,body.id);if(!parent)return conflict('分段复刻任务不存在');
    if(parent.status==='remix_finishing' || await db.prepare("SELECT id FROM tasks WHERE batch_parent_id=? AND (status='concat_running' OR review_status IN ('merging','approving'))").bind(parent.id).first()) return conflict('正在拼接或放行，请完成后再删除');
    await db.prepare("UPDATE tasks SET status='remix_deleting',bridge_worker_id=NULL,bridge_claimed_at=NULL WHERE id=?").bind(parent.id).run();
    return Response.json({parent,children:(await db.prepare('SELECT * FROM tasks WHERE batch_parent_id=?').bind(parent.id).all()).results});
  }
  if(body.action==='remix-reserve-delete-clip' || body.action==='remix-delete-clip') {
    const clip=await db.prepare("SELECT c.* FROM tasks c JOIN tasks p ON p.id=c.batch_parent_id WHERE c.id=? AND c.task_role='clip' AND p.task_role='remix' AND p.status='remix_segmented' AND c.review_status IN ('pending','deleting')").bind(body.id).first();
    if(!clip)return conflict('分段正在使用或已放行，不能删除');
    if(body.action==='remix-reserve-delete-clip') {
      await db.prepare("UPDATE tasks SET review_status='deleting',status='failed',bridge_worker_id=NULL,bridge_claimed_at=NULL WHERE id=?").bind(body.id).run();return Response.json(clip);
    }
    await db.batch([db.prepare("DELETE FROM schedules WHERE task_id IN (SELECT id FROM tasks WHERE id=? AND review_status='deleting')").bind(body.id),db.prepare("DELETE FROM tasks WHERE id=? AND review_status='deleting'").bind(body.id)]);
    return Response.json({ok:true});
  }
  if(body.action==='remix-prepare') return prepareRemixRelease(db,body.id);
  if(body.action==='remix-single-reserve') {
    const parent=await getRemix(db,body.id);if(!parent)return conflict('分段复刻任务不存在');
    if(parent.remix_release_task_id && ['remix_finishing','remix_done'].includes(parent.status)) return Response.json({releaseId:parent.remix_release_task_id});
    try {
      const clips=await ready(db,parent);if(clips.length!==1)return conflict('只有一段的组才能直接放行');
      const result=await db.prepare(`UPDATE tasks SET status='remix_finishing',remix_release_task_id=? WHERE id=? AND status='remix_segmented'
        AND COALESCE(remix_selected_json,'{}')=? AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND segment_checked_at IS NOT NULL AND review_status='pending')`)
        .bind(clips[0]!.id,parent.id,parent.remix_selected_json || '{}',clips[0]!.id).run();
      return result.meta.changes?Response.json({releaseId:clips[0]!.id}):conflict('选用版本已改变');
    }catch(error){return conflict((error as Error).message);}
  }
  if(body.action==='remix-delete-unused') {
    const gate="SELECT c.id FROM tasks c JOIN tasks p ON p.id=c.batch_parent_id JOIN tasks released ON released.id=p.remix_release_task_id WHERE c.id=? AND p.id=? AND p.task_role='remix' AND released.review_status='approved' AND c.id<>released.id";
    await db.batch([db.prepare(`DELETE FROM schedules WHERE task_id IN (${gate})`).bind(body.id,body.groupId),db.prepare(`DELETE FROM tasks WHERE id IN (${gate})`).bind(body.id,body.groupId)]);
    return await db.prepare('SELECT id FROM tasks WHERE id=?').bind(body.id).first()?conflict('未满足放行后清理条件'):Response.json({ok:true});
  }
  if(body.action==='remix-complete') {
    const updated=await db.prepare(`UPDATE tasks SET status='remix_done',progress=100,error=NULL WHERE id=? AND task_role='remix'
      AND remix_release_task_id IN (SELECT id FROM tasks WHERE review_status='approved')
      AND NOT EXISTS(SELECT 1 FROM tasks c WHERE c.batch_parent_id=tasks.id AND c.id<>tasks.remix_release_task_id)`).bind(body.id).run();
    return updated.meta.changes?Response.json({ok:true}):conflict('成片尚未放行或旧版本尚未清理');
  }
  return null;
}
export async function allowRemixClipApproval(db:Db,id:string,groupId?:string) {
  const child=await db.prepare("SELECT p.id,p.task_role,p.batch_size,p.status,p.remix_release_task_id,c.segment_checked_at FROM tasks c JOIN tasks p ON p.id=c.batch_parent_id WHERE c.id=? AND c.task_role='clip' AND p.task_role='remix'").bind(id).first<Record<string,unknown>>();
  if(!child) return true;
  return child.id===groupId && Number(child.batch_size)===1 && child.remix_release_task_id===id && child.segment_checked_at && ['remix_finishing','remix_done'].includes(String(child.status));
}
