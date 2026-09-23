import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("studio exposes multi-image product upload", async () => {
  const [studio, products] = await Promise.all([
    source("app/studio-app.tsx"),
    source("app/api/products/route.ts"),
  ]);

  assert.match(studio, /multiple/);
  assert.match(studio, /onDrop=\{onDrop\}/);
  assert.match(studio, /form\.append\("images"/);
  assert.match(studio, /quickUploadProduct/);
  assert.match(studio, /quickProductName/);
  assert.match(studio, /form\.set\("name", productName\.trim\(\)\)/);
  assert.match(studio, /ProductEditModal/);
  assert.match(products, /export async function PUT/);
  assert.match(products, /UPDATE products/);
  assert.match(studio, /拖拽商品图到这里，或点击批量选择/);
  assert.match(studio, /setQuickFiles\(\(current\)/);
  assert.match(studio, /上传新商品与选择商品库二选一/);
  assert.match(studio, /productMode === "new"/);
  assert.match(studio, /新商品会自动入库/);
  assert.match(studio, /URL\.createObjectURL/);
  assert.match(studio, /商品名称（选填）/);
  assert.match(products, /\.getAll\("images"\)/);
  assert.match(products, /INSERT INTO product_images/);
  assert.doesNotMatch(products, /产品名称不能为空/);
});

test("task queue can clear all completed records without deleting product assets", async () => {
  const [studio, tasks] = await Promise.all([
    source("app/studio-app.tsx"),
    source("app/api/tasks/route.ts"),
  ]);

  assert.match(studio, /清除已完成/);
  assert.match(studio, /\/api\/tasks\?completed=1/);
  assert.match(tasks, /url\.searchParams\.get\("completed"\) === "1"/);
  assert.match(tasks, /DELETE FROM schedules/);
  assert.match(tasks, /DELETE FROM tasks WHERE status IN/);
  assert.match(tasks, /"video_ready", "scheduled"/);
  assert.doesNotMatch(tasks, /DELETE FROM products WHERE status/);
});

test("Gemini web transient failures are persisted for delayed automatic recovery", async () => {
  const [bridge, storage, schema, desktopBridge] = await Promise.all([
    source("app/api/gemini-bridge/route.ts"),
    source("lib/storage.ts"),
    source("db/schema.ts"),
    source("gemini-web-workbench/src/bridge-engine.js"),
  ]);

  assert.match(bridge, /body\.action === "defer"/);
  assert.match(bridge, /gemini_retry_at/);
  assert.match(
    bridge,
    /retryDelays = \[2 \* 60_000, 10 \* 60_000, 30 \* 60_000\]/,
  );
  assert.match(storage, /gemini_failures/);
  assert.match(storage, /gemini_retry_at/);
  assert.match(schema, /geminiFailures/);
  assert.match(schema, /geminiRetryAt/);
  assert.match(desktopBridge, /this\.report\(job\.id, "defer"/);
});

test("desktop runtime hides developer overlays and accepts idempotent Gemini writeback", async () => {
  const [viteConfig, settingsRoute, bridgeRoute] = await Promise.all([
    source("vite.config.ts"),
    source("app/api/settings/route.ts"),
    source("app/api/gemini-bridge/route.ts"),
  ]);
  assert.match(viteConfig, /isDesktopRuntime \? \{ overlay: false \}/);
  assert.match(viteConfig, /"\*\*\/release\/\*\*"/);
  assert.match(settingsRoute, /desktopRuntime:/);
  assert.match(bridgeRoute, /alreadyApplied: true/);
  assert.match(bridgeRoute, /ignorable: true/);
  assert.match(bridgeRoute, /status = 'prompt_generating'/);
});

test("studio exposes encrypted providers, concurrent tasks and Seedance bridge", async () => {
  const [studio, settings, tasks, bridge, geminiBridge, providerConfig, tiktokAccounts, desktopRenderer] = await Promise.all([
    source("app/studio-app.tsx"),
    source("app/api/settings/route.ts"),
    source("app/api/tasks/route.ts"),
    source("app/api/seedance-bridge/route.ts"),
    source("app/api/gemini-bridge/route.ts"),
    source("lib/provider-config.ts"),
    source("app/api/tiktok-accounts/route.ts"),
    source("gemini-web-workbench/src/renderer.js"),
  ]);

  assert.match(studio, /Gemini API/);
  assert.match(studio, /Seedance 2\.0/);
  assert.match(studio, /action: "process"/);
  assert.match(studio, /Promise\.allSettled/);
  assert.match(studio, /TK 归档账号/);
  assert.match(studio, /TikTokAccountModal/);
  assert.match(studio, /添加并选择/);
  assert.doesNotMatch(studio, /window\.prompt/);
  assert.match(studio, /成片自动保存到/);
  assert.match(studio, /selectedTikTokAccount/);
  assert.match(studio, /设置本次视频/);
  assert.match(studio, /selectedDuration/);
  assert.match(studio, /selectedRegion/);
  assert.match(studio, /selectedShootingStyle/);
  assert.match(tasks, /shooting_style/);
  assert.match(bridge, /duration: task\.duration/);
  assert.doesNotMatch(studio, /fetch\(`\$\{LOCAL_SEEDANCE_BASE\}/);
  assert.match(tasks, /status = 'prompt_generating'/);
  assert.match(tasks, /status = 'video_queued'/);
  assert.match(bridge, /bridge_claimed_at/);
  assert.match(bridge, /products\.external_id/);
  assert.match(bridge, /productExternalId/);
  assert.match(bridge, /tiktokAccountName/);
  assert.match(tasks, /validateTikTokAccountName/);
  assert.match(tiktokAccounts, /INSERT INTO tiktok_accounts/);
  assert.match(bridge, /action === "heartbeat"/);
  assert.match(geminiBridge, /body\.action === "retrying"/);
  assert.match(geminiBridge, /activeTaskIds/);
  assert.match(geminiBridge, /bridge_claimed_at = \?/);
  assert.match(settings, /saveProviderConfig/);
  assert.match(settings, /generateContent/);
  assert.match(providerConfig, /AES-GCM/);
  assert.doesNotMatch(settings, /secrets\.apiKey[^;]*Response\.json/);
  assert.match(desktopRenderer, /account-name-dialog/);
  assert.doesNotMatch(desktopRenderer, /\bprompt\(/);
});

test("duration, region and shooting style travel through the real task chain", async () => {
  const [tasks, gemini, seedanceBridge, flowcutBridge, tiktokClient] =
    await Promise.all([
      source("app/api/tasks/route.ts"),
      source("lib/gemini.ts"),
      source("app/api/seedance-bridge/route.ts"),
      source("vendor/seedance-engine/flowcut-bridge.js"),
      source("vendor/seedance-engine/tiktok-client.js"),
    ]);

  assert.match(tasks, /duration, region, shooting_style/);
  assert.match(gemini, /`时长：\$\{product\.duration\}秒`/);
  assert.match(gemini, /`地区：\$\{product\.region\}`/);
  assert.match(gemini, /`拍摄风格：\$\{product\.shooting_style\}`/);
  assert.match(seedanceBridge, /tasks\.duration/);
  assert.match(seedanceBridge, /duration: task\.duration/);
  assert.match(flowcutBridge, /duration: Number\(job\.duration \|\| 15\)/);
  assert.match(tiktokClient, /const duration = normalizeDuration\(task\.duration\)/);
  assert.match(tiktokClient, /prompt: task\.prompt,\s+duration,/);
  assert.doesNotMatch(tiktokClient, /duration: 15,/);
});

test("Gemini web preserves the selected web model and API has no fixed model", async () => {
  const [gemini, settings, providerConfig, preload] = await Promise.all([
    source("lib/gemini.ts"),
    source("app/api/settings/route.ts"),
    source("lib/provider-config.ts"),
    source("gemini-web-workbench/src/gemini-preload.js"),
  ]);

  assert.match(gemini, /resolveGeminiApiModel/);
  assert.match(gemini, /supportedGenerationMethods/);
  assert.doesNotMatch(gemini, /thinkingConfig/);
  assert.doesNotMatch(settings, /thinkingConfig/);
  assert.match(providerConfig, /model: ""/);
  assert.doesNotMatch(preload, /ensureProModel/);
  assert.doesNotMatch(preload, /MODEL_SELECTION_FAILED/);
});
