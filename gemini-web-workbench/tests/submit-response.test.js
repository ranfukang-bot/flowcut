const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../../vendor/seedance-engine/store");
const { QueueEngine } = require("../../vendor/seedance-engine/queue-engine");
const { TikTokClient } = require("../../vendor/seedance-engine/tiktok-client");

// The real TikTok client on top of a fake Electron session: only the HTTP
// answer to the generation request changes between cases.
function setup(t, answer) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flowcut-response-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  const account = store.accounts[0];
  const requests = [];
  const session = {
    cookies: { get: async () => [] },
    async fetch(url, init = {}) {
      requests.push(url);
      if (url.includes("/i2v/gen_r2v_video")) return answer();
      if (url.includes("/generating-task-count")) return Response.json({ code: 0, data: { total: 0 } });
      if (url.includes("/history/tasks")) return Response.json({ code: 0, data: { draft_infos: [] } });
      throw new Error(`unexpected request ${url} ${init.method || "GET"}`);
    },
  };
  const client = new TikTokClient(session);
  const accounts = {
    authenticated: true,
    authCheckedAt: Date.now(),
    client: () => client,
    availableAccount: async () => account,
    ensureRuntime: () => ({ maxConcurrent: 5 }),
    effectiveModel: () => "2000012",
    isQuotaError: () => false,
    markAuthenticated: () => {},
    markAuthInvalid: () => {},
    accountName: () => account.name,
    refreshAuth: async () => true,
    state: () => ({ items: [] }),
  };
  store.upsertTask({
    id: "local-1",
    order: 1,
    prompt: "P".repeat(320),
    duration: 15,
    imageItems: [{ name: "1.jpg", localPath: "1.jpg", uploadedUrl: "https://img/1", uploadedAccountId: account.id }],
    status: "queued",
    attempts: 0,
    accountId: account.id,
    taskId: "",
    taskIds: [],
    logs: [],
  });
  const engine = new QueueEngine(store, accounts);
  const submissions = () => requests.filter((url) => url.includes("/i2v/gen_r2v_video")).length;
  return { store, engine, submissions };
}

async function submitThenRetry(t, answer) {
  const context = setup(t, answer);
  await context.engine.tick();
  const task = context.store.getTask("local-1");
  const first = { status: task.status, error: task.errorMessage };
  if (task.status === "failed") await context.engine.retryFailedTask("local-1");
  await context.engine.tick();
  await context.engine.tick();
  return { ...context, first, task };
}

const json = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

test("a success status with a truncated body is unconfirmed and never resent", async (t) => {
  const result = await submitThenRetry(t, () => json('{"code":0,"data":{"task_id":"7390'));
  assert.equal(result.first.status, "submit_unconfirmed");
  assert.match(result.first.error, /提交结果不确定/);
  assert.equal(result.submissions(), 1);
});

test("an empty success body is unconfirmed", async (t) => {
  const result = await submitThenRetry(t, () => json(""));
  assert.equal(result.first.status, "submit_unconfirmed");
  assert.equal(result.submissions(), 1);
});

test("a non-JSON page with a success status is unconfirmed, not treated as a logout resubmit", async (t) => {
  const result = await submitThenRetry(t, () =>
    new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }),
  );
  assert.equal(result.first.status, "submit_unconfirmed");
  assert.equal(result.submissions(), 1);
});

test("a server error answer is unconfirmed", async (t) => {
  const result = await submitThenRetry(t, () => json('{"code":500,"message":"internal"}', 502));
  assert.equal(result.first.status, "submit_unconfirmed");
  assert.equal(result.submissions(), 1);
});

test("a dropped connection is unconfirmed", async (t) => {
  const result = await submitThenRetry(t, () => {
    throw new TypeError("fetch failed");
  });
  assert.equal(result.first.status, "submit_unconfirmed");
  assert.equal(result.submissions(), 1);
});

test("an explicit error code from the platform is a failure that a retry may resend", async (t) => {
  const result = await submitThenRetry(t, () => json('{"code":40010,"message":"网络繁忙，请稍后重试"}'));
  assert.equal(result.first.status, "failed");
  assert.match(result.first.error, /^提交失败：网络繁忙/);
  assert.equal(result.submissions(), 2, "a definite refusal can be retried on request");
});

test("a plain HTTP 400 refusal is a failure", async (t) => {
  const result = await submitThenRetry(t, () => json('{"message":"bad request"}', 400));
  assert.equal(result.first.status, "failed");
});

test("tasks failed by older versions with an unreadable answer are not resent", async (t) => {
  const context = setup(t, () => json('{"code":0,"data":{"task_id":"1"}}'));
  const task = context.store.getTask("local-1");
  Object.assign(task, { status: "failed", errorMessage: "提交失败：接口 HTTP 200" });
  context.store.upsertTask(task);
  const outcome = await context.engine.retryFailedTask("local-1");
  await context.engine.tick();
  assert.equal(outcome.action, "unconfirmed");
  assert.equal(context.submissions(), 0);
});
