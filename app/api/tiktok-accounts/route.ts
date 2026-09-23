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
    const body = await request.json() as { id?: string; archiveDirectory?: string };
    const directory = validateArchiveDirectory(body.archiveDirectory);
    if (!body.id || !directory) return Response.json({ error: "请选择账号和保存文件夹" }, { status: 400 });
    const found = await getDb().prepare("SELECT id FROM tiktok_accounts WHERE id = ?").bind(body.id).first();
    if (!found) return Response.json({ error: "归档账号不存在" }, { status: 404 });
    await getDb().prepare("UPDATE tiktok_accounts SET archive_directory = ? WHERE id = ?").bind(directory, body.id).run();
    return Response.json({ ok: true });
  } catch (error) { return jsonError(error, 400); }
}
