const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../../vendor/seedance-engine/store");
const { QueueEngine } = require("../../vendor/seedance-engine/queue-engine");
const { FlowCutBridge } = require("../../vendor/seedance-engine/flowcut-bridge");

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flowcut-submit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function patchFs(t, name, replacement) {
  const original = fs[name];
  fs[name] = (...args) => replacement(original, ...args);
  const restore = () => {
    fs[name] = original;
  };
  t.after(restore);
  return restore;
}

function lockError(code = "EPERM") {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

// A logged-in TikTok account whose client counts generation submissions.
function fakeAccounts(store, client) {
  const account = store.accounts[0];
  return {
    authenticated: true,
    authCheckedAt: Date.now(),
    client: () => client,
    availableAccount: async () => account,
    ensureRuntime: () => ({ maxConcurrent: 5 }),
    effectiveModel: () => "2000012",
    isQuotaError: () => false,
    markAuthenticated: () => store.upsertAccount(account),
    markAuthInvalid: () => {},
    accountName: () => account.name,
    refreshAuth: async () => true,
    state: () => ({ items: [] }),
  };
}

function fakeClient({ submit } = {}) {
  const client = {
    submits: 0,
    async submitTask() {
      client.submits += 1;
      if (submit) return submit();
      return { data: { task_id: "7390000000000000123" } };
    },
    async getGeneratingCount() {
      return 0;
    },
    async fetchHistory() {
      return { data: { draft_infos: [] } };
    },
  };
  return client;
}

function queuedTask(store) {
  const account = store.accounts[0];
  const task = {
    id: "local-1",
    order: 1,
    prompt: "P".repeat(320),
    imageItems: [{ name: "1.jpg", localPath: "1.jpg", uploadedUrl: "https://img/1", uploadedAccountId: account.id }],
    imageName: "1.jpg",
    status: "queued",
    attempts: 0,
    accountId: account.id,
    taskId: "",
    taskIds: [],
    logs: [],
    flowcutTaskId: "flowcut-1",
  };
  store.upsertTask(task);
  return task;
}

test("an accepted generation stays tracked when saving right after submit fails", async (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  const task = queuedTask(store);
  let lockStateFile = false;
  patchFs(t, "renameSync", (original, from, to) => {
    // A lock on the state file blocks renaming it away as well as over it.
    const touchesState = [from, to].some((file) => String(file).endsWith("workbench-state.json"));
    if (lockStateFile && touchesState) throw lockError();
    return original(from, to);
  });
  const client = fakeClient({
    submit: () => {
      lockStateFile = true; // antivirus grabs the file just as TikTok answers
      return { data: { task_id: "7390000000000000123" } };
    },
  });
  const engine = new QueueEngine(store, fakeAccounts(store, client));
  await engine.submitTask(task, store.accounts[0]);

  assert.equal(client.submits, 1);
  assert.equal(task.status, "generating");
  assert.equal(task.taskId, "7390000000000000123");
  assert.ok(store.persistError, "the save failure is known and reported");
});

test("any bookkeeping error after TikTok accepted the job keeps it tracked", async (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  const task = queuedTask(store);
  const client = fakeClient();
  const accounts = fakeAccounts(store, client);
  accounts.markAuthenticated = () => {
    throw new Error("账号不存在");
  };
  await new QueueEngine(store, accounts).submitTask(task, store.accounts[0]);
  assert.equal(task.status, "generating");
  assert.equal(task.taskId, "7390000000000000123");
  assert.equal(new WorkbenchStore(directory).getTask("local-1").taskId, "7390000000000000123");
});

test("after that failed save, a restart recovers the Task ID and does not submit again", async (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  const task = queuedTask(store);
  let lockStateFile = false;
  const restore = patchFs(t, "renameSync", (original, from, to) => {
    // A lock on the state file blocks renaming it away as well as over it.
    const touchesState = [from, to].some((file) => String(file).endsWith("workbench-state.json"));
    if (lockStateFile && touchesState) throw lockError();
    return original(from, to);
  });
  const firstClient = fakeClient({
    submit: () => {
      lockStateFile = true;
      return { data: { task_id: "7390000000000000123" } };
    },
  });
  await new QueueEngine(store, fakeAccounts(store, firstClient)).submitTask(task, store.accounts[0]);
  restore(); // the app is closed and reopened

  const reopened = new WorkbenchStore(directory);
  const recovered = reopened.getTask("local-1");
  assert.equal(recovered.status, "generating");
  assert.equal(recovered.taskId, "7390000000000000123");
  const secondClient = fakeClient();
  const engine = new QueueEngine(reopened, fakeAccounts(reopened, secondClient));
  await engine.tick();
  assert.equal(secondClient.submits, 0, "no duplicate generation after restart");
  assert.equal(fs.existsSync(path.join(directory, "submitted-tasks.jsonl")), false, "journal cleared once saved");
});

test("a task interrupted while submitting is held for confirmation instead of resubmitted", async (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  const task = queuedTask(store);
  task.status = "submitting"; // saved just before the request, then the app closed
  store.upsertTask(task);

  const reopened = new WorkbenchStore(directory);
  assert.equal(reopened.getTask("local-1").status, "submit_unconfirmed");
  const client = fakeClient();
  const engine = new QueueEngine(reopened, fakeAccounts(reopened, client));
  await engine.tick();
  await engine.tick();
  assert.equal(client.submits, 0);
  assert.throws(() => engine.retryTask("local-1"), /提交结果尚未确认/);
});

test("a submit timeout is recorded as unconfirmed rather than failed", async (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  const task = queuedTask(store);
  const client = fakeClient({
    submit: () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    },
  });
  const engine = new QueueEngine(store, fakeAccounts(store, client));
  await engine.submitTask(task, store.accounts[0]);
  assert.equal(task.status, "submit_unconfirmed");
  assert.match(task.errorMessage, /提交结果不确定/);
  await engine.tick();
  assert.equal(client.submits, 1, "not resubmitted automatically");
});

test("a definite rejection from the platform is still a failure", async (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  const task = queuedTask(store);
  const client = fakeClient({
    submit: () => {
      throw Object.assign(new Error("prompt contains restricted content"), { code: 40010 });
    },
  });
  await new QueueEngine(store, fakeAccounts(store, client)).submitTask(task, store.accounts[0]);
  assert.equal(task.status, "failed");
  assert.match(task.errorMessage, /^提交失败：/);
});

test("when neither the task list nor the journal can be written, the Task ID is surfaced", async (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  const task = queuedTask(store);
  let diskFull = false;
  const full = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  patchFs(t, "openSync", (original, file, ...rest) => {
    if (diskFull) throw full();
    return original(file, ...rest);
  });
  const client = fakeClient({
    submit: () => {
      diskFull = true;
      return { data: { task_id: "7390000000000000777" } };
    },
  });
  const engine = new QueueEngine(store, fakeAccounts(store, client));
  const alerts = [];
  engine.onUnsavedSubmission = (submission) => alerts.push(submission.taskId);
  await engine.submitTask(task, store.accounts[0]);
  assert.equal(task.status, "generating");
  assert.deepEqual(alerts, ["7390000000000000777"]);
});

test("a finished download is not reported as a download failure when bookkeeping throws", async () => {
  const task = { id: "local-1", flowcutTaskId: "flowcut-1", status: "success", tiktokAccountName: "shop", logs: [] };
  let failNextUpsert = false;
  const logs = [];
  const store = {
    settings: {},
    tasks: [task],
    isFlowcutTaskCleared: () => false,
    upsertTask() {
      if (failNextUpsert) {
        failNextUpsert = false;
        throw new Error("EPERM: operation not permitted");
      }
    },
    log: (message, level) => logs.push({ message, level }),
  };
  const bridge = new FlowCutBridge({
    engine: {},
    store,
    downloadTask: async (item) => {
      item.lastDownloadedPath = "C:\\videos\\shop\\1729000000000000001.mp4";
      failNextUpsert = true;
    },
  });
  bridge.scheduleAutoDownload(task);
  for (let index = 0; index < 5; index += 1) await new Promise(setImmediate);
  assert.equal(task.autoDownloadError, "");
  assert.equal(logs.some((entry) => /等待下载/.test(entry.message)), false);
  assert.equal(bridge.autoDownloads.size, 0);
});
