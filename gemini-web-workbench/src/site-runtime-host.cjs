"use strict";

const runtime = JSON.parse(
  Buffer.from(process.env.FLOWCUT_RUNTIME_OPTIONS || "", "base64url").toString(
    "utf8",
  ),
);
const { unstable_dev: startWorker } = require(runtime.wranglerLibrary);

let worker = null;
let closing = false;

async function close() {
  if (closing) return;
  closing = true;
  await worker?.stop?.().catch(() => {});
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
process.once("disconnect", () => void close());

void (async () => {
  worker = await startWorker(runtime.workerScript, {
    config: runtime.config,
    ip: runtime.ip,
    port: runtime.port,
    persistTo: runtime.persistTo,
    vars: runtime.vars,
    experimental: {
      watch: false,
      disableExperimentalWarning: true,
    },
  });
  await worker.waitUntilExit();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
