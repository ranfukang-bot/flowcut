import { getDb, runtimeEnv } from "./storage";

const encoder = new TextEncoder();
// Cloudflare Workers Web Crypto currently caps PBKDF2 at 100,000 rounds.
const PASSWORD_ITERATIONS = 100_000;
const SESSION_DAYS = 30;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 30 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;

type LicenseUserRow = {
  id: string;
  username: string;
  password_salt: string;
  password_hash: string;
  status: string;
  expires_at: string | null;
  plan_code: string;
  max_devices: number;
  max_concurrent: number;
  offline_grace_hours: number;
  notes: string;
  created_at: string;
  updated_at: string;
};

export const LICENSE_PLANS = {
  trial: {
    code: "trial",
    name: "7天体验版",
    monthlyPriceYuan: 0,
    maxDevices: 1,
    maxConcurrent: 1,
    termPrices: { 1: 0, 3: 0, 12: 0 },
  },
  starter: {
    code: "starter",
    name: "基础版",
    monthlyPriceYuan: 299,
    maxDevices: 1,
    maxConcurrent: 3,
    termPrices: { 1: 299, 3: 799, 12: 2990 },
  },
  pro: {
    code: "pro",
    name: "专业版",
    monthlyPriceYuan: 599,
    maxDevices: 2,
    maxConcurrent: 8,
    termPrices: { 1: 599, 3: 1599, 12: 5990 },
  },
  team: {
    code: "team",
    name: "团队版",
    monthlyPriceYuan: 1299,
    maxDevices: 5,
    maxConcurrent: 20,
    termPrices: { 1: 1299, 3: 3499, 12: 12990 },
  },
  flagship: {
    code: "flagship",
    name: "旗舰版",
    monthlyPriceYuan: 2499,
    maxDevices: 10,
    // 999 is the wire-compatible representation of "unlimited". The real
    // ceiling is the number of usable accounts and the machine/platform load.
    maxConcurrent: 999,
    termPrices: { 1: 2499, 3: 6999, 12: 24990 },
  },
  custom: {
    code: "custom",
    name: "定制版",
    monthlyPriceYuan: 0,
    maxDevices: 1,
    maxConcurrent: 1,
    termPrices: { 1: 0, 3: 0, 12: 0 },
  },
} as const;

export type LicensePlanCode = keyof typeof LICENSE_PLANS;

export function normalizePlanCode(value: unknown): LicensePlanCode {
  const code = String(value || "").trim() as LicensePlanCode;
  return code in LICENSE_PLANS ? code : "starter";
}

export type LicenseUserView = {
  id: string;
  username: string;
  status: string;
  expiresAt: string | null;
  planCode: LicensePlanCode;
  maxDevices: number;
  maxConcurrent: number;
  offlineGraceHours: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
  devices: Array<{
    id: string;
    deviceName: string;
    status: string;
    firstSeenAt: string;
    lastSeenAt: string;
    revokedAt: string | null;
  }>;
};

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function secureEquals(left: string, right: string) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

export async function ensureLicenseSchema() {
  const db = getDb();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS license_users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', expires_at TEXT,
      plan_code TEXT NOT NULL DEFAULT 'starter',
      max_devices INTEGER NOT NULL DEFAULT 1,
      max_concurrent INTEGER NOT NULL DEFAULT 0,
      offline_grace_hours INTEGER NOT NULL DEFAULT 24,
      notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS license_devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, fingerprint_hash TEXT NOT NULL,
      device_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS license_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS license_audit_logs (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
      target_id TEXT NOT NULL DEFAULT '', detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS license_login_limits (
      key_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
      window_started_at TEXT NOT NULL, blocked_until TEXT, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS license_payments (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_code TEXT NOT NULL,
      months INTEGER NOT NULL, amount_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'CNY', payment_method TEXT NOT NULL DEFAULT 'manual',
      reference TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL,
      period_started_at TEXT NOT NULL, period_ends_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS license_devices_user_fingerprint_unique ON license_devices(user_id, fingerprint_hash)"),
    db.prepare("CREATE INDEX IF NOT EXISTS license_devices_user_idx ON license_devices(user_id, status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS license_sessions_user_idx ON license_sessions(user_id, revoked_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS license_audit_created_idx ON license_audit_logs(created_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS license_login_limits_updated_idx ON license_login_limits(updated_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS license_payments_user_idx ON license_payments(user_id, created_at DESC)"),
  ]);
  const columns = await db
    .prepare("PRAGMA table_info(license_users)")
    .all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "plan_code")) {
    await db
      .prepare(
        "ALTER TABLE license_users ADD COLUMN plan_code TEXT NOT NULL DEFAULT 'starter'",
      )
      .run();
  }
  if (!columns.results.some((column) => column.name === "max_concurrent")) {
    await db
      .prepare(
        "ALTER TABLE license_users ADD COLUMN max_concurrent INTEGER NOT NULL DEFAULT 0",
      )
      .run();
  }
}

async function derivePassword(password: string, salt: Uint8Array) {
  const sourceKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations: PASSWORD_ITERATIONS,
    },
    sourceKey,
    256,
  );
  return toBase64Url(new Uint8Array(bits));
}

export async function hashPassword(password: string) {
  if (password.length < 8) throw new Error("密码至少需要 8 位");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    salt: toBase64Url(salt),
    hash: await derivePassword(password, salt),
  };
}

export async function verifyPassword(password: string, salt: string, expected: string) {
  const actual = await derivePassword(password, fromBase64Url(salt));
  return secureEquals(actual, expected);
}

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return toBase64Url(new Uint8Array(digest));
}

function requestAddress(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

async function loginLimitKey(
  request: Request,
  scope: string,
  identifier: string,
) {
  return hashToken(
    `${scope}|${requestAddress(request)}|${identifier.trim().toLowerCase()}`,
  );
}

export async function checkLoginThrottle(
  request: Request,
  scope: string,
  identifier: string,
) {
  await ensureLicenseSchema();
  const keyHash = await loginLimitKey(request, scope, identifier);
  const row = await getDb()
    .prepare(
      "SELECT blocked_until FROM license_login_limits WHERE key_hash = ?",
    )
    .bind(keyHash)
    .first<{ blocked_until: string | null }>();
  const blockedUntil = row?.blocked_until
    ? new Date(row.blocked_until).getTime()
    : 0;
  return {
    allowed: !blockedUntil || blockedUntil <= Date.now(),
    retryAfterSeconds: blockedUntil
      ? Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000))
      : 0,
  };
}

export async function recordLoginFailure(
  request: Request,
  scope: string,
  identifier: string,
) {
  await ensureLicenseSchema();
  const db = getDb();
  const keyHash = await loginLimitKey(request, scope, identifier);
  const now = new Date();
  const row = await db
    .prepare(
      `SELECT attempts, window_started_at FROM license_login_limits
       WHERE key_hash = ?`,
    )
    .bind(keyHash)
    .first<{ attempts: number; window_started_at: string }>();
  const windowExpired =
    !row ||
    now.getTime() - new Date(row.window_started_at).getTime() >
      LOGIN_WINDOW_MS;
  const attempts = windowExpired ? 1 : Number(row.attempts || 0) + 1;
  const windowStartedAt = windowExpired
    ? now.toISOString()
    : row.window_started_at;
  const blockedUntil =
    attempts >= LOGIN_MAX_FAILURES
      ? new Date(now.getTime() + LOGIN_BLOCK_MS).toISOString()
      : null;
  await db
    .prepare(
      `INSERT INTO license_login_limits
       (key_hash, attempts, window_started_at, blocked_until, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key_hash) DO UPDATE SET attempts = excluded.attempts,
       window_started_at = excluded.window_started_at,
       blocked_until = excluded.blocked_until, updated_at = excluded.updated_at`,
    )
    .bind(
      keyHash,
      attempts,
      windowStartedAt,
      blockedUntil,
      now.toISOString(),
    )
    .run();
}

export async function clearLoginFailures(
  request: Request,
  scope: string,
  identifier: string,
) {
  await ensureLicenseSchema();
  await getDb()
    .prepare("DELETE FROM license_login_limits WHERE key_hash = ?")
    .bind(await loginLimitKey(request, scope, identifier))
    .run();
}

export function randomToken(bytes = 32) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function signingJwk() {
  const serialized = runtimeEnv().FLOWCUT_LICENSE_PRIVATE_JWK;
  if (!serialized) throw new Error("授权中心签名私钥尚未配置");
  return JSON.parse(serialized) as JsonWebKey;
}

function verificationJwk() {
  const serialized = runtimeEnv().FLOWCUT_LICENSE_PUBLIC_JWK;
  if (!serialized) throw new Error("授权中心验签公钥尚未配置");
  return JSON.parse(serialized) as JsonWebKey;
}

export async function signLease(payload: Record<string, unknown>) {
  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: "ES256", typ: "FCLEASE" })));
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const message = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    signingJwk(),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(message),
  );
  return `${message}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySignedToken(token: string) {
  const [header, body, signature, extra] = token.split(".");
  if (!header || !body || !signature || extra) throw new Error("令牌格式错误");
  const key = await crypto.subtle.importKey(
    "jwk",
    verificationJwk(),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    fromBase64Url(signature),
    encoder.encode(`${header}.${body}`),
  );
  if (!valid) throw new Error("令牌签名无效");
  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as Record<string, unknown>;
  if (Number(payload.exp || 0) * 1000 <= Date.now()) throw new Error("令牌已过期");
  return payload;
}

export async function issueLease(user: LicenseUserRow, deviceId: string) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const graceHours = Math.max(1, Math.min(168, Number(user.offline_grace_hours || 24)));
  const planCode = normalizePlanCode(user.plan_code);
  const plan = LICENSE_PLANS[planCode];
  const maxConcurrent =
    Number(user.max_concurrent || 0) > 0
      ? Math.min(999, Number(user.max_concurrent))
      : plan.maxConcurrent;
  return signLease({
    aud: "flowcut-desktop",
    sub: user.id,
    username: user.username,
    deviceId,
    status: user.status,
    iat: nowSeconds,
    exp: nowSeconds + graceHours * 60 * 60,
    licenseExpiresAt: user.expires_at,
    offlineGraceHours: graceHours,
    planCode,
    planName: plan.name,
    maxDevices: user.max_devices,
    maxConcurrent,
  });
}

export function userUsable(user: Pick<LicenseUserRow, "status" | "expires_at">) {
  if (user.status !== "active") return { ok: false, reason: "该账号已被管理员停用" };
  if (user.expires_at && new Date(user.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: "该账号授权已到期" };
  }
  return { ok: true, reason: "" };
}

export async function audit(actor: string, action: string, targetId = "", detail: unknown = {}) {
  await ensureLicenseSchema();
  await getDb()
    .prepare(
      "INSERT INTO license_audit_logs (id, actor, action, target_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      actor,
      action,
      targetId,
      JSON.stringify(detail),
      new Date().toISOString(),
    )
    .run();
}

export async function listLicenseUsers(): Promise<LicenseUserView[]> {
  await ensureLicenseSchema();
  const db = getDb();
  const users = await db
    .prepare(
      `SELECT id, username, status, expires_at, max_devices, max_concurrent, offline_grace_hours,
       plan_code, notes, created_at, updated_at
       FROM license_users ORDER BY created_at DESC`,
    )
    .all<Omit<LicenseUserRow, "password_salt" | "password_hash">>();
  const devices = await db
    .prepare(
      `SELECT id, user_id, device_name, status, first_seen_at, last_seen_at, revoked_at
       FROM license_devices ORDER BY last_seen_at DESC`,
    )
    .all<{
      id: string;
      user_id: string;
      device_name: string;
      status: string;
      first_seen_at: string;
      last_seen_at: string;
      revoked_at: string | null;
    }>();
  return users.results.map((user) => ({
    id: user.id,
    username: user.username,
    status: user.status,
    expiresAt: user.expires_at,
    planCode: normalizePlanCode(user.plan_code),
    maxDevices: user.max_devices,
    maxConcurrent:
      Number(user.max_concurrent || 0) > 0
        ? Number(user.max_concurrent)
        : LICENSE_PLANS[normalizePlanCode(user.plan_code)].maxConcurrent,
    offlineGraceHours: user.offline_grace_hours,
    notes: user.notes,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    devices: devices.results
      .filter((device) => device.user_id === user.id)
      .map((device) => ({
        id: device.id,
        deviceName: device.device_name,
        status: device.status,
        firstSeenAt: device.first_seen_at,
        lastSeenAt: device.last_seen_at,
        revokedAt: device.revoked_at,
      })),
  }));
}

export function adminUsername() {
  return runtimeEnv().FLOWCUT_ADMIN_USERNAME || "admin";
}

export async function createAdminSession(username: string, password: string) {
  const configuredPassword = runtimeEnv().FLOWCUT_ADMIN_PASSWORD || "";
  if (!configuredPassword || username !== adminUsername() || !secureEquals(password, configuredPassword)) {
    throw new Error("管理员账号或密码错误");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  return signLease({
    aud: "flowcut-admin",
    sub: adminUsername(),
    iat: nowSeconds,
    exp: nowSeconds + 12 * 60 * 60,
  });
}

export async function requireAdmin(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const token = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("flowcut_admin="))
    ?.slice("flowcut_admin=".length);
  if (!token) throw new Error("请先登录管理员后台");
  const payload = await verifySignedToken(decodeURIComponent(token));
  if (payload.aud !== "flowcut-admin" || payload.sub !== adminUsername()) {
    throw new Error("管理员会话无效");
  }
  return String(payload.sub);
}

export function sessionExpiryIso() {
  return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export type { LicenseUserRow };
