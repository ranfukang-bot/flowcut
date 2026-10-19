const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkbenchStore } = require('../../vendor/seedance-engine/store');
const { QueueEngine } = require('../../vendor/seedance-engine/queue-engine');
const { TikTokClient } = require('../../vendor/seedance-engine/tiktok-client');

function fixture(t, { target = false, recentCount = 80, failSecondPage = false } = {}) {
  const now = 1_792_390_600_000, start = now - 600_000;
  t.mock.method(Date, 'now', () => now);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-history-range-'));
  const store = new WorkbenchStore(directory);
  t.after(() => { store.flushPendingSave(); fs.rmSync(directory, { recursive: true, force: true }); });
  const account = store.accounts[0];
  const task = { id: 'uncertain', prompt: 'original prompt', accountId: account.id, taskId: '', taskIds: [], attempts: 0,
    imageItems: [{ uploadedUrl: 'https://image.invalid/original', uploadedAccountId: account.id }],
    submitStartedAt: start, submitIntents: ['original-intent'], status: 'submit_unconfirmed', logs: [] };
  const row = (id, time, prompt) => ({ taskId: id, createdAt: String(Math.floor(time / 1000)),
    settings: JSON.stringify({ prompt, images: [{ previewUrl: 'https://image.invalid/original' }] }), draftTaskStatus: 1, renderTaskStatus: 1 });
  const recent = Array.from({ length: recentCount }, (_, i) => row(`recent-${i}`, start - 60_000 + i * 400, `unrelated-${i}`))
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  if (target) recent[60].settings = row('unused', start, task.prompt).settings;
  const older = Array.from({ length: 3000 - recentCount }, (_, i) => row(`old-${i}`, start - 86400_000 - i * 60_000, task.prompt));
  const all = [...recent, ...older];
  const requests = [], client = new TikTokClient({});
  let submits = 0;
  client.submitTask = async () => { submits++; return { data: { task_id: 'manual-retry' } }; };
  client.apiRequest = async (_endpoint, { body }) => {
    requests.push({ ...body });
    if (failSecondPage && body.pageOffset === 50) throw new Error('network unavailable');
    const filtered = all.filter(r => Number(r.createdAt) >= Number(body.start_time));
    return { data: { total: filtered.length, draft_infos: filtered.slice(body.pageOffset, body.pageOffset + body.pageLimit) } };
  };
  const engine = new QueueEngine(store, { client: () => client, state: () => ({}), accountName: () => account.name,
    effectiveModel: () => '2000012', markAuthenticated() {} });
  store.upsertTask(task); engine.markSubmitUnconfirmed(task, '历史提交超时');
  return { task, engine, account, client, requests, start, now, expectedId: recent[60]?.taskId, all, submits: () => submits };
}

test('3000 yearly records, target on range page two: recover with two pages and zero submits', async t => {
  const f = fixture(t, { target: true });
  await f.engine.syncUnconfirmedSubmissions();
  assert.equal(f.requests.length, 2); assert.deepEqual(f.requests.map(r => r.pageOffset), [0, 50]);
  assert.ok(f.requests.every(r => r.start_time === String(Math.floor((f.start - 120_000) / 1000))));
  assert.equal(f.task.taskId, f.expectedId); assert.equal(f.task.status, 'generating'); assert.equal(f.submits(), 0);
});

test('3000 yearly records, no range match: conclude missing, allow manual restore and final recheck', async t => {
  const f = fixture(t);
  await f.engine.syncUnconfirmedSubmissions();
  assert.equal(f.requests.length, 2); assert.equal(f.task.status, 'failed');
  assert.equal(f.task.historyRecovery.resolution, 'missing'); assert.equal(f.submits(), 0);
  assert.equal((await f.engine.retryUnconfirmedTask(f.task)).action, 'resubmitting');
  assert.equal(f.submits(), 0, 'manual restore alone does not send');
  await f.engine.submitTask(f.task, f.account);
  assert.equal(f.requests.length, 4, 'the last check also scans the bounded range');
  assert.ok(f.requests.every(r => r.start_time === String(Math.floor((f.start - 120_000) / 1000))));
  assert.equal(f.submits(), 1); assert.equal(f.task.taskId, 'manual-retry');
});

test('more than 20 pages INSIDE the range remains uncertain with zero submits', async t => {
  const f = fixture(t, { recentCount: 1100, target: true });
  await f.engine.syncUnconfirmedSubmissions();
  assert.equal(f.requests.length, 20); assert.equal(f.task.status, 'submit_unconfirmed');
  assert.equal(f.task.historyRecovery.resolution, 'pending'); assert.equal(f.task.taskId, ''); assert.equal(f.submits(), 0);
});

test('range paging network failure never becomes a missing conclusion', async t => {
  const f = fixture(t, { failSecondPage: true });
  await f.engine.syncUnconfirmedSubmissions();
  assert.equal(f.requests.length, 2); assert.equal(f.task.status, 'submit_unconfirmed');
  assert.equal(f.task.historyRecovery.resolution, 'pending'); assert.ok(f.task.historyRecovery.nextCheckAt > f.now); assert.equal(f.submits(), 0);
});

test('existing Task-ID polling keeps its yearly request and stops at the known ID', async t => {
  const f = fixture(t);
  const id = f.all[2].taskId;
  const result = await f.client.fetchHistory([id]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].start_time, String(Math.floor(f.now / 1000) - 365 * 86400));
  assert.equal(f.requests[0].sorted, 2); assert.equal(f.requests[0].pageLimit, 50); assert.equal(f.requests[0].pageOffset, 0);
  assert.ok(result.data.draft_infos.some(r => r.taskId === id)); assert.equal('historyComplete' in result, false); assert.equal(f.submits(), 0);
});

test('invalid range bounds stop before querying or submitting', async t => {
  const f = fixture(t);
  for (const createdAfterMs of [NaN, Infinity, 0, -1, '1792390000000']) await assert.rejects(f.client.fetchHistory([], { exhaustive: true, createdAfterMs }), /创建时间下限无效/);
  assert.equal(f.requests.length, 0); assert.equal(f.submits(), 0);
});
