const assert = require('node:assert/strict');
const path = require('node:path');

// Real isolated HTTP storage + rendered UI. Never uses the user's accounts.
module.exports = async function testAccountManager(page, api, evidence) {
  const manager = page.getByRole('dialog', { name: 'TK 账号管理', exact: true });
  const picker = page.getByRole('combobox', { name: 'TK 归档账号', exact: true });
  const confirmation = page.getByRole('dialog', { name: '确认操作' });
  const before = await api('/api/workspace');
  const selected = await picker.inputValue();
  const selectedId = before.tiktokAccounts.find(a => a.name === selected).id;
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await manager.waitFor();
  await manager.getByRole('article', { name: selected, exact: true }).getByRole('button', { name: '修改', exact: true }).click();
  let editor = page.getByRole('dialog', { name: '修改 TK 归档账号', exact: true });
  await editor.getByLabel('归档名称（例如对应的 TK 账号）').fill('clear-test');
  await editor.getByRole('button', { name: '保存修改', exact: true }).click();
  await editor.getByRole('alert').getByText('这个 TK 账号名已经存在').waitFor();
  assert.equal((await api('/api/tiktok-accounts')).accounts.find(a => a.id === selectedId).name, selected);
  await editor.getByLabel('归档名称（例如对应的 TK 账号）').fill('归档账号已改名');
  await editor.getByRole('button', { name: '保存修改', exact: true }).click();
  await manager.getByRole('article', { name: '归档账号已改名', exact: true }).waitFor();
  assert.equal(await picker.inputValue(), '归档账号已改名');
  assert.equal((await api('/api/workspace')).tasks[0].tiktok_account_name, selected, 'existing tasks retain original names');

  await manager.getByRole('article', { name: '归档账号已改名', exact: true }).getByRole('button', { name: '删除', exact: true }).click();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  assert.ok((await api('/api/tiktok-accounts')).accounts.some(a => a.id === selectedId));

  // A failed delete must keep the row and surface the server error.
  await page.route('**/api/tiktok-accounts', route => route.fulfill({ status: 500, json: { error: '模拟删除失败' } }), { times: 1 });
  await manager.getByRole('article', { name: '归档账号已改名', exact: true }).getByRole('button', { name: '删除', exact: true }).click();
  await confirmation.getByRole('button', { name: '确认', exact: true }).click();
  await manager.getByRole('alert').getByText('模拟删除失败').waitFor();
  assert.ok((await api('/api/tiktok-accounts')).accounts.some(a => a.id === selectedId));

  await manager.getByRole('article', { name: '归档账号已改名', exact: true }).getByRole('button', { name: '删除', exact: true }).click();
  await confirmation.getByRole('button', { name: '确认', exact: true }).click();
  await manager.getByRole('article', { name: '归档账号已改名', exact: true }).waitFor({ state: 'detached' });
  assert.notEqual(await picker.inputValue(), '归档账号已改名');
  const after = await api('/api/workspace');
  assert.deepEqual(after.tasks, before.tasks, 'rename/delete must not alter existing task snapshots');
  assert.deepEqual(after.products, before.products, 'product images are untouched');

  // Delete remaining directory entries; the last deletion leaves a usable empty list.
  for (const account of after.tiktokAccounts) {
    await manager.getByRole('article', { name: account.name, exact: true }).getByRole('button', { name: '删除', exact: true }).click();
    await confirmation.getByRole('button', { name: '确认', exact: true }).click();
    await manager.getByRole('article', { name: account.name, exact: true }).waitFor({ state: 'detached' });
  }
  await manager.getByText('还没有 TK 归档账号，点击上方“添加账号”创建。').waitFor();
  assert.equal(await picker.inputValue(), '');
  assert.equal((await api('/api/tiktok-accounts')).accounts.length, 0);
  await manager.getByRole('button', { name: '＋ 添加账号', exact: true }).click();
  editor = page.getByRole('dialog', { name: '添加 TK 归档账号', exact: true });
  await editor.getByLabel('归档名称（例如对应的 TK 账号）').fill('管理列表新增账号');
  await editor.getByRole('button', { name: '选择保存文件夹', exact: true }).click();
  await editor.getByRole('button', { name: '添加并选择', exact: true }).click();
  await manager.getByRole('article', { name: '管理列表新增账号', exact: true }).waitFor();
  assert.equal(await picker.inputValue(), '管理列表新增账号');
  await page.screenshot({ path: path.join(evidence, 'TK账号管理.png'), fullPage: true });
  await manager.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await picker.inputValue(), '管理列表新增账号', 'changes survive reload');
};
