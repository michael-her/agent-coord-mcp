@echo off
REM Patch A: ensure powershell shim (-NoLogo) is on PATH before real powershell.exe
set "SHIM_DIR=G:\ide\cursor\resources\app\codeBin"
if not exist "%SHIM_DIR%\powershell.cmd" (
  echo @echo off> "%SHIM_DIR%\powershell.cmd"
  echo "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive %%*>> "%SHIM_DIR%\powershell.cmd"
)
copy /Y "%SHIM_DIR%\powershell.cmd" "G:\ide\nodejs\powershell.cmd" >nul 2>&1
echo OK: powershell shims in codeBin + nodejs
echo Restart Cursor after PATH changes.
