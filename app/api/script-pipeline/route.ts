import { ensureWorkspace, getDb, jsonError } from "../../../lib/storage";

const ACTIVE_STATUSES = [
  "rewrite_queued",
  "rewriting",
  "extracting",
  "storyboarding",
  "grouping",
  "optimization_queued",
  "optimizing",
];

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const body = (await request.json()) as {
      title?: string;
      sourceScript?: string;
      projectContext?: string;
      geminiAccountId?: string;
    };
    const sourceScript = String(body.sourceScript || "").trim();
    if (sourceScript.length < 30) {
      return Response.json({ error: "请粘贴完整剧本，至少 30 个字" }, { status: 400 });
    }
    if (sourceScript.length > 180_000) {
      return Response.json({ error: "单次剧本不能超过 18 万字，请按集拆分后提交" }, { status: 400 });
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const fallbackTitle = sourceScript.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 48);
    const title = String(body.title || fallbackTitle || "未命名剧本").trim().slice(0, 80);
    await getDb()
      .prepare(
        `INSERT INTO script_pipeline_tasks (
          id, title, status, progress, source_script, project_context,
          gemini_account_id, provider, created_at, updated_at
        ) VALUES (?, ?, 'rewrite_queued', 5, ?, ?, ?, 'gemini-web', ?, ?)`
      )
      .bind(
        id,
        title,
        sourceScript,
        String(body.projectContext || "").trim().slice(0, 30_000),
        String(body.geminiAccountId || "").trim() || null,
        now,
        now
      )
      .run();
    return Response.json({ id, status: "rewrite_queued" }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureWorkspace();
    const body = (await request.json()) as { id?: string; action?: "retry" | "retry_optimization" };
    if (!body.id || !["retry", "retry_optimization"].includes(String(body.action))) {
      return Response.json({ error: "缺少任务或操作参数" }, { status: 400 });
    }
    const now = new Date().toISOString();
    if (body.action === "retry_optimization") {
      const task = await getDb()
        .prepare(
          `SELECT status, raw_groups_json, optimized_groups_json, bridge_claimed_at
           FROM script_pipeline_tasks WHERE id = ?`
        )
        .bind(body.id)
        .first<{
          status: string;
          raw_groups_json: string;
          optimized_groups_json: string;
          bridge_claimed_at?: string | null;
        }>();
      if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });
      if (task.status === "completed") {
        return Response.json({ ok: true, alreadyCompleted: true });
      }
      if (["optimization_queued", "optimizing"].includes(task.status)) {
        return Response.json({ ok: true, alreadyRunning: true });
      }
      let reusableGroups: unknown[] = [];
      try {
        reusableGroups = JSON.parse(task.raw_groups_json || "[]");
      } catch {
        reusableGroups = [];
      }
      if (!Array.isArray(reusableGroups) || !reusableGroups.length) {
        return Response.json({ error: "任务还没有可重用的分镜组合，请从头重试" }, { status: 409 });
      }
      const result = await getDb()
        .prepare(
          `UPDATE script_pipeline_tasks SET status = 'optimization_queued', progress = 72,
           optimized_groups_json = '[]', bridge_claimed_at = NULL, bridge_worker_id = NULL,
           gemini_failures = 0, gemini_retry_at = NULL, error = NULL, updated_at = ?
           WHERE id = ? AND status = 'failed'`
        )
        .bind(now, body.id)
        .run();
      if (!result.meta.changes) {
        return Response.json({ ok: true, alreadyRunning: true });
      }
      return Response.json({ ok: true });
    }
    const result = await getDb()
      .prepare(
        `UPDATE script_pipeline_tasks SET
         status = CASE
           WHEN raw_groups_json <> '[]' THEN 'optimization_queued'
           WHEN storyboard_json <> '' THEN 'grouping'
           WHEN extraction_json <> '' THEN 'storyboarding'
           WHEN rewritten_script <> '' THEN 'extracting'
           ELSE 'rewrite_queued'
         END,
         progress = CASE
           WHEN raw_groups_json <> '[]' THEN 72
           WHEN storyboard_json <> '' THEN 66
           WHEN extraction_json <> '' THEN 48
           WHEN rewritten_script <> '' THEN 30
           ELSE 5
         END,
         optimized_groups_json = '[]',
         bridge_claimed_at = NULL, bridge_worker_id = NULL,
         gemini_failures = 0, gemini_retry_at = NULL, error = NULL, updated_at = ?
         WHERE id = ? AND status = 'failed'`
      )
      .bind(now, body.id)
      .run();
    if (!result.meta.changes) {
      const task = await getDb()
        .prepare("SELECT status FROM script_pipeline_tasks WHERE id = ?")
        .bind(body.id)
        .first<{ status: string }>();
      if (!task) return Response.json({ error: "任务不存在" }, { status: 404 });
      return Response.json({ ok: true, alreadyRunning: task.status !== "completed", alreadyCompleted: task.status === "completed" });
    }
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureWorkspace();
    const body = (await request.json()) as { id?: string };
    if (!body.id) return Response.json({ error: "缺少任务 ID" }, { status: 400 });
    const task = await getDb()
      .prepare("SELECT status FROM script_pipeline_tasks WHERE id = ?")
      .bind(body.id)
      .first<{ status: string }>();
    if (!task) return Response.json({ ok: true });
    if (ACTIVE_STATUSES.includes(task.status) && task.status !== "rewrite_queued") {
      return Response.json({ error: "任务正在由 Gemini 处理，请等待完成或失败后再删除" }, { status: 409 });
    }
    await getDb().prepare("DELETE FROM script_pipeline_tasks WHERE id = ?").bind(body.id).run();
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
