const {test}=require('node:test');const assert=require('node:assert/strict');
const {resumeRemixSeedance}=require('../src/remix-seed-recovery');
const {BridgeEngine}=require('../src/bridge-engine');
test('desktop stage/failure reports carry the active remix round',async()=>{
  const engine=new BridgeEngine({store:{},getAuthenticatedAccounts:()=>[],runJob:async()=>{},onChange:()=>{}});
  engine.active.set('account',{taskId:'task',remixRound:3});let reported;
  engine.request=async(_url,init)=>{reported=JSON.parse(init.body);return {ok:true};};
  await engine.report('task','defer',{kind:'remix-segments'});assert.equal(reported.remixRound,3);
});
test('restore resumes only the matching existing local identity through the journal-aware retry function',async()=>{
  const local={id:'local',taskId:'remote',flowcutTaskId:'clip',status:'submit_unconfirmed',backupRestoreHold:true};
  const calls=[],bridge={sentStatus:new Map([['local','old']]),syncStatuses:async()=>calls.push('sync'),scheduleAutoDownloads:()=>calls.push('download')};
  const input={task:{id:'clip',provider_job_id:'local',task_role:'clip',remix_segment_start:0},parent:{task_role:'remix',status:'remix_segmented'},store:{tasks:[local]},engine:{retryTask:async id=>{calls.push(id);return {action:'held'};}},bridge};
  assert.equal((await resumeRemixSeedance(input)).action,'held');assert.deepEqual(calls,['local','sync','download']);assert.equal(local.taskId,'remote');assert.equal(local.backupRestoreHold,true);
  calls.length=0;local.status='generating';await resumeRemixSeedance(input);assert.deepEqual(calls,['sync','download']);
  await assert.rejects(resumeRemixSeedance({...input,store:{tasks:[]}}),/未创建或重新提交/);
});
