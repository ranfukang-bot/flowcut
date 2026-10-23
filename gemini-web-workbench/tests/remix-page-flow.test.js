const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('../../vendor/publisher/node_modules/playwright-core');
const {validateRemixJob}=require('../src/remix-job-validation');
const {planRemixSegments,segmentHeader}=require('../../lib/remix-segments.ts');
const source=fs.readFileSync(require.resolve('../src/gemini-preload.js'),'utf8');
const workflow=source.slice(source.indexOf('async function runSegmentedRemixJob('),source.indexOf('async function runReferenceRemixJob('));
const block=(i,a,b)=>`${segmentHeader(i,a,b)}\n${'运镜、动作和音效完整分镜。'.repeat(40)}`;
const good=[block(1,0,15),block(2,15,24)];
let browser;
before(async()=>{const executablePath=process.env.CHROMIUM_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);browser=await chromium.launch({executablePath});});
after(async()=>browser?.close());
async function run(t,{replies=[good,good],saved=false,rewrite=false,persistFails=false}={}) {
  const page=await browser.newPage();t.after(()=>page.close());
  await page.route('https://gemini.google.com/**',route=>route.fulfill({body:'<html><body><div contenteditable="true"></div></body></html>'}));
  await page.goto('https://gemini.google.com/gem/test');
  const metadata={seconds:24,plan:planRemixSegments(24).segments,round:1,analysisBlocks:saved?good:[],region:'印尼',spokenLanguage:'auto',rewriteIndex:rewrite?2:null};
  const pending={kind:rewrite?'remix-rewrite':'remix-segments',remix:structuredClone(metadata)};
  const persisted=[];
  await page.exposeFunction('validate',(payload)=>validateRemixJob(pending,payload,async data=>{if(persistFails)throw Error('disk failed');persisted.push(data);}));
  const result=await page.evaluate(async ({workflow,replies,metadata})=>{
    const events=[],responses=[];let current=[],next=0,prompt='';
    const location=window.location,document=window.document;
    const SELECTORS={promptInput:'[contenteditable]'};
    const codedError=(message,code)=>Object.assign(Error(message),{code});
    const loginOrChallengeVisible=()=>false;
    const waitUntil=async check=>{if(!check())throw Error('not ready');};
    const waitFor=async()=>{};
    const ensureFreshConversation=async url=>{events.push(['new',url]);history.replaceState(null,'','/gem/test');};
    const ensureJobModel=async()=>events.push(['model']);
    const clearExistingAttachments=async()=>{};
    const uploadFiles=async files=>events.push(['upload',files]);
    const typePrompt=async value=>{prompt=value;events.push(['prompt',value]);};
    const responseSnapshot=()=>[...responses];
    const submitPrompt=async()=>{events.push(['send',prompt]);history.replaceState(null,'','/app/same-conversation');};
    const waitForResponse=async()=>{current=replies[next++] || [];const text=current.join('\n\n');responses.push(text);return text;};
    const responseCodeBlocks=()=>({blocks:current,markup:current.length>0});
    const ipcRenderer={invoke:async (_channel,payload)=>window.validate(payload)};
    let geminiProgress='';
    // Evaluate the actual page workflow with the fake page drivers in scope.
    const actual=eval('('+workflow+')');
    try {const result=await actual({requestId:'req',gemUrl:'https://gemini.google.com/gem/test',remix:metadata,analysisPrompt:'分析视频',adaptationPrompt:'已保存原脚本换品',referenceFiles:['video'],files:['image']});return {ok:true,result,events};}
    catch(error){return {ok:false,code:error.code,error:error.message,raw:error.rawReplies,events};}
  },{workflow,replies,metadata});
  return {...result,persisted,pending};
}
test('saved Gem two rounds stay in one conversation; analysis persisted before image round',async t=>{
  const result=await run(t);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.persisted.length,1);assert.deepEqual(result.events.filter(e=>e[0]==='upload').map(e=>e[1]),[['video'],['image']]);assert.equal(result.events.filter(e=>e[0]==='new').length,1);assert.equal(result.result.codeBlocks.length,2);
});
test('invalid first round corrects once in same chat, then never uploads images',async t=>{
  const result=await run(t,{replies:[[good[0]],[good[0]],good]});assert.equal(result.ok,false);assert.equal(result.code,'REMIX_SEGMENTS_INVALID',JSON.stringify(result));assert.equal(result.events.filter(e=>e[0]==='send').length,2);assert.equal(result.events.filter(e=>e[0]==='new').length,1);assert.deepEqual(result.events.filter(e=>e[0]==='upload').map(e=>e[1]),[['video']]);assert.equal(result.persisted.length,0);assert.equal(result.raw.length,2);
});
test('a corrected first round proceeds without reupload; invalid adaptation also gets one correction',async t=>{
  const result=await run(t,{replies:[[good[0]],good,[good[0]],good]});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.events.filter(e=>e[0]==='send').length,4);assert.equal(result.events.filter(e=>e[0]==='upload').length,2);assert.equal(result.persisted.length,1);
});
test('resumed adaptation and segment rewrite never upload reference video',async t=>{
  const resumed=await run(t,{saved:true});assert.equal(resumed.ok,true,JSON.stringify(resumed));assert.deepEqual(resumed.events.filter(e=>e[0]==='upload').map(e=>e[1]),[['image']]);assert.equal(resumed.persisted.length,0);
  const rewritten=await run(t,{saved:true,rewrite:true,replies:[[good[1]]]});assert.equal(rewritten.ok,true);assert.equal(rewritten.result.codeBlocks.length,1);
});
test('server persistence failure blocks the second round even after local validation',async t=>{
  const result=await run(t,{persistFails:true});assert.equal(result.ok,false);assert.equal(result.events.filter(e=>e[0]==='send').length,1);assert.equal(result.events.filter(e=>e[0]==='upload').length,1);
});
