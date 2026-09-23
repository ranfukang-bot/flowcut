const assert = require("node:assert/strict");
const test = require("node:test");

const {
  runWithActivatedGeminiWorker,
} = require("../src/gemini-worker-activation");

function mockWindow({ visible = false, focused = false } = {}) {
  const calls = [];
  let currentVisible = visible;
  let currentFocused = focused;
  let currentOpacity = 1;
  let currentBounds = { x: 100, y: 100, width: 1280, height: 900 };
  return {
    calls,
    webContents: {
      focus() {
        calls.push(["webContents.focus"]);
      },
    },
    isDestroyed: () => false,
    isVisible: () => currentVisible,
    isFocused: () => currentFocused,
    getOpacity: () => currentOpacity,
    getBounds: () => ({ ...currentBounds }),
    setSkipTaskbar(value) {
      calls.push(["setSkipTaskbar", value]);
    },
    setOpacity(value) {
      currentOpacity = value;
      calls.push(["setOpacity", value]);
    },
    setBounds(value) {
      currentBounds = { ...value };
      calls.push(["setBounds", value]);
    },
    setFocusable(value) {
      calls.push(["setFocusable", value]);
    },
    setAlwaysOnTop(value, level) {
      calls.push(["setAlwaysOnTop", value, level]);
    },
    show() {
      currentVisible = true;
      calls.push(["show"]);
    },
    hide() {
      currentVisible = false;
      currentFocused = false;
      calls.push(["hide"]);
    },
    focus() {
      currentFocused = true;
      calls.push(["focus"]);
    },
    moveTop() {
      calls.push(["moveTop"]);
    },
  };
}

test("hidden Gemini worker is focused off-screen for upload then restored", async () => {
  const workerWindow = mockWindow();
  const ownerWindow = mockWindow({ visible: true, focused: true });
  const result = await runWithActivatedGeminiWorker({
    workerWindow,
    ownerWindow,
    action: async () => {
      assert.equal(workerWindow.isVisible(), true);
      assert.equal(workerWindow.isFocused(), true);
      assert.equal(workerWindow.getOpacity(), 0);
      return "uploaded";
    },
  });

  assert.equal(result, "uploaded");
  assert.equal(workerWindow.isVisible(), false);
  assert.equal(workerWindow.getOpacity(), 1);
  assert.deepEqual(workerWindow.getBounds(), {
    x: 100,
    y: 100,
    width: 1280,
    height: 900,
  });
  assert.equal(
    workerWindow.calls.some(
      (call) => call[0] === "setBounds" && call[1].x === -32000
    ),
    true
  );
  assert.equal(
    ownerWindow.calls.some((call) => call[0] === "focus"),
    true
  );
});

test("worker state is restored even when native upload fails", async () => {
  const workerWindow = mockWindow();
  const ownerWindow = mockWindow({ visible: true, focused: true });

  await assert.rejects(
    runWithActivatedGeminiWorker({
      workerWindow,
      ownerWindow,
      action: async () => {
        throw new Error("chooser failed");
      },
    }),
    /chooser failed/
  );

  assert.equal(workerWindow.isVisible(), false);
  assert.equal(workerWindow.getOpacity(), 1);
  assert.equal(
    ownerWindow.calls.some((call) => call[0] === "focus"),
    true
  );
});

test("debug-visible worker stays visible", async () => {
  const workerWindow = mockWindow({ visible: true, focused: true });
  await runWithActivatedGeminiWorker({
    workerWindow,
    debugVisible: true,
    action: async () => true,
  });

  assert.equal(workerWindow.isVisible(), true);
  assert.equal(
    workerWindow.calls.some((call) => call[0] === "hide"),
    false
  );
});
