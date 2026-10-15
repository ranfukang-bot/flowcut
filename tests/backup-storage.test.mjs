import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { summarizeBackupStorage, BACKUP_WARNING_BYTES, formatBackupBytes, backupCompletionSummary } from '../lib/backup-storage.ts';
import backup from '../gemini-web-workbench/src/backup-manager.js';

test('backup sizes include every retained ZIP and the latest media count; exact 5 GB is not over the limit', () => {
  const files = Array.from({ length: 7 }, (_, i) => ({ path: `zip-${i}`, name: `202610${i}`, bytes: i === 6 ? 2e9 : 0.5e9 }));
  const metadata = { path: 'zip-6', mediaCount: 123, createdAt: 'fixture time' };
  const exact = summarizeBackupStorage(files, metadata);
  assert.equal(exact.backupCount, 7); assert.equal(exact.totalBytes, BACKUP_WARNING_BYTES);
  assert.equal(exact.latest.zipBytes, 2e9); assert.equal(exact.latest.mediaCount, 123); assert.equal(exact.overLimit, false);
  const over = summarizeBackupStorage([...files.slice(0, 6), { ...files[6], bytes: 2e9 + 1 }], metadata);
  assert.equal(over.overLimit, true); assert.equal(over.backupCount, 7);
  assert.equal(summarizeBackupStorage(files.slice(0, 6)).overLimit, false);
  assert.deepEqual(summarizeBackupStorage([]), { backupCount: 0, totalBytes: 0, overLimit: false, latest: null });
});

test('storage inventory ignores unrelated ZIPs/directories and reports real file sizes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-storage-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const name = day => `FlowCut-backup-202610${day}T000000000Z-00000000-0000-0000-0000-000000000000.zip`;
  fs.writeFileSync(path.join(directory, name('01')), 'abc'); fs.writeFileSync(path.join(directory, name('02')), '12345');
  fs.writeFileSync(path.join(directory, 'other.zip'), 'ignored data'); fs.mkdirSync(path.join(directory, name('03')));
  const manager = new backup.BackupManager({ directory: () => directory, latest: { path: path.join(directory, name('02')), mediaCount: 4, createdAt: 'fixture' } });
  const result = await manager.status();
  assert.equal(result.backupCount, 2); assert.equal(result.totalBytes, 8); assert.equal(result.latest.zipBytes, 5); assert.equal(result.latest.mediaCount, 4);
  assert.equal(result.overLimit, false);
  assert.equal(fs.readFileSync(path.join(directory, 'other.zip'), 'utf8'), 'ignored data');
});

test('backup completion text includes ZIP size, retained total and media objects', () => {
  assert.equal(formatBackupBytes(0), '0 B'); assert.equal(formatBackupBytes(1234), '1.23 KB');
  assert.equal(formatBackupBytes(2e6), '2.00 MB'); assert.equal(formatBackupBytes(5e9), '5.00 GB');
  assert.equal(backupCompletionSummary({ zipBytes: 2e6, totalBytes: 8e6, backupCount: 7, mediaCount: 20 }), '本份 ZIP 2.00 MB，保留 7 份合计 8.00 MB，媒体对象 20 个');
});
