const assert = require('node:assert/strict');

// Real packaged HTTP/SQLite paths, synthetic accounts and no external Gemini requests.
module.exports = async ({ api, productId, gemId }) => {
  const created = [];
  const auth = { authorization: 'Bearer smoke-bridge-only' };
  const claim = () => api('/api/gemini-bridge?workerId=queue-smoke&capacity=1&accountIds=test-account', { headers: auth });
  const report = body => api('/api/gemini-bridge', { method: 'POST', headers: auth, body: JSON.stringify({ workerId: 'queue-smoke', ...body }) });
  for (let i = 0; i < 3; i++) created.push(await api('/api/tasks', { method: 'POST', body: JSON.stringify({ productId, gemId, tiktokAccountName: 'clear-test', autoQueue: false }) }));
  const first = (await claim()).jobs[0];
  assert.equal(first.id, created[0].id);
  const start = Date.now();
  const deferred = await report({ taskId: first.id, kind: 'standard', action: 'defer', error: 'fixture response incomplete' });
  assert.equal(deferred.deferred, true);
  assert.ok(Date.parse(deferred.retryAt) >= start + 30000 && Date.parse(deferred.retryAt) <= Date.now() + 30000);
  for (let i = 1; i < 3; i++) {
    const job = (await claim()).jobs[0];
    assert.equal(job.id, created[i].id, 'waiting task must not obstruct subsequent work');
    await report({ taskId: job.id, kind: 'standard', action: 'result', prompt: 'fixture text '.repeat(40) });
  }
  const tasks = (await api('/api/workspace')).tasks;
  assert.equal(tasks.find(t => t.id === first.id).status, 'prompt_queued');
  assert.match(tasks.find(t => t.id === first.id).error, /30 秒后可重试/);
  for (const task of created.slice(1)) assert.equal(tasks.find(t => t.id === task.id).status, 'prompt_ready');
  assert.equal((await claim()).jobs.length, 0, 'do not retry early or duplicate completed work');
  await api('/api/tasks?all=1', { method: 'DELETE' });
  console.log('Gemini queue HTTP smoke: PASS (30-second defer, later tasks complete, no duplicate dispatch)');
};
