param(
  [switch]$Desktop
)

$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$desktopRoot = Join-Path $projectRoot "gemini-web-workbench"
$desktopPackage = Join-Path $desktopRoot "package.json"
$desktopModules = Join-Path $desktopRoot "node_modules"
$runtimeDirectory = Join-Path $projectRoot ".local-runtime"
$stdoutPath = Join-Path $runtimeDirectory "desktop.out.log"
$stderrPath = Join-Path $runtimeDirectory "desktop.err.log"

function Show-StartupError {
  param([string]$Message)
  try {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
      $Message,
      "FlowCut startup failed",
      [System.Windows.MessageBoxButton]::OK,
      [System.Windows.MessageBoxImage]::Error
    ) | Out-Null
  } catch {
    Write-Error $Message
  }
}

try {
  New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

  # Prefer the current source tree so newly built features are available.
  if ((Test-Path -LiteralPath $desktopPackage) -and (Test-Path -LiteralPath $desktopModules)) {
    $npm = Get-Command "npm.cmd" -ErrorAction Stop
    $process = Start-Process `
      -FilePath $npm.Source `
      -ArgumentList "--prefix", $desktopRoot, "start" `
      -WorkingDirectory $projectRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru

    Start-Sleep -Seconds 2
    if ($process.HasExited -and $process.ExitCode -ne 0) {
      $detail = if (Test-Path -LiteralPath $stderrPath) {
        (Get-Content -LiteralPath $stderrPath -Tail 20) -join "`n"
      } else {
        "No error log was created."
      }
      throw "FlowCut exited during startup (code $($process.ExitCode)).`n`n$detail`n`nFull log: $stderrPath"
    }
    exit 0
  }

  # Packaged fallback: use the unpacked executable without relying on its name.
  $unpackedRoot = Join-Path $desktopRoot "release\win-unpacked"
  $packaged = Get-ChildItem -LiteralPath $unpackedRoot -File -Filter "*.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch "(?i)uninstall|squirrel|update" } |
    Sort-Object Length -Descending |
    Select-Object -First 1

  if ($packaged) {
    Start-Process -FilePath $packaged.FullName
    exit 0
  }

  throw "No runnable FlowCut desktop application was found. Restore the project dependencies or reinstall FlowCut."
} catch {
  Show-StartupError -Message ([string]$_.Exception.Message)
  exit 1
}
