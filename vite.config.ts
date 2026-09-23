import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const isDesktopRuntime = process.env.FLOWCUT_DESKTOP_RUNTIME === "1";
const externalWranglerConfig =
  process.env.FLOWCUT_WRANGLER_CONFIG_PATH?.trim();

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  vars: Object.fromEntries(
    [
      "CREDENTIALS_MASTER_KEY",
      "FLOWCUT_CONTROL_PLANE",
      "FLOWCUT_ADMIN_USERNAME",
      "FLOWCUT_ADMIN_PASSWORD",
      "FLOWCUT_LICENSE_PRIVATE_JWK",
      "FLOWCUT_LICENSE_PUBLIC_JWK",
      "FLOWCUT_DESKTOP_RUNTIME",
      "FLOWCUT_DESKTOP_TOKEN",
    ]
      .filter((key) => Boolean(process.env[key]))
      .map((key) => [key, process.env[key] as string]),
  ),
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const persistStatePath = process.env.FLOWCUT_PERSIST_PATH?.trim();
  const cacheDirectory = process.env.FLOWCUT_CACHE_DIR?.trim();

  return {
    cacheDir: cacheDirectory || undefined,
    server: {
      hmr: isDesktopRuntime ? { overlay: false } : undefined,
      watch: {
        ...(isCodexSeatbeltSandbox
          ? { useFsEvents: false, usePolling: true }
          : {}),
        ignored: ["**/release/**", "**/*.exe", "**/backups/**"],
      },
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare(
        externalWranglerConfig
          ? {
              viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
              configPath: externalWranglerConfig,
              persistState: persistStatePath
                ? { path: persistStatePath }
                : true,
            }
          : {
              viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
              config: localBindingConfig,
              persistState: persistStatePath
                ? { path: persistStatePath }
                : true,
            },
      ),
    ],
  };
});
