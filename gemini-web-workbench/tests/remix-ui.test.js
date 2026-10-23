const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
const {chromium}=require('../../vendor/publisher/node_modules/playwright-core');
const at=new Date().toISOString();
const child=(id,index,round,extra={})=>({id,task_role:'clip',batch_parent_id:'group',batch_index:index,batch_round:round,status:'video_ready',provider:'seedance-bridge',duration:index===1?15:9,region:'印尼',shooting_style:'',tiktok_account_name:'隔离TK',review_status:'pending',download_path:'C:/isolated/'+id+'.mp4',created_at:at,remix_segment_start:index===1?0:15,remix_segment_end:index===1?15:24,...extra});
test('remix page shows duration plan, locked instructions, version selection and group-only review',{timeout:60000},async t=>{
  const executablePath=process.env.CHROMIUM_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const browser=await chromium.launch({executablePath});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1100}});
  const errors=[],actions=[],native=[],posts=[];page.on('pageerror',e=>errors.push(e.message));
  const group={id:'group',task_role:'remix',title:'隔离商品 · 爆款复刻',status:'remix_segmented',batch_size:2,provider:'gemini-web',region:'印尼',tiktok_account_name:'隔离TK',created_at:at,remix_video_seconds:24,remix_script:'已保存原脚本全文',product_external_id:'1735360337668113923',children:[child('a',1,1),child('b',2,1),child('c',1,2,{status:'video_generating',download_path:null})]};
  await page.exposeFunction('nativeCall',(action,id)=>native.push([action,id]));
  await page.addInitScript(()=>{window.flowcutDesktop={openReviewVideo:id=>window.nativeCall('preview',id),finishRemix:id=>window.nativeCall('finish',id),setQueueRunning:async()=>{},seedanceSetRunning:async()=>{}};});
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.pathname==='/api/reference-remix') {
      if(req.method()==='PATCH') {const b=req.postDataJSON();actions.push(b);if(b.action==='check')group.children.find(c=>c.id===b.clipId).segment_checked_at=at;return route.fulfill({json:{ok:true}});}
      if(req.method()==='POST'){posts.push(req.postDataBuffer().toString());return route.fulfill({status:201,json:{id:'created'}});}
      return route.fulfill({json:{groups:[group],gem:{content:'隔离测试的锁定指令全文'}}});
    }
    return route.fulfill({contentType:'text/html',body:'<div id="root"></div>'});
  });
  const code=esbuild.buildSync({stdin:{contents:`import {ReferenceRemixPage} from './reference-remix-page';import{createRoot}from'react-dom/client';createRoot(document.getElementById('root')).render(<ReferenceRemixPage tasks={[]} settings={{region:'印尼',duration:15}} geminiAccounts={[{id:'acc',name:'隔离Gemini',authenticated:true}]} defaultGeminiAccountId="acc" tiktokAccounts={[{id:'tk',name:'隔离TK',created_at:'${at}'}]} integrations={{gemini:true,geminiMode:'web'}} onReload={async()=>{}} onNotice={()=>{}}/>);`,loader:'tsx',resolveDir:path.resolve(__dirname,'../../app')},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
  await page.goto('http://127.0.0.1:45992');await page.addStyleTag({content:fs.readFileSync(path.resolve(__dirname,'../../app/globals.css'),'utf8').replace('@import "tailwindcss";','')});await page.addScriptTag({content:code});
  await page.locator('.remix-group-panel').waitFor();assert.equal(await page.getByRole('button',{name:'通过检查并送入发布目录'}).count(),0);
  assert.equal(await page.getByLabel('第1段版本').inputValue(),'a','default is latest downloaded, not latest running');
  assert.equal(await page.getByRole('button',{name:'拼接并放入 TK 目录'}).isDisabled(),true);
  await page.locator('.remix-segment').first().getByRole('button',{name:'预览视频',exact:true}).click();assert.deepEqual(native[0],['preview','a']);
  await page.locator('.remix-segment').first().getByRole('button',{name:'这段可以',exact:true}).click();await page.locator('.remix-segment').first().getByRole('button',{name:'✓ 这段可以'}).waitFor();
  await page.locator('.remix-segment').nth(1).getByRole('button',{name:'这段可以',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.remix-group-actions button.primary').disabled);
  await page.getByRole('button',{name:'拼接并放入 TK 目录'}).click();await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.remix-group-actions button.primary').disabled);assert.ok(native.some(c=>c[0]==='finish'));
  await page.getByText('查看指令全文',{exact:true}).click();assert.equal(await page.locator('.locked-gem-card pre').textContent(),'隔离测试的锁定指令全文');
  await page.getByLabel('口播语言',{exact:true}).selectOption('follow-reference');assert.match(await page.locator('.remix-config-grid').textContent(),/跟随原视频/);
  await page.locator('input[type=file][accept^="video/"]').setInputFiles({name:'ref.mp4',mimeType:'video/mp4',buffer:Buffer.from('fake video')});
  await page.locator('.remix-drop video').evaluate(video=>{Object.defineProperty(video,'duration',{value:24});video.dispatchEvent(new Event('loadedmetadata'));});
  assert.match(await page.locator('.remix-file-caption').textContent(),/24 秒 → 2 段：15 秒 \+ 9 秒，生成 2 条视频/);
  await page.locator('input[type=file][accept^="image/"]').setInputFiles({name:'1735360337668113923.png',mimeType:'image/png',buffer:Buffer.from('image')});
  await page.getByRole('button',{name:'开始自动复刻 ↗'}).click();await page.waitForFunction(()=>!document.querySelector('.remix-options button.primary').disabled);assert.equal(posts.length,1);assert.match(posts[0],/name="videoSeconds"\r\n\r\n24/);assert.match(posts[0],/follow-reference/);assert.doesNotMatch(posts[0],/saveToLibrary/);
  if(process.env.FLOWCUT_REMIX_SCREENSHOT)await page.screenshot({path:process.env.FLOWCUT_REMIX_SCREENSHOT,fullPage:true});
  assert.deepEqual(errors,[]);assert.equal(actions.filter(a=>a.action==='check').length,2);
});
