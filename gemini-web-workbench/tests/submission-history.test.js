const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkbenchStore } = require('../../vendor/seedance-engine/store');
const { QueueEngine } = require('../../vendor/seedance-engine/queue-engine');
const { TikTokClient } = require('../../vendor/seedance-engine/tiktok-client');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-history-'));
  let now = 1_792_390_000_000;
  t.mock.method(Date, 'now', () => now);
  let store = new WorkbenchStore(dir);
  t.after(() => { store.flushPendingSave(); fs.rmSync(dir, { recursive: true, force: true }); });
  let rows = [], failure = null;
  const client = { submits: 0, reads: 0,
    async submitTask() { this.submits++; if (this.submits === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); return { data: { task_id: 'retry-id' } }; },
    async fetchHistory() { this.reads++; if (failure) throw failure; return { data: { draft_infos: rows }, historyComplete: true }; },
  };
  const makeEngine = () => new QueueEngine(store, { authenticated: true, authCheckedAt: now, state: () => ({}), client: () => client,
    accountName: () => 'test', effectiveModel: () => '2000012', markAuthenticated() {}, isQuotaError: () => false });
  let engine = makeEngine();
  const task = { id: 'local', status: 'queued', prompt: ' original prompt ', imageItems: [{ uploadedUrl: 'https://image.invalid/original', uploadedAccountId: store.accounts[0].id }],
    taskId: '', taskIds: [], attempts: 0, logs: [], accountId: store.accounts[0].id, createdAt: now };
  store.upsertTask(task);
  await engine.submitTask(task, store.accounts[0]);
  assert.equal(client.submits, 1); assert.equal(task.status, 'submit_unconfirmed');
  return {
    client, get task() { return store.getTask('local'); }, get engine() { return engine; }, get store() { return store; },
    elapsed(ms) { now = task.submitStartedAt + ms; }, rows(value) { rows = value; }, error(value) { failure = value; },
    row(id = 'found-id', overrides = {}) { return { taskId: id, createdAt: String(task.submitStartedAt / 1000), settings: JSON.stringify({ prompt: 'original prompt', images: [{ previewUrl: 'https://image.invalid/original' }] }), draftTaskStatus: 1, renderTaskStatus: 1, ...overrides }; },
    restart() { store.flushPendingSave(); store = new WorkbenchStore(dir); engine = makeEngine(); },
    async submit() { await engine.submitTask(store.getTask('local'), store.accounts[0]); },
  };
}

test('timeout, empty at 1 minute, found at 3 minutes: one submit, saved ID survives restart', async t => {
  const f = await fixture(t);
  f.elapsed(60_000); await f.engine.syncUnconfirmedSubmissions();
  assert.equal(f.task.historyRecovery.nextCheckAt, f.task.submitStartedAt + 180_000);
  f.elapsed(180_000); f.rows([f.row()]); await f.engine.syncUnconfirmedSubmissions();
  assert.equal(f.task.taskId, 'found-id'); assert.equal(f.task.status, 'generating'); assert.equal(f.client.submits, 1);
  f.restart(); assert.equal(f.task.status, 'generating'); assert.equal(f.task.historyRecovery.resolution, 'found'); assert.equal(f.client.submits, 1);
});

test('10 minute absence requires manual restore and a final empty check before one new submit', async t => {
  const f = await fixture(t); f.elapsed(600_000); await f.engine.syncUnconfirmedSubmissions();
  assert.equal(f.task.status, 'failed'); assert.equal(f.task.historyRecovery.resolution, 'missing');
  f.restart(); assert.equal(f.task.status, 'failed'); assert.equal(f.task.historyRecovery.resolution, 'missing');
  await f.submit(); assert.equal(f.client.submits, 1, 'absence alone never grants a resend');
  assert.equal((await f.engine.retryUnconfirmedTask(f.task)).action, 'resubmitting');
  const before = f.client.reads; await f.submit();
  assert.equal(f.client.reads, before + 1); assert.equal(f.client.submits, 2); assert.equal(f.task.taskId, 'retry-id');
});

test('last check finds accepted work: manual restore never submits again', async t => {
  const f = await fixture(t); f.elapsed(600_000); await f.engine.syncUnconfirmedSubmissions();
  await f.engine.retryUnconfirmedTask(f.task); f.rows([f.row()]); await f.submit();
  assert.equal(f.client.submits, 1); assert.equal(f.task.taskId, 'found-id');
});

for (const scenario of ['ambiguous', 'query-error', 'incomplete', 'missing-prompt', 'missing-time']) test(`${scenario} cannot authorize a resend`, async t => {
  const f = await fixture(t); f.elapsed(600_000);
  if (scenario === 'ambiguous') f.rows([f.row('one'), f.row('two')]);
  if (scenario === 'query-error') f.error(new Error('network unavailable'));
  if (scenario === 'incomplete') f.client.fetchHistory = async () => ({ historyComplete: false, data: { draft_infos: [] } });
  if (scenario === 'missing-prompt') f.rows([f.row('one', { settings: '{}' })]);
  if (scenario === 'missing-time') f.rows([f.row('one', { createdAt: null })]);
  await f.engine.syncUnconfirmedSubmissions(); await f.engine.retryUnconfirmedTask(f.task); await f.submit();
  assert.equal(f.task.status, 'submit_unconfirmed'); assert.equal(f.client.submits, 1);
  if (scenario === 'ambiguous') { assert.deepEqual(f.task.historyRecovery.candidateTaskIds, ['one', 'two']); assert.match(f.task.errorMessage, /one、two/); }
});

test('an identical earlier prompt outside the window or different image is not a match', async t => {
  const f = await fixture(t); f.elapsed(600_000);
  f.rows([f.row('old', { createdAt: String((f.task.submitStartedAt - 180_000) / 1000) }), f.row('other-image', { settings: JSON.stringify({ prompt: 'original prompt', images: [{ previewUrl: 'https://image.invalid/other' }] }) })]);
  await f.engine.syncUnconfirmedSubmissions(); assert.equal(f.task.historyRecovery.resolution, 'missing'); assert.equal(f.client.submits, 1);
});

test('ambiguous accepted candidates remain held if a later history page omits them', async t => {
  const f = await fixture(t); f.elapsed(180_000); f.rows([f.row('one'), f.row('two')]); await f.engine.syncUnconfirmedSubmissions();
  f.elapsed(600_000); f.rows([]); await f.engine.syncUnconfirmedSubmissions(); await f.engine.retryUnconfirmedTask(f.task);
  assert.equal(f.task.status, 'submit_unconfirmed'); assert.deepEqual(f.task.historyRecovery.candidateTaskIds, ['one', 'two']); assert.equal(f.client.submits, 1);
});

for (const found of [false, true]) test(`journal alone replays history ${found ? 'found' : 'missing'} when saving the state fails`, async t => {
  const f = await fixture(t); f.elapsed(600_000); if (found) f.rows([f.row()]);
  const save = f.store.save.bind(f.store); f.store.save = () => false;
  await f.engine.syncUnconfirmedSubmissions();
  f.store.save = save;
  // Reopen the on-disk pre-check task list, without flushing the modified object.
  const reopened = new WorkbenchStore(path.dirname(f.store.filePath));
  assert.equal(reopened.getTask('local').historyRecovery.resolution, found ? 'found' : 'missing');
  assert.equal(reopened.getTask('local').status, found ? 'generating' : 'failed'); assert.equal(f.client.submits, 1);
});

test('restart midway keeps the next check and never converts pending work into a retry', async t => {
  const f = await fixture(t); f.elapsed(60_000); await f.engine.syncUnconfirmedSubmissions();
  const next = f.task.historyRecovery.nextCheckAt; f.restart(); assert.equal(f.task.historyRecovery.nextCheckAt, next);
  f.elapsed(120_000); const reads = f.client.reads; await f.engine.syncUnconfirmedSubmissions(); assert.equal(f.client.reads, reads);
  f.elapsed(180_000); f.rows([f.row()]); await f.engine.syncUnconfirmedSubmissions(); assert.equal(f.client.submits, 1); assert.equal(f.task.taskId, 'found-id');
});

test('restore before one minute only returns a pending hint, without reading or sending', async t => {
  const f = await fixture(t); f.elapsed(30_000); await f.engine.retryUnconfirmedTask(f.task);
  assert.equal(f.client.reads, 0); assert.equal(f.client.submits, 1); assert.match(f.task.errorMessage, /正在核对.*不需要删除任务/);
});

test('failed final query preserves manual intent but cannot submit', async t => {
  const f = await fixture(t); f.elapsed(600_000); await f.engine.syncUnconfirmedSubmissions(); await f.engine.retryUnconfirmedTask(f.task);
  f.error(new Error('network')); await f.submit(); assert.equal(f.client.submits, 1);
  f.restart(); f.error(null); f.rows([f.row()]); await f.submit(); assert.equal(f.client.submits, 1); assert.equal(f.task.taskId, 'found-id');
});

test('legacy network failures are checked on startup, without resending', async t => {
  const f = await fixture(t); delete f.task.historyRecovery; f.task.status = 'failed'; f.task.errorMessage = '提交失败：network error'; f.store.save();
  f.restart(); f.engine.recoverInterruptedTasks(); assert.equal(f.task.status, 'submit_unconfirmed');
  f.elapsed(600_000); f.rows([f.row()]); await f.engine.syncUnconfirmedSubmissions(); assert.equal(f.client.submits, 1); assert.equal(f.task.taskId, 'found-id');
});

test('exhaustive client history scans later pages and reports incomplete scans', async () => {
  const client = new TikTokClient({}); let calls = 0;
  client.apiRequest = async () => { const page = calls++; return { data: { total: 51, draft_infos: page === 0 ? Array.from({ length: 50 }, (_, i) => ({ taskId: String(i) })) : [{ taskId: 'later' }] } }; };
  const result = await client.fetchHistory([], { exhaustive: true }); assert.equal(calls, 2); assert.equal(result.data.draft_infos.length, 51); assert.equal(result.historyComplete, true);
  calls = 0; client.apiRequest = async () => ({ data: { total: 60, draft_infos: Array.from({ length: 50 }, (_, i) => ({ taskId: String(i) })) } });
  assert.equal((await client.fetchHistory([], { exhaustive: true })).historyComplete, false);
});
