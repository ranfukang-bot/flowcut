const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { modelRuntimeSource } = require('../src/gemini-model-selection');
const { callModelPage } = require('../src/model-selection-errors');
const { runWithActivatedGeminiWorker } = require('../src/gemini-worker-activation');
const report = require('./helpers/electron-test-report.cjs');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { partition: `model-selection-${process.pid}`, sandbox: true } });
  try {
    const fixture = `<button data-test-id="bard-mode-menu-button">Flash</button>
      <div role="menu" id="models" hidden><button role="menuitemradio" aria-checked="false">3.5 Flash-Lite</button><button role="menuitemradio" aria-checked="true">3.8 Flash</button><button role="menuitemradio" aria-checked="false">3.1 Pro</button><button role="menuitem" aria-haspopup="menu">思考等级</button></div>
      <div role="menu" id="thinking" hidden><button role="menuitemradio" aria-checked="true">低</button><button role="menuitemradio" aria-checked="false">高</button></div><script>
      window.clicks=[];const picker=document.querySelector('button'),models=document.querySelector('#models'),thinking=document.querySelector('#thinking');
      const close=()=>{models.hidden=thinking.hidden=true;};picker.onclick=()=>{clicks.push('menu');models.hidden=false;};
      document.querySelector('[aria-haspopup]').onclick=()=>{thinking.hidden=false;};
      models.querySelectorAll('[role="menuitemradio"]').forEach(item=>item.onclick=()=>{clicks.push(item.textContent);models.querySelectorAll('[role="menuitemradio"]').forEach(el=>el.setAttribute('aria-checked',String(el===item)));picker.textContent=item.textContent;thinking.children[0].setAttribute('aria-checked','true');thinking.children[1].setAttribute('aria-checked','false');close();});
      [...thinking.children].forEach(item=>item.onclick=()=>{clicks.push(item.textContent);[...thinking.children].forEach(el=>el.setAttribute('aria-checked',String(el===item)));close();});document.addEventListener('keydown',event=>{if(event.key==='Escape')close();});</script>`;
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fixture));
    const run = script => window.webContents.executeJavaScript(script, true);
    await run(modelRuntimeSource + '\ntrue');
    let started = performance.now();
    const fast = await run(`__flowcutModelPicker.inspect({mode:'auto',thinking:''},{models:['3.5 Flash-Lite','3.8 Flash','3.1 Pro']},false)`);
    const fastMs = performance.now() - started;
    assert.equal(fast.needsMenu, false); assert.deepEqual(await run('clicks'), []); assert.ok(fastMs < 500);
    report({ pass: true, scenario: 'matching model has no clicks or activation', elapsedMs: fastMs });
    await run(`document.querySelectorAll('#models [role="menuitemradio"]')[2].click();clicks=[];true`);
    started = performance.now();
    const changed = await runWithActivatedGeminiWorker({ workerWindow: window, action: () => run(`__flowcutModelPicker.ensure({mode:'auto',thinking:'高'},{checkThinking:true})`) });
    const switchMs = performance.now() - started;
    assert.equal(changed.model, '3.8 Flash'); assert.equal(changed.thinking, '高'); assert.ok(switchMs < 5000);
    report({ pass: true, scenario: 'hidden Electron activation switches model before restoring thinking', elapsedMs: switchMs });
    await assert.rejects(callModelPage(window, modelRuntimeSource, 'ensure', [{ mode: 'exact', name: 'missing-model', thinking: '' }]), { code: 'MODEL_SELECTION_FAILED' });
    await run(`__flowcutModelPicker.inspect = () => { throw new Error('temporary fixture script error'); }; true`);
    await assert.rejects(callModelPage(window, '', 'inspect'), { code: 'MODEL_SELECTION_RETRYABLE' });
    window.destroy();
    await assert.rejects(callModelPage(window, '', 'inspect'), { code: 'MODEL_SELECTION_RETRYABLE' });
    report({ pass: true, scenario: 'native model calls preserve deterministic codes and retry script/destruction errors' });
  } finally { if (!window.isDestroyed()) window.destroy(); }
  app.exit(0);
}).catch(error => { report({ pass: false, error: String(error.stack || error) }); app.exit(1); });
