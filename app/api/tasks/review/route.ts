import { ensureWorkspace, getDb, jsonError } from "../../../../lib/storage";
import { approvalDay, APPROVAL_COUNT_INSERT } from "../../../../lib/approval-stats";
import { ORPHAN_GROUP_DELETE } from "../../../../lib/task-batches";

const TASK_ID = /^[\w-]{1,120}$/;
const MAX_CONCAT_CLIPS = 10;

export async function GET(request: Request) {
  try {
    await ensureWorkspace();
    const params = new URL(request.url).searchParams;
    // Desktop recovery: concatenations interrupted mid-way, and approved
    // concatenations whose merged clips still have to be removed.
    if (params.get('concat') === 'running') {
      const rows = await getDb().prepare(`SELECT id FROM tasks WHERE task_role='concat' AND status='concat_running'`).all();
      return Response.json(rows.results);
    }
    if (params.get('concat') === 'consume') {
      const rows = await getDb().prepare(`SELECT DISTINCT merged_into_task_id AS id FROM tasks WHERE review_status='merged'
        AND merged_into_task_id IN (SELECT id FROM tasks WHERE task_role='concat' AND review_status='approved')`).all();
      return Response.json(rows.results);
    }
    if (params.get('merged')) {
      const rows = await getDb().prepare(`SELECT id, download_path, review_status, batch_index, batch_round FROM tasks
        WHERE merged_into_task_id=? ORDER BY batch_round ASC, batch_index ASC, created_at ASC`).bind(params.get('merged')).all();
      return Response.json(rows.results);
    }
    if (params.get('approved') === '1') {
      const tasks = await getDb().prepare(`SELECT t.*, COALESCE(t.product_external_id_snapshot,p.external_id) AS product_external_id
        FROM tasks t LEFT JOIN products p ON p.id=t.product_id WHERE review_status='approved'`).all();
      return Response.json(tasks.results);
    }
    const id = new URL(request.url).searchParams.get("id");
    const task = await getDb().prepare(`SELECT t.*, COALESCE(t.product_external_id_snapshot,p.external_id) AS product_external_id
      FROM tasks t LEFT JOIN products p ON p.id=t.product_id WHERE t.id=?`).bind(id).first();
    return task || new URL(request.url).searchParams.get('optional') === '1' ? Response.json(task || null) : Response.json({ error: "任务不存在" }, { status: 404 });
  } catch (error) { return jsonError(error); }
}

// Invoked by the local desktop after the checked file is durably released.
export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const body = await request.json() as { id: string; path: string; oldPath?: string; confirmed: boolean; action?: string; replacementId?: string; approvedAt?: string; timeZone?: string; concatId?: string; sourceIds?: string[] };
    if (body.confirmed !== true || !body.id) return Response.json({ error: "请确认审核通过" }, { status: 400 });
    if (body.action === 'concat-reserve') return reserveConcat(body);
    if (body.action === 'concat-finish') {
      if (!body.path) return Response.json({ error: '缺少拼接成片路径' }, { status: 400 });
      const db = getDb();
      const [finished] = await db.batch([
        db.prepare(`UPDATE tasks SET status='video_ready', progress=100, download_path=?, error=NULL, updated_at=?
          WHERE id=? AND task_role='concat' AND status='concat_running'`).bind(body.path, new Date().toISOString(), body.id),
        db.prepare(`UPDATE tasks SET review_status='merged' WHERE merged_into_task_id=? AND review_status='merging'
          AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND task_role='concat' AND status='video_ready')`).bind(body.id, body.id),
      ]);
      return finished.meta.changes ? Response.json({ ok: true }) : Response.json({ error: '拼接任务已取消或已完成' }, { status: 409 });
    }
    if (body.action === 'concat-cancel') {
      const db = getDb();
      await db.batch([
        db.prepare(`UPDATE tasks SET review_status='pending', merged_into_task_id=NULL WHERE merged_into_task_id=? AND review_status='merging'
          AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND task_role='concat' AND status='concat_running')`).bind(body.id, body.id),
        db.prepare(`DELETE FROM tasks WHERE id=? AND task_role='concat' AND status='concat_running'`).bind(body.id),
      ]);
      return Response.json({ ok: true });
    }
    if (body.action === 'delete-merged') {
      // Only after the concatenated video was approved; its clips are consumed.
      const db = getDb();
      await db.batch([
        db.prepare(`DELETE FROM schedules WHERE task_id IN (SELECT id FROM tasks WHERE id=? AND review_status='merged'
          AND merged_into_task_id IN (SELECT id FROM tasks WHERE task_role='concat' AND review_status='approved'))`).bind(body.id),
        db.prepare(`DELETE FROM tasks WHERE id=? AND review_status='merged'
          AND merged_into_task_id IN (SELECT id FROM tasks WHERE task_role='concat' AND review_status='approved')`).bind(body.id),
      ]);
      const remaining = await db.prepare('SELECT id FROM tasks WHERE id=?').bind(body.id).first();
      return remaining ? Response.json({ error: '片段状态已改变，未删除' }, { status: 409 }) : Response.json({ ok: true });
    }
    if (body.action === 'reserve-delete') {
      const result = await getDb().prepare(`UPDATE tasks SET review_status='deleting' WHERE id=?
        AND review_status IN ('pending','deleting') AND status IN ('video_ready','scheduled') AND download_path IS NOT NULL`).bind(body.id).run();
      return result.meta.changes ? Response.json({ok:true}) : Response.json({error:'任务已放行、重做或状态已改变，未删除'}, {status:409});
    }
    if (body.action === 'delete-pending') {
      const db = getDb();
      await db.batch([
        // Deleting a concatenated video returns its clips to review.
        db.prepare(`UPDATE tasks SET review_status='pending', merged_into_task_id=NULL WHERE merged_into_task_id=? AND review_status='merged'
          AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND review_status='deleting')`).bind(body.id, body.id),
        db.prepare("DELETE FROM schedules WHERE task_id IN (SELECT id FROM tasks WHERE id=? AND review_status='deleting')").bind(body.id),
        db.prepare("DELETE FROM tasks WHERE id=? AND review_status='deleting'").bind(body.id),
        db.prepare(ORPHAN_GROUP_DELETE),
      ]);
      const remaining = await db.prepare('SELECT id FROM tasks WHERE id=?').bind(body.id).first();
      return remaining ? Response.json({error:'任务状态已改变，未删除'}, {status:409}) : Response.json({ok:true});
    }
    if (body.action === 'relocate') {
      if (!body.path || !body.oldPath) return Response.json({error:'缺少移动路径'}, {status:400});
      const result = await getDb().prepare(`UPDATE tasks SET approved_path=? WHERE id=? AND review_status='approved' AND approved_path IN (?,?)`)
        .bind(body.path,body.id,body.oldPath,body.path).run();
      return result.meta.changes ? Response.json({ok:true}) : Response.json({error:'审核路径已变化，未修改'}, {status:409});
    }
    if (body.action === 'discard') {
      const db = getDb();
      const replacement = await db.prepare('SELECT id FROM tasks WHERE id=? AND regenerated_from_task_id=?').bind(body.replacementId || '',body.id).first();
      if (!replacement) return Response.json({error:'重做任务不存在'}, {status:409});
      await db.batch([
        db.prepare("DELETE FROM schedules WHERE task_id IN (SELECT id FROM tasks WHERE id=? AND review_status='replaced')").bind(body.id),
        db.prepare("DELETE FROM tasks WHERE id=? AND review_status='replaced'").bind(body.id),
        db.prepare(ORPHAN_GROUP_DELETE),
      ]);
      return Response.json({ok:true});
    }
    if (body.action === 'reserve' || body.action === 'cancel') {
      const reserve = body.action === 'reserve';
      const result = await getDb().prepare(`UPDATE tasks SET review_status=? WHERE id=?
        AND review_status IN (${reserve ? "'pending','approving'" : "'approving'"})
        AND status IN ('video_ready','scheduled') AND download_path IS NOT NULL`)
        .bind(reserve ? 'approving' : 'pending',body.id).run();
      return result.meta.changes ? Response.json({ok:true}) : Response.json({error:'任务已重做或审核状态已改变，请刷新'}, {status:409});
    }
    if (!body.path) return Response.json({error:'缺少放行路径'}, {status:400});
    const db = getDb();
    const previous = await db.prepare('SELECT reviewed_at FROM tasks WHERE id=?').bind(body.id).first<{reviewed_at:string|null}>();
    const approvedAt = previous?.reviewed_at || body.approvedAt || new Date().toISOString();
    let day: string;
    try { day = approvalDay(approvedAt, body.timeZone || 'UTC'); }
    catch { return Response.json({error:'审核时间或时区无效'}, {status:400}); }
    const [result] = await db.batch([
      db.prepare(`UPDATE tasks SET review_status='approved', reviewed_at=COALESCE(reviewed_at,?), approved_path=?
        WHERE id=? AND review_status IN ('approving','approved') AND status IN ('video_ready','scheduled') AND download_path IS NOT NULL`).bind(approvedAt, body.path, body.id),
      db.prepare(APPROVAL_COUNT_INSERT).bind(day,body.id),
    ]);
    if (!result.meta.changes) return Response.json({ error: "任务尚未下载完成或已删除" }, { status: 409 });
    return Response.json({ ok: true });
  } catch (error) { return jsonError(error); }
}

type ConcatSource = { id: string; download_path: string; batch_index: number | null; batch_round: number | null };

// Reserve the selected clips of one group for a local concatenation. The new
// task and the clip reservations are written in one batch; a repeated request
// with the same concatId returns the same reservation.
async function reserveConcat(body: { id: string; concatId?: string; sourceIds?: string[] }) {
  const groupId = body.id, concatId = String(body.concatId || '');
  const ids = Array.isArray(body.sourceIds) ? body.sourceIds.map(String) : [];
  if (!TASK_ID.test(groupId) || !TASK_ID.test(concatId) || ids.some(id => !TASK_ID.test(id))) return Response.json({ error: '拼接参数无效' }, { status: 400 });
  if (ids.length < 2 || ids.length > MAX_CONCAT_CLIPS || new Set(ids).size !== ids.length) {
    return Response.json({ error: `请选择 2–${MAX_CONCAT_CLIPS} 条不同的视频进行拼接` }, { status: 400 });
  }
  const db = getDb();
  const sourcesOf = async () => (await db.prepare(`SELECT id, download_path, batch_index, batch_round FROM tasks
    WHERE merged_into_task_id=? AND review_status='merging' ORDER BY batch_round ASC, batch_index ASC, created_at ASC`).bind(concatId).all<ConcatSource>()).results;
  const existing = await db.prepare('SELECT status, batch_parent_id FROM tasks WHERE id=?').bind(concatId).first<{ status: string; batch_parent_id: string }>();
  if (existing) {
    const sources = await sourcesOf();
    return existing.status === 'concat_running' && existing.batch_parent_id === groupId && sources.length === ids.length
      ? Response.json({ ok: true, sources }) : Response.json({ error: '拼接请求标识冲突，请重新打开任务' }, { status: 409 });
  }
  const marks = ids.map(() => '?').join(',');
  const eligible = `(SELECT COUNT(*) FROM tasks WHERE id IN (${marks}) AND batch_parent_id=? AND task_role='clip'
    AND review_status='pending' AND status IN ('video_ready','scheduled') AND download_path IS NOT NULL)`;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO tasks (id, product_id, gem_id, title, status, prompt, provider, progress, duration, region, shooting_style,
        callback_token, auto_queue, gemini_account_id, tiktok_account_name, archive_directory, gem_content_snapshot,
        product_external_id_snapshot, gemini_request_text, image_keys_snapshot, review_status, task_role, batch_parent_id,
        batch_size, concat_source_ids, created_at, updated_at)
      SELECT ?, product_id, gem_id, title || ' · 拼接成片', 'concat_running', '', 'local-concat', 60,
        (SELECT COALESCE(SUM(duration), 0) FROM tasks WHERE id IN (${marks})), region, shooting_style,
        ?, 0, NULL, tiktok_account_name, archive_directory, gem_content_snapshot,
        product_external_id_snapshot, gemini_request_text, image_keys_snapshot, 'pending', 'concat', id, ?, ?, ?, ?
      FROM tasks WHERE id=? AND task_role='group' AND ${eligible} = ?`).bind(
      concatId, ...ids, crypto.randomUUID(), ids.length, JSON.stringify(ids), now, now, groupId, ...ids, groupId, ids.length),
    db.prepare(`UPDATE tasks SET review_status='merging', merged_into_task_id=? WHERE id IN (${marks}) AND review_status='pending'
      AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND status='concat_running')`).bind(concatId, ...ids, concatId),
  ]);
  const sources = await sourcesOf();
  if (sources.length !== ids.length) {
    return Response.json({ error: '所选片段中有的已放行、已删除、尚未下载或正在处理，没有拼接；请刷新后重新选择' }, { status: 409 });
  }
  return Response.json({ ok: true, sources });
}
