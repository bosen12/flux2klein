@echo off
title Flux2 Klein Panel - Funnel Stop

rem Stop the public Tailscale Funnel (the local panel keeps running).
tailscale funnel --bg off

echo [OK] Tailscale Funnel stopped. The panel is no longer public.
echo      (The local panel window, if open, keeps running on its port.)
timeout /t 2 /nobreak >nul
