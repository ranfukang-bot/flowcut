const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../../vendor/seedance-engine/store");
const { QueueEngine } = require("../../vendor/seedance-engine/queue-engine");

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flowcut-journal-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function lockStateFile(t) {
  const original = fs.renameSync;
  let locked = true;
  fs.renameSync = (from, to) => {
    const touchesState = [from, to].some((file) => String(file).endsWith("workbench-state.json"));
    if (locked && touchesState) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    return original(from, to);
  };
  const unlock = () => {
    locked = false;
    fs.renameSync = original;
  };
  t.after(unlock);
  return unlock;
}

function accounts(store, client) {
  const account = store.accounts[0];
  return {
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
}

function countingClient() {
  const client = {
    submits: 0,
    async submitTask() {
      client.submits += 1;
      return { data: { task_id: "7390000000000000555" } };
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

function newTask(store) {
  const account = store.accounts[0];
  return {
    id: "local-new",
    order: 7,
    prompt: "P".repeat(320),
    duration: 12,
    imageItems: [{ name: "1.jpg", localPath: "C:\\\\uploads\\\\1.jpg", uploadedUrl: "https://img/1", uploadedAccountId: account.id }],
    imageName: "1.jpg",
    status: "queued",
    attempts: 0,
    accountId: account.id,
    taskId: "",
    taskIds: [],
    logs: [],
    flowcutTaskId: "flowcut-7",
    tiktokAccountName: "shop",
    productExternalId: "1729000000000000001",
  };
}

test("a task that never reached the task list is rebuilt from its submission record", async (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  store.upsertTask({ id: "other", status: "success", logs: [] });
  const unlock = lockStateFile(t); // from here on nothing reaches the task list
  const task = newTask(store);
  store.upsertTask(task);
  const client = countingClient();
  await new QueueEngine(store, accounts(store, client)).submitTask(task, store.accounts[0]);
  unlock(); // restart

  const reopened = new WorkbenchStore(directory);
  const restored = reopened.getTask("local-new");
  assert.ok(restored, "the task is back");
  assert.equal(restored.status, "generating");
  assert.equal(restored.taskId, "7390000000000000555");
  assert.equal(restored.prompt, task.prompt);
  assert.equal(restored.flowcutTaskId, "flowcut-7");
  assert.equal(restored.productExternalId, "1729000000000000001");
  assert.equal(restored.attempts, 1);
  assert.equal(fs.existsSync(path.join(directory, "submitted-tasks.jsonl")), false, "pruned once saved");

  await new QueueEngine(reopened, accounts(reopened, client)).tick();
  assert.equal(client.submits, 1, "no second generation");
});

test("a record whose account is gone holds its task, is kept in a separate file and reported", async (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  store.upsertTask({ ...newTask(store), status: "queued" }); // the saved list never saw the submission
  assert.ok(store.recordSubmission({ type: "accepted", localTaskId: "local-new", taskId: "7390000000000000666", accountId: "removed-account" }));

  const reopened = new WorkbenchStore(directory);
  assert.deepEqual(reopened.journalRecovery.unmatched.map((item) => item.taskId), ["7390000000000000666"]);
  const kept = fs.readFileSync(path.join(directory, "submitted-tasks-unmatched.jsonl"), "utf8");
  assert.match(kept, /7390000000000000666/);
  const held = reopened.getTask("local-new");
  assert.equal(held.status, "submit_unconfirmed");
  assert.match(held.errorMessage, /7390000000000000666/);
  const client = countingClient();
  const engine = new QueueEngine(reopened, accounts(reopened, client));
  await engine.tick();
  await engine.tick();
  assert.equal(client.submits, 0, "the accepted task is never sent again");
  assert.equal(fs.existsSync(path.join(directory, "submitted-tasks.jsonl")), false);
  // The hold is saved, and the record is reported only once.
  const again = new WorkbenchStore(directory);
  assert.equal(again.getTask("local-new").status, "submit_unconfirmed");
  assert.equal(again.journalRecovery.unmatched.length, 0);
  assert.match(fs.readFileSync(path.join(directory, "submitted-tasks-unmatched.jsonl"), "utf8"), /7390000000000000666/);
});

test("a lost task whose account is gone is rebuilt on hold from its snapshot", (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  store.recordSubmission({
    type: "accepted",
    localTaskId: "local-new",
    taskId: "7390000000000000667",
    accountId: "removed-account",
    snapshot: { ...newTask(store), accountId: "removed-account" },
  });
  const held = new WorkbenchStore(directory).getTask("local-new");
  assert.equal(held.status, "submit_unconfirmed");
  assert.equal(held.flowcutTaskId, "flowcut-7");
});

test("a record without a matching task or snapshot is kept, not deleted", (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  store.recordSubmission({ localTaskId: "vanished", taskId: "7390000000000000777", accountId: store.accounts[0].id });
  const reopened = new WorkbenchStore(directory);
  assert.equal(reopened.journalRecovery.unmatched[0].taskId, "7390000000000000777");
  assert.match(fs.readFileSync(path.join(directory, "submitted-tasks-unmatched.jsonl"), "utf8"), /7390000000000000777/);
});

test("a successful save removes only the records the task list now holds", (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  const unlock = lockStateFile(t);
  store.upsertTask({ id: "saved-later", status: "generating", taskId: "7390000000000000001", taskIds: ["7390000000000000001"], logs: [] });
  store.recordSubmission({ localTaskId: "saved-later", taskId: "7390000000000000001", accountId: store.accounts[0].id });
  store.recordSubmission({ localTaskId: "not-in-list", taskId: "7390000000000000002", accountId: store.accounts[0].id });
  unlock();
  assert.equal(store.save(), true);
  const journal = fs.readFileSync(path.join(directory, "submitted-tasks.jsonl"), "utf8");
  assert.doesNotMatch(journal, /7390000000000000001/);
  assert.match(journal, /7390000000000000002/);
});

test("records for tasks the person cleared are dropped with them", (t) => {
  const directory = tempDirectory(t);
  const store = new WorkbenchStore(directory);
  store.recordSubmission({ localTaskId: "gone", taskId: "7390000000000000888", accountId: store.accounts[0].id, flowcutTaskId: "flowcut-cleared" });
  store.clearFlowcutTasks(["flowcut-cleared"]);
  const reopened = new WorkbenchStore(directory);
  assert.equal(reopened.journalRecovery.unmatched.length, 0);
  assert.equal(fs.existsSync(path.join(directory, "submitted-tasks.jsonl")), false);
});
