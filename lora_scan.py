#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LoRA 清單掃描：面板 serve.py 與暗房 preview_ui.py 共用。

兩邊以前各掃一次 LORA_ROOT，預覽副檔名與 <lora:…> 剝除已經漂移——面板看不到
只有影片預覽的 LoRA、也會把 A1111 的 <lora:name:1> 當觸發詞送進 ComfyUI。
掃描與快取集中在這裡，兩邊呼叫同一支 list_loras()。"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

LORA_ROOT = Path(os.environ.get(
    "LORA_ROOT",
    r"E:\Comfyui\loras",
))
LORA_FOLDERS = ["style", "Character", "HENTAI", "illus"]
# 先找明確的 .preview.* ，再找同名 stem.* 。副檔名順序＝優先序（先命中先用）。
LORA_PREVIEW_EXTS = (
    ".preview.png", ".preview.jpeg", ".preview.jpg", ".preview.webp",
    ".preview.mp4", ".preview.webm",
    ".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm",
)
LORA_VIDEO_EXTS = (".mp4", ".webm")
TTL = 300.0   # LoRA 很少變動；冷掃要讀數百個 metadata.json，本機約 5 秒

_ANGLE_TAG_RE = re.compile(r"<[^<>]*>")
_cache = {"data": None, "at": 0.0, "refreshing": False}
_lock = threading.Lock()


def is_video_preview(name: str) -> bool:
    n = (name or "").lower()
    return n.endswith(".mp4") or n.endswith(".webm")


def strip_angle_tags(word: str) -> str:
    """拿掉 <...> 這類標籤，並清掉因此留下的空白/多餘逗點。

    有些 LoRA 的 trainedWords 是從 CivitAI 頁面複製貼上的，會混進 A1111/Forge
    用的 <lora:xxx:1> 語法（那邊的提示詞處理器認得、ComfyUI 不認得，送進去只是
    沒意義的文字 token）。只在讀取時清掉、不改 metadata.json。"""
    cleaned = _ANGLE_TAG_RE.sub("", word or "")
    parts = [p.strip() for p in cleaned.split(",")]
    parts = [p for p in parts if p]
    return ", ".join(parts)


def preview_path(folder: str, fn: str) -> Path | None:
    """回傳 LoRA 預覽檔的實體路徑。folder 可能帶子資料夾（如 Character/other）。

    驗證：第一段須在白名單、每一段不得是 ".."；fn 仍是純檔名（擋目錄穿越），
    最後再確認解析後的路徑真的落在 LORA_ROOT 底下。

    fn 的穿越檢查用「整段等於 ".."」而不是「字串包含 ".."」——後者會誤傷合法
    檔名裡剛好連續兩個點的情況。"""
    if not fn or "/" in fn or "\\" in fn or fn in (".", ".."):
        return None
    parts = (folder or "").split("/")
    if (not parts or parts[0] not in LORA_FOLDERS
            or any(part in ("", "..") for part in parts) or "\\" in folder):
        return None
    p = LORA_ROOT / folder / fn
    try:
        p.resolve().relative_to(LORA_ROOT.resolve())
    except ValueError:
        return None
    return p if p.is_file() else None


def build_lora_list() -> dict:
    """真的去掃 LORA_ROOT。呼叫端一律走 list_loras()，它有 SWR 快取。

    用 rglob 遞迴（不是只掃頂層）：LoRA Manager 允許在四分類底下建子資料夾。
    item 的 folder 是完整相對路徑（送 ComfyUI 前轉 "\\"），category 才是頂層四分類。"""
    items, counts, errs = [], {}, []
    for category in LORA_FOLDERS:
        base = LORA_ROOT / category
        if not base.is_dir():
            errs.append(f"{category}: 資料夾不存在")
            counts[category] = 0
            continue
        try:
            paths = sorted(base.rglob("*.safetensors"),
                           key=lambda p: (p.parent.as_posix(), p.name))
        except OSError:
            counts[category] = 0
            continue
        n = 0
        for p in paths:
            fn = p.name
            d = p.parent
            folder = d.relative_to(LORA_ROOT).as_posix()
            stem = fn[: -len(".safetensors")]
            words, title, base_model = [], stem, ""
            meta = d / (stem + ".metadata.json")
            if meta.is_file():
                try:
                    md = json.loads(meta.read_text(encoding="utf-8"))
                    raw_words = (md.get("civitai") or {}).get("trainedWords") or []
                    words = [strip_angle_tags(w) for w in raw_words]
                    title = md.get("model_name") or stem
                    base_model = (md.get("base_model")
                                  or (md.get("civitai") or {}).get("baseModel")
                                  or "")
                except Exception:
                    pass
            preview = None
            for ext in LORA_PREVIEW_EXTS:
                if (d / (stem + ext)).is_file():
                    preview = stem + ext
                    break
            items.append({
                "folder": folder,
                "category": category,
                "file": fn,
                "name": stem,
                "title": title,
                "trainedWords": words,
                "preview": preview,
                "base_model": base_model,
            })
            n += 1
        counts[category] = n
    data = {"items": items, "counts": counts, "folders": list(LORA_FOLDERS)}
    if errs:
        data["error"] = "；".join(errs)
    with _lock:
        _cache["data"] = data
        _cache["at"] = time.time()
        _cache["refreshing"] = False
    return data


def list_loras() -> dict:
    """stale-while-revalidate：過期先回舊的、背景重掃。冷啟動沒有舊資料才同步等。"""
    with _lock:
        data = _cache["data"]
        stale = (time.time() - _cache["at"]) >= TTL
        need_bg = stale and data is not None and not _cache["refreshing"]
        if need_bg:
            _cache["refreshing"] = True
    if data is None:
        return build_lora_list()
    if need_bg:
        def work():
            try:
                build_lora_list()
            except Exception as e:
                with _lock:
                    _cache["refreshing"] = False
                print(f"[lora] 背景重掃失敗：{type(e).__name__}: {e}", flush=True)
        threading.Thread(target=work, daemon=True).start()
    return data
