const fs = require('node:fs');
const path = require('node:path');
const { FAST_MODEL, STANDARD_MODEL, requireModel } = require('./models');

const DEFAULT_SETTINGS = {
  running: false,
  maxConcurrent: 5,
  maxRetries: 3,
  retryDelaySeconds: 30,
  pollSeconds: 20,
  maxUploadRetries: 10,
  uploadRetryDelaySeconds: 60,
  uploadConcurrent: 3,
  apiEnabled: true,
  apiPort: 17890,
  apiKey: '',
  flowcutBridgeEnabled: true,
  flowcutBridgeUrl: 'http://127.0.0.1:4173',
  flowcutWorkerId: '',
  downloadDirectory: '',
  activeAccountId: 'default',
};

const DEFAULT_ACCOUNT = {
  id: 'default',
  name: '账号 1',
  partition: 'persist:tiktok-symphony',
  enabled: true,
  exhaustedDate: '',
  exhaustedReason: '',
};

class WorkbenchStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'workbench-state.json');
    this.data = {
      version: 1,
      settings: { ...DEFAULT_SETTINGS },
      accounts: [{ ...DEFAULT_ACCOUNT, createdAt: Date.now() }],
      tasks: [],
      clearedFlowcutTaskIds: [],
      logs: [],
    };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.data = {
        version: 1,
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        accounts:
          Array.isArray(parsed.accounts) && parsed.accounts.length
            ? parsed.accounts
            : [{ ...DEFAULT_ACCOUNT, createdAt: Date.now() }],
        clearedFlowcutTaskIds: Array.isArray(parsed.clearedFlowcutTaskIds) ? parsed.clearedFlowcutTaskIds : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        logs: Array.isArray(parsed.logs) ? parsed.logs.slice(0, 200) : [],
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.data.logs.unshift({
          time: Date.now(),
          level: 'error',
          message: `任务库读取失败，已使用空任务库：${error.message}`,
        });
      }
    }

    for (const account of this.data.accounts) {
      try { account.preferredModel = requireModel(account.preferredModel); }
      catch { account.preferredModel = FAST_MODEL; }
      account.modelQuota ||= {};
      // Old versions only submitted the standard model.
      if (account.exhaustedDate) {
        account.modelQuota[STANDARD_MODEL] ||= { date: account.exhaustedDate, reason: account.exhaustedReason };
        account.exhaustedDate = '';
        account.exhaustedReason = '';
      }
    }
    for (const task of this.data.tasks) {
      if (!task.accountId) task.accountId = 'default';
      delete task.editing;
      if (!Array.isArray(task.logs)) task.logs = [];
      if (!task.activity) {
        const activityByStatus = {
          draft: '等待完善任务',
          upload_wait: '等待上传图片',
          uploading: '正在上传图片',
          queued: '图片已上传，等待生成并发空位',
          submitting: '正在提交生成任务',
          generating: '已提交，正在生成视频',
          retry_wait: '生成失败，等待自动重试',
          success: '视频生成成功',
          failed: task.errorMessage || '任务已停止',
        };
        task.activity = activityByStatus[task.status] || '等待处理';
        task.activityAt = Date.now();
      }
      if (['uploading', 'submitting'].includes(task.status)) {
        task.status = task.status === 'uploading' ? 'upload_wait' : 'queued';
        task.activity =
          task.status === 'upload_wait' ? '软件重新启动，等待恢复图片上传' : '等待重新提交';
      }
    }
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  snapshot(extra = {}) {
    return JSON.parse(
      JSON.stringify({
        settings: this.data.settings,
        accounts: this.data.accounts,
        tasks: [...this.data.tasks].sort((a, b) => (a.order || 0) - (b.order || 0)),
        logs: this.data.logs.slice(0, 100),
        ...extra,
      }),
    );
  }

  get settings() {
    return this.data.settings;
  }

  get tasks() {
    return this.data.tasks;
  }

  get accounts() {
    return this.data.accounts;
  }

  getAccount(id) {
    return this.data.accounts.find((account) => account.id === id);
  }

  upsertAccount(account) {
    const index = this.data.accounts.findIndex((item) => item.id === account.id);
    if (index >= 0) this.data.accounts[index] = account;
    else this.data.accounts.push(account);
    this.save();
    return account;
  }

  removeAccount(id) {
    this.data.accounts = this.data.accounts.filter((account) => account.id !== id);
    if (this.data.settings.activeAccountId === id) {
      this.data.settings.activeAccountId = this.data.accounts[0]?.id || 'default';
    }
    this.save();
  }

  getTask(id) {
    return this.data.tasks.find((task) => task.id === id);
  }

  isFlowcutTaskCleared(id) { return Boolean(id) && this.data.clearedFlowcutTaskIds.includes(id); }

  clearFlowcutTasks(ids) {
    this.data.clearedFlowcutTaskIds = [...new Set([...this.data.clearedFlowcutTaskIds, ...ids])];
    this.data.tasks = this.data.tasks.filter(task => !this.isFlowcutTaskCleared(task.flowcutTaskId));
    this.save();
  }

  upsertTask(task) {
    if (this.isFlowcutTaskCleared(task.flowcutTaskId)) return task;
    const index = this.data.tasks.findIndex((item) => item.id === task.id);
    if (index >= 0) this.data.tasks[index] = task;
    else this.data.tasks.push(task);
    this.save();
    return task;
  }

  addTasks(tasks) {
    this.data.tasks.push(...tasks.filter(task => !this.isFlowcutTaskCleared(task.flowcutTaskId)));
    this.save();
  }

  removeTask(id) {
    this.data.tasks = this.data.tasks.filter((task) => task.id !== id);
    this.save();
  }

  clearSuccess() {
    const before = this.data.tasks.length;
    this.data.tasks = this.data.tasks.filter((task) => task.status !== 'success');
    this.save();
    return before - this.data.tasks.length;
  }

  updateSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.data.settings;
  }

  log(message, level = 'info') {
    const entry = { time: Date.now(), level, message: String(message) };
    this.data.logs.unshift(entry);
    this.data.logs = this.data.logs.slice(0, 200);
    this.save();
    return entry;
  }
}

module.exports = { WorkbenchStore, DEFAULT_SETTINGS };
