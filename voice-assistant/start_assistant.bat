@echo off
rem ===========================================================
rem  Start the AI assistant speech service.
rem  Pipeline: Silero VAD -> Whisper STT -> Groq LLM -> Qwen3-TTS
rem  Everything runs locally except the LLM, which calls Groq.
rem
rem  Usage:
rem    double-click                -> ws port 8765
rem    start_assistant.bat 8770    -> custom ws port
rem
rem  Keep this file pure ASCII. Non-ASCII characters make the
rem  console reinterpret the codepage and the window closes
rem  immediately (see progress notes, commit 3a994ac).
rem ===========================================================
setlocal
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8765"

rem Prefer the venv python; fall back to the system one.
set "PY=C:\projects\s2s\Scripts\python.exe"
if not exist "%PY%" set "PY=py"

"%PY%" start_assistant.py --port %PORT%

echo.
echo Service stopped. Press any key to close.
pause >nul
