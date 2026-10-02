const test = require('node:test');
const assert = require('node:assert/strict');
const { BridgeEngine, ACCOUNT_COOLDOWN_MS, ACCOUNT_FAILURE_BACKOFF_MS, isAccountLimitedError } = require('../src/bridge-engine');

for (const code of ['GEM_SETUP_RETRYABLE', 'GEMINI_REFUSED_RESPONSE', 'RESPONSE_STALLED', 'UPLOAD_NOT_CONFIRMED', 'INCOMPLETE_RESPONSE', 'GEMINI_PAGE_ERROR']) {
  test(`${code}: waiting task does not block later work on the same account`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
    const account = { id: 'a', name: 'a', authenticated: true };
    const runs = [], reports = [], executions = [];
    const store = { state: { settings: { queueRunning: true, bridgeKey: 'fixture' }, accounts: [account], pendingResults: [] }, log() {} };
    const engine = new BridgeEngine({ store, getAuthenticatedAccounts: () => [account], onChange() {}, runJob: async (_a, job) => {
      runs.push(job.id);
      throw Object.assign(new Error('fixture ordinary failure'), { code });
    } });
    const execute = engine.execute.bind(engine);
    engine.execute = (...args) => { const p = execute(...args); executions.push(p); return p; };
    engine.downloadFiles = async () => [];
    engine.report = async (taskId, action, extra) => { reports.push({ taskId, action, ...extra }); return { deferred: true, failures: 1 }; };
    engine.heartbeat = async () => {};
    let claimed = 0;
    engine.request = async () => ({ jobs: claimed < 2 ? [{ id: `task-${++claimed}`, accountId: 'a', kind: 'standard', imageUrls: [] }] : [] });
    await engine.tick();
    await executions[0];
    assert.deepEqual(runs, ['task-1']);
    assert.equal(engine.active.size, 0);
    assert.equal(engine.cooldownUntil.get('a'), Date.now() + ACCOUNT_COOLDOWN_MS);
    t.mock.timers.tick(ACCOUNT_COOLDOWN_MS); // before the failed task's 30-second retry
    await engine.tick();
    await executions[1];
    assert.deepEqual(runs, ['task-1', 'task-2']);
    assert.ok(reports.every(r => r.action === 'defer' && r.accountLimited === false));
    assert.equal(engine.failureStreak.size, 0, 'ordinary failures never escalate account cooldown');
    store.state.settings.queueRunning = false;
  });
}

test('genuine rate limits cool only the affected account; a second account works', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const accounts = ['a', 'b'].map(id => ({ id, name: id, authenticated: true }));
  const reports = [];
  const store = { state: { settings: { queueRunning: true, bridgeKey: 'fixture' }, accounts, pendingResults: [] }, log() {} };
  const engine = new BridgeEngine({ store, getAuthenticatedAccounts: () => accounts, getMaxConcurrent: () => 2, onChange() {}, runJob: async () => {
    throw Object.assign(new Error('Gemini 页面返回错误：too many requests'), { code: 'GEMINI_PAGE_ERROR' });
  } });
  engine.downloadFiles = async () => [];
  engine.report = async (_id, _action, extra) => { reports.push(extra); return { deferred: true }; };
  engine.active.set('a', { taskId: 'first' });
  await engine.execute(accounts[0], { id: 'first', imageUrls: [] });
  assert.equal(reports[0].accountLimited, true);
  assert.equal(engine.cooldownUntil.get('a'), Date.now() + ACCOUNT_FAILURE_BACKOFF_MS[0]);
  engine.heartbeat = async () => {};
  engine.request = async path => {
    assert.equal(new URLSearchParams(path.slice(1)).get('accountIds'), 'b');
    return { jobs: [] };
  };
  await engine.tick();
  store.state.settings.queueRunning = false;
});

test('limit detection does not mistake a generated refusal for account exhaustion', () => {
  assert.equal(isAccountLimitedError({ code: 'GEMINI_REFUSED_RESPONSE', message: 'I have a daily usage limit' }), false);
  assert.equal(isAccountLimitedError({ code: 'GEMINI_PAGE_ERROR', message: 'Something went wrong' }), false);
  assert.equal(isAccountLimitedError({ code: 'GEMINI_PAGE_ERROR', message: '已达到今日使用上限' }), true);
  assert.equal(isAccountLimitedError({ status: 429 }), true);
});
