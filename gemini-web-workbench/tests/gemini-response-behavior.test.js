const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { watchGeminiJob } = require("../src/gemini-job-watchdog");
const source = fs.readFileSync(require.resolve("../src/gemini-preload.js"), "utf8");
const responseCode = source.slice(source.indexOf("async function waitForResponse("), source.indexOf("\nasync function runJob("));
async function responseScenario(snapshot, generating, initial = []) {
  let now = 0;
  const context = vm.createContext({
    Date: { now: () => now }, JSON, String,
    sleep: async ms => { now += ms; },
    responseSnapshot: () => snapshot(now), generationInProgress: () => generating(now),
    loginOrChallengeVisible: () => false, visibleGeminiError: () => "",
    classifyUnusableResponse: () => null,
    codedError: (message, code) => Object.assign(new Error(message), { code }),
    geminiProgress: "",
  });
  vm.runInContext(responseCode, context);
  const value = await context.waitForResponse(initial);
  return { value, elapsed: now };
}
test("a pause in streaming does not submit a truncated prompt to video generation", async () => {
  const partial = "A".repeat(300), complete = partial + " final scene";
  const result = await responseScenario(t => [t < 15_000 ? partial : complete], t => t < 16_000);
  assert.equal(result.value, complete);
  assert.ok(result.elapsed >= 18_000);
});
test("a slow but progressing answer can take longer than the previous 90-second cutoff", async () => {
  const result = await responseScenario(t => ["A".repeat(300 + Math.min(Math.floor(t / 1000), 120))], t => t < 120_000);
  assert.equal(result.value.length, 420);
  assert.ok(result.elapsed > 120_000);
});
test("an unchanged previous answer is never mistaken for the new answer", async () => {
  const previous = "old".repeat(150);
  await assert.rejects(responseScenario(() => [previous], () => false, [previous]), { code: "NO_RESPONSE_DETECTED" });
});
test("a stuck stop button fails with a recoverable stall instead of returning partial text", async () => {
  await assert.rejects(responseScenario(() => ["partial".repeat(60)], () => true), { code: "RESPONSE_STALLED" });
});
test("short final replies fail instead of holding the queue forever", async () => {
  await assert.rejects(responseScenario(() => ["short answer"], () => false), { code: "INCOMPLETE_RESPONSE" });
});
function watcher() {
  let now = 0, tick, cancels = 0;
  const contents = new EventEmitter(), failures = [];
  const watch = watchGeminiJob({ contents, onFailure: error => failures.push(error.code), timeoutMs: 300_000,
    now: () => now, schedule: fn => { tick = fn; return 1; }, cancel: () => cancels++ });
  return { watch, contents, failures, advance(ms) { now += ms; tick(); }, cancels: () => cancels };
}
test("renderer crash releases a pending job once and removes listeners", () => {
  const f = watcher(); f.contents.emit("render-process-gone"); f.contents.emit("destroyed");
  assert.deepEqual(f.failures, ["GEMINI_PAGE_CRASHED"]);
  assert.equal(f.contents.listenerCount("destroyed"), 0); assert.equal(f.cancels(), 1);
});
test("page heartbeats keep a working task alive; a silent renderer is recovered", () => {
  const f = watcher(); f.advance(60_000); f.watch.touch(); f.advance(60_000);
  assert.deepEqual(f.failures, []); f.advance(31_000);
  assert.deepEqual(f.failures, ["GEMINI_PAGE_UNRESPONSIVE"]);
});
test("success disposes the watchdog without a later failure", () => {
  const f = watcher(); f.watch.stop(); f.advance(400_000);
  assert.deepEqual(f.failures, []); assert.equal(f.cancels(), 1);
});
