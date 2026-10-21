const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { chromium } = require('../../vendor/publisher/node_modules/playwright-core');
const { siteFixture } = require('./helpers/site-routes.cjs');

test('tasks API forwards account, status, search and cursor to the real SQLite list', async t => {
  const f = await siteFixture(t);
  const add = f.sqlite.prepare(`INSERT INTO tasks(id,product_id,gem_id,title,status,review_status,tiktok_account_name,created_at,updated_at)
    VALUES(?,'p','g',?,'video_ready','pending',?,'2026-10-21T00:00:00.000Z','2026-10-21T00:00:00.000Z')`);
  for (const [id, title, account] of [['1', '目标商品', 'Shop'], ['2', '目标商品', 'sHoP'], ['3', '目标商品', 'ShopPlus'], ['4', '其他商品', 'Shop']]) add.run(id, title, account);
  const query = '?' + new URLSearchParams({ account: 'SHOP', status: 'review', q: '目标', limit: '1' });
  const first = await f.call('tasks', 'GET', { query });
  assert.equal(first.status, 200); assert.deepEqual(first.body.tasks.map(row => row.id), ['2']); assert.ok(first.body.nextCursor);
  const second = await f.call('tasks', 'GET', { query: query + '&cursor=' + first.body.nextCursor });
  assert.equal(second.status, 200); assert.deepEqual(second.body.tasks.map(row => row.id), ['1']); assert.equal(second.body.nextCursor, null);
  const empty = await f.call('tasks', 'GET', { query: query.replace('review', 'completed') });
  assert.deepEqual(empty.body.tasks, []);
});

let bundle;
function studioBundle() {
  return bundle ||= esbuild.buildSync({
    stdin: { contents: "import{StudioApp}from'./studio-app';import{createRoot}from'react-dom/client';createRoot(document.getElementById('root')).render(<StudioApp/>);", loader: 'tsx', resolveDir: path.resolve(__dirname, '../../app') },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  }).outputFiles[0].text;
}

for (const storageAvailable of [true, false]) test(`real task page combines account, status and search with storage ${storageAvailable ? 'remembered on reload' : 'read/write failures'}`, { timeout: 60000 }, async t => {
  const executablePath = process.env.CHROMIUM_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], requests = [], at = '2026-10-21T00:00:00.000Z';
  page.on('pageerror', error => errors.push(error.message));
  const rows = [
    { id: 'a1', product_name: '商品A 成片', tiktok_account_name: 'AlphaShop', status: 'video_ready' },
    { id: 'a2', product_name: '商品A 进行中', tiktok_account_name: 'AlphaShop', status: 'video_generating' },
    { id: 'b1', product_name: '商品B', tiktok_account_name: 'BetaShop', status: 'video_generating' },
  ].map(row => ({ ...row, title: row.product_name, provider: 'seedance-bridge', created_at: at, review_status: 'pending' }));
  const workspace = { products: [], gems: [], tasks: [], taskCounts: { total: 3, active: 2, review: 1, completed: 0, attention: 0 },
    schedules: [], tiktokAccounts: ['AlphaShop', 'BetaShop', 'EmptyShop'].map(name => ({ id: name, name })),
    referenceRemixTasks: [], scriptPipelineTasks: [], referenceRemixSettings: {}, integrations: {} };
  if (!storageAvailable) await page.addInitScript(() => {
    for (const method of ['getItem', 'setItem']) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function(key, ...args) {
        if (key === 'flowcut-task-account-v1') throw new DOMException('Storage denied', 'SecurityError');
        return original.call(this, key, ...args);
      };
    }
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/workspace') return route.fulfill({ json: workspace });
    if (url.pathname === '/api/tasks/stats') return route.fulfill({ json: { day: '2026-10-21', total: 0, accounts: [] } });
    if (url.pathname === '/api/tasks') {
      const params = Object.fromEntries(url.searchParams); requests.push(params);
      const tasks = rows.filter(row => (!params.account || row.tiktok_account_name === params.account)
        && (params.status === 'all' || params.status === 'review' && row.status === 'video_ready')
        && (!params.q || row.product_name.includes(params.q)));
      return route.fulfill({ json: { tasks, nextCursor: null } });
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  const open = async saved => {
    await page.goto('http://task-accounts.test');
    if (saved !== undefined) await page.evaluate(value => localStorage.setItem('flowcut-task-account-v1', value), saved);
    await page.addStyleTag({ content: fs.readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8').replace('@import "tailwindcss";', '') });
    await page.addScriptTag({ content: studioBundle() });
    await page.locator('.nav-list').getByRole('button', { name: /任务队列/ }).click();
    await page.getByLabel('按 TK 账号筛选任务').waitFor();
  };
  const waitForRows = count => page.waitForFunction(count => document.querySelectorAll('.tasks-table > .table-row').length === count, count);
  await open(storageAvailable ? 'alphashop' : undefined);
  const account = page.getByLabel('按 TK 账号筛选任务');
  assert.deepEqual(await account.locator('option').allTextContents(), ['全部账号', 'AlphaShop', 'BetaShop', 'EmptyShop']);
  if (storageAvailable) {
    await page.waitForFunction(() => document.querySelector('[aria-label="按 TK 账号筛选任务"]').value === 'AlphaShop');
    await waitForRows(2);
  }
  await account.selectOption('AlphaShop'); await waitForRows(2);
  await page.getByRole('group', { name: '筛选任务' }).getByRole('button', { name: '待检查', exact: true }).click();
  await waitForRows(1);
  await page.getByLabel('搜索任务').fill('找不到');
  await page.getByText('没有匹配的任务', { exact: true }).waitFor();
  assert.equal(requests.at(-1).account, 'AlphaShop'); assert.equal(requests.at(-1).status, 'review'); assert.equal(requests.at(-1).q, '找不到');
  await account.selectOption('BetaShop');
  await page.getByLabel('搜索任务').fill('');
  await page.getByRole('group', { name: '筛选任务' }).getByRole('button', { name: '全部', exact: true }).click();
  await waitForRows(1); assert.equal(await page.locator('.tasks-table .task-product-copy b').textContent(), '商品B');
  assert.equal(requests.at(-1).account, 'BetaShop');
  if (storageAvailable && process.env.FLOWCUT_TASK_FILTER_SCREENSHOT) await page.screenshot({ path: process.env.FLOWCUT_TASK_FILTER_SCREENSHOT, fullPage: true });
  await open();
  await page.waitForFunction(expected => document.querySelector('[aria-label="按 TK 账号筛选任务"]').value === expected, storageAvailable ? 'BetaShop' : '');
  await waitForRows(storageAvailable ? 1 : 3);
  await account.selectOption('EmptyShop'); await page.getByText('没有匹配的任务', { exact: true }).waitFor();
  await account.selectOption(''); await waitForRows(3);
  if (storageAvailable) {
    assert.equal(await page.evaluate(() => localStorage.getItem('flowcut-task-account-v1')), '');
    await open('RemovedShop'); await waitForRows(3); assert.equal(await account.inputValue(), '');
  }
  assert.deepEqual(errors, []);
});
