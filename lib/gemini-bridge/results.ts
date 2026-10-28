import { getProviderConfig } from "../provider-config";
import { splitPromptBlocks, type PromptBlockMode } from "../prompt-blocks";
import { clipInsertStatements, clipStart, clipTaskId } from "../task-batches";
import { GEMINI_STATUSES } from '../task-statuses';
import { rawReplyValue } from "./shared";
import { queueReferenceRemixSeedance, queueSeedance } from "./seedance-queue";
import type { Db, TaskBody } from "./types";

// A finished Gemini reply, written back to its task. `prompt` is the trimmed
// reply, already checked to be at least 300 characters.

export async function applyScriptResult(db: Db, body: TaskBody, now: string) {
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

export async function applyRemixResult(db: Db, body: TaskBody, now: string, prompt: string) {
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

// Product tasks: plain, two-round variant, code-block split and multi-product fission.
export async function applyPromptResult(db: Db, body: TaskBody, now: string, prompt: string, requestUrl: string) {
  const task = await db
    .prepare(
      `SELECT auto_queue, status, provider, prompt, bridge_worker_id, duration, task_role, prompt_batch_id, prompt_variant_count,
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
      prompt_batch_id: string | null;
      prompt_variant_count: number | null;
    }>();
  if (!task) {
    return Response.json(
      { error: "任务不存在，忽略过期结果", ignorable: true },
      { status: 409 }
    );
  }
  if (task.task_role === 'prompt_item') {
    let text: string;
    try { text = splitPromptBlocks({ text: prompt, mode: 'single' }).prompts[0]; }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : '提示词不完整' }, { status: 400 }); }
    if (task.status === 'prompt_ready' && task.prompt === text) return Response.json({ ok: true, alreadyApplied: true });
    if (body.kind && body.kind !== 'standard') return Response.json({ error: '提示词领取类型已失效', ignorable: true }, { status: 409 });
    if (!body.workerId) return Response.json({ error: '缺少提示词执行器标识', ignorable: true }, { status: 409 });
    const result = await db.prepare(`UPDATE tasks SET prompt=?,gemini_raw_reply=?,status='prompt_ready',progress=100,
      error=NULL,bridge_claimed_at=NULL,bridge_worker_id=NULL,gemini_failures=0,gemini_retry_at=NULL,updated_at=?
      WHERE id=? AND task_role='prompt_item' AND status='prompt_generating' AND provider='gemini-web' AND bridge_worker_id=?`)
      .bind(text, rawReplyValue(String(body.rawReply || prompt)), now, body.taskId, body.workerId).run();
    return result.meta.changes ? Response.json({ ok: true, promptReady: true })
      : Response.json({ error: '提示词领取已失效，忽略过期结果', ignorable: true }, { status: 409 });
  }
  const variantRound = body.kind === "variant";
  const expectedStatus = variantRound ? "variant_generating" : "prompt_generating";
  const fissionChild=task.task_role==='fission_child';
  const fissionMother=task.task_role==='fission';
  const mode: PromptBlockMode = fissionChild ? 'single' : variantRound ? "split" : task.prompt_batch_id ? 'single' : Number(task.duration) === 30 ? "raw" : task.variant_mode ? "single" : "split";
  let parsed;
  let notes: string[] | undefined;
  try {
    let blocks = body.codeBlocks;
    if(task.prompt_batch_id && task.task_role==='group' && variantRound) {
      if(!Array.isArray(blocks) || blocks.length!==task.prompt_variant_count) throw Error('PROMPT_BLOCKS_INVALID：代码块数必须等于 '+task.prompt_variant_count);
      notes=[];
      blocks=blocks.map(value=>{const lines=String(value).trim().split(/\r?\n/);const match=lines[0].match(/^裂变第\s*\d+\s*条\s*[｜|]\s*开头[：:]\s*(.+)$/);notes!.push(match?.[1]?.trim() || '');return match?lines.slice(1).join('\n').trim():String(value);});
    }
    parsed = splitPromptBlocks({ text: prompt, blocks, hint: body.codeBlockHint === true, mode });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "代码块校验失败", code: "PROMPT_BLOCKS_INVALID" }, { status: 400 });
  }
  const split = !fissionChild && (parsed.prompts.length > 1 || variantRound);
  const appliedPrompt = split ? prompt : parsed.prompts[0];
  if (
    String(task.prompt || "").trim() === appliedPrompt &&
    !GEMINI_STATUSES.includes(task.status)
  ) {
    return Response.json({ ok: true, alreadyApplied: true });
  }
  if (
    task.provider !== "gemini-web" ||
    task.status !== expectedStatus ||
    ((fissionChild || fissionMother) && (task.bridge_worker_id !== body.workerId || !body.workerId || variantRound !== fissionChild)) ||
    (task.prompt_batch_id && (!body.workerId || task.bridge_worker_id !== body.workerId)) ||
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
    const start = clipStart(!task.prompt_batch_id && Boolean(task.auto_queue), { mode: seedance.config.mode, secretConfigured: seedance.secretConfigured });
    const latest = await db
      .prepare("SELECT COALESCE(MAX(batch_round), 0) AS round FROM tasks WHERE batch_parent_id = ?")
      .bind(body.taskId)
      .first<{ round: number }>();
    const round = Number(latest?.round || 0) + 1;
    const results = await db.batch([
      ...clipInsertStatements(db, { groupId: body.taskId, round, prompts: parsed.prompts, notes, start, expectedStatus, workerId, now }),
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
    if (start.status === "prompt_ready" && task.auto_queue && !task.prompt_batch_id) {
      for (let index = 1; index <= parsed.prompts.length; index += 1) {
        const clipId = clipTaskId(body.taskId, round, index);
        try {
          await queueSeedance(clipId, requestUrl);
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
       status = 'prompt_ready', progress = CASE WHEN COALESCE(prompt_batch_id,'')<>'' THEN 100 ELSE 32 END,
       auto_queue = CASE WHEN COALESCE(prompt_batch_id,'')<>'' THEN 0 ELSE auto_queue END,
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
  if (task.auto_queue && !task.prompt_batch_id) {
    try {
      await queueSeedance(body.taskId, requestUrl);
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
