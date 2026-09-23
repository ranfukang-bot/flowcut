import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { accountFolder, normalizePickedProduct, importProducts, releaseVideo, installFlowCutRoutes } from '../vendor/publisher/src/flowcut-integration.js';
const require = createRequire(import.meta.url);
const express = require('../vendor/publisher/node_modules/express');
const id = '1735360337668113923';
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-personal-test-'));
  t.after(() => { if (root.startsWith(path.join(os.tmpdir(), 'flowcut-personal-test-'))) fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
test('FastMoss imports retain exact product IDs and ignore already imported products', async t => {
  const root = temporary(t), products = [];
  const api = async (route, init) => {
    if (route === '/api/workspace') return { products };
    assert.equal(init.body.get('externalId'), id);
    const product = { id: 'local-product', external_id: init.body.get('externalId') };
    products.push(product); return product;
  };
  const row = { productId: id, name: '商品', region: 'ID', url: `https://www.fastmoss.com/e-commerce/detail/${id}` };
  const first = await importProducts([row, row], root, api);
  assert.equal(first.added, 1); assert.equal(first.total, 2);
  assert.match(first.results[0].warning, /补充图片/);
  assert.equal((await importProducts([row], root, api)).added, 0);
  assert.equal(products.length, 1);
});
test('rounded numeric IDs and mismatched detail links are rejected', () => {
  assert.throws(() => normalizePickedProduct({ productId: Number(id) }), /数字文本/);
  assert.throws(() => normalizePickedProduct({ productId: id, url: 'https://www.fastmoss.com/e-commerce/detail/1735360337668113924' }), /不一致/);
});
function box(type, bytes) { const head = Buffer.alloc(8); head.writeUInt32BE(bytes.length + 8); head.write(type, 4); return Buffer.concat([head, bytes]); }
test('review preserves source video, names the copy by product ID, and never requeues an already released task', t => {
  const root = temporary(t), downloadRoot = path.join(root, 'downloads'); fs.mkdirSync(downloadRoot);
  const file = path.join(downloadRoot, 'source.mp4');
  fs.writeFileSync(file, Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('mdat', Buffer.alloc(2048)), box('moov', Buffer.from('vide'))]));
  const account = { name: 'TK测试账号', videoFolder: accountFolder(root, 'TK测试账号') };
  const task = { id: 'task-a', status: 'video_ready', download_path: file, product_external_id: id, tiktok_account_name: account.name };
  assert.throws(() => releaseVideo({ root, downloadRoot, task, account, confirmed: false }), /先确认/);
  assert.throws(() => releaseVideo({ root, downloadRoot, task, account: { ...account, name: '别的账号' }, confirmed: true }), /一致/);
  const first = releaseVideo({ root, downloadRoot, task, account, confirmed: true });
  assert.equal(path.basename(first.file), id + '.mp4');
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(fs.readFileSync(first.file), fs.readFileSync(file));
  fs.unlinkSync(first.file); // Simulate the publisher archiving an already published file.
  const again = releaseVideo({ root, downloadRoot, task, account, confirmed: true });
  assert.equal(again.alreadyReleased, true); assert.equal(fs.existsSync(first.file), false);
  assert.throws(() => releaseVideo({ root, downloadRoot: path.join(root, 'elsewhere'), task: { ...task, id: 'task-b' }, account, confirmed: true }));
});
test('picker connector credentials cannot start or control publishing', async t => {
  const root = temporary(t); process.env.FLOWCUT_DESKTOP_TOKEN = 'test-desktop-secret'; process.env.FLOWCUT_CONNECTOR_KEY = 'test-picker-secret'; process.env.FLOWCUT_URL = 'http://127.0.0.1:4173';
  const app = express(); installFlowCutRoutes(app, express, root);
  app.post('/api/orchestrator/start', (_req, res) => res.json({ called: true }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/flowcut/health')).status, 401);
  assert.equal((await fetch(base + '/api/flowcut/health', { headers: { 'x-flowcut-desktop-token': 'test-desktop-secret' } })).status, 200);
  assert.equal((await fetch(base + '/api/orchestrator/start', { method: 'POST', headers: { 'x-workflow-key': 'test-picker-secret' } })).status, 401);
  assert.equal((await fetch(base + '/api/flowcut/open', { method: 'POST', headers: { 'x-workflow-key': 'test-picker-secret' } })).status, 200);
});
