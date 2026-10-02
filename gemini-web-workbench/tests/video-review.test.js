const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {VideoReview,reviewDirectory,moveToStaging} = require('../src/video-review');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flowcut-review-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(reviewDirectory(root,'task-1'),'1735360337668113923.mp4');
  fs.mkdirSync(path.dirname(source),{recursive:true}); fs.writeFileSync(source,'test-mp4-bytes');
  const task={id:'task-1',status:'video_ready',review_status:'pending',download_path:source,archive_directory:path.join(root,'publishing'),product_external_id:'1735360337668113923',tiktok_account_name:'A'};
  const tasks={'task-1':task}; let failReport=false; const opened=[],trashed=[];
  const runtime=new VideoReview({userData:root,defaultDirectory:()=>path.join(root,'default'),shell:{openPath:async p=>{opened.push(p);return '';},trashItem:async p=>{trashed.push(p);fs.renameSync(p,p+'.recycled');}},request:async (url,options)=>{
    if(!options) { const query=new URL('http://local'+url).searchParams; const value=tasks[query.get('id')]; if(!value){if(query.get('optional')==='1')return null;throw Error('missing');}return {...value}; }
    const body=JSON.parse(options.body);
    if(body.action==='reserve') { if(!['pending','approving'].includes(task.review_status))throw Error('not pending');task.review_status='approving'; }
    else if(body.action==='cancel') {if(task.review_status==='approving')task.review_status='pending';}
    else if(body.action==='discard') {if(failReport)throw Error('local server unavailable');delete tasks[body.id];}
    else {if(failReport)throw Error('local server unavailable');task.review_status='approved';task.approved_path=body.path;}
    return {ok:true};
  }});
  return {root,source,task,tasks,runtime,opened,trashed,failReport:v=>failReport=v};
}
test('pending video lives outside publishing directory; opens exact local video externally',async t=>{
  const f=fixture(t);assert.equal(fs.existsSync(f.task.archive_directory),false);
  await f.runtime.open('task-1');assert.deepEqual(f.opened,[fs.realpathSync(f.source)]);
});
test('approval needs explicit confirmation, publishes exact product filename and is idempotent',async t=>{
  const f=fixture(t);await assert.rejects(f.runtime.approve('task-1',false));
  assert.equal(fs.existsSync(f.task.archive_directory),false);
  const result=await f.runtime.approve('task-1',true);
  assert.equal(path.basename(result.file),f.task.product_external_id+'.mp4');
  assert.equal(fs.readFileSync(result.file,'utf8'),'test-mp4-bytes');
  assert.equal(fs.existsSync(f.source),false,'approval moves, never retains a review video copy');
  assert.equal(f.task.review_status,'approved');
  await f.runtime.open('task-1');assert.deepEqual(f.opened,[fs.realpathSync(result.file)]);
  assert.equal((await f.runtime.approve('task-1',true)).alreadyApproved,true);
});
test('lost approval response and publisher deleting output never requeues a duplicate',async t=>{
  const f=fixture(t);f.failReport(true);await assert.rejects(f.runtime.approve('task-1',true));
  const record=JSON.parse(fs.readFileSync(path.join(path.dirname(f.source),'approval.json')));
  assert.ok(record.approvedAt && record.timeZone,'approval time and local timezone persist before writeback');
  fs.unlinkSync(record.file);f.failReport(false);
  await f.runtime.approve('task-1',true);
  assert.equal(fs.existsSync(record.file),false);assert.equal(f.task.review_status,'approved');
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(f.source),'approval.json'))).approvedAt,record.approvedAt,'retry keeps original approval time');
});
test('missing video and invalid product ID do not approve or expose a file',async t=>{
  const f=fixture(t);f.task.product_external_id='wrong';await assert.rejects(f.runtime.approve('task-1',true),/商品 ID/);
  assert.equal(f.task.review_status,'pending');fs.unlinkSync(f.source);
  await assert.rejects(f.runtime.open('task-1'));assert.equal(f.opened.length,0);
});
test('legacy file already in publishing directory is not duplicated',async t=>{
  const f=fixture(t);fs.mkdirSync(f.task.archive_directory,{recursive:true});
  f.task.download_path=path.join(f.task.archive_directory,'1735360337668113923.mp4');fs.copyFileSync(f.source,f.task.download_path);
  assert.equal((await f.runtime.approve('task-1',true)).legacy,true);
  assert.equal(fs.readdirSync(f.task.archive_directory).length,1);
});
test('remake deletes old video permanently and removes old task, retaining only replacement',async t=>{
  const f=fixture(t);await assert.rejects(f.runtime.discard('task-1','new'));
  assert.ok(fs.existsSync(f.source));f.tasks.new={id:'new',regenerated_from_task_id:'task-1'};
  await assert.rejects(f.runtime.discard('task-1','new'));f.task.review_status='replaced';
  await f.runtime.discard('task-1','new');await f.runtime.discard('task-1','new');
  assert.equal(f.trashed.length,0);assert.equal(fs.existsSync(f.source),false);
  assert.equal(fs.existsSync(f.source+'.recycled'),false);
  assert.deepEqual(Object.keys(f.tasks),['new']);
});

test('retry after record deletion failed completes deletion without another generation',async t=>{
  const f=fixture(t);f.tasks.new={id:'new',regenerated_from_task_id:'task-1'};f.task.review_status='replaced';
  f.failReport(true);await assert.rejects(f.runtime.discard('task-1','new'));
  assert.equal(fs.existsSync(f.source),false);f.failReport(false);
  await f.runtime.discard('task-1','new');assert.deepEqual(Object.keys(f.tasks),['new']);
});
test('already approved tasks cannot be discarded through remake',async t=>{
  const f=fixture(t);await f.runtime.approve('task-1',true);f.tasks.new={id:'new',regenerated_from_task_id:'task-1'};
  await assert.rejects(f.runtime.discard('task-1','new'));assert.ok(fs.existsSync(f.task.approved_path));
});

test('same-volume move uses rename without copying and resumes staged files',t=>{
  const f=fixture(t),temp=path.join(f.root,'staged.partial');
  moveToStaging(f.source,temp,{...fs,copyFileSync:()=>assert.fail('same-volume move must not copy')});
  assert.equal(fs.existsSync(f.source),false);assert.equal(fs.readFileSync(temp,'utf8'),'test-mp4-bytes');
  moveToStaging(f.source,temp);
});

test('cross-volume move removes source only after complete staging; locked source retries',t=>{
  const f=fixture(t),temp=path.join(f.root,'staged.partial');
  const crossVolume={...fs,renameSync:()=>{throw Object.assign(Error('cross volume'),{code:'EXDEV'});}};
  assert.throws(()=>moveToStaging(f.source,temp,{...crossVolume,unlinkSync:()=>{throw Error('locked');}}),/locked/);
  assert.equal(fs.existsSync(f.source),true);
  moveToStaging(f.source,temp,crossVolume);
  assert.equal(fs.existsSync(f.source),false);assert.equal(fs.readFileSync(temp,'utf8'),'test-mp4-bytes');
});

test('cross-volume copy failure keeps source and does not create a publishable MP4',t=>{
  const f=fixture(t),temp=path.join(f.root,'staged.partial');
  assert.throws(()=>moveToStaging(f.source,temp,{...fs,renameSync:()=>{throw Object.assign(Error('cross volume'),{code:'EXDEV'});},copyFileSync:()=>{fs.writeFileSync(temp,'partial');throw Error('disk full');}}),/disk full/);
  assert.equal(fs.readFileSync(f.source,'utf8'),'test-mp4-bytes');
});

test('interrupted moving intent resumes without retaining review video',async t=>{
  const f=fixture(t),file=path.join(f.root,'publishing','1735360337668113923.mp4'),temp=file+'.partial';
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.renameSync(f.source,temp);
  fs.writeFileSync(path.join(path.dirname(f.source),'approval.json'),JSON.stringify({status:'moving',source:f.source,file,temp}));
  await f.runtime.approve('task-1',true);
  assert.equal(fs.existsSync(f.source),false);assert.equal(fs.existsSync(temp),false);assert.ok(fs.existsSync(file));
});

test('1.4.19 interrupted copy approval removes leftover review video without duplicating release',async t=>{
  const f=fixture(t),file=path.join(f.root,'publishing','1735360337668113923.mp4');
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(f.source,file);
  fs.writeFileSync(path.join(path.dirname(f.source),'approval.json'),JSON.stringify({status:'released',file}));
  await f.runtime.approve('task-1',true);assert.equal(fs.existsSync(f.source),false);assert.ok(fs.existsSync(file));
});

test('review folder can be opened without exposing videos to publishing',async t=>{
  const f=fixture(t);await f.runtime.openFolder();assert.deepEqual(f.opened,[path.join(f.root,'review-videos')]);
  assert.equal(fs.existsSync(f.task.archive_directory),false);
});
