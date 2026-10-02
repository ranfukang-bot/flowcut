const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { pageFiles } = require('../src/gemini-page-files');
const source = fs.readFileSync(require.resolve('../src/gemini-preload'), 'utf8');
const rebuild = source.slice(source.indexOf('function rebuildFiles('), source.indexOf('\nfunction composerRoot('));
const upload = source.slice(source.indexOf('async function uploadFiles('), source.indexOf('\nasync function typePrompt('));
const codedError = (message, code) => Object.assign(new Error(message), {code});
const input = [
  {name:'one.webp',mime:'image/webp',data:new Uint8Array([82,73,70,70,255,0,128])},
  {name:'two.png',mime:'image/png',data:new Uint8Array([137,80,78,71,0,255])},
];
test('packaged JSON roundtrip retains exact bytes, names and types for multiple attachments', async()=>{
  const context=vm.createContext({File,Uint8Array,atob,codedError});vm.runInContext(rebuild,context);
  const result=context.rebuildFiles(JSON.parse(JSON.stringify(pageFiles(input))));
  for(let i=0;i<input.length;i++) {
    assert.equal(result[i].name,input[i].name);assert.equal(result[i].type,input[i].mime);
    assert.deepEqual(new Uint8Array(await result[i].arrayBuffer()),input[i].data);
  }
  assert.equal(context.rebuildFiles(input)[0].size,input[0].data.length,'unpacked runtime remains compatible');
});
test('empty attachments cannot reach native or fallback upload',()=>{
  assert.throws(()=>pageFiles([{name:'bad.png',data:[]}]),/附件为空/);
  const context=vm.createContext({File,Uint8Array,atob,codedError});vm.runInContext(rebuild,context);
  assert.throws(()=>context.rebuildFiles([{name:'bad.png',data:[]}]),{code:'UPLOAD_NOT_CONFIRMED'});
});
test('native chooser timeout falls back to paste with real bytes before settlement',async()=>{
  let pasted=[],settled=false,nativeCalls=0;
  const editor={focus(){},dispatchEvent(event){pasted=event.clipboardData.files;}};
  class Transfer {constructor(){this.files=[];this.items={add:file=>this.files.push(file)};}}
  const context=vm.createContext({File,Uint8Array,atob,codedError,Boolean,Number,String,JSON,
    location:{href:'https://gemini.google.com/gem/test'},document:{title:'Gemini'},
    SELECTORS:{promptInput:'editor',fileInput:'file',uploadButton:'upload'},
    DataTransfer:Transfer,ClipboardEvent:class{constructor(type,options){Object.assign(this,options);}},
    loginOrChallengeVisible:()=>false,firstConnected:()=>null,first:()=>editor,
    attachmentCount:()=>pasted.length,all:()=>[],visible:()=>true,
    uploadConfirmed:(_files,count)=>pasted.length===count,
    waitUntil:async predicate=>{assert.equal(predicate(),true);},
    waitForUploadSettlement:async files=>{assert.equal(files.length,2);settled=true;},
    ipcRenderer:{send(){},async invoke(channel){if(channel==='gemini:upload-files-via-chooser'){nativeCalls++;return {ok:false,code:'FILE_CHOOSER_FAILED'};}}},
  });vm.runInContext(rebuild+'\n'+upload,context);
  await context.uploadFiles(JSON.parse(JSON.stringify(pageFiles(input))),['one.webp','two.png']);
  assert.equal(nativeCalls,1);assert.equal(settled,true);assert.equal(pasted.length,2);
  for(let i=0;i<input.length;i++)assert.deepEqual(new Uint8Array(await pasted[i].arrayBuffer()),input[i].data);
});
test('production page job uses byte-preserving payload for product and reference files',()=>{
  const main=fs.readFileSync(require.resolve('../src/main'),'utf8');
  assert.match(main,/productPageFiles = pageFiles\(job.files\)/);
  assert.match(main,/referencePageFiles = pageFiles\(job.referenceFiles\)/);
  assert.match(main,/files: productPageFiles/);assert.match(main,/referenceFiles: referencePageFiles/);
});
