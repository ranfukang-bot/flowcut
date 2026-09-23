import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const gems = sqliteTable("gems", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  content: text("content").notNull(),
  duration: integer("duration").notNull().default(15),
  locale: text("locale").notNull().default("id-ID"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  externalId: text("external_id").notNull().default(""),
  name: text("name").notNull(),
  country: text("country").notNull().default("ID"),
  language: text("language").notNull().default("id-ID"),
  features: text("features").notNull().default(""),
  imageKey: text("image_key"),
  imageName: text("image_name"),
  createdAt: text("created_at").notNull(),
});

export const productImages = sqliteTable("product_images", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  objectKey: text("object_key").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  gemId: text("gem_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("prompt_ready"),
  prompt: text("prompt").notNull().default(""),
  provider: text("provider").notNull().default("seedance-browser"),
  duration: integer("duration").notNull().default(15),
  region: text("region").notNull().default("印尼"),
  shootingStyle: text("shooting_style")
    .notNull()
    .default("iPhone实拍质感"),
  progress: integer("progress").notNull().default(0),
  providerJobId: text("provider_job_id"),
  providerStatusUrl: text("provider_status_url"),
  callbackToken: text("callback_token"),
  autoQueue: integer("auto_queue", { mode: "boolean" }).notNull().default(true),
  geminiAccountId: text("gemini_account_id"),
  tiktokAccountName: text("tiktok_account_name").notNull().default(""),
  bridgeClaimedAt: text("bridge_claimed_at"),
  bridgeWorkerId: text("bridge_worker_id"),
  geminiFailures: integer("gemini_failures").notNull().default(0),
  geminiRetryAt: text("gemini_retry_at"),
  outputUrl: text("output_url"),
  downloadPath: text("download_path"),
  downloadError: text("download_error"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const referenceRemixTasks = sqliteTable("reference_remix_tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  status: text("status").notNull().default("reference_queued"),
  progress: integer("progress").notNull().default(5),
  duration: integer("duration").notNull().default(15),
  region: text("region").notNull().default("马来西亚"),
  productName: text("product_name").notNull().default(""),
  productExternalId: text("product_external_id").notNull().default(""),
  saveToLibrary: integer("save_to_library", { mode: "boolean" }).notNull().default(false),
  productId: text("product_id"),
  geminiAccountId: text("gemini_account_id"),
  tiktokAccountName: text("tiktok_account_name").notNull().default(""),
  autoQueue: integer("auto_queue", { mode: "boolean" }).notNull().default(true),
  referenceAnalysis: text("reference_analysis").notNull().default(""),
  prompt: text("prompt").notNull().default(""),
  provider: text("provider").notNull().default("gemini-web"),
  providerJobId: text("provider_job_id"),
  providerStatusUrl: text("provider_status_url"),
  bridgeClaimedAt: text("bridge_claimed_at"),
  bridgeWorkerId: text("bridge_worker_id"),
  geminiFailures: integer("gemini_failures").notNull().default(0),
  geminiRetryAt: text("gemini_retry_at"),
  outputUrl: text("output_url"),
  downloadPath: text("download_path"),
  downloadError: text("download_error"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const referenceRemixAssets = sqliteTable("reference_remix_assets", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  kind: text("kind").notNull(),
  objectKey: text("object_key").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  fileSize: integer("file_size").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const referenceRemixSettings = sqliteTable("reference_remix_settings", {
  id: text("id").primaryKey(),
  duration: integer("duration").notNull().default(15),
  region: text("region").notNull().default("马来西亚"),
  updatedAt: text("updated_at").notNull(),
});

export const scriptPipelineTasks = sqliteTable("script_pipeline_tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  status: text("status").notNull().default("rewrite_queued"),
  progress: integer("progress").notNull().default(5),
  sourceScript: text("source_script").notNull(),
  projectContext: text("project_context").notNull().default(""),
  rewrittenScript: text("rewritten_script").notNull().default(""),
  extractionJson: text("extraction_json").notNull().default(""),
  storyboardJson: text("storyboard_json").notNull().default(""),
  rawGroupsJson: text("raw_groups_json").notNull().default("[]"),
  optimizedGroupsJson: text("optimized_groups_json").notNull().default("[]"),
  geminiAccountId: text("gemini_account_id"),
  provider: text("provider").notNull().default("gemini-web"),
  bridgeClaimedAt: text("bridge_claimed_at"),
  bridgeWorkerId: text("bridge_worker_id"),
  geminiFailures: integer("gemini_failures").notNull().default(0),
  geminiRetryAt: text("gemini_retry_at"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const tiktokAccounts = sqliteTable("tiktok_accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

export const providerConfigs = sqliteTable("provider_configs", {
  provider: text("provider").primaryKey(),
  configJson: text("config_json").notNull().default("{}"),
  encryptedSecret: text("encrypted_secret"),
  secretIv: text("secret_iv"),
  updatedAt: text("updated_at").notNull(),
});

export const providerRuntime = sqliteTable("provider_runtime", {
  provider: text("provider").primaryKey(),
  statusJson: text("status_json").notNull().default("{}"),
  updatedAt: text("updated_at").notNull(),
});

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  accountName: text("account_name").notNull(),
  scheduledAt: text("scheduled_at").notNull(),
  caption: text("caption").notNull().default(""),
  status: text("status").notNull().default("scheduled"),
  createdAt: text("created_at").notNull(),
});

export const licenseUsers = sqliteTable("license_users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordSalt: text("password_salt").notNull(),
  passwordHash: text("password_hash").notNull(),
  status: text("status").notNull().default("active"),
  expiresAt: text("expires_at"),
  planCode: text("plan_code").notNull().default("starter"),
  maxDevices: integer("max_devices").notNull().default(1),
  maxConcurrent: integer("max_concurrent").notNull().default(0),
  offlineGraceHours: integer("offline_grace_hours").notNull().default(24),
  notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const licenseDevices = sqliteTable("license_devices", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  fingerprintHash: text("fingerprint_hash").notNull(),
  deviceName: text("device_name").notNull().default(""),
  status: text("status").notNull().default("active"),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  revokedAt: text("revoked_at"),
});

export const licenseSessions = sqliteTable("license_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  deviceId: text("device_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull(),
});

export const licenseAuditLogs = sqliteTable("license_audit_logs", {
  id: text("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  targetId: text("target_id").notNull().default(""),
  detailJson: text("detail_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
});

export const licenseLoginLimits = sqliteTable("license_login_limits", {
  keyHash: text("key_hash").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
  windowStartedAt: text("window_started_at").notNull(),
  blockedUntil: text("blocked_until"),
  updatedAt: text("updated_at").notNull(),
});

export const licensePayments = sqliteTable("license_payments", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  planCode: text("plan_code").notNull(),
  months: integer("months").notNull(),
  amountCents: integer("amount_cents").notNull().default(0),
  currency: text("currency").notNull().default("CNY"),
  paymentMethod: text("payment_method").notNull().default("manual"),
  reference: text("reference").notNull().default(""),
  actor: text("actor").notNull(),
  periodStartedAt: text("period_started_at").notNull(),
  periodEndsAt: text("period_ends_at").notNull(),
  createdAt: text("created_at").notNull(),
});
