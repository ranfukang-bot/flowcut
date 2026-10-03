const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { SavedGems, cleanGemUrl, gemVersion, createGemDriver, GEM_FIELDS } = require('../src/saved-gems');
const gem = { id: 'template-1', name: '开箱', content: '只输出文字视频提示词。\n产品保持一致。' };
const url = 'https://gemini.google.com/gem/abc123';
function editorContext(fields, location) {
  return vm.createContext({ document: { querySelector: s => fields[s], createRange: () => ({ selectNodeContents() {} }) },
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) }, location });
}
function fixture() {
  let disk, writable = true, saves = 0;
  const store = { state: { accounts: [{ id: 'a' }, { id: 'b' }] }, save() {
    saves++;
    if (!writable) return false;
    disk = structuredClone(this.state); return true;
  } };
  store.save();
  let prepared = 0, submitted = 0;
  const driver = { async prepare() { prepared++; }, async save() { submitted++; return url; } };
  return { store, driver, manager: new SavedGems(store), disk: () => disk,
    writable: value => { writable = value; }, counts: () => ({ prepared, submitted, saves }) };
}
test('first use creates and saves once; reuse and restart use the saved Gem', async () => {
  const f = fixture();
  assert.equal(await f.manager.ensure('a', gem, f.driver), url);
  assert.equal(await f.manager.ensure('a', gem, f.driver), url);
  f.store.state = structuredClone(f.disk());
  assert.equal(await new SavedGems(f.store).ensure('a', gem, f.driver), url);
  assert.equal(f.counts().submitted, 1);
});
test('account and instruction version isolate bindings; name-only change reuses it', async () => {
  const f = fixture();
  await f.manager.ensure('a', gem, f.driver);
  await f.manager.ensure('a', { ...gem, name: '改名' }, f.driver);
  await f.manager.ensure('b', gem, f.driver);
  await f.manager.ensure('a', { ...gem, content: '另一版指令' }, f.driver);
  assert.equal(f.counts().submitted, 3);
  assert.equal(Object.keys(f.store.state.accounts[0].gemBindings).length, 2);
});
test('disk failure before Save prevents remote creation', async () => {
  const f = fixture(); f.writable(false);
  await assert.rejects(f.manager.ensure('a', gem, f.driver), /无法保存/);
  assert.equal(f.counts().submitted, 0);
});
test('ambiguous save is held across restart, never blindly creates twice; manual URL resolves it', async () => {
  const f = fixture();
  f.driver.save = async () => { throw new Error('response lost'); };
  await assert.rejects(f.manager.ensure('a', gem, f.driver), /response lost/);
  f.store.state = structuredClone(f.disk());
  const manager = new SavedGems(f.store);
  await assert.rejects(manager.ensure('a', gem, f.driver), /待核对/);
  manager.bind('a', gem, url);
  assert.equal(await manager.ensure('a', gem, f.driver), url);
  assert.equal(f.counts().prepared, 1);
});
test('form failure before saving can retry safely', async () => {
  const f = fixture();
  await assert.rejects(f.manager.ensure('a', gem, { prepare: async () => { throw Error('form'); } }), { code: 'GEM_SETUP_RETRYABLE' });
  assert.equal(f.manager.get('a', gem), null);
  await f.manager.ensure('a', gem, f.driver);
  assert.equal(f.counts().submitted, 1);
});
test('failed final local save never submits the product and never recreates remotely', async () => {
  const f = fixture();
  f.driver.save = async () => { f.writable(false); return url; };
  await assert.rejects(f.manager.ensure('a', gem, f.driver), /无法保存/);
  f.writable(true);
  assert.equal(await f.manager.ensure('a', gem, f.driver), url);
  assert.equal(f.counts().prepared, 1);
});
test('concurrent setup and manual binding cannot steal the same account', async () => {
  const f = fixture(); let release;
  const pending = f.manager.ensure('a', gem, { prepare: () => new Promise(r => { release = r; }), save: async () => url });
  await assert.rejects(f.manager.ensure('a', gem, f.driver), /正在创建/);
  assert.throws(() => f.manager.bind('a', gem, url), /正在创建/);
  release(); await pending;
});
test('links are restricted to saved Gem home, never ordinary chat, edit, or external origins', () => {
  assert.equal(cleanGemUrl(url + '/?x=1#test'), url);
  for (const value of ['https://gemini.google.com/app/123', 'https://gemini.google.com/gems/edit/123', 'https://gemini.google.com/gem/id/chat', 'https://evil.test/gem/123', 'https://gemini.google.com.evil.test/gem/123', 'http://gemini.google.com/gem/123', 'https://x@gemini.google.com/gem/123']) {
    assert.throws(() => cleanGemUrl(value), { code: 'GEM_SETUP_REQUIRED' });
  }
  assert.throws(() => gemVersion({ id: 'x', content: '' }), { code: 'GEM_SETUP_REQUIRED' });
});

// Execute real driver scripts against the observed editor DOM shape. Preview
// and model controls are traps: touching either must fail this test.
test('creation driver fills actual instruction editor and waits for save confirmation', async () => {
  let focused, clicks = 0;
  const location = { pathname: '/gems/create' };
  const fields = {};
  fields[GEM_FIELDS.name] = { value: '', focus() { focused = this; } };
  fields[GEM_FIELDS.instructions] = { innerText: '', focus() { focused = this; } };
  fields[GEM_FIELDS.save] = { disabled: false, getAttribute: () => null, click() {
    clicks++; location.pathname = '/gems/edit/abc123';
    fields['bot-creation-confirmation-dialog [data-test-id="new-conversation-button"]'] = {};
  } };
  const context = editorContext(fields, location);
  const window = { isDestroyed: () => false, loadURL: async value => { assert.equal(value, 'https://gemini.google.com/gems/create'); }, webContents: {
    executeJavaScript: async code => vm.runInContext(code, context),
    sendInputEvent: () => {},
    // Observed on the real Quill editor: P blocks introduce extra blank lines.
    insertText: async value => { if ('value' in focused) focused.value = value; else focused.innerText = value.replace(/\n/g, '\n\n'); },
  } };
  const driver = createGemDriver(window);
  await driver.prepare({ name: gem.name, content: gem.content });
  assert.equal(fields[GEM_FIELDS.instructions].innerText, gem.content.replace(/\n/g, '\n\n'));
  assert.equal(await driver.save(), url);
  assert.equal(clicks, 1);
});

test('editor verification rejects incomplete instructions before Save', async () => {
  let focused, clicks = 0;
  const fields = {
    [GEM_FIELDS.name]: { value: '', focus() { focused = this; } },
    [GEM_FIELDS.instructions]: { innerText: '', focus() { focused = this; } },
    [GEM_FIELDS.save]: { disabled: false, click() { clicks++; } },
  };
  const context = editorContext(fields);
  const window = { isDestroyed: () => false, loadURL: async () => {}, webContents: {
    executeJavaScript: async code => vm.runInContext(code, context), sendInputEvent: () => {},
    insertText: async value => { if ('value' in focused) focused.value = value; else focused.innerText = value.slice(0, -3); },
  } };
  await assert.rejects(createGemDriver(window, { timeoutMs: 20, sleep: () => new Promise(r => setTimeout(r, 5)) }).prepare({ name: gem.name, content: gem.content }), /核对 Gem 指令填写超时/);
  assert.equal(clicks, 0);
});

test('transient partial fill is replaced and verified before one Save', async () => {
  let focused, fills = 0, saves = 0, selected;
  const fields = {
    [GEM_FIELDS.name]: { value: '', focus() { focused = this; }, select() { selected = this; } },
    [GEM_FIELDS.instructions]: { innerText: '', focus() { focused = this; } },
    [GEM_FIELDS.save]: { disabled: false, getAttribute: () => null, click() {
      saves++; location.pathname = '/gems/edit/abc123';
      fields['bot-creation-confirmation-dialog [data-test-id="new-conversation-button"]'] = {};
    } },
  };
  const location = { pathname: '/gems/create' };
  const context = editorContext(fields, location);
  context.document.createRange = () => ({ selectNodeContents(el) { selected = el; } });
  const window = { isDestroyed: () => false, loadURL: async () => {}, webContents: {
    executeJavaScript: async code => vm.runInContext(code, context),
    sendInputEvent() { throw Error('must not rely on native Ctrl+A'); },
    insertText: async value => {
      assert.equal(selected, focused, 'replace the full field, never append');
      if ('value' in focused) focused.value = value;
      else { fills++; focused.innerText = fills === 1 ? value.slice(0, -3) : value; }
    },
  } };
  const f = fixture();
  const driver = createGemDriver(window, { timeoutMs: 100, verifyMs: 5, sleep: () => new Promise(r => setTimeout(r, 2)) });
  assert.equal(await f.manager.ensure('a', gem, driver), url);
  assert.equal(fills, 2);
  assert.equal(saves, 1);
});

test('editor changed after fill must not click Save or leave saving intent', async () => {
  let focused;
  const fields = {
    [GEM_FIELDS.name]: { value: '', focus() { focused = this; } },
    [GEM_FIELDS.instructions]: { innerText: '', focus() { focused = this; } },
    [GEM_FIELDS.save]: { disabled: false, getAttribute() { fields[GEM_FIELDS.instructions].innerText = ''; return null; }, click() { throw Error('must not save'); } },
  };
  const context = editorContext(fields);
  const window = { isDestroyed: () => false, loadURL: async () => {}, webContents: {
    executeJavaScript: async code => vm.runInContext(code, context),
    insertText: async value => { if ('value' in focused) focused.value = value; else focused.innerText = value; },
  } };
  const f = fixture();
  await assert.rejects(f.manager.ensure('a', gem, createGemDriver(window)), { code: 'GEM_SETUP_RETRYABLE' });
  assert.equal(f.manager.get('a', gem), null);
});

test('uncertain Save never becomes a pre-save automatic retry', async () => {
  const f = fixture(); let saves = 0;
  f.driver.save = async () => { saves++; throw Error('response lost'); };
  await assert.rejects(f.manager.ensure('a', gem, f.driver));
  await assert.rejects(f.manager.ensure('a', gem, f.driver), { code: 'GEM_SETUP_REQUIRED' });
  assert.equal(saves, 1);
});

test('lost save confirmation recovers the persisted Gem without another Save', async () => {
  const f = fixture(); let saves = 0, lookups = 0;
  f.driver.save = async () => { saves++; throw Error('confirmation missing'); };
  f.driver.findSaved = async input => {
    lookups++;
    assert.equal(input.name, `${gem.name} · FlowCut ${gemVersion(gem).slice(0, 8)}`);
    assert.equal(input.content, gem.content);
    return url;
  };
  assert.equal(await f.manager.ensure('a', gem, f.driver), url);
  assert.equal(f.manager.get('a', gem).source, 'recovered');
  f.store.state = structuredClone(f.disk());
  assert.equal(await new SavedGems(f.store).ensure('a', gem, f.driver), url);
  assert.equal(saves, 1); assert.equal(lookups, 1);
});

test('saving state after restart checks the original name even if the template was renamed', async () => {
  const f = fixture();
  f.driver.save = async () => { throw Error('response lost'); };
  await assert.rejects(f.manager.ensure('a', gem, f.driver));
  f.store.state = structuredClone(f.disk());
  const originalName = f.manager.get('a', gem).name;
  const reader = { async findSaved({ name, content }) {
    assert.equal(name, originalName); assert.equal(content, gem.content); return url;
  } };
  assert.equal(await new SavedGems(f.store).ensure('a', { ...gem, name: 'renamed' }, reader), url);
  assert.equal(f.manager.get('b', gem), null);
  assert.equal(f.counts().prepared, 1);
});

test('failed recovery preserves saving intent and never prepares or submits again', async () => {
  for (const lookup of [async () => null, async () => { throw Error('mismatch or unavailable'); }, async () => 'https://evil.test/gem/a']) {
    const f = fixture();
    f.driver.save = async () => { throw Error('lost'); };
    await assert.rejects(f.manager.ensure('a', gem, f.driver));
    const record = structuredClone(f.manager.get('a', gem));
    f.driver.findSaved = lookup;
    await assert.rejects(f.manager.ensure('a', gem, f.driver), { code: 'GEM_SETUP_REQUIRED' });
    assert.deepEqual(f.manager.get('a', gem), record);
    assert.equal(f.counts().prepared, 1);
  }
});

test('recovered URL must be persisted before returning it to a task', async () => {
  const f = fixture();
  f.driver.save = async () => { throw Error('lost'); };
  await assert.rejects(f.manager.ensure('a', gem, f.driver));
  f.driver.findSaved = async () => url;
  f.writable(false);
  await assert.rejects(f.manager.ensure('a', gem, f.driver), /无法保存/);
  f.writable(true);
  assert.equal(await f.manager.ensure('a', gem, f.driver), url);
  assert.equal(f.counts().prepared, 1);
});

function recoveryPage({ cards = [{ name: gem.name, href: '/gem/abc123' }], name = gem.name, content = gem.content, redirect } = {}) {
  const location = { origin: 'https://gemini.google.com', pathname: '/gems/view' };
  const fields = {
    [GEM_FIELDS.name]: { value: name },
    [GEM_FIELDS.instructions]: { innerText: content.replace(/\n/g, '\n\n') },
  };
  const context = editorContext(fields, location);
  context.URL = URL;
  context.document.querySelectorAll = selector => {
    assert.equal(selector, '.bot-list-row-container');
    return cards.map(card => ({ querySelector(s) {
      if (s === 'a.bot-row[href]') return {
        querySelector: s => { assert.equal(s, '.title'); return { textContent: card.name }; },
        getAttribute: s => { assert.equal(s, 'href'); return card.href; },
      };
      if (s === '[data-test-id="edit-button-tooltip"] button') return card.editable === false ? null : {};
      throw Error(`unexpected selector: ${s}`);
    } }));
  };
  const loads = [];
  return { loads, driver: createGemDriver({
    isDestroyed: () => false,
    async loadURL(value) { loads.push(value); const next = new URL(redirect || value); location.origin = next.origin; location.pathname = next.pathname; },
    webContents: { executeJavaScript: async code => vm.runInContext(code, context),
      insertText() { throw Error('recovery must not edit'); } },
  }, { timeoutMs: 30, sleep: () => new Promise(r => setTimeout(r, 2)) }) };
}

test('read-only recovery reloads manager then verifies full persisted editor content', async () => {
  const { driver, loads } = recoveryPage();
  assert.equal(await driver.findSaved({name:gem.name, content:gem.content}), url);
  assert.deepEqual(loads, ['https://gemini.google.com/gems/view', 'https://gemini.google.com/gems/edit/abc123']);
});

for (const [scenario, options] of Object.entries({
  absent: { cards: [] },
  'similar name': { cards: [{name:gem.name + ' extra', href:'/gem/abc123'}] },
  'external URL': { cards: [{name:gem.name, href:'https://evil.test/gem/abc123'}] },
  'ordinary chat': { cards: [{name:gem.name, href:'/app/abc123'}] },
  'not editable': { cards: [{name:gem.name, href:'/gem/abc123', editable:false}] },
  duplicates: { cards: [{name:gem.name, href:'/gem/abc123'},{name:gem.name, href:'/gem/other'}] },
  'changed instructions': { content: gem.content.slice(0,-3) },
  'changed name': { name: 'different' },
  'wrong account/login redirect': { redirect: 'https://accounts.google.com/login' },
})) {
  test(`recovery refuses ${scenario} without editing or saving`, async () => {
    const {driver} = recoveryPage(options);
    await assert.rejects(driver.findSaved({name:gem.name, content:gem.content}), { code:'GEM_SETUP_REQUIRED' });
  });
}

const source = fs.readFileSync(require.resolve('../src/gemini-preload.js'), 'utf8');
const resetSource = source.slice(source.indexOf('async function ensureFreshConversation('), source.indexOf('function uploadProcessingVisible()'));
for (const scenario of [
  { path: '/gem/abc123', content: false, generating: false, pass: true },
  { path: '/app', content: false },
  { path: '/gem/different', content: false },
  { path: '/gem/abc123', content: true },
  { path: '/gem/abc123', generating: true },
]) {
  test(`Gem conversation guard: ${JSON.stringify(scenario)}`, async () => {
    const context = vm.createContext({ URL, location: { origin: 'https://gemini.google.com', pathname: scenario.path },
      conversationHasContent: () => scenario.content, generationInProgress: () => scenario.generating,
      codedError: (message, code) => Object.assign(Error(message), { code }),
      all() { throw Error('must not click generic New chat or model picker'); },
    });
    vm.runInContext(resetSource, context);
    if (scenario.pass) await context.ensureFreshConversation(url);
    else await assert.rejects(context.ensureFreshConversation(url), { code: 'GEM_SETUP_REQUIRED' });
  });
}
