CREATE TABLE IF NOT EXISTS license_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT,
  plan_code TEXT NOT NULL DEFAULT 'starter',
  max_devices INTEGER NOT NULL DEFAULT 1,
  max_concurrent INTEGER NOT NULL DEFAULT 0,
  offline_grace_hours INTEGER NOT NULL DEFAULT 24,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS license_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  fingerprint_hash TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS license_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS license_audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS license_login_limits (
  key_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  blocked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS license_payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_code TEXT NOT NULL,
  months INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  payment_method TEXT NOT NULL DEFAULT 'manual',
  reference TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  period_started_at TEXT NOT NULL,
  period_ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS license_devices_user_fingerprint_unique
  ON license_devices(user_id, fingerprint_hash);
CREATE INDEX IF NOT EXISTS license_devices_user_idx
  ON license_devices(user_id, status);
CREATE INDEX IF NOT EXISTS license_sessions_user_idx
  ON license_sessions(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS license_audit_created_idx
  ON license_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS license_login_limits_updated_idx
  ON license_login_limits(updated_at);
CREATE INDEX IF NOT EXISTS license_payments_user_idx
  ON license_payments(user_id, created_at DESC);
