const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {splitDualPrompts,acceptDualJob,dualStatus}=require('../../vendor/seedance-engine/dual-video');
const {DualVideoComposer,segmentDirectory,probe,segmentTiming}=require('../src/dual-video-composer');
const {cleanupSegments,reviewDirectory}=require('../src/video-review');
const {completedDelivery}=require('../src/video-delivery');
const {FlowCutBridge}=require('../../vendor/seedance-engine/flowcut-bridge');
const part=n=>`生成一段完整连续15秒，9:16竖屏。第${n}段。\n`+'产品图片、人物和音色保持一致；每个镜头真实自然。'.repeat(24);
const response=(fenced=false)=>`创意策略\n视频1｜上半段｜15秒\n${fenced?'```text\n':''}${part(1)}${fenced?'\n```':''}\n视频2｜下半段｜15秒\n${fenced?'```text\n':''}${part(2)}${fenced?'\n```':''}\n拼接说明\n先1后2；这里不是生成提示词。`;

test('parses both rendered text and fenced prompts, without strategy or joining notes',()=>{
  for(const fenced of [true,false]) assert.deepEqual(splitDualPrompts(response(fenced)),[part(1),part(2)]);
  for(const bad of ['一段提示词',response()+ '\n视频1｜另一条创意\n'+part(1),response().replace(part(2),'15秒太短'),response().replace('视频1｜','视频2｜')]) assert.throws(()=>splitDualPrompts(bad));
});
test('spoken word budgets are metadata, not additional video headings',()=>{
  const budget='视频1：约39词（Taglish），预计朗读13.0秒。\n视频2：约38词（Taglish），预计朗读12.6秒。\n';
  assert.deepEqual(splitDualPrompts(budget+response()),[part(1),part(2)]);
  assert.throws(()=>splitDualPrompts(budget),'budgets alone cannot create prompts');
});

const directive=n=>`生成一段完整连续的15秒、9:16竖屏视频。这是30秒内容的${n===1?'上':'下'}半段，本次只生成本段15秒。\n${part(n)}`;
test('rendered code bodies without headings retain both complete generation tasks',()=>{
  for(const label of ['', '【生成任务】\n', '生成任务：\n', '1. 生成任务：\n', '1. 生成任务：']) {
    const parts=[1,2].map(n=>label+directive(n));
    for(const render of [p=>'Plaintext\n'+p,p=>'```text\n'+p+'\n```',p=>p]) {
      const text='创意策略\n视频1：39词；预计朗读13秒。\n视频2：38词；预计朗读12秒。\n\n'+parts.map(render).join('\n\n')+'\n\n拼接说明\n参考上段末帧，不应提交这段说明';
      assert.deepEqual(splitDualPrompts(text),parts);
    }
  }
});

test('missing headings never permit reversed, duplicated, missing or short generation bodies',()=>{
  const upper=directive(1),lower=directive(2);
  for(const text of [upper,lower+'\n'+upper,upper+'\n'+upper,upper+'\n'+lower+'\n'+upper,upper+'\n生成一段15秒视频，这是下半段。',response().replace('视频1｜上半段','视频1｜下半段')]) {
    assert.throws(()=>splitDualPrompts(text));
  }
});

function fixture(){
  let sequence=0,downloads=0;const retries=[];
  const store={tasks:[],isFlowcutTaskCleared:()=>false,upsertTask:t=>{if(!store.tasks.includes(t))store.tasks.push(t);}};
  const bridge={store,sentStatus:new Map(),downloadImages:async()=>{downloads++;return ['image.png'];},acknowledge:async()=>{},resumeRequeuedTask:async t=>{if(t.status==='failed'){retries.push(t.id);t.status='upload_wait';}},engine:{createTask:(prompt,paths,meta)=>{const t={id:String(++sequence),prompt,status:'upload_wait',imageItems:paths.map(localPath=>({localPath})),...meta};store.upsertTask(t);return t;}}};
  return {bridge,store,retries,downloads:()=>downloads,job:{id:'parent',kind:'standard',duration:30,prompt:response(),tiktokAccountName:'shop',productExternalId:'123456789012'}};
}
test('one parent creates two 15s children; replay/restart and failed second segment reuse first',async()=>{
  const f=fixture();await acceptDualJob(f.bridge,f.job);assert.equal(f.store.tasks.length,2);assert.deepEqual(f.store.tasks.map(t=>t.duration),[15,15]);
  f.store.tasks[0].status='success';f.store.tasks[0].lastDownloadedPath='first.mp4';f.store.tasks[1].status='failed';
  f.store.tasks=JSON.parse(JSON.stringify(f.store.tasks));await acceptDualJob(f.bridge,f.job);
  assert.equal(f.store.tasks.length,2);assert.deepEqual(f.retries,['2']);assert.equal(f.downloads(),1);assert.equal(f.store.tasks[0].lastDownloadedPath,'first.mp4');
  await assert.rejects(acceptDualJob(f.bridge,{...f.job,prompt:response()+'changed'}),/提示词已变化/);
});
test('recovers interruption between creating first and second child without resubmitting first',async()=>{
  const f=fixture();await acceptDualJob(f.bridge,f.job);f.store.tasks.pop();await acceptDualJob(f.bridge,f.job);assert.deepEqual(f.store.tasks.map(t=>t.segmentIndex),[1,2]);assert.equal(f.store.tasks[0].id,'1');
});
test('incomplete or refused output never creates any child',async()=>{const f=fixture();await assert.rejects(acceptDualJob(f.bridge,{...f.job,prompt:'拒绝生成'}));assert.equal(f.store.tasks.length,0);assert.equal(f.downloads(),0);});
test('timing uses the full spoken tail, accepts moderate deviations, and rejects damaged inputs',()=>{
  const media=(video,audio)=>({streams:[{codec_type:'video',duration:video},...(audio===undefined?[]:[{codec_type:'audio',duration:audio}])]});
  const timing=segmentTiming(media(13.208333,13.815873),2);
  assert.equal(timing.duration,13.815873);assert.ok(timing.stretch>1 && timing.stretch<1.1);
  assert.equal(segmentTiming(media(16.5,16.5),1).tempo,1.1);
  assert.equal(segmentTiming(media(12),1).audioDuration,0);
  for(const input of [media(3,3),media(25,25),media(13,15),media('N/A'),media(15,'NaN')]) assert.throws(()=>segmentTiming(input,2),/第 2 段/);
  assert.equal(segmentTiming({streams:[{codec_type:'video',duration_ts:360,time_base:'1/24'}]},1).duration,15);
});
test('only combined video can mark the main task ready; reports failing segment',async()=>{
  const f=fixture();await acceptDualJob(f.bridge,f.job);for(const t of f.store.tasks){t.status='success';t.lastDownloadedPath=`${t.id}.mp4`;t.videoUrl='https://segment';}
  let status=dualStatus(f.store.tasks);assert.equal(status.providerStatus,'generating');assert.equal(status.outputUrl,'');assert.equal(status.downloadPath,'');
  f.store.tasks[1].status='failed';assert.match(dualStatus(f.store.tasks).error,/第 2 段/);
  f.store.tasks[1].status='success';f.store.tasks[0].combinedPath='combined.mp4';assert.equal(dualStatus(f.store.tasks).downloadPath,'combined.mp4');
});
test('bridge sync sends one aggregate, never child URLs; parallel ticks compose once',async()=>{
  const f=fixture();await acceptDualJob(f.bridge,f.job);for(const t of f.store.tasks){t.status='success';t.lastDownloadedPath='clip.mp4';}
  let finish,calls=0;const bodies=[];const b=new FlowCutBridge({store:{...f.store,settings:{flowcutWorkerId:'test'}},engine:{},composeDual:()=>{calls++;return new Promise(r=>finish=r);}});
  b.request=async(_,init)=>bodies.push(JSON.parse(init.body));b.scheduleCompositions();b.scheduleCompositions();assert.equal(calls,1);
  await b.syncStatuses();assert.equal(bodies.length,1);assert.equal(bodies[0].taskId,'parent');assert.equal(bodies[0].downloadPath,'');finish('combined.mp4');await new Promise(r=>setImmediate(r));await b.syncStatuses();assert.equal(bodies[1].downloadPath,'combined.mp4');
});

test('real ffmpeg joins in order with audio, recovers receipt, and cleans only task-owned segments',{timeout:180000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flowcut-dual-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const children=[1,2].map(segmentIndex=>({id:`local${segmentIndex}`,flowcutTaskId:'parent',segmentIndex,dualSignature:'test',status:'success'}));
  for (const task of children) {
    const dir=segmentDirectory(root,'parent',task.segmentIndex);fs.mkdirSync(dir,{recursive:true});task.lastDownloadedPath=path.join(dir,'clip.mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=${task.segmentIndex===1?'red':'blue'}:s=180x320:r=15:d=15`,'-f','lavfi','-i',`sine=frequency=${task.segmentIndex*440}:duration=15`,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-t','15',task.lastDownloadedPath],{windowsHide:true});
  }
  const composer=new DualVideoComposer(root);
  const file=await composer.compose(children);const info=await probe(file);
  assert.ok(Math.abs(Number(info.format.duration)-30)<0.2);assert.ok(info.streams.some(s=>s.codec_type==='audio'));
  for(const [seconds,index] of [[2,0],[17,2]]) {
    const pixel=execFileSync('ffmpeg',['-v','error','-ss',String(seconds),'-i',file,'-vframes','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{windowsHide:true});
    assert.ok(pixel[index]>200 && pixel[(index+2)%3]<40,'segment ordering');
  }
  // Simulate crash after atomic rename, before receipt.
  for(const name of ['composition.json','composition.json.bak']) {const p=path.join(reviewDirectory(root,'parent'),name);if(fs.existsSync(p))fs.unlinkSync(p);}
  assert.equal(await composer.compose(children),file);
  fs.unlinkSync(file);assert.equal(await new DualVideoComposer(root).compose(children),file);assert.equal(fs.existsSync(file),false,'published file must never be recreated');
  // A child must not recover a sibling or final video.
  const delivered=await completedDelivery(root,{...children[1],lastDownloadedPath:undefined});assert.equal(delivered.file,children[1].lastDownloadedPath);
  cleanupSegments(root,'parent');assert.equal(fs.existsSync(path.join(reviewDirectory(root,'parent'),'segments')),false);assert.ok(fs.existsSync(path.join(reviewDirectory(root,'parent'),'composition.json')));
});

test('real short clip with longer spoken tail becomes 30s without dropping tail or changing pitch',{timeout:180000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flowcut-dual-short-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const children=[1,2].map(segmentIndex=>({flowcutTaskId:'short-parent',segmentIndex,dualSignature:'short-test'}));
  for(const task of children){
    const first=task.segmentIndex===1,dir=segmentDirectory(root,task.flowcutTaskId,task.segmentIndex);fs.mkdirSync(dir,{recursive:true});
    task.lastDownloadedPath=path.join(dir,'clip.mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=${first?'red':'blue'}:s=180x320:r=24:d=${first?'15.041667':'13.208333'}`,'-f','lavfi','-i',`sine=frequency=880:sample_rate=48000:duration=${first?'15.069002':'13.815873'}`,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',task.lastDownloadedPath],{windowsHide:true});
  }
  const file=await new DualVideoComposer(root).compose(children),info=await probe(file);
  assert.ok(Math.abs(Number(info.format.duration)-30)<0.05);
  const video=info.streams.find(s=>s.codec_type==='video');assert.equal(Number(video.nb_frames),900);
  for(const [time,channel] of [[14.8,0],[15.1,2],[29.8,2]]){
    const pixel=execFileSync('ffmpeg',['-v','error','-ss',String(time),'-i',file,'-vframes','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{windowsHide:true});
    assert.ok(pixel[channel]>200,'no gap and correct order');
  }
  const pcm=execFileSync('ffmpeg',['-v','error','-ss','29.25','-i',file,'-t','0.5','-vn','-ac','1','-ar','48000','-f','s16le','pipe:1'],{windowsHide:true});
  let energy=0,crossings=0,previous=0;
  for(let i=0;i<pcm.length;i+=2){const sample=pcm.readInt16LE(i);energy+=sample*sample;if(previous<=0 && sample>0)crossings++;previous=sample;}
  assert.ok(Math.sqrt(energy/(pcm.length/2))>500,'spoken tail is not silent padding');
  assert.ok(Math.abs(crossings/(pcm.length/2/48000)-880)<20,'tempo adjustment preserves pitch');
});
