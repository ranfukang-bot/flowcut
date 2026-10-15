const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { BridgeEngine } = require('../src/bridge-engine');
const { WorkbenchStore } = require('../../vendor/seedance-engine/store');
const { AccountManager } = require('../../vendor/seedance-engine/account-manager');
const { QueueEngine } = require('../../vendor/seedance-engine/queue-engine');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-accounts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Gemini pause and rename survive restart without losing login, partition or saved Gems', t => {
  const dir = directory(t), app = { getPath: () => dir }, store = new Store(app);
  const a = store.addAccount('A'), b = store.addAccount('B');
  store.updateAccount(a.id, { authenticated: true, gemBindings: { template: { status: 'ready', url: 'saved' } } });
  const partition = a.partition;
  store.renameAccount(a.id, '  主账号改名  ');
  store.setAccountEnabled(a.id, false);
  const restored = new Store(app), account = restored.state.accounts.find(x => x.id === a.id);
  assert.equal(account.name, '主账号改名');
  assert.equal(account.enabled, false);
  assert.equal(account.authenticated, true);
  assert.equal(account.partition, partition);
  assert.equal(account.gemBindings.template.url, 'saved');
  assert.equal(restored.state.defaultAccountId, b.id);
  assert.throws(() => restored.renameAccount(a.id, ' '), /不能为空/);
  restored.setAccountEnabled(b.id, false);
  assert.equal(restored.state.defaultAccountId, '');
  restored.setAccountEnabled(a.id, true);
  assert.equal(restored.state.defaultAccountId, a.id);
});

test('Gemini paused accounts get no new claims while their current jobs remain active', async () => {
  const accounts = [{ id: 'a', enabled: false, authenticated: true }, { id: 'b', authenticated: true }];
  const engine = new BridgeEngine({ store: { state: { accounts, settings: { bridgeKey: 'test', queueRunning: true } } },
    getAuthenticatedAccounts: () => accounts, getMaxConcurrent: () => 2, onChange() {} });
  engine.active.set('a', { taskId: 'running', accountId: 'a' });
  let claims = 0;
  engine.heartbeat = async () => {};
  engine.request = async route => { claims++; assert.equal(new URLSearchParams(route.slice(1)).get('accountIds'), 'b'); return { jobs: [] }; };
  await engine.tick();
  assert.equal(claims, 1);
  assert.equal(engine.active.get('a').taskId, 'running');
  accounts[1].enabled = false;
  await engine.tick();
  assert.equal(claims, 1, 'all paused keeps jobs queued');
});

test('Gemini pause during an in-flight claim releases the job before uploading', async () => {
  const account = { id: 'a', authenticated: true }, releases = [];
  const engine = new BridgeEngine({ store: { state: { accounts: [account], settings: { bridgeKey: 'test', queueRunning: true } } },
    getAuthenticatedAccounts: () => [account], onChange() {} });
  engine.heartbeat = async () => {};
  engine.execute = () => assert.fail('paused account must never upload');
  engine.report = async (id, action) => releases.push({ id, action });
  engine.request = async () => { account.enabled = false; return { jobs: [{ id: 'claimed', accountId: 'a' }] }; };
  await engine.tick();
  assert.deepEqual(releases, [{ id: 'claimed', action: 'release' }]);
  assert.equal(engine.active.size, 0);
});

test('Seedance pause keeps remote polling, routes new work elsewhere, persists and resumes', async t => {
  const dir = directory(t), store = new WorkbenchStore(dir), polls = [];
  const manager = new AccountManager({ store, sessionFactory: () => ({}), clientFactory: () => ({
    checkAuth: async () => true, fetchHistory: async ids => { polls.push(ids); return { data: { draft_infos: [] } }; },
  }) });
  manager.initialize();
  const a = store.accounts[0], b = manager.addAccount('B');
  manager.markAuthenticated(a.id); manager.markAuthenticated(b.id);
  store.upsertTask({ id: 'running', status: 'generating', accountId: a.id, taskId: 'remote-1', imageItems: [], logs: [] });
  const partition = a.partition;
  manager.renameAccount(a.id, '广告户改名');
  manager.setEnabled(a.id, false);
  assert.equal((await manager.availableAccount(a.id)).id, b.id);
  assert.equal(manager.ensureRuntime(a.id).authenticated, true);
  manager.setEnabled(b.id, false);
  assert.equal(await manager.availableAccount(a.id), null);
  assert.equal(store.settings.activeAccountId, '');
  const engine = new QueueEngine(store, manager);
  await engine.syncRemoteStatuses();
  assert.deepEqual(polls, [['remote-1']]);
  await engine.submitTask({ id: 'never-submit' }, a);
  const restored = new WorkbenchStore(dir), saved = restored.getAccount(a.id);
  assert.equal(saved.name, '广告户改名');
  assert.equal(saved.enabled, false);
  assert.equal(saved.partition, partition);
  assert.ok(saved.lastAuthenticatedAt);
  assert.equal(restored.getTask('running').taskId, 'remote-1');
  assert.throws(() => manager.renameAccount(a.id, ''), /不能为空/);
  manager.setEnabled(a.id, true);
  assert.equal(store.settings.activeAccountId, a.id);
  assert.equal((await manager.availableAccount(a.id)).id, a.id);
});
