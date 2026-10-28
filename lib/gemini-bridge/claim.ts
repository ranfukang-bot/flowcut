import { claimRemixTask, pendingRemixSegments } from './remix-segments';
import { buildSavedGemPrompt } from "../gemini";
import { buildGemRequest } from '../gem-request';
import { requestSpokenLanguage } from '../spoken-language';
import { chooseGeminiAccount, availableGemAccounts } from "../gemini-account-routing";
import { buildReferenceAdaptationPrompt, buildReferenceAnalysisPrompt } from "../reference-remix";
import { buildRewritePrompt } from "../script-pipeline";
import { ensureWorkspace, getDb, jsonError } from "../storage";
import { renderVariantRequest, type PromptBlockMode } from "../prompt-blocks";
import { authorize, mediaUrl, type GeminiKind } from "./shared";

// GET /api/gemini-bridge: the desktop asks for work. Pick the oldest waiting
// task of every kind, claim it for one idle account and describe the job.
export async function claimGeminiJobs(request: Request) {
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
                t.task_role, t.prompt_batch_id, t.duration, t.region, t.shooting_style, t.gemini_request_text, t.image_keys_snapshot, t.gem_id, g.name AS gem_name,
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
        task_role: string | null;
        prompt_batch_id: string | null;
      }>();

    // Second round of a two-round task: the mother prompt (saved as the
    // group's prompt) goes to the variant Gem together with the same images.
    const variantPending = await db
      .prepare(
        `SELECT t.id, t.product_id, t.gemini_account_id, t.created_at, COALESCE(t.gemini_retry_at, t.created_at) AS queue_at,
                CASE WHEN t.task_role='fission_child' THEN parent.prompt ELSE t.prompt END AS mother_prompt, t.task_role, t.prompt_batch_id, t.variant_request_text, t.image_keys_snapshot,
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
        prompt_batch_id: string | null;
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

    const remixSegmentPending = await pendingRemixSegments(db, staleBefore, retryReadyAt);

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
      remix?: unknown;
    }> = [];
    const candidates = [
      ...pending.results.map((task) => ({ kind: "standard" as const, task })),
      ...variantPending.results.map((task) => ({ kind: "variant" as const, task })),
      ...remixPending.results.map((task) => ({ kind: "reference-remix" as const, task })),
      ...scriptPending.results.map((task) => ({ kind: "script-pipeline" as const, task })),
      ...remixSegmentPending.map((task) => ({ kind: "remix-segments" as const, task })),
    ].sort((left, right) => left.task.queue_at.localeCompare(right.task.queue_at));
    for (const queued of candidates) {
      if(blockedTaskIds.has(queued.task.id))continue;
      if (jobs.length >= capacity) break;
      if (queued.kind === "remix-segments") {
        // Segmented remix groups take their turn by queue time like every other kind.
        const job = await claimRemixTask(db, queued.task, { requestUrl: request.url, workerId, staleBefore, now: retryReadyAt, accounts: availableAccounts, blocked: blockedGemVersions });
        if (job) jobs.push(job);
        continue;
      }
      const candidate = queued;
      const task = candidate.task;
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
          blockMode: standardTask.prompt_batch_id ? 'single' : Number(standardTask.duration) === 30 ? "raw" : standardTask.variant_mode ? "single" : "split",
          gem: { id: standardTask.gem_id || `snapshot-${standardTask.id}`, name: standardTask.gem_name || "历史任务 Gem", content: standardTask.content },
          prompt: standardTask.prompt_batch_id ? (standardTask.gemini_request_text ?? '') : buildSavedGemPrompt(standardTask),
          spokenLanguage: requestSpokenLanguage(standardTask.prompt_batch_id ? (standardTask.gemini_request_text ?? '') : buildSavedGemPrompt(standardTask),standardTask.region),
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
          blockMode: (variantTask.prompt_batch_id || variantTask.task_role==='fission_child') ? "single" : "split",
          gem: { id: variantTask.gem_id, name: variantTask.gem_name, content: variantTask.content },
          prompt: renderVariantRequest(variantTask.prompt_batch_id ? (variantTask.variant_request_text || "") : buildGemRequest(variantTask.variant_request_text || "",{duration:variantTask.duration,region:variantTask.region,shooting_style:variantTask.shooting_style,spoken_language:requestSpokenLanguage(variantTask.gemini_request_text || '',variantTask.region)}), variantTask.mother_prompt),
          spokenLanguage: requestSpokenLanguage((variantTask.prompt_batch_id ? variantTask.variant_request_text : variantTask.gemini_request_text) || '',variantTask.region),
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
