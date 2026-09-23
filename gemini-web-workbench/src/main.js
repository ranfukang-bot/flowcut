const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  utilityProcess,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { Store } = require("./store");
const { BridgeEngine } = require("./bridge-engine");
const { watchGeminiJob } = require("./gemini-job-watchdog");
const {
  DETECT_GEMINI_AUTH_SCRIPT,
  OPEN_GEMINI_LOGIN_SCRIPT,
  uploadFilesViaChooser,
} = require("./gemini-file-chooser");
const {
  runWithActivatedGeminiWorker,
} = require("./gemini-worker-activation");
const { SeedanceRuntime } = require("./seedance-runtime");
const { protectLoginNavigation } = require('./web-login-navigation');
const { PublisherRuntime } = require("./publisher-runtime");
const { version: appVersion } = require("../package.json");

app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");
app.setName("FlowCut全自动AI视频工作台");
// The explicit smoke-test profile never reads or submits the user's old queue.
const smokeProfile = process.env.FLOWCUT_DESKTOP_SMOKE_FILE && process.env.FLOWCUT_SMOKE_USER_DATA;
if (smokeProfile) {
  fs.mkdirSync(path.resolve(smokeProfile), { recursive: true });
  app.setPath("userData", path.resolve(smokeProfile));
  fs.mkdirSync(path.resolve(smokeProfile, "isolated-appdata"), { recursive: true });
  app.setPath("appData", path.resolve(smokeProfile, "isolated-appdata"));
}
const showGeminiWorkerForDebug =
  process.env.FLOWCUT_DEBUG_GEMINI === "1";
app.setAppUserModelId("local.flowcut.ai.video.workbench");
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let store;
let bridge;
let mainWindow;
let seedanceRuntime;
let publisherRuntime;
let flowcutProjectRoot = "";
let localSiteProcess = null;
let localSiteStartPromise = null;
let localSiteRestartTimer = null;
let localSiteRestartFailures = 0;
let localSiteHealthTimer = null;
let localSiteHealthFailures = 0;
let workbenchStarted = false;
let shutdownStarted = false;
const loginWindows = new Map();
const workerWindows = new Map();
const pendingJobs = new Map();
const desktopRuntimeToken = randomBytes(48).toString("base64url");
const protectedIntegrity =
  typeof __FLOWCUT_RUNTIME_INTEGRITY__ !== "undefined"
    ? __FLOWCUT_RUNTIME_INTEGRITY__
    : { runtime: {}, site: {} };
const protectedGeminiPageRuntime =
  typeof __FLOWCUT_GEMINI_PAGE_RUNTIME__ !== "undefined"
    ? __FLOWCUT_GEMINI_PAGE_RUNTIME__
    : "";

function verifyHash(file, expected) {
  if (!fs.existsSync(file)) throw new Error(`FlowCut 受保护文件缺失：${path.basename(file)}`);
  const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== expected) {
    throw new Error(`FlowCut 文件完整性校验失败：${path.basename(file)}`);
  }
}

function verifyProtectedRuntime() {
  if (!app.isPackaged) return;
  for (const [relative, expected] of Object.entries(protectedIntegrity.runtime || {})) {
    verifyHash(path.join(__dirname, relative), expected);
  }
}

function verifyCompiledSite(siteRoot) {
  if (!app.isPackaged) return;
  for (const [relative, expected] of Object.entries(protectedIntegrity.site || {})) {
    verifyHash(path.join(siteRoot, "dist", ...relative.split("/")), expected);
  }
}

function desktopRuntimeHeaders(extra = {}) {
  return {
    "x-flowcut-desktop-token": desktopRuntimeToken,
    ...extra,
  };
}

const regularChromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "Chrome/142.0.0.0 Safari/537.36";

function importLocalBridgeKey() {
  if (store.state.settings.bridgeKey) return;
  try {
    const seedanceState = path.join(
      app.getPath("appData"),
      "seedance-workbench",
      "workbench-state.json"
    );
    const parsed = JSON.parse(fs.readFileSync(seedanceState, "utf8"));
    const key = String(parsed?.settings?.apiKey || "").trim();
    if (key) {
      store.state.settings.bridgeKey = key;
      store.save();
      store.log("已自动读取本机 Seedance Workbench Key，用于连接 FlowCut");
    }
  } catch {
    store.log("未自动读取到 Bridge Key，可在设置中手动粘贴", "warn");
  }
}

function accountById(id) {
  return store.state.accounts.find((account) => account.id === id);
}

function accountSession(account) {
  const current = session.fromPartition(account.partition, { cache: true });
  current.setUserAgent(regularChromeUserAgent, "zh-CN");
  current.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(["clipboard-read", "clipboard-sanitized-write"].includes(permission));
  });
  return current;
}

const TRANSIENT_GEMINI_NETWORK_ERRORS =
  /ERR_(?:NETWORK_CHANGED|CONNECTION_CLOSED|CONNECTION_RESET|PROXY_CONNECTION_FAILED|TIMED_OUT)/i;

async function refreshAccountNetwork(account) {
  const current = accountSession(account);
  await current.setProxy({ mode: "system" });
  await current.closeAllConnections().catch(() => {});
  return current;
}

async function loadGeminiPage(account, window, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await withTimeout(
        window.loadURL("https://gemini.google.com/app"),
        60_000,
        "Gemini 页面加载超时"
      );
      return;
    } catch (error) {
      lastError = error;
      const message =
        error instanceof Error ? error.message : String(error || "");
      if (
        attempt >= attempts ||
        !TRANSIENT_GEMINI_NETWORK_ERRORS.test(message)
      ) {
        throw error;
      }
      store.log(
        `${account.name} Gemini 网络连接中断，正在自动重连（${attempt}/${attempts}）`,
        "warn"
      );
      await refreshAccountNetwork(account);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError || new Error("Gemini 页面加载失败");
}

async function accountAuthenticated(account) {
  const cookies = await accountSession(account).cookies.get({
    domain: ".google.com",
  });
  return cookies.some((cookie) =>
    ["SID", "__Secure-1PSID", "__Secure-3PSID"].includes(cookie.name)
  );
}

async function refreshAccount(account) {
  const authenticated = await accountAuthenticated(account);
  store.updateAccount(account.id, {
    authenticated,
    lastCheckedAt: new Date().toISOString(),
    error: authenticated ? "" : "尚未登录 Gemini",
  });
  return authenticated;
}

function publicState() {
  return {
    settings: {
      flowcutUrl: store.state.settings.flowcutUrl,
      queueRunning: store.state.settings.queueRunning,
      hasBridgeKey: Boolean(store.state.settings.bridgeKey),
    },
    defaultAccountId: store.state.defaultAccountId,
    accounts: store.state.accounts,
    logs: store.state.logs.slice(-120),
    bridge: bridge?.runtimeState() || {
      online: false,
      lastError: "",
      activeJobs: [],
    },
    edition: "personal",
    update: { status: "local", currentVersion: appVersion, availableVersion: "", percent: 0, message: "个人本机版" },
    seedance: seedanceRuntime?.state() || {
      ready: false,
      authenticated: false,
      accountState: { items: [] },
      tasks: [],
    },
  };
}

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("workbench:state", publicState());
  }
}

function tickBridgeSoon() {
  if (bridge) setTimeout(() => void bridge.tick(), 50);
}

function flowcutWindowIcon() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "flowcut-icon.ico")
    : path.join(__dirname, "..", "build", "flowcut-icon.ico");
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    show: !smokeProfile,
    width: 1500,
    height: 920,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: "#f4f4f0",
    title: "FlowCut 全自动 AI 视频工作台",
    icon: flowcutWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload-ui.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ["http://127.0.0.1/*", "http://localhost/*"] },
    (details, callback) => {
      details.requestHeaders["x-flowcut-desktop-token"] = desktopRuntimeToken;
      callback({ requestHeaders: details.requestHeaders });
    },
  );
  mainWindow.on("focus", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.focus();
  });
  mainWindow.loadFile(path.join(__dirname, "boot.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
    // Gemini and Seedance login sessions use hidden BrowserWindows. Without an
    // explicit quit, those windows keep Electron alive after the visible
    // FlowCut window is closed.
    if (!app.isQuitting) app.quit();
  });
}


function findProjectRoot() {
  const candidates = [
    process.env.FLOWCUT_PROJECT_ROOT,
    process.env.PORTABLE_EXECUTABLE_DIR
      ? path.resolve(process.env.PORTABLE_EXECUTABLE_DIR, "..", "..")
      : "",
    path.join(app.getPath("desktop"), "全自动AI视频工作台"),
    path.resolve(__dirname, "..", ".."),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "Start-FlowCut.ps1"))) {
      return candidate;
    }
  }
  throw new Error(
    "没有找到 FlowCut 本机项目目录，请把桌面 EXE 保留在工作台 release 目录中"
  );
}

function flowcutSiteRoot() {
  if (app.isPackaged) {
    const bundledRoot = path.join(process.resourcesPath, "flowcut-site");
    const bundledWrangler = path.join(
      bundledRoot,
      "node_modules",
      "wrangler",
      "bin",
      "wrangler.js"
    );
    const compiledWorker = path.join(bundledRoot, "dist", "server", "index.js");
    if (!fs.existsSync(bundledWrangler) || !fs.existsSync(compiledWorker)) {
      throw new Error("安装包中的 FlowCut 本地运行组件不完整，请重新安装完整版本");
    }
    verifyCompiledSite(bundledRoot);
    return bundledRoot;
  }
  return findProjectRoot();
}

async function siteReady(url) {
  try {
    const response = await fetch(`${url}/api/settings`, {
      headers: desktopRuntimeHeaders(),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return false;
    if (!app.isPackaged) return true;
    const data = await response.json().catch(() => ({}));
    return data.desktopRuntime === true;
  } catch {
    return false;
  }
}

async function syncSeedanceBridgeKey(siteUrl) {
  const key = String(store.state.settings.bridgeKey || "").trim();
  if (!key) return false;
  const response = await fetch(`${siteUrl.replace(/\/+$/, "")}/api/settings`, {
    method: "PUT",
    headers: desktopRuntimeHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      provider: "seedance",
      apiKey: key,
      config: { mode: "local-api" },
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Seedance Bridge Key 自动同步失败：${response.status} ${detail.slice(0, 160)}`
    );
  }
  return true;
}

function scheduleLocalSiteRestart(reason = "本地服务已退出") {
  if (app.isQuitting || shutdownStarted || localSiteRestartTimer) return;
  const delays = [1_000, 2_000, 5_000, 10_000, 30_000];
  const delayMs = delays[Math.min(localSiteRestartFailures, delays.length - 1)];
  localSiteRestartFailures += 1;
  store?.log(
    `${reason}，FlowCut 将在 ${Math.ceil(delayMs / 1000)} 秒后自动恢复`,
    "warn"
  );
  localSiteRestartTimer = setTimeout(async () => {
    localSiteRestartTimer = null;
    try {
      const siteUrl = await ensureLocalFlowcut();
      localSiteRestartFailures = 0;
      if (mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(siteUrl);
      }
      bridge?.start();
      seedanceRuntime?.flowcutBridge?.start();
      store?.log("FlowCut 本机服务已自动恢复");
      broadcast();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      scheduleLocalSiteRestart(`FlowCut 本机服务恢复失败：${message}`);
    }
  }, delayMs);
  localSiteRestartTimer.unref?.();
}

function startLocalSiteHealthMonitor() {
  if (localSiteHealthTimer) return;
  localSiteHealthTimer = setInterval(async () => {
    if (app.isQuitting || shutdownStarted || !workbenchStarted) return;
    const siteUrl = store.state.settings.flowcutUrl.replace(/\/+$/, "");
    if (await siteReady(siteUrl)) {
      localSiteHealthFailures = 0;
      return;
    }
    localSiteHealthFailures += 1;
    if (localSiteHealthFailures < 3) return;
    localSiteHealthFailures = 0;
    store.log("FlowCut 本机服务连续健康检查失败，正在自动重启", "warn");
    if (localSiteProcess?.pid) {
      localSiteProcess.kill();
    }
    scheduleLocalSiteRestart("FlowCut 本机服务无响应");
  }, 5_000);
  localSiteHealthTimer.unref?.();
}

async function startLocalFlowcut() {
  const siteUrl = store.state.settings.flowcutUrl.replace(/\/+$/, "");
  if (await siteReady(siteUrl)) {
    await syncSeedanceBridgeKey(siteUrl);
    return siteUrl;
  }
  flowcutProjectRoot = flowcutSiteRoot();
  const parsedUrl = new URL(siteUrl);
  if (!["127.0.0.1", "localhost"].includes(parsedUrl.hostname)) {
    throw new Error("桌面完整版本只允许使用本机 FlowCut 地址");
  }
  const runtimeDirectory = path.join(app.getPath("userData"), "site-runtime");
  const logDirectory = path.join(runtimeDirectory, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const wranglerCli = path.join(
    flowcutProjectRoot,
    "node_modules",
    "wrangler",
    "wrangler-dist",
    "cli.js"
  );
  const compiledWorker = path.join(
    flowcutProjectRoot,
    "dist",
    "server",
    "index.js",
  );
  const wranglerConfig = path.join(
    flowcutProjectRoot,
    "dist",
    "server",
    "wrangler.json",
  );
  const runtimeHost = app.isPackaged
    ? path.join(process.resourcesPath, "site-runtime-host.cjs")
    : path.join(__dirname, "site-runtime-host.cjs");
  if (app.isPackaged) {
    verifyHash(
      runtimeHost,
      protectedIntegrity.runtime?.["site-runtime-host.cjs"],
    );
  }
  const stdoutPath = path.join(logDirectory, "site.out.log");
  const stderrPath = path.join(logDirectory, "site.err.log");
  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "a" });
  const stderrStream = fs.createWriteStream(stderrPath, { flags: "a" });
  let childExited = false;
  const child = utilityProcess.fork(
    runtimeHost,
    [],
    {
      cwd: flowcutProjectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      serviceName: "FlowCut Local Runtime",
      env: {
        ...process.env,
        CREDENTIALS_MASTER_KEY:
          store.state.settings.credentialsMasterKey,
        FLOWCUT_PERSIST_PATH: path.join(runtimeDirectory, "data"),
        WRANGLER_LOG_PATH: path.join(logDirectory, "wrangler.log"),
        MINIFLARE_REGISTRY_PATH: path.join(runtimeDirectory, "registry"),
        // Local video work does not need Cloudflare's IP geolocation lookup.
        CLOUDFLARE_CF_FETCH_ENABLED: "false",
        FLOWCUT_PERSONAL_MODE: "1",
        FLOWCUT_DESKTOP_RUNTIME: "1",
        FLOWCUT_DESKTOP_TOKEN: desktopRuntimeToken,
        FLOWCUT_RUNTIME_OPTIONS: Buffer.from(
          JSON.stringify({
            wranglerLibrary: wranglerCli,
            workerScript: compiledWorker,
            config: wranglerConfig,
            ip: "127.0.0.1",
            port: Number(parsedUrl.port || "4173"),
            persistTo: path.join(runtimeDirectory, "data"),
            vars: {
              CREDENTIALS_MASTER_KEY:
                store.state.settings.credentialsMasterKey,
              FLOWCUT_PERSONAL_MODE: "1",
              FLOWCUT_DESKTOP_RUNTIME: "1",
              FLOWCUT_DESKTOP_TOKEN: desktopRuntimeToken,
            },
          }),
          "utf8",
        ).toString("base64url"),
      },
    }
  );
  child.stdout?.pipe(stdoutStream);
  child.stderr?.pipe(stderrStream);
  child.once("error", (type, location, report) => {
    fs.appendFileSync(
      stderrPath,
      `[utility-error] ${type || "unknown"} ${location || ""}\n${report || ""}\n`,
    );
  });
  localSiteProcess = child;
  child.once("exit", (code) => {
    childExited = true;
    fs.appendFileSync(stderrPath, `[utility-exit] code=${code}\n`);
    stdoutStream.end();
    stderrStream.end();
    if (localSiteProcess === child) localSiteProcess = null;
    if (workbenchStarted && !app.isQuitting && !shutdownStarted) {
      scheduleLocalSiteRestart(
        `FlowCut 本机服务意外退出（${code ?? "未知原因"}）`
      );
    }
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (childExited) break;
    if (await siteReady(siteUrl)) {
      localSiteRestartFailures = 0;
      await syncSeedanceBridgeKey(siteUrl);
      return siteUrl;
    }
  }
  throw new Error("FlowCut 本机服务启动失败，请检查 .local-runtime 日志");
}

async function ensureLocalFlowcut() {
  if (localSiteStartPromise) return localSiteStartPromise;
  localSiteStartPromise = startLocalFlowcut();
  try {
    return await localSiteStartPromise;
  } finally {
    localSiteStartPromise = null;
  }
}

function createGeminiWindow(account, visible) {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    show: visible,
    title: `${account.name} · Gemini`,
    backgroundColor: "#ffffff",
    icon: flowcutWindowIcon(),
    webPreferences: {
      partition: account.partition,
      preload: visible ? undefined : path.join(__dirname, "gemini-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.setUserAgent(regularChromeUserAgent);
  window.webContents.setWindowOpenHandler(({ url }) => {
    window.loadURL(url);
    return { action: "deny" };
  });
  return window;
}

async function syncLoginWindowState(account, window) {
  if (!window || window.isDestroyed()) return "unknown";
  const state = await window.webContents
    .executeJavaScript(DETECT_GEMINI_AUTH_SCRIPT, true)
    .catch(() => "unknown");
  if (state === "signed-out") {
    store.updateAccount(account.id, {
      authenticated: false,
      lastCheckedAt: new Date().toISOString(),
      error: "Gemini 登录已失效，请重新登录",
    });
    broadcast();
    return state;
  }
  if (state !== "signed-in" || !(await accountAuthenticated(account))) {
    return state;
  }
  store.updateAccount(account.id, {
    authenticated: true,
    lastCheckedAt: new Date().toISOString(),
    error: "",
  });
  await accountSession(account).cookies.flushStore();
  accountSession(account).flushStorageData();
  store.log(`${account.name} Gemini 登录成功，等待中的任务将自动继续`);
  broadcast();
  tickBridgeSoon();
  setTimeout(() => {
    if (!window.isDestroyed()) window.hide();
  }, 1200);
  return state;
}

async function openLoginWindow(id) {
  const account = accountById(id);
  if (!account) throw new Error("账号不存在");
  let window = loginWindows.get(id);
  if (!window || window.isDestroyed()) {
    window = createGeminiWindow(account, true);
    loginWindows.set(id, window);
    window.on("closed", () => loginWindows.delete(id));
    window.webContents.on("did-finish-load", () => {
      setTimeout(
        () => void syncLoginWindowState(account, window),
        1200
      );
    });
    await loadGeminiPage(account, window);
  }
  window.show();
  window.focus();
  await window.webContents
    .executeJavaScript(OPEN_GEMINI_LOGIN_SCRIPT, true)
    .catch(() => {});
  return true;
}

async function hideLoginWindow(id) {
  const account = accountById(id);
  if (!account) throw new Error("账号不存在");
  const authenticated = await refreshAccount(account);
  if (!authenticated) {
    throw new Error("还没有检测到 Google 登录，请先在账号窗口完成登录");
  }
  const window = loginWindows.get(id);
  if (window && !window.isDestroyed()) window.hide();
  store.log(`${account.name} 登录态已保存，账号窗口已隐藏`);
  broadcast();
  return true;
}

function workerWindow(account) {
  let window = workerWindows.get(account.id);
  if (!window || window.isDestroyed()) {
    window = createGeminiWindow(account, false);
    workerWindows.set(account.id, window);
    window.on("closed", () => workerWindows.delete(account.id));
  }
  if (showGeminiWorkerForDebug && !window.isDestroyed()) {
    window.setTitle(`${account.name} · Gemini 实时调试`);
    window.show();
  }
  return window;
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), timeoutMs)
    ),
  ]);
}

function prepareTemporaryGeminiFiles(files, requestId, prefix = "product") {
  const root = path.join(app.getPath("temp"), "flowcut-gemini-uploads");
  const directory = path.join(root, requestId);
  fs.mkdirSync(directory, { recursive: true });
  const filePaths = (files || []).map((file, index) => {
    const requestedExtension = path
      .extname(String(file.name || ""))
      .toLowerCase();
    const extension = [".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".webm"].includes(
      requestedExtension
    )
      ? requestedExtension
      : "";
    const fallback = String(file.mime || "").startsWith("video/") ? ".mp4" : ".jpg";
    const filePath = path.join(directory, `${prefix}-${index + 1}${extension || fallback}`);
    fs.writeFileSync(filePath, Buffer.from(file.data));
    return filePath;
  });
  return { directory, filePaths, root };
}

function removeTemporaryGeminiFiles(temporary) {
  if (
    temporary?.directory &&
    temporary?.root &&
    path.dirname(temporary.directory) === temporary.root
  ) {
    fs.rmSync(temporary.directory, { recursive: true, force: true });
  }
}

async function runGeminiJob(account, job) {
  bridge?.assertTaskActive(job.id);
  if (!(await refreshAccount(account))) {
    const error = new Error("Gemini 登录已失效，请重新登录该账号");
    error.code = "NEEDS_LOGIN";
    void openLoginWindow(account.id);
    throw error;
  }
  bridge?.assertTaskActive(job.id);
  const window = workerWindow(account);
  await loadGeminiPage(account, window);
  await new Promise((resolve) => setTimeout(resolve, 2200));

  bridge?.assertTaskActive(job.id);
  const requestId = randomUUID();
  const temporary = prepareTemporaryGeminiFiles(job.files || [], requestId, "product");
  const referenceTemporary = prepareTemporaryGeminiFiles(
    job.referenceFiles || [],
    `${requestId}-reference`,
    "reference"
  );
  const resultPromise = new Promise((resolve, reject) => {
    const watchdog = watchGeminiJob({
      contents: window.webContents,
      timeoutMs: (job.kind === "script-pipeline" ? 60 : job.kind === "reference-remix" ? 26 : 13) * 60_000,
      onFailure(error) {
        pendingJobs.delete(requestId);
        // Stop the old renderer before releasing the account for another task.
        if (!window.isDestroyed()) window.destroy();
        reject(error);
      },
    });
    pendingJobs.set(requestId, {
      resolve(value) { watchdog.stop(); resolve(value); },
      reject(error) { watchdog.stop(); reject(error); },
      touch: watchdog.touch,
      contentsId: window.webContents.id,
      accountId: account.id,
      taskId: job.id,
      kind: job.kind || "standard",
    });
  });
  const pageJob = {
    requestId,
    prompt: job.prompt,
    kind: job.kind || "standard",
    analysisPrompt: job.analysisPrompt,
    adaptationPrompt: job.adaptationPrompt,
    projectContext: job.projectContext || "",
    rewrittenScript: job.rewrittenScript || "",
    extractionJson: job.extractionJson || "",
    storyboardJson: job.storyboardJson || "",
    rawGroupsJson: job.rawGroupsJson || "",
    files: (job.files || []).map(({ name, mime }) => ({
      name,
      mime,
      data: [],
    })),
    filePaths: temporary.filePaths,
    referenceFiles: (job.referenceFiles || []).map(({ name, mime }) => ({
      name,
      mime,
      data: [],
    })),
    referenceFilePaths: referenceTemporary.filePaths,
  };
  if (protectedGeminiPageRuntime) {
    void (async () => {
      try {
        await window.webContents.executeJavaScript(
          protectedGeminiPageRuntime,
          true,
        );
        const result = await window.webContents.executeJavaScript(
          `globalThis.__flowcutRunGeminiJob(${JSON.stringify(pageJob)})`,
          true,
        );
        completeGeminiJob(result);
      } catch (error) {
        completeGeminiJob({
          requestId,
          ok: false,
          code: error?.code || "",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  } else {
    window.webContents.send("gemini:run-job", {
      ...pageJob,
      files: job.files,
      referenceFiles: job.referenceFiles,
    });
  }
  try {
    return await resultPromise;
  } finally {
    removeTemporaryGeminiFiles(temporary);
    removeTemporaryGeminiFiles(referenceTemporary);
  }
}

async function smokeProtectedGeminiRuntime() {
  if (!protectedGeminiPageRuntime) return false;
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "gemini-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  try {
    await window.loadURL("data:text/html,<main>FlowCut runtime smoke</main>");
    await window.webContents.executeJavaScript(
      protectedGeminiPageRuntime,
      true,
    );
    return await window.webContents.executeJavaScript(
      'typeof globalThis.__flowcutRunGeminiJob === "function" && ' +
        'typeof globalThis.flowcutGeminiNative?.sendKey === "function"',
      true,
    );
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

function completeGeminiJob(result) {
  const pending = pendingJobs.get(result.requestId);
  if (!pending) return;
  pendingJobs.delete(result.requestId);
  if (result.ok) {
    pending.resolve({
      prompt: result.prompt,
      analysis: result.analysis || "",
      rewrittenScript: result.rewrittenScript || "",
      extractionJson: result.extractionJson || "",
      storyboardJson: result.storyboardJson || "",
      rawGroupsJson: result.rawGroupsJson || "",
      optimizedGroupsJson: result.optimizedGroupsJson || "",
    });
    return;
  }
  const error = new Error(result.error || "Gemini 网页执行失败");
  error.code = result.code || "";
  if (error.code === "NEEDS_LOGIN") {
    void openLoginWindow(pending.accountId);
  }
  pending.reject(error);
}

ipcMain.on("gemini:job-result", (_event, result) => {
  completeGeminiJob(result);
});

ipcMain.on("gemini:job-stage", (event, result) => {
  const pending = pendingJobs.get(result.requestId);
  if (!pending || event.sender.id !== pending.contentsId) return;
  pending.touch();
  if (result.stage === "progress") {
    const active = bridge?.active.get(pending.accountId);
    if (active) {
      active.stage = String(result.detail || "Gemini 正在处理").slice(0, 160);
      active.updatedAt = new Date().toISOString();
      broadcast();
    }
    return;
  }
  if (!["reference-remix", "script-pipeline"].includes(pending.kind)) return;
  void bridge
    ?.report(pending.taskId, "stage", {
      kind: pending.kind,
      stage: result.stage,
      analysis: String(result.analysis || ""),
      rewrittenScript: String(result.rewrittenScript || ""),
      extractionJson: String(result.extractionJson || ""),
      storyboardJson: String(result.storyboardJson || ""),
      rawGroupsJson: String(result.rawGroupsJson || ""),
    })
    .catch(() => {});
});

ipcMain.on("gemini:job-diagnostic", (_event, diagnostic) => {
  const active = [...pendingJobs.values()][0];
  const accountId = active?.accountId;
  const window = accountId ? workerWindows.get(accountId) : null;
  const informational =
    diagnostic?.phase === "upload_native_confirmed_dom_changed" ||
    diagnostic?.phase === "upload_native_chooser_failed";
  store.log(
    `Gemini 页面诊断：${JSON.stringify(diagnostic)}`,
    informational ? "info" : "warn"
  );
  if (!informational && window && !window.isDestroyed()) {
    window.setTitle("Gemini 任务未响应 · 请检查页面");
  }
  broadcast();
});

function bindIpc() {
  ipcMain.handle("gemini:upload-files-via-chooser", async (event, filePaths) => {
    const uploadRoot = path.resolve(
      app.getPath("temp"),
      "flowcut-gemini-uploads"
    );
    const paths = Array.isArray(filePaths)
      ? filePaths
          .slice(0, 12)
          .map((filePath) => path.resolve(String(filePath || "")))
          .filter(
            (filePath) =>
              filePath.startsWith(`${uploadRoot}${path.sep}`) &&
              fs.existsSync(filePath)
          )
      : [];
    const window = BrowserWindow.fromWebContents(event.sender);
    return runWithActivatedGeminiWorker({
      workerWindow: window,
      ownerWindow: mainWindow,
      debugVisible: showGeminiWorkerForDebug,
      action: async () => {
        let result = { ok: false, code: "FILE_CHOOSER_NOT_OPENED" };
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          result = await uploadFilesViaChooser(event.sender, paths, 12_000);
          if (result?.ok || result?.code === "NEEDS_LOGIN") {
            return { ...result, attempt };
          }
          event.sender.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
          event.sender.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
          if (attempt < 3) {
            await new Promise((resolve) =>
              setTimeout(resolve, 500 + attempt * 500)
            );
          }
        }
        return { ...result, attempts: 3 };
      },
    });
  });
  ipcMain.handle("gemini:replace-editor-text", async (event, text) => {
    const webContents = event.sender;
    webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "A",
      modifiers: ["control"],
    });
    webContents.sendInputEvent({
      type: "keyUp",
      keyCode: "A",
      modifiers: ["control"],
    });
    webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
    webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
    webContents.insertText(String(text || ""));
    return true;
  });
  ipcMain.handle("gemini:send-key", async (event, requestedKey) => {
    const keyCode = requestedKey === "Escape" ? "Escape" : "Enter";
    event.sender.sendInputEvent({ type: "keyDown", keyCode });
    event.sender.sendInputEvent({ type: "keyUp", keyCode });
    return true;
  });
  ipcMain.handle("workbench:get-state", () => publicState());
  ipcMain.handle("archive:choose-directory", async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, { title: "选择视频保存文件夹", properties: ["openDirectory", "createDirectory"] });
      if (result.canceled || !result.filePaths[0]) return null;
      const folder = path.resolve(result.filePaths[0]);
      fs.accessSync(folder, fs.constants.W_OK);
      return folder;
    } finally { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.focus(); mainWindow.webContents.focus(); } }
  });
  ipcMain.handle("tasks:clear-all", async () => {
    store.state.settings.queueRunning = false;
    store.save();
    await seedanceRuntime?.setRunning(false);
    const response = await fetch(store.state.settings.flowcutUrl.replace(/\/+$/, "") + "/api/tasks?all=1", {
      method: "DELETE", headers: { "x-flowcut-desktop-token": desktopRuntimeToken }, signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "清除任务失败");
    const ids = new Set(result.ids || []);
    // Include old local remnants whose site row was already removed individually.
    for (const task of seedanceRuntime?.store?.tasks || []) {
      if (task.flowcutTaskId && (!task.flowcutTaskKind || task.flowcutTaskKind === "standard")) ids.add(task.flowcutTaskId);
    }
    for (const item of store.state.pendingResults || []) if (!item.kind || item.kind === "standard") ids.add(item.taskId);
    bridge?.cancelTasks([...ids]);
    seedanceRuntime?.clearTasks([...ids]);
    for (const [requestId, job] of pendingJobs) {
      if (!ids.has(job.taskId)) continue;
      pendingJobs.delete(requestId);
      job.reject(Object.assign(new Error("任务已清除"), { code: "TASK_CLEARED" }));
      const window = workerWindows.get(job.accountId);
      if (window && !window.isDestroyed()) window.destroy();
    }
    broadcast();
    return { deleted: result.deleted };
  });
  ipcMain.handle("publisher:start", () => publisherRuntime.start());
  ipcMain.handle("publisher:import", (_event, rows) => publisherRuntime.importProducts(rows));
  ipcMain.handle("publisher:open-extension", () => publisherRuntime.openExtension());
  ipcMain.handle("publisher:release", (_event, input) => publisherRuntime.release(String(input?.taskId || ""), input?.confirmed === true));
  ipcMain.handle("update:get-state", () => publicState().update);
  ipcMain.handle("seedance:get-state", () => seedanceRuntime?.state() || null);
  ipcMain.handle('seedance:preferred-model', (_event, input) => seedanceRuntime.setPreferredModel(input.id, input.model));
  ipcMain.handle('seedance:fast-fallback', (_event, input) => seedanceRuntime.decideFastFallback(input.id, input.choice, input.date));
  ipcMain.handle('seedance:reconnect-login', (_event, id) => seedanceRuntime.reconnectLogin(id));
  ipcMain.handle("seedance:account-add", async (_event, name) => {
    return seedanceRuntime.addAccount(String(name || "").trim());
  });
  ipcMain.handle("seedance:account-open-login", (_event, id) => {
    return seedanceRuntime.showLogin(id);
  });
  ipcMain.handle("seedance:account-save-login", (_event, id) => {
    return seedanceRuntime.saveLogin(id);
  });
  ipcMain.handle("seedance:account-remove", (_event, id) => {
    return seedanceRuntime.removeAccount(id);
  });
  ipcMain.handle("seedance:set-running", (_event, running) => {
    return seedanceRuntime.setRunning(running);
  });
  ipcMain.handle("seedance:choose-download-directory", () => {
    return seedanceRuntime.chooseDownloadDirectory();
  });
  ipcMain.handle("seedance:open-download-directory", () =>
    seedanceRuntime.openDownloadDirectory(),
  );
  ipcMain.handle("account:add", async (_event, name) => {
    const account = store.addAccount(String(name || "").trim());
    store.log(`已添加账号：${account.name}`);
    await openLoginWindow(account.id);
    broadcast();
    tickBridgeSoon();
    return publicState();
  });
  ipcMain.handle("account:open-login", async (_event, id) => {
    await openLoginWindow(id);
    return true;
  });
  ipcMain.handle("account:hide-login", async (_event, id) => {
    await hideLoginWindow(id);
    tickBridgeSoon();
    return publicState();
  });
  ipcMain.handle("account:check", async (_event, id) => {
    const account = accountById(id);
    if (!account) throw new Error("账号不存在");
    await refreshAccount(account);
    broadcast();
    tickBridgeSoon();
    return publicState();
  });
  ipcMain.handle("account:set-default", (_event, id) => {
    if (!accountById(id)) throw new Error("账号不存在");
    store.state.defaultAccountId = id;
    store.save();
    broadcast();
    tickBridgeSoon();
    return publicState();
  });
  ipcMain.handle("account:remove", async (_event, id) => {
    const account = accountById(id);
    if (!account) return publicState();
    loginWindows.get(id)?.destroy();
    workerWindows.get(id)?.destroy();
    loginWindows.delete(id);
    workerWindows.delete(id);
    await accountSession(account).clearStorageData();
    store.removeAccount(id);
    store.log(`已移除账号：${account.name}`);
    broadcast();
    tickBridgeSoon();
    return publicState();
  });
  ipcMain.handle("workbench:set-queue-running", (_event, running) => {
    store.state.settings.queueRunning = Boolean(running);
    store.save();
    broadcast();
    tickBridgeSoon();
    return publicState();
  });
  ipcMain.handle("workbench:save-settings", async (_event, settings) => {
    store.state.settings.flowcutUrl = String(
      settings?.flowcutUrl || "http://127.0.0.1:4173"
    ).replace(/\/+$/, "");
    if (String(settings?.bridgeKey || "").trim()) {
      store.state.settings.bridgeKey = String(settings.bridgeKey).trim();
    }
    store.save();
    await syncSeedanceBridgeKey(store.state.settings.flowcutUrl);
    broadcast();
    tickBridgeSoon();
    return publicState();
  });
}

async function activateWorkbench() {
  try {
    const siteUrl = await ensureLocalFlowcut();
    void mainWindow.loadURL(siteUrl).catch(async (error) => {
      store.log(
        error instanceof Error ? error.message : "FlowCut 页面加载失败",
        "error",
      );
      await mainWindow.loadFile(path.join(__dirname, "boot.html"), {
        query: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
  } catch (error) {
    store.log(
      error instanceof Error ? error.message : "FlowCut 本机服务启动失败",
      "error"
    );
    await mainWindow.loadFile(path.join(__dirname, "boot.html"), {
      query: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }
  if (!workbenchStarted) {
    for (const account of store.state.accounts) {
      await refreshAccount(account).catch(() => false);
    }
    bridge = new BridgeEngine({
      store,
      getAuthenticatedAccounts: () =>
        store.state.accounts.filter((account) => account.authenticated),
      getMaxConcurrent: () => store.state.settings.maxConcurrent,
      getDesktopToken: () => desktopRuntimeToken,
      version: appVersion,
      runJob: runGeminiJob,
      onChange: broadcast,
    });
    seedanceRuntime = new SeedanceRuntime({
      app,
      flowcutStore: store,
      startPaused: !store.state.settings.personalEditionInitialized || Boolean(smokeProfile),
      version: appVersion,
      mainWindow,
      getMaxConcurrent: () => store.state.settings.maxConcurrent,
      getDesktopToken: () => desktopRuntimeToken,
      onChange: broadcast,
    });
    await seedanceRuntime.start();
    store.state.settings.personalEditionInitialized = true;
    store.save();
    workbenchStarted = true;
    await publisherRuntime.start().catch(error => store.log(`选品与发布连接暂不可用：${error.message}`, "warn"));
    startLocalSiteHealthMonitor();
  }
  bridge.start();
  seedanceRuntime.flowcutBridge?.start();
  broadcast();
}

app.whenReady().then(async () => {
  verifyProtectedRuntime();
  store = new Store(app);
  if (smokeProfile) store.state.settings.flowcutUrl = "http://127.0.0.1:4198";
  if (!store.state.settings.personalEditionInitialized) {
    store.state.settings.queueRunning = false;
    store.log("已切换为个人本机版。历史任务已保留，队列已暂停，请检查后继续。", "info");
    store.save();
  }
  importLocalBridgeKey();
  bindIpc();
  createMainWindow();
  publisherRuntime = new PublisherRuntime({ app, store, token: desktopRuntimeToken, smoke: Boolean(smokeProfile),
    onOpen: () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } } });
  await activateWorkbench();
  if (process.env.FLOWCUT_DESKTOP_SMOKE_FILE) {
    const geminiPageRuntimeReady = await smokeProtectedGeminiRuntime().catch(
      () => false,
    );
    const clearAllResult = smokeProfile ? await mainWindow.webContents.executeJavaScript("globalThis.flowcutDesktop.clearAllTasks()") : null;
    const modelPolicyVerified = smokeProfile ? await mainWindow.webContents.executeJavaScript(`(async () => {
      const api = globalThis.flowcutDesktop;
      const state = await api.seedanceState();
      const id = state.accountState.items[0].id;
      const standard = await api.seedanceSetPreferredModel(id, '2000004');
      let blocked = false;
      try { await api.seedanceSetPreferredModel(id, '2000009'); } catch { blocked = true; }
      const fast = await api.seedanceSetPreferredModel(id, '2000012');
      return blocked && standard.accountState.items[0].preferredModel === '2000004' && fast.accountState.items[0].preferredModel === '2000012';
    })()`): null;
    let nativeProtocolBlocked = null;
    if (smokeProfile) {
      const probe = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
      let blocked = 0;
      protectLoginNavigation(probe.webContents, {}, () => blocked++);
      try {
        await probe.loadURL('data:text/html,<html><body>Navigation guard test</body></html>');
        await probe.webContents.executeJavaScript("location.href='bytedance://flowcut-local-navigation-test'; true", true);
        await new Promise(resolve => setTimeout(resolve, 300));
        nativeProtocolBlocked = blocked > 0 && probe.webContents.getURL().startsWith('data:');
      } finally { probe.destroy(); }
    }
    fs.writeFileSync(
      process.env.FLOWCUT_DESKTOP_SMOKE_FILE,
      JSON.stringify(
        {
          edition: "personal",
          clearAllVerified: clearAllResult?.deleted === 0,
          modelPolicyVerified,
          nativeProtocolBlocked,
          workbenchStarted,
          seedance: seedanceRuntime?.state() || null,
          siteUrl: store.state.settings.flowcutUrl,
          geminiPageRuntimeReady,
          userData: app.getPath("userData"),
          version: appVersion,
          publisherReady: Boolean(publisherRuntime?.child),
        },
        null,
        2,
      ),
      "utf8",
    );
    if (smokeProfile) app.quit();
  }
});

app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (shutdownStarted) return;
  shutdownStarted = true;
  bridge?.stop();
  seedanceRuntime?.stop();
  publisherRuntime?.stop();
  if (localSiteRestartTimer) {
    clearTimeout(localSiteRestartTimer);
    localSiteRestartTimer = null;
  }
  if (localSiteHealthTimer) {
    clearInterval(localSiteHealthTimer);
    localSiteHealthTimer = null;
  }
  if (localSiteProcess?.pid) {
    localSiteProcess.kill();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
