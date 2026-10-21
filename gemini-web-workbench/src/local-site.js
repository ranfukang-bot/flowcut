// FlowCut 的本机网页服务：找到并启动它、等它就绪、同步 Seedance Bridge Key、
// 每 5 秒做一次健康检查，意外退出或无响应时自动重启，退出程序时关闭。
// 依赖由 main.js 传入；这里不直接碰主窗口和各执行器，恢复后的动作交给 onRecovered。
const path = require("node:path");
const fs = require("node:fs");
const { requireLocalSiteUrl } = require("./desktop-security");
const { startRuntimeLogMaintenance } = require("./runtime-log-maintenance");

function createLocalSite({
  app,
  utilityProcess,
  store,
  desktopRuntimeToken,
  desktopRuntimeHeaders,
  verifyHash,
  verifyCompiledSite,
  protectedIntegrity,
  isStarted,
  isShuttingDown,
  onRecovered,
}) {
  let flowcutProjectRoot = "";
  let localSiteProcess = null;
  let localSiteStartPromise = null;
  let localSiteRestartTimer = null;
  let localSiteRestartFailures = 0;
  let localSiteHealthTimer = null;
  let localSiteHealthFailures = 0;
  let stopRuntimeLogMaintenance = null;

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
    requireLocalSiteUrl(url);
    try {
      const response = await fetch(`${url}/api/settings`, {
        redirect: 'error',
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
    requireLocalSiteUrl(siteUrl);
    const key = String(store.state.settings.bridgeKey || "").trim();
    if (!key) return false;
    const response = await fetch(`${siteUrl.replace(/\/+$/, "")}/api/settings`, {
      redirect: 'error',
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
    if (app.isQuitting || isShuttingDown() || localSiteRestartTimer) return;
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
        await onRecovered(siteUrl);
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
      if (app.isQuitting || isShuttingDown() || !isStarted()) return;
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
    const parsedUrl = requireLocalSiteUrl(siteUrl);
    if (!stopRuntimeLogMaintenance) {
      stopRuntimeLogMaintenance = startRuntimeLogMaintenance(app.getPath("userData"), {
        onError: (error, file) => console.warn(`运行日志清理暂时失败（${file}）：${error.message}`),
      });
    }
    if (await siteReady(siteUrl)) {
      await syncSeedanceBridgeKey(siteUrl);
      return siteUrl;
    }
    flowcutProjectRoot = flowcutSiteRoot();
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
          // Wrangler otherwise writes every debug event, even at console log level.
          // Keep ordinary stdout/stderr diagnostics under our bounded log policy.
          WRANGLER_WRITE_LOGS: "false",
          WRANGLER_LOG: "warn",
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
      if (isStarted() && !app.isQuitting && !isShuttingDown()) {
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

  function stopLogMaintenance() {
    stopRuntimeLogMaintenance?.();
    stopRuntimeLogMaintenance = null;
  }

  // Called once while FlowCut quits: no restart, no health check, stop the service.
  function stop() {
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
  }

  return { ensureLocalFlowcut, syncSeedanceBridgeKey, startLocalSiteHealthMonitor, stopLogMaintenance, stop };
}

module.exports = { createLocalSite };
