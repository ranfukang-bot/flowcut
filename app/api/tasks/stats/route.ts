import { ensureWorkspace, getDb, jsonError } from '../../../../lib/storage';
import { approvalDay, APPROVAL_COUNT_INSERT } from '../../../../lib/approval-stats';

export async function GET(request: Request) {
  try {
    await ensureWorkspace();
    const query = new URL(request.url).searchParams;
    const day = query.get('day') || '';
    const timeZone = query.get('timeZone') || 'UTC';
    try { approvalDay(new Date().toISOString(),timeZone); }
    catch { return Response.json({error:'时区无效'},{status:400}); }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day+'T00:00:00Z')) || new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day) {
      return Response.json({error:'统计日期无效'}, {status:400});
    }
    const db=getDb();
    // Restore already-approved records from earlier versions, never pending videos.
    const missing=await db.prepare(`SELECT id,reviewed_at FROM tasks WHERE review_status='approved' AND reviewed_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM approval_counts WHERE task_id=tasks.id)`).all<{id:string;reviewed_at:string}>();
    for(let i=0;i<missing.results.length;i+=50) {
      const rows=missing.results.slice(i,i+50).filter(row=>Number.isFinite(Date.parse(row.reviewed_at)));
      if(rows.length) await db.batch(rows.map(row=>db.prepare(APPROVAL_COUNT_INSERT).bind(approvalDay(row.reviewed_at,timeZone),row.id)));
    }
    const rows=await db.prepare(`SELECT account_name,SUM(count) AS count FROM (
      SELECT account_name,COUNT(*) AS count FROM approval_counts WHERE day_key=? GROUP BY account_name
      UNION ALL SELECT name AS account_name,0 AS count FROM tiktok_accounts
    ) GROUP BY account_name ORDER BY account_name`).bind(day).all<{account_name:string;count:number}>();
    return Response.json({day,total:rows.results.reduce((sum,row)=>sum+Number(row.count),0),accounts:rows.results});
  } catch(error) { return jsonError(error); }
}
