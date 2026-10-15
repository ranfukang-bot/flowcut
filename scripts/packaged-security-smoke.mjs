import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const executable = path.resolve(process.argv[2] || path.join(root, 'gemini-web-workbench/release/win-unpacked/FlowCut全自动AI视频工作台.exe'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-personal-package-'));
const profile = path.join(temporary, 'profile'), resultFile = path.join(temporary, 'result.json');
fs.mkdirSync(path.join(profile, 'seedance'), { recursive: true });
fs.writeFileSync(path.join(profile, 'workbench-state.json'), JSON.stringify({ settings: { bridgeKey: randomBytes(32).toString('hex'), queueRunning: false, flowcutUrl: 'http://127.0.0.1:4198' }, accounts: [] }));
fs.writeFileSync(path.join(profile, 'seedance/workbench-state.json'), JSON.stringify({ settings: { running: false, apiPort: 17891, downloadDirectory: path.join(temporary, 'downloads') }, accounts: [{ id: 'default', name: '隔离测试', enabled: false, partition: 'persist:isolated-package-smoke' }], tasks: [] }));
let child, exited = false;
try {
  child = spawn(executable, [`--user-data-dir=${profile}`], { windowsHide: true, stdio: 'ignore', env: { ...process.env, FLOWCUT_SMOKE_USER_DATA: profile, FLOWCUT_DESKTOP_SMOKE_FILE: resultFile } });
  let launchError;
  child.once('error', error => { launchError = error; }); child.once('exit', () => { exited = true; });
  const deadline = Date.now() + 90000;
  while (!fs.existsSync(resultFile) && !exited && !launchError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  if (launchError) throw launchError;
  assert.ok(fs.existsSync(resultFile), 'packaged smoke timed out or exited before reporting');
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'gemini-web-workbench/package.json'), 'utf8')).version;
  assert.equal(result.version, expectedVersion); assert.equal(result.edition, 'personal');
  for (const key of ['workbenchStarted', 'publisherReady', 'geminiPageRuntimeReady', 'backupVerified', 'clearAllVerified', 'modelPolicyVerified', 'nativeProtocolBlocked', 'savedGemEditorVerified']) assert.equal(result[key], true, key);
  assert.equal(result.sandbox.main, true); assert.equal(result.sandbox.gemini, true); assert.equal(result.sandbox.geminiBridge, true);
  assert.ok(result.sandbox.seedance.length > 0 && result.sandbox.seedance.every(Boolean));
  assert.ok(result.backupStorage.zipBytes > 0); assert.equal(result.backupStorage.totalBytes, result.backupStorage.zipBytes);
  assert.equal(result.backupStorage.backupCount, 1); assert.ok(result.backupStorage.mediaCount >= 0);
  const evidence = { passed: true, version: result.version, edition: result.edition, sandbox: result.sandbox, backupVerified: true, backupStorage: result.backupStorage, isolatedProfile: profile };
  if (process.env.FLOWCUT_PACKAGED_SMOKE_EVIDENCE) fs.writeFileSync(process.env.FLOWCUT_PACKAGED_SMOKE_EVIDENCE, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  const exitDeadline = Date.now() + 10000;
  while (!exited && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 100));
} finally {
  if (child?.pid && !exited) {
    if (process.platform === 'win32') { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
    else child.kill();
  }
  // The resolved target was created here and is always inside the OS temp root.
  if (temporary.startsWith(path.join(os.tmpdir(), 'flowcut-personal-package-'))) fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
