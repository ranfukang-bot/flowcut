const test = require('node:test');
const assert = require('node:assert/strict');
const { chromeUserAgent } = require('../src/chrome-user-agent');

test('browser identity follows the bundled Chromium version and retains its compatibility token', () => {
  for (const version of ['150.0.7871.129', '151.0.1.2']) {
    const ua = chromeUserAgent(version);
    assert.ok(ua.includes(`(KHTML, like Gecko) Chrome/${version} Safari/537.36`));
    assert.doesNotMatch(ua, /Electron|142\.0\.0\.0|undefined/);
  }
  assert.throws(() => chromeUserAgent(undefined), /unavailable/);
});
