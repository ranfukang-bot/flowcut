const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { SavedGems, createGemDriver, gemVersion } = require('../src/saved-gems');
const report = require('./helpers/electron-test-report.cjs');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const window = new BrowserWindow({show:false, webPreferences:{partition:`recovery-test-${process.pid}`}});
  let remote = null, saves = 0, managerReads = 0, editorReads = 0;
  const escape = value => value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  const form = (name='',content='') => `<input id="gem-name-input" value="${escape(name)}"><div data-test-id="instruction-rich-input-field"><div class="ql-editor" contenteditable="true" style="white-space:pre-wrap">${escape(content)}</div></div><button data-test-id="create-button">Save</button>`;
  // All navigation stays in an isolated in-memory session. The fake server
  // persists Save but deliberately never displays the confirmation dialog.
  window.webContents.session.protocol.handle('https', async request => {
    const url = new URL(request.url);
    if(url.origin!=='https://gemini.google.com') return new Response('',{status:403});
    let html;
    if(url.pathname==='/gems/create') {
      html=form()+`<script>document.querySelector('button').onclick=()=>fetch('/save',{method:'POST',body:JSON.stringify({name:document.querySelector('input').value,content:document.querySelector('.ql-editor').innerText})});</script>`;
    } else if(url.pathname==='/save' && request.method==='POST') {
      remote=JSON.parse(await request.text()); saves++;
      return new Response('{}',{headers:{'content-type':'application/json'}});
    } else if(url.pathname==='/gems/view') {
      managerReads++;
      html=remote ? `<div class="bot-list-row-container"><a class="bot-row" href="/gem/persisted"><span class="title">${escape(remote.name)}</span></a><span data-test-id="edit-button-tooltip"><button>Edit</button></span></div>` : 'Empty';
    } else if(url.pathname==='/gems/edit/persisted' && remote) {
      editorReads++; html=form(remote.name,remote.content);
    } else return new Response('',{status:404});
    return new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}});
  });
  try {
    const gem={id:'first-use',name:'自动化完整流程',content:('完整指令\n第二行：保留产品细节。\n\n').repeat(180).trim()};
    let disk;
    const store={state:{accounts:[{id:'test-account'}]},save(){disk=structuredClone(this.state);return true;}};
    const manager=new SavedGems(store);
    const driver=createGemDriver(window,{timeoutMs:2000,verifyMs:400});
    assert.equal(await manager.ensure('test-account',gem,driver),'https://gemini.google.com/gem/persisted');
    assert.equal(saves,1); assert.equal(managerReads,1); assert.equal(editorReads,1);
    assert.equal(manager.get('test-account',gem).source,'recovered');
    assert.equal(remote.content.replace(/\n+/g,'\n').trim(),gem.content.replace(/\n+/g,'\n').trim());
    report({scenario:'first creation, lost confirmation, automatic full-content recovery',pass:true,saves});

    store.state=structuredClone(disk);
    assert.equal(await new SavedGems(store).ensure('test-account',gem,{}),'https://gemini.google.com/gem/persisted');
    assert.equal(saves,1); assert.equal(managerReads,1);
    report({scenario:'restart reuses persisted binding without another Save',pass:true,saves});

    store.state.accounts[0].gemBindings[gemVersion(gem)]={status:'saving',name:remote.name};
    store.save(); store.state=structuredClone(disk);
    assert.equal(await new SavedGems(store).ensure('test-account',gem,driver),'https://gemini.google.com/gem/persisted');
    assert.equal(saves,1); assert.equal(managerReads,2); assert.equal(editorReads,2);
    report({scenario:'restart with uncertain intent automatically reconciles before task continues',pass:true,saves});
    window.destroy(); app.exit(0);
  } catch(error) {report({pass:false,error:error.stack});window.destroy();app.exit(1);}
});
