const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
const {chromium}=require('../../vendor/publisher/node_modules/playwright-core');

test('fission UI: independent navigation, 4-product form, confirmation, own uploads, paste mode, queue and details',{timeout:90000},async t=>{
  const executablePath=process.env.CHROMIUM_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const browser=await chromium.launch(executablePath?{executablePath}:{});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),at=new Date().toISOString();
  page.on('pageerror',error=>t.diagnostic(error.message));
  const products=[1,2,3,4].map(i=>({id:'p'+i,external_id:'173536033766811392'+i,name:'隔离商品 '+i,created_at:at,images:[{id:'img'+i,object_key:`products/p${i}/own.png`}]}));
  const workspace={products,gems:[{id:'mother',name:'测试母版 Gem',content:'母版'},{id:'variant',name:'测试变体 Gem',content:'变体'}],tasks:[],taskCounts:{total:0,active:0,review:0,completed:0,attention:0},schedules:[],tiktokAccounts:[{id:'tk',name:'隔离归档账号'}],referenceRemixTasks:[],scriptPipelineTasks:[],referenceRemixSettings:{duration:15,region:'印尼'},integrations:{gemini:true,geminiMode:'web',geminiRuntime:{online:true,authenticated:true,queueRunning:false},seedance:true}};
  const posts=[],uploads=[],batches=[];let failNext=false;
  const prompt='隔离母版：'+'用竖屏真实商品视频展示产品功能，保持自然光和真实生活场景，输出完整镜头与口播。'.repeat(15);
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname==='/api/workspace')return route.fulfill({json:workspace});
    if(url.pathname==='/api/tasks/stats')return route.fulfill({json:{day:'2026-10-20',total:0,accounts:[]}});
    if(url.pathname==='/api/media')return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=','base64')});
    if(url.pathname==='/api/fission'){
      if(request.method()==='POST'){
        const body=request.postDataJSON();posts.push(body);
        if(failNext){failNext=false;return route.fulfill({status:503,json:{error:'模拟丢失提交结果，请重试'}});}
        const children=body.products.map((row,index)=>({id:body.requestId+'-p'+(index+1),product_id:row.productId,product_name:products.find(p=>p.id===row.productId).name,product_external_id:products.find(p=>p.id===row.productId).external_id,product_image_key:`products/${row.productId}/own.png`,task_role:'fission_child',batch_parent_id:body.requestId,batch_index:index+1,provider:'seedance-bridge',duration:15,region:'印尼',shooting_style:'iPhone实拍质感',status:'video_ready',review_status:'pending',prompt,created_at:at,tiktok_account_name:'隔离归档账号'}));
        const batch={id:body.requestId,task_role:'fission',title:'多品裂变 · '+children.length+' 个商品',status:'fission_ready',prompt,children,region:'印尼',duration:15,provider:'gemini-web',created_at:at,tiktok_account_name:'隔离归档账号'};
        batches.unshift(batch);workspace.tasks=[batch];return route.fulfill({status:201,json:{id:body.requestId,created:true}});
      }
      return route.fulfill({json:{batches}});
    }
    if(url.pathname==='/api/products'&&request.method()==='POST'){uploads.push(request.postDataBuffer());return route.fulfill({json:{id:'p2',reused:true,imageKeys:['products/p2/new.png']}});}
    if(url.pathname==='/api/tasks'){
      const id=url.searchParams.get('id');return route.fulfill({json:id?(batches.flatMap(b=>[b,...b.children]).find(t=>t.id===id)||{}):{tasks:workspace.tasks,nextCursor:null}});
    }
    if(url.pathname.startsWith('/api/'))return route.fulfill({json:{}});
    return route.fulfill({contentType:'text/html',body:'<div id="root"></div>'});
  });
  await page.goto('http://127.0.0.1:45991');
  const bundle=esbuild.buildSync({stdin:{contents:"import {StudioApp} from './studio-app';import{createRoot}from'react-dom/client';createRoot(document.getElementById('root')).render(<StudioApp/>);",loader:'tsx',resolveDir:path.resolve(__dirname,'../../app')},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
  await page.addStyleTag({content:fs.readFileSync(path.resolve(__dirname,'../../app/globals.css'),'utf8').replace('@import "tailwindcss";','')});
  await page.addScriptTag({content:bundle});
  const nav=page.locator('.nav-list');await nav.getByRole('button',{name:/多品裂变/}).click();
  assert.match((await nav.textContent()).replace(/\s/g,''),/爆款复刻⑂多品裂变/);
  await page.locator('.fission-product-row').nth(3).waitFor();assert.equal(await page.locator('.fission-product-row').count(),4);
  assert.equal(await page.getByLabel('时长',{exact:true}).locator('option[value="30"]').count(),0);
  for(let i=1;i<=4;i++)await page.getByRole('combobox',{name:'选择商品 '+i,exact:true}).selectOption('p'+i);
  await page.getByLabel('母版 Gem',{exact:true}).selectOption('mother');await page.getByLabel('变体 Gem',{exact:true}).selectOption('variant');await page.getByLabel('TK 归档账号',{exact:true}).selectOption('隔离归档账号');
  await page.getByLabel('母版商品',{exact:true}).selectOption({index:2});
  const screenshot=process.env.FLOWCUT_FISSION_SCREENSHOT;
  if(screenshot)await page.screenshot({path:screenshot,fullPage:true});
  await page.getByRole('button',{name:'创建 4 品裂变批次'}).click();
  const dialog=page.getByRole('dialog',{name:'确认操作'});await dialog.waitFor();assert.match(await dialog.textContent(),/1 条母版.*4 条子提示词.*4 条视频/);
  await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(posts.length,0);
  await page.getByRole('button',{name:'创建 4 品裂变批次'}).click();await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
  await page.getByRole('status').filter({hasText:'裂变批次已创建'}).waitFor();assert.equal(posts.length,1);assert.equal(posts[0].motherProductId,'p3');assert.deepEqual(posts[0].products.map(p=>p.productId),['p1','p2','p3','p4']);
  await page.getByRole('button',{name:'移除',exact:true}).last().click();await page.getByRole('button',{name:'移除',exact:true}).last().click();
  await page.getByRole('combobox',{name:'选择商品 1',exact:true}).selectOption('p1');
  await page.getByRole('combobox',{name:'商品 2 来源',exact:true}).selectOption('new');
  await page.getByLabel('商品图片',{exact:true}).setInputFiles({name:'1735360337668113922.png',mimeType:'image/png',buffer:Buffer.from('isolated image')});
  await page.waitForFunction(()=>document.querySelector('.fission-product-row:nth-child(2) input:not([type=file])')?.value==='1735360337668113922');
  await page.getByLabel('母版来源',{exact:true}).selectOption('paste');await page.getByLabel('现成母版提示词（至少 300 字）',{exact:true}).fill(prompt);
  await page.getByLabel('生成方式',{exact:true}).selectOption('prompt');
  failNext=true;await page.getByRole('button',{name:'创建 2 品裂变批次'}).click();await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'模拟丢失提交结果'}).waitFor();assert.equal(uploads.length,1);
  await page.getByRole('button',{name:'创建 2 品裂变批次'}).click();await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
  await page.getByRole('status').filter({hasText:'裂变批次已创建'}).waitFor();assert.equal(uploads.length,1);assert.equal(posts.length,3);
  assert.equal(posts[1].requestId,posts[2].requestId);assert.equal(posts[2].motherSource,'paste');assert.equal(posts[2].autoQueue,false);assert.deepEqual(posts[2].products[1],{productId:'p2',imageKeys:['products/p2/new.png']});
  await nav.getByRole('button',{name:/任务队列/}).click();await page.locator('.task-batch-row').nth(1).waitFor();
  assert.match(await page.locator('.task-batch-rows').textContent(),/隔离商品 1.*1735360337668113921.*隔离商品 2.*1735360337668113922/s);
  await page.locator('.table-row>.task-name').first().click();await page.locator('.fission-batch-panel').waitFor();
  assert.equal(await page.getByRole('button',{name:/拼接所选|同一份母版重新分裂/}).count(),0);
  await page.locator('.fission-child').first().getByRole('button',{name:'查看商品任务'}).click();await page.getByRole('button',{name:'用母版重新写这条提示词'}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'重做使用的 Gem'}).count(),0);
});
