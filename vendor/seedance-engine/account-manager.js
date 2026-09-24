const crypto = require('node:crypto');
const { TikTokClient, AuthRequiredError, BASE_URL } = require('./tiktok-client');
const { FAST_MODEL, STANDARD_MODEL, requireModel, modelLabel, isQuotaError } = require('./models');

const RUNNING_TASK_STATUSES = new Set(['uploading', 'submitting', 'generating']);

class AccountManager {
  constructor({
    store,
    sessionFactory,
    clientFactory = (electronSession, logger) => new TikTokClient(electronSession, logger),
    onChange = () => {},
  }) {
    this.store = store;
    this.sessionFactory = sessionFactory;
    this.clientFactory = clientFactory;
    this.onChange = onChange;
    this.resources = new Map();
    this.runtime = new Map();
  }

  initialize() {
    for (const account of this.store.accounts) this.ensureResources(account.id);
    this.ensureActiveAccount();
  }

  todayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  ensureRuntime(accountId) {
    if (!this.runtime.has(accountId)) {
      const account = this.store.getAccount(accountId);
      const lastTaskAuthAt = this.store.tasks.reduce(
        (latest, task) =>
          task.accountId === accountId && task.taskId
            ? Math.max(latest, Number(task.lastSubmittedAt || task.createdAt || 0))
            : latest,
        0,
      );
      const lastAuthenticatedAt = Math.max(
        Number(account?.lastAuthenticatedAt || 0),
        lastTaskAuthAt,
      );
      this.runtime.set(accountId, {
        authenticated: Boolean(lastAuthenticatedAt),
        authKnown: Boolean(lastAuthenticatedAt),
        authCheckFailed: false,
        authCheckedAt: 0,
        lastAuthenticatedAt,
        maxConcurrent: 5,
        generatingCount: 0,
        error: '',
      });
    }
    return this.runtime.get(accountId);
  }

  ensureResources(accountId) {
    if (this.resources.has(accountId)) return this.resources.get(accountId);
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error('账号不存在');
    const electronSession = this.sessionFactory(account.partition);
    const client = this.clientFactory(electronSession, (message, level = 'info') =>
      this.store.log(`[${account.name}] ${message}`, level),
    );
    electronSession.webRequest?.onBeforeSendHeaders(
      { urls: [`${BASE_URL}/*`] },
      (details, callback) => {
        if (details.url.includes('/creative_bff_i18n/api/cue/')) {
          client.captureHeaders(details.requestHeaders);
        }
        callback({ cancel: false, requestHeaders: details.requestHeaders });
      },
    );
    const resource = { session: electronSession, client };
    this.resources.set(accountId, resource);
    this.ensureRuntime(accountId);
    return resource;
  }

  client(accountId) {
    return this.ensureResources(accountId).client;
  }

  session(accountId) {
    return this.ensureResources(accountId).session;
  }

  account(accountId) {
    return this.store.getAccount(accountId);
  }

  accountName(accountId) {
    return this.account(accountId)?.name || '未知账号';
  }

  isExhausted(account) {
    return Boolean(account && (!this.effectiveModel(account) || account.exhaustedDate === this.todayKey()));
  }

  modelExhausted(account, model) { return account?.modelQuota?.[model]?.date === this.todayKey(); }

  effectiveModel(account) {
    if (!account) return '';
    const preferred = requireModel(account.preferredModel);
    if (!this.modelExhausted(account, preferred)) return preferred;
    if (preferred === FAST_MODEL && account.fallbackDecision?.date === this.todayKey() && account.fallbackDecision.choice === 'standard' && !this.modelExhausted(account, STANDARD_MODEL)) return STANDARD_MODEL;
    return '';
  }

  setPreferredModel(accountId, model) {
    const account = this.account(accountId);
    if (!account) throw new Error('账号不存在');
    account.preferredModel = requireModel(model);
    this.store.upsertAccount(account);
    this.onChange();
    return account;
  }

  markModelExhausted(accountId, model, reason) {
    const account = this.account(accountId);
    if (!account) return;
    model = requireModel(model);
    account.modelQuota ||= {};
    account.modelQuota[model] = { date: this.todayKey(), reason: String(reason || '平台返回额度不足') };
    this.store.upsertAccount(account);
    this.store.log(`账号“${account.name}” ${modelLabel(model)} 额度不足${model === FAST_MODEL ? '，等待确认是否改用 2.0' : '，已暂停该模型'}`, 'warn');
    this.onChange();
  }

  decideFastFallback(accountId, choice, expectedDate) {
    const account = this.account(accountId);
    if (!account || expectedDate !== this.todayKey() || !this.modelExhausted(account, FAST_MODEL)) throw new Error('额度状态已变化，请刷新后再选择');
    if (!['standard', 'wait'].includes(choice)) throw new Error('无效的模型选择');
    if (choice === 'standard' && this.modelExhausted(account, STANDARD_MODEL)) throw new Error('该账号的 2.0 额度也已用完');
    account.fallbackDecision = { date: this.todayKey(), choice };
    this.store.upsertAccount(account);
    this.store.log(`账号“${account.name}”：${choice === 'standard' ? '用户确认今天改用 Seedance 2.0' : '等待 Fast 额度恢复，不切换模型'}`);
    this.onChange();
  }

  isAvailable(account) {
    const runtime = account ? this.ensureRuntime(account.id) : null;
    return Boolean(
      account &&
        account.enabled !== false &&
        !this.isExhausted(account) &&
        runtime?.authenticated,
    );
  }

  get authenticated() {
    return this.store.accounts.some((account) => this.ensureRuntime(account.id).authenticated);
  }

  get authCheckedAt() {
    return this.store.accounts.reduce(
      (latest, account) => Math.max(latest, this.ensureRuntime(account.id).authCheckedAt || 0),
      0,
    );
  }

  ensureActiveAccount() {
    const current = this.store.getAccount(this.store.settings.activeAccountId);
    if (current?.enabled !== false) return current;
    const first = this.store.accounts.find((account) => account.enabled !== false);
    if (first) this.store.updateSettings({ activeAccountId: first.id });
    return first || null;
  }

  activeAccount() {
    return this.ensureActiveAccount();
  }

  setActive(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error('账号不存在');
    if (account.enabled === false) throw new Error('该账号已停用');
    this.store.updateSettings({ activeAccountId: account.id });
    this.store.log(`当前账号已切换为“${account.name}”`);
    this.onChange();
    return account;
  }

  addAccount(name) {
    const id = crypto.randomUUID();
    const account = {
      id,
      name: String(name || `账号 ${this.store.accounts.length + 1}`).trim(),
      partition: `persist:tiktok-symphony-${id}`,
      enabled: true,
      preferredModel: FAST_MODEL,
      modelQuota: {},
      exhaustedDate: '',
      exhaustedReason: '',
      createdAt: Date.now(),
    };
    this.store.upsertAccount(account);
    this.ensureResources(id);
    this.store.updateSettings({ activeAccountId: id });
    this.store.log(`已添加账号“${account.name}”`);
    this.onChange();
    return account;
  }

  renameAccount(accountId, name) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error('账号不存在');
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('账号名称不能为空');
    account.name = cleanName;
    this.store.upsertAccount(account);
    this.onChange();
    return account;
  }

  setEnabled(accountId, enabled) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error('账号不存在');
    account.enabled = Boolean(enabled);
    this.store.upsertAccount(account);
    this.ensureActiveAccount();
    this.onChange();
    return account;
  }

  removeAccount(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error('账号不存在');
    if (this.store.accounts.length <= 1) throw new Error('至少需要保留一个账号');
    const linkedTasks = this.store.tasks.filter((task) => task.accountId === accountId);
    if (linkedTasks.some((task) => RUNNING_TASK_STATUSES.has(task.status))) {
      throw new Error('该账号仍有正在上传或生成的视频，请等待任务结束后再删除');
    }
    for (const task of linkedTasks) {
      task.accountHistory = [
        ...(task.accountHistory || []),
        {
          accountId,
          accountName: task.accountName || account.name,
          changedAt: Date.now(),
          reason: 'account-removed',
        },
      ];
      task.accountId = '';
      if (task.status !== 'success') {
        task.taskId = '';
        task.taskIds = [];
        task.uploadProgress = null;
        for (const image of task.imageItems || []) {
          image.uploadedUrl = '';
          image.uploadedAccountId = '';
        }
        if (['queued', 'upload_wait', 'retry_wait', 'model_wait'].includes(task.status)) {
          task.status = 'upload_wait';
          task.nextRetryAt = 0;
          task.nextUploadRetryAt = Date.now();
          task.activity = `原 Seedance 账号“${account.name}”已移除，等待切换账号重新上传`;
          task.activityAt = Date.now();
        }
      }
      this.store.upsertTask(task);
    }
    this.store.removeAccount(accountId);
    this.resources.delete(accountId);
    this.runtime.delete(accountId);
    this.ensureActiveAccount();
    this.onChange();
  }

  markExhausted(accountId, reason) {
    const account = this.store.getAccount(accountId);
    if (!account) return;
    account.exhaustedDate = this.todayKey();
    account.exhaustedReason = String(reason || '今日生成额度已用完');
    this.store.upsertAccount(account);
    this.store.log(`账号“${account.name}”今日额度已用完，准备切换账号`, 'error');
    this.rotateFrom(accountId);
    this.onChange();
  }

  resetExhausted(accountId) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error('账号不存在');
    account.exhaustedDate = '';
    account.exhaustedReason = '';
    this.store.upsertAccount(account);
    this.onChange();
    return account;
  }

  rotateFrom(accountId) {
    const accounts = this.store.accounts;
    const start = Math.max(0, accounts.findIndex((account) => account.id === accountId));
    for (let offset = 1; offset <= accounts.length; offset += 1) {
      const candidate = accounts[(start + offset) % accounts.length];
      if (this.isAvailable(candidate)) {
        this.store.updateSettings({ activeAccountId: candidate.id });
        return candidate;
      }
    }
    const fallback = accounts.find(
      (account) => account.enabled !== false && !this.isExhausted(account),
    );
    if (fallback) this.store.updateSettings({ activeAccountId: fallback.id });
    return fallback || null;
  }

  async refreshAuth(accountId = '') {
    const targets = accountId
      ? [this.store.getAccount(accountId)].filter(Boolean)
      : this.store.accounts.filter((account) => account.enabled !== false);
    await Promise.all(
      targets.map(async (account) => {
        const runtime = this.ensureRuntime(account.id);
        try {
          runtime.authenticated = await this.client(account.id).checkAuth();
          runtime.authKnown = true;
          runtime.authCheckFailed = false;
          runtime.authCheckedAt = Date.now();
          runtime.error = runtime.authenticated ? '' : '未登录或登录已失效';
          if (runtime.authenticated) {
            runtime.loginNetworkError = '';
            runtime.loginNetworkFailureKey = '';
            runtime.lastAuthenticatedAt = Date.now();
            account.lastAuthenticatedAt = runtime.lastAuthenticatedAt;
            this.store.upsertAccount(account);
          } else if (account.lastAuthenticatedAt) {
            account.lastAuthenticatedAt = 0;
            this.store.upsertAccount(account);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const previousError = runtime.error;
          runtime.authCheckFailed = true;
          runtime.authCheckedAt = Date.now();
          runtime.error = `登录检测暂时失败：${message}`;
          if (runtime.error !== previousError) {
            this.store.log(
              `账号“${account.name}”登录检测遇到网络异常，保留上次状态：${message}`,
              'error',
            );
          }
        }
      }),
    );
    const current = this.activeAccount();
    if (!this.isAvailable(current)) {
      const firstAvailable = this.store.accounts.find((account) => this.isAvailable(account));
      if (firstAvailable) this.store.updateSettings({ activeAccountId: firstAvailable.id });
    }
    this.onChange();
    return this.authenticated;
  }

  markAuthInvalid(accountId, message = '登录已失效') {
    const runtime = this.ensureRuntime(accountId);
    runtime.authenticated = false;
    runtime.authKnown = true;
    runtime.authCheckFailed = false;
    runtime.authCheckedAt = Date.now();
    runtime.lastAuthenticatedAt = 0;
    runtime.error = message;
    const account = this.account(accountId);
    if (account) {
      account.lastAuthenticatedAt = 0;
      this.store.upsertAccount(account);
      this.store.log(`账号“${account.name}”登录已失效`, 'error');
    }
    this.rotateFrom(accountId);
    this.onChange();
  }

  markAuthenticated(accountId) {
    const account = this.account(accountId);
    if (!account) return;
    const runtime = this.ensureRuntime(accountId);
    const timestamp = Date.now();
    runtime.authenticated = true;
    runtime.authKnown = true;
    runtime.authCheckFailed = false;
    runtime.authCheckedAt = timestamp;
    runtime.lastAuthenticatedAt = timestamp;
    runtime.error = '';
    runtime.loginNetworkError = '';
    runtime.loginNetworkFailureKey = '';
    account.lastAuthenticatedAt = timestamp;
    this.store.upsertAccount(account);
  }

  async availableAccount(preferredAccountId = '') {
    const preferred = this.store.getAccount(preferredAccountId);
    if (this.isAvailable(preferred)) return preferred;
    const active = this.activeAccount();
    if (this.isAvailable(active)) return active;
    let available = this.store.accounts.find((account) => this.isAvailable(account));
    if (available) {
      this.store.updateSettings({ activeAccountId: available.id });
      return available;
    }
    const stale = this.store.accounts.some(
      (account) =>
        account.enabled !== false &&
        Date.now() - this.ensureRuntime(account.id).authCheckedAt > 30_000,
    );
    if (stale) await this.refreshAuth();
    available = this.store.accounts.find((account) => this.isAvailable(account));
    if (available) this.store.updateSettings({ activeAccountId: available.id });
    return available || null;
  }

  isQuotaError(value) {
    return isQuotaError(value);
  }

  state() {
    const activeAccountId = this.store.settings.activeAccountId;
    return {
      activeAccountId,
      items: this.store.accounts.map((account) => {
        const runtime = this.ensureRuntime(account.id);
        return {
          id: account.id,
          name: account.name,
          enabled: account.enabled !== false,
          authenticated: runtime.authenticated,
          authKnown: runtime.authKnown,
          authCheckFailed: runtime.authCheckFailed,
          authCheckedAt: runtime.authCheckedAt,
          lastAuthenticatedAt: runtime.lastAuthenticatedAt,
          error: runtime.error,
          // null means no local API generation-count limit, not a promise
          // about the platform's own capacity or rate limits.
          maxConcurrent: null,
          generatingCount: this.store.tasks.filter((task) =>
            task.accountId === account.id && ['submitting', 'generating'].includes(task.status),
          ).length,
          exhaustedToday: this.isExhausted(account),
          exhaustedReason: this.isExhausted(account) ? account.exhaustedReason : '',
          active: account.id === activeAccountId,
          preferredModel: requireModel(account.preferredModel),
          effectiveModel: this.effectiveModel(account),
          fastExhaustedToday: this.modelExhausted(account, FAST_MODEL),
          standardExhaustedToday: this.modelExhausted(account, STANDARD_MODEL),
          quotaDate: this.todayKey(),
          quotaReason: account.modelQuota?.[FAST_MODEL]?.date === this.todayKey() ? account.modelQuota[FAST_MODEL].reason : '',
          fallbackDecision: account.fallbackDecision?.date === this.todayKey() ? account.fallbackDecision.choice : '',
          needsModelDecision: requireModel(account.preferredModel) === FAST_MODEL && this.modelExhausted(account, FAST_MODEL) && account.fallbackDecision?.date !== this.todayKey(),
          loginNetworkError: runtime.loginNetworkError || '',
        };
      }),
    };
  }
}

module.exports = { AccountManager };
