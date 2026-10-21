const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { BridgeEngine, isRetryableJobError } = require('../src/bridge-engine');
const { siteFixture } = require('./helpers/site-routes.cjs');

const preload = fs.readFileSync(require.resolve('../src/gemini-preload.js'), 'utf8');
function pageRuntime(reply) {
  let now = 0;
  const events = [], listeners = {};
  const ipcRenderer = { on: (channel, listener) => { listeners[channel] = listener; }, send: (channel, data) => events.push({channel, data}) };
  const context = vm.createContext({
    require: () => ({ipcRenderer}), reply, Date: {now: () => now},
    setTimeout: (callback, ms) => { now += ms; callback(); }, setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(preload + `
    loginOrChallengeVisible = () => false;
    visibleGeminiError = () => null;
    responseSnapshot = () => [reply];
    generationInProgress = () => false;
    classifyUnusableResponse = () => null;
    globalThis.readReply = () => waitForResponse([]);
  `, context);
  return {context, events, listeners};
}

function receiveInMain(payload, sender = 7) {
  const main = fs.readFileSync(require.resolve('../src/main.js'), 'utf8');
  const body = main.slice(main.indexOf('function completeGeminiJob('), main.indexOf('\nipcMain.on("gemini:job-result"'));
  let rejected;
  const pendingJobs = new Map([['request', {contentsId: 7, accountId: 'account', reject: error => { rejected = error; }, resolve() { throw Error('short reply cannot succeed'); }}]]);
  const context = vm.createContext({pendingJobs, isJobResultSourceAllowed: (actual, expected) => actual === expected, store: {updateAccount() {}}});
  vm.runInContext(body, context);
  context.completeGeminiJob(payload, sender);
  return {rejected, pendingJobs};
}

test('stable replies under 200 chars retain their complete text through preload IPC and the guarded main-process handler', async () => {
  for (const reply of ['请提供母版。', '请先确认目标国家和口播语言，再提供商品图片。'.repeat(3), '短'.repeat(199)]) {
    const {context, events, listeners} = pageRuntime(reply);
    await assert.rejects(context.readReply(), error => {
      assert.equal(error.code, 'INCOMPLETE_RESPONSE'); assert.equal(error.rawReply, reply);
      assert.ok(error.message.includes(`Gemini 只回复了 ${reply.length} 字：『${reply}』`)); return true;
    });
    vm.runInContext('executeGeminiJob = async () => ({prompt: await waitForResponse([])})', context);
    await listeners['gemini:run-job'](null, {requestId: 'request'});
    const payload = events.find(event => event.channel === 'gemini:job-result').data;
    assert.equal(payload.ok, false); assert.equal(payload.rawReply, reply);
    assert.equal(receiveInMain(payload, 8).rejected, undefined, 'wrong window cannot report a reply');
    const received = receiveInMain(payload);
    assert.equal(received.rejected.rawReply, reply); assert.equal(received.rejected.code, 'INCOMPLETE_RESPONSE');
    assert.equal(received.pendingJobs.size, 0);
  }
});

test('packaged page-runtime wrapper also returns short-reply text; normal replies still complete', async () => {
  const builder = fs.readFileSync(require.resolve('../scripts/build-protected.cjs'), 'utf8');
  const wrapper = builder.slice(builder.indexOf('const geminiPageRuntime = '), builder.indexOf('const integrity = '));
  const reply = '请说明目标国家和语言。';
  const {context} = pageRuntime(reply);
  context.geminiRuntimeBody = preload.slice(preload.indexOf('\n') + 1, preload.indexOf('\nipcRenderer.on("gemini:run-job"')) + `
    executeGeminiJob = async () => { throw Object.assign(new Error('短回复'), {code:'INCOMPLETE_RESPONSE', rawReply:${JSON.stringify(reply)}}); };
  `;
  context.flowcutGeminiNative = {};
  vm.runInContext(wrapper + 'globalThis.builtRuntime = geminiPageRuntime;', context);
  vm.runInContext(context.builtRuntime, context);
  const result = await context.__flowcutRunGeminiJob({requestId:'request'});
  assert.equal(result.rawReply, reply); assert.equal(result.code, 'INCOMPLETE_RESPONSE'); assert.equal(result.ok, false);
  for (const length of [200, 350]) assert.equal(await pageRuntime('文'.repeat(length)).context.readReply(), '文'.repeat(length));
});

test('a short reply (the Gem asking) gets exactly one plain correction in the same conversation, then succeeds or fails terminally with both replies',async()=>{
  for(const mode of ['split','single']) for(const success of [true,false]) {
    const {context}=pageRuntime('unused');
    context.round=0;context.sent=[];context.full='完整提示词'.repeat(90);context.success=success;context.mode=mode;
    vm.runInContext(`
      waitForResponse=async()=>{round++;return round===1?'口播用什么语言？':success?full:'请先确认语言。';};
      responseCodeBlocks=()=>({blocks:[],markup:false});
      responsePlainText=()=>round===1?'口播用什么语言？':success?full:'请先确认语言。';
      typePrompt=async text=>sent.push(text);
      submitPrompt=async()=>{};
      ensureFreshConversation=()=>{throw Error('must stay in this conversation');};
      uploadFiles=()=>{throw Error('must keep the uploaded image');};
      globalThis.readPrompt=()=>readPromptReply({blockMode:mode,spokenLanguage:'Taglish'},[]);
    `,context);
    if(success){const result=await context.readPrompt();assert.equal(result.correctionUsed,true);assert.equal(result.prompt,context.full);}
    else await assert.rejects(context.readPrompt(),error=>{assert.equal(error.code,'GEM_NO_PROMPT');assert.equal(isRetryableJobError(error),false);assert.ok(error.rawReply.includes('口播用什么语言？'));assert.ok(error.rawReply.includes('请先确认语言。'));return true;});
    assert.equal(context.round,2);assert.equal(context.sent.length,1);
    assert.equal(context.sent[0],'不要提问，按默认值直接输出完整的视频提示词。口播语言：Taglish。');
    assert.doesNotMatch(context.sent[0],/代码块/);
  }
});

test('a full reply is accepted at once with no correction: single mode takes the whole text however many code boxes, split mode keeps the boxes for splitting',async()=>{
  for(const mode of ['single','split']) for(const boxes of [0,1,6]) {
    const {context}=pageRuntime('unused');
    context.sent=[];context.mode=mode;context.boxes=Array.from({length:boxes},(_,i)=>`第${i+1}段`+'镜头与口播'.repeat(70));
    context.full='好的，以下是提示词：\n'+(context.boxes.join('\n')||'整段提示词'.repeat(60));
    vm.runInContext(`
      waitForResponse=async()=>'Plaintext\\n'+full;
      responseCodeBlocks=()=>({blocks:boxes,markup:boxes.length>0});
      responsePlainText=()=>full;
      typePrompt=async text=>sent.push(text);submitPrompt=async()=>{};
      globalThis.readPrompt=()=>readPromptReply({blockMode:mode,spokenLanguage:'Taglish'},[]);
    `,context);
    const result=await context.readPrompt();
    assert.equal(context.sent.length,0,'no correction is typed into the conversation');
    assert.equal(result.correctionUsed,false);
    if(mode==='single') {assert.equal(result.prompt,context.full);assert.deepEqual([...result.codeBlocks],[]);}
    else {assert.deepEqual([...result.codeBlocks],context.boxes);assert.equal(result.prompt,'Plaintext\n'+context.full);}
  }
});

test('a no-prompt failure never defers or creates another generation and keeps its durable raw reply',async()=>{
  const account={id:'a',name:'隔离账号'},reports=[];
  const store={state:{settings:{},pendingResults:[],pendingErrors:[]},log(){},movePendingResultToError(p,error){this.state.pendingErrors.push({...p,error});},removePendingError(id){this.state.pendingErrors=this.state.pendingErrors.filter(p=>p.taskId!==id);}};
  const engine=new BridgeEngine({store,getAuthenticatedAccounts:()=>[],onChange(){},runJob:async()=>{throw Object.assign(Error('Gem 没有输出提示词：原对话补充一次后仍只回复了 4 字'),{code:'GEM_NO_PROMPT',rawReply:'口播语言？\n仍是反问'});}});
  engine.downloadFiles=async()=>[];engine.report=async(id,action,detail)=>{reports.push({id,action,...detail});throw Error('服务暂时离线');};
  engine.active.set('a',{taskId:'task'});await engine.execute(account,{id:'task',kind:'standard'});
  assert.deepEqual(reports.map(r=>r.action),['error']);assert.equal(store.state.pendingErrors[0].rawReply,'口播语言？\n仍是反问');
  engine.report=async(id,action,detail)=>{reports.push({id,action,...detail});return {ok:true};};
  store.state.pendingErrors[0].nextRetryAt=0;await engine.flushPendingErrors();
  assert.deepEqual(reports.map(r=>r.action),['error','error']);assert.equal(reports[1].rawReply,'口播语言？\n仍是反问');assert.equal(store.state.pendingErrors.length,0);
});

test('a timeout after the single correction is terminal and keeps the original question',async()=>{
  assert.equal(isRetryableJobError({code:'GEM_CORRECTION_FAILED',message:'Gem 原对话补充未能确认发送：等待输入框或发送按钮超时'}),false);
  const {context}=pageRuntime('unused');
  vm.runInContext(`let reads=0;
    waitForResponse=async()=>{if(++reads===1)return '口播用什么语言？';throw Object.assign(Error('超时'),{code:'RESPONSE_TIMEOUT'});};
    responseCodeBlocks=()=>({blocks:[],markup:false});typePrompt=async()=>{};submitPrompt=async()=>{};
    globalThis.readPrompt=()=>readPromptReply({spokenLanguage:'Taglish'},[]);`,context);
  await assert.rejects(context.readPrompt(),error=>{assert.equal(error.code,'GEM_CORRECTION_FAILED');assert.ok(error.rawReply.includes('口播用什么语言？'));return true;});
});

test('page failure passes through BridgeEngine defer/fallback error to real API storage; parent does not release children', async t => {
  const f = await siteFixture(t), at = new Date().toISOString();
  f.sqlite.prepare("INSERT INTO gems(id,name,content,created_at,updated_at) VALUES('g','测试 Gem','测试指令',?,?)").run(at,at);
  f.sqlite.prepare("INSERT INTO products(id,external_id,name,created_at) VALUES('p','1735360337668113921','隔离商品',?)").run(at);
  const reply = '请提供母版提示词和目标国家。';
  for (const [index, kind, role] of [[1,'standard','fission'],[2,'standard','single'],[3,'variant','group']]) {
    const id='short-'+index, status=kind==='variant'?'variant_generating':'prompt_generating';
    f.sqlite.prepare(`INSERT INTO tasks(id,product_id,gem_id,title,status,prompt,provider,task_role,bridge_worker_id,created_at,updated_at) VALUES(?,'p','g','隔离任务',?,'','gemini-web',?,'desk',?,?)`).run(id,status,role,at,at);
    if(role==='fission')f.sqlite.prepare(`INSERT INTO tasks(id,product_id,gem_id,title,status,prompt,provider,task_role,batch_parent_id,created_at,updated_at) VALUES('child','p','g','等待母版','fission_wait','','gemini-web','fission_child',?,?,?)`).run(id,at,at);
    const payload={requestId:'request',ok:false,code:'INCOMPLETE_RESPONSE',error:`Gemini 只回复了 ${reply.length} 字：『${reply}』`,rawReply:reply};
    const error=receiveInMain(payload).rejected;
    const store={state:{settings:{},pendingResults:[]},log(){},updateAccount(){}};
    const engine=new BridgeEngine({store,getAuthenticatedAccounts:()=>[],runJob:async()=>{throw error;},onChange(){}});
    engine.workerId='desk';engine.downloadFiles=async()=>[];
    let actions=[];
    engine.report=async(taskId,action,extra)=>{actions.push(action);const result=await f.call('gemini-bridge','POST',{body:{taskId,action,workerId:'desk',...extra}});assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
    engine.active.set('account',{taskId:id});await engine.execute({id:'account',name:'隔离账号'},{id,kind,imageUrls:[]});
    assert.deepEqual(actions,['defer']);
    let row=f.row('SELECT status,prompt,gemini_raw_reply,error FROM tasks WHERE id=?',id);
    assert.equal(row.gemini_raw_reply,reply);assert.ok(row.error.includes(reply));assert.equal(row.prompt,'');
    f.sqlite.prepare('UPDATE tasks SET gemini_failures=3,bridge_worker_id=?,status=? WHERE id=?').run('desk',status,id);
    engine.active.set('account',{taskId:id});await engine.execute({id:'account',name:'隔离账号'},{id,kind,imageUrls:[]});
    assert.equal(f.row('SELECT status,gemini_raw_reply FROM tasks WHERE id=?',id).status,'failed');
    if(role==='fission')assert.equal(f.row("SELECT status FROM tasks WHERE id='child'").status,'fission_wait');
    f.sqlite.prepare('UPDATE tasks SET status=?,bridge_worker_id=? WHERE id=?').run(status,'desk',id);
    actions=[];const report=engine.report;engine.report=async(taskId,action,extra)=>{if(action==='defer'){actions.push(action);throw Error('临时离线');}return report(taskId,action,extra);};
    engine.active.set('account',{taskId:id});await engine.execute({id:'account',name:'隔离账号'},{id,kind,imageUrls:[]});
    assert.deepEqual(actions,['defer','error']);assert.equal(f.row('SELECT gemini_raw_reply FROM tasks WHERE id=?',id).gemini_raw_reply,reply);
  }
  assert.equal(f.seedanceCalls.length,0);
});
