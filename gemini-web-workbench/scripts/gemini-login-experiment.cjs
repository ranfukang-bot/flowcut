// Manual, isolated experiment only. Not part of the installed account UI.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TemporaryBrowserLogin } = require('../src/gemini-browser-login');
const { Store } = require('../src/store');
const { chromeUserAgent } = require('../src/chrome-user-agent');
const { modelRuntimeSource } = require('../src/gemini-model-selection');
const { callModelPage } = require('../src/model-selection-errors');
const { DETECT_GEMINI_AUTH_SCRIPT } = require('../src/gemini-file-chooser');
const { protectGeminiNavigation, securedIpcHandle } = require('../src/desktop-security');
const { runWithActivatedGeminiWorker } = require('../src/gemini-worker-activation');
const rootArg = process.argv.find(arg => arg.startsWith('--experiment-root='));
if (!rootArg) throw Error('Explicit isolated experiment root is required');
const root = path.resolve(rootArg.slice('--experiment-root='.length));
const realProfile = path.resolve(app.getPath('appData'), 'FlowCut全自动AI视频工作台');
if (root.toLowerCase().startsWith(realProfile.toLowerCase())) throw Error('Real user profile is forbidden');
const profile = path.join(root, 'isolated-profile');
fs.mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
app.setName('FlowCut Gemini 登录隔离实验');
const file = path.join(root, 'experiment-status.json');
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { schema: 1, createdAt: new Date().toISOString(), rows: [] };
const browsers = [
  { kind: 'chrome', executable: path.join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe') },
  { kind: 'edge', executable: path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe') },
  { kind: 'firefox', executable: path.join(process.env.ProgramFiles || 'C:/Program Files', 'Mozilla Firefox/firefox.exe') },
].filter(browser => fs.existsSync(browser.executable));
let control, store, active, busy = false, quitting = false;
const save = () => { state.updatedAt = new Date().toISOString(); fs.writeFileSync(file, JSON.stringify(state, null, 2)); };
const publicState = () => ({ ...state, browsers: browsers.map(browser => browser.kind), active: active?.row.id || null, busy });
const safeCode = error => /^[A-Z_]{3,70}$/.test(error?.code || '') ? error.code : 'EXPERIMENT_CHECK_FAILED';
const getRow = id => { const row = state.rows.find(row => row.id === id); if (!row) throw Error('Experiment does not exist'); return row; };

async function check(row) {
  if (!row.importedAt) throw Error('Complete browser login first');
  const jar = session.fromPartition(row.partition, { cache: true });
  jar.setUserAgent(chromeUserAgent(process.versions.chrome), 'zh-CN');
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
    partition: row.partition, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
  } });
  protectGeminiNavigation(window.webContents, () => {}, () => {});
  const result = { checkedAt: new Date().toISOString(), elapsedMs: Date.now() - Date.parse(row.importedAt), authenticated: false, catalogRead: false };
  let timer;
  try {
    await Promise.race([window.loadURL('https://gemini.google.com/app'), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('load timeout')), 60000); })]);
    clearTimeout(timer);
    const auth = await window.webContents.executeJavaScript(DETECT_GEMINI_AUTH_SCRIPT, true);
    result.authenticated = auth === 'signed-in' && (await jar.cookies.get({ domain: '.google.com' })).some(c => ['SID', '__Secure-1PSID', '__Secure-3PSID'].includes(c.name));
    if (result.authenticated) {
      const catalog = await runWithActivatedGeminiWorker({ workerWindow: window, ownerWindow: control,
        action: () => callModelPage(window, modelRuntimeSource, 'readCatalog') });
      result.catalogRead = Array.isArray(catalog.models) && catalog.models.length > 0;
      result.modelCount = catalog.models.length;
    }
    result.passed = result.authenticated && result.catalogRead;
  } catch (error) { result.passed = false; result.code = safeCode(error); }
  finally { clearTimeout(timer); if (!window.isDestroyed()) window.destroy(); }
  row.checks.push(result); row.status = result.passed ? 'checked' : 'check-failed';
  store.updateAccount(row.id, { authenticated: result.authenticated, lastCheckedAt: result.checkedAt });
  save(); return result;
}

app.whenReady().then(async () => {
  store = new Store(app); store.state.settings.queueRunning = false; store.save();
  control = new BrowserWindow({ width: 1000, height: 780, title: 'FlowCut · 新账号登录实验',
    webPreferences: { preload: path.join(__dirname, 'gemini-login-experiment-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const handle = securedIpcHandle(ipcMain, () => ({ mainId: control.webContents.id }));
  function bindIpc() {
    handle('account:experiment-state', () => publicState());
    handle('account:experiment-action', async (_event, input) => {
      if (busy) return { ok: false, code: 'BUSY', message: '请等待本次操作完成' };
      busy = true;
      try {
        if (input.action === 'start') {
          if (active) throw Object.assign(Error('请先完成或取消当前登录'), { code: 'LOGIN_ALREADY_STARTED' });
          const browser = browsers.find(b => b.kind === input.browser); if (!browser) throw Object.assign(Error('未安装这个浏览器'), { code: 'BROWSER_NOT_FOUND' });
          const account = store.addAccount(`登录实验 · ${browser.kind} · ${new Date().toLocaleTimeString('zh-CN')}`);
          store.setAccountEnabled(account.id, false);
          const row = { id: account.id, partition: account.partition, browser: browser.kind, startedAt: new Date().toISOString(), status: 'waiting-for-user', checks: [] };
          const run = new TemporaryBrowserLogin({ root: path.join(profile, 'login-temp'), browser });
          await run.start(); state.rows.push(row); active = { row, run }; save();
        } else if (input.action === 'import') {
          if (!active) throw Error('请先打开登录窗口');
          const { row, run } = active;
          const imported = await run.complete({ userConfirmed: true, target: session.fromPartition(row.partition) });
          row.importedAt = new Date().toISOString(); row.tempRemoved = imported.tempRemoved; row.importedCount = imported.importedCount; row.status = 'imported';
          active = null; save(); await check(row);
        } else if (input.action === 'cancel') {
          if (active) { await active.run.cancel(); active.row.status = 'cancelled'; active.row.tempRemoved = true; active = null; save(); }
        } else if (input.action === 'check') await check(getRow(input.id));
        else throw Error('Unknown action');
        return { ok: true, state: publicState() };
      } catch (error) {
        if (active && active.run.phase === 'failed') { active.row.status = 'import-failed'; active.row.code = safeCode(error); active.row.tempRemoved = !fs.existsSync(active.run.profile); save(); }
        return { ok: false, code: safeCode(error), message: safeCode(error) === 'EXPERIMENT_CHECK_FAILED' ? '操作未完成，请确认浏览器已打开并登录成功。原账号未修改。' : error.message };
      } finally { busy = false; }
    });
  }
  bindIpc();
  control.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  control.webContents.on('will-navigate', event => event.preventDefault());
  control.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (busy) return;
    quitting = true;
    (async () => { if (active) await active.run.cancel(); })().then(() => app.exit(0), () => { quitting = false; });
  });
  await control.loadFile(path.join(__dirname, 'gemini-login-experiment.html'));
  save();
}).catch(() => { fs.writeFileSync(path.join(root, 'launch-failed.txt'), 'The isolated experiment could not start. No existing account was changed.'); app.exit(1); });
