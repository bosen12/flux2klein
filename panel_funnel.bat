@echo off
title Flux2 Klein Panel - Tailscale Funnel
setlocal
cd /d "%~dp0"

rem ============================================================
rem  Start the Flux2 Klein panel (serve.py) and expose it
rem  publicly via Tailscale Funnel.
rem    ComfyUI : 127.0.0.1:8188
rem    Panel   : 127.0.0.1:7801   (served by serve.py)
rem  Usage: double-click, or  panel_funnel.bat host:port port
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
  pause
  exit /b 1
)

rem --- start panel if not already running ---
set RUNNING=0
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel% == 0 set RUNNING=1

if "%RUNNING%" == "1" (
  echo [SKIP] Panel already running on port %PORT%
  goto start_funnel
)

if not exist "%~dp0serve.py" (
  echo [ERROR] serve.py not found next to this bat.
  pause
  exit /b 1
)

echo [INFO] Starting panel (serve.py) on port %PORT% ...
start "Flux2 Klein Panel" cmd /k "%PY% serve.py %COMFY% %PORT%"

rem --- wait for the panel to come up (max 15s) ---
set /a tries=0
:wait_loop
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel% == 0 goto panel_ready
set /a tries+=1
if %tries% lss 15 goto wait_loop
echo [WARN] Panel not ready after 15s, continuing anyway...
goto start_funnel

:panel_ready
echo [OK] Panel is ready.

:start_funnel
rem --- Tailscale must exist and be logged in ---
where tailscale >nul 2>&1
if %errorlevel% neq 0 (
  echo [ERROR] Tailscale not found. Install from https://tailscale.com/download
  pause
  exit /b 1
)
tailscale status >nul 2>&1
if %errorlevel% neq 0 (
  echo [ERROR] Tailscale not logged in. Run: tailscale login
  pause
  exit /b 1
)

rem --- start funnel (background, survives this window closing) ---
echo [INFO] Starting Tailscale Funnel for port %PORT% ...
tailscale funnel --bg %PORT%
if %errorlevel% neq 0 (
  echo [ERROR] Failed to start Tailscale Funnel.
  echo         Enable Funnel for your account: https://tailscale.com/kb/1223/tailscale-funnel
  pause
  exit /b 1
)

echo.
echo [OK] Funnel is running. Public URL:
tailscale funnel status
echo.
echo   The panel is served at the ROOT of that https URL.
echo   NOTE: anyone with the URL can drive your ComfyUI (no login). Share carefully.
echo   To stop: run panel_funnel_off.bat   (or: tailscale funnel --bg off)
echo.

rem --- open the panel locally for yourself ---
start "" "http://localhost:%PORT%/klein"

pause
