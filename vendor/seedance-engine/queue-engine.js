const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AuthRequiredError, isTransientRequestError } = require('./tiktok-client');
const { FAST_MODEL, STANDARD_MODEL, requireModel, modelLabel } = require('./models');

const EDITABLE_STATUSES = new Set(['draft', 'queued', 'upload_wait', 'retry_wait', 'failed']);
const TRANSIENT_NETWORK_PATTERN =
  /ERR_(?:HTTP2_PROTOCOL_ERROR|CONNECTION_CLOSED|CONNECTION_RESET|CONNECTION_ABORTED|NETWORK_CHANGED|INTERNET_DISCONNECTED|TIMED_OUT)|ECONN(?:RESET|REFUSED|ABORTED)|EAI_AGAIN|ENET(?:DOWN|UNREACH)|ETIMEDOUT|fetch failed|network error|socket hang up|aborted|超时|网络/i;

function isTransientNetworkError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return TRANSIENT_NETWORK_PATTERN.test(message);
}

// No definitive answer from the platform: it may already have accepted the
// generation, so resubmitting could create (and pay for) a duplicate. Only an
// answer the client classified as a refusal counts as definite.
function isUncertainSubmitError(error) {
  if (error?.outcome === 'unknown') return true;
  if (error?.outcome === 'rejected') return false;
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return true;
  if (Number(error?.status || 0) >= 500) return true;
  return isTransientRequestError(error) || isTransientNetworkError(error);
}

// Enough of a task to rebuild it if the task list lost it after a submission.
const SNAPSHOT_FIELDS = [
  'id', 'order', 'prompt', 'imageItems', 'imageName', 'duration', 'model',
  'accountId', 'accountName', 'source', 'flowcutTaskId', 'flowcutTaskKind',
  'tiktokAccountName', 'archiveDirectory', 'productExternalId',
  'managedLocalFiles', 'excelRow', 'folderIndex', 'createdAt', 'taskIds', 'attempts',
];

function submissionSnapshot(task) {
  const snapshot = {};
  for (const field of SNAPSHOT_FIELDS) {
    if (task[field] !== undefined) snapshot[field] = task[field];
  }
  return JSON.parse(JSON.stringify(snapshot));
}

// The task fields a definite refusal changes, restored after a restart.
const REFUSAL_FIELDS = [
  'status', 'errorCode', 'errorMessage', 'submitOutcome', 'completedAt',
  'nextRetryAt', 'nextUploadRetryAt', 'accountId', 'accountName', 'taskId',
  'imageItems', 'uploadProgress', 'model',
];

function refusalResult(task) {
  const result = {};
  for (const field of REFUSAL_FIELDS) result[field] = task[field] === undefined ? null : task[field];
  return JSON.parse(JSON.stringify(result));
}

const UNCONFIRMED_SUBMIT_HINT =
  '为避免重复生成，没有自动重新提交。请到 TikTok Symphony 生成历史核对：已生成可在历史中取回视频；确认没有生成时，请为该商品重新创建任务。';

// Tasks that failed before this version recorded an unanswered submit as
// "提交失败：<network error>"; those are just as unconfirmed.
function isUncertainLegacyFailure(task) {
  if (task?.submitOutcome === 'rejected') return false;
  const message = String(task?.errorMessage || '');
  if (!message.startsWith('提交失败：')) return false;
  const reason = message.slice('提交失败：'.length);
  // Older versions reported an unreadable success response as "接口 HTTP 200",
  // and a body without a result code as "接口错误 undefined".
  const unreadable = /^接口 HTTP (\d{3})$/.exec(reason);
  if (unreadable) return !/^4/.test(unreadable[1]);
  if (/^接口错误 (?:undefined|null)?$/.test(reason)) return true;
  return /生成接口未返回 Task ID/.test(reason) || isUncertainSubmitError(new Error(reason));
}

function backoffDelayMs(failures, baseSeconds = 30, maxSeconds = 300) {
  const exponent = Math.max(0, Math.min(4, Number(failures || 1) - 1));
  return Math.min(maxSeconds, baseSeconds * 2 ** exponent) * 1000;
}

class QueueEngine {
  constructor(store, accountManager, onChange = () => {}) {
    this.store = store;
    this.accounts = accountManager;
    this.onChange = onChange;
    this.timer = null;
    this.tickBusy = false;
    this.activeUploads = new Set();
    this.remotePollState = new Map();
    // Called when an accepted generation's Task ID could not be stored durably.
    this.onUnsavedSubmission = () => {};
    this.submitsPausedForPersistence = false;
  }

  get authenticated() {
    return this.accounts.authenticated;
  }

  state() {
    return this.store.snapshot({
      authenticated: this.accounts.authenticated,
      accountState: this.accounts.state(),
      activeUploads: [...this.activeUploads],
    });
  }

  emit() {
    this.onChange(this.state());
  }

  log(message, level = 'info') {
    this.store.log(message, level);
    this.emit();
  }

  recordTask(task, message, level = 'info', appendLog = true) {
    if (this.store.isFlowcutTaskCleared?.(task.flowcutTaskId)) return;
    const text = String(message || '');
    if (
      task.activity === text &&
      (!appendLog || (Array.isArray(task.logs) && task.logs[0]?.message === text))
    ) {
      return;
    }
    const timestamp = Date.now();
    task.activity = text;
    task.activityLevel = level;
    task.activityAt = timestamp;
    if (!Array.isArray(task.logs)) task.logs = [];
    if (appendLog && task.logs[0]?.message !== text) {
      task.logs.unshift({ time: timestamp, level, message: text });
      task.logs = task.logs.slice(0, 80);
    }
    this.store.upsertTask(task);
    this.emit();
  }

  start() {
    this.stop();
    this.recoverInterruptedTasks();
    this.tick();
    this.schedule();
  }

  recoverInterruptedTasks() {
    let recovered = 0;
    for (const task of this.store.tasks) {
      if (
        task.status === 'failed' &&
        task.imageItems?.some((item) => !item.uploadedUrl) &&
        isTransientNetworkError(task.errorMessage)
      ) {
        task.status = 'upload_wait';
        task.completedAt = 0;
        task.errorCode = '';
        task.errorMessage = '';
        task.uploadRetries = 0;
        task.transientUploadFailures = 0;
        task.nextUploadRetryAt = Date.now() + 5_000;
        this.recordTask(task, '检测到上次是临时网络中断，已自动恢复图片上传队列');
        recovered += 1;
      }
    }
    if (recovered) {
      this.store.log(`已恢复 ${recovered} 条因临时网络中断停止的 Seedance 任务`);
    }
    return recovered;
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      await this.tick();
      this.schedule();
    }, Math.max(5, Number(this.store.settings.pollSeconds || 20)) * 1000);
  }

  async refreshAuth(accountId = '') {
    const authenticated = await this.accounts.refreshAuth(accountId);
    this.emit();
    return authenticated;
  }

  setAuthRequired(error, accountId) {
    if (error instanceof AuthRequiredError || /登录|login|unauthorized/i.test(error.message)) {
      this.accounts.markAuthInvalid(accountId, error.message);
      this.emit();
      return true;
    }
    return false;
  }

  nextOrder() {
    return this.store.tasks.reduce((max, task) => Math.max(max, task.order || 0), 0) + 1;
  }

  createTask(prompt, imagePaths, metadata = {}) {
    const paths = [...new Set(imagePaths.filter(Boolean))];
    if (!prompt?.trim()) throw new Error('提示词不能为空');
    if (paths.length < 1 || paths.length > 9) throw new Error('每个任务必须包含 1–9 张图片');
    const task = {
      id: crypto.randomUUID(),
      order: this.nextOrder(),
      prompt: prompt.trim(),
      imageItems: paths.map((filePath) => ({
        name: path.basename(filePath),
        localPath: filePath,
        uploadedUrl: '',
      })),
      imageName: paths.map((filePath) => path.basename(filePath)).join('、'),
      status: 'upload_wait',
      attempts: 0,
      uploadRetries: 0,
      accountId: '',
      accountName: '',
      taskId: '',
      taskIds: [],
      duration: 15,
      errorCode: '',
      errorMessage: '',
      nextUploadRetryAt: Date.now(),
      createdAt: Date.now(),
      activity: `任务已加入，等待上传 ${paths.length} 张图片`,
      activityLevel: 'info',
      activityAt: Date.now(),
      logs: [
        {
          time: Date.now(),
          level: 'info',
          message: `任务已加入，等待上传 ${paths.length} 张图片`,
        },
      ],
      ...metadata,
    };
    this.store.upsertTask(task);
    this.log(`已加入任务：${task.imageItems.length} 张图片`);
    this.pumpUploads();
    return task;
  }

  createTasks(definitions) {
    let order = this.nextOrder();
    const tasks = definitions.map((definition) => {
      const imagePaths = [...new Set(definition.imagePaths.filter(Boolean))];
      if (!definition.prompt?.trim()) throw new Error('批量任务存在空提示词');
      if (imagePaths.length < 1 || imagePaths.length > 9) {
        throw new Error(`第 ${definition.excelRow} 行图片数量必须为 1–9`);
      }
      const task = {
        id: definition.id || crypto.randomUUID(),
        order: order++,
        prompt: definition.prompt.trim(),
        imageItems: imagePaths.map((filePath) => ({
          name: path.basename(filePath),
          localPath: filePath,
          uploadedUrl: '',
        })),
        imageName: imagePaths.map((filePath) => path.basename(filePath)).join('、'),
        status: 'upload_wait',
        attempts: 0,
        uploadRetries: 0,
        accountId: '',
        accountName: '',
        taskId: '',
        taskIds: [],
        errorCode: '',
        errorMessage: '',
        nextUploadRetryAt: Date.now(),
        createdAt: Date.now(),
        activity: `Excel 第 ${definition.excelRow} 行已加入，等待上传 ${imagePaths.length} 张图片`,
        activityLevel: 'info',
        activityAt: Date.now(),
        logs: [
          {
            time: Date.now(),
            level: 'info',
            message: `Excel 第 ${definition.excelRow} 行已加入，等待上传 ${imagePaths.length} 张图片`,
          },
        ],
        source: 'excel',
        excelRow: definition.excelRow,
        folderIndex: String(definition.excelRow),
      };
      return task;
    });
    this.store.addTasks(tasks);
    this.log(`已加入 ${tasks.length} 个 Excel 批量任务`);
    this.pumpUploads();
    return tasks;
  }

  updateTask(id, prompt, imagePaths) {
    const task = this.store.getTask(id);
    if (!task) throw new Error('任务不存在');
    if (!EDITABLE_STATUSES.has(task.status)) throw new Error('该任务正在运行，暂时不能修改');
    const uniquePaths = [...new Set(imagePaths.filter(Boolean))];
    if (!prompt?.trim()) throw new Error('提示词不能为空');
    if (uniquePaths.length < 1 || uniquePaths.length > 9) {
      throw new Error('每个任务必须包含 1–9 张图片');
    }
    const previous = new Map(task.imageItems.map((item) => [item.localPath, item]));
    task.prompt = prompt.trim();
    task.imageItems = uniquePaths.map((filePath) => {
      const old = previous.get(filePath);
      return {
        name: path.basename(filePath),
        localPath: filePath,
        uploadedUrl: old?.uploadedUrl || '',
        uploadedAccountId: old?.uploadedAccountId || task.accountId || '',
      };
    });
    task.imageName = task.imageItems.map((item) => item.name).join('、');
    task.errorCode = '';
    task.errorMessage = '';
    task.completedAt = 0;
    task.nextRetryAt = 0;
    task.taskId = '';
    task.attempts = 0;
    if (task.imageItems.some((item) => !item.uploadedUrl)) {
      task.status = 'upload_wait';
      task.nextUploadRetryAt = Date.now();
      task.uploadRetries = 0;
    } else {
      task.status = 'queued';
    }
    this.recordTask(
      task,
      task.status === 'upload_wait'
        ? '任务修改已保存，等待上传新增图片'
        : '任务修改已保存，等待生成并发空位',
    );
    this.log(`任务已修改：${task.imageItems.length} 张图片`);
    this.pumpUploads();
    return task;
  }

  removeTask(id) {
    const task = this.store.getTask(id);
    if (!task) return;
    if (['uploading', 'submitting', 'generating'].includes(task.status)) {
      throw new Error('运行中的任务不能删除');
    }
    this.store.removeTask(id);
    this.log('任务已删除');
  }

  retryTask(id) {
    const task = this.store.getTask(id);
    if (!task) throw new Error('任务不存在');
    if (task.status === 'submit_unconfirmed') {
      throw new Error(`这条任务的提交结果尚未确认。${UNCONFIRMED_SUBMIT_HINT}`);
    }
    task.errorCode = '';
    task.errorMessage = '';
    task.completedAt = 0;
    if (task.imageItems.some((item) => !item.uploadedUrl)) {
      task.status = 'upload_wait';
      task.nextUploadRetryAt = Date.now();
      this.recordTask(task, '已手动重试，等待重新上传图片');
    } else {
      task.status = 'queued';
      task.nextRetryAt = 0;
      this.recordTask(task, '已手动重试，等待重新提交生成任务');
    }
    this.log('任务已重新加入队列');
    this.pumpUploads();
    this.tick();
  }

  // A person asked FlowCut to retry a failed task. A new generation is only
  // started when no earlier one can still be running or already finished:
  // an existing Task ID is checked first, an unanswered submit is never
  // resent, and only the task's own prompt, settings and image files are used.
  async retryFailedTask(id) {
    const task = this.store.getTask(id);
    if (!task || task.status !== 'failed') return { action: 'none' };
    const hold = (action, message) => {
      task.errorMessage = message;
      this.recordTask(task, message, 'error');
      return { action, message };
    };
    if (task.taskId) {
      let remote;
      try {
        const history = await this.accounts
          .client(task.accountId || 'default')
          .fetchHistory([task.taskId]);
        remote = (history?.data?.draft_infos || []).find(
          (item) => String(item.taskId) === String(task.taskId),
        );
      } catch (error) {
        return hold(
          'check-failed',
          `重试前需要先核对原任务 Task ID ${task.taskId}，但暂时无法查询（${error.message}）。为避免重复生成，没有重新提交，请稍后再重试。`,
        );
      }
      if (!remote) {
        return hold(
          'not-found',
          `TikTok 生成历史中找不到原任务 Task ID ${task.taskId}，无法确认它是否已经生成。为避免重复生成，没有重新提交；请到 TikTok Symphony 核对，确认没有生成时请为该商品重新创建任务。`,
        );
      }
      if (this.isRemoteSuccess(remote)) {
        task.status = 'success';
        task.completedAt = Date.now();
        task.errorCode = '';
        task.errorMessage = '';
        this.applyVideoResult(task, remote);
        this.recordTask(task, `原任务 Task ID ${task.taskId} 已经生成成功，无需重新生成，将自动下载`, 'success');
        return { action: 'already-succeeded' };
      }
      if (!this.isRemoteFailure(remote)) {
        task.status = 'generating';
        task.errorCode = '';
        task.errorMessage = '';
        this.recordTask(task, `原任务 Task ID ${task.taskId} 仍在生成，继续追踪，不重新提交`);
        return { action: 'still-generating' };
      }
    } else if (isUncertainLegacyFailure(task)) {
      this.markSubmitUnconfirmed(task, task.errorMessage.slice('提交失败：'.length));
      return { action: 'unconfirmed', message: task.errorMessage };
    }
    const needsUpload = task.imageItems.some(
      (item) => !item.uploadedUrl || item.uploadedAccountId !== task.accountId,
    );
    // Re-uploading may redo every image (for example on another account).
    const missing = task.imageItems.filter(
      (item) => !(item.localPath && fs.existsSync(item.localPath)),
    );
    if (needsUpload && missing.length) {
      return hold(
        'images-missing',
        `原任务的图片文件已不存在（${missing.map((item) => item.localPath || item.name).join('、')}），无法按原图片重试；不会改用商品库当前图片。请为该商品重新创建任务。`,
      );
    }
    task.taskId = '';
    task.errorCode = '';
    task.errorMessage = '';
    task.completedAt = 0;
    task.attempts = 0;
    task.uploadRetries = 0;
    task.nextRetryAt = 0;
    task.nextUploadRetryAt = Date.now();
    task.status = needsUpload ? 'upload_wait' : 'queued';
    this.recordTask(
      task,
      needsUpload
        ? 'FlowCut 请求重试：使用原任务的图片重新上传后，按原提示词和参数提交'
        : 'FlowCut 请求重试：原任务已确认未生成成功，按原提示词、图片和参数重新提交',
    );
    this.pumpUploads();
    return { action: 'resubmitting' };
  }

  clearSuccess() {
    const count = this.store.clearSuccess();
    this.log(`已清除 ${count} 个成功任务`);
    return count;
  }

  setRunning(running) {
    this.store.updateSettings({ running: Boolean(running) });
    this.log(running ? '生成队列已启动' : '生成队列已暂停');
    if (running) return this.tick();
    return Promise.resolve();
  }

  updateSettings(patch) {
    const current = this.store.settings;
    const clean = {
      maxRetries: this.clamp(patch.maxRetries ?? current.maxRetries, 0, 20, 3),
      retryDelaySeconds: this.clamp(
        patch.retryDelaySeconds ?? current.retryDelaySeconds,
        10,
        3600,
        30,
      ),
      pollSeconds: this.clamp(patch.pollSeconds ?? current.pollSeconds, 5, 300, 20),
      maxUploadRetries: this.clamp(
        patch.maxUploadRetries ?? current.maxUploadRetries,
        0,
        30,
        10,
      ),
      uploadRetryDelaySeconds: this.clamp(
        patch.uploadRetryDelaySeconds ?? current.uploadRetryDelaySeconds,
        10,
        3600,
        60,
      ),
      uploadConcurrent: this.clamp(
        patch.uploadConcurrent ?? current.uploadConcurrent,
        1,
        5,
        3,
      ),
      downloadDirectory:
        patch.downloadDirectory == null
          ? current.downloadDirectory
          : path.resolve(String(patch.downloadDirectory)),
    };
    this.store.updateSettings(clean);
    this.log('设置已保存');
    this.schedule();
    this.pumpUploads();
    return clean;
  }

  clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  assignTaskAccount(task, account, resetUploads = true) {
    if (!account) return false;
    const changed = Boolean(task.accountId && task.accountId !== account.id);
    if (changed) {
      task.accountHistory = [
        ...(task.accountHistory || []),
        {
          accountId: task.accountId,
          accountName: task.accountName || this.accounts.accountName(task.accountId),
          changedAt: Date.now(),
        },
      ];
      if (resetUploads) {
        for (const item of task.imageItems) {
          item.uploadedUrl = '';
          item.uploadedAccountId = '';
        }
        task.uploadProgress = null;
      }
      task.taskId = '';
    }
    task.accountId = account.id;
    task.accountName = account.name;
    return changed;
  }

  releaseTaskAccount(task) {
    task.accountId = '';
    task.accountName = '';
    task.taskId = '';
    for (const item of task.imageItems) {
      item.uploadedUrl = '';
      item.uploadedAccountId = '';
    }
    task.uploadProgress = null;
  }

  switchAfterQuota(task, accountId, reason) {
    const accountName = this.accounts.accountName(accountId);
    const model = task.model || (task.taskId ? STANDARD_MODEL : FAST_MODEL);
    this.accounts.markModelExhausted(accountId, model, reason);
    task.status = 'model_wait';
    task.taskId = '';
    task.errorCode = 'MODEL_QUOTA_WAIT';
    task.errorMessage = `${accountName} · ${modelLabel(model)} 额度不足，等待模型选择`;
    this.recordTask(
      task,
      task.errorMessage,
      'error',
    );
  }

  resumeModelWaiters() {
    for (const task of this.store.tasks.filter(item => item.status === 'model_wait')) {
      const account = this.accounts.account(task.accountId);
      if (!account || !this.accounts.effectiveModel(account)) continue;
      task.status = task.imageItems.every(item => item.uploadedUrl && item.uploadedAccountId === account.id) ? 'queued' : 'upload_wait';
      task.errorCode = '';
      task.errorMessage = '';
      task.nextRetryAt = 0;
      task.nextUploadRetryAt = 0;
      this.recordTask(task, '模型可用，已恢复等待队列');
    }
  }

  async pumpUploads() {
    const available = Math.max(
      0,
      Number(this.store.settings.uploadConcurrent || 3) - this.activeUploads.size,
    );
    if (!available) return;
    const due = this.store.tasks
      .filter(
        (task) =>
          task.status === 'upload_wait' &&
          Number(task.nextUploadRetryAt || 0) <= Date.now() &&
          !this.activeUploads.has(task.id),
      )
      .slice(0, available);
    for (const task of due) this.uploadTask(task);
  }

  isUploadRetryable(message) {
    return !/积分|credit|登录|login|unauthorized|permission|forbidden/i.test(
      String(message || ''),
    );
  }

  async uploadTask(task) {
    if (this.store.isFlowcutTaskCleared?.(task.flowcutTaskId)) return;
    if (this.activeUploads.has(task.id)) return;
    this.activeUploads.add(task.id);
    const account = await this.accounts.availableAccount(task.accountId);
    if (!account) {
      task.status = 'upload_wait';
      task.nextUploadRetryAt = Date.now() + 30_000;
      task.errorMessage = '没有已登录且可用的 TikTok 账号';
      this.recordTask(task, '等待可用的 TikTok 账号', 'error');
      this.activeUploads.delete(task.id);
      this.emit();
      return;
    }
    const changedAccount = this.assignTaskAccount(task, account);
    task.status = 'uploading';
    task.errorMessage = '';
    task.uploadProgress = {
      current: 1,
      completed: task.imageItems.filter((item) => item.uploadedUrl).length,
      total: task.imageItems.length,
    };
    this.recordTask(
      task,
      changedAccount
        ? `已切换到账号“${account.name}”，重新上传 ${task.imageItems.length} 张图片`
        : `账号“${account.name}”开始上传，共 ${task.imageItems.length} 张图片`,
    );
    try {
      const client = this.accounts.client(account.id);
      for (let index = 0; index < task.imageItems.length; index += 1) {
        if (this.store.isFlowcutTaskCleared?.(task.flowcutTaskId)) return;
        const item = task.imageItems[index];
        if (item.uploadedUrl) continue;
        if (!item.localPath) throw new Error(`${item.name} 缺少本地路径`);
        task.uploadProgress = {
          current: index + 1,
          completed: task.imageItems.filter((image) => image.uploadedUrl).length,
          total: task.imageItems.length,
        };
        this.recordTask(
          task,
          `正在处理第 ${index + 1}/${task.imageItems.length} 张：${item.name}`,
        );
        item.uploadedUrl = await client.uploadImage(item.localPath, (message) => {
          this.recordTask(
            task,
            `第 ${index + 1}/${task.imageItems.length} 张 · ${message}`,
            message.includes('失败') ? 'error' : 'info',
          );
        });
        item.uploadedAccountId = account.id;
        task.uploadProgress.completed = index + 1;
        this.recordTask(
          task,
          `第 ${index + 1}/${task.imageItems.length} 张上传完成：${item.name}`,
          'success',
        );
        this.log(`任务图片上传完成 ${index + 1}/${task.imageItems.length}`);
      }
      task.status = 'queued';
      task.uploadRetries = 0;
      task.transientUploadFailures = 0;
      task.errorMessage = '';
      task.uploadProgress = {
        current: task.imageItems.length,
        completed: task.imageItems.length,
        total: task.imageItems.length,
      };
      this.recordTask(task, '全部图片上传完成，等待生成并发空位', 'success');
      this.log(`任务的 ${task.imageItems.length} 张图片已全部上传`);
      if (this.store.settings.running) this.tick();
    } catch (error) {
      if (this.setAuthRequired(error, account.id)) {
        this.releaseTaskAccount(task);
        task.status = 'upload_wait';
        task.nextUploadRetryAt = Date.now() + 30_000;
        task.errorMessage = '等待 TikTok 登录';
        this.recordTask(task, '图片上传暂停：等待 TikTok 登录', 'error');
      } else {
        const transientNetworkFailure = isTransientNetworkError(error);
        if (transientNetworkFailure) {
          task.transientUploadFailures = Number(task.transientUploadFailures || 0) + 1;
          const delayMs = backoffDelayMs(
            task.transientUploadFailures,
            Math.max(15, Number(this.store.settings.uploadRetryDelaySeconds || 60)),
          );
          task.status = 'upload_wait';
          task.completedAt = 0;
          task.nextUploadRetryAt = Date.now() + delayMs;
          task.errorMessage = `网络连接波动，${Math.ceil(delayMs / 1000)} 秒后继续上传：${error.message}`;
          this.recordTask(task, task.errorMessage, 'error');
          this.store.log(task.errorMessage, 'error');
          return;
        }
        task.uploadRetries = Number(task.uploadRetries || 0) + 1;
        const canRetry =
          task.uploadRetries <= this.store.settings.maxUploadRetries &&
          this.isUploadRetryable(error.message);
        if (canRetry) {
          task.status = 'upload_wait';
          task.nextUploadRetryAt =
            Date.now() + this.store.settings.uploadRetryDelaySeconds * 1000;
          task.errorMessage = `上传失败（${task.uploadRetries}/${this.store.settings.maxUploadRetries}），稍后重试：${error.message}`;
          this.recordTask(
            task,
            `上传失败，${this.store.settings.uploadRetryDelaySeconds} 秒后自动重试：${error.message}`,
            'error',
          );
        } else {
          task.status = 'failed';
          task.errorMessage = `上传失败：${error.message}`;
          task.completedAt = Date.now();
          this.recordTask(task, task.errorMessage, 'error');
        }
        this.store.log(task.errorMessage, 'error');
      }
    } finally {
      this.activeUploads.delete(task.id);
      this.emit();
      this.pumpUploads();
    }
  }

  isRemoteSuccess(remote) {
    if (this.extractVideoResult(remote).videoUrl) return true;
    return (
      Number(remote.draftTaskStatus) === 0 &&
      Number(remote.renderTaskStatus) === 0 &&
      remote.hasContent === true
    );
  }

  isRemoteFailure(remote) {
    return (
      Number(remote.draftTaskStatus) === 3 ||
      Number(remote.renderTaskStatus) === 3 ||
      Boolean(remote.generateErrorCode)
    );
  }

  extractVideoResult(remote) {
    const videoInfo = remote?.videoInfo || {};
    const original = videoInfo.OriginalVideoInfo || {};
    const variants = Array.isArray(videoInfo.VideoInfos) ? videoInfo.VideoInfos : [];
    const fallback = variants[variants.length - 1] || variants[0] || {};
    const selected = original.MainHTTPUrl || original.MainUrl ? original : fallback;
    const expiresSeconds = Number(selected.UrlExpire || fallback.UrlExpire || 0);
    return {
      videoUrl: selected.MainHTTPUrl || selected.MainUrl || '',
      videoBackupUrl: selected.BackupHTTPUrl || selected.BackupUrl || '',
      posterUrl: videoInfo.PosterUrl || '',
      videoUrlExpiresAt: expiresSeconds ? expiresSeconds * 1000 : 0,
    };
  }

  applyVideoResult(task, remote) {
    const result = this.extractVideoResult(remote);
    if (result.videoUrl) Object.assign(task, result);
    return result;
  }

  async refreshTaskResult(id) {
    const task = this.store.getTask(id);
    if (!task?.taskId) throw new Error('任务没有 TikTok Task ID');
    const accountId = task.accountId || 'default';
    const history = await this.accounts.client(accountId).fetchHistory([task.taskId]);
    const remote = (history?.data?.draft_infos || []).find(
      (item) => String(item.taskId) === String(task.taskId),
    );
    if (!remote) throw new Error('TikTok 历史记录中没有找到该任务');
    this.applyVideoResult(task, remote);
    this.store.upsertTask(task);
    this.emit();
    return task;
  }

  shouldRetry(task, errorCode, message) {
    if (task.attempts > this.store.settings.maxRetries) return false;
    if (String(errorCode) === '10043004') return false;
    return !/积分|credit|登录|login|unauthorized|permission/i.test(String(message || ''));
  }

  async syncRemoteStatuses() {
    const active = this.store.tasks.filter((task) =>
      ['submitting', 'generating'].includes(task.status),
    );
    if (!active.length) return;
    const grouped = new Map();
    for (const task of active) {
      const accountId = task.accountId || 'default';
      if (!grouped.has(accountId)) grouped.set(accountId, []);
      grouped.get(accountId).push(task);
    }
    for (const [accountId, tasks] of grouped) {
      const pollState = this.remotePollState.get(accountId) || {
        failures: 0,
        nextPollAt: 0,
      };
      if (pollState.nextPollAt > Date.now()) continue;
      let result;
      try {
        result = await this.accounts
          .client(accountId)
          .fetchHistory(tasks.map((task) => task.taskId));
      } catch (error) {
        pollState.failures += 1;
        pollState.nextPollAt =
          Date.now() + backoffDelayMs(pollState.failures, 15, 120);
        this.remotePollState.set(accountId, pollState);
        if (!this.setAuthRequired(error, accountId)) {
          this.store.log(
            `账号“${this.accounts.accountName(accountId)}”查询任务状态暂时失败，将持续重试：${error.message}`,
            'error',
          );
        }
        continue;
      }
      this.remotePollState.set(accountId, { failures: 0, nextPollAt: 0 });
      const remoteTasks = result?.data?.draft_infos || [];
      const byId = new Map(remoteTasks.map((item) => [String(item.taskId), item]));
      for (const task of tasks) {
        const remote = byId.get(String(task.taskId));
        if (!remote) {
          task.remoteMisses = Number(task.remoteMisses || 0) + 1;
          if (task.remoteMisses === 1 || task.remoteMisses % 15 === 0) {
            const elapsedMinutes = Math.max(
              1,
              Math.floor((Date.now() - Number(task.lastSubmittedAt || Date.now())) / 60_000),
            );
            this.recordTask(
              task,
              `Seedance 仍在排队或历史列表暂未返回该任务，已等待 ${elapsedMinutes} 分钟，将继续追踪`,
            );
          }
          continue;
        }
        task.remoteMisses = 0;
        if (this.isRemoteSuccess(remote)) {
          task.status = 'success';
          task.completedAt = Date.now();
          task.errorCode = '';
          task.errorMessage = '';
          task.remotePollFailures = 0;
          const videoResult = this.applyVideoResult(task, remote);
          this.recordTask(
            task,
            videoResult.videoUrl
              ? `账号“${task.accountName || this.accounts.accountName(accountId)}”生成成功，结果地址已保存`
              : '视频生成成功',
            'success',
          );
          this.store.log(`任务“${task.imageName}”生成成功`);
        } else if (this.isRemoteFailure(remote)) {
          task.errorCode = remote.generateErrorCode || '';
          task.errorMessage = remote.generateErrorMessage || '生成失败';
          if (
            this.accounts.isQuotaError({
              code: task.errorCode,
              message: task.errorMessage,
            })
          ) {
            this.switchAfterQuota(task, accountId, task.errorMessage);
          } else if (this.shouldRetry(task, task.errorCode, task.errorMessage)) {
            task.status = 'retry_wait';
            task.nextRetryAt = Date.now() + this.store.settings.retryDelaySeconds * 1000;
            this.recordTask(
              task,
              `生成失败（${task.errorCode || '未知错误'}），${this.store.settings.retryDelaySeconds} 秒后自动重试`,
              'error',
            );
            this.store.log(
              `生成失败（${task.errorCode || '未知错误'}），稍后自动重试`,
              'error',
            );
          } else {
            task.status = 'failed';
            task.completedAt = Date.now();
            this.recordTask(
              task,
              `生成停止：${task.errorCode || task.errorMessage}`,
              'error',
            );
            this.store.log(`任务停止重试：${task.errorCode || task.errorMessage}`, 'error');
          }
        } else if (task.status === 'submitting') {
          task.status = 'generating';
          this.recordTask(task, 'TikTok 已接收任务，正在生成视频');
        }
      }
    }
  }

  markSubmitUnconfirmed(task, reason) {
    task.status = 'submit_unconfirmed';
    task.errorCode = 'SUBMIT_UNCONFIRMED';
    task.errorMessage = `提交结果不确定（${reason}）。${UNCONFIRMED_SUBMIT_HINT}`;
    task.completedAt = Date.now();
    this.recordTask(task, task.errorMessage, 'error');
    this.store.log(`任务“${task.imageName || task.id}”提交结果不确定，未自动重发：${reason}`, 'error');
  }

  async submitTask(task, account) {
    if (this.store.isFlowcutTaskCleared?.(task.flowcutTaskId)) return;
    this.assignTaskAccount(task, account, false);
    const selectedModel = this.accounts.effectiveModel ? this.accounts.effectiveModel(account) : requireModel(account.preferredModel);
    if (!selectedModel) {
      task.status = 'model_wait';
      this.recordTask(task, '当前账号模型额度不足，等待用户选择');
      return;
    }
    task.model = requireModel(selectedModel);
    const previousStatus = task.status;
    const intentId = crypto.randomUUID();
    task.status = 'submitting';
    task.errorCode = '';
    task.errorMessage = '';
    task.submitOutcome = '';
    task.submitStartedAt = Date.now();
    task.submitIntents = [...(task.submitIntents || []), intentId].slice(-20);
    // Write-ahead: the attempt must be on disk before the request leaves, so a
    // restart can never take a possibly accepted job for one that was never sent.
    const intentRecorded = this.store.recordSubmission?.({
      type: 'intent',
      intentId,
      localTaskId: task.id,
      accountId: account.id,
      flowcutTaskId: task.flowcutTaskId || '',
      at: task.submitStartedAt,
      snapshot: submissionSnapshot(task),
    }) === true;
    this.recordTask(task, `正在使用账号“${account.name}” · ${modelLabel(task.model)} 提交生成任务`);
    const stateSaved = typeof this.store.save === 'function' ? this.store.save() !== false : true;
    if (!intentRecorded && !stateSaved) {
      task.status = previousStatus;
      task.submitIntents = task.submitIntents.filter((id) => id !== intentId);
      const message = `本机无法保存提交记录（${this.store.persistError?.message || '写入失败'}），为避免重启后重复生成，已暂停提交新任务；已提交的任务继续查询，恢复保存后自动继续`;
      if (!this.submitsPausedForPersistence) this.store.log(message, 'error');
      this.submitsPausedForPersistence = true;
      this.recordTask(task, message, 'error');
      this.emit();
      return 'not-durable';
    }
    if (this.submitsPausedForPersistence) {
      this.submitsPausedForPersistence = false;
      this.store.log('本机提交记录已可保存，恢复提交新任务');
    }
    let result;
    try {
      result = await this.accounts.client(account.id).submitTask(task);
    } catch (error) {
      let refusal = '';
      if (isUncertainSubmitError(error)) {
        // Checked first: an unreadable answer may still hide an accepted job.
        this.markSubmitUnconfirmed(task, error.message);
      } else if (this.accounts.isQuotaError(error)) {
        refusal = 'quota';
        this.switchAfterQuota(task, account.id, error.message);
      } else if (this.setAuthRequired(error, account.id)) {
        refusal = 'auth';
        this.releaseTaskAccount(task);
        task.status = 'upload_wait';
        task.nextUploadRetryAt = Date.now() + 30_000;
        task.errorMessage = '等待 TikTok 登录';
        this.recordTask(task, '提交暂停：等待其他已登录账号', 'error');
      } else if (/too many|rate.?limit|concurren|频繁|并发|HTTP 429/i.test(error.message)) {
        refusal = 'rate-limited';
        task.status = 'retry_wait';
        task.nextRetryAt = Date.now() + 60_000;
        this.recordTask(task, '平台限流或并发已满，稍后继续使用同一模型');
      } else {
        refusal = 'rejected';
        task.status = 'failed';
        task.submitOutcome = 'rejected';
        task.errorMessage = `提交失败：${error.message}`;
        task.completedAt = Date.now();
        this.recordTask(task, task.errorMessage, 'error');
        this.store.log(task.errorMessage, 'error');
      }
      // If the task list cannot hold this definite answer, the journal keeps
      // it, so a restart restores it instead of the older "queued" state.
      if (refusal) {
        const outcomeSaved = typeof this.store.save === 'function' ? this.store.save() !== false : true;
        if (!outcomeSaved) {
          this.store.recordSubmission?.({
            type: 'resolved',
            intentId,
            localTaskId: task.id,
            outcome: refusal,
            result: refusalResult(task),
          });
        }
      }
      this.emit();
      return;
    }
    const remoteTaskId = String(result?.data?.task_id || '');
    if (!remoteTaskId) {
      // Accepted without an ID: the generation cannot be tracked or ruled out.
      this.markSubmitUnconfirmed(task, '生成接口未返回 Task ID');
      this.emit();
      return;
    }
    // The platform accepted the generation. Nothing below may turn that into
    // a failure: local bookkeeping errors only affect how it is recorded.
    task.attempts = Number(task.attempts || 0) + 1;
    task.lastSubmittedAt = Date.now();
    task.taskId = remoteTaskId;
    task.taskIds = [...(task.taskIds || []), remoteTaskId];
    task.status = 'generating';
    let journaled = false;
    try {
      journaled = this.store.recordSubmission?.({
        type: 'accepted',
        intentId,
        localTaskId: task.id,
        taskId: remoteTaskId,
        accountId: account.id,
        flowcutTaskId: task.flowcutTaskId || '',
        submittedAt: task.lastSubmittedAt,
        snapshot: submissionSnapshot(task),
      }) === true;
      this.accounts.markAuthenticated(account.id);
      this.recordTask(
        task,
        `账号“${account.name}”提交成功，正在生成视频 · Task ID ${remoteTaskId}`,
        'success',
      );
      this.store.log(`账号“${account.name}”已提交任务，Task ID：${remoteTaskId}`);
    } catch (error) {
      console.error('[seedance] bookkeeping after an accepted submission failed', error);
    }
    if (!journaled && this.store.persistError) {
      this.onUnsavedSubmission({
        taskId: remoteTaskId,
        localTaskId: task.id,
        flowcutTaskId: task.flowcutTaskId || '',
        accountName: account.name,
      });
    }
    this.emit();
  }

  async tick() {
    if (this.tickBusy) return;
    this.tickBusy = true;
    try {
      this.resumeModelWaiters();
      this.pumpUploads();
      const hasNetworkWork =
        this.store.settings.running ||
        this.store.tasks.some((task) => ['submitting', 'generating'].includes(task.status));
      if (!hasNetworkWork) return;
      if (
        !this.accounts.authenticated ||
        Date.now() - this.accounts.authCheckedAt > 60_000
      ) {
        await this.refreshAuth();
      }
      if (!this.accounts.authenticated) return;
      await this.syncRemoteStatuses();
      if (!this.store.settings.running) return;
      const due = this.store.tasks
        .filter(
          (task) =>
            task.status === 'queued' ||
            (task.status === 'retry_wait' && Number(task.nextRetryAt || 0) <= Date.now()),
        )
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      const slotCache = new Map();
      for (const task of due) {
        if (!this.store.settings.running) break;
        const account = await this.accounts.availableAccount(task.accountId);
        if (!account) {
          this.recordTask(task, '没有已登录且可用的账号，继续排队', 'error');
          continue;
        }
        const changedAccount = this.assignTaskAccount(task, account);
        if (
          changedAccount ||
          task.imageItems.some(
            (item) => !item.uploadedUrl || item.uploadedAccountId !== account.id,
          )
        ) {
          task.status = 'upload_wait';
          task.nextUploadRetryAt = Date.now();
          this.recordTask(task, `切换到账号“${account.name}”，等待重新上传图片`);
          this.pumpUploads();
          continue;
        }
        if (!slotCache.has(account.id)) {
          try {
            const client = this.accounts.client(account.id);
            const runningCount = await client.getGeneratingCount();
            const runtime = this.accounts.ensureRuntime(account.id);
            runtime.generatingCount = runningCount;
            slotCache.set(
              account.id,
              Math.max(0, Number(runtime.maxConcurrent || 5) - runningCount),
            );
          } catch (error) {
            if (this.accounts.isQuotaError(error)) {
              this.switchAfterQuota(task, account.id, error.message);
            } else {
              this.setAuthRequired(error, account.id);
            }
            continue;
          }
        }
        const slots = slotCache.get(account.id);
        if (slots <= 0) {
          this.recordTask(
            task,
            `账号“${account.name}”当前生成并发已满，继续排队`,
          );
          continue;
        }
        const submitted = await this.submitTask(task, account);
        // Nothing may be sent while attempts cannot be recorded; polling goes on.
        if (submitted === 'not-durable') break;
        if (task.status === 'generating') {
          slotCache.set(account.id, slots - 1);
        }
      }
    } catch (error) {
      this.store.log(`调度异常：${error.message}`, 'error');
    } finally {
      this.tickBusy = false;
      this.emit();
    }
  }
}

module.exports = {
  QueueEngine,
  EDITABLE_STATUSES,
  UNCONFIRMED_SUBMIT_HINT,
  isTransientNetworkError,
  isUncertainLegacyFailure,
  isUncertainSubmitError,
};
