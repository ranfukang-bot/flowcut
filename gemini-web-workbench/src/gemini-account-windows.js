const { restoreGeminiWorkerPlacement } = require('./gemini-worker-activation');

// Viewing an existing session is independent of importing a new login.
class GeminiAccountWindows {
  constructor({ windows, getAccount, createWindow, loadPage, isBusy, isQuitting }) {
    Object.assign(this, { windows, getAccount, createWindow, loadPage, isBusy, isQuitting });
    this.visibleAccounts = new Set();
    this.loading = new WeakMap();
  }
  worker(account, fresh = false) {
    let window = this.windows.get(account.id);
    if (fresh && window && !window.isDestroyed()) window.destroy();
    if (!window || window.isDestroyed()) {
      window = this.createWindow(account);
      this.windows.set(account.id, window);
      window.flowcutUserVisible = this.visibleAccounts.has(account.id);
      window.on('close', event => {
        if (this.isQuitting()) return;
        event.preventDefault();
        this.visibleAccounts.delete(account.id);
        window.flowcutUserVisible = false;
        window.hide();
      });
      window.on('closed', () => {
        if (this.windows.get(account.id) === window) this.windows.delete(account.id);
      });
    }
    if (this.visibleAccounts.has(account.id)) this.reveal(window);
    return window;
  }
  reveal(window) {
    window.flowcutUserVisible = true;
    restoreGeminiWorkerPlacement(window);
    if (window.isMinimized?.()) window.restore();
    window.show();
    window.focus();
  }
  async open(id) {
    const account = this.getAccount(id);
    if (!account) throw new Error('账号不存在');
    this.visibleAccounts.add(id);
    let window = this.worker(account);
    this.reveal(window);
    const url = window.webContents.getURL();
    // Never reload, navigate or start another page in an in-flight task.
    if (!this.isBusy(id) && (!url || url === 'about:blank')) {
      let loading = this.loading.get(window);
      if (!loading) {
        loading = this.loadPage(account, window);
        this.loading.set(window, loading);
      }
      try { await loading; }
      catch (error) {
        this.loading.delete(window);
        const current = this.windows.get(id);
        // A task may have replaced an idle viewer while its first load was
        // pending. Show its fresh worker without touching its navigation.
        if (!window.isDestroyed() || !current || current.isDestroyed() || !this.isBusy(id)) throw error;
        window = current;
      }
      if (!window.isDestroyed() && this.visibleAccounts.has(id)) this.reveal(window);
    }
    return true;
  }
  finish(window) {
    if (!window.isDestroyed() && !window.flowcutUserVisible) window.destroy();
  }
  forget(id) {
    this.visibleAccounts.delete(id);
    this.windows.get(id)?.destroy();
    this.windows.delete(id);
  }
}

module.exports = { GeminiAccountWindows };
