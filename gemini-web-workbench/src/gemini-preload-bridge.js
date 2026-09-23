const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flowcutGeminiNative", {
  uploadFiles: (filePaths) =>
    ipcRenderer.invoke("gemini:upload-files-via-chooser", filePaths),
  replaceEditorText: (text) =>
    ipcRenderer.invoke("gemini:replace-editor-text", text),
  sendKey: (key) => ipcRenderer.invoke("gemini:send-key", key),
  reportDiagnostic: (payload) =>
    ipcRenderer.send("gemini:job-diagnostic", payload),
  reportStage: (payload) => ipcRenderer.send("gemini:job-stage", payload),
});
