import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const stateDir = path.join(projectRoot, ".flowcut-cloudflare");
export const recoveryPath = path.join(stateDir, "recovery.json");
export const secretsPath = path.join(stateDir, "secrets.json");
export const wranglerConfigPath = path.join(stateDir, "wrangler.jsonc");
export const desktopDistributionPath = path.join(
  stateDir,
  "desktop-distribution.json",
);
export const databaseName = "flowcut-license-db";
export const updatesNamespaceName = "flowcut-desktop-updates";
export const workerName = "flowcut-license-control";
export const wranglerScript = path.join(
  projectRoot,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(
      `${path.basename(command)} 执行失败${detail ? `：${detail}` : ""}`,
    );
  }
  return result;
}

export function runWrangler(args, options = {}) {
  return run(process.execPath, [wranglerScript, ...args], {
    ...options,
    env: {
      CI: "true",
      WRANGLER_SEND_METRICS: "false",
      ...(options.env || {}),
    },
  });
}

export function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("请通过 npm run cloudflare:deploy 启动部署");
  }
  return run(process.execPath, [npmCli, ...args], options);
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function parseJsonOutput(output) {
  const text = String(output || "").trim();
  const arrayStart = text.indexOf("[");
  const objectStart = text.indexOf("{");
  const candidates = [arrayStart, objectStart].filter((index) => index >= 0);
  if (!candidates.length) throw new Error("Cloudflare 没有返回可解析的数据");
  return JSON.parse(text.slice(Math.min(...candidates)));
}

export function d1Id(database) {
  return (
    database?.uuid ||
    database?.id ||
    database?.database_id ||
    database?.databaseId ||
    ""
  );
}
