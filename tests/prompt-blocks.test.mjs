import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VARIANT_REQUEST, RAW_REPLY_NOTE, renderVariantRequest, splitPromptBlocks, validateVariantRequest } from '../lib/prompt-blocks.ts';
import { renderGemRequest } from '../lib/gem-request.ts';

const prompt = n => `视频${n}：` + '产品特写、人物口播和使用场景自然衔接，画面真实。'.repeat(16);
const reply = '创意说明\n| 镜头 | 内容 |\n| 1 | 表格 |\n' + prompt(1);

test('every code block is one prompt, in order, with Windows line endings normalised', () => {
  const blocks = [prompt(1), `\r\n${prompt(2).replace('。', '。\r\n')}\r\n`, prompt(3)];
  const result = splitPromptBlocks({ text: reply, blocks });
  assert.equal(result.note, '');
  assert.deepEqual(result.prompts, [prompt(1), prompt(2).replace('。', '。\n'), prompt(3)]);
  assert.equal(splitPromptBlocks({ text: reply, blocks: Array.from({ length: 10 }, (_, i) => prompt(i + 1)) }).prompts.length, 10);
});

test('a reply with no code blocks keeps working as one prompt and says so', () => {
  assert.deepEqual(splitPromptBlocks({ text: reply, blocks: [] }), { prompts: [reply], note: RAW_REPLY_NOTE });
  assert.deepEqual(splitPromptBlocks({ text: reply, blocks: ['  ', ''] }), { prompts: [reply], note: RAW_REPLY_NOTE });
});

test('code-block markup without readable blocks is refused instead of sending the whole reply', () => {
  for (const text of ['```\n' + prompt(1) + '\n```', 'Plaintext\n' + prompt(1), prompt(1) + '\n复制代码\n']) {
    assert.throws(() => splitPromptBlocks({ text, blocks: [] }), { code: 'PROMPT_BLOCKS_INVALID' });
  }
  assert.throws(() => splitPromptBlocks({ text: reply, blocks: [], hint: true }), /没有读到/);
});

test('the whole round is refused for a short, repeated or excessive block', () => {
  assert.throws(() => splitPromptBlocks({ text: reply, blocks: [prompt(1), '太短'] }), /第 2 个代码块只有 2 字/);
  assert.throws(() => splitPromptBlocks({ text: reply, blocks: [prompt(1), prompt(2), `  ${prompt(1)}\n`] }), /第 1 个和第 3 个代码块内容相同/);
  assert.throws(() => splitPromptBlocks({ text: reply, blocks: Array.from({ length: 11 }, (_, i) => prompt(i + 1)) }), /11 个代码块，超过上限 10/);
  assert.throws(() => splitPromptBlocks({ text: '太短', blocks: [] }), /只有 2 字/);
});

test('the mother round accepts exactly one prompt; the legacy 30-second mode reads the whole reply', () => {
  assert.deepEqual(splitPromptBlocks({ text: reply, blocks: [prompt(1)], mode: 'single' }).prompts, [prompt(1)]);
  assert.throws(() => splitPromptBlocks({ text: reply, blocks: [prompt(1), prompt(2)], mode: 'single' }), /母版只能是 1 条/);
  assert.deepEqual(splitPromptBlocks({ text: reply, blocks: [prompt(1), prompt(2)], mode: 'raw' }), { prompts: [reply], note: '' });
});

test('the second-round text needs the mother prompt placeholder and fills country and mother literally', () => {
  assert.equal(validateVariantRequest(DEFAULT_VARIANT_REQUEST), DEFAULT_VARIANT_REQUEST);
  for (const bad of ['', '  ', null, 7, '没有占位符', '{母版提示词}' + 'x'.repeat(12000)]) assert.throws(() => validateVariantRequest(bad));
  const template = renderGemRequest(DEFAULT_VARIANT_REQUEST, { duration: 15, region: '马来西亚', shooting_style: 'iPhone实拍感' });
  const mother = '母版 $1 $& 内容';
  assert.equal(renderVariantRequest(template, `\n${mother}\n`),
    `目标国家：马来西亚\n以下是母版提示词，请根据母版和产品图片输出视频提示词，每条提示词放在一个独立代码块中：\n${mother}`);
});
