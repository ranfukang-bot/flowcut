export function approvalDay(timestamp: string, timeZone: string) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw Error('审核时间无效');
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const part = (name: string) => parts.find(p=>p.type===name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// Independent of the task list: clearing tasks must not erase production totals.
export const APPROVAL_COUNT_INSERT = `INSERT OR IGNORE INTO approval_counts (task_id,account_name,day_key,approved_at)
  SELECT id,COALESCE(NULLIF(tiktok_account_name,''),'未指定账号'),?,reviewed_at FROM tasks
  WHERE id=? AND review_status='approved' AND reviewed_at IS NOT NULL`;
