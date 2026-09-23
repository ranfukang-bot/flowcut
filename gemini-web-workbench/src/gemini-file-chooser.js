const CLICK_UPLOAD_CONTROL_SCRIPT = `(() => {
  const visible = (element) => {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const signedOut = () => Boolean(
    document.querySelector('[data-test-id="sign-out-banner"]')
  ) || /登录即可体验工具|Sign in to (?:use|try|experience) tools/i.test(
    String(document.body?.innerText || "")
  );
  const controls = () => [...document.querySelectorAll(
    'button, [role="button"], [role="menuitem"]'
  )].filter(visible);
  const uploadItem = () =>
    document.querySelector('[data-test-id="local-images-files-uploader-button"]') ||
    controls().find((element) =>
      /上传文件|上传图片|从设备上传|Upload files?|Upload images?/i.test(
        [element.innerText, element.getAttribute("aria-label")]
          .filter(Boolean)
          .join(" ")
      )
    );
  const targetInfo = (element, status) => {
    const rect = element.getBoundingClientRect();
    return {
      status,
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      },
      label: String(element.innerText || element.getAttribute("aria-label") || "").trim(),
      testId: String(element.getAttribute("data-test-id") || "")
    };
  };
  const findUploadItem = () => {
    if (signedOut()) {
      return { status: "needs-login" };
    }
    const item = uploadItem();
    if (!item) {
      return { status: "upload-item-missing" };
    }
    if (item.disabled || item.getAttribute("aria-disabled") === "true") {
      return { status: "upload-item-disabled" };
    }
    return targetInfo(item, "upload-item-ready");
  };
  if (uploadItem()) {
    return findUploadItem();
  }
  const trigger = controls().find((element) =>
    /上传和工具|添加文件|Upload and tools|Add files/i.test(
      [element.innerText, element.getAttribute("aria-label")]
        .filter(Boolean)
        .join(" ")
    )
  );
  if (!trigger) {
    return { status: "upload-trigger-missing" };
  }
  return targetInfo(trigger, "upload-trigger-ready");
})()`;

const CLICK_UPLOAD_ITEM_SCRIPT = `(() => {
  const visible = (element) => {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const signedOut = () => Boolean(
    document.querySelector('[data-test-id="sign-out-banner"]')
  ) || /登录即可体验工具|Sign in to (?:use|try|experience) tools/i.test(
    String(document.body?.innerText || "")
  );
  if (signedOut()) return { status: "needs-login" };
  const controls = [...document.querySelectorAll(
    'button, [role="button"], [role="menuitem"]'
  )].filter(visible);
  const item =
    document.querySelector('[data-test-id="local-images-files-uploader-button"]') ||
    controls.find((element) =>
      /上传文件|上传图片|从设备上传|Upload files?|Upload images?/i.test(
        [element.innerText, element.getAttribute("aria-label")]
          .filter(Boolean)
          .join(" ")
      )
    );
  if (!item || !visible(item)) return { status: "upload-item-missing" };
  if (item.disabled || item.getAttribute("aria-disabled") === "true") {
    return { status: "upload-item-disabled" };
  }
  const rect = item.getBoundingClientRect();
  return {
    status: "upload-item-ready",
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    },
    label: String(item.innerText || item.getAttribute("aria-label") || "").trim(),
    testId: String(item.getAttribute("data-test-id") || "")
  };
})()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function dispatchTrustedClick(webContents, target) {
  const rect = target?.rect;
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
    return false;
  }
  const x = Math.round(rect.x + Math.max(1, rect.width) / 2);
  const y = Math.round(rect.y + Math.max(1, rect.height) / 2);
  webContents.sendInputEvent({ type: "mouseMove", x, y });
  webContents.sendInputEvent({
    type: "mouseDown",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  webContents.sendInputEvent({
    type: "mouseUp",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sleep(180);
  return true;
}

async function clickGeminiUploadItem(webContents, timeoutMs = 12_000) {
  const controlStartedAt = Date.now();
  let lastResult = null;
  while (Date.now() - controlStartedAt < timeoutMs) {
    lastResult = await webContents.executeJavaScript(
      CLICK_UPLOAD_CONTROL_SCRIPT,
      true
    );
    if (lastResult?.status === "clicked") return lastResult;
    if (lastResult?.status === "upload-item-ready") {
      if (!(await dispatchTrustedClick(webContents, lastResult))) {
        return { status: "upload-item-coordinates-missing" };
      }
      return { ...lastResult, status: "clicked", trusted: true };
    }
    if (lastResult?.status === "upload-trigger-ready") {
      if (!(await dispatchTrustedClick(webContents, lastResult))) {
        return { status: "upload-trigger-coordinates-missing" };
      }
      lastResult = { ...lastResult, status: "menu-opened", trusted: true };
      break;
    }
    if (lastResult?.status === "needs-login") return lastResult;
    if (lastResult?.status === "menu-opened") break;
    if (!["upload-trigger-missing", "upload-trigger-disabled"].includes(lastResult?.status)) {
      return lastResult;
    }
    await sleep(150);
  }
  if (lastResult?.status !== "menu-opened") {
    return {
      status: "upload-trigger-timeout",
      detail: lastResult?.status || "unknown",
    };
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    lastResult = await webContents.executeJavaScript(
      CLICK_UPLOAD_ITEM_SCRIPT,
      true
    );
    if (lastResult?.status === "clicked") return lastResult;
    if (lastResult?.status === "upload-item-ready") {
      if (!(await dispatchTrustedClick(webContents, lastResult))) {
        return { status: "upload-item-coordinates-missing" };
      }
      return { ...lastResult, status: "clicked", trusted: true };
    }
    if (lastResult?.status !== "upload-item-missing") return lastResult;
    await sleep(120);
  }
  return {
    status: "upload-item-timeout",
    detail: lastResult?.status || "unknown",
  };
}

const OPEN_GEMINI_LOGIN_SCRIPT = `(() => new Promise((resolve) => {
  const visible = (element) => {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const controls = () => [...document.querySelectorAll(
    'a, button, [role="button"], [role="menuitem"]'
  )].filter(visible);
  const direct = controls().find((element) =>
    /^(登录|登录 Google|Sign in|Sign in with Google)$/i.test(
      String(element.innerText || element.getAttribute("aria-label") || "").trim()
    )
  );
  if (direct) {
    direct.click();
    resolve({ status: "direct-sign-in-clicked" });
    return;
  }
  const trigger = controls().find((element) =>
    /上传和工具|Upload and tools/i.test(
      [element.innerText, element.getAttribute("aria-label")]
        .filter(Boolean)
        .join(" ")
    )
  );
  if (!trigger) {
    resolve({ status: "no-sign-in-control" });
    return;
  }
  trigger.click();
  setTimeout(() => {
    const banner = document.querySelector('[data-test-id="sign-out-banner"]');
    if (banner) {
      banner.click();
      resolve({ status: "tool-sign-in-clicked" });
      return;
    }
    resolve({ status: "already-signed-in" });
  }, 700);
}))()`;

const DETECT_GEMINI_AUTH_SCRIPT = `(() => {
  const visible = (element) => {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  if (location.hostname.includes("accounts.google.")) return "signing-in";
  if (!location.hostname.includes("gemini.google.")) return "unknown";
  if (document.querySelector('[data-test-id="sign-out-banner"]')) {
    return "signed-out";
  }
  const signInControl = [...document.querySelectorAll(
    'a, button, [role="button"]'
  )].filter(visible).find((element) =>
    /^(登录|登录 Google|Sign in|Sign in with Google)$/i.test(
      String(element.innerText || element.getAttribute("aria-label") || "").trim()
    )
  );
  return signInControl ? "signed-out" : "signed-in";
})()`;

async function uploadFilesViaChooser(webContents, filePaths, timeoutMs = 15_000) {
  const paths = Array.isArray(filePaths)
    ? filePaths.filter((filePath) => typeof filePath === "string" && filePath)
    : [];
  if (!paths.length) return { ok: false, code: "NO_FILE_PATHS" };

  const debuggerApi = webContents.debugger;
  const attachedHere = !debuggerApi.isAttached();
  let timeout = null;
  let chooserListener = null;
  let fileInputObjectId = "";
  try {
    if (attachedHere) debuggerApi.attach("1.3");
    await debuggerApi.sendCommand("Page.enable", {
      enableFileChooserOpenedEvent: true,
    });
    await debuggerApi.sendCommand("Page.setInterceptFileChooserDialog", {
      enabled: true,
    });

    const chooserOpened = new Promise((resolve, reject) => {
      chooserListener = (_event, method, params) => {
        if (method === "Page.fileChooserOpened") resolve(params);
      };
      debuggerApi.on("message", chooserListener);
      timeout = setTimeout(
        () => reject(new Error("等待 Gemini 文件选择器超时")),
        timeoutMs
      );
      timeout.unref?.();
    });

    const clickPromise = clickGeminiUploadItem(webContents);
    const firstSignal = await Promise.race([
      clickPromise.then((result) => ({ type: "click", result })),
      chooserOpened.then((chooser) => ({ type: "chooser", chooser })),
    ]);
    let chooser = null;
    if (firstSignal.type === "click") {
      const clickResult = firstSignal.result;
      if (clickResult?.status !== "clicked") {
        return {
          ok: false,
          code:
            clickResult?.status === "needs-login"
              ? "NEEDS_LOGIN"
              : "FILE_CHOOSER_NOT_OPENED",
          detail: clickResult?.status || "unknown",
        };
      }
      chooser = await chooserOpened;
    } else {
      chooser = firstSignal.chooser;
      void clickPromise.catch(() => {});
    }

    if (!chooser?.backendNodeId) {
      return {
        ok: false,
        code: "FILE_CHOOSER_NODE_MISSING",
      };
    }
    const resolvedNode = await debuggerApi
      .sendCommand("DOM.resolveNode", {
        backendNodeId: chooser.backendNodeId,
      })
      .catch(() => null);
    fileInputObjectId = String(resolvedNode?.object?.objectId || "");
    await debuggerApi.sendCommand("DOM.setFileInputFiles", {
      files: paths,
      backendNodeId: chooser.backendNodeId,
    });
    // New Gemini builds may not notify the Angular uploader after CDP assigns
    // the files. Dispatch both events on the exact chooser input so the page
    // starts creating and uploading its attachment cards.
    if (fileInputObjectId) {
      await debuggerApi
        .sendCommand("Runtime.callFunctionOn", {
          objectId: fileInputObjectId,
          functionDeclaration: `function () {
            this.dispatchEvent(new Event("input", { bubbles: true }));
            this.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          }`,
          returnByValue: true,
        })
        .catch(() => null);
    }
    const selectedFiles = fileInputObjectId
      ? await debuggerApi
          .sendCommand("Runtime.callFunctionOn", {
            objectId: fileInputObjectId,
            functionDeclaration: `function () {
              return Array.from(this.files || []).map((file) => ({
                name: String(file.name || ""),
                size: Number(file.size || 0),
                type: String(file.type || "")
              }));
            }`,
            returnByValue: true,
          })
          .then((result) =>
            Array.isArray(result?.result?.value) ? result.result.value : []
          )
          .catch(() => [])
      : [];
    return {
      ok: true,
      mode: chooser.mode || "",
      selectedFileCount: selectedFiles.length,
      selectedFiles,
    };
  } catch (error) {
    return {
      ok: false,
      code: "FILE_CHOOSER_FAILED",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (chooserListener) debuggerApi.removeListener("message", chooserListener);
    if (debuggerApi.isAttached()) {
      if (fileInputObjectId) {
        await debuggerApi
          .sendCommand("Runtime.releaseObject", {
            objectId: fileInputObjectId,
          })
          .catch(() => {});
      }
      await debuggerApi
        .sendCommand("Page.setInterceptFileChooserDialog", { enabled: false })
        .catch(() => {});
    }
    if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
  }
}

module.exports = {
  CLICK_UPLOAD_CONTROL_SCRIPT,
  DETECT_GEMINI_AUTH_SCRIPT,
  OPEN_GEMINI_LOGIN_SCRIPT,
  uploadFilesViaChooser,
};
