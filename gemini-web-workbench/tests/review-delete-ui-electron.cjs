const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const esbuild=require('esbuild');const report=require('./helpers/electron-test-report.cjs');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const window=new BrowserWindow({show:false,webPreferences:{partition:`review-ui-${process.pid}`}});
  window.webContents.session.webRequest.onBeforeRequest((_,callback)=>callback({cancel:true}));
  try{
    const source=path.resolve(__dirname,'../../app/studio-app.tsx');
    const bundle=esbuild.buildSync({stdin:{contents:fs.readFileSync(source,'utf8')+`
      import {createRoot} from 'react-dom/client';
      const root=createRoot(document.getElementById('root'));let serial=0;
      window.renderReviewTest=(task,mode='drawer')=>root.render(mode==='drawer'
        ? <PromptDrawer key={++serial} task={task} gems={[]} onClose={()=>window.closedReview=true} onUpdated={async message=>{window.updatedReview=message}} />
        : <TasksPage key={++serial} tasks={[task]} onPreview={()=>{}} onDelete={()=>{}} onClearCompleted={()=>{}} onClearAll={()=>{}} />);
    `,loader:'tsx',resolveDir:path.dirname(source)},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
    await window.loadURL('about:blank');
    const run=s=>window.webContents.executeJavaScript(s,true);
    const wait=async s=>{for(let n=0;n<100;n++){if(await run(s))return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout: '+s);};
    await run(`document.body.innerHTML='<div id="root"></div>';window.calls=[];window.fetch=async()=>({ok:true,json:async()=>({day:'2026-10-03',total:0,accounts:[]})});window.flowcutDesktop={openReviewFolder:async id=>calls.push(['folder',id]),deletePendingReviewVideo:async(...args)=>calls.push(['delete',...args])};true;`);
    await run(bundle);
    const task={id:'fixture-task',status:'video_ready',review_status:'pending',download_path:'C:/fixture/review-videos/test.mp4',provider:'seedance-bridge',prompt:'test',product_external_id:'1737206719748015225',tiktok_account_name:'测试账号',title:'测试成片',gem_name:'测试 Gem'};
    await run(`renderReviewTest(${JSON.stringify(task)},'queue')`);
    await wait(`[...document.querySelectorAll('button')].some(b=>b.textContent==='审核')`);
    assert.equal(await run(`document.body.innerText.includes('查看视频')`),false);
    await run(`renderReviewTest(${JSON.stringify(task)})`);
    await wait(`document.body.innerText.includes('删除该任务并删除该视频')`);
    assert.equal(await run(`(()=>{const b=[...document.querySelectorAll('button')];return b.findIndex(x=>x.textContent==='删除该任务并删除该视频')===b.findIndex(x=>x.textContent==='重新生成该任务')+1})()`),true);
    const click=text=>run(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
    await click('打开临时存放目录');await wait(`calls.length===1`);
    assert.deepEqual(await run('calls'),[['folder','fixture-task']]);
    await wait(`![...document.querySelectorAll('button')].find(b=>b.textContent==='删除该任务并删除该视频').disabled`);
    await click('删除该任务并删除该视频');await wait(`!!document.querySelector('dialog[open]')`);
    assert.equal(await run(`document.querySelector('dialog').innerText.includes('不会重新生成')`),true);
    await click('取消');await wait(`!document.querySelector('dialog')`);assert.equal(await run('calls.length'),1);
    await click('删除该任务并删除该视频');await wait(`!!document.querySelector('dialog[open]')`);await click('确认');
    await wait('window.closedReview===true');assert.deepEqual(await run('calls'),[['folder','fixture-task'],['delete','fixture-task',true]]);
    await run(`renderReviewTest(${JSON.stringify({...task,review_status:'approved'})})`);await wait(`document.body.innerText.includes('成片已审核通过')`);
    assert.equal(await run(`document.body.innerText.includes('删除该任务并删除该视频')`),false);
    report({pass:true,scenario:'pending queue has review only; drawer opens exact task folder; delete cancellation and confirmation; released videos cannot be deleted'});
  }finally{window.destroy();}
  app.exit(0);
}).catch(error=>{report({pass:false,error:String(error.stack||error)});app.exit(1);});
