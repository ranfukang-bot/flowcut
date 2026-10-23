import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { bridgeSource, uiSource } from "./helpers/sources.mjs";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("studio exposes multi-image product upload", async () => {
  const [studio, products] = await Promise.all([
    Promise.resolve(uiSource()),
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
  assert.match(studio, /把商品图拖到这里，或点击选择/);
  assert.match(studio, /setQuickFiles\(\(current\)/);
  assert.match(studio, /选择已有商品/);
  assert.match(studio, /productMode === "new"/);
  assert.match(studio, /开始后存进商品库/);
  assert.match(studio, /URL\.createObjectURL/);
  assert.match(studio, /商品名称（选填）/);
  assert.match(products, /\.getAll\("images"\)/);
  assert.match(products, /INSERT INTO product_images/);
  assert.doesNotMatch(products, /产品名称不能为空/);
});

test("clearing completed tasks retains product assets and remix group history", async t => {
  const {siteFixture}=await import('../gemini-web-workbench/tests/helpers/site-routes.cjs');
  const f=await siteFixture(t),at=new Date().toISOString();
  f.sqlite.prepare("INSERT INTO products(id,name,external_id,created_at) VALUES('product','商品','1735360337668113923',?)").run(at);
  f.objects.set('products/product/image.png','image');
  for(const id of ['ordinary','remix','release'])f.sqlite.prepare("INSERT INTO tasks(id,product_id,gem_id,title,status,prompt,provider,created_at,updated_at,review_status) VALUES(?,'product','gem',?,'video_ready','','seedance-bridge',?,?,'approved')").run(id,id,at,at);
  f.sqlite.prepare("UPDATE tasks SET task_role='remix',status='remix_done',review_status='pending' WHERE id='remix'").run();
  f.sqlite.prepare("UPDATE tasks SET task_role='concat',batch_parent_id='remix' WHERE id='release'").run();
  const result=await f.call('tasks','DELETE',{query:'?completed=1'});
  assert.equal(result.status,200);assert.equal(result.body.deleted,1);
  assert.equal(f.row("SELECT id FROM tasks WHERE id='ordinary'"),null);
  assert.deepEqual(f.rows('SELECT id FROM tasks ORDER BY id').map(r=>r.id),['release','remix']);
  assert.ok(f.row("SELECT id FROM products WHERE id='product'"));assert.equal(f.objects.get('products/product/image.png'),'image');
});

test("Gemini web transient failures are persisted for delayed automatic recovery", async () => {
  const [bridge, storage, desktopBridge] = await Promise.all([
    Promise.resolve(bridgeSource()),
    source("lib/storage.ts"),
    source("gemini-web-workbench/src/bridge-engine.js"),
  ]);

  assert.match(bridge, /job\.action === "defer"/);
  assert.match(bridge, /gemini_retry_at/);
  assert.match(
    bridge,
    /geminiRetryPlan\(failures, body.accountLimited === true\)/,
  );
  assert.match(storage, /gemini_failures/);
  assert.match(storage, /gemini_retry_at/);
  assert.match(desktopBridge, /this\.report\(job\.id, "defer"/);
});

test("desktop runtime hides developer overlays and accepts idempotent Gemini writeback", async () => {
  const [viteConfig, settingsRoute, bridgeRoute] = await Promise.all([
    source("vite.config.ts"),
    source("app/api/settings/route.ts"),
    Promise.resolve(bridgeSource()),
  ]);
  assert.match(viteConfig, /isDesktopRuntime \? \{ overlay: false \}/);
  assert.match(viteConfig, /"\*\*\/release\/\*\*"/);
  assert.match(settingsRoute, /desktopRuntime:/);
  assert.match(bridgeRoute, /alreadyApplied: true/);
  assert.match(bridgeRoute, /ignorable: true/);
  assert.match(bridgeRoute, /status = 'prompt_generating'/);
});

test("studio exposes encrypted providers, concurrent tasks and Seedance bridge", async () => {
  const [studio, settings, tasks, bridge, geminiBridge, providerConfig, tiktokAccounts] = await Promise.all([
    Promise.resolve(uiSource()),
    source("app/api/settings/route.ts"),
    source("app/api/tasks/route.ts"),
    source("app/api/seedance-bridge/route.ts"),
    Promise.resolve(bridgeSource()),
    source("lib/provider-config.ts"),
    source("app/api/tiktok-accounts/route.ts"),
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
  assert.match(studio, /本次设置/);
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
  assert.match(geminiBridge, /job\.action === "retrying"/);
  assert.match(geminiBridge, /activeTaskIds/);
  assert.match(geminiBridge, /bridge_claimed_at = \?/);
  assert.match(settings, /saveProviderConfig/);
  assert.match(settings, /generateContent/);
  assert.match(providerConfig, /AES-GCM/);
  assert.doesNotMatch(settings, /secrets\.apiKey[^;]*Response\.json/);
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

test("Gemini API has no fixed model or forced thinking configuration", async () => {
  const [gemini, settings, providerConfig] = await Promise.all([
    source("lib/gemini.ts"),
    source("app/api/settings/route.ts"),
    source("lib/provider-config.ts"),
  ]);

  assert.match(gemini, /resolveGeminiApiModel/);
  assert.match(gemini, /supportedGenerationMethods/);
  assert.doesNotMatch(gemini, /thinkingConfig/);
  assert.doesNotMatch(settings, /thinkingConfig/);
  assert.match(providerConfig, /model: ""/);
});
