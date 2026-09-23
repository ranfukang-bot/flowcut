const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { AccountManager } = require(path.resolve(
  __dirname,
  "..",
  "..",
  "vendor",
  "seedance-engine",
  "account-manager.js",
));

function createStore(tasks) {
  return {
    accounts: [
      { id: "remove-me", name: "广告户 A", enabled: true },
      { id: "keep-me", name: "广告户 B", enabled: true },
    ],
    tasks,
    settings: { activeAccountId: "remove-me" },
    getAccount(id) {
      return this.accounts.find((account) => account.id === id);
    },
    upsertTask() {},
    removeAccount(id) {
      this.accounts = this.accounts.filter((account) => account.id !== id);
      if (this.settings.activeAccountId === id) {
        this.settings.activeAccountId = this.accounts[0]?.id || "default";
      }
    },
    updateSettings(patch) {
      this.settings = { ...this.settings, ...patch };
    },
  };
}

test("Seedance account deletion detaches completed and failed history", () => {
  const completed = {
    id: "done",
    status: "success",
    accountId: "remove-me",
    accountName: "广告户 A",
    taskId: "remote-complete",
    imageItems: [],
  };
  const failed = {
    id: "failed",
    status: "failed",
    accountId: "remove-me",
    accountName: "广告户 A",
    taskId: "remote-failed",
    taskIds: ["remote-failed"],
    imageItems: [{ uploadedUrl: "https://example.test/image", uploadedAccountId: "remove-me" }],
  };
  const store = createStore([completed, failed]);
  const manager = new AccountManager({ store, sessionFactory: () => ({}) });

  manager.removeAccount("remove-me");

  assert.deepEqual(store.accounts.map((account) => account.id), ["keep-me"]);
  assert.equal(completed.accountId, "");
  assert.equal(completed.taskId, "remote-complete");
  assert.equal(failed.accountId, "");
  assert.equal(failed.taskId, "");
  assert.deepEqual(failed.taskIds, []);
  assert.equal(failed.imageItems[0].uploadedUrl, "");
  assert.equal(store.settings.activeAccountId, "keep-me");
});

test("Seedance account deletion refuses only genuinely running tasks", () => {
  const store = createStore([
    { id: "running", status: "generating", accountId: "remove-me" },
  ]);
  const manager = new AccountManager({ store, sessionFactory: () => ({}) });

  assert.throws(
    () => manager.removeAccount("remove-me"),
    /正在上传或生成的视频/,
  );
  assert.equal(store.accounts.length, 2);
});
