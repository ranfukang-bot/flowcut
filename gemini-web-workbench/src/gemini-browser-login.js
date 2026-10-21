const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { loginError, readChromiumGoogleCookies, readFirefoxGoogleCookies, importIntoEmptyGoogleSession } = require('./gemini-login-import');
const exec = promisify(execFile);
const LOGIN_URL = 'https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com/app';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connectCdp(profile) {
  let lines;
  try { lines = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/); }
  catch { throw loginError('BROWSER_NOT_READY', '浏览器调试端口尚未就绪，请确认登录窗口还开着'); }
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[a-f0-9-]+$/i.test(lines[1])) {
    throw loginError('BROWSER_NOT_READY', '浏览器调试端口资料无效');
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}${lines[1]}`);
  let nextId = 0;
  const pending = new Map();
  const rejectPending = () => { for (const row of pending.values()) { clearTimeout(row.timer); row.reject(loginError('BROWSER_DISCONNECTED', '登录浏览器已断开')); } pending.clear(); };
  ws.addEventListener('message', event => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    const row = pending.get(message.id); if (!row) return;
    pending.delete(message.id); clearTimeout(row.timer);
    if (message.error) row.reject(loginError('BROWSER_COMMAND_FAILED', '浏览器登录资料读取失败'));
    else row.resolve(message.result);
  });
  ws.addEventListener('close', rejectPending);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(loginError('BROWSER_CONNECT_TIMEOUT', '连接登录浏览器超时')); }, 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(loginError('BROWSER_CONNECT_FAILED', '无法连接登录浏览器')); }, { once: true });
  });
  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(loginError('BROWSER_COMMAND_TIMEOUT', '读取登录浏览器超时')); }, 10000);
        pending.set(id, { resolve, reject, timer });
        try { ws.send(JSON.stringify({ id, method, params })); }
        catch { pending.delete(id); clearTimeout(timer); reject(loginError('BROWSER_DISCONNECTED', '登录浏览器已断开')); }
      });
    },
    close() { ws.close(); rejectPending(); },
  };
}

function assertTempProfile(root, profile) {
  const parent = path.resolve(root), target = path.resolve(profile);
  if (path.dirname(target) !== parent || !/^login-[a-f0-9-]{36}$/.test(path.basename(target))) throw loginError('UNSAFE_TEMP_PATH', '临时登录目录校验失败');
  for (const file of [parent, target]) {
    if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== file)) {
      throw loginError('UNSAFE_TEMP_PATH', '临时登录目录不能是链接');
    }
  }
  return target;
}

async function windowsBrowserProcesses(profile, action = 'list') {
  // Never terminate by executable name. Ownership is the random profile path,
  // then descendants of that process. The script outputs IDs only.
  const script = `$ErrorActionPreference='Stop'; $items=@(Get-CimInstance Win32_Process -Filter "name='chrome.exe' OR name='msedge.exe' OR name='firefox.exe'"); $ids=[Collections.Generic.HashSet[int]]::new(); foreach($item in $items){if($item.CommandLine -and $item.CommandLine.Contains($env:FLOWCUT_LOGIN_TEMP_PROFILE)){[void]$ids.Add([int]$item.ProcessId)}}; do{$added=$false;foreach($item in $items){if($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)){$added=$true}}}while($added); if($env:FLOWCUT_LOGIN_PROCESS_ACTION -eq 'close'){foreach($idValue in $ids){$p=Get-Process -Id $idValue -ErrorAction SilentlyContinue;if($p){[void]$p.CloseMainWindow()}}}; @($ids) | ConvertTo-Json -Compress`;
  const { stdout } = await exec(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15000, env: { ...process.env, FLOWCUT_LOGIN_TEMP_PROFILE: profile, FLOWCUT_LOGIN_PROCESS_ACTION: action } });
  const value = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(value) ? value : [value];
}

async function closeBrowser(profile, client) {
  if (client) { try { await client.call('Browser.close'); } catch { /* Closing may disconnect before replying. */ } finally { client.close(); } }
  await windowsBrowserProcesses(profile, 'close');
  for (let attempt = 0; attempt < 25; attempt++) {
    if (!(await windowsBrowserProcesses(profile)).length) return;
    await sleep(300);
  }
  throw loginError('BROWSER_STILL_RUNNING', '临时登录浏览器尚未退出，请关闭该实验窗口后重试清理');
}

class TemporaryBrowserLogin {
  constructor({ root, browser, launch = spawn, connect = connectCdp, stop = closeBrowser,
    remove = profile => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }) }) {
    this.root = path.resolve(root); this.browser = browser;
    this.launch = launch; this.connect = connect; this.stop = stop; this.remove = remove;
    this.phase = 'new'; this.client = null;
  }
  async start() {
    if (this.phase !== 'new') throw loginError('LOGIN_ALREADY_STARTED', '登录实验已开始');
    if (!['chrome', 'edge', 'firefox'].includes(this.browser.kind) || !fs.existsSync(this.browser.executable)) {
      throw loginError('BROWSER_NOT_FOUND', '请先安装实验所需的真实浏览器');
    }
    fs.mkdirSync(this.root, { recursive: true });
    this.profile = assertTempProfile(this.root, path.join(this.root, 'login-' + randomUUID()));
    fs.mkdirSync(this.profile);
    const args = this.browser.kind === 'firefox'
      ? ['-profile', this.profile, '-no-remote', '-new-instance', LOGIN_URL]
      : ['--user-data-dir=' + this.profile, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', LOGIN_URL];
    try {
      this.child = this.launch(this.browser.executable, args, { stdio: 'ignore', windowsHide: false });
      await new Promise((resolve, reject) => {
        this.child.once('spawn', resolve);
        this.child.once('error', () => reject(loginError('BROWSER_LAUNCH_FAILED', '登录浏览器启动失败')));
      });
      this.phase = 'waiting-for-user';
      return { browser: this.browser.kind, phase: this.phase };
    } catch {
      this.phase = 'failed';
      assertTempProfile(this.root, this.profile);
      await this.remove(this.profile);
      throw loginError('BROWSER_LAUNCH_FAILED', '登录浏览器启动失败，临时资料已清理');
    }
  }
  async cleanup() {
    if (!this.profile) return;
    assertTempProfile(this.root, this.profile);
    await this.stop(this.profile, this.client);
    this.client = null;
    assertTempProfile(this.root, this.profile);
    await this.remove(this.profile);
  }
  async complete({ userConfirmed, target }) {
    if (userConfirmed !== true || this.phase !== 'waiting-for-user') throw loginError('USER_CONFIRMATION_REQUIRED', '请完成浏览器登录后主动点“我已登录”');
    this.phase = 'importing';
    try {
      if (this.launchFailed) throw loginError('BROWSER_LAUNCH_FAILED', '登录浏览器启动失败');
      let cookies;
      if (this.browser.kind === 'firefox') {
        await this.stop(this.profile, null);
        cookies = readFirefoxGoogleCookies(this.profile);
      } else {
        this.client = await this.connect(this.profile);
        cookies = await readChromiumGoogleCookies(this.client);
      }
      // Clean the source profile before changing even the new destination.
      await this.cleanup();
      const result = await importIntoEmptyGoogleSession(target, cookies);
      this.phase = 'imported';
      return { ...result, browser: this.browser.kind, tempRemoved: !fs.existsSync(this.profile) };
    } catch (error) {
      this.phase = 'failed';
      try { await this.cleanup(); } catch { throw loginError('LOGIN_CLEANUP_FAILED', '实验失败且临时浏览器未完成清理，请关闭实验浏览器后点“取消并清理”'); }
      throw error?.code && !String(error.code).startsWith('ERR_') ? error : loginError('LOGIN_IMPORT_FAILED', '登录实验失败，原账号未修改');
    }
  }
  async cancel() { await this.cleanup(); this.phase = 'cancelled'; return { cancelled: true, tempRemoved: !this.profile || !fs.existsSync(this.profile) }; }
}

module.exports = { TemporaryBrowserLogin, connectCdp, assertTempProfile, windowsBrowserProcesses, LOGIN_URL };
