@echo off
title Stop Flux2 Klein / Z-Image Panel
echo ============================================================
echo   Stopping ALL panel (serve.py) processes...
echo   (Your ComfyUI is NOT touched.)
echo ============================================================
echo.

powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'serve\.py' }; if ($p) { $p | ForEach-Object { Write-Host ('  killing PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } else { Write-Host '  (none running)' }"

echo.
echo Done.
ping -n 3 127.0.0.1 >nul
