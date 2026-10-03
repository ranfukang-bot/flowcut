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
  const originalSwitch = engine.switchAfterQuota;
  const originalSubmit = engine.submitTask;
  const originalPreferred = accounts.setPreferredModel;

  accounts.isQuotaError = function (error) {
    return isDailyModelQuota(error) || originalQuotaError.call(this, error);
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
    let selectedModel = model;
    let next = ordered.find(account => account.id !== excludeId && account.enabled !== false &&
      accounts.isAvailable(account) && accounts.effectiveModel(account) === model &&
      !accounts.modelExhausted(account, model));
    // Only an explicit, current-day approval can release Fast tasks to 2.0.
    // Keep their original preference so they return to Fast after the reset.
    if (!next && model === '2000012' && accounts.allFastExhausted()) {
      next = ordered.find(account => account.enabled !== false && accounts.isAvailable(account) &&
        account.preferredModel === '2000012' && accounts.effectiveModel(account) === '2000004');
      if (next) selectedModel = '2000004';
    }
    if (!next) {
      const changed = task.status !== 'model_wait' || task.errorCode !== 'MODEL_QUOTA_WAIT';
      task.status = 'model_wait';
      task.errorCode = 'MODEL_QUOTA_WAIT';
      task.errorMessage = model === '2000012' && accounts.allFastExhausted()
        ? `所有已启用 Fast 账号今日均已上限，等待确认是否改用 Seedance 2.0；可在顶部额度提醒中选择`
        : `${label(model)} 暂无可用账号，请检查登录状态或等待额度恢复；尚未确认所有账号均已上限`;
      delete task.completedAt;
      if (changed) engine.recordTask(task, task.errorMessage, 'warn');
      return changed;
    }
    const oldId = task.accountId;
    engine.assignTaskAccount(task, next);
    task.model = selectedModel;
    task.status = task.imageItems?.some(image => !image.uploadedUrl || image.uploadedAccountId !== next.id) ? 'upload_wait' : 'queued';
    task.errorCode = '';
    task.errorMessage = '';
    task.nextUploadRetryAt = Date.now();
    task.uploadRetries = 0;
    task.transientUploadFailures = 0;
    delete task.nextRetryAt;
    delete task.completedAt;
    accounts.setActive(next.id);
    engine.recordTask(task, `${oldId === next.id ? '继续使用' : '已切换到'}账号“${next.name}”，使用 ${label(selectedModel)}，${task.status === 'upload_wait' ? '重新上传素材后生成' : '等待提交生成'}`, 'info');
    return true;
  }

  engine.switchAfterQuota = function (task, accountId, error) {
    const model = requestedModel(task);
    if (!MODELS.has(model) || hasRemoteJob(task)) return originalSwitch.call(this, task, accountId, error);
    accounts.markModelExhausted(accountId, task.model || model, String(error?.message || error || '模型每日额度已用尽'));
    task.quotaRequestedModel = model;
    route(task, accountId);
    save();
  };

  engine.resumeModelWaiters = function () {
    let changed = false;
    for (const task of engine.store.data.tasks) {
      if (!WAITING.has(task.status) || hasRemoteJob(task)) continue;
      const model = requestedModel(task);
      if (task.status === 'model_wait' || (MODELS.has(model) &&
        (!accounts.isAvailable(accounts.account(task.accountId)) ||
         task.model !== accounts.effectiveModel(accounts.account(task.accountId))))) {
        changed = route(task) || changed;
      }
    }
    if (changed) save();
  };

  engine.submitTask = function (task, account) {
    if (task.quotaRequestedModel && accounts.effectiveModel(account) !== task.model) {
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
  // Old versions classified this explicit platform rejection as an ordinary
  // failure. Recover only today's unsent tasks; never replay a remote job.
  for (const task of engine.store.data.tasks) {
    if (task.status !== 'failed' || hasRemoteJob(task) || !isDailyModelQuota(task.errorMessage) ||
        !MODELS.has(task.model) || !accounts.account(task.accountId) ||
        engine.store.isFlowcutTaskCleared?.(task.flowcutTaskId)) continue;
    const at = Number(task.completedAt || 0);
    if (!at || accounts.todayKey(new Date(at)) !== accounts.todayKey()) continue;
    accounts.markModelExhausted(task.accountId, task.model, task.errorMessage);
    task.quotaRequestedModel = task.model;
    task.status = 'model_wait';
    task.errorCode = 'MODEL_QUOTA_WAIT';
    task.errorMessage = '已恢复旧版未识别的每日额度上限，正在检查其他账号';
    delete task.completedAt;
    engine.store.save();
  }
  Object.defineProperty(engine, '__seedanceQuotaRecovery', { value: true });
}
module.exports = { patchEngine, isDailyModelQuota };
