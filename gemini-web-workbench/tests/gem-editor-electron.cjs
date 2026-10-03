// Real Chromium editing in hidden windows, isolated from all user profiles.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { createGemDriver } = require('../src/saved-gems');
const report = require('./helpers/electron-test-report.cjs');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const windows = [];
  try {
    for (const prefilled of [false, true, 'truncated-once', 'remounted-once']) {
      const window = new BrowserWindow({ show: false, webPreferences: { partition: `gem-editor-test-${Date.now()}-${prefilled}` } });
      windows.push(window);
      const fixture = '<input id="gem-name-input"><div data-test-id="instruction-rich-input-field"><div class="ql-editor" contenteditable="true" style="white-space:pre-wrap"></div></div><button data-test-id="create-button">Save</button>';
      const content = ('## 测试指令\n  保留产品细节，输出文字。\n\n- 分镜 01：近景\n- 分镜 02：远景\n').repeat(130).trim();
      const loadURL = window.loadURL.bind(window);
      const driverWindow = { isDestroyed: () => window.isDestroyed(), webContents: window.webContents,
        loadURL: async () => {
          await loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fixture));
          if (prefilled) await window.webContents.executeJavaScript(`document.querySelector('input').value='旧名称'; document.querySelector('.ql-editor').innerText='旧内容';`);
          if (typeof prefilled === 'string') await window.webContents.executeJavaScript(`{
            const editor = document.querySelector('.ql-editor');
            editor.addEventListener('input', () => {
              ${prefilled === 'truncated-once' ? "editor.innerText=editor.innerText.slice(0,-3);" : "editor.replaceWith(editor.cloneNode(false));"}
            }, {once:true});
          }`);
        },
      };
      try {
        await createGemDriver(driverWindow, { timeoutMs: 1200, verifyMs: 100 }).prepare({ name: '测试 Gem', content });
        report({ prefilled, pass: true });
      } catch (error) {
        const stats = await window.webContents.executeJavaScript(`(() => { const el=document.querySelector('.ql-editor'); return {name: document.querySelector('input').value, length: el.innerText.length, prefix: el.innerText.slice(0,50)}; })()`);
        report({ prefilled, pass: false, error: error.message, expectedLength: content.length, stats });
        throw error;
      }
      const actual = await window.webContents.executeJavaScript(`document.querySelector('.ql-editor').innerText`);
      assert.equal(actual.replace(/\n+/g, '\n').trim(), content.replace(/\n+/g, '\n').trim());
      window.destroy();
    }
    app.exit(0);
  } catch (error) { report({ pass: false, error: error.stack }); app.exit(1); }
});
