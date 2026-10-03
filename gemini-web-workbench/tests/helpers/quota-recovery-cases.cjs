'use strict';
const assert = require('node:assert/strict');
const {patchEngine,isDailyModelQuota} = require('../../src/seedance-quota-recovery.cjs');
const QUOTA = 'User Generation Day Limit: limit_level=STRATEGY';

module.exports = async (fixture, test) => {
  function setup(model='2000012') {
    const f=fixture();
    for (const a of f.store.data.accounts) a.preferredModel=model;
    const task={id:'task',status:'queued',accountId:'a',accountName:'A',model,prompt:'test',duration:15,attempts:0,
      imageItems:[{name:'image',localPath:'image.png',uploadedUrl:'url-a',uploadedAccountId:'a'}],taskId:'',taskIds:[],logs:[]};
    f.store.data.tasks.push(task);
    patchEngine(f.engine);
    const submissions=[];
    f.accounts.client=id=>({submitTask:async task=>{
      submissions.push({id,model:task.model}); throw new Error(QUOTA);
    }});
    return {...f,task,submissions};
  }
  await test('recognizes daily quota without classifying ordinary errors',()=>{
    assert.equal(isDailyModelQuota(new Error(QUOTA)),true);
    assert.equal(isDailyModelQuota({errorMessage:QUOTA}),true);
    for(const msg of ['Bad Request','Too Many Requests','User concurrency limit','SensitiveContentDetected']) assert.equal(isDailyModelQuota(msg),false);
  });
  for(const model of ['2000012','2000004']) await test(`${model}: real submit failure moves task to second account and reuploads`,async()=>{
    const f=setup(model);
    await f.engine.submitTask(f.task,f.accounts.account('a'));
    assert.deepEqual(f.submissions,[{id:'a',model}]);
    assert.equal(f.accounts.modelExhausted(f.accounts.account('a'),model),true);
    assert.equal(f.task.accountId,'b');assert.equal(f.task.model,model);assert.equal(f.task.status,'upload_wait');
    assert.equal(f.task.imageItems[0].uploadedUrl,'');assert.equal(f.task.imageItems[0].uploadedAccountId,'');
    assert.equal(f.task.imageItems[0].localPath,'image.png');assert.equal(f.accounts.account('a').preferredModel,model);
    assert.equal(f.accounts.modelExhausted(f.accounts.account('a'),model==='2000012'?'2000004':'2000012'),false);
  });
  await test('different selected model on second account is not silently substituted',()=>{
    const f=setup();f.accounts.account('b').preferredModel='2000004';
    f.engine.switchAfterQuota(f.task,'a',QUOTA);
    assert.equal(f.task.status,'model_wait');assert.equal(f.task.model,'2000012');
    f.engine.resumeModelWaiters();assert.equal(f.task.status,'model_wait');
    assert.equal(f.accounts.account('b').preferredModel,'2000004');
  });
  await test('both accounts exhausted waits and resumes after daily reset',()=>{
    const f=setup();f.accounts.markModelExhausted('b','2000012',QUOTA);f.engine.switchAfterQuota(f.task,'a',QUOTA);
    assert.equal(f.task.status,'model_wait');f.engine.resumeModelWaiters();assert.equal(f.task.status,'model_wait');
    f.accounts.todayKey=()=> '2099-01-01';f.engine.resumeModelWaiters();
    assert.equal(f.task.status,'queued');assert.equal(f.task.model,'2000012');
  });
  await test('unauthenticated or disabled accounts are skipped',()=>{
    for(const mode of ['auth','disabled']){
      const f=setup();if(mode==='auth') f.accounts.runtime.get('b').authenticated=false;else f.accounts.account('b').enabled=false;
      f.engine.switchAfterQuota(f.task,'a',QUOTA);assert.equal(f.task.status,'model_wait');
    }
  });
  await test('other queued tasks leave the exhausted account before submission',()=>{
    const f=setup();f.accounts.markModelExhausted('a','2000012',QUOTA);f.engine.resumeModelWaiters();
    assert.equal(f.task.accountId,'b');assert.equal(f.task.status,'upload_wait');
  });
  await test('only explicit manual model choice changes a waiting task model',()=>{
    const f=setup();f.accounts.markModelExhausted('b','2000012',QUOTA);f.engine.switchAfterQuota(f.task,'a',QUOTA);
    f.accounts.setPreferredModel('a','2000004');f.engine.resumeModelWaiters();
    assert.equal(f.task.model,'2000004');assert.equal(f.task.status,'queued');
    assert.equal(f.accounts.account('b').preferredModel,'2000012');
  });
  await test('ordinary rejected submissions remain ordinary failures',async()=>{
    const f=setup();f.accounts.client=()=>({submitTask:async()=>{throw new Error('Bad Request');}});
    await f.engine.submitTask(f.task,f.accounts.account('a'));
    assert.equal(f.task.status,'failed');assert.equal(f.accounts.modelExhausted(f.accounts.account('a'),'2000012'),false);
  });
  await test('existing remote jobs are never reassigned by the waiting-task scan',()=>{
    const f=setup();f.task.status='model_wait';f.task.taskId='already-submitted';f.accounts.markModelExhausted('a','2000012',QUOTA);
    f.engine.resumeModelWaiters();assert.equal(f.task.accountId,'a');assert.equal(f.task.taskId,'already-submitted');
  });
};
