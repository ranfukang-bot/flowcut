function normalizeModelSettings(value = {}) {
  const mode = value.mode || 'auto';
  if (!['auto', 'exact', 'preserve'].includes(mode)) throw new Error('未知的 Gemini 模型设置');
  const name = String(value.name || '').trim();
  const thinking = String(value.thinking || '').trim();
  if ((mode === 'exact' && !name) || name.length > 160 || thinking.length > 160) throw new Error('Gemini 模型或思考等级设置无效');
  return { mode, name: mode === 'exact' ? name : '', thinking };
}

const modelSettingsKey = value => JSON.stringify(normalizeModelSettings(value));
function needsThinkingCheck(prior, settings, now = Date.now()) {
  return prior?.settingsKey !== modelSettingsKey(settings) || now - (prior?.checkedAt || 0) >= 3600_000;
}

// Self-contained: serialized into the Gemini page, including saved /gem/ pages.
// Menu labels come from the DOM; only the requested Flash/Lite rule is fixed.
function createModelPicker(doc = document) {
  const buttonSelector = '[data-test-id="bard-mode-menu-button"], [data-test-id="model-selector-button"], button[aria-haspopup="menu"][aria-label*="model" i], button[aria-haspopup="menu"][aria-label*="模型"]';
  const menuSelector = '[role="menu"], .mat-mdc-menu-panel, [role="listbox"]';
  const itemSelector = '[role="menuitem"], [role="menuitemradio"], [role="option"], [data-test-id="model-option"]';
  const clean = value => String(value || '').replace(/[✓✔]/g, '').replace(/\s+/g, ' ').trim();
  const equal = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();
  const visible = el => Boolean(el && el.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden],[aria-hidden="true"]'));
  const fail = message => { throw Object.assign(new Error(message), { code: 'MODEL_SELECTION_FAILED' }); };
  const button = () => {
    const rows = [...doc.querySelectorAll(buttonSelector)].filter(visible);
    if (rows.length !== 1) fail('模型按钮无法唯一识别，网页菜单结构可能已变化');
    return rows[0];
  };
  const label = el => clean(el.getAttribute('data-model-name') || el.querySelector('[data-test-id="model-name"],.mode-title,.model-name,.model-title')?.textContent || String(el.innerText || el.textContent).split('\n').find(line => clean(line)));
  const menus = () => [...doc.querySelectorAll(menuSelector)].filter(visible).filter(el => !el.parentElement?.closest(menuSelector));
  const items = menu => [...menu.querySelectorAll(itemSelector)].filter(visible).filter(el => !el.parentElement?.closest(itemSelector));
  const selected = el => {
    const aria = el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected');
    if (aria !== null) return aria === 'true';
    const icon = el.querySelector('[data-mat-icon-name="check"], [data-mat-icon-name="check_circle"], .checkmark');
    if (icon) return visible(icon) && getComputedStyle(icon).opacity !== '0';
    return /[✓✔]/.test(el.innerText || el.textContent);
  };
  const models = menu => items(menu).filter(el => el.getAttribute('aria-haspopup') !== 'menu' && (['menuitemradio', 'option'].includes(el.getAttribute('role')) || el.hasAttribute('data-model-name') || el.getAttribute('data-test-id') === 'model-option' || /\d+(?:\.\d+)*\s*[a-z]/i.test(label(el))));
  const isModelMenu = menu => items(menu).some(el => el.getAttribute('aria-haspopup') === 'menu' || /\d+(?:\.\d+)*\s*[a-z]/i.test(label(el)) || el.hasAttribute('data-model-name')) || menu.id === button().getAttribute('aria-controls');
  const thinkingTrigger = menu => {
    const rows = items(menu).filter(el => el.getAttribute('aria-haspopup') === 'menu');
    if (rows.length > 1) fail('思考等级子菜单无法唯一识别');
    return rows[0];
  };
  const version = name => {
    const match = String(name).match(/\d+(?:\.\d+)*/);
    return match ? match[0].split('.').map(Number) : [];
  };
  const compare = (a, b) => {
    const x = version(a), y = version(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
  };
  function target(settings, names) {
    if (settings.mode === 'preserve') return '';
    if (settings.mode === 'exact') {
      const matches = names.filter(name => equal(name, settings.name));
      if (matches.length !== 1) fail(`找不到指定模型 ${settings.name}，请重新读取模型列表或更改设置`);
      return matches[0];
    }
    const flash = names.filter(name => /flash/i.test(name) && !/lite/i.test(name) && version(name).length).sort(compare);
    if (!flash.length) fail('没有找到不含 Lite 的 Flash 模型，请重新读取模型列表或更改设置');
    if (flash.length > 1 && compare(flash.at(-1), flash.at(-2)) === 0 && !equal(flash.at(-1), flash.at(-2))) fail('最新 Flash 模型名称不明确');
    return flash.at(-1);
  }
  function buttonMatches(current, wanted, names) {
    if (equal(current, wanted)) return true;
    // A short label is safe only when it uniquely identifies a catalog entry.
    const family = name => clean(name).replace(/^(?:gemini\s*)?\d+(?:\.\d+)*\s*/i, '');
    const matches = names.filter(name => equal(current, family(name)));
    return matches.length === 1 && equal(matches[0], wanted);
  }
  function inspect(settings, catalog = {}, checkThinking = false) {
    const current = (() => { try { return label(button()); } catch (error) { if (settings.mode !== 'preserve' || settings.thinking) throw error; return ''; } })();
    if (settings.mode === 'preserve' && (!settings.thinking || !checkThinking)) return { needsMenu: false, model: current, thinking: null };
    let wanted = '';
    try { wanted = target(settings, catalog.models || []); } catch { return { needsMenu: true }; }
    return { needsMenu: checkThinking || !wanted || !buttonMatches(current, wanted, catalog.models || []), model: wanted || current };
  }
  async function session(action) {
    const deadline = Date.now() + 4000;
    const wait = async (predicate, message = '模型菜单响应超时或结构已变化') => {
      while (Date.now() <= deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
      fail(message);
    };
    const open = async () => {
      let menu = menus().find(isModelMenu);
      if (!menu) {
        await wait(() => [...doc.querySelectorAll(buttonSelector)].some(visible));
        button().click(); menu = await wait(() => menus().find(isModelMenu));
      }
      return menu;
    };
    const close = async () => {
      if (!menus().length) return;
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
      if (menus().length) {
        const backdrop = [...doc.querySelectorAll('.cdk-overlay-backdrop')].find(visible);
        if (backdrop) backdrop.click();
      }
      await wait(() => !menus().length);
    };
    const thoughtMenu = async menu => {
      const trigger = thinkingTrigger(menu);
      if (!trigger) return null;
      trigger.click();
      return wait(() => menus().find(el => el !== menu && items(el).length && !isModelMenu(el)));
    };
    try { return await action({ wait, open, close, thoughtMenu }); }
    finally { await close(); }
  }
  async function readCatalog() {
    return session(async ({ open, thoughtMenu }) => {
      const menu = await open();
      const names = models(menu).map(label);
      if (!names.length || new Set(names.map(name => name.toLowerCase())).size !== names.length) fail('模型列表为空或存在重名选项');
      const thought = await thoughtMenu(menu);
      return { models: names, thinking: thought ? items(thought).map(label) : [], current: label(models(menu).find(selected) || button()), currentThinking: thought ? label(items(thought).find(selected) || { getAttribute: () => '', querySelector: () => null, innerText: '' }) || null : null };
    });
  }
  async function ensure(settings, { checkThinking = false, previousThinking = null } = {}) {
    return session(async ({ wait, open, close, thoughtMenu }) => {
      let menu = await open();
      let rows = models(menu), names = rows.map(label);
      const marked = rows.filter(selected);
      if (marked.length !== 1) fail('无法从菜单勾选状态确认当前模型');
      const wanted = target(settings, names) || label(marked[0]);
      let changed = false;
      if (!equal(label(marked[0]), wanted)) {
        const choice = rows.filter(el => equal(label(el), wanted));
        if (choice.length !== 1) fail(`找不到目标模型 ${wanted}`);
        choice[0].click(); changed = true;
        await wait(() => {
          const stillOpen = menus().find(isModelMenu);
          return !stillOpen || models(stillOpen).some(el => selected(el) && equal(label(el), wanted));
        });
        await close();
        menu = await open(); rows = models(menu); names = rows.map(label);
      }
      await wait(() => models(menu).filter(el => selected(el) && equal(label(el), wanted)).length === 1, `切换后核对不一致，目标模型 ${wanted}`);
      let thinking = previousThinking, thinkingChecked = false, thinkingOptions;
      if (changed || checkThinking) {
        const thought = await thoughtMenu(menu);
        if (!thought && settings.thinking) fail(`找不到思考等级 ${settings.thinking}`);
        if (thought) {
          let choices = items(thought);
          thinkingOptions = choices.map(label);
          const wantedThinking = settings.thinking;
          if (wantedThinking) {
            const matches = choices.filter(el => equal(label(el), wantedThinking));
            if (matches.length !== 1) fail(`找不到思考等级 ${wantedThinking}`);
            if (!selected(matches[0])) {
              matches[0].click();
              await close(); menu = await open();
              const confirm = await thoughtMenu(menu);
              if (!confirm) fail('思考等级子菜单结构已变化');
              choices = items(confirm);
            }
          }
          const checked = choices.filter(selected);
          if (checked.length !== 1 || (wantedThinking && !equal(label(checked[0]), wantedThinking))) fail('思考等级设置后核对不一致');
          thinking = label(checked[0]);
        } else thinking = null;
        thinkingChecked = true;
      }
      await close();
      // The menu checkmark has verified the full name. The button may show a
      // shared short family label, unlike the stricter menu-free fast path.
      await wait(() => buttonMatches(label(button()), wanted, [wanted]), `模型按钮核对不一致，目标模型 ${wanted}`);
      return { model: wanted, thinking, thinkingChecked, changed, models: names, thinkingOptions };
    });
  }
  return { inspect, readCatalog, ensure };
}

// Bytecode has no recoverable function source. Production embeds this string
// during the protected build, while development/tests can serialize directly.
const modelRuntimeSource = typeof __FLOWCUT_MODEL_RUNTIME__ !== 'undefined'
  ? __FLOWCUT_MODEL_RUNTIME__
  : `globalThis.__flowcutModelPicker ||= (${createModelPicker.toString()})();`;
module.exports = { normalizeModelSettings, modelSettingsKey, needsThinkingCheck, createModelPicker, modelRuntimeSource };
