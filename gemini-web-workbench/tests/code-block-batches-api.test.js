const test=require('node:test');
const assert=require('node:assert/strict');
const {siteFixture}=require('./helpers/site-routes.cjs');

const block=(n,extra='')=>`视频${n}：9:16 竖屏，15 秒连续镜头。${extra}\n`+`第${n}条：产品特写、人物口播与使用场景自然衔接，画面真实，光线柔和。`.repeat(12);
const reply=blocks=>`创意分析\n| 镜头 | 说明 |\n| --- | --- |\n| 1 | 表格不是提示词 |\n\n${blocks.map((b,i)=>`方案 ${i+1}\n\`\`\`\n${b}\n\`\`\``).join('\n\n')}\n\n以上为全部方案。`;
const now=()=>new Date().toISOString();

async function seeded(t,options) {
  const f=await siteFixture(t,options);
  const at=now();
  f.sqlite.prepare("INSERT INTO gems(id,name,content,created_at,updated_at) VALUES('gem','主 Gem','主 Gem 设定',?,?),('variant','变体 Gem','变体 Gem 设定',?,?)").run(at,at,at,at);
  f.sqlite.prepare("INSERT INTO products(id,external_id,name,created_at) VALUES('product','1735360337668113923','测试商品',?)").run(at);
  f.sqlite.prepare("INSERT INTO product_images(id,product_id,object_key,file_name,content_type,sort_order,created_at) VALUES('img','product','products/product/a.png','a.png','image/png',0,?)").run(at);
  f.objects.set('products/product/a.png',new Uint8Array([1]));
  f.sqlite.prepare("INSERT INTO tiktok_accounts(id,name,created_at) VALUES('tk','测试账号',?)").run(at);
  return f;
}
async function createTask(f,extra={}) {
  const result=await f.call('tasks','POST',{body:{productId:'product',gemId:'gem',tiktokAccountName:'测试账号',imageKeys:['products/product/a.png'],duration:15,region:'泰国',...extra}});
  return result;
}
async function claim(f,workerId='desk') {
  const result=await f.call('gemini-bridge','GET',{query:`?workerId=${workerId}&capacity=1&accountIds=acc-1`});
  assert.equal(result.status,200,JSON.stringify(result.body));
  return result.body.jobs[0];
}
const submit=(f,job,{prompt,codeBlocks,codeBlockHint=false,workerId='desk'})=>f.call('gemini-bridge','POST',{body:{action:'result',kind:job.kind,taskId:job.id,workerId,prompt,codeBlocks,codeBlockHint}});
const children=(f,id)=>f.rows('SELECT id,status,provider,prompt,title,task_role,batch_index,batch_round,batch_size FROM tasks WHERE batch_parent_id=? ORDER BY batch_round,batch_index',id);

test('each code block becomes one clip; text and tables outside the blocks are ignored; a repeated result adds nothing',async t=>{
  const f=await seeded(t);
  const created=await createTask(f);
  assert.equal(created.status,201,JSON.stringify(created.body));
  const job=await claim(f);
  assert.equal(job.kind,'standard');
  assert.equal(job.blockMode,'split');
  const blocks=[block(1),block(2),block(3)],text=reply(blocks);
  const first=await submit(f,job,{prompt:text,codeBlocks:blocks});
  assert.equal(first.status,200,JSON.stringify(first.body));
  assert.equal(first.body.clips,3);
  const group=f.row('SELECT status,task_role,batch_size,gemini_raw_reply FROM tasks WHERE id=?',job.id);
  assert.deepEqual({...group,gemini_raw_reply:undefined},{status:'split_done',task_role:'group',batch_size:3,gemini_raw_reply:undefined});
  assert.equal(group.gemini_raw_reply,text.trim());
  const clips=children(f,job.id);
  assert.deepEqual(clips.map(c=>c.id),[1,2,3].map(n=>`${job.id}-r1-${n}`));
  assert.deepEqual(clips.map(c=>c.prompt),blocks);
  assert.ok(clips.every(c=>c.status==='video_queued'&&c.provider==='seedance-bridge'&&c.task_role==='clip'&&c.batch_size===3));
  assert.match(clips[1].title,/第 2\/3 条$/);
  assert.ok(clips.every(c=>!/表格不是提示词|创意分析/.test(c.prompt)));

  const replay=await submit(f,job,{prompt:text,codeBlocks:blocks});
  assert.equal(replay.status,200);
  assert.equal(replay.body.alreadyApplied,true);
  assert.equal(children(f,job.id).length,3);
  for (const action of ['release','retrying','defer','error']) {
    await f.call('gemini-bridge','POST',{body:{action,kind:'standard',taskId:job.id,workerId:'old-worker',error:'late report'}});
  }
  assert.equal(f.row('SELECT status FROM tasks WHERE id=?',job.id).status,'split_done','late reports from an old worker cannot reopen a split group');

  const list=await f.call('tasks','GET',{query:'?status=all'});
  assert.deepEqual(list.body.tasks.map(task=>task.id),[job.id],'clips are listed inside their group');
  assert.equal(list.body.tasks[0].children.length,3);
  const workspace=await f.call('tasks','GET',{query:'?status=active'});
  assert.equal(workspace.body.tasks[0].id,job.id,'a group with active clips appears under the active filter');
});

test('a bad split is refused as a whole: nothing is created and the raw reply is kept for the user',async t=>{
  const f=await seeded(t);
  await createTask(f);
  const job=await claim(f);
  const blocks=[block(1),'太短的代码块',block(3)];
  const refused=await submit(f,job,{prompt:reply(blocks),codeBlocks:blocks});
  assert.equal(refused.status,400);
  assert.match(refused.body.error,/第 2 个代码块只有/);
  assert.equal(f.row('SELECT status FROM tasks WHERE id=?',job.id).status,'prompt_generating');
  assert.equal(children(f,job.id).length,0);
  for (const bad of [[block(1),block(1)],Array.from({length:11},(_,i)=>block(i+1))]) {
    assert.equal((await submit(f,job,{prompt:reply(bad),codeBlocks:bad})).status,400);
  }
  const deferred=await f.call('gemini-bridge','POST',{body:{action:'defer',kind:'standard',taskId:job.id,workerId:'desk',error:'第 2 个代码块只有 6 字',rawReply:reply(blocks)}});
  assert.equal(deferred.status,200);
  const row=f.row('SELECT status,gemini_raw_reply,error FROM tasks WHERE id=?',job.id);
  assert.equal(row.status,'prompt_queued');
  assert.equal(row.gemini_raw_reply,reply(blocks).trim());
  assert.match(row.error,/第 2 个代码块/);
  assert.equal(children(f,job.id).length,0);
});

test('a reply without code blocks still works as one prompt with a note; visible code-block markup without readable blocks is refused',async t=>{
  const f=await seeded(t);
  await createTask(f);
  const plain=await claim(f);
  const text='整段提示词：'+block(1);
  const fallback=await submit(f,plain,{prompt:text,codeBlocks:[]});
  assert.equal(fallback.status,200,JSON.stringify(fallback.body));
  const row=f.row('SELECT status,prompt,prompt_note,task_role FROM tasks WHERE id=?',plain.id);
  assert.equal(row.status,'video_queued');
  assert.equal(row.prompt,text);
  assert.equal(row.prompt_note,'未识别到代码块，按整段回复处理');
  assert.equal(row.task_role,null);

  await createTask(f);
  const marked=await claim(f);
  assert.equal((await submit(f,marked,{prompt:'Plaintext\n'+block(2),codeBlocks:[],codeBlockHint:true})).status,400);
  assert.equal((await submit(f,marked,{prompt:'```\n'+block(2)+'\n```',codeBlocks:[]})).status,400);
  assert.equal(f.row('SELECT status FROM tasks WHERE id=?',marked.id).status,'prompt_generating');

  await createTask(f);
  const single=await claim(f);
  assert.equal((await submit(f,single,{prompt:reply([block(5)]),codeBlocks:[block(5)]})).status,200);
  const one=f.row('SELECT status,prompt,task_role,prompt_note FROM tasks WHERE id=?',single.id);
  assert.deepEqual(one,{status:'video_queued',prompt:block(5),task_role:null,prompt_note:null},'one code block keeps the ordinary single-task flow');
});

test('30-second two-part tasks keep the old whole-reply behaviour',async t=>{
  const f=await seeded(t);
  assert.equal((await createTask(f,{duration:30})).status,201);
  const job=await claim(f);
  assert.equal(job.blockMode,'raw');
  const text=reply([block(1),block(2)]);
  assert.equal((await submit(f,job,{prompt:text,codeBlocks:[block(1),block(2)]})).status,200);
  const row=f.row('SELECT prompt,task_role FROM tasks WHERE id=?',job.id);
  assert.equal(row.prompt,text.trim());
  assert.equal(row.task_role,null);
  assert.equal(children(f,job.id).length,0);
});

test('two-round variant: mother prompt, then the variant Gem with the mother and target country; split again adds a new batch',async t=>{
  const f=await seeded(t);
  const template='目标国家：{地区}\n母版如下：\n{母版提示词}\n每条放一个代码块。';
  assert.equal((await createTask(f,{duration:30,variantGemId:'variant',variantRequestText:template})).status,400);
  assert.equal((await createTask(f,{variantGemId:'variant',variantRequestText:'没有母版占位符'})).status,400);
  assert.equal((await createTask(f,{variantGemId:'missing',variantRequestText:template})).status,400);
  const created=await createTask(f,{variantGemId:'variant',variantRequestText:template});
  assert.equal(created.status,201);

  const first=await claim(f);
  assert.equal(first.kind,'standard');
  assert.equal(first.blockMode,'single');
  assert.equal(first.gem.content,'主 Gem 设定');
  assert.equal((await submit(f,first,{prompt:reply([block(1),block(2)]),codeBlocks:[block(1),block(2)]})).status,400,'round one must return one mother prompt');
  const mother=block(9,'母版');
  const motherResult=await submit(f,first,{prompt:reply([mother]),codeBlocks:[mother]});
  assert.equal(motherResult.status,200,JSON.stringify(motherResult.body));
  assert.deepEqual(f.row('SELECT status,prompt,task_role FROM tasks WHERE id=?',first.id),{status:'variant_queued',prompt:mother,task_role:'group'});

  const second=await claim(f);
  assert.equal(second.kind,'variant');
  assert.equal(second.id,first.id);
  assert.equal(second.gem.content,'变体 Gem 设定');
  assert.equal(second.prompt,`目标国家：泰国\n母版如下：\n${mother}\n每条放一个代码块。\n口播语言：泰语\n不要提问，直接按以上信息输出提示词，每条提示词放在单独的代码块里`);
  assert.equal(second.spokenLanguage,'泰语');
  assert.deepEqual(second.imageUrls,first.imageUrls,'the same product images go to the variant Gem');
  const variants=[block(11),block(12)];
  assert.equal((await submit(f,second,{prompt:reply(variants),codeBlocks:variants})).status,200);
  assert.equal(f.row('SELECT prompt FROM tasks WHERE id=?',first.id).prompt,mother,'the mother prompt is kept on the group');
  assert.deepEqual(children(f,first.id).map(c=>[c.batch_round,c.batch_index,c.prompt]),[[1,1,variants[0]],[1,2,variants[1]]]);

  assert.equal((await f.call('tasks','PATCH',{body:{id:first.id,action:'resplit'}})).status,200);
  assert.equal((await f.call('tasks','PATCH',{body:{id:first.id,action:'resplit'}})).status,409,'already queued');
  const third=await claim(f);
  assert.equal(third.kind,'variant');
  const more=[block(21),block(22),block(23)];
  assert.equal((await submit(f,third,{prompt:reply(more),codeBlocks:more})).status,200);
  assert.deepEqual(children(f,first.id).map(c=>c.id),[`${first.id}-r1-1`,`${first.id}-r1-2`,`${first.id}-r2-1`,`${first.id}-r2-2`,`${first.id}-r2-3`]);
});

test('with "prompts only" the clips wait as prompt-ready and each one is submitted when asked',async t=>{
  const f=await seeded(t);
  await createTask(f,{autoQueue:false});
  const job=await claim(f);
  const blocks=[block(1),block(2)];
  assert.equal((await submit(f,job,{prompt:reply(blocks),codeBlocks:blocks})).status,200);
  const clips=children(f,job.id);
  assert.deepEqual(clips.map(c=>c.status),['prompt_ready','prompt_ready']);
  assert.ok((await f.call('tasks','PATCH',{body:{id:job.id,action:'queue'}})).status>=400,'a group container is never sent to Seedance');
  assert.equal((await f.call('tasks','PATCH',{body:{id:clips[0].id,action:'queue'}})).status,200);
  assert.deepEqual(children(f,job.id).map(c=>c.status),['video_queued','prompt_ready']);
});

async function readyGroup(t) {
  const f=await seeded(t);
  await createTask(f);
  const job=await claim(f);
  const blocks=[block(1),block(2),block(3)];
  await submit(f,job,{prompt:reply(blocks),codeBlocks:blocks});
  for (const clip of children(f,job.id)) {
    f.sqlite.prepare("UPDATE tasks SET status='video_ready',progress=100,download_path=? WHERE id=?").run(`C:/review/${clip.id}/1735360337668113923.mp4`,clip.id);
  }
  return {f,group:job.id,clips:children(f,job.id).map(c=>c.id)};
}
const review=(f,body)=>f.call('tasks/review','POST',{body:{confirmed:true,...body}});
const statusOf=(f,ids)=>ids.map(id=>f.row('SELECT review_status FROM tasks WHERE id=?',id)?.review_status??null);

test('concatenation reserves the chosen clips, keeps them out of review, and gives them back when the joined video is deleted',async t=>{
  const {f,group,clips}=await readyGroup(t);
  const concatId='11111111-2222-4333-8444-555555555555';
  const reserved=await review(f,{id:group,action:'concat-reserve',concatId,sourceIds:[clips[2],clips[0]]});
  assert.equal(reserved.status,200,JSON.stringify(reserved.body));
  assert.deepEqual(reserved.body.sources.map(s=>s.id),[clips[0],clips[2]],'clips are joined in batch order');
  assert.deepEqual(statusOf(f,clips),['merging','pending','merging']);
  assert.equal((await review(f,{id:group,action:'concat-reserve',concatId,sourceIds:[clips[2],clips[0]]})).status,200,'a repeated request returns the same reservation');
  assert.equal((await review(f,{id:group,action:'concat-reserve',concatId:'other-concat',sourceIds:[clips[0],clips[1]]})).status,409,'a clip being joined cannot be joined twice');
  assert.equal((await review(f,{id:clips[0],action:'reserve'})).status,409,'a clip being joined cannot be approved');
  assert.equal((await f.call('tasks','DELETE',{body:{id:group}})).status,409,'the group cannot be deleted mid-concatenation');

  assert.equal((await review(f,{id:concatId,action:'concat-cancel'})).status,200);
  assert.deepEqual(statusOf(f,clips),['pending','pending','pending']);
  assert.equal(f.row('SELECT id FROM tasks WHERE id=?',concatId),null);

  await review(f,{id:group,action:'concat-reserve',concatId,sourceIds:[clips[0],clips[1]]});
  assert.equal((await review(f,{id:concatId,action:'concat-finish',path:'C:/review/concat.mp4'})).status,200);
  const joined=f.row('SELECT status,task_role,duration,batch_parent_id,product_external_id_snapshot,review_status FROM tasks WHERE id=?',concatId);
  assert.deepEqual(joined,{status:'video_ready',task_role:'concat',duration:30,batch_parent_id:group,product_external_id_snapshot:'1735360337668113923',review_status:'pending'});
  assert.deepEqual(statusOf(f,clips),['merged','merged','pending']);
  const counts=(await f.call('tasks','GET',{query:'?status=review'})).body.tasks[0].children.filter(c=>c.status==='video_ready'&&!['merged','merging'].includes(c.review_status));
  assert.deepEqual(counts.map(c=>c.id).sort(),[clips[2],concatId].sort(),'merged clips are not waiting for review; the joined video is');

  assert.equal((await review(f,{id:concatId,action:'reserve-delete'})).status,200);
  assert.equal((await review(f,{id:concatId,action:'delete-pending'})).status,200);
  assert.deepEqual(statusOf(f,clips),['pending','pending','pending'],'deleting the joined video returns its clips to review');
});

test('approving a joined video lets the desktop remove its clips; the emptied group disappears',async t=>{
  const {f,group,clips}=await readyGroup(t);
  const concatId='concat-approved';
  await review(f,{id:group,action:'concat-reserve',concatId,sourceIds:clips});
  await review(f,{id:concatId,action:'concat-finish',path:'C:/review/concat.mp4'});
  assert.equal((await review(f,{id:clips[0],action:'delete-merged'})).status,409,'clips stay until the joined video is approved');
  assert.equal((await review(f,{id:concatId,action:'reserve'})).status,200);
  assert.equal((await review(f,{id:concatId,path:'C:/publish/1735360337668113923.mp4',approvedAt:now(),timeZone:'Asia/Shanghai'})).status,200);
  assert.deepEqual((await f.call('tasks/review','GET',{query:'?concat=consume'})).body.map(r=>r.id),[concatId]);
  const merged=(await f.call('tasks/review','GET',{query:'?merged='+concatId})).body;
  assert.deepEqual(merged.map(r=>r.id),clips);
  for (const clip of clips) assert.equal((await review(f,{id:clip,action:'delete-merged'})).status,200);
  assert.deepEqual((await f.call('tasks/review','GET',{query:'?concat=consume'})).body,[]);
  assert.equal(f.row('SELECT review_status FROM tasks WHERE id=?',concatId).review_status,'approved');
  assert.ok(f.row('SELECT id FROM tasks WHERE id=?',group),'the group still holds the approved joined video');
  assert.equal((await f.call('tasks','DELETE',{query:'?completed=1'})).status,200);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM tasks').n,0,'clearing completed tasks also removes the empty group');
});

test('a clip is remade from its own prompt without Gemini; joined or merged videos cannot be remade',async t=>{
  const {f,group,clips}=await readyGroup(t);
  const requestId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const remade=await f.call('tasks/recreate','POST',{body:{id:clips[1],requestId}});
  assert.equal(remade.status,201,JSON.stringify(remade.body));
  const copy=f.row('SELECT status,provider,prompt,task_role,batch_parent_id,batch_index,batch_size FROM tasks WHERE id=?',requestId);
  assert.deepEqual(copy,{status:'video_queued',provider:'seedance-bridge',prompt:block(2),task_role:'clip',batch_parent_id:group,batch_index:2,batch_size:3});
  assert.equal(f.row('SELECT review_status FROM tasks WHERE id=?',clips[1]).review_status,'replaced');
  assert.equal((await f.call('tasks/recreate','POST',{body:{id:clips[1],requestId}})).body.created,false,'a lost reply can be retried safely');

  await review(f,{id:group,action:'concat-reserve',concatId:'concat-x',sourceIds:[clips[0],clips[2]]});
  await review(f,{id:'concat-x',action:'concat-finish',path:'C:/review/concat.mp4'});
  assert.equal((await f.call('tasks/recreate','POST',{body:{id:clips[0],requestId:'aaaaaaaa-bbbb-4ccc-8ddd-000000000001'}})).status,409);
  assert.equal((await f.call('tasks/recreate','POST',{body:{id:'concat-x',requestId:'aaaaaaaa-bbbb-4ccc-8ddd-000000000002'}})).status,409);
});

test('deleting a group removes its clips; deleting the last clip removes the empty group',async t=>{
  const {f,group,clips}=await readyGroup(t);
  for (const clip of clips.slice(0,2)) assert.equal((await f.call('tasks','DELETE',{body:{id:clip}})).status,200);
  assert.ok(f.row('SELECT id FROM tasks WHERE id=?',group));
  assert.equal((await f.call('tasks','DELETE',{body:{id:clips[2]}})).status,200);
  assert.equal(f.row('SELECT id FROM tasks WHERE id=?',group),null);

  const other=await readyGroup(t);
  assert.equal((await other.f.call('tasks','DELETE',{body:{id:other.group}})).status,200);
  assert.equal(other.f.row('SELECT COUNT(*) AS n FROM tasks').n,0);
});
