#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
每次啟動前跑一次，把 settings.json 的路徑同步成環境變數（跟 darkroom/preview_ui.py、
serve.py 用同一組環境變數、同一個預設值，各邊永遠指向同一份收藏，不會各自為政）。

用 portable 模式（settings.json 留在這個資料夾，不是寫去 %APPDATA%）——這支專案
被 vendor 進 flux2klein，設定也該跟著 repo 走，不要散到系統的使用者設定目錄。

checkpoints 曾經完全沒同步過（只有 loras 這一段），導致 LoRA Manager 的 checkpoint
管理功能一直是空的——不是沒設定，是這支腳本原本就沒寫過這個欄位。checkpoints 不像
loras 是走 settings["folder_paths"]，而是走 settings["libraries"][<active_library>]
["extra_folder_paths"]["checkpoints"]（見 py/config.py 的 _load_extra_paths_from_
settings，"default" 是 active_library 沒特別設定時的預設值——見
py/services/settings_manager.py 的 get_active_library_name）。同時寫一份進頂層
settings["extra_folder_paths"] 保持跟 loras 那份對稱，即使目前程式碼只讀 libraries
底下那份，兩邊一致比較不會在往後看設定檔的人心裡打問號。

default_checkpoint_root 刻意不寫——那是「目前選了哪一個 checkpoint 當預設」的 UI
狀態，不是「要掃哪些資料夾」的路徑設定，不該被啟動腳本每次覆蓋掉使用者在介面上
自己選的值。
"""
import json
import os
from pathlib import Path

BASE = Path(__file__).resolve().parent
SETTINGS_PATH = BASE / "settings.json"

LORA_ROOT = os.environ.get(
    "LORA_ROOT",
    r"E:\Comfyui\loras",
)
CHECKPOINT_ROOT = os.environ.get(
    "CHECKPOINT_ROOT",
    r"C:\ComfyUI\ComfyUI_windows_portable_nvidia\ComfyUI_windows_portable\ComfyUI\models\checkpoints",
)


def main():
    settings = {}
    if SETTINGS_PATH.is_file():
        try:
            settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except Exception:
            settings = {}

    settings["use_portable_settings"] = True
    settings.setdefault("civitai_api_key", "")
    folder_paths = settings.setdefault("folder_paths", {})
    folder_paths["loras"] = [LORA_ROOT.replace("\\", "/")]
    settings.setdefault("auto_organize_exclusions", [])

    checkpoint_root = CHECKPOINT_ROOT.replace("\\", "/")
    settings.setdefault("extra_folder_paths", {})["checkpoints"] = [checkpoint_root]
    default_lib = settings.setdefault("libraries", {}).setdefault("default", {})
    default_lib.setdefault("extra_folder_paths", {})["checkpoints"] = [checkpoint_root]

    SETTINGS_PATH.write_text(
        json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[write_settings] loras 路徑指向: {LORA_ROOT}")
    print(f"[write_settings] checkpoints 路徑指向: {CHECKPOINT_ROOT}")


if __name__ == "__main__":
    main()
