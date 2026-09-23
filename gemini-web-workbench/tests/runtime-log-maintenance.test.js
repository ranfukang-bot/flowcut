const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LOG_FILES, cleanRuntimeLogs, startRuntimeLogMaintenance } = require('../src/runtime-log-maintenance');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-log-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, content = 'test log') => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return { root, write };
}

test('startup clears only the four runtime logs; tasks, journals, images and backups survive', t => {
  const { root, write } = fixture(t);
  LOG_FILES.forEach(name => write(name));
  const protectedNames = ['workbench-state.json', 'seedance/workbench-state.json',
    'seedance/submitted-tasks.jsonl', 'site-runtime/data/product.webp',
    'Partitions/account/Network/Cookies', 'site-runtime/logs/unknown.log', 'workbench-state.json.bak'];
  protectedNames.forEach(name => write(name, 'keep'));
  assert.equal(cleanRuntimeLogs(root, { clearAll: true }).length, 4);
  LOG_FILES.forEach(name => assert.equal(fs.statSync(path.join(root, name)).size, 0));
  protectedNames.forEach(name => assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), 'keep'));
});

test('size checks keep small logs and clear large ones without reading their content', t => {
  const { root, write } = fixture(t);
  write(LOG_FILES[0], '123456789'); write(LOG_FILES[1], 'small');
  const io = Object.create(fs);
  io.readFileSync = () => { throw new Error('must not read log content'); };
  assert.equal(cleanRuntimeLogs(root, { maxBytes: 8, io }).length, 1);
  assert.equal(fs.readFileSync(path.join(root, LOG_FILES[1]), 'utf8'), 'small');
});

test('an already open append stream continues writing after cleanup', async t => {
  const { root, write } = fixture(t);
  const file = write(LOG_FILES[1], 'old');
  const stream = fs.createWriteStream(file, { flags: 'a' });
  await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
  cleanRuntimeLogs(root, { clearAll: true });
  await new Promise((resolve, reject) => { stream.once('error', reject); stream.end('new', resolve); });
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});

test('missing files are harmless and locked logs do not stop cleanup of other logs', t => {
  const { root, write } = fixture(t);
  LOG_FILES.forEach(name => write(name));
  const io = Object.create(fs), errors = [];
  io.truncateSync = (file, length) => {
    if (file.endsWith('wrangler.log')) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    fs.truncateSync(file, length);
  };
  assert.equal(cleanRuntimeLogs(root, { clearAll: true, io, onError: e => errors.push(e) }).length, 3);
  assert.equal(errors.length, 1);
  assert.deepEqual(cleanRuntimeLogs(path.join(root, 'missing')), []);
});

test('junctions are not followed', t => {
  const { root, write } = fixture(t);
  const target = path.join(root, 'untouched');
  fs.mkdirSync(target); write('untouched/service.log', 'keep');
  fs.symlinkSync(target, path.join(root, 'publisher'), process.platform === 'win32' ? 'junction' : 'dir');
  cleanRuntimeLogs(root, { clearAll: true });
  assert.equal(fs.readFileSync(path.join(target, 'service.log'), 'utf8'), 'keep');
});

test('maintenance runs at startup, each minute and on day changes; stops on shutdown', t => {
  const { root, write } = fixture(t);
  const file = write(LOG_FILES[1]);
  let date = new Date(2026, 0, 1, 23, 59), tick, cancelled = false;
  const timer = { unref() {} };
  const stop = startRuntimeLogMaintenance(root, { now: () => date, maxBytes: 8,
    schedule: (fn, ms) => { assert.equal(ms, 60000); tick = fn; return timer; },
    cancel: id => { assert.equal(id, timer); cancelled = true; } });
  assert.equal(fs.statSync(file).size, 0);
  fs.appendFileSync(file, 'small'); tick(); assert.equal(fs.statSync(file).size, 5);
  fs.appendFileSync(file, 'long'); tick(); assert.equal(fs.statSync(file).size, 0);
  fs.appendFileSync(file, 'small'); date = new Date(2026, 0, 2); tick(); assert.equal(fs.statSync(file).size, 0);
  stop(); assert.equal(cancelled, true);
});
