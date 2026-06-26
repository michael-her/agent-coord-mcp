@echo off

setlocal EnableExtensions

echo [%DATE% %TIME%] audit>>"%~dp0coord-hooks.log"

call "%~dp0coord-launch.cmd" coord-audit.mjs

exit /b %ERRORLEVEL%

