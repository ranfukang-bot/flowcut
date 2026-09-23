const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { utilityProcess, shell } = require('electron');

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}
function accountFolder(root, name) {
  const label = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60) || 'account';
  return path.join(root, 'videos', `${label}-${createHash('sha256').update(String(name)).digest('hex').slice(0, 10)}`);
}
class PublisherRuntime {
  constructor({ app, store, token, smoke = false, onOpen = () => {} }) {
    Object.assign(this, { app, store, token, smoke, onOpen });
    this.root = path.join(app.getPath('userData'), 'publisher');
    this.resource = app.isPackaged ? path.join(process.resourcesPath, 'publisher') : path.resolve(__dirname, '../../vendor/publisher');
    this.origin = `http://127.0.0.1:${smoke ? 18777 : 18776}`;
    this.child = null;
    this.starting = null;
  }
  prepare() {
    const config = path.join(this.root, 'config'); fs.mkdirSync(config, { recursive: true });
    const old = path.join(this.app.getPath('desktop'), 'TikTok全流程工作台', 'config');
    const settings = path.join(config, 'settings.json');
    if (!fs.existsSync(settings)) {
      const source = !this.smoke && fs.existsSync(path.join(old, 'settings.json')) ? path.join(old, 'settings.json') : path.join(this.resource, 'config/settings.example.json');
      const value = JSON.parse(fs.readFileSync(source, 'utf8'));
      value.deleteAfterPublish = false;
      if (value.notifications) value.notifications.enabled = false;
      fs.writeFileSync(settings, JSON.stringify(value, null, 2));
    }
    const accounts = path.join(config, 'accounts.json');
    if (!fs.existsSync(accounts)) {
      const source = path.join(old, 'accounts.json');
      const items = !this.smoke && fs.existsSync(source) ? JSON.parse(fs.readFileSync(source, 'utf8')) : [];
      for (const item of items) { item.videoFolder = accountFolder(this.root, item.name); fs.mkdirSync(item.videoFolder, { recursive: true }); }
      fs.writeFileSync(accounts, JSON.stringify(items, null, 2));
    }
    fs.copyFileSync(path.join(this.resource, 'config/settings.example.json'), path.join(config, 'settings.example.json'));
    const extensionSource = this.app.isPackaged ? path.join(process.resourcesPath, 'fastmoss-picker') : path.resolve(__dirname, '../integrations/fastmoss-picker');
    this.extensionDirectory = path.join(this.app.getPath('userData'), 'integrations', 'fastmoss-picker');
    copyTree(extensionSource, this.extensionDirectory);
    fs.writeFileSync(path.join(this.extensionDirectory, 'bridge-config.json'), JSON.stringify({ origin: this.origin, key: this.store.state.settings.bridgeKey }));
  }
  async request(route, init = {}) {
    const response = await fetch(this.origin + route, { ...init, headers: { 'x-flowcut-desktop-token': this.token, 'content-type': 'application/json' }, signal: AbortSignal.timeout(route.includes('/products/import') ? 15 * 60_000 : 30_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '发布管理暂时不可用');
    return data;
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.child) return { origin: this.origin, extensionDirectory: this.extensionDirectory };
    this.starting = this.launch();
    try { return await this.starting; } finally { this.starting = null; }
  }
  async launch() {
    this.prepare();
    const log = fs.createWriteStream(path.join(this.root, 'service.log'), { flags: 'a' });
    const child = utilityProcess.fork(path.join(this.resource, 'src/server.js'), [], {
      cwd: this.root, stdio: ['ignore', 'pipe', 'pipe'], serviceName: 'FlowCut Publishing',
      env: { ...process.env, PORT: new URL(this.origin).port, FLOWCUT_PUBLISHER_DATA_DIR: this.root,
        FLOWCUT_URL: this.store.state.settings.flowcutUrl, FLOWCUT_DESKTOP_TOKEN: this.token,
        FLOWCUT_CONNECTOR_KEY: this.store.state.settings.bridgeKey,
        FLOWCUT_SEEDANCE_STATE: path.join(this.app.getPath('userData'), 'seedance/workbench-state.json') },
    });
    this.child = child;
    child.stdout?.pipe(log, { end: false }); child.stderr?.pipe(log, { end: false });
    child.on('message', message => { if (message?.type === 'show-workbench') this.onOpen(); });
    child.once('exit', () => { if (this.child === child) this.child = null; log.end(); });
    for (let count = 0; count < 40; count++) {
      if (this.child !== child) throw new Error('发布管理启动失败，请检查本机日志');
      try { const status = await this.request('/api/flowcut/health'); if (status.app === 'flowcut-publisher') return { origin: this.origin, extensionDirectory: this.extensionDirectory }; } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    this.stop(); throw new Error('发布管理启动超时');
  }
  async importProducts(rows) { await this.start(); return this.request('/api/workflow/products/import', { method: 'POST', body: JSON.stringify({ rows }) }); }
  async openExtension() { await this.start(); const error = await shell.openPath(this.extensionDirectory); if (error) throw new Error(error); return true; }
  async release(taskId, confirmed) { await this.start(); return this.request('/api/flowcut/review', { method: 'POST', body: JSON.stringify({ taskId, confirmed }) }); }
  stop() { this.child?.kill(); this.child = null; }
}
module.exports = { PublisherRuntime };
