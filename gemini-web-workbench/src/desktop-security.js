const { protectLoginNavigation } = require('./web-login-navigation');

const GOOGLE_LOGIN_HOSTS = Object.freeze(['gemini.google.com', 'accounts.google.com', 'myaccount.google.com', 'consent.google.com', 'www.google.com']);
const MAIN_CHANNEL_PREFIXES = ['workbench:', 'account:', 'seedance:', 'video-review:', 'publisher:', 'tasks:', 'gem:', 'archive:', 'update:'];

function requireLocalSiteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('FlowCut 本机地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error('桌面完整版本只允许使用 127.0.0.1 / localhost 的本机 FlowCut 地址');
  return url;
}

function publisherOrigin(context) {
  try {
    const url = requireLocalSiteUrl(context.publisherOrigin);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && ['18776', '18777'].includes(url.port) ? url.origin : '';
  } catch { return ''; }
}

function isMainNavigationAllowed(value, context, isMainFrame = true) {
  try {
    const url = new URL(value), boot = new URL(context.bootUrl);
    if (url.protocol === 'file:' && url.host === boot.host && url.pathname === boot.pathname) return true;
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    if (!isMainFrame && url.origin === publisherOrigin(context)) return true;
    return url.origin === requireLocalSiteUrl(context.siteUrl).origin;
  } catch { return false; }
}

function shouldInjectDesktopToken(details, context) {
  if (!Number.isInteger(context.mainId) || details.webContentsId !== context.mainId) return false;
  try {
    const url = new URL(details.url);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return false;
    return url.origin === requireLocalSiteUrl(context.siteUrl).origin || url.origin === publisherOrigin(context);
  } catch { return false; }
}

function desktopRequestHeaders(details, context, token) {
  const headers = { ...details.requestHeaders };
  // Remove a token carried over by a redirect, including alternate casing.
  for (const name of Object.keys(headers)) if (name.toLowerCase() === 'x-flowcut-desktop-token') delete headers[name];
  if (shouldInjectDesktopToken(details, context)) headers['x-flowcut-desktop-token'] = token;
  return headers;
}

function isGeminiPopupAllowed(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && GOOGLE_LOGIN_HOSTS.includes(url.hostname);
  } catch { return false; }
}

function navigationInfo(event, legacyUrl, legacyFrame, name) {
  return { url: event.url || legacyUrl, isMainFrame: event.isMainFrame ?? legacyFrame ?? (name !== 'will-frame-navigate') };
}

function protectMainNavigation(contents, getContext, openExternal) {
  const openHttps = value => {
    try { const url = new URL(value); if (url.protocol === 'https:') openExternal(url.href)?.catch?.(() => {}); } catch { /* No external app protocols. */ }
  };
  for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    contents.on(name, (event, legacyUrl, _inPlace, legacyFrame) => {
      const { url, isMainFrame } = navigationInfo(event, legacyUrl, legacyFrame, name);
      if (isMainNavigationAllowed(url, getContext(), isMainFrame)) return;
      event.preventDefault();
      if (isMainFrame) openHttps(url);
    });
  }
  contents.setWindowOpenHandler(({ url }) => { openHttps(url); return { action: 'deny' }; });
}

function protectGeminiNavigation(contents, navigate, onBlocked = () => {}) {
  protectLoginNavigation(contents, { webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } }, onBlocked);
  for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    contents.on(name, (event, legacyUrl, _inPlace, legacyFrame) => {
      if (event.defaultPrevented) return;
      const { url, isMainFrame } = navigationInfo(event, legacyUrl, legacyFrame, name);
      if (!isMainFrame || isGeminiPopupAllowed(url)) return;
      event.preventDefault(); onBlocked();
    });
  }
  contents.setWindowOpenHandler(({ url }) => {
    if (isGeminiPopupAllowed(url)) navigate(url);
    else onBlocked();
    return { action: 'deny' };
  });
}

function isIpcSourceAllowed(channel, senderId, context) {
  if (typeof channel !== 'string' || !Number.isInteger(senderId) || senderId <= 0) return false;
  if (channel.startsWith('gemini:')) return (context.geminiIds || []).includes(senderId);
  return MAIN_CHANNEL_PREFIXES.some(prefix => channel.startsWith(prefix)) && senderId === context.mainId;
}

function securedIpcHandle(ipc, getContext) {
  return (channel, handler) => ipc.handle(channel, (event, ...args) => {
    if (!isIpcSourceAllowed(channel, event?.sender?.id, getContext())) throw Object.assign(new Error('IPC 调用来源无效'), { code: 'IPC_SOURCE_DENIED' });
    return handler(event, ...args);
  });
}

function isJobResultSourceAllowed(senderId, contentsId) {
  return Number.isInteger(senderId) && senderId > 0 && senderId === contentsId;
}

module.exports = { GOOGLE_LOGIN_HOSTS, requireLocalSiteUrl, isMainNavigationAllowed, shouldInjectDesktopToken, desktopRequestHeaders, isGeminiPopupAllowed, protectMainNavigation, protectGeminiNavigation, isIpcSourceAllowed, securedIpcHandle, isJobResultSourceAllowed };
