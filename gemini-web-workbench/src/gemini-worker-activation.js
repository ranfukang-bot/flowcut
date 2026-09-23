const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runWithActivatedGeminiWorker({
  workerWindow,
  ownerWindow,
  debugVisible = false,
  action,
}) {
  if (typeof action !== "function") {
    throw new TypeError("action must be a function");
  }
  if (!workerWindow || workerWindow.isDestroyed?.()) {
    return action();
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
      workerWindow.hide?.();
      if (originalBounds) workerWindow.setBounds?.(originalBounds, false);
      workerWindow.setOpacity?.(originalOpacity);
      workerWindow.setSkipTaskbar?.(false);
    } else if (!wasVisible && !debugVisible && !workerWindow.isDestroyed?.()) {
      workerWindow.hide?.();
    } else if (wasFocused && !workerWindow.isDestroyed?.()) {
      workerWindow.focus?.();
    }

    if (
      ownerWasFocused &&
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
};
