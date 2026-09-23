const fs = require('node:fs');
const path = require('node:path');
const { FAST_MODEL, STANDARD_MODEL, requireModel } = require('./models');
const {
  QUICK_RETRY_DELAYS_MS,
  describeBlockedState,
  loadJsonState,
  withFsRetry,
  writeTextDurable,
} = require('./durable-json');

const UNCONFIRMED_RESTART_MESSAGE =
  '软件重新启动时这条任务正在提交，无法确认 TikTok 是否已经收到。为避免重复生成，没有自动重新提交。请到 TikTok Symphony 生成历史核对：已生成可在历史中取回视频；确认没有生成时，请为该商品重新创建任务。';

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '不是有效的任务库对象';
  if (value.tasks !== undefined && !Array.isArray(value.tasks)) return 'tasks 格式错误';
  if (value.accounts !== undefined && !Array.isArray(value.accounts)) return 'accounts 格式错误';
  if (!value.settings && !Array.isArray(value.tasks)) return '缺少任务库内容';
  return '';
}

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
  constructor(userDataPath, { onPersistError = null, onPersistRecovered = null } = {}) {
    this.filePath = path.join(userDataPath, 'workbench-state.json');
    // Append-only record of accepted generations. It survives even when the
    // task list could not be saved after a submission.
    this.submissionJournalPath = path.join(userDataPath, 'submitted-tasks.jsonl');
    // Records that match no task are moved here and kept; never deleted.
    this.unmatchedJournalPath = path.join(userDataPath, 'submitted-tasks-unmatched.jsonl');
    this.journalEntries = [];
    this.journalRecovery = { restored: [], unmatched: [] };
    this.persistError = null;
    this.onPersistError = onPersistError;
    this.onPersistRecovered = onPersistRecovered;
    this.blocked = null;
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
    const loaded = loadJsonState({ file: this.filePath, validate: validateState });
    this.loadResult = loaded;
    if (loaded.status === 'blocked') {
      // Never replace unreadable or damaged tasks with an empty task list.
      this.blocked = { ...loaded, message: describeBlockedState(loaded, 'Seedance 任务库') };
      return;
    }
    if (loaded.value) {
      const parsed = loaded.value;
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
    }
    if (loaded.status === 'recovered') {
      this.data.logs.unshift({
        time: Date.now(),
        level: 'error',
        message: `任务库${loaded.damage === 'missing' ? '缺失' : '已损坏'}，已从备份 ${path.basename(loaded.source)} 恢复${loaded.preserved ? `；损坏文件保留为 ${loaded.preserved}` : ''}`,
      });
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
    }
    this.journalEntries = this.readSubmissionJournal();
    this.applySubmissionJournal();
    for (const task of this.data.tasks) {
      if (task.status === 'uploading') {
        task.status = 'upload_wait';
        task.activity = '软件重新启动，等待恢复图片上传';
      } else if (task.status === 'submitting') {
        // The request may have reached TikTok before the restart.
        task.status = 'submit_unconfirmed';
        task.errorCode = 'SUBMIT_UNCONFIRMED';
        task.errorMessage = UNCONFIRMED_RESTART_MESSAGE;
        task.activity = UNCONFIRMED_RESTART_MESSAGE;
        task.activityLevel = 'error';
        task.activityAt = Date.now();
      }
    }
    // Saving prunes the journal records this task list now contains.
    this.save();
  }

  readSubmissionJournal() {
    let text = '';
    try {
      text = withFsRetry(() => fs.readFileSync(this.submissionJournalPath, 'utf8'));
    } catch {
      return [];
    }
    const entries = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.localTaskId && entry?.taskId) entries.push(entry);
      } catch {
        // A line cut off by a crash; complete lines before it are still valid.
      }
    }
    return entries;
  }

  // Adds submissions the saved task list does not know about yet, so a task
  // that was accepted before a failed save is tracked instead of resubmitted.
  // A task missing from the list is rebuilt from the record's snapshot.
  applySubmissionJournal() {
    const unmatched = [];
    for (const entry of this.journalEntries) {
      if (this.isFlowcutTaskCleared(entry.flowcutTaskId)) continue;
      const taskId = String(entry.taskId);
      let task = this.getTask(entry.localTaskId);
      if (task && (task.taskIds || []).map(String).includes(taskId)) continue;
      const accountId = entry.accountId || task?.accountId || entry.snapshot?.accountId || '';
      if (accountId && !this.getAccount(accountId)) {
        unmatched.push({ entry, reason: '提交所用的 Seedance 账号已不在账号列表中' });
        continue;
      }
      if (!task) {
        if (!entry.snapshot?.id) {
          unmatched.push({ entry, reason: '任务库中没有这条任务，也没有可用于恢复的任务快照' });
          continue;
        }
        task = { ...entry.snapshot, logs: [], restoredFromJournal: true };
        this.data.tasks.push(task);
        this.journalRecovery.restored.push({ localTaskId: task.id, taskId, flowcutTaskId: task.flowcutTaskId || '' });
      }
      task.taskId = taskId;
      task.taskIds = [...(task.taskIds || []).filter((id) => String(id) !== taskId), taskId];
      task.accountId = accountId || task.accountId;
      task.status = 'generating';
      task.errorCode = '';
      task.errorMessage = '';
      // A snapshot is taken after the attempt was already counted.
      if (!task.restoredFromJournal) task.attempts = Number(task.attempts || 0) + 1;
      task.lastSubmittedAt = Number(entry.submittedAt || Date.now());
      task.activity = `已按提交记录恢复 Task ID ${taskId}，继续追踪生成结果`;
      task.activityLevel = 'info';
      task.activityAt = Date.now();
      task.logs = [{ time: Date.now(), level: 'info', message: task.activity }, ...(task.logs || [])].slice(0, 80);
      delete task.restoredFromJournal;
    }
    this.moveUnmatchedSubmissions(unmatched);
  }

  // Keeps records that cannot be applied in a separate file (never deleted)
  // and reports them, instead of dropping them when the journal is pruned.
  moveUnmatchedSubmissions(unmatched) {
    const before = this.journalEntries.length;
    for (const { entry, reason } of unmatched) {
      this.journalRecovery.unmatched.push({ taskId: String(entry.taskId), reason, entry });
      try {
        withFsRetry(() => {
          const descriptor = fs.openSync(this.unmatchedJournalPath, 'a');
          try {
            fs.writeSync(descriptor, `${JSON.stringify({ ...entry, unmatchedReason: reason, movedAt: Date.now() })}\n`);
            fs.fsyncSync(descriptor);
          } finally {
            fs.closeSync(descriptor);
          }
        });
        this.journalEntries = this.journalEntries.filter((item) => item !== entry);
      } catch {
        // Stays in the main journal and is reported again next start.
      }
    }
    if (this.journalEntries.length !== before) {
      try {
        this.writeSubmissionJournal(this.journalEntries);
      } catch {
        // The kept copy exists; a duplicate in the main journal is only re-reported.
      }
    }
    if (unmatched.length) {
      this.data.logs.unshift({
        time: Date.now(),
        level: 'error',
        message: `${unmatched.length} 条已提交的生成无法对应到本机任务，记录已保存在 ${this.unmatchedJournalPath}：${unmatched.map(({ entry }) => entry.taskId).join('、')}`,
      });
    }
  }

  // A record may only leave the journal once the saved task list holds it.
  isJournalEntryDurable(entry) {
    if (this.isFlowcutTaskCleared(entry.flowcutTaskId)) return true;
    const task = this.getTask(entry.localTaskId);
    return Boolean(task && (task.taskIds || []).map(String).includes(String(entry.taskId)));
  }

  recordSubmission(entry) {
    if (this.blocked) return false;
    try {
      withFsRetry(() => {
        const descriptor = fs.openSync(this.submissionJournalPath, 'a');
        try {
          fs.writeSync(descriptor, `${JSON.stringify(entry)}\n`);
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
      });
      this.journalEntries.push(entry);
      return true;
    } catch {
      return false;
    }
  }

  // Called after a successful save: drops only the records it now contains.
  pruneSubmissionJournal() {
    if (!this.journalEntries.length) return;
    const remaining = this.journalEntries.filter((entry) => !this.isJournalEntryDurable(entry));
    if (remaining.length === this.journalEntries.length) return;
    try {
      this.writeSubmissionJournal(remaining);
      this.journalEntries = remaining;
    } catch {
      // Harmless: kept records are checked again after the next save.
    }
  }

  writeSubmissionJournal(entries) {
    if (!entries.length) {
      withFsRetry(() => fs.rmSync(this.submissionJournalPath, { force: true }));
      return;
    }
    writeTextDurable(
      this.submissionJournalPath,
      entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      { backup: 'none' },
    );
  }

  // Returns false instead of throwing: a failed write must not turn an accepted
  // generation or a finished download into a failure. The owner is notified.
  save() {
    if (this.blocked) return false;
    try {
      writeTextDurable(this.filePath, JSON.stringify(this.data, null, 2), {
        delays: this.persistError ? QUICK_RETRY_DELAYS_MS : undefined,
      });
    } catch (error) {
      const firstFailure = !this.persistError;
      this.persistError = {
        file: this.filePath,
        code: String(error?.code || ''),
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      };
      if (firstFailure) this.onPersistError?.(this.persistError);
      return false;
    }
    this.pruneSubmissionJournal();
    if (this.persistError) {
      const previous = this.persistError;
      this.persistError = null;
      this.onPersistRecovered?.(previous);
    }
    return true;
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
