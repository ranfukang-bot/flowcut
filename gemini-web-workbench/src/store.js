const path = require("node:path");
const crypto = require("node:crypto");
const { WorkbenchLog } = require('./workbench-log');
const { normalizeModelSettings } = require('./gemini-model-selection');
const {
  QUICK_RETRY_DELAYS_MS,
  describeBlockedState,
  loadJsonState,
  writeTextDurable,
} = require("../../vendor/seedance-engine/durable-json");

// Keys and account list must never be regenerated from a damaged file:
// the local site encrypts saved credentials with credentialsMasterKey.
function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "不是有效的配置对象";
  if (!value.settings || typeof value.settings !== "object") return "缺少 settings";
  if (typeof value.settings.bridgeKey !== "string" || !value.settings.bridgeKey.trim()) {
    return "缺少 bridgeKey";
  }
  if (value.accounts !== undefined && !Array.isArray(value.accounts)) return "accounts 格式错误";
  if (value.pendingResults !== undefined && !Array.isArray(value.pendingResults)) {
    return "pendingResults 格式错误";
  }
  if (value.pendingErrors !== undefined && (!Array.isArray(value.pendingErrors) || value.pendingErrors.some(item => !item || typeof item.taskId !== 'string' || typeof item.error !== 'string'))) return 'pendingErrors 格式错误';
  return "";
}

class Store {
  constructor(app, { priorDataPaths = [] } = {}) {
    this.filePath = path.join(app.getPath("userData"), "workbench-state.json");
    this.persistError = null;
    this.onPersistError = null;
    this.onPersistRecovered = null;
    const loaded = loadJsonState({
      file: this.filePath,
      validate: validateState,
      priorDataPaths,
    });
    this.loadResult = loaded;
    if (loaded.status === "blocked") {
      // Nothing may be written: the damaged file stays as the user left it.
      this.blocked = { ...loaded, message: describeBlockedState(loaded, "FlowCut 主配置文件") };
      this.state = null;
      return;
    }
    this.blocked = null;
    this.state = this.normalize(loaded.value || {});
    this.logWriter = new WorkbenchLog(app.getPath('userData'));
    const legacyLogs = this.state.logs;
    this.state.logs = [...this.logWriter.tail(), ...legacyLogs].slice(-300);
    legacyLogs.forEach(entry => this.logWriter.append(entry));
    if (loaded.status === "recovered") {
      this.state.logs.push({
        time: new Date().toISOString(),
        level: "warn",
        message: `主配置文件${loaded.damage === "missing" ? "缺失" : "已损坏"}，已从备份 ${path.basename(loaded.source)} 恢复账号和密钥${loaded.preserved ? `；损坏文件保留为 ${loaded.preserved}` : ""}`,
      });
    }
    this.save();
  }

  normalize(value) {
    const bridgeKey = String(
      value?.settings?.bridgeKey || crypto.randomBytes(32).toString("hex")
    );
    const credentialsMasterKey = String(
      value?.settings?.credentialsMasterKey ||
        (bridgeKey
          ? crypto.createHash("sha256").update(bridgeKey).digest("base64")
          : crypto.randomBytes(32).toString("base64"))
    );
    return {
      settings: {
        flowcutUrl: String(value?.settings?.flowcutUrl || "http://127.0.0.1:4173"),
        bridgeKey,
        credentialsMasterKey,
        queueRunning: value?.settings?.queueRunning !== false,
        personalEditionInitialized: value?.settings?.personalEditionInitialized === true,
        maxConcurrent: Math.max(1, Math.min(32, Number(value?.settings?.maxConcurrent) || 5)),
        seedanceEmbedded: value?.settings?.seedanceEmbedded !== false,
        geminiModel: normalizeModelSettings(value?.settings?.geminiModel),
        backupDirectory: String(value?.settings?.backupDirectory || ''),
        lastBackup: value?.settings?.lastBackup && typeof value.settings.lastBackup.path === 'string' && Number.isSafeInteger(value.settings.lastBackup.mediaCount) && value.settings.lastBackup.mediaCount >= 0
          ? { path: value.settings.lastBackup.path, createdAt: String(value.settings.lastBackup.createdAt || ''), mediaCount: value.settings.lastBackup.mediaCount } : null,
      },
      defaultAccountId: String(value?.defaultAccountId || ""),
      accounts: Array.isArray(value?.accounts) ? value.accounts : [],
      pendingResults: Array.isArray(value?.pendingResults)
        ? value.pendingResults
            .filter(
              (item) =>
                item &&
                typeof item.taskId === "string" &&
                typeof item.prompt === "string" &&
                item.prompt.trim().length >= 300
            )
            .slice(-50)
        : [],
      pendingErrors: Array.isArray(value?.pendingErrors) ? value.pendingErrors : [],
      logs: Array.isArray(value?.logs) ? value.logs.slice(-300) : [],
    };
  }

  // Returns false instead of throwing: a failed write must not turn a finished
  // task into a failure. The owner is notified so the problem is visible.
  save() {
    if (this.blocked) return false;
    const { logs: _logs, ...durable } = this.state;
    const serialized = JSON.stringify(durable, null, 2);
    if (!this.persistError && serialized === this.lastSerialized) return true;
    try {
      writeTextDurable(this.filePath, serialized, {
        delays: this.persistError ? QUICK_RETRY_DELAYS_MS : undefined,
        backup: "mirror",
      });
    } catch (error) {
      const firstFailure = !this.persistError;
      this.persistError = {
        file: this.filePath,
        code: String(error?.code || ""),
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      };
      if (firstFailure) this.onPersistError?.(this.persistError);
      return false;
    }
    this.lastSerialized = serialized;
    if (this.persistError) {
      const previous = this.persistError;
      this.persistError = null;
      this.onPersistRecovered?.(previous);
    }
    return true;
  }

  addAccount(name) {
    const id = crypto.randomUUID();
    const account = {
      id,
      name: String(name || `Gemini 账号 ${this.state.accounts.length + 1}`),
      partition: `persist:flowcut-gemini-${id}`,
      authenticated: false,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastCheckedAt: "",
      error: "",
    };
    this.state.accounts.push(account);
    if (!this.state.defaultAccountId) this.state.defaultAccountId = id;
    this.save();
    return account;
  }

  commitGeminiLogin({ accountId, candidate, checkedAt, modelCatalog }) {
    const priorAccounts = this.state.accounts, priorDefault = this.state.defaultAccountId;
    const old = accountId ? priorAccounts.find(a => a.id === accountId) : null;
    if (accountId && !old) throw Object.assign(new Error('账号不存在'), { code: 'ACCOUNT_NOT_FOUND' });
    const account = { ...(old || { id: candidate.id, name: candidate.name, enabled: true, createdAt: checkedAt }),
      partition: candidate.partition, authenticated: true, lastCheckedAt: checkedAt, error: '' };
    if (modelCatalog) account.modelCatalog = modelCatalog;
    this.state.accounts = old ? priorAccounts.map(a => a.id === accountId ? account : a) : [...priorAccounts, account];
    if (!this.state.defaultAccountId) this.state.defaultAccountId = account.id;
    if (!this.save()) {
      this.state.accounts = priorAccounts; this.state.defaultAccountId = priorDefault;
      this.save();
      throw Object.assign(new Error('登录资料配置保存失败，原登录会话已保留'), { code: 'LOGIN_SAVE_FAILED' });
    }
    return account;
  }

  updateAccount(id, patch) {
    const account = this.state.accounts.find((item) => item.id === id);
    if (!account) return null;
    Object.assign(account, patch);
    this.save();
    return account;
  }

  renameAccount(id, name) {
    const account = this.state.accounts.find((item) => item.id === id);
    if (!account) throw new Error("账号不存在");
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("账号名称不能为空");
    return this.updateAccount(id, { name: cleanName });
  }

  setAccountEnabled(id, enabled) {
    const account = this.state.accounts.find((item) => item.id === id);
    if (!account) throw new Error("账号不存在");
    account.enabled = Boolean(enabled);
    if (!this.state.defaultAccountId || (this.state.defaultAccountId === id && !account.enabled)) {
      this.state.defaultAccountId = this.state.accounts.find((item) => item.enabled !== false)?.id || "";
    }
    this.save();
    return account;
  }

  removeAccount(id) {
    this.state.accounts = this.state.accounts.filter((item) => item.id !== id);
    if (this.state.defaultAccountId === id) {
      this.state.defaultAccountId = this.state.accounts[0]?.id || "";
    }
    this.save();
  }

  upsertPendingResult(taskId, prompt, workerId = "", detail = {}) {
    const result = {
      taskId: String(taskId || ""),
      prompt: String(prompt || ""),
      workerId: String(workerId || ""),
      kind: ["reference-remix", "script-pipeline", "variant","remix-segments","remix-rewrite"].includes(detail.kind)
        ? detail.kind
        : "standard",
      analysis: String(detail.analysis || ""),
      remixRound: detail.remixRound,
      rawReplies: Array.isArray(detail.rawReplies)?detail.rawReplies:[],
      rewrittenScript: String(detail.rewrittenScript || ""),
      extractionJson: String(detail.extractionJson || ""),
      storyboardJson: String(detail.storyboardJson || ""),
      rawGroupsJson: String(detail.rawGroupsJson || ""),
      optimizedGroupsJson: String(detail.optimizedGroupsJson || ""),
      // Code blocks decide how many videos a reply becomes; they must survive
      // a restart together with the reply until written back.
      codeBlocks: Array.isArray(detail.codeBlocks) ? detail.codeBlocks.slice(0, 50).map(String) : [],
      codeBlockHint: detail.codeBlockHint === true,
      createdAt: new Date().toISOString(),
    };
    if (!result.taskId || result.prompt.trim().length < 300) {
      throw new Error("待写回的 Gemini 提示词数据不完整");
    }
    this.state.pendingResults = this.state.pendingResults.filter(
      (item) => item.taskId !== result.taskId
    );
    this.state.pendingResults.push(result);
    this.state.pendingResults = this.state.pendingResults.slice(-50);
    this.save();
    return result;
  }

  removePendingResult(taskId) {
    const before = this.state.pendingResults.length;
    this.state.pendingResults = this.state.pendingResults.filter(
      (item) => item.taskId !== taskId
    );
    if (this.state.pendingResults.length !== before) this.save();
  }

  movePendingResultToError(pending, error) {
    const priorResults = this.state.pendingResults, priorErrors = this.state.pendingErrors;
    this.state.pendingResults = priorResults.filter(item => item.taskId !== pending.taskId);
    this.state.pendingErrors = [...priorErrors.filter(item => item.taskId !== pending.taskId), {
      taskId: pending.taskId, kind: pending.kind || 'standard', workerId: pending.workerId,remixRound:pending.remixRound,
      error, createdAt: new Date().toISOString(), nextRetryAt: Date.now() + 5000,
      rawReply: String(pending.rawReply || pending.prompt || '').slice(0,60000),
    }];
    if (!this.save()) {
      this.state.pendingResults = priorResults; this.state.pendingErrors = priorErrors;
      throw new Error('无法保存失败状态写回记录，原提示词仍保留在待写回队列');
    }
  }

  removePendingError(taskId) {
    const before = this.state.pendingErrors.length;
    this.state.pendingErrors = this.state.pendingErrors.filter(item => item.taskId !== taskId);
    if (this.state.pendingErrors.length !== before) this.save();
  }

  log(message, level = "info") {
    const entry = {
      time: new Date().toISOString(),
      level,
      message: String(message),
    };
    this.state.logs.push(entry);
    this.state.logs = this.state.logs.slice(-300);
    this.logWriter.append(entry);
  }

  flushLogs() { return this.logWriter?.flush(); }
}

module.exports = { Store };
