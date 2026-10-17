import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { listTasks, countTasks, taskDetail } from '../lib/task-list.ts';

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE products(id TEXT PRIMARY KEY,name TEXT,external_id TEXT,image_key TEXT);
    CREATE TABLE gems(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE product_images(id TEXT,product_id TEXT,object_key TEXT,sort_order INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,product_id TEXT,gem_id TEXT,title TEXT,status TEXT,progress INTEGER,provider TEXT,
      duration INTEGER,region TEXT,shooting_style TEXT,provider_job_id TEXT,provider_status_url TEXT,output_url TEXT,error TEXT,
      gemini_account_id TEXT,tiktok_account_name TEXT,archive_directory TEXT,download_path TEXT,review_status TEXT,approved_path TEXT,
      segment_progress TEXT,download_error TEXT,created_at TEXT,updated_at TEXT,prompt TEXT,image_keys_snapshot TEXT,
      product_external_id_snapshot TEXT,gem_content_snapshot TEXT,gemini_request_text TEXT,gemini_model_info TEXT,
      task_role TEXT,batch_parent_id TEXT,batch_index INTEGER,batch_round INTEGER,batch_size INTEGER,merged_into_task_id TEXT,
      prompt_note TEXT,variant_gem_snapshot TEXT);
    INSERT INTO gems VALUES('gem','测试 Gem');`);
  const insertProduct = sqlite.prepare('INSERT INTO products VALUES(?,?,?,NULL)');
  const insertTask = sqlite.prepare(`INSERT INTO tasks(id,product_id,gem_id,title,status,provider,tiktok_account_name,review_status,created_at,updated_at,prompt,gem_content_snapshot,gemini_request_text,image_keys_snapshot)
    VALUES(?,?,'gem',?,?,'gemini-web',?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 200; i++) {
    const suffix = String(i).padStart(3, '0'), at = new Date(Date.UTC(2026, 9, 15, 0, 0, i)).toISOString();
    const number = i === 50 ? 150 : i === 150 ? 50 : i;
    insertProduct.run('product-' + suffix, '商品' + number, '1735000000000000' + String(number).padStart(3, '0'));
    insertTask.run('task-' + suffix, 'product-' + suffix, '任务' + i, i < 30 ? 'video_ready' : i < 50 ? 'failed' : i < 75 ? 'scheduled' : 'prompt_queued',
      '归档账号' + (i % 3), i >= 50 && i < 75 ? 'approved' : 'pending', at, at, 'p'.repeat(10000), 'g'.repeat(50000), 'request'.repeat(1000), JSON.stringify(['media/' + suffix + '.png']));
  }
  const db = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    const bound = args => ({
      all: async () => ({ results: statement.all(...args).map(row => ({ ...row })) }),
      first: async () => { const row = statement.get(...args); return row ? { ...row } : null; },
    });
    return { ...bound([]), bind: (...args) => bound(args) };
  } };
  return { db, sqlite };
}

test('counts include all 200 tasks, including 30 old review tasks and 20 old failures', async t => {
  const { db } = fixture(t);
  assert.deepEqual(await countTasks(db), { total: 200, active: 125, review: 30, completed: 25, attention: 20 });
  const recent = await listTasks(db, { limit: 60 });
  assert.equal(recent.tasks.length, 60);
  assert.ok(recent.tasks.every(row => row.status === 'prompt_queued'), 'old pending review/failure rows are outside the latest 60');
});
test('review cursor pagination retrieves every old review task exactly once', async t => {
  const { db } = fixture(t);
  let cursor, rows = [];
  do {
    const page = await listTasks(db, { status: '待检查', limit: 7, cursor });
    rows.push(...page.tasks); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(rows.length, 30); assert.equal(new Set(rows.map(row => row.id)).size, 30);
  assert.equal(rows[0].id, 'task-029'); assert.equal(rows.at(-1).id, 'task-000');
  assert.equal((await listTasks(db, { status: 'attention' })).tasks.length, 20);
});
test('server search finds product 150 outside the latest page and treats wildcards literally', async t => {
  const { db } = fixture(t);
  const result = await listTasks(db, { q: '1735000000000000150', limit: 1 });
  assert.deepEqual(result.tasks.map(row => row.id), ['task-050']);
  assert.equal((await listTasks(db, { limit: 60 })).tasks.some(row => row.id === 'task-050'), false);
  assert.deepEqual((await listTasks(db, { q: '商品150' })).tasks.map(row => row.id), ['task-050']);
  const accountRows = await listTasks(db, { q: '归档账号1' });
  assert.equal(accountRows.tasks.length, 50); assert.ok(accountRows.tasks.every(row => row.tiktok_account_name === '归档账号1'));
  assert.deepEqual((await listTasks(db, { q: '%' })).tasks, []);
});
test('workspace list projection omits long fields while id detail retains exact saved inputs', async t => {
  const { db } = fixture(t);
  const workspace = { tasks: (await listTasks(db, { limit: 60 })).tasks };
  for (const row of workspace.tasks) {
    for (const field of ['gem_content_snapshot', 'gemini_request_text', 'prompt', 'image_keys_snapshot']) assert.equal(Object.hasOwn(row, field), false);
    assert.equal(row.has_prompt, 1); assert.ok(row.product_image_key.startsWith('media/'));
  }
  const detail = await taskDetail(db, 'task-150');
  assert.equal(detail.gem_content_snapshot, 'g'.repeat(50000));
  assert.equal(detail.gemini_request_text, 'request'.repeat(1000)); assert.equal(detail.prompt, 'p'.repeat(10000));
  assert.equal(await taskDetail(db, 'missing'), null);
});
test('equal creation timestamps have deterministic id order without cursor gaps or repeats', async t => {
  const { db, sqlite } = fixture(t);
  sqlite.exec("UPDATE tasks SET created_at='2026-10-15T00:04:00.000Z' WHERE id BETWEEN 'task-180' AND 'task-195'");
  let cursor, ids = [];
  do { const page = await listTasks(db, { limit: 9, cursor }); ids.push(...page.tasks.map(row => row.id)); cursor = page.nextCursor; } while (cursor);
  assert.equal(ids.length, 200); assert.equal(new Set(ids).size, 200);
  assert.deepEqual(ids.slice(0, 16), Array.from({ length: 16 }, (_, index) => 'task-' + (195 - index)));
  await assert.rejects(listTasks(db, { cursor: 'not-a-valid-cursor' }), /分页游标无效/);
  await assert.rejects(listTasks(db, { status: 'unknown' }), /筛选状态/);
});
test('a split group is listed once with its clips; counts treat clips as videos, never the container or merged clips', async t => {
  const { db, sqlite } = fixture(t);
  const at = '2026-10-16T00:00:00.000Z';
  const add = sqlite.prepare(`INSERT INTO tasks(id,product_id,gem_id,title,status,provider,tiktok_account_name,review_status,created_at,updated_at,
    task_role,batch_parent_id,batch_index,batch_round,batch_size,merged_into_task_id,download_path) VALUES(?,'product-000','gem',?,?,'gemini-web','归档账号0',?,?,?,?,?,?,?,?,?,?)`);
  add.run('group', '分条任务', 'split_done', 'pending', at, at, 'group', null, null, 1, 3, null, null);
  add.run('group-r1-1', '第 1/3 条', 'video_ready', 'merged', at, at, 'clip', 'group', 1, 1, 3, 'joined', 'a.mp4');
  add.run('group-r1-2', '第 2/3 条', 'video_ready', 'merged', at, at, 'clip', 'group', 2, 1, 3, 'joined', 'b.mp4');
  add.run('group-r1-3', '第 3/3 条', 'video_generating', 'pending', at, at, 'clip', 'group', 3, 1, 3, null, null);
  add.run('joined', '拼接成片', 'video_ready', 'pending', at, at, 'concat', 'group', null, null, 2, null, 'joined.mp4');
  const before = { total: 200, active: 125, review: 30, completed: 25, attention: 20 };
  assert.deepEqual(await countTasks(db), { ...before, total: 204, active: 126, review: 31 });

  const page = await listTasks(db, { limit: 1 });
  assert.deepEqual(page.tasks.map(row => row.id), ['group']);
  assert.deepEqual(page.tasks[0].children.map(row => row.id), ['group-r1-1', 'group-r1-2', 'group-r1-3', 'joined'], 'clips in batch order, joined video last');
  for (const [status, expected] of [['review', true], ['active', true], ['attention', false], ['completed', false]]) {
    assert.equal((await listTasks(db, { status })).tasks.some(row => row.id === 'group'), expected, status);
  }
  assert.equal((await listTasks(db, { limit: 200 })).tasks.some(row => row.batch_parent_id), false, 'clips never appear as separate rows');
  assert.deepEqual((await taskDetail(db, 'group')).children.map(row => row.id).at(-1), 'joined');
  sqlite.prepare("UPDATE tasks SET variant_gem_snapshot='变体设定' WHERE id='group'").run();
  assert.equal((await taskDetail(db, 'group')).variant_mode, 1, 'the detail view knows a two-round task');
  assert.equal((await listTasks(db, { limit: 1 })).tasks[0].variant_mode, 1);
});
