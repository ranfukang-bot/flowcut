const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { downloadVideo, buildArchivedVideoFilename } = require('../../vendor/seedance-engine/video-download');
const { WorkbenchStore } = require('../../vendor/seedance-engine/store');
const { FlowCutBridge } = require('../../vendor/seedance-engine/flowcut-bridge');
const { BridgeEngine } = require('../src/bridge-engine');
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-141-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function box(type, data) { const head = Buffer.alloc(8); head.writeUInt32BE(data.length + 8); head.write(type, 4); return Buffer.concat([head, data]); }
const video = Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov', Buffer.from('test')), box('mdat', Buffer.from('frame-data'))]);
const ready = () => new Response(video, { headers: { 'content-type': 'video/mp4', 'content-length': String(video.length) } });
test('rendering responses never become MP4 files; a later ready response downloads', async t => {
  const root = temp(t), destination = path.join(root, '1735360337668113923.mp4');
  for (const response of [new Response('{"rendering":true}', { status: 202 }), new Response('rendering', { headers: { 'content-type': 'text/html' } }), new Response('{"rendering":true}', { headers: { 'content-type': 'application/octet-stream' } }), new Response(video.subarray(0, 25), { headers: { 'content-type': 'video/mp4' } })]) {
    await assert.rejects(downloadVideo('https://example.test/video', destination, async () => response), { code: 'VIDEO_NOT_READY' });
    assert.deepEqual(fs.readdirSync(root), []);
  }
  const result = await downloadVideo('https://example.test/video', destination, async () => ready());
  assert.equal(result.destination, destination); assert.deepEqual(fs.readFileSync(destination), video);
});
test('concurrent videos retain exact product ID names without overwriting', async t => {
  const root = temp(t), id = '1735360337668113923';
  assert.equal(buildArchivedVideoFilename({ productExternalId: id, prompt: 'other' }), id + '.mp4');
  const destination = path.join(root, id + '.mp4');
  const results = await Promise.all([downloadVideo('a', destination, async () => ready()), downloadVideo('b', destination, async () => ready())]);
  assert.equal(new Set(results.map(r => r.destination)).size, 2);
  assert.deepEqual(fs.readdirSync(root).sort(), [id + ' (2).mp4', id + '.mp4'].sort());
});
test('cleared task tombstones survive restarts and reject late callbacks without deleting other jobs', t => {
  const root = temp(t), store = new WorkbenchStore(root);
  const old = { id: 'old', flowcutTaskId: 'site-old', status: 'generating' };
  const keep = { id: 'keep', flowcutTaskId: 'remix', status: 'success' };
  store.addTasks([old, keep]); store.clearFlowcutTasks(['site-old']);
  store.upsertTask({ ...old, status: 'success' }); store.addTasks([old]);
  assert.deepEqual(store.tasks.map(t => t.id), ['keep']);
  const reloaded = new WorkbenchStore(root); reloaded.upsertTask(old);
  assert.deepEqual(reloaded.tasks.map(t => t.id), ['keep']);
});
test('clearing a Gemini task while images load prevents submission and result writeback', async () => {
  let finishDownload, run = 0, write = 0;
  const bridge = new BridgeEngine({ store: { state: { settings: {}, pendingResults: [] }, removePendingResult() {}, log() {}, upsertPendingResult() { write++; } }, runJob: async () => { run++; }, onChange() {} });
  bridge.active.set('account', { taskId: 'job' });
  bridge.downloadFiles = () => new Promise(resolve => { finishDownload = resolve; });
  bridge.report = async () => { throw new Error('Cleared tasks must not report'); };
  const execution = bridge.execute({ id: 'account', name: 'test' }, { id: 'job', imageUrls: ['test'] });
  bridge.cancelTasks(['job']); finishDownload([]); await execution;
  assert.equal(run, 0); assert.equal(write, 0); assert.equal(bridge.active.size, 0);
});
test('rendering is retried later without submitting another generation task', async t => {
  const store = new WorkbenchStore(temp(t));
  const task = { id: 'download', flowcutTaskId: 'site', status: 'success', tiktokAccountName: 'shop' };
  store.addTasks([task]); let attempts = 0;
  const bridge = new FlowCutBridge({ store, engine: {}, downloadTask: async task => {
    attempts++; if (attempts === 1) throw Object.assign(new Error('视频仍在渲染'), { code: 'VIDEO_NOT_READY' });
    task.lastDownloadedPath = path.join('videos', 'shop', '123.mp4');
  } });
  bridge.scheduleAutoDownload(task); await new Promise(setImmediate);
  assert.equal(task.status, 'success'); assert.ok(task.nextAutoDownloadAt > Date.now());
  bridge.scheduleAutoDownload(task); assert.equal(attempts, 1);
  task.nextAutoDownloadAt = 0; bridge.scheduleAutoDownload(task); await new Promise(setImmediate);
  assert.equal(attempts, 2); assert.equal(task.autoDownloadError, '');
});
