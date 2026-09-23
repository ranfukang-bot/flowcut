const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Execute the real conversation-reset path, including any helpers it defines.
// Keep the screenshot's Lite-first menu so a broad Flash fallback is detectable.
const source = fs.readFileSync(
  process.env.FLOWCUT_MODEL_TEST_SOURCE || path.join(__dirname, "../src/gemini-preload.js"),
  "utf8"
);
const start = source.indexOf("async function ensureFreshConversation()");
const end = source.indexOf("function uploadProcessingVisible()", start);
assert.ok(start >= 0 && end > start);

function fixture({ label = "Flash 扩展", hasContent = true, generating = false, resetWorks = true, hasNewChat = true } = {}) {
  const clicks = [];
  const preferences = { model: label, extendedThinking: true };
  const state = { hasContent, generating };
  const button = (text, action = () => {}) => ({
    innerText: text,
    isConnected: true,
    getAttribute: () => null,
    click() { clicks.push(text); action(); },
  });
  const newChat = button("new-chat", () => {
    if (resetWorks) state.hasContent = false;
  });
  const stop = button("stop-generation", () => { state.generating = false; });
  const picker = button(label);
  const items = ["3.5 Flash-Lite 极速回答", "3.8 Flash 全方位帮助", "3.1 Pro 高级推理", "扩展思考"].map((text) =>
    button(text, () => {
      if (text === "扩展思考") preferences.extendedThinking = !preferences.extendedThinking;
      else { preferences.model = text; preferences.extendedThinking = false; }
    })
  );
  const context = vm.createContext({
    SELECTORS: { stopGenerating: "stop-selector", promptInput: "editor-selector" },
    generationInProgress: () => state.generating,
    conversationHasContent: () => state.hasContent,
    first: (selector) => selector === "stop-selector" ? stop : { isConnected: true },
    all: (selector) => {
      if (selector.includes('a[href="/app"]')) return hasNewChat ? [newChat] : [];
      if (selector.includes("bard-mode-menu-button")) return [picker];
      if (selector.includes("menuitem")) return items;
      return [];
    },
    visible: () => true,
    elementText: (element) => element.innerText,
    codedError: (message, code) => Object.assign(new Error(message), { code }),
    waitUntil: async (predicate) => { if (!predicate()) throw new Error("fixture wait failed"); },
    waitFor: async () => {},
    sleep: async () => {},
    ipcRenderer: { invoke: async (...args) => { clicks.push(args.join(":")); } },
  });
  vm.runInContext(source.slice(start, end), context);
  return { reset: () => context.ensureFreshConversation(), clicks, preferences, state };
}

for (const label of ["Flash 扩展", "3.8 Flash", "3.1 Pro", "Future model"]) {
  test(`new conversations/retries preserve user model and thinking: ${label}`, async () => {
    const page = fixture({ label });
    for (let turn = 0; turn < 3; turn += 1) {
      page.state.hasContent = true;
      await page.reset();
    }
    assert.deepEqual(page.clicks, ["new-chat", "new-chat", "new-chat"]);
    assert.deepEqual(page.preferences, { model: label, extendedThinking: true });
  });
}

test("blank conversations do not touch model or thinking controls", async () => {
  const page = fixture({ hasContent: false });
  await page.reset();
  assert.deepEqual(page.clicks, []);
  assert.equal(page.preferences.extendedThinking, true);
});

test("stale generation is still stopped without changing the model", async () => {
  const page = fixture({ generating: true });
  await page.reset();
  assert.deepEqual(page.clicks, ["stop-generation", "new-chat"]);
  assert.deepEqual(page.preferences, { model: "Flash 扩展", extendedThinking: true });
});

for (const options of [{ resetWorks: false }, { hasNewChat: false }]) {
  test(`failed conversation reset still blocks submission: ${JSON.stringify(options)}`, async () => {
    const page = fixture(options);
    await assert.rejects(page.reset(), { code: "CONVERSATION_RESET_FAILED" });
    assert.deepEqual(page.preferences, { model: "Flash 扩展", extendedThinking: true });
  });
}
