const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), esbuild = require('esbuild');
const { chromium } = require('../../vendor/publisher/node_modules/playwright-core');
const text = '供外部 Seedance 2.5 使用的完整提示词：' + '产品保持原图外观，自然光实拍，连续镜头展示细节和使用动作。'.repeat(20);
const at = '2026-10-26T02:00:00Z';
const customRequest = '完全按我自己的文字生成。\n保留第二段，不自动追加固定要求。';
const bundle = () => esbuild.buildSync({ stdin: { contents: "import {StudioApp} from './studio-app';import{createRoot}from'react-dom/client';createRoot(document.getElementById('root')).render(<StudioApp/>);", loader: 'tsx', resolveDir: path.resolve(__dirname, '../../app') }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text;

test('prompt-only page: drag images, Gem/count, create, poll to completion, copy/view, remembered settings, paging and mobile', { timeout: 90000 }, async t => {
  const executablePath = process.env.CHROMIUM_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const browser = await chromium.launch({ executablePath }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1360, height: 1050 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const workspace = { products: [], gems: [{ id: 'gem', name: '商品提示词 Gem', content: '保留 Gem 原文' }], tasks: [], taskCounts: { total: 0, active: 0, review: 0, completed: 0, attention: 0 }, schedules: [], tiktokAccounts: [], referenceRemixTasks: [], scriptPipelineTasks: [], referenceRemixSettings: {}, integrations: { gemini: true, geminiMode: 'web', geminiRuntime: { online: true, authenticated: true, accounts: [] }, seedance: false } };
  const posts = [], patches = [], batches = [];
  let completed = false, listRequests = 0, cursors = 0;
  await page.addInitScript(() => {
    window.__copied = []; window.__queueStarts = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => window.__copied.push(value) } });
    window.flowcutDesktop = { setQueueRunning: async value => window.__queueStarts.push(value) };
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/workspace') return route.fulfill({ json: workspace });
    if (url.pathname === '/api/tasks/stats') return route.fulfill({ json: { total: 0, accounts: [] } });
    if (url.pathname === '/api/media') return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64') });
    if (url.pathname === '/api/prompt-batches') {
      if (request.method() === 'POST') {
        const form = new Request('http://fixture', { method: 'POST', headers: { 'content-type': request.headers()['content-type'] }, body: request.postDataBuffer() });
        const data = await form.formData(); posts.push(data);
        const n = Number(data.get('count'));
        batches.unshift({ id: 'batch', created_at: at, items: Array.from({ length: n }, (_, i) => ({ id: 'item-' + (i + 1), batch_index: i + 1, batch_size: n, status: 'prompt_queued', prompt: '', prompt_copied_at: null, product_name: data.get('productName'), product_external_id_snapshot: data.get('externalId'), image_keys_snapshot: '["products/test/image"]', gem_name: '商品提示词 Gem', gemini_request_text: data.get('geminiRequestText'), created_at: at })) });
        return route.fulfill({ status: 201, json: { id: 'batch' } });
      }
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON(); patches.push(body);
        if (body.action === 'copied') batches[0].items.find(item => item.id === body.id).prompt_copied_at = at;
        return route.fulfill({ json: { ok: true, copiedAt: at } });
      }
      listRequests++;
      if (completed) for (const batch of batches) for (const item of batch.items) { item.status = 'prompt_ready'; item.prompt = text; }
      if (url.searchParams.has('cursor')) { cursors++; return route.fulfill({ json: { batches: [{ ...batches[0], id: 'older', items: batches[0].items.map(item => ({ ...item, id: 'old-' + item.id })) }], hasActive: false, nextCursor: null } }); }
      return route.fulfill({ json: { batches, hasActive: batches.length > 0 && !completed, nextCursor: completed ? 'older-cursor' : null } });
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  const code = bundle(), css = fs.readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8').replace('@import "tailwindcss";', '');
  const open = async () => {
    await page.goto('http://127.0.0.1:45992'); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: code });
    await page.locator('.nav-list').getByRole('button', { name: '提示词生成', exact: true }).click();
    await page.locator('.prompt-batch-page').getByRole('heading', { name: '提示词生成', exact: true }).waitFor();
  };
  await open();
  const panel = page.locator('.prompt-batch-page');
  assert.match((await page.locator('.nav-list').textContent()).replace(/\s/g, ''), /多品裂变提示词生成/);
  assert.equal(await panel.getByLabel('地区', { exact: true }).inputValue(), '印尼');
  assert.equal(await panel.getByLabel('条数', { exact: true }).inputValue(), '5');
  assert.equal(await panel.getByRole('button', { name: '生成 5 条提示词', exact: true }).isDisabled(), true);
  const drop = async (name, type) => {
    const transfer = await page.evaluateHandle(({ name, type }) => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([1, 2])], name, { type })); return dt; }, { name, type });
    await panel.getByTestId('prompt-batch-drop').dispatchEvent('drop', { dataTransfer: transfer });
  };
  await drop('notes.txt', 'text/plain'); await panel.getByRole('status').filter({ hasText: '只接受非空图片文件' }).waitFor();
  await drop('1735360337668113921.png', 'image/png');
  await page.waitForFunction(() => document.querySelector('.prompt-batch-fields input').value === '1735360337668113921');
  await panel.getByLabel('商品 ID', { exact: true }).fill('1735360337668113999');
  await panel.getByLabel('商品名（选填）').fill('隔离商品');
  await panel.getByLabel('Gem', { exact: true }).selectOption('gem');
  await panel.getByLabel('地区', { exact: true }).selectOption('泰国');
  await panel.getByLabel('描述', { exact: true }).fill('手持实拍');
  await panel.getByLabel('条数', { exact: true }).fill('3');
  await panel.getByText('发送给 Gem 的文字', { exact: true }).click();
  const requestEditor = panel.getByLabel('发送给 Gem 的文字', { exact: true });
  assert.equal(await requestEditor.inputValue(), '泰国，手持实拍\n口播语言：泰语\n不要提问，直接按以上信息输出提示词');
  await requestEditor.fill(customRequest);
  await panel.getByLabel('地区', { exact: true }).selectOption('印尼');
  assert.equal(await requestEditor.inputValue(), customRequest, 'changing region never overwrites edited text');
  await panel.getByLabel('地区', { exact: true }).selectOption('泰国');
  await panel.getByRole('button', { name: '生成 3 条提示词', exact: true }).click();
  await panel.getByText('已完成 0/3', { exact: false }).waitFor();
  assert.equal(posts.length, 1); assert.equal(posts[0].get('count'), '3'); assert.equal(posts[0].get('gemId'), 'gem');
  assert.equal(posts[0].get('externalId'), '1735360337668113999'); assert.equal(posts[0].getAll('images').length, 1);
  assert.equal(posts[0].get('geminiRequestText').replace(/\r\n?/g, '\n'), customRequest);
  assert.deepEqual(await page.evaluate(() => window.__queueStarts), [true]);
  completed = true;
  await panel.getByText('已完成 3/3', { exact: false }).waitFor({ timeout: 12000 });
  const requestsAfterCompletion = listRequests;
  await new Promise(resolve => setTimeout(resolve, 5500)); assert.equal(listRequests, requestsAfterCompletion, 'polling stops after all items finish');
  const first = panel.locator('.prompt-batch-items li').first();
  await first.getByRole('button', { name: '复制提示词', exact: true }).click();
  await first.getByRole('button', { name: '已复制', exact: true }).waitFor();
  assert.match(await first.textContent(), /已复制 ·/); assert.equal(patches[0].action, 'copied');
  await first.getByRole('button', { name: '查看', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '提示词全文' }); await dialog.waitFor();
  assert.equal(await dialog.locator('pre').textContent(), text);
  await dialog.getByRole('button', { name: '已复制', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__copied), [text, text]);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await panel.getByRole('button', { name: '加载更多', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.prompt-batch-card').length === 2); assert.equal(cursors, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile page has no horizontal scroll');
  await open();
  assert.equal(await panel.getByLabel('Gem', { exact: true }).inputValue(), 'gem');
  assert.equal(await panel.getByLabel('地区', { exact: true }).inputValue(), '泰国');
  assert.equal(await panel.getByLabel('描述', { exact: true }).inputValue(), '手持实拍');
  assert.equal(await panel.getByLabel('条数', { exact: true }).inputValue(), '3');
  assert.equal(await requestEditor.inputValue(), customRequest, 'custom text survives reloading');
  await panel.locator('summary').click();
  await panel.getByRole('button', { name: '恢复默认文字', exact: true }).click();
  assert.equal(await requestEditor.inputValue(), '泰国，手持实拍\n口播语言：泰语\n不要提问，直接按以上信息输出提示词');
  await panel.getByLabel('地区', { exact: true }).selectOption('印尼');
  assert.equal(await requestEditor.inputValue(), '印尼，手持实拍\n口播语言：印尼语\n不要提问，直接按以上信息输出提示词');
  await requestEditor.fill('');
  assert.equal(await panel.getByRole('button', { name: '生成 3 条提示词', exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
});
