@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  HTTPS launcher - use this when you want voice input on your PHONE.
rem  Microphone only works on a secure origin; over the LAN that means HTTPS.
rem  Optional args override defaults: start_https.bat host:port port
rem ============================================================

set "COMFY=%~1"
if "%COMFY%"=="" set "COMFY=127.0.0.1:8188"
set "PORT=%~2"
if "%PORT%"=="" set "PORT=7801"

call "%~dp0start.bat" %COMFY% %PORT% https
