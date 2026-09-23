const { autoUpdater } = require("electron-updater");
const distribution = require("./license-distribution.json");

function updateFeedUrl() {
  const configured = Array.isArray(distribution.controlPlanes)
    ? distribution.controlPlanes.find(
        (item) => item.id === distribution.defaultControlPlaneId,
      ) || distribution.controlPlanes[0]
    : null;
  const base = String(
    process.env.FLOWCUT_UPDATE_BASE_URL || configured?.url || "",
  ).replace(/\/+$/, "");
  if (!base) throw new Error("安装包没有配置云更新地址");
  return `${base}/api/updates/windows`;
}

class UpdateManager {
  constructor(app, { onChange = () => {}, log = () => {} } = {}) {
    this.app = app;
    this.onChange = onChange;
    this.log = log;
    this.timer = null;
    this.state = {
      status: "idle",
      currentVersion: app.getVersion(),
      availableVersion: "",
      percent: 0,
      message: "等待检查更新",
      checkedAt: null,
    };
  }

  publicState() {
    return { ...this.state };
  }

  setState(patch) {
    Object.assign(this.state, patch);
    this.onChange(this.publicState());
  }

  start() {
    if (!this.app.isPackaged && process.env.FLOWCUT_FORCE_UPDATE_CHECK !== "1") {
      this.setState({
        status: "development",
        message: "开发模式不检查云更新",
      });
      return;
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.setFeedURL({
      provider: "generic",
      url: updateFeedUrl(),
      useMultipleRangeRequest: true,
    });
    autoUpdater.on("checking-for-update", () => {
      this.setState({ status: "checking", message: "正在检查新版本…" });
    });
    autoUpdater.on("update-available", (info) => {
      this.log(`发现 FlowCut 新版本 ${info.version}`);
      this.setState({
        status: "available",
        availableVersion: String(info.version || ""),
        percent: 0,
        message: `发现新版本 ${info.version}，正在后台下载`,
        checkedAt: new Date().toISOString(),
      });
    });
    autoUpdater.on("update-not-available", () => {
      this.setState({
        status: "current",
        availableVersion: "",
        percent: 0,
        message: "当前已是最新版本",
        checkedAt: new Date().toISOString(),
      });
    });
    autoUpdater.on("download-progress", (progress) => {
      const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
      this.setState({
        status: "downloading",
        percent,
        message: `新版本下载中 ${Math.round(percent)}%`,
      });
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.log(`FlowCut ${info.version} 已下载，等待重启安装`);
      this.setState({
        status: "downloaded",
        availableVersion: String(info.version || ""),
        percent: 100,
        message: `新版本 ${info.version} 已准备好，重启即可完成更新`,
      });
    });
    autoUpdater.on("error", (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`云更新检查失败：${detail}`, "warn");
      this.setState({
        status: "error",
        message: `更新暂时不可用：${detail}`,
        checkedAt: new Date().toISOString(),
      });
    });
    setTimeout(() => void this.check(), 12_000);
    this.timer = setInterval(() => void this.check(), 6 * 60 * 60_000);
  }

  async check() {
    if (
      !this.app.isPackaged &&
      process.env.FLOWCUT_FORCE_UPDATE_CHECK !== "1"
    ) {
      return this.publicState();
    }
    if (["checking", "downloading"].includes(this.state.status)) {
      return this.publicState();
    }
    await autoUpdater.checkForUpdates().catch(() => {});
    return this.publicState();
  }

  install() {
    if (this.state.status !== "downloaded") {
      throw new Error("新版本还没有下载完成");
    }
    autoUpdater.quitAndInstall(false, true);
    return true;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { UpdateManager, updateFeedUrl };
