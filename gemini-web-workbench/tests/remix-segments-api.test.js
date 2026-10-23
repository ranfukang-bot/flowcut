const {test}=require('node:test');
const assert=require('node:assert/strict');
const {siteFixture}=require('./helpers/site-routes.cjs');
const {segmentHeader,planRemixSegments}=require('../../lib/remix-segments.ts');
const block=(i,a,b)=>`${segmentHeader(i,a,b)}\n${'运镜动作音效与口播细节。'.repeat(45)}`;
async function setup(t,seconds=24) {
  const f=await siteFixture(t);
  f.sqlite.prepare("INSERT INTO tiktok_accounts(id,name,archive_directory,created_at) VALUES('tk','印尼1','C:/isolated/TK',?)").run(new Date().toISOString());
  const form=new FormData();form.set('video',new File(['video'],'ref.mp4',{type:'video/mp4'}));form.append('images',new File(['img'],'product.png',{type:'image/png'}));
  form.set('videoSeconds',String(seconds));form.set('region','印尼');form.set('tiktokAccountName','印尼1');form.set('externalId','123456789');form.set('productName','测试商品');
  const route=await f.route('reference-remix');const res=await route.POST(new Request('http://fixture/api/reference-remix',{method:'POST',body:form}));
  const result=await res.json();assert.equal(res.status,201,JSON.stringify(result));
  return Object.assign(f,{id:result.id,form});
}
async function claim(f,account='a') {
  const res=await f.call('gemini-bridge','GET',{query:`?accountIds=${account}&workerId=worker&capacity=1`});assert.equal(res.status,200);return res.body.jobs[0];
}
const report=(f,action,fields={})=>f.call('gemini-bridge','POST',{body:{action,taskId:f.id,kind:'remix-segments',workerId:'worker',remixRound:1,...fields}});
test('creation uses tasks, saves deduplicated library product and immutable snapshots',async t=>{
  const f=await setup(t);const p=f.row('SELECT * FROM tasks WHERE id=?',f.id);assert.equal(p.task_role,'remix');assert.equal(p.batch_size,2);assert.equal(p.duration,24);assert.equal(f.rows('SELECT * FROM reference_remix_tasks').length,0);
  const route=await f.route('reference-remix');await route.POST(new Request('http://fixture/api/reference-remix',{method:'POST',body:f.form}));assert.equal(f.rows('SELECT * FROM products').length,1);assert.equal(JSON.parse(p.image_keys_snapshot).length,1);
});
test('claim uses actual saved Gem, pins first account and prefers it on resume with fallback',async t=>{
  const f=await setup(t);const j=await claim(f);assert.equal(j.gem.id,'builtin-reference-remix');assert.equal(j.gem.name,'爆款视频复刻智能体');assert.equal(j.kind,'remix-segments');assert.ok(j.referenceVideoUrl);assert.match(j.analysisPrompt,/15-24/);
  await report(f,'release');const j2=await claim(f,'b');assert.equal(j2.accountId,'b');assert.equal(f.row('SELECT gemini_account_id FROM tasks WHERE id=?',f.id).gemini_account_id,'b');
});
test('first-round validation is durable before adaptation; resume skips video',async t=>{
  const f=await setup(t);await claim(f);const analysis=[block(1,0,15),block(2,15,24)];
  assert.equal((await report(f,'stage',{analysisBlocks:analysis,rawReply:'原始回复',rawReplies:['原始回复']})).status,200);
  assert.equal(f.row('SELECT remix_script FROM tasks WHERE id=?',f.id).remix_script,analysis.join('\n\n'));
  await report(f,'defer',{error:'network'});f.sqlite.prepare('UPDATE tasks SET gemini_retry_at=NULL WHERE id=?').run(f.id);
  const job=await claim(f);assert.equal(job.referenceVideoUrl,undefined);assert.ok(job.adaptationPrompt.includes(analysis[0]));assert.ok(job.adaptationPrompt.includes('商品名称：测试商品'));
});
test('invalid first round never persists script or changes stage',async t=>{
  const f=await setup(t);await claim(f);const result=await report(f,'stage',{analysisBlocks:[block(1,0,15)]});assert.equal(result.status,400);assert.equal(f.row('SELECT status,remix_script FROM tasks WHERE id=?',f.id).status,'remix_analyzing');assert.equal(f.row('SELECT remix_script FROM tasks WHERE id=?',f.id).remix_script,null);
});
test('second-round all-or-nothing, duration snapshots, stale reports and replay cannot insert clips',async t=>{
  const f=await setup(t);await claim(f);const blocks=[block(1,0,15),block(2,15,24)];await report(f,'stage',{analysisBlocks:blocks});
  assert.notEqual((await report(f,'result',{codeBlocks:[blocks[0]],prompt:blocks[0]})).status,200);assert.equal(f.rows("SELECT * FROM tasks WHERE task_role='clip'").length,0);
  assert.equal((await report(f,'result',{codeBlocks:blocks,prompt:blocks.join('\n\n'),workerId:'stale'})).status,409);
  const result=await report(f,'result',{codeBlocks:blocks,prompt:blocks.join('\n\n')});assert.equal(result.status,200,JSON.stringify(result));
  assert.deepEqual(f.rows("SELECT duration FROM tasks WHERE task_role='clip' ORDER BY batch_index").map(r=>r.duration),[15,9]);
  await report(f,'result',{codeBlocks:blocks});await report(f,'error',{error:'late'});await report(f,'release');assert.equal(f.rows("SELECT * FROM tasks WHERE task_role='clip'").length,2);assert.equal(f.row('SELECT status FROM tasks WHERE id=?',f.id).status,'remix_segmented');
});
test('rewrite creates one newer version and keeps prior versions',async t=>{
  const f=await setup(t);await claim(f);const blocks=[block(1,0,15),block(2,15,24)];await report(f,'stage',{analysisBlocks:blocks});await report(f,'result',{codeBlocks:blocks});
  assert.equal((await f.call('reference-remix','PATCH',{body:{id:f.id,action:'rewrite',index:2,note:'加快运镜'}})).status,200);
  const job=await claim(f);assert.equal(job.kind,'remix-rewrite');assert.equal(job.referenceVideoUrl,undefined);assert.match(job.adaptationPrompt,/只输出第2段/);
  const result=await report(f,'result',{kind:'remix-rewrite',remixRound:2,codeBlocks:[block(2,15,24)]});assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.rows("SELECT * FROM tasks WHERE task_role='clip'").length,3);
});
