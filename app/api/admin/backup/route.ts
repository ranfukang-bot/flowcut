import {
  audit,
  ensureLicenseSchema,
  requireAdmin,
} from "../../../../lib/license";
import { getDb, jsonError } from "../../../../lib/storage";

type BackupUser = {
  id: string;
  username: string;
  password_salt: string;
  password_hash: string;
  status: string;
  expires_at: string | null;
  plan_code?: string;
  max_devices: number;
  max_concurrent?: number;
  offline_grace_hours: number;
  notes: string;
  created_at: string;
  updated_at: string;
};

type BackupDevice = {
  id: string;
  user_id: string;
  fingerprint_hash: string;
  device_name: string;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

type BackupPayment = {
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
};

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    await ensureLicenseSchema();
    const db = getDb();
    const [users, devices, payments] = await Promise.all([
      db.prepare("SELECT * FROM license_users ORDER BY created_at").all(),
      db.prepare("SELECT * FROM license_devices ORDER BY first_seen_at").all(),
      db.prepare("SELECT * FROM license_payments ORDER BY created_at").all(),
    ]);
    return Response.json(
      {
        format: "flowcut-license-backup",
        version: 3,
        exportedAt: new Date().toISOString(),
        users: users.results,
        devices: devices.results,
        payments: payments.results,
      },
      {
        headers: {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="flowcut-license-${new Date()
            .toISOString()
            .slice(0, 10)}.json"`,
        },
      },
    );
  } catch (error) {
    return jsonError(error, 401);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAdmin(request);
    const body = (await request.json()) as {
      backup?: {
        format?: string;
        version?: number;
        users?: BackupUser[];
        devices?: BackupDevice[];
        payments?: BackupPayment[];
      };
    };
    const backup = body.backup;
    if (
      backup?.format !== "flowcut-license-backup" ||
      ![1, 2, 3].includes(Number(backup.version)) ||
      !Array.isArray(backup.users) ||
      !Array.isArray(backup.devices)
    ) {
      return Response.json({ error: "授权备份文件格式不正确" }, { status: 400 });
    }
    const payments = Array.isArray(backup.payments) ? backup.payments : [];
    if (
      backup.users.length > 10_000 ||
      backup.devices.length > 50_000 ||
      payments.length > 100_000
    ) {
      return Response.json({ error: "授权备份数据量异常" }, { status: 400 });
    }
    await ensureLicenseSchema();
    const db = getDb();
    const existing = await db
      .prepare("SELECT COUNT(*) AS count FROM license_users")
      .first<{ count: number }>();
    if (Number(existing?.count || 0) > 0) {
      return Response.json(
        { error: "当前授权中心已有账号；为避免覆盖，只允许导入到空数据库" },
        { status: 409 },
      );
    }
    const userIds = new Set<string>();
    for (const user of backup.users) {
      if (
        !user.id ||
        !/^[a-z0-9._-]{3,40}$/.test(String(user.username || "")) ||
        !user.password_salt ||
        !user.password_hash
      ) {
        return Response.json(
          { error: "授权备份中存在无效账号记录" },
          { status: 400 },
        );
      }
      userIds.add(user.id);
    }
    if (backup.devices.some((device) => !userIds.has(device.user_id))) {
      return Response.json(
        { error: "授权备份中的设备找不到对应账号" },
        { status: 400 },
      );
    }
    for (const user of backup.users) {
      await db
        .prepare(
          `INSERT INTO license_users
           (id, username, password_salt, password_hash, status, expires_at,
            plan_code, max_devices, max_concurrent, offline_grace_hours, notes,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          user.id,
          user.username,
          user.password_salt,
          user.password_hash,
          user.status === "active" ? "active" : "suspended",
          user.expires_at || null,
          String(user.plan_code || "starter"),
          Math.max(1, Math.min(100, Number(user.max_devices || 1))),
          Math.max(0, Math.min(999, Number(user.max_concurrent || 0))),
          Math.max(
            1,
            Math.min(168, Number(user.offline_grace_hours || 24)),
          ),
          String(user.notes || "").slice(0, 500),
          user.created_at || new Date().toISOString(),
          user.updated_at || new Date().toISOString(),
        )
        .run();
    }
    for (const device of backup.devices) {
      await db
        .prepare(
          `INSERT INTO license_devices
           (id, user_id, fingerprint_hash, device_name, status, first_seen_at,
            last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          device.id,
          device.user_id,
          device.fingerprint_hash,
          String(device.device_name || "").slice(0, 120),
          device.status === "active" ? "active" : "revoked",
          device.first_seen_at || new Date().toISOString(),
          device.last_seen_at || new Date().toISOString(),
          device.revoked_at || null,
        )
        .run();
    }
    for (const payment of payments) {
      if (!userIds.has(payment.user_id)) continue;
      await db
        .prepare(
          `INSERT INTO license_payments
           (id, user_id, plan_code, months, amount_cents, currency,
            payment_method, reference, actor, period_started_at,
            period_ends_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          payment.id || crypto.randomUUID(),
          payment.user_id,
          String(payment.plan_code || "starter"),
          Math.max(1, Number(payment.months || 1)),
          Math.max(0, Number(payment.amount_cents || 0)),
          String(payment.currency || "CNY").slice(0, 8),
          String(payment.payment_method || "manual").slice(0, 30),
          String(payment.reference || "").slice(0, 200),
          String(payment.actor || actor).slice(0, 80),
          payment.period_started_at || new Date().toISOString(),
          payment.period_ends_at || new Date().toISOString(),
          payment.created_at || new Date().toISOString(),
        )
        .run();
    }
    await audit(actor, "backup_imported", "", {
      users: backup.users.length,
      devices: backup.devices.length,
      payments: payments.length,
    });
    return Response.json({
      ok: true,
      importedUsers: backup.users.length,
      importedDevices: backup.devices.length,
      importedPayments: payments.length,
    });
  } catch (error) {
    return jsonError(error);
  }
}
