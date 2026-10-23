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
async function fixture(t, { models = names, current = '3.1 Pro', short = false, wrong = false, inline = false, level = '低点', levels = ['低点', '中等', '高点'], url = 'https://gemini.google.com/app' } = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<button data-test-id="bard-mode-menu-button" aria-haspopup="menu"></button><div role="menu" id="models" hidden></div><div role="menu" id="thinking" hidden></div>' }));
  await page.goto(url);
  await page.evaluate(({ models, current, short, wrong, level, levels, inline }) => {
    globalThis.clicks = []; globalThis.sent = 0; globalThis.uploads = 0;
    let choice = current;
    const button = document.querySelector('button'), menu = document.querySelector('#models'), thought = document.querySelector('#thinking');
    const close = () => { menu.hidden = thought.hidden = true; };
    function render() {
      button.innerHTML = `<span>${short ? choice.replace(/^\d+(?:\.\d+)*\s*/, '') : choice}</span> <span>${level}</span><mat-icon>keyboard_arrow_up</mat-icon>`;
      menu.replaceChildren(); thought.replaceChildren();
      for (const name of models) {
        const item = document.createElement('gem-menu-item'); item.setAttribute('role', 'menuitem'); item.setAttribute('aria-haspopup', 'false'); item.classList.toggle('selected', name === choice);
        item.setAttribute('data-model-name', name);
        item.innerHTML = `<span class="label">${name}</span><div>全方位帮助</div>${name === choice ? '<mat-icon data-mat-icon-name="check" style="display:contents"></mat-icon>' : ''}`;
        item.onclick = () => { clicks.push(name); if (!wrong) choice = name; level = levels[0]; close(); render(); }; menu.append(item);
      }
      const trigger = document.createElement('gem-menu-item'); trigger.setAttribute('role', 'menuitem'); trigger.setAttribute('aria-haspopup', 'true'); trigger.textContent = '思考等级';
      if (inline) { trigger.setAttribute('aria-haspopup', 'false'); trigger.setAttribute('value', 'thinking_level'); trigger.setAttribute('aria-expanded', 'false'); trigger.className = 'expandable'; thought.removeAttribute('role'); thought.className = 'expand-content'; }
      trigger.onclick = event => { if (event.target.closest('.expand-content')) return; clicks.push('思考等级'); trigger.setAttribute('aria-expanded', 'true'); thought.hidden = false; }; menu.append(trigger);
      for (const name of levels) {
        const item = document.createElement('gem-menu-item'); item.setAttribute('role', 'menuitem'); item.setAttribute('aria-haspopup', 'false'); item.classList.toggle('selected', name === level);
        item.innerHTML = `<span class="label">${name}</span><div>深度适中</div>${name === level ? '<mat-icon data-mat-icon-name="check" style="display:contents"></mat-icon>' : ''}`;
        item.onclick = () => { clicks.push(name); level = name; close(); render(); }; thought.append(item);
      }
      (inline ? trigger : menu).append(thought);
    }
    button.onclick = () => { clicks.push('模型菜单'); menu.hidden = false; };
    document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    render();
  }, { models, current, short, wrong, level, levels, inline });
  await page.addScriptTag({ content: modelRuntimeSource });
  const select = (settings, checkThinking = false, catalog = { models, thinking: levels }) => page.evaluate(async ({ settings, checkThinking, catalog }) => {
    const started = performance.now();
    try {
      const inspect = await __flowcutModelPicker.inspect(settings, catalog, checkThinking);
      const result = inspect.needsMenu ? await __flowcutModelPicker.ensure(settings, { checkThinking, catalog }) : inspect;
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

test('Flash 中等 plus icon verifies thinking with zero clicks even when a check is due', async t => {
  const { select } = await fixture(t, { current: '3.8 Flash', short: true, level: '中等' });
  const result = await select(config('auto', '', '中等'), true);
  assert.deepEqual(result.clicks, []); assert.equal(result.thinking, '中等'); assert.equal(result.thinkingChecked, true); assert.ok(result.elapsedMs < 500);
});

test('Flash 低点 changes only thinking and accepts the combined final button', async t => {
  const { select, page } = await fixture(t, { current: '3.8 Flash', short: true });
  const result = await select(config('auto', '', '中等'));
  assert.equal(result.thinking, '中等'); assert.equal(result.clicks.includes('3.8 Flash'), false); assert.ok(result.clicks.includes('中等'));
  assert.match(await page.locator('button').innerText(), /Flash.*中等/s); assert.equal(result.sent, 1);
});

test('Pro 高点 switches to latest Flash before restoring 中等', async t => {
  const { select } = await fixture(t, { short: true, level: '高点' });
  const result = await select(config('auto', '', '中等'));
  assert.equal(result.model, '3.8 Flash'); assert.equal(result.thinking, '中等'); assert.equal(result.thinkingChecked, true);
  assert.ok(result.clicks.indexOf('3.8 Flash') < result.clicks.indexOf('中等')); assert.equal(result.sent, 1);
});

test('missing 中等 deterministically prevents upload and send', async t => {
  const { select } = await fixture(t, { current: '3.8 Flash', short: true, levels: ['低点', '高点'] });
  const result = await select(config('auto', '', '中等'));
  assert.equal(result.code, 'MODEL_SELECTION_FAILED'); assert.equal(result.sent, 0); assert.equal(result.uploads, 0);
});

test('a level saved as 中等 keeps working after Gemini renames the levels to 低/中/高', async t => {
  const renamed = { levels: ['低', '中', '高'] };
  const ready = await fixture(t, { current: '3.8 Flash', short: true, level: '中', ...renamed });
  const fast = await ready.select(config('auto', '', '中等'), true);
  assert.deepEqual(fast.clicks, []); assert.equal(fast.thinking, '中'); assert.equal(fast.thinkingChecked, true);
  const low = await fixture(t, { current: '3.8 Flash', short: true, level: '低', ...renamed });
  const changed = await low.select(config('auto', '', '中等'));
  assert.equal(changed.thinking, '中'); assert.ok(changed.clicks.includes('中')); assert.equal(changed.sent, 1);
  const pro = await fixture(t, { short: true, level: '高', ...renamed });
  const switched = await pro.select(config('auto', '', '中等'), false, { models: names, thinking: ['低点', '中等', '高点'] });
  assert.equal(switched.model, '3.8 Flash'); assert.equal(switched.thinking, '中'); assert.equal(switched.sent, 1, 'an outdated saved list does not block the job');
});

test('the reverse rename and English labels are understood; two options of one level stop the job', async t => {
  const old = await fixture(t, { current: '3.8 Flash', short: true });
  assert.equal((await old.select(config('auto', '', '中'))).thinking, '中等');
  const english = await fixture(t, { current: '3.8 Flash', short: true, level: 'Low', levels: ['Low', 'Medium', 'High'] });
  const englishResult = await english.select(config('auto', '', '中等'));
  assert.equal(englishResult.thinking, 'Medium', JSON.stringify(englishResult));
  const ambiguous = await fixture(t, { current: '3.8 Flash', short: true, levels: ['低点', '中', '中等', '高点'] });
  const failed = await ambiguous.select(config('auto', '', '中等'));
  assert.equal(failed.code, 'MODEL_SELECTION_FAILED'); assert.match(failed.error, /无法唯一对应/); assert.equal(failed.sent, 0); assert.equal(failed.uploads, 0);
});

test('narrow Gemini layout expands thinking inline instead of opening a second menu', async t => {
  const { select } = await fixture(t, { current: '3.8 Flash', short: true, inline: true });
  const result = await select(config('auto', '', '中等'));
  assert.equal(result.thinking, '中等'); assert.equal(result.sent, 1);
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
  const result = await select(config('auto', '', '高点'));
  assert.equal(result.model, '3.8 Flash'); assert.equal(result.thinking, '高点'); assert.equal(result.thinkingChecked, true);
  assert.ok(result.clicks.indexOf('高点') > result.clicks.indexOf('3.8 Flash'));
});
test('mismatched model verification prevents upload and send', async t => {
  const { select } = await fixture(t, { wrong: true });
  const result = await select(config());
  assert.equal(result.code, 'MODEL_SELECTION_FAILED'); assert.equal(result.sent, 0); assert.equal(result.uploads, 0);
});

test('menu timeout has an eight-second budget and remains retryable without upload or send', async t => {
  const { page, select } = await fixture(t);
  await page.evaluate(() => {
    globalThis.testClock = 0;
    Date.now = () => (globalThis.testClock += 1000);
    document.querySelector('button').onclick = () => { clicks.push('stalled menu'); };
  });
  const result = await select(config());
  assert.equal(result.code, 'MODEL_SELECTION_RETRYABLE'); assert.equal(result.sent, 0); assert.equal(result.uploads, 0);
  const clock = await page.evaluate(() => testClock);
  assert.ok(clock >= 9000 && clock <= 11000, `eight-second simulated deadline: ${clock}`);
});

test('duplicate model names deterministically fail without upload or send', async t => {
  const { select } = await fixture(t, { models: [...names, '3.8 Flash'] });
  const result = await select(config());
  assert.equal(result.code, 'MODEL_SELECTION_FAILED'); assert.equal(result.sent, 0); assert.equal(result.uploads, 0);
});

test('an identified empty model menu fails deterministically without upload or send', async t => {
  const { page, select } = await fixture(t);
  await page.evaluate(() => { document.querySelector('button').setAttribute('aria-controls', 'models'); document.querySelector('#models').replaceChildren(); });
  const result = await select(config());
  assert.equal(result.code, 'MODEL_SELECTION_FAILED'); assert.equal(result.sent, 0); assert.equal(result.uploads, 0);
});
test('menu reader returns per-account labels and thinking options without changing choices', async t => {
  const { page } = await fixture(t);
  const catalog = await page.evaluate(() => __flowcutModelPicker.readCatalog());
  assert.deepEqual(catalog.models, names); assert.deepEqual(catalog.thinking, ['低点', '中等', '高点']);
  assert.equal(catalog.current, '3.1 Pro'); assert.equal(catalog.currentThinking, '低点');
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
  assert.equal(result.model, '4 Argon 低点'); assert.deepEqual(result.clicks, []);
});

for (const method of ['inspect', 'readCatalog']) {
  test(`${method} waits for a model button that appears near the ten-second readiness deadline`, async t => {
    const { page } = await fixture(t, { current: '3.8 Flash' });
    await page.evaluate(() => {
      const button = document.querySelector('button'), nativeTimeout = setTimeout;
      button.hidden = true; globalThis.readinessClock = 0;
      Date.now = () => readinessClock;
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay > 0 && delay <= 50) {
          readinessClock += 500;
          if (readinessClock >= 9500) button.hidden = false;
          return nativeTimeout(callback, 0, ...args);
        }
        return nativeTimeout(callback, delay, ...args);
      };
    });
    const result = await page.evaluate(async method => {
      const result = await (method === 'inspect' ? __flowcutModelPicker.inspect({ mode: 'auto', thinking: '' }, { models: ['3.8 Flash'], thinking: ['低点', '中等', '高点'] }) : __flowcutModelPicker.readCatalog());
      return { result, clock: readinessClock, clicks, sent, uploads };
    }, method);
    assert.equal(result.clock, 9500); assert.equal(result.sent, 0); assert.equal(result.uploads, 0);
    if (method === 'inspect') { assert.equal(result.result.needsMenu, false); assert.deepEqual(result.clicks, []); }
    else { assert.deepEqual(result.result.models, names); assert.equal(result.result.current, '3.8 Flash'); }
  });

  test(`${method} times out after ten seconds with visible-button diagnostics and no private page data`, async t => {
    const { page } = await fixture(t);
    await page.evaluate(() => {
      document.querySelector('button').remove();
      document.body.insertAdjacentHTML('beforeend', `<button data-test-id="future-picker" aria-label="选择模型" aria-haspopup="listbox" class="first second third fourth">123456789012345678901234567890EXTRA_TEXT</button>
        <button hidden data-test-id="HIDDEN_CANARY">HIDDEN_CANARY</button>
        <nav><button aria-label="HISTORY_PROMPT_CANARY">HISTORY_PROMPT_CANARY</button></nav>
        <user-query><button aria-label="MESSAGE_PROMPT_CANARY">MESSAGE_PROMPT_CANARY</button></user-query>
        <button aria-label="https://example.invalid/login?token=URL_TOKEN_CANARY#secret">Cookie: SID=COOKIE_CANARY</button>
        <textarea>PROMPT_INPUT_CANARY</textarea>`);
      Object.defineProperty(document, 'cookie', { get() { throw Error('cookie must never be read'); } });
      const nativeTimeout = setTimeout; globalThis.readinessClock = 0;
      Date.now = () => readinessClock;
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay > 0 && delay <= 50) { readinessClock += 500; return nativeTimeout(callback, 0, ...args); }
        return nativeTimeout(callback, delay, ...args);
      };
    });
    const result = await page.evaluate(async method => {
      try { await (method === 'inspect' ? __flowcutModelPicker.inspect({ mode: 'auto' }) : __flowcutModelPicker.readCatalog()); uploads++; sent++; return { unexpectedSuccess: true }; }
      catch (error) { return { error: error.message, code: error.code, clock: readinessClock, sent, uploads }; }
    }, method);
    assert.equal(result.clock, 10000); assert.equal(result.code, 'MODEL_SELECTION_RETRYABLE');
    assert.equal(result.sent, 0); assert.equal(result.uploads, 0);
    for (const expected of ['等待 10 秒', 'visibilityState=visible', 'data-test-id="future-picker"', 'aria-label="选择模型"', 'aria-haspopup="listbox"', 'class="first second third"', '文字="123456789012345678901234567890"']) assert.ok(result.error.includes(expected), expected);
    for (const privateValue of ['HIDDEN_CANARY', 'HISTORY_PROMPT_CANARY', 'MESSAGE_PROMPT_CANARY', 'URL_TOKEN_CANARY', 'COOKIE_CANARY', 'PROMPT_INPUT_CANARY', 'EXTRA_TEXT', 'fourth']) assert.equal(result.error.includes(privateValue), false, privateValue);
  });
}

test('buttonReady answers instantly from the current page without waiting or clicking', async t => {
  const { page } = await fixture(t, { current: '3.8 Flash' });
  const result = await page.evaluate(async () => {
    const button = document.querySelector('button'), started = performance.now();
    const shown = await __flowcutModelPicker.buttonReady();
    button.hidden = true; const hidden = await __flowcutModelPicker.buttonReady();
    button.remove(); const missing = await __flowcutModelPicker.buttonReady();
    return { shown, hidden, missing, elapsedMs: performance.now() - started, clicks, sent, uploads };
  });
  assert.deepEqual([result.shown, result.hidden, result.missing], [true, false, false]);
  assert.ok(result.elapsedMs < 500); assert.deepEqual(result.clicks, []); assert.equal(result.sent, 0); assert.equal(result.uploads, 0);
});

test('default preserve mode does not wait, open menus, upload or send when no model button exists', async t => {
  const { page } = await fixture(t);
  await page.evaluate(() => document.querySelector('button').remove());
  const result = await page.evaluate(async settings => ({ ...await __flowcutModelPicker.inspect(settings, {}, true), clicks, sent, uploads }), normalizeModelSettings());
  assert.equal(result.needsMenu, false); assert.deepEqual(result.clicks, []); assert.equal(result.sent, 0); assert.equal(result.uploads, 0);
});
test('thinking check metadata is invalidated by settings, not an hourly menu timer', () => {
  const value = config('auto', '', '高'), prior = { settingsKey: modelSettingsKey(value), checkedAt: 1000 };
  assert.equal(needsThinkingCheck(undefined, value, 2000), true);
  assert.equal(needsThinkingCheck(prior, value, 2000), false);
  assert.equal(needsThinkingCheck(prior, value, 3601000), false);
  assert.equal(needsThinkingCheck(prior, config('exact', '3.1 Pro'), 2000), true);
  assert.deepEqual(normalizeModelSettings(), config('preserve'));
});

test('global selection, discovered catalog and account hold survive a store restart', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { Store } = require('../src/store');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-model-state-'));
  t.after(() => { if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'flowcut-model-state-'))) throw Error('Unsafe test cleanup path'); fs.rmSync(directory, { recursive: true, force: true }); });
  const app = { getPath: () => directory }, first = new Store(app);
  assert.deepEqual(first.state.settings.geminiModel, config('preserve'));
  first.state.settings.geminiModel = config('exact', '3.1 Pro', '高');
  const account = first.addAccount('模型测试');
  first.updateAccount(account.id, { modelCatalog: { models: names, thinking: ['低', '高'], readAt: '2026-10-15T08:00:00Z' }, modelSelectionHold: { settingsKey: modelSettingsKey(first.state.settings.geminiModel), message: 'MODEL_SELECTION_FAILED' } });
  const restored = new Store(app);
  assert.deepEqual(restored.state.settings.geminiModel, config('exact', '3.1 Pro', '高'));
  assert.deepEqual(restored.state.accounts[0].modelCatalog.models, names);
  assert.equal(restored.state.accounts[0].modelSelectionHold.settingsKey, modelSettingsKey(restored.state.settings.geminiModel));
});

test('upgrading an unconfigured profile defaults to preserve while saved choices, accounts and keys survive', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { Store } = require('../src/store');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-model-upgrade-'));
  t.after(() => { if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'flowcut-model-upgrade-'))) throw Error('Unsafe cleanup'); fs.rmSync(directory, { recursive: true, force: true }); });
  const original = { settings: { bridgeKey: 'fixture-bridge', credentialsMasterKey: 'fixture-key', queueRunning: false }, accounts: [{ id: 'existing', name: 'Existing account', partition: 'persist:existing', authenticated: true }], pendingResults: [] };
  fs.writeFileSync(path.join(directory, 'workbench-state.json'), JSON.stringify(original));
  const app = { getPath: () => directory }, upgraded = new Store(app);
  assert.deepEqual(upgraded.state.settings.geminiModel, config('preserve'));
  assert.deepEqual(upgraded.state.accounts, original.accounts);
  assert.equal(upgraded.state.settings.credentialsMasterKey, original.settings.credentialsMasterKey);
  await upgraded.flushLogs();
  for (const settings of [config('auto', '', '高'), config('exact', '3.1 Pro', '低'), config('preserve')]) {
    const saved = { ...original, settings: { ...original.settings, geminiModel: settings } };
    fs.writeFileSync(path.join(directory, 'workbench-state.json'), JSON.stringify(saved));
    const reopened = new Store(app);
    assert.deepEqual(reopened.state.settings.geminiModel, settings); assert.deepEqual(reopened.state.accounts, original.accounts);
    await reopened.flushLogs();
  }
});

for (const code of ['MODEL_SELECTION_FAILED', 'MODEL_SELECTION_RETRYABLE']) for (const [method, job] of [
  ['runJob', { gemUrl: 'https://gemini.google.com/gem/fixture' }],
  ['runReferenceRemixJob', {}],
  ['runScriptPipelineJob', {}],
  ['runScriptPipelineJob', { rawGroupsJson: JSON.stringify([{ index: 1, rawDuration: 15, targetDuration: 15, rawPrompt: 'fixture' }]) }],
]) {
  test(`real ${method} rejects ${code} before any upload or prompt: ${Object.keys(job)}`, async () => {
    const vm = require('node:vm');
    const source = require('node:fs').readFileSync(require.resolve('../src/gemini-preload'), 'utf8');
    const calls = [];
    const context = vm.createContext({ require: () => ({ ipcRenderer: { on() {}, send() {}, invoke: async () => ({ ok: false, code, error: '模型检查失败' }) } }), setTimeout, clearTimeout, console, document: { readyState: 'complete' } });
    vm.runInContext(source, context);
    Object.assign(context, { loginOrChallengeVisible: () => false, waitUntil: async () => {}, waitFor: async () => {}, ensureFreshConversation: async () => {}, clearExistingAttachments: async () => {}, uploadFiles: async () => calls.push('upload'), typePrompt: async () => calls.push('prompt'), submitPrompt: async () => calls.push('send') });
    await assert.rejects(context[method](job), { code });
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

test('unconfigured settings UI preserves the web model until saved and shows catalog failure diagnostics', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    globalThis.savedSettings = [];
    globalThis.modelApi = {
      getState: async () => ({ settings: {}, accounts: [] }),
      readGeminiModels: async () => ({ settings: {}, accounts: [{ id: 'a', name: 'Account A', modelCatalog: { error: '模型按钮等待 10 秒后仍未出现。\n可见按钮诊断：data-test-id="future-picker" aria-label="模型" aria-haspopup="menu" class="one two three" 文字="Flash"' } }] }),
      saveGeminiModel: async value => { savedSettings.push(value); return { settings: { geminiModel: value } }; },
    };
  });
  const bundle = require('esbuild').buildSync({ stdin: { contents: `import {createRoot} from 'react-dom/client'; import {GeminiModelSettingsPanel} from './gemini-model-settings'; const bridge=()=>window.modelApi; createRoot(document.getElementById('root')).render(<GeminiModelSettingsPanel bridge={bridge}/>);`, loader: 'tsx', resolveDir: require('node:path').resolve(__dirname, '../../app') }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text;
  await page.addScriptTag({ content: bundle });
  await page.getByRole('button', { name: '读取模型列表' }).waitFor();
  assert.equal(await page.getByLabel('Gemini 生成模型模式').inputValue(), 'preserve');
  assert.equal(await page.getByLabel('Gemini 思考等级').inputValue(), '');
  assert.deepEqual(await page.evaluate(() => savedSettings), []);
  await page.getByRole('button', { name: '读取模型列表' }).click();
  await page.getByRole('alert').waitFor(); assert.ok((await page.getByRole('alert').innerText()).includes('data-test-id="future-picker"'));
  await page.getByLabel('Gemini 生成模型模式').selectOption('auto');
  assert.deepEqual(await page.evaluate(() => savedSettings), []);
  await page.getByRole('button', { name: '保存生成模型' }).click();
  await page.waitForFunction(() => savedSettings.length === 1);
  assert.deepEqual(await page.evaluate(() => savedSettings), [config()]);
});
