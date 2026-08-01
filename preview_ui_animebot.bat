@echo off
rem ===========================================================
rem  Ci-Ku Darkroom - ANIMEBOT path variant.
rem  Same tool as preview_ui.bat, but serves the OLD library at
rem  C:\projects\animebot\special_prompts (overrides special_dir
rem  in preview_config.json). Everything else (port 7860, comfy,
rem  workflow) still comes from preview_config.json.
rem
rem  Run only ONE darkroom at a time (they share port 7860).
rem  Keep this file pure ASCII (see progress notes 3a994ac).
rem ===========================================================
cd /d "%~dp0"
python preview_ui.py --special-dir "C:\projects\animebot\special_prompts" %*
pause
