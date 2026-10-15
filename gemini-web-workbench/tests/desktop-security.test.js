const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { requireLocalSiteUrl, isMainNavigationAllowed, shouldInjectDesktopToken, desktopRequestHeaders, isGeminiPopupAllowed, protectMainNavigation, protectGeminiNavigation, isIpcSourceAllowed, securedIpcHandle, isJobResultSourceAllowed } = require('../src/desktop-security');
const context = { mainId: 10, siteUrl: 'http://127.0.0.1:4173', bootUrl: 'file:///C:/FlowCut/boot.html', publisherOrigin: 'http://127.0.0.1:18776', geminiIds: [20, 21] };
class Contents extends EventEmitter { setWindowOpenHandler(handler) { this.open = handler; } }
function navigation(contents, name, url, isMainFrame = true) {
  const event = { url, isMainFrame, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  contents.emit(name, event); return event.defaultPrevented;
}

test('local site validation rejects foreign hosts and protocols before callers can use credentials', () => {
  for (const url of ['http://127.0.0.1:4173', 'http://localhost:4198', 'https://localhost:444']) assert.ok(requireLocalSiteUrl(url));
  for (const url of ['https://example.test', 'http://127.0.0.1.example.test', 'http://localhost.example.test', 'file://localhost/file', 'javascript:alert(1)', 'http://user:secret@localhost', 'not a URL']) assert.throws(() => requireLocalSiteUrl(url));
});
test('main navigation permits only its site, exact boot file and publisher subframe', () => {
  assert.equal(isMainNavigationAllowed('http://127.0.0.1:4173/api/tasks', context), true);
  assert.equal(isMainNavigationAllowed('file:///C:/FlowCut/boot.html?error=fixture', context), true);
  assert.equal(isMainNavigationAllowed('http://127.0.0.1:18776/', context, false), true);
  assert.equal(isMainNavigationAllowed('http://127.0.0.1:18776/', context, true), false);
  for (const url of ['http://127.0.0.1:9999', 'http://localhost:4173', 'https://example.test', 'file:///C:/FlowCut/other.html', 'data:text/html,fixture', 'bytedance://login']) assert.equal(isMainNavigationAllowed(url, context), false, url);
  assert.equal(isMainNavigationAllowed('http://127.0.0.1:18777', { ...context, publisherOrigin: 'http://127.0.0.1:18777' }, false), true);
});
test('token injection is limited to two origins and the current main webContents', () => {
  for (const url of ['http://127.0.0.1:4173/api/tasks', 'http://127.0.0.1:18776/api/status']) {
    assert.equal(shouldInjectDesktopToken({ url, webContentsId: 10 }, context), true);
    assert.equal(shouldInjectDesktopToken({ url, webContentsId: 20 }, context), false);
  }
  for (const url of ['http://127.0.0.1:9999', 'http://localhost:18776', 'https://127.0.0.1:4173', 'https://example.test', 'http://127.0.0.1:18777']) assert.equal(shouldInjectDesktopToken({ url, webContentsId: 10 }, context), false);
});
test('cross-origin redirects and foreign windows cannot retain a previously injected token', () => {
  const requestHeaders = { 'X-FlowCut-Desktop-Token': 'secret', Accept: 'application/json' };
  const foreign = desktopRequestHeaders({ requestHeaders, url: 'https://example.test', webContentsId: 10 }, context, 'secret');
  assert.deepEqual(foreign, { Accept: 'application/json' }); assert.equal(requestHeaders['X-FlowCut-Desktop-Token'], 'secret');
  const allowed = desktopRequestHeaders({ requestHeaders, url: context.siteUrl, webContentsId: 10 }, context, 'fresh');
  assert.deepEqual(allowed, { Accept: 'application/json', 'x-flowcut-desktop-token': 'fresh' });
});
test('Gemini popup allowlist accepts only necessary HTTPS Google hosts', () => {
  for (const url of ['https://gemini.google.com/gem/test', 'https://accounts.google.com/signin', 'https://myaccount.google.com/', 'https://consent.google.com/', 'https://www.google.com/']) assert.equal(isGeminiPopupAllowed(url), true);
  for (const url of ['http://accounts.google.com/', 'https://accounts.google.com.evil.test/', 'https://evil.test@accounts.google.com/', 'https://accounts.google.com:444/', 'about:blank', 'file:///C:/file', 'bytedance://login', 'https://example.test']) assert.equal(isGeminiPopupAllowed(url), false);
});

test('YouTube account login is allowed while arbitrary hosts and lookalikes remain blocked', () => {
  assert.equal(isGeminiPopupAllowed('https://accounts.youtube.com/SetSID?token=fixture'), true);
  for (const url of ['https://youtube.com/', 'https://www.youtube.com/', 'https://accounts.youtube.com.evil.test/', 'https://other.test/', 'http://accounts.youtube.com/']) assert.equal(isGeminiPopupAllowed(url), false);
  const contents = new Contents(), navigated = [], hosts = [];
  protectGeminiNavigation(contents, url => navigated.push(url), host => hosts.push(host));
  assert.equal(navigation(contents, 'will-redirect', 'https://accounts.youtube.com/SetSID?token=fixture'), false);
  contents.open({ url: 'https://accounts.youtube.com/SetSID?token=fixture' });
  assert.equal(navigated.length, 1); assert.deepEqual(hosts, []);
});

test('Gemini block logging receives hostname only for redirects, popups and native protocols', () => {
  const contents = new Contents(), hosts = [];
  protectGeminiNavigation(contents, () => {}, host => hosts.push(host));
  const secretUrl = 'https://username:secret-password@blocked.test/private-signin?token=secret-token#secret-fragment';
  navigation(contents, 'will-redirect', secretUrl);
  contents.open({ url: secretUrl });
  navigation(contents, 'will-frame-navigate', 'custom-app://native-host/private?token=secret-token', false);
  contents.open({ url: 'data:text/html,secret-token' });
  assert.deepEqual(hosts, ['blocked.test', 'blocked.test', 'native-host', '（无主机名）']);
  assert.ok(hosts.every(host => !/[/?#:@]/.test(host) && !host.includes('secret')));
});
test('all three main navigation events are guarded and new windows are always denied', () => {
  const contents = new Contents(), external = [];
  protectMainNavigation(contents, () => context, url => external.push(url));
  for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    assert.equal(navigation(contents, event, context.siteUrl), false);
    assert.equal(navigation(contents, event, 'file:///C:/other.html'), true);
  }
  assert.equal(navigation(contents, 'will-frame-navigate', context.publisherOrigin, false), false);
  assert.equal(contents.open({ url: 'https://example.test/docs' }).action, 'deny');
  assert.deepEqual(external, ['https://example.test/docs']);
  assert.equal(contents.open({ url: 'bytedance://open' }).action, 'deny'); assert.equal(external.length, 1);
});
test('Gemini keeps Google popups in its own window and blocks native protocols in subframes', () => {
  const contents = new Contents(), navigated = []; let blocked = 0;
  protectGeminiNavigation(contents, url => navigated.push(url), () => blocked++);
  assert.equal(contents.open({ url: 'https://accounts.google.com/signin' }).action, 'deny');
  assert.deepEqual(navigated, ['https://accounts.google.com/signin']);
  assert.equal(contents.open({ url: 'https://example.test' }).action, 'deny');
  assert.equal(navigation(contents, 'will-frame-navigate', 'bytedance://login', false), true);
  assert.equal(navigation(contents, 'will-redirect', 'https://example.test', true), true);
  assert.equal(navigation(contents, 'will-frame-navigate', 'https://www.google.com/recaptcha', false), false);
  assert.equal(blocked, 3);
});
test('business IPC is main-only, Gemini IPC is execution-window-only, and unknown channels fail closed', () => {
  for (const prefix of ['workbench', 'account', 'seedance', 'video-review', 'publisher', 'tasks', 'gem', 'archive', 'update']) {
    assert.equal(isIpcSourceAllowed(prefix + ':test', 10, context), true);
    assert.equal(isIpcSourceAllowed(prefix + ':test', 20, context), false);
  }
  assert.equal(isIpcSourceAllowed('gemini:select-model', 20, context), true);
  assert.equal(isIpcSourceAllowed('gemini:select-model', 10, context), false);
  assert.equal(isIpcSourceAllowed('unknown:method', 10, context), false);
  assert.equal(isIpcSourceAllowed('gemini:job-result', 99, context), false);
});
test('secured handler registration checks the live source before calling any business code', () => {
  const handlers = {}, ipc = { handle: (name, handler) => { handlers[name] = handler; } };
  let current = context, calls = 0;
  const handle = securedIpcHandle(ipc, () => current);
  handle('account:remove', (_event, value) => { calls++; return value; });
  handle('gemini:select-model', () => 'selected');
  assert.throws(() => handlers['account:remove']({ sender: { id: 20 } }, 'private-account'), { code: 'IPC_SOURCE_DENIED' }); assert.equal(calls, 0);
  assert.equal(handlers['account:remove']({ sender: { id: 10 } }, 'fixture'), 'fixture'); assert.equal(calls, 1);
  assert.equal(handlers['gemini:select-model']({ sender: { id: 20 } }), 'selected');
  current = { ...context, geminiIds: [21] };
  assert.throws(() => handlers['gemini:select-model']({ sender: { id: 20 } }), { code: 'IPC_SOURCE_DENIED' });
});
test('job results must match the exact pending webContents, including internal protected execution', () => {
  assert.equal(isJobResultSourceAllowed(20, 20), true);
  for (const id of [10, 21, 0, undefined, '20']) assert.equal(isJobResultSourceAllowed(id, 20), false);
  assert.equal(isJobResultSourceAllowed(20, undefined), false);
});
