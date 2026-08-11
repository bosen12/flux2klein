@echo off
rem ===========================================================
rem  Ci-Ku Darkroom - 多 GPU 一次性補缺圖
rem  對 preview_config.json 的 comfy_endpoints 清單裡每一台
rem  ComfyUI（本機 + RunPod 之類租的都算）平行送生成，補齊
rem  special_prompts 缺圖的詞庫。只是暫時用來一次補完一大批，
rem  平常瀏覽/單張生成還是用 preview_ui.bat。
rem
rem  Keep this file pure ASCII (see progress notes 3a994ac).
rem ===========================================================
cd /d "%~dp0"
python multi_gpu_batch.py
pause
