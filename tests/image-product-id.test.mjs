import test from 'node:test';
import assert from 'node:assert/strict';
import { productIdFromImageName } from '../app/use-image-product-id.ts';

test('图片文件名里的长商品 ID 原样保留，不经过浮点数转换', () => {
  for (const id of ['1736559317591099105', '1732884222365828199', '001735893093605795331']) {
    for (const extension of ['webp', 'jpeg', 'jpg', 'PNG', 'avif']) {
      assert.equal(productIdFromImageName(`${id}.${extension}`), id);
    }
  }
});

test('兼容截图里重复下载的数字 (2).webp 文件名', () => {
  for (const name of ['1736559317591099105 (2).webp', '1736559317591099105(12).JPEG', ' 1736559317591099105.webp ']) {
    assert.equal(productIdFromImageName(name), '1736559317591099105');
  }
});

test('普通图片名、说明文字、非图片和空文件名不猜测商品 ID', () => {
  for (const name of ['', '封面.webp', 'IMG_1736559317591099105.jpg', '1736559317591099105-detail.webp', '1736559317591099105.mp4', '1736559317591099105', '.png']) {
    assert.equal(productIdFromImageName(name), '');
  }
});
