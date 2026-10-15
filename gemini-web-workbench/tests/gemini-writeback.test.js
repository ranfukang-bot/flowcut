const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Store } = require('../src/store');
const { BridgeEngine } = require('../src/bridge-engine');

function fixture(t, runJob = async () => 'generated prompt '.repeat(30)) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-writeback-'));
  t.after(() => {
    if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'flowcut-writeback-'))) throw Error('Unsafe test cleanup path');
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });
  const app = { getPath: () => directory }, store = new Store(app);
  const account = store.addAccount('写回测试账号'); store.updateAccount(account.id, { authenticated: true });
  const engine = new BridgeEngine({ store, getAuthenticatedAccounts: () => store.state.accounts, runJob, onChange() {} });
  engine.downloadFiles = async () => [];
  return { app, store, engine };
}

test('400 result fails only that task, flushes the next result and claims new work in the same tick', async t => {
  let runs = 0, claims = 0;
  const { store, engine } = fixture(t, async () => { runs++; return 'new task prompt '.repeat(30); });
  store.upsertPendingResult('bad', 'bad result '.repeat(40)); store.upsertPendingResult('good', 'good result '.repeat(40));
  const states = {}, calls = [];
  engine.request = async (url, init) => {
    if (url.startsWith('?')) { claims++; return { jobs: claims === 1 ? [{ id: 'new', imageUrls: [] }] : [] }; }
    const body = JSON.parse(init.body); calls.push(body);
    if (body.action === 'result' && body.taskId === 'bad') throw Object.assign(Error('server rejected format'), { status: 400 });
    if (body.action === 'result') states[body.taskId] = 'ready';
    if (body.action === 'error') states[body.taskId] = 'failed';
    return { ok: true };
  };
  await engine.tick();
  for (let i = 0; i < 20 && states.new !== 'ready'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(states.bad, 'failed'); assert.equal(states.good, 'ready'); assert.equal(states.new, 'ready');
  assert.equal(runs, 1); assert.equal(claims, 1); assert.deepEqual(store.state.pendingResults, []);
  assert.match(calls.find(row => row.action === 'error').error, /server rejected format/);
});

for (const status of [0, 408, 429, 503]) {
  test(`temporary writeback failure ${status} retains its result and limits repeated warnings`, async t => {
    const { store, engine } = fixture(t);
    store.upsertPendingResult('retry', 'saved prompt '.repeat(40));
    engine.report = async () => { throw Object.assign(Error(status ? 'service temporarily unavailable' : 'fetch failed'), { status }); };
    assert.equal(await engine.flushPendingResults(), false);
    assert.equal(await engine.flushPendingResults(), false);
    assert.equal(store.state.pendingResults.length, 1);
    assert.equal(store.state.logs.filter(row => row.level === 'warn').length, 1);
  });
}

test('failed error reporting moves to a durable separate outbox without blocking other results or claims', async t => {
  const { app, store, engine } = fixture(t);
  const key = store.state.settings.bridgeKey;
  store.upsertPendingResult('bad', 'rejected result '.repeat(30)); store.upsertPendingResult('good', 'valid result '.repeat(30));
  let unavailable = true, claims = 0;
  const calls = [], states = {};
  const request = async (url, init) => {
    if (url.startsWith('?')) { claims++; return { jobs: [] }; }
    const body = JSON.parse(init.body); calls.push(body);
    if (body.action === 'result' && body.taskId === 'bad') throw Object.assign(Error('invalid payload'), { status: 400 });
    if (body.action === 'error' && unavailable) throw TypeError('fetch failed');
    if (body.action === 'error') states[body.taskId] = 'failed';
    if (body.action === 'result') states[body.taskId] = 'ready';
    return { ok: true };
  };
  engine.request = request;
  await engine.tick();
  assert.equal(states.good, 'ready'); assert.equal(claims, 1);
  assert.equal(store.state.pendingResults.length, 0); assert.equal(store.state.pendingErrors.length, 1);
  const restored = new Store(app);
  assert.equal(restored.state.settings.bridgeKey, key); assert.equal(restored.state.pendingErrors[0].taskId, 'bad');
  assert.match(restored.state.pendingErrors[0].error, /invalid payload/);
  restored.state.pendingErrors[0].nextRetryAt = 0; restored.save(); unavailable = false;
  const restarted = new BridgeEngine({ store: restored, getAuthenticatedAccounts: () => restored.state.accounts, onChange() {} }); restarted.request = request;
  await restarted.tick();
  assert.equal(states.bad, 'failed'); assert.equal(claims, 2);
  assert.equal(new Store(app).state.pendingErrors.length, 0);
  assert.equal(calls.filter(row => row.taskId === 'bad' && row.action === 'result').length, 1);
});

test('failure transition is rolled back in memory if durable state cannot be saved', t => {
  const { app, store } = fixture(t);
  const original = store.upsertPendingResult('saved', 'keep this prompt '.repeat(30));
  const save = store.save; store.save = () => false;
  assert.throws(() => store.movePendingResultToError(original, 'rejected'), /原提示词仍保留/);
  store.save = save;
  assert.equal(store.state.pendingResults[0].taskId, 'saved'); assert.equal(store.state.pendingErrors.length, 0);
  assert.equal(new Store(app).state.pendingResults[0].taskId, 'saved');
});
