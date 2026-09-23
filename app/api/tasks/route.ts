import { generatePrompt } from "../../../lib/gemini";
import { getProviderConfig } from "../../../lib/provider-config";
import { checkSeedance, submitSeedance } from "../../../lib/seedance";
import { ensureWorkspace, getDb, jsonError } from "../../../lib/storage";
import {
  normalizeShootingStyle,
  normalizeTaskDuration,
  normalizeTaskRegion,
} from "../../../lib/task-config";
import { validateTikTokAccountName } from "../../../lib/tiktok-accounts";

async function taskImages(productId: string, requestUrl: string) {
  const images = await getDb()
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
      `SELECT t.product_id, t.gem_id, t.callback_token, t.auto_queue,
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
    const images = await taskImages(task.product_id, requestUrl);
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
    };
    if (!body.productId || !body.gemId) {
      return Response.json({ error: "请选择产品和 Gem" }, { status: 400 });
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

    const images = await taskImages(body.productId, request.url);
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
    const region = normalizeTaskRegion(body.region);
    const shootingStyle = normalizeShootingStyle(body.shootingStyle);
    await db
      .prepare(
        `INSERT INTO tasks
         (id, product_id, gem_id, title, status, prompt, provider, progress,
          duration, region, shooting_style, callback_token, auto_queue,
          gemini_account_id, tiktok_account_name, archive_directory, gem_content_snapshot, product_external_id_snapshot, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'prompt_queued', '', ?, 5, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 NULL, ?, ?)`
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
        body.geminiAccountId?.trim() || null,
        tiktokAccountName,
        account.archive_directory || "",
        gem.content,
        product.external_id || "",
        now,
        now
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

    if (body.action === "queue") {
      const task = await db
        .prepare(
          "SELECT product_id, prompt, provider, callback_token, duration FROM tasks WHERE id = ?"
        )
        .bind(body.id)
        .first<{
          product_id: string;
          prompt: string;
          provider: string;
          callback_token?: string | null;
          duration: number;
        }>();
      if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });
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
      const images = await taskImages(task.product_id, request.url);
      const seedance = await getProviderConfig("seedance");
      if (seedance.config.mode === "local-api") {
        await db
          .prepare(
            `UPDATE tasks SET provider = 'seedance-bridge',
             status = 'video_queued', progress = 48, error = NULL,
             provider_job_id = NULL, provider_status_url = NULL,
             bridge_claimed_at = NULL, bridge_worker_id = NULL,
             updated_at = ? WHERE id = ?`
          )
          .bind(new Date().toISOString(), body.id)
          .run();
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
           status = CASE WHEN prompt = '' THEN 'prompt_queued' ELSE 'prompt_ready' END,
           progress = CASE WHEN prompt = '' THEN 5 ELSE 32 END,
           error = NULL,
           provider_job_id = NULL, provider_status_url = NULL,
           gemini_failures = 0, gemini_retry_at = NULL,
           updated_at = ? WHERE id = ?`
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
      const rows = await getDb().prepare("SELECT id FROM tasks").all<{ id: string }>();
      const ids = rows.results.map(row => row.id);
      // One atomic batch clears every row, including tasks beyond the visible 60.
      if (ids.length) await getDb().batch([
        getDb().prepare("DELETE FROM schedules WHERE task_id IN (SELECT id FROM tasks)"),
        getDb().prepare("DELETE FROM tasks"),
      ]);
      return Response.json({ ok: true, deleted: ids.length, ids });
    }
    if (url.searchParams.get("completed") === "1") {
      const completedStatuses = ["video_ready", "scheduled"];
      const completed = await getDb()
        .prepare(
          "SELECT COUNT(*) AS count FROM tasks WHERE status IN (?, ?)"
        )
        .bind(...completedStatuses)
        .first<{ count: number }>();
      await getDb().batch([
        getDb().prepare(
          `DELETE FROM schedules
           WHERE task_id IN (
             SELECT id FROM tasks WHERE status IN (?, ?)
           )`
        ).bind(...completedStatuses),
        getDb()
          .prepare("DELETE FROM tasks WHERE status IN (?, ?)")
          .bind(...completedStatuses),
      ]);
      return Response.json({ ok: true, deleted: Number(completed?.count || 0) });
    }
    const { id } = (await request.json()) as { id?: string };
    if (!id) return Response.json({ error: "缺少任务 ID" }, { status: 400 });
    await getDb().batch([
      getDb().prepare("DELETE FROM schedules WHERE task_id = ?").bind(id),
      getDb().prepare("DELETE FROM tasks WHERE id = ?").bind(id),
    ]);
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
