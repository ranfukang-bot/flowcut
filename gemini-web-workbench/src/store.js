const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

class Store {
  constructor(app) {
    this.filePath = path.join(app.getPath("userData"), "workbench-state.json");
    this.state = this.load();
    this.save();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return this.normalize(parsed);
    } catch {
      return this.normalize({});
    }
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
      logs: Array.isArray(value?.logs) ? value.logs.slice(-300) : [],
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  addAccount(name) {
    const id = crypto.randomUUID();
    const account = {
      id,
      name: String(name || `Gemini 账号 ${this.state.accounts.length + 1}`),
      partition: `persist:flowcut-gemini-${id}`,
      authenticated: false,
      createdAt: new Date().toISOString(),
      lastCheckedAt: "",
      error: "",
    };
    this.state.accounts.push(account);
    if (!this.state.defaultAccountId) this.state.defaultAccountId = id;
    this.save();
    return account;
  }

  updateAccount(id, patch) {
    const account = this.state.accounts.find((item) => item.id === id);
    if (!account) return null;
    Object.assign(account, patch);
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
      kind: ["reference-remix", "script-pipeline"].includes(detail.kind)
        ? detail.kind
        : "standard",
      analysis: String(detail.analysis || ""),
      rewrittenScript: String(detail.rewrittenScript || ""),
      extractionJson: String(detail.extractionJson || ""),
      storyboardJson: String(detail.storyboardJson || ""),
      rawGroupsJson: String(detail.rawGroupsJson || ""),
      optimizedGroupsJson: String(detail.optimizedGroupsJson || ""),
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

  log(message, level = "info") {
    this.state.logs.push({
      time: new Date().toISOString(),
      level,
      message: String(message),
    });
    this.state.logs = this.state.logs.slice(-300);
    this.save();
  }
}

module.exports = { Store };
