import { remixAction } from '../../../lib/remix-tasks';
import { generatePrompt } from "../../../lib/gemini";
import { DEFAULT_GEM_REQUEST, buildGemRequest, validateGemRequest } from "../../../lib/gem-request";
import { getProviderConfig } from "../../../lib/provider-config";
import { checkSeedance, submitSeedance } from "../../../lib/seedance";
import { ensureWorkspace, getDb, jsonError, runtimeEnv } from "../../../lib/storage";
import {
  normalizeShootingStyle,
  normalizeTaskDuration,
  normalizeTaskRegion,
} from "../../../lib/task-config";
import { validateTikTokAccountName } from "../../../lib/tiktok-accounts";
import { listTasks, taskDetail } from '../../../lib/task-list';
import { validateVariantRequest } from "../../../lib/prompt-blocks";
import { ORPHAN_GROUP_DELETE } from "../../../lib/task-batches";
import { PROMPT_ONLY_STATUSES, VIDEO_DONE_STATUSES } from '../../../lib/task-statuses';

export async function GET(request: Request) {
  try {
    await ensureWorkspace();
    const params = new URL(request.url).searchParams;
    if (params.has('id')) {
      const id = params.get('id')?.trim();
      if (!id) return Response.json({ error: '缺少任务 ID' }, { status: 400 });
      const task = await taskDetail(getDb(), id);
      return task ? Response.json(task, { headers: { 'cache-control': 'no-store' } }) : Response.json({ error: '任务不存在' }, { status: 404 });
    }
    const result = await listTasks(getDb(), { status: params.get('status') || 'all', q: params.get('q') || '', cursor: params.get('cursor') || '', limit: params.has('limit') ? Number(params.get('limit')) : undefined });
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return jsonError(error, error instanceof Error && /筛选状态|分页/.test(error.message) ? 400 : 500); }
}

async function taskImages(productId: string, requestUrl: string, snapshot?: string[]) {
  const images = snapshot ? {results:snapshot.map(object_key=>({object_key}))} : await getDb()
    .prepare(
      "SELECT object_key FROM product_images WHERE product_id = ? ORDER BY sort_order ASC"
    )
    .bind(productId)
    .all<{ object_key: string }>();
  return {
    keys: images.results.map((item: { object_key: string }) => item.object_key),
    urls: images.results.map((item: { object_key: string }) => {
      const url = new URL("/api/media", requestUrl);
      url.searchParams.set("key", item.object_key);
      return url.toString();
    }),
  };
}

function callbackUrl(requestUrl: string, token: string) {
  const url = new URL("/api/tasks/callback", requestUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

async function processQueuedTask(taskId: string, requestUrl: string) {
  const db = getDb();
  const pendingTask = await db
    .prepare("SELECT provider FROM tasks WHERE id = ?")
    .bind(taskId)
    .first<{ provider: string }>();
  if (!pendingTask) throw new Error("任务不存在");
  if (pendingTask.provider === "gemini-web") {
    return { accepted: false, awaitingExecutor: true };
  }
  const claimTime = new Date().toISOString();
  const claimed = await db
    .prepare(
      `UPDATE tasks SET status = 'prompt_generating', progress = 12,
       error = NULL, updated_at = ?
       WHERE id = ? AND status = 'prompt_queued'`
    )
    .bind(claimTime, taskId)
    .run();
  if (!claimed.meta.changes) return { accepted: false };

  const task = await db
    .prepare(
      `SELECT t.product_id, t.gem_id, t.callback_token, t.auto_queue, t.image_keys_snapshot,
              t.duration, t.region, t.shooting_style,
              p.name, p.features, COALESCE(t.gem_content_snapshot, g.content) AS content
       FROM tasks t
       JOIN products p ON p.id = t.product_id
       LEFT JOIN gems g ON g.id = t.gem_id
       WHERE t.id = ?`
    )
    .bind(taskId)
    .first<{
      product_id: string;
      image_keys_snapshot?: string | null;
      gem_id: string;
      callback_token?: string | null;
      auto_queue: number;
      name: string;
      features: string;
      content: string;
      duration: number;
      region: string;
      shooting_style: string;
    }>();
  if (!task) throw new Error("任务、商品或 Gem 已不存在");

  try {
    const images = await taskImages(task.product_id, requestUrl, task.image_keys_snapshot ? JSON.parse(task.image_keys_snapshot) : undefined);
    const result = await generatePrompt(task.content, task, images.keys);
    const now = new Date().toISOString();
    await db
      .prepare(
        `UPDATE tasks SET prompt = ?, provider = 'gemini-api',
         status = 'prompt_ready', progress = 32, error = NULL,
         provider_job_id = NULL, provider_status_url = NULL,
         output_url = NULL, updated_at = ? WHERE id = ?`
      )
      .bind(result.prompt, now, taskId)
      .run();

    if (!task.auto_queue) return { accepted: true, status: "prompt_ready" };

    const seedance = await getProviderConfig("seedance");
    if (seedance.config.mode === "local-api") {
      if (!seedance.secretConfigured) {
        await db
          .prepare(
            `UPDATE tasks SET status = 'seedance_blocked', progress = 40,
             error = ?, updated_at = ? WHERE id = ?`
          )
          .bind(
            "Seedance Bridge Key 尚未保存，请在接口设置中保存本机 API Key",
            new Date().toISOString(),
            taskId
          )
          .run();
        return { accepted: true, status: "seedance_blocked" };
      }
      await db
        .prepare(
          `UPDATE tasks SET provider = 'seedance-bridge',
           status = 'video_queued', progress = 48, error = NULL,
           bridge_claimed_at = NULL, bridge_worker_id = NULL,
           updated_at = ? WHERE id = ?`
        )
        .bind(new Date().toISOString(), taskId)
        .run();
      return { accepted: true, status: "video_queued" };
    }

    const token = task.callback_token || crypto.randomUUID();
    if (!task.callback_token) {
      await db
        .prepare("UPDATE tasks SET callback_token = ? WHERE id = ?")
        .bind(token, taskId)
        .run();
    }
    await submitSeedance({
      taskId,
      prompt: result.prompt,
      imageUrls: images.urls,
      duration: task.duration,
      callbackUrl: callbackUrl(requestUrl, token),
    });
    return { accepted: true, status: "video_queued" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "任务处理失败";
    await db
      .prepare(
        `UPDATE tasks SET status = 'failed', progress = 0,
         error = ?, updated_at = ? WHERE id = ?`
      )
      .bind(message, new Date().toISOString(), taskId)
      .run();
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const body = (await request.json()) as {
      productId?: string;
      gemId?: string;
      autoQueue?: boolean;
      geminiAccountId?: string;
      tiktokAccountName?: string;
      duration?: number;
      region?: string;
      shootingStyle?: string;
      geminiRequestText?: string;
      spokenLanguage?: string;
      imageKeys?: string[];
      variantGemId?: string;
      variantRequestText?: string;
    };
    if (!body.productId || !body.gemId) {
      return Response.json({ error: "请选择产品和 Gem" }, { status: 400 });
    }
    if (body.geminiRequestText !== undefined) {
      try { validateGemRequest(body.geminiRequestText); }
      catch (error) { return jsonError(error, 400); }
    }
    let tiktokAccountName = "";
    try {
      tiktokAccountName = validateTikTokAccountName(body.tiktokAccountName);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "请选择 TK 账号" },
        { status: 400 }
      );
    }
    const db = getDb();

    const account = await db
      .prepare(
        "SELECT id, archive_directory FROM tiktok_accounts WHERE lower(name) = lower(?)"
      )
      .bind(tiktokAccountName)
      .first<{ id: string; archive_directory: string }>();
    if (!account) {
      return Response.json(
        { error: "选择的 TK 账号不存在，请重新选择" },
        { status: 400 }
      );
    }
    const product = await db
      .prepare("SELECT * FROM products WHERE id = ?")
      .bind(body.productId)
      .first<{
        name: string;
        external_id: string;
        features: string;
      }>();
    const gem = await db
      .prepare("SELECT name, content FROM gems WHERE id = ?")
      .bind(body.gemId)
      .first<{ name: string; content: string }>();
    if (!product || !gem) {
      return Response.json({ error: "产品或 Gem 不存在" }, { status: 404 });
    }

    if (body.imageKeys !== undefined) {
      if (!Array.isArray(body.imageKeys) || body.imageKeys.length < 1 || body.imageKeys.length > 12 ||
        body.imageKeys.some(key=>typeof key !== 'string' || !key.startsWith(`products/${body.productId}/`) || key.includes('..')) ||
        !runtimeEnv().MEDIA || (await Promise.all(body.imageKeys.map(key=>runtimeEnv().MEDIA!.head(key)))).some(item=>!item)) {
        return Response.json({error:'本次上传的商品图片无效或已丢失，请重新上传'},{status:400});
      }
    }
    const images = await taskImages(body.productId, request.url, body.imageKeys);
    if (!images.keys.length && !product.name && !product.features) {
      return Response.json(
        { error: "没有找到商品图片或商品资料，请重新上传商品图" },
        { status: 400 }
      );
    }
    const gemini = await getProviderConfig("gemini");
    if (gemini.config.mode === "api" && !gemini.secretConfigured) {
      return Response.json(
        {
          error:
            "Gemini API 尚未配置。已阻止任务创建，不会再返回演示提示词；请先到「接口设置」保存并测试 Gemini API Key。",
          stage: "gemini",
        },
        { status: 409 }
      );
    }
    const id = crypto.randomUUID();
    const token = crypto.randomUUID();
    const now = new Date().toISOString();
    const provider = gemini.config.mode === "web" ? "gemini-web" : "gemini-api";
    const duration = normalizeTaskDuration(body.duration);
    if (duration === 30 && (await getProviderConfig("seedance")).config.mode !== "local-api") return Response.json({error:"双段 30 秒需要本机 Seedance 执行器"},{status:400});
    const region = normalizeTaskRegion(body.region);
    const shootingStyle = normalizeShootingStyle(body.shootingStyle);
    const geminiRequestText = buildGemRequest(body.geminiRequestText ?? DEFAULT_GEM_REQUEST, { duration, region, shooting_style: shootingStyle, spoken_language: body.spokenLanguage });
    // Two-round task: the selected Gem writes a mother prompt, the variant Gem
    // turns it into one video per code block. Snapshots keep later template
    // edits from changing a task already in progress.
    let variant: { id: string; content: string; request: string } | null = null;
    if (body.variantGemId) {
      if (provider !== "gemini-web") return Response.json({ error: "变体两轮只支持 Gemini 网页模式" }, { status: 400 });
      if (duration === 30) return Response.json({ error: "变体两轮不支持双段 30 秒，请选择单条时长" }, { status: 400 });
      const variantGem = await db.prepare("SELECT id, content FROM gems WHERE id = ?").bind(body.variantGemId).first<{ id: string; content: string }>();
      if (!variantGem?.content?.trim()) return Response.json({ error: "选择的变体 Gem 不存在或内容为空" }, { status: 400 });
      let request: string;
      try { request = validateVariantRequest(body.variantRequestText); }
      catch (error) { return jsonError(error, 400); }
      variant = { id: variantGem.id, content: variantGem.content, request: buildGemRequest(request, { duration, region, shooting_style: shootingStyle, spoken_language: body.spokenLanguage }) };
    }
    await db
      .prepare(
        `INSERT INTO tasks
         (id, product_id, gem_id, title, status, prompt, provider, progress,
          duration, region, shooting_style, callback_token, auto_queue,
          gemini_account_id, tiktok_account_name, archive_directory, gem_content_snapshot, product_external_id_snapshot, gemini_request_text, image_keys_snapshot, error, created_at, updated_at,
          task_role, variant_gem_id, variant_gem_snapshot, variant_request_text)
         VALUES (?, ?, ?, ?, 'prompt_queued', '', ?, 5, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        body.productId,
        body.gemId,
        `${product.name || "图片识别商品"} · ${gem.name}`,
        provider,
        duration,
        region,
        shootingStyle,
        token,
        body.autoQueue === false ? 0 : 1,
        null, // Product tasks always use an idle account, including old UI clients.
        tiktokAccountName,
        account.archive_directory || "",
        gem.content,
        product.external_id || "",
        geminiRequestText,
        JSON.stringify(images.keys),
        now,
        now,
        variant ? "group" : null,
        variant?.id || null,
        variant?.content || null,
        variant?.request || null,
      )
      .run();
    return Response.json(
      { id, status: "prompt_queued" },
      { status: 201 }
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureWorkspace();
    const body = (await request.json()) as { id?: string; action?: string };
    if (!body.id) return Response.json({ error: "缺少任务 ID" }, { status: 400 });
    const db = getDb();
    if (await db.prepare("SELECT id FROM tasks WHERE id=? AND task_role='prompt_item'").bind(body.id).first()) return Response.json({ error: '请在提示词生成页操作；提示词条目不能提交视频' }, { status: 409 });

    const remix=await db.prepare("SELECT t.task_role,t.batch_parent_id,p.task_role AS parent_role FROM tasks t LEFT JOIN tasks p ON p.id=t.batch_parent_id WHERE t.id=? AND (t.task_role='remix' OR p.task_role='remix')").bind(body.id).first<{task_role:string;parent_role?:string}>();
    if(remix?.task_role==='remix') {
      if(body.action==='retry') return remixAction(db,{id:body.id,action:'retry'});
      return Response.json({error:'请在爆款复刻整组中操作'},{status:409});
    }
    if(remix && ['process','regenerate','retry'].includes(body.action || '')) return Response.json({error:'分段视频请用同提示词重新生成或原 Seedance 任务恢复，不能重置 Gemini'},{status:409});
    const fission=await db.prepare("SELECT task_role,batch_parent_id,status,prompt,provider_job_id FROM tasks WHERE id=? AND task_role IN ('fission','fission_child')").bind(body.id).first<{task_role:string;batch_parent_id:string|null;status:string;prompt:string;provider_job_id:string|null}>();
    if(fission && ['regenerate','process'].includes(body.action||'')) return Response.json({error:'多品裂变请使用恢复任务或用母版重写，不能按普通商品任务重置'},{status:409});
    if(fission && body.action==='retry'){
      if(fission.status!=='failed' || fission.provider_job_id) return Response.json({error:'请仅恢复失败的 Gemini 任务；已提交视频请从 Seedance 原任务接续监控'},{status:409});
      const now=new Date().toISOString();
      if(fission.task_role==='fission'){
        await db.batch([
          db.prepare(`UPDATE tasks SET status='variant_queued',progress=36,updated_at=? WHERE batch_parent_id=? AND task_role='fission_child' AND status='fission_wait'
            AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND status='failed' AND length(trim(prompt))>=300)`).bind(now,body.id,body.id),
          db.prepare(`UPDATE tasks SET status=CASE WHEN length(trim(prompt))>=300 THEN 'fission_ready' ELSE 'prompt_queued' END,
            progress=CASE WHEN length(trim(prompt))>=300 THEN 100 ELSE 5 END,provider='gemini-web',error=NULL,bridge_claimed_at=NULL,bridge_worker_id=NULL,gemini_failures=0,gemini_retry_at=NULL,updated_at=? WHERE id=? AND status='failed'`).bind(now,body.id),
        ]);
      }else{
        const parent=await db.prepare("SELECT status FROM tasks WHERE id=? AND task_role='fission' AND length(trim(prompt))>=300").bind(fission.batch_parent_id).first<{status:string}>();
        if(parent?.status!=='fission_ready') return Response.json({error:'请先恢复并完成母版任务'},{status:409});
        await db.prepare(`UPDATE tasks SET status=CASE WHEN length(trim(prompt))>=300 THEN 'prompt_ready' ELSE 'variant_queued' END,
          progress=CASE WHEN length(trim(prompt))>=300 THEN 32 ELSE 36 END,provider='gemini-web',error=NULL,bridge_claimed_at=NULL,bridge_worker_id=NULL,gemini_failures=0,gemini_retry_at=NULL,updated_at=? WHERE id=? AND status='failed'`).bind(now,body.id).run();
      }
      return Response.json({ok:true});
    }

    if (body.action === "process") {
      return Response.json(await processQueuedTask(body.id, request.url));
    }

    if (body.action === "check") {
      return Response.json(await checkSeedance(body.id));
    }

    if (body.action === "local-submitted") {
      const detail = body as {
        providerJobId?: string;
      };
      if (!detail.providerJobId) {
        return Response.json({ error: "缺少 Seedance 本机任务 ID" }, { status: 400 });
      }
      await db
        .prepare(
          `UPDATE tasks SET status = 'video_queued', progress = 48,
           provider = 'seedance-local', provider_job_id = ?,
           provider_status_url = ?, error = NULL, updated_at = ? WHERE id = ?`
        )
        .bind(
          detail.providerJobId,
          `local://seedance/${detail.providerJobId}`,
          new Date().toISOString(),
          body.id
        )
        .run();
      return Response.json({ ok: true });
    }

    if (body.action === "local-status") {
      const detail = body as {
        providerStatus?: string;
        outputUrl?: string;
        error?: string;
      };
      const providerStatus = String(detail.providerStatus || "");
      const status =
        providerStatus === "success"
          ? "video_ready"
          : providerStatus === "failed"
            ? "failed"
            : "video_generating";
      await db
        .prepare(
          `UPDATE tasks SET status = ?, progress = ?, output_url = ?,
           error = ?, updated_at = ? WHERE id = ?`
        )
        .bind(
          status,
          status === "video_ready" ? 100 : status === "failed" ? 0 : 70,
          detail.outputUrl || null,
          detail.error || null,
          new Date().toISOString(),
          body.id
        )
        .run();
      return Response.json({ ok: true, status });
    }

    if (body.action === "local-error") {
      const detail = body as { error?: string };
      await db
        .prepare(
          `UPDATE tasks SET status = 'seedance_blocked', progress = 40,
           error = ?, updated_at = ? WHERE id = ?`
        )
        .bind(detail.error || "本机 Seedance 提交失败", new Date().toISOString(), body.id)
        .run();
      return Response.json({ ok: true });
    }

    if (body.action === "resplit") {
      // Run the variant round again from the same mother prompt; a new batch
      // of clips is created and earlier clips are left for the user to judge.
      const result = await db
        .prepare(
          `UPDATE tasks SET status = 'variant_queued', progress = 36, error = NULL,
           bridge_claimed_at = NULL, bridge_worker_id = NULL,
           gemini_failures = 0, gemini_retry_at = NULL, updated_at = ?
           WHERE id = ? AND provider = 'gemini-web' AND task_role = 'group'
             AND variant_gem_snapshot IS NOT NULL AND trim(prompt) <> ''
             AND status IN ('split_done', 'failed')`
        )
        .bind(new Date().toISOString(), body.id)
        .run();
      if (!result.meta.changes) {
        return Response.json({ error: "只有已生成母版的变体两轮任务可以重新分裂；正在处理中的任务请等待完成" }, { status: 409 });
      }
      return Response.json({ ok: true });
    }

    if (body.action === "queue") {
      const task = await db
        .prepare(
          "SELECT product_id, prompt, provider, callback_token, duration, task_role, image_keys_snapshot, status, provider_job_id FROM tasks WHERE id = ?"
        )
        .bind(body.id)
        .first<{
          product_id: string;
          prompt: string;
          provider: string;
          callback_token?: string | null;
          duration: number;
          task_role?: string | null;
          image_keys_snapshot: string | null;
          status: string;
          provider_job_id: string | null;
        }>();
      if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });
      if (task.task_role === 'remix' || task.task_role === "group" || task.task_role === "concat" || task.task_role === 'fission') {
        return Response.json({ error: "分组或拼接任务不能直接提交 Seedance，请在其中的单条视频上操作" }, { status: 409 });
      }
      if(task.task_role==='fission_child' && (!PROMPT_ONLY_STATUSES.includes(task.status)||task.provider_job_id)) return Response.json({error:'这条视频已在执行或尚未完成提示词，请使用原任务继续处理'},{status:409});
      if (task.provider === "demo-engine") {
        return Response.json(
          {
            error:
              "这是旧版演示提示词，不能提交 Seedance。请先点击「重新用 Gemini 识别」。",
          },
          { status: 409 }
        );
      }
      if (!task.prompt.trim()) {
        return Response.json({ error: "任务没有可提交的提示词" }, { status: 409 });
      }
      const token = task.callback_token || crypto.randomUUID();
      if (!task.callback_token) {
        await db
          .prepare("UPDATE tasks SET callback_token = ? WHERE id = ?")
          .bind(token, body.id)
          .run();
      }
      const images = await taskImages(task.product_id, request.url,task.image_keys_snapshot?JSON.parse(task.image_keys_snapshot):undefined);
      const seedance = await getProviderConfig("seedance");
      if (seedance.config.mode === "local-api") {
        const queued=await db
          .prepare(
            `UPDATE tasks SET provider = 'seedance-bridge',
             status = 'video_queued', progress = 48, error = NULL,
             provider_job_id = NULL, provider_status_url = NULL,
             bridge_claimed_at = NULL, bridge_worker_id = NULL,
             updated_at = ? WHERE id = ? AND ((COALESCE(task_role,'') <> 'fission_child' AND remix_segment_start IS NULL)
               OR (status IN ('prompt_ready','seedance_blocked') AND provider_job_id IS NULL))`
          )
          .bind(new Date().toISOString(), body.id)
          .run();
        if(!queued.meta.changes)return Response.json({error:'这条视频已进入队列，未重复提交'},{status:409});
        return Response.json({ ok: true });
      }
      try {
        await submitSeedance({
          taskId: body.id,
          prompt: task.prompt,
          imageUrls: images.urls,
          duration: task.duration,
          callbackUrl: callbackUrl(request.url, token),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Seedance 提交失败";
        await db
          .prepare(
            `UPDATE tasks SET status = 'seedance_blocked', progress = 40,
             error = ?, updated_at = ? WHERE id = ?`
          )
          .bind(message, new Date().toISOString(), body.id)
          .run();
        throw error;
      }
    } else if (body.action === "regenerate") {
      const gemini = await getProviderConfig("gemini");
      const provider = gemini.config.mode === "web" ? "gemini-web" : "gemini-api";
      await db
        .prepare(
          `UPDATE tasks SET prompt = '', provider = ?,
           status = 'prompt_queued', progress = 5, error = NULL,
           auto_queue = ?,
           provider_job_id = NULL, provider_status_url = NULL,
           bridge_claimed_at = NULL, bridge_worker_id = NULL,
           gemini_failures = 0, gemini_retry_at = NULL,
           output_url = NULL, updated_at = ? WHERE id = ?`
        )
        .bind(
          provider,
          (body as { autoQueue?: boolean }).autoQueue === false ? 0 : 1,
          new Date().toISOString(),
          body.id
        )
        .run();
    } else if (body.action === "retry") {
      await db
        .prepare(
          `UPDATE tasks SET
           status = CASE WHEN prompt = '' THEN 'prompt_queued'
             WHEN variant_gem_snapshot IS NOT NULL THEN 'variant_queued' ELSE 'prompt_ready' END,
           progress = CASE WHEN prompt = '' THEN 5
             WHEN variant_gem_snapshot IS NOT NULL THEN 36 ELSE 32 END,
           error = NULL,
           provider_job_id = NULL, provider_status_url = NULL,
           gemini_failures = 0, gemini_retry_at = NULL,
           updated_at = ? WHERE id = ?
             AND COALESCE(task_role, '') <> 'concat'
             AND NOT (COALESCE(task_role, '') = 'group' AND status = 'split_done')`
        )
        .bind(new Date().toISOString(), body.id)
        .run();
    }
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureWorkspace();
    const url = new URL(request.url);
    if (url.searchParams.get("all") === "1") {
      const rows = await getDb().prepare("SELECT id FROM tasks WHERE COALESCE(task_role,'') <> 'prompt_item'").all<{ id: string }>();
      const ids = rows.results.map(row => row.id);
      // One atomic batch clears every row, including tasks beyond the visible 60.
      if (ids.length) await getDb().batch([
        getDb().prepare("DELETE FROM schedules WHERE task_id IN (SELECT id FROM tasks WHERE COALESCE(task_role,'') <> 'prompt_item')"),
        getDb().prepare("DELETE FROM tasks WHERE COALESCE(task_role,'') <> 'prompt_item'"),
      ]);
      return Response.json({ ok: true, deleted: ids.length, ids });
    }
    if (url.searchParams.get("completed") === "1") {
      const completedStatuses = VIDEO_DONE_STATUSES;
      // A concatenated video keeps its row until the desktop has removed the
      // clips merged into it; otherwise those clips would be stranded.
      const completedWhere = `NOT EXISTS(SELECT 1 FROM tasks parent WHERE parent.id=tasks.batch_parent_id AND parent.task_role='remix') AND status IN (?, ?) AND review_status IN ('approved','replaced')
        AND NOT EXISTS (SELECT 1 FROM tasks merged WHERE merged.merged_into_task_id = tasks.id AND merged.review_status = 'merged')`;
      const completed = await getDb()
        .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE ${completedWhere}`)
        .bind(...completedStatuses)
        .first<{ count: number }>();
      await getDb().batch([
        getDb().prepare(
          `DELETE FROM schedules WHERE task_id IN (SELECT id FROM tasks WHERE ${completedWhere})`
        ).bind(...completedStatuses),
        getDb()
          .prepare(`DELETE FROM tasks WHERE ${completedWhere}`)
          .bind(...completedStatuses),
        getDb().prepare(ORPHAN_GROUP_DELETE),
      ]);
      return Response.json({ ok: true, deleted: Number(completed?.count || 0) });
    }
    const { id, remixCleaned } = (await request.json()) as { id?: string;remixCleaned?:boolean };
    if (!id) return Response.json({ error: "缺少任务 ID" }, { status: 400 });
    if (await getDb().prepare("SELECT id FROM tasks WHERE id=? AND task_role='prompt_item'").bind(id).first()) return Response.json({ error: '请在提示词生成页删除条目' }, { status: 409 });
    // Deleting a group removes its clips and concatenated videos as well.
    // Clips merged into a deleted concatenated video return to review.
    const db = getDb();
    const remixParent=await db.prepare("SELECT remix_video_key,status FROM tasks WHERE id=? AND task_role='remix'").bind(id).first<{remix_video_key:string;status:string}>();
    if(remixParent && (remixParent.status!=='remix_deleting' || remixCleaned!==true)) return Response.json({error:'请在爆款复刻中删除整组及临时视频'},{status:409});
    if(remixParent?.remix_video_key) await runtimeEnv().MEDIA?.delete(remixParent.remix_video_key);
    const concatRunning = await db.prepare(`SELECT 1 AS busy FROM tasks WHERE (id = ? OR batch_parent_id = ?)
      AND (status = 'concat_running' OR review_status = 'merging') LIMIT 1`).bind(id, id).first();
    if (concatRunning) return Response.json({ error: "正在拼接这组视频，请等拼接完成后再删除" }, { status: 409 });
    await db.batch([
      db.prepare(`UPDATE tasks SET review_status = 'pending', merged_into_task_id = NULL
        WHERE review_status IN ('merging', 'merged')
          AND merged_into_task_id IN (SELECT id FROM tasks WHERE id = ? OR batch_parent_id = ?)`).bind(id, id),
      db.prepare("DELETE FROM schedules WHERE task_id IN (SELECT id FROM tasks WHERE id = ? OR batch_parent_id = ?)").bind(id, id),
      db.prepare("DELETE FROM tasks WHERE id = ? OR batch_parent_id = ?").bind(id, id),
      db.prepare(ORPHAN_GROUP_DELETE),
    ]);
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
