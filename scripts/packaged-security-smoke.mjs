import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const root = path.resolve(import.meta.dirname, "..");
if (process.platform === "win32") {
  try {
    const registry = execFileSync(
      "reg.exe",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        "/v",
        "ProxyServer",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const proxy = registry.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
    if (proxy) setGlobalDispatcher(new ProxyAgent(`http://${proxy}`));
  } catch {}
}

const recovery = JSON.parse(
  fs.readFileSync(path.join(root, ".flowcut-cloudflare", "recovery.json"), "utf8"),
);
const base = String(recovery.controlPlaneUrl || "").replace(/\/+$/, "");
const adminLogin = await fetch(`${base}/api/admin/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username: recovery.adminUsername,
    password: recovery.adminPassword,
  }),
});
if (!adminLogin.ok) throw new Error(`管理员测试登录失败：${adminLogin.status}`);
const cookie = adminLogin.headers.get("set-cookie")?.split(";")[0] || "";
const suffix = Date.now().toString(36);
const username = `desktop-smoke-${suffix}`;
const password = randomBytes(24).toString("base64url");
let userId = "";
let child = null;
let childExit = null;

async function adminAction(body) {
  const response = await fetch(`${base}/api/admin/license`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `管理员操作失败：${response.status}`);
  return data;
}

try {
  const created = await adminAction({
    action: "createUser",
    username,
    password,
    planCode: "trial",
    maxDevices: 1,
    maxConcurrent: 1,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    notes: "受保护安装包冒烟测试，完成后自动删除",
  });
  userId = created.users?.find((item) => item.username === username)?.id || "";
  if (!userId) throw new Error("测试账号创建后没有返回账号 ID");

  const executable = path.join(
    root,
    "gemini-web-workbench",
    "release",
    "win-unpacked",
    "FlowCut全自动AI视频工作台.exe",
  );
  const smokeFile = path.join(os.tmpdir(), `flowcut-packaged-authorized-${suffix}.json`);
  const isolatedUserData = path.join(os.tmpdir(), `flowcut-user-data-${suffix}`);
  child = spawn(executable, [`--user-data-dir=${isolatedUserData}`], {
    env: {
      ...process.env,
      FLOWCUT_TEST_LICENSE_USERNAME: username,
      FLOWCUT_TEST_LICENSE_PASSWORD: password,
      FLOWCUT_DESKTOP_SMOKE_FILE: smokeFile,
    },
    windowsHide: true,
    stdio: "ignore",
  });
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !fs.existsSync(smokeFile) && !childExit) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (childExit) {
    throw new Error(
      `受保护安装包提前退出：${childExit.signal || childExit.code || "unknown"}`,
    );
  }
  if (!fs.existsSync(smokeFile)) throw new Error("受保护安装包启动超时");
  const result = JSON.parse(fs.readFileSync(smokeFile, "utf8"));
  if (!result.license?.authorized || !result.workbenchStarted) {
    throw new Error(`受保护安装包未进入已授权工作台：${result.license?.error || "未知错误"}`);
  }
  if (!result.geminiPageRuntimeReady) {
    throw new Error("受保护安装包没有成功注入 Gemini 页面执行器");
  }
  const response = await fetch(`${result.siteUrl}/api/settings`, {
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (response?.status !== 401) {
    throw new Error("本地业务接口没有拒绝缺少随机凭证的外部访问");
  }
  console.log("Protected packaged desktop smoke test passed.");
} finally {
  if (child?.pid && process.platform === "win32") {
    try {
      execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {}
  } else {
    child?.kill("SIGKILL");
  }
  if (userId) await adminAction({ action: "deleteUser", userId }).catch(() => {});
}
