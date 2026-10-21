import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GEM_REQUEST, buildGemRequest, renderGemRequest, validateGemRequest } from '../lib/gem-request.ts';

test('default Gem request contains no unrequested conservative-processing instruction', () => {
  assert.doesNotMatch(DEFAULT_GEM_REQUEST, /信息不足|保守处理|无人值守/);
  assert.equal(renderGemRequest(DEFAULT_GEM_REQUEST, { duration: 15, region: '印尼', shooting_style: 'iPhone实拍感' }),
    '请根据本次上传的商品图片，按这个 Gem 的设定生成完整的视频提示词。只输出文字，不要生成图片或视频。\n时长：15秒\n地区：印尼\n口播语言：印尼语\n拍摄风格：iPhone实拍感\n不要提问，直接按以上信息输出提示词');
  assert.doesNotMatch(DEFAULT_GEM_REQUEST, /代码块/);
});
test('custom request is sent literally without extra text; only known placeholders resolve once', () => {
  const input = { duration: 30, region: '泰国', shooting_style: '{地区}' };
  assert.equal(renderGemRequest('只写提示词。\n地区={地区}，{时长}秒，{拍摄风格}；{自定义}', input), '只写提示词。\n地区=泰国，30秒，{地区}；{自定义}');
  assert.equal(renderGemRequest('  My instructions only.\n', input), '  My instructions only.\n');
});
test('empty or oversized requests are rejected instead of silently reverting to a default', () => {
  for (const value of ['', ' \n', null, 123, 'x'.repeat(12001)]) assert.throws(() => validateGemRequest(value));
  assert.equal(validateGemRequest('我的文字'), '我的文字');
});

test('code-box wording added by 1.4.51–1.4.52 is removed from saved texts and queued tasks before sending', () => {
  const input={duration:15,region:'菲律宾',shooting_style:'iPhone实拍质感'};
  const expected='请按图片写提示词。\n口播语言：Taglish\n不要提问，直接按以上信息输出提示词';
  const queued=[
    '请按图片写提示词。\n口播语言：Taglish\n不要提问，直接按以上信息输出提示词，每条提示词放在单独的代码块里',
    '请按图片写提示词。\n口播语言：Taglish\n不要提问，直接按以上信息输出提示词，每条提示词放在单独的代码块里\n本轮只需要 1 条完整的视频提示词（包含整段全部镜头），全部放在唯一一个代码块中。不要把预设、章节、分镜或口播拆成多个代码块。',
  ];
  for (const text of queued) assert.equal(buildGemRequest(text,input),expected);
  assert.equal(buildGemRequest(expected,input),expected);
  const own='我自己的要求：每条放一个代码块，每条提示词放在单独的代码块里。';
  assert.ok(buildGemRequest(own,input).startsWith(own),'the user\'s own wording is never edited');
});
