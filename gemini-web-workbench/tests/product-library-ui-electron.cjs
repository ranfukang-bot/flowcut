const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),esbuild=require('esbuild');
const report=require('./helpers/electron-test-report.cjs');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,webPreferences:{partition:'product-ui-'+process.pid}});
 window.webContents.session.webRequest.onBeforeRequest((_,cb)=>cb({cancel:true}));
 try{
  const source=path.resolve(__dirname,'../../app/studio-app.tsx');
  const bundle=esbuild.buildSync({stdin:{contents:fs.readFileSync(source,'utf8')+"\nimport {createRoot} from 'react-dom/client';createRoot(document.getElementById('root')).render(<StudioApp/>);",loader:'tsx',resolveDir:path.dirname(source)},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
  await window.loadURL('about:blank');
  const run=s=>window.webContents.executeJavaScript(s,true);
  const wait=async s=>{for(let n=0;n<150;n++){if(await run(s))return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout: '+s);};
  const products=[{id:'first',name:'商品一',external_id:'173627418556382511',created_at:new Date().toISOString(),images:[{id:'img1',object_key:'products/first/one'}]},{id:'second',name:'商品二',external_id:'1737206719748015225',created_at:new Date().toISOString(),images:[{id:'img2',object_key:'products/second/two'},{id:'img3',object_key:'products/second/three'}]}];
  const workspace={products,gems:[{id:'gem',name:'测试模板',content:'test'}],tiktokAccounts:[{id:'tk',name:'测试账号'}],tasks:[],schedules:[],referenceRemixTasks:[],scriptPipelineTasks:[],referenceRemixSettings:{duration:15,region:'印尼'},integrations:{gemini:true,geminiMode:'web',geminiRuntime:{online:true,authenticated:true,queueRunning:true},seedance:true}};
  await run("document.body.innerHTML='<div id=\"root\"></div>';window.calls=[];window.fixture="+JSON.stringify(workspace)+";window.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url==='/api/workspace'?fixture:url==='/api/tasks'?{id:'new-task'}:{}}};true;");
  await run(bundle);
  await wait("!!document.querySelector('.sidebar')");
  const library=()=>run("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('商品库')&&b.closest('.sidebar')).click()");
  await library();await wait("document.querySelectorAll('.product-create').length===2");
  await run("[...document.querySelectorAll('.product-card')].find(c=>c.textContent.includes('1737206719748015225')).querySelector('.product-create').click()");
  await wait("!!document.querySelector('.library-product-picker')");
  assert.equal(await run("document.querySelector('.library-product-picker select').value"),'second');
  assert.equal(await run("document.querySelector('.library-product-picker small').textContent.includes('1737206719748015225')"),true);
  assert.equal(await run("document.querySelectorAll('[aria-label=\"已带入的商品图片\"] img').length"),2);
  // Navigation preserves the product and source mode; choosing another card replaces both images and ID.
  await library();await wait("document.querySelectorAll('.product-create').length===2");
  await run("[...document.querySelectorAll('.product-card')].find(c=>c.textContent.includes('173627418556382511')).querySelector('.product-create').click()");await wait("!!document.querySelector('.library-product-picker')");
  assert.equal(await run("document.querySelector('.library-product-picker select').value"),'first');
  assert.equal(await run("document.querySelectorAll('[aria-label=\"已带入的商品图片\"] img').length"),1);
  assert.equal(await run("calls.some(c=>c.options?.method==='POST')"),false);
  report({pass:true,scenario:'Real StudioApp navigation opens selected product in creation with exact ID and images; switching product refreshes selection; no task created by navigation'});
 }finally{window.destroy();}
 app.exit(0);
}).catch(error=>{report({pass:false,error:String(error.stack||error)});app.exit(1);});
