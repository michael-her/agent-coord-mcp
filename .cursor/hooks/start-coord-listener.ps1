# Start agent-coord listener (runs until Ctrl+C)
$ErrorActionPreference = "Stop"
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $root
Write-Host "agent-coord listener — wake on @mention (@rico/@all etc.) or DM for rico"
node .cursor/hooks/coord-listener.mjs