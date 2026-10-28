const test = require('node:test'), assert = require('node:assert/strict');
const { siteFixture } = require('./helpers/site-routes.cjs');
const { restorableTables } = require('../src/backup-manager');
const text = '完整的母版提示词。' + '保持真实商品外观与自然光，连续镜头展示使用动作和口播。'.repeat(20);
const firstText = '\n完全自定义第一轮。{地区} 是原文，不要替换。\n口播语言：泰语\n';
const secondText = '\n只替换母版：{母版提示词}\n保留字面量 {地区}，不补固定句子。\n口播语言：中文\n';
async function fixture(t) {
  const f = await siteFixture(t), now = new Date().toISOString();
  for (const id of ['mother', 'variant']) f.sqlite.prepare('INSERT INTO gems(id,name,content,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, id + ' Gem', id + ' 冻结指令', now, now);
  const products = [];
  for (let i = 1; i <= 3; i++) {
    const form = new FormData(); form.set('externalId', '173536033766811392' + i); form.set('name', '商品 ' + i);
    form.append('images', new File(['test image'], i + '.png', { type: 'image/png' }));
    const response = await (await f.route('products')).POST(new Request('http://fixture/api/products', { method: 'POST', body: form }));
    const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body));
    products.push({ productId: body.id, imageKeys: body.imageKeys });
  }
  f.input = { mode: 'fission', requestId: crypto.randomUUID(), products, motherSource: 'generate', motherProductId: products[1].productId, motherGemId: 'mother', variantGemId: 'variant', region: '印尼', firstText, secondText };
  f.create = extra => f.call('prompt-batches', 'POST', { body: { ...f.input, ...extra } });
  f.items = id => f.rows('SELECT * FROM tasks WHERE prompt_batch_id=? ORDER BY batch_index', id);
  f.claim = async (worker = 'desk') => (await f.call('gemini-bridge', 'GET', { query: '?workerId=' + worker + '&capacity=1&accountIds=acc' })).body.jobs;
  f.result = (id, kind = 'standard', worker = 'desk', prompt = text) => f.call('gemini-bridge', 'POST', { body: { action: 'result', kind, taskId: id, workerId: worker, prompt, codeBlocks: [text, text + '二', text + '三'], codeBlockHint: true } });
  f.action = (action, id) => f.call('prompt-batches', 'PATCH', { body: { action, id } });
  return f;
}

test('prompt fission: atomic snapshots, UUID idempotency, standard mother and single variant claims use verbatim text', async t => {
  const f = await fixture(t), c = await f.create(); assert.equal(c.status, 201, JSON.stringify(c.body));
  const id = c.body.id, [mother, ...children] = f.items(id); assert.equal(children.length, 3);
  assert.equal(mother.product_id, f.input.products[1].productId); assert.equal(mother.task_role, 'fission');
  for (const [i, row] of [mother, ...children].entries()) {
    assert.equal(row.prompt_batch_id, id); assert.equal(row.auto_queue, 0); assert.equal(row.tiktok_account_name, ''); assert.equal(row.archive_directory, ''); assert.equal(row.gemini_account_id, null);
    assert.equal(row.duration, 30); assert.equal(row.gemini_request_text, firstText); assert.equal(row.variant_request_text, secondText);
    if (i) { assert.equal(row.status, 'fission_wait'); assert.equal(row.task_role, 'fission_child'); assert.deepEqual(JSON.parse(row.image_keys_snapshot), f.input.products[i - 1].imageKeys); }
    assert.equal(row.gem_content_snapshot, (i ? 'variant' : 'mother') + ' 冻结指令');
  }
  assert.equal((await f.create()).body.created, false); assert.equal(f.items(id).length, 4);
  f.sqlite.prepare("UPDATE gems SET content='新指令'").run();
  const [job] = await f.claim(); assert.equal(job.kind, 'standard'); assert.equal(job.blockMode, 'single'); assert.equal(job.prompt, firstText); assert.equal(job.gem.content, 'mother 冻结指令');
  assert.equal(job.spokenLanguage, '泰语');
  assert.deepEqual(job.imageUrls.map(url => new URL(url).searchParams.get('key')), f.input.products[1].imageKeys);
  assert.equal((await f.result(id, 'standard', 'old')).status, 409); assert.deepEqual(await f.claim(), []);
  assert.equal((await f.result(id, 'standard', 'desk', '回复太短')).status, 400); assert.ok(f.items(id).slice(1).every(row => row.status === 'fission_wait'));
  assert.equal((await f.result(id)).status, 200); assert.equal(f.items(id)[0].status, 'fission_ready');
  assert.ok(f.items(id).slice(1).every(row => row.status === 'variant_queued'));
  assert.equal((await f.result(id)).body.alreadyApplied, true);
  const [childJob] = await f.claim(); assert.equal(childJob.kind, 'variant'); assert.equal(childJob.blockMode, 'single');
  assert.equal(childJob.prompt, secondText.replace('{母版提示词}', text)); assert.equal(childJob.gem.content, 'variant 冻结指令');
  assert.equal(childJob.spokenLanguage, '中文');
  const reply = ['```text', text, '```', '```text', text, '```', '```text', text, '```'].join('\n');
  assert.equal((await f.result(childJob.id, 'variant', 'old', reply)).status, 409);
  assert.equal((await f.result(childJob.id, 'variant', 'desk', '回复太短')).status, 400);
  f.sqlite.prepare('UPDATE tasks SET auto_queue=1 WHERE id=?').run(childJob.id);
  assert.equal((await f.result(childJob.id, 'variant', 'desk', reply)).status, 200);
  const saved = f.row('SELECT * FROM tasks WHERE id=?', childJob.id); assert.equal(saved.status, 'prompt_ready'); assert.equal(saved.prompt, reply); assert.equal(saved.gemini_raw_reply, reply); assert.equal(saved.progress, 100); assert.equal(saved.auto_queue, 0);
  assert.equal((await f.result(childJob.id, 'variant', 'desk', reply)).body.alreadyApplied, true);
  for (const action of ['release', 'error', 'defer']) await f.call('gemini-bridge', 'POST', { body: { action, kind: 'variant', taskId: childJob.id, workerId: 'desk', error: 'late' } });
  assert.equal(f.row('SELECT status FROM tasks WHERE id=?', childJob.id).status, 'prompt_ready');
  assert.equal(f.row('SELECT COUNT(*) AS n FROM tasks').n, 4); assert.equal(f.seedanceCalls.length, 0);
});

test('prompt fission: paste queues children immediately; validation and batch rollback', async t => {
  const f = await fixture(t);
  for (const extra of [{ products: [] }, { region: '不存在' }, { firstText: ' ' }, { secondText: '无占位' }, { motherGemId: 'missing' }, { motherProductId: 'missing' }, { requestId: 'bad' }, { products: [f.input.products[0], f.input.products[0]] }, { products: [{ ...f.input.products[0], imageKeys: ['products/other/a'] }, f.input.products[1]] }]) assert.equal((await f.create(extra)).status, 400, JSON.stringify(extra));
  f.sqlite.exec("CREATE TRIGGER fail_prompt_fission BEFORE INSERT ON tasks WHEN NEW.task_role='fission_child' AND NEW.batch_index=2 BEGIN SELECT RAISE(ABORT,'test atomic failure'); END");
  assert.equal((await f.create()).status, 400); assert.equal(f.row('SELECT COUNT(*) AS n FROM tasks').n, 0); f.sqlite.exec('DROP TRIGGER fail_prompt_fission');
  assert.equal((await f.create({ motherSource: 'paste', motherPrompt: '短' })).status, 400);
  const c = await f.create({ motherSource: 'paste', motherPrompt: text, firstText: undefined, motherGemId: undefined }); assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(f.items(c.body.id)[0].status, 'fission_ready'); assert.equal(f.items(c.body.id)[0].prompt, text);
  assert.ok(f.items(c.body.id).slice(1).every(row => row.status === 'variant_queued')); assert.equal((await f.claim())[0].kind, 'variant');
});

test('prompt fission: failed mother keeps barrier, retry releases children, child retry has two destinations', async t => {
  const f = await fixture(t), c = await f.create(), id = c.body.id;
  await f.claim(); await f.call('gemini-bridge', 'POST', { body: { action: 'error', kind: 'standard', taskId: id, workerId: 'desk', error: 'test failed' } });
  assert.ok(f.items(id).slice(1).every(row => row.status === 'fission_wait'));
  assert.equal((await f.call('prompt-batches', 'GET')).body.hasActive, false);
  const child = f.items(id)[1]; f.sqlite.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(child.id);
  assert.equal((await f.action('retry', child.id)).status, 200); assert.equal(f.row('SELECT status FROM tasks WHERE id=?', child.id).status, 'fission_wait');
  assert.equal((await f.action('retry', id)).status, 200); assert.equal(f.items(id)[0].gemini_account_id, null); assert.equal(f.items(id)[0].bridge_worker_id, null);
  await f.claim(); await f.result(id); assert.ok(f.items(id).slice(1).every(row => row.status === 'variant_queued'));
  await f.claim(); await f.call('gemini-bridge', 'POST', { body: { action: 'error', kind: 'variant', taskId: child.id, workerId: 'desk', error: 'test failed' } });
  assert.equal((await f.action('retry', child.id)).status, 200); const retried = f.row('SELECT * FROM tasks WHERE id=?', child.id);
  assert.equal(retried.status, 'variant_queued'); assert.equal(retried.gemini_account_id, null); assert.equal(retried.error, null); assert.equal(retried.bridge_worker_id, null);
});

test('prompt fission: video lists, counts, details, fission page and operations all exclude ownership marker', async t => {
  const f = await fixture(t), c = await f.create();
  for (const row of f.items(c.body.id)) {
    assert.equal((await f.call('tasks', 'GET', { query: '?id=' + row.id })).status, 404);
    assert.equal((await f.call('tasks', 'PATCH', { body: { id: row.id, action: 'queue' } })).status, 409);
    assert.equal((await f.call('tasks', 'DELETE', { body: { id: row.id } })).status, 409);
    assert.equal((await f.call('tasks/recreate', 'POST', { body: { id: row.id, requestId: crypto.randomUUID() } })).status, 409);
    assert.equal((await f.call('tasks/review', 'POST', { body: { id: row.id, action: 'reserve', confirmed: true } })).status, 409);
    assert.equal((await f.call('schedules', 'POST', { body: { taskId: row.id, accountName: 'tk', scheduledAt: new Date().toISOString() } })).status, 409);
    assert.equal((await f.call('products', 'DELETE', { body: { id: row.product_id } })).status, 409);
  }
  for (const status of ['all','active','review','completed','attention']) assert.deepEqual((await f.call('tasks', 'GET', { query: '?status=' + status })).body.tasks, []);
  assert.deepEqual((await f.call('fission', 'GET')).body.batches, []);
  assert.equal((await f.call('tasks/review', 'POST', { body: { id: 'other', sourceIds: [c.body.id], action: 'concat-reserve', confirmed: true } })).status, 409);
  const workspace = (await f.call('workspace', 'GET')).body;
  assert.deepEqual(workspace.tasks, []); assert.equal(workspace.taskCounts.total, 0);
  assert.equal((await f.call('tasks', 'DELETE', { query: '?all=1' })).body.deleted, 0); assert.equal(f.items(c.body.id).length, 4);
  assert.equal((await f.call('tasks', 'DELETE', { query: '?completed=1' })).body.deleted, 0); assert.equal(f.items(c.body.id).length, 4);
  assert.equal((await f.call('seedance-bridge', 'POST', { body: { taskId: c.body.id, kind: 'standard', action: 'submitted', providerJobId: 'should-never-submit' } })).status, 409);
  f.sqlite.prepare("UPDATE tasks SET provider='seedance-bridge',status='video_queued'").run();
  assert.deepEqual((await f.call('seedance-bridge', 'GET')).body.jobs, []);
});

test('prompt batches group single and fission results independently using the ownership marker', async t => {
  const f = await fixture(t); const c = await f.create();
  const form = new FormData(); form.set('gemId', 'mother'); form.set('count', '2'); form.set('externalId', 'single');
  form.append('images', new File(['image'], 'single.png', { type: 'image/png' }));
  const response = await (await f.route('prompt-batches')).POST(new Request('http://fixture/api/prompt-batches', { method: 'POST', body: form })); assert.equal(response.status, 201);
  const list = (await f.call('prompt-batches', 'GET')).body; assert.equal(list.batches.length, 2);
  assert.equal(list.batches.find(row => row.kind === 'fission').id, c.body.id);
  assert.equal(list.batches.find(row => row.kind === 'single').items.length, 2);
  assert.equal(list.batches.find(row => row.kind === 'single').mother, undefined);
});

test('prompt fission: list groups and projection, copy mother/children, delete whole batch only and generation guards', async t => {
  const f = await fixture(t), c = await f.create({ motherSource: 'paste', motherPrompt: text }); const id = c.body.id;
  const batch = (await f.call('prompt-batches', 'GET')).body.batches[0]; assert.equal(batch.kind, 'fission'); assert.equal(batch.items.length, 3); assert.equal(batch.mother.prompt, text); assert.equal(batch.mother.gem_name, 'variant Gem');
  for (const row of [batch.mother, ...batch.items]) for (const key of ['gem_content_snapshot','variant_gem_snapshot','gemini_raw_reply','callback_token','variant_request_text']) assert.equal(key in row, false);
  assert.equal((await f.action('copied', id)).status, 200);
  for (const row of f.items(id)) assert.equal((await f.action('delete-item', row.id)).status, 409);
  const [job] = await f.claim(); assert.equal((await f.action('delete-batch', id)).status, 409);
  await f.result(job.id, 'variant'); assert.equal((await f.action('copied', job.id)).status, 200);
  assert.ok(f.row('SELECT prompt_copied_at FROM tasks WHERE id=?', job.id).prompt_copied_at);
  assert.equal((await f.action('delete-batch', id)).status, 200); assert.equal(f.items(id).length, 0);
  const next = await f.create({ requestId: crypto.randomUUID() }); await f.claim(); assert.equal((await f.action('delete-batch', next.body.id)).status, 409);
});

test('prompt fission restore preserves completed mother and children, pauses incomplete work without resubmission', () => {
  const rows = [
    { task_role: 'fission', status: 'fission_ready', prompt: text }, { task_role: 'fission_child', status: 'prompt_ready', prompt: text },
    { task_role: 'fission', status: 'fission_ready', prompt: '短' }, { task_role: 'fission', status: 'prompt_queued' },
    { task_role: 'fission_child', status: 'variant_generating' }, { task_role: 'fission_child', status: 'fission_wait' },
  ].map(row => ({ ...row, prompt_batch_id: 'batch', error: null }));
  const restored = restorableTables({ tasks: [...rows, { task_role: 'fission', status: 'fission_ready', prompt: text }] }).tasks;
  assert.deepEqual(restored.map(row => row.status), ['fission_ready','prompt_ready','failed','failed','failed','failed','failed']);
  assert.equal(restored[0].prompt, text); assert.equal(restored[1].prompt, text); assert.match(restored[4].error, /未自动重发/);
});
