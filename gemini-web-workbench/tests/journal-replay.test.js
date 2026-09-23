const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../../vendor/seedance-engine/store");
const { QueueEngine } = require("../../vendor/seedance-engine/queue-engine");

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flowcut-replay-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function lockStateFile(t) {
  const { renameSync } = fs;
  fs.renameSync = (from, to) => {
    if ([from, to].some((file) => String(file).endsWith("workbench-state.json"))) {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    }
    return renameSync(from, to);
  };
  const unlock = () => {
    fs.renameSync = renameSync;
  };
  t.after(unlock);
  return unlock;
}

function tiktok(answers) {
  const client = {
    submits: 0,
    polled: [],
    async submitTask() {
      const answer = answers[client.submits];
      client.submits += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async fetchHistory(ids) {
      client.polled.push(...ids);
      return { data: { draft_infos: [] } };
    },
    async getGeneratingCount() {
      return 0;
    },
  };
  return client;
}

function engineFor(store, client) {
  const account = store.accounts[0];
  return new QueueEngine(store, {
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
  });
}

function setup(t) {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  const account = store.accounts[0];
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
  return { directory, store, journal: path.join(directory, "submitted-tasks.jsonl") };
}

const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const refused = () => Object.assign(new Error("prompt contains restricted content"), { code: 40010, outcome: "rejected" });

test("a journal that cannot be read at startup blocks instead of counting as empty", async (t) => {
  const { directory, store, journal } = setup(t);
  const client = tiktok([timeout(), { data: { task_id: "7390000000000000002" } }]);
  const unlock = lockStateFile(t);
  await engineFor(store, client).tick(); // recorded only in the journal, answer unknown
  unlock();
  const recorded = fs.readFileSync(journal);

  const { readFileSync } = fs;
  fs.readFileSync = (file, ...rest) => {
    if (file === journal) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    return readFileSync(file, ...rest);
  };
  const blocked = new WorkbenchStore(directory);
  fs.readFileSync = readFileSync;
  assert.equal(blocked.blocked?.reason, "journal-unreadable");
  assert.match(blocked.blocked.message, /已停止启动/);
  assert.deepEqual(fs.readFileSync(journal), recorded, "the journal is left as it was");

  const reopened = new WorkbenchStore(directory); // lock released
  assert.equal(reopened.getTask("local-1").status, "submit_unconfirmed");
  const engine = engineFor(reopened, client);
  await engine.tick();
  await engine.tick();
  assert.equal(client.submits, 1);
});

test("replay keeps the latest attempt: refused then accepted", async (t) => {
  const { directory, store } = setup(t);
  const client = tiktok([refused(), { data: { task_id: "7390000000000000222" } }]);
  const unlock = lockStateFile(t);
  const engine = engineFor(store, client);
  await engine.tick();
  await engine.retryFailedTask("local-1");
  await engine.tick();
  unlock();

  const reopened = new WorkbenchStore(directory);
  const task = reopened.getTask("local-1");
  assert.equal(task.status, "generating");
  assert.equal(task.taskId, "7390000000000000222");
  const polling = tiktok([]);
  await engineFor(reopened, polling).tick();
  assert.equal(polling.submits, 0);
  assert.ok(polling.polled.includes("7390000000000000222"), "the accepted generation is still followed");
});

test("replay keeps the latest attempt: accepted then refused", (t) => {
  const { directory, store } = setup(t);
  const accountId = store.accounts[0].id;
  const lines = [
    { type: "intent", intentId: "first", localTaskId: "local-1", accountId },
    { type: "accepted", intentId: "first", localTaskId: "local-1", taskId: "7390000000000000111", accountId },
    { type: "intent", intentId: "second", localTaskId: "local-1", accountId },
    { type: "resolved", intentId: "second", localTaskId: "local-1", outcome: "rejected", result: { status: "failed", submitOutcome: "rejected", errorMessage: "提交失败：restricted", taskId: "" } },
  ];
  fs.writeFileSync(path.join(directory, "submitted-tasks.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const task = new WorkbenchStore(directory).getTask("local-1");
  assert.equal(task.status, "failed");
  assert.deepEqual(task.submitIntents, ["first", "second"]);
  assert.ok(task.taskIds.includes("7390000000000000111"), "the earlier generation stays in the history");
});

test("an old record for a removed account keeps its hold until the hold is saved", async (t) => {
  const { directory, store } = setup(t);
  store.recordSubmission({ localTaskId: "local-1", taskId: "7390000000000000333", accountId: "removed-account" });
  const unlock = lockStateFile(t);
  const first = new WorkbenchStore(directory); // hold applied, but cannot be saved
  assert.equal(first.getTask("local-1").status, "submit_unconfirmed");
  unlock();
  assert.ok(fs.existsSync(path.join(directory, "submitted-tasks.jsonl")), "the record stays recoverable");

  const second = new WorkbenchStore(directory);
  assert.equal(second.getTask("local-1").status, "submit_unconfirmed");
  const client = tiktok([{ data: { task_id: "7390000000000000999" } }]);
  const engine = engineFor(second, client);
  await engine.tick();
  await engine.tick();
  assert.equal(client.submits, 0);
  assert.match(fs.readFileSync(path.join(directory, "submitted-tasks-unmatched.jsonl"), "utf8"), /7390000000000000333/);
  assert.equal(fs.existsSync(path.join(directory, "submitted-tasks.jsonl")), false, "moved once the hold was saved");
  assert.equal(new WorkbenchStore(directory).getTask("local-1").status, "submit_unconfirmed");
});
