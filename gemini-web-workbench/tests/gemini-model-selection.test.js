const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { chromium } = require('../../vendor/publisher/node_modules/playwright-core');
const { modelRuntimeSource, normalizeModelSettings, modelSettingsKey, needsThinkingCheck } = require('../src/gemini-model-selection');
let browser;
test.before(async () => {
  const executablePath = process.env.CHROMIUM_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser = await chromium.launch(executablePath ? { executablePath } : {});
});
test.after(async () => browser?.close());

const names = ['3.5 Flash-Lite', '3.8 Flash', '3.1 Pro', '4 Argon'];
const config = (mode = 'auto', name = '', thinking = '') => ({ mode, name, thinking });
async function fixture(t, { models = names, current = '3.1 Pro', short = false, wrong = false, url = 'https://gemini.google.com/app' } = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<button data-test-id="bard-mode-menu-button" aria-haspopup="menu"></button><div role="menu" id="models" hidden></div><div role="menu" id="thinking" hidden></div>' }));
  await page.goto(url);
  await page.evaluate(({ models, current, short, wrong }) => {
    globalThis.clicks = []; globalThis.sent = 0; globalThis.uploads = 0;
    let choice = current, level = '低';
    const button = document.querySelector('button'), menu = document.querySelector('#models'), thought = document.querySelector('#thinking');
    const close = () => { menu.hidden = thought.hidden = true; };
    function render() {
      button.textContent = short ? choice.replace(/^\d+(?:\.\d+)*\s*/, '') : choice;
      menu.replaceChildren(); thought.replaceChildren();
      for (const name of models) {
        const item = document.createElement('button'); item.setAttribute('role', 'menuitemradio'); item.setAttribute('aria-checked', String(name === choice)); item.textContent = name;
        item.onclick = () => { clicks.push(name); if (!wrong) choice = name; level = '低'; close(); render(); }; menu.append(item);
      }
      const trigger = document.createElement('button'); trigger.setAttribute('role', 'menuitem'); trigger.setAttribute('aria-haspopup', 'menu'); trigger.textContent = '思考等级';
      trigger.onclick = () => { clicks.push('思考等级'); thought.hidden = false; }; menu.append(trigger);
      for (const name of ['低', '高']) {
        const item = document.createElement('button'); item.setAttribute('role', 'menuitemradio'); item.setAttribute('aria-checked', String(name === level)); item.textContent = name;
        item.onclick = () => { clicks.push(name); level = name; close(); render(); }; thought.append(item);
      }
    }
    button.onclick = () => { clicks.push('模型菜单'); menu.hidden = false; };
    document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    render();
  }, { models, current, short, wrong });
  await page.addScriptTag({ content: modelRuntimeSource });
  const select = (settings, checkThinking = false, catalog = { models }) => page.evaluate(async ({ settings, checkThinking, catalog }) => {
    const started = performance.now();
    try {
      const inspect = __flowcutModelPicker.inspect(settings, catalog, checkThinking);
      const result = inspect.needsMenu ? await __flowcutModelPicker.ensure(settings, { checkThinking }) : inspect;
      // Exercise the send boundary: rejection must prevent both actions.
      uploads++; sent++;
      return { ...result, elapsedMs: performance.now() - started, clicks, sent, uploads };
    } catch (error) { return { code: error.code, error: error.message, clicks, sent, uploads }; }
  }, { settings, checkThinking, catalog });
  return { page, select };
}

test('target button takes the fast path without opening a menu or clicking', async t => {
  const { select } = await fixture(t, { current: '3.8 Flash', short: true });
  const result = await select(config());
  assert.deepEqual(result.clicks, []); assert.equal(result.model, '3.8 Flash'); assert.ok(result.elapsedMs < 500);
  t.diagnostic(`fast path: ${result.elapsedMs.toFixed(2)}ms (browser fixture)`);
});
test('automatic Flash selection skips Lite even when Lite is first', async t => {
  const { select } = await fixture(t);
  const result = await select(config());
  assert.equal(result.model, '3.8 Flash'); assert.equal(result.clicks.includes('3.5 Flash-Lite'), false); assert.equal(result.sent, 1); assert.ok(result.elapsedMs < 4550);
  t.diagnostic(`switch path: ${result.elapsedMs.toFixed(2)}ms + native activation (browser fixture)`);
});
test('automatic version ordering selects 3.9 and compares numeric components', async t => {
  const { select } = await fixture(t, { models: [...names, '3.9 Flash', '3.10 Flash'] });
  assert.equal((await select(config())).model, '3.10 Flash');
  const other = await fixture(t, { models: [...names, '3.9 Flash'] });
  assert.equal((await other.select(config())).model, '3.9 Flash');
});
test('ambiguous short Flash label is confirmed against the full checked menu name', async t => {
  const { select } = await fixture(t, { models: [...names, '3.9 Flash'], current: '3.9 Flash', short: true });
  const result = await select(config());
  assert.equal(result.model, '3.9 Flash'); assert.deepEqual(result.clicks, ['模型菜单']);
});
test('Lite-only menu fails without upload or send', async t => {
  const { select } = await fixture(t, { models: ['3.5 Flash-Lite'], current: '3.5 Flash-Lite' });
  const result = await select(config());
  assert.equal(result.code, 'MODEL_SELECTION_FAILED'); assert.equal(result.sent, 0); assert.equal(result.uploads, 0);
});
test('exact Pro name is honored without model fallback', async t => {
  const { select } = await fixture(t, { current: '3.8 Flash' });
  assert.equal((await select(config('exact', '3.1 Pro'))).model, '3.1 Pro');
  const other = await fixture(t);
  const failed = await other.select(config('exact', 'Missing model'));
  assert.equal(failed.code, 'MODEL_SELECTION_FAILED'); assert.equal(failed.sent, 0);
});
test('model switch resets thinking and the chosen thinking level is restored and verified', async t => {
  const { select } = await fixture(t);
  const result = await select(config('auto', '', '高'));
  assert.equal(result.model, '3.8 Flash'); assert.equal(result.thinking, '高'); assert.equal(result.thinkingChecked, true);
  assert.ok(result.clicks.indexOf('高') > result.clicks.indexOf('3.8 Flash'));
});
test('mismatched model verification prevents upload and send', async t => {
  const { select } = await fixture(t, { wrong: true });
  const result = await select(config());
  assert.equal(result.code, 'MODEL_SELECTION_FAILED'); assert.equal(result.sent, 0); assert.equal(result.uploads, 0);
});
test('menu reader returns per-account labels and thinking options without changing choices', async t => {
  const { page } = await fixture(t);
  const catalog = await page.evaluate(() => __flowcutModelPicker.readCatalog());
  assert.deepEqual(catalog.models, names); assert.deepEqual(catalog.thinking, ['低', '高']);
  assert.equal(catalog.current, '3.1 Pro'); assert.equal(catalog.currentThinking, '低');
  assert.equal(await page.locator('[role="menu"]:visible').count(), 0);
  assert.deepEqual(await page.evaluate(() => clicks), ['模型菜单', '思考等级']);
});
test('menu reader and exact mode support future unversioned model names', async t => {
  const { page, select } = await fixture(t, { models: [...names, 'Future Reasoner'] });
  const catalog = await page.evaluate(() => __flowcutModelPicker.readCatalog());
  assert.equal(catalog.models.at(-1), 'Future Reasoner');
  assert.equal((await select(config('exact', 'Future Reasoner'))).model, 'Future Reasoner');
});
test('saved Gem conversation uses the same selectors and selection behavior', async t => {
  const { select } = await fixture(t, { url: 'https://gemini.google.com/gem/fixture-saved-gem' });
  assert.equal((await select(config())).model, '3.8 Flash');
});
test('preserve mode leaves model and thinking menus untouched', async t => {
  const { select } = await fixture(t, { current: '4 Argon' });
  const result = await select(config('preserve'), true);
  assert.equal(result.model, '4 Argon'); assert.deepEqual(result.clicks, []);
});
test('thinking checks are due at startup, after one hour, and after a settings change', () => {
  const value = config('auto', '', '高'), prior = { settingsKey: modelSettingsKey(value), checkedAt: 1000 };
  assert.equal(needsThinkingCheck(undefined, value, 2000), true);
  assert.equal(needsThinkingCheck(prior, value, 2000), false);
  assert.equal(needsThinkingCheck(prior, value, 3601000), true);
  assert.equal(needsThinkingCheck(prior, config('exact', '3.1 Pro'), 2000), true);
  assert.deepEqual(normalizeModelSettings(), config());
});

test('global selection, discovered catalog and account hold survive a store restart', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { Store } = require('../src/store');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-model-state-'));
  t.after(() => { if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'flowcut-model-state-'))) throw Error('Unsafe test cleanup path'); fs.rmSync(directory, { recursive: true, force: true }); });
  const app = { getPath: () => directory }, first = new Store(app);
  assert.deepEqual(first.state.settings.geminiModel, config());
  first.state.settings.geminiModel = config('exact', '3.1 Pro', '高');
  const account = first.addAccount('模型测试');
  first.updateAccount(account.id, { modelCatalog: { models: names, thinking: ['低', '高'], readAt: '2026-10-15T08:00:00Z' }, modelSelectionHold: { settingsKey: modelSettingsKey(first.state.settings.geminiModel), message: 'MODEL_SELECTION_FAILED' } });
  const restored = new Store(app);
  assert.deepEqual(restored.state.settings.geminiModel, config('exact', '3.1 Pro', '高'));
  assert.deepEqual(restored.state.accounts[0].modelCatalog.models, names);
  assert.equal(restored.state.accounts[0].modelSelectionHold.settingsKey, modelSettingsKey(restored.state.settings.geminiModel));
});

for (const [method, job] of [
  ['runJob', { gemUrl: 'https://gemini.google.com/gem/fixture' }],
  ['runReferenceRemixJob', {}],
  ['runScriptPipelineJob', {}],
  ['runScriptPipelineJob', { rawGroupsJson: JSON.stringify([{ index: 1, rawDuration: 15, targetDuration: 15, rawPrompt: 'fixture' }]) }],
]) {
  test(`real ${method} rejects serialized model failure before any upload or prompt: ${Object.keys(job)}`, async () => {
    const vm = require('node:vm');
    const source = require('node:fs').readFileSync(require.resolve('../src/gemini-preload'), 'utf8');
    const calls = [];
    const context = vm.createContext({ require: () => ({ ipcRenderer: { on() {}, send() {}, invoke: async () => ({ ok: false, code: 'MODEL_SELECTION_FAILED', error: '找不到目标模型' }) } }), setTimeout, clearTimeout, console, document: { readyState: 'complete' } });
    vm.runInContext(source, context);
    Object.assign(context, { loginOrChallengeVisible: () => false, waitUntil: async () => {}, waitFor: async () => {}, ensureFreshConversation: async () => {}, clearExistingAttachments: async () => {}, uploadFiles: async () => calls.push('upload'), typePrompt: async () => calls.push('prompt'), submitPrompt: async () => calls.push('send') });
    await assert.rejects(context[method](job), { code: 'MODEL_SELECTION_FAILED' });
    assert.deepEqual(calls, []);
  });
}

test('settings UI shows each account catalog and saves exact model plus thinking', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    globalThis.savedSettings = [];
    globalThis.modelState = { settings: { geminiModel: { mode: 'auto', name: '', thinking: '' } }, accounts: [
      { id: 'a', name: '账号 A', authenticated: true, modelCatalog: { models: ['3.5 Flash-Lite', '3.8 Flash'], thinking: ['低', '高'], readAt: '2026-10-15T08:00:00Z' } },
      { id: 'b', name: '账号 B', authenticated: true, modelCatalog: { models: ['3.1 Pro'], thinking: ['高'], readAt: '2026-10-15T08:00:00Z' } },
    ] };
    globalThis.modelApi = { getState: async () => modelState, readGeminiModels: async () => modelState, saveGeminiModel: async value => { savedSettings.push(value); modelState.settings.geminiModel = value; return modelState; } };
  });
  const bundle = require('esbuild').buildSync({ stdin: { contents: `import {createRoot} from 'react-dom/client'; import {GeminiModelSettingsPanel} from './gemini-model-settings'; const bridge=()=>window.modelApi; createRoot(document.getElementById('root')).render(<GeminiModelSettingsPanel bridge={bridge}/>);`, loader: 'tsx', resolveDir: require('node:path').resolve(__dirname, '../../app') }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text;
  await page.addScriptTag({ content: bundle });
  await page.getByText('账号 B', { exact: true }).waitFor();
  await page.getByLabel('Gemini 生成模型模式').selectOption('exact');
  await page.getByLabel('指定 Gemini 模型').selectOption('3.1 Pro');
  await page.getByLabel('Gemini 思考等级').selectOption('高');
  await page.getByRole('button', { name: '保存生成模型' }).click();
  await page.getByRole('status').waitFor();
  assert.deepEqual(await page.evaluate(() => savedSettings), [{ mode: 'exact', name: '3.1 Pro', thinking: '高' }]);
});
