const { createHash } = require("node:crypto");

function gemError(message) {
  return Object.assign(new Error(message), { code: "GEM_SETUP_REQUIRED" });
}

function cleanGemUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw gemError("请填写完整的 Gemini Gem 链接"); }
  if (url.origin !== "https://gemini.google.com" || url.username || url.password ||
      !/^\/gem\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    throw gemError("只接受 https://gemini.google.com/gem/… 链接，不接受普通对话或编辑页链接");
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

function gemVersion(gem) {
  if (!gem || !String(gem.id || "").trim() || !String(gem.content || "").trim()) {
    throw gemError("任务缺少 Gem 指令快照，请检查模板后重新生成任务");
  }
  return createHash("sha256").update(JSON.stringify([String(gem.id), String(gem.content).trim()])).digest("hex");
}

class SavedGems {
  constructor(store) { this.store = store; this.locks = new Map(); }
  account(id) {
    const account = this.store.state.accounts.find(a => a.id === id);
    if (!account) throw gemError("Gemini 账号不存在");
    return account;
  }
  get(accountId, gem) { return this.account(accountId).gemBindings?.[gemVersion(gem)] || null; }
  write(accountId, key, record) {
    const account = this.account(accountId);
    account.gemBindings = { ...account.gemBindings, [key]: record };
    if (!this.store.save()) throw gemError("Gem 链接/创建状态无法保存，请先解决磁盘写入问题；本次不发送任务");
  }
  bind(accountId, gem, url) {
    if (this.locks.has(accountId)) throw gemError("该账号正在创建 Gem，请稍后绑定");
    const record = { url: cleanGemUrl(url), status: "ready", source: "manual", name: gem.name, at: new Date().toISOString() };
    this.write(accountId, gemVersion(gem), record);
    return record;
  }
  async ensure(accountId, gem, driver) {
    if (this.locks.has(accountId)) throw gemError("该账号正在创建 Gem，请稍后重试");
    this.locks.set(accountId, true);
    try {
      const key = gemVersion(gem);
      const previous = this.get(accountId, gem);
      if (previous?.status === "ready") {
        // Also retry a failed local save before using an in-memory-only URL.
        this.write(accountId, key, previous);
        return cleanGemUrl(previous.url);
      }
      if (previous?.status === "saving") {
        throw gemError(`上次保存 Gem 的结果待核对（${previous.name}）。请在“Gem 模板 → 网页 Gem”粘贴已保存的链接，不会重复创建或改用普通聊天。`);
      }
      const name = `${String(gem.name || "Gem").slice(0, 65)} · FlowCut ${key.slice(0, 8)}`;
      // Preparing the form has no remote write. Only persist intent immediately
      // before Save; a crash after that is deliberately not retried blindly.
      try {
        await driver.prepare({ name, content: String(gem.content).trim() });
      } catch (error) {
        // No Save has been sent. Yield this task to the queue and retry later,
        // rather than treating a transient editor failure as manual setup.
        throw Object.assign(new Error(`Gem 创建准备暂时失败（尚未点击保存）：${error.message || error}`), {
          code: "GEM_SETUP_RETRYABLE", cause: error,
        });
      }
      this.write(accountId, key, { status: "saving", name, at: new Date().toISOString() });
      const url = cleanGemUrl(await driver.save());
      this.write(accountId, key, { status: "ready", source: "auto", name, url, at: new Date().toISOString() });
      return url;
    } finally { this.locks.delete(accountId); }
  }
}

// DOM selectors verified on Gemini's real Gem editor. Never opens the model
// selector, default-tool menu or the preview-chat editor.
const GEM_FIELDS = {
  name: "#gem-name-input",
  instructions: '[data-test-id="instruction-rich-input-field"] .ql-editor[contenteditable="true"]',
  save: '[data-test-id="create-button"]',
};

// Keep renderer code as literal strings: V8 bytecode intentionally does not
// retain Function#toString source in the protected desktop distribution.
const GEM_SCRIPTS = {
  focus: `selector => {
    const el = document.querySelector(selector);
    if (!el) throw new Error("Gem 编辑字段不存在");
    el.focus();
    if (typeof el.select === "function") el.select();
    else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }`,
  valueMatches: `({ selector, value }) => {
    const el = document.querySelector(selector);
    // Quill renders each input line as a paragraph. innerText adds layout-only
    // blank lines; compare text without those extra line breaks, not the HTML.
    const normalize = text => text.replace(/\\r\\n/g, "\\n").replace(/\\u00a0/g, " ").replace(/\\n+/g, "\\n").trim();
    return !!el && normalize(el.value ?? el.innerText ?? "") === normalize(value);
  }`,
  fieldStats: `({ selector, value }) => {
    const el = document.querySelector(selector);
    return { present: !!el, expectedLength: value.length, actualLength: (el?.value ?? el?.innerText ?? "").length };
  }`,
  formReady: `fields => Object.values(fields).every(s => document.querySelector(s))`,
  saveReady: `selector => {
    const el = document.querySelector(selector);
    return el && !el.disabled && el.getAttribute("aria-disabled") !== "true";
  }`,
  save: `selector => {
    const el = document.querySelector(selector);
    if (!el || el.disabled) throw new Error("Gem 保存按钮不可用");
    el.click();
  }`,
  savedUrl: `() => {
    const match = location.pathname.match(/^\\/gems\\/edit\\/([A-Za-z0-9_-]+)$/);
    if (!match || !document.querySelector('bot-creation-confirmation-dialog [data-test-id="new-conversation-button"]')) return null;
    return "https://gemini.google.com/gem/" + match[1];
  }`,
};

function createGemDriver(window, { timeoutMs = 45_000, verifyMs = 4_000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const run = (script, arg) => window.webContents.executeJavaScript(`(${script})(${JSON.stringify(arg)})`, true);
  async function wait(fn, description) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (window.isDestroyed()) throw gemError("Gem 创建窗口已关闭");
      const value = await fn();
      if (value) return value;
      await sleep(350);
    }
    throw gemError(`${description}超时。请到“Gem 模板 → 网页 Gem”检查或手动填写链接`);
  }
  async function fill(selector, value, label) {
    // Select only the intended field, independent of the native window's
    // Ctrl+A routing. Keep trusted insertText so Quill receives input events.
    for (let attempt = 0; attempt < 3; attempt++) {
      await wait(() => run(GEM_SCRIPTS.formReady, GEM_FIELDS), "等待 Gem 创建表单");
      window.webContents.focus?.();
      await run(GEM_SCRIPTS.focus, selector);
      await window.webContents.insertText(value);
      const deadline = Date.now() + Math.min(timeoutMs, verifyMs);
      while (Date.now() < deadline) {
        if (await run(GEM_SCRIPTS.valueMatches, { selector, value })) return;
        await sleep(350);
      }
    }
    const stats = await run(GEM_SCRIPTS.fieldStats, { selector, value });
    throw gemError(`核对 Gem ${label}填写超时（已重新填写 3 次；预期 ${stats.expectedLength} 字，实际 ${stats.actualLength} 字，字段${stats.present ? "存在" : "丢失"}；尚未点击保存）`);
  }
  return {
    async prepare({ name, content }) {
      let timer;
      try {
        await Promise.race([
          window.loadURL("https://gemini.google.com/gems/create"),
          new Promise((_, reject) => { timer = setTimeout(() => reject(gemError("Gem 创建页面加载超时，请检查网络或手动绑定链接")), timeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
      await wait(() => run(GEM_SCRIPTS.formReady, GEM_FIELDS), "等待 Gem 创建表单");
      await fill(GEM_FIELDS.name, name, "名称");
      await fill(GEM_FIELDS.instructions, content, "指令");
      await wait(() => run(GEM_SCRIPTS.saveReady, GEM_FIELDS.save), "等待 Gem 保存按钮");
      // A framework rerender may reset an earlier field while the next field
      // is being filled. Never persist a save intent for an incomplete form.
      if (!await run(GEM_SCRIPTS.valueMatches, { selector: GEM_FIELDS.name, value: name }) ||
          !await run(GEM_SCRIPTS.valueMatches, { selector: GEM_FIELDS.instructions, value: content })) {
        throw gemError("Gem 表单在保存前发生变化，尚未点击保存");
      }
    },
    async save() {
      await run(GEM_SCRIPTS.save, GEM_FIELDS.save);
      return wait(() => run(GEM_SCRIPTS.savedUrl), "确认 Gem 已保存");
    },
  };
}

module.exports = { SavedGems, cleanGemUrl, gemVersion, createGemDriver, GEM_FIELDS };
