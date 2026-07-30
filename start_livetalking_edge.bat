@echo off
rem ============================================================
rem  LiveTalking with EdgeTTS (free cloud voice).
rem  Use this FIRST to validate the whole pipeline - it needs no
rem  local TTS model, so it starts fast and uses less VRAM.
rem  Optional args: %1=model (wav2lip/musetalk)  %2=avatar_id
rem ============================================================
set "LT_TTS=edgetts"
set "LT_EXTRA=--REF_FILE zh-TW-HsiaoChenNeural"
call "%~dp0start_livetalking.bat" %*
