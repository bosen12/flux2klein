@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  Flux2 Klein / Z-Image - ComfyUI Panel launcher
rem  Usage:
rem    double-click            -> ComfyUI=127.0.0.1:8188, panel=8189
rem    start.bat host:port port -> e.g. start.bat 127.0.0.1:8188 8190
rem ============================================================

set "COMFY=%~1"
if "%COMFY%"=="" set "COMFY=127.0.0.1:8188"
set "PORT=%~2"
if "%PORT%"=="" set "PORT=7801"

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
echo   Panel   : http://127.0.0.1:%PORT%/klein
echo ------------------------------------------------------------
echo   Make sure ComfyUI is running. Browser opens in a moment.
echo   Close this window to stop the panel.
echo ============================================================
echo.

rem --- open browser after 3s (server keeps running in THIS window) ---
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start "" http://127.0.0.1:%PORT%/klein"

%PY% serve.py %COMFY% %PORT%

echo.
echo Panel stopped.
pause
