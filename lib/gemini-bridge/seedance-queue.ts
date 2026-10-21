import { getProviderConfig } from "../provider-config";
import { submitSeedance } from "../seedance";
import { getDb } from "../storage";
import { callbackUrl, mediaUrl } from "./shared";

// After Gemini has written a prompt: submit it to Seedance (or mark why it could not be).
export async function queueSeedance(taskId: string, requestUrl: string) {
  const db = getDb();
  const task = await db
    .prepare(
      `SELECT product_id, prompt, callback_token, duration, image_keys_snapshot
       FROM tasks WHERE id = ?`
    )
    .bind(taskId)
    .first<{
      product_id: string;
      prompt: string;
      callback_token?: string | null;
      duration: number;
      image_keys_snapshot: string | null;
    }>();
  if (!task) throw new Error("任务不存在");
  if (String(task.prompt || "").trim().length < 300) {
    throw new Error("Gemini 提示词不足 300 字，已阻止提交 Seedance");
  }

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
      return;
    }
    await db
      .prepare(
        `UPDATE tasks SET provider = 'seedance-bridge',
         status = 'video_queued', progress = 48, error = NULL,
         provider_job_id = NULL, provider_status_url = NULL,
         bridge_claimed_at = NULL, bridge_worker_id = NULL,
         updated_at = ? WHERE id = ?`
      )
      .bind(new Date().toISOString(), taskId)
      .run();
    return;
  }

  const token = task.callback_token || crypto.randomUUID();
  if (!task.callback_token) {
    await db
      .prepare("UPDATE tasks SET callback_token = ? WHERE id = ?")
      .bind(token, taskId)
      .run();
  }
  const images = await db
    .prepare(
      `SELECT object_key FROM product_images
       WHERE product_id = ? ORDER BY sort_order ASC LIMIT 12`
    )
    .bind(task.product_id)
    .all<{ object_key: string }>();
  await submitSeedance({
    taskId,
    prompt: task.prompt,
    imageUrls: (task.image_keys_snapshot ? JSON.parse(task.image_keys_snapshot) as string[] : images.results.map(image=>image.object_key)).map(key=>mediaUrl(requestUrl,key)),
    duration: task.duration,
    callbackUrl: callbackUrl(requestUrl, token),
  });
}

export async function queueReferenceRemixSeedance(taskId: string) {
  const db = getDb();
  const task = await db
    .prepare("SELECT prompt FROM reference_remix_tasks WHERE id = ?")
    .bind(taskId)
    .first<{ prompt: string }>();
  if (!task) throw new Error("爆款复刻任务不存在");
  if (String(task.prompt || "").trim().length < 300) {
    throw new Error("Gemini 最终提示词不足 300 字，已阻止提交 Seedance");
  }
  const seedance = await getProviderConfig("seedance");
  if (!seedance.secretConfigured) {
    await db
      .prepare(
        `UPDATE reference_remix_tasks SET status = 'seedance_blocked', progress = 62,
         error = ?, updated_at = ? WHERE id = ?`
      )
      .bind(
        "Seedance Bridge Key 尚未保存，请在接口设置中完成本机 Seedance 配置",
        new Date().toISOString(),
        taskId
      )
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE reference_remix_tasks SET provider = 'seedance-bridge',
       status = 'video_queued', progress = 68, error = NULL,
       provider_job_id = NULL, provider_status_url = NULL,
       bridge_claimed_at = NULL, bridge_worker_id = NULL, updated_at = ?
       WHERE id = ?`
    )
    .bind(new Date().toISOString(), taskId)
    .run();
}
