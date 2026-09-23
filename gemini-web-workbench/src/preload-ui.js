const { contextBridge, ipcRenderer } = require("electron");

const desktopApi = {
  seedanceSetPreferredModel: (id, model) => ipcRenderer.invoke('seedance:preferred-model', { id, model }),
  seedanceDecideFastFallback: (id, choice, date) => ipcRenderer.invoke('seedance:fast-fallback', { id, choice, date }),
  seedanceReconnectLogin: id => ipcRenderer.invoke('seedance:reconnect-login', id),
  chooseArchiveDirectory: () => ipcRenderer.invoke("archive:choose-directory"),
  clearAllTasks: () => ipcRenderer.invoke("tasks:clear-all"),
  getState: () => ipcRenderer.invoke("workbench:get-state"),
  publisherStart: () => ipcRenderer.invoke("publisher:start"),
  publisherImport: (rows) => ipcRenderer.invoke("publisher:import", rows),
  publisherOpenExtension: () => ipcRenderer.invoke("publisher:open-extension"),
  publisherRelease: (taskId, confirmed) => ipcRenderer.invoke("publisher:release", { taskId, confirmed }),
  addAccount: (name) => ipcRenderer.invoke("account:add", name),
  openLogin: (id) => ipcRenderer.invoke("account:open-login", id),
  hideLogin: (id) => ipcRenderer.invoke("account:hide-login", id),
  checkAccount: (id) => ipcRenderer.invoke("account:check", id),
  removeAccount: (id) => ipcRenderer.invoke("account:remove", id),
  setDefaultAccount: (id) => ipcRenderer.invoke("account:set-default", id),
  setQueueRunning: (running) =>
    ipcRenderer.invoke("workbench:set-queue-running", running),
  saveSettings: (settings) =>
    ipcRenderer.invoke("workbench:save-settings", settings),
  updateState: () => ipcRenderer.invoke("update:get-state"),
  seedanceState: () => ipcRenderer.invoke("seedance:get-state"),
  seedanceAddAccount: (name) =>
    ipcRenderer.invoke("seedance:account-add", name),
  seedanceOpenLogin: (id) =>
    ipcRenderer.invoke("seedance:account-open-login", id),
  seedanceSaveLogin: (id) =>
    ipcRenderer.invoke("seedance:account-save-login", id),
  seedanceRemoveAccount: (id) =>
    ipcRenderer.invoke("seedance:account-remove", id),
  seedanceSetRunning: (running) =>
    ipcRenderer.invoke("seedance:set-running", running),
  seedanceChooseDownloadDirectory: () =>
    ipcRenderer.invoke("seedance:choose-download-directory"),
  seedanceOpenDownloadDirectory: () =>
    ipcRenderer.invoke("seedance:open-download-directory"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("workbench:state", listener);
    return () => ipcRenderer.removeListener("workbench:state", listener);
  },
};

contextBridge.exposeInMainWorld("flowcutDesktop", desktopApi);
contextBridge.exposeInMainWorld("geminiWorkbench", desktopApi);
