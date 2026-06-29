param(
    [Parameter(Mandatory = $true)]
    [string]$GndExe,
    [string]$AgentId = "sehui",
    [string]$CoordDir = "$env:USERPROFILE/agent-coord",
    [string]$Repo
)

$ErrorActionPreference = "Stop"

$Host.UI.RawUI.WindowTitle = "gnd-client (PowerShell 7)"

if (-not (Test-Path -LiteralPath $GndExe)) {
    Write-Error "gnd.exe not found: $GndExe"
    exit 1
}

$env:AGENT_COORD_DIR = $CoordDir
$env:CURSOR_PROJECT_DIR = $Repo
$vcpkgDebug = Join-Path $Repo "gnd/vcpkg_installed/x64-windows/debug/bin"
$vcpkgBin = Join-Path $Repo "gnd/vcpkg_installed/x64-windows/bin"
$env:PATH = "$env:PATH;$vcpkgDebug;$vcpkgBin"

Set-Location -LiteralPath $Repo

& $GndExe --id $AgentId --dir $CoordDir --repo $Repo
