import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("script prompt pipeline is persisted and exposed in the studio", () => {
  const storage = read("lib/storage.ts");
  const workspace = read("app/api/workspace/route.ts");
  const studio = read("app/studio-app.tsx");
  assert.match(storage, /CREATE TABLE IF NOT EXISTS script_pipeline_tasks/);
  assert.match(workspace, /scriptPipelineTasks/);
  assert.match(studio, /全自动剧本提示词/);
  assert.match(studio, /Seedance 2\.5｜官方写法视频提示词工程师/);
  assert.match(studio, /最终可复制提示词/);
  assert.match(studio, /"optimization_queued", "optimizing"/);
  assert.match(studio, /document\.addEventListener\("visibilitychange", refreshVisiblePage\)/);
  assert.match(studio, /Gem 正在后台自动优化/);
});

test("Gemini bridge supports all five script stages and durable results", () => {
  const bridge = read("app/api/gemini-bridge/route.ts");
  const route = read("app/api/script-pipeline/route.ts");
  assert.match(bridge, /kind: "script-pipeline"/);
  for (const stage of ["rewriting", "extracting", "storyboarding", "grouping", "optimizing"]) {
    assert.match(bridge, new RegExp(stage));
  }
  assert.match(bridge, /optimized_groups_json = \?/);
  assert.match(route, /'rewrite_queued'/);
  assert.match(route, /alreadyRunning/);
  assert.match(route, /alreadyCompleted/);
  assert.match(route, /WHERE id = \? AND status = 'failed'/);
  assert.match(route, /WHEN extraction_json <> '' THEN 'storyboarding'/);
  assert.equal(route.includes("rewritten_script = '', extraction_json = '', storyboard_json = ''"), false);
});
