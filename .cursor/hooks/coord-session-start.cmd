@echo off

setlocal EnableExtensions

echo [%DATE% %TIME%] session-start>>"%~dp0coord-hooks.log"

call "%~dp0coord-launch.cmd" coord-session-start.mjs

exit /b %ERRORLEVEL%

