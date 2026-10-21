const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { GeminiLoginFlow } = require('../src/gemini-login-flow');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-login-flow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store({ getPath: () => dir }), original = store.addAccount('Original');
  store.updateAccount(original.id, { authenticated: true, enabled: false, gemBindings: { one: 'unchanged' } });
  const calls = [], jars = new Map(), flow = new GeminiLoginFlow({ root: dir, store,
    sessionFactory: partition => { calls.push(['session', partition]); const jar = {}; jars.set(partition, jar); return jar; },
    clearSession: async partition => { calls.push(['clear', partition]); jars.delete(partition); },
    verify: async () => ({ authenticated: options.valid !== false }),
    canReplace: () => options.available !== false,
    confirmReplace: async () => { calls.push(['confirm']); return options.confirm !== false; },
    browserFinder: async () => options.missing ? null : { kind: 'firefox', executable: 'test-firefox' },
    browserFactory: () => ({ start: async () => { calls.push(['open']); }, cancel: async () => { calls.push(['cleanup']); },
      complete: async ({ userConfirmed }) => { assert.equal(userConfirmed, true); calls.push(['import', 'cleanup']); if (options.importFails) throw Object.assign(Error('secret fixture cookie'), { code: options.importCode }); return { importedCount: 2, skippedPartitioned: options.skippedPartitioned || 0 }; } }),
  });
  return { store, original, calls, jars, flow };
}
test('new account is committed only after explicit confirmation and validation, other accounts remain byte-for-byte equal', async t => {
  const { store, original, calls, flow } = fixture(t), before = structuredClone(original);
  await flow.prepare({ name: 'New account' }); assert.equal(store.state.accounts.length, 1); assert.equal(calls.length, 0);
  await flow.open(); assert.equal(flow.state().phase, 'waiting-for-user'); assert.equal(store.state.accounts.length, 1);
  const result = await flow.finish();
  assert.equal(store.state.accounts.length, 2); assert.equal(store.state.accounts.find(a => a.id === result.accountId).authenticated, true);
  assert.deepEqual(store.state.accounts[0], before); assert.equal(flow.state(), null);
});
test('relogin validates a fresh partition and switches only that account while preserving settings and Gem bindings', async t => {
  const { store, original, calls, flow } = fixture(t), priorPartition = original.partition, settings = structuredClone(store.state.settings);
  await flow.prepare({ accountId: original.id }); assert.equal(flow.heldAccountId, original.id);
  await flow.open(); await flow.finish();
  const now = store.state.accounts[0];
  assert.equal(now.id, original.id); assert.notEqual(now.partition, priorPartition); assert.equal(now.enabled, false);
  assert.deepEqual(now.gemBindings, { one: 'unchanged' }); assert.deepEqual(store.state.settings, settings);
  assert.equal(calls.filter(c => c[0] === 'confirm').length, 1);
  assert.ok(calls.filter(c => ['session', 'clear'].includes(c[0])).every(c => c[1] !== priorPartition));
});

test('successful login returns the skipped partitioned count without Cookie data', async t => {
  const { flow } = fixture(t, { skippedPartitioned: 3 });
  await flow.prepare({ name: 'New' }); await flow.open();
  const result = await flow.finish();
  assert.deepEqual(result, { accountId: result.accountId, cancelled: false, skippedPartitioned: 3 });
});
for (const options of [{ valid: false }, { importFails: true }]) test('failed relogin keeps existing account and partition unchanged and cleans only staging', async t => {
  const { store, original, flow, calls } = fixture(t, options), before = structuredClone(original);
  await flow.prepare({ accountId: original.id }); await flow.open(); await assert.rejects(flow.finish());
  assert.deepEqual(store.state.accounts, [before]); assert.equal(flow.state().phase, 'failed');
  assert.ok(calls.some(c => c[0] === 'cleanup')); assert.ok(calls.some(c => c[0] === 'clear' && c[1] !== before.partition));
});
test('declining overwrite confirmation cleans Firefox without reading or altering either session', async t => {
  const { store, original, flow, calls } = fixture(t, { confirm: false }), before = structuredClone(original);
  await flow.prepare({ accountId: original.id }); await flow.open(); assert.equal((await flow.finish()).cancelled, true);
  assert.equal(calls.some(c => c[0] === 'session' || c[0] === 'import'), false); assert.ok(calls.some(c => c[0] === 'cleanup'));
  assert.deepEqual(store.state.accounts, [before]); assert.equal(flow.state(), null);
});
test('missing Firefox provides the official installation link and never starts another browser', async t => {
  const { flow, calls } = fixture(t, { missing: true }); await flow.prepare({ name: 'New' }); await flow.open();
  assert.equal(flow.state().phase, 'missing'); assert.equal(flow.state().downloadUrl, 'https://www.mozilla.org/firefox/new/'); assert.equal(calls.length, 0);
  await flow.cancel(); assert.equal(flow.state(), null);
});
test('cancelling a waiting login cleans its browser and does not add an account', async t => {
  const { flow, store, calls } = fixture(t); await flow.prepare({ name: 'New' }); await flow.open(); await flow.cancel();
  assert.equal(store.state.accounts.length, 1); assert.deepEqual(calls, [['open'], ['cleanup']]);
});
test('active account cannot begin reauthentication', async t => {
  const { flow, original, calls } = fixture(t, { available: false });
  await assert.rejects(flow.prepare({ accountId: original.id }), { code: 'ACCOUNT_BUSY' }); assert.equal(calls.length, 0);
});
test('failed config save restores account references and default without modifying original login data', t => {
  const { store, original } = fixture(t), before = structuredClone(store.state);
  store.save = () => false;
  assert.throws(() => store.commitGeminiLogin({ accountId: original.id, candidate: { id: 'new', partition: 'persist:staging' }, checkedAt: 'now' }), { code: 'LOGIN_SAVE_FAILED' });
  assert.deepEqual(store.state, before);
});

test('failed import reports a safe failure category without exposing native error or Cookie content', async t => {
  for (const code of ['BROWSER_PROCESS_QUERY_FAILED', 'COOKIE_READ_FAILED', 'LOGIN_NOT_FINISHED']) {
    const { flow, store, original } = fixture(t, { importFails: true, importCode: code }), before = structuredClone(original);
    await flow.prepare({ name: 'New account' });await flow.open();await assert.rejects(flow.finish(), { code });
    assert.equal(flow.state().errorCode, code);assert.ok(flow.state().error.includes(code));
    assert.equal(flow.state().error.includes('secret'), false);assert.deepEqual(store.state.accounts, [before]);
  }
});
