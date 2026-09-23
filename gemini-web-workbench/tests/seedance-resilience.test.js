const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  QueueEngine,
  isTransientNetworkError,
} = require(path.resolve(
  __dirname,
  "..",
  "..",
  "vendor",
  "seedance-engine",
  "queue-engine.js",
));
const { FlowCutBridge } = require(path.resolve(
  __dirname,
  "..",
  "..",
  "vendor",
  "seedance-engine",
  "flowcut-bridge.js",
));

function createStore(tasks = []) {
  return {
    tasks,
    settings: {
      running: true,
      maxRetries: 3,
      retryDelaySeconds: 30,
      pollSeconds: 20,
      maxUploadRetries: 10,
      uploadRetryDelaySeconds: 60,
      uploadConcurrent: 3,
      maxConcurrent: 5,
      flowcutBridgeEnabled: true,
      flowcutBridgeUrl: "http://127.0.0.1:4173",
      apiKey: "test-key",
      downloadDirectory: "",
    },
    logs: [],
    getTask(id) {
      return this.tasks.find((task) => task.id === id);
    },
    upsertTask(task) {
      const index = this.tasks.findIndex((item) => item.id === task.id);
      if (index >= 0) this.tasks[index] = task;
      else this.tasks.push(task);
      return task;
    },
    updateSettings(patch) {
      this.settings = { ...this.settings, ...patch };
    },
    log(message, level = "info") {
      this.logs.push({ message, level });
    },
    snapshot(extra = {}) {
      return { tasks: this.tasks, settings: this.settings, ...extra };
    },
  };
}

test("transport errors are recognized as transient Seedance failures", () => {
  assert.equal(isTransientNetworkError(new Error("net::ERR_HTTP2_PROTOCOL_ERROR")), true);
  assert.equal(isTransientNetworkError(new Error("net::ERR_CONNECTION_CLOSED")), true);
  assert.equal(isTransientNetworkError(new Error("积分不足")), false);
});

test("previous transient upload failures are restored to the queue", () => {
  const task = {
    id: "recover-upload",
    status: "failed",
    completedAt: Date.now(),
    errorMessage: "上传失败：net::ERR_CONNECTION_CLOSED",
    imageItems: [{ uploadedUrl: "", localPath: "product.png" }],
    logs: [],
  };
  const store = createStore([task]);
  const engine = new QueueEngine(store, { authenticated: false, state: () => ({}) });

  assert.equal(engine.recoverInterruptedTasks(), 1);
  assert.equal(task.status, "upload_wait");
  assert.equal(task.completedAt, 0);
  assert.ok(task.nextUploadRetryAt > Date.now());
});

test("repeated HTTP2 upload outages never turn a task into a terminal failure", async () => {
  const task = {
    id: "network-upload",
    status: "upload_wait",
    accountId: "account-1",
    accountName: "广告户",
    imageItems: [{ uploadedUrl: "", localPath: "product.png", name: "product.png" }],
    uploadRetries: 10,
    logs: [],
  };
  const store = createStore([task]);
  const accounts = {
    authenticated: true,
    state: () => ({}),
    availableAccount: async () => ({ id: "account-1", name: "广告户" }),
    client: () => ({
      uploadImage: async () => {
        throw new Error("net::ERR_HTTP2_PROTOCOL_ERROR");
      },
    }),
    markAuthInvalid() {},
  };
  const engine = new QueueEngine(store, accounts);

  await engine.uploadTask(task);

  assert.equal(task.status, "upload_wait");
  assert.equal(task.uploadRetries, 10);
  assert.equal(task.transientUploadFailures, 1);
  assert.match(task.errorMessage, /网络连接波动/);
});

test("a returned video URL completes a long-running task even if status fields changed", async () => {
  const task = {
    id: "long-queue",
    status: "generating",
    taskId: "remote-1",
    accountId: "account-1",
    accountName: "广告户",
    imageItems: [],
    logs: [],
  };
  const store = createStore([task]);
  const accounts = {
    authenticated: true,
    state: () => ({}),
    accountName: () => "广告户",
    client: () => ({
      fetchHistory: async () => ({
        data: {
          draft_infos: [
            {
              taskId: "remote-1",
              draftTaskStatus: 1,
              renderTaskStatus: 1,
              hasContent: false,
              videoInfo: {
                OriginalVideoInfo: { MainHTTPUrl: "https://video.test/output.mp4" },
              },
            },
          ],
        },
      }),
    }),
    markAuthInvalid() {},
    isQuotaError: () => false,
  };
  const engine = new QueueEngine(store, accounts);

  await engine.syncRemoteStatuses();

  assert.equal(task.status, "success");
  assert.equal(task.videoUrl, "https://video.test/output.mp4");
});

test("automatic download is scheduled even when the local Bridge endpoint is unavailable", async () => {
  const task = {
    id: "download-ready",
    flowcutTaskId: "flowcut-1",
    status: "success",
    tiktokAccountName: "店铺1",
    videoUrl: "https://video.test/output.mp4",
  };
  const store = createStore([task]);
  let downloads = 0;
  const bridge = new FlowCutBridge({
    engine: { authenticated: true },
    store,
    uploadsDirectory: "C:\\temp",
    version: "test",
    desktopToken: "token",
    downloadTask: async () => {
      downloads += 1;
      task.lastDownloadedPath = "C:\\videos\\店铺1\\output.mp4";
    },
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: "temporary unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
  });

  await bridge.tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(downloads, 1);
  assert.equal(task.autoDownloadError, "");
});

