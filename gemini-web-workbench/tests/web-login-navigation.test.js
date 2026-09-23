const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { isWebNavigation, protectLoginNavigation } = require('../src/web-login-navigation');
class Contents extends EventEmitter {
  setWindowOpenHandler(handler) { this.open = handler; }
}
test('native app schemes are denied while browser login navigation is retained', () => {
  for (const url of ['bytedance://login?token=private', 'ByTeDaNcE:login', 'intent://login', 'microsoft-store://page', 'file:///C:/file']) assert.equal(isWebNavigation(url), false, url);
  for (const url of ['https://ads.tiktok.com/i18n/login', 'https://accounts.google.com/', 'about:blank', 'about:srcdoc', 'blob:https://ads.tiktok.com/id', 'data:text/html,frame']) assert.equal(isWebNavigation(url), true, url);
});
test('same-window redirects, hidden frames and recursively opened windows are protected', () => {
  const parent = new Contents(); let blocked = 0;
  const options = { webPreferences: { session: 'account-session' } };
  protectLoginNavigation(parent, options, () => blocked++);
  protectLoginNavigation(parent, options);
  assert.equal(parent.listenerCount('will-navigate'), 1);
  for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    let prevented = false;
    parent.emit(event, { url: 'bytedance://login', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    parent.emit(event, { url: 'https://ads.tiktok.com/page', preventDefault() { throw new Error('normal login blocked'); } });
  }
  assert.equal(parent.open({ url: 'bytedance://open' }).action, 'deny');
  assert.deepEqual(parent.open({ url: 'https://accounts.google.com/' }), { action: 'allow', overrideBrowserWindowOptions: options });
  assert.equal(parent.open({ url: 'about:blank' }).action, 'allow');
  const child = new Contents(), grandchild = new Contents();
  parent.emit('did-create-window', { webContents: child });
  child.emit('did-create-window', { webContents: grandchild });
  let prevented = false;
  grandchild.emit('will-frame-navigate', { preventDefault() { prevented = true; } }, 'bytedance://open');
  assert.equal(prevented, true); assert.equal(blocked, 5);
});
