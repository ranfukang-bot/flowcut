const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { observeGeminiUploads, isUploadRequest } = require('../src/gemini-upload-network');
test('only Google upload transport is tracked, never analytics or generation',()=>{
  assert.equal(isUploadRequest({method:'POST',url:'https://content-push.googleapis.com/upload/'}),true);
  assert.equal(isUploadRequest({method:'POST',url:'https://gemini.google.com/resumable',headers:{'X-Goog-Upload-Command':'upload, finalize'}}),true);
  for(const url of ['https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate','https://example.com/upload']) assert.equal(isUploadRequest({method:'POST',url}),false);
});
test('preview before response is not completion; HTTP errors and disconnects are retained',async()=>{
  const api = new EventEmitter(); let attached=false;
  Object.assign(api,{isAttached:()=>attached,attach:()=>{attached=true;},detach:()=>{attached=false;},sendCommand:async()=>({})});
  const monitor=await observeGeminiUploads({debugger:api}); monitor.begin();
  const emit=(method,params)=>api.emit('message',{},'Network.'+method,params);
  const start=id=>emit('requestWillBeSent',{requestId:id,request:{method:'POST',url:'https://content-push.googleapis.com/upload/'}});
  start('a'); start('b'); assert.equal(monitor.status().pending,2);
  emit('responseReceived',{requestId:'a',response:{status:200}}); assert.equal(monitor.status().completed,0);
  emit('loadingFinished',{requestId:'a'}); assert.equal(monitor.status().completed,1); assert.equal(monitor.status().pending,1);
  emit('responseReceived',{requestId:'b',response:{status:503}});emit('loadingFinished',{requestId:'b'});
  assert.deepEqual(monitor.status().failed,['HTTP 503']);
  monitor.begin(); assert.equal(monitor.status().observed,0);
  start('c');emit('loadingFailed',{requestId:'c',errorText:'net::ERR_CONNECTION_RESET'});
  assert.deepEqual(monitor.status().failed,['net::ERR_CONNECTION_RESET']);
  api.emit('detach');assert.equal(monitor.status().available,false);
  await monitor.stop();assert.equal(api.listenerCount('message'),0);assert.equal(api.listenerCount('detach'),0);
});

test('generation headers alone do not prove a reply and do not count as uploads',async()=>{
  const api=new EventEmitter();Object.assign(api,{isAttached:()=>true,sendCommand:async()=>({})});
  const monitor=await observeGeminiUploads({debugger:api});monitor.begin();
  const emit=(method,params)=>api.emit('message',{},'Network.'+method,params);
  emit('requestWillBeSent',{requestId:'g',request:{method:'POST',url:'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'}});
  emit('responseReceived',{requestId:'g',response:{status:200}});
  assert.equal(monitor.status().observed,0);
  assert.deepEqual(monitor.status().generation,[{endpoint:'StreamGenerate',status:200,bytes:0,done:false,error:''}]);
  emit('dataReceived',{requestId:'g',dataLength:123});emit('loadingFinished',{requestId:'g'});
  assert.equal(monitor.status().generation[0].bytes,123);assert.equal(monitor.status().generation[0].done,true);
  await monitor.stop();
});

test('keeps the worker active until completion and restores a shared debugger without detaching it',async()=>{
  const api=new EventEmitter(), commands=[];
  Object.assign(api,{isAttached:()=>true,detach:()=>{throw new Error('shared debugger must remain attached');},
    sendCommand:async(method,params)=>{commands.push([method,params]);return {};}});
  const contents={debugger:api,backgroundThrottling:true};
  const monitor=await observeGeminiUploads(contents);
  assert.equal(contents.backgroundThrottling,false);
  assert.deepEqual(commands.at(-1),['Emulation.setFocusEmulationEnabled',{enabled:true}]);
  monitor.begin();
  assert.equal(commands.filter(([m])=>m==='Emulation.setFocusEmulationEnabled').length,1);
  await monitor.stop();
  assert.deepEqual(commands.at(-1),['Emulation.setFocusEmulationEnabled',{enabled:false}]);
  assert.equal(api.listenerCount('message'),0);
});
