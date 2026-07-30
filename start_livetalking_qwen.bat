@echo off
rem ============================================================
rem  LiveTalking with local Qwen3-TTS (your cloned voice).
rem  Runs entirely on this machine - no Alibaba DashScope key needed.
rem  Run start_livetalking_edge.bat first to confirm the pipeline works.
rem  Optional args: %1=model (wav2lip/musetalk)  %2=avatar_id
rem ============================================================
set "LT_TTS=qwen3local"

rem --- voice cloning config, read by LiveTalking\tts\qwen3local.py ---
set "QWEN3_TTS_REF_AUDIO=%~dp0voices\my_voice_10s.wav"
set "QWEN3_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-1.7B-Base"
set "QWEN3_TTS_LANGUAGE=zh"
rem x-vector: timbre only, no transcript needed. Set to 0 for ICL mode
rem (also carries accent and delivery) but then QWEN3_TTS_REF_TEXT must be
rem the exact transcript of the reference audio.
set "QWEN3_TTS_XVEC_ONLY=1"
set "QWEN3_TTS_REF_TEXT="
rem codec steps per chunk: smaller = faster first audio, more overhead
set "QWEN3_TTS_CHUNK_SIZE=8"

if not exist "%QWEN3_TTS_REF_AUDIO%" (
  echo [ERROR] Reference audio not found:
  echo         %QWEN3_TTS_REF_AUDIO%
  echo         Put a 24kHz mono wav ^(5-10s of clean speech^) there,
  echo         or edit QWEN3_TTS_REF_AUDIO in this file.
  pause
  exit /b 1
)

call "%~dp0start_livetalking.bat" %*
