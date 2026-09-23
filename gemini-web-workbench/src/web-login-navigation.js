const protectedContents = new WeakSet();

function isWebNavigation(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'blob:', 'data:', 'javascript:'].includes(url.protocol) ||
      (url.protocol === 'about:' && ['blank', 'srcdoc'].includes(url.pathname));
  } catch { return false; }
}

// Login sites sometimes try to wake up their native app, including from hidden
// iframes or OAuth popups. Keep those attempts inside the browser boundary.
function protectLoginNavigation(contents, popupOptions, onBlocked = () => {}) {
  if (protectedContents.has(contents)) return;
  protectedContents.add(contents);
  const guard = (event, legacyUrl) => {
    const url = event.url || legacyUrl;
    if (isWebNavigation(url)) return;
    event.preventDefault();
    onBlocked(); // Never record URLs carrying login tokens.
  };
  contents.on('will-navigate', guard);
  contents.on('will-frame-navigate', guard);
  contents.on('will-redirect', guard);
  contents.setWindowOpenHandler(({ url }) => {
    if (!(url === 'about:blank' || /^https:\/\//i.test(url))) {
      onBlocked();
      return { action: 'deny' };
    }
    return { action: 'allow', overrideBrowserWindowOptions: popupOptions };
  });
  contents.on('did-create-window', child => {
    protectLoginNavigation(child.webContents, popupOptions, onBlocked);
  });
}

module.exports = { isWebNavigation, protectLoginNavigation };
