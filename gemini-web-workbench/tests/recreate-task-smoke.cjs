const assert = require('node:assert/strict');
const crypto = require('node:crypto');

module.exports = async function ({ api, base, headers, sourceId }) {
  const recreate = (id = sourceId, requestId = crypto.randomUUID()) => fetch(base + '/api/tasks/recreate', {
    method: 'POST', headers, body: JSON.stringify({ id, requestId }),
  });
  assert.equal((await recreate()).status, 409, 'in-flight original must not be regenerated');
  await api('/api/tasks', { method: 'PATCH', body: JSON.stringify({ id: sourceId, action: 'local-status', providerStatus: 'success', outputUrl: 'https://example.com/original.mp4' }) });
  assert.equal((await recreate()).status, 409, 'deleted archive account produces an actionable error');
  await api('/api/tiktok-accounts', { method: 'POST', body: JSON.stringify({ name: 'archive-test', archiveDirectory: 'E:\\NewDefault' }) });
  const before = (await api('/api/workspace')).tasks.find(row => row.id === sourceId);
  const responses = await Promise.all(Array.from({ length: 5 }, () => recreate()));
  assert.ok(responses.every(response => response.ok));
  const results = await Promise.all(responses.map(response => response.json()));
  assert.equal(new Set(results.map(result => result.id)).size, 1, 'concurrent clicks produce one new task');
  assert.equal(results.filter(result => result.created).length, 1);
  const taskId = results[0].id;
  assert.notEqual(taskId, sourceId);
  const after = await api('/api/workspace');
  assert.equal(after.tasks.length, 2);
  assert.deepEqual(after.tasks.find(row => row.id === sourceId), {...before,review_status:'replaced'}, 'old task is replaced; other history stays unchanged');
  const copy = after.tasks.find(row => row.id === taskId);
  assert.ok(before.gemini_request_text, 'fixture must have a saved custom request');
  for (const field of ['product_id', 'gem_id', 'gem_content_snapshot', 'gemini_request_text', 'product_external_id', 'duration', 'region', 'shooting_style', 'tiktok_account_name', 'archive_directory', 'product_image_key', 'image_count']) {
    assert.equal(copy[field], before[field], `preserves ${field}`);
  }
  assert.equal(copy.auto_queue, 1);
  assert.equal(copy.status, 'prompt_queued');
  assert.equal(copy.prompt, '');
  assert.equal(copy.provider, 'gemini-web');
  for (const field of ['provider_job_id', 'provider_status_url', 'output_url', 'download_path', 'download_error', 'bridge_claimed_at', 'bridge_worker_id', 'gemini_account_id']) assert.equal(copy[field], null, `does not inherit ${field}`);
  assert.notEqual(copy.callback_token, before.callback_token);
  assert.equal(copy.regenerated_from_task_id, sourceId);
  // A delayed retry with the same operation ID must never generate another
  // copy, even if this generation has already finished in the meantime.
  await api('/api/tasks', { method: 'PATCH', body: JSON.stringify({ id: taskId, action: 'local-status', providerStatus: 'success', outputUrl: 'https://example.com/remade.mp4' }) });
  const repeated = await recreate(sourceId, taskId);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).id, taskId);
  assert.equal((await api('/api/workspace')).tasks.length, 2);
  const another = await recreate();
  assert.equal(another.status, 200, 'old replaced task points to its remake, even after refresh');
  assert.equal((await another.json()).id, taskId);
  assert.equal((await recreate('missing-task')).status, 404);
  assert.equal((await recreate(sourceId, sourceId)).status, 409, 'never overwrite an existing unrelated task ID');
  await api('/api/tasks/review', {method:'POST',body:JSON.stringify({id:sourceId,replacementId:taskId,action:'discard',confirmed:true})});
  assert.equal((await api('/api/workspace')).tasks.length,1,'old rejected task is removed from the list');
  assert.equal(await api('/api/tasks/review?id='+sourceId+'&optional=1'),null,'old task record is really deleted, not hidden');
  assert.equal((await recreate(sourceId,taskId)).status,200,'lost reply retry still reuses replacement after original deletion');
  assert.equal((await api('/api/tasks?completed=1',{method:'DELETE'})).deleted,0,'pending review must survive clear completed');
  const emptyProduct = new FormData();
  emptyProduct.set('name', 'Image-less product');
  const empty = await fetch(base + '/api/products', { method: 'POST', headers: { 'x-flowcut-desktop-token': headers['x-flowcut-desktop-token'] }, body: emptyProduct });
  assert.equal(empty.status, 201);
  const emptyId = (await empty.json()).id;
  const noImageTask = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ productId: emptyId, gemId: before.gem_id, tiktokAccountName: 'archive-test' }) });
  await api('/api/tasks', { method: 'PATCH', body: JSON.stringify({ id: noImageTask.id, action: 'local-status', providerStatus: 'success', outputUrl: 'https://example.com/old.mp4' }) });
  const countBefore = (await api('/api/workspace')).tasks.length;
  const noImage = await recreate(noImageTask.id);
  assert.equal(noImage.status, 409);
  assert.match((await noImage.json()).error, /商品图片已删除/);
  assert.equal((await api('/api/workspace')).tasks.length, countBefore, 'missing images do not create an unusable task');
  console.log('Task remake API: saved inputs, fresh execution, concurrent deduplication, old-record deletion and pending-review retention PASS');
};
