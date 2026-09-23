import {
  ensureWorkspace,
  getDb,
  jsonError,
} from "../../../lib/storage";
import { validateTikTokAccountName, validateArchiveDirectory } from "../../../lib/tiktok-accounts";

export async function GET() {
  try {
    await ensureWorkspace();
    const accounts = await getDb()
      .prepare("SELECT * FROM tiktok_accounts ORDER BY created_at ASC")
      .all();
    return Response.json({ accounts: accounts.results });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureWorkspace();
    const body = (await request.json()) as { name?: string; archiveDirectory?: string };
    const name = validateTikTokAccountName(body.name);
    const archiveDirectory = validateArchiveDirectory(body.archiveDirectory);
    const db = getDb();
    const duplicate = await db
      .prepare("SELECT id FROM tiktok_accounts WHERE lower(name) = lower(?)")
      .bind(name)
      .first<{ id: string }>();
    if (duplicate) {
      return Response.json(
        { error: "这个 TK 账号名已经存在" },
        { status: 409 }
      );
    }
    const account = {
      id: crypto.randomUUID(),
      name,
      archive_directory: archiveDirectory,
      created_at: new Date().toISOString(),
    };
    await db
      .prepare(
        "INSERT INTO tiktok_accounts (id, name, archive_directory, created_at) VALUES (?, ?, ?, ?)"
      )
      .bind(account.id, account.name, account.archive_directory, account.created_at)
      .run();
    return Response.json(account, { status: 201 });
  } catch (error) {
    return jsonError(error, error instanceof Error ? 400 : 500);
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureWorkspace();
    const body = (await request.json()) as { id?: string };
    if (!body.id) {
      return Response.json({ error: "缺少 TK 账号 ID" }, { status: 400 });
    }
    await getDb()
      .prepare("DELETE FROM tiktok_accounts WHERE id = ?")
      .bind(body.id)
      .run();
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request) {
  try {
    await ensureWorkspace();
    const body = await request.json() as { id?: string; name?: string; archiveDirectory?: string };
    if (!body.id) return Response.json({ error: "请选择归档账号" }, { status: 400 });
    const db = getDb();
    const found = await db.prepare("SELECT * FROM tiktok_accounts WHERE id = ?").bind(body.id)
      .first<{ id: string; name: string; archive_directory: string }>();
    if (!found) return Response.json({ error: "归档账号不存在" }, { status: 404 });
    const name = body.name === undefined ? found.name : validateTikTokAccountName(body.name);
    const directory = body.archiveDirectory === undefined ? found.archive_directory : validateArchiveDirectory(body.archiveDirectory);
    const duplicate = await db.prepare("SELECT id FROM tiktok_accounts WHERE lower(name) = lower(?) AND id <> ?")
      .bind(name, body.id).first();
    if (duplicate) return Response.json({ error: "这个 TK 账号名已经存在" }, { status: 409 });
    // Existing tasks own their name/path snapshots. Editing this directory entry
    // must not move files or redirect any queued or completed task.
    await db.prepare("UPDATE tiktok_accounts SET name = ?, archive_directory = ? WHERE id = ?")
      .bind(name, directory, body.id).run();
    return Response.json({ ok: true });
  } catch (error) { return jsonError(error, 400); }
}
