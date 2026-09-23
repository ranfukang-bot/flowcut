import { env } from "cloudflare:workers";

type RuntimeEnv = {
  DB?: D1Database;
  MEDIA?: R2Bucket;
  UPDATES?: R2Bucket;
  UPDATES_KV?: KVNamespace;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  SEEDANCE_WEBHOOK_URL?: string;
  SEEDANCE_WEBHOOK_TOKEN?: string;
  CREDENTIALS_MASTER_KEY?: string;
  FLOWCUT_CONTROL_PLANE?: string;
  FLOWCUT_ADMIN_USERNAME?: string;
  FLOWCUT_ADMIN_PASSWORD?: string;
  FLOWCUT_LICENSE_PRIVATE_JWK?: string;
  FLOWCUT_LICENSE_PUBLIC_JWK?: string;
  FLOWCUT_CONTROL_PLANE_VERSION?: string;
  FLOWCUT_DESKTOP_RUNTIME?: string;
};

export function runtimeEnv() {
  return env as unknown as RuntimeEnv;
}

export function getDb() {
  const db = runtimeEnv().DB;
  if (!db) throw new Error("数据库尚未连接");
  return db;
}

let workspaceReady: Promise<void> | null = null;

export function ensureWorkspace() {
  if (!workspaceReady) {
    workspaceReady = initializeWorkspace().catch((error) => {
      workspaceReady = null;
      throw error;
    });
  }
  return workspaceReady;
}

async function initializeWorkspace() {
  const db = getDb();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS gems (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 15,
      locale TEXT NOT NULL DEFAULT 'id-ID', is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, external_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT '印度尼西亚', language TEXT NOT NULL DEFAULT '印尼语',
      features TEXT NOT NULL DEFAULT '', image_key TEXT, image_name TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS product_images (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, object_key TEXT NOT NULL,
      file_name TEXT NOT NULL, content_type TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, gem_id TEXT NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'prompt_ready',
      prompt TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT 'seedance-browser',
      duration INTEGER NOT NULL DEFAULT 15,
      region TEXT NOT NULL DEFAULT '印尼',
      shooting_style TEXT NOT NULL DEFAULT 'iPhone实拍质感',
      progress INTEGER NOT NULL DEFAULT 0, provider_job_id TEXT,
      provider_status_url TEXT, callback_token TEXT, output_url TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS reference_remix_tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'reference_queued', progress INTEGER NOT NULL DEFAULT 5,
      duration INTEGER NOT NULL DEFAULT 15, region TEXT NOT NULL DEFAULT '马来西亚',
      product_name TEXT NOT NULL DEFAULT '', product_external_id TEXT NOT NULL DEFAULT '',
      save_to_library INTEGER NOT NULL DEFAULT 0, product_id TEXT,
      gemini_account_id TEXT, tiktok_account_name TEXT NOT NULL DEFAULT '',
      auto_queue INTEGER NOT NULL DEFAULT 1,
      reference_analysis TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'gemini-web', provider_job_id TEXT,
      provider_status_url TEXT, bridge_claimed_at TEXT, bridge_worker_id TEXT,
      gemini_failures INTEGER NOT NULL DEFAULT 0, gemini_retry_at TEXT,
      output_url TEXT, download_path TEXT, download_error TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS reference_remix_assets (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
      object_key TEXT NOT NULL, file_name TEXT NOT NULL, content_type TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS reference_remix_settings (
      id TEXT PRIMARY KEY, duration INTEGER NOT NULL DEFAULT 15,
      region TEXT NOT NULL DEFAULT '马来西亚', updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS script_pipeline_tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'rewrite_queued', progress INTEGER NOT NULL DEFAULT 5,
      source_script TEXT NOT NULL, project_context TEXT NOT NULL DEFAULT '',
      rewritten_script TEXT NOT NULL DEFAULT '', extraction_json TEXT NOT NULL DEFAULT '',
      storyboard_json TEXT NOT NULL DEFAULT '', raw_groups_json TEXT NOT NULL DEFAULT '[]',
      optimized_groups_json TEXT NOT NULL DEFAULT '[]',
      gemini_account_id TEXT, provider TEXT NOT NULL DEFAULT 'gemini-web',
      bridge_claimed_at TEXT, bridge_worker_id TEXT,
      gemini_failures INTEGER NOT NULL DEFAULT 0, gemini_retry_at TEXT,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS tiktok_accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS provider_configs (
      provider TEXT PRIMARY KEY, config_json TEXT NOT NULL DEFAULT '{}',
      encrypted_secret TEXT, secret_iv TEXT, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS provider_runtime (
      provider TEXT PRIMARY KEY, status_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS workspace_migrations (
      id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, account_name TEXT NOT NULL,
      scheduled_at TEXT NOT NULL, caption TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'scheduled', created_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_schedules_time ON schedules(scheduled_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id, sort_order)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_reference_remix_created ON reference_remix_tasks(created_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_reference_remix_assets_task ON reference_remix_assets(task_id, kind, sort_order)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_script_pipeline_created ON script_pipeline_tasks(created_at DESC)"),
  ]);

  await db
    .prepare(
      `INSERT OR IGNORE INTO reference_remix_settings (id, duration, region, updated_at)
       VALUES ('default', 15, '马来西亚', ?)`
    )
    .bind(new Date().toISOString())
    .run();

  await ensureColumn("tasks", "provider_job_id", "TEXT");
  await ensureColumn("tasks", "provider_status_url", "TEXT");
  await ensureColumn("tasks", "callback_token", "TEXT");
  await ensureColumn("tasks", "auto_queue", "INTEGER NOT NULL DEFAULT 1");
  await ensureColumn("tasks", "gemini_account_id", "TEXT");
  await ensureColumn("tasks", "tiktok_account_name", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("tiktok_accounts", "archive_directory", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("tasks", "archive_directory", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("tasks", "gem_content_snapshot", "TEXT");
  await ensureColumn("tasks", "product_external_id_snapshot", "TEXT");
  await ensureColumn("reference_remix_tasks", "archive_directory", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("tasks", "bridge_claimed_at", "TEXT");
  await ensureColumn("tasks", "bridge_worker_id", "TEXT");
  await ensureColumn("tasks", "gemini_failures", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("tasks", "gemini_retry_at", "TEXT");
  await ensureColumn("tasks", "download_path", "TEXT");
  await ensureColumn("tasks", "download_error", "TEXT");
  await ensureColumn("tasks", "duration", "INTEGER NOT NULL DEFAULT 15");
  await ensureColumn("tasks", "region", "TEXT NOT NULL DEFAULT '印尼'");
  await ensureColumn(
    "tasks",
    "shooting_style",
    "TEXT NOT NULL DEFAULT 'iPhone实拍质感'"
  );

  // 旧版本曾自动注入一个“内置模板”。Gem 现在完全由用户维护，
  // 因此升级时清理旧内置记录，之后也不再自动创建。
  await db.prepare("DELETE FROM gems WHERE is_default = 1").run();

  const modelMigrationId = "clear-legacy-gemini-model-default-v1";
  const modelMigration = await db
    .prepare("SELECT id FROM workspace_migrations WHERE id = ?")
    .bind(modelMigrationId)
    .first<{ id: string }>();
  if (!modelMigration) {
    const row = await db
      .prepare("SELECT config_json FROM provider_configs WHERE provider = 'gemini'")
      .first<{ config_json: string }>();
    if (row) {
      const config = JSON.parse(row.config_json) as Record<string, unknown>;
      if (config.model === "gemini-3.6-flash") {
        delete config.model;
        await db
          .prepare(
            "UPDATE provider_configs SET config_json = ?, updated_at = ? WHERE provider = 'gemini'"
          )
          .bind(JSON.stringify(config), new Date().toISOString())
          .run();
      }
    }
    await db
      .prepare(
        "INSERT OR IGNORE INTO workspace_migrations (id, applied_at) VALUES (?, ?)"
      )
      .bind(modelMigrationId, new Date().toISOString())
      .run();
  }

  await db
    .prepare(
      `INSERT INTO product_images (id, product_id, object_key, file_name, content_type, sort_order, created_at)
       SELECT lower(hex(randomblob(16))), id, image_key, COALESCE(image_name, 'product-image'),
       'image/jpeg', 0, created_at FROM products
       WHERE image_key IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id)`
    )
    .run();

}

async function ensureColumn(table: string, column: string, type: string) {
  const db = getDb();
  const info = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  if (!info.results.some((item) => item.name === column)) {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  }
}

export function jsonError(error: unknown, status = 500) {
  return Response.json(
    { error: error instanceof Error ? error.message : "未知错误" },
    { status }
  );
}

export type ProviderRuntime = {
  online: boolean;
  updatedAt?: string;
  authenticated?: boolean;
  queueRunning?: boolean;
  maxConcurrent?: number;
  activeCount?: number;
  activeJobs?: Array<{ taskId: string; accountName?: string; stage?: string; startedAt?: string; updatedAt?: string }>;
  workerId?: string;
  version?: string;
  error?: string;
  defaultAccountId?: string;
  accounts?: Array<{
    id: string;
    name: string;
    authenticated: boolean;
    busy?: boolean;
  }>;
  downloadDirectory?: string;
};

export async function getProviderRuntime(
  provider: string,
  onlineWindowMs = 30_000
): Promise<ProviderRuntime> {
  await ensureWorkspace();
  const row = await getDb()
    .prepare(
      "SELECT status_json, updated_at FROM provider_runtime WHERE provider = ?"
    )
    .bind(provider)
    .first<{ status_json: string; updated_at: string }>();
  if (!row) return { online: false };
  let status: Omit<ProviderRuntime, "online" | "updatedAt"> = {};
  try {
    status = JSON.parse(row.status_json);
  } catch {
    status = { error: "执行器状态数据损坏" };
  }
  return {
    ...status,
    updatedAt: row.updated_at,
    online: Date.now() - new Date(row.updated_at).getTime() <= onlineWindowMs,
  };
}
