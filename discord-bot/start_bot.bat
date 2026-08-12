@echo off
rem ===========================================================
rem  Darkroom Discord Bot (bot.py) - slash commands /intro
rem  /lora /chkp /gacha. Needs discord-bot/config.json filled
rem  in (copy from config.example.json) and darkroom's
rem  preview_ui.py already running.
rem ===========================================================
cd /d "%~dp0"
python bot.py %*
pause
