@echo off

setlocal EnableExtensions

echo [%DATE% %TIME%] stop>>"%~dp0coord-hooks.log"

call "%~dp0coord-launch.cmd" coord-stop.mjs

exit /b %ERRORLEVEL%

