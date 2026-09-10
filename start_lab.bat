@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  KLEIN LAB - the redesigned panel, side by side with the original.
rem
rem  This starts a SECOND server on port 7802 and opens /lab.
rem  start.bat (port 7801, /klein) is untouched - run both at once
rem  and compare in two browser tabs.
rem
rem  Usage:
rem    double-click                       -> ComfyUI=127.0.0.1:8188, panel=7802
rem    start_lab.bat host:port port       -> e.g. start_lab.bat 127.0.0.1:8188 7899
rem    start_lab.bat host:port port https -> HTTPS (phone mic / voice input)
rem ============================================================

set "COMFY=%~1"
if "%COMFY%"=="" set "COMFY=127.0.0.1:8188"
set "PORT=%~2"
if "%PORT%"=="" set "PORT=7802"

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
echo   KLEIN LAB - redesigned panel ^(the original is not touched^)
echo   ComfyUI : %COMFY%
echo   LAB     : %SCHEME%://127.0.0.1:%PORT%/lab
echo   original: %SCHEME%://127.0.0.1:%PORT%/klein   ^(same server, old skin^)
echo ------------------------------------------------------------
echo   Both URLs are served by this one process, so you can flip
echo   between them in two tabs without starting anything else.
echo   Close this window to stop it.
echo ============================================================
echo.

rem --- open browser after 3s (server keeps running in THIS window) ---
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start "" %SCHEME%://127.0.0.1:%PORT%/lab"

%PY% serve.py %COMFY% %PORT% %HTTPSARG%

echo.
echo KLEIN LAB stopped.
pause
