const {test}=require('node:test');
const assert=require('node:assert/strict');
const {siteFixture}=require('./helpers/site-routes.cjs');
const {segmentHeader,planRemixSegments}=require('../../lib/remix-segments.ts');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {VideoReview,reviewDirectory}=require('../src/video-review');
const {restorableTables}=require('../src/backup-manager');
const block=(i,a,b)=>`${segmentHeader(i,a,b)}\n${'运镜动作音效与口播细节。'.repeat(45)}`;
async function setup(t,seconds=24,autoQueue=true) {
  const f=await siteFixture(t);
  f.sqlite.prepare("INSERT INTO tiktok_accounts(id,name,archive_directory,created_at) VALUES('tk','印尼1','C:/isolated/TK',?)").run(new Date().toISOString());
  const form=new FormData();form.set('video',new File(['video'],'ref.mp4',{type:'video/mp4'}));form.append('images',new File(['img'],'product.png',{type:'image/png'}));
  form.set('autoQueue',String(autoQueue));form.set('videoSeconds',String(seconds));form.set('region','印尼');form.set('tiktokAccountName','印尼1');form.set('externalId','1735360337668113923');form.set('productName','测试商品');
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
  await report(f,'release');const j2=await claim(f,'b');assert.equal(j2.accountId,'b');assert.equal(f.row('SELECT gemini_account_id FROM tasks WHERE id=?',f.id).gemini_account_id,'a','fallback retains the originally pinned account for future rounds');
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

async function reviewFixture(t,seconds=24) {
  const f=await setup(t,seconds);await claim(f);
  const blocks=planRemixSegments(seconds).segments.map(s=>block(s.index,s.start,s.end));
  await report(f,'stage',{analysisBlocks:blocks});await report(f,'result',{codeBlocks:blocks});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flowcut-remix-review-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const publish=path.join(root,'TK');f.sqlite.prepare('UPDATE tasks SET archive_directory=?').run(publish);
  const prepareFiles=()=>{for(const c of f.rows("SELECT * FROM tasks WHERE task_role='clip'")) {
    const file=path.join(reviewDirectory(root,c.id),'clip.mp4');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,c.id);
    f.sqlite.prepare("UPDATE tasks SET status='video_ready',review_status='pending',download_path=? WHERE id=?").run(file,c.id);
  }};prepareFiles();
  const request=async(route,init={})=>{const url=new URL(route,'http://fixture');const r=await f.call(url.pathname.replace('/api/',''),init.method || 'GET',{query:url.search,body:init.body?JSON.parse(init.body):undefined});if(r.status>=400) throw Error(r.body.error);return r.body;};
  const order=[];
  const review=new VideoReview({userData:root,request,defaultDirectory:()=>publish,shell:{openPath:async()=>''},concatClips:async(files,out)=>{order.push(...files.map(file=>fs.readFileSync(file,'utf8')));fs.writeFileSync(out,files.map(file=>fs.readFileSync(file)).join(''));}});
  const check=async id=>{const r=await f.call('reference-remix','PATCH',{body:{id:f.id,action:'check',clipId:id}});assert.equal(r.status,200,JSON.stringify(r));};
  return {f,root,publish,review,check,order,prepareFiles,blocks};
}
test('remix concat refuses missing/unchecked/duplicate indices and direct segment approval',async t=>{
  const {f,review,check}=await reviewFixture(t);const clips=f.rows("SELECT id FROM tasks WHERE task_role='clip' ORDER BY batch_index").map(r=>r.id);
  await assert.rejects(review.finishRemix(f.id,true),/全部标记/);
  await check(clips[0]);await assert.rejects(review.finishRemix(f.id,true),/全部标记/);
  await assert.rejects(review.approve(clips[0],true),/不能单独放行/);
  assert.equal((await f.call('tasks/review','POST',{body:{id:clips[0],action:'reserve',confirmed:true}})).status,409);
  await check(clips[1]);assert.equal((await f.call('tasks/review','POST',{body:{id:f.id,action:'concat-reserve',concatId:'bad',sourceIds:[clips[0],clips[0]],confirmed:true}})).status,400);
});
test('mixed-round segment selections concatenate by segment index, automatically move to TK and delete every unused version',async t=>{
  const {f,review,check,prepareFiles,order,publish,blocks}=await reviewFixture(t);
  const first=f.rows("SELECT id FROM tasks WHERE task_role='clip' ORDER BY batch_index").map(r=>r.id);
  await f.call('reference-remix','PATCH',{body:{id:f.id,action:'rewrite',index:1}});await claim(f);await report(f,'result',{kind:'remix-rewrite',remixRound:2,codeBlocks:[blocks[0]]});prepareFiles();
  const newer=f.row('SELECT id FROM tasks WHERE batch_parent_id=? AND batch_round=2',f.id).id;
  await check(newer);await check(first[1]);
  const result=await review.finishRemix(f.id,true);
  assert.deepEqual(order,[newer,first[1]],'segment order takes priority over batch round');
  assert.equal(path.basename(result.file),'1735360337668113923.mp4');assert.equal(path.dirname(result.file),publish);assert.ok(fs.existsSync(result.file));
  assert.equal(f.row('SELECT status FROM tasks WHERE id=?',f.id).status,'remix_done');assert.equal(f.rows("SELECT * FROM tasks WHERE task_role='clip'").length,0);
  assert.equal(fs.readdirSync(publish).length,1);await review.finishRemix(f.id,true);assert.equal(fs.readdirSync(publish).length,1,'retry never releases a second copy');
});
test('one-segment group uses the same approval move without concatenation; direct approval remains blocked',async t=>{
  const {f,review,check,order,publish}=await reviewFixture(t,4);const id=f.row("SELECT id FROM tasks WHERE task_role='clip'").id;
  await check(id);await assert.rejects(review.approve(id,true),/不能单独放行/);
  const result=await review.finishRemix(f.id,true);assert.equal(order.length,0);assert.equal(path.dirname(result.file),publish);assert.equal(f.row('SELECT status FROM tasks WHERE id=?',f.id).status,'remix_done');assert.equal(f.row('SELECT review_status FROM tasks WHERE id=?',id).review_status,'approved');
});
test('segment regenerate keeps exact prompt/range and old checked version; no Gemini round',async t=>{
  const {f,check}=await reviewFixture(t);const original=f.row("SELECT * FROM tasks WHERE task_role='clip' ORDER BY batch_index");await check(original.id);
  const r=await f.call('tasks/recreate','POST',{body:{id:original.id,requestId:crypto.randomUUID()}});assert.equal(r.status,201,JSON.stringify(r));
  const repeated=await f.call('tasks/recreate','POST',{body:{id:original.id,requestId:r.body.id}});assert.equal(repeated.body.preserveSource,true);
  const next=f.row('SELECT * FROM tasks WHERE id=?',r.body.id);assert.equal(next.prompt,original.prompt);assert.equal(next.duration,original.duration);assert.equal(next.remix_segment_start,original.remix_segment_start);assert.equal(next.status,'video_queued');assert.equal(next.segment_checked_at,null);assert.equal(f.row('SELECT review_status FROM tasks WHERE id=?',original.id).review_status,'pending');
});
test('failed local concat returns checked clips and parent to segmented state',async t=>{
  const {f,review,check}=await reviewFixture(t);for(const row of f.rows("SELECT id FROM tasks WHERE task_role='clip'")) await check(row.id);
  review.concatClips=async()=>{throw Error('fake ffmpeg failure');};await assert.rejects(review.finishRemix(f.id,true),/拼接未完成/);
  assert.equal(f.row('SELECT status FROM tasks WHERE id=?',f.id).status,'remix_segmented');assert.ok(f.rows("SELECT review_status FROM tasks WHERE task_role='clip'").every(r=>r.review_status==='pending'));
});
test('lost approval acknowledgement resumes the receipt and startup completes cleanup without another release',async t=>{
  const {f,review,check,publish}=await reviewFixture(t);for(const c of f.rows("SELECT id FROM tasks WHERE task_role='clip'"))await check(c.id);
  const request=review.request;let lost=true;
  review.request=async(route,init)=>{const result=await request(route,init);if(init?.body){const b=JSON.parse(init.body);if(lost&&b.path&&!b.action){lost=false;throw Error('lost ack');}}return result;};
  await assert.rejects(review.finishRemix(f.id,true),/lost ack/);assert.equal(fs.readdirSync(publish).length,1);
  const recovered=await review.recoverConcats();assert.deepEqual(recovered.errors,[]);assert.equal(f.row('SELECT status FROM tasks WHERE id=?',f.id).status,'remix_done');assert.equal(fs.readdirSync(publish).length,1);
});
test('whole-group deletion cleans owned videos and partial files, retaining the library and other files',async t=>{
  const {f,root,review}=await reviewFixture(t);const clip=f.row("SELECT * FROM tasks WHERE task_role='clip' ORDER BY batch_index");
  const folder=reviewDirectory(root,clip.id);const partial=path.join(folder,'clip.mp4.partial'),other=path.join(folder,'notes.txt');fs.writeFileSync(partial,'partial');fs.writeFileSync(other,'keep');
  assert.equal((await f.call('tasks','DELETE',{body:{id:f.id}})).status,409);
  await review.deleteRemix(f.id,true);assert.equal(f.rows('SELECT * FROM tasks').length,0);assert.equal(f.rows('SELECT * FROM products').length,1);assert.ok(fs.existsSync(other));assert.equal(fs.existsSync(partial),false);assert.equal(fs.existsSync(clip.download_path),false);assert.equal([...f.objects.keys()].some(k=>k.startsWith('reference-remix/')),false);
});
test('saved-Gem holds apply to remix, and all held accounts leave it unclaimed',async t=>{
  const f=await setup(t);const task=f.row('SELECT gem_id,gem_content_snapshot FROM tasks WHERE id=?',f.id);
  const key=require('node:crypto').createHash('sha256').update(JSON.stringify([task.gem_id,task.gem_content_snapshot.trim()])).digest('hex');
  let result=await f.call('gemini-bridge','GET',{query:'?workerId=worker&accountIds=a,b&blockedGemVersions='+encodeURIComponent(JSON.stringify({a:[key],b:[key]}))});assert.equal(result.body.jobs.length,0);
  result=await f.call('gemini-bridge','GET',{query:'?workerId=worker&accountIds=a,b&blockedGemVersions='+encodeURIComponent(JSON.stringify({a:[key]}))});assert.equal(result.body.jobs[0].accountId,'b');
});
test('restored groups can reopen existing segments without starting a Gemini round or clearing original Task IDs',async t=>{
  const {f}=await reviewFixture(t);f.sqlite.prepare("UPDATE tasks SET status='failed',provider_job_id='original-local-task' WHERE task_role='clip'").run();f.sqlite.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(f.id);
  const round=f.row('SELECT batch_round FROM tasks WHERE id=?',f.id).batch_round;
  assert.equal((await f.call('reference-remix','PATCH',{body:{id:f.id,action:'resume-segments'}})).status,200);assert.equal(f.row('SELECT batch_round FROM tasks WHERE id=?',f.id).batch_round,round);
  assert.ok(f.rows("SELECT provider_job_id FROM tasks WHERE task_role='clip'").every(c=>c.provider_job_id==='original-local-task'));assert.equal(await claim(f),undefined);
});
test('reanalyzed ranges cannot accidentally approve an old checked version',async t=>{
  const {f,check}=await reviewFixture(t);const old=f.row("SELECT id FROM tasks WHERE task_role='clip' AND batch_index=1").id;await check(old);
  await f.call('reference-remix','PATCH',{body:{id:f.id,action:'reanalyze'}});await claim(f);
  const changed=[block(1,0,14),block(2,14,24)];await report(f,'stage',{remixRound:2,analysisBlocks:changed});await report(f,'result',{remixRound:2,codeBlocks:changed});
  assert.equal((await f.call('reference-remix','PATCH',{body:{id:f.id,action:'check',clipId:old}})).status,409);
});
test('late failure and release reports from a prior round cannot reopen a newer claim, even with the same desktop worker',async t=>{
  const {f}=await reviewFixture(t);await f.call('reference-remix','PATCH',{body:{id:f.id,action:'readapt'}});const job=await claim(f);assert.equal(job.remix.round,2);
  assert.equal((await report(f,'defer',{error:'old round'})).status,409);await report(f,'release');await report(f,'error',{error:'old failure'});
  assert.equal(f.row('SELECT status FROM tasks WHERE id=?',f.id).status,'remix_adapting');assert.equal(f.rows("SELECT * FROM tasks WHERE task_role='clip'").length,2);
});
test('backup restore pauses unfinished remix work while retaining scripts, ranges, task ids and completed groups',()=>{
  const restored=restorableTables({tasks:[{id:'g',task_role:'remix',status:'remix_adapting',remix_script:'durable',error:null},{id:'c',task_role:'clip',status:'video_generating',provider_job_id:'remote',remix_segment_start:15,error:null},{id:'done',task_role:'remix',status:'remix_done'}]});
  assert.equal(restored.tasks[0].status,'failed');assert.equal(restored.tasks[0].remix_script,'durable');assert.equal(restored.tasks[1].provider_job_id,'remote');assert.equal(restored.tasks[1].status,'failed');assert.equal(restored.tasks[2].status,'remix_done');
});

test('prompt-only remix clips remain manual and can enter the existing Seedance queue explicitly',async t=>{
  const f=await setup(t,24,false);await claim(f);const blocks=[block(1,0,15),block(2,15,24)];await report(f,'stage',{analysisBlocks:blocks});await report(f,'result',{codeBlocks:blocks});
  const clips=f.rows("SELECT * FROM tasks WHERE task_role='clip'");assert.ok(clips.every(c=>c.status==='prompt_ready'));
  const result=await f.call('tasks','PATCH',{body:{id:clips[0].id,action:'queue'}});assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.row('SELECT status FROM tasks WHERE id=?',clips[0].id).status,'video_queued');
});
