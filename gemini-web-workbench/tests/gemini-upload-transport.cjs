// Real Chromium + CDP, production chooser/network observer/page runtime.
// All Google URLs are intercepted locally: no accounts, uploads or quota used.
const { chromium } = require('../../vendor/publisher/node_modules/playwright-core');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { observeGeminiUploads } = require('../src/gemini-upload-network');
const { uploadFilesViaChooser } = require('../src/gemini-file-chooser');
const source = fs.readFileSync(require.resolve('../src/gemini-preload'), 'utf8');
const declarations = source.slice(source.indexOf('const SELECTORS'), source.indexOf('\nipcRenderer.on("gemini:run-job"'));
const fixture = `<style>rich-textarea,user-query{display:block} [contenteditable]{min-height:40px}button{padding:15px}</style>
  <form><rich-textarea><div contenteditable="true"></div></rich-textarea><div id="attachments"></div>
  <button type="button" data-test-id="local-images-files-uploader-button" onclick="document.querySelector('input').click()">Upload files</button>
  <input type=file multiple hidden><button type="button" aria-label="Send">Send</button></form>
  <script>
  window.events=[];window.sent=[];window.pending=0;
  const editor=document.querySelector('[contenteditable]');
  async function receive(files) {
    for(const file of files) {
      pending++;
      const chip=document.createElement('button');chip.type='button';chip.setAttribute('aria-label','Remove attachment');chip.textContent=file.name;
      if(window.previewDelay)setTimeout(()=>document.querySelector('#attachments').appendChild(chip),window.previewDelay);
      else document.querySelector('#attachments').appendChild(chip);
      await fetch('https://content-push.googleapis.com/upload/'+encodeURIComponent(file.name),{method:'POST',body:file});
      pending--;
    }
  }
  document.querySelector('input').addEventListener('input',event=>events.push({type:'input',trusted:event.isTrusted}));
  document.querySelector('input').addEventListener('change',event=>{events.push({type:'change',trusted:event.isTrusted});receive(Array.from(event.target.files));event.target.value='';});
  editor.addEventListener('paste',event=>{if(window.usePaste)receive(Array.from(event.clipboardData.files));});
  document.querySelector('[aria-label=Send]').onclick=()=>{
    sent.push({text:editor.innerText,pending,count:document.querySelector('#attachments').children.length});
    const message=document.createElement('user-query');message.innerText=editor.innerText;document.body.appendChild(message);
    editor.innerText='';document.querySelector('#attachments').replaceChildren();
  };
  </script>`;

async function main(){
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'flowcut-upload-test-'));
  try {
    const page=await browser.newPage();
    let delay=200, status=200, actualBodies=[];
    await page.route('**/*',async route=>{
      if(route.request().url().includes('content-push.googleapis.com/upload/')){
        actualBodies.push([...route.request().postDataBuffer()]);
        await new Promise(resolve=>setTimeout(resolve,delay));
        await route.fulfill({status,body:status===200?'ok':'failure'});
      } else await route.fulfill({contentType:'text/html',body:fixture});
    });
    await page.goto('https://gemini.google.com/app');
    const cdp=await page.context().newCDPSession(page);
    const api=new EventEmitter();
    Object.assign(api,{isAttached:()=>true,attach(){},detach(){},sendCommand:(method,params)=>cdp.send(method,params)});
    for(const name of ['Network.requestWillBeSent','Network.responseReceived','Network.loadingFinished','Network.loadingFailed','Page.fileChooserOpened'])cdp.on(name,params=>api.emit('message',{},name,params));
    let inputTurn=Promise.resolve();
    const contents={debugger:api,executeJavaScript:script=>page.evaluate(script),sendInputEvent(event){
      const types={mouseMove:'mouseMoved',mouseDown:'mousePressed',mouseUp:'mouseReleased'};
      inputTurn=inputTurn.then(()=>cdp.send('Input.dispatchMouseEvent',{type:types[event.type],x:event.x,y:event.y,button:event.button||'none',clickCount:event.clickCount||0}));
    }};
    const monitor=await observeGeminiUploads(contents);
    let chooserCalls=0;
    await page.exposeFunction('nativeInvoke',async(channel,...args)=>{
      if(channel==='gemini:upload-status')return args[0]==='begin'?monitor.begin():monitor.status();
      if(channel==='gemini:upload-files-via-chooser'){chooserCalls++;return uploadFilesViaChooser(contents,args[0]);}
      if(channel==='gemini:send-key')return true;
      throw Error(channel);
    });
    const inject=()=>page.evaluate(`window.ipcRenderer={send(){},invoke:window.nativeInvoke};${declarations}\nwindow.testRuntime={uploadFiles,typePrompt,submitPrompt,attachmentCount};`);
    const bytes=[137,80,78,71,13,10,26,10,255,0,128];
    const files=['one.png','two.png','three.png'].map(name=>{const target=path.join(temp,name);fs.writeFileSync(target,Buffer.from(bytes));return target;});
    await inject();
    monitor.begin();
    const chooser=await uploadFilesViaChooser(contents,files);
    assert.equal(chooser.ok,true);assert.equal(chooser.selectedFileCount,3);
    await page.waitForFunction(()=>document.querySelector('#attachments').children.length===3 && !pending);
    assert.deepEqual(await page.evaluate(()=>events),[{type:'input',trusted:true},{type:'change',trusted:true}]);
    assert.equal(await page.evaluate(()=>testRuntime.attachmentCount()),3);
    console.log('PASS: native chooser uploads exactly 3 files, one trusted change event');
    await page.reload(); await inject(); actualBodies=[];delay=2500;
    await page.evaluate(()=>{window.usePaste=true;});
    const payload=['one.png','two.png'].map(name=>({name,mime:'image/png',data:bytes}));
    await page.evaluate(async files=>{await testRuntime.uploadFiles(files,[]);await testRuntime.typePrompt('商品图片验证\n完整提示词');await testRuntime.submitPrompt();},payload);
    assert.deepEqual(actualBodies,[bytes,bytes]);
    assert.deepEqual(await page.evaluate(()=>sent),[{text:'商品图片验证\n完整提示词',pending:0,count:2}]);
    console.log('PASS: complete file bytes + delayed sequential uploads + complete text + exactly one send');
    await page.reload(); await inject();actualBodies=[];delay=200;chooserCalls=0;
    await page.evaluate(()=>{window.usePaste=true;window.previewDelay=17000;});
    await page.evaluate(async files=>{await testRuntime.uploadFiles(files,[]);await testRuntime.typePrompt('延迟缩略图');await testRuntime.submitPrompt();},payload);
    assert.equal(chooserCalls,0);assert.deepEqual(actualBodies,[bytes,bytes]);assert.equal(await page.evaluate(()=>sent.length),1);
    console.log('PASS: previews delayed beyond fallback timeout do not upload duplicate files');
    await page.reload(); await inject();status=503;delay=20;
    await page.evaluate(()=>{window.usePaste=true;});
    const code=await page.evaluate(async files=>{try{await testRuntime.uploadFiles(files,[]);await testRuntime.typePrompt('不应发送');await testRuntime.submitPrompt();return 'sent';}catch(e){return e.code;}},payload);
    assert.equal(code,'UPLOAD_NOT_CONFIRMED');assert.equal(await page.evaluate(()=>sent.length),0);
    console.log('PASS: HTTP 503 with optimistic previews never sends a prompt');
    monitor.stop();
  } finally {await browser.close();fs.rmSync(temp,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
