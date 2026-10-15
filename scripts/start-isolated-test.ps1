param(
  [string]$Executable = (Join-Path $PSScriptRoot '..\gemini-web-workbench\release\win-unpacked\FlowCut全自动AI视频工作台.exe')
)
$ErrorActionPreference = 'Stop'
$executablePath = (Resolve-Path -LiteralPath $Executable).Path
$testProfile = Join-Path ([IO.Path]::GetTempPath()) ('FlowCut-manual-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testProfile | Out-Null
$priorProfile = $env:FLOWCUT_SMOKE_USER_DATA
$priorSmokeFile = $env:FLOWCUT_DESKTOP_SMOKE_FILE
try {
  $env:FLOWCUT_SMOKE_USER_DATA = $testProfile
  Remove-Item Env:FLOWCUT_DESKTOP_SMOKE_FILE -ErrorAction SilentlyContinue
  # This is the user-requested interactive window.
  $process = Start-Process -FilePath $executablePath -ArgumentList "--user-data-dir=`"$testProfile`"" -WindowStyle Normal -PassThru
  [PSCustomObject]@{ ProcessId = $process.Id; Profile = $testProfile; Site = 'http://127.0.0.1:4198'; Publisher = 'http://127.0.0.1:18777' }
} finally {
  $env:FLOWCUT_SMOKE_USER_DATA = $priorProfile
  $env:FLOWCUT_DESKTOP_SMOKE_FILE = $priorSmokeFile
}
