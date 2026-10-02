import { ensureWorkspace, getDb, jsonError } from "../../../../lib/storage";
import { approvalDay, APPROVAL_COUNT_INSERT } from "../../../../lib/approval-stats";

export async function GET(request: Request) {
  try {
    await ensureWorkspace();
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
    const body = await request.json() as { id: string; path: string; confirmed: boolean; action?: string; replacementId?: string; approvedAt?: string; timeZone?: string };
    if (body.confirmed !== true || !body.id) return Response.json({ error: "请确认审核通过" }, { status: 400 });
    if (body.action === 'discard') {
      const db = getDb();
      const replacement = await db.prepare('SELECT id FROM tasks WHERE id=? AND regenerated_from_task_id=?').bind(body.replacementId || '',body.id).first();
      if (!replacement) return Response.json({error:'重做任务不存在'}, {status:409});
      await db.batch([
        db.prepare("DELETE FROM schedules WHERE task_id IN (SELECT id FROM tasks WHERE id=? AND review_status='replaced')").bind(body.id),
        db.prepare("DELETE FROM tasks WHERE id=? AND review_status='replaced'").bind(body.id),
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
