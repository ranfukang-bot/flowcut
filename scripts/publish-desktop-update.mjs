import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  projectRoot,
  readJson,
  recoveryPath,
  runWrangler,
  wranglerScript,
  wranglerConfigPath,
} from "./cloudflare-common.mjs";

if (!fs.existsSync(wranglerConfigPath) || !fs.existsSync(recoveryPath)) {
  throw new Error("缺少 Cloudflare 私密部署配置，请先恢复 .flowcut-cloudflare");
}

const desktopRoot = path.join(projectRoot, "gemini-web-workbench");
const releaseRoot = path.join(desktopRoot, "release");
const desktopPackage = readJson(path.join(desktopRoot, "package.json"));
const latestYml = path.join(releaseRoot, "latest.yml");
if (!fs.existsSync(latestYml)) {
  throw new Error("没有找到 latest.yml，请先构建 FlowCut 安装版");
}

const manifest = fs.readFileSync(latestYml, "utf8");
const installerName = manifest.match(/^path:\s*(.+)$/m)?.[1]?.trim();
if (!installerName) throw new Error("latest.yml 中没有安装包路径");
const installerPath = path.join(releaseRoot, installerName);
const blockmapPath = `${installerPath}.blockmap`;
for (const file of [installerPath, blockmapPath]) {
  if (!fs.existsSync(file)) {
    throw new Error(`更新文件不存在：${path.basename(file)}`);
  }
}

const recovery = readJson(recoveryPath);
const releaseMetadata = {
  version: String(desktopPackage.version),
  channel: "stable",
  publishedAt: new Date().toISOString(),
  installer: installerName,
  size: fs.statSync(installerPath).size,
  controlPlaneUrl: String(recovery.controlPlaneUrl || ""),
};
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "flowcut-update-"),
);
const metadataPath = path.join(temporaryDirectory, "release.json");
fs.writeFileSync(
  metadataPath,
  `${JSON.stringify(releaseMetadata, null, 2)}\n`,
  "utf8",
);

const uploads = [
  [installerPath, installerName, "application/vnd.microsoft.portable-executable"],
  [blockmapPath, `${installerName}.blockmap`, "application/octet-stream"],
  [metadataPath, "release.json", "application/json; charset=utf-8"],
  [latestYml, "latest.yml", "text/yaml; charset=utf-8"],
];

// Wrangler 4 serializes KV file uploads in memory. With 16 MB chunks and
// three parallel processes it can consume more than 10 GB on Windows and get
// killed before the release manifest is published. Smaller chunks keep the
// updater reliable on the machine that owns the Cloudflare account.
const chunkSize = 4 * 1024 * 1024;

function runWranglerAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerScript, ...args], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CI: "true",
        WRANGLER_SEND_METRICS: "false",
      },
    });
    let outputTail = "";
    const appendOutput = (chunk) => {
      outputTail = `${outputTail}${String(chunk || "")}`.slice(-32_000);
    };
    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `Wrangler 上传失败（退出码 ${code}）${
              outputTail.trim() ? `\n${outputTail.trim()}` : ""
            }`,
          ),
        );
      }
    });
  });
}

async function putKey(key, file) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await runWranglerAsync([
        "kv",
        "key",
        "put",
        key,
        "--path",
        file,
        "--binding",
        "UPDATES_KV",
        "--config",
        wranglerConfigPath,
        "--remote",
      ]);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      }
    }
  }
  throw lastError;
}

async function deleteKey(key) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await runWranglerAsync([
        "kv",
        "key",
        "delete",
        key,
        "--binding",
        "UPDATES_KV",
        "--config",
        wranglerConfigPath,
        "--remote",
      ]);
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
}

async function uploadInParallel(items, concurrency = 2) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      await putKey(item.key, item.file);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
}

async function uploadAsset(file, name, contentType) {
  const size = fs.statSync(file).size;
  const handle = fs.openSync(file, "r");
  const hash = crypto.createHash("sha256");
  const chunks = [];
  const chunkUploads = [];
  const stableAsset = name === "latest.yml" || name === "release.json";
  const safeAssetId = crypto
    .createHash("sha1")
    .update(stableAsset ? name : `${desktopPackage.version}|${name}`)
    .digest("hex");
  try {
    for (let offset = 0, index = 0; offset < size; index += 1) {
      const length = Math.min(chunkSize, size - offset);
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(handle, buffer, 0, length, offset);
      hash.update(buffer);
      const key = `updates/windows/chunks/${safeAssetId}/${String(index).padStart(4, "0")}`;
      const chunkFile = path.join(
        temporaryDirectory,
        `asset-${safeAssetId}-${index}.part`,
      );
      fs.writeFileSync(chunkFile, buffer);
      chunkUploads.push({
        key,
        file: chunkFile,
      });
      chunks.push({ key, offset, size: length });
      offset += length;
    }
  } finally {
    fs.closeSync(handle);
  }
  await uploadInParallel(chunkUploads);
  for (const upload of chunkUploads) {
    fs.rmSync(upload.file, { force: true });
  }
  const assetManifest = {
    size,
    contentType,
    etag: hash.digest("hex"),
    chunks,
  };
  const assetManifestPath = path.join(
    temporaryDirectory,
    `${crypto.createHash("sha1").update(name).digest("hex")}.json`,
  );
  fs.writeFileSync(
    assetManifestPath,
    `${JSON.stringify(assetManifest)}\n`,
    "utf8",
  );
  const manifestKey = `updates/windows/${name}.meta.json`;
  await putKey(manifestKey, assetManifestPath);
  return {
    name,
    manifestKey,
    chunkKeys: chunks.map((chunk) => chunk.key),
  };
}

const publishedAssets = [];
try {
  for (const [file, name, contentType] of uploads) {
    publishedAssets.push(await uploadAsset(file, name, contentType));
  }

  const indexKey = "updates/windows/releases.json";
  const previousResult = runWrangler(
    [
      "kv",
      "key",
      "get",
      indexKey,
      "--binding",
      "UPDATES_KV",
      "--config",
      wranglerConfigPath,
      "--remote",
    ],
    { capture: true, allowFailure: true },
  );
  let previousReleases = [];
  if (previousResult.status === 0) {
    try {
      previousReleases = JSON.parse(previousResult.stdout || "[]");
    } catch {
      previousReleases = [];
    }
  }
  const currentRelease = {
    version: String(desktopPackage.version),
    publishedAt: releaseMetadata.publishedAt,
    assets: publishedAssets.filter(
      (asset) => asset.name !== "latest.yml" && asset.name !== "release.json",
    ),
  };
  const merged = [
    currentRelease,
    ...previousReleases.filter(
      (release) => release.version !== currentRelease.version,
    ),
  ];
  const retained = merged.slice(0, 2);
  const removed = merged.slice(2);
  const indexPath = path.join(temporaryDirectory, "releases.json");
  fs.writeFileSync(indexPath, `${JSON.stringify(retained, null, 2)}\n`, "utf8");
  await putKey(indexKey, indexPath);
  const obsoleteKeys = removed.flatMap((release) =>
    (release.assets || []).flatMap((asset) => [
      asset.manifestKey,
      ...(asset.chunkKeys || []),
    ]),
  );
  let cleanupCursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(3, obsoleteKeys.length) },
      async () => {
        while (cleanupCursor < obsoleteKeys.length) {
          await deleteKey(obsoleteKeys[cleanupCursor++]);
        }
      },
    ),
  );
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log(
  `FlowCut ${desktopPackage.version} 已发布到云更新通道：${installerName}`,
);
