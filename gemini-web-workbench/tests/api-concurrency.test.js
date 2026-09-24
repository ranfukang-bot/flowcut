const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkbenchStore } = require('../../vendor/seedance-engine/store');
const { QueueEngine } = require('../../vendor/seedance-engine/queue-engine');

function fixture(t, submit) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-api-cap-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new WorkbenchStore(directory);
  store.updateSettings({ running: true });
  const account = store.accounts[0];
  const calls = [];
  const client = {
    getGeneratingCount: async () => { throw new Error('the web count must not gate API submissions'); },
    fetchHistory: async () => ({ data: { draft_infos: [] } }),
    submitTask: async (task) => {
      calls.push(task.id);
      if (submit) return submit(task, calls.length);
      return { data: { task_id: `remote-${task.id}` } };
    },
  };
  const engine = new QueueEngine(store, {
    authenticated: true, authCheckedAt: Date.now(),
    client: () => client, availableAccount: async () => account,
    ensureRuntime: () => ({ maxConcurrent: 5 }),
    effectiveModel: () => '2000012', isQuotaError: () => false,
    markAuthenticated() {}, markAuthInvalid() {},
    accountName: () => account.name, state: () => ({ items: [] }),
  });
  function add(id, status = 'queued') {
    store.upsertTask({ id, order: store.tasks.length, prompt: 'Product video',
      status, accountId: account.id, duration: 15, attempts: 0, logs: [],
      taskId: status === 'generating' ? `remote-${id}` : '', taskIds: [],
      imageItems: [{ name: '1.jpg', uploadedUrl: 'https://example.com/1.jpg', uploadedAccountId: account.id }],
    });
  }
  return { store, engine, calls, add };
}

test('API submits more than five ready tasks while five older tasks are still generating', async (t) => {
  const { engine, calls, add } = fixture(t);
  for (let i = 0; i < 5; i++) add(`old-${i}`, 'generating');
  for (let i = 0; i < 8; i++) add(`new-${i}`);
  await Promise.all([engine.tick(), engine.tick()]);
  assert.equal(calls.length, 8);
  assert.equal(new Set(calls).size, 8);
  await engine.tick();
  assert.equal(calls.length, 8, 'accepted tasks are never submitted again');
});

test('actual API rate limit cools the account instead of submitting the rest of its queue', async (t) => {
  const { engine, store, calls, add } = fixture(t, () => {
    throw Object.assign(new Error('HTTP 429 too many requests'), { outcome: 'rejected', status: 429 });
  });
  add('one'); add('two');
  await engine.tick();
  await engine.tick();
  assert.deepEqual(calls, ['one']);
  assert.equal(store.getTask('one').status, 'retry_wait');
  assert.equal(store.getTask('two').status, 'queued');
  engine.submitCooldowns.clear();
  store.getTask('one').nextRetryAt = Date.now() + 100000;
  await engine.tick();
  assert.deepEqual(calls, ['one', 'two']);
});

test('pausing during a submit stops the next API submission', async (t) => {
  const f = fixture(t, task => {
    f.store.updateSettings({ running: false });
    return { data: { task_id: `remote-${task.id}` } };
  });
  f.add('one'); f.add('two');
  await f.engine.tick();
  assert.deepEqual(f.calls, ['one']);
  assert.equal(f.store.getTask('two').status, 'queued');
});

test('an ambiguous submit remains held and is not retried without a local concurrency cap', async (t) => {
  const { engine, store, calls, add } = fixture(t, () => {
    throw Object.assign(new Error('connection lost'), { outcome: 'unknown' });
  });
  add('one');
  await engine.tick(); await engine.tick();
  assert.deepEqual(calls, ['one']);
  assert.equal(store.getTask('one').status, 'submit_unconfirmed');
});
