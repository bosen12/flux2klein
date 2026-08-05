@echo off
rem ===========================================================
rem  LoRA Manager (standalone) - browse/tag/manage LoRA files,
rem  "send to workflow" pushes into the currently-open 暗房 tab
rem  instead of a live ComfyUI graph (see darkroom/preview_ui.py
rem  /api/lora-push). Vendored from github.com/willmiao/
rem  ComfyUI-Lora-Manager, see VENDORED.md for the source commit
rem  and exactly what was changed.
rem
rem  Runs on its own port (7861 by default), independent of
rem  ComfyUI (8188), the KLEIN panel (7801) and 暗房 (7860).
rem
rem  Keep this file pure ASCII (see progress notes 3a994ac).
rem ===========================================================
setlocal
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=7861"

rem Unlike voice-assistant (needs CUDA torch, dedicated venv), LoRA Manager's
rem deps are lightweight (aiohttp etc) - just use the system Python, same as
rem serve.py/preview_ui.py/groq_proxy.py elsewhere in this project.
set "PY=python"
where %PY% >nul 2>nul || set "PY=py"

echo Installing/checking dependencies (aiohttp etc, quick if already present)...
"%PY%" -m pip install -q -r requirements.txt

echo Syncing settings.json loras path from LORA_ROOT ...
"%PY%" write_settings.py

echo Starting LoRA Manager on port %PORT% ...
echo Open http://127.0.0.1:%PORT%/loras
"%PY%" standalone.py --port %PORT%

echo.
echo LoRA Manager stopped.
pause
