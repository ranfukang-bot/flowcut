import { getProviderConfig, readPath, SeedanceConfig } from "./provider-config";
import { getDb } from "./storage";

type SubmitInput = {
  taskId: string;
  prompt: string;
  imageUrls: string[];
  duration: number;
  callbackUrl: string;
};

function headers(config: SeedanceConfig, apiKey?: string) {
  const result: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    result[config.authHeader || "Authorization"] = config.authScheme
      ? `${config.authScheme} ${apiKey}`
      : apiKey;
  }
  return result;
}

export async function submitSeedance(input: SubmitInput) {
  const { config, secrets } = await getProviderConfig("seedance");
  if (config.mode === "local-api") {
    throw new Error("本机 Seedance 需要由当前浏览器提交");
  }
  if (!config.endpoint) throw new Error("请先在接口设置中填写 Seedance API 或插件地址");

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: headers(config, secrets.apiKey),
    body: JSON.stringify({
      type: "video_generation",
      task_id: input.taskId,
      prompt: input.prompt,
      images: input.imageUrls,
      duration: input.duration,
      aspect_ratio: "9:16",
      callback_url: input.callbackUrl,
    }),
  });
  const raw = await response.text();
  let data: unknown = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw };
  }
  if (!response.ok) {
    throw new Error(`Seedance 提交失败：${response.status} ${raw.slice(0, 240)}`);
  }

  const jobId = String(readPath(data, config.responseJobIdPath) || "");
  const directOutput = String(readPath(data, config.responseOutputPath) || "");
  const statusUrl =
    config.statusUrlTemplate && jobId
      ? config.statusUrlTemplate.replaceAll("{jobId}", encodeURIComponent(jobId))
      : "";

  await getDb()
    .prepare(
      `UPDATE tasks SET status = ?, progress = ?, provider = ?, provider_job_id = ?,
       provider_status_url = ?, output_url = ?, error = NULL, updated_at = ? WHERE id = ?`
    )
    .bind(
      directOutput ? "video_ready" : "video_queued",
      directOutput ? 100 : 48,
      config.mode === "webhook" ? "seedance-plugin" : "seedance-api",
      jobId || null,
      statusUrl || null,
      directOutput || null,
      new Date().toISOString(),
      input.taskId
    )
    .run();

  return { jobId, directOutput };
}

export async function checkSeedance(taskId: string) {
  const db = getDb();
  const task = await db
    .prepare("SELECT provider_job_id, provider_status_url, status FROM tasks WHERE id = ?")
    .bind(taskId)
    .first<{ provider_job_id?: string; provider_status_url?: string; status: string }>();
  if (!task) throw new Error("任务不存在");
  if (!task.provider_status_url) return { status: task.status };

  const { config, secrets } = await getProviderConfig("seedance");
  const response = await fetch(task.provider_status_url, {
    headers: headers(config, secrets.apiKey),
  });
  const raw = await response.text();
  const data = raw ? JSON.parse(raw) : {};
  if (!response.ok) throw new Error(`Seedance 状态查询失败：${response.status}`);
  const providerStatus = String(readPath(data, config.statusPath) || "");
  const outputUrl = String(readPath(data, config.outputPath) || "");
  const success = providerStatus.toLowerCase() === config.successValue.toLowerCase();
  const failed = providerStatus.toLowerCase() === config.failureValue.toLowerCase();
  const status = success ? "video_ready" : failed ? "failed" : "video_generating";
  await db
    .prepare(
      "UPDATE tasks SET status = ?, progress = ?, output_url = ?, error = ?, updated_at = ? WHERE id = ?"
    )
    .bind(
      status,
      success ? 100 : failed ? 0 : 70,
      outputUrl || null,
      failed ? `Seedance 任务状态：${providerStatus}` : null,
      new Date().toISOString(),
      taskId
    )
    .run();
  return { status, outputUrl };
}
