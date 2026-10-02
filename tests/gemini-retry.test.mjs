import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { geminiRetryPlan, LEGACY_GEMINI_RETRY_UPDATES } from '../lib/gemini-retry.ts';

test('ordinary Gemini failures use short bounded retries; rate limits retain backoff', () => {
  assert.deepEqual([1, 2, 3, 4].map(n => geminiRetryPlan(n).delayMs), [30000, 60000, 120000, null]);
  assert.deepEqual([1, 2, 3, 4].map(n => geminiRetryPlan(n, true).delayMs), [120000, 300000, 900000, null]);
  assert.equal(geminiRetryPlan(1).label, '30 秒');
  assert.equal(geminiRetryPlan(3).label, '2 分钟');
});

test('upgrade releases only legacy unclaimed retries, preserving counters and active/video work', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const [index, table] of ['tasks', 'reference_remix_tasks', 'script_pipeline_tasks'].entries()) {
      db.exec(`CREATE TABLE ${table} (id TEXT, provider TEXT, status TEXT, bridge_claimed_at TEXT, bridge_worker_id TEXT, gemini_retry_at TEXT, gemini_failures INTEGER, error TEXT)`);
      const status = ['prompt_queued', 'reference_queued', 'rewrite_queued'][index];
      const old = 'Gemini 网页临时波动，系统将在 10 分钟后自动重试（2/3）：失败';
      const insert = db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?,?,?,?,?)`);
      insert.run('legacy', 'gemini-web', status, null, null, '2099-01-01', 2, old);
      insert.run('active', 'gemini-web', status, 'claimed', 'worker', '2099-01-01', 2, old);
      insert.run('video', 'seedance-bridge', 'video_queued', null, null, '2099-01-01', 2, old);
      insert.run('new', 'gemini-web', status, null, null, '2099-01-01', 2, 'Gemini 账号限流，稍后重试');
    }
    for (const sql of LEGACY_GEMINI_RETRY_UPDATES) db.exec(sql);
    for (const table of ['tasks', 'reference_remix_tasks', 'script_pipeline_tasks']) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      assert.equal(rows[0].gemini_retry_at, null);
      assert.equal(rows[0].gemini_failures, 2);
      assert.ok(rows.slice(1).every(r => r.gemini_retry_at === '2099-01-01'));
      const before = JSON.stringify(rows);
      for (const sql of LEGACY_GEMINI_RETRY_UPDATES) db.exec(sql);
      assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()), before);
    }
  } finally { db.close(); }
});

test('real claim SELECT skips waiting tasks and places ready retries behind already queued work', () => {
  const source = readFileSync(new URL('../app/api/gemini-bridge/route.ts', import.meta.url), 'utf8');
  const sql = source.match(/`(SELECT t.id, t.product_id,[\s\S]*?LIMIT 32)`/)[1];
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE tasks (id TEXT, product_id TEXT, gemini_account_id TEXT, created_at TEXT, duration INTEGER, region TEXT, shooting_style TEXT, gemini_request_text TEXT, gem_id TEXT, gem_content_snapshot TEXT, image_keys_snapshot TEXT, provider TEXT, status TEXT, bridge_claimed_at TEXT, gemini_retry_at TEXT);
      CREATE TABLE products (id TEXT, name TEXT, features TEXT);
      CREATE TABLE gems (id TEXT, name TEXT, content TEXT);
      INSERT INTO products VALUES ('p','fixture','');`);
    const insert = db.prepare(`INSERT INTO tasks (id, product_id, created_at, gemini_retry_at, provider, status) VALUES (?, 'p', ?, ?, 'gemini-web', 'prompt_queued')`);
    insert.run('retry', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:30.000Z');
    insert.run('next', '2026-01-01T00:00:01.000Z', null);
    const claim = now => db.prepare(sql).all('2025-12-31T00:00:00.000Z', now).map(row => row.id);
    assert.deepEqual(claim('2026-01-01T00:00:12.000Z'), ['next']);
    assert.deepEqual(claim('2026-01-01T00:00:30.000Z'), ['next', 'retry']);
  } finally { db.close(); }
});
