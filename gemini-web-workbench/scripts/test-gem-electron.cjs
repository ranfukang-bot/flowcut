const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const desktop = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-gem-regression-'));

(async () => {
  const cases = process.argv.includes('--review-ui') ? [['review-delete-ui-electron', 1]] : process.argv.includes('--quota-ui') ? [['seedance-quota-ui-electron', 1]] : [['gem-editor-electron', 4], ['gem-recovery-electron', 3]];
  for (const [name, expectedResults] of cases) {
    const result = path.join(output, `${name}.jsonl`);
    const child = spawn(require('electron'), [
      path.join(desktop, 'tests', name + '.cjs'), '--user-data-dir=' + path.join(output, name + '-profile'),
    ], { cwd: desktop, windowsHide: true, env: { ...process.env, FLOWCUT_ELECTRON_TEST_RESULT: result }, stdio: ['ignore', 'pipe', 'pipe'] });
    // Simulate the launcher disappearing while the GUI process still runs.
    child.stdout.destroy(); child.stderr.destroy();
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error(name + ' timed out')); }, 30000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(code, 0, name + ' exit code');
    const rows = fs.readFileSync(result, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, expectedResults);
    assert.ok(rows.every(row => row.pass), JSON.stringify(rows));
    console.log(JSON.stringify({ name, closedOutputPipes: true, results: rows }));
  }
  console.log('Test evidence: ' + output);
})().catch(error => { console.error(error); process.exitCode = 1; });
