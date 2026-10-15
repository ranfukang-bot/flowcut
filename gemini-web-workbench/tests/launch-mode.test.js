const test = require('node:test');
const assert = require('node:assert/strict');
const { desktopLaunchMode } = require('../src/launch-mode');

for (const isolated of [false, true]) for (const report of [false, true]) {
  test(`launch flags: isolated=${isolated}, report=${report}`, () => {
    const mode = desktopLaunchMode({ FLOWCUT_SMOKE_USER_DATA: isolated ? 'C:/temporary/profile' : '', FLOWCUT_DESKTOP_SMOKE_FILE: report ? 'C:/temporary/result.json' : '' });
    assert.equal(mode.isolated, isolated);
    assert.equal(mode.automaticSmoke, isolated && report);
    assert.equal(mode.showMainWindow, !(isolated && report));
    assert.equal(mode.smokeFile, isolated && report ? 'C:/temporary/result.json' : '');
    assert.equal(mode.siteUrl, isolated ? 'http://127.0.0.1:4198' : '');
    assert.equal(mode.publisherPort, isolated ? 18777 : 18776);
  });
}
test('empty flags behave as unset and interactive isolation uses separate ports', () => {
  assert.equal(desktopLaunchMode({ FLOWCUT_SMOKE_USER_DATA: ' ', FLOWCUT_DESKTOP_SMOKE_FILE: 'report' }).automaticSmoke, false);
  const normal = desktopLaunchMode({}), manual = desktopLaunchMode({ FLOWCUT_SMOKE_USER_DATA: 'temporary' });
  assert.equal(manual.showMainWindow, true);
  assert.notEqual(manual.publisherPort, normal.publisherPort);
  assert.notEqual(manual.siteUrl, 'http://127.0.0.1:4173');
});
