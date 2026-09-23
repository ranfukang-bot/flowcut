import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("double-click launcher starts current source and never targets a stale fixed exe", () => {
  const cmd = fs.readFileSync(path.join(root, "启动全自动AI视频工作台.cmd"), "utf8");
  const launcher = fs.readFileSync(path.join(root, "Start-FlowCut.ps1"), "utf8");
  assert.match(cmd, /Start-FlowCut\.ps1/);
  assert.equal(cmd.includes("1.0.0"), false);
  assert.match(launcher, /Get-Command "npm\.cmd"/);
  assert.match(launcher, /"--prefix", \$desktopRoot, "start"/);
  assert.match(launcher, /desktop\.err\.log/);
  assert.match(launcher, /release\\win-unpacked/);
});
