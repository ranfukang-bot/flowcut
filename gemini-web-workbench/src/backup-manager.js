const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { zipDirectory, readZipMetadata } = require('./backup-zip');
const { writeTextDurable } = require('../../vendor/seedance-engine/durable-json');
const { requireLocalSiteUrl } = require('./desktop-security');
const { summarizeBackupStorage } = require('../../lib/backup-storage.ts');
const LOCAL_FILES = ['workbench-state.json', 'seedance/workbench-state.json', 'seedance/submitted-tasks.jsonl', 'seedance/submitted-tasks-unmatched.jsonl', 'publisher/config/settings.json', 'publisher/config/accounts.json'];
const BACKUP_NAME = /^FlowCut-backup-\d{8}T\d{9}Z-[a-f0-9-]{36}\.zip$/;
const hash = file => new Promise((resolve, reject) => {
  const digest = createHash('sha256'), stream = fs.createReadStream(file);
  stream.on('error', reject); stream.on('data', chunk => digest.update(chunk)); stream.on('end', () => resolve(digest.digest('hex')));
});
function safeRelative(name) {
  return typeof name === 'string' && !name.includes('\\') && !name.includes(':') && !name.startsWith('/') && name.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== 'partitions');
}
function ownedLocal(name) { return LOCAL_FILES.includes(name); }
function regularFile(root, relative) {
  let current = root;
  if (fs.lstatSync(current).isSymbolicLink()) throw new Error('备份数据目录不能为链接');
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) return null;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('备份不读取链接文件');
  }
  return fs.statSync(current).isFile() ? current : null;
}
async function write(file, data) { await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file, data); }

class BackupManager {
  constructor(options) { Object.assign(this, { beforeSnapshot: async () => {}, beforeRestore: async () => {}, onComplete: async () => {}, latest: null, now: () => new Date(), ...options }); this.busy = false; }
  async exclusive(action) {
    if (this.busy) throw new Error('正在备份或恢复，请稍后重试');
    this.busy = true; try { return await action(); } finally { this.busy = false; if (this.cachedStatus) this.cachedStatus.busy = false; }
  }
  backup(reason = 'manual') { return this.exclusive(() => this.createBackup(reason)); }
  async createBackup(reason) {
    await this.beforeSnapshot();
    const stage = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flowcut-backup-'));
    let partial;
    try {
      const snapshot = await this.site.exportSnapshot();
      const manifest = { format: 'FlowCutBackup', formatVersion: 1, version: this.version, createdAt: this.now().toISOString(), reason, tables: {}, media: [], files: {} };
      for (const [name, rows] of Object.entries(snapshot.tables)) {
        if (!/^[a-z_]+$/.test(name) || !Array.isArray(rows)) throw new Error('业务表导出格式错误');
        await write(path.join(stage, 'tables', `${name}.json`), JSON.stringify(rows));
        manifest.tables[name] = rows.length;
      }
      for (const [index, media] of snapshot.media.entries()) {
        const relative = `media/${index}.bin`;
        await this.site.downloadMedia(media.key, path.join(stage, relative));
        manifest.media.push({ ...media, path: relative });
      }
      for (const relative of LOCAL_FILES) {
        const source = regularFile(this.userData, relative);
        if (source) await write(path.join(stage, 'local', relative), await fs.promises.readFile(source));
      }
      for (const relative of await this.files(stage)) manifest.files[relative] = { sha256: await hash(path.join(stage, relative)), bytes: (await fs.promises.stat(path.join(stage, relative))).size };
      await write(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
      const directory = this.directory(); await fs.promises.mkdir(directory, { recursive: true });
      const file = `FlowCut-backup-${manifest.createdAt.replace(/[-:.]/g, '')}-${randomUUID()}.zip`;
      const target = path.join(directory, file); partial = path.join(directory, `.flowcut-partial-${randomUUID()}.zip`);
      await zipDirectory(stage, partial); await fs.promises.rename(partial, target); partial = null;
      await this.retain(directory);
      this.latest = { path: target, createdAt: manifest.createdAt, mediaCount: manifest.media.length };
      const status = await this.status();
      const result = { ...this.latest, tables: manifest.tables, zipBytes: (await fs.promises.stat(target)).size, totalBytes: status.totalBytes, backupCount: status.backupCount, overLimit: status.overLimit };
      await this.onComplete(result, reason);
      return result;
    } finally { if (partial) await fs.promises.rm(partial, { force: true }); await fs.promises.rm(stage, { recursive: true, force: true }); }
  }
  async files(root, prefix = '') {
    const output = [];
    for (const entry of await fs.promises.readdir(path.join(root, prefix), { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safeRelative(relative) || entry.isSymbolicLink()) throw new Error('备份包含无效路径');
      if (entry.isDirectory()) output.push(...await this.files(root, relative));
      else if (entry.isFile()) output.push(relative);
      else throw new Error('备份包含特殊文件');
    }
    return output;
  }
  async retain(directory) {
    const own = (await fs.promises.readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && BACKUP_NAME.test(entry.name)).map(entry => entry.name).sort().reverse();
    for (const name of own.slice(7)) await fs.promises.unlink(path.join(directory, name));
  }
  async status() {
    const directory = this.directory();
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !BACKUP_NAME.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      try {
        const stat = await fs.promises.lstat(file);
        if (stat.isFile() && !stat.isSymbolicLink()) files.push({ path: file, name: entry.name, bytes: stat.size });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let summary = summarizeBackupStorage(files, this.latest);
    // Older backups already contain media counts in their manifest. Read just
    // that entry once; never extract media merely to display occupied space.
    if (summary.latest && summary.latest.mediaCount === null && process.platform === 'win32') {
      try {
        this.latest = { path: summary.latest.path, ...await readZipMetadata(summary.latest.path) };
        summary = summarizeBackupStorage(files, this.latest);
      } catch { /* Sizes are still known; invalid/foreign archives have no media count. */ }
    }
    this.cachedStatus = { directory, busy: this.busy, ...summary };
    return this.cachedStatus;
  }
  restore(zip) { return this.exclusive(() => this.restoreBackup(zip)); }
  async restoreBackup(zip) {
    const stage = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flowcut-restore-'));
    try {
      await zipDirectory(zip, stage, { extract: true });
      const manifest = JSON.parse(await fs.promises.readFile(path.join(stage, 'manifest.json'), 'utf8'));
      if (manifest.format !== 'FlowCutBackup' || manifest.formatVersion !== 1 || !manifest.files || !manifest.tables || !Array.isArray(manifest.media)) throw new Error('不是受支持的 FlowCut 备份');
      const actual = (await this.files(stage)).filter(name => name !== 'manifest.json').sort();
      const expected = Object.keys(manifest.files).sort();
      if (actual.join('\n') !== expected.join('\n')) throw new Error('备份文件清单不一致');
      const tables = {};
      for (const relative of expected) {
        if (!safeRelative(relative) || !(relative.startsWith('local/') && ownedLocal(relative.slice(6))) && !/^tables\/[a-z_]+\.json$/.test(relative) && !/^media\/\d+\.bin$/.test(relative)) throw new Error('备份包含未授权文件');
        const file = path.join(stage, relative), info = manifest.files[relative];
        if ((await fs.promises.stat(file)).size !== info.bytes || await hash(file) !== info.sha256) throw new Error(`备份文件校验失败：${relative}`);
      }
      for (const [name, count] of Object.entries(manifest.tables)) {
        if (!/^[a-z_]+$/.test(name)) throw new Error('业务表名称无效');
        const rows = JSON.parse(await fs.promises.readFile(path.join(stage, 'tables', `${name}.json`), 'utf8'));
        if (!Array.isArray(rows) || rows.length !== count) throw new Error(`备份表行数不一致：${name}`);
        tables[name] = rows;
      }
      const local = {};
      for (const relative of LOCAL_FILES) if (manifest.files[`local/${relative}`]) {
        const text = await fs.promises.readFile(path.join(stage, 'local', relative), 'utf8');
        local[relative] = relative.endsWith('.json') ? JSON.parse(text.replace(/^\uFEFF/, '')) : text;
      }
      if (!local['workbench-state.json']?.settings?.bridgeKey || !Array.isArray(local['workbench-state.json'].accounts)) throw new Error('备份主配置不完整');
      requireLocalSiteUrl(local['workbench-state.json'].settings.flowcutUrl);
      const seedance = local['seedance/workbench-state.json'];
      if (seedance && (!seedance.settings || !Array.isArray(seedance.tasks) || !Array.isArray(seedance.accounts))) throw new Error('备份 Seedance 配置不完整');
      if (local['publisher/config/accounts.json'] && !Array.isArray(local['publisher/config/accounts.json'])) throw new Error('备份发布账号格式错误');
      for (const media of manifest.media) if (!/^media\/\d+\.bin$/.test(media.path) || !manifest.files[media.path] || typeof media.key !== 'string') throw new Error('备份媒体清单无效');
      await this.beforeRestore();
      const previous = await this.createBackup('before-restore');
      for (const media of manifest.media) await this.site.uploadMedia(media, path.join(stage, media.path));
      // A historical queue entry may have been submitted since this snapshot.
      // Require explicit inspection rather than automatically replaying it.
      for (const name of ['tasks', 'reference_remix_tasks', 'script_pipeline_tasks']) for (const row of tables[name] || []) {
        if (typeof row.status === 'string' && !['video_ready', 'scheduled', 'completed', 'success', 'failed'].includes(row.status)) {
          row.status = 'failed';
          if ('error' in row) row.error = '从历史备份恢复，请核对平台历史后再手动重新生成；未自动重发。';
        }
      }
      await this.site.restoreTables(tables);
      for (const [relative, value] of Object.entries(local)) {
        const destination = path.join(this.userData, relative);
        if (relative.endsWith('.jsonl')) {
          // Never discard submissions made after the older backup was created.
          const current = regularFile(this.userData, relative);
          const lines = [...new Set([...String(value).split(/\r?\n/), ...(current ? fs.readFileSync(current, 'utf8').split(/\r?\n/) : [])].filter(Boolean))];
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          writeTextDurable(destination, lines.join('\n') + '\n');
        } else {
          if (relative === 'workbench-state.json') {
            value.settings.queueRunning = false;
            value.settings.lastBackup = { path: previous.path, createdAt: previous.createdAt, mediaCount: previous.mediaCount };
          }
          if (relative === 'seedance/workbench-state.json') {
            value.settings.running = false;
            value.restoringBackup = true;
            for (const task of value.tasks || []) if (task.status !== 'success') {
              task.backupRestoreHold = true;
              task.status = 'submit_unconfirmed'; task.nextRetryAt = 0;
              task.errorMessage = '从历史备份恢复；无法确认备份之后的平台提交情况。请先核对平台历史，禁止自动重发。';
            }
          }
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          writeTextDurable(destination, JSON.stringify(value), { backup: 'mirror' });
        }
      }
      return { restartRequired: true, previousBackup: previous.path, tables: manifest.tables };
    } finally { await fs.promises.rm(stage, { recursive: true, force: true }); }
  }
}

function scheduleBackups(run, { schedule = setTimeout, cancel = clearTimeout, onError = () => {} } = {}) {
  let stopped = false, timer;
  const next = delay => { timer = schedule(async () => { try { await run(); } catch (error) { onError(error); } finally { if (!stopped) next(86400000); } }, delay); timer?.unref?.(); };
  next(300000);
  return () => { stopped = true; cancel(timer); };
}
async function confirmRestore(confirm) {
  for (const message of ['恢复将覆盖商品、Gem、任务和本机配置，并重启程序。当前登录 Cookie 保留。是否继续？', '再次确认恢复：覆盖前会先备份当前数据；历史未完成任务将暂停自动执行，需要核对平台历史。']) if (!await confirm(message)) return false;
  return true;
}
module.exports = { BackupManager, LOCAL_FILES, BACKUP_NAME, safeRelative, scheduleBackups, confirmRestore, hash };
