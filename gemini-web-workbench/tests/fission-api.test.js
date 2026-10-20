const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {siteFixture}=require('./helpers/site-routes.cjs');
const {restorableTables}=require('../src/backup-manager');
const {VideoReview,reviewDirectory}=require('../src/video-review');
const {countTasks}=require('../../lib/task-list.ts');
const block=n=>`商品${n}的专属提示词：`+'请用本商品图片中的产品，保持真实拍摄，展示产品细节、使用过程和自然口播。'.repeat(12);
async function fixture(t){
  const f=await siteFixture(t),at=new Date().toISOString();
  f.sqlite.prepare("INSERT INTO gems(id,name,content,created_at,updated_at) VALUES('mother','母版','母版内容',?,?),('variant','变体','变体内容',?,?)").run(at,at,at,at);
  f.sqlite.prepare("INSERT INTO tiktok_accounts(id,name,created_at) VALUES('tk','测试归档',?)").run(at);
  for(let i=1;i<=4;i++){
    f.sqlite.prepare('INSERT INTO products(id,external_id,name,created_at) VALUES(?,?,?,?)').run('p'+i,'173536033766811392'+i,'商品'+i,at);
    f.sqlite.prepare('INSERT INTO product_images(id,product_id,object_key,file_name,content_type,sort_order,created_at) VALUES(?,?,?,?,?,0,?)').run('img'+i,'p'+i,`products/p${i}/own.png`,'own.png','image/png',at);
    f.objects.set(`products/p${i}/own.png`,new Uint8Array([i]));
  }
  f.create=extra=>f.call('fission','POST',{body:{products:[1,2,3,4].map(i=>({productId:'p'+i})),motherSource:'generate',motherGemId:'mother',variantGemId:'variant',region:'泰国',tiktokAccountName:'测试归档',...extra}});
  f.claim=async(capacity=1,worker='desk')=>(await f.call('gemini-bridge','GET',{query:`?workerId=${worker}&capacity=${capacity}&accountIds=acc1,acc2,acc3,acc4`})).body.jobs;
  f.submit=(job,prompt=block(job.id),blocks=[prompt],worker='desk')=>f.call('gemini-bridge','POST',{body:{action:'result',kind:job.kind,taskId:job.id,workerId:worker,prompt,codeBlocks:blocks}});
  f.children=id=>f.rows('SELECT * FROM tasks WHERE batch_parent_id=? ORDER BY batch_index',id);
  f.ready=async()=>{
    const c=await f.create({motherSource:'paste',motherPrompt:block('母版')});assert.equal(c.status,201,JSON.stringify(c.body));
    const jobs=await f.claim(4);for(const job of jobs) assert.equal((await f.submit(job)).status,200);
    f.sqlite.prepare("UPDATE tasks SET status='video_ready',review_status='pending' WHERE batch_parent_id=?").run(c.body.id);
    return c.body.id;
  };
  return f;
}

test('fission: one mother releases four independent products, with frozen own images, IDs, template and Gems',async t=>{
  const f=await fixture(t),created=await f.create({motherProductId:'p3'});
  assert.equal(created.status,201,JSON.stringify(created.body));
  const id=created.body.id;
  assert.ok(f.children(id).every(c=>c.status==='fission_wait'));
  const [mother]=await f.claim(4);
  assert.equal(mother.id,id);assert.equal(mother.kind,'standard');assert.equal(mother.blockMode,'single');
  assert.equal(mother.gem.content,'母版内容');assert.deepEqual(mother.imageUrls.map(u=>new URL(u).searchParams.get('key')),['products/p3/own.png']);
  assert.deepEqual(await f.claim(4),[]);
  const text=block('共用母版');
  assert.equal((await f.submit(mother,text)).status,200);
  assert.equal((await f.submit(mother,text)).body.alreadyApplied,true);
  assert.ok(f.children(id).every(c=>c.status==='variant_queued'));
  f.sqlite.prepare("UPDATE gems SET content='已修改 Gem'").run();
  f.sqlite.prepare("UPDATE products SET external_id='changed'").run();
  f.sqlite.prepare("UPDATE product_images SET object_key='products/other/wrong.png'").run();
  const jobs=await f.claim(4);
  assert.equal(jobs.length,4);
  for(const [i,job] of jobs.entries()){
    assert.equal(job.kind,'variant');assert.equal(job.blockMode,'single');assert.equal(job.gem.content,'变体内容');
    assert.ok(job.prompt.includes(text)&&job.prompt.includes('目标国家：泰国'));
    assert.deepEqual(job.imageUrls.map(u=>new URL(u).searchParams.get('key')),[`products/p${i+1}/own.png`]);
    assert.equal((await f.submit(job,block(i+1))).status,200);
  }
  const children=f.children(id);
  assert.deepEqual(children.map(c=>c.product_external_id_snapshot),[1,2,3,4].map(i=>'173536033766811392'+i));
  assert.deepEqual(children.map(c=>JSON.parse(c.image_keys_snapshot)),[1,2,3,4].map(i=>[`products/p${i}/own.png`]));
  assert.ok(children.every(c=>c.status==='video_queued'&&c.provider==='seedance-bridge'&&c.task_role==='fission_child'));
  assert.equal(f.row("SELECT COUNT(*) AS n FROM tasks WHERE task_role='clip'").n,0);
  const videos=(await f.call('seedance-bridge','GET',{query:'?workerId=video-desk'})).body.jobs;
  assert.equal(videos.length,4);
  for(const job of videos){
    const own=children.find(child=>child.id===job.id);assert.ok(own);
    assert.equal(job.productExternalId,own.product_external_id_snapshot);
    assert.deepEqual(job.imageUrls.map(url=>new URL(url).searchParams.get('key')),JSON.parse(own.image_keys_snapshot));
  }
});

test('fission: pasted mother skips the standard round; confirmation may select prompt only',async t=>{
  const f=await fixture(t),c=await f.create({motherSource:'paste',motherPrompt:block('贴入'),autoQueue:false});
  assert.equal(c.status,201,JSON.stringify(c.body));
  assert.equal(f.row('SELECT status FROM tasks WHERE id=?',c.body.id).status,'fission_ready');
  const jobs=await f.claim(4);assert.equal(jobs.length,4);assert.ok(jobs.every(j=>j.kind==='variant'));
  for(const job of jobs)assert.equal((await f.submit(job)).status,200);
  assert.ok(f.children(c.body.id).every(c=>c.status==='prompt_ready'));
});

test('fission: rejects multiple, short, or unreadable blocks; defer preserves reply and retries normally',async t=>{
  const f=await fixture(t),c=await f.create({motherSource:'paste',motherPrompt:block('母版')});
  const [job]=await f.claim();
  for(const blocks of [[block(1),block(2)],['short']])assert.equal((await f.submit(job,blocks.join('\n'),blocks)).status,400);
  assert.equal((await f.submit(job,'Plaintext\n'+block(1),[])).status,400);
  assert.equal(f.row('SELECT prompt FROM tasks WHERE id=?',job.id).prompt,'');
  const raw=block(1)+'\n'+block(2);
  assert.equal((await f.call('gemini-bridge','POST',{body:{action:'defer',kind:'variant',taskId:job.id,workerId:'desk',rawReply:raw,error:'两个代码块'}})).status,200);
  assert.equal(f.row('SELECT gemini_raw_reply FROM tasks WHERE id=?',job.id).gemini_raw_reply,raw);
  f.sqlite.prepare('UPDATE tasks SET gemini_retry_at=NULL WHERE id=?').run(job.id);
  const retried=(await f.claim(4)).find(j=>j.id===job.id);assert.ok(retried);
  assert.equal((await f.submit(retried)).status,200);
  assert.equal(f.children(c.body.id).length,4);
});

test('fission: visible plain reply falls back with a note, never creates clips',async t=>{
  const f=await fixture(t);await f.create({motherSource:'paste',motherPrompt:block('母版')});
  const [job]=await f.claim();assert.equal((await f.submit(job,block('整段'),[])).status,200);
  assert.equal(f.row('SELECT prompt_note FROM tasks WHERE id=?',job.id).prompt_note,'未识别到代码块，按整段回复处理');
});

test('fission: mother failure blocks children, child failure is independent, recovery uses the right round',async t=>{
  const f=await fixture(t),c=await f.create(),[mother]=await f.claim();
  await f.call('gemini-bridge','POST',{body:{action:'error',kind:'standard',taskId:mother.id,workerId:'desk',error:'母版失败'}});
  assert.deepEqual(await f.claim(4),[]);
  assert.equal((await f.call('tasks','PATCH',{body:{id:c.body.id,action:'retry'}})).status,200);
  assert.equal((await f.submit((await f.claim())[0])).status,200);
  const children=await f.claim(4);
  await f.call('gemini-bridge','POST',{body:{action:'error',kind:'variant',taskId:children[0].id,workerId:'desk',error:'子任务失败'}});
  for(const child of children.slice(1))assert.equal((await f.submit(child)).status,200);
  assert.equal((await f.call('tasks','PATCH',{body:{id:children[0].id,action:'retry'}})).status,200);
  const [retried]=await f.claim();assert.equal(retried.kind,'variant');assert.equal(retried.id,children[0].id);assert.equal((await f.submit(retried)).status,200);
});

test('fission: duplicate and stale results/reports cannot reopen mother or completed children, including another worker',async t=>{
  const f=await fixture(t),c=await f.create(),[mother]=await f.claim();
  assert.equal((await f.submit(mother,block('mother'),[block('mother')],'wrong-worker')).status,409);
  await f.submit(mother);
  const children=await f.claim(4),job=children[0];await f.submit(job);
  for(const target of [mother,job])for(const action of ['release','retrying','defer','error']){
    await f.call('gemini-bridge','POST',{body:{action,kind:target.kind,taskId:target.id,workerId:'old-worker',error:'晚到'}});
  }
  assert.equal(f.row('SELECT status FROM tasks WHERE id=?',c.body.id).status,'fission_ready');
  assert.equal(f.row('SELECT status FROM tasks WHERE id=?',job.id).status,'video_queued');
  assert.equal((await f.submit(job)).body.alreadyApplied,true);
  for(const action of ['release','retrying','defer','error'])await f.call('gemini-bridge','POST',{body:{action,kind:'variant',taskId:children[1].id,workerId:'old-worker'}});
  assert.equal(f.row('SELECT status FROM tasks WHERE id=?',children[1].id).status,'variant_generating');
});

test('fission: list, search, filters and counts include children, container never counted or queued/concatenated',async t=>{
  const f=await fixture(t),id=await f.ready(),children=f.children(id);
  const list=(await f.call('tasks','GET')).body.tasks;
  assert.equal(list.length,1);assert.equal(list[0].children.length,4);
  assert.equal((await f.call('tasks','GET',{query:'?q=1735360337668113924'})).body.tasks[0].id,id);
  assert.equal((await f.call('tasks','GET',{query:'?status=review'})).body.tasks[0].id,id);
  const stats=await countTasks(f.env.DB);
  assert.equal(stats.total,4);assert.equal(stats.review,4);
  f.sqlite.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(children[0].id);
  assert.equal((await f.call('tasks','GET',{query:'?status=attention'})).body.tasks[0].id,id);
  assert.equal((await f.call('fission','GET')).body.batches[0].id,id);
  assert.equal((await f.call('tasks','PATCH',{body:{id,action:'queue'}})).status,409);
  assert.equal((await f.call('tasks/review','POST',{body:{id,confirmed:true,action:'concat-reserve',concatId:'bad',sourceIds:children.slice(1,3).map(c=>c.id)}})).status,409);
});

test('fission: remake uses same prompt; mother rewrite is an idempotent new child with frozen snapshots; delete handles group',async t=>{
  const f=await fixture(t),id=await f.ready(),children=f.children(id);
  const newId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const remake=await f.call('tasks/recreate','POST',{body:{id:children[0].id,requestId:newId}});
  assert.equal(remake.status,201,JSON.stringify(remake.body));
  const remade=f.row('SELECT * FROM tasks WHERE id=?',newId);
  assert.equal(remade.prompt,children[0].prompt);assert.equal(remade.status,'video_queued');assert.equal(remade.task_role,'fission_child');
  assert.equal(remade.image_keys_snapshot,children[0].image_keys_snapshot);assert.equal(remade.variant_gem_snapshot,'变体内容');
  const rewriteId='aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
  const body={id:children[1].id,requestId:rewriteId,rewriteMother:true};
  assert.equal((await f.call('tasks/recreate','POST',{body})).status,201);
  assert.equal((await f.call('tasks/recreate','POST',{body})).body.created,false);
  const rewritten=f.row('SELECT * FROM tasks WHERE id=?',rewriteId);
  assert.equal(rewritten.status,'variant_queued');assert.equal(rewritten.prompt,'');assert.equal(rewritten.product_id,'p2');
  const [job]=await f.claim();assert.equal(job.id,rewriteId);assert.ok(job.prompt.includes(block('母版')));
  assert.equal((await f.call('tasks','DELETE',{body:{id}})).status,200);assert.equal(f.row('SELECT COUNT(*) AS n FROM tasks').n,0);
});

test('fission: invalid batches do not write any row; repeat creation request is safe',async t=>{
  const f=await fixture(t);
  for(const extra of [{products:[{productId:'p1'}]},{products:[{productId:'p1'},{productId:'p1'}]},{duration:30},{variantRequestText:'没有母版'},{motherSource:'paste',motherPrompt:'short'},{products:[{productId:'p1',imageKeys:['products/p2/own.png']},{productId:'p2'}]}]){
    assert.equal((await f.create(extra)).status,400);assert.equal(f.row('SELECT COUNT(*) AS n FROM tasks').n,0);
  }
  const requestId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  assert.equal((await f.create({requestId})).status,201);
  assert.equal((await f.create({requestId})).body.created,false);assert.equal(f.row('SELECT COUNT(*) AS n FROM tasks').n,5);
});

test('fission: a failed child insert rolls back the entire batch; concurrent mother results release children once',async t=>{
  const f=await fixture(t);
  f.sqlite.exec("CREATE TRIGGER reject_fission_child BEFORE INSERT ON tasks WHEN NEW.task_role='fission_child' AND NEW.batch_index=3 BEGIN SELECT RAISE(ABORT,'isolated write failure'); END;");
  assert.equal((await f.create()).status,400);assert.equal(f.row('SELECT COUNT(*) AS n FROM tasks').n,0);
  f.sqlite.exec('DROP TRIGGER reject_fission_child');
  const c=await f.create(),[mother]=await f.claim();
  const results=await Promise.all([f.submit(mother),f.submit(mother)]);
  assert.ok(results.some(r=>r.body.fissionReady));
  assert.equal(f.children(c.body.id).length,4);assert.ok(f.children(c.body.id).every(c=>c.status==='variant_queued'));
  for(const child of f.children(c.body.id))await f.call('tasks','DELETE',{body:{id:child.id}});
  assert.equal(f.row('SELECT COUNT(*) AS n FROM tasks').n,0,'empty fission container is removed');
});

test('fission: concurrent manual queue requests accept once; recovery never erases a known remote Task ID',async t=>{
  const f=await fixture(t);await f.create({motherSource:'paste',motherPrompt:block('母版'),autoQueue:false});
  const [job]=await f.claim();await f.submit(job);
  const enqueue=()=>f.call('tasks','PATCH',{body:{id:job.id,action:'queue'}});
  const results=await Promise.all([enqueue(),enqueue()]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  f.sqlite.prepare("UPDATE tasks SET status='failed',provider_job_id='known-task-id' WHERE id=?").run(job.id);
  for(const action of ['queue','retry','regenerate'])assert.equal((await f.call('tasks','PATCH',{body:{id:job.id,action}})).status,409);
  assert.equal(f.row('SELECT provider_job_id FROM tasks WHERE id=?',job.id).provider_job_id,'known-task-id');
});

test('fission: deleting the mother product cannot orphan other products; deleting a child product keeps its siblings',async t=>{
  const f=await fixture(t),created=await f.create();
  const parentDelete=await f.call('products','DELETE',{body:{id:'p1'}});
  assert.equal(parentDelete.status,409,JSON.stringify(parentDelete.body));
  assert.equal(f.children(created.body.id).length,4);assert.ok(f.objects.has('products/p1/own.png'));
  assert.equal((await f.call('products','DELETE',{body:{id:'p4'}})).status,200);
  assert.deepEqual(f.children(created.body.id).map(c=>c.product_id),['p1','p2','p3']);
  assert.ok(f.row('SELECT id FROM tasks WHERE id=?',created.body.id));
});

test('fission: backup restoration pauses waiting children and ready mother; manual recovery preserves mother',async t=>{
  const f=await fixture(t),c=await f.create({motherSource:'paste',motherPrompt:block('母版')});
  const tables=restorableTables({tasks:[{status:'fission_wait',error:''},{status:'fission_ready',error:''}]});
  assert.ok(tables.tasks.every(r=>r.status==='failed'&&r.error.includes('未自动重发')));
  f.sqlite.prepare("UPDATE tasks SET status='failed'").run();
  assert.equal((await f.call('tasks','PATCH',{body:{id:c.body.id+'-p1',action:'retry'}})).status,409);
  assert.equal((await f.call('tasks','PATCH',{body:{id:c.body.id,action:'retry'}})).status,200);
  assert.equal((await f.call('tasks','PATCH',{body:{id:c.body.id+'-p1',action:'retry'}})).status,200);
  assert.equal((await f.claim())[0].kind,'variant');
});

test('fission: real VideoReview and routes release each file under its own product ID',async t=>{
  const f=await fixture(t),id=await f.ready(),children=f.children(id).slice(0,2);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flowcut-fission-review-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const child of children){const file=path.join(reviewDirectory(root,child.id),'ready.mp4');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'isolated video '+child.product_id);f.sqlite.prepare('UPDATE tasks SET download_path=? WHERE id=?').run(file,child.id);}
  const review=new VideoReview({userData:root,defaultDirectory:()=>path.join(root,'publish'),shell:{openPath:async()=>''},request:async(route,init)=>{
    const url=new URL('http://fixture'+route),result=await f.call(url.pathname.replace('/api/',''),init?.method||'GET',{query:url.search,body:init?.body?JSON.parse(init.body):undefined});
    if(result.status>=400)throw Error(result.body.error);return result.body;
  }});
  for(const child of children){const result=await review.approve(child.id,true);assert.equal(path.basename(result.file),child.product_external_id_snapshot+'.mp4');assert.equal(fs.readFileSync(result.file,'utf8'),'isolated video '+child.product_id);}
});
