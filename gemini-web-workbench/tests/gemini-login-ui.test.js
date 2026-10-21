const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { chromium } = require('../../vendor/publisher/node_modules/playwright-core');

test('Firefox login dialog opens, confirms, retries failures, cancels and links missing-browser installation', async () => {
  const executablePath = process.env.CHROMIUM_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage(); await page.setContent('<div id="root"></div>');
    const bundle = require('esbuild').buildSync({ stdin: { contents: `
      import {useState} from 'react';import {createRoot} from 'react-dom/client';import {GeminiLoginDialog} from './gemini-login';
      const initial={id:'flow',accountId:'existing',name:'测试账号',mode:'relogin',phase:'ready',busy:false,error:'',downloadUrl:'https://www.mozilla.org/firefox/new/'};
      window.calls=[];function App(){const [flow,setFlow]=useState(initial);window.patchFlow=value=>setFlow(current=>({...current,...value}));
        return <GeminiLoginDialog flow={flow} busy={false} onAction={action=>{window.calls.push(action);if(action==='login-open')setFlow({...flow,phase:'waiting-for-user'});if(action==='login-cancel')setFlow(null);}}/>;}
      createRoot(document.getElementById('root')).render(<App/>);`, loader: 'tsx', resolveDir: path.resolve(__dirname, '../../app') }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text;
    await page.addScriptTag({ content: bundle });
    await page.getByRole('dialog').waitFor(); assert.match(await page.getByRole('dialog').innerText(), /导入前会确认覆盖/);
    assert.equal(await page.getByRole('button', { name: '我已登录', exact: true }).isEnabled(), false);
    await page.getByRole('button', { name: '打开 Firefox 登录窗口', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '我已登录', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: '我已登录', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => calls), ['login-open', 'login-import']);
    await page.evaluate(() => patchFlow({ phase: 'failed', error: '原登录保留' }));
    await page.getByRole('alert').waitFor(); assert.equal(await page.getByRole('button', { name: '打开 Firefox 登录窗口', exact: true }).isEnabled(), true);
    await page.evaluate(() => patchFlow({ phase: 'missing', error: '' }));
    assert.equal(await page.getByRole('link', { name: 'Firefox 官网下载安装' }).getAttribute('href'), 'https://www.mozilla.org/firefox/new/');
    await page.getByRole('button', { name: '取消', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal((await page.evaluate(() => calls)).at(-1), 'login-cancel');
  } finally { await browser.close(); }
});
