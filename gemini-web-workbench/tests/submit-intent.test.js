const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../../vendor/seedance-engine/store");
const { QueueEngine } = require("../../vendor/seedance-engine/queue-engine");

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flowcut-intent-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Switchable disk faults: "full" fails every new write, "stateLocked" only
// blocks the task list file (antivirus), leaving the journal writable.
function diskFaults(t) {
  const faults = { full: false, stateLocked: false };
  const { openSync, renameSync } = fs;
  fs.openSync = (file, ...rest) => {
    if (faults.full) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    return openSync(file, ...rest);
  };
  fs.renameSync = (from, to) => {
    const touchesState = [from, to].some((file) => String(file).endsWith("workbench-state.json"));
    if (faults.stateLocked && touchesState) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    return renameSync(from, to);
  };
  t.after(() => {
    fs.openSync = openSync;
    fs.renameSync = renameSync;
  });
  return faults;
}

function tiktok({ submit } = {}) {
  const client = {
    submits: 0,
    historyQueries: 0,
    async submitTask() {
      client.submits += 1;
      if (submit) return submit(client.submits);
      return { data: { task_id: `739000000000000000${client.submits}` } };
    },
    async fetchHistory() {
      client.historyQueries += 1;
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

function addQueued(store, id = "local-1", order = 1) {
  const account = store.accounts[0];
  store.upsertTask({
    id,
    order,
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
}

test("with the disk full nothing is sent, and after a restart the task is generated only once", async (t) => {
  const directory = tempDirectory(t);
  const faults = diskFaults(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  addQueued(store);
  const client = tiktok();
  faults.full = true;
  await engineFor(store, client).tick();
  assert.equal(client.submits, 0, "not sent while the attempt cannot be recorded");
  assert.equal(store.getTask("local-1").status, "queued");
  assert.match(store.getTask("local-1").activity, /已暂停提交新任务/);

  faults.full = false; // the app is restarted after space was freed
  const reopened = new WorkbenchStore(directory);
  assert.equal(reopened.getTask("local-1").status, "queued");
  const engine = engineFor(reopened, client);
  await engine.tick();
  await engine.tick();
  assert.equal(client.submits, 1);
});

test("submissions resume by themselves once the disk can be written again", async (t) => {
  const directory = tempDirectory(t);
  const faults = diskFaults(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  addQueued(store);
  const client = tiktok();
  const engine = engineFor(store, client);
  faults.full = true;
  await engine.tick();
  faults.full = false;
  await engine.tick();
  assert.equal(client.submits, 1);
  assert.equal(store.getTask("local-1").status, "generating");
});

test("while new submissions are paused, running generations are still followed", async (t) => {
  const directory = tempDirectory(t);
  const faults = diskFaults(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  addQueued(store, "waiting", 2);
  store.upsertTask({ id: "running", order: 1, status: "generating", taskId: "7390000000000000999", taskIds: ["7390000000000000999"], accountId: store.accounts[0].id, imageItems: [], logs: [] });
  const client = tiktok();
  faults.full = true;
  await engineFor(store, client).tick();
  assert.equal(client.submits, 0);
  assert.ok(client.historyQueries > 0, "the running task is still polled");
});

test("an attempt only the journal recorded is held for checking after a restart", async (t) => {
  const directory = tempDirectory(t);
  const faults = diskFaults(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  addQueued(store);
  const client = tiktok({
    submit: () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    },
  });
  faults.stateLocked = true; // the task list cannot record "submitting"
  await engineFor(store, client).tick();
  assert.equal(client.submits, 1);
  faults.stateLocked = false;

  const reopened = new WorkbenchStore(directory);
  assert.equal(reopened.getTask("local-1").status, "submit_unconfirmed");
  const engine = engineFor(reopened, client);
  await engine.tick();
  await engine.tick();
  assert.equal(client.submits, 1, "not resent after the restart");
});

test("a definite refusal recorded in the journal is not mistaken for an unconfirmed attempt", async (t) => {
  const directory = tempDirectory(t);
  const faults = diskFaults(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  addQueued(store);
  const client = tiktok({
    submit: () => {
      throw Object.assign(new Error("prompt contains restricted content"), { code: 40010, outcome: "rejected" });
    },
  });
  faults.stateLocked = true;
  await engineFor(store, client).tick();
  faults.stateLocked = false;
  const reopened = new WorkbenchStore(directory);
  const task = reopened.getTask("local-1");
  assert.equal(task.status, "failed", "the refusal itself is restored, not the older queued state");
  assert.match(task.errorMessage, /restricted content/);
  const engine = engineFor(reopened, client);
  await engine.tick();
  await engine.tick();
  assert.equal(client.submits, 1, "not retried without the person asking");
  assert.equal(fs.existsSync(path.join(directory, "submitted-tasks.jsonl")), false, "pruned once the outcome is saved");
  assert.equal(new WorkbenchStore(directory).getTask("local-1").status, "failed");
});

test("a refusal is restored even when only the outcome save failed", async (t) => {
  const directory = tempDirectory(t);
  const faults = diskFaults(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  addQueued(store);
  const client = tiktok({
    submit: () => {
      faults.stateLocked = true; // "submitting" was saved; the answer cannot be
      throw Object.assign(new Error("prompt contains restricted content"), { code: 40010, outcome: "rejected" });
    },
  });
  await engineFor(store, client).tick();
  faults.stateLocked = false;
  const reopened = new WorkbenchStore(directory);
  assert.equal(reopened.getTask("local-1").status, "failed");
  await engineFor(reopened, client).tick();
  assert.equal(client.submits, 1);
});

test("a rate-limit answer is restored with its wait time", async (t) => {
  const directory = tempDirectory(t);
  const faults = diskFaults(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  addQueued(store);
  const client = tiktok({
    submit: () => {
      throw Object.assign(new Error("TikTok HTTP 429: too many requests"), { status: 429, outcome: "rejected" });
    },
  });
  faults.stateLocked = true;
  await engineFor(store, client).tick();
  const waitUntil = store.getTask("local-1").nextRetryAt;
  faults.stateLocked = false;
  const restored = new WorkbenchStore(directory).getTask("local-1");
  assert.equal(restored.status, "retry_wait");
  assert.equal(restored.nextRetryAt, waitUntil);
});

test("a torn last line left by a crash does not swallow the next attempt record", async (t) => {
  const directory = tempDirectory(t);
  const faults = diskFaults(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  addQueued(store);
  fs.writeFileSync(path.join(directory, "submitted-tasks.jsonl"), '{"type":"accepted","localTaskId":"x","taskI');
  const client = tiktok({
    submit: () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    },
  });
  faults.stateLocked = true; // only the journal can record the attempt
  await engineFor(store, client).tick();
  assert.equal(client.submits, 1);
  faults.stateLocked = false;

  const reopened = new WorkbenchStore(directory);
  assert.equal(reopened.getTask("local-1").status, "submit_unconfirmed");
  const engine = engineFor(reopened, client);
  await engine.tick();
  await engine.tick();
  assert.equal(client.submits, 1, "not sent a second time");
});

test("a record that does not read back is not trusted, so nothing is sent", async (t) => {
  const directory = tempDirectory(t);
  const faults = diskFaults(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  addQueued(store);
  const { writeSync } = fs;
  // A write that reports success but never reaches the file.
  fs.writeSync = (descriptor, buffer, offset = 0, length = buffer.length - offset) => length;
  t.after(() => {
    fs.writeSync = writeSync;
  });
  const client = tiktok();
  faults.stateLocked = true;
  await engineFor(store, client).tick();
  assert.equal(client.submits, 0);
  assert.equal(store.getTask("local-1").status, "queued");
});
