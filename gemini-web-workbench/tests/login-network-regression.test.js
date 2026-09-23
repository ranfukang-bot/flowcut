const test = require('node:test');
const assert = require('node:assert/strict');
const { networkFailureMessage, createLoginNetworkReporter } = require('../src/seedance-login-network');

const login = { url: 'https://ads.tiktok.com/creative/creativestudio/create', resourceType: 'mainFrame' };
const verify = { url: 'https://verify-sg.byteoversea.com/captcha/verify?token=SECRET', resourceType: 'xhr' };

test('附带资源失败不能变成登录故障，包括截图里的遥测域名', () => {
  for (const resourceType of ['ping', 'script', 'image', 'font', 'stylesheet', 'xhr']) {
    for (const url of ['https://tsr16-normal-useast1a.tiktok.com/event', 'https://ads.tiktok.com/optional.js']) {
      assert.equal(networkFailureMessage({ url, resourceType, error: 'net::ERR_CONNECTION_CLOSED' }), '');
    }
  }
  assert.equal(networkFailureMessage({ url: 'https://verify-sg.byteoversea.com/logo.png', resourceType: 'image', statusCode: 500 }), '');
});

test('真实登录页面和验证接口失败仍告警，取消导航不告警，不泄露查询参数', () => {
  assert.match(networkFailureMessage({ ...login, error: 'net::ERR_EMPTY_RESPONSE' }), /ERR_EMPTY_RESPONSE/);
  for (const statusCode of [401, 403, 429, 500, 503]) {
    const message = networkFailureMessage({ ...verify, statusCode });
    assert.match(message, new RegExp(`HTTP ${statusCode}`));
    assert.doesNotMatch(message, /SECRET|token=|5101/);
  }
  assert.equal(networkFailureMessage({ ...login, error: 'net::ERR_ABORTED' }), '');
  assert.equal(networkFailureMessage({ ...verify, statusCode: 200 }), '');
});

test('同一登录请求恢复才清旧告警，其他成功请求不能掩盖它', () => {
  const runtime = { authenticated: true };
  const logs = [], changes = [];
  const report = createLoginNetworkReporter({ runtime, log: message => logs.push(message), onChange: () => changes.push(1) });
  report({ ...verify, statusCode: 500 });
  assert.match(runtime.loginNetworkError, /HTTP 500/);
  report({ ...verify, statusCode: 500 });
  assert.equal(logs.length, 1);
  report({ ...login, statusCode: 200 });
  report({ url: 'https://ads.tiktok.com/optional.js', resourceType: 'script', statusCode: 200 });
  assert.match(runtime.loginNetworkError, /HTTP 500/);
  report({ ...verify, url: verify.url.replace('SECRET', 'NEW_SECRET'), statusCode: 200 });
  assert.equal(runtime.loginNetworkError, '');
  assert.equal(runtime.authenticated, true, '诊断不能改账号登录状态');
  assert.equal(changes.length, 2);
});
