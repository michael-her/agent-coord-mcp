@echo off
setlocal EnableExtensions
set "SCRIPT=%~1"
if "%SCRIPT%"=="" exit /b 1
set "NODE=G:\ide\nodejs\node.exe"
if not exist "%NODE%" set "NODE=G:\ide\cursor\resources\app\resources\helpers\node.exe"
if not exist "%NODE%" set "NODE=node"
set "OUT=%TEMP%\coord-hook-%RANDOM%.json"
"%NODE%" "%~dp0%SCRIPT%" 1>"%OUT%" 2>>"%~dp0coord-hook-errors.log"
if exist "%OUT%" (type "%OUT%" & del "%OUT%")
exit /b %ERRORLEVEL%
