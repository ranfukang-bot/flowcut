const test = require('node:test');
const { WorkbenchStore } = require('../../vendor/seedance-engine/store');
const { AccountManager } = require('../../vendor/seedance-engine/account-manager');
const { QueueEngine } = require('../../vendor/seedance-engine/queue-engine');

function fixture() {
  const store = Object.create(WorkbenchStore.prototype);
  store.data = { version: 1, settings: { activeAccountId: 'a', running: false },
    accounts: ['a', 'b'].map(id => ({ id, name: id.toUpperCase(), enabled: true, preferredModel: '2000012', modelQuota: {} })),
    tasks: [], logs: [] };
  store.save = () => true;
  store.recordSubmission = () => true;
  const accounts = new AccountManager({ store, sessionFactory: () => { throw new Error('Network forbidden in test'); } });
  for (const id of ['a', 'b']) { accounts.ensureRuntime(id); accounts.markAuthenticated(id); }
  const engine = new QueueEngine(store, accounts);
  engine.schedule = () => {};
  return { store, accounts, engine };
}

test('daily model quota recovery', async t => {
  await require('./helpers/quota-recovery-cases.cjs')(fixture, (name, fn) => t.test(name, fn));
});
