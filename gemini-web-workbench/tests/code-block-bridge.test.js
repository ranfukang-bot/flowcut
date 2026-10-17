const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {siteFixture}=require('./helpers/site-routes.cjs');
const {BridgeEngine}=require('../src/bridge-engine');
const {Store}=require('../src/store');

const block=n=>`第${n}条视频提示词：`+'产品特写、人物口播与使用场景自然衔接，画面真实，光线柔和。'.repeat(14);
const reply=blocks=>`说明文字\n| 表格 | 不用 |\n${blocks.map(b=>'```\n'+b+'\n```').join('\n')}`;

// The desktop engine talks to the real Gemini bridge route; a flag simulates
// the local service being unreachable for result write-backs.
async function fixture(t) {
  const f=await siteFixture(t);
  const at=new Date().toISOString();
  f.sqlite.prepare("INSERT INTO gems(id,name,content,created_at,updated_at) VALUES('gem','主 Gem','设定',?,?)").run(at,at);
  f.sqlite.prepare("INSERT INTO products(id,external_id,name,created_at) VALUES('product','1735360337668113923','测试商品',?)").run(at);
  f.sqlite.prepare("INSERT INTO tiktok_accounts(id,name,created_at) VALUES('tk','测试账号',?)").run(at);
  f.objects.set('products/product/a.png',1);
  const created=await f.call('tasks','POST',{body:{productId:'product',gemId:'gem',tiktokAccountName:'测试账号',imageKeys:['products/product/a.png'],duration:15}});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'flowcut-blocks-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const app={getPath:()=>directory};
  const offline={value:false};
  const engineFor=(store,runJob)=>{
    const engine=new BridgeEngine({store,getAuthenticatedAccounts:()=>[],runJob,onChange(){}});
    engine.downloadFiles=async()=>[{name:'product.png'}];
    engine.request=async(route,init={})=>{
      const body=init.body?JSON.parse(init.body):undefined;
      if (offline.value&&body?.action==='result') throw Object.assign(Error('fetch failed'),{code:'ECONNREFUSED'});
      const result=await f.call('gemini-bridge',init.method||'GET',{query:route,body});
      if (result.status>=400) throw Object.assign(Error(result.body.error||'HTTP '+result.status),{status:result.status,ignorable:Boolean(result.body.ignorable)});
      return result.body;
    };
    return engine;
  };
  return {f,app,offline,engineFor,taskId:created.body.id};
}
async function run(engine,f,runJob) {
  const job=(await f.call('gemini-bridge','GET',{query:`?workerId=${engine.workerId}&capacity=1&accountIds=acc`})).body.jobs[0];
  const account={id:'acc',name:'账号 A'};
  engine.store.state.accounts=[account];
  engine.store.updateAccount=(_id,patch)=>Object.assign(account,patch);
  engine.active.set(account.id,{taskId:job.id});
  await engine.execute(account,job);
  return job;
}

test('the desktop refuses a reply it cannot split, before writing anything back; the task retries with the reply kept',async t=>{
  const {f,app,engineFor,taskId}=await fixture(t);
  const text=reply([block(1),'只有几个字']);
  const engine=engineFor(new Store(app),async()=>({prompt:text,codeBlocks:[block(1),'只有几个字'],codeBlockHint:false}));
  await run(engine,f);
  const row=f.row('SELECT status,gemini_raw_reply,error FROM tasks WHERE id=?',taskId);
  assert.equal(row.status,'prompt_queued');
  assert.match(row.error,/第 2 个代码块只有/);
  assert.equal(row.gemini_raw_reply,text);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM tasks WHERE batch_parent_id=?',taskId).n,0);
  assert.deepEqual(engine.store.state.pendingResults,[]);
});

test('a reply with code-block markup but no readable blocks is not sent as one whole prompt',async t=>{
  const {f,app,engineFor,taskId}=await fixture(t);
  const engine=engineFor(new Store(app),async()=>({prompt:'Plaintext\n'+block(1),codeBlocks:[],codeBlockHint:true}));
  await run(engine,f);
  const row=f.row('SELECT status,prompt FROM tasks WHERE id=?',taskId);
  assert.deepEqual(row,{status:'prompt_queued',prompt:''});
});

test('code blocks wait in the local outbox across a restart and become clips once the service is back',async t=>{
  const {f,app,offline,engineFor,taskId}=await fixture(t);
  const blocks=[block(1),block(2),block(3)];
  offline.value=true;
  await run(engineFor(new Store(app),async()=>({prompt:reply(blocks),codeBlocks:blocks,codeBlockHint:false})),f);
  assert.equal(f.row('SELECT COUNT(*) AS n FROM tasks WHERE batch_parent_id=?',taskId).n,0);

  const restored=new Store(app);
  assert.deepEqual(restored.state.pendingResults.map(item=>item.codeBlocks),[blocks]);
  offline.value=false;
  assert.equal(await engineFor(restored,async()=>{throw Error('not called');}).flushPendingResults(),true);
  assert.deepEqual(f.rows('SELECT prompt FROM tasks WHERE batch_parent_id=? ORDER BY batch_index',taskId).map(r=>r.prompt),blocks);
  assert.equal(f.row('SELECT status FROM tasks WHERE id=?',taskId).status,'split_done');
  assert.deepEqual(new Store(app).state.pendingResults,[]);
});
