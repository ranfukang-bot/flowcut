const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { Store } = require("../src/store");

test("Gemini pending writebacks survive a desktop restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flowcut-outbox-"));
  const app = { getPath: () => directory };
  try {
    const first = new Store(app);
    first.upsertPendingResult("task-1", "x".repeat(350), "worker-old");

    const restored = new Store(app);
    assert.equal(restored.state.pendingResults.length, 1);
    assert.equal(restored.state.pendingResults[0].taskId, "task-1");
    assert.equal(restored.state.pendingResults[0].workerId, "worker-old");

    restored.removePendingResult("task-1");
    assert.equal(new Store(app).state.pendingResults.length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
