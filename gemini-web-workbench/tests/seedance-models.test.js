const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkbenchStore } = require('../../vendor/seedance-engine/store');
const { AccountManager } = require('../../vendor/seedance-engine/account-manager');
const { QueueEngine } = require('../../vendor/seedance-engine/queue-engine');
const { TikTokClient } = require('../../vendor/seedance-engine/tiktok-client');
const { FAST_MODEL, STANDARD_MODEL, isQuotaError } = require('../../vendor/seedance-engine/models');
const { configureLoginSession, networkFailureMessage } = require('../src/seedance-login-network');

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-model-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new WorkbenchStore(directory);
  const manager = new AccountManager({ store, sessionFactory: () => ({}) });
  manager.markAuthenticated('default');
  return { directory, store, manager, engine: new QueueEngine(store, manager) };
}
function queuedTask(store) {
  const task = { id: 'test', accountId: 'default', status: 'queued', attempts: 0, duration: 15, prompt: 'test prompt', imageItems: [{ name: 'product', uploadedUrl: 'https://example.test/image', uploadedAccountId: 'default' }] };
  store.upsertTask(task); return task;
}

test('Fast is default; per-account preference survives restart; Mini is rejected', t => {
  const { directory, store, manager } = setup(t);
  assert.equal(manager.effectiveModel(store.accounts[0]), FAST_MODEL);
  const second = manager.addAccount('Second');
  manager.setPreferredModel(second.id, STANDARD_MODEL);
  assert.equal(manager.effectiveModel(store.accounts[0]), FAST_MODEL);
  assert.equal(manager.effectiveModel(second), STANDARD_MODEL);
  assert.throws(() => manager.setPreferredModel(second.id, '2000009'), /禁止 Mini/);
  const restored = new WorkbenchStore(directory);
  assert.equal(restored.getAccount(second.id).preferredModel, STANDARD_MODEL);
});

test('both request model fields match selected model; Mini never sends a request', async () => {
  const client = new TikTokClient({}); const sent = [];
  client.apiRequest = async (_, options) => sent.push(options.body);
  for (const model of [FAST_MODEL, STANDARD_MODEL]) {
    await client.submitTask({ model, duration: 12, prompt: 'test', imageItems: [{ name: 'product', uploadedUrl: 'image' }] });
    assert.equal(sent.at(-1).model, model); assert.equal(JSON.parse(sent.at(-1).settings).aiModel, model);
  }
  await assert.rejects(client.submitTask({ model: '2000009' }), /禁止 Mini/);
  assert.equal(sent.length, 2);
});

test('Fast quota stops submission and persists; only explicit approval permits 2.0', async t => {
  const { directory, store, manager, engine } = setup(t); const task = queuedTask(store);
  const submitted = [];
  manager.client = () => ({ submitTask: async job => {
    submitted.push(job.model);
    if (job.model === FAST_MODEL) throw new Error('daily quota exceeded');
    return { data: { task_id: 'remote-standard' } };
  } });
  await engine.submitTask(task, store.accounts[0]);
  assert.equal(task.status, 'model_wait');
  assert.equal(manager.state().items[0].needsModelDecision, true);
  const restored = new WorkbenchStore(directory);
  const otherManager = new AccountManager({ store: restored, sessionFactory: () => ({}) });
  assert.equal(otherManager.effectiveModel(restored.accounts[0]), '');
  engine.resumeModelWaiters(); assert.equal(task.status, 'model_wait');
  await engine.submitTask(task, store.accounts[0]); assert.deepEqual(submitted, [FAST_MODEL]);
  manager.decideFastFallback('default', 'wait', manager.todayKey());
  engine.resumeModelWaiters(); assert.equal(task.status, 'model_wait');
  assert.equal(manager.state().items[0].needsModelDecision, false);
  manager.decideFastFallback('default', 'standard', manager.todayKey());
  engine.resumeModelWaiters(); assert.equal(task.status, 'queued');
  await engine.submitTask(task, store.accounts[0]);
  assert.deepEqual(submitted, [FAST_MODEL, STANDARD_MODEL]); assert.equal(task.status, 'generating');
  assert.equal(store.accounts[0].preferredModel, FAST_MODEL);
  manager.todayKey = () => '2099-01-01';
  assert.equal(manager.effectiveModel(store.accounts[0]), FAST_MODEL);
  assert.throws(() => manager.decideFastFallback('default', 'standard', '2020-01-01'), /状态已变化/);
});

test('one exhausted account does not block another; both models exhausted never submit', t => {
  const { store, manager } = setup(t); const second = manager.addAccount('Second');
  manager.markAuthenticated(second.id);
  manager.markModelExhausted('default', FAST_MODEL, 'daily quota');
  assert.equal(manager.isAvailable(store.accounts[0]), false);
  assert.equal(manager.isAvailable(second), true);
  manager.markModelExhausted('default', STANDARD_MODEL, 'daily quota');
  assert.throws(() => manager.decideFastFallback('default', 'standard', manager.todayKey()), /也已用完/);
});

test('rate limits and validation errors are not daily quota exhaustion', async t => {
  for (const message of ['too many requests', 'concurrent limit reached', 'maximum image size exceeded', 'HTTP 429', '并发已满']) assert.equal(isQuotaError(new Error(message)), false, message);
  for (const message of ['daily generation limit exceeded', 'quota exceeded', 'insufficient credits', '今日生成次数达到上限', '额度已用完']) assert.equal(isQuotaError(new Error(message)), true, message);
  const { store, manager, engine } = setup(t); const task = queuedTask(store);
  manager.client = () => ({ submitTask: async () => { throw new Error('HTTP 429: too many requests'); } });
  await engine.submitTask(task, store.accounts[0]);
  assert.equal(task.status, 'retry_wait'); assert.equal(manager.state().items[0].needsModelDecision, false);
});

test('login reconnect follows system proxy and preserves cookies; diagnostics omit sensitive URLs', async () => {
  const calls = [];
  const session = { getUserAgent: () => 'Chrome/145.0.0.0 Electron/43.2.0', setUserAgent: ua => calls.push(ua), setProxy: async config => calls.push(config), clearHostResolverCache: async () => calls.push('dns'), closeAllConnections: async () => calls.push('connections'), clearStorageData: () => { throw new Error('must preserve login'); } };
  await configureLoginSession(session, { reconnect: true });
  assert.match(calls[0], /Chrome\//); assert.doesNotMatch(calls[0], /Electron/);
  assert.deepEqual(calls.slice(1), [{ mode: 'system' }, 'dns', 'connections']);
  const message = networkFailureMessage({ url: 'https://verify-sg.byteoversea.com/captcha?token=SECRET', statusCode: 500 });
  assert.match(message, /HTTP 500/); assert.doesNotMatch(message, /SECRET|captcha/);
  assert.equal(networkFailureMessage({ url: 'https://ads.tiktok.com/page', statusCode: 200, error: 'net::OK' }), '');
  assert.match(networkFailureMessage({ url: 'https://ads.tiktok.com/page', resourceType: 'mainFrame', statusCode: 500, error: 'net::OK' }), /HTTP 500/);
});

test('真实登录校验恢复会清掉历史登录网络告警，真正的失败仍保留', async t => {
  const { manager } = setup(t);
  const runtime = manager.ensureRuntime('default');
  runtime.loginNetworkError = 'old login error';
  runtime.loginNetworkFailureKey = 'old key';
  manager.client = () => ({ checkAuth: async () => { throw new Error('network unavailable'); } });
  await manager.refreshAuth('default');
  assert.equal(runtime.loginNetworkError, 'old login error');
  assert.equal(runtime.authCheckFailed, true);
  manager.client = () => ({ checkAuth: async () => true, getMaxConcurrent: async () => 5 });
  await manager.refreshAuth('default');
  assert.equal(runtime.loginNetworkError, '');
  assert.equal(runtime.loginNetworkFailureKey, '');
  assert.equal(runtime.authCheckFailed, false);
  runtime.loginNetworkError = 'old';
  manager.markAuthenticated('default');
  assert.equal(runtime.loginNetworkError, '');
});
