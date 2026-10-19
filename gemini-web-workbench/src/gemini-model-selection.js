function normalizeModelSettings(value = {}) {
  const mode = value.mode || 'preserve';
  if (!['auto', 'exact', 'preserve'].includes(mode)) throw new Error('未知的 Gemini 模型设置');
  const name = String(value.name || '').trim();
  const thinking = String(value.thinking || '').trim();
  if ((mode === 'exact' && !name) || name.length > 160 || thinking.length > 160) throw new Error('Gemini 模型或思考等级设置无效');
  return { mode, name: mode === 'exact' ? name : '', thinking };
}

const modelSettingsKey = value => JSON.stringify(normalizeModelSettings(value));
function needsThinkingCheck(prior, settings) {
  return prior?.settingsKey !== modelSettingsKey(settings);
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
  const retry = message => { throw Object.assign(new Error(message), { code: 'MODEL_SELECTION_RETRYABLE' }); };
  const buttonRows = () => [...doc.querySelectorAll(buttonSelector)].filter(visible);
  const diagnosticText = (value, limit = 160) => Array.from(clean(value)
    .replace(/(?:https?:\/\/|www\.)[^\s"'<>]+/gi, '[网址已省略]')
    .replace(/\S*[?&#]\S*/g, '[参数已省略]')
    .replace(/\b(?:cookie|set-cookie)\s*[:=].*/gi, '[Cookie已省略]')
    .replace(/\b(?:__Secure-[\w-]+|SID|HSID|SSID|APISID|SAPISID)\s*=\s*[^\s;]+/gi, '[Cookie已省略]'))
    .slice(0, limit).join('');
  const buttonDiagnostics = () => {
    const rows = [...doc.querySelectorAll('button,[role="button"]')].filter(visible);
    const entries = rows.map((el, index) => {
      // Conversation/history labels can contain prompts. Never include their
      // aria-label or text, nor inspect inputs, URLs, cookies or page content.
      const privateLabel = el.closest('nav,[role="navigation"],user-query,model-response,.conversation-container,[data-message-id],[contenteditable="true"],[data-test-id*="conversation" i],[data-test-id*="history" i]');
      const text = value => privateLabel ? '[会话区域文字已省略]' : diagnosticText(value);
      return `${index + 1}. data-test-id=${JSON.stringify(diagnosticText(el.getAttribute('data-test-id')))} aria-label=${JSON.stringify(text(el.getAttribute('aria-label')))} aria-haspopup=${JSON.stringify(diagnosticText(el.getAttribute('aria-haspopup')))} class=${JSON.stringify([...el.classList].slice(0, 3).map(value => diagnosticText(value, 64)).join(' '))} 文字=${JSON.stringify(Array.from(text(el.innerText || el.textContent)).slice(0, 30).join(''))}`;
    });
    return `可见按钮诊断（${rows.length} 个）：\n${entries.join('\n') || '（无可见按钮）'}`;
  };
  const waitForButton = async () => {
    const deadline = Date.now() + 10_000;
    while (true) {
      const rows = buttonRows();
      if (rows.length > 1) fail('模型按钮无法唯一识别，网页菜单结构可能已变化');
      if (rows.length === 1) return rows[0];
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
    }
    retry(`模型按钮等待 10 秒后仍未出现，请稍后重试。\n${buttonDiagnostics()}`);
  };
  const button = () => {
    const rows = buttonRows();
    if (!rows.length) retry(`模型按钮尚未出现，请稍后重试。\n${buttonDiagnostics()}`);
    if (rows.length !== 1) fail('模型按钮无法唯一识别，网页菜单结构可能已变化');
    return rows[0];
  };
  const textWithoutIcons = el => {
    return String(el.innerText || el.textContent || '').replace(/\b(?:keyboard_arrow_(?:up|down|right)|arrow_right|expand_more|expand_less|check_circle|check)\b/g, '');
  };
  const label = el => clean(el.getAttribute('data-model-name') || el.querySelector('[data-test-id="model-name"],.mode-title,.model-name,.model-title,.label')?.textContent || textWithoutIcons(el).split('\n').find(line => clean(line)));
  const buttonLabel = el => clean(textWithoutIcons(el));
  const popup = el => ['true', 'menu'].includes(el.getAttribute('aria-haspopup')) || el.matches('gem-menu-item[value="thinking_level"].expandable');
  const splitButton = (value, options = []) => {
    const text = clean(value);
    const matches = options.filter(option => text.toLowerCase().endsWith(` ${clean(option).toLowerCase()}`));
    if (matches.length !== 1) return { model: text, thinking: null };
    return { model: text.slice(0, -clean(matches[0]).length).trim(), thinking: matches[0] };
  };
  const menus = () => [...doc.querySelectorAll(menuSelector)].filter(visible)
    .filter(el => el.matches('[role="menu"],[role="listbox"]') || !el.querySelector('[role="menu"],[role="listbox"]'));
  const items = menu => [...menu.querySelectorAll(itemSelector)].filter(visible).filter(el => {
    if (menu.matches(menuSelector) && el.closest(menuSelector) !== menu) return false;
    const parentItem = el.parentElement?.closest(itemSelector);
    return !parentItem || !menu.contains(parentItem);
  });
  const selected = el => {
    const aria = el.getAttribute('aria-checked') ?? el.getAttribute('aria-selected');
    if (aria !== null) return aria === 'true';
    const icon = el.querySelector('[data-mat-icon-name="check"], [data-mat-icon-name="check_circle"], .checkmark');
    // Real gem-menu-item has no aria-checked. Its selected class and check
    // icon agree; mat-icon itself can have no layout box (display: contents).
    if (el.matches('gem-menu-item.selected') && icon) return true;
    if (icon) return visible(icon) && getComputedStyle(icon).opacity !== '0';
    return /[✓✔]/.test(el.innerText || el.textContent);
  };
  const models = menu => items(menu).filter(el => !popup(el) && (['menuitemradio', 'option'].includes(el.getAttribute('role')) || el.hasAttribute('data-model-name') || el.getAttribute('data-test-id') === 'model-option' || /\d+(?:\.\d+)*\s*[a-z]/i.test(label(el))));
  const isModelMenu = menu => items(menu).some(el => popup(el) || /\d+(?:\.\d+)*\s*[a-z]/i.test(label(el)) || el.hasAttribute('data-model-name')) || Boolean(menu.id && menu.id === button().getAttribute('aria-controls'));
  const thinkingTrigger = menu => {
    const rows = items(menu).filter(popup);
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
  async function inspect(settings, catalog = {}, checkThinking = false) {
    if (settings.mode === 'preserve' && !settings.thinking) {
      const rows = buttonRows();
      return { needsMenu: false, model: rows.length === 1 ? label(rows[0]) : '', thinking: null };
    }
    const current = splitButton(buttonLabel(await waitForButton()), catalog.thinking);
    let wanted = '';
    try { wanted = target(settings, catalog.models || []); } catch { return { needsMenu: true }; }
    const matchingModels = (catalog.models || []).filter(name => buttonMatches(current.model, name, catalog.models || []));
    const model = wanted || (matchingModels.length === 1 ? matchingModels[0] : '');
    const thinkingMatches = !settings.thinking || equal(current.thinking, settings.thinking);
    return { needsMenu: !model || !buttonMatches(current.model, model, catalog.models || []) || !thinkingMatches,
      model: model || current.model, thinking: current.thinking, thinkingChecked: Boolean(settings.thinking && thinkingMatches) };
  }
  async function session(action) {
    const deadline = Date.now() + 8000;
    const wait = async (predicate, message = '模型菜单响应超时或结构已变化') => {
      while (Date.now() <= deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
      retry(message);
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
      for (let depth = 0; depth < 3 && menus().length; depth++) {
        menus().at(-1).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (menus().length) {
        const backdrop = [...doc.querySelectorAll('.cdk-overlay-backdrop')].find(visible);
        if (backdrop) backdrop.click();
      }
      await wait(() => !menus().length);
    };
    const thoughtMenu = async menu => {
      const trigger = thinkingTrigger(menu);
      if (!trigger) return null;
      if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
      return wait(() => {
        const inline = trigger.querySelector('.expand-content');
        return inline && items(inline).length ? inline : menus().find(el => el !== menu && items(el).length && !isModelMenu(el));
      });
    };
    let failed = false;
    try { return await action({ wait, open, close, thoughtMenu }); }
    catch (error) { failed = true; throw error; }
    finally { try { await close(); } catch (error) { if (!failed) throw error; } }
  }
  async function readCatalog() {
    await waitForButton();
    return session(async ({ open, thoughtMenu }) => {
      const menu = await open();
      const names = models(menu).map(label);
      if (!names.length || new Set(names.map(name => name.toLowerCase())).size !== names.length) fail('模型列表为空或存在重名选项');
      const thought = await thoughtMenu(menu);
      const chosen = models(menu).find(selected);
      const chosenThinking = thought && items(thought).find(selected);
      return { models: names, thinking: thought ? items(thought).map(label) : [], current: chosen ? label(chosen) : buttonLabel(button()), currentThinking: chosenThinking ? label(chosenThinking) : null };
    });
  }
  async function ensure(settings, { checkThinking = false, previousThinking = null, catalog = {} } = {}) {
    return session(async ({ wait, open, close, thoughtMenu }) => {
      let menu = await open();
      let rows = models(menu), names = rows.map(label);
      if (!names.length || new Set(names.map(name => name.toLowerCase())).size !== names.length) fail('模型列表为空或存在重名选项');
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
      const verified = models(menu).filter(selected);
      if (verified.length !== 1 || !equal(label(verified[0]), wanted)) fail(`切换后核对不一致，目标模型 ${wanted}`);
      let thinking = previousThinking, thinkingChecked = false, thinkingOptions = catalog.thinking;
      if (changed || checkThinking || settings.thinking) {
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
      await wait(() => {
        const final = splitButton(buttonLabel(button()), thinkingOptions);
        return buttonMatches(final.model, wanted, [wanted]) && (!settings.thinking || equal(final.thinking, settings.thinking));
      }, `模型按钮核对不一致，目标模型 ${wanted}${settings.thinking ? ` · 思考等级 ${settings.thinking}` : ''}`);
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
