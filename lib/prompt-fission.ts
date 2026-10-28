import { getDb, runtimeEnv } from './storage';
import { TASK_REGIONS } from './task-config';
import { validateGemRequest } from './gem-request';
import { validateVariantRequest } from './prompt-blocks';

export type PromptFissionInput = {
  mode: 'fission'; requestId: string;
  products: Array<{ productId: string; imageKeys: string[] }>;
  motherSource: 'generate' | 'paste'; motherProductId: string;
  motherGemId?: string; motherPrompt?: string; variantGemId: string;
  region: string; firstText?: string; secondText: string;
};

// This shares the existing fission rows and ready barrier, but never a video queue.
export async function createPromptFission(body: PromptFissionInput) {
  if (body.mode !== 'fission' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(body.requestId || '')) throw Error('批次请求标识无效');
  const db = getDb(), id = body.requestId;
  const existing = await db.prepare('SELECT prompt_batch_id,task_role FROM tasks WHERE id=?').bind(id).first<{ prompt_batch_id: string; task_role: string }>();
  if (existing) return existing.prompt_batch_id === id && existing.task_role === 'fission'
    ? Response.json({ id, created: false }) : Response.json({ error: '请求标识冲突' }, { status: 409 });
  if (!Array.isArray(body.products) || body.products.length < 2 || body.products.length > 10) throw Error('请选择 2–10 个商品');
  if (body.products.some(p => !p || typeof p.productId !== 'string' || !p.productId.trim()) || new Set(body.products.map(p => p.productId)).size !== body.products.length) throw Error('同一批商品不能重复或为空');
  if (!['generate', 'paste'].includes(body.motherSource)) throw Error('请选择母版来源');
  if (!TASK_REGIONS.includes(body.region)) throw Error('请选择有效地区');
  const pasted = body.motherSource === 'paste';
  const firstText = pasted && body.firstText === undefined ? '' : validateGemRequest(body.firstText);
  const secondText = validateVariantRequest(body.secondText);
  const motherPrompt = typeof body.motherPrompt === 'string' ? body.motherPrompt : '';
  if (pasted && (motherPrompt.trim().length < 300 || motherPrompt.length > 60000)) throw Error('粘贴的母版提示词须为 300–60000 字');
  const gem = async (gemId?: string) => db.prepare('SELECT id,content FROM gems WHERE id=?').bind(gemId || '').first<{ id: string; content: string }>();
  const variant = await gem(body.variantGemId), mother = pasted ? variant : await gem(body.motherGemId);
  if (!variant?.content?.trim() || !mother?.content?.trim()) throw Error('请选择已有且内容非空的母版 Gem 和变体 Gem');
  const products = [];
  for (const row of body.products) {
    const product = await db.prepare('SELECT id,name,external_id FROM products WHERE id=?').bind(row.productId).first<{ id: string; name: string; external_id: string }>();
    if (!product?.external_id?.trim()) throw Error('每个商品都必须有商品 ID');
    const keys = row.imageKeys, bucket = runtimeEnv().MEDIA;
    if (!Array.isArray(keys) || !keys.length || keys.length > 12 || keys.some(key => typeof key !== 'string' || !key.startsWith(`products/${product.id}/`) || key.includes('..')) || !bucket || (await Promise.all(keys.map(key => bucket.head(key)))).some(image => !image)) throw Error('商品图片无效或缺失，请重新上传');
    products.push({ ...product, keys });
  }
  if (new Set(products.map(p => p.external_id.trim().toLowerCase())).size !== products.length) throw Error('同一批商品 ID 不能重复');
  const master = products.find(p => p.id === body.motherProductId);
  if (!master) throw Error('母版商品必须在本批商品中');
  const at = new Date().toISOString();
  const statement = (row: typeof master, child: boolean, index: number) => db.prepare(`INSERT INTO tasks
    (id,product_id,gem_id,title,status,prompt,provider,progress,duration,region,shooting_style,auto_queue,tiktok_account_name,archive_directory,
     callback_token,gem_content_snapshot,product_external_id_snapshot,image_keys_snapshot,gemini_request_text,
     task_role,batch_parent_id,batch_index,batch_size,variant_gem_id,variant_gem_snapshot,variant_request_text,prompt_batch_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'gemini-web',?,30,?,'',0,'','',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    child ? `${id}-p${index}` : id, row.id, child ? variant.id : mother.id,
    child ? (row.name || row.external_id) : `多品裂变 · ${products.length} 个商品`,
    child ? (pasted ? 'variant_queued' : 'fission_wait') : (pasted ? 'fission_ready' : 'prompt_queued'), child ? '' : (pasted ? motherPrompt : ''),
    child ? (pasted ? 36 : 0) : (pasted ? 100 : 5), body.region, crypto.randomUUID(), child ? variant.content : mother.content,
    row.external_id.trim(), JSON.stringify(row.keys), firstText, child ? 'fission_child' : 'fission', child ? id : null,
    child ? index : 0, products.length, variant.id, variant.content, secondText, id, at, at);
  // Ignore concurrent delivery of the same UUID without hiding unrelated insert failures.
  try { await db.batch([statement(master, false, 0), ...products.map((p, i) => statement(p, true, i + 1))]); }
  catch (error) {
    const won = await db.prepare("SELECT id FROM tasks WHERE id=? AND prompt_batch_id=? AND task_role='fission'").bind(id, id).first();
    if (!won) throw error;
    return Response.json({ id, created: false });
  }
  return Response.json({ id, created: true }, { status: 201 });
}
