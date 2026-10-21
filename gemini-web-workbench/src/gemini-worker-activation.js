const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function restoreGeminiWorkerPlacement(window) {
  const original = window.flowcutActivationRestore;
  if (!original) return;
  if (original.bounds) window.setBounds?.(original.bounds, false);
  window.setOpacity?.(original.opacity);
  window.setSkipTaskbar?.(false);
  delete window.flowcutActivationRestore;
}

let uploadTurn = Promise.resolve();
// Native upload uses focus/input events: two account windows must not steal
// focus from one another. Only serialize this short step, not text generation.
function runWithActivatedGeminiWorker(options) {
  const result = uploadTurn.then(() => activateGeminiWorker(options));
  uploadTurn = result.catch(() => {});
  return result;
}

async function activateGeminiWorker({
  workerWindow,
  ownerWindow,
  debugVisible = false,
  action,
}) {
  if (typeof action !== "function") {
    throw new TypeError("action must be a function");
  }
  if (!workerWindow || workerWindow.isDestroyed?.()) {
    throw new Error('Gemini 上传窗口已关闭，请重试');
  }

  const wasVisible = Boolean(workerWindow.isVisible?.());
  const wasFocused = Boolean(workerWindow.isFocused?.());
  const ownerWasFocused = Boolean(
    ownerWindow && !ownerWindow.isDestroyed?.() && ownerWindow.isFocused?.()
  );
  const originalBounds = workerWindow.getBounds?.();
  const originalOpacity = workerWindow.getOpacity?.() ?? 1;
  const concealWorker = !debugVisible && !wasVisible;

  try {
    if (concealWorker) {
      workerWindow.flowcutActivationRestore = { bounds: originalBounds, opacity: originalOpacity };
      workerWindow.setSkipTaskbar?.(true);
      workerWindow.setOpacity?.(0);
      if (originalBounds) {
        workerWindow.setBounds?.(
          {
            ...originalBounds,
            x: -32000,
            y: -32000,
          },
          false
        );
      }
    }

    workerWindow.setFocusable?.(true);
    workerWindow.show?.();
    workerWindow.setAlwaysOnTop?.(true, "screen-saver");
    workerWindow.focus?.();
    workerWindow.moveTop?.();
    workerWindow.webContents?.focus?.();
    await sleep(450);
    workerWindow.setAlwaysOnTop?.(false);

    return await action();
  } finally {
    workerWindow.setAlwaysOnTop?.(false);
    if (concealWorker && !workerWindow.isDestroyed?.()) {
      restoreGeminiWorkerPlacement(workerWindow);
      if (workerWindow.flowcutUserVisible) workerWindow.show?.();
      else workerWindow.hide?.();
    } else if (!wasVisible && !debugVisible && !workerWindow.flowcutUserVisible && !workerWindow.isDestroyed?.()) {
      workerWindow.hide?.();
    } else if (wasFocused && !workerWindow.isDestroyed?.()) {
      workerWindow.focus?.();
    }

    if (
      ownerWasFocused &&
      !workerWindow.flowcutUserVisible &&
      ownerWindow &&
      !ownerWindow.isDestroyed?.()
    ) {
      ownerWindow.show?.();
      ownerWindow.focus?.();
      ownerWindow.moveTop?.();
    }
  }
}

module.exports = {
  runWithActivatedGeminiWorker,
  restoreGeminiWorkerPlacement,
};
