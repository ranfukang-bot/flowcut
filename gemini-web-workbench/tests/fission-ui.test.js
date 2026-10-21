const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
const {chromium}=require('../../vendor/publisher/node_modules/playwright-core');

// Isolated browser run of the real StudioApp with mocked local APIs: images are
// dropped in, grouped by the product ID in their names, checked on cards and
// submitted with one button. Nothing touches real data or accounts.
const bundle=()=>esbuild.buildSync({stdin:{contents:"import {StudioApp} from './studio-app';import{createRoot}from'react-dom/client';createRoot(document.getElementById('root')).render(<StudioApp/>);",loader:'tsx',resolveDir:path.resolve(__dirname,'../../app')},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text;
const css=()=>fs.readFileSync(path.resolve(__dirname,'../../app/globals.css'),'utf8').replace('@import "tailwindcss";','');

async function drop(page,selector,files){
  const transfer=await page.evaluateHandle(async files=>{
    const dt=new DataTransfer();
    for(const [index,name] of files.entries()){
      const canvas=Object.assign(document.createElement('canvas'),{width:120,height:120});const ctx=canvas.getContext('2d');
      ctx.fillStyle=`hsl(${(index*67+name.length*23)%360} 70% 72%)`;ctx.fillRect(0,0,120,120);ctx.fillStyle='#222';ctx.font='bold 40px sans-serif';ctx.fillText(String(index+1),45,75);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      dt.items.add(new File([blob],name,{type:'image/png'}));
    }
    return dt;
  },files);
  await page.dispatchEvent(selector,'dragover',{dataTransfer:transfer});
  await page.dispatchEvent(selector,'drop',{dataTransfer:transfer});
}

test('fission UI: drop images grouped by product ID, fix one card, pick from library, remembered settings, one-button start',{timeout:120000},async t=>{
  const executablePath=process.env.CHROMIUM_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
  const browser=await chromium.launch(executablePath?{executablePath}:{});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),at=new Date().toISOString();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const products=[1,2].map(i=>({id:'p'+i,external_id:'173536033766811392'+i,name:'商品库商品 '+i,created_at:at,images:[{id:'img'+i,object_key:`products/p${i}/own.png`}]}));
  const workspace={products,gems:[{id:'mother',name:'测试母版 Gem',content:'母版'},{id:'variant',name:'测试变体 Gem',content:'变体'}],tasks:[],taskCounts:{total:0,active:0,review:0,completed:0,attention:0},schedules:[],tiktokAccounts:[{id:'tk',name:'隔离归档账号'}],referenceRemixTasks:[],scriptPipelineTasks:[],referenceRemixSettings:{duration:15,region:'印尼'},integrations:{gemini:true,geminiMode:'web',geminiRuntime:{online:true,authenticated:true,queueRunning:false},seedance:true}};
  const posts=[],uploads=[],batches=[];let failNext=false;
  const prompt='隔离母版：'+'用竖屏真实商品视频展示产品功能，保持自然光和真实生活场景，输出完整镜头与口播。'.repeat(15);
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname==='/api/workspace')return route.fulfill({json:workspace});
    if(url.pathname==='/api/tasks/stats')return route.fulfill({json:{day:'2026-10-20',total:0,accounts:[]}});
    if(url.pathname==='/api/media')return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=','base64')});
    if(url.pathname==='/api/products'&&request.method()==='POST'){
      const body=request.postDataBuffer().toString('latin1');
      const externalId=body.match(/name="externalId"\r\n\r\n([^\r]*)/)[1];
      const images=(body.match(/filename="/g)||[]).length;
      uploads.push({externalId,images});
      return route.fulfill({json:{id:'u-'+externalId,reused:false,imageKeys:Array.from({length:images},(_,i)=>`products/u-${externalId}/${i}.png`)}});
    }
    if(url.pathname==='/api/fission'){
      if(request.method()==='POST'){
        const body=request.postDataJSON();posts.push(body);
        if(failNext){failNext=false;return route.fulfill({status:503,json:{error:'模拟丢失提交结果，请重试'}});}
        const children=body.products.map((row,index)=>({id:body.requestId+'-p'+(index+1),product_id:row.productId,product_name:'商品 '+(index+1),product_external_id:row.productId.replace(/^u-/,'').replace(/^p(\d)$/,'17353603376681139$1'),product_image_key:`products/${row.productId}/own.png`,task_role:'fission_child',batch_parent_id:body.requestId,batch_index:index+1,provider:'seedance-bridge',duration:15,region:'印尼',shooting_style:'iPhone实拍质感',status:index?'video_generating':'video_ready',review_status:'pending',prompt,created_at:at,tiktok_account_name:'隔离归档账号'}));
        const batch={id:body.requestId,task_role:'fission',title:'多品裂变 · '+children.length+' 个商品',status:'fission_ready',prompt,children,region:'印尼',duration:15,provider:'gemini-web',created_at:at,tiktok_account_name:'隔离归档账号'};
        batches.unshift(batch);workspace.tasks=[batch];return route.fulfill({status:201,json:{id:body.requestId,created:true}});
      }
      return route.fulfill({json:{batches}});
    }
    if(url.pathname==='/api/tasks'){
      const id=url.searchParams.get('id');return route.fulfill({json:id?(batches.flatMap(b=>[b,...b.children]).find(t=>t.id===id)||{}):{tasks:workspace.tasks,nextCursor:null}});
    }
    if(url.pathname.startsWith('/api/'))return route.fulfill({json:{}});
    return route.fulfill({contentType:'text/html',body:'<div id="root"></div>'});
  });
  const code=bundle(),style=css();
  const creationTemplate='按已保存要求生成完整文字。地区：{地区}；{时长} 秒；{拍摄风格}。';
  await page.addInitScript(value=>localStorage.setItem('flowcut-gem-request-template-v1',value),creationTemplate);
  const open=async()=>{
    await page.goto('http://127.0.0.1:45991');await page.addStyleTag({content:style});await page.addScriptTag({content:code});
    await page.locator('.nav-list').getByRole('button',{name:/多品裂变/}).click();await page.locator('.fission-drop').waitFor();
  };
  await open();
  const nav=page.locator('.nav-list');
  assert.match((await nav.textContent()).replace(/\s/g,''),/爆款复刻⑂多品裂变/);
  const start=page.locator('.fission-submit button.primary');
  const shot=async name=>{if(process.env.FLOWCUT_FISSION_SCREENSHOT)await page.screenshot({path:process.env.FLOWCUT_FISSION_SCREENSHOT.replace(/\.png$/,`-${name}.png`),fullPage:true});};
  await shot('empty');
  assert.equal(await start.isDisabled(),true);
  assert.match(await page.locator('.fission-submit').textContent(),/还差：至少 2 个商品.*母版 Gem.*变体 Gem.*TK 账号/);

  // Several products at once: IDs from file names, a duplicate download and
  // a numbered picture group; pictures without an ID become one card to fix.
  await drop(page,'.fission-drop',['1735360337668113921.png','1735360337668113921 (2).png','1735360337668113925-1.jpg','photo.png','1.png']);
  const cards=page.locator('.fission-card');
  await cards.nth(2).waitFor();assert.equal(await cards.count(),3);
  assert.equal(await page.getByLabel('商品 1 的商品 ID').inputValue(),'1735360337668113921');
  assert.match(await cards.nth(0).textContent(),/商品库商品 1/,'an ID already in the library is recognized');
  assert.equal(await page.getByLabel('商品 2 的商品 ID').inputValue(),'1735360337668113925');
  assert.equal(await page.getByLabel('商品 3 的商品 ID').inputValue(),'');
  assert.match(await cards.nth(2).getAttribute('class'),/invalid/);assert.match(await cards.nth(2).textContent(),/请填写商品 ID/);
  await shot('dropped');
  await page.getByLabel('商品 3 的商品 ID').fill('1735360337668113926');
  assert.doesNotMatch(await cards.nth(2).getAttribute('class'),/invalid/);
  await drop(page,'.fission-card:nth-child(2)','1735360337668113925-2.jpg'.split(' '));
  await page.waitForFunction(()=>document.querySelectorAll('.fission-card:nth-child(2) .fission-card-thumbs img').length===2);
  await page.getByRole('button',{name:'从商品库添加'}).click();
  await page.getByLabel('搜索商品库').fill('3922');
  await page.locator('.fission-picker [role=listitem]').filter({hasText:'1735360337668113922'}).click();
  assert.equal(await cards.count(),4);
  await page.getByRole('button',{name:'收起商品库'}).click();

  await page.getByLabel('母版 Gem',{exact:true}).selectOption('mother');await page.getByLabel('变体 Gem',{exact:true}).selectOption('variant');await page.getByLabel('TK 归档账号',{exact:true}).selectOption('隔离归档账号');
  assert.equal(await page.getByLabel('口播语言',{exact:true}).inputValue(),'auto');
  assert.equal(await page.getByLabel('口播语言',{exact:true}).locator('option').filter({hasText:'中文'}).count(),1);
  await page.getByLabel('口播语言',{exact:true}).selectOption('中文');
  await page.getByLabel('变体 Gem',{exact:true}).selectOption('mother');
  await page.getByRole('status').filter({hasText:'母版 Gem 和变体 Gem 是同一个，确认没选错？'}).waitFor();
  assert.equal(await start.isEnabled(),true,'the same-Gem message warns without blocking');
  await page.getByLabel('变体 Gem',{exact:true}).selectOption('variant');
  assert.equal(await page.getByRole('status').filter({hasText:'母版 Gem 和变体 Gem 是同一个'}).count(),0);
  await page.locator('.fission-more summary').click();
  assert.equal(await page.getByLabel('第一轮发给母版 Gem 的文字',{exact:true}).inputValue(),creationTemplate);
  assert.ok((await page.getByTestId('fission-mother-request-preview').textContent()).includes('15 秒'));
  assert.ok((await page.getByTestId('fission-mother-request-preview').textContent()).includes('口播语言：中文'));
  await page.getByLabel('第一轮发给母版 Gem 的文字',{exact:true}).fill('本模块单独要求：{地区}；{时长} 秒。');
  await page.locator('.fission-more summary').click();
  await cards.nth(2).getByRole('button',{name:'设为母版'}).click();
  assert.equal(await cards.nth(2).getByRole('button',{name:'★ 母版'}).getAttribute('aria-pressed'),'true');
  assert.equal(await start.isDisabled(),false);assert.equal((await start.textContent()).trim(),'生成 4 条视频');
  const screenshot=process.env.FLOWCUT_FISSION_SCREENSHOT;
  if(screenshot)await page.screenshot({path:screenshot,fullPage:true});

  await start.click();
  const dialog=page.getByRole('dialog',{name:'确认操作'});await dialog.waitFor();
  assert.match(await dialog.textContent(),/为 4 个商品各生成 1 条视频，消耗 4 次视频额度.*由商品 1735360337668113926 生成/);
  await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(posts.length,0);assert.equal(uploads.length,0);
  await start.click();await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
  await page.getByRole('status').filter({hasText:'已开始'}).waitFor();
  assert.deepEqual(uploads,[{externalId:'1735360337668113921',images:2},{externalId:'1735360337668113925',images:2},{externalId:'1735360337668113926',images:2}]);
  assert.equal(posts.length,1);
  assert.deepEqual(posts[0].products.map(p=>p.productId),['u-1735360337668113921','u-1735360337668113925','u-1735360337668113926','p2']);
  assert.equal(posts[0].motherProductId,'u-1735360337668113926');assert.equal(posts[0].products[3].imageKeys,undefined,'a library product keeps its saved images');
  assert.equal(posts[0].motherRequestTemplate,'本模块单独要求：{地区}；{时长} 秒。');
  assert.equal(posts[0].spokenLanguage,'中文');
  assert.equal(await cards.count(),0,'the form is cleared for the next batch');
  await page.locator('.fission-batch-card').first().waitFor();
  assert.match(await page.locator('.fission-batch-card').first().textContent(),/4 个商品.*1\/4 条已出片/s);

  // Gem and account choices are remembered for the next visit.
  await open();
  assert.equal(await page.getByLabel('变体 Gem',{exact:true}).inputValue(),'variant');
  assert.equal(await page.getByLabel('TK 归档账号',{exact:true}).inputValue(),'隔离归档账号');
  await page.locator('.fission-more summary').click();
  assert.equal(await page.getByLabel('第一轮发给母版 Gem 的文字',{exact:true}).inputValue(),'本模块单独要求：{地区}；{时长} 秒。');
  await page.getByRole('button',{name:'沿用创作中心',exact:true}).click();
  assert.equal(await page.getByLabel('第一轮发给母版 Gem 的文字',{exact:true}).inputValue(),creationTemplate);
  await page.locator('.fission-more summary').click();

  // Pasted mother, prompts only, and a lost reply retried with the same request.
  await drop(page,'.fission-drop',['1735360337668113931.png','1735360337668113932.webp']);
  await cards.nth(1).waitFor();
  await page.locator('.fission-more summary').click();
  await page.getByLabel('母版来源',{exact:true}).selectOption('paste');
  assert.equal(await page.getByLabel('母版 Gem',{exact:true}).count(),0,'a pasted mother needs no mother Gem');
  await page.getByLabel('现成母版').fill(prompt);
  await shot('more');
  await page.getByLabel('生成方式',{exact:true}).selectOption('prompt');
  assert.equal((await start.textContent()).trim(),'生成 2 条提示词');
  failNext=true;await start.click();await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'模拟丢失提交结果'}).waitFor();assert.equal(uploads.length,5);
  await start.click();await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
  await page.getByRole('status').filter({hasText:'已开始'}).waitFor();
  assert.equal(uploads.length,5,'images already uploaded are not uploaded again');assert.equal(posts.length,3);
  assert.equal(posts[1].requestId,posts[2].requestId);assert.equal(posts[2].motherSource,'paste');assert.equal(posts[2].autoQueue,false);
  // Restore the defaults so later visits in this profile start normally.
  await page.getByLabel('母版来源',{exact:true}).selectOption('generate');await page.getByLabel('生成方式',{exact:true}).selectOption('video');

  const shortReply='请先提供目标国家和口播语言。';
  batches[0].status='failed';batches[0].prompt='';batches[0].gemini_raw_reply=shortReply;
  batches[0].error=`Gemini 只回复了 ${shortReply.length} 字：『${shortReply}』`;

  await nav.getByRole('button',{name:/任务队列/}).click();await page.locator('.task-batch-row').nth(1).waitFor();
  await page.locator('.table-row>.task-name').first().click();await page.locator('.fission-batch-panel').waitFor();
  await page.getByText('母版原始回复',{exact:true}).click();
  assert.equal(await page.locator('.fission-batch-panel details').filter({hasText:'母版原始回复'}).locator('pre').textContent(),shortReply);
  assert.ok((await page.locator('.drawer').textContent()).includes(`Gemini 只回复了 ${shortReply.length} 字`));
  assert.equal(await page.getByRole('button',{name:/拼接所选|同一份母版重新分裂/}).count(),0);
  await page.locator('.fission-child').first().getByRole('button',{name:'查看商品任务'}).click();await page.getByRole('button',{name:'用母版重新写这条提示词'}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'重做使用的 Gem'}).count(),0);
  assert.deepEqual(errors,[]);
});

test('product IDs are read from image and folder names; short picture numbers are not IDs',async()=>{
  const {outputFiles}=esbuild.buildSync({entryPoints:[path.resolve(__dirname,'../../app/fission-page.tsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']});
  const module={exports:{}};new Function('module','exports','require',outputFiles[0].text)(module,module.exports,require);
  const {productIdFromFileName,addImagesToCards}=module.exports;
  assert.equal(productIdFromFileName('1735360337668113921.png'),'1735360337668113921');
  assert.equal(productIdFromFileName('1735360337668113921 (3).JPG'),'1735360337668113921');
  assert.equal(productIdFromFileName('1735360337668113921_2.webp'),'1735360337668113921');
  for(const name of ['1.png','12345.png','photo.png','IMG_1735360337668113921.png'])assert.equal(productIdFromFileName(name),'');
  const file=name=>({name,size:name.length,lastModified:1});
  const grouped=addImagesToCards([],[{file:file('a.png'),folder:'1735360337668113940'},{file:file('b.png'),folder:'1735360337668113940'},{file:file('c.png'),folder:'无名文件夹'},{file:file('1735360337668113941.png'),folder:'1735360337668113940'}]);
  assert.deepEqual(grouped.cards.map(card=>[card.externalId,card.files.length]),[['1735360337668113940',2],['',1],['1735360337668113941',1]],'the file name wins over the folder name');
  const many=addImagesToCards([],Array.from({length:14},(_,i)=>({file:file(`1735360337668113950 (${i}).png`),folder:''})));
  assert.equal(many.cards[0].files.length,12);assert.match(many.notes.join(),/最多 12 张/);
  const eleven=addImagesToCards([],Array.from({length:11},(_,i)=>({file:file(`17353603376681139${60+i}.png`),folder:''})));
  assert.equal(eleven.cards.length,10);assert.match(eleven.notes.join(),/最多 10 个商品/);
});
