import { ensureWorkspace, getDb, runtimeEnv } from "./storage";

export type GeminiConfig = {
  mode: "web" | "api";
  model: string;
  baseUrl: string;
};

export type SeedanceConfig = {
  mode: "local-api" | "webhook" | "async-api";
  endpoint: string;
  healthUrl: string;
  authHeader: string;
  authScheme: string;
  responseJobIdPath: string;
  responseOutputPath: string;
  statusUrlTemplate: string;
  statusPath: string;
  outputPath: string;
  successValue: string;
  failureValue: string;
};

type ProviderName = "gemini" | "seedance";

const defaults = {
  gemini: {
    mode: "web",
    model: "",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  } satisfies GeminiConfig,
  seedance: {
    mode: "local-api",
    endpoint: "http://127.0.0.1:17890/v1/videos",
    healthUrl: "http://127.0.0.1:17890/health",
    authHeader: "Authorization",
    authScheme: "Bearer",
    responseJobIdPath: "id",
    responseOutputPath: "result.videoUrl",
    statusUrlTemplate: "http://127.0.0.1:17890/v1/videos/{jobId}",
    statusPath: "status",
    outputPath: "result.videoUrl",
    successValue: "success",
    failureValue: "failed",
  } satisfies SeedanceConfig,
};

function decodeBase64(value: string) {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function encodeBase64(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Buffer.from(bytes).toString("base64");
}

async function encryptionKey() {
  const raw = runtimeEnv().CREDENTIALS_MASTER_KEY;
  if (!raw) throw new Error("凭证加密主密钥尚未配置");
  const bytes = decodeBase64(raw);
  if (bytes.byteLength !== 32) throw new Error("凭证加密主密钥格式错误");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function credentialEncryptionReady() {
  await encryptionKey();
  return true;
}

async function encryptSecret(secret: Record<string, string>) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(JSON.stringify(secret));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(),
    payload
  );
  return { encrypted: encodeBase64(encrypted), iv: encodeBase64(iv) };
}

async function decryptSecret(encrypted?: string | null, iv?: string | null) {
  if (!encrypted || !iv) return {} as Record<string, string>;
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64(iv) },
    await encryptionKey(),
    decodeBase64(encrypted)
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as Record<string, string>;
}

export async function getProviderConfig<T extends ProviderName>(provider: T) {
  await ensureWorkspace();
  const row = await getDb()
    .prepare(
      "SELECT config_json, encrypted_secret, secret_iv FROM provider_configs WHERE provider = ?"
    )
    .bind(provider)
    .first<{
      config_json: string;
      encrypted_secret?: string | null;
      secret_iv?: string | null;
    }>();
  const config = {
    ...defaults[provider],
    ...(row ? JSON.parse(row.config_json) : {}),
  } as T extends "gemini" ? GeminiConfig : SeedanceConfig;
  let secrets: Record<string, string> = {};
  if (row?.encrypted_secret) {
    secrets = await decryptSecret(row.encrypted_secret, row.secret_iv);
  } else if (provider === "gemini" && runtimeEnv().GEMINI_API_KEY) {
    secrets.apiKey = runtimeEnv().GEMINI_API_KEY!;
  } else if (provider === "seedance" && runtimeEnv().SEEDANCE_WEBHOOK_TOKEN) {
    secrets.apiKey = runtimeEnv().SEEDANCE_WEBHOOK_TOKEN!;
  }
  return { config, secrets, secretConfigured: Boolean(secrets.apiKey) };
}

export async function saveProviderConfig(
  provider: ProviderName,
  config: Record<string, unknown>,
  secret?: Record<string, string>
) {
  await ensureWorkspace();
  const db = getDb();
  const current = await db
    .prepare(
      "SELECT encrypted_secret, secret_iv FROM provider_configs WHERE provider = ?"
    )
    .bind(provider)
    .first<{ encrypted_secret?: string | null; secret_iv?: string | null }>();
  let encrypted = current?.encrypted_secret || null;
  let iv = current?.secret_iv || null;
  if (secret?.apiKey) {
    const result = await encryptSecret(secret);
    encrypted = result.encrypted;
    iv = result.iv;
  }
  await db
    .prepare(
      `INSERT INTO provider_configs
       (provider, config_json, encrypted_secret, secret_iv, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET config_json = excluded.config_json,
       encrypted_secret = excluded.encrypted_secret, secret_iv = excluded.secret_iv,
       updated_at = excluded.updated_at`
    )
    .bind(provider, JSON.stringify(config), encrypted, iv, new Date().toISOString())
    .run();
}

export function readPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, part) => {
      if (current && typeof current === "object") {
        return (current as Record<string, unknown>)[part];
      }
      return undefined;
    }, value);
}
