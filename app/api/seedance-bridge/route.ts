import { getProviderConfig } from "../../../lib/provider-config";
import { ensureWorkspace, getDb, jsonError } from "../../../lib/storage";

async function authorize(request: Request) {
  const configured = await getProviderConfig("seedance");
  const expected = configured.secrets.apiKey;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !supplied || supplied !== expected) {
    return false;
  }
  return true;
}

function mediaUrl(requestUrl: string, objectKey: string) {
  const url = new URL("/api/media", requestUrl);
  url.searchParams.set("key", objectKey);
  return url.toString();
}

function mappedTaskStatus(providerStatus: string) {
  if (providerStatus === "success") return { status: "video_ready", progress: 100 };
  if (providerStatus === "failed") return { status: "failed", progress: 0 };
  if (
    ["upload_wait", "uploading", "queued", "submitting", "pending", "model_wait"].includes(
      providerStatus
    )
  ) {
    return { status: "video_queued", progress: 52 };
  }
  return { status: "video_generating", progress: 72 };
}

export async function GET(request: Request) {
  try {
    await ensureWorkspace();
    if (!(await authorize(request))) {
      return Response.json({ error: "Seedance Bridge 鉴权失败" }, { status: 401 });
    }
    const workerId =
      new URL(request.url).searchParams.get("workerId") || "seedance-desktop";
    const db = getDb();
    const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();
    const pending = await db
      .prepare(
        `SELECT tasks.id, tasks.product_id, tasks.prompt,
                tasks.tiktok_account_name, tasks.archive_directory, tasks.duration,
                COALESCE(tasks.product_external_id_snapshot, products.external_id, '') AS product_external_id
         FROM tasks
         LEFT JOIN products ON products.id = tasks.product_id
         WHERE tasks.provider = 'seedance-bridge'
           AND tasks.status = 'video_queued'
           AND tasks.provider_job_id IS NULL
           AND (tasks.bridge_claimed_at IS NULL OR tasks.bridge_claimed_at < ?)
         ORDER BY tasks.created_at ASC LIMIT 4`
      )
      .bind(staleBefore)
      .all<{
        id: string;
        product_id: string;
        prompt: string;
        tiktok_account_name: string;
        archive_directory: string;
        product_external_id: string;
        duration: number;
      }>();

    const jobs: Array<{
      id: string;
      kind: "standard" | "reference-remix";
      prompt: string;
      imageUrls: string[];
      tiktokAccountName: string;
      archiveDirectory: string;
      productExternalId: string;
      duration: number;
    }> = [];
    for (const task of pending.results) {
      const claimedAt = new Date().toISOString();
      const claimed = await db
        .prepare(
          `UPDATE tasks SET bridge_claimed_at = ?, bridge_worker_id = ?, updated_at = ?
           WHERE id = ? AND provider = 'seedance-bridge' AND provider_job_id IS NULL
             AND (bridge_claimed_at IS NULL OR bridge_claimed_at < ?)`
        )
        .bind(claimedAt, workerId, claimedAt, task.id, staleBefore)
        .run();
      if (!claimed.meta.changes) continue;
      const images = await db
        .prepare(
          `SELECT object_key FROM product_images
           WHERE product_id = ? ORDER BY sort_order ASC LIMIT 9`
        )
        .bind(task.product_id)
        .all<{ object_key: string }>();
      jobs.push({
        id: task.id,
        kind: "standard",
        prompt: task.prompt,
        tiktokAccountName: task.tiktok_account_name || "",
        archiveDirectory: task.archive_directory || "",
        productExternalId: task.product_external_id || "",
        duration: task.duration,
        imageUrls: images.results.map((item: { object_key: string }) =>
          mediaUrl(request.url, item.object_key)
        ),
      });
    }
    const remainingCapacity = Math.max(0, 4 - jobs.length);
    if (remainingCapacity > 0) {
      const remixPending = await db
        .prepare(
          `SELECT id, prompt, tiktok_account_name, archive_directory, duration, product_external_id
           FROM reference_remix_tasks
           WHERE provider = 'seedance-bridge' AND status = 'video_queued'
             AND provider_job_id IS NULL
             AND (bridge_claimed_at IS NULL OR bridge_claimed_at < ?)
           ORDER BY created_at ASC LIMIT ?`
        )
        .bind(staleBefore, remainingCapacity)
        .all<{
          id: string;
          prompt: string;
          tiktok_account_name: string;
        archive_directory: string;
          duration: number;
          product_external_id: string;
        }>();
      for (const task of remixPending.results) {
        const claimedAt = new Date().toISOString();
        const claimed = await db
          .prepare(
            `UPDATE reference_remix_tasks SET bridge_claimed_at = ?, bridge_worker_id = ?, updated_at = ?
             WHERE id = ? AND provider = 'seedance-bridge' AND provider_job_id IS NULL
               AND (bridge_claimed_at IS NULL OR bridge_claimed_at < ?)`
          )
          .bind(claimedAt, workerId, claimedAt, task.id, staleBefore)
          .run();
        if (!claimed.meta.changes) continue;
        const images = await db
          .prepare(
            `SELECT object_key FROM reference_remix_assets
             WHERE task_id = ? AND kind = 'product_image'
             ORDER BY sort_order ASC LIMIT 9`
          )
          .bind(task.id)
          .all<{ object_key: string }>();
        jobs.push({
          id: task.id,
          kind: "reference-remix",
          prompt: task.prompt,
          tiktokAccountName: task.tiktok_account_name || "",
        archiveDirectory: task.archive_directory || "",
          productExternalId: task.product_external_id || "",
          duration: task.duration,
          imageUrls: images.results.map((item) => mediaUrl(request.url, item.object_key)),
        });
      }
    }
    return Response.json({ jobs });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    if (!(await authorize(request))) {
      return Response.json({ error: "Seedance Bridge 鉴权失败" }, { status: 401 });
    }
    const body = (await request.json()) as {
      action?: "heartbeat" | "submitted" | "status";
      kind?: "standard" | "reference-remix";
      taskId?: string;
      providerJobId?: string;
      providerStatus?: string;
      outputUrl?: string;
      error?: string;
      downloadPath?: string;
      downloadError?: string;
      workerId?: string;
      version?: string;
      authenticated?: boolean;
      queueRunning?: boolean;
      maxConcurrent?: number;
      activeCount?: number;
      downloadDirectory?: string;
    };
    const db = getDb();
    const now = new Date().toISOString();

    if (body.action === "heartbeat") {
      const status = {
        workerId: body.workerId || "seedance-desktop",
        version: body.version || "",
        authenticated: Boolean(body.authenticated),
        queueRunning: Boolean(body.queueRunning),
        maxConcurrent: Number(body.maxConcurrent || 0),
        activeCount: Number(body.activeCount || 0),
        downloadDirectory: String(body.downloadDirectory || ""),
      };
      await db
        .prepare(
          `INSERT INTO provider_runtime (provider, status_json, updated_at)
           VALUES ('seedance', ?, ?)
           ON CONFLICT(provider) DO UPDATE SET
             status_json = excluded.status_json, updated_at = excluded.updated_at`
        )
        .bind(JSON.stringify(status), now)
        .run();
      return Response.json({ ok: true });
    }

    if (!body.taskId) {
      return Response.json({ error: "缺少工作台任务 ID" }, { status: 400 });
    }
    if (body.action === "submitted") {
      if (!body.providerJobId) {
        return Response.json({ error: "缺少 Seedance 任务 ID" }, { status: 400 });
      }
      if (body.kind === "reference-remix") {
        await db
          .prepare(
            `UPDATE reference_remix_tasks SET status = 'video_queued', progress = 72,
             provider_job_id = ?, provider_status_url = ?, error = NULL,
             bridge_claimed_at = NULL, updated_at = ?
             WHERE id = ? AND provider = 'seedance-bridge'`
          )
          .bind(body.providerJobId, `bridge://seedance/${body.providerJobId}`, now, body.taskId)
          .run();
        return Response.json({ ok: true });
      }
      await db
        .prepare(
          `UPDATE tasks SET status = 'video_queued', progress = 52,
           provider_job_id = ?, provider_status_url = ?, error = NULL,
           bridge_claimed_at = NULL, updated_at = ?
           WHERE id = ? AND provider = 'seedance-bridge'`
        )
        .bind(
          body.providerJobId,
          `bridge://seedance/${body.providerJobId}`,
          now,
          body.taskId
        )
        .run();
      return Response.json({ ok: true });
    }
    if (body.action === "status") {
      const mapped = mappedTaskStatus(String(body.providerStatus || ""));
      if (body.kind === "reference-remix") {
        await db
          .prepare(
            `UPDATE reference_remix_tasks SET status = ?, progress = ?, output_url = ?,
             download_path = COALESCE(?, download_path), download_error = ?,
             error = ?, updated_at = ?
             WHERE id = ? AND provider = 'seedance-bridge'`
          )
          .bind(
            mapped.status,
            mapped.progress,
            body.outputUrl || null,
            String(body.downloadPath || "").trim() || null,
            String(body.downloadError || "").trim() || null,
            body.error || null,
            now,
            body.taskId
          )
          .run();
        return Response.json({ ok: true, status: mapped.status });
      }
      await db
        .prepare(
          `UPDATE tasks SET status = ?, progress = ?, output_url = ?,
           download_path = COALESCE(?, download_path), download_error = ?,
           error = ?, updated_at = ?
           WHERE id = ? AND provider = 'seedance-bridge'`
        )
        .bind(
          mapped.status,
          mapped.progress,
          body.outputUrl || null,
          String(body.downloadPath || "").trim() || null,
          String(body.downloadError || "").trim() || null,
          body.error || null,
          now,
          body.taskId
        )
        .run();
      return Response.json({ ok: true, status: mapped.status });
    }
    return Response.json({ error: "不支持的 Bridge 操作" }, { status: 400 });
  } catch (error) {
    return jsonError(error);
  }
}
