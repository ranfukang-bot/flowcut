const { ipcRenderer } = require("electron");

const SELECTORS = {
  promptInput:
    'rich-textarea div[contenteditable="true"], div[contenteditable="true"][aria-label*="Gemini" i], div.ql-editor[contenteditable="true"], textarea[aria-label*="Gemini" i]',
  sendButton:
    'button[aria-label="发送" i], button[aria-label*="发送" i], button[aria-label*="Send" i], button[aria-label*="Submit" i], button[mattooltip*="发送" i], button[mattooltip*="Send" i], button[data-mat-icon-name="send"], button:has(mat-icon[data-mat-icon-name="arrow_upward"]), button:has(mat-icon[data-mat-icon-name="send"])',
  fileInput: 'input[type="file"]',
  uploadButton:
    'button[aria-label*="上传" i], button[aria-label*="添加文件" i], button[aria-label*="添加图片" i], button[aria-label*="upload" i], button[aria-label*="attach" i], button[data-test-id*="upload" i], button[data-test-id*="attach" i]',
  attachedFileItem:
    'rich-textarea img[alt="attachment" i], rich-textarea img[src^="blob:" i], rich-textarea [class*="attachment" i], rich-textarea [class*="preview" i], rich-textarea [class*="file-chip" i], img[alt*="上传图片" i], img[alt*="uploaded image" i], button[aria-label*="显示上传的图片" i], button[aria-label*="show uploaded image" i], [data-test-id*="attachment" i], [data-test-id*="file-preview" i], [data-test-id*="uploaded-file" i], [class*="attachment-chip" i], [class*="attachment-container" i], [class*="upload-preview" i], img[src^="blob:" i], .gem-attachment-close-button, button[aria-label*="关闭附件" i], button[aria-label*="移除附件" i], button[aria-label*="Remove attachment" i], button[aria-label*="Remove file" i], button[aria-label*="删除文件" i], button[aria-label*="删除图片" i], button[aria-label*="Remove image" i]',
  attachmentCloseButton:
    '.gem-attachment-close-button, button[aria-label*="关闭附件" i], button[aria-label*="移除附件" i], button[aria-label*="Remove attachment" i], button[aria-label*="Remove file" i], button[aria-label*="删除文件" i], button[aria-label*="删除图片" i], button[aria-label*="Remove image" i], button[data-test-id*="remove-file" i], button[data-test-id*="remove-attachment" i]',
  responseMarkdown:
    '[id^="model-response-message-content"], model-response message-content, model-response .markdown, model-response, message-content .markdown, message-content, [data-test-id*="model-response" i], [data-message-author-role="model"], [data-message-author-role="assistant"], article[data-author="assistant"]',
  stopGenerating:
    'button[aria-label*="停止" i], button[aria-label*="Stop" i], button[data-test-id*="stop-generating" i], [data-test-id="stop-generating-button"], button:has(mat-icon[data-mat-icon-name="stop"])',
  pageError:
    'mat-snack-bar-container, [data-test-id*="error" i], .error-message, .error-container, [role="alertdialog"], .snackbar-content, [role="alert"]',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function all(selectors) {
  const output = new Set();
  for (const selector of String(selectors || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    document.querySelectorAll(selector).forEach((element) => output.add(element));
  }
  return [...output];
}

function visible(element) {
  if (!element || !element.isConnected) return false;
  const style = getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    Number(style.opacity) === 0
  ) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function first(selectors) {
  for (const selector of String(selectors || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const elements = document.querySelectorAll(selector);
    for (const element of elements) {
      if (!visible(element)) continue;
      if (
        selectors === SELECTORS.sendButton &&
        element.closest(
          'model-response, message-content, [class*="response" i], chat-history'
        )
      ) {
        continue;
      }
      return element;
    }
  }
  return null;
}

function firstConnected(selectors) {
  for (const selector of String(selectors || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    for (const element of document.querySelectorAll(selector)) {
      if (element?.isConnected) return element;
    }
  }
  return null;
}

async function waitUntil(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return true;
    await sleep(300);
  }
  throw new Error(`等待超时：${label}`);
}

async function waitFor(selectors, timeoutMs, label) {
  let element = null;
  await waitUntil(() => {
    element = first(selectors);
    return Boolean(element);
  }, timeoutMs, label);
  return element;
}

function loginOrChallengeVisible() {
  const text = String(document.body?.innerText || "").slice(0, 6000);
  return (
    location.hostname.includes("accounts.google.") ||
    Boolean(document.querySelector('[data-test-id="sign-out-banner"]')) ||
    /Sign in to continue|Sign in to (?:use|try|experience) tools|登录以继续|登录即可体验工具|验证您是人类|Verify you are human|captcha/i.test(
      text
    )
  );
}

function rebuildFiles(files) {
  return files.map((item) => {
    const bytes =
      item.data instanceof Uint8Array ? item.data : new Uint8Array(item.data);
    return new File([bytes], item.name, { type: item.mime || "image/jpeg" });
  });
}

function composerRoot() {
  const editor = first(SELECTORS.promptInput);
  if (!editor) return null;
  return (
    editor.closest("form") ||
    editor.closest('[class*="input-area" i]') ||
    editor.closest('[class*="composer" i]') ||
    editor.closest("rich-textarea") ||
    editor.parentElement
  );
}

function composerMatches(selectors) {
  const root = composerRoot();
  if (!root) return [];
  // 参考 1.5.39：附件卡片可能是 rich-textarea 的兄弟节点，不能只在编辑器内找。
  // 同时排除旧对话和侧栏，不能把历史附件算成本次上传或点掉旧消息里的控件。
  return all(selectors).filter((element) => !element.closest(
    'model-response, message-content, user-query, chat-history, [class*="user-query" i], [data-message-author-role], article[data-author], [data-test-id*="user-query" i], nav, [aria-label*="sidebar" i], [aria-label*="侧边" i]'
  ));
}

function attachmentCount() {
  const closeButtons = composerMatches(SELECTORS.attachmentCloseButton).filter(visible);
  if (closeButtons.length) return closeButtons.length;
  const items = composerMatches(SELECTORS.attachedFileItem).filter(visible);
  // 一个附件的外层容器、卡片、缩略图可能同时命中，只数最内层的附件。
  return items.filter((item) => !items.some((child) => child !== item && item.contains(child))).length;
}

function fileNamesVisible(files) {
  if (!files.length) return true;
  const searchable = all(
    'rich-textarea [aria-label], rich-textarea [title], rich-textarea [data-test-id], rich-textarea'
  )
    .filter(visible)
    .map((element) =>
      [
        element.innerText,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title"),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
    )
    .join("\n");
  return files.every((file) => searchable.includes(file.name.toLowerCase()));
}

function uploadConfirmed(files, expectedCount) {
  return attachmentCount() >= expectedCount || fileNamesVisible(files);
}

async function clearExistingAttachments() {
  const existing = composerMatches(SELECTORS.attachmentCloseButton);
  for (const closeButton of existing) {
    closeButton.click();
    await sleep(150);
  }
  const cleared = await waitUntil(
    () => attachmentCount() === 0,
    8_000,
    "清理 Gemini 输入区残留附件"
  )
    .then(() => true)
    .catch(() => false);
  if (!cleared) {
    throw codedError(
      `Gemini 输入区残留 ${attachmentCount()} 张旧附件，已停止任务以免商品图片混用`,
      "STALE_ATTACHMENTS"
    );
  }
}

function editorText(editor = first(SELECTORS.promptInput)) {
  if (!editor) return "";
  return String("value" in editor ? editor.value : editor.innerText || "");
}

function responseElements() {
  const identified = all('[id^="model-response-message-content"]').filter(
    (element) => visible(element) && String(element.innerText || "").trim()
  );
  if (identified.length) return identified;
  return all(SELECTORS.responseMarkdown).filter(
    (element) =>
      visible(element) &&
      !element.closest(
        'rich-textarea, nav, [aria-label*="侧边" i], [aria-label*="sidebar" i]'
      ) &&
      String(element.innerText || "").trim()
  );
}

function responseSnapshot() {
  return responseElements().map((element) =>
    String(element.innerText || "").trim()
  );
}

function userMessageCount() {
  return all(
    'user-query, [data-test-id*="user-query" i], [class*="user-query" i]'
  ).filter(visible).length;
}

function generationInProgress() {
  return all(SELECTORS.stopGenerating).some((element) =>
    visible(element.closest("button") || element)
  );
}

function elementText(element) {
  return [
    element?.innerText,
    element?.getAttribute?.("aria-label"),
    element?.getAttribute?.("title"),
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function conversationHasContent() {
  return Boolean(
    responseElements().length ||
      userMessageCount() ||
      visibleGeminiError()
  );
}

async function ensureFreshConversation() {
  if (generationInProgress()) {
    const stopButton = first(SELECTORS.stopGenerating);
    if (stopButton) stopButton.click();
    const stopped = await waitUntil(
      () => !generationInProgress(),
      15_000,
      "停止 Gemini 上一条残留生成"
    )
      .then(() => true)
      .catch(() => false);
    if (!stopped) {
      throw codedError(
        "Gemini 上一条生成仍未结束，已停止本次任务以免混入旧回复",
        "CONVERSATION_RESET_FAILED"
      );
    }
  }
  if (!conversationHasContent()) return;
  const candidates = all(
    'a[aria-label*="发起新对话" i], a[aria-label*="New chat" i], a[href="/app"]'
  ).filter(visible);
  const newChat = candidates[0];
  if (!newChat) {
    throw codedError(
      "Gemini 当前停留在旧对话，且没有找到“发起新对话”按钮",
      "CONVERSATION_RESET_FAILED"
    );
  }
  newChat.click();
  const cleared = await waitUntil(
    () => !conversationHasContent() && !generationInProgress(),
    20_000,
    "进入 Gemini 新对话"
  )
    .then(() => true)
    .catch(() => false);
  if (!cleared) {
    throw codedError(
      "Gemini 没有进入空白新对话，已停止本次任务以免读取旧回复",
      "CONVERSATION_RESET_FAILED"
    );
  }
  await waitFor(SELECTORS.promptInput, 20_000, "新对话输入框重新就绪");
  await waitUntil(
    () => {
      const editor = first(SELECTORS.promptInput);
      return Boolean(editor?.isConnected && visible(editor) && !generationInProgress());
    },
    10_000,
    "新对话编辑器稳定"
  );
  // Model and thinking preferences belong to the user. Starting a new chat
  // must not open the model menu or replace those preferences with a fallback.
  await sleep(800);
}

function uploadProcessingVisible() {
  const candidates = composerMatches(
    'rich-textarea mat-progress-spinner, rich-textarea [role="progressbar"], rich-textarea [class*="progress" i], rich-textarea [class*="loading" i], rich-textarea [aria-busy="true"], rich-textarea [aria-label*="上传中" i], rich-textarea [aria-label*="uploading" i], rich-textarea [aria-label*="processing" i], [class*="attachment" i] mat-progress-spinner, [class*="attachment" i] [role="progressbar"], [class*="attachment" i] [class*="progress" i], [class*="attachment" i] [class*="loading" i], [class*="attachment" i] [aria-busy="true"], [class*="upload" i] mat-progress-spinner, [class*="upload" i] [role="progressbar"], [class*="upload" i] [aria-busy="true"]'
  ).filter(visible);
  return candidates.length > 0;
}

async function waitForUploadSettlement(files, expectedCount) {
  const containsVideo = files.some((file) =>
    String(file.type || "").startsWith("video/")
  );
  const timeoutMs = containsVideo ? 150_000 : 60_000;
  const startedAt = Date.now();
  // The native chooser only proves that Chromium selected the files. It does
  // not prove Gemini finished ingesting them. Keep every item on screen long
  // enough for Gemini to create/process its attachment before continuing.
  // Gemini creates attachment cards before their bytes are available to the
  // model. Submitting as soon as the card appears makes Gemini report that no
  // image was attached and turns a 4-second upload into several full retries.
  // Use a short count-aware ingest window: it is still much faster than a
  // retry, while separate worker windows keep different tasks concurrent.
  const imageCount = files.filter((file) =>
    String(file.type || "").startsWith("image/")
  ).length;
  const minimumWaitMs = containsVideo
    ? 5_000
    : Math.min(5_000, 2_800 + Math.max(0, imageCount - 1) * 650);
  let stableSince = 0;
  while (Date.now() - startedAt < timeoutMs) {
    if (loginOrChallengeVisible()) throw codedError("Gemini 登录已失效，请重新登录", "NEEDS_LOGIN");
    const pageError = visibleGeminiError();
    if (pageError) {
      throw codedError(
        `Gemini 处理上传素材时返回错误：${pageError}`,
        "GEMINI_PAGE_ERROR"
      );
    }
    const processing = uploadProcessingVisible();
    const attached = uploadConfirmed(files, expectedCount);
    if (processing || !attached) {
      stableSince = 0;
    } else if (!stableSince) {
      stableSince = Date.now();
    } else if (
      Date.now() - stableSince >= (containsVideo ? 1800 : 2000) &&
      Date.now() - startedAt >= minimumWaitMs
    ) {
      ipcRenderer.send("gemini:job-diagnostic", {
        phase: "upload_settled",
        media: containsVideo ? "video" : "images",
        fileCount: files.length,
        attachmentCount: attachmentCount(),
        waitedMs: Date.now() - startedAt,
      });
      return;
    }
    await sleep(500);
  }
  throw codedError(
    containsVideo
      ? "参考视频在 Gemini 中处理超时，请检查视频格式后重试"
      : "商品图片在 Gemini 中处理超时，请稍后重试",
    "UPLOAD_PROCESSING_TIMEOUT"
  );
}

async function uploadFiles(inputFiles, filePaths = []) {
  if (!inputFiles.length) return;
  if (loginOrChallengeVisible()) {
    throw codedError(
      "Gemini 网页登录已失效，请在弹出的账号窗口重新登录",
      "NEEDS_LOGIN"
    );
  }
  const files = rebuildFiles(inputFiles);
  const before = attachmentCount();
  const wanted = before + files.length;
  let input = firstConnected('input[type="file"]');
  let nativeChooserResult = null;

  const strategies = [
    {
      name: "native-chooser",
      timeoutMs: 12_000,
      async run() {
        if (!filePaths.length) return false;
        const result = await ipcRenderer.invoke(
          "gemini:upload-files-via-chooser",
          filePaths
        );
        nativeChooserResult = result || null;
        if (!result?.ok) {
          ipcRenderer.send("gemini:job-diagnostic", {
            phase: "upload_native_chooser_failed",
            location: location.href,
            title: document.title,
            code: result?.code || "UNKNOWN",
            detail: result?.detail || "",
            filePathCount: filePaths.length,
            fileInputCount: all(SELECTORS.fileInput).length,
            uploadButtonCount: all(SELECTORS.uploadButton).filter(visible).length,
          });
        }
        if (result?.code === "NEEDS_LOGIN") {
          throw codedError(
            "Gemini 网页登录已失效，请在弹出的账号窗口重新登录",
            "NEEDS_LOGIN"
          );
        }
        const selectedCount = Number(result?.selectedFileCount || 0);
        if (result?.ok && selectedCount !== filePaths.length) {
          ipcRenderer.send("gemini:job-diagnostic", {
            phase: "upload_native_selection_incomplete",
            expectedFileCount: filePaths.length,
            selectedFileCount: selectedCount,
            selectedFiles: result?.selectedFiles || [],
          });
          throw codedError("Gemini 文件选择不完整，已停止发送以免漏图", "UPLOAD_NOT_CONFIRMED");
        }
        return Boolean(result?.ok);
      },
    },
    {
      name: "paste",
      timeoutMs: 15_000,
      run() {
        const editor = first(SELECTORS.promptInput);
        if (!editor) return false;
        editor.focus();
        const transfer = new DataTransfer();
        files.forEach((file) => transfer.items.add(file));
        editor.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: transfer,
          })
        );
        return true;
      },
    },
    {
      name: "input",
      timeoutMs: 15_000,
      async run() {
        input = input?.isConnected
          ? input
          : firstConnected('input[type="file"]');
        if (!input) return false;
        const transfer = new DataTransfer();
        files.forEach((file) => transfer.items.add(file));
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      },
    },
    {
      name: "drop",
      timeoutMs: 15_000,
      run() {
        const zone =
          document.querySelector("rich-textarea") ||
          document.querySelector("chat-app") ||
          document.body;
        const transfer = new DataTransfer();
        files.forEach((file) => transfer.items.add(file));
        ["dragenter", "dragover", "drop"].forEach((type) =>
          zone.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
            })
          )
        );
        return true;
      },
    },
  ];

  for (const strategy of strategies) {
    let fired = false;
    try {
      fired = await strategy.run();
    } catch (error) {
      if (error?.code === "NEEDS_LOGIN") throw error;
      if (error?.code === "UPLOAD_NOT_CONFIRMED") throw error;
      fired = false;
    }
    if (!fired) continue;
    const attached = await waitUntil(
      () => uploadConfirmed(files, wanted),
      strategy.timeoutMs,
      `上传商品图（${strategy.name}）`
    )
      .then(() => true)
      .catch(() => false);
    if (attached) {
      await ipcRenderer.invoke("gemini:send-key", "Escape");
      await waitForUploadSettlement(files, wanted);
      return;
    }
    if (strategy.name === "native-chooser" && nativeChooserResult?.ok) {
      ipcRenderer.send("gemini:job-diagnostic", {
        phase: "upload_native_selected_but_not_attached",
        location: location.href,
        title: document.title,
        attachmentCount: attachmentCount(),
        selectedFileCount: nativeChooserResult.selectedFileCount,
        selectedFiles: nativeChooserResult.selectedFiles,
        attempt: nativeChooserResult.attempt,
        fileInputCount: all(SELECTORS.fileInput).length,
        uploadButtonCount: all(SELECTORS.uploadButton).filter(visible).length,
      });
    }
    if (attachmentCount() > before) {
      const completed = await waitUntil(
        () => uploadConfirmed(files, wanted),
        30_000,
        `等待全部商品图上传完成（${strategy.name}）`
      )
        .then(() => true)
        .catch(() => false);
      if (completed) {
        await ipcRenderer.invoke("gemini:send-key", "Escape");
        await waitForUploadSettlement(files, wanted);
        return;
      }
      break;
    }
  }
  ipcRenderer.send("gemini:job-diagnostic", {
    phase: "upload_failed",
    location: location.href,
    title: document.title,
    attachmentCount: attachmentCount(),
    fileInputCount: all(SELECTORS.fileInput).length,
    uploadButtonCount: all(SELECTORS.uploadButton).filter(visible).length,
    editorTextLength: editorText().length,
  });
  throw codedError(
    "商品图上传失败：Gemini 页面没有确认全部附件，FlowCut 将自动重试一次",
    "UPLOAD_NOT_CONFIRMED"
  );
}

async function typePrompt(text) {
  const value = String(text || "");
  const expectedLength = value.trim().length;
  let actualLength = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const editor = await waitFor(SELECTORS.promptInput, 30_000, "Gemini 输入框");
    editor.click?.();
    editor.focus();
    await sleep(250 * attempt);
    await ipcRenderer.invoke("gemini:replace-editor-text", value);
    const inserted = await waitUntil(() => {
      const currentEditor = first(SELECTORS.promptInput) || editor;
      actualLength = editorText(currentEditor).trim().length;
      return actualLength >= Math.max(1, Math.floor(expectedLength * 0.9));
    }, 6_000, `完整写入 Gem 提示词（${attempt}/3）`)
      .then(() => true)
      .catch(() => false);
    if (inserted) {
      await sleep(500);
      return;
    }
    await sleep(600 * attempt);
  }
  throw codedError(
    `Gem 提示词连续 3 次没有完整写入输入框（应写入 ${expectedLength} 字，实际 ${actualLength} 字）`,
    "PROMPT_INPUT_FAILED"
  );
}

async function submitPrompt() {
  let button = await waitFor(SELECTORS.sendButton, 30_000, "发送按钮");
  const startedAt = Date.now();
  while (button.disabled || button.getAttribute("aria-disabled") === "true") {
    if (Date.now() - startedAt > 5 * 60_000) {
      throw codedError(
        "发送按钮长时间未就绪，商品图可能仍在处理",
        "UPLOAD_PROCESSING_TIMEOUT"
      );
    }
    await sleep(500);
    button = first(SELECTORS.sendButton) || button;
  }
  const userMessageCountBefore = userMessageCount();
  const attachmentsBefore = attachmentCount();
  const locationBefore = location.href;
  const responsesBefore = responseSnapshot();
  const generatingBefore = generationInProgress();
  const promptLengthBefore = editorText().trim().length;
  if (!promptLengthBefore) {
    throw codedError("Gem 提示词为空，已阻止发送", "PROMPT_INPUT_FAILED");
  }
  let observedSubmission = false;
  const submissionState = () => {
    const currentEditor = first(SELECTORS.promptInput);
    const textCleared =
      Boolean(currentEditor) && editorText(currentEditor).trim().length === 0;
    const userMessageAdded = userMessageCount() > userMessageCountBefore;
    const conversationOpened = location.href !== locationBefore;
    const responseAdded =
      JSON.stringify(responseSnapshot()) !== JSON.stringify(responsesBefore);
    const generating = generationInProgress();
    const generationStarted = !generatingBefore && generating;
    observedSubmission =
      observedSubmission ||
      userMessageAdded ||
      conversationOpened ||
      responseAdded ||
      generationStarted ||
      textCleared;
    return {
      confirmed: observedSubmission,
      textCleared,
      userMessageAdded,
      conversationOpened,
      responseAdded,
      generating,
      generatingBefore,
      generationStarted,
    };
  };
  const submissionConfirmed = () => {
    return submissionState().confirmed;
  };
  first(SELECTORS.promptInput)?.focus();
  await ipcRenderer.invoke("gemini:send-key", "Enter");
  let submitted = await waitUntil(
    submissionConfirmed,
    30_000,
    "确认 Gemini 已接收文字和商品图"
  )
    .then(() => true)
    .catch(() => false);
  if (
    !submitted &&
    editorText().trim().length > 0 &&
    !generationInProgress()
  ) {
    button.click();
    submitted = await waitUntil(
      submissionConfirmed,
      30_000,
      "再次确认 Gemini 已接收文字和商品图"
    )
      .then(() => true)
      .catch(() => false);
  }
  if (!submitted) {
    submitted = await waitUntil(
      submissionConfirmed,
      8_000,
      "发送后的最终状态复核"
    )
      .then(() => true)
      .catch(() => false);
  }
  if (!submitted) {
    const finalState = submissionState();
    ipcRenderer.send("gemini:job-diagnostic", {
      phase: "submit_failed",
      location: location.href,
      title: document.title,
      attachmentCount: attachmentCount(),
      editorTextLength: editorText().trim().length,
      userMessageCount: userMessageCount(),
      generationInProgress: finalState.generating,
      submissionState: finalState,
      sendButton: {
        aria: String(button.getAttribute("aria-label") || ""),
        disabled: Boolean(button.disabled),
        ariaDisabled: String(button.getAttribute("aria-disabled") || ""),
      },
    });
    throw codedError(
      `Gemini 没有确认接收本次内容（发送前 ${attachmentsBefore} 张图，当前 ${attachmentCount()} 张图），FlowCut 将自动重试一次`,
      "SUBMIT_NOT_CONFIRMED"
    );
  }
  await sleep(800);
}

function visibleGeminiError() {
  const errorPattern =
    /(?:Something went wrong|There was an error|An error occurred|Failed to generate(?: response)?|Unable to process(?: request)?|出了点问题|发生错误|服务器繁忙|请稍后重试|无法处理此请求|系统暂时无法响应|Try again later)/i;
  for (const element of all(SELECTORS.pageError).filter(visible)) {
    if (
      element.closest(
        'user-query, [data-test-id*="user-query" i], [class*="user-query" i], rich-textarea, nav, [aria-label*="侧边" i], [aria-label*="sidebar" i], model-response, message-content, [id^="model-response" i], [data-test-id*="model-response" i], [data-message-author-role], chat-history, chat-window, conversation-container, [role="main"], chat-app, main'
      )
    ) {
      continue;
    }
    const match = elementText(element).match(errorPattern);
    if (match?.[0]) return match[0].trim();
  }
  return "";
}

function classifyUnusableResponse(text) {
  const value = String(text || "").trim();
  if (value.length >= 280) return null;

  if (
    /(?:我无法|我未能|未能|无法)(?:查看|读取|识别|获取|处理)(?:该|此|您上传的|提供的)?(?:图片|图文|附件|文件)/i.test(
      value
    ) ||
    /(?:请上传|没有看到|未收到)(?:商品)?(?:图片|图文|附件|文件)/i.test(value) ||
    /(?:unable|cannot|can't|couldn't) (?:to )?(?:read|view|process|see) (?:the )?(?:image|attachment|file)/i.test(
      value
    )
  ) {
    return codedError(
      "Gemini 没有成功读取商品图，系统将重新上传后再试",
      "GEMINI_MEDIA_UNREADABLE"
    );
  }
  if (
    /我只是一个语言模型|我不具备这方面(?:的信息或)?能力|由于程序代码的局限|没法帮到你|无法帮助你|无法为您提供|I(?:'m| am) (?:just|only) a language model|I can(?:not|'t) (?:help|assist) with that/i.test(
      value
    )
  ) {
    return codedError(
      "Gemini 返回了能力限制答复，没有生成视频提示词，系统将换新对话后再试",
      "GEMINI_REFUSED_RESPONSE"
    );
  }
  return null;
}

// Only a fresh answer whose generation has stopped may advance to Seedance.
async function waitForResponse(initialResponses, minLength = 200) {
  const startedAt = Date.now();
  const baseline = JSON.stringify(initialResponses);
  let lastText = "";
  let changedAt = startedAt;
  let started = false;
  while (true) {
    if (loginOrChallengeVisible()) {
      throw codedError("Gemini 登录已失效或需要人工验证", "NEEDS_LOGIN");
    }
    const pageError = visibleGeminiError();
    if (pageError && Date.now() - startedAt > 5000) {
      throw codedError(`Gemini 页面返回错误：${pageError}`, "GEMINI_PAGE_ERROR");
    }
    const responses = responseSnapshot();
    const fresh = JSON.stringify(responses) !== baseline;
    const currentText = fresh ? String(responses.at(-1) || "").trim() : "";
    const inProgress = generationInProgress();
    if (currentText || inProgress) started = true;
    if (currentText !== lastText) {
      lastText = currentText;
      changedAt = Date.now();
    }
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    geminiProgress = currentText
      ? `Gemini 正在生成 · 已接收 ${currentText.length} 字 · ${seconds} 秒`
      : `等待 Gemini 回复 · ${seconds} 秒`;
    if (fresh && lastText.length > 5 && !inProgress && Date.now() - changedAt > 3000) {
      await sleep(500);
      const confirmedText = String(responseSnapshot().at(-1) || "").trim();
      if (confirmedText !== lastText || generationInProgress()) continue;
      const unusableResponse = classifyUnusableResponse(lastText);
      if (unusableResponse) throw unusableResponse;
      if (lastText.length < minLength) {
        throw codedError(`Gemini 回复不完整（${lastText.length} 字），任务将自动恢复`, "INCOMPLETE_RESPONSE");
      }
      geminiProgress = "提示词已完成，正在回传";
      return lastText;
    }
    if (!started && Date.now() - startedAt >= 90_000) {
      throw codedError("发送后 90 秒没有检测到新回复，任务将自动恢复", "NO_RESPONSE_DETECTED");
    }
    if (started && Date.now() - changedAt >= 180_000) {
      throw codedError("Gemini 连续 3 分钟没有新输出，任务将自动恢复", "RESPONSE_STALLED");
    }
    if (Date.now() - startedAt >= 8 * 60_000) {
      throw codedError("Gemini 本轮回复超过 8 分钟，任务将自动恢复", "RESPONSE_TIMEOUT");
    }
    await sleep(500);
  }
}

async function runJob(job) {
  if (loginOrChallengeVisible()) {
    const error = new Error("Gemini 登录已失效或需要人工验证");
    error.code = "NEEDS_LOGIN";
    throw error;
  }
  await waitUntil(
    () => document.readyState === "complete",
    15_000,
    "Gemini 页面加载完成"
  );
  await waitFor(SELECTORS.promptInput, 45_000, "Gemini 输入框");
  await sleep(500);
  await ensureFreshConversation();
  await clearExistingAttachments();
  geminiProgress = "正在上传商品图片";
  await uploadFiles(job.files || [], job.filePaths || []);
  geminiProgress = "正在填写并发送提示词";
  await typePrompt(job.prompt);
  const baseline = responseSnapshot();
  await submitPrompt();
  return waitForResponse(baseline);
}

async function runReferenceRemixJob(job) {
  if (loginOrChallengeVisible()) {
    const error = new Error("Gemini 登录已失效或需要人工验证");
    error.code = "NEEDS_LOGIN";
    throw error;
  }
  await waitUntil(
    () => document.readyState === "complete",
    15_000,
    "Gemini 页面加载完成"
  );
  await waitFor(SELECTORS.promptInput, 45_000, "Gemini 输入框");
  await sleep(500);

  // 整个复刻任务只在这里新建一次对话。第二轮严禁再次调用此函数，
  // 从而让 Gemini 保留第一轮对对标视频的理解。
  await ensureFreshConversation();
  await clearExistingAttachments();
  await uploadFiles(job.referenceFiles || [], job.referenceFilePaths || []);
  await typePrompt(job.analysisPrompt);
  const analysisBaseline = responseSnapshot();
  await submitPrompt();
  const analysis = await waitForResponse(analysisBaseline, 60);
  ipcRenderer.send("gemini:job-stage", {
    requestId: job.requestId,
    stage: "product_adapting",
    analysis,
  });
  const conversationUrl = location.href;
  const responsesAfterAnalysis = responseSnapshot();

  await clearExistingAttachments();
  await uploadFiles(job.files || [], job.filePaths || []);
  await typePrompt(job.adaptationPrompt);
  const adaptationBaseline = responseSnapshot();
  if (adaptationBaseline.length < responsesAfterAnalysis.length) {
    throw codedError(
      "Gemini 在第二轮开始前丢失了第一轮对话，已阻止生成错误结果",
      "CONVERSATION_RESET_FAILED"
    );
  }
  await submitPrompt();
  const prompt = await waitForResponse(adaptationBaseline, 150);
  if (conversationUrl !== location.href) {
    throw codedError(
      "Gemini 第二轮跳到了新的对话，未采用对标视频分析结果",
      "CONVERSATION_RESET_FAILED"
    );
  }
  return { analysis, prompt };
}

function stripJsonFence(value) {
  return String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function parseJsonObject(value, label) {
  const cleaned = stripJsonFence(value);
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) {
    throw codedError(`${label}没有返回合法 JSON`, "INCOMPLETE_RESPONSE");
  }
  try {
    return JSON.parse(cleaned.slice(first, last + 1));
  } catch (error) {
    throw codedError(
      `${label} JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      "INCOMPLETE_RESPONSE"
    );
  }
}

async function runJsonRound(prompt, label) {
  const firstResponse = await runTextRound(prompt);
  try {
    return parseJsonObject(firstResponse, label);
  } catch (firstError) {
    const repairPrompt = `你刚才输出的${label}不是合法 JSON。请修复下面内容中的缺失逗号、未转义引号、换行或截断结构，保持全部字段和内容不变。只输出修复后的一个合法 JSON 对象，不要解释，不要代码块。\n\n【待修复内容】\n${firstResponse}`;
    const repaired = await runTextRound(repairPrompt);
    try {
      return parseJsonObject(repaired, label);
    } catch {
      throw firstError;
    }
  }
}

function extractionPrompt(screenplay, projectContext) {
  return `你是制片助理，从下面这集剧本中提取角色和场景。只提取本集真实出现或被明确提及的，不要遗漏有台词或重要动作的角色。

${String(projectContext || "").trim() ? `【项目已有角色/场景，同名或同地点同时间请复用】\n${String(projectContext).trim()}\n` : ""}
【严格输出格式】只输出合法 JSON，不要代码块、解释或额外文字。所有字符串内部的双引号、反斜杠和换行必须正确转义：
{"characters":[{"id":1,"name":"角色名","role":"主角/配角/龙套","description":"背景与人物关系","appearance":"性别、年龄、体型、面部、发型、着装，300-500字","personality":"核心性格标签"}],"scenes":[{"id":1,"location":"具体地点","time":"时间段+光线","prompt":"用于AI图片生成的英文纯背景提示词，不含人物"}]}

characters 和 scenes 的 id 都从1开始连续递增；同名角色不重复，同地点且同时间段的场景不重复。

【本集剧本】
${screenplay}`;
}

function storyboardPrompt(screenplay, extractionJson) {
  return `你是资深影视分镜师，把下面这集剧本拆解为完整分镜序列。剧本中的每一行对白和每一段旁白都必须完整出现在某个镜头的 dialogue 字段里，一字不漏。不要改写或创作台词。动作场景一个明确动作一个镜头，宁可多拆也不能省略。character_ids 和 scene_id 只能使用给定 JSON 中存在的 id。

只输出合法 JSON，不要代码块或解释。所有 dialogue、action、description、prompt 字符串内部的双引号、反斜杠和换行必须正确转义，禁止输出未转义引号：
{"storyboards":[{"shot_number":1,"title":"3-8字标题","shot_type":"远景/全景/中景/近景/特写","angle":"平视/仰视/俯视/侧拍","movement":"固定/推/拉/摇/跟拍","location":"地点","time":"时间段","scene_id":1,"character_ids":[1],"action":"角色动作与表演","dialogue":"原文台词或旁白原文，无则空串","description":"镜头概述","result":"镜头结束画面","atmosphere":"氛围、光线、色调","image_prompt":"静态画面英文提示词","video_prompt":"动态视频提示词，必须从0秒开始按约3秒分段，使用<location>地点</location>、<role>角色名</role>、<voice>旁白</voice>标记，<n>分隔","bgm_prompt":"具体配乐风格","sound_effect":"关键音效","duration":6}]}

有对白的镜头按实际说完台词所需时长设置，通常4-10秒；单一短动作3-8秒，复杂动作8-15秒。每个 video_prompt 的最后时间点必须等于 duration。

【可用角色与场景】
${extractionJson}

【本集剧本】
${screenplay}`;
}

function shiftTimeline(prompt, offset, fallbackDuration) {
  const source = String(prompt || "").trim();
  let matched = false;
  const shifted = source.replace(/(\d+(?:\.\d+)?)\s*[-–—至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)/gi, (_all, start, end) => {
    matched = true;
    const a = Number(start) + offset;
    const b = Number(end) + offset;
    return `${Number.isInteger(a) ? a : a.toFixed(1)}-${Number.isInteger(b) ? b : b.toFixed(1)}秒`;
  });
  if (matched) return shifted;
  return `${offset}-${offset + fallbackDuration}秒：${source}`;
}

function buildRawGroups(storyboardValue) {
  const storyboards = Array.isArray(storyboardValue?.storyboards)
    ? storyboardValue.storyboards
    : [];
  if (!storyboards.length) {
    throw codedError("分镜 JSON 中没有 storyboards", "INCOMPLETE_RESPONSE");
  }
  const groups = [];
  let current = [];
  let duration = 0;
  const flush = () => {
    if (!current.length) return;
    let offset = 0;
    const timeline = current.map((shot) => {
      const shotDuration = Math.max(1, Math.min(25, Number(shot.duration || 6)));
      const text = shiftTimeline(shot.video_prompt || shot.description || shot.action, offset, shotDuration);
      offset += shotDuration;
      return text;
    }).join("<n>");
    const dialogues = current.map((shot) => String(shot.dialogue || "").trim()).filter(Boolean);
    const effects = current.map((shot) => String(shot.sound_effect || "").trim()).filter(Boolean);
    const music = current.map((shot) => String(shot.bgm_prompt || "").trim()).filter(Boolean);
    const rawPrompt = `${timeline}, 次世代游戏美术风格，8K超清，极致细节，真实材质渲染，景深效果，史诗氛围感，暗调暗黑奇幻风格, 高质量

--------------------
【音频提示（音画同出参考）】
${dialogues.length ? `【配音/台词】${dialogues.join("\n")}` : ""}
${effects.length ? `【音效】${[...new Set(effects)].join("、")}` : ""}
${music.length ? `【BGM】${[...new Set(music)].join("；")}` : ""}`.replace(/\n{3,}/g, "\n\n").trim();
    groups.push({
      index: groups.length + 1,
      rawDuration: duration,
      targetDuration: Math.min(duration, 20),
      shotNumbers: current.map((shot) => Number(shot.shot_number || 0)),
      rawPrompt,
    });
    current = [];
    duration = 0;
  };
  for (const shot of storyboards) {
    const shotDuration = Math.max(1, Math.min(25, Number(shot.duration || 6)));
    if (current.length && duration + shotDuration > 25) flush();
    current.push({ ...shot, duration: shotDuration });
    duration += shotDuration;
  }
  flush();
  return groups;
}

function optimizationPrompt(group) {
  const durationRule = group.rawDuration > 20
    ? "本组原分镜合计超过20秒，请在不遗漏剧情、完整台词和关键动作的前提下压缩到严格20秒；只输出一个连续提示词，不要拆成Part或多个视频。"
    : `本组原分镜合计${group.rawDuration}秒，必须保持总时长${group.rawDuration}秒，不要补足到20秒。`;
  return `你是 Seedance 2.5 官方写法视频提示词工程师、影视导演和分镜导演。把已确定的剧情、分镜和声音要求转换成可直接复制到 Seedance 2.5 使用的高质量视频提示词，不重新创作剧情。

${durationRule}
最高优先级：完整原始台词与剧情、原分镜顺序、人物产品场景一致性、动作准确性、镜头表达、声音。禁止添加不存在的角色、台词、动作和情节。
时间轴从0秒连续递增到${group.targetDuration}秒，不重叠、不倒退、不留空档。对白逐字保留，口型与语音同步；音效和BGM与动作同步。明确人物站位、可执行动作、表情、景别和运镜。连续镜头保持人物、服装、产品、场景和光线一致。画面不要字幕、自动字幕、文字转录或对白文字，只保留真实口播。

为保证多个视频格式完全一致，只输出下面结构的合法 JSON，不要代码块、标题、解释或其他文字。所有说明字段统一使用中文，原始角色名、产品名和外语台词保持原文：
{"style":"整体风格、画质、连续性和禁止字幕规范","segments":[{"start":0,"end":3,"shot_and_camera":"景别、机位和运镜","visual":"画面视觉与环境","action":"角色动作与表情，无则空字符串","dialogue":"原文对白，无则空字符串","sound_effect":"具体音效，无则空字符串","bgm":"具体配乐及变化，无则空字符串"}]}

segments 必须覆盖完整0-${group.targetDuration}秒，相邻段的 end 与下一段 start 必须完全相等，最后一段 end 必须严格等于${group.targetDuration}。字段名、字段顺序和数据类型不得改变，不得使用英文段落标题。

【待优化的未处理提示词】
${group.rawPrompt}`;
}

function promptTimecode(value) {
  const total = Math.max(0, Number(value || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  const renderedSeconds = Number.isInteger(seconds)
    ? String(seconds).padStart(2, "0")
    : seconds.toFixed(1).padStart(4, "0");
  return `${String(minutes).padStart(2, "0")}:${renderedSeconds}`;
}

function formatOptimizedPrompt(value, group) {
  const style = String(value?.style || "").trim();
  const segments = Array.isArray(value?.segments) ? value.segments : [];
  if (!style || !segments.length) {
    throw codedError("Gem 优化没有返回固定结构", "INCOMPLETE_RESPONSE");
  }
  let cursor = 0;
  const rendered = segments.map((segment, index) => {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      Math.abs(start - cursor) > 0.01
    ) {
      throw codedError(`Gem 优化第 ${index + 1} 段时间轴不连续`, "INCOMPLETE_RESPONSE");
    }
    cursor = end;
    const shotAndCamera = String(segment?.shot_and_camera || "").trim();
    const visual = String(segment?.visual || "").trim();
    if (!shotAndCamera || !visual) {
      throw codedError(`Gem 优化第 ${index + 1} 段缺少镜头或画面`, "INCOMPLETE_RESPONSE");
    }
    const lines = [
      `[${promptTimecode(start)}-${promptTimecode(end)}]`,
      `景别与运镜：${shotAndCamera}`,
      `画面视觉：${visual}`,
    ];
    const action = String(segment?.action || "").trim();
    const dialogue = String(segment?.dialogue || "").trim();
    const soundEffect = String(segment?.sound_effect || "").trim();
    const bgm = String(segment?.bgm || "").trim();
    if (action) lines.push(`动作与表情：${action}`);
    if (dialogue) lines.push(`对白口播：${dialogue}`);
    lines.push(
      `音效与音频：${soundEffect ? `【SFX】${soundEffect}` : "【SFX】无"}${bgm ? `【BGM】${bgm}` : "【BGM】无"}`
    );
    return lines.join("\n");
  });
  if (Math.abs(cursor - Number(group.targetDuration)) > 0.01) {
    throw codedError(
      `Gem 优化总时长为 ${cursor} 秒，应为 ${group.targetDuration} 秒`,
      "INCOMPLETE_RESPONSE"
    );
  }
  return `【整体风格与画质规范】\n${style}\n\n【分镜与时间轴（全长严格${group.targetDuration}秒连续递增）】\n\n${rendered.join("\n\n")}`;
}

async function runTextRound(prompt) {
  await clearExistingAttachments();
  await typePrompt(prompt);
  const baseline = responseSnapshot();
  await submitPrompt();
  return waitForResponse(baseline, 30);
}

async function runScriptPipelineJob(job) {
  if (loginOrChallengeVisible()) {
    const error = new Error("Gemini 登录已失效或需要人工验证");
    error.code = "NEEDS_LOGIN";
    throw error;
  }
  await waitUntil(() => document.readyState === "complete", 15_000, "Gemini 页面加载完成");
  await waitFor(SELECTORS.promptInput, 45_000, "Gemini 输入框");
  await sleep(500);

  let rewrittenScript = String(job.rewrittenScript || "").trim();
  let extractionJson = String(job.extractionJson || "").trim();
  let storyboardJson = String(job.storyboardJson || "").trim();
  let groups = [];

  if (job.rawGroupsJson) {
    try {
      groups = JSON.parse(job.rawGroupsJson);
    } catch {
      throw codedError("已保存的分镜组合不是合法 JSON", "INCOMPLETE_RESPONSE");
    }
    if (!Array.isArray(groups) || !groups.length) {
      throw codedError("已保存的分镜组合为空", "INCOMPLETE_RESPONSE");
    }
    if (storyboardJson) {
      try {
        groups = buildRawGroups(JSON.parse(storyboardJson));
      } catch {
        // 旧任务仍可直接复用已经保存的组合。
      }
    }
  } else {
    await ensureFreshConversation();
    await clearExistingAttachments();

    if (!rewrittenScript) {
      rewrittenScript = await runTextRound(job.prompt);
      ipcRenderer.send("gemini:job-stage", {
        requestId: job.requestId,
        stage: "extracting",
        rewrittenScript,
      });
    }

    if (!extractionJson) {
      const extraction = await runJsonRound(
        extractionPrompt(rewrittenScript, job.projectContext),
        "角色场景提取"
      );
      extractionJson = JSON.stringify(extraction, null, 2);
      ipcRenderer.send("gemini:job-stage", {
        requestId: job.requestId,
        stage: "storyboarding",
        rewrittenScript,
        extractionJson,
      });
    }

    let storyboard;
    if (storyboardJson) {
      storyboard = parseJsonObject(storyboardJson, "已保存的分镜拆解");
    } else {
      storyboard = await runJsonRound(
        storyboardPrompt(rewrittenScript, extractionJson),
        "分镜拆解"
      );
      storyboardJson = JSON.stringify(storyboard, null, 2);
      ipcRenderer.send("gemini:job-stage", {
        requestId: job.requestId,
        stage: "grouping",
        rewrittenScript,
        extractionJson,
        storyboardJson,
      });
    }
    groups = buildRawGroups(storyboard);
  }
  const rawGroupsJson = JSON.stringify(groups, null, 2);
  ipcRenderer.send("gemini:job-stage", {
    requestId: job.requestId,
    stage: "optimizing",
    rewrittenScript,
    extractionJson,
    storyboardJson,
    rawGroupsJson,
  });

  const optimizedGroups = [];
  for (const group of groups) {
    let optimizedPrompt = "";
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        // 每组使用全新对话，避免上一组或完整分镜污染当前视频提示词。
        await ensureFreshConversation();
        await sleep(500);
        const optimizedValue = await runJsonRound(
          optimizationPrompt(group),
          `第${group.index}组 Gem 优化`
        );
        optimizedPrompt = formatOptimizedPrompt(optimizedValue, group);
        break;
      } catch (error) {
        lastError = error;
        if (
          attempt >= 2 ||
          error?.code === "NEEDS_LOGIN" ||
          !["PROMPT_INPUT_FAILED", "SUBMIT_NOT_CONFIRMED", "NO_RESPONSE_DETECTED", "GEMINI_PAGE_ERROR", "INCOMPLETE_RESPONSE"].includes(error?.code || "")
        ) {
          throw error;
        }
        await sleep(1200);
      }
    }
    if (!optimizedPrompt) throw lastError || codedError("Gem 优化未返回内容", "INCOMPLETE_RESPONSE");
    optimizedGroups.push({ ...group, optimizedPrompt });
  }
  const optimizedGroupsJson = JSON.stringify(optimizedGroups, null, 2);
  const prompt = optimizedGroups
    .map((group) => `【最终视频提示词 ${group.index}｜${group.targetDuration}秒】\n${group.optimizedPrompt}`)
    .join("\n\n");
  return {
    prompt,
    analysis: "",
    rewrittenScript,
    extractionJson,
    storyboardJson,
    rawGroupsJson,
    optimizedGroupsJson,
  };
}

let geminiProgress = "正在准备 Gemini 页面";
async function executeGeminiJob(job) {
  geminiProgress = "正在准备 Gemini 页面";
  const heartbeat = () => ipcRenderer.send("gemini:job-stage", {
    requestId: job.requestId, stage: "progress", detail: geminiProgress,
  });
  heartbeat();
  const timer = setInterval(heartbeat, 10_000);
  try {
    return job.kind === "reference-remix"
      ? await runReferenceRemixJob(job)
      : job.kind === "script-pipeline"
        ? await runScriptPipelineJob(job)
        : { prompt: await runJob(job), analysis: "" };
  } finally {
    clearInterval(timer);
  }
}

ipcRenderer.on("gemini:run-job", async (_event, job) => {
  try {
    const result = await executeGeminiJob(job);
    ipcRenderer.send("gemini:job-result", {
      requestId: job.requestId,
      ok: true,
      prompt: result.prompt,
      analysis: result.analysis,
      rewrittenScript: result.rewrittenScript || "",
      extractionJson: result.extractionJson || "",
      storyboardJson: result.storyboardJson || "",
      rawGroupsJson: result.rawGroupsJson || "",
      optimizedGroupsJson: result.optimizedGroupsJson || "",
    });
  } catch (error) {
    ipcRenderer.send("gemini:job-result", {
      requestId: job.requestId,
      ok: false,
      code: error?.code || "",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
