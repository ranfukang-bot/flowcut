const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../src/gemini-preload'),'utf8');
const compactPrompt=text=>String(text||'').replace(/\s+/g,' ').trim();
const code=source.slice(source.indexOf('async function typePrompt('),source.indexOf('\nfunction visibleGeminiError('));
function fixture(mode='correct') {
  let now=0,text='prompt text for this product',messages=[],clicks=0,keys=0;
  const log=[]; const editor={focus(){},click(){}};
  const button={disabled:false,getAttribute:()=>'',click(){clicks++;send();}};
  const location={href:'/gem/home'};
  function send(){
    if(mode==='keyboard'&&keys===0)return;
    if(mode==='cleared'){text='';return;}
    if(mode==='navigated'){location.href='/gem/other';return;}
    if(mode==='wrong'){messages.push({innerText:'different product prompt',textContent:'different product prompt'});text='';return;}
    messages.push({innerText:text,textContent:text});text='';
  }
  const context=vm.createContext({String,Number,Math,Set,JSON,compactPrompt,location,document:{title:'Gemini',createRange:()=>({selectNodeContents(){}}),execCommand:(_a,_b,value)=>{text=mode==='truncated'?value.slice(0,-1):value;return true;}},
    window:{getSelection:()=>({removeAllRanges(){},addRange(){}})},Date:{now:()=>now},
    SELECTORS:{promptInput:'editor',sendButton:'send'},first:selector=>selector==='send'?button:editor,waitFor:async selector=>selector==='send'?button:editor,
    editorText:()=>text,sleep:async ms=>{now+=ms;},pendingUploadCount:0,
    waitUntil:async(fn,timeout)=>{const end=now+timeout;while(now<end){if(await fn())return;now+=300;}throw Error('timeout');},
    userMessages:()=>messages,userMessageCount:()=>messages.length,attachmentCount:()=>text?2:0,responseSnapshot:()=>[],generationInProgress:()=>false,
    codedError:(message,code)=>Object.assign(Error(message),{code}),
    ipcRenderer:{send:(_channel,data)=>log.push(data),async invoke(channel,value){if(channel==='gemini:send-key'){keys++;send();}else{text=mode==='truncated'?value.slice(0,-1):value;}}},
  });vm.runInContext(code,context);
  return {context,log,read:()=>({text,messages,clicks,keys})};
}
test('normal composer write preserves exact original content; one click produces matching new user message',async()=>{
  const f=fixture();await f.context.typePrompt('印尼，iPhone实拍质感。\n只生成提示词。');await f.context.submitPrompt();
  assert.equal(f.read().messages[0].innerText,'印尼，iPhone实拍质感。\n只生成提示词。');assert.equal(f.read().clicks,1);assert.equal(f.read().keys,0);
  assert.equal(f.log.at(-1).phase,'submit_confirmed');
});
test('90-percent text is no longer accepted as complete input',async()=>{
  const f=fixture('truncated');await assert.rejects(f.context.typePrompt('a'.repeat(100)),{code:'PROMPT_INPUT_FAILED'});
  assert.equal(f.read().clicks,0);
});
for(const mode of ['cleared','navigated','wrong'])test(mode+' alone does not confirm sending or trigger a second send',async()=>{
  const f=fixture(mode);await assert.rejects(f.context.submitPrompt(),{code:'SUBMIT_NOT_CONFIRMED'});assert.equal(f.read().keys,0);assert.equal(f.read().clicks,1);
});
test('a no-op button can safely fall back to Enter when original composer is unchanged',async()=>{
  const f=fixture('keyboard');await f.context.submitPrompt();assert.equal(f.read().keys,1);assert.equal(f.read().messages.length,1);
});
