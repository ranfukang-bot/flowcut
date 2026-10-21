const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TemporaryBrowserLogin, findFirefox, FIREFOX_DOWNLOAD_URL } = require('./gemini-browser-login');
const { loginError } = require('./gemini-login-import');

class GeminiLoginFlow {
  constructor({ root, store, sessionFactory, verify, clearSession, canReplace = () => true,
    confirmReplace = async () => false, browserFinder = findFirefox,
    browserFactory = options => new TemporaryBrowserLogin(options), onChange = () => {} }) {
    Object.assign(this, { root, store, sessionFactory, verify, clearSession, canReplace, confirmReplace,
      browserFinder, browserFactory, onChange });
    this.flow = null; this.run = null; this.busy = false;
  }
  state() { return this.flow ? { ...this.flow, busy: this.busy, downloadUrl: FIREFOX_DOWNLOAD_URL } : null; }
  get heldAccountId() { return this.flow?.accountId || ''; }
  changed() { this.onChange(); }
  async prepare({ name, accountId = '' }) {
    if (this.flow || this.busy) throw loginError('LOGIN_ALREADY_STARTED', '请先完成或取消当前 Firefox 登录');
    const account = accountId ? this.store.state.accounts.find(a => a.id === accountId) : null;
    if (accountId && !account) throw loginError('ACCOUNT_NOT_FOUND', '账号不存在');
    if (account && !this.canReplace(account.id)) throw loginError('ACCOUNT_BUSY', '请等该账号当前任务结束后再重新登录');
    this.flow = { id: randomUUID(), accountId, name: account?.name || String(name || '').trim() || 'Gemini 账号',
      mode: account ? 'relogin' : 'add', phase: 'ready', error: '' };
    this.changed(); return this.state();
  }
  async open() {
    if (!this.flow || this.busy) throw loginError('LOGIN_NOT_READY', '请先添加账号或点击重新登录');
    this.busy = true; this.changed();
    try {
      if (this.run) await this.run.cancel();
      const browser = await this.browserFinder();
      if (!browser) { this.flow.phase = 'missing'; this.flow.error = '未找到 Firefox，请安装后重试'; return this.state(); }
      this.run = this.browserFactory({ root: path.join(this.root, 'login-temp'), browser });
      await this.run.start(); this.flow.phase = 'waiting-for-user'; this.flow.error = '';
      return this.state();
    } catch { this.flow.phase = 'failed'; this.flow.error = 'Firefox 登录窗口打开失败，请重试'; throw loginError('FIREFOX_LAUNCH_FAILED', this.flow.error); }
    finally { this.busy = false; this.changed(); }
  }
  async finish() {
    if (!this.flow || this.flow.phase !== 'waiting-for-user' || this.busy) throw loginError('LOGIN_NOT_READY', '请先打开 Firefox 并完成登录');
    const flow = this.flow;
    this.busy = true; flow.phase = 'importing'; flow.error = ''; this.changed();
    let candidate;
    try {
      if (flow.accountId) {
        if (!this.canReplace(flow.accountId)) throw loginError('ACCOUNT_BUSY', '该账号正在执行任务，请稍后再导入');
        if (!await this.confirmReplace(flow.name)) {
          await this.run.cancel(); this.run = null; this.flow = null;
          return { cancelled: true };
        }
      }
      const id = randomUUID(), partition = 'persist:flowcut-gemini-' + id;
      candidate = { id, name: flow.name, partition };
      const target = this.sessionFactory(partition);
      await this.run.complete({ userConfirmed: true, target });
      const checked = await this.verify(candidate);
      if (!checked?.authenticated) throw loginError('LOGIN_CHECK_FAILED', '导入后的 Gemini 登录检查未通过，原登录保持不变');
      await target.cookies?.flushStore?.(); target.flushStorageData?.();
      // Commit a new partition only after validation. The original partition
      // is never written, cleared or deleted, including on failed relogin.
      const account = this.store.commitGeminiLogin({ accountId: flow.accountId, candidate,
        checkedAt: new Date().toISOString(), modelCatalog: checked.modelCatalog });
      candidate = null; this.run = null; this.flow = null;
      return { accountId: account.id, cancelled: false };
    } catch (error) {
      let clean = true;
      try { await this.run?.cancel(); } catch { clean = false; }
      if (candidate) { try { await this.clearSession(candidate.partition); } catch { clean = false; } }
      flow.phase = 'failed';
      const code = /^[A-Z_]{3,70}$/.test(error?.code || '') ? error.code : 'LOGIN_IMPORT_FAILED';
      flow.error = clean ? (code === 'ACCOUNT_BUSY' ? '该账号正在执行任务，请等任务结束后重新打开 Firefox' : '登录导入或检查失败，原账号保持不变，请重新打开 Firefox 登录')
        : '登录未完成，临时资料清理失败，请关闭本次 Firefox 登录窗口后点击取消重试清理';
      throw loginError(clean ? code : 'LOGIN_CLEANUP_FAILED', flow.error);
    } finally { this.busy = false; this.changed(); }
  }
  async cancel() {
    if (this.busy) throw loginError('LOGIN_BUSY', '正在导入登录，请等待完成');
    this.busy = true; this.changed();
    try { await this.run?.cancel(); this.run = null; this.flow = null; }
    finally { this.busy = false; this.changed(); }
  }
  async shutdown() {
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 50));
    await this.cancel();
  }
}
module.exports = { GeminiLoginFlow };
