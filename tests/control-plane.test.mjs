import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("self-owned control plane keeps business APIs private", async () => {
  const [worker, statusRoute] = await Promise.all([
    source("worker/index.ts"),
    source("app/api/control-plane/status/route.ts"),
  ]);
  assert.match(worker, /FLOWCUT_CONTROL_PLANE === "1"/);
  assert.match(worker, /\/api\/control-plane\//);
  assert.match(worker, /公网授权中心不提供本地工作台业务接口/);
  assert.match(worker, /x-frame-options/);
  assert.match(worker, /strict-transport-security/);
  assert.match(statusRoute, /flowcut-control-plane/);
  assert.match(statusRoute, /signingKeyConfigured/);
});

test("public login routes are throttled", async () => {
  const [license, desktopLogin, adminLogin] = await Promise.all([
    source("lib/license.ts"),
    source("app/api/license/login/route.ts"),
    source("app/api/admin/login/route.ts"),
  ]);
  assert.match(license, /license_login_limits/);
  assert.match(license, /LOGIN_MAX_FAILURES = 8/);
  assert.match(desktopLogin, /checkLoginThrottle/);
  assert.match(desktopLogin, /recordLoginFailure/);
  assert.match(adminLogin, /checkLoginThrottle/);
  assert.match(adminLogin, /retry-after/);
});

test("Cloudflare ownership handoff includes prepare, deploy and backup tools", async () => {
  const [manifest, deploy, backup, backupRoute, guide] = await Promise.all([
    source("package.json"),
    source("scripts/cloudflare-deploy.mjs"),
    source("scripts/cloudflare-backup.mjs"),
    source("app/api/admin/backup/route.ts"),
    source("cloudflare/README.md"),
  ]);
  assert.match(manifest, /cloudflare:prepare/);
  assert.match(manifest, /cloudflare:deploy/);
  assert.match(manifest, /cloudflare:backup/);
  assert.match(deploy, /runWrangler\(\[\s*"d1",\s+"create"/);
  assert.match(deploy, /api\/control-plane\/status/);
  assert.match(backup, /runWrangler\(\[\s*"d1",\s+"export"/);
  assert.match(backupRoute, /flowcut-license-backup/);
  assert.match(backupRoute, /只允许导入到空数据库/);
  assert.match(guide, /你必须亲自完成的步骤/);
});

test("admin can permanently delete a licensed user and related access records", async () => {
  const [adminUi, adminRoute] = await Promise.all([
    source("app/admin-app.tsx"),
    source("app/api/admin/license/route.ts"),
  ]);
  assert.match(adminUi, /删除账号/);
  assert.match(adminUi, /action: "deleteUser"/);
  assert.match(adminRoute, /action === "deleteUser"/);
  assert.match(adminRoute, /DELETE FROM license_sessions WHERE user_id = \?/);
  assert.match(adminRoute, /DELETE FROM license_devices WHERE user_id = \?/);
  assert.match(adminRoute, /DELETE FROM license_users WHERE id = \?/);
});
