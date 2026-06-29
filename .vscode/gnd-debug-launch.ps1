param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspaceFolder,
    [string]$AgentId = "sehui"
)

$ErrorActionPreference = "Stop"

$gndExe = Join-Path $WorkspaceFolder "gnd/x64/Debug/gnd.exe"
$repo = $WorkspaceFolder
$coordDir = Join-Path $env:USERPROFILE "agent-coord"
$externalScript = Join-Path $WorkspaceFolder ".vscode/gnd-debug-external.ps1"
$pwsh = "C:\Program Files\PowerShell\7\pwsh.exe"

if (-not (Test-Path -LiteralPath $pwsh)) {
    Write-Error "PowerShell 7 not found: $pwsh"
    exit 1
}

Get-Process -Name "gnd" -ErrorAction SilentlyContinue | Stop-Process -Force

$psArgs = @(
    "-NoLogo",
    "-NoExit",
    "-File", $externalScript,
    "-GndExe", $gndExe,
    "-AgentId", $AgentId,
    "-CoordDir", $coordDir,
    "-Repo", $repo
)

# Prefer Windows Terminal + pwsh profile (not legacy conhost/cmd).
$wt = "${env:LOCALAPPDATA}\Microsoft\WindowsApps\wt.exe"
if (-not (Test-Path -LiteralPath $wt)) {
    $wtCmd = Get-Command wt -ErrorAction SilentlyContinue
    if ($wtCmd) { $wt = $wtCmd.Source }
}

if ($wt -and (Test-Path -LiteralPath $wt)) {
    $wtArgs = @(
        "-w", "0",
        "new-tab",
        "--title", "gnd-client",
        "-d", $repo,
        "--",
        $pwsh
    ) + $psArgs
    Start-Process -FilePath $wt -ArgumentList $wtArgs
} else {
    Start-Process -FilePath $pwsh -ArgumentList $psArgs -WorkingDirectory $repo
}

$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    if (Get-Process -Name "gnd" -ErrorAction SilentlyContinue) {
        Write-Output "GND_DEBUG_READY"
        exit 0
    }
    Start-Sleep -Milliseconds 200
}

Write-Error "gnd.exe did not start within 30 seconds"
exit 1
