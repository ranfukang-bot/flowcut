import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = async (path) => (await readFile(new URL(path, root), "utf8")).replace(/\r\n/g, "\n");

test("reference remix is isolated from the editable Gem library", async () => {
  const [studio, storage, remix, gemPolicy] = await Promise.all([
    source("app/studio-app.tsx"),
    source("lib/storage.ts"),
    source("app/api/reference-remix/route.ts"),
    source("tests/gemini-prompt-policy.test.mjs"),
  ]);
  assert.match(studio, /爆款复刻/);
  assert.match(studio, /仅本模块使用，不会出现在普通 Gem 列表/);
  assert.match(storage, /reference_remix_tasks/);
  assert.match(storage, /reference_remix_assets/);
  assert.match(remix, /referenceRemixGemPreview/);
  assert.match(gemPolicy, /DELETE FROM gems WHERE is_default = 1/);
  assert.doesNotMatch(storage, /INSERT INTO gems[\s\S]*爆款视频结构复刻/);
});

test("Gemini runs video analysis and product adaptation in one conversation", async () => {
  const [preload, bridgeRoute, desktopBridge, promptBuilder] = await Promise.all([
    source("gemini-web-workbench/src/gemini-preload.js"),
    source("app/api/gemini-bridge/route.ts"),
    source("gemini-web-workbench/src/bridge-engine.js"),
    source("lib/reference-remix.ts"),
  ]);
  const remixFunction = preload.match(
    /async function runReferenceRemixJob[\s\S]*?return \{ analysis, prompt \};\n\}/,
  )?.[0] || "";
  assert.ok(remixFunction);
  assert.equal((remixFunction.match(/ensureFreshConversation\(\)/g) || []).length, 1);
  assert.match(remixFunction, /referenceFilePaths/);
  assert.match(remixFunction, /adaptationPrompt/);
  assert.match(remixFunction, /conversationUrl !== location\.href/);
  assert.match(preload, /function composerMatches/);
  // Gemini can render current attachments beside rich-textarea. Keep history
  // excluded without requiring root.contains (covered by real DOM fixtures).
  const composerMatcher = preload.slice(preload.indexOf('function composerMatches('), preload.indexOf('function attachmentCount('));
  assert.match(composerMatcher, /!element\.closest/);
  assert.match(composerMatcher, /user-query, chat-history/);
  assert.match(composerMatcher, /if \(!root\) return \[\]/);
  assert.match(bridgeRoute, /status = 'product_adapting'/);
  assert.match(desktopBridge, /referenceVideoUrl/);
  assert.match(promptBuilder, /replace\(\/15\\s\*秒\/g/);
  assert.match(promptBuilder, /\$\{region\}的TIKTOK平台喜好/);
});

test("reference remix output continues through Seedance and TK archive metadata", async () => {
  const [api, seedance, localBridge] = await Promise.all([
    source("app/api/reference-remix/route.ts"),
    source("app/api/seedance-bridge/route.ts"),
    source("vendor/seedance-engine/flowcut-bridge.js"),
  ]);
  assert.match(api, /tiktokAccountName/);
  assert.match(api, /product_external_id/);
  assert.match(seedance, /kind: "reference-remix"/);
  assert.match(seedance, /reference_remix_assets/);
  assert.match(localBridge, /flowcutTaskKind/);
  assert.match(localBridge, /productExternalId/);
  assert.match(localBridge, /tiktokAccountName/);
});
