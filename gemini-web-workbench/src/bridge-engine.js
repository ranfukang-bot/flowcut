const { randomUUID } = require("node:crypto");

const RETRYABLE_JOB_CODES = new Set([
  "CONVERSATION_RESET_FAILED",
  "GEMINI_PAGE_ERROR",
  "GEMINI_MEDIA_UNREADABLE",
  "GEMINI_REFUSED_RESPONSE",
  "INCOMPLETE_RESPONSE",
  "NO_RESPONSE_DETECTED",
  "PROMPT_INPUT_FAILED",
  "RESPONSE_TIMEOUT",
  "RESPONSE_STALLED",
  "GEMINI_PAGE_CRASHED",
  "GEMINI_PAGE_UNRESPONSIVE",
  "MATERIAL_DOWNLOAD_TIMEOUT",
  "STALE_ATTACHMENTS",
  "SUBMIT_NOT_CONFIRMED",
  "UPLOAD_NOT_CONFIRMED",
  "UPLOAD_PROCESSING_TIMEOUT",
]);
const INLINE_RETRYABLE_JOB_CODES = new Set([
  "CONVERSATION_RESET_FAILED",
  "NO_RESPONSE_DETECTED",
  "PROMPT_INPUT_FAILED",
  "STALE_ATTACHMENTS",
  "SUBMIT_NOT_CONFIRMED",
  "UPLOAD_NOT_CONFIRMED",
  "UPLOAD_PROCESSING_TIMEOUT",
]);
const REMOTE_FAILURE_CODES = new Set([
  "GEMINI_PAGE_ERROR",
  "GEMINI_MEDIA_UNREADABLE",
  "GEMINI_REFUSED_RESPONSE",
  "INCOMPLETE_RESPONSE",
  "RESPONSE_TIMEOUT",
  "RESPONSE_STALLED",
  "GEMINI_PAGE_CRASHED",
  "GEMINI_PAGE_UNRESPONSIVE",
  "MATERIAL_DOWNLOAD_TIMEOUT",
]);
const ACCOUNT_COOLDOWN_MS = 12_000;
const ACCOUNT_FAILURE_BACKOFF_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000];
const RETRY_DELAY_MS = 12_000;
const BRIDGE_REQUEST_TIMEOUT_MS = 10_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableJobError(error) {
  if (RETRYABLE_JOB_CODES.has(error?.code || "")) return true;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Gemini 页面加载超时|Gemini 网页任务超过|输入框|发送按钮/.test(message);
}

function shouldRetryInline(error) {
  return INLINE_RETRYABLE_JOB_CODES.has(error?.code || "");
}

function isTransientBridgeError(error) {
  const status = Number(error?.status || 0);
  if (status === 408 || status === 429 || status >= 500) return true;
  const code = String(error?.code || error?.cause?.code || "");
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    /^(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ABORT_ERR)$/i.test(
      code
    ) ||
    /fetch failed|connection refused|连接被拒绝|network|timed?\s*out|aborted/i.test(
      message
    )
  );
}

class BridgeEngine {
  constructor({
    store,
    getAuthenticatedAccounts,
    getMaxConcurrent = () => 1,
    getDesktopToken = () => "",
    version = "0.0.0",
    runJob,
    onChange,
  }) {
    this.store = store;
    this.getAuthenticatedAccounts = getAuthenticatedAccounts;
    this.getMaxConcurrent = getMaxConcurrent;
    this.getDesktopToken = getDesktopToken;
    this.version = version;
    this.runJob = runJob;
    this.onChange = onChange;
    this.workerId = `gemini-web-${randomUUID()}`;
    this.active = new Map();
    this.cancelledTasks = new Set();
    this.timer = null;
    this.polling = false;
    this.lastError = "";
    this.online = false;
    this.cooldownUntil = new Map();
    this.failureStreak = new Map();
    this.flushingResults = false;
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 5000);
  }

  cancelTasks(ids) {
    for (const id of ids) { this.cancelledTasks.add(id); this.store.removePendingResult(id); }
  }

  assertTaskActive(id) {
    if (this.cancelledTasks.has(id)) throw Object.assign(new Error("任务已清除"), { code: "TASK_CLEARED" });
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  headers() {
    return {
      authorization: `Bearer ${this.store.state.settings.bridgeKey}`,
      "x-flowcut-desktop-token": this.getDesktopToken(),
      "content-type": "application/json",
    };
  }

  bridgeUrl() {
    return `${this.store.state.settings.flowcutUrl.replace(/\/+$/, "")}/api/gemini-bridge`;
  }

  async request(path, init = {}, options = {}) {
    const retries = Math.max(0, Number(options.retries || 0));
    const timeoutMs = Math.max(
      1_000,
      Number(options.timeoutMs || BRIDGE_REQUEST_TIMEOUT_MS)
    );
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(`${this.bridgeUrl()}${path}`, {
          ...init,
          headers: { ...this.headers(), ...(init.headers || {}) },
          signal: init.signal || AbortSignal.timeout(timeoutMs),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(data.error || `HTTP ${response.status}`);
          error.status = response.status;
          error.data = data;
          error.ignorable = Boolean(data.ignorable);
          throw error;
        }
        return data;
      } catch (error) {
        lastError = error;
        if (attempt >= retries || !isTransientBridgeError(error)) throw error;
        await delay(1_000 * 2 ** attempt);
      }
    }
    throw lastError || new Error("FlowCut 本机服务请求失败");
  }

  runtimeState() {
    return {
      online: this.online,
      lastError: this.lastError,
      workerId: this.workerId,
      activeJobs: [...this.active.values()],
    };
  }

  async heartbeat(accounts, maxConcurrent) {
    await this.request("", {
      method: "POST",
      body: JSON.stringify({
        action: "heartbeat",
        workerId: this.workerId,
        version: this.version,
        queueRunning: this.store.state.settings.queueRunning,
        activeCount: this.active.size,
        activeTaskIds: [...this.active.values()].map((job) => job.taskId),
        activeJobs: [...this.active.values()],
        maxConcurrent,
        defaultAccountId: this.store.state.defaultAccountId,
        accounts: accounts.map((account) => ({
          id: account.id,
          name: account.name,
          authenticated: Boolean(account.authenticated),
          busy: this.active.has(account.id),
        })),
      }),
    });
  }

  async tick() {
    if (this.polling) return;
    this.polling = true;
    try {
      const key = this.store.state.settings.bridgeKey;
      if (!key) throw new Error("尚未读取到本机 Bridge Key");
      const accounts = this.getAuthenticatedAccounts();
      const planLimit = Math.max(1, Number(this.getMaxConcurrent() || 1));
      const effectiveLimit = Math.min(planLimit, accounts.length);
      await this.heartbeat(this.store.state.accounts, effectiveLimit);
      this.online = true;
      this.lastError = "";

      await this.flushPendingResults();
      if ((this.store.state.pendingResults || []).length) return;

      if (!this.store.state.settings.queueRunning) return;
      const availableSlots = Math.max(0, effectiveLimit - this.active.size);
      const idle = accounts
        .filter(
          (account) =>
            !this.active.has(account.id) &&
            Number(this.cooldownUntil.get(account.id) || 0) <= Date.now()
        )
        .slice(0, availableSlots);
      if (!idle.length) return;
      const params = new URLSearchParams({
        workerId: this.workerId,
        capacity: String(idle.length),
        accountIds: idle.map((account) => account.id).join(","),
      });
      const result = await this.request(`?${params.toString()}`);
      const jobs = Array.isArray(result.jobs) ? result.jobs : [];
      const remaining = [...idle];
      for (const job of jobs) {
        if (this.cancelledTasks.has(job.id)) continue;
        const index = job.accountId
          ? remaining.findIndex((account) => account.id === job.accountId)
          : 0;
        if (index < 0) {
          await this.report(job.id, "release", {
            kind: job.kind,
            error: "指定的 Gemini 账号当前不可用，任务已退回队列",
          });
          continue;
        }
        const [account] = remaining.splice(index, 1);
        this.active.set(account.id, {
          taskId: job.id,
          accountId: account.id,
          accountName: account.name,
          startedAt: new Date().toISOString(),
          stage: "下载商品图",
        });
        this.onChange();
        void this.execute(account, job);
      }
    } catch (error) {
      this.online = false;
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.polling = false;
      this.onChange();
    }
  }

  async report(taskId, action, extra = {}, options = {}) {
    return this.request("", {
      method: "POST",
      body: JSON.stringify({ action, taskId, workerId: this.workerId, ...extra }),
    }, options);
  }

  async flushPendingResults() {
    if (this.flushingResults) return false;
    this.flushingResults = true;
    try {
      for (const pending of [...(this.store.state.pendingResults || [])]) {
        try {
          await this.report(
            pending.taskId,
            "result",
            {
              prompt: pending.prompt,
              analysis: pending.analysis || "",
              kind: pending.kind || "standard",
              rewrittenScript: pending.rewrittenScript || "",
              extractionJson: pending.extractionJson || "",
              storyboardJson: pending.storyboardJson || "",
              rawGroupsJson: pending.rawGroupsJson || "",
              optimizedGroupsJson: pending.optimizedGroupsJson || "",
              workerId: pending.workerId,
            },
            { retries: 3, timeoutMs: 10_000 }
          );
          this.store.removePendingResult(pending.taskId);
          this.store.log(`任务 ${pending.taskId} 的 Gemini 提示词已可靠写回`);
        } catch (error) {
          if (error?.ignorable || Number(error?.status || 0) === 409) {
            this.store.removePendingResult(pending.taskId);
            this.store.log(
              `任务 ${pending.taskId} 已进入后续阶段，忽略重复的 Gemini 写回`,
              "warn"
            );
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          const isLegacyScriptResult =
            pending.kind === "script-pipeline" &&
            !String(pending.optimizedGroupsJson || "").trim() &&
            Number(error?.status || 0) === 400 &&
            /最终优化提示词(?:不是合法 JSON|为空)/.test(message);
          if (isLegacyScriptResult) {
            this.store.removePendingResult(pending.taskId);
            await this.report(pending.taskId, "release", {
              kind: "script-pipeline",
              error: "旧版桌面端回写缺少结构化结果，已保留前四步并自动重试 Gem 优化",
            }).catch(() => {});
            this.store.log(
              `任务 ${pending.taskId} 已清理旧版无效回写，将从 Gem 优化阶段继续`,
              "warn"
            );
            continue;
          }
          this.lastError = message;
          this.store.log(
            `任务 ${pending.taskId} 的提示词已保存在本机，等待服务恢复后写回：${message}`,
            "warn"
          );
          return false;
        }
      }
      return true;
    } finally {
      this.flushingResults = false;
    }
  }

  async downloadFiles(imageUrls, prefix = "product") {
    const output = [];
    for (let index = 0; index < imageUrls.length; index += 1) {
      const response = await fetch(imageUrls[index], {
        headers: { "x-flowcut-desktop-token": this.getDesktopToken() },
        signal: AbortSignal.timeout(prefix === "reference" ? 120_000 : 30_000),
      });
      if (!response.ok) throw new Error(`第 ${index + 1} 个${prefix === "reference" ? "对标视频" : "商品素材"}下载失败`);
      const mime = response.headers.get("content-type") || (prefix === "reference" ? "video/mp4" : "image/jpeg");
      const extension = mime.includes("png")
        ? "png"
        : mime.includes("webp")
          ? "webp"
          : mime.includes("quicktime")
            ? "mov"
            : mime.includes("webm")
              ? "webm"
              : mime.startsWith("video/")
                ? "mp4"
                : "jpg";
      const buffer = await response.arrayBuffer();
      output.push({
        name: `${prefix}-${index + 1}.${extension}`,
        mime,
        data: new Uint8Array(buffer),
      });
    }
    return output;
  }

  async execute(account, job) {
    let cooldownMs = ACCOUNT_COOLDOWN_MS;
    try {
      const active = this.active.get(account.id);
      active.stage = "正在准备任务";
      this.onChange();
      active.stage = "正在读取商品图片";
      this.onChange();
      this.assertTaskActive(job.id);
      const files = await this.downloadFiles(job.imageUrls || []);
      const referenceFiles = job.kind === "reference-remix"
        ? await this.downloadFiles([job.referenceVideoUrl], "reference")
        : [];
      let result = { prompt: "", analysis: "" };
      const maxAttempts = job.kind === "script-pipeline" ? 1 : 2;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          active.stage =
            attempt === 1
              ? "上传图片并生成"
              : "Gemini 页面波动，正在自动重试（1/1）";
          this.onChange();
          this.assertTaskActive(job.id);
          const runResult = await this.runJob(account, { ...job, files, referenceFiles });
          result = typeof runResult === "string"
            ? { prompt: runResult, analysis: "" }
            : {
                ...runResult,
                prompt: String(runResult?.prompt || ""),
                analysis: String(runResult?.analysis || ""),
              };
          break;
        } catch (error) {
          if (
            attempt >= maxAttempts ||
            error?.code === "NEEDS_LOGIN" ||
            !isRetryableJobError(error) ||
            !shouldRetryInline(error)
          ) {
            throw error;
          }
          const message =
            error instanceof Error ? error.message : String(error);
          active.stage = "Gemini 页面波动，正在自动重试（1/1）";
          this.onChange();
          await this.report(job.id, "retrying", {
            kind: job.kind,
            error: `首次执行未确认成功，正在自动重试：${message}`,
          }).catch(() => {});
          this.store.log(
            `任务 ${job.id} 首次执行未确认成功，12 秒后自动重试：${message}`,
            "warn"
          );
          await delay(RETRY_DELAY_MS);
        }
      }
      this.assertTaskActive(job.id);
      active.stage = "回传提示词";
      this.onChange();
      this.store.upsertPendingResult(job.id, result.prompt, this.workerId, {
        kind: job.kind,
        analysis: result.analysis,
        rewrittenScript: result.rewrittenScript,
        extractionJson: result.extractionJson,
        storyboardJson: result.storyboardJson,
        rawGroupsJson: result.rawGroupsJson,
        optimizedGroupsJson: result.optimizedGroupsJson,
      });
      const written = await this.flushPendingResults();
      if (
        written &&
        !(this.store.state.pendingResults || []).some(
          (item) => item.taskId === job.id
        )
      ) {
        this.store.log(
          `任务 ${job.id} 已由 ${account.name} 生成提示词并进入下一步`
        );
      }
      this.failureStreak.delete(account.id);
    } catch (error) {
      if (this.cancelledTasks.has(job.id)) return;
      const code = error?.code || "";
      const message = error instanceof Error ? error.message : String(error);
      if (REMOTE_FAILURE_CODES.has(code)) {
        const streak = Number(this.failureStreak.get(account.id) || 0) + 1;
        this.failureStreak.set(account.id, streak);
        cooldownMs = ACCOUNT_FAILURE_BACKOFF_MS[
          Math.min(streak - 1, ACCOUNT_FAILURE_BACKOFF_MS.length - 1)
        ];
      }
      if (code === "EXECUTION_PERMIT_REQUIRED" || code === "EXECUTION_PERMIT_INVALID") {
        await this.report(job.id, "release", {
          kind: job.kind,
          error: message,
        }).catch(() => {});
        this.store.log(`任务 ${job.id} 未取得云端执行许可：${message}`, "error");
      } else if (code === "NEEDS_LOGIN") {
        this.store.updateAccount(account.id, {
          authenticated: false,
          error: message,
        });
        await this.report(job.id, "release", { kind: job.kind, error: message }).catch(() => {});
        this.store.log(`任务 ${job.id} 等待账号重新登录：${message}`, "warn");
      } else if (isRetryableJobError(error)) {
        const recovery = await this.report(job.id, "defer", {
          kind: job.kind,
          error: message,
        }).catch(() => null);
        if (!recovery) {
          await this.report(job.id, "error", { kind: job.kind, error: message }).catch(() => {});
          this.store.log(`任务 ${job.id} 失败：${message}`, "error");
        } else if (recovery.deferred) {
          this.store.log(
            `任务 ${job.id} 遇到 Gemini 网页波动，已安排后台恢复（${recovery.failures}/${recovery.maxFailures || 3}）`,
            "warn"
          );
        } else {
          this.store.log(
            `任务 ${job.id} 多轮后台恢复后仍失败：${message}`,
            "error"
          );
        }
      } else {
        await this.report(job.id, "error", { kind: job.kind, error: message }).catch(() => {});
        this.store.log(`任务 ${job.id} 失败：${message}`, "error");
      }
    } finally {
      this.active.delete(account.id);
      this.cooldownUntil.set(account.id, Date.now() + cooldownMs);
      this.onChange();
      const timer = setTimeout(
        () => void this.tick(),
        cooldownMs + 200
      );
      timer.unref?.();
    }
  }
}

module.exports = {
  ACCOUNT_COOLDOWN_MS,
  ACCOUNT_FAILURE_BACKOFF_MS,
  BridgeEngine,
  RETRYABLE_JOB_CODES,
  BRIDGE_REQUEST_TIMEOUT_MS,
  isTransientBridgeError,
  isRetryableJobError,
  shouldRetryInline,
};
