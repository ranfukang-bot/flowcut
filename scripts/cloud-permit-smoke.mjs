import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
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
  } catch {
    // Direct connection remains the fallback when Windows has no proxy.
  }
}
const recovery = JSON.parse(
  fs.readFileSync(path.join(root, ".flowcut-cloudflare", "recovery.json"), "utf8"),
);
const base = String(recovery.controlPlaneUrl || "").replace(/\/+$/, "");
if (!base) throw new Error("FlowCut 授权中心尚未部署");

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
const username = `permit-smoke-${suffix}`;
const password = randomBytes(24).toString("base64url");
let userId = "";

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
    notes: "自动化任务许可冒烟测试，完成后自动删除",
  });
  userId = created.users?.find((item) => item.username === username)?.id || "";
  if (!userId) throw new Error("测试账号创建后没有返回账号 ID");

  const fingerprintHash = "a".repeat(64);
  const login = await fetch(`${base}/api/license/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username,
      password,
      fingerprintHash,
      deviceName: "FlowCut permit smoke test",
      appVersion: "1.3.13-smoke",
    }),
  });
  const loginData = await login.json().catch(() => ({}));
  if (!login.ok || !loginData.sessionToken) {
    throw new Error(loginData.error || `测试账号登录失败：${login.status}`);
  }

  const taskId = `smoke-${suffix}`;
  const permitResponse = await fetch(`${base}/api/license/permit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionToken: loginData.sessionToken,
      fingerprintHash,
      deviceName: "FlowCut permit smoke test",
      appVersion: "1.3.13-smoke",
      taskId,
      stage: "gemini",
      kind: "standard",
    }),
  });
  const permitData = await permitResponse.json().catch(() => ({}));
  if (!permitResponse.ok || !permitData.permit) {
    throw new Error(permitData.error || `云端任务许可签发失败：${permitResponse.status}`);
  }
  const payload = JSON.parse(
    Buffer.from(permitData.permit.split(".")[1], "base64url").toString("utf8"),
  );
  if (
    payload.aud !== "flowcut-execution" ||
    payload.taskId !== taskId ||
    payload.stage !== "gemini" ||
    payload.fingerprintHash !== fingerprintHash
  ) {
    throw new Error("云端任务许可内容校验失败");
  }
  console.log("Cloud execution permit smoke test passed.");
} finally {
  if (userId) {
    await adminAction({ action: "deleteUser", userId }).catch(() => {});
  }
}
