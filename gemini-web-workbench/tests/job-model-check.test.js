const test = require('node:test');
const assert = require('node:assert/strict');
const { checkJobModel, needsModelButton } = require('../src/gemini-model-selection');

// Fake worker page: records each picker call and whether the window was
// brought forward at that moment. `renderedWhenHidden` mimics Gemini leaving
// the mode switcher unrendered until the window is shown.
function fakeWorker({ renderedWhenHidden = true, needsMenu = false, failWith = null } = {}) {
  const calls = [];
  let active = false, activations = 0;
  const call = async (method, args = []) => {
    calls.push({ method, active });
    if (method === 'buttonReady') return renderedWhenHidden || active;
    if (method === 'inspect') {
      if (!renderedWhenHidden && !active) throw Object.assign(Error('模型按钮等待 10 秒后仍未出现'), { code: 'MODEL_SELECTION_RETRYABLE' });
      return needsMenu ? { needsMenu: true } : { needsMenu: false, model: '3.8 Flash', thinking: '中', thinkingChecked: true };
    }
    if (method === 'ensure') {
      if (failWith) throw failWith;
      return { model: '3.8 Flash', thinking: '中', thinkingChecked: true, changed: false, models: ['3.8 Flash'], thinkingOptions: ['低', '中', '高'], args };
    }
    throw Error(`unexpected ${method}`);
  };
  const activate = async action => {
    activations++; active = true;
    try { return await action(); } finally { active = false; }
  };
  return { call, activate, calls, activations: () => activations };
}
const exact = { mode: 'exact', name: '3.8 Flash', thinking: '中' };

test('button rendered in the hidden window: zero-click check stays hidden, no activation', async () => {
  const worker = fakeWorker();
  const outcome = await checkJobModel({ settings: exact, call: worker.call, activate: worker.activate });
  assert.equal(outcome.inspected.model, '3.8 Flash'); assert.equal(outcome.activatedForButton, false);
  assert.equal(worker.activations(), 0);
  assert.deepEqual(worker.calls.map(row => row.method), ['buttonReady', 'inspect']);
});

test('button rendered but menu needed: inspect hidden, only the menu step is activated', async () => {
  const worker = fakeWorker({ needsMenu: true });
  const outcome = await checkJobModel({ settings: exact, checkThinking: true, previousThinking: '低', catalog: { models: ['3.8 Flash'] }, call: worker.call, activate: worker.activate });
  assert.equal(outcome.ensured.model, '3.8 Flash'); assert.equal(worker.activations(), 1);
  assert.deepEqual(worker.calls.map(row => `${row.method}:${row.active}`), ['buttonReady:false', 'inspect:false', 'ensure:true']);
  assert.deepEqual(outcome.ensured.args, [exact, { checkThinking: true, previousThinking: '低', catalog: { models: ['3.8 Flash'] } }]);
});

test('switcher not rendered while hidden: the window is brought forward once and the whole check runs there', async () => {
  const worker = fakeWorker({ renderedWhenHidden: false });
  const outcome = await checkJobModel({ settings: exact, call: worker.call, activate: worker.activate });
  assert.equal(outcome.inspected.model, '3.8 Flash'); assert.equal(outcome.activatedForButton, true);
  assert.equal(worker.activations(), 1);
  // No ten-second wait in the hidden window: inspect never runs before activation.
  assert.deepEqual(worker.calls.map(row => `${row.method}:${row.active}`), ['buttonReady:false', 'inspect:true']);
});

test('switcher not rendered and menu needed: inspect and menu share the same single activation', async () => {
  const worker = fakeWorker({ renderedWhenHidden: false, needsMenu: true });
  const outcome = await checkJobModel({ settings: exact, call: worker.call, activate: worker.activate });
  assert.equal(outcome.ensured.model, '3.8 Flash'); assert.equal(outcome.activatedForButton, true);
  assert.equal(worker.activations(), 1);
  assert.deepEqual(worker.calls.map(row => `${row.method}:${row.active}`), ['buttonReady:false', 'inspect:true', 'ensure:true']);
});

test('a definite selection failure inside the activated check still stops the job', async () => {
  const failure = Object.assign(Error('找不到目标模型 3.8 Flash'), { code: 'MODEL_SELECTION_FAILED' });
  const worker = fakeWorker({ renderedWhenHidden: false, needsMenu: true, failWith: failure });
  await assert.rejects(checkJobModel({ settings: exact, call: worker.call, activate: worker.activate }), { code: 'MODEL_SELECTION_FAILED' });
  assert.equal(worker.activations(), 1);
});

test('default preserve mode never probes the button or brings the window forward', async () => {
  const worker = fakeWorker({ renderedWhenHidden: false });
  const outcome = await checkJobModel({ settings: { mode: 'preserve' }, call: async (method, args) => method === 'inspect' ? { needsMenu: false, model: '', thinking: null } : worker.call(method, args), activate: worker.activate });
  assert.equal(outcome.activatedForButton, false); assert.equal(worker.activations(), 0);
  assert.equal(worker.calls.length, 0);
  assert.equal(needsModelButton({ mode: 'preserve' }), false);
  assert.equal(needsModelButton({ mode: 'preserve', thinking: '中' }), true);
  assert.equal(needsModelButton({ mode: 'auto' }), true);
});
