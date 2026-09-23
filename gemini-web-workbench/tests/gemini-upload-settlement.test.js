const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/gemini-preload'), 'utf8');
const code = source.slice(source.indexOf('async function waitForUploadSettlement('), source.indexOf('\nasync function uploadFiles('));
const files = [{ name: 'first.webp', type: 'image/webp', size: 100 }, { name: 'second.webp', type: 'image/webp', size: 200 }];
async function scenario({ count = () => 2, busy = () => false, error = () => '', login = () => false, video = false } = {}) {
  let now = 0;
  const context = vm.createContext({
    Date: { now: () => now }, Math, Number, String,
    sleep: async ms => { now += ms; },
    uploadProcessingVisible: () => busy(now), uploadConfirmed: (_files, expected) => count(now) >= expected,
    attachmentCount: () => count(now), visibleGeminiError: () => error(now), loginOrChallengeVisible: () => login(now),
    codedError: (message, code) => Object.assign(new Error(message), { code }),
    ipcRenderer: { send() {} },
    waitUntil: async (predicate, timeout, label) => { while(now < timeout) { if(await predicate()) return; now += 300; } throw new Error('等待超时：'+label); },
  });
  vm.runInContext(code, context);
  await context.waitForUploadSettlement(video ? [{ name: 'clip.mp4', type: 'video/mp4' }] : files, video ? 1 : 2);
  return now;
}
test('必须看到全部图片，不能把选择器返回成功当作 Gemini 已收到图片', async () => {
  await assert.rejects(scenario({ count: () => 0 }), { code: 'UPLOAD_PROCESSING_TIMEOUT' });
  await assert.rejects(scenario({ count: () => 1 }), { code: 'UPLOAD_PROCESSING_TIMEOUT' });
});
test('延迟出现的附件处理完再发送，不在空白期误判成功', async () => {
  const elapsed = await scenario({ count: t => t < 8000 ? 0 : 2, busy: t => t >= 8000 && t < 12000 });
  assert.ok(elapsed >= 14000 && elapsed < 18000, String(elapsed));
});
test('处理动画消失但附件丢失不能放行；永久忙碌返回可重试错误码', async () => {
  await assert.rejects(scenario({ count: () => 0, busy: t => t < 5000 }), { code: 'UPLOAD_PROCESSING_TIMEOUT' });
  await assert.rejects(scenario({ busy: () => true }), { code: 'UPLOAD_PROCESSING_TIMEOUT' });
});
test('正常图片按参考版保留短暂处理窗口，视频有独立等待窗口', async () => {
  const imageTime = await scenario();
  assert.ok(imageTime >= 3450 && imageTime <= 5000, String(imageTime));
  assert.ok(await scenario({ video: true }) >= 5000);
});

test('真实登录失效或网页报错仍然立即中止，不吞掉错误', async () => {
  await assert.rejects(scenario({login: () => true}), {code:'NEEDS_LOGIN'});
  await assert.rejects(scenario({error: () => 'Upload failed'}), {code:'GEMINI_PAGE_ERROR'});
});
