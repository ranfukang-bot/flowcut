import { createPromptFission, type PromptFissionInput } from '../../../lib/prompt-fission';
import { ensureWorkspace, getDb, runtimeEnv, jsonError } from '../../../lib/storage';
import { getProviderConfig } from '../../../lib/provider-config';
import { saveLibraryProduct } from '../../../lib/product-library';
import { TASK_REGIONS } from '../../../lib/task-config';
import { promptBatchRequest, type PromptItem } from '../../../lib/prompt-batches';
import { validateGemRequest } from '../../../lib/gem-request';

const conflict = (error: string) => Response.json({ error }, { status: 409 });

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    if ((await getProviderConfig('gemini')).config.mode !== 'web') return conflict('提示词生成需要 Gemini 网页模式，请先在账号与设置中切换');
    if (request.headers.get('content-type')?.includes('application/json')) return await createPromptFission(await request.json() as PromptFissionInput);
    const form = await request.formData();
    const files = form.getAll('images');
    if (!files.length || files.length > 12 || files.some(file => !(file instanceof File) || !file.size || !file.type.startsWith('image/'))) throw Error('请上传 1–12 张图片，只接受非空图片文件');
    const images = files as File[];
    if (images.some(file => file.size > 12 * 1024 * 1024) || images.reduce((sum, file) => sum + file.size, 0) > 48 * 1024 * 1024) throw Error('单张图片不能超过 12MB，总大小不能超过 48MB');
    const count = Number(form.get('count') ?? 5);
    if (!Number.isInteger(count) || count < 1 || count > 20) throw Error('条数必须是 1–20 的整数');
    const region = String(form.get('region') || '印尼');
    if (!TASK_REGIONS.includes(region)) throw Error('请选择有效地区');
    const description = String(form.get('description') ?? 'iPhone实拍质感').trim();
    if (!description || description.length > 1000 || /[\r\n]/.test(description)) throw Error('请填写一句描述（最多 1000 字）');
    const submittedText = form.get('geminiRequestText');
    // Multipart transport uses CRLF; match the textarea's LF without changing its text.
    const text = form.has('geminiRequestText') ? validateGemRequest(typeof submittedText === 'string' ? submittedText.replace(/\r\n?/g, '\n') : submittedText) : promptBatchRequest(region, description);
    const name = String(form.get('productName') || '').trim();
    const externalId = String(form.get('externalId') || '').trim();
    if (name.length > 200 || externalId.length > 200) throw Error('商品名称或 ID 过长');
    const db = getDb();
    const gem = await db.prepare('SELECT id,content FROM gems WHERE id=?').bind(String(form.get('gemId') || '')).first<{ id: string; content: string }>();
    if (!gem?.content.trim()) throw Error('请选择已有且内容非空的 Gem');
    const product = await saveLibraryProduct(db, runtimeEnv().MEDIA, { externalId, name, country: region, files: images });
    const id = crypto.randomUUID(), now = new Date().toISOString();
    // The entire N-item batch is committed together; a partial batch is never visible.
    await db.batch(Array.from({ length: count }, (_, i) => db.prepare(`INSERT INTO tasks
      (id,product_id,gem_id,title,status,provider,auto_queue,gemini_account_id,tiktok_account_name,archive_directory,
       gem_content_snapshot,gemini_request_text,region,duration,shooting_style,product_external_id_snapshot,image_keys_snapshot,
       task_role,prompt_batch_id,batch_index,batch_size,created_at,updated_at)
      VALUES (?,?,?,?,'prompt_queued','gemini-web',0,NULL,'','',?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(`${id}-${i + 1}`, product.id, gem.id, `${name || '图片识别商品'} · 第 ${i + 1}/${count} 条`,
        gem.content, text, region, 30, '', externalId, JSON.stringify(product.imageKeys), 'prompt_item', id, i + 1, count, now, now)));
    return Response.json({ id, count, productId: product.id, reused: product.reused }, { status: 201 });
  } catch (error) { return jsonError(error, 400); }
}

export async function GET(request: Request) {
  try {
    await ensureWorkspace();
    const db = getDb(), cursor = new URL(request.url).searchParams.get('cursor');
    const args: string[] = [];
    let gate = '';
    if (cursor) {
      let parsed: unknown;
      try { if (cursor.length > 1000) throw Error(); parsed = JSON.parse(atob(cursor)); } catch { throw Error('分页游标无效'); }
      if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || !Number.isFinite(Date.parse(parsed[0])) || typeof parsed[1] !== 'string' || parsed[1].length > 200) throw Error('分页游标无效');
      gate = 'HAVING MAX(created_at) < ? OR (MAX(created_at) = ? AND prompt_batch_id < ?)';
      args.push(parsed[0], parsed[0], parsed[1]);
    }
    const groups = await db.prepare(`SELECT prompt_batch_id AS id,MAX(created_at) AS created_at FROM tasks
      WHERE COALESCE(prompt_batch_id,'')<>'' GROUP BY prompt_batch_id ${gate} ORDER BY created_at DESC,prompt_batch_id DESC LIMIT 21`)
      .bind(...args).all<{ id: string; created_at: string }>();
    const selected = groups.results.slice(0, 20);
    // Only what the page shows: this list is polled every 5 s while items run,
    // and Gem snapshots and raw replies would multiply every response by megabytes.
    const rows = selected.length ? await db.prepare(`SELECT t.id,t.prompt_batch_id,t.title,t.status,t.prompt,t.error,t.batch_index,t.batch_size,t.prompt_copied_at,
      t.image_keys_snapshot,t.product_external_id_snapshot,t.created_at,
      CASE WHEN t.task_role='prompt_item' THEN t.gemini_request_text ELSE '' END AS gemini_request_text,t.region,t.task_role,
      p.name AS product_name,g.name AS gem_name FROM tasks t
      LEFT JOIN products p ON p.id=t.product_id LEFT JOIN gems g ON g.id=t.gem_id
      WHERE t.prompt_batch_id IN (${selected.map(() => '?').join(',')}) ORDER BY t.batch_index`)
      .bind(...selected.map(row => row.id)).all<PromptItem & { prompt_batch_id: string }>() : { results: [] };
    const last = selected.at(-1);
    const active = await db.prepare(`SELECT t.id FROM tasks t WHERE COALESCE(t.prompt_batch_id,'')<>'' AND
      (t.status IN ('prompt_queued','prompt_generating','variant_queued','variant_generating') OR
       (t.status='fission_wait' AND EXISTS (SELECT 1 FROM tasks parent WHERE parent.id=t.batch_parent_id AND parent.status<>'failed'))) LIMIT 1`).first();
    return Response.json({ batches: selected.map(group => {
      const all = rows.results.filter(row => row.prompt_batch_id === group.id), mother = all.find(row => row.task_role === 'fission');
      return { ...group, kind: mother ? 'fission' : 'single', ...(mother ? { mother } : {}), items: all.filter(row => row.task_role !== 'fission') };
    }),
      nextCursor: groups.results.length > 20 && last ? btoa(JSON.stringify([last.created_at, last.id])) : null, hasActive: Boolean(active) }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return jsonError(error, 400); }
}

// Library selection, every task snapshot and legacy reference assets all own
// their media independently. Deleting one batch must not break any of them.
async function cleanupImages(keys: string[]) {
  const db = getDb(), bucket = runtimeEnv().MEDIA;
  for (const key of new Set(keys)) {
    const used = await db.prepare(`SELECT 1 FROM product_images WHERE object_key=? UNION ALL
      SELECT 1 FROM products WHERE image_key=? UNION ALL
      SELECT 1 FROM tasks WHERE EXISTS (SELECT 1 FROM json_each(tasks.image_keys_snapshot) WHERE value=?) UNION ALL
      SELECT 1 FROM reference_remix_assets WHERE object_key=? LIMIT 1`).bind(key, key, key, key).first();
    if (!used) await bucket?.delete(key);
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureWorkspace();
    const { id, action } = await request.json() as { id: string; action: string };
    if (!id || !['retry', 'copied', 'delete-item', 'delete-batch'].includes(action)) throw Error('操作参数无效');
    const db = getDb(), now = new Date().toISOString();
    if (action === 'retry') {
      const result = await db.prepare(`UPDATE tasks SET status=CASE WHEN task_role='fission_child' THEN
          CASE WHEN EXISTS (SELECT 1 FROM tasks parent WHERE parent.id=tasks.batch_parent_id AND parent.status='fission_ready' AND length(trim(parent.prompt))>=300) THEN 'variant_queued' ELSE 'fission_wait' END
          ELSE 'prompt_queued' END,progress=0,prompt='',gemini_raw_reply=NULL,prompt_copied_at=NULL,
        error=NULL,bridge_claimed_at=NULL,bridge_worker_id=NULL,gemini_account_id=NULL,gemini_failures=0,gemini_retry_at=NULL,updated_at=?
        WHERE id=? AND COALESCE(prompt_batch_id,'')<>'' AND status='failed'`).bind(now, id).run();
      return result.meta.changes ? Response.json({ ok: true }) : conflict('只能重试失败的提示词');
    }
    if (action === 'copied') {
      const result = await db.prepare("UPDATE tasks SET prompt_copied_at=?,updated_at=? WHERE id=? AND COALESCE(prompt_batch_id,'')<>'' AND length(trim(prompt))>0").bind(now, now, id).run();
      return result.meta.changes ? Response.json({ ok: true, copiedAt: now }) : conflict('没有可复制的提示词');
    }
    const batch = action === 'delete-batch';
    const predicate = batch ? 'prompt_batch_id=?' : 'id=?';
    const rows = await db.prepare(`SELECT status,task_role,image_keys_snapshot FROM tasks WHERE COALESCE(prompt_batch_id,'')<>'' AND ${predicate}`).bind(id).all<{ status: string; task_role: string; image_keys_snapshot: string | null }>();
    if (!batch && rows.results.some(row => row.task_role !== 'prompt_item')) return conflict('裂变商品不能单独删除，请删除整批');
    if (rows.results.some(row => ['prompt_generating','variant_generating'].includes(row.status))) return conflict('Gemini 正在生成，请等本批生成结束再删除');
    // Repeat the generation check in the DELETE itself to close a claim/delete race.
    const result = await db.prepare(`DELETE FROM tasks WHERE COALESCE(prompt_batch_id,'')<>'' AND ${predicate}
      AND NOT EXISTS (SELECT 1 FROM tasks active WHERE COALESCE(active.prompt_batch_id,'')<>'' AND active.${predicate} AND active.status IN ('prompt_generating','variant_generating'))`).bind(id, id).run();
    if (rows.results.length && !result.meta.changes) return conflict('条目状态已变化，请刷新后重试删除');
    await cleanupImages(rows.results.flatMap(row => JSON.parse(row.image_keys_snapshot || '[]') as string[]));
    return Response.json({ ok: true, deleted: result.meta.changes });
  } catch (error) { return jsonError(error, 400); }
}
