import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GEM_REQUEST, renderGemRequest, validateGemRequest } from '../lib/gem-request.ts';

test('default Gem request contains no unrequested conservative-processing instruction', () => {
  assert.doesNotMatch(DEFAULT_GEM_REQUEST, /信息不足|保守处理|无人值守/);
  assert.equal(renderGemRequest(DEFAULT_GEM_REQUEST, { duration: 15, region: '印尼', shooting_style: 'iPhone实拍感' }),
    '请根据本次上传的商品图片，按这个 Gem 的设定生成完整的视频提示词。只输出文字，不要生成图片或视频。\n时长：15秒\n地区：印尼\n拍摄风格：iPhone实拍感');
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
