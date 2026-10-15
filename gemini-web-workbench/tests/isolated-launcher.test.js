const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

test('Windows PowerShell 5.1 launches the default Chinese executable path and restores caller flags', { skip: process.platform !== 'win32' }, t => {
  const temporaryRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'flowcut-launcher-test-'));
  let profile;
  t.after(() => {
    if (profile && fs.realpathSync.native(path.dirname(profile)).toLowerCase() === temporaryRoot.toLowerCase() && path.basename(profile).startsWith('FlowCut-manual-')) fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const scripts = path.join(root, 'scripts'), executable = path.join(root, 'gemini-web-workbench/release/win-unpacked/FlowCut全自动AI视频工作台.exe');
  fs.mkdirSync(scripts); fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, 'fixture');
  fs.copyFileSync(path.resolve(__dirname, '../../scripts/start-isolated-test.ps1'), path.join(scripts, 'start-isolated-test.ps1'));
  const output = path.join(root, 'result.json'), harness = path.join(root, 'harness.ps1');
  // Run the actual launcher with a process boundary stub. PowerShell itself
  // decodes the copied script and resolves its default executable argument.
  fs.writeFileSync(harness, `
    $ErrorActionPreference = 'Stop'
    function Start-Process {
      param($FilePath, $ArgumentList, $WindowStyle, [switch]$PassThru)
      if (!$FilePath -or !(Test-Path -LiteralPath $FilePath)) { throw 'Executable path was not resolved' }
      $global:launch = @{ file=$FilePath; arguments=$ArgumentList; style=$WindowStyle; profile=$env:FLOWCUT_SMOKE_USER_DATA; smokeFile=$env:FLOWCUT_DESKTOP_SMOKE_FILE }
      [PSCustomObject]@{ Id=123 }
    }
    $env:FLOWCUT_SMOKE_USER_DATA = 'caller-profile'
    $env:FLOWCUT_DESKTOP_SMOKE_FILE = 'caller-result'
    $result = & (Join-Path $env:FLOWCUT_LAUNCHER_FIXTURE 'scripts/start-isolated-test.ps1')
    @{ launch=$global:launch; result=$result; restoredProfile=$env:FLOWCUT_SMOKE_USER_DATA; restoredResult=$env:FLOWCUT_DESKTOP_SMOKE_FILE } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $env:FLOWCUT_LAUNCHER_RESULT -Encoding UTF8
  `);
  execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { windowsHide: true, env: { ...process.env, FLOWCUT_LAUNCHER_FIXTURE: root, FLOWCUT_LAUNCHER_RESULT: output } });
  const evidence = JSON.parse(fs.readFileSync(output, 'utf8').replace(/^\uFEFF/, ''));
  profile = evidence.result.Profile;
  assert.equal(fs.realpathSync.native(evidence.launch.file), fs.realpathSync.native(executable));
  assert.equal(evidence.launch.style, 'Normal'); assert.equal(evidence.launch.smokeFile || '', '');
  assert.equal(evidence.launch.profile, profile); assert.equal(fs.statSync(profile).isDirectory(), true);
  assert.equal(evidence.launch.arguments, `--user-data-dir="${profile}"`);
  assert.equal(evidence.restoredProfile, 'caller-profile'); assert.equal(evidence.restoredResult, 'caller-result');
  assert.equal(evidence.result.Site, 'http://127.0.0.1:4198'); assert.equal(evidence.result.Publisher, 'http://127.0.0.1:18777');
});
