const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {existsSync}=fs;
const {chromium}=require('../../vendor/publisher/node_modules/playwright-core');

// The extraction code that runs inside the Gemini page, tested on a page laid
// out like Gemini's reply: text and a table around rendered code blocks, each
// with a language label and copy button above the code.
const source=fs.readFileSync(require.resolve('../src/gemini-preload.js'),'utf8');
const extract=source.slice(source.indexOf('function codeBlocksIn('),source.indexOf('function responseCodeBlocks('));
let browser;
test.before(async()=>{
  const executablePath=process.env.CHROMIUM_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser=await chromium.launch(executablePath?{executablePath}:{});
});
test.after(async()=>browser?.close());

const codeBlock=text=>`<code-block><div class="code-block"><div class="code-block-decoration header-formatted"><span>Plaintext</span><div class="buttons"><button aria-label="复制代码">复制代码</button></div></div>
  <div class="formatted-code-block-internal-container"><div class="animated-opacity"><pre><code role="text" data-test-id="code-content" class="code-container formatted">${text}</code></pre></div></div></div></code-block>`;
async function read(t,html) {
  const page=await browser.newPage();
  t.after(()=>page.close());
  await page.setContent(`<div id="model-response-message-content-r1">${html}</div>`);
  return page.evaluate(`(() => { ${extract}
 return codeBlocksIn(document.querySelector('#model-response-message-content-r1')); })()`);
}

test('only the text inside each code block is read, line breaks kept; labels, buttons, prose and tables are left out',async t=>{
  const first='视频1：9:16 竖屏\n镜头一：产品特写\n镜头二：人物口播';
  const second='视频2：9:16 竖屏\n镜头一：开箱\n镜头二：&lt;使用场景&gt;';
  const result=await read(t,`<p>以下是创意分析。</p><table><tr><td>镜头</td><td>表格内容不是提示词</td></tr></table>
    <h3>方案 1</h3>${codeBlock(first)}<p>方案说明</p><h3>方案 2</h3>${codeBlock(second)}<p>以上。</p>`);
  assert.deepEqual(result,{blocks:[first,'视频2：9:16 竖屏\n镜头一：开箱\n镜头二：<使用场景>'],markup:true});
});

test('a reply without code blocks reports none, so the old whole-reply flow still applies',async t=>{
  assert.deepEqual(await read(t,'<p>整段提示词，没有代码块。</p><table><tr><td>A</td></tr></table>'),{blocks:[],markup:false});
});

test('a code block that renders but cannot be read is reported, so the reply is not used as one prompt',async t=>{
  assert.deepEqual(await read(t,'<p>说明</p><code-block><div class="code-block"><span>Plaintext</span></div></code-block>'),{blocks:[],markup:true});
  assert.deepEqual(await read(t,'<p>说明</p>'+codeBlock('   ')),{blocks:[],markup:true});
});

async function plain(t,html) {
  const page=await browser.newPage();
  t.after(()=>page.close());
  await page.setContent(`<div id="model-response-message-content-r1">${html}</div>`);
  return page.evaluate(`(() => { ${extract}
 return replyPlainText(document.querySelector('#model-response-message-content-r1')); })()`);
}

test('a one-prompt round reads the whole reply in order: prose and every code box kept, only the box label and copy button dropped',async t=>{
  const preset='预设：9:16 竖屏，15 秒\n人物：年轻女性';
  const timeline='0-3 秒：产品特写\n3-15 秒：口播 Plaintext 字样也保留';
  const text=await plain(t,`<p>好的，以下是母版：</p><h3>预设</h3>${codeBlock(preset)}<p>时间轴如下</p>${codeBlock(timeline)}<p>以上。</p>`);
  assert.equal(text.split('\n').filter(line=>line.trim()==='Plaintext').length,0);
  assert.doesNotMatch(text,/复制代码/);
  const order=['好的，以下是母版：','预设','预设：9:16 竖屏，15 秒','人物：年轻女性','时间轴如下','0-3 秒：产品特写','3-15 秒：口播 Plaintext 字样也保留','以上。'];
  let at=-1;
  for(const part of order){const next=text.indexOf(part,at+1);assert.ok(next>at,`「${part}」 missing or out of order in:\n${text}`);at=next;}
});

test('a reply without code boxes is read unchanged',async t=>{
  assert.equal(await plain(t,'<p>第一段</p><p>第二段</p>'),'第一段\n\n第二段');
});
