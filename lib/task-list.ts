export type TaskCounts = { total: number; active: number; review: number; completed: number; attention: number };
type TaskRow = Record<string, unknown> & { id: string; created_at: string };
type TaskQuery = { status?: string; q?: string; cursor?: string; limit?: number };
type TaskDatabase = Pick<D1Database, 'prepare'>;

const groups: Record<string, string> = {
  all: '1 = 1',
  active: "t.status NOT IN ('video_ready','scheduled','failed','seedance_blocked')",
  review: "t.status IN ('video_ready','scheduled') AND COALESCE(t.review_status,'') NOT IN ('approved','replaced')",
  completed: "t.status IN ('video_ready','scheduled') AND t.review_status IN ('approved','replaced')",
  attention: "t.status IN ('failed','seedance_blocked')",
};
const aliases: Record<string, string> = { '全部': 'all', '处理中': 'active', '进行中': 'active', '待检查': 'review', '已完成': 'completed', '需处理': 'attention' };
const joins = 'FROM tasks t LEFT JOIN products p ON p.id=t.product_id LEFT JOIN gems g ON g.id=t.gem_id';
const displayColumns = `p.name AS product_name, COALESCE(t.product_external_id_snapshot,p.external_id) AS product_external_id, g.name AS gem_name,
  COALESCE(json_extract(t.image_keys_snapshot,'$[0]'),(SELECT pi.object_key FROM product_images pi WHERE pi.product_id=t.product_id ORDER BY pi.sort_order ASC,pi.id ASC LIMIT 1),p.image_key) AS product_image_key,
  COALESCE(json_array_length(t.image_keys_snapshot),(SELECT COUNT(*) FROM product_images pi WHERE pi.product_id=t.product_id)) AS image_count`;
const listColumns = `t.id,t.product_id,t.gem_id,t.title,t.status,t.progress,t.provider,t.duration,t.region,t.shooting_style,
  t.provider_job_id,t.provider_status_url,t.output_url,t.error,t.gemini_account_id,t.tiktok_account_name,t.archive_directory,
  t.download_path,t.review_status,t.approved_path,t.segment_progress,t.download_error,t.created_at,t.updated_at,
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

export async function listTasks(db: TaskDatabase, query: TaskQuery = {}) {
  const status = aliases[query.status || 'all'] || query.status || 'all';
  if (!Object.hasOwn(groups, status)) throw new Error('未知的任务筛选状态');
  const requestedLimit = query.limit ?? 50;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new Error('分页条数必须是正整数');
  const limit = Math.min(200, requestedLimit);
  const where = [`(${groups[status]})`];
  const args: (string | number)[] = [];
  if (query.q?.trim()) {
    where.push("instr(lower(COALESCE(NULLIF(p.name,''),t.title,'') || ' ' || COALESCE(t.product_external_id_snapshot,p.external_id,'') || ' ' || COALESCE(t.tiktok_account_name,'')),lower(?)) > 0");
    args.push(query.q.trim());
  }
  if (query.cursor) {
    const [createdAt, id] = decodeCursor(query.cursor);
    where.push('(t.created_at < ? OR (t.created_at = ? AND t.id < ?))'); args.push(createdAt, createdAt, id);
  }
  const rows = await db.prepare(`SELECT ${listColumns} ${joins} WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC,t.id DESC LIMIT ?`).bind(...args, limit + 1).all<TaskRow>();
  const tasks = rows.results.slice(0, limit);
  return { tasks, nextCursor: rows.results.length > limit ? encodeCursor(tasks.at(-1)!) : null };
}

export async function countTasks(db: TaskDatabase): Promise<TaskCounts> {
  const result = await db.prepare(`SELECT COUNT(*) AS total,
    COUNT(CASE WHEN ${groups.active} THEN 1 END) AS active,
    COUNT(CASE WHEN ${groups.review} THEN 1 END) AS review,
    COUNT(CASE WHEN ${groups.completed} THEN 1 END) AS completed,
    COUNT(CASE WHEN ${groups.attention} THEN 1 END) AS attention FROM tasks t`).first<TaskCounts>();
  return result || { total: 0, active: 0, review: 0, completed: 0, attention: 0 };
}

export function taskDetail(db: TaskDatabase, id: string) {
  return db.prepare(`SELECT t.*,${displayColumns} ${joins} WHERE t.id=?`).bind(id).first<TaskRow>();
}
