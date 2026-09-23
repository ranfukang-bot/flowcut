import { ensureWorkspace, getDb, jsonError } from "../../../../lib/storage";

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const token = new URL(request.url).searchParams.get("token");
    const body = (await request.json()) as {
      taskId?: string;
      task_id?: string;
      status?: "processing" | "completed" | "failed";
      progress?: number;
      outputUrl?: string;
      output_url?: string;
      video_url?: string;
      error?: string;
    };
    const taskId = body.taskId || body.task_id;
    if (!taskId || !token) {
      return Response.json({ error: "缺少回调身份信息" }, { status: 400 });
    }
    const task = await getDb()
      .prepare("SELECT callback_token FROM tasks WHERE id = ?")
      .bind(taskId)
      .first<{ callback_token?: string }>();
    if (!task || task.callback_token !== token) {
      return Response.json({ error: "无效的回调令牌" }, { status: 403 });
    }
    const status =
      body.status === "completed"
        ? "video_ready"
        : body.status === "failed"
          ? "failed"
          : "video_generating";
    const outputUrl = body.outputUrl || body.output_url || body.video_url || null;
    await getDb()
      .prepare(
        `UPDATE tasks SET status = ?, progress = ?, output_url = ?, error = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(
        status,
        body.progress ?? (status === "video_ready" ? 100 : 68),
        outputUrl,
        body.error || null,
        new Date().toISOString(),
        taskId
      )
      .run();
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
