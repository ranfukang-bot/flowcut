import {
  audit,
  ensureLicenseSchema,
  hashToken,
  signLease,
  sessionExpiryIso,
  userUsable,
  type LicenseUserRow,
} from "../../../../lib/license";
import { getDb, jsonError } from "../../../../lib/storage";

const ALLOWED_STAGES = new Set(["gemini", "seedance"]);
const PERMIT_LIFETIME_SECONDS = 5 * 60;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      sessionToken?: string;
      fingerprintHash?: string;
      deviceName?: string;
      appVersion?: string;
      taskId?: string;
      stage?: string;
      kind?: string;
    };
    const sessionToken = String(body.sessionToken || "");
    const fingerprintHash = String(body.fingerprintHash || "");
    const taskId = String(body.taskId || "").trim().slice(0, 160);
    const stage = String(body.stage || "").trim().toLowerCase();
    const kind = String(body.kind || "standard").trim().slice(0, 64);
    if (
      !sessionToken ||
      fingerprintHash.length < 32 ||
      !taskId ||
      !ALLOWED_STAGES.has(stage)
    ) {
      return Response.json(
        { error: "任务授权参数不完整" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }

    await ensureLicenseSchema();
    const db = getDb();
    const session = await db
      .prepare(
        `SELECT s.id AS session_id, s.expires_at AS session_expires_at,
         s.revoked_at AS session_revoked_at,
         d.id AS device_id, d.fingerprint_hash, d.status AS device_status,
         u.id, u.username, u.password_salt, u.password_hash, u.status, u.expires_at,
         u.plan_code, u.max_devices, u.max_concurrent, u.offline_grace_hours,
         u.notes, u.created_at, u.updated_at
         FROM license_sessions s
         JOIN license_devices d ON d.id = s.device_id
         JOIN license_users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .bind(await hashToken(sessionToken))
      .first<LicenseUserRow & {
        session_id: string;
        session_expires_at: string;
        session_revoked_at: string | null;
        device_id: string;
        fingerprint_hash: string;
        device_status: string;
      }>();

    if (!session || session.session_revoked_at) {
      return Response.json({ error: "登录已失效，请重新登录" }, { status: 401 });
    }
    if (new Date(session.session_expires_at).getTime() <= Date.now()) {
      return Response.json({ error: "登录会话已过期，请重新登录" }, { status: 401 });
    }
    if (
      session.fingerprint_hash !== fingerprintHash ||
      session.device_status !== "active"
    ) {
      return Response.json({ error: "这台设备的授权已被撤销" }, { status: 403 });
    }
    const usable = userUsable(session);
    if (!usable.ok) {
      return Response.json({ error: usable.reason }, { status: 403 });
    }

    const now = new Date().toISOString();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const permit = await signLease({
      aud: "flowcut-execution",
      sub: session.id,
      username: session.username,
      deviceId: session.device_id,
      fingerprintHash,
      taskId,
      stage,
      kind,
      nonce: crypto.randomUUID(),
      appVersion: String(body.appVersion || "").slice(0, 32),
      iat: nowSeconds,
      nbf: nowSeconds - 5,
      exp: nowSeconds + PERMIT_LIFETIME_SECONDS,
    });

    await db.batch([
      db
        .prepare("UPDATE license_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?")
        .bind(now, sessionExpiryIso(), session.session_id),
      db
        .prepare("UPDATE license_devices SET device_name = ?, last_seen_at = ? WHERE id = ?")
        .bind(String(body.deviceName || "Windows 设备").slice(0, 120), now, session.device_id),
    ]);
    await audit("desktop", "execution_permit", session.id, {
      deviceId: session.device_id,
      taskId,
      stage,
      kind,
      appVersion: String(body.appVersion || "").slice(0, 32),
    }).catch(() => {});

    return Response.json(
      { ok: true, permit, expiresInSeconds: PERMIT_LIFETIME_SECONDS },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    await audit("desktop", "execution_permit_error", "", {
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    return jsonError(error);
  }
}
