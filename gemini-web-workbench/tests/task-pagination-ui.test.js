const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { chromium } = require('../../vendor/publisher/node_modules/playwright-core');

test('task page loads more, retains loaded pages on polling, and sends full-dataset filters', async t => {
  const executablePath = process.env.CHROMIUM_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  t.after(() => browser.close());
  const page = await browser.newPage();
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: 'task-' + i, name: 'product-' + i, group: i < 30 ? 'review' : 'active' }));
  const requests = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/tasks') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    const params = url.searchParams, start = Number(params.get('cursor') || 0);
    requests.push(Object.fromEntries(params));
    const filtered = rows.filter(row => (params.get('status') === 'all' || row.group === params.get('status')) && (!params.get('q') || row.name === params.get('q')));
    return route.fulfill({ json: { tasks: filtered.slice(start, start + 50), nextCursor: filtered.length > start + 50 ? String(start + 50) : null } });
  });
  await page.goto('http://task-fixture.test');
  const bundle = require('esbuild').buildSync({ stdin: { contents: `
    import {createRoot} from 'react-dom/client'; import {useState} from 'react'; import {useTaskPage} from './use-task-page';
    function App(){const [filter,setFilter]=useState('all'),[q,setQ]=useState('');const result=useTaskPage([],filter,q,'');return <><input aria-label="搜索任务" value={q} onChange={e=>{setQ(e.target.value);result.resetPages()}}/><select aria-label="筛选任务" value={filter} onChange={e=>{setFilter(e.target.value);result.resetPages()}}><option>all</option><option>review</option></select><span id="count">{result.tasks.length}</span><div id="ids">{result.tasks.map(task=>task.id).join(',')}</div>{result.hasMore&&<button disabled={result.loading} onClick={result.loadMore}>加载更多</button>}{result.error&&<p role="alert">{result.error}</p>}</>}; createRoot(document.getElementById('root')).render(<App/>);`, loader: 'tsx', resolveDir: path.resolve(__dirname, '../../app') }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text;
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => document.querySelector('#count').textContent === '50');
  await page.getByRole('button', { name: '加载更多' }).click();
  await page.waitForFunction(() => document.querySelector('#count').textContent === '100');
  const beforePoll = requests.length;
  await new Promise(resolve => setTimeout(resolve, 5200));
  assert.equal(await page.locator('#count').textContent(), '100');
  assert.ok(requests.length >= beforePoll + 2, 'polling refreshes both loaded pages');
  assert.ok(requests.some(request => request.cursor === '50'));
  await page.getByLabel('搜索任务').fill('product-150');
  await page.waitForFunction(() => document.querySelector('#ids').textContent === 'task-150');
  assert.equal(requests.at(-1).q, 'product-150');
  await page.getByLabel('搜索任务').fill('');
  await page.getByLabel('筛选任务').selectOption('review');
  await page.waitForFunction(() => document.querySelector('#count').textContent === '30');
  assert.equal(requests.at(-1).status, 'review'); assert.equal(requests.at(-1).cursor, undefined);
});
