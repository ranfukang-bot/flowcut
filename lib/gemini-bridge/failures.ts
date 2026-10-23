import { geminiRetryPlan } from "../gemini-retry";
import { kindState, rawReplyValue } from "./shared";
import type { Db, TaskBody } from "./types";

// The desktop gave a job back: released unstarted, deferred after a temporary
// failure (retried later, up to the plan's limit), being retried now, or failed.
export async function releaseJob(db: Db, body: TaskBody, now: string) {
  const state = kindState(body.kind,body.workerId,body.remixRound);
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

export async function deferJob(db: Db, body: TaskBody, now: string) {
  const state = kindState(body.kind,body.workerId,body.remixRound);
  const isRemix=body.kind==='remix-segments'||body.kind==='remix-rewrite';
  const rawReplySql = state.rawReply ? ", gemini_raw_reply = COALESCE(?, gemini_raw_reply)"+(isRemix?",remix_raw_replies=json_insert(COALESCE(remix_raw_replies,'[]'),'$[#]',json(?))":"") : "";
  const rawReplyArgs = state.rawReply ? [rawReplyValue(body.rawReply),...(isRemix?[JSON.stringify(body.rawReplies || [])]:[])] : [];
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

export async function markRetrying(db: Db, body: TaskBody, now: string) {
  const state = kindState(body.kind,body.workerId,body.remixRound);
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

export async function failJob(db: Db, body: TaskBody, now: string) {
  const state = kindState(body.kind,body.workerId,body.remixRound);
  const isRemix=body.kind==='remix-segments'||body.kind==='remix-rewrite';
  const rawReplySql = state.rawReply ? ", gemini_raw_reply = COALESCE(?, gemini_raw_reply)"+(isRemix?",remix_raw_replies=json_insert(COALESCE(remix_raw_replies,'[]'),'$[#]',json(?))":"") : "";
  await db
    .prepare(
      `UPDATE ${state.table} SET status = 'failed', progress = 0,
       bridge_claimed_at = NULL, bridge_worker_id = NULL,
       error = ?${rawReplySql}, updated_at = ? WHERE id = ?${state.guard}`
    )
    .bind(body.error || "Gemini 网页生成失败", ...(state.rawReply ? [rawReplyValue(body.rawReply),...(isRemix?[JSON.stringify(body.rawReplies || [])]:[])] : []), now, body.taskId,...state.guardArgs)
    .run();
  return Response.json({ ok: true });
}
