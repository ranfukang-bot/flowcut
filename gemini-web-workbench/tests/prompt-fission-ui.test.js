const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), esbuild = require('esbuild');
const { chromium } = require('../../vendor/publisher/node_modules/playwright-core');
const text = '完整商品提示词：' + '自然光展示产品细节，保持同一商品外观，镜头包含完整动作及口播。'.repeat(20);
const at = '2026-10-28T02:00:00Z';

test('prompt fission page: grouped drops, editable two rounds, retry UUID, copy mother/child, persistence and mobile', { timeout: 90000 }, async t => {
  const executablePath = process.env.CHROMIUM_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const browser = await chromium.launch({ executablePath }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1360, height: 1050 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const code = esbuild.buildSync({ stdin: { contents: "import {PromptBatchPage} from './prompt-batch-page';import{createRoot}from'react-dom/client';createRoot(document.getElementById('root')).render(<PromptBatchPage gems={[{id:'mother',name:'母版测试 Gem',content:'指令'},{id:'variant',name:'变体测试 Gem',content:'指令'}]}/>);", loader: 'tsx', resolveDir: path.resolve(__dirname, '../../app') }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text;
  const style = fs.readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8').replace('@import "tailwindcss";', '');
  const posts = [], uploads = [], patches = [], batches = [];
  let fail = true;
  await page.addInitScript(() => {
    window.__copied = []; window.__queueStarts = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => window.__copied.push(value) } });
    window.flowcutDesktop = { setQueueRunning: async value => window.__queueStarts.push(value) };
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/products') {
      const form = await new Request('http://fixture', { method: 'POST', headers: { 'content-type': request.headers()['content-type'] }, body: request.postDataBuffer() }).formData();
      uploads.push(form.get('externalId')); return route.fulfill({ json: { id: 'p' + uploads.length, imageKeys: ['products/p' + uploads.length + '/image.png'] } });
    }
    if (url.pathname === '/api/prompt-batches') {
      if (request.method() === 'POST') {
        const body = request.postDataJSON(); posts.push(body);
        if (!batches.length) {
          const item = (id, i, role) => ({ id, task_role: role, batch_index: i, batch_size: 2, status: role === 'fission' ? 'fission_ready' : 'prompt_ready', prompt: text, product_name: '商品 ' + i, product_external_id_snapshot: '173536033766811392' + i, image_keys_snapshot: '[]', gem_name: role === 'fission' ? '母版测试 Gem' : '变体测试 Gem', region: body.region, created_at: at });
          batches.push({ id: body.requestId, kind: 'fission', created_at: at, mother: item(body.requestId, 0, 'fission'), items: [item(body.requestId + '-p1', 1, 'fission_child'), item(body.requestId + '-p2', 2, 'fission_child')] });
        }
        if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: '模拟回包丢失，请重试' } }); }
        return route.fulfill({ json: { id: body.requestId, created: false } });
      }
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON(); patches.push(body);
        const row = [batches[0].mother, ...batches[0].items].find(item => item.id === body.id); if (row) row.prompt_copied_at = at;
        return route.fulfill({ json: { ok: true, copiedAt: at } });
      }
      return route.fulfill({ json: { batches, nextCursor: null, hasActive: false } });
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  const open = async () => { await page.goto('http://127.0.0.1:45992'); await page.addStyleTag({ content: style }); await page.addScriptTag({ content: code }); };
  await open(); await page.getByRole('group', { name: '生成模式' }).getByRole('button', { name: '多品裂变', exact: true }).click();
  const transfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer(); for (const name of ['1735360337668113921.png','1735360337668113921-2.png','1735360337668113922.png']) dt.items.add(new File([new Uint8Array([1,2,3])], name, { type: 'image/png' })); return dt;
  });
  await page.locator('.fission-drop').dispatchEvent('drop', { dataTransfer: transfer });
  await page.getByRole('article', { name: '商品 2', exact: true }).waitFor(); assert.equal(await page.locator('.fission-card').count(), 2);
  assert.equal(await page.getByRole('button', { name: '从商品库添加' }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1360, height: 1050 });
  await page.getByLabel('母版 Gem', { exact: true }).selectOption('mother'); await page.getByLabel('变体 Gem', { exact: true }).selectOption('variant');
  await page.getByRole('article', { name: '商品 2', exact: true }).getByRole('button', { name: '设为母版' }).click();
  await page.getByText('发送给 Gem 的文字', { exact: true }).click();
  const first = '我自己的第一轮。\n不要追加任何句子。'; await page.getByLabel('发送给 Gem 的文字', { exact: true }).fill(first);
  await page.getByText('第二轮文字（发给变体 Gem）', { exact: true }).click();
  const second = '把 {母版提示词} 换成这个商品。\n{地区} 保持原文。'; await page.getByLabel('第二轮文字', { exact: true }).fill('缺少占位符');
  assert.equal(await page.getByRole('button', { name: '生成 2 个商品的提示词' }).isDisabled(), true);
  await page.getByLabel('第二轮文字', { exact: true }).fill(second); await page.getByLabel('地区', { exact: true }).selectOption('泰国');
  assert.equal(await page.getByLabel('第二轮文字', { exact: true }).inputValue(), second); assert.equal(await page.getByLabel('发送给 Gem 的文字', { exact: true }).inputValue(), first);
  await page.getByRole('button', { name: '生成 2 个商品的提示词' }).click(); await page.getByRole('status').filter({ hasText: '模拟回包丢失' }).waitFor();
  await page.getByRole('button', { name: '生成 2 个商品的提示词' }).click(); await page.getByRole('status').filter({ hasText: '已创建' }).waitFor();
  assert.equal(uploads.length, 2); assert.equal(posts.length, 2); assert.equal(posts[0].requestId, posts[1].requestId); assert.equal(posts[0].motherProductId, 'p2');
  assert.equal(posts[0].firstText, first); assert.equal(posts[0].secondText, second); assert.equal(posts[0].region, '泰国');
  const batch = page.getByRole('article', { name: '多品裂变提示词批次', exact: true });
  assert.equal(await batch.getByText('已完成 2/2', { exact: false }).count(), 1);
  await batch.getByRole('button', { name: '复制提示词', exact: true }).first().click(); await batch.getByRole('button', { name: '已复制', exact: true }).waitFor();
  await batch.getByRole('button', { name: '复制母版', exact: true }).click(); await page.waitForFunction(() => window.__copied.length === 2);
  assert.equal(patches.length, 2); assert.deepEqual(await page.evaluate(() => window.__queueStarts), [true]);
  await open(); await page.getByLabel('母版 Gem', { exact: true }).waitFor(); assert.equal(await page.getByLabel('母版 Gem', { exact: true }).inputValue(), 'mother');
  await page.locator('summary').filter({ hasText: '第二轮文字' }).click(); assert.equal(await page.getByLabel('第二轮文字', { exact: true }).inputValue(), second);
  await page.getByLabel('母版来源').selectOption('paste'); assert.equal(await page.getByLabel('发送给 Gem 的文字', { exact: true }).count(), 0); await page.getByLabel('母版提示词', { exact: true }).fill(text);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});
