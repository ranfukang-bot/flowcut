import { ensureLicenseSchema, hashToken } from "../../../../lib/license";
import { getDb, jsonError } from "../../../../lib/storage";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { sessionToken?: string };
    const sessionToken = String(body.sessionToken || "");
    if (sessionToken) {
      await ensureLicenseSchema();
      await getDb()
        .prepare("UPDATE license_sessions SET revoked_at = ? WHERE token_hash = ?")
        .bind(new Date().toISOString(), await hashToken(sessionToken))
        .run();
    }
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
