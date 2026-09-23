import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  d1Id,
  databaseName,
  desktopDistributionPath,
  parseJsonOutput,
  projectRoot,
  readJson,
  recoveryPath,
  runNpm,
  runWrangler,
  secretsPath,
  updatesNamespaceName,
  workerName,
  wranglerConfigPath,
  writePrivateJson,
} from "./cloudflare-common.mjs";

if (!fs.existsSync(recoveryPath) || !fs.existsSync(secretsPath)) {
  throw new Error("请先执行 npm run cloudflare:prepare");
}

const whoami = runWrangler(["whoami"], {
  capture: true,
  allowFailure: true,
});
if (whoami.status !== 0 || /not authenticated/i.test(whoami.stdout || "")) {
  console.error("尚未登录 Cloudflare。");
  console.error("请先执行：npx wrangler login");
  console.error("在浏览器里登录你本人的 Cloudflare 账户并允许 Wrangler 访问。");
  process.exit(2);
}

let databases = parseJsonOutput(
  runWrangler(["d1", "list", "--json"], {
    capture: true,
  }).stdout,
);
let database = databases.find((item) => item.name === databaseName);
if (!database) {
  runWrangler([
    "d1",
    "create",
    databaseName,
    "--location",
    "apac",
  ]);
  databases = parseJsonOutput(
    runWrangler(["d1", "list", "--json"], {
      capture: true,
    }).stdout,
  );
  database = databases.find((item) => item.name === databaseName);
}
const databaseId = d1Id(database);
if (!databaseId) throw new Error("没有取得 Cloudflare D1 数据库 ID");

let namespaces = parseJsonOutput(
  runWrangler(["kv", "namespace", "list"], {
    capture: true,
  }).stdout,
);
let updatesNamespace = namespaces.find(
  (item) => item.title === updatesNamespaceName,
);
if (!updatesNamespace) {
  runWrangler(["kv", "namespace", "create", updatesNamespaceName]);
  namespaces = parseJsonOutput(
    runWrangler(["kv", "namespace", "list"], {
      capture: true,
    }).stdout,
  );
  updatesNamespace = namespaces.find(
    (item) => item.title === updatesNamespaceName,
  );
}
if (!updatesNamespace?.id) {
  throw new Error("没有取得 FlowCut 云更新 KV 命名空间 ID");
}

const recovery = readJson(recoveryPath);
recovery.databaseId = databaseId;
const config = {
  $schema: "../node_modules/wrangler/config-schema.json",
  name: workerName,
  main: "../worker/index.ts",
  compatibility_date: "2026-05-22",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: true,
  vars: {
    FLOWCUT_CONTROL_PLANE: "1",
    FLOWCUT_CONTROL_PLANE_VERSION: "1.1.0",
    FLOWCUT_ADMIN_USERNAME: recovery.adminUsername || "admin",
  },
  secrets: {
    required: [
      "FLOWCUT_ADMIN_PASSWORD",
      "FLOWCUT_LICENSE_PRIVATE_JWK",
      "FLOWCUT_LICENSE_PUBLIC_JWK",
    ],
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: databaseName,
      database_id: databaseId,
    },
  ],
  kv_namespaces: [
    {
      binding: "UPDATES_KV",
      id: updatesNamespace.id,
    },
  ],
  observability: { enabled: true },
};
writePrivateJson(wranglerConfigPath, config);
writePrivateJson(recoveryPath, recovery);

runWrangler([
  "d1",
  "execute",
  "DB",
  "--remote",
  "--file",
  path.join(projectRoot, "cloudflare", "license-schema.sql"),
  "--config",
  wranglerConfigPath,
  "--yes",
]);

runNpm(["run", "build"], {
  env: { FLOWCUT_WRANGLER_CONFIG_PATH: wranglerConfigPath },
});

const deployment = runWrangler(
  ["deploy", "--secrets-file", secretsPath],
  { capture: true },
);
process.stdout.write(deployment.stdout || "");
process.stderr.write(deployment.stderr || "");
const combined = `${deployment.stdout || ""}\n${deployment.stderr || ""}`;
const url =
  combined.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/iu)?.[0] ||
  recovery.controlPlaneUrl;
if (!url) {
  throw new Error(
    "部署完成但没有识别出 workers.dev 地址，请从上面的 Cloudflare 输出中确认地址",
  );
}

function readWindowsProxy() {
  if (process.platform !== "win32") return "";
  const key =
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const enabledResult = spawnSync(
    "reg.exe",
    ["query", key, "/v", "ProxyEnable"],
    { encoding: "utf8", windowsHide: true },
  );
  if (
    enabledResult.status !== 0 ||
    !/\b0x1\b/i.test(enabledResult.stdout || "")
  ) {
    return "";
  }
  const proxyResult = spawnSync(
    "reg.exe",
    ["query", key, "/v", "ProxyServer"],
    { encoding: "utf8", windowsHide: true },
  );
  const raw = String(proxyResult.stdout || "")
    .match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]
    ?.trim();
  if (!raw) return "";
  const entries = raw.split(";").map((item) => item.trim());
  const mapped =
    entries
      .find((item) => /^https=/i.test(item))
      ?.replace(/^https=/i, "") ||
    entries
      .find((item) => /^http=/i.test(item))
      ?.replace(/^http=/i, "") ||
    raw;
  return /^[a-z]+:\/\//i.test(mapped) ? mapped : `http://${mapped}`;
}

async function checkControlPlane(endpoint) {
  try {
    const response = await fetch(endpoint, {
      headers: { accept: "application/json" },
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json().catch(() => ({})),
    };
  } catch (fetchError) {
    const proxy = readWindowsProxy();
    if (!proxy) throw fetchError;
    const curl = spawnSync(
      "curl.exe",
      [
        "--silent",
        "--show-error",
        "--fail-with-body",
        "--max-time",
        "30",
        "--proxy",
        proxy,
        endpoint,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (curl.status !== 0) throw fetchError;
    return {
      ok: true,
      status: 200,
      body: JSON.parse(curl.stdout || "{}"),
    };
  }
}

const statusResult = await checkControlPlane(
  `${url.replace(/\/+$/, "")}/api/control-plane/status`,
);
const status = statusResult.body;
if (!statusResult.ok || status?.ok !== true) {
  throw new Error(
    `授权中心已发布，但健康检查失败：${statusResult.status}`,
  );
}
if (!status.signingKeyConfigured) {
  throw new Error("授权中心缺少许可证签名密钥");
}

recovery.controlPlaneUrl = url.replace(/\/+$/, "");
recovery.deployedAt = new Date().toISOString();
writePrivateJson(recoveryPath, recovery);
writePrivateJson(desktopDistributionPath, {
  controlPlaneUrl: recovery.controlPlaneUrl,
  publicJwk: recovery.publicJwk,
});

console.log("");
console.log("FlowCut 自有授权中心部署成功：");
console.log(recovery.controlPlaneUrl);
console.log("接下来需要把该地址和公钥写入桌面客户端并重新打包。");
