'use strict';

const MODELS = new Set(['2000012', '2000004']);
const WAITING = new Set(['model_wait', 'upload_wait', 'queued', 'retry_wait']);
const label = model => model === '2000004' ? 'Seedance 2.0 标准版' : 'Seedance 2.0 Fast';

function isDailyModelQuota(error) {
  const message = typeof error === 'string' ? error :
    [error?.message, error?.errorMessage, error?.msg, error?.data?.message].filter(Boolean).join(' ');
  return /\buser\s+generation\s+day\s+limit\b/i.test(message);
}

function patchEngine(engine) {
  if (engine.__seedanceQuotaRecovery) return;
  const accounts = engine.accounts;
  const originalQuotaError = accounts.isQuotaError;
  const originalEffectiveModel = accounts.effectiveModel;
  const originalSwitch = engine.switchAfterQuota;
  const originalSubmit = engine.submitTask;
  const originalPreferred = accounts.setPreferredModel;

  accounts.isQuotaError = function (error) {
    return isDailyModelQuota(error) || originalQuotaError.call(this, error);
  };
  accounts.effectiveModel = function (value) {
    const account = typeof value === 'string' ? this.account(value) : value;
    const preferred = account?.preferredModel;
    if (!MODELS.has(preferred)) return originalEffectiveModel.call(this, account);
    return this.modelExhausted(account, preferred) ? '' : preferred;
  };

  const hasRemoteJob = task => Boolean(task.taskId || task.taskIds?.length);
  const requestedModel = task => task.quotaRequestedModel || task.model || accounts.account(task.accountId)?.preferredModel;
  const save = () => { engine.store.save(); engine.emit(); };

  function route(task, excludeId = '') {
    if (hasRemoteJob(task)) return false;
    const model = requestedModel(task);
    if (!MODELS.has(model)) return false;
    task.quotaRequestedModel = model;
    const list = engine.store.data.accounts;
    const pivot = list.findIndex(a => a.id === (excludeId || task.accountId));
    const ordered = excludeId && pivot >= 0 ? [...list.slice(pivot + 1), ...list.slice(0, pivot + 1)] :
      [...list.filter(a => a.id === task.accountId), ...list.filter(a => a.id !== task.accountId)];
    const next = ordered.find(account => account.id !== excludeId && account.enabled !== false &&
      accounts.isAvailable(account) && accounts.effectiveModel(account) === model &&
      !accounts.modelExhausted(account, model));
    if (!next) {
      const changed = task.status !== 'model_wait' || task.errorCode !== 'MODEL_QUOTA_WAIT';
      task.status = 'model_wait';
      task.errorCode = 'MODEL_QUOTA_WAIT';
      task.errorMessage = `${label(model)} 暂无可用账号，保留任务等待账号额度恢复或手动选择模型`;
      delete task.completedAt;
      if (changed) engine.recordTask(task, task.errorMessage, 'warn');
      return changed;
    }
    const oldId = task.accountId;
    engine.assignTaskAccount(task, next);
    task.model = model;
    task.status = task.imageItems?.some(image => !image.uploadedUrl || image.uploadedAccountId !== next.id) ? 'upload_wait' : 'queued';
    task.errorCode = '';
    task.errorMessage = '';
    task.nextUploadRetryAt = Date.now();
    task.uploadRetries = 0;
    task.transientUploadFailures = 0;
    delete task.nextRetryAt;
    delete task.completedAt;
    accounts.setActive(next.id);
    engine.recordTask(task, `${oldId === next.id ? '继续使用' : '已切换到'}账号“${next.name}”，保持 ${label(model)}，${task.status === 'upload_wait' ? '重新上传素材后生成' : '等待提交生成'}`, 'info');
    return true;
  }

  engine.switchAfterQuota = function (task, accountId, error) {
    const model = requestedModel(task);
    if (!MODELS.has(model) || hasRemoteJob(task)) return originalSwitch.call(this, task, accountId, error);
    accounts.markModelExhausted(accountId, model, String(error?.message || error || '模型每日额度已用尽'));
    task.quotaRequestedModel = model;
    route(task, accountId);
    save();
  };

  engine.resumeModelWaiters = function () {
    let changed = false;
    for (const task of engine.store.data.tasks) {
      if (!WAITING.has(task.status) || hasRemoteJob(task)) continue;
      const model = requestedModel(task);
      if (task.status === 'model_wait' || (MODELS.has(model) && accounts.modelExhausted(accounts.account(task.accountId), model))) {
        changed = route(task) || changed;
      }
    }
    if (changed) save();
  };

  engine.submitTask = function (task, account) {
    if (task.quotaRequestedModel && accounts.effectiveModel(account) !== task.quotaRequestedModel) {
      route(task); save(); return Promise.resolve();
    }
    return originalSubmit.call(this, task, account);
  };

  accounts.setPreferredModel = function (id, model) {
    const result = originalPreferred.call(this, id, model);
    for (const task of engine.store.data.tasks) {
      if (task.accountId === id && task.quotaRequestedModel && WAITING.has(task.status) && !hasRemoteJob(task)) {
        task.quotaRequestedModel = model;
        task.model = model;
      }
    }
    save();
    return result;
  };
  Object.defineProperty(engine, '__seedanceQuotaRecovery', { value: true });
}

function install() {
  if (Object.getOwnPropertyDescriptor(Object.prototype, 'submitCooldowns')) throw new Error('Conflicting Seedance queue hook');
  const cleanup = () => { delete Object.prototype.submitCooldowns; };
  Object.defineProperty(Object.prototype, 'submitCooldowns', {
    configurable: true,
    set(value) {
      Object.defineProperty(this, 'submitCooldowns', { value, writable: true, configurable: true, enumerable: true });
      if (!(value instanceof Map) || typeof this.switchAfterQuota !== 'function' || !this.accounts) return;
      cleanup(); clearTimeout(timer); patchEngine(this);
    },
  });
  const timer = setTimeout(cleanup, 30000); timer.unref();
}

module.exports = { patchEngine, install, isDailyModelQuota };
