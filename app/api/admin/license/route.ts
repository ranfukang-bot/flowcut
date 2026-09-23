import {
  audit,
  ensureLicenseSchema,
  hashPassword,
  LICENSE_PLANS,
  listLicenseUsers,
  normalizePlanCode,
  requireAdmin,
} from "../../../../lib/license";
import { getDb, jsonError } from "../../../../lib/storage";

async function overview() {
  const users = await listLicenseUsers();
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const paymentRows = await getDb()
    .prepare(
      `SELECT p.id, p.user_id, p.plan_code, p.months, p.amount_cents,
       p.currency, p.payment_method, p.reference, p.actor,
       p.period_started_at, p.period_ends_at, p.created_at,
       u.username
       FROM license_payments p
       LEFT JOIN license_users u ON u.id = p.user_id
       ORDER BY p.created_at DESC LIMIT 100`,
    )
    .all<{
      id: string;
      user_id: string;
      plan_code: string;
      months: number;
      amount_cents: number;
      currency: string;
      payment_method: string;
      reference: string;
      actor: string;
      period_started_at: string;
      period_ends_at: string;
      created_at: string;
      username: string | null;
    }>();
  const payments = paymentRows.results.map((payment) => ({
    id: payment.id,
    userId: payment.user_id,
    username: payment.username || "已删除账号",
    planCode: normalizePlanCode(payment.plan_code),
    months: payment.months,
    amountYuan: payment.amount_cents / 100,
    currency: payment.currency,
    paymentMethod: payment.payment_method,
    reference: payment.reference,
    actor: payment.actor,
    periodStartedAt: payment.period_started_at,
    periodEndsAt: payment.period_ends_at,
    createdAt: payment.created_at,
  }));
  return {
    users,
    plans: Object.values(LICENSE_PLANS),
    payments,
    generatedAt: new Date().toISOString(),
    stats: {
      totalUsers: users.length,
      activeUsers: users.filter(
        (user) =>
          user.status === "active" &&
          (!user.expiresAt || new Date(user.expiresAt).getTime() > Date.now()),
      ).length,
      activeDevices: users.reduce(
        (total, user) =>
          total + user.devices.filter((device) => device.status === "active").length,
        0,
      ),
      expiringSoon: users.filter((user) => {
        if (!user.expiresAt) return false;
        const remaining = new Date(user.expiresAt).getTime() - Date.now();
        return remaining > 0 && remaining <= 7 * 24 * 60 * 60 * 1000;
      }).length,
      currentMonthRevenueYuan: payments
        .filter((payment) => payment.createdAt.startsWith(monthPrefix))
        .reduce((total, payment) => total + payment.amountYuan, 0),
    },
  };
}

function addMonths(date: Date, months: number) {
  const result = new Date(date);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDay));
  return result;
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    return Response.json(await overview(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return jsonError(error, 401);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action || "");
    await ensureLicenseSchema();
    const db = getDb();
    const now = new Date().toISOString();

    if (action === "createUser") {
      const username = String(body.username || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
        return Response.json(
          { error: "账号需为 3–40 位小写字母、数字、点、横线或下划线" },
          { status: 400 },
        );
      }
      const credentials = await hashPassword(password);
      const id = crypto.randomUUID();
      const planCode = normalizePlanCode(body.planCode);
      const plan = LICENSE_PLANS[planCode];
      const maxConcurrent = Math.max(
        1,
        Math.min(999, Number(body.maxConcurrent || plan.maxConcurrent)),
      );
      await db
        .prepare(
          `INSERT INTO license_users
           (id, username, password_salt, password_hash, status, expires_at, plan_code,
            max_devices, max_concurrent, offline_grace_hours, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          username,
          credentials.salt,
          credentials.hash,
          body.expiresAt ? new Date(String(body.expiresAt)).toISOString() : null,
          planCode,
          Math.max(
            1,
            Math.min(100, Number(body.maxDevices || plan.maxDevices)),
          ),
          maxConcurrent,
          Math.max(1, Math.min(168, Number(body.offlineGraceHours || 24))),
          String(body.notes || "").slice(0, 500),
          now,
          now,
        )
        .run();
      await audit(actor, "user_created", id, {
        username,
        planCode,
        maxConcurrent,
      });
    } else if (action === "updateUser") {
      const id = String(body.userId || "");
      const status = body.status === "suspended" ? "suspended" : "active";
      const planCode = normalizePlanCode(body.planCode);
      const plan = LICENSE_PLANS[planCode];
      const maxConcurrent = Math.max(
        1,
        Math.min(999, Number(body.maxConcurrent || plan.maxConcurrent)),
      );
      await db
        .prepare(
          `UPDATE license_users SET status = ?, expires_at = ?, plan_code = ?, max_devices = ?,
           max_concurrent = ?, offline_grace_hours = ?, notes = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(
          status,
          body.expiresAt ? new Date(String(body.expiresAt)).toISOString() : null,
          planCode,
          Math.max(1, Math.min(100, Number(body.maxDevices || plan.maxDevices))),
          maxConcurrent,
          Math.max(1, Math.min(168, Number(body.offlineGraceHours || 24))),
          String(body.notes || "").slice(0, 500),
          now,
          id,
        )
        .run();
      if (status === "suspended") {
        await db
          .prepare("UPDATE license_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
          .bind(now, id)
          .run();
      }
      await audit(actor, "user_updated", id, {
        status,
        planCode,
        maxConcurrent,
      });
    } else if (action === "renewUser") {
      const id = String(body.userId || "");
      const months = [1, 3, 12].includes(Number(body.months))
        ? Number(body.months)
        : 1;
      const user = await db
        .prepare(
          `SELECT username, expires_at, plan_code, max_devices, max_concurrent
           FROM license_users WHERE id = ?`,
        )
        .bind(id)
        .first<{
          username: string;
          expires_at: string | null;
          plan_code: string;
          max_devices: number;
          max_concurrent: number;
        }>();
      if (!user) {
        return Response.json({ error: "账号不存在或已被删除" }, { status: 404 });
      }
      const planCode = normalizePlanCode(body.planCode || user.plan_code);
      const plan = LICENSE_PLANS[planCode];
      const currentExpiry = user.expires_at
        ? new Date(user.expires_at)
        : new Date(0);
      const periodStartedAt =
        currentExpiry.getTime() > Date.now() ? currentExpiry : new Date();
      const periodEndsAt = addMonths(periodStartedAt, months);
      const termPrices = plan.termPrices as Record<number, number>;
      const suggestedAmount = Number(termPrices[months] ?? plan.monthlyPriceYuan * months);
      const amountYuan = Math.max(
        0,
        Math.min(1_000_000, Number(body.amountYuan ?? suggestedAmount)),
      );
      const paymentMethod = ["wechat", "alipay", "bank", "cash", "other"].includes(
        String(body.paymentMethod || ""),
      )
        ? String(body.paymentMethod)
        : "manual";
      const renewedMaxDevices =
        planCode === "custom"
          ? Math.max(1, Math.min(100, Number(user.max_devices || 1)))
          : plan.maxDevices;
      const renewedMaxConcurrent =
        planCode === "custom"
          ? Math.max(1, Math.min(999, Number(user.max_concurrent || 1)))
          : plan.maxConcurrent;
      await db.batch([
        db
          .prepare(
            `UPDATE license_users
             SET status = 'active', expires_at = ?, plan_code = ?,
             max_devices = ?, max_concurrent = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(
            periodEndsAt.toISOString(),
            planCode,
            renewedMaxDevices,
            renewedMaxConcurrent,
            now,
            id,
          ),
        db
          .prepare(
            `INSERT INTO license_payments
             (id, user_id, plan_code, months, amount_cents, currency,
              payment_method, reference, actor, period_started_at,
              period_ends_at, created_at)
             VALUES (?, ?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            id,
            planCode,
            months,
            Math.round(amountYuan * 100),
            paymentMethod,
            String(body.reference || "").slice(0, 200),
            actor,
            periodStartedAt.toISOString(),
            periodEndsAt.toISOString(),
            now,
          ),
      ]);
      await audit(actor, "user_renewed", id, {
        username: user.username,
        planCode,
        months,
        amountYuan,
        periodEndsAt: periodEndsAt.toISOString(),
      });
    } else if (action === "resetPassword") {
      const id = String(body.userId || "");
      const credentials = await hashPassword(String(body.password || ""));
      await db
        .prepare(
          "UPDATE license_users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?",
        )
        .bind(credentials.salt, credentials.hash, now, id)
        .run();
      await db
        .prepare("UPDATE license_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .bind(now, id)
        .run();
      await audit(actor, "password_reset", id);
    } else if (action === "deleteUser") {
      const id = String(body.userId || "");
      const user = await db
        .prepare("SELECT username FROM license_users WHERE id = ?")
        .bind(id)
        .first<{ username: string }>();
      if (!user) {
        return Response.json({ error: "账号不存在或已被删除" }, { status: 404 });
      }
      await db.batch([
        db.prepare("DELETE FROM license_sessions WHERE user_id = ?").bind(id),
        db.prepare("DELETE FROM license_devices WHERE user_id = ?").bind(id),
        db.prepare("DELETE FROM license_audit_logs WHERE target_id = ?").bind(id),
        db.prepare("DELETE FROM license_users WHERE id = ?").bind(id),
      ]);
      await audit(actor, "user_deleted", id, { username: user.username });
    } else if (action === "revokeDevice") {
      const deviceId = String(body.deviceId || "");
      const device = await db
        .prepare("SELECT user_id FROM license_devices WHERE id = ?")
        .bind(deviceId)
        .first<{ user_id: string }>();
      await db.batch([
        db
          .prepare(
            "UPDATE license_devices SET status = 'revoked', revoked_at = ? WHERE id = ?",
          )
          .bind(now, deviceId),
        db
          .prepare(
            "UPDATE license_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
          )
          .bind(now, deviceId),
      ]);
      await audit(actor, "device_revoked", device?.user_id || "", { deviceId });
    } else if (action === "allowDevice") {
      const deviceId = String(body.deviceId || "");
      await db
        .prepare(
          "UPDATE license_devices SET status = 'active', revoked_at = NULL, last_seen_at = ? WHERE id = ?",
        )
        .bind(now, deviceId)
        .run();
      await audit(actor, "device_allowed", "", { deviceId });
    } else if (action === "removeDevice") {
      const deviceId = String(body.deviceId || "");
      await db.batch([
        db.prepare("DELETE FROM license_sessions WHERE device_id = ?").bind(deviceId),
        db.prepare("DELETE FROM license_devices WHERE id = ?").bind(deviceId),
      ]);
      await audit(actor, "device_removed", "", { deviceId });
    } else {
      return Response.json({ error: "未知的管理操作" }, { status: 400 });
    }
    return Response.json({ ok: true, ...(await overview()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /UNIQUE constraint/i.test(message) ? 409 : /管理员/.test(message) ? 401 : 500;
    return jsonError(error, status);
  }
}
