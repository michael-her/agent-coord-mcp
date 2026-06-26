$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$log = Join-Path $dir 'coord-hooks.log'
Add-Content -Path $log -Value "[$(Get-Date -Format o)] RUN session-start.ps1"

$node = @(
  'G:\ide\nodejs\node.exe',
  'G:\ide\cursor\resources\app\resources\helpers\node.exe',
  'node'
) | Where-Object { $_ -eq 'node' -or (Test-Path $_) } | Select-Object -First 1

$stdin = [Console]::In.ReadToEnd()
$out = $stdin | & $node (Join-Path $dir 'coord-session-start.mjs') 2>&1
if ($LASTEXITCODE -ne 0) {
  Add-Content -Path (Join-Path $dir 'coord-hook-errors.log') -Value "session-start exit $LASTEXITCODE : $out"
  exit $LASTEXITCODE
}
[Console]::Out.Write($out)
[Console]::Out.Flush()
exit 0
