import { buildGeminiPrompt } from "../../../lib/gemini";
import { getProviderConfig } from "../../../lib/provider-config";
import { submitSeedance } from "../../../lib/seedance";
import {
  buildReferenceAdaptationPrompt,
  buildReferenceAnalysisPrompt,
} from "../../../lib/reference-remix";
import { buildRewritePrompt } from "../../../lib/script-pipeline";
import { ensureWorkspace, getDb, jsonError } from "../../../lib/storage";

async function authorize(request: Request) {
  const configured = await getProviderConfig("seedance");
  const expected = configured.secrets.apiKey;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return Boolean(expected && supplied && supplied === expected);
}

function mediaUrl(requestUrl: string, objectKey: string) {
  const url = new URL("/api/media", requestUrl);
  url.searchParams.set("key", objectKey);
  return url.toString();
}

function callbackUrl(requestUrl: string, token: string) {
  const url = new URL("/api/tasks/callback", requestUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

async function queueSeedance(taskId: string, requestUrl: string) {
  const db = getDb();
  const task = await db
    .prepare(
      `SELECT product_id, prompt, callback_token, duration
       FROM tasks WHERE id = ?`
    )
    .bind(taskId)
    .first<{
      product_id: string;
      prompt: string;
      callback_token?: string | null;
      duration: number;
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
    imageUrls: images.results.map((image: { object_key: string }) =>
      mediaUrl(requestUrl, image.object_key)
    ),
    duration: task.duration,
    callbackUrl: callbackUrl(requestUrl, token),
  });
}

async function queueReferenceRemixSeedance(taskId: string) {
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

export async function GET(request: Request) {
  try {
    await ensureWorkspace();
    if (!(await authorize(request))) {
      return Response.json({ error: "Gemini 网页执行器鉴权失败" }, { status: 401 });
    }

    const url = new URL(request.url);
    const workerId = url.searchParams.get("workerId") || "gemini-web-desktop";
    const capacity = Math.max(1, Math.min(8, Number(url.searchParams.get("capacity") || 1)));
    const availableAccounts = new Set(
      (url.searchParams.get("accountIds") || "").split(",").filter(Boolean)
    );
    const db = getDb();
    const staleBefore = new Date(Date.now() - 12 * 60_000).toISOString();
    const retryReadyAt = new Date().toISOString();
    const pending = await db
      .prepare(
      `SELECT t.id, t.product_id, t.gemini_account_id, t.created_at,
                t.duration, t.region, t.shooting_style,
                p.name, p.features, COALESCE(t.gem_content_snapshot, g.content) AS content
         FROM tasks t
         JOIN products p ON p.id = t.product_id
         LEFT JOIN gems g ON g.id = t.gem_id
         WHERE t.provider = 'gemini-web'
           AND t.status IN ('prompt_queued', 'prompt_generating')
           AND (t.bridge_claimed_at IS NULL OR t.bridge_claimed_at < ?)
           AND (t.gemini_retry_at IS NULL OR t.gemini_retry_at <= ?)
         ORDER BY t.created_at ASC LIMIT 32`
      )
      .bind(staleBefore, retryReadyAt)
      .all<{
        id: string;
        product_id: string;
        gemini_account_id?: string | null;
        name: string;
        features: string;
        content: string;
        duration: number;
        region: string;
        shooting_style: string;
        created_at: string;
      }>();

    const remixPending = await db
      .prepare(
        `SELECT id, gemini_account_id, duration, region, created_at
         FROM reference_remix_tasks
         WHERE provider = 'gemini-web'
           AND status IN ('reference_queued', 'reference_analyzing', 'product_adapting')
           AND (bridge_claimed_at IS NULL OR bridge_claimed_at < ?)
           AND (gemini_retry_at IS NULL OR gemini_retry_at <= ?)
         ORDER BY created_at ASC LIMIT 32`
      )
      .bind(staleBefore, retryReadyAt)
      .all<{
        id: string;
        gemini_account_id?: string | null;
        duration: number;
        region: string;
        created_at: string;
      }>();

    const scriptPending = await db
      .prepare(
        `SELECT id, title, source_script, project_context, rewritten_script,
                extraction_json, storyboard_json, raw_groups_json,
                gemini_account_id, status, created_at
         FROM script_pipeline_tasks
         WHERE provider = 'gemini-web'
           AND status IN ('rewrite_queued', 'rewriting', 'extracting', 'storyboarding', 'grouping', 'optimization_queued', 'optimizing')
           AND (bridge_claimed_at IS NULL OR bridge_claimed_at < ?)
           AND (gemini_retry_at IS NULL OR gemini_retry_at <= ?)
         ORDER BY created_at ASC LIMIT 32`
      )
      .bind(staleBefore, retryReadyAt)
      .all<{
        id: string;
        title: string;
        source_script: string;
        project_context: string;
        rewritten_script: string;
        extraction_json: string;
        storyboard_json: string;
        raw_groups_json: string;
        gemini_account_id?: string | null;
        status: string;
        created_at: string;
      }>();

    const jobs: Array<{
      id: string;
      kind: "standard" | "reference-remix" | "script-pipeline";
      accountId: string;
      prompt?: string;
      analysisPrompt?: string;
      adaptationPrompt?: string;
      imageUrls: string[];
      referenceVideoUrl?: string;
      projectContext?: string;
      rewrittenScript?: string;
      extractionJson?: string;
      storyboardJson?: string;
      rawGroupsJson?: string;
    }> = [];
    const candidates = [
      ...pending.results.map((task) => ({ kind: "standard" as const, task })),
      ...remixPending.results.map((task) => ({ kind: "reference-remix" as const, task })),
      ...scriptPending.results.map((task) => ({ kind: "script-pipeline" as const, task })),
    ].sort((left, right) => left.task.created_at.localeCompare(right.task.created_at));
    for (const candidate of candidates) {
      const task = candidate.task;
      if (jobs.length >= capacity) break;
      if (
        task.gemini_account_id &&
        !availableAccounts.has(task.gemini_account_id)
      ) {
        continue;
      }
      const claimedAt = new Date().toISOString();
      const scriptHasGroups = candidate.kind === "script-pipeline" && (() => {
        try {
          return JSON.parse(String((task as (typeof scriptPending.results)[number]).raw_groups_json || "[]")).length > 0;
        } catch {
          return false;
        }
      })();
      const scriptResume = candidate.kind === "script-pipeline" ? (() => {
        const script = task as (typeof scriptPending.results)[number];
        if (scriptHasGroups) return { status: "optimizing", progress: 76 };
        if (String(script.storyboard_json || "").trim()) return { status: "grouping", progress: 66 };
        if (String(script.extraction_json || "").trim()) return { status: "storyboarding", progress: 48 };
        if (String(script.rewritten_script || "").trim()) return { status: "extracting", progress: 30 };
        return { status: "rewriting", progress: 12 };
      })() : null;
      const claimed = candidate.kind === "standard"
        ? await db.prepare(
          `UPDATE tasks SET status = 'prompt_generating', progress = 12,
           bridge_claimed_at = ?, bridge_worker_id = ?, gemini_retry_at = NULL,
           error = NULL, updated_at = ?
           WHERE id = ? AND provider = 'gemini-web'
             AND (bridge_claimed_at IS NULL OR bridge_claimed_at < ?)`
        ).bind(claimedAt, workerId, claimedAt, task.id, staleBefore).run()
        : candidate.kind === "reference-remix" ? await db.prepare(
          `UPDATE reference_remix_tasks SET status = 'reference_analyzing', progress = 18,
           bridge_claimed_at = ?, bridge_worker_id = ?, gemini_retry_at = NULL,
           error = NULL, updated_at = ?
           WHERE id = ? AND provider = 'gemini-web'
             AND (bridge_claimed_at IS NULL OR bridge_claimed_at < ?)`
        ).bind(claimedAt, workerId, claimedAt, task.id, staleBefore).run()
        : await db.prepare(
          `UPDATE script_pipeline_tasks SET status = ?, progress = ?,
           bridge_claimed_at = ?, bridge_worker_id = ?, gemini_retry_at = NULL,
           error = NULL, updated_at = ?
           WHERE id = ? AND provider = 'gemini-web'
             AND (bridge_claimed_at IS NULL OR bridge_claimed_at < ?)`
        ).bind(
          scriptResume?.status || "rewriting",
          scriptResume?.progress || 12,
          claimedAt, workerId, claimedAt, task.id, staleBefore
        ).run();
      if (!claimed.meta.changes) continue;
      if (candidate.kind === "standard") {
        const standardTask = task as (typeof pending.results)[number];
        const images = await db
          .prepare(
            `SELECT object_key FROM product_images
             WHERE product_id = ? ORDER BY sort_order ASC LIMIT 12`
          )
          .bind(standardTask.product_id)
          .all<{ object_key: string }>();
        jobs.push({
          id: standardTask.id,
          kind: "standard",
          accountId: standardTask.gemini_account_id || "",
          prompt: buildGeminiPrompt(standardTask.content, standardTask),
          imageUrls: images.results.map((image: { object_key: string }) =>
            mediaUrl(request.url, image.object_key)
          ),
        });
      } else if (candidate.kind === "reference-remix") {
        const remixTask = task as (typeof remixPending.results)[number];
        const assets = await db
          .prepare(
            `SELECT kind, object_key FROM reference_remix_assets
             WHERE task_id = ? ORDER BY sort_order ASC`
          )
          .bind(remixTask.id)
          .all<{ kind: string; object_key: string }>();
        const referenceVideo = assets.results.find((asset) => asset.kind === "reference_video");
        const productImages = assets.results.filter((asset) => asset.kind === "product_image");
        if (!referenceVideo || !productImages.length) {
          await db.prepare(
            `UPDATE reference_remix_tasks SET status = 'failed', progress = 0,
             bridge_claimed_at = NULL, bridge_worker_id = NULL, error = ?, updated_at = ?
             WHERE id = ?`
          ).bind("对标视频或产品图片已丢失，请重新创建任务", claimedAt, remixTask.id).run();
          continue;
        }
        jobs.push({
          id: remixTask.id,
          kind: "reference-remix",
          accountId: remixTask.gemini_account_id || "",
          analysisPrompt: buildReferenceAnalysisPrompt(remixTask.duration, remixTask.region),
          adaptationPrompt: buildReferenceAdaptationPrompt(remixTask.duration, remixTask.region),
          referenceVideoUrl: mediaUrl(request.url, referenceVideo.object_key),
          imageUrls: productImages.map((image) => mediaUrl(request.url, image.object_key)),
        });
      } else {
        const scriptTask = task as (typeof scriptPending.results)[number];
        jobs.push({
          id: scriptTask.id,
          kind: "script-pipeline",
          accountId: scriptTask.gemini_account_id || "",
          prompt: buildRewritePrompt(scriptTask.source_script),
          projectContext: scriptTask.project_context || "",
          rewrittenScript: scriptTask.rewritten_script || "",
          extractionJson: scriptTask.extraction_json || "",
          storyboardJson: scriptTask.storyboard_json || "",
          rawGroupsJson: scriptHasGroups ? scriptTask.raw_groups_json : "",
          imageUrls: [],
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
      return Response.json({ error: "Gemini 网页执行器鉴权失败" }, { status: 401 });
    }
    const body = (await request.json()) as {
      action?: "heartbeat" | "stage" | "result" | "error" | "release" | "retrying" | "defer";
      taskId?: string;
      kind?: "standard" | "reference-remix" | "script-pipeline";
      stage?: "extracting" | "storyboarding" | "grouping" | "optimizing";
      prompt?: string;
      analysis?: string;
      rewrittenScript?: string;
      extractionJson?: string;
      storyboardJson?: string;
      rawGroupsJson?: string;
      optimizedGroupsJson?: string;
      error?: string;
      workerId?: string;
      version?: string;
      queueRunning?: boolean;
      activeCount?: number;
      activeTaskIds?: string[];
      activeJobs?: Array<{ taskId: string; accountName?: string; stage?: string; startedAt?: string; updatedAt?: string }>;
      maxConcurrent?: number;
      defaultAccountId?: string;
      accounts?: Array<{
        id: string;
        name: string;
        authenticated: boolean;
        busy?: boolean;
      }>;
    };
    const db = getDb();
    const now = new Date().toISOString();

    if (body.action === "heartbeat") {
      const accounts = Array.isArray(body.accounts) ? body.accounts : [];
      const status = {
        workerId: body.workerId || "gemini-web-desktop",
        version: body.version || "",
        queueRunning: body.queueRunning !== false,
        activeCount: Number(body.activeCount || 0),
        activeJobs: (Array.isArray(body.activeJobs) ? body.activeJobs : []).slice(0, 100).map((job) => ({
          taskId: String(job.taskId || ""), accountName: String(job.accountName || "").slice(0, 80),
          stage: String(job.stage || "").slice(0, 160), startedAt: String(job.startedAt || ""),
          updatedAt: String(job.updatedAt || ""),
        })),
        maxConcurrent: Number(
          body.maxConcurrent ??
            accounts.filter((account) => account.authenticated).length
        ),
        defaultAccountId: body.defaultAccountId || "",
        authenticated: accounts.some((account) => account.authenticated),
        accounts,
      };
      await db
        .prepare(
          `INSERT INTO provider_runtime (provider, status_json, updated_at)
           VALUES ('gemini-web', ?, ?)
           ON CONFLICT(provider) DO UPDATE SET
             status_json = excluded.status_json, updated_at = excluded.updated_at`
        )
        .bind(JSON.stringify(status), now)
        .run();
      for (const taskId of Array.isArray(body.activeTaskIds)
        ? body.activeTaskIds.slice(0, 8)
        : []) {
        await db
          .prepare(
            `UPDATE tasks SET bridge_claimed_at = ?, updated_at = ?
             WHERE id = ? AND bridge_worker_id = ?
               AND status = 'prompt_generating'`
          )
          .bind(now, now, taskId, body.workerId || "gemini-web-desktop")
          .run();
        await db
          .prepare(
            `UPDATE script_pipeline_tasks SET bridge_claimed_at = ?, updated_at = ?
             WHERE id = ? AND bridge_worker_id = ?
               AND status IN ('rewriting', 'extracting', 'storyboarding', 'grouping', 'optimizing')`
          )
          .bind(now, now, taskId, body.workerId || "gemini-web-desktop")
          .run();
        await db
          .prepare(
            `UPDATE reference_remix_tasks SET bridge_claimed_at = ?, updated_at = ?
             WHERE id = ? AND bridge_worker_id = ?
               AND status IN ('reference_analyzing', 'product_adapting')`
          )
          .bind(now, now, taskId, body.workerId || "gemini-web-desktop")
          .run();
      }
      return Response.json({ ok: true });
    }

    if (!body.taskId) {
      return Response.json({ error: "缺少 FlowCut 任务 ID" }, { status: 400 });
    }

    if (body.action === "stage" && body.kind === "reference-remix") {
      const analysis = String(body.analysis || "").trim();
      if (analysis.length < 100) {
        return Response.json({ error: "第一轮分析内容不完整" }, { status: 400 });
      }
      await db
        .prepare(
          `UPDATE reference_remix_tasks SET reference_analysis = ?,
           status = 'product_adapting', progress = 42, updated_at = ?
           WHERE id = ? AND provider = 'gemini-web'
             AND status = 'reference_analyzing'
             AND (bridge_worker_id IS NULL OR bridge_worker_id = ?)`
        )
        .bind(analysis, now, body.taskId, body.workerId || "")
        .run();
      return Response.json({ ok: true });
    }

    if (body.action === "stage" && body.kind === "script-pipeline") {
      const stage = body.stage || "extracting";
      const stageConfig = {
        extracting: { status: "extracting", progress: 30 },
        storyboarding: { status: "storyboarding", progress: 48 },
        grouping: { status: "grouping", progress: 66 },
        optimizing: { status: "optimizing", progress: 76 },
      }[stage];
      if (!stageConfig) return Response.json({ error: "未知剧本流水线阶段" }, { status: 400 });
      const rewritten = String(body.rewrittenScript || "").trim();
      const extraction = String(body.extractionJson || "").trim();
      const storyboard = String(body.storyboardJson || "").trim();
      const rawGroups = String(body.rawGroupsJson || "").trim();
      await db
        .prepare(
          `UPDATE script_pipeline_tasks SET status = ?, progress = ?,
           rewritten_script = CASE WHEN ? <> '' THEN ? ELSE rewritten_script END,
           extraction_json = CASE WHEN ? <> '' THEN ? ELSE extraction_json END,
           storyboard_json = CASE WHEN ? <> '' THEN ? ELSE storyboard_json END,
           raw_groups_json = CASE WHEN ? <> '' THEN ? ELSE raw_groups_json END,
           error = NULL, updated_at = ?
           WHERE id = ? AND provider = 'gemini-web'
             AND (bridge_worker_id IS NULL OR bridge_worker_id = ?)`
        )
        .bind(
          stageConfig.status, stageConfig.progress,
          rewritten, rewritten,
          extraction, extraction,
          storyboard, storyboard,
          rawGroups, rawGroups,
          now, body.taskId, body.workerId || ""
        )
        .run();
      return Response.json({ ok: true });
    }

    if (body.action === "result") {
      const prompt = String(body.prompt || "").trim();
      if (prompt.length < 300) {
        return Response.json(
          {
            error: `Gemini 返回内容只有 ${prompt.length} 字，不是完整 Seedance 提示词，已阻止进入下一步`,
          },
          { status: 400 }
        );
      }
      if (body.kind === "script-pipeline") {
        const optimizedGroups = String(body.optimizedGroupsJson || "").trim();
        let groups: unknown[] = [];
        try {
          groups = JSON.parse(optimizedGroups);
        } catch {
          return Response.json({ error: "最终优化提示词不是合法 JSON" }, { status: 400 });
        }
        if (!Array.isArray(groups) || !groups.length) {
          return Response.json({ error: "最终优化提示词为空" }, { status: 400 });
        }
        const updated = await db
          .prepare(
            `UPDATE script_pipeline_tasks SET
             rewritten_script = CASE WHEN ? <> '' THEN ? ELSE rewritten_script END,
             extraction_json = CASE WHEN ? <> '' THEN ? ELSE extraction_json END,
             storyboard_json = CASE WHEN ? <> '' THEN ? ELSE storyboard_json END,
             raw_groups_json = CASE WHEN ? <> '' THEN ? ELSE raw_groups_json END,
             optimized_groups_json = ?, status = 'completed', progress = 100,
             error = NULL, bridge_claimed_at = NULL, bridge_worker_id = NULL,
             gemini_failures = 0, gemini_retry_at = NULL, updated_at = ?
             WHERE id = ? AND provider = 'gemini-web'
               AND status IN ('rewriting', 'extracting', 'storyboarding', 'grouping', 'optimizing')
               AND (bridge_worker_id IS NULL OR bridge_worker_id = ?)`
          )
          .bind(
            String(body.rewrittenScript || "").trim(), String(body.rewrittenScript || "").trim(),
            String(body.extractionJson || "").trim(), String(body.extractionJson || "").trim(),
            String(body.storyboardJson || "").trim(), String(body.storyboardJson || "").trim(),
            String(body.rawGroupsJson || "").trim(), String(body.rawGroupsJson || "").trim(),
            optimizedGroups, now, body.taskId, body.workerId || ""
          )
          .run();
        if (!updated.meta.changes) {
          return Response.json({ error: "剧本任务阶段已变化，忽略过期结果", ignorable: true }, { status: 409 });
        }
        return Response.json({ ok: true });
      }
      if (body.kind === "reference-remix") {
        const analysis = String(body.analysis || "").trim();
        if (analysis.length < 100) {
          return Response.json({ error: "对标视频结构分析不完整" }, { status: 400 });
        }
        const task = await db
          .prepare(
            `SELECT auto_queue, status, provider, prompt, bridge_worker_id
             FROM reference_remix_tasks WHERE id = ?`
          )
          .bind(body.taskId)
          .first<{
            auto_queue: number;
            status: string;
            provider: string;
            prompt: string;
            bridge_worker_id?: string | null;
          }>();
        if (!task) {
          return Response.json({ error: "复刻任务不存在，忽略过期结果", ignorable: true }, { status: 409 });
        }
        if (task.prompt.trim() === prompt && !["reference_analyzing", "product_adapting"].includes(task.status)) {
          return Response.json({ ok: true, alreadyApplied: true });
        }
        if (
          task.provider !== "gemini-web" ||
          !["reference_analyzing", "product_adapting"].includes(task.status) ||
          (task.bridge_worker_id && body.workerId && task.bridge_worker_id !== body.workerId)
        ) {
          return Response.json({ error: "复刻任务已进入后续阶段，忽略过期结果", ignorable: true }, { status: 409 });
        }
        const updated = await db
          .prepare(
            `UPDATE reference_remix_tasks SET reference_analysis = ?, prompt = ?,
             status = 'prompt_ready', progress = 62, error = NULL,
             bridge_claimed_at = NULL, bridge_worker_id = NULL,
             gemini_failures = 0, gemini_retry_at = NULL, updated_at = ?
             WHERE id = ? AND provider = 'gemini-web'
               AND status IN ('reference_analyzing', 'product_adapting')
               AND (bridge_worker_id IS NULL OR bridge_worker_id = ?)`
          )
          .bind(analysis, prompt, now, body.taskId, body.workerId || "")
          .run();
        if (!updated.meta.changes) {
          return Response.json({ error: "复刻任务阶段已变化，忽略过期结果", ignorable: true }, { status: 409 });
        }
        if (task.auto_queue) {
          try {
            await queueReferenceRemixSeedance(body.taskId);
          } catch (error) {
            await db.prepare(
              `UPDATE reference_remix_tasks SET status = 'seedance_blocked', progress = 62,
               error = ?, updated_at = ? WHERE id = ?`
            ).bind(error instanceof Error ? error.message : "Seedance 自动提交失败", now, body.taskId).run();
          }
        }
        return Response.json({ ok: true });
      }
      const task = await db
        .prepare(
          `SELECT auto_queue, status, provider, prompt, bridge_worker_id
           FROM tasks WHERE id = ?`
        )
        .bind(body.taskId)
        .first<{
          auto_queue: number;
          status: string;
          provider: string;
          prompt: string;
          bridge_worker_id?: string | null;
        }>();
      if (!task) {
        return Response.json(
          { error: "任务不存在，忽略过期结果", ignorable: true },
          { status: 409 }
        );
      }
      if (
        String(task.prompt || "").trim() === prompt &&
        !["prompt_queued", "prompt_generating"].includes(task.status)
      ) {
        return Response.json({ ok: true, alreadyApplied: true });
      }
      if (
        task.provider !== "gemini-web" ||
        task.status !== "prompt_generating" ||
        (task.bridge_worker_id &&
          body.workerId &&
          task.bridge_worker_id !== body.workerId)
      ) {
        return Response.json(
          {
            error: "任务已由其他执行器处理或进入后续阶段，忽略过期结果",
            ignorable: true,
          },
          { status: 409 }
        );
      }
      const updated = await db
        .prepare(
          `UPDATE tasks SET prompt = ?, status = 'prompt_ready', progress = 32,
           error = NULL, bridge_claimed_at = NULL, bridge_worker_id = NULL,
           gemini_failures = 0, gemini_retry_at = NULL,
           updated_at = ? WHERE id = ? AND provider = 'gemini-web'
             AND status = 'prompt_generating'
             AND (bridge_worker_id IS NULL OR bridge_worker_id = ?)`
        )
        .bind(prompt, now, body.taskId, body.workerId || "")
        .run();
      if (!updated.meta.changes) {
        return Response.json(
          { error: "任务阶段已变化，忽略过期 Gemini 结果", ignorable: true },
          { status: 409 }
        );
      }
      if (task.auto_queue) {
        try {
          await queueSeedance(body.taskId, request.url);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Seedance 自动提交失败";
          await db
            .prepare(
              `UPDATE tasks SET status = 'seedance_blocked', progress = 40,
               error = ?, updated_at = ? WHERE id = ?`
            )
            .bind(message, new Date().toISOString(), body.taskId)
            .run();
        }
      }
      return Response.json({ ok: true });
    }

    if (body.action === "release") {
      const table = body.kind === "reference-remix" ? "reference_remix_tasks" : body.kind === "script-pipeline" ? "script_pipeline_tasks" : "tasks";
      const queuedStatusSql = body.kind === "script-pipeline"
        ? `CASE
             WHEN raw_groups_json <> '[]' THEN 'optimization_queued'
             WHEN storyboard_json <> '' THEN 'grouping'
             WHEN extraction_json <> '' THEN 'storyboarding'
             WHEN rewritten_script <> '' THEN 'extracting'
             ELSE 'rewrite_queued'
           END`
        : `'${body.kind === "reference-remix" ? "reference_queued" : "prompt_queued"}'`;
      const queuedProgressSql = body.kind === "script-pipeline"
        ? `CASE
             WHEN raw_groups_json <> '[]' THEN 72
             WHEN storyboard_json <> '' THEN 66
             WHEN extraction_json <> '' THEN 48
             WHEN rewritten_script <> '' THEN 30
             ELSE 5
           END`
        : "5";
      await db
        .prepare(
          `UPDATE ${table} SET status = ${queuedStatusSql}, progress = ${queuedProgressSql},
           bridge_claimed_at = NULL, bridge_worker_id = NULL,
           gemini_retry_at = NULL, error = ?, updated_at = ? WHERE id = ?`
        )
        .bind(body.error || null, now, body.taskId)
        .run();
      return Response.json({ ok: true });
    }

    if (body.action === "defer") {
      const table = body.kind === "reference-remix" ? "reference_remix_tasks" : body.kind === "script-pipeline" ? "script_pipeline_tasks" : "tasks";
      const queuedStatusSql = body.kind === "script-pipeline"
        ? `CASE
             WHEN raw_groups_json <> '[]' THEN 'optimization_queued'
             WHEN storyboard_json <> '' THEN 'grouping'
             WHEN extraction_json <> '' THEN 'storyboarding'
             WHEN rewritten_script <> '' THEN 'extracting'
             ELSE 'rewrite_queued'
           END`
        : `'${body.kind === "reference-remix" ? "reference_queued" : "prompt_queued"}'`;
      const queuedProgressSql = body.kind === "script-pipeline"
        ? `CASE
             WHEN raw_groups_json <> '[]' THEN 72
             WHEN storyboard_json <> '' THEN 66
             WHEN extraction_json <> '' THEN 48
             WHEN rewritten_script <> '' THEN 30
             ELSE 5
           END`
        : "5";
      const task = await db
        .prepare(
          `SELECT gemini_failures FROM ${table} WHERE id = ? AND provider = 'gemini-web'`
        )
        .bind(body.taskId)
        .first<{ gemini_failures: number }>();
      if (!task) {
        return Response.json({ error: "任务已不在 Gemini 阶段" }, { status: 409 });
      }
      const failures = Number(task.gemini_failures || 0) + 1;
      const retryDelays = [2 * 60_000, 10 * 60_000, 30 * 60_000];
      const waitLabels = ["2 分钟", "10 分钟", "30 分钟"];
      if (failures <= retryDelays.length) {
        const retryAt = new Date(Date.now() + retryDelays[failures - 1]).toISOString();
        const waitLabel = waitLabels[failures - 1];
        await db
          .prepare(
            `UPDATE ${table} SET status = ${queuedStatusSql}, progress = ${queuedProgressSql},
             bridge_claimed_at = NULL, bridge_worker_id = NULL,
             gemini_failures = ?, gemini_retry_at = ?,
             error = ?, updated_at = ? WHERE id = ?`
          )
          .bind(
            failures,
            retryAt,
            `Gemini 网页临时波动，系统将在 ${waitLabel}后自动重试（${failures}/${retryDelays.length}）：${body.error || "页面未确认任务完成"}`,
            now,
            body.taskId
          )
          .run();
        return Response.json({
          ok: true,
          deferred: true,
          failures,
          maxFailures: retryDelays.length,
          retryAt,
        });
      }
      await db
        .prepare(
          `UPDATE ${table} SET status = 'failed', progress = 0,
           bridge_claimed_at = NULL, bridge_worker_id = NULL,
           gemini_failures = ?, gemini_retry_at = NULL,
           error = ?, updated_at = ? WHERE id = ?`
        )
        .bind(
          failures,
          `${body.error || "Gemini 网页生成失败"}（后台恢复已尝试 ${retryDelays.length} 轮）`,
          now,
          body.taskId
        )
        .run();
      return Response.json({
        ok: true,
        deferred: false,
        failures,
        maxFailures: retryDelays.length,
      });
    }

    if (body.action === "retrying") {
      const table = body.kind === "reference-remix" ? "reference_remix_tasks" : body.kind === "script-pipeline" ? "script_pipeline_tasks" : "tasks";
      const activeStatusSql = body.kind === "script-pipeline"
        ? `CASE
             WHEN raw_groups_json <> '[]' THEN 'optimizing'
             WHEN storyboard_json <> '' THEN 'grouping'
             WHEN extraction_json <> '' THEN 'storyboarding'
             WHEN rewritten_script <> '' THEN 'extracting'
             ELSE 'rewriting'
           END`
        : `'${body.kind === "reference-remix" ? "reference_analyzing" : "prompt_generating"}'`;
      const activeProgressSql = body.kind === "script-pipeline"
        ? `CASE
             WHEN raw_groups_json <> '[]' THEN 76
             WHEN storyboard_json <> '' THEN 66
             WHEN extraction_json <> '' THEN 48
             WHEN rewritten_script <> '' THEN 30
             ELSE 14
           END`
        : "14";
      await db
        .prepare(
          `UPDATE ${table} SET status = ${activeStatusSql}, progress = ${activeProgressSql},
           bridge_claimed_at = ?, error = ?, updated_at = ?
           WHERE id = ? AND provider = 'gemini-web'`
        )
        .bind(
          now,
          body.error || "Gemini 页面波动，正在自动重试",
          now,
          body.taskId
        )
        .run();
      return Response.json({ ok: true });
    }

    if (body.action === "error") {
      const table = body.kind === "reference-remix" ? "reference_remix_tasks" : body.kind === "script-pipeline" ? "script_pipeline_tasks" : "tasks";
      await db
        .prepare(
          `UPDATE ${table} SET status = 'failed', progress = 0,
           bridge_claimed_at = NULL, bridge_worker_id = NULL,
           error = ?, updated_at = ? WHERE id = ?`
        )
        .bind(body.error || "Gemini 网页生成失败", now, body.taskId)
        .run();
      return Response.json({ ok: true });
    }
    return Response.json({ error: "不支持的 Gemini Bridge 操作" }, { status: 400 });
  } catch (error) {
    return jsonError(error);
  }
}
