// A renderer can disappear while executeJavaScript is still awaiting its result.
// Watch it from the main process so one dead page cannot occupy an account forever.
function watchGeminiJob({ contents, onFailure, timeoutMs, heartbeatTimeoutMs = 90_000,
  now = Date.now, schedule = setInterval, cancel = clearInterval }) {
  const startedAt = now();
  let lastHeartbeat = startedAt;
  let stopped = false;
  let timer;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancel(timer);
    contents.removeListener("render-process-gone", crashed);
    contents.removeListener("destroyed", crashed);
  };
  const fail = (message, code) => {
    if (stopped) return;
    stop();
    onFailure(Object.assign(new Error(message), { code }));
  };
  const crashed = () => fail("Gemini 页面已关闭或崩溃，任务将自动恢复", "GEMINI_PAGE_CRASHED");
  contents.on("render-process-gone", crashed);
  contents.on("destroyed", crashed);
  timer = schedule(() => {
    if (now() - startedAt >= timeoutMs) {
      fail("Gemini 任务超过最长等待时间，任务将自动恢复", "RESPONSE_TIMEOUT");
    } else if (now() - lastHeartbeat >= heartbeatTimeoutMs) {
      fail("Gemini 页面连续 90 秒没有响应，任务将自动恢复", "GEMINI_PAGE_UNRESPONSIVE");
    }
  }, 5_000);
  timer.unref?.();
  return { stop, touch() { lastHeartbeat = now(); } };
}

module.exports = { watchGeminiJob };
