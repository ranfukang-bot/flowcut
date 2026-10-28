import { APPROVED_REVIEW_STATUSES, CONCAT_REVIEW_STATUSES, GROUP_DONE_STATUSES, GROUP_ROLES, VIDEO_DONE_STATUSES, VIDEO_FAILED_STATUSES, sqlList } from './task-statuses.ts';
export type TaskCounts = { total: number; active: number; review: number; completed: number; attention: number };
type TaskRow = Record<string, unknown> & { id: string; created_at: string };
type TaskQuery = { status?: string; q?: string; cursor?: string; limit?: number };
type TaskDatabase = Pick<D1Database, 'prepare'>;

// Status filters, written for any table alias so the same rule can be applied
// to a group's clips. A split group is a container, never a video by itself;
// clips merged into a concatenated video are not waiting for review.
const FILTERS = ['all', 'active', 'review', 'completed', 'attention'] as const;
type Filter = (typeof FILTERS)[number];
function condition(filter: Filter, a: string) {
  switch (filter) {
    case 'active': return `${a}.status NOT IN (${sqlList([...VIDEO_DONE_STATUSES, ...VIDEO_FAILED_STATUSES, ...GROUP_DONE_STATUSES])})`;
    case 'review': return `${a}.status IN (${sqlList(VIDEO_DONE_STATUSES)}) AND COALESCE(${a}.review_status,'') NOT IN (${sqlList([...APPROVED_REVIEW_STATUSES, ...CONCAT_REVIEW_STATUSES])})`;
    case 'completed': return `${a}.status IN (${sqlList(VIDEO_DONE_STATUSES)}) AND ${a}.review_status IN (${sqlList(APPROVED_REVIEW_STATUSES)})`;
    case 'attention': return `${a}.status IN (${sqlList(VIDEO_FAILED_STATUSES)})`;
    default: return '1 = 1';
  }
}
const aliases: Record<string, string> = { '全部': 'all', '处理中': 'active', '进行中': 'active', '待检查': 'review', '已完成': 'completed', '需处理': 'attention' };
const joins = 'FROM tasks t LEFT JOIN products p ON p.id=t.product_id LEFT JOIN gems g ON g.id=t.gem_id';
const displayColumns = `p.name AS product_name, COALESCE(t.product_external_id_snapshot,p.external_id) AS product_external_id, g.name AS gem_name,
  COALESCE(json_extract(t.image_keys_snapshot,'$[0]'),(SELECT pi.object_key FROM product_images pi WHERE pi.product_id=t.product_id ORDER BY pi.sort_order ASC,pi.id ASC LIMIT 1),p.image_key) AS product_image_key,
  COALESCE(json_array_length(t.image_keys_snapshot),(SELECT COUNT(*) FROM product_images pi WHERE pi.product_id=t.product_id)) AS image_count`;
const listColumns = `t.id,t.product_id,t.gem_id,t.title,t.status,t.progress,t.provider,t.duration,t.region,t.shooting_style,
  t.provider_job_id,t.provider_status_url,t.output_url,t.error,t.gemini_account_id,t.tiktok_account_name,t.archive_directory,
  t.download_path,t.review_status,t.approved_path,t.segment_progress,t.download_error,t.created_at,t.updated_at,
  t.task_role,t.batch_parent_id,t.batch_index,t.batch_round,t.batch_size,t.merged_into_task_id,t.prompt_note,
  t.segment_checked_at,t.remix_segment_start,t.remix_segment_end,t.remix_video_seconds,t.remix_selected_json,
  t.variant_gem_snapshot IS NOT NULL AS variant_mode,
  length(trim(COALESCE(t.prompt,''))) > 0 AS has_prompt,${displayColumns}`;

function encodeCursor(row: TaskRow) {
  return btoa(JSON.stringify([row.created_at, row.id])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeCursor(value: string): [string, string] {
  try {
    if (value.length > 1024 || !/^[\w-]+$/.test(value)) throw Error();
    const plain = value.replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(atob(plain.padEnd(Math.ceil(plain.length / 4) * 4, '=')));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string' || !parsed[1] || parsed[1].length > 200 || !Number.isFinite(Date.parse(parsed[0]))) throw Error();
    return parsed as [string, string];
  } catch { throw new Error('分页游标无效，请重新加载任务'); }
}

// Clips belong to their group: the list shows top-level rows only and each
// group carries its clips (and concatenated videos) in batch order.
async function attachChildren(db: TaskDatabase, rows: TaskRow[]) {
  const groupIds = rows.filter(row => GROUP_ROLES.includes(String(row.task_role))).map(row => row.id);
  if (!groupIds.length) return rows;
  const children = await db.prepare(`SELECT ${listColumns} ${joins} WHERE COALESCE(t.prompt_batch_id,'')='' AND t.batch_parent_id IN (${groupIds.map(() => '?').join(',')})
    ORDER BY CASE WHEN t.task_role='concat' THEN 1 ELSE 0 END, t.batch_round ASC, t.batch_index ASC, t.created_at ASC, t.id ASC`)
    .bind(...groupIds).all<TaskRow>();
  const byGroup = new Map<string, TaskRow[]>();
  for (const child of children.results) {
    const key = String(child.batch_parent_id);
    byGroup.set(key, [...(byGroup.get(key) || []), child]);
  }
  return rows.map(row => GROUP_ROLES.includes(String(row.task_role)) ? { ...row, children: byGroup.get(row.id) || [] } : row);
}

export async function listTasks(db: TaskDatabase, query: TaskQuery = {}) {
  const status = aliases[query.status || 'all'] || query.status || 'all';
  if (!(FILTERS as readonly string[]).includes(status)) throw new Error('未知的任务筛选状态');
  const filter = status as Filter;
  const requestedLimit = query.limit ?? 50;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new Error('分页条数必须是正整数');
  const limit = Math.min(200, requestedLimit);
  const where = ["COALESCE(t.prompt_batch_id,'') = ''", 't.batch_parent_id IS NULL', filter === 'all' ? '1 = 1'
    : `((${condition(filter, 't')}) OR (t.task_role IN ('group','fission','remix') AND EXISTS (SELECT 1 FROM tasks c WHERE COALESCE(c.prompt_batch_id,'')='' AND c.batch_parent_id = t.id AND ${condition(filter, 'c')})))`];
  const args: (string | number)[] = [];
  if (query.q?.trim()) {
    where.push("(instr(lower(COALESCE(NULLIF(p.name,''),t.title,'') || ' ' || COALESCE(t.product_external_id_snapshot,p.external_id,'') || ' ' || COALESCE(t.tiktok_account_name,'')),lower(?)) > 0 OR (t.task_role='fission' AND EXISTS (SELECT 1 FROM tasks c LEFT JOIN products cp ON cp.id=c.product_id WHERE COALESCE(c.prompt_batch_id,'')='' AND c.batch_parent_id=t.id AND instr(lower(COALESCE(cp.name,'') || ' ' || COALESCE(c.product_external_id_snapshot,'')),lower(?))>0)))");
    args.push(query.q.trim(),query.q.trim());
  }
  if (query.cursor) {
    const [createdAt, id] = decodeCursor(query.cursor);
    where.push('(t.created_at < ? OR (t.created_at = ? AND t.id < ?))'); args.push(createdAt, createdAt, id);
  }
  const rows = await db.prepare(`SELECT ${listColumns} ${joins} WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC,t.id DESC LIMIT ?`).bind(...args, limit + 1).all<TaskRow>();
  const tasks = rows.results.slice(0, limit);
  return { tasks: await attachChildren(db, tasks), nextCursor: rows.results.length > limit ? encodeCursor(tasks.at(-1)!) : null };
}

export async function countTasks(db: TaskDatabase): Promise<TaskCounts> {
  const result = await db.prepare(`SELECT
    COUNT(CASE WHEN NOT (COALESCE(t.task_role,'') = 'group' AND t.status = 'split_done') THEN 1 END) AS total,
    COUNT(CASE WHEN ${condition('active', 't')} THEN 1 END) AS active,
    COUNT(CASE WHEN ${condition('review', 't')} THEN 1 END) AS review,
    COUNT(CASE WHEN ${condition('completed', 't')} THEN 1 END) AS completed,
    COUNT(CASE WHEN ${condition('attention', 't')} THEN 1 END) AS attention FROM tasks t WHERE COALESCE(t.task_role,'') <> 'fission' AND COALESCE(t.prompt_batch_id,'') = ''`).first<TaskCounts>();
  return result || { total: 0, active: 0, review: 0, completed: 0, attention: 0 };
}

export async function taskDetail(db: TaskDatabase, id: string) {
  const task = await db.prepare(`SELECT t.*,t.variant_gem_snapshot IS NOT NULL AS variant_mode,${displayColumns} ${joins} WHERE t.id=? AND COALESCE(t.prompt_batch_id,'') = ''`).bind(id).first<TaskRow>();
  return task ? (await attachChildren(db, [task]))[0] : null;
}
