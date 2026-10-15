import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BACKUP_TABLES, exportTables, restoreTables } from '../lib/backup-data.ts';
import backup from '../gemini-web-workbench/src/backup-manager.js';
import zip from '../gemini-web-workbench/src/backup-zip.js';
import { gemExportFiles } from '../lib/gem-export.ts';
import seedanceStore from '../vendor/seedance-engine/store.js';
import queueEngine from '../vendor/seedance-engine/queue-engine.js';
const { BackupManager, scheduleBackups, hash } = backup;
const { zipDirectory } = zip;

function database(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  for (const name of BACKUP_TABLES) sqlite.exec(`CREATE TABLE "${name}" (id TEXT PRIMARY KEY, name TEXT); INSERT INTO "${name}" VALUES ('${name}-1','中文数据');`);
  const prepare = sql => {
    const make = values => ({ sql, values, bind: (...args) => make(args), all: async () => ({ results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })) }) });
    return make([]);
  };
  const db = { prepare, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const result = statements.map(statement => ({ results: sqlite.prepare(statement.sql).all(...statement.values).map(row => ({ ...row })) })); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return { sqlite, db };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-backup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, name, data) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; }

test('table export/restore includes all business rows and rolls back a constraint failure', async t => {
  const { sqlite, db } = database(t), original = await exportTables(db);
  for (const name of BACKUP_TABLES) sqlite.exec(`DELETE FROM "${name}"`);
  const counts = await restoreTables(db, original);
  assert.equal(Object.keys(counts).length, 14); assert.ok(Object.values(counts).every(count => count === 1));
  assert.deepEqual(await exportTables(db), original);
  const broken = structuredClone(original); broken.tasks.push(broken.tasks[0]);
  await assert.rejects(restoreTables(db, broken), /UNIQUE/);
  assert.deepEqual(await exportTables(db), original);
  await assert.rejects(restoreTables(db, { ...original, unexpected: [] }), /未知表/);
  const wrong = structuredClone(original); wrong.gems[0]['id";DROP TABLE gems'] = 'bad';
  await assert.rejects(restoreTables(db, wrong), /不兼容字段/);
});

test('real ZIP round trip restores table counts, media SHA256, settings; excludes Partitions and makes pre-restore backup', { skip: process.platform !== 'win32' }, async t => {
  const root = fixture(t), userData = path.join(root, 'profile'), directory = path.join(root, 'backups');
  write(userData, 'workbench-state.json', JSON.stringify({ settings: { bridgeKey: 'fixture-key', credentialsMasterKey: 'fixture-secret', flowcutUrl: 'http://127.0.0.1:4173', queueRunning: true }, accounts: [] }));
  write(userData, 'seedance/workbench-state.json', JSON.stringify({ settings: { running: true }, accounts: [], tasks: [{ id: 'queued', status: 'queued' }, { id: 'done', status: 'success' }, { id: 'transient-failed', status: 'failed', imageItems: [{ uploadedUrl: '' }], errorMessage: 'fetch failed' }] }));
  write(userData, 'seedance/submitted-tasks.jsonl', '{"taskId":"old-task"}\n');
  write(userData, 'publisher/config/settings.json', '{"enabled":false}');
  write(userData, 'publisher/config/accounts.json', '[]');
  write(userData, 'Partitions/fixture/Network/Cookies', 'must-not-export');
  const { sqlite, db } = database(t);
  const media = new Map([['products/图.png', Buffer.from('synthetic image bytes')]]), expectedHash = createHash('sha256').update(media.values().next().value).digest('hex');
  const site = {
    exportSnapshot: async () => ({ tables: await exportTables(db), media: [...media.keys()].map(key => ({ key, httpMetadata: { contentType: 'image/png' } })) }),
    downloadMedia: async (key, file) => { write(path.dirname(file), path.basename(file), media.get(key)); },
    uploadMedia: async (item, file) => media.set(item.key, fs.readFileSync(file)),
    restoreTables: tables => restoreTables(db, tables),
  };
  let restoreCalls = 0;
  const manager = new BackupManager({ userData, directory: () => directory, version: '1.4.37', site, beforeRestore: async () => { restoreCalls++; } });
  const saved = await manager.backup();
  const inspect = path.join(root, 'inspect'); await zipDirectory(saved.path, inspect, { extract: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(inspect, 'manifest.json')));
  assert.equal(manifest.version, '1.4.37'); assert.equal(manifest.tables.products, 1);
  assert.ok(!(await manager.files(inspect)).some(file => /Partitions/i.test(file)));
  assert.equal(await hash(path.join(inspect, manifest.media[0].path)), expectedHash);
  // Remove only this test's temporary data, then restore through the same API.
  fs.rmSync(userData, { recursive: true, force: true }); fs.mkdirSync(userData);
  write(userData, 'workbench-state.json', JSON.stringify({ settings: { bridgeKey: 'replacement', flowcutUrl: 'http://127.0.0.1:4173' }, accounts: [] }));
  write(userData, 'seedance/submitted-tasks.jsonl', '{"taskId":"newer-task"}\n' + JSON.stringify({ type: 'resolved', intentId: 'later-intent', localTaskId: 'transient-failed', outcome: 'rate-limited', result: { status: 'queued', errorMessage: 'fetch failed' } }) + '\n' + JSON.stringify({ type: 'resolved', intentId: 'recovered-intent', localTaskId: 'recovered-after-backup', snapshot: { id: 'recovered-after-backup', status: 'queued' }, outcome: 'rate-limited', result: { status: 'queued' } }) + '\n');
  for (const name of BACKUP_TABLES) sqlite.exec(`DELETE FROM "${name}"`); media.clear();
  const restored = await manager.restore(saved.path);
  assert.equal(restoreCalls, 1); assert.ok(fs.existsSync(restored.previousBackup));
  assert.ok(Object.values(restored.tables).every(count => count === 1));
  assert.ok(Object.values(await exportTables(db)).every(rows => rows.length === 1));
  assert.equal(createHash('sha256').update(media.get('products/图.png')).digest('hex'), expectedHash);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'workbench-state.json'))).settings.queueRunning, false);
  const tasks = JSON.parse(fs.readFileSync(path.join(userData, 'seedance/workbench-state.json'))).tasks;
  assert.equal(tasks[0].status, 'submit_unconfirmed'); assert.equal(tasks[1].status, 'success');
  assert.equal(tasks[2].status, 'submit_unconfirmed', 'an old failure may have been retried after the backup');
  const journal = fs.readFileSync(path.join(userData, 'seedance/submitted-tasks.jsonl'), 'utf8');
  assert.ok(journal.includes('old-task') && journal.includes('newer-task'));
  const reopened = new seedanceStore.WorkbenchStore(path.join(userData, 'seedance'));
  const engine = new queueEngine.QueueEngine(reopened, {}, () => {});
  assert.equal(engine.recoverInterruptedTasks(), 0, 'restart must not recover a historical failure into the upload queue');
  assert.equal(reopened.getTask('transient-failed').status, 'submit_unconfirmed');
  assert.equal(reopened.getTask('recovered-after-backup').status, 'submit_unconfirmed', 'journal-recovered rows also require historical inspection');
  const secondRestart = new seedanceStore.WorkbenchStore(path.join(userData, 'seedance'));
  assert.equal(secondRestart.getTask('transient-failed').status, 'submit_unconfirmed', 'hold survives another restart after journal pruning');
  // Tampering must fail before pre-backup, upload or database writes.
  fs.appendFileSync(path.join(inspect, 'tables/gems.json'), ' ');
  const damaged = path.join(root, 'damaged.zip'); await zipDirectory(inspect, damaged);
  await assert.rejects(manager.restore(damaged), /校验失败/); assert.equal(restoreCalls, 1);
});

test('retention removes only owned backups beyond seven, never unrelated ZIPs or directories', async t => {
  const root = fixture(t), manager = new BackupManager({});
  for (let i = 0; i < 10; i++) write(root, `FlowCut-backup-202610${String(i + 1).padStart(2, '0')}T000000000Z-00000000-0000-0000-0000-000000000000.zip`, 'fixture');
  write(root, 'family.zip', 'keep'); write(root, 'FlowCut-backup-invalid.zip', 'keep');
  fs.mkdirSync(path.join(root, 'FlowCut-backup-20260901T000000000Z-00000000-0000-0000-0000-000000000000.zip'));
  await manager.retain(root);
  assert.equal(fs.readdirSync(root).filter(name => backup.BACKUP_NAME.test(name) && fs.statSync(path.join(root, name)).isFile()).length, 7);
  assert.ok(fs.existsSync(path.join(root, 'family.zip'))); assert.ok(fs.existsSync(path.join(root, 'FlowCut-backup-invalid.zip')));
});

test('scheduler starts at five minutes, repeats after 24h and stops; failures still schedule next run', async () => {
  let callback, delay, calls = 0, errors = 0, canceled = false;
  const stop = scheduleBackups(async () => { calls++; throw new Error('fixture'); }, { schedule: (fn, ms) => { callback = fn; delay = ms; return 1; }, cancel: () => { canceled = true; }, onError: () => errors++ });
  assert.equal(delay, 300000); await callback(); assert.equal(calls, 1); assert.equal(errors, 1); assert.equal(delay, 86400000);
  stop(); assert.ok(canceled);
});

test('Gem export preserves exact instructions in JSON and each safely named text file', () => {
  const gems = [{ id: 'a', name: 'A/B', content: '原样指令\n不要变更' }, { id: 'b', name: 'A:B', content: 'second instruction' }];
  const files = gemExportFiles(gems);
  assert.deepEqual(JSON.parse(files[0].content).gems, gems);
  assert.equal(files[1].content, gems[0].content); assert.equal(files[2].content, gems[1].content);
  assert.notEqual(files[1].name, files[2].name); assert.ok(files.every(file => !file.name.includes('/')));
});

test('restore requires two affirmative confirmations; either cancel aborts', async () => {
  let calls = 0;
  assert.equal(await backup.confirmRestore(async () => { calls++; return true; }), true); assert.equal(calls, 2);
  calls = 0; assert.equal(await backup.confirmRestore(async () => { calls++; return false; }), false); assert.equal(calls, 1);
  calls = 0; assert.equal(await backup.confirmRestore(async () => { calls++; return calls === 1; }), false); assert.equal(calls, 2);
});
