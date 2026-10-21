const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { GeminiAccountWindows } = require('../src/gemini-account-windows');

function fixture() {
  const account = { id: 'existing', partition: 'persist:existing-session', authenticated: true, enabled: false, gemBindings: { unchanged: true } };
  const windows = new Map(), created = [], loads = [];
  let busy = false, quitting = false;
  const manager = new GeminiAccountWindows({ windows, getAccount: id => id === account.id ? account : null,
    isBusy: () => busy, isQuitting: () => quitting,
    createWindow(candidate) {
      assert.equal(candidate.partition, 'persist:existing-session');
      const window = new EventEmitter();let destroyed = false, visible = false, minimized = false, url = '';
      Object.assign(window, { isDestroyed: () => destroyed, isVisible: () => visible, isMinimized: () => minimized,
        show() { visible = true; }, hide() { visible = false; }, focus() {}, restore() { minimized = false; }, minimize() { minimized = true; },
        destroy() { destroyed = true;visible = false;window.emit('closed'); },
        close() { let prevented = false;window.emit('close', { preventDefault() { prevented = true; } });if (!prevented) window.destroy(); },
        webContents: { getURL: () => url }, setURL(value) { url = value; } });
      created.push(window);return window;
    }, loadPage: async (candidate, window) => { loads.push(candidate.partition);window.setURL('https://gemini.google.com/app'); },
  });
  return { account, manager, windows, created, loads, busy(value) { busy = value; }, quitting(value) { quitting = value; } };
}

test('opening an existing account reuses its partition, loads once and leaves login/settings untouched', async () => {
  const f = fixture(), before = structuredClone(f.account);
  await f.manager.open(f.account.id);await f.manager.open(f.account.id);
  assert.equal(f.created.length, 1);assert.deepEqual(f.loads, ['persist:existing-session']);
  assert.equal(f.created[0].isVisible(), true);assert.deepEqual(f.account, before);
});

test('viewing a running task reveals its existing window without navigation or creating another page', async () => {
  const f = fixture();f.busy(true);const worker = f.manager.worker(f.account);worker.setURL('https://gemini.google.com/gem/existing-task');
  await f.manager.open(f.account.id);
  assert.equal(f.created.length, 1);assert.equal(f.loads.length, 0);assert.equal(worker.isVisible(), true);
  assert.equal(worker.webContents.getURL(), 'https://gemini.google.com/gem/existing-task');
  f.manager.finish(worker);assert.equal(worker.isDestroyed(), false, 'The viewed reply remains open after completion');
});

test('closing a viewed worker hides it without destroying a task; finished hidden workers are disposed', async () => {
  const f = fixture();f.busy(true);await f.manager.open(f.account.id);const worker = f.windows.get(f.account.id);
  assert.equal(f.loads.length, 0, 'A not-yet-navigated task worker is not navigated by the viewer');
  worker.close();assert.equal(worker.isVisible(), false);assert.equal(worker.isDestroyed(), false);
  assert.equal(worker.flowcutUserVisible, false);f.manager.finish(worker);assert.equal(worker.isDestroyed(), true);
});

test('a fresh task keeps requested visibility while delayed old close events cannot erase its worker', async () => {
  const f = fixture();await f.manager.open(f.account.id);const old = f.windows.get(f.account.id);
  const fresh = f.manager.worker(f.account, true);old.emit('closed');
  assert.equal(old.isDestroyed(), true);assert.equal(f.windows.get(f.account.id), fresh);
  assert.equal(fresh.isVisible(), true);assert.equal(f.loads.length, 1);
});

test('a task replacing the idle first load is shown without navigating the new task window', async () => {
  const f = fixture();let rejectLoad;
  f.manager.loadPage = () => new Promise((_resolve, reject) => { rejectLoad = reject; });
  const opened = f.manager.open(f.account.id);f.busy(true);const fresh = f.manager.worker(f.account, true);
  rejectLoad(new Error('old navigation aborted'));
  assert.equal(await opened, true);assert.equal(fresh.isVisible(), true);assert.equal(fresh.webContents.getURL(), '');
});

test('reopening a minimized viewer restores it, normal quit can close it and removal clears visibility', async () => {
  const f = fixture();await f.manager.open(f.account.id);const worker = f.windows.get(f.account.id);worker.minimize();
  await f.manager.open(f.account.id);assert.equal(worker.isMinimized(), false);
  f.quitting(true);worker.close();assert.equal(worker.isDestroyed(), true);
  f.quitting(false);f.manager.forget(f.account.id);const next = f.manager.worker(f.account);assert.equal(next.isVisible(), false);
  await assert.rejects(f.manager.open('missing'), /账号不存在/);
});
