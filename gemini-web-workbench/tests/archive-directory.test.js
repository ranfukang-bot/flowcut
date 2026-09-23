const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SeedanceRuntime } = require('../src/seedance-runtime');
const { FlowCutBridge } = require('../../vendor/seedance-engine/flowcut-bridge');
const { originalVideoFilename } = require('../../vendor/seedance-engine/video-download');
const { WorkbenchStore } = require('../../vendor/seedance-engine/store');
function box(type, bytes) { const b = Buffer.alloc(8); b.writeUInt32BE(bytes.length + 8); b.write(type, 4); return Buffer.concat([b, bytes]); }
const video = Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov', Buffer.from('meta')), box('mdat', Buffer.from('frame'))]);
function temp(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'flowcut-archive-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root; }
for (const productId of ['1735360337668113923','']) test(`download uses chosen folder directly and ${productId ? 'exact product ID' : 'original remote filename'}`,async t=>{
  const root=temp(t), chosen=path.join(root,'chosen','Any folder');
  const task={id:'test',taskId:'remote-task',prompt:'Original fallback',status:'success',tiktokAccountName:'Shop',archiveDirectory:chosen,productExternalId:productId,videoUrl:'https://example.test/video'};
  const runtime=new SeedanceRuntime({app:{getPath:()=>path.join(root,'default')},flowcutStore:{}});
  runtime.emit=()=>{}; runtime.store={settings:{downloadDirectory:path.join(root,'wrong')},getTask:()=>task};
  runtime.engine={refreshTaskResult:async()=>task,recordTask:()=>{}};
  runtime.accountManager={session:()=>({fetch:async()=>new Response(video,{headers:{'content-type':'video/mp4','content-disposition':"attachment; filename*=UTF-8''%E5%8E%9F%E5%A7%8B%E5%90%8D%E7%A7%B0.mp4"}})})};
  const result=await runtime.downloadTask(task);
  assert.equal(path.dirname(result.destination),chosen);
  assert.equal(path.basename(result.destination),productId ? productId+'.mp4' : '原始名称.mp4');
  assert.equal(task.lastDownloadedPath,result.destination);
  assert.deepEqual(fs.readFileSync(result.destination),video);
  let duplicate=0;
  const store=new WorkbenchStore(path.join(root,'state'));store.addTasks([task]);
  const bridge=new FlowCutBridge({store,engine:{},downloadTask:async()=>duplicate++});
  bridge.scheduleAutoDownload(task);await new Promise(setImmediate);assert.equal(duplicate,0);
});
test('original filename fallback stays inside selected directory',()=>{
  assert.equal(originalVideoFilename(new Response('',{headers:{'content-disposition':'attachment; filename="../../safe.mp4"'}}),'https://example.test/v'),'safe.mp4');
  assert.equal(originalVideoFilename(new Response(''),'https://example.test/original.mp4?token=hidden'),'original.mp4');
  assert.equal(originalVideoFilename(new Response(''),'https://example.test/video'),'');
});
