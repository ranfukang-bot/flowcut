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

// The journal decides which tasks must not be sent again, so a locked file
// is waited for a little longer before startup stops.
const JOURNAL_READ_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600, 3200];

const UNCONFIRMED_RESTART_MESSAGE =
  '软件重新启动时这条任务正在提交，无法确认 TikTok 是否已经收到。为避免重复生成，没有自动重新提交。请到 TikTok Symphony 生成历史核对：已生成可在历史中取回视频；确认没有生成时，请为该商品重新创建任务。';

// A record counts as saved only if it reads back as its own complete line:
// fsync alone does not prove that. The leading newline separates it from a
// line cut off by an earlier crash, which would otherwise swallow it.
function appendJsonLine(file, entry) {
  const line = JSON.stringify(entry);
  const bytes = Buffer.from(`\n${line}\n`, 'utf8');
  withFsRetry(() => {
    const descriptor = fs.openSync(file, 'a');
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
        if (!written) throw new Error('提交记录没有写入任何内容');
        offset += written;
      }
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  });
  const text = withFsRetry(() => fs.readFileSync(file, 'utf8'));
  if (!text.split(/\r?\n/).includes(line)) throw new Error('提交记录写入后无法完整读回');
}

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
    this.pendingUnmatched = new Map();
    this.movedUnmatched = new Set();
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
    const journal = this.readSubmissionJournal();
    if (journal.error) {
      // Its records decide which tasks must not be sent again; never guess.
      this.blocked = {
        reason: 'journal-unreadable',
        file: this.submissionJournalPath,
        error: journal.error,
        message: `无法读取 Seedance 提交记录：${this.submissionJournalPath}（${journal.error.message}）。可能被杀毒或备份软件占用。为避免重复生成，FlowCut 已停止启动，没有改动任何文件。请稍后重新打开 FlowCut；如果持续出现，请把 FlowCut 数据文件夹加入杀毒软件白名单。`,
      };
      return;
    }
    this.journalEntries = journal.entries;
    this.replaySubmissionJournal();
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
      text = withFsRetry(
        () => fs.readFileSync(this.submissionJournalPath, 'utf8'),
        JOURNAL_READ_RETRY_DELAYS_MS,
      );
    } catch (error) {
      if (error?.code === 'ENOENT') return { entries: [] };
      return { entries: [], error };
    }
    const entries = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.localTaskId && (entry.taskId || ['intent', 'resolved'].includes(entry.type))) {
          entries.push(entry);
        }
      } catch {
        // A line cut off by a crash; complete lines before it are still valid.
      }
    }
    return { entries };
  }

  // Brings the saved task list up to date with submission attempts it may
  // have missed. Records are grouped per attempt in the order they were
  // written, and only each task's latest attempt decides its state, so an
  // older answer can never overwrite a newer one.
  replaySubmissionJournal() {
    const attemptsByTask = new Map();
    const attemptByKey = new Map();
    for (const entry of this.journalEntries) {
      const key = entry.intentId || `accepted:${entry.taskId}`;
      let attempt = attemptByKey.get(key);
      if (!attempt) {
        attempt = { intentId: entry.intentId || '', entries: [] };
        attemptByKey.set(key, attempt);
        if (!attemptsByTask.has(entry.localTaskId)) attemptsByTask.set(entry.localTaskId, []);
        attemptsByTask.get(entry.localTaskId).push(attempt);
      }
      attempt.entries.push(entry);
    }
    for (const [localTaskId, attempts] of attemptsByTask) {
      for (const attempt of attempts) {
        attempt.accepted = attempt.entries.find((entry) => entry.taskId);
        attempt.resolved = attempt.entries.find((entry) => entry.type === 'resolved');
        attempt.snapshot = attempt.accepted?.snapshot || attempt.entries.find((entry) => entry.snapshot)?.snapshot;
      }
      const latest = attempts[attempts.length - 1];
      const flowcutTaskId = latest.entries.find((entry) => entry.flowcutTaskId)?.flowcutTaskId
        || latest.snapshot?.flowcutTaskId || '';
      if (this.isFlowcutTaskCleared(flowcutTaskId)) continue;
      // Accepted work on a removed account is kept aside once its hold is saved.
      for (const attempt of attempts) {
        const accountId = attempt.accepted?.accountId || attempt.snapshot?.accountId || '';
        if (attempt.accepted && accountId && !this.getAccount(accountId)) {
          this.queueUnmatched(attempt.accepted, '提交所用的 Seedance 账号已不在账号列表中');
        }
      }
      let task = this.getTask(localTaskId);
      if (task && this.savedListIsCurrent(task, latest)) continue;
      if (!task) {
        const snapshot = [...attempts].reverse().find((attempt) => attempt.snapshot?.id)?.snapshot;
        if (!snapshot) {
          for (const attempt of attempts) {
            this.queueUnmatched(attempt.accepted || attempt.entries[0], '任务库中没有这条任务，也没有可用于恢复的任务快照');
          }
          continue;
        }
        task = { ...snapshot, logs: [], restoredFromJournal: true };
        this.data.tasks.push(task);
        this.journalRecovery.restored.push({
          localTaskId: task.id,
          taskId: String(latest.accepted?.taskId || ''),
          flowcutTaskId: task.flowcutTaskId || '',
        });
      }
      // Every attempt joins the task's history in the order it was made.
      for (const attempt of attempts) {
        if (attempt.intentId && !(task.submitIntents || []).includes(attempt.intentId)) {
          task.submitIntents = [...(task.submitIntents || []), attempt.intentId].slice(-20);
        }
        const acceptedId = String(attempt.accepted?.taskId || '');
        if (acceptedId && !(task.taskIds || []).map(String).includes(acceptedId)) {
          task.taskIds = [...(task.taskIds || []), acceptedId];
        }
      }
      this.applyAttemptOutcome(task, latest);
      delete task.restoredFromJournal;
    }
    const unmatched = this.journalRecovery.unmatched;
    if (unmatched.length) {
      this.data.logs.unshift({
        time: Date.now(),
        level: 'error',
        message: `${unmatched.length} 条已提交的生成无法对应到本机任务，保存后会转存到 ${this.unmatchedJournalPath}：${unmatched.map((item) => item.taskId).join('、')}`,
      });
    }
  }

  // True when the saved list already shows this attempt's outcome, or an
  // attempt made after it.
  savedListIsCurrent(task, attempt) {
    if (!attempt.intentId) {
      return (task.taskIds || []).map(String).includes(String(attempt.accepted?.taskId));
    }
    const intents = task.submitIntents || [];
    const position = intents.indexOf(attempt.intentId);
    if (position < 0) return false;
    if (position < intents.length - 1) return true;
    if (attempt.accepted) return (task.taskIds || []).map(String).includes(String(attempt.accepted.taskId));
    if (attempt.resolved) return task.status !== 'submitting';
    // Only the attempt itself was saved: "submitting" becomes unconfirmed below.
    return true;
  }

  applyAttemptOutcome(task, attempt) {
    const labels = { rejected: '平台已明确拒绝', 'rate-limited': '平台限流，稍后自动重试', auth: '等待 TikTok 登录', quota: '模型额度不足' };
    let message;
    let level = 'info';
    if (attempt.accepted) {
      const entry = attempt.accepted;
      const taskId = String(entry.taskId);
      const accountId = entry.accountId || task.accountId || '';
      task.taskId = taskId;
      if (accountId && !this.getAccount(accountId)) {
        // Accepted but no longer trackable: never let this task be sent again.
        message = `已提交（Task ID ${taskId}），但提交所用的 Seedance 账号已不在账号列表中，无法自动追踪和下载。为避免重复生成，不会重新提交；请在 TikTok Symphony 生成历史中按 Task ID 取回视频。`;
        task.status = 'submit_unconfirmed';
        task.errorCode = 'SUBMIT_UNCONFIRMED';
        task.errorMessage = message;
        level = 'error';
      } else {
        message = `已按提交记录恢复 Task ID ${taskId}，继续追踪生成结果`;
        task.accountId = accountId || task.accountId;
        task.status = 'generating';
        task.errorCode = '';
        task.errorMessage = '';
        // A snapshot is taken after the attempt was already counted.
        if (!task.restoredFromJournal) task.attempts = Number(task.attempts || 0) + 1;
        task.lastSubmittedAt = Number(entry.submittedAt || Date.now());
      }
    } else if (attempt.resolved) {
      const entry = attempt.resolved;
      const result = entry.result || (entry.outcome === 'rejected'
        ? { status: 'failed', submitOutcome: 'rejected', errorMessage: '提交失败：平台已明确拒绝（重启前未能保存详细原因）', completedAt: Date.now() }
        : { status: 'queued' });
      for (const [field, value] of Object.entries(result)) {
        if (value === null) delete task[field];
        else task[field] = value;
      }
      message = `软件重启后已按提交记录恢复上次提交结果：${labels[entry.outcome] || entry.outcome}`;
      if (entry.outcome === 'rejected') level = 'error';
    } else {
      // Recorded before sending, answer unknown: the restart rule in load()
      // turns this into "submit_unconfirmed".
      task.status = 'submitting';
      return;
    }
    task.activity = message;
    task.activityLevel = level;
    task.activityAt = Date.now();
    task.logs = [{ time: Date.now(), level, message }, ...(task.logs || [])].slice(0, 80);
  }

  // Unmatched records are copied to their own file (never deleted) after a
  // save succeeds, so they leave the journal only once any hold is on disk.
  queueUnmatched(entry, reason) {
    if (!entry || this.pendingUnmatched.has(entry)) return;
    this.pendingUnmatched.set(entry, reason);
    this.journalRecovery.unmatched.push({ taskId: String(entry.taskId || '未返回'), reason, entry });
  }

  flushPendingUnmatched() {
    for (const [entry, reason] of this.pendingUnmatched) {
      try {
        appendJsonLine(this.unmatchedJournalPath, { ...entry, unmatchedReason: reason, movedAt: Date.now() });
        this.pendingUnmatched.delete(entry);
        this.movedUnmatched.add(entry);
      } catch {
        // Stays in the main journal and is handled again next start.
      }
    }
  }

  // A record may only leave the journal once the saved task list holds it.
  isJournalEntryDurable(entry) {
    if (this.movedUnmatched.has(entry)) return true;
    if (this.pendingUnmatched.has(entry)) return false;
    if (this.isFlowcutTaskCleared(entry.flowcutTaskId)) return true;
    const task = this.getTask(entry.localTaskId);
    const intents = task?.submitIntents || [];
    if (entry.type === 'resolved') {
      // Held until a saved list shows this attempt with its outcome applied.
      const stillSubmitting = task?.status === 'submitting' && intents[intents.length - 1] === entry.intentId;
      return Boolean(task && intents.includes(entry.intentId) && !stillSubmitting);
    }
    if (entry.type === 'intent') return Boolean(task && intents.includes(entry.intentId));
    return Boolean(task && (task.taskIds || []).map(String).includes(String(entry.taskId)));
  }

  recordSubmission(entry) {
    if (this.blocked) return false;
    try {
      appendJsonLine(this.submissionJournalPath, entry);
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
      this.movedUnmatched.clear();
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
    this.flushPendingUnmatched();
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
