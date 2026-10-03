const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),esbuild=require('esbuild');
const report=require('./helpers/electron-test-report.cjs');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,webPreferences:{partition:'product-ui-'+process.pid}});
 window.webContents.session.webRequest.onBeforeRequest((_,cb)=>cb({cancel:true}));
 try{
  const source=path.resolve(__dirname,'../../app/studio-app.tsx');
  const bundle=esbuild.buildSync({stdin:{contents:fs.readFileSync(source,'utf8')+"\nimport {createRoot} from 'react-dom/client';const root=createRoot(document.getElementById('root'));let generation=0;window.remountStudio=()=>root.render(<StudioApp key={++generation}/>);window.remountStudio();",loader:'tsx',resolveDir:path.dirname(source)},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
  await window.loadURL('about:blank');
  const run=async s=>{try{return await window.webContents.executeJavaScript(s,true);}catch(e){throw Error(e.message+"\nScript: "+s);}};
  const wait=async s=>{for(let n=0;n<150;n++){if(await run(s))return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout: '+s);};
  const products=[{id:'first',name:'商品一',external_id:'173627418556382511',created_at:new Date().toISOString(),images:[{id:'img1',object_key:'products/first/one'}]},{id:'second',name:'商品二',external_id:'1737206719748015225',created_at:new Date().toISOString(),images:[{id:'img2',object_key:'products/second/two'},{id:'img3',object_key:'products/second/three'}]}];
  const workspace={products,gems:[{id:'gem',name:'测试模板',content:'test'},{id:'gem2',name:'另一个模板',content:'second'}],tiktokAccounts:[{id:'tk',name:'测试账号'},{id:'tk2',name:'第二账号'}],tasks:[],schedules:[],referenceRemixTasks:[],scriptPipelineTasks:[],referenceRemixSettings:{duration:15,region:'印尼'},integrations:{gemini:true,geminiMode:'web',geminiRuntime:{online:true,authenticated:true,queueRunning:true},seedance:true}};
  await run("document.body.innerHTML='<div id=\"root\"></div>';window.calls=[];const saved=new Map();Object.defineProperty(window,'localStorage',{value:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)}});window.fixture="+JSON.stringify(workspace)+";window.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url==='/api/workspace'?fixture:url==='/api/tasks'?{id:'new-task'}:{}}};true;");
  await run(bundle);
  await wait("!!document.querySelector('.sidebar')");
  const library=()=>run("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('商品库')&&b.closest('.sidebar')).click()");
  await library();await wait("document.querySelectorAll('.product-create').length===2");
  await run("[...document.querySelectorAll('.product-card')].find(c=>c.textContent.includes('1737206719748015225')).querySelector('.product-create').click()");
  await wait("!!document.querySelector('.library-product-picker')");
  assert.equal(await run("document.querySelector('.library-product-picker').dataset.productId"),'second');
  assert.equal(await run("document.querySelector('.chosen-product-detail').textContent.includes('1737206719748015225')"),true);
  assert.equal(await run("document.querySelectorAll('[aria-label=\"已带入的商品图片\"] img').length"),2);
  // Navigation preserves the product and source mode; choosing another card replaces both images and ID.
  await library();await wait("document.querySelectorAll('.product-create').length===2");
  await run("[...document.querySelectorAll('.product-card')].find(c=>c.textContent.includes('173627418556382511')).querySelector('.product-create').click()");await wait("!!document.querySelector('.library-product-picker')");
  assert.equal(await run("document.querySelector('.library-product-picker').dataset.productId"),'first');
  assert.equal(await run("document.querySelectorAll('[aria-label=\"已带入的商品图片\"] img').length"),1);
  assert.equal(await run("calls.some(c=>c.options?.method==='POST')"),false);
  const click=text=>run("[...document.querySelectorAll('button')].find(b=>b.textContent.includes("+JSON.stringify(text)+")).click()");
  const selected=()=>run("document.querySelector('.library-product-picker')?.dataset.productId");
  await click('看图更换商品');await wait("!!document.querySelector('dialog[open]')");
  assert.equal(await run("document.querySelectorAll('.product-image-option img').length"),2);
  assert.equal(await run("document.querySelector('.product-image-option.selected').dataset.productId"),'first');
  await run("const input=document.querySelector('[aria-label=\"搜索待选商品\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'商品二');input.dispatchEvent(new Event('input',{bubbles:true}));");
  await wait("document.querySelectorAll('.product-image-option').length===1");
  await run("document.querySelector('.product-image-option').click()");await wait("!document.querySelector('dialog')");assert.equal(await selected(),'second');
  await click('看图更换商品');await wait("!!document.querySelector('dialog[open]')");await click('取消');await wait("!document.querySelector('dialog')");assert.equal(await selected(),'second');
  await click('加入并发任务');await wait("calls.filter(c=>c.url==='/api/tasks').length===1 && !document.querySelector('.composer-foot button').disabled");
  assert.equal(await selected(),'second');
  await run("for(const [value] of [['gem2'],['第二账号']]){const select=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value===value));Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,value);select.dispatchEvent(new Event('change',{bubbles:true}));}");
  await click('加入并发任务');await wait("calls.filter(c=>c.url==='/api/tasks').length===2 && !document.querySelector('.composer-foot button').disabled");
  const requests=await run("calls.filter(c=>c.url==='/api/tasks').map(c=>JSON.parse(c.options.body))");
  assert.deepEqual(requests.map(r=>r.productId),['second','second']);assert.equal(requests[1].gemId,'gem2');assert.equal(requests[1].tiktokAccountName,'第二账号');
  assert.deepEqual(requests[1].imageKeys,['products/second/two','products/second/three']);
  assert.equal(await run("calls.some(c=>c.url==='/api/products')"),false);
  await run('remountStudio()');await wait("document.querySelector('.library-product-picker')?.dataset.productId==='second'");
  // A fresh upload becomes the selected library item after the first successful task.
  await click('上传新商品');await wait("!!document.querySelector('.quick-upload-zone input')");
  await run("const fileInput=document.querySelector('.quick-upload-zone input');const transfer=new DataTransfer();transfer.items.add(new File(['image'],'1737206719748015225.png',{type:'image/png'}));fileInput.files=transfer.files;fileInput.dispatchEvent(new Event('change',{bubbles:true}));const originalFetch=window.fetch;window.fetch=async(url,options)=>url==='/api/products'?(calls.push({url,options}),{ok:true,json:async()=>({id:'first',reused:true,imageKeys:['products/first/one']})}):originalFetch(url,options);true;");
  await wait("!document.querySelector('.composer-foot button').disabled");await click('加入并发任务');
  await wait("document.querySelector('.library-product-picker')?.dataset.productId==='first'");
  await click('加入并发任务');await wait("calls.filter(c=>c.url==='/api/tasks').length===4 && !document.querySelector('.composer-foot button').disabled");
  assert.equal(await run("calls.filter(c=>c.url==='/api/products').length"),1);
  assert.deepEqual(await run("calls.filter(c=>c.url==='/api/tasks').slice(2).map(c=>JSON.parse(c.options.body).productId)"),['first','first']);
  await run('remountStudio()');await wait("document.querySelector('.library-product-picker')?.dataset.productId==='first'");
  await run("fixture.products=fixture.products.filter(p=>p.id!=='first');remountStudio();");await wait("document.querySelector('.library-product-picker')?.dataset.productId===''");
  assert.equal(await run("document.querySelector('.composer-foot button').disabled"),true);
  report({pass:true,scenario:'Image picker search, selected badge, cancellation; repeat tasks with different Gem/accounts retain exact images; remount restores selection; upload switches to reusable library product; deleted selection requires explicit choice'});

 }finally{window.destroy();}
 app.exit(0);
}).catch(error=>{report({pass:false,error:String(error.stack||error)});app.exit(1);});
