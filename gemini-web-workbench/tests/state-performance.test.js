const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { WorkbenchLog } = require('../src/workbench-log');
const { WorkbenchStore } = require('../../vendor/seedance-engine/store');
const { QueueEngine } = require('../../vendor/seedance-engine/queue-engine');
const { createStateBroadcast } = require('../src/state-broadcast');
const { cleanRuntimeLogs } = require('../src/runtime-log-maintenance');
const { benchmark } = require('../../scripts/bench-state.cjs');

function directory(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-performance-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test('100 desktop logs never write credentials state; migrate old logs once and reload tail', async t => {
  const root = directory(t), app = { getPath: () => root }, first = new Store(app);
  const legacy = JSON.parse(fs.readFileSync(first.filePath)); legacy.logs = [{ message: 'legacy' }];
  fs.writeFileSync(first.filePath, JSON.stringify(legacy));
  const store = new Store(app), state = fs.readFileSync(store.filePath, 'utf8');
  for (let i = 0; i < 400; i++) store.log(`log ${i}`);
  assert.equal(fs.readFileSync(store.filePath, 'utf8'), state);
  assert.equal(store.state.logs.length, 300);
  assert.equal(JSON.parse(state).logs, undefined);
  await store.flushLogs();
  const again = new Store(app);
  assert.equal(again.state.logs.at(-1).message, 'log 399');
  await again.flushLogs();
  assert.equal(fs.readFileSync(store.logWriter.file, 'utf8').split('legacy').length - 1, 1);
});

test('100 Seedance logs coalesce; progress batches but changed status/Task ID persist immediately', async t => {
  const root = directory(t), store = new WorkbenchStore(root);
  t.after(() => store.flushPendingSave());
  const original = store.save.bind(store); let saves = 0;
  store.save = () => { saves++; return original(); };
  for (let i = 0; i < 100; i++) store.log(`entry ${i}`);
  assert.equal(saves, 0);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(saves, 1);
  assert.equal(JSON.parse(fs.readFileSync(store.filePath)).logs.length, 100);
  const task = { id: 't', status: 'generating', logs: [] };
  store.upsertTask(task);
  const engine = new QueueEngine(store, { state: () => ({}), authenticated: false }, () => {});
  for (let i = 0; i < 100; i++) engine.recordTask(task, `activity ${i}`);
  assert.equal(saves, 2);
  task.status = 'success'; task.taskId = 'accepted-id';
  engine.recordTask(task, 'success');
  assert.equal(saves, 3);
  assert.equal(JSON.parse(fs.readFileSync(store.filePath)).tasks[0].taskId, 'accepted-id');
  assert.equal(store.saveTimer, null);
  store.log('last entry'); store.flushPendingSave();
  assert.equal(JSON.parse(fs.readFileSync(store.filePath)).logs[0].message, 'last entry');
});

test('UI summary retains five logs and full detail remains available without changing source', t => {
  const store = new WorkbenchStore(directory(t));
  const task = { id: 'x', status: 'success', prompt: 'private long prompt', logs: Array.from({ length: 80 }, (_, n) => ({ message: String(n) })) };
  store.upsertTask(task);
  const summary = store.snapshot({}, { summary: true });
  assert.equal(summary.tasks[0].prompt, undefined); assert.equal(summary.tasks[0].logs.length, 5);
  summary.tasks[0].logs[0].message = 'edited';
  assert.equal(store.getTask('x').logs.length, 80); assert.equal(store.getTask('x').logs[0].message, '0');
  assert.equal(store.snapshot().tasks[0].prompt, task.prompt);
});

test('state broadcast coalesces changes and computes state only once per 250ms', () => {
  let tick, sent = 0, cancelled = false;
  const send = createStateBroadcast(() => sent++, { schedule: (fn, ms) => { assert.equal(ms, 250); tick = fn; return 1; }, cancel: () => { cancelled = true; } });
  for (let i = 0; i < 100; i++) send();
  assert.equal(sent, 0); tick(); assert.equal(sent, 1);
  send(); send.stop(); assert.equal(cancelled, true);
});

test('diagnostic logs rotate by size/day; maintenance only removes owned expired rotations', async t => {
  const root = directory(t); let date = new Date('2026-10-01T00:00:00Z');
  const log = new WorkbenchLog(root, { now: () => date, maxBytes: 100 });
  log.append({ message: 'a'.repeat(90) }); await log.flush();
  log.append({ message: 'b' }); await log.flush();
  date = new Date('2026-10-02T00:00:00Z'); log.append({ message: 'c' }); await log.flush();
  const dir = path.dirname(log.file), rotations = fs.readdirSync(dir).filter(n => n !== 'workbench.log');
  assert.equal(rotations.length, 2);
  const old = new Date('2026-09-01'); rotations.forEach(n => fs.utimesSync(path.join(dir, n), old, old));
  fs.writeFileSync(path.join(dir, 'unrelated.log'), 'keep');
  cleanRuntimeLogs(root);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['unrelated.log', 'workbench.log']);
});

test('500 task log call stays below 10ms', async () => {
  const result = await benchmark();
  assert.ok(result.seedanceLogMs < 10, JSON.stringify(result));
});
