const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// GUI processes can outlive the terminal pipe that launched them. Keep test
// results on disk instead of writing to stdout/stderr and triggering Electron's
// unhandled EPIPE dialog after the parent disconnects.
const resultPath = process.env.FLOWCUT_ELECTRON_TEST_RESULT ||
  path.join(os.tmpdir(), `flowcut-electron-test-${process.pid}.jsonl`);
fs.mkdirSync(path.dirname(resultPath), { recursive: true });
module.exports = result => fs.appendFileSync(resultPath, JSON.stringify(result) + '\n', 'utf8');
