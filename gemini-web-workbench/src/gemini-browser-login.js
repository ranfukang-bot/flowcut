const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { loginError, readFirefoxGoogleCookies, importIntoEmptyGoogleSession } = require('./gemini-login-import');
const exec = promisify(execFile);
const LOGIN_URL = 'https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com/app';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const FIREFOX_DOWNLOAD_URL = 'https://www.mozilla.org/firefox/new/';
async function findFirefox() {
  const candidates = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter(Boolean).flatMap(base => [path.join(base, 'Mozilla Firefox/firefox.exe'), path.join(base, 'Programs/Mozilla Firefox/firefox.exe')]);
  for (const file of candidates) if (fs.existsSync(file)) return { kind: 'firefox', executable: file };
  if (process.platform === 'win32') {
    for (const hive of ['HKCU', 'HKLM']) {
      try {
        const { stdout } = await exec('reg.exe', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe`, '/ve'], { windowsHide: true, timeout: 5000 });
        const file = stdout.match(/REG_SZ\s+(.+firefox\.exe)\s*$/im)?.[1]?.trim();
        if (file && fs.existsSync(file)) return { kind: 'firefox', executable: file };
      } catch { /* An absent registry entry is normal. */ }
    }
  }
  return null;
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
  const script = `$ErrorActionPreference='Stop'; $items=@(Get-CimInstance Win32_Process -Filter "name='firefox.exe'"); $ids=[Collections.Generic.HashSet[int]]::new(); foreach($item in $items){if($item.CommandLine -and $item.CommandLine.Contains($env:FLOWCUT_LOGIN_TEMP_PROFILE)){[void]$ids.Add([int]$item.ProcessId)}}; do{$added=$false;foreach($item in $items){if($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)){$added=$true}}}while($added); if($env:FLOWCUT_LOGIN_PROCESS_ACTION -eq 'close'){foreach($idValue in $ids){$p=Get-Process -Id $idValue -ErrorAction SilentlyContinue;if($p){try{[void]$p.CloseMainWindow()}catch{if(Get-Process -Id $idValue -ErrorAction SilentlyContinue){throw}}finally{$p.Dispose()}}}}; @($ids) | ConvertTo-Json -Compress`;
  const { stdout } = await exec(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15000, env: { ...process.env, FLOWCUT_LOGIN_TEMP_PROFILE: profile, FLOWCUT_LOGIN_PROCESS_ACTION: action } });
  const value = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(value) ? value : [value];
}

async function closeBrowser(profile, { processes = windowsBrowserProcesses, wait = sleep } = {}) {
  // Closing the parent can make a child exit between Get-Process and
  // CloseMainWindow. A close-command error must not discard a completed login
  // when a fresh process query proves this profile has already exited.
  let closeFailed = false;
  try { await processes(profile, 'close'); } catch { closeFailed = true; }
  for (let attempt = 0; attempt < 25; attempt++) {
    let remaining;
    try { remaining = await processes(profile); }
    catch { throw loginError('BROWSER_PROCESS_QUERY_FAILED', '无法确认临时 Firefox 是否已退出，请关闭本次登录窗口后重试'); }
    if (!remaining.length) return;
    await wait(300);
  }
  if (closeFailed) throw loginError('BROWSER_CLOSE_FAILED', '临时 Firefox 关闭失败，请关闭本次登录窗口后重试');
  throw loginError('BROWSER_STILL_RUNNING', '临时登录浏览器尚未退出，请关闭该实验窗口后重试清理');
}

class TemporaryBrowserLogin {
  constructor({ root, browser, launch = spawn, stop = closeBrowser, read = readFirefoxGoogleCookies,
    remove = profile => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }) }) {
    this.root = path.resolve(root); this.browser = browser;
    this.launch = launch; this.stop = stop; this.remove = remove; this.read = read;
    this.phase = 'new';
  }
  async start() {
    if (this.phase !== 'new') throw loginError('LOGIN_ALREADY_STARTED', '登录实验已开始');
    if (this.browser.kind !== 'firefox' || !fs.existsSync(this.browser.executable)) {
      throw loginError('FIREFOX_NOT_FOUND', '请先安装 Firefox：' + FIREFOX_DOWNLOAD_URL);
    }
    fs.mkdirSync(this.root, { recursive: true });
    this.profile = assertTempProfile(this.root, path.join(this.root, 'login-' + randomUUID()));
    fs.mkdirSync(this.profile);
    const args = ['-profile', this.profile, '-no-remote', '-new-instance', LOGIN_URL];
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
    await this.stop(this.profile);
    assertTempProfile(this.root, this.profile);
    await this.remove(this.profile);
  }
  async complete({ userConfirmed, target }) {
    if (userConfirmed !== true || this.phase !== 'waiting-for-user') throw loginError('USER_CONFIRMATION_REQUIRED', '请完成浏览器登录后主动点“我已登录”');
    this.phase = 'importing';
    try {
      if (this.launchFailed) throw loginError('BROWSER_LAUNCH_FAILED', '登录浏览器启动失败');
      await this.stop(this.profile);
      const { cookies, skippedPartitioned } = this.read(this.profile);
      // Clean the source profile before changing even the new destination.
      await this.cleanup();
      const result = await importIntoEmptyGoogleSession(target, cookies, { skippedPartitioned });
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

module.exports = { TemporaryBrowserLogin, assertTempProfile, windowsBrowserProcesses, closeBrowser, LOGIN_URL, findFirefox, FIREFOX_DOWNLOAD_URL };
