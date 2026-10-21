import { buildSavedGemPrompt } from "../../../lib/gemini";
import { buildGemRequest, buildSingleGemRequest } from '../../../lib/gem-request';
import { requestSpokenLanguage } from '../../../lib/spoken-language';
import { chooseGeminiAccount, availableGemAccounts } from "../../../lib/gemini-account-routing";
import { geminiRetryPlan } from "../../../lib/gemini-retry";
import { getProviderConfig } from "../../../lib/provider-config";
import { submitSeedance } from "../../../lib/seedance";
import {
  buildReferenceAdaptationPrompt,
  buildReferenceAnalysisPrompt,
} from "../../../lib/reference-remix";
import { buildRewritePrompt } from "../../../lib/script-pipeline";
import { ensureWorkspace, getDb, jsonError } from "../../../lib/storage";
import { renderVariantRequest, splitPromptBlocks, type PromptBlockMode } from "../../../lib/prompt-blocks";
import { clipInsertStatements, clipStart, clipTaskId } from "../../../lib/task-batches";

type GeminiKind = "standard" | "variant" | "reference-remix" | "script-pipeline";

// A group already split into clips is finished with Gemini: a late release,
// retry or failure report from an old worker must not reopen it.
const SPLIT_GUARD = " AND status NOT IN ('split_done','fission_ready')";

// Table and queue/active states for each Gemini job kind. A variant job is the
// second round of a product task and lives in the tasks table.
function kindState(kind: GeminiKind | undefined, workerId = '') {
  const fissionGuard = ` AND (COALESCE(task_role,'') NOT IN ('fission','fission_child') OR
    (provider='gemini-web' AND status IN (${kind==='variant'?"'variant_queued','variant_generating'":"'prompt_queued','prompt_generating'"}) AND bridge_worker_id=?))`;
  if (kind === "reference-remix") {
    return { table: "reference_remix_tasks", queued: "'reference_queued'", queuedProgress: "5", active: "'reference_analyzing'", activeProgress: "14", rawReply: false, guard: "", guardArgs: [] as string[] };
  }
  if (kind === "script-pipeline") {
    return {
      table: "script_pipeline_tasks",
      queued: `CASE
             WHEN raw_groups_json <> '[]' THEN 'optimization_queued'
             WHEN storyboard_json <> '' THEN 'grouping'
             WHEN extraction_json <> '' THEN 'storyboarding'
             WHEN rewritten_script <> '' THEN 'extracting'
             ELSE 'rewrite_queued'
           END`,
      queuedProgress: `CASE
             WHEN raw_groups_json <> '[]' THEN 72
             WHEN storyboard_json <> '' THEN 66
             WHEN extraction_json <> '' THEN 48
             WHEN rewritten_script <> '' THEN 30
             ELSE 5
           END`,
      active: `CASE
             WHEN raw_groups_json <> '[]' THEN 'optimizing'
             WHEN storyboard_json <> '' THEN 'grouping'
             WHEN extraction_json <> '' THEN 'storyboarding'
             WHEN rewritten_script <> '' THEN 'extracting'
             ELSE 'rewriting'
           END`,
      activeProgress: `CASE
             WHEN raw_groups_json <> '[]' THEN 76
             WHEN storyboard_json <> '' THEN 66
             WHEN extraction_json <> '' THEN 48
             WHEN rewritten_script <> '' THEN 30
             ELSE 14
           END`,
      rawReply: false,
      guard: "",
      guardArgs: [] as string[],
    };
  }
  if (kind === "variant") {
    return { table: "tasks", queued: "'variant_queued'", queuedProgress: "36", active: "'variant_generating'", activeProgress: "40", rawReply: true, guard: SPLIT_GUARD+fissionGuard, guardArgs: [workerId] };
  }
  return { table: "tasks", queued: "'prompt_queued'", queuedProgress: "5", active: "'prompt_generating'", activeProgress: "14", rawReply: true, guard: SPLIT_GUARD+fissionGuard, guardArgs: [workerId] };
}

// Gemini replies kept for the task detail when a split was refused.
function rawReplyValue(value: unknown) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 60_000) : null;
}

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
    const blockedValue=JSON.parse(url.searchParams.get('blockedTaskIds') || '[]');
    const blockedTaskIds=new Set(Array.isArray(blockedValue)?blockedValue.filter(id=>typeof id==='string').slice(0,1000):[]);
    const workerId = url.searchParams.get("workerId") || "gemini-web-desktop";
    const capacity = Math.max(1, Math.min(8, Number(url.searchParams.get("capacity") || 1)));
    const availableAccounts = new Set(
      (url.searchParams.get("accountIds") || "").split(",").filter(Boolean)
    );
    const db = getDb();
    const staleBefore = new Date(Date.now() - 12 * 60_000).toISOString();
    const retryReadyAt = new Date().toISOString();
    const blockedGemVersions: Record<string,string[]> = {};
    const advertisedBlocks = JSON.parse(url.searchParams.get("blockedGemVersions") || "{}");
    if (advertisedBlocks && typeof advertisedBlocks === "object" && !Array.isArray(advertisedBlocks)) {
      for (const [account, values] of Object.entries(advertisedBlocks)) {
        if (Array.isArray(values)) blockedGemVersions[account] = values.filter((value): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
      }
    }
    const pending = await db
      .prepare(
      `SELECT t.id, t.product_id, t.gemini_account_id, t.created_at, COALESCE(t.gemini_retry_at, t.created_at) AS queue_at,
                t.duration, t.region, t.shooting_style, t.gemini_request_text, t.image_keys_snapshot, t.gem_id, g.name AS gem_name,
                p.name, p.features, COALESCE(t.gem_content_snapshot, g.content) AS content,
                t.variant_gem_snapshot IS NOT NULL AS variant_mode
         FROM tasks t
         JOIN products p ON p.id = t.product_id
         LEFT JOIN gems g ON g.id = t.gem_id
         WHERE t.provider = 'gemini-web'
           AND t.status IN ('prompt_queued', 'prompt_generating')
           AND (t.bridge_claimed_at IS NULL OR t.bridge_claimed_at < ?)
           AND (t.gemini_retry_at IS NULL OR t.gemini_retry_at <= ?)
         ORDER BY queue_at ASC LIMIT 32`
      )
      .bind(staleBefore, retryReadyAt)
      .all<{
        id: string;
        product_id: string;
        gemini_account_id?: string | null;
        name: string;
        features: string;
        content: string;
        gem_id: string;
        gem_name: string;
        duration: number;
        region: string;
        shooting_style: string;
        gemini_request_text: string | null;
        image_keys_snapshot: string | null;
        created_at: string;
        queue_at: string;
        variant_mode: number;
      }>();

    // Second round of a two-round task: the mother prompt (saved as the
    // group's prompt) goes to the variant Gem together with the same images.
    const variantPending = await db
      .prepare(
        `SELECT t.id, t.product_id, t.gemini_account_id, t.created_at, COALESCE(t.gemini_retry_at, t.created_at) AS queue_at,
                CASE WHEN t.task_role='fission_child' THEN parent.prompt ELSE t.prompt END AS mother_prompt, t.task_role, t.variant_request_text, t.image_keys_snapshot,
                t.duration,t.region,t.shooting_style,t.gemini_request_text,
                COALESCE(t.variant_gem_id, 'snapshot-variant-' || t.id) AS gem_id, COALESCE(vg.name, '变体 Gem') AS gem_name,
                t.variant_gem_snapshot AS content
         FROM tasks t
         LEFT JOIN gems vg ON vg.id = t.variant_gem_id
         LEFT JOIN tasks parent ON parent.id=t.batch_parent_id
         WHERE t.provider = 'gemini-web'
           AND t.status IN ('variant_queued', 'variant_generating')
           AND t.variant_gem_snapshot IS NOT NULL
           AND (COALESCE(t.task_role,'') <> 'fission_child' OR (parent.task_role='fission' AND parent.status='fission_ready' AND length(trim(parent.prompt))>=300))
           AND (t.bridge_claimed_at IS NULL OR t.bridge_claimed_at < ?)
           AND (t.gemini_retry_at IS NULL OR t.gemini_retry_at <= ?)
         ORDER BY queue_at ASC LIMIT 32`
      )
      .bind(staleBefore, retryReadyAt)
      .all<{
        id: string;
        product_id: string;
        gemini_account_id?: string | null;
        mother_prompt: string;
        duration: number;
        region: string;
        shooting_style: string;
        gemini_request_text: string | null;
        task_role: string | null;
        variant_request_text: string | null;
        image_keys_snapshot: string | null;
        gem_id: string;
        gem_name: string;
        content: string;
        created_at: string;
        queue_at: string;
      }>();

    const remixPending = await db
      .prepare(
        `SELECT id, gemini_account_id, duration, region, created_at, COALESCE(gemini_retry_at, created_at) AS queue_at
         FROM reference_remix_tasks
         WHERE provider = 'gemini-web'
           AND status IN ('reference_queued', 'reference_analyzing', 'product_adapting')
           AND (bridge_claimed_at IS NULL OR bridge_claimed_at < ?)
           AND (gemini_retry_at IS NULL OR gemini_retry_at <= ?)
         ORDER BY queue_at ASC LIMIT 32`
      )
      .bind(staleBefore, retryReadyAt)
      .all<{
        id: string;
        gemini_account_id?: string | null;
        duration: number;
        region: string;
        created_at: string;
        queue_at: string;
      }>();

    const scriptPending = await db
      .prepare(
        `SELECT id, title, source_script, project_context, rewritten_script,
                extraction_json, storyboard_json, raw_groups_json,
                gemini_account_id, status, created_at, COALESCE(gemini_retry_at, created_at) AS queue_at
         FROM script_pipeline_tasks
         WHERE provider = 'gemini-web'
           AND status IN ('rewrite_queued', 'rewriting', 'extracting', 'storyboarding', 'grouping', 'optimization_queued', 'optimizing')
           AND (bridge_claimed_at IS NULL OR bridge_claimed_at < ?)
           AND (gemini_retry_at IS NULL OR gemini_retry_at <= ?)
         ORDER BY queue_at ASC LIMIT 32`
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
        queue_at: string;
      }>();

    const jobs: Array<{
      gem?: { id: string; name: string; content: string };
      id: string;
      kind: GeminiKind;
      accountId: string;
      blockMode?: PromptBlockMode;
      prompt?: string;
      spokenLanguage?: string;
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
      ...variantPending.results.map((task) => ({ kind: "variant" as const, task })),
      ...remixPending.results.map((task) => ({ kind: "reference-remix" as const, task })),
      ...scriptPending.results.map((task) => ({ kind: "script-pipeline" as const, task })),
    ].sort((left, right) => left.task.queue_at.localeCompare(right.task.queue_at));
    for (const candidate of candidates) {
      const task = candidate.task;
      if(blockedTaskIds.has(task.id))continue;
      if (jobs.length >= capacity) break;
      const eligibleAccounts = candidate.kind === "standard" || candidate.kind === "variant"
        ? await availableGemAccounts(availableAccounts, blockedGemVersions, candidate.task.gem_id, candidate.task.content)
        : availableAccounts;
      const accountId = chooseGeminiAccount(candidate.kind, task.gemini_account_id, eligibleAccounts);
      if (!accountId) continue;
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
             AND status IN ('prompt_queued', 'prompt_generating')
             AND (bridge_claimed_at IS NULL OR bridge_claimed_at < ?)`
        ).bind(claimedAt, workerId, claimedAt, task.id, staleBefore).run()
        : candidate.kind === "variant" ? await db.prepare(
          `UPDATE tasks SET status = 'variant_generating', progress = 40,
           bridge_claimed_at = ?, bridge_worker_id = ?, gemini_retry_at = NULL,
           error = NULL, updated_at = ?
           WHERE id = ? AND provider = 'gemini-web'
             AND status IN ('variant_queued', 'variant_generating')
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
          accountId,
          blockMode: Number(standardTask.duration) === 30 ? "raw" : standardTask.variant_mode ? "single" : "split",
          gem: { id: standardTask.gem_id || `snapshot-${standardTask.id}`, name: standardTask.gem_name || "历史任务 Gem", content: standardTask.content },
          prompt: buildSavedGemPrompt(standardTask),
          spokenLanguage: requestSpokenLanguage(buildSavedGemPrompt(standardTask),standardTask.region),
          imageUrls: (standardTask.image_keys_snapshot ? JSON.parse(standardTask.image_keys_snapshot) as string[] : images.results.map(image => image.object_key))
            .map(key => mediaUrl(request.url, key)),
        });
      } else if (candidate.kind === "variant") {
        const variantTask = task as (typeof variantPending.results)[number];
        const images = variantTask.image_keys_snapshot ? null : await db
          .prepare(`SELECT object_key FROM product_images WHERE product_id = ? ORDER BY sort_order ASC LIMIT 12`)
          .bind(variantTask.product_id)
          .all<{ object_key: string }>();
        jobs.push({
          id: variantTask.id,
          kind: "variant",
          accountId,
          blockMode: variantTask.task_role==='fission_child' ? "single" : "split",
          gem: { id: variantTask.gem_id, name: variantTask.gem_name, content: variantTask.content },
          prompt: renderVariantRequest((variantTask.task_role==='fission_child'?buildSingleGemRequest:buildGemRequest)(variantTask.variant_request_text || "",{duration:variantTask.duration,region:variantTask.region,shooting_style:variantTask.shooting_style,spoken_language:requestSpokenLanguage(variantTask.gemini_request_text || '',variantTask.region)}), variantTask.mother_prompt),
          spokenLanguage: requestSpokenLanguage(variantTask.gemini_request_text || '',variantTask.region),
          imageUrls: (variantTask.image_keys_snapshot ? JSON.parse(variantTask.image_keys_snapshot) as string[] : (images?.results || []).map(image => image.object_key))
            .map(key => mediaUrl(request.url, key)),
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
          accountId,
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
          accountId,
          prompt: buildRewritePrompt(scriptTask.source_script),
          projectContext: scriptTask.project_context || "",
          rewrittenScript: scriptTask.rewritten_script || "",
          extractionJson: scriptTask.extraction_json || "",
          storyboardJson: scriptTask.storyboard_json || "",
          rawGroupsJson: scriptHasGroups ? scriptTask.raw_groups_json : "",
          imageUrls: [],
        });
      }
      // One claimed job per idle account in this batch, even with legacy pins.
      availableAccounts.delete(accountId);
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
      action?: "heartbeat" | "stage" | "result" | "error" | "release" | "retrying" | "defer" | "model";
      modelInfo?: { model?: string; thinking?: string | null; checkedAt?: string; elapsedMs?: number };
      errorCode?: string;
      taskId?: string;
      kind?: GeminiKind;
      stage?: "extracting" | "storyboarding" | "grouping" | "optimizing";
      prompt?: string;
      codeBlocks?: string[];
      codeBlockHint?: boolean;
      rawReply?: string;
      analysis?: string;
      rewrittenScript?: string;
      extractionJson?: string;
      storyboardJson?: string;
      rawGroupsJson?: string;
      optimizedGroupsJson?: string;
      error?: string;
      accountLimited?: boolean;
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
        enabled?: boolean;
        busy?: boolean;
        error?: string;
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
            accounts.filter((account) => account.authenticated && account.enabled !== false).length
        ),
        defaultAccountId: body.defaultAccountId || "",
        authenticated: accounts.some((account) => account.authenticated && account.enabled !== false),
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
               AND status IN ('prompt_generating', 'variant_generating')`
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

    if (body.action === 'model') {
      const info = body.modelInfo;
      if (!info || !String(info.model || '').trim() || String(info.model).length > 200 || String(info.thinking || '').length > 160) return Response.json({ error: '实际模型记录无效' }, { status: 400 });
      const table = kindState(body.kind).table;
      const updated = await db.prepare(`UPDATE ${table} SET gemini_model_info = ?, gemini_error_code = NULL, updated_at = ? WHERE id = ? AND bridge_worker_id = ? AND bridge_claimed_at IS NOT NULL`)
        .bind(JSON.stringify({ model: info.model, thinking: info.thinking || null, checkedAt: now, elapsedMs: Math.max(0, Number(info.elapsedMs) || 0) }), now, body.taskId, body.workerId).run();
      if (!updated.meta.changes) return Response.json({ error: '任务领取已失效，禁止发送', ignorable: true }, { status: 409 });
      return Response.json({ ok: true });
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
          `SELECT auto_queue, status, provider, prompt, bridge_worker_id, duration, task_role,
                  variant_gem_snapshot IS NOT NULL AS variant_mode
           FROM tasks WHERE id = ?`
        )
        .bind(body.taskId)
        .first<{
          auto_queue: number;
          status: string;
          provider: string;
          prompt: string;
          bridge_worker_id?: string | null;
          duration: number;
          variant_mode: number;
          task_role: string | null;
        }>();
      if (!task) {
        return Response.json(
          { error: "任务不存在，忽略过期结果", ignorable: true },
          { status: 409 }
        );
      }
      const variantRound = body.kind === "variant";
      const expectedStatus = variantRound ? "variant_generating" : "prompt_generating";
      const fissionChild=task.task_role==='fission_child';
      const fissionMother=task.task_role==='fission';
      const mode: PromptBlockMode = fissionChild ? 'single' : variantRound ? "split" : Number(task.duration) === 30 ? "raw" : task.variant_mode ? "single" : "split";
      let parsed;
      try {
        parsed = splitPromptBlocks({ text: prompt, blocks: body.codeBlocks, hint: body.codeBlockHint === true, mode, singleLabel:fissionChild?'变体 Gem':undefined });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "代码块校验失败" }, { status: 400 });
      }
      const split = !fissionChild && (parsed.prompts.length > 1 || variantRound);
      const appliedPrompt = split ? prompt : parsed.prompts[0];
      if (
        String(task.prompt || "").trim() === appliedPrompt &&
        !["prompt_queued", "prompt_generating", "variant_queued", "variant_generating"].includes(task.status)
      ) {
        return Response.json({ ok: true, alreadyApplied: true });
      }
      if (
        task.provider !== "gemini-web" ||
        task.status !== expectedStatus ||
        ((fissionChild || fissionMother) && (task.bridge_worker_id !== body.workerId || !body.workerId || variantRound !== fissionChild)) ||
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
      const workerId = body.workerId || "";
      const rawReply = rawReplyValue(prompt);
      const note = parsed.note || null;

      if (fissionMother) {
        const results=await db.batch([
          db.prepare(`UPDATE tasks SET status='variant_queued',progress=36,updated_at=? WHERE batch_parent_id=? AND task_role='fission_child' AND status='fission_wait'
            AND EXISTS (SELECT 1 FROM tasks parent WHERE parent.id=? AND parent.task_role='fission' AND parent.status='prompt_generating' AND parent.provider='gemini-web' AND parent.bridge_worker_id=?)`).bind(now,body.taskId,body.taskId,workerId),
          db.prepare(`UPDATE tasks SET prompt=?,prompt_note=?,gemini_raw_reply=?,status='fission_ready',progress=100,error=NULL,
            bridge_claimed_at=NULL,bridge_worker_id=NULL,gemini_failures=0,gemini_retry_at=NULL,updated_at=?
            WHERE id=? AND task_role='fission' AND status='prompt_generating' AND provider='gemini-web' AND bridge_worker_id=?`).bind(parsed.prompts[0],note,rawReply,now,body.taskId,workerId),
        ]);
        return results[1].meta.changes ? Response.json({ok:true,fissionReady:true}) : Response.json({error:'母版领取已失效，忽略过期结果',ignorable:true},{status:409});
      }

      if (mode === "single" && !fissionChild) {
        // Round 1 of a two-round task: keep the mother prompt and queue round 2.
        const updated = await db
          .prepare(
            `UPDATE tasks SET prompt = ?, prompt_note = ?, gemini_raw_reply = ?, task_role = 'group',
             status = 'variant_queued', progress = 36,
             error = NULL, bridge_claimed_at = NULL, bridge_worker_id = NULL,
             gemini_failures = 0, gemini_retry_at = NULL,
             updated_at = ? WHERE id = ? AND provider = 'gemini-web'
               AND status = 'prompt_generating'
               AND (bridge_worker_id IS NULL OR bridge_worker_id = ?)`
          )
          .bind(parsed.prompts[0], note, rawReply, now, body.taskId, workerId)
          .run();
        if (!updated.meta.changes) {
          return Response.json({ error: "任务阶段已变化，忽略过期 Gemini 结果", ignorable: true }, { status: 409 });
        }
        return Response.json({ ok: true, variantQueued: true });
      }

      if (split) {
        const seedance = await getProviderConfig("seedance");
        const start = clipStart(Boolean(task.auto_queue), { mode: seedance.config.mode, secretConfigured: seedance.secretConfigured });
        const latest = await db
          .prepare("SELECT COALESCE(MAX(batch_round), 0) AS round FROM tasks WHERE batch_parent_id = ?")
          .bind(body.taskId)
          .first<{ round: number }>();
        const round = Number(latest?.round || 0) + 1;
        const results = await db.batch([
          ...clipInsertStatements(db, { groupId: body.taskId, round, prompts: parsed.prompts, start, expectedStatus, workerId, now }),
          db.prepare(
            `UPDATE tasks SET task_role = 'group', status = 'split_done', progress = 100,
             ${variantRound ? "" : "prompt = ?, "}gemini_raw_reply = ?, prompt_note = NULL,
             batch_size = ?, batch_round = ?,
             error = NULL, bridge_claimed_at = NULL, bridge_worker_id = NULL,
             gemini_failures = 0, gemini_retry_at = NULL, updated_at = ?
             WHERE id = ? AND provider = 'gemini-web' AND status = ?
               AND (bridge_worker_id IS NULL OR bridge_worker_id = ?)`
          ).bind(
            ...(variantRound ? [] : [prompt]),
            rawReply, parsed.prompts.length, round, now, body.taskId, expectedStatus, workerId,
          ),
        ]);
        if (!results.at(-1)?.meta.changes) {
          return Response.json({ error: "任务阶段已变化，忽略过期 Gemini 结果", ignorable: true }, { status: 409 });
        }
        if (start.status === "prompt_ready" && task.auto_queue) {
          for (let index = 1; index <= parsed.prompts.length; index += 1) {
            const clipId = clipTaskId(body.taskId, round, index);
            try {
              await queueSeedance(clipId, request.url);
            } catch (error) {
              await db.prepare(
                `UPDATE tasks SET status = 'seedance_blocked', progress = 40, error = ?, updated_at = ? WHERE id = ?`
              ).bind(error instanceof Error ? error.message : "Seedance 自动提交失败", new Date().toISOString(), clipId).run();
            }
          }
        }
        return Response.json({ ok: true, clips: parsed.prompts.length, round });
      }

      const updated = await db
        .prepare(
          `UPDATE tasks SET prompt = ?, prompt_note = ?, gemini_raw_reply = ?,
           status = 'prompt_ready', progress = 32,
           error = NULL, bridge_claimed_at = NULL, bridge_worker_id = NULL,
           gemini_failures = 0, gemini_retry_at = NULL,
           updated_at = ? WHERE id = ? AND provider = 'gemini-web'
             AND status = ?
             AND (bridge_worker_id IS NULL OR bridge_worker_id = ?)`
        )
        .bind(appliedPrompt, note, mode === "raw" ? null : rawReply, now, body.taskId, expectedStatus, workerId)
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
      const state = kindState(body.kind,body.workerId);
      await db
        .prepare(
          `UPDATE ${state.table} SET status = ${state.queued}, progress = ${state.queuedProgress},
           bridge_claimed_at = NULL, bridge_worker_id = NULL,
           gemini_retry_at = NULL, error = ?, gemini_error_code = ?, updated_at = ? WHERE id = ?${state.guard}`
        )
        .bind(body.error || null, body.errorCode || null, now, body.taskId,...state.guardArgs)
        .run();
      return Response.json({ ok: true });
    }

    if (body.action === "defer") {
      const state = kindState(body.kind,body.workerId);
      const rawReplySql = state.rawReply ? ", gemini_raw_reply = COALESCE(?, gemini_raw_reply)" : "";
      const rawReplyArgs = state.rawReply ? [rawReplyValue(body.rawReply)] : [];
      const task = await db
        .prepare(
          `SELECT gemini_failures FROM ${state.table} WHERE id = ? AND provider = 'gemini-web'${state.guard}`
        )
        .bind(body.taskId,...state.guardArgs)
        .first<{ gemini_failures: number }>();
      if (!task) {
        return Response.json({ error: "任务已不在 Gemini 阶段" }, { status: 409 });
      }
      const failures = Number(task.gemini_failures || 0) + 1;
      const retry = geminiRetryPlan(failures, body.accountLimited === true);
      if (retry.delayMs !== null) {
        const retryAt = new Date(Date.now() + retry.delayMs).toISOString();
        await db
          .prepare(
            `UPDATE ${state.table} SET status = ${state.queued}, progress = ${state.queuedProgress},
             bridge_claimed_at = NULL, bridge_worker_id = NULL,
             gemini_failures = ?, gemini_retry_at = ?,
             error = ?${rawReplySql}, updated_at = ? WHERE id = ?${state.guard}`
          )
          .bind(
            failures,
            retryAt,
            `Gemini ${body.accountLimited ? "账号限流，稍后重试" : "任务暂时失败，先处理后续任务"}；${retry.label}后可重试（${failures}/${retry.maxFailures}）：${body.error || "页面未确认任务完成"}`,
            ...rawReplyArgs,
            now,
            body.taskId,...state.guardArgs
          )
          .run();
        return Response.json({
          ok: true,
          deferred: true,
          failures,
          maxFailures: retry.maxFailures,
          retryAt,
        });
      }
      await db
        .prepare(
          `UPDATE ${state.table} SET status = 'failed', progress = 0,
           bridge_claimed_at = NULL, bridge_worker_id = NULL,
           gemini_failures = ?, gemini_retry_at = NULL,
           error = ?${rawReplySql}, updated_at = ? WHERE id = ?${state.guard}`
        )
        .bind(
          failures,
          `${body.error || "Gemini 网页生成失败"}（后台恢复已尝试 ${retry.maxFailures} 轮）`,
          ...rawReplyArgs,
          now,
          body.taskId,...state.guardArgs
        )
        .run();
      return Response.json({
        ok: true,
        deferred: false,
        failures,
        maxFailures: retry.maxFailures,
      });
    }

    if (body.action === "retrying") {
      const state = kindState(body.kind,body.workerId);
      await db
        .prepare(
          `UPDATE ${state.table} SET status = ${state.active}, progress = ${state.activeProgress},
           bridge_claimed_at = ?, error = ?, updated_at = ?
           WHERE id = ? AND provider = 'gemini-web'${state.guard}`
        )
        .bind(
          now,
          body.error || "Gemini 页面波动，正在自动重试",
          now,
          body.taskId,...state.guardArgs
        )
        .run();
      return Response.json({ ok: true });
    }

    if (body.action === "error") {
      const state = kindState(body.kind,body.workerId);
      const rawReplySql = state.rawReply ? ", gemini_raw_reply = COALESCE(?, gemini_raw_reply)" : "";
      await db
        .prepare(
          `UPDATE ${state.table} SET status = 'failed', progress = 0,
           bridge_claimed_at = NULL, bridge_worker_id = NULL,
           error = ?${rawReplySql}, updated_at = ? WHERE id = ?${state.guard}`
        )
        .bind(body.error || "Gemini 网页生成失败", ...(state.rawReply ? [rawReplyValue(body.rawReply)] : []), now, body.taskId,...state.guardArgs)
        .run();
      return Response.json({ ok: true });
    }
    return Response.json({ error: "不支持的 Gemini Bridge 操作" }, { status: 400 });
  } catch (error) {
    return jsonError(error);
  }
}
