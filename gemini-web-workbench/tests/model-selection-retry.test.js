const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { BridgeEngine } = require('../src/bridge-engine');
const { callModelPage, modelSucceeded, modelWatchdogError } = require('../src/model-selection-errors');

async function fixture(t, outcomes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-model-retry-'));
  const app = { getPath: () => directory }, store = new Store(app);
  t.after(async () => { await store.flushLogs(); if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'flowcut-model-retry-'))) throw Error('Unsafe cleanup'); fs.rmSync(directory, { recursive: true, force: true }); });
  const account = store.addAccount('临时故障测试'), reports = [];
  let uploads = 0, sends = 0, index = 0;
  const window = { webContents: { executeJavaScript: script => vm.runInNewContext(script, {
    __flowcutModelPicker: { ensure: async () => { const error = outcomes[index++]; if (error) throw error; return { model: '3.8 Flash' }; } },
  }) } };
  const engine = new BridgeEngine({ store, getAuthenticatedAccounts: () => [account], onChange() {}, runJob: async () => {
    await callModelPage(window, '', 'ensure');
    modelSucceeded(store, account);
    uploads++; sends++;
    return 'successful fixture prompt '.repeat(20);
  } });
  engine.tick = async () => {};
  engine.downloadFiles = async () => [];
  engine.report = async (taskId, action, extra) => { reports.push({ taskId, action, ...extra }); return { ok: true, deferred: true, failures: 1 }; };
  const execute = async () => { const id = `task-${index}`; engine.active.set(account.id, { taskId: id }); await engine.execute(account, { id, imageUrls: [] }); };
  return { app, store, account, reports, execute, actions: () => ({ uploads, sends }) };
}
const timeout = () => Object.assign(Error('模型菜单响应超时'), { code: 'MODEL_SELECTION_RETRYABLE' });

test('one model timeout defers without holding the account or uploading/sending', async t => {
  const { account, execute, reports, actions } = await fixture(t, [timeout()]);
  await execute();
  assert.deepEqual(reports.map(row => row.action), ['defer']);
  assert.equal(account.modelSelectionHold, undefined); assert.equal(account.modelSelectionFailures.count, 1);
  assert.deepEqual(actions(), { uploads: 0, sends: 0 });
});

test('the first deferred model error keeps its button diagnostics in the log', async t => {
  const diagnostic = '模型按钮等待 10 秒后仍未出现。\n可见按钮诊断：data-test-id="future-picker" aria-label="模型" aria-haspopup="menu" class="one two three" 文字="Flash"';
  const { store, execute, reports, actions } = await fixture(t, [Object.assign(Error(diagnostic), { code: 'MODEL_SELECTION_RETRYABLE' })]);
  await execute();
  assert.ok(store.state.logs.some(entry => entry.message.includes(diagnostic)));
  assert.equal(reports[0].error, diagnostic); assert.deepEqual(actions(), { uploads: 0, sends: 0 });
});
test('three consecutive model timeouts hold the account; counter is persisted', async t => {
  const { app, account, execute, reports, actions } = await fixture(t, [timeout(), timeout(), timeout()]);
  await execute(); await execute();
  const reopened = new Store(app);
  assert.equal(reopened.state.accounts[0].modelSelectionFailures.count, 2);
  await reopened.flushLogs();
  await execute();
  assert.deepEqual(reports.map(row => row.action), ['defer', 'defer', 'release']);
  assert.equal(account.modelSelectionFailures.count, 3); assert.ok(account.modelSelectionHold);
  assert.equal(reports.at(-1).errorCode, 'MODEL_SELECTION_FAILED');
  assert.deepEqual(actions(), { uploads: 0, sends: 0 });
});
test('one missing model immediately holds and never uploads or sends', async t => {
  const { account, execute, reports, actions } = await fixture(t, [Object.assign(Error('找不到目标模型 3.8 Flash'), { code: 'MODEL_SELECTION_FAILED' })]);
  await execute();
  assert.deepEqual(reports.map(row => row.action), ['release']); assert.ok(account.modelSelectionHold);
  assert.deepEqual(actions(), { uploads: 0, sends: 0 });
});
test('a successful model check resets failures even if the later upload has not run', async t => {
  const { store, account, execute, actions } = await fixture(t, [timeout(), timeout(), timeout()]);
  await execute(); await execute(); modelSucceeded(store, account);
  assert.equal(account.modelSelectionFailures, null);
  await execute(); assert.equal(account.modelSelectionFailures.count, 1); assert.equal(account.modelSelectionHold, undefined);
  assert.deepEqual(actions(), { uploads: 0, sends: 0 });
});
test('changing the global setting starts a separate failure count', async t => {
  const { store, account, execute, actions } = await fixture(t, [timeout(), timeout(), timeout()]);
  await execute(); await execute(); store.state.settings.geminiModel = { mode: 'exact', name: '3.1 Pro' };
  await execute(); assert.equal(account.modelSelectionFailures.count, 1); assert.equal(account.modelSelectionHold, undefined);
  assert.deepEqual(actions(), { uploads: 0, sends: 0 });
});
test('a successful job resets the next model timeout to the first failure', async t => {
  const { account, execute, reports, actions } = await fixture(t, [timeout(), null, timeout()]);
  await execute(); await execute(); await execute();
  assert.equal(account.modelSelectionFailures.count, 1); assert.equal(account.modelSelectionHold, undefined);
  assert.deepEqual(reports.map(row => row.action), ['defer', 'result', 'defer']);
  assert.deepEqual(actions(), { uploads: 1, sends: 1 }, 'only the successful check reaches the send boundary');
});
test('script exceptions, native navigation errors, destroyed windows and hung scripts are retryable', async () => {
  const contexts = [
    { webContents: { executeJavaScript: script => vm.runInNewContext(script, { __flowcutModelPicker: { ensure() { throw Error('page script exception'); } } }) } },
    { webContents: { executeJavaScript: async () => { throw Error('navigation interrupted'); } } },
    { webContents: { executeJavaScript: () => { throw Error('Object has been destroyed'); } } },
    { webContents: { executeJavaScript: () => new Promise(() => {}) } },
  ];
  for (const window of contexts) await assert.rejects(callModelPage(window, '', 'ensure', [], { timeoutMs: 10 }), { code: 'MODEL_SELECTION_RETRYABLE' });
});
test('a crash/unresponsive watchdog during selection is counted as a model temporary failure', () => {
  const original = Object.assign(Error('renderer crashed'), { code: 'GEMINI_PAGE_CRASHED' });
  const converted = modelWatchdogError(original, { modelSelectionActive: true, modelSettings: { mode: 'auto' } });
  assert.equal(converted.code, 'MODEL_SELECTION_RETRYABLE'); assert.ok(converted.modelSettingsKey);
  assert.equal(modelWatchdogError(original, { modelSelectionActive: false }), original);
});

test('native model calls allow the readiness wait and the subsequent catalog session to finish', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [method, delay] of [['inspect', 10_000], ['readCatalog', 18_000]]) {
    const window = { webContents: { executeJavaScript: () => new Promise(resolve => setTimeout(() => resolve({ ok: true, value: { ready: true } }), delay)) } };
    const result = callModelPage(window, '', method);
    t.mock.timers.tick(delay);
    assert.deepEqual(await result, { ready: true });
  }
});
