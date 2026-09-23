const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { BrowserWindow, dialog, session, shell } = require("electron");
const { WorkbenchStore } = require("../../vendor/seedance-engine/store.js");
const {
  TikTokClient,
  BASE_URL,
} = require("../../vendor/seedance-engine/tiktok-client.js");
const { QueueEngine } = require("../../vendor/seedance-engine/queue-engine.js");
const { AccountManager } = require("../../vendor/seedance-engine/account-manager.js");
const { FlowCutBridge } = require("../../vendor/seedance-engine/flowcut-bridge.js");
const { LOGIN_URL, configureLoginSession, createLoginNetworkReporter } = require('./seedance-login-network');
const { protectLoginNavigation } = require('./web-login-navigation');
const {
  accountVideoDirectory,
  availableVideoPath,
  buildArchivedVideoFilename,
  buildVideoFilename,
  downloadVideo,
} = require("../../vendor/seedance-engine/video-download.js");

class SeedanceRuntime {
  constructor({
    app,
    flowcutStore,
    version,
    mainWindow,
    startPaused = false,
    getMaxConcurrent = () => 1,
    getDesktopToken = () => "",
    onChange = () => {},
    onPersistenceProblem = () => {},
  }) {
    this.app = app;
    this.startPaused = startPaused;
    this.flowcutStore = flowcutStore;
    this.version = version;
    this.mainWindow = mainWindow;
    this.getMaxConcurrent = getMaxConcurrent;
    this.getDesktopToken = getDesktopToken;
    this.onChange = onChange;
    this.onPersistenceProblem = onPersistenceProblem;
    this.authWindows = new Map();
    this.activeDownloads = new Map();
    this.downloadControllers = new Map();
    this.store = null;
    this.accountManager = null;
    this.engine = null;
    this.flowcutBridge = null;
    this.started = false;
  }

  userDataRoot() {
    return path.join(this.app.getPath("userData"), "seedance");
  }

  migrateLegacyState() {
    const destinationRoot = this.userDataRoot();
    const destinationState = path.join(destinationRoot, "workbench-state.json");
    const legacyRoot = path.join(this.app.getPath("appData"), "seedance-workbench");
    const legacyState = path.join(legacyRoot, "workbench-state.json");
    const marker = path.join(destinationRoot, ".legacy-imported");
    fs.mkdirSync(destinationRoot, { recursive: true });
    if (fs.existsSync(marker)) return;
    if (!fs.existsSync(destinationState) && fs.existsSync(legacyState)) {
      fs.copyFileSync(legacyState, destinationState);
    }
    const legacyPartitions = path.join(legacyRoot, "Partitions");
    const currentPartitions = path.join(this.app.getPath("userData"), "Partitions");
    const skippedLoginData = [];
    if (fs.existsSync(legacyPartitions)) {
      const loginDataPaths = [
        "IndexedDB",
        "Local Storage",
        "Network",
        "Session Storage",
        "WebStorage",
        "SharedStorage",
        "DIPS",
        "Preferences",
        path.join("Service Worker", "Database"),
      ];
      fs.mkdirSync(currentPartitions, { recursive: true });
      for (const partition of fs.readdirSync(legacyPartitions, {
        withFileTypes: true,
      })) {
        if (!partition.isDirectory()) continue;
        const sourcePartition = path.join(legacyPartitions, partition.name);
        const destinationPartition = path.join(
          currentPartitions,
          partition.name,
        );
        fs.mkdirSync(destinationPartition, { recursive: true });
        for (const relativePath of loginDataPaths) {
          const source = path.join(sourcePartition, relativePath);
          if (!fs.existsSync(source)) continue;
          const destination = path.join(destinationPartition, relativePath);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          try {
            fs.cpSync(source, destination, {
              recursive: true,
              force: false,
              errorOnExist: false,
            });
          } catch {
            // The legacy Chromium profile may still be open in the old
            // workbench. Migration is best-effort so one locked cookie
            // database can never prevent FlowCut from starting.
            skippedLoginData.push(
              path.join(partition.name, relativePath),
            );
          }
        }
      }
    }
    fs.writeFileSync(
      marker,
      JSON.stringify(
        {
          importedAt: new Date().toISOString(),
          skippedLoginData,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  isLiveWindow(window) {
    return Boolean(
      window &&
        !window.isDestroyed() &&
        window.webContents &&
        !window.webContents.isDestroyed(),
    );
  }

  state() {
    const state = this.engine?.state();
    if (!state) {
      return {
        ready: false,
        authenticated: false,
        settings: { running: false, downloadDirectory: "" },
        accountState: { activeAccountId: "", items: [] },
        tasks: [],
        bridge: { online: false, error: "" },
      };
    }
    return {
      ...state,
      ready: true,
      bridge: this.flowcutBridge?.info() || { online: false, error: "" },
      downloads: Object.fromEntries(this.activeDownloads),
    };
  }

  emit() {
    this.onChange(this.state());
  }

  createAuthWindow(accountId) {
    const account = this.accountManager.account(accountId);
    if (!account) throw new Error("Seedance 账号不存在");
    const tiktokSession = this.accountManager.session(accountId);
    const reportNetwork = createLoginNetworkReporter({
      runtime: this.accountManager.ensureRuntime(accountId),
      log: message => this.store.log(`[${account.name}] ${message}`, 'warn'),
      onChange: () => this.emit(),
    });
    tiktokSession.webRequest.onErrorOccurred({ urls: ['https://*/*'] }, reportNetwork);
    tiktokSession.webRequest.onCompleted({ urls: ['https://*/*'] }, reportNetwork);
    const window = new BrowserWindow({
      width: 1220,
      height: 820,
      minWidth: 900,
      minHeight: 650,
      title: `登录 TikTok Symphony · ${account.name}`,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        session: tiktokSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.authWindows.set(accountId, window);
    window.on("close", (event) => {
      if (!this.app.isQuitting) {
        event.preventDefault();
        if (this.isLiveWindow(window)) window.hide();
      }
    });
    window.on("closed", () => {
      if (this.authWindows.get(accountId) === window) {
        this.authWindows.delete(accountId);
      }
    });
    protectLoginNavigation(window.webContents, {
          width: 980,
          height: 760,
          autoHideMenuBar: true,
          webPreferences: {
            session: tiktokSession,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
    });
    configureLoginSession(tiktokSession).then(() => {
      if (this.isLiveWindow(window)) return window.loadURL(LOGIN_URL);
    }).catch(error => reportNetwork({ url: LOGIN_URL, resourceType: 'mainFrame', error: error.message }));
    return window;
  }

  async reconnectLogin(accountId) {
    if (this.store.tasks.some(task => task.accountId === accountId && ['uploading', 'submitting', 'generating'].includes(task.status))) throw new Error('该账号有任务正在执行，请等待任务结束后重连登录');
    const current = this.accountManager.session(accountId);
    await configureLoginSession(current, { reconnect: true });
    this.accountManager.ensureRuntime(accountId).loginNetworkError = '';
    this.showLogin(accountId);
    await this.authWindows.get(accountId).loadURL(LOGIN_URL);
    this.emit();
    return this.state();
  }

  setPreferredModel(accountId, model) {
    this.accountManager.setPreferredModel(accountId, model);
    this.engine.resumeModelWaiters();
    this.emit();
    return this.state();
  }

  decideFastFallback(accountId, choice, date) {
    this.accountManager.decideFastFallback(accountId, choice, date);
    this.engine.resumeModelWaiters();
    void this.engine.tick();
    this.emit();
    return this.state();
  }

  showLogin(accountId = this.accountManager.activeAccount()?.id) {
    if (!accountId) throw new Error("没有 Seedance 账号");
    const existing = this.authWindows.get(accountId);
    const window = this.isLiveWindow(existing)
      ? existing
      : this.createAuthWindow(accountId);
    window.show();
    window.focus();
    return true;
  }

  async saveLogin(accountId) {
    this.accountManager.session(accountId).flushStorageData();
    await this.engine.refreshAuth(accountId);
    const runtime = this.accountManager.ensureRuntime(accountId);
    if (!runtime.authenticated) {
      throw new Error(runtime.authCheckFailed ? runtime.error : "还没有检测到 TikTok Symphony 登录。请先在登录窗口完成验证并进入 Creative Studio；遇到 5101/500 可尝试重连登录。");
    }
    const window = this.authWindows.get(accountId);
    if (this.isLiveWindow(window)) window.hide();
    runtime.loginNetworkError = '';
    this.emit();
    return this.state();
  }

  clearTasks(ids) {
    const selected = new Set(ids);
    for (const task of this.store.tasks) if (selected.has(task.flowcutTaskId)) this.downloadControllers.get(task.id)?.abort();
    this.store.clearFlowcutTasks(ids);
    this.emit();
  }

  async downloadTask(task) {
    const id = task.id;
    if (this.activeDownloads.has(id)) throw new Error("这条任务正在下载");
    await this.engine.refreshTaskResult(id).catch(() => {});
    task = this.store.getTask(id);
    if (!task) throw new Error("任务已清除");
    if (!task?.videoUrl) throw Object.assign(new Error("视频仍在渲染，完成后将自动下载"), { code: "VIDEO_NOT_READY" });
    const rootDirectory =
      this.store.settings.downloadDirectory ||
      path.join(this.app.getPath("downloads"), "FlowCut视频");
    const archiveAccount = String(task.tiktokAccountName || "").trim();
    const downloadDirectory = task.archiveDirectory
      ? path.resolve(task.archiveDirectory)
      : archiveAccount ? accountVideoDirectory(rootDirectory, archiveAccount) : rootDirectory;
    const destination = await availableVideoPath(
      downloadDirectory,
      buildArchivedVideoFilename(task),
    );
    const downloadState = {
      status: "downloading",
      receivedBytes: 0,
      totalBytes: 0,
      percent: 0,
    };
    this.activeDownloads.set(id, downloadState);
    const controller = new AbortController();
    this.downloadControllers.set(id, controller);
    this.engine.recordTask(
      task,
      archiveAccount
        ? `正在自动下载到 TK 账号文件夹：${archiveAccount}`
        : "正在下载生成的视频",
    );
    this.emit();
    try {
      const fetchVideo = (url) =>
        this.accountManager.session(task.accountId || "default").fetch(url, {
          headers: { Referer: `${BASE_URL}/` },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        });
      const onProgress = ({ receivedBytes, totalBytes }) => {
        downloadState.receivedBytes = receivedBytes;
        downloadState.totalBytes = totalBytes;
        downloadState.percent = totalBytes
          ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100))
          : 0;
        this.emit();
      };
      let result = null;
      let lastError = null;
      let refreshedAfterFailure = false;
      const attemptedUrls = new Set();
      while (!result) {
        const candidates = [task.videoUrl, task.videoBackupUrl]
          .map((url) => String(url || "").trim())
          .filter((url) => url && !attemptedUrls.has(url));
        for (const url of candidates) {
          attemptedUrls.add(url);
          try {
            result = await downloadVideo(url, destination, fetchVideo, onProgress, { preserveOriginalName: !String(task.productExternalId || "").trim() });
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (result || refreshedAfterFailure) break;
        refreshedAfterFailure = true;
        await this.engine.refreshTaskResult(id).catch(() => {});
        task = this.store.getTask(id) || task;
      }
      if (!result) throw lastError || new Error("视频下载地址暂时不可用");
      task.lastDownloadedPath = result.destination;
      task.lastDownloadedAt = Date.now();
      task.autoDownloadError = "";
      task.nextAutoDownloadAt = 0;
      try {
        this.engine.recordTask(task, `视频已下载：${result.destination}`, "success");
      } catch (error) {
        // The file is complete on disk; a logging problem must not undo that.
        console.error("[seedance] download bookkeeping failed", error);
      }
      return result;
    } finally {
      this.downloadControllers.delete(id);
      this.activeDownloads.delete(id);
      this.emit();
    }
  }

  async start() {
    if (this.started) return this.state();
    this.migrateLegacyState();
    this.store = new WorkbenchStore(this.userDataRoot(), {
      onPersistError: (problem) =>
        this.onPersistenceProblem({ source: "Seedance 任务库", failing: true, ...problem }),
      onPersistRecovered: (problem) =>
        this.onPersistenceProblem({ source: "Seedance 任务库", failing: false, ...problem }),
    });
    if (this.store.blocked) {
      throw Object.assign(new Error(this.store.blocked.message), { code: "STATE_BLOCKED" });
    }
    const isFreshEmbeddedState = this.store.loadResult?.status === "fresh";
    const { restored, unmatched } = this.store.journalRecovery;
    if (restored.length) {
      this.store.log(`已按提交记录恢复 ${restored.length} 条任务库中缺失的生成任务：${restored.map((item) => item.taskId).join("、")}`, "warn");
    }
    if (unmatched.length) {
      this.onPersistenceProblem({
        source: "Seedance 任务库",
        unmatchedSubmissions: unmatched.map(({ taskId, reason }) => ({ taskId, reason })),
        file: this.store.unmatchedJournalPath,
      });
    }
    if (this.store.loadResult?.status === "recovered") {
      this.onPersistenceProblem({
        source: "Seedance 任务库",
        recovered: true,
        file: this.store.filePath,
        backup: this.store.loadResult.source,
        preserved: this.store.loadResult.preserved,
      });
    }
    this.store.updateSettings({
      apiKey: this.flowcutStore.state.settings.bridgeKey,
      flowcutBridgeEnabled: true,
      flowcutBridgeUrl: this.flowcutStore.state.settings.flowcutUrl,
      maxConcurrent: Math.max(1, Number(this.getMaxConcurrent() || 1)),
      downloadDirectory:
        this.store.settings.downloadDirectory ||
        path.join(this.app.getPath("downloads"), "FlowCut视频"),
      // Personal-edition migration pauses old jobs once; later starts retain
      // the user's explicit pause/run choice.
      running: this.startPaused || isFreshEmbeddedState
        ? false
        : this.store.settings.running !== false,
    });
    this.accountManager = new AccountManager({
      store: this.store,
      sessionFactory: (partition) => session.fromPartition(partition),
      clientFactory: (electronSession, logger) =>
        new TikTokClient(electronSession, logger),
      onChange: () => this.emit(),
    });
    this.accountManager.initialize();
    this.engine = new QueueEngine(this.store, this.accountManager, () => this.emit());
    this.engine.onUnsavedSubmission = (submission) =>
      this.onPersistenceProblem({ source: "Seedance 任务库", unsavedSubmission: submission });
    this.flowcutBridge = new FlowCutBridge({
      engine: this.engine,
      store: this.store,
      uploadsDirectory: path.join(this.userDataRoot(), "api-uploads"),
      version: this.version,
      downloadTask: (task) => this.downloadTask(task),
      desktopToken: this.getDesktopToken(),
      onChange: () => this.emit(),
    });
    for (const account of this.store.accounts) this.createAuthWindow(account.id);
    this.engine.start();
    this.flowcutBridge.start();
    this.started = true;
    setTimeout(() => this.engine.refreshAuth().catch(() => {}), 1500);
    return this.state();
  }

  async addAccount(name) {
    const account = this.accountManager.addAccount(name);
    this.createAuthWindow(account.id);
    this.showLogin(account.id);
    return this.state();
  }

  async removeAccount(id) {
    const accountSession = this.accountManager.session(id);
    this.accountManager.removeAccount(id);
    const window = this.authWindows.get(id);
    if (this.isLiveWindow(window)) window.destroy();
    this.authWindows.delete(id);
    await accountSession.clearStorageData().catch(() => {});
    await accountSession.clearCache().catch(() => {});
    this.emit();
    return this.state();
  }

  async setRunning(running) {
    await this.engine.setRunning(Boolean(running));
    return this.state();
  }

  applyMaxConcurrent(value) {
    if (!this.store) return;
    this.store.updateSettings({
      maxConcurrent: Math.max(1, Number(value || 1)),
    });
    this.emit();
  }

  async chooseDownloadDirectory() {
    const result = await dialog.showOpenDialog(this.mainWindow, {
      title: "选择 FlowCut 成片下载根目录",
      defaultPath:
        this.store.settings.downloadDirectory || this.app.getPath("downloads"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled) return this.state();
    this.engine.updateSettings({ downloadDirectory: result.filePaths[0] });
    return this.state();
  }

  async openDownloadDirectory() {
    const directory =
      this.store.settings.downloadDirectory ||
      path.join(this.app.getPath("downloads"), "FlowCut视频");
    await fsp.mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
    return true;
  }

  async block() {
    if (!this.started) return;
    await this.engine.setRunning(false).catch(() => {});
    this.flowcutBridge.stop();
    this.emit();
  }

  stop() {
    this.engine?.stop();
    this.flowcutBridge?.stop();
    for (const window of this.authWindows.values()) {
      if (this.isLiveWindow(window)) window.destroy();
    }
    this.authWindows.clear();
  }
}

module.exports = { SeedanceRuntime };
