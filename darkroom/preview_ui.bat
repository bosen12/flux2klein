@echo off
rem ===========================================================
rem  Ci-Ku Darkroom (preview_ui.py) - special_prompts preview
rem  generator / manager. Opens in your browser on port 7860
rem  (change in preview_config.json). Needs ComfyUI running to
rem  actually generate images.
rem
rem  Keep this file pure ASCII (see progress notes 3a994ac).
rem ===========================================================
cd /d "%~dp0"
python preview_ui.py %*
pause
