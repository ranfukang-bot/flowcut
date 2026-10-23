import { kindState } from "./shared";
import type { BridgeBody, Db, TaskBody } from "./types";

// Heartbeat, actual-model record and intermediate stages of the two-round kinds.
export async function recordHeartbeat(db: Db, body: BridgeBody, now: string) {
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
           AND status IN ('prompt_generating', 'variant_generating','remix_analyzing','remix_adapting','remix_rewriting')`
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

export async function recordModel(db: Db, body: TaskBody, now: string) {
  const info = body.modelInfo;
  if (!info || !String(info.model || '').trim() || String(info.model).length > 200 || String(info.thinking || '').length > 160) return Response.json({ error: '实际模型记录无效' }, { status: 400 });
  const table = kindState(body.kind).table;
  const updated = await db.prepare(`UPDATE ${table} SET gemini_model_info = ?, gemini_error_code = NULL, updated_at = ? WHERE id = ? AND bridge_worker_id = ? AND bridge_claimed_at IS NOT NULL`)
    .bind(JSON.stringify({ model: info.model, thinking: info.thinking || null, checkedAt: now, elapsedMs: Math.max(0, Number(info.elapsedMs) || 0) }), now, body.taskId, body.workerId).run();
  if (!updated.meta.changes) return Response.json({ error: '任务领取已失效，禁止发送', ignorable: true }, { status: 409 });
  return Response.json({ ok: true });
}

export async function recordRemixAnalysis(db: Db, body: TaskBody, now: string) {
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

export async function recordScriptStage(db: Db, body: TaskBody, now: string) {
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
