const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const sourceRoot = path.resolve(__dirname, "..", "src");

test("Gemini submission accepts real page signals without attachment-count gating", () => {
  const preload = fs.readFileSync(
    path.join(sourceRoot, "gemini-preload.js"),
    "utf8"
  );
  assert.match(preload, /const responseAdded =/);
  assert.match(preload, /observedSubmission =\s+observedSubmission \|\|/);
  assert.match(preload, /const generationStarted = !generatingBefore && generating/);
  assert.match(preload, /generationStarted \|\|\s+textCleared/);
  assert.match(preload, /发送后的最终状态复核/);
  assert.equal(preload.includes("attachmentsSent"), false);
});

test("Gemini jobs clear stale generation and wait for a stable complete response", () => {
  const preload = fs.readFileSync(
    path.join(sourceRoot, "gemini-preload.js"),
    "utf8"
  );
  assert.match(preload, /停止 Gemini 上一条残留生成/);
  assert.match(preload, /document\.readyState === "complete"/);
  assert.match(preload, /!inProgress && Date\.now\(\) - changedAt > 3000/);
  assert.match(preload, /const confirmedText =/);
  assert.match(preload, /新对话编辑器稳定/);
  assert.match(preload, /for \(let attempt = 1; attempt <= 3; attempt \+= 1\)/);
  assert.match(preload, /连续 3 次没有完整写入输入框/);
  assert.match(preload, /function conversationHasContent/);
  assert.match(preload, /userMessageCount\(\)/);
});

test("Gemini upload can use hidden file inputs and waits for delayed previews", () => {
  const preload = fs.readFileSync(
    path.join(sourceRoot, "gemini-preload.js"),
    "utf8"
  );
  assert.match(preload, /function firstConnected/);
  assert.match(preload, /firstConnected\('input\[type="file"\]/);
  assert.match(preload, /name: "native-chooser"/);
  assert.match(preload, /gemini:upload-files-via-chooser/);
  assert.match(preload, /upload_native_selected_but_not_attached/);
  assert.match(preload, /upload_native_chooser_failed/);
  assert.match(
    preload,
    /strategy\.name === "native-chooser" &&\s+nativeChooserResult\?\.ok/
  );
  assert.match(preload, /name: "paste"/);
  assert.match(preload, /UPLOAD_NOT_CONFIRMED/);
  assert.match(preload, /waitForUploadSettlement\(files, wanted\)/);
  assert.match(preload, /商品图片在 Gemini 中处理超时/);
});

test("Gemini web jobs keep the account model unchanged and reject unusable short responses", () => {
  const preload = fs.readFileSync(
    path.join(sourceRoot, "gemini-preload.js"),
    "utf8"
  );
  assert.doesNotMatch(preload, /ensureProModel/);
  assert.doesNotMatch(preload, /ensureGeminiWebModel/);
  assert.doesNotMatch(preload, /bard-mode-menu-button|model-picker|model-select|model-switcher|model-choice-item/);
  assert.doesNotMatch(preload, /MODEL_SELECTION_FAILED/);
  assert.match(preload, /GEMINI_MEDIA_UNREADABLE/);
  assert.match(preload, /GEMINI_REFUSED_RESPONSE/);
  assert.match(preload, /all\(SELECTORS\.pageError\)\.filter\(visible\)/);
  const errorScanner = preload.match(
    /function visibleGeminiError\(\) \{[\s\S]*?\n\}/
  )?.[0] || "";
  assert.equal(errorScanner.includes("document.body"), false);
});

test("Gemini signed-out tool banner is treated as a login failure", () => {
  const preload = fs.readFileSync(
    path.join(sourceRoot, "gemini-preload.js"),
    "utf8"
  );
  assert.match(preload, /data-test-id="sign-out-banner"/);
  assert.match(preload, /登录即可体验工具/);
  assert.match(preload, /"NEEDS_LOGIN"/);
  assert.match(
    preload,
    /if \(error\?\.code === "NEEDS_LOGIN"\) throw error/
  );
});

test("Gemini diagnostics stay hidden instead of interrupting the user", () => {
  const main = fs.readFileSync(path.join(sourceRoot, "main.js"), "utf8");
  const start = main.indexOf('ipcMain.on("gemini:job-diagnostic"');
  const end = main.indexOf("function bindIpc", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = main.slice(start, end);
  assert.equal(handler.includes("window.show()"), false);
  assert.equal(handler.includes("window.focus()"), false);
  assert.match(handler, /upload_native_confirmed_dom_changed/);
  assert.match(handler, /informational \? "info" : "warn"/);
});

test("Gemini login windows use the FlowCut icon and persist successful login", () => {
  const main = fs.readFileSync(path.join(sourceRoot, "main.js"), "utf8");
  assert.match(main, /icon: flowcutWindowIcon\(\)/);
  assert.match(main, /cookies\.flushStore\(\)/);
  assert.match(main, /flushStorageData\(\)/);
});
