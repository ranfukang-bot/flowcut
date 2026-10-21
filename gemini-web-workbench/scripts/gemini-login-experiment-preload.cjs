const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('loginExperiment', {
  state: () => ipcRenderer.invoke('account:experiment-state'),
  act: input => ipcRenderer.invoke('account:experiment-action', input),
});
