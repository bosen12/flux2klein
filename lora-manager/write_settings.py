#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
每次啟動前跑一次，把 settings.json 的 loras 路徑同步成 LORA_ROOT 環境變數（跟
darkroom/preview_ui.py、serve.py 用同一個環境變數、同一個預設值，三邊永遠指向
同一份 LoRA 收藏，不會各自為政）。

用 portable 模式（settings.json 留在這個資料夾，不是寫去 %APPDATA%）——這支專案
被 vendor 進 flux2klein，設定也該跟著 repo 走，不要散到系統的使用者設定目錄。
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

    SETTINGS_PATH.write_text(
        json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[write_settings] loras 路徑指向: {LORA_ROOT}")


if __name__ == "__main__":
    main()
