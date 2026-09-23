import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("license control plane has plans, renewal records and client entitlements", () => {
  const license = read("lib/license.ts");
  const admin = read("app/api/admin/license/route.ts");
  const client = read("gemini-web-workbench/src/license-client.js");
  assert.match(license, /starter:[\s\S]*monthlyPriceYuan:\s*299/);
  assert.match(license, /pro:[\s\S]*monthlyPriceYuan:\s*599/);
  assert.match(license, /team:[\s\S]*monthlyPriceYuan:\s*1299/);
  assert.match(license, /flagship:[\s\S]*maxConcurrent:\s*999/);
  assert.match(license, /custom:[\s\S]*monthlyPriceYuan:\s*0/);
  assert.match(license, /max_concurrent/);
  assert.match(admin, /action === "renewUser"/);
  assert.match(admin, /renewedMaxConcurrent/);
  assert.match(admin, /INSERT INTO license_payments/);
  assert.match(client, /planName/);
  assert.match(client, /maxConcurrent/);
});

test("personal package excludes commercial updates while old server source is retained", () => {
  const desktopPackage = JSON.parse(
    read("gemini-web-workbench/package.json"),
  );
  const updater = read("gemini-web-workbench/src/update-manager.js");
  const updateRoute = read("app/api/updates/windows/[asset]/route.ts");
  assert.match(desktopPackage.version, /^\d+\.\d+\.\d+$/);
  assert.equal(desktopPackage.dependencies["electron-updater"], undefined);
  assert.equal(desktopPackage.build.publish, undefined);
  assert.match(updater, /autoUpdater\.checkForUpdates/);
  assert.match(updater, /quitAndInstall/);
  assert.match(updateRoute, /runtimeEnv\(\)\.UPDATES \|\| runtimeEnv\(\)\.MEDIA/);
  assert.match(updateRoute, /runtimeEnv\(\)\.UPDATES_KV/);
  assert.match(updateRoute, /accept-ranges/);
});
