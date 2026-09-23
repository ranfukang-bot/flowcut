import {
  audit,
  checkLoginThrottle,
  clearLoginFailures,
  ensureLicenseSchema,
  hashToken,
  issueLease,
  randomToken,
  recordLoginFailure,
  sessionExpiryIso,
  userUsable,
  verifyPassword,
  type LicenseUserRow,
} from "../../../../lib/license";
import { getDb, jsonError } from "../../../../lib/storage";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      username?: string;
      password?: string;
      fingerprintHash?: string;
      deviceName?: string;
      appVersion?: string;
    };
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    const fingerprintHash = String(body.fingerprintHash || "").trim();
    const deviceName = String(body.deviceName || "").trim().slice(0, 120);
    if (!username || !password || fingerprintHash.length < 32) {
      return Response.json({ error: "账号、密码或设备信息不完整" }, { status: 400 });
    }

    await ensureLicenseSchema();
    const throttle = await checkLoginThrottle(request, "desktop", username);
    if (!throttle.allowed) {
      return Response.json(
        { error: "登录失败次数过多，请稍后再试" },
        {
          status: 429,
          headers: {
            "retry-after": String(throttle.retryAfterSeconds),
            "cache-control": "no-store",
          },
        },
      );
    }
    const db = getDb();
    const user = await db
      .prepare("SELECT * FROM license_users WHERE username = ?")
      .bind(username)
      .first<LicenseUserRow>();
    if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash))) {
      await recordLoginFailure(request, "desktop", username);
      await audit("desktop", "login_failed", user?.id || "", { username });
      return Response.json({ error: "账号或密码错误" }, { status: 401 });
    }
    await clearLoginFailures(request, "desktop", username);
    const usable = userUsable(user);
    if (!usable.ok) {
      await audit("desktop", "login_rejected", user.id, { reason: usable.reason });
      return Response.json({ error: usable.reason }, { status: 403 });
    }

    const now = new Date().toISOString();
    let device = await db
      .prepare(
        "SELECT id, status FROM license_devices WHERE user_id = ? AND fingerprint_hash = ?",
      )
      .bind(user.id, fingerprintHash)
      .first<{ id: string; status: string }>();
    if (device?.status === "revoked") {
      return Response.json(
        { error: "这台设备的授权已被管理员撤销，请联系管理员重新授权" },
        { status: 403 },
      );
    }
    if (!device) {
      const active = await db
        .prepare(
          "SELECT COUNT(*) AS count FROM license_devices WHERE user_id = ? AND status = 'active'",
        )
        .bind(user.id)
        .first<{ count: number }>();
      if (Number(active?.count || 0) >= Math.max(1, user.max_devices)) {
        return Response.json(
          { error: `该账号最多允许 ${user.max_devices} 台设备，请联系管理员解绑旧设备` },
          { status: 409 },
        );
      }
      device = { id: crypto.randomUUID(), status: "active" };
      await db
        .prepare(
          `INSERT INTO license_devices
           (id, user_id, fingerprint_hash, device_name, status, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        )
        .bind(device.id, user.id, fingerprintHash, deviceName || "Windows 设备", now, now)
        .run();
    } else {
      await db
        .prepare("UPDATE license_devices SET device_name = ?, last_seen_at = ? WHERE id = ?")
        .bind(deviceName || "Windows 设备", now, device.id)
        .run();
    }

    const sessionToken = randomToken();
    await db
      .prepare(
        `INSERT INTO license_sessions
         (id, user_id, device_id, token_hash, expires_at, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        user.id,
        device.id,
        await hashToken(sessionToken),
        sessionExpiryIso(),
        now,
        now,
      )
      .run();
    const lease = await issueLease(user, device.id);
    await audit("desktop", "login_success", user.id, {
      deviceId: device.id,
      deviceName,
      appVersion: String(body.appVersion || ""),
    });
    return Response.json(
      {
        ok: true,
        sessionToken,
        lease,
        account: {
          username: user.username,
          expiresAt: user.expires_at,
          planCode: user.plan_code,
          offlineGraceHours: user.offline_grace_hours,
          deviceId: device.id,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
