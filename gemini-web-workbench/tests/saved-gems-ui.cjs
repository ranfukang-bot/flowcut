const assert = require('node:assert/strict');
const path = require('node:path');
module.exports = async function savedGemsUI(page, evidence) {
  await page.evaluate(() => {
    window.gemCalls = [];
    window.gemRows = [{ id: 'one', name: 'Gemini 账号一', authenticated: true, binding: null }, { id: 'two', name: 'Gemini 账号二', authenticated: true, binding: null }];
    window.flowcutDesktop.listGemBindings = async () => structuredClone(window.gemRows);
    window.flowcutDesktop.configureGem = async options => {
      window.gemCalls.push(options);
      if (options.action === 'open') return;
      if (options.action === 'bind' && !/^https:\/\/gemini\.google\.com\/gem\/[\w-]+$/.test(options.url)) throw Error('只接受已保存的 Gem 对话链接');
      const row = window.gemRows.find(row => row.id === options.accountId);
      row.binding = { status: 'ready', url: options.action === 'bind' ? options.url : 'https://gemini.google.com/gem/created' };
    };
  });
  await page.getByRole('navigation').getByRole('button', { name: 'Gem 模板' }).click();
  await page.locator('.gem-card').first().getByRole('button', { name: '网页 Gem', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '网页 Gem', exact: true });
  await modal.getByText('此版本尚未创建', { exact: true }).waitFor();
  await modal.getByRole('button', { name: /自动创建/ }).click();
  await modal.getByText('此版本已绑定', { exact: true }).waitFor();
  assert.equal(await modal.getByRole('textbox').inputValue(), 'https://gemini.google.com/gem/created');
  await modal.getByRole('combobox').selectOption('two');
  await modal.getByText('此版本尚未创建', { exact: true }).waitFor();
  assert.equal(await modal.getByRole('textbox').inputValue(), '');
  await modal.getByRole('textbox').fill('https://gemini.google.com/app');
  await modal.getByRole('button', { name: '保存此账号的链接' }).click();
  await modal.getByText('只接受已保存的 Gem 对话链接').waitFor();
  await modal.getByRole('textbox').fill('https://gemini.google.com/gem/manual');
  await modal.getByRole('button', { name: '保存此账号的链接' }).click();
  await modal.getByText('此版本已绑定', { exact: true }).waitFor();
  await modal.getByRole('combobox').selectOption('one');
  assert.equal(await modal.getByRole('textbox').inputValue(), 'https://gemini.google.com/gem/created');
  await page.screenshot({ path: path.join(evidence, '网页Gem-自动创建和备用链接.png'), fullPage: true });
  await modal.getByRole('button', { name: '关闭', exact: true }).click();
  const calls = await page.evaluate(() => window.gemCalls);
  assert.deepEqual(calls.map(c => [c.accountId, c.action]), [['one', 'create'], ['two', 'bind'], ['two', 'bind']]);
  assert.ok(calls[0].gem.id && calls[0].gem.content);
};
