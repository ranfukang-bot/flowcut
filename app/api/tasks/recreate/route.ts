import { getProviderConfig } from "../../../../lib/provider-config";
import { ensureWorkspace, getDb, jsonError, runtimeEnv } from "../../../../lib/storage";

// A fresh task identity keeps old callbacks/downloads/publication records isolated.
export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const { id, requestId, gemId } = await request.json() as { id?: string; requestId?: string; gemId?: string };
    if (!id || !requestId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestId)) {
      return Response.json({ error: "缺少原任务 ID 或重做请求标识" }, { status: 400 });
    }
    const db = getDb();
    const prior = await db.prepare("SELECT id, status, regenerated_from_task_id FROM tasks WHERE id = ?")
      .bind(requestId).first<{ id: string; status: string; regenerated_from_task_id: string | null }>();
    if (prior) {
      if (prior.regenerated_from_task_id !== id) return Response.json({ error: "重做请求标识冲突，请重新打开任务" }, { status: 409 });
      return Response.json({ id: prior.id, status: prior.status, created: false });
    }
    const source = await db.prepare(`SELECT t.*, COALESCE(t.gem_content_snapshot, g.content) AS saved_content,
      COALESCE(t.product_external_id_snapshot, p.external_id) AS saved_product_id
      FROM tasks t LEFT JOIN gems g ON g.id = t.gem_id
      LEFT JOIN products p ON p.id = t.product_id WHERE t.id = ?`).bind(id).first<{
        id: string; status: string; product_id: string; gem_id: string; title: string;
        saved_content: string | null; saved_product_id: string | null;
        tiktok_account_name: string; archive_directory: string;
        duration: number; region: string; shooting_style: string;
        gemini_request_text: string | null;
        image_keys_snapshot: string | null; review_status: string;
      }>();
    if (!source) return Response.json({ error: "原任务不存在" }, { status: 404 });
    if (['approved','approving'].includes(source.review_status)) return Response.json({error:'成片已送入发布流程或正在放行，不能直接重做删除'}, {status:409});
    if (!["video_ready", "scheduled"].includes(source.status)) {
      return Response.json({ error: "请等原任务成片完成后再重新生成；进行中的任务不会被中断" }, { status: 409 });
    }
    const activeCopy = () => db.prepare(`SELECT id, status FROM tasks WHERE regenerated_from_task_id = ?
      AND status NOT IN ('video_ready', 'scheduled', 'failed') ORDER BY created_at DESC LIMIT 1`)
      .bind(id).first<{ id: string; status: string }>();
    const existing = await activeCopy();
    if (existing) return Response.json({ ...existing, created: false });
    if (source.review_status === 'replaced') {
      const replacement = await db.prepare('SELECT id,status FROM tasks WHERE regenerated_from_task_id=? ORDER BY created_at DESC LIMIT 1').bind(id).first();
      return replacement ? Response.json({...replacement,created:false}) : Response.json({error:'此任务已重做，但新任务记录已删除'}, {status:409});
    }
    const selectedGem = gemId ? await db.prepare('SELECT id,name,content FROM gems WHERE id=?').bind(gemId).first<{id:string;name:string;content:string}>() : null;
    if (gemId && !selectedGem) return Response.json({error:'选择的 Gem 已删除，请重新选择'}, {status:409});
    const gemContent = selectedGem ? selectedGem.content : source.saved_content;
    if (!gemContent?.trim()) return Response.json({ error: "Gem 设定已丢失，请选择可用的 Gem 重做" }, { status: 409 });
    const product = await db.prepare("SELECT id FROM products WHERE id = ?").bind(source.product_id).first();
    if (!product) return Response.json({ error: "商品资料已删除，无法重做" }, { status: 409 });
    const account = await db.prepare("SELECT id FROM tiktok_accounts WHERE lower(name) = lower(?)")
      .bind(source.tiktok_account_name).first();
    if (!account) return Response.json({ error: "原 TK 归档账号已删除或更名，请先恢复该账号配置" }, { status: 409 });
    const currentImages = await db.prepare("SELECT object_key FROM product_images WHERE product_id = ? ORDER BY sort_order ASC")
      .bind(source.product_id).all<{ object_key: string }>();
    const images = {results: source.image_keys_snapshot ? (JSON.parse(source.image_keys_snapshot) as string[]).map(object_key=>({object_key})) : currentImages.results};
    if (!images.results.length) return Response.json({ error: "商品图片已删除，请先补回图片再重做" }, { status: 409 });
    const media = runtimeEnv().MEDIA;
    if (!media || (await Promise.all(images.results.map(image => media.head(image.object_key)))).some(image => !image)) {
      return Response.json({ error: "商品图片文件缺失，请先补回图片再重做" }, { status: 409 });
    }
    const gemini = await getProviderConfig("gemini");
    if (gemini.config.mode !== "web" && !gemini.secretConfigured) {
      return Response.json({ error: "请先配置 Gemini，原任务未改动" }, { status: 409 });
    }
    const now = new Date().toISOString();
    // A single conditional INSERT prevents concurrent clicks/tabs creating two
    // active remakes. requestId also makes a lost HTTP reply safe to retry.
    const statements = await db.batch([db.prepare(`INSERT OR IGNORE INTO tasks
      (id, product_id, gem_id, title, status, prompt, provider, progress,
       duration, region, shooting_style, callback_token, auto_queue,
       gemini_account_id, tiktok_account_name, archive_directory,
       gem_content_snapshot, product_external_id_snapshot, gemini_request_text, image_keys_snapshot, regenerated_from_task_id, created_at, updated_at)
      SELECT ?, ?, ?, ?, 'prompt_queued', '', ?, 5, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status IN ('video_ready', 'scheduled') AND review_status='pending')
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE regenerated_from_task_id = ?
          AND status NOT IN ('video_ready', 'scheduled', 'failed'))`)
      .bind(requestId, source.product_id, selectedGem?.id || source.gem_id, selectedGem ? `图片识别商品 · ${selectedGem.name}` : source.title,
        gemini.config.mode === "web" ? "gemini-web" : "gemini-api",
        source.duration, source.region, source.shooting_style, crypto.randomUUID(),
        source.tiktok_account_name, source.archive_directory || "", gemContent,
        source.saved_product_id || "", source.gemini_request_text ?? null, JSON.stringify(images.results.map(image=>image.object_key)), id, now, now, id, id),
      db.prepare(`UPDATE tasks SET review_status='replaced' WHERE id=? AND review_status='pending'
        AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND regenerated_from_task_id=?)`).bind(id,requestId,id)]);
    const inserted = statements[0];
    const result = await db.prepare("SELECT id, status FROM tasks WHERE id = ? AND regenerated_from_task_id = ?")
      .bind(requestId, id).first<{ id: string; status: string }>() || await activeCopy();
    if (!result) return Response.json({ error: "原任务状态已变化，未创建新任务，请刷新后重试" }, { status: 409 });
    return Response.json({ ...result, created: Boolean(inserted.meta.changes) }, { status: inserted.meta.changes ? 201 : 200 });
  } catch (error) {
    return jsonError(error);
  }
}
