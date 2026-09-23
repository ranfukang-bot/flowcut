const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { WorkbenchStore } = require("../../vendor/seedance-engine/store");
const { QueueEngine } = require("../../vendor/seedance-engine/queue-engine");
const { FlowCutBridge } = require("../../vendor/seedance-engine/flowcut-bridge");

const PROMPT = "原提示词".repeat(80);
const ORIGINAL_TASK_ID = "7390000000000000123";

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flowcut-retry-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// FlowCut's /api/seedance-bridge for one task, following the real route's rules.
function fakeSite() {
  const site = {
    status: "failed",
    providerJobId: "local-1",
    error: "",
    imageDownloads: 0,
    queueAgain() {
      // PATCH /api/tasks action "queue" (after "恢复任务").
      site.status = "video_queued";
      site.providerJobId = null;
    },
    async fetch(url, init = {}) {
      const body = init.body ? JSON.parse(init.body) : null;
      if (String(url).includes("/api/media")) {
        site.imageDownloads += 1;
        return new Response(Buffer.from("current-library-image"), { headers: { "content-type": "image/jpeg" } });
      }
      if (!init.method) {
        const jobs = site.status === "video_queued" && !site.providerJobId
          ? [{
              id: "flowcut-1",
              kind: "standard",
              prompt: PROMPT,
              imageUrls: ["http://127.0.0.1:4173/api/media?key=current"],
              tiktokAccountName: "shop",
              productExternalId: "1729000000000000001",
              duration: 15,
            }]
          : [];
        return Response.json({ jobs });
      }
      if (body.action === "submitted") {
        site.status = "video_queued";
        site.providerJobId = body.providerJobId;
      }
      if (body.action === "status") {
        const mapped = { success: "video_ready", failed: "failed" }[body.providerStatus];
        site.status = mapped || (["upload_wait", "uploading", "queued", "submitting", "model_wait"].includes(body.providerStatus) ? "video_queued" : "video_generating");
        site.error = body.error || "";
      }
      return Response.json({ ok: true });
    },
  };
  return site;
}

function remoteRecord(state) {
  if (state === "success") {
    return { taskId: ORIGINAL_TASK_ID, draftTaskStatus: 0, renderTaskStatus: 0, hasContent: true, videoInfo: { OriginalVideoInfo: { MainUrl: "https://video/done.mp4" } } };
  }
  if (state === "failed") return { taskId: ORIGINAL_TASK_ID, draftTaskStatus: 3, generateErrorCode: "500123" };
  return { taskId: ORIGINAL_TASK_ID, draftTaskStatus: 1, renderTaskStatus: 1 };
}

function fakeTikTok({ original = "failed", historyError = null } = {}) {
  const client = {
    submitted: [],
    uploads: [],
    async submitTask(task) {
      client.submitted.push({ prompt: task.prompt, images: task.imageItems.map((item) => item.uploadedUrl), duration: task.duration });
      return { data: { task_id: `74000000000000000${client.submitted.length}` } };
    },
    async uploadImage(localPath) {
      client.uploads.push(localPath);
      return `https://img/reuploaded/${path.basename(localPath)}`;
    },
    async fetchHistory(ids) {
      if (historyError) throw historyError;
      return { data: { draft_infos: ids.includes(ORIGINAL_TASK_ID) ? [remoteRecord(original)] : [] } };
    },
    async getGeneratingCount() {
      return 0;
    },
  };
  return client;
}

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
    markAuthenticated: () => {},
    markAuthInvalid: () => {},
    accountName: () => account.name,
    refreshAuth: async () => true,
    state: () => ({ items: [] }),
  };
}

// A FlowCut task whose Seedance generation already ran and failed.
function setup(t, { original = "failed", historyError = null, local = {} } = {}) {
  const directory = tempDirectory(t);
  const imageDirectory = path.join(directory, "api-uploads", "flowcut", "flowcut-1");
  fs.mkdirSync(imageDirectory, { recursive: true });
  const images = ["1.jpg", "2.jpg"].map((name) => {
    const file = path.join(imageDirectory, name);
    fs.writeFileSync(file, `original-${name}`);
    return file;
  });
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true, flowcutBridgeUrl: "http://127.0.0.1:4173", apiKey: "k", flowcutWorkerId: "w" });
  const account = store.accounts[0];
  store.upsertTask({
    id: "local-1",
    order: 1,
    prompt: PROMPT,
    duration: 15,
    imageItems: images.map((file, index) => ({ name: path.basename(file), localPath: file, uploadedUrl: `https://img/original/${index + 1}`, uploadedAccountId: account.id })),
    imageName: "1.jpg、2.jpg",
    status: "failed",
    accountId: account.id,
    accountName: account.name,
    taskId: ORIGINAL_TASK_ID,
    taskIds: [ORIGINAL_TASK_ID],
    attempts: 4,
    errorCode: "500123",
    errorMessage: "生成失败",
    logs: [],
    source: "flowcut",
    flowcutTaskId: "flowcut-1",
    flowcutTaskKind: "standard",
    tiktokAccountName: "shop",
    productExternalId: "1729000000000000001",
    managedLocalFiles: images,
    ...local,
  });
  const client = fakeTikTok({ original, historyError });
  const engine = new QueueEngine(store, fakeAccounts(store, client));
  const site = fakeSite();
  const bridge = new FlowCutBridge({
    engine,
    store,
    uploadsDirectory: path.join(directory, "api-uploads"),
    version: "test",
    fetchImpl: site.fetch,
  });
  return { directory, store, engine, bridge, site, client, images };
}

async function settle(bridge, engine, rounds = 3) {
  for (let index = 0; index < rounds; index += 1) {
    await bridge.tick();
    await engine.tick();
    await new Promise(setImmediate);
  }
  await bridge.tick();
}

test("retrying a confirmed Seedance failure starts one new generation with the original prompt and images", async (t) => {
  const { bridge, engine, site, client } = setup(t, { original: "failed" });
  await bridge.syncStatuses();
  site.queueAgain();
  await settle(bridge, engine);

  assert.equal(client.submitted.length, 1);
  assert.equal(client.submitted[0].prompt, PROMPT);
  assert.deepEqual(client.submitted[0].images, ["https://img/original/1", "https://img/original/2"]);
  assert.equal(site.imageDownloads, 0, "the product library's current images are not used");
  assert.equal(site.status, "video_generating", "FlowCut shows the real state, not a stuck queue");
});

test("clicking retry again while the retried task is running does not start another generation", async (t) => {
  const { bridge, engine, site, client } = setup(t, { original: "failed" });
  site.queueAgain();
  await settle(bridge, engine);
  site.queueAgain();
  await settle(bridge, engine);
  site.queueAgain();
  await settle(bridge, engine);
  assert.equal(client.submitted.length, 1);
  assert.equal(site.status, "video_generating");
});

test("a failed task whose original generation is still running is followed, not resubmitted", async (t) => {
  const { bridge, engine, site, client, store } = setup(t, { original: "generating" });
  site.queueAgain();
  await settle(bridge, engine);
  assert.equal(client.submitted.length, 0);
  assert.equal(store.getTask("local-1").status, "generating");
  assert.equal(site.status, "video_generating");
});

test("a failed task whose original generation actually succeeded is completed, not resubmitted", async (t) => {
  const { bridge, engine, site, client, store } = setup(t, { original: "success" });
  site.queueAgain();
  await settle(bridge, engine);
  assert.equal(client.submitted.length, 0);
  assert.equal(store.getTask("local-1").status, "success");
  assert.equal(store.getTask("local-1").videoUrl, "https://video/done.mp4");
  assert.equal(site.status, "video_ready");
});

test("when the original task cannot be checked, nothing is resubmitted and FlowCut says why", async (t) => {
  const { bridge, engine, site, client } = setup(t, { historyError: new Error("fetch failed") });
  site.queueAgain();
  await settle(bridge, engine);
  assert.equal(client.submitted.length, 0);
  assert.equal(site.status, "failed");
  assert.match(site.error, /没有重新提交/);
});

test("a submit that never got an answer is not resent by a retry", async (t) => {
  const { bridge, engine, site, client, store } = setup(t, {
    local: { taskId: "", taskIds: [], errorCode: "", errorMessage: "提交失败：fetch failed" },
  });
  site.queueAgain();
  await settle(bridge, engine);
  assert.equal(client.submitted.length, 0);
  assert.equal(store.getTask("local-1").status, "submit_unconfirmed");
  assert.equal(site.status, "failed");
  assert.match(site.error, /提交结果不确定/);
});

test("a retry that needs the original images fails clearly when they are gone", async (t) => {
  const { bridge, engine, site, client, images } = setup(t, {
    local: { taskId: "", taskIds: [], errorMessage: "上传失败：图片数据上传超时" },
  });
  const task = bridge.store.getTask("local-1");
  task.imageItems.forEach((item) => {
    item.uploadedUrl = "";
  });
  bridge.store.upsertTask(task);
  fs.rmSync(images[1]);
  site.queueAgain();
  await settle(bridge, engine);
  assert.equal(client.submitted.length, 0);
  assert.equal(client.uploads.length, 0);
  assert.equal(site.imageDownloads, 0, "does not silently switch to the product library");
  assert.match(site.error, /原任务的图片文件已不存在/);
});

test("an upload failure is retried from the task's own image files", async (t) => {
  const { bridge, engine, site, client, images } = setup(t, {
    local: { taskId: "", taskIds: [], errorMessage: "上传失败：图片数据上传超时" },
  });
  const task = bridge.store.getTask("local-1");
  task.imageItems.forEach((item) => {
    item.uploadedUrl = "";
  });
  bridge.store.upsertTask(task);
  site.queueAgain();
  await settle(bridge, engine);
  assert.deepEqual(client.uploads, images);
  assert.equal(client.submitted.length, 1);
  assert.equal(site.imageDownloads, 0);
});

test("after a retry and a restart, FlowCut gets the real status and no extra generation starts", async (t) => {
  const { directory, bridge, engine, site, client } = setup(t, { original: "failed" });
  site.queueAgain();
  await settle(bridge, engine);
  assert.equal(client.submitted.length, 1);

  site.status = "video_queued"; // FlowCut shows something stale before the restart
  const reopened = new WorkbenchStore(directory);
  const restartedEngine = new QueueEngine(reopened, fakeAccounts(reopened, client));
  const restartedBridge = new FlowCutBridge({
    engine: restartedEngine,
    store: reopened,
    uploadsDirectory: path.join(directory, "api-uploads"),
    version: "test",
    fetchImpl: site.fetch,
  });
  await settle(restartedBridge, restartedEngine);
  assert.equal(client.submitted.length, 1);
  assert.equal(site.status, "video_generating");
});

test("queuing again while the local task is still generating keeps that generation only", async (t) => {
  const { bridge, engine, site, client, store } = setup(t, {
    original: "generating",
    local: { status: "generating", errorCode: "", errorMessage: "" },
  });
  await bridge.syncStatuses();
  site.queueAgain(); // e.g. a stale "failed" on the FlowCut page, then 恢复任务 → 提交 Seedance
  await settle(bridge, engine);
  assert.equal(client.submitted.length, 0);
  assert.equal(store.getTask("local-1").taskId, ORIGINAL_TASK_ID);
  assert.equal(site.status, "video_generating");
});
