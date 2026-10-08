const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { observeGeminiUploads } = require('../src/gemini-upload-network');
const root = process.env.FLOWCUT_BACKGROUND_SMOKE_ROOT;
if (!root) throw new Error('An isolated smoke directory is required');
app.setPath('userData', path.join(root, 'profile'));
app.whenReady().then(async () => {
  let window, monitor;
  try {
    window = new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});
    await window.loadURL('data:text/html,<body><p id="answer"></p></body>');
    monitor = await observeGeminiUploads(window.webContents);
    window.setOpacity(0); window.showInactive(); window.hide();
    const result = await window.webContents.executeJavaScript(`new Promise(resolve=>{
      let frames=0;
      function tick(){if(++frames<5)requestAnimationFrame(tick);else{
        document.querySelector('#answer').innerText='completed';
        resolve({frames,visible:document.visibilityState,focused:document.hasFocus(),text:document.querySelector('#answer').innerText});
      }}
      requestAnimationFrame(tick);
      setTimeout(()=>resolve({frames,error:'background frames stopped'}),5000);
    })`);
    fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result));
    if (result.frames < 5 || result.text !== 'completed' || result.visible !== 'visible' || !result.focused) throw new Error('Background rendering failed');
    await monitor.stop(); window.destroy(); app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(root,'error.txt'),String(error.stack || error));
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(1);
  }
});
