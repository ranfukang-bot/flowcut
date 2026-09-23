const fs = require('node:fs');
const path = require('node:path');

// An explicit allowlist: never walk user data, sessions, images or task journals.
const LOG_FILES = [
  'site-runtime/logs/wrangler.log',
  'site-runtime/logs/site.out.log',
  'site-runtime/logs/site.err.log',
  'publisher/service.log',
];
const MAX_LOG_BYTES = 10 * 1024 * 1024;

function cleanRuntimeLogs(userData, { clearAll = false, maxBytes = MAX_LOG_BYTES,
  io = fs, onError = () => {} } = {}) {
  const cleared = [];
  for (const relative of LOG_FILES) {
    const file = path.join(userData, relative);
    try {
      // Do not follow links/junctions into another directory.
      const parts = relative.split('/');
      let current = userData;
      let linked = io.lstatSync(current).isSymbolicLink();
      for (const part of parts) {
        current = path.join(current, part);
        if (io.lstatSync(current).isSymbolicLink()) linked = true;
      }
      if (linked) continue;
      const stat = io.statSync(file);
      if (!stat.isFile() || !stat.size || (!clearAll && stat.size <= maxBytes)) continue;
      // Keep the same file: existing append-mode stdout/stderr streams can keep
      // writing on Windows. No rename of an open file, and no multi-GB reads.
      io.truncateSync(file, 0);
      cleared.push({ file: relative, bytes: stat.size });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        try { onError(error, relative); } catch { /* logging must not stop work */ }
      }
    }
  }
  return cleared;
}

function startRuntimeLogMaintenance(userData, { now = () => new Date(),
  schedule = setInterval, cancel = clearInterval, ...options } = {}) {
  const day = () => now().toDateString();
  let previousDay = day();
  cleanRuntimeLogs(userData, { ...options, clearAll: true });
  const timer = schedule(() => {
    const currentDay = day();
    cleanRuntimeLogs(userData, { ...options, clearAll: currentDay !== previousDay });
    previousDay = currentDay;
  }, 60_000);
  timer.unref?.();
  return () => cancel(timer);
}

module.exports = { LOG_FILES, MAX_LOG_BYTES, cleanRuntimeLogs, startRuntimeLogMaintenance };
