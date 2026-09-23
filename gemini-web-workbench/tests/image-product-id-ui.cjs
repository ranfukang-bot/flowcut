// Runs on the isolated runtime-smoke profile, never on a user's account/data.
const assert = require('node:assert/strict');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWzUAAAAASUVORK5CYII=', 'base64');
const firstId = '1736559317591099105';
const secondId = '1732884222365828199';
const file = name => ({ name, mimeType: 'image/png', buffer: png });

module.exports = async function testImageProductIds(page, api) {
  const quick = page.locator('.quick-product-grid');
  const input = quick.locator('input[type="file"]');
  const id = quick.getByPlaceholder('自动识别首张图片文件名中的 ID，可修改');
  async function expectId(expected) {
    await page.waitForFunction(value => document.querySelector('.quick-product-options input[title]')?.value === value, expected);
    assert.equal(await id.inputValue(), expected);
  }
  async function drop(names, size = png.length) {
    await quick.locator('.quick-upload-zone').evaluate((element, {names, bytes, size}) => {
      const transfer = new DataTransfer();
      for (const name of names) transfer.items.add(new File([size === bytes.length ? new Uint8Array(bytes) : new Uint8Array(size)], name, {type:'image/png'}));
      element.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:transfer}));
    }, {names, bytes:[...png], size});
  }
  const clear = () => page.getByRole('button', {name:'清空图片', exact:true}).click();

  await drop([`${firstId} (2).webp`]);
  await expectId(firstId);
  await input.setInputFiles(file(`${secondId}.jpeg`));
  await expectId(firstId);
  await id.fill('1735360337668113923');
  await drop(['0000000000000000001.png']);
  await expectId('1735360337668113923');
  await quick.getByRole('button', {name:`移除 ${firstId} (2).webp`,exact:true}).click();
  await expectId('1735360337668113923');
  await id.fill('');
  await drop(['0000000000000000002.png']);
  await expectId(''); // Intentional manual clearing must also survive appends.
  await clear();
  await drop(['ordinary.png', `${secondId}.png`]);
  await expectId(''); // Never search later images for a usable ID.
  await quick.getByRole('button', {name:'移除 ordinary.png',exact:true}).click();
  await drop([`${firstId}.png`]);
  await expectId('');
  await clear();
  await input.setInputFiles([file(`${firstId}.png`),file(`${secondId}.png`)]);
  await expectId(firstId);
  await clear();
  await expectId(''); // Clearing a group clears only its automatic ID.
  await drop([`${secondId}.png`]);
  await expectId(secondId);
  await quick.getByRole('button', {name:`移除 ${secondId}.png`,exact:true}).click();
  await expectId(''); // Removing the final picture also starts a new group.
  await drop([`${firstId}.png`], 13 * 1024 * 1024);
  await page.getByText(`${firstId}.png 超过 12MB`, {exact:true}).waitFor();
  await expectId('');
  await drop([`${secondId}.png`]);
  await expectId(secondId); // Rejected files don't consume first-image detection.
  await clear();
  await id.fill('001735360337668113923');
  await drop([`${firstId}.png`]);
  await expectId('001735360337668113923'); // Respect a pre-entered ID.
  await page.reload({waitUntil:'networkidle'});

  // Product-library modal uses the same hook, including real FormData save.
  await page.getByRole('navigation').getByRole('button', {name:'商品库'}).click();
  await page.getByRole('button', {name:/添加商品/}).first().click();
  const modal = page.locator('form.product-modal');
  await modal.waitFor();
  await modal.locator('input[type="file"]').first().setInputFiles(file(`${firstId} (2).png`));
  await page.waitForFunction(value => document.querySelector('form.product-modal input[name="externalId"]')?.value === value, firstId);
  await modal.locator('input[type="file"]').first().setInputFiles(file(`${secondId}.png`));
  assert.equal(await modal.locator('input[name="externalId"]').inputValue(), firstId);
  await modal.locator('input[name="name"]').fill('image-id-fixture');
  await modal.getByRole('button', {name:'保存商品',exact:true}).click();
  await modal.waitFor({state:'hidden', timeout:10000}).catch(async error => {
    throw new Error(`保存测试商品失败：${await modal.innerText()}`, {cause:error});
  });
  const saved = (await api('/api/workspace')).products.find(product => product.name === 'image-id-fixture');
  assert.equal(saved.external_id, firstId);
  assert.equal(saved.images.length, 2);
  await api('/api/products', {method:'DELETE', body:JSON.stringify({id:saved.id})});
  await page.getByRole('button', {name:'更多工具'}).click();
  await page.getByRole('navigation').getByRole('button', {name:'爆款复刻'}).click();
  const remixInput = page.locator('.product-drop input[type="file"]');
  const remixId = page.getByPlaceholder('自动识别首张图片文件名中的 ID，可修改');
  await remixInput.setInputFiles(file(`${firstId}.png`));
  await page.waitForFunction(value => document.querySelector('.remix-config-grid input[placeholder*="首张图片"]')?.value === value, firstId);
  await remixInput.setInputFiles(file(`${secondId}.png`));
  assert.equal(await remixId.inputValue(), firstId);
  await remixId.fill('custom-id');
  await remixInput.setInputFiles(file('extra.png'));
  assert.equal(await remixId.inputValue(), 'custom-id');
  // Leave the isolated page without submitting any generation request.
  await page.getByRole('button', {name:'更多工具'}).click();
  await page.getByRole('navigation').getByRole('button', {name:'创作中心'}).click();
  console.log('Image filename IDs: drag/drop, append, batch order, manual edits, clear/reset, invalid files and product save PASS');
};
