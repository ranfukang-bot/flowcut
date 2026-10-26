const test = require('node:test'), assert = require('node:assert/strict');
const { siteFixture } = require('./helpers/site-routes.cjs');
const { restorableTables } = require('../src/backup-manager');
const text = '完整的商品提示词：' + '自然光下真实展示商品细节、使用动作和口播，镜头连续且保持同一商品外观。'.repeat(15);

async function fixture(t, options) {
  const f = await siteFixture(t, options), at = new Date().toISOString();
  f.sqlite.prepare("INSERT INTO gems(id,name,content,created_at,updated_at) VALUES('gem','测试 Gem','冻结的 Gem 指令',?,?)").run(at, at);
  f.create = async (extra = {}, names = ['1735360337668113921.png']) => {
    const form = new FormData();
    Object.entries({ gemId: 'gem', region: '印尼', description: 'iPhone实拍质感', count: '5', externalId: '1735360337668113921', productName: '测试商品', ...extra }).forEach(([k, v]) => form.set(k, String(v)));
    names.forEach(name => form.append('images', new File([new Uint8Array([1, 2, 3])], name, { type: name.endsWith('.txt') ? 'text/plain' : 'image/png' })));
    const response = await (await f.route('prompt-batches')).POST(new Request('http://fixture/api/prompt-batches', { method: 'POST', body: form }));
    return { status: response.status, body: await response.json() };
  };
  f.items = id => f.rows('SELECT * FROM tasks WHERE prompt_batch_id=? ORDER BY batch_index', id);
  f.claim = async (worker = 'desk') => (await f.call('gemini-bridge', 'GET', { query: `?workerId=${worker}&capacity=1&accountIds=acc` })).body.jobs;
  f.result = (id, worker = 'desk', prompt = text) => f.call('gemini-bridge', 'POST', { body: { action: 'result', kind: 'standard', taskId: id, workerId: worker, prompt, codeBlocks: [text, text + '二', text + '三'], codeBlockHint: true } });
  f.action = (action, id) => f.call('prompt-batches', 'PATCH', { body: { action, id } });
  return f;
}

test('prompt batches create five frozen standard items, no TK account, and reuse products by ID', async t => {
  const f = await fixture(t), c = await f.create();
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const items = f.items(c.body.id); assert.equal(items.length, 5);
  for (const [i, row] of items.entries()) {
    assert.equal(row.title, `测试商品 · 第 ${i + 1}/5 条`);
    assert.equal(row.task_role, 'prompt_item'); assert.equal(row.status, 'prompt_queued'); assert.equal(row.auto_queue, 0);
    assert.equal(row.provider, 'gemini-web'); assert.equal(row.duration, 30); assert.equal(row.gemini_account_id, null);
    assert.equal(row.tiktok_account_name, ''); assert.equal(row.archive_directory, '');
    assert.equal(row.product_external_id_snapshot, '1735360337668113921'); assert.equal(row.gem_content_snapshot, '冻结的 Gem 指令');
    assert.equal(row.gemini_request_text, '印尼，iPhone实拍质感\n口播语言：印尼语\n不要提问，直接按以上信息输出提示词');
    assert.equal(JSON.parse(row.image_keys_snapshot).length, 1);
  }
  const keys = JSON.parse(items[0].image_keys_snapshot);
  const second = await f.create({ count: 1 });
  assert.equal(second.status, 201); assert.equal(second.body.productId, c.body.productId); assert.equal(second.body.reused, true);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM products').n, 1);
  assert.deepEqual(JSON.parse(f.items(c.body.id)[0].image_keys_snapshot), keys);
  assert.ok(f.objects.has(keys[0]));
  f.sqlite.prepare("UPDATE gems SET content='后来编辑的指令'").run();
  const [job] = await f.claim();
  assert.equal(job.kind, 'standard'); assert.equal(job.blockMode, 'single'); assert.equal(job.gem.content, '冻结的 Gem 指令');
  assert.equal(job.prompt, items[0].gemini_request_text);
  assert.deepEqual(job.imageUrls.map(url => new URL(url).searchParams.get('key')), keys);
});

test('prompt items store a three-code-block reply as ONE ready prompt, never split or submit; stale/duplicate results', async t => {
  const f = await fixture(t), c = await f.create({ count: 1 });
  const [job] = await f.claim();
  const reply = [text, text + '二', text + '三'].map(value => '```text\n' + value + '\n```').join('\n\n');
  assert.equal((await f.result(job.id, 'stale-worker', reply)).status, 409);
  assert.equal(f.items(c.body.id)[0].status, 'prompt_generating');
  assert.equal((await f.result(job.id, 'desk', reply)).status, 200);
  const row = f.items(c.body.id)[0];
  assert.equal(row.prompt, reply); assert.equal(row.gemini_raw_reply, reply); assert.equal(row.status, 'prompt_ready'); assert.equal(row.progress, 100);
  assert.equal(row.bridge_worker_id, null); assert.equal(row.bridge_claimed_at, null);
  assert.equal((await f.result(job.id, 'desk', reply)).body.alreadyApplied, true);
  assert.equal((await f.result(job.id, 'old', text)).status, 409);
  for (const action of ['release', 'error', 'defer']) await f.call('gemini-bridge', 'POST', { body: { action, kind: 'standard', taskId: job.id, workerId: 'desk', error: 'late failure' } });
  assert.equal(f.items(c.body.id)[0].status, 'prompt_ready', 'late failure reports cannot reopen a completed prompt');
  assert.equal(f.row('SELECT COUNT(*) AS n FROM tasks').n, 1);
  assert.equal(f.seedanceCalls.length, 0);
  assert.deepEqual((await f.call('seedance-bridge', 'GET')).body.jobs, []);
});

test('prompt batches: atomic inserts, web-only mode, image/count validation and blank product name', async t => {
  const f = await fixture(t);
  for (const count of [0, 21, 1.5]) assert.equal((await f.create({ count })).status, 400);
  assert.equal((await f.create({}, [])).status, 400);
  assert.equal((await f.create({}, ['notes.txt'])).status, 400);
  assert.equal((await f.create({}, Array(13).fill('a.png'))).status, 400);
  f.providers.gemini.config.mode = 'api'; assert.equal((await f.create()).status, 409);
  f.providers.gemini.config.mode = 'web';
  f.sqlite.exec("CREATE TRIGGER fail_batch BEFORE INSERT ON tasks WHEN NEW.task_role='prompt_item' AND NEW.batch_index=3 BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.equal((await f.create()).status, 400); assert.equal(f.row('SELECT COUNT(*) AS n FROM tasks').n, 0);
  f.sqlite.exec('DROP TRIGGER fail_batch');
  const created = await f.create({ count: 1, productName: '', externalId: '' });
  assert.equal(created.status, 201); assert.equal(f.items(created.body.id)[0].title, '图片识别商品 · 第 1/1 条');
});

test('prompt items stay out of video lists/counts/workspace/calendar/review and reject video operations', async t => {
  const f = await fixture(t), c = await f.create(), id = f.items(c.body.id)[0].id;
  for (const status of ['all', 'active', 'review', 'completed', 'attention']) assert.deepEqual((await f.call('tasks', 'GET', { query: '?status=' + status })).body.tasks, []);
  const workspace = await f.call('workspace', 'GET'); assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
  assert.deepEqual(workspace.body.tasks, []); assert.deepEqual(workspace.body.taskCounts, { total: 0, active: 0, review: 0, completed: 0, attention: 0 });
  assert.deepEqual(workspace.body.schedules, []);
  assert.equal((await f.call('tasks', 'PATCH', { body: { id, action: 'queue' } })).status, 409);
  assert.equal((await f.call('tasks/recreate', 'POST', { body: { id, requestId: crypto.randomUUID() } })).status, 409);
  assert.equal((await f.call('tasks/review', 'POST', { body: { id, confirmed: true, action: 'reserve' } })).status, 409);
  assert.equal((await f.call('tasks/review', 'POST', { body: { id: 'other', sourceIds: [id], concatId: 'merged', confirmed: true, action: 'concat-reserve' } })).status, 409);
  assert.equal((await f.call('schedules', 'POST', { body: { taskId: id, accountName: 'tk', scheduledAt: new Date().toISOString() } })).status, 409);
  assert.equal((await f.call('tasks', 'DELETE', { query: '?all=1' })).body.deleted, 0);
  assert.equal(f.items(c.body.id).length, 5);
});

test('prompt retry/copy/deletion are guarded; cleanup preserves shared images, removes only unreferenced media', async t => {
  const f = await fixture(t), c = await f.create({ count: 2 }), [a, b] = f.items(c.body.id);
  assert.equal((await f.action('retry', a.id)).status, 409);
  assert.equal((await f.action('copied', a.id)).status, 409);
  f.sqlite.prepare("UPDATE tasks SET status='failed',prompt=?,error='broken',bridge_worker_id='old',gemini_failures=3 WHERE id=?").run(text, a.id);
  const copied = await f.action('copied', a.id); assert.equal(copied.status, 200); assert.ok(copied.body.copiedAt);
  assert.equal(f.row('SELECT prompt_copied_at FROM tasks WHERE id=?', a.id).prompt_copied_at, copied.body.copiedAt);
  assert.equal((await f.action('retry', a.id)).status, 200);
  const retried = f.row('SELECT * FROM tasks WHERE id=?', a.id);
  assert.equal(retried.status, 'prompt_queued'); assert.equal(retried.prompt, ''); assert.equal(retried.prompt_copied_at, null); assert.equal(retried.bridge_worker_id, null); assert.equal(retried.error, null); assert.equal(retried.gemini_failures, 0);
  await f.claim();
  assert.equal((await f.action('delete-item', a.id)).status, 409);
  assert.equal((await f.action('delete-batch', c.body.id)).status, 409);
  assert.equal((await f.action('delete-item', b.id)).status, 200);
  f.sqlite.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(a.id);
  const key = JSON.parse(a.image_keys_snapshot)[0];
  assert.equal((await f.action('delete-batch', c.body.id)).status, 200); assert.ok(f.objects.has(key), 'library still owns the image');
  const next = await f.create({ count: 2 }), rows = f.items(next.body.id), orphan = JSON.parse(rows[0].image_keys_snapshot)[0];
  f.sqlite.prepare('DELETE FROM product_images WHERE product_id=?').run(next.body.productId); f.sqlite.prepare('UPDATE products SET image_key=NULL WHERE id=?').run(next.body.productId);
  assert.equal((await f.action('delete-item', rows[0].id)).status, 200); assert.ok(f.objects.has(orphan), 'other item still owns it');
  assert.equal((await f.action('delete-batch', next.body.id)).status, 200); assert.equal(f.objects.has(orphan), false);
});

test('prompt batch pagination returns 20 groups with full prompts, newest first, with no skipped groups', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 22; i++) await f.create({ count: 1 });
  f.sqlite.prepare('UPDATE tasks SET prompt=?').run(text);
  const first = (await f.call('prompt-batches', 'GET')).body;
  assert.equal(first.batches.length, 20); assert.equal(first.batches[0].items[0].prompt, text); assert.ok(first.nextCursor); assert.equal(first.hasActive, true);
  const second = (await f.call('prompt-batches', 'GET', { query: '?cursor=' + encodeURIComponent(first.nextCursor) })).body;
  assert.equal(second.batches.length, 2); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.batches, ...second.batches].map(row => row.id)).size, 22);
  f.sqlite.prepare("UPDATE tasks SET status='prompt_ready'").run(); assert.equal((await f.call('prompt-batches', 'GET')).body.hasActive, false);
});

test('backup restore preserves completed prompt items and pauses queued/generating ones without replay', () => {
  const tables = restorableTables({ tasks: ['prompt_ready', 'prompt_queued', 'prompt_generating'].map(status => ({ task_role: 'prompt_item', status, prompt: text, error: null })) });
  assert.deepEqual(tables.tasks.map(row => row.status), ['prompt_ready', 'failed', 'failed']);
  assert.equal(tables.tasks[0].prompt, text); assert.equal(tables.tasks[0].error, null);
  assert.match(tables.tasks[1].error, /未自动重发/);
});

test('the polled batch list carries what the page shows, never Gem snapshots or raw replies', async t => {
  const f = await fixture(t), c = await f.create({ count: 1 });
  const [id] = f.items(c.body.id).map(row => row.id);
  f.sqlite.prepare("UPDATE tasks SET prompt=?,gemini_raw_reply=?,status='prompt_ready' WHERE id=?").run(text, '原始回复'.repeat(500), id);
  const item = (await f.call('prompt-batches', 'GET')).body.batches[0].items[0];
  assert.equal(item.prompt, text); assert.equal(item.product_name, '测试商品'); assert.equal(item.gem_name, '测试 Gem');
  assert.equal(item.gemini_request_text.split('\n')[0], '印尼，iPhone实拍质感'); assert.equal(JSON.parse(item.image_keys_snapshot).length, 1);
  for (const column of ['gem_content_snapshot', 'gemini_raw_reply', 'callback_token']) assert.equal(column in item, false, column);
});
