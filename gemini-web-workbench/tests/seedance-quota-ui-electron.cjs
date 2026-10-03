const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const report = require('./helpers/electron-test-report.cjs');
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { partition: `quota-ui-${process.pid}` } });
  window.webContents.session.webRequest.onBeforeRequest((_, callback) => callback({ cancel: true }));
  try {
    const source = path.resolve(__dirname, '../../app/studio-app.tsx');
    const bundle = esbuild.buildSync({
      stdin: { contents: fs.readFileSync(source, 'utf8') + `
        import {createRoot} from 'react-dom/client';
        const quotaRoot = createRoot(document.getElementById('root'));
        function Harness({initial}: any) {
          const [state,setState] = useState(initial);
          return <SeedanceQuotaSummary state={state} onUpdated={setState} onError={message=>{throw Error(message)}} />;
        }
        let serial=0;
        window.renderQuotaTest = initial => quotaRoot.render(<Harness key={++serial} initial={initial} />);
      `, loader: 'tsx', resolveDir: path.dirname(source) },
      bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    }).outputFiles[0].text;
    await window.loadURL('about:blank');
    await window.webContents.executeJavaScript(`document.body.innerHTML='<div id="root"></div>';`);
    await window.webContents.executeJavaScript(bundle);
    const run = script => window.webContents.executeJavaScript(script, true);
    const wait = async script => {
      for (let n=0;n<100;n++) { if(await run(script)) return; await new Promise(r=>setTimeout(r,20)); }
      throw Error('UI did not reach expected state: '+script);
    };
    const account = (id,exhausted) => ({id,name:id,enabled:true,authenticated:true,preferredModel:'2000012',effectiveModel:exhausted?'':'2000012',fastExhaustedToday:exhausted,needsModelDecision:false,quotaDate:'2026-10-03'});
    const one={accountState:{allFastExhausted:false,items:[account('账号 A',true),account('账号 B',false)]}};
    await run(`renderQuotaTest(${JSON.stringify(one)})`);
    await wait(`document.body.innerText.includes('账号 B：今日尚未检测到上限')`);
    assert.equal(await run(`document.querySelectorAll('button').length`),0);
    const both=structuredClone(one);both.accountState.allFastExhausted=true;
    for(const a of both.accountState.items) {a.fastExhaustedToday=true;a.effectiveModel='';a.needsModelDecision=true;}
    const approved=structuredClone(both);approved.accountState.items[0].effectiveModel='2000004';approved.accountState.items[0].fallbackDecision='standard';
    await run(`window.quotaCalls=[];window.flowcutDesktop={seedanceDecideFastFallback:async(...args)=>{quotaCalls.push(args);return ${JSON.stringify(approved)}}};renderQuotaTest(${JSON.stringify(both)})`);
    await wait(`document.querySelectorAll('button').length===4`);
    await run(`document.querySelector('button').click()`);
    await wait(`!!document.querySelector('dialog[open]')`);
    assert.equal(await run(`quotaCalls.length`),0);
    await run(`document.querySelector('dialog .primary').click()`);
    await wait(`document.body.innerText.includes('已按你的确认改用 2.0')`);
    assert.deepEqual(await run(`quotaCalls`),[['账号 A','standard','2026-10-03']]);
    assert.equal(await run(`document.querySelectorAll('button').length`),0);
    report({ pass:true, scenario:'real React quota UI names both accounts, asks only after both limits, and sends exact approved IPC choice' });
  } finally { window.destroy(); }
  app.exit(0);
}).catch(error=>{report({pass:false,error:String(error.stack||error)});app.exit(1);});
