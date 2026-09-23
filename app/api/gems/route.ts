import { ensureWorkspace, getDb, jsonError } from "../../../lib/storage";

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const body = (await request.json()) as {
      name?: string;
      description?: string;
      content?: string;
    };
    if (!body.name?.trim() || !body.content?.trim()) {
      return Response.json({ error: "Gem 名称和完整指令不能为空" }, { status: 400 });
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await getDb()
      .prepare(
        `INSERT INTO gems (id, name, description, content, duration, locale, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .bind(
        id,
        body.name.trim(),
        body.description?.trim() || "",
        body.content.trim(),
        15,
        "id-ID",
        now,
        now
      )
      .run();
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureWorkspace();
    const body = (await request.json()) as {
      id?: string;
      name?: string;
      description?: string;
      content?: string;
    };
    if (!body.id || !body.name?.trim() || !body.content?.trim()) {
      return Response.json({ error: "缺少 Gem 必填信息" }, { status: 400 });
    }
    await getDb()
      .prepare(
        `UPDATE gems SET name = ?, description = ?, content = ?,
         updated_at = ? WHERE id = ?`
      )
      .bind(
        body.name.trim(),
        body.description?.trim() || "",
        body.content.trim(),
        new Date().toISOString(),
        body.id
      )
      .run();
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureWorkspace();
    const { id } = (await request.json()) as { id?: string };
    if (!id) return Response.json({ error: "缺少 Gem ID" }, { status: 400 });
    await getDb().prepare("DELETE FROM gems WHERE id = ?").bind(id).run();
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
