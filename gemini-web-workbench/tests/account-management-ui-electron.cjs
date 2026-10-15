const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const report = require('./helpers/electron-test-report.cjs');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  try {
    const source = path.resolve(__dirname, '../../app/studio-app.tsx');
    const bundle = esbuild.buildSync({ stdin: { contents: fs.readFileSync(source, 'utf8') + `
      import {createRoot} from 'react-dom/client';
      createRoot(document.getElementById('root')).render(<SettingsPage integrations={{}} onUpdated={async()=>{}} onNotice={()=>{}} />);
    `, loader: 'tsx', resolveDir: path.dirname(source) }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text;
    await window.loadURL('about:blank');
    const run = script => window.webContents.executeJavaScript(script, true);
    await run(`document.body.innerHTML='<div id="root"></div>';
      window.calls=[];
      window.accounts=[{id:'gem-a',name:'Gemini A',authenticated:true},{id:'gem-b',name:'Gemini B',authenticated:true}];
      window.seed={ready:true,authenticated:true,settings:{running:true},tasks:[],accountState:{items:[{id:'ad-a',name:'广告户 A',authenticated:true,enabled:true},{id:'ad-b',name:'广告户 B',authenticated:true,enabled:true}]}};
      window.failRename=false;
      const change=(kind,id,key,value)=>{calls.push([kind,id,key,value]);if(key==='name'&&failRename)throw Error('模拟保存失败');(kind==='gemini'?accounts:seed.accountState.items).find(a=>a.id===id)[key]=value;return kind==='gemini'?{accounts}:seed};
      window.flowcutDesktop={getState:async()=>({accounts,defaultAccountId:'gem-a',bridge:{activeJobs:[]}}),seedanceState:async()=>seed,
        renameAccount:async(id,name)=>change('gemini',id,'name',name),setAccountEnabled:async(id,enabled)=>change('gemini',id,'enabled',enabled),
        seedanceRenameAccount:async(id,name)=>change('seedance',id,'name',name),seedanceSetAccountEnabled:async(id,enabled)=>change('seedance',id,'enabled',enabled)};
      window.fetch=async(url,options)=>{if(options?.method&&options.method!=='GET')throw Error('Unexpected provider form submit');return {ok:true,json:async()=>({gemini:{mode:'web',runtime:{online:true,accounts,queueRunning:true}},seedance:{mode:'local-api'}})}};
      window.row=name=>[...document.querySelectorAll('article')].find(el=>el.querySelector('b')?.textContent===name);
      window.clickButton=(el,name)=>{const b=[...el.querySelectorAll('button')].find(b=>b.textContent===name);if(!b)throw Error('Missing '+name);b.click()};
      window.inputName=(el,value)=>{const i=el.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,value);i.dispatchEvent(new Event('input',{bubbles:true}));};
      true;
    `);
    await run(bundle);
    const wait = async script => { for(let i=0;i<100;i++){if(await run(script))return;await new Promise(r=>setTimeout(r,25));}throw Error('UI timeout: '+script); };
    await wait(`!!row('Gemini A') && !!row('广告户 A')`);
    for (const [kind, original, renamed] of [['gemini','Gemini A','主账号已改名'],['seedance','广告户 A','广告户已改名']]) {
      await run(`clickButton(row(${JSON.stringify(original)}),'暂停使用')`);
      await wait(`row(${JSON.stringify(original)}).textContent.includes('已暂停使用') && row(${JSON.stringify(original)}).textContent.includes('恢复使用')`);
      await run(`clickButton(row(${JSON.stringify(original)}),'编辑名称');`);
      await wait(`!!document.querySelector('.account-name-editor input')`);
      await run(`inputName(document.querySelector('.account-name-editor:has(input)'),'  ')`);
      await run(`clickButton(document.querySelector('.account-name-editor:has(input)'),'保存名称')`);
      await wait(`document.body.innerText.includes('账号名称不能为空')`);
      await run(`inputName(document.querySelector('.account-name-editor:has(input)'),${JSON.stringify(renamed)})`);
      await run(`clickButton(document.querySelector('.account-name-editor:has(input)'),'保存名称')`);
      await wait(`!!row(${JSON.stringify(renamed)}) && !row(${JSON.stringify(renamed)}).querySelector('input')`);
      await run(`clickButton(row(${JSON.stringify(renamed)}),'恢复使用')`);
      await wait(`row(${JSON.stringify(renamed)}).textContent.includes('暂停使用') && !row(${JSON.stringify(renamed)}).textContent.includes('已暂停使用')`);
      assert.deepEqual(await run(`calls.filter(c=>c[0]===${JSON.stringify(kind)})`), [[kind,kind==='gemini'?'gem-a':'ad-a','enabled',false],[kind,kind==='gemini'?'gem-a':'ad-a','name',renamed],[kind,kind==='gemini'?'gem-a':'ad-a','enabled',true]]);
    }
    await run(`failRename=true;clickButton(row('主账号已改名'),'编辑名称')`);
    await wait(`!!document.querySelector('.account-name-editor input')`);
    await run(`inputName(document.querySelector('.account-name-editor:has(input)'),'不能误报成功')`);
    await run(`clickButton(document.querySelector('.account-name-editor:has(input)'),'保存名称')`);
    await wait(`document.querySelector('.account-name-editor').textContent.includes('模拟保存失败')`);
    assert.equal(await run(`accounts[0].name`),'主账号已改名');
    report({ pass:true, scenario:'Both account cards pause/resume, edit names, reject blank names and retain editor on save failure without submitting the provider form' });
  } finally { window.destroy(); }
  app.exit(0);
}).catch(error=>{report({pass:false,error:String(error.stack||error)});app.exit(1);});
