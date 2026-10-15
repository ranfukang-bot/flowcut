const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const execute = promisify(execFile);

// Windows supplies the ZIP/ZIP64 implementation; no additional runtime dependency.
async function zipDirectory(from, to, { extract = false } = {}) {
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if ($env:FLOWCUT_ZIP_EXTRACT -eq '1') {
      $archive = [IO.Compression.ZipFile]::OpenRead($env:FLOWCUT_ZIP_FROM)
      try {
        $root = [IO.Path]::GetFullPath($env:FLOWCUT_ZIP_TO) + [IO.Path]::DirectorySeparatorChar
        $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        [long]$total = 0
        foreach ($entry in $archive.Entries) {
          $name = $entry.FullName
          if ($name -match '(^[\\/]|:|(^|[\\/])\.\.([\\/]|$)|(^|[\\/])Partitions([\\/]|$))') { throw 'Unsafe ZIP entry' }
          $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $name))
          if (!$target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or !$seen.Add($target)) { throw 'Unsafe or duplicate ZIP entry' }
          if (($entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000) { throw 'ZIP links are not supported' }
          $total += $entry.Length
          if ($total -gt 1099511627776 -or $seen.Count -gt 1000000) { throw 'Backup exceeds extraction limits' }
        }
      } finally { $archive.Dispose() }
      [IO.Compression.ZipFile]::ExtractToDirectory($env:FLOWCUT_ZIP_FROM, $env:FLOWCUT_ZIP_TO)
    } else {
      [IO.Compression.ZipFile]::CreateFromDirectory($env:FLOWCUT_ZIP_FROM, $env:FLOWCUT_ZIP_TO, [IO.Compression.CompressionLevel]::Fastest, $false)
    }
  `;
  await execute(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, maxBuffer: 1024 * 1024,
      env: { ...process.env, FLOWCUT_ZIP_FROM: path.resolve(from), FLOWCUT_ZIP_TO: path.resolve(to), FLOWCUT_ZIP_EXTRACT: extract ? '1' : '0' },
    });
}
module.exports = { zipDirectory };
