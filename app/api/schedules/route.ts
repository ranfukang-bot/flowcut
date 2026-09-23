import { ensureWorkspace, getDb, jsonError } from "../../../lib/storage";

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const body = (await request.json()) as {
      taskId?: string;
      accountName?: string;
      scheduledAt?: string;
      caption?: string;
    };
    if (!body.taskId || !body.accountName || !body.scheduledAt) {
      return Response.json({ error: "请填写任务、账号和发布时间" }, { status: 400 });
    }
    const id = crypto.randomUUID();
    await getDb()
      .prepare(
        `INSERT INTO schedules (id, task_id, account_name, scheduled_at, caption, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'scheduled', ?)`
      )
      .bind(
        id,
        body.taskId,
        body.accountName,
        body.scheduledAt,
        body.caption || "",
        new Date().toISOString()
      )
      .run();
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureWorkspace();
    const { id } = (await request.json()) as { id?: string };
    await getDb().prepare("DELETE FROM schedules WHERE id = ?").bind(id || "").run();
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
