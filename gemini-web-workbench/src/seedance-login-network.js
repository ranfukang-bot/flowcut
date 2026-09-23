const LOGIN_URL = 'https://ads.tiktok.com/creative/creativestudio/create';

async function configureLoginSession(session, { reconnect = false } = {}) {
  const chrome = process.versions.chrome || session.getUserAgent?.().match(/Chrome\/([\d.]+)/)?.[1];
  if (chrome) session.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`, 'en-US,en');
  // Follow the same Windows proxy as the user's regular browser, including after VPN changes.
  await session.setProxy({ mode: 'system' });
  if (reconnect) {
    await session.clearHostResolverCache();
    await session.closeAllConnections();
  }
}

function loginRequest(details) {
  let url;
  try { url = new URL(details.url); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname;
  if (!/(^|\.)(?:tiktok\.com|byteoversea\.com|bytedance\.com)$/.test(host)) return null;
  const mainFrame = details.resourceType === 'mainFrame';
  const api = !details.resourceType || ['xhr', 'fetch', 'other', 'subFrame'].includes(details.resourceType);
  const authEndpoint = /(?:^|\/)(?:passport|captcha|verify|login|oauth)(?:\/|$)/i.test(url.pathname);
  const verifyHost = /^verify(?:[-.])/.test(host);
  if (!mainFrame && !(api && (verifyHost || authEndpoint))) return null;
  // 不保留查询参数：其中可能带有登录凭据。仅匹配同一个失败接口的恢复。
  return { host, key: `${details.method || 'GET'} ${url.origin}${url.pathname}`, mainFrame };
}

function networkFailureMessage(details) {
  const request = loginRequest(details);
  if (!request) return '';
  if (details.error === 'net::ERR_ABORTED') return '';
  const error = details.error && details.error !== 'net::OK'
    ? (String(details.error).match(/net::ERR_[A-Z_]+/)?.[0] || '连接失败')
    : (details.statusCode >= 400 ? `HTTP ${details.statusCode}` : '');
  return error ? `${request.mainFrame ? '登录页面' : '登录验证接口'}请求失败：${request.host} · ${error}。仅代表该请求失败，不代表电脑断网；可点击“重连登录”后重试。` : '';
}

function createLoginNetworkReporter({ runtime, log, onChange }) {
  return details => {
    const request = loginRequest(details);
    if (!request) return;
    const message = networkFailureMessage(details);
    if (message) {
      const changed = runtime.loginNetworkError !== message;
      runtime.loginNetworkError = message;
      runtime.loginNetworkFailureKey = request.key;
      if (changed) { log(message); onChange(); }
    } else if ((!details.error || details.error === 'net::OK') &&
      details.statusCode >= 200 && details.statusCode < 300 &&
      runtime.loginNetworkFailureKey === request.key) {
      runtime.loginNetworkFailureKey = '';
      if (runtime.loginNetworkError) {
        runtime.loginNetworkError = '';
        onChange();
      }
    }
  };
}
module.exports = { LOGIN_URL, configureLoginSession, networkFailureMessage, createLoginNetworkReporter };
