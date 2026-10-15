/* eslint-disable @typescript-eslint/no-require-imports -- reproducible CommonJS benchmark shared with desktop Node tests */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { WorkbenchStore } = require('../vendor/seedance-engine/store');
const { Store } = require('../gemini-web-workbench/src/store');

async function benchmark(count = 500) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-state-bench-'));
  let seedance, main;
  try {
    seedance = new WorkbenchStore(path.join(root, 'seedance'));
    seedance.data.tasks = Array.from({ length: count }, (_, index) => ({
      id: `fixture-${index}`, status: 'success', order: index, prompt: 'fixture prompt '.repeat(40),
      logs: Array.from({ length: 80 }, (_, n) => ({ time: n, level: 'info', message: 'synthetic log '.repeat(8) })),
    }));
    seedance.save();
    const bytes = fs.statSync(seedance.filePath).size;
    const start = performance.now();
    seedance.log('benchmark single log');
    const seedanceLogMs = performance.now() - start;
    main = new Store({ getPath: () => path.join(root, 'main') });
    const mainStart = performance.now();
    main.log('benchmark single log');
    const mainLogMs = performance.now() - mainStart;
    return { tasks: count, bytes, seedanceLogMs, mainLogMs };
  } finally {
    seedance?.flushPendingSave?.();
    await main?.flushLogs?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (require.main === module) benchmark(Number(process.argv[2]) || 500).then(value => console.log(JSON.stringify(value, null, 2)));
module.exports = { benchmark };
