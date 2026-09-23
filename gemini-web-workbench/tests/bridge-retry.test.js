const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ACCOUNT_COOLDOWN_MS,
  ACCOUNT_FAILURE_BACKOFF_MS,
  BridgeEngine,
  isTransientBridgeError,
  isRetryableJobError,
  shouldRetryInline,
} = require("../src/bridge-engine");

function fixture(runJob) {
  const reports = [];
  const logs = [];
  const store = {
      state: {
        settings: { bridgeKey: "test", flowcutUrl: "http://127.0.0.1" },
        pendingResults: [],
      },
      log(message, level) {
        logs.push({ message, level });
      },
      updateAccount() {},
      upsertPendingResult(taskId, prompt, workerId, detail = {}) {
        this.state.pendingResults = this.state.pendingResults.filter(
          (item) => item.taskId !== taskId
        );
        this.state.pendingResults.push({ taskId, prompt, workerId, ...detail });
      },
      removePendingResult(taskId) {
        this.state.pendingResults = this.state.pendingResults.filter(
          (item) => item.taskId !== taskId
        );
      },
    };
  const engine = new BridgeEngine({
    store,
    getAuthenticatedAccounts: () => [],
    runJob,
    onChange() {},
  });
  engine.downloadFiles = async () => [{ name: "product-1.jpg" }];
  engine.report = async (taskId, action, extra = {}) => {
    reports.push({ taskId, action, ...extra });
    return action === "defer"
      ? { ok: true, deferred: true, failures: 1 }
      : { ok: true };
  };
  return { engine, reports, logs, store };
}

test("retryable Gemini page failures are retried once before reporting success", async () => {
  let attempts = 0;
  const { engine, reports } = fixture(async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("upload not confirmed");
      error.code = "UPLOAD_NOT_CONFIRMED";
      throw error;
    }
    return "x".repeat(350);
  });
  engine.active.set("account-1", {
    taskId: "task-1",
    accountId: "account-1",
    accountName: "Gemini 1",
  });

  await engine.execute(
    { id: "account-1", name: "Gemini 1" },
    { id: "task-1", imageUrls: [] }
  );

  assert.equal(attempts, 2);
  assert.deepEqual(
    reports.map((item) => item.action),
    ["retrying", "result"]
  );
  assert.ok(engine.cooldownUntil.get("account-1") >= Date.now());
  assert.equal(ACCOUNT_COOLDOWN_MS, 12_000);
});

test("login failures never trigger automatic retries", async () => {
  let attempts = 0;
  const { engine, reports } = fixture(async () => {
    attempts += 1;
    const error = new Error("login required");
    error.code = "NEEDS_LOGIN";
    throw error;
  });
  engine.active.set("account-1", {
    taskId: "task-2",
    accountId: "account-1",
    accountName: "Gemini 1",
  });

  await engine.execute(
    { id: "account-1", name: "Gemini 1" },
    { id: "task-2", imageUrls: [] }
  );

  assert.equal(attempts, 1);
  assert.deepEqual(reports.map((item) => item.action), ["release"]);
});

test("retry classification excludes login failures", () => {
  assert.equal(
    isRetryableJobError(Object.assign(new Error("login"), { code: "NEEDS_LOGIN" })),
    false
  );
  assert.equal(
    isRetryableJobError(
      Object.assign(new Error("no response"), {
        code: "NO_RESPONSE_DETECTED",
      })
    ),
    true
  );
  assert.equal(
    shouldRetryInline(
      Object.assign(new Error("Gemini refused"), {
        code: "GEMINI_REFUSED_RESPONSE",
      })
    ),
    false
  );
});

test("remote Gemini failures are deferred without a rapid duplicate submission", async () => {
  let attempts = 0;
  const { engine, reports } = fixture(async () => {
    attempts += 1;
    const error = new Error("Gemini page error");
    error.code = "GEMINI_PAGE_ERROR";
    throw error;
  });
  engine.active.set("account-1", {
    taskId: "task-page-error",
    accountId: "account-1",
    accountName: "Gemini 1",
  });

  await engine.execute(
    { id: "account-1", name: "Gemini 1" },
    { id: "task-page-error", imageUrls: [] }
  );

  assert.equal(attempts, 1);
  assert.deepEqual(reports.map((item) => item.action), ["defer"]);
  assert.ok(
    engine.cooldownUntil.get("account-1") >=
      Date.now() + ACCOUNT_FAILURE_BACKOFF_MS[0] - 1_000
  );
});

test("repeated transient Gemini failures are deferred instead of immediately failed", async () => {
  const { engine, reports } = fixture(async () => {
    const error = new Error("file chooser temporarily unavailable");
    error.code = "UPLOAD_NOT_CONFIRMED";
    throw error;
  });
  engine.active.set("account-1", {
    taskId: "task-recover",
    accountId: "account-1",
    accountName: "Gemini 1",
  });

  await engine.execute(
    { id: "account-1", name: "Gemini 1" },
    { id: "task-recover", imageUrls: [] }
  );

  assert.deepEqual(
    reports.map((item) => item.action),
    ["retrying", "defer"]
  );
});

test("generated prompts stay in the local outbox until writeback recovers", async () => {
  const { engine, store } = fixture(async () => "x".repeat(350));
  let writebackAttempts = 0;
  engine.report = async (_taskId, action) => {
    if (action === "result") {
      writebackAttempts += 1;
      if (writebackAttempts === 1) throw new TypeError("fetch failed");
    }
    return { ok: true };
  };
  engine.active.set("account-1", {
    taskId: "task-outbox",
    accountId: "account-1",
    accountName: "Gemini 1",
  });

  await engine.execute(
    { id: "account-1", name: "Gemini 1" },
    { id: "task-outbox", imageUrls: [] }
  );
  assert.equal(store.state.pendingResults.length, 1);
  assert.equal(store.state.pendingResults[0].prompt.length, 350);

  await engine.flushPendingResults();
  assert.equal(writebackAttempts, 2);
  assert.equal(store.state.pendingResults.length, 0);
});

test("script pipeline preserves structured artifacts during writeback", async () => {
  const optimizedGroupsJson = JSON.stringify([
    { index: 1, targetDuration: 20, optimizedPrompt: "成品提示词" },
  ]);
  const { engine, reports } = fixture(async () => ({
    prompt: "x".repeat(350),
    analysis: "",
    rewrittenScript: "格式化剧本",
    extractionJson: "{\"characters\":[]}",
    storyboardJson: "{\"storyboards\":[]}",
    rawGroupsJson: "[{\"index\":1}]",
    optimizedGroupsJson,
  }));
  engine.active.set("account-1", {
    taskId: "script-task",
    accountId: "account-1",
    accountName: "Gemini 1",
  });

  await engine.execute(
    { id: "account-1", name: "Gemini 1" },
    { id: "script-task", kind: "script-pipeline", imageUrls: [] }
  );

  const writeback = reports.find((item) => item.action === "result");
  assert.equal(writeback.optimizedGroupsJson, optimizedGroupsJson);
  assert.equal(writeback.rewrittenScript, "格式化剧本");
});

test("legacy script outbox entries are released to resume only optimization", async () => {
  const { engine, reports, store } = fixture(async () => "unused");
  store.state.pendingResults.push({
    taskId: "legacy-script",
    kind: "script-pipeline",
    prompt: "x".repeat(350),
    optimizedGroupsJson: "",
  });
  engine.report = async (taskId, action, extra = {}) => {
    reports.push({ taskId, action, ...extra });
    if (action === "result") {
      throw Object.assign(new Error("最终优化提示词不是合法 JSON"), { status: 400 });
    }
    return { ok: true };
  };

  assert.equal(await engine.flushPendingResults(), true);
  assert.equal(store.state.pendingResults.length, 0);
  assert.deepEqual(reports.map((item) => item.action), ["result", "release"]);
});

test("bridge network and server failures are classified for safe retries", () => {
  assert.equal(isTransientBridgeError(new TypeError("fetch failed")), true);
  assert.equal(
    isTransientBridgeError(Object.assign(new Error("HTTP 500"), { status: 500 })),
    true
  );
  assert.equal(
    isTransientBridgeError(Object.assign(new Error("conflict"), { status: 409 })),
    false
  );
});
