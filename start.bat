@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  Flux2 Klein / Z-Image - ComfyUI Panel launcher
rem  Usage:
rem    double-click                    -> HTTP,  ComfyUI=127.0.0.1:8188, panel=7801
rem    start.bat host:port port        -> e.g. start.bat 127.0.0.1:8188 8190
rem    start.bat host:port port https  -> HTTPS (needed for phone mic / voice input)
rem    (or just double-click start_https.bat)
rem ============================================================

set "COMFY=%~1"
if "%COMFY%"=="" set "COMFY=127.0.0.1:8188"
set "PORT=%~2"
if "%PORT%"=="" set "PORT=7801"

rem --- HTTPS only via the 3rd argument (keeps host/port parsing clean) ---
set "HTTPSARG="
if /i "%~3"=="https"   set "HTTPSARG=--https"
if /i "%~3"=="--https" set "HTTPSARG=--https"
set "SCHEME=http"
if defined HTTPSARG set "SCHEME=https"

rem --- find Python ---
set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo [ERROR] Python not found. Install Python 3 and tick "Add to PATH".
  echo         https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo   Flux2 Klein / Z-Image - ComfyUI Panel
echo   ComfyUI : %COMFY%
echo   Panel   : %SCHEME%://127.0.0.1:%PORT%/klein
if defined HTTPSARG (
  echo   Mode    : HTTPS  ^(phone can use microphone / voice input^)
  echo   Phone   : open the https://LAN-IP URL printed below on your phone,
  echo             accept the one-time "not secure" warning once.
) else (
  echo   Mode    : HTTP   ^(desktop only for voice; use start_https.bat for phone^)
)
echo ------------------------------------------------------------
echo   Make sure ComfyUI is running. Browser opens in a moment.
echo   Close this window to stop the panel.
echo ============================================================
echo.

rem --- open browser after 3s (server keeps running in THIS window) ---
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start "" %SCHEME%://127.0.0.1:%PORT%/klein"

%PY% serve.py %COMFY% %PORT% %HTTPSARG%

echo.
echo Panel stopped.
pause
