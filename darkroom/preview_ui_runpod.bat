@echo off
rem ===========================================================
rem  Ci-Ku Darkroom (preview_ui.py) - RunPod GPU 版
rem  跟 preview_ui.bat 完全同一支程式，只是 --comfy 指到 RunPod
rem  pod 的 ComfyUI 代理網址、--port 用 7861（跟本機那份 7860
rem  錯開，可以兩個同時開）。special_prompts 詞庫還是讀本機這份，
rem  只有實際送去生成的 ComfyUI 換成 RunPod 的 GPU。
rem
rem  用法：改下面這行的網址成你自己 pod 的 8188 代理網址即可，
rem  pod 重啟後網址不會變（跟 SSH 那個 direct TCP port 不一樣）。
rem
rem  Keep this file pure ASCII (see progress notes 3a994ac).
rem ===========================================================
cd /d "%~dp0"
python preview_ui.py --comfy https://kjk5gnmjzvlrdj-8188.proxy.runpod.net --port 7861 %*
pause
