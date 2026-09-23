import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "lib", "gemini.ts"), "utf8");

test("Gemini prompt appends task facts and an unattended execution contract", () => {
  for (const forbidden of [
    "以下是本次产品资料",
    "未提供，请先",
    "不得编造",
    "严格遵循上面的身份",
    "请仅依据参考图",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(source, /`时长：\$\{product\.duration\}秒`/);
  assert.match(source, /`地区：\$\{product\.region\}`/);
  assert.match(source, /`拍摄风格：\$\{product\.shooting_style\}`/);
  assert.match(source, /执行方式：这是无人值守批量任务/);
  assert.match(source, /不要停下来询问或等待补充/);
  assert.equal(source.includes("口播语言："), false);
  assert.equal(source.includes("产品名称："), false);
  assert.equal(source.includes("商品ID："), false);
  assert.equal(source.includes("产品信息："), false);
  assert.equal(source.includes("直接输出最终提示词。"), false);
});

test("workspace no longer creates or requires a built-in Gem", () => {
  const storage = fs.readFileSync(path.join(root, "lib", "storage.ts"), "utf8");
  const gemRoute = fs.readFileSync(
    path.join(root, "app", "api", "gems", "route.ts"),
    "utf8",
  );
  assert.equal(storage.includes("DEFAULT_GEM_CONTENT"), false);
  assert.match(storage, /DELETE FROM gems WHERE is_default = 1/);
  assert.equal(gemRoute.includes("至少保留一个 Gem"), false);
});
