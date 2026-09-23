// Real Chromium DOM fixtures, without network, cookies, or user accounts.
// FLOWCUT_PLAYWRIGHT_PATH may point to an existing playwright-core installation.
const { chromium } = require(process.env.FLOWCUT_PLAYWRIGHT_PATH || 'playwright-core');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require.resolve('../src/gemini-preload'), 'utf8');
const declarations = source.slice(source.indexOf('const SELECTORS'), source.indexOf('\nipcRenderer.on("gemini:run-job"'));
const fixture = `<style>rich-textarea,form{display:block} [contenteditable],.attachment-chip,.attachment-container{min-width:30px;min-height:20px} img{width:20px;height:20px}</style>
  <form><rich-textarea><div contenteditable="true">Prompt</div></rich-textarea><span role="progressbar">Unrelated control</span></form>
  <div id="attachments"></div><user-query><button aria-label="Remove attachment">Old image</button><div class="attachment-chip"><span role="progressbar">Old busy</span></div></user-query>
  <model-response><img src="blob:old-response"></model-response><nav><button aria-label="Remove file">Sidebar</button></nav>`;
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent(fixture);
    await page.evaluate(`${declarations}\nwindow.uploadTest = {attachmentCount,uploadConfirmed,uploadProcessingVisible,uploadFiles};`);
    const check = () => page.evaluate(() => ({ count: uploadTest.attachmentCount(), busy: uploadTest.uploadProcessingVisible(), two: uploadTest.uploadConfirmed([{name:'a.png'},{name:'b.png'}],2) }));
    assert.deepEqual(await check(), {count:0,busy:false,two:false}, '历史附件和无关进度条不能参与判断');
    await page.locator('#attachments').evaluate(el => {el.innerHTML = '<div class="attachment-chip"><img alt="uploaded image" src="blob:a"><button aria-label="Remove attachment">Remove</button></div><div class="attachment-chip"><img alt="uploaded image" src="blob:b"><button aria-label="Remove attachment">Remove</button></div>';});
    assert.deepEqual(await check(), {count:2,busy:false,two:true}, '识别编辑器外面的兄弟附件');
    await page.locator('#attachments').evaluate(el => {el.firstElementChild.insertAdjacentHTML('beforeend','<span role="progressbar">Processing</span>');});
    assert.equal((await check()).busy,true, '真实附件处理动画必须等待');
    await page.locator('#attachments [role="progressbar"]').evaluate(el => {el.style.display='none';});
    assert.equal((await check()).busy,false, '隐藏动画不能卡住生成');
    await page.locator('#attachments').evaluate(el => {el.innerHTML = '<div class="attachment-container"><div class="attachment-chip"><img alt="uploaded image" src="blob:a"></div></div>';});
    assert.deepEqual(await check(), {count:1,busy:false,two:false}, '一张图的嵌套容器不能算成三张图');
    await page.locator('#attachments').evaluate(el => {el.innerHTML = '<div class="attachment-container"><div class="attachment-chip"><img alt="uploaded image" src="blob:a"></div><div class="attachment-chip"><img alt="uploaded image" src="blob:b"></div></div>';});
    assert.deepEqual(await check(), {count:2,busy:false,two:true});
    // Exercise the real upload strategy with a native-chooser IPC stub.
    await page.evaluate(() => { document.querySelector('#attachments').replaceChildren(); window.ipcRenderer={send(){},async invoke(channel){ if(channel==='gemini:upload-files-via-chooser')return {ok:true,selectedFileCount:1}; }}; });
    const partial = await page.evaluate(async () => {try {await uploadTest.uploadFiles([{name:'a.png',mime:'image/png',data:[1]},{name:'b.png',mime:'image/png',data:[2]}],['a.png','b.png']);return 'unexpected-success';}catch(e){return e.code;}});
    assert.equal(partial,'UPLOAD_NOT_CONFIRMED','原生选择只收到一张，不能继续发送或重复追加');
    console.log('PASS: real Chromium attachment siblings, nested cards, history isolation, busy/hidden indicators and partial selection');
  } finally { await browser.close(); }
}
main().catch(error => {console.error(error);process.exitCode=1;});
