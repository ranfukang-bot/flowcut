import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { bridgeSource, uiSource } from "./helpers/sources.mjs";

const root = new URL("../", import.meta.url);
const source = async (path) => (await readFile(new URL(path, root), "utf8")).replace(/\r\n/g, "\n");

test("segmented remix exposes the exact immutable Gem for per-account bindings", async t => {
  const {siteFixture}=await import('../gemini-web-workbench/tests/helpers/site-routes.cjs');
  const fixture=await siteFixture(t);
  const result=await fixture.call('reference-remix','GET');
  assert.equal(result.body.gem.id,'builtin-reference-remix');
  assert.equal(result.body.gem.name,'爆款视频复刻智能体');
  assert.equal(result.body.gem.content,await readFile(new URL('lib/reference-remix-segments-gem.txt',root),'utf8'));
  assert.equal(result.body.gem.locked,true);
  const workspace=await fixture.call('workspace','GET');
  assert.ok(workspace.body.gems.some(g=>g.id===result.body.gem.id&&g.locked));
  assert.equal((await fixture.call('gems','PUT',{body:{...result.body.gem,content:'changed'}})).status,409);
  assert.equal((await fixture.call('gems','DELETE',{body:{id:result.body.gem.id}})).status,409);
});

test("Gemini runs video analysis and product adaptation in one conversation", async () => {
  const [preload, bridgeRoute, desktopBridge, promptBuilder] = await Promise.all([
    source("gemini-web-workbench/src/gemini-preload.js"),
    Promise.resolve(bridgeSource()),
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
