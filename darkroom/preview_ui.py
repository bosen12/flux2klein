#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
preview_ui.py
=============
把 generate_special_previews.py 包成本機網頁 UI。

啟動:
    python preview_ui.py
    python preview_ui.py --port 8765 --comfy http://127.0.0.1:8188

功能:
  - 顯示 special_prompts/ 底下所有詞庫,標示哪些已有圖片
  - 點縮圖看大圖 + 正/負向 prompt
  - 一鍵重新生成某個詞庫的圖片
  - 過濾:資料夾 / 只看沒圖 / 只看已有 / 名稱搜尋

依賴:標準庫,重用 generate_special_previews.py 的邏輯
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
import mimetypes
import os
import random
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    from PIL import Image
    _HAS_PIL = True
except Exception:
    _HAS_PIL = False

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_special_previews as gsp
from generate_special_previews import (
    SPECIAL_DIR,
    DEFAULT_WORKFLOW,
    DEFAULT_WORKFLOWS,
    build_negative,
    build_prompt,
    download_image,
    http_json,
    load_lib,
    load_workflow,
    prepare_workflow,
    queue_and_wait,
    resolve_comfy_base,
)


# ---------------------------------------------------------------------------
# 本機設定（preview_config.json，已 gitignore）——把機器相關路徑抽出來，
# 這樣程式本身可以推上 GitHub 不含任何硬編路徑。所有欄位可省略。
# 詞庫資料夾預設指向 animebot 那份（bot 也在用），可用 special_dir 改。
# ---------------------------------------------------------------------------
CONFIG_PATH = Path(__file__).resolve().parent / "preview_config.json"


def load_config() -> dict:
    if CONFIG_PATH.is_file():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            if isinstance(cfg, dict):
                return cfg
        except Exception as e:
            print(f"[config] 讀取 {CONFIG_PATH.name} 失敗，用預設：{e}")
    return {}


def apply_special_dir(path_str: str):
    """把詞庫資料夾指向設定的位置（同時更新本模組與 gsp 的全域）。"""
    global SPECIAL_DIR
    p = Path(path_str)
    SPECIAL_DIR = p
    gsp.SPECIAL_DIR = p


def plog(msg: str):
    """主控台 log：帶時間戳、立即 flush，讓 bat 視窗看得到即時進度。
    HTTP 請求那種雜訊仍靜音（Handler.log_message），只印生成/批次這類有用的事件。"""
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# 側檔 metadata（旗標／收藏／稀有度）——**依 special_dir 分檔**。兩個 bat 指向不同
# 的 special_prompts（C:\projects\special_prompts 與 animebot\special_prompts），
# 若共用一份 JSON、key 又是相對路徑，兩份同名結構的詞庫就會互相污染。所以每個
# dataset 各存一份，檔名帶該路徑的短雜湊，放在 .darkroom_meta/ 底下（gitignore）。
# 舊版是共用一份 flags.json / favorites.json——首次啟動時若本 dataset 專屬檔還不
# 存在、而舊共用檔在，就複製過來當起點（兩個 dataset 各複製一份、之後獨立），舊檔
# 保留不刪、絕不遺失資料。
# ---------------------------------------------------------------------------
META_DIR = Path(__file__).resolve().parent / ".darkroom_meta"


def _dataset_tag() -> str:
    """目前 special_dir 的短雜湊，用來把各 dataset 的 metadata 分檔。用解析後的絕對
    路徑並轉小寫，避免同一個資料夾因大小寫/相對寫法算出不同值。"""
    key = str(SPECIAL_DIR.resolve()).lower()
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:8]


def _meta_path(kind: str) -> Path:
    """kind ∈ {flags, favorites, rarities}。回傳本 dataset 專屬的 json 路徑。"""
    return META_DIR / f"{kind}.{_dataset_tag()}.json"


def _migrate_shared(kind: str, old_path: Path):
    """一次性遷移：本 dataset 專屬檔不存在、舊共用檔存在時，複製過去當起點。"""
    new_path = _meta_path(kind)
    if not new_path.exists() and old_path.is_file():
        try:
            META_DIR.mkdir(exist_ok=True)
            shutil.copy2(old_path, new_path)
            plog(f"[meta] {kind}：從舊共用檔遷移到本 dataset（{new_path.name}）")
        except Exception as e:
            plog(f"[meta] {kind} 遷移失敗（改從空白開始）：{e}")


def _atomic_write_json(path: Path, obj):
    """原子寫：temp → replace。呼叫端負責鎖。"""
    META_DIR.mkdir(exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


# --- 詞庫品質旗標（黑名單）：只記錄，不影響抽卡/顯示。key 是詞庫的 rel。 ---------
FLAGS_OLD_PATH = Path(__file__).resolve().parent / "flags.json"   # 舊共用檔（遷移用）
_flags: dict = {}                 # rel -> {"at": ts}
_flags_lock = threading.Lock()


def _load_flags():
    global _flags
    _migrate_shared("flags", FLAGS_OLD_PATH)
    path = _meta_path("flags")
    if not path.is_file():
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        fl = d.get("flagged") if isinstance(d, dict) else None
        if isinstance(fl, dict):
            _flags = fl
        elif isinstance(fl, list):        # 容忍純 list 格式
            _flags = {r: {} for r in fl}
        plog(f"[flags] 載入 {len(_flags)} 筆已標記")
    except Exception as e:
        plog(f"[flags] 讀取失敗，從空白開始：{e}")


def _save_flags_locked():
    """呼叫端須已持有 _flags_lock。原子寫：temp → replace。"""
    _atomic_write_json(_meta_path("flags"), {"flagged": _flags})


def set_flag(rel: str, flagged: bool) -> bool:
    with _flags_lock:
        if flagged:
            _flags[rel] = {"at": time.time()}
        else:
            _flags.pop(rel, None)
        _save_flags_locked()
        return rel in _flags


def flagged_set() -> set:
    with _flags_lock:
        return set(_flags.keys())


# ---------------------------------------------------------------------------
# 收藏（我的最愛）：結構同品質旗標，另存一份 favorites.json。只記錄，不影響
# 抽卡/顯示。key 是詞庫的 rel。
# ---------------------------------------------------------------------------
FAVS_OLD_PATH = Path(__file__).resolve().parent / "favorites.json"   # 舊共用檔（遷移用）
_favs: dict = {}                  # rel -> {"at": ts}
_favs_lock = threading.Lock()


def _load_favs():
    global _favs
    _migrate_shared("favorites", FAVS_OLD_PATH)
    path = _meta_path("favorites")
    if not path.is_file():
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        fv = d.get("favorited") if isinstance(d, dict) else None
        if isinstance(fv, dict):
            _favs = fv
        elif isinstance(fv, list):        # 容忍純 list 格式
            _favs = {r: {} for r in fv}
        plog(f"[favs] 載入 {len(_favs)} 筆收藏")
    except Exception as e:
        plog(f"[favs] 讀取失敗，從空白開始：{e}")


def _save_favs_locked():
    """呼叫端須已持有 _favs_lock。原子寫：temp → replace。"""
    _atomic_write_json(_meta_path("favorites"), {"favorited": _favs})


def set_fav(rel: str, favorited: bool) -> bool:
    with _favs_lock:
        if favorited:
            _favs[rel] = {"at": time.time()}
        else:
            _favs.pop(rel, None)
        _save_favs_locked()
        return rel in _favs


def fav_set() -> set:
    with _favs_lock:
        return set(_favs.keys())


# ---------------------------------------------------------------------------
# 稀有度：改存側檔（rarities.<dataset>.json），**不再寫進檔名**。key 是詞庫 rel，
# value 是稀有度 key（common/rare/special/legendary）；空字串 "" 表示「明確清除」，
# 用來蓋掉舊檔名前綴衍生的稀有度（見 scan 疊加）。舊版把稀有度寫在檔名前綴
# （傳奇版xxx.py），那些檔的檔名不動、由 scan 以檔名衍生當 fallback，等於自動沿用。
# ---------------------------------------------------------------------------
RARITY_KEYS = ("common", "rare", "special", "legendary")
_rarities: dict = {}              # rel -> key（"" = 明確清除）
_rarities_lock = threading.Lock()


def _load_rarities():
    global _rarities
    path = _meta_path("rarities")
    if not path.is_file():
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        r = d.get("rarities") if isinstance(d, dict) else None
        if isinstance(r, dict):
            _rarities = r
        plog(f"[rarity] 載入 {len(_rarities)} 筆稀有度")
    except Exception as e:
        plog(f"[rarity] 讀取失敗，從空白開始：{e}")


def _save_rarities_locked():
    _atomic_write_json(_meta_path("rarities"), {"rarities": _rarities})


def set_rarity(rel: str, key: str, name_has_prefix: bool = False) -> str:
    """設定/清除稀有度。key ∈ RARITY_KEYS 為設定；"" 為清除。清除時若該檔名本身帶
    舊前綴，存明確 "" 以蓋掉 scan 的檔名衍生值；否則直接移除保持側檔精簡。回傳最終值。"""
    with _rarities_lock:
        if key:
            _rarities[rel] = key
        elif name_has_prefix:
            _rarities[rel] = ""
        else:
            _rarities.pop(rel, None)
        _save_rarities_locked()
        return _rarities.get(rel, "")


def rarity_map() -> dict:
    with _rarities_lock:
        return dict(_rarities)


# ---------------------------------------------------------------------------
# LoRA（給「生圖」模式用）：讀 ComfyUI 的 loras 資料夾，列出每個 .safetensors 的觸發詞
# 與預覽圖。沿用主面板 serve.py 的做法與路徑（可用環境變數 LORA_ROOT 覆寫）。這些檔在
# ComfyUI 磁碟上、不透過 ComfyUI API，直接讀資料夾。
# ---------------------------------------------------------------------------
LORA_ROOT = Path(os.environ.get(
    "LORA_ROOT",
    r"C:\ComfyUI\ComfyUI_windows_portable_nvidia\ComfyUI_windows_portable\ComfyUI\models\loras",
))
LORA_FOLDERS = ["style", "Character", "HENTAI", "illus"]
LORA_PREVIEW_EXTS = (".preview.png", ".preview.jpeg", ".preview.jpg", ".preview.webp",
                     ".preview.mp4", ".preview.webm",
                     ".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm")
mimetypes.add_type("image/webp", ".webp")   # 有些 Python 的 mimetypes 不認 webp
LORA_VIDEO_EXTS = (".mp4", ".webm")   # 有些 LoRA 的預覽是短片，前端要改用 <video> 渲染


_lora_cache = {"data": None, "at": 0.0}
_LORA_TTL = 300.0   # LoRA 很少變動，快取 5 分鐘（每次要讀數百個 metadata.json，約 5 秒）


def list_loras() -> dict:
    """列出各分類夾內每個 LoRA 的觸發詞與預覽圖檔名。trainedWords 保留為「多組」陣列。
    讀數百個 metadata.json 很慢（約 5s），用 TTL 快取。"""
    if _lora_cache["data"] is not None and (time.time() - _lora_cache["at"]) < _LORA_TTL:
        return _lora_cache["data"]
    items, counts = [], {}
    for folder in LORA_FOLDERS:
        d = LORA_ROOT / folder
        try:
            names = sorted(p.name for p in d.iterdir())
        except OSError:
            counts[folder] = 0
            continue
        n = 0
        for fn in names:
            if not fn.lower().endswith(".safetensors"):
                continue
            stem = fn[: -len(".safetensors")]
            words, title = [], stem
            meta = d / (stem + ".metadata.json")
            if meta.is_file():
                try:
                    md = json.loads(meta.read_text(encoding="utf-8"))
                    words = (md.get("civitai") or {}).get("trainedWords") or []
                    title = md.get("model_name") or stem
                except Exception:
                    pass
            preview = None
            for ext in LORA_PREVIEW_EXTS:
                if (d / (stem + ext)).is_file():
                    preview = stem + ext
                    break
            items.append({"folder": folder, "file": fn, "name": stem,
                          "title": title, "trainedWords": words, "preview": preview})
            n += 1
        counts[folder] = n
    data = {"items": items, "counts": counts, "folders": LORA_FOLDERS}
    _lora_cache["data"] = data
    _lora_cache["at"] = time.time()
    return data


def lora_preview_path(folder: str, fn: str):
    """回傳 LoRA 預覽圖的實體路徑；folder 須在白名單、fn 純檔名（擋目錄穿越）。"""
    if folder not in LORA_FOLDERS or not fn or "/" in fn or "\\" in fn or ".." in fn:
        return None
    p = LORA_ROOT / folder / fn
    return p if p.is_file() else None


# ---------------------------------------------------------------------------
# 前端靜態檔（html/css/js，跟主面板一樣分開，不再內嵌字串）。preview_ui.py 本身現在
# 就住在 darkroom/ 裡（2026-08 整理專案結構時跟前端檔案併到同一層），DARKROOM_DIR
# 直接是自己的目錄，不再是子資料夾。
DARKROOM_DIR = Path(__file__).resolve().parent
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/darkroom.css": ("darkroom.css", "text/css; charset=utf-8"),
    "/darkroom.js": ("darkroom.js", "application/javascript; charset=utf-8"),
    # 打標已併進同一頁（瀏覽/打標用頂列模式切換）。舊網址 /tag 保留：回同一個
    # index.html，前端依 location.pathname === '/tag' 自動進打標模式。
    "/tag": ("index.html", "text/html; charset=utf-8"),
}

# ---------------------------------------------------------------------------
# 全域狀態
# ---------------------------------------------------------------------------
STATE = {
    "workflow_path": None,
    "template": None,
    "comfy_base": None,
    "steps": 25,
    "timeout": 600,
    "jobs": {},                     # rel(str) -> {status, message, updated}
    "jobs_lock": threading.Lock(),
    "concurrency": 2,               # 一次最多同時跑幾張
    "gen_sem": threading.Semaphore(2),  # 全域併發上限(單張+批次共用)
    "batch": {                      # 批次狀態
        "running": False,
        "stop": False,
        "total": 0,
        "done": 0,
        "ok": 0,
        "fail": 0,
        "running_rels": [],         # 目前正在跑的項目(可能同時多個)
    },
    "batch_lock": threading.Lock(),
}


# 生成後存檔的副檔名(改用 webp);辨識時舊 png 也接受
OUT_EXT = ".webp"
IMG_EXTS = (".webp", ".png")

# 參考工作流:ANIMESTYLE (1).json(WAS Image Save → webp, cfg6.5/euler_ancestral)
NEW_WORKFLOW = Path(r"C:\Users\boshe\Downloads\ANIMESTYLE (1).json")


def find_image(py: Path) -> Path | None:
    """回傳該詞庫既有的預覽圖(webp 優先,其次 png),沒有則 None。"""
    for ext in IMG_EXTS:
        p = py.with_suffix(ext)
        if p.is_file():
            return p
    return None


# --- 稀有度：以檔名前綴標註(無分隔)。傳奇 > 特別 > 稀有 ----------------------
# 前綴放最前面,例如「傳奇版我是白癡.py」。稀有度純由檔名衍生,不另存 JSON;
# 打標網頁的工作就是改檔名來加/換/移除這個前綴。
RARITY_TOKENS = (("legendary", "傳奇版"), ("special", "特別版"),
                 ("rare", "稀有版"), ("common", "普通版"))


def rarity_of(stem: str) -> tuple[str, str]:
    """回傳 (key, token)。沒有前綴則 ("", "")。"""
    for key, tok in RARITY_TOKENS:
        if stem.startswith(tok):
            return key, tok
    return "", ""


def strip_rarity(stem: str) -> str:
    """去掉稀有度前綴,回傳原本的名字。"""
    _, tok = rarity_of(stem)
    return stem[len(tok):] if tok else stem


# --- 縮圖快取 -------------------------------------------------------------
THUMB_MAX = 360           # 縮圖最長邊(px);格子 ~180px @2x DPR 剛好
THUMB_QUALITY = 72
THUMB_DIR = Path(__file__).resolve().parent / ".thumb_cache"
_thumb_locks: dict[str, threading.Lock] = {}
_thumb_locks_guard = threading.Lock()
# 併發上限:伺服器是多執行緒,瀏覽時瀏覽器會同時要一堆縮圖,若每個都馬上用 PIL
# 縮放(LANCZOS+webp 編碼)會把所有 CPU 核心塞滿(實測 CPU 一直 55%+/溫度飆高)。
# 用 semaphore 把「同時現場生成」的張數壓到 2,快取命中的不受限、照樣快。
_thumb_gen_sem = threading.Semaphore(2)


def _thumb_lock(key: str) -> threading.Lock:
    with _thumb_locks_guard:
        lk = _thumb_locks.get(key)
        if lk is None:
            lk = _thumb_locks[key] = threading.Lock()
        return lk


def make_thumb(src: Path) -> tuple[bytes, str]:
    """回傳 (webp bytes, etag)。磁碟快取,靠來源 mtime+size 失效。

    Pillow 不可用時,退回原圖(較大但仍可顯示)。
    """
    st = src.stat()
    sig = f"{src}|{int(st.st_mtime)}|{st.st_size}|{THUMB_MAX}"
    etag = hashlib.sha1(sig.encode("utf-8")).hexdigest()

    if not _HAS_PIL:
        return src.read_bytes(), '"' + etag + '"'

    THUMB_DIR.mkdir(exist_ok=True)
    cache_file = THUMB_DIR / f"{etag}.webp"
    if cache_file.is_file():
        return cache_file.read_bytes(), '"' + etag + '"'

    with _thumb_lock(etag):
        if cache_file.is_file():  # 可能剛被別的執行緒建好
            return cache_file.read_bytes(), '"' + etag + '"'
        # 只有「真的要現場生成」才佔用併發額度;快取命中在上面就回了、不進這裡。
        # method=1 比預設 4 快很多、檔案只大一點點(縮圖不在意)。
        with _thumb_gen_sem:
            t0 = time.time()
            plog(f"[thumb] Pillow 縮圖 {src.parent.name}/{src.name}")
            with Image.open(src) as im:
                im = im.convert("RGB")
                im.thumbnail((THUMB_MAX, THUMB_MAX), Image.LANCZOS)
                buf = io.BytesIO()
                im.save(buf, format="WEBP", quality=THUMB_QUALITY, method=1)
            data = buf.getvalue()
            plog(f"[thumb] 完成 {src.parent.name}/{src.name}  {time.time()-t0:.2f}s  {len(data)//1024}KB")
        # data 已在上面取得
        try:
            cache_file.write_bytes(data)
        except OSError:
            pass
        return data, '"' + etag + '"'


def get_tailscale_ip() -> str | None:
    """回傳本機 Tailscale IPv4(100.64.0.0/10),找不到則 None。"""
    exes = [
        "tailscale",
        r"C:\Program Files\Tailscale\tailscale.exe",
        r"C:\Program Files (x86)\Tailscale\tailscale.exe",
    ]
    for exe in exes:
        try:
            r = subprocess.run(
                [exe, "ip", "-4"], capture_output=True, text=True, timeout=5
            )
            for line in (r.stdout or "").splitlines():
                ip = line.strip()
                if _is_tailscale_ip(ip):
                    return ip
        except Exception:
            continue
    # 後備:掃本機介面上的位址
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            ip = info[4][0]
            if _is_tailscale_ip(ip):
                return ip
    except Exception:
        pass
    return None


def _is_tailscale_ip(ip: str) -> bool:
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        a, b = int(parts[0]), int(parts[1])
    except ValueError:
        return False
    return a == 100 and 64 <= b <= 127


def rel_of(py: Path) -> str:
    return str(py.relative_to(SPECIAL_DIR)).replace("\\", "/")


def py_of(rel: str) -> Path:
    base = SPECIAL_DIR.resolve()
    p = (base / rel).resolve()
    if p != base and base not in p.parents:
        raise ValueError("path outside special_prompts")
    return p


def set_job(rel: str, status: str, message: str = ""):
    with STATE["jobs_lock"]:
        STATE["jobs"][rel] = {
            "status": status,
            "message": message,
            "updated": time.time(),
        }


def get_job(rel: str) -> dict:
    with STATE["jobs_lock"]:
        return dict(STATE["jobs"].get(rel) or {})


# --- 詞庫清單快取 ---------------------------------------------------------
# 掃描一次要走完整棵樹（實測 12569 個 .py：rglob 0.45s + 每筆探 .webp/.png 約
# 25000 次 stat 0.47s），而 /api/libs 是開頁與重掃的唯一阻塞點——TTFB 1.1s 全
# 花在這裡，畫面在那之前是空的。所以把「檔案系統那一半」快取起來：
#   * 首次請求同步掃，之後直接回快取；
#   * 超過 SCAN_TTL 只在背景重掃（stale-while-revalidate），請求永遠不等；
#   * 生成成功時就地更新那一筆（唯一由本程式造成的變動，不必整棵重掃）；
#   * 「重掃」鈕帶 force=1 同步重掃，使用者要的就是即時反映外部改動。
# job 狀態不進快取——它會變，每次回應時才疊上去（純記憶體查表，成本可忽略）。
SCAN_TTL = 60.0
_scan = {"items": None, "at": 0.0, "refreshing": False}
_scan_lock = threading.Lock()


def _scan_fs() -> list[dict]:
    """實際走檔案系統，回傳不含 job 的項目清單。"""
    t0 = time.time()
    items = []
    for py in gsp.iter_libraries(None):
        img = find_image(py)
        stem = py.stem
        rk, _tok = rarity_of(stem)
        items.append({
            "rel": rel_of(py),
            "name": stem,                       # 完整檔名(含稀有度前綴)
            "display_name": strip_rarity(stem), # 去前綴的顯示名
            "rarity": rk,                        # "" / rare / special / legendary
            "folder": py.parent.name if py.parent != SPECIAL_DIR else "",
            "has_image": img is not None,
            "image_mtime": int(img.stat().st_mtime) if img else 0,
        })
    plog(f"[scan] 掃描詞庫 {len(items)} 筆 · {time.time() - t0:.2f}s")
    return items


def _scan_refresh_bg():
    def work():
        try:
            items = _scan_fs()
            with _scan_lock:
                _scan["items"] = items
                _scan["at"] = time.time()
        finally:
            with _scan_lock:
                _scan["refreshing"] = False
    threading.Thread(target=work, daemon=True).start()


def scan_libraries(force: bool = False) -> list[dict]:
    with _scan_lock:
        cached = _scan["items"]
        stale = (time.time() - _scan["at"]) > SCAN_TTL
        if cached is not None and not force:
            # 過期就在背景重掃，這次仍回舊的（同一時間只排一個背景掃描）
            if stale and not _scan["refreshing"]:
                _scan["refreshing"] = True
                need_bg = True
            else:
                need_bg = False
        else:
            need_bg = False
    if cached is not None and not force:
        if need_bg:
            _scan_refresh_bg()
    else:
        cached = _scan_fs()
        with _scan_lock:
            _scan["items"] = cached
            _scan["at"] = time.time()
    # 疊上會變、不進快取的部分：job 狀態、品質旗標、收藏、稀有度。稀有度以側檔為準，
    # 側檔沒有該筆才用 _scan_fs 由檔名衍生的值（舊前綴檔自動沿用）；側檔存 "" 代表
    # 明確清除，會蓋掉檔名衍生值。
    with STATE["jobs_lock"]:
        jobs = dict(STATE["jobs"])
    fl = flagged_set()
    fv = fav_set()
    rmap = rarity_map()
    return [
        dict(it,
             job=dict(jobs.get(it["rel"]) or {}),
             flagged=(it["rel"] in fl),
             favorited=(it["rel"] in fv),
             rarity=(rmap[it["rel"]] if it["rel"] in rmap else it["rarity"]))
        for it in cached
    ]


def _scan_note_image(rel: str, img: Path):
    """生成成功後就地更新快取裡那一筆，免得為了一張圖重掃整棵樹。"""
    with _scan_lock:
        if _scan["items"] is None:
            return
        for it in _scan["items"]:
            if it["rel"] == rel:
                it["has_image"] = True
                try:
                    it["image_mtime"] = int(img.stat().st_mtime)
                except OSError:
                    pass
                return


def get_batch() -> dict:
    with STATE["batch_lock"]:
        return dict(STATE["batch"])


def set_batch(**kwargs):
    with STATE["batch_lock"]:
        STATE["batch"].update(kwargs)


def do_batch(rels: list[str]):
    with STATE["batch_lock"]:
        STATE["batch"].update(
            running=True, stop=False, total=len(rels),
            done=0, ok=0, fail=0, running_rels=[],
        )
    total = len(rels)
    plog(f"[batch] 開始 · 共 {total} 張 · 併發 {STATE['concurrency']}")
    idx = {"i": 0}
    idx_lock = threading.Lock()

    def worker():
        while True:
            if get_batch().get("stop"):
                return
            with idx_lock:
                if idx["i"] >= len(rels):
                    return
                rel = rels[idx["i"]]
                idx["i"] += 1
            with STATE["batch_lock"]:
                STATE["batch"]["running_rels"].append(rel)
            try:
                do_generate(rel, in_batch=True)
            finally:
                job = get_job(rel)
                with STATE["batch_lock"]:
                    rr = STATE["batch"]["running_rels"]
                    if rel in rr:
                        rr.remove(rel)
                    STATE["batch"]["done"] += 1
                    if job.get("status") == "done":
                        STATE["batch"]["ok"] += 1
                    else:
                        STATE["batch"]["fail"] += 1
                    done, ok, fail = STATE["batch"]["done"], STATE["batch"]["ok"], STATE["batch"]["fail"]
                tag = "OK " if job.get("status") == "done" else "ERR"
                plog(f"[batch] {done}/{total} ok={ok} fail={fail} · {tag} {rel} · {job.get('message', '')}")

    n = max(1, int(STATE["concurrency"]))
    threads = [threading.Thread(target=worker, daemon=True) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    b = get_batch()
    set_batch(running=False, running_rels=[])
    stopped = b.get("stop")
    plog(f"[batch] {'已停止' if stopped else '完成'} · {b.get('done')}/{total} · ok {b.get('ok')} · fail {b.get('fail')}")


def do_generate(rel: str, seed: int | None = None, in_batch: bool = False):
    if not STATE["comfy_base"]:
        set_job(rel, "error", "ComfyUI 未連線")
        if not in_batch:
            plog(f"[gen] ERR {rel} — ComfyUI 未連線")
        return
    with STATE["gen_sem"]:
        try:
            plog(f"[gen] ▶ 生成中 {rel}")   # 即時顯示現在在處理哪個詞庫
            set_job(rel, "running", "載入詞庫...")
            py = py_of(rel)
            req, pos, neg = load_lib(py)
            positive = build_prompt(req, pos)
            negative = build_negative(neg)
            if seed is None or seed < 0:
                seed = random.randint(0, 2**63 - 1)

            set_job(rel, "running", "組工作流...")
            safe_prefix = f"special/{py.parent.name}/{py.stem}"[:180]
            wf = prepare_workflow(
                STATE["template"],
                positive=positive,
                negative=negative,
                seed=seed,
                filename_prefix=safe_prefix,
                steps=STATE["steps"],
            )

            set_job(rel, "running", "已送入 ComfyUI,等待完成...")
            t0 = time.time()
            images = queue_and_wait(STATE["comfy_base"], wf, timeout=STATE["timeout"])
            img_bytes = download_image(STATE["comfy_base"], images[0])
            out_img = py.with_suffix(OUT_EXT)
            out_img.write_bytes(img_bytes)
            # 清掉同名舊 png,避免 webp/png 並存
            old_png = py.with_suffix(".png")
            if OUT_EXT != ".png" and old_png.is_file():
                try:
                    old_png.unlink()
                except OSError:
                    pass
            _scan_note_image(rel, out_img)
            dt = time.time() - t0
            set_job(
                rel,
                "done",
                f"完成 · {dt:.1f}s · {len(img_bytes)//1024}KB · seed={seed}",
            )
            if not in_batch:   # 批次的每張進度由 do_batch 統一印，避免重複
                plog(f"[gen] OK  {rel}  {dt:.1f}s  {len(img_bytes)//1024}KB  seed={seed}")
        except Exception as e:
            set_job(rel, "error", f"{type(e).__name__}: {e}")
            plog(f"[gen] ERR {rel}  {type(e).__name__}: {e}")


# ---------------------------------------------------------------------------
# 「生圖」模式：選詞庫 + LoRA → 注入 LoraLoader 生成，結果只放前端結果區、
# 不覆蓋詞庫的預覽圖（存在記憶體 _gen_results，供 /api/gen-result 取用）。
# ---------------------------------------------------------------------------
def inject_lora(wf: dict, lora_name: str, strength: float):
    """在工作流插入一個 LoraLoader：把原本吃 checkpoint model([_,0])/clip([_,1]) 的節點
    改接到它（VAE([_,2]) 不動）。lora_name 用 ComfyUI 認得的 '<folder>\\<file>'。"""
    ckpt = None
    for nid, n in wf.items():
        if isinstance(n, dict) and n.get("class_type") == "CheckpointLoaderSimple":
            ckpt = str(nid); break
    if ckpt is None:
        return
    lid = "200"
    while lid in wf:
        lid = str(int(lid) + 1)
    wf[lid] = {"class_type": "LoraLoader", "inputs": {
        "lora_name": lora_name, "strength_model": float(strength), "strength_clip": float(strength),
        "model": [ckpt, 0], "clip": [ckpt, 1]}}
    for nid, n in wf.items():
        if nid == lid or not isinstance(n, dict):
            continue
        for k, v in (n.get("inputs") or {}).items():
            if isinstance(v, list) and len(v) == 2 and str(v[0]) == ckpt:
                if v[1] == 0:
                    n["inputs"][k] = [lid, 0]
                elif v[1] == 1:
                    n["inputs"][k] = [lid, 1]


_gen_results = {}      # gid -> {"bytes", "ctype"}
_gen_preview = {}      # gid -> {"bytes", "ctype"}（採樣中的即時預覽，生完即清）
_gen_status = {}       # gid -> {"status", "rel", "name", "err", "seed", "pv"}
_gen_lock = threading.Lock()
_GEN_MAX = 240         # 結果快取上限，超過砍最舊

# ---------------------------------------------------------------------------
# 2026-08 lora-manager 整合：LoRA Manager（standalone、獨立埠，見 ../lora-manager/）
# 點「送到 workflow」時，因為 standalone 模式本來就連不到真正的 ComfyUI 網頁（那條路
# 是靠同源 LiteGraph 即時改節點，見 lora-manager/VENDORED.md），改成直接 POST 這裡，
# 暗房前端輪詢偵測到新版本就自動選進生圖大面板。單一 slot（不排隊、後到蓋掉先到）——
# 這是「推進目前開著的分頁」的單次動作，不是佇列。
_lora_push = {"ver": 0, "data": None}   # {"ver": int, "data": {"folder","name"}|None}
_lora_push_lock = threading.Lock()


class _WSHandshakeError(Exception):
    """WS 握手失敗——呼叫端可據此退化成純 HTTP 輪詢（無即時預覽）。"""


class _GenCancelled(Exception):
    """生圖被取消（該分頁自己刷新/關閉）——中止採樣、不取結果。"""


def _ws_send(sock, opcode, payload: bytes):
    """送一個 client→server WS frame（規範要求 client frame 一律 masked）。"""
    import struct
    header = bytearray([0x80 | opcode])
    mask = os.urandom(4)
    ln = len(payload)
    if ln < 126:
        header.append(0x80 | ln)
    elif ln < 65536:
        header.append(0x80 | 126); header += struct.pack(">H", ln)
    else:
        header.append(0x80 | 127); header += struct.pack(">Q", ln)
    header += mask
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(bytes(header) + masked)


def _comfy_ws_generate(base: str, wf: dict, timeout: float, on_preview,
                       should_cancel=None, on_prompt_id=None):
    """開 WebSocket 連 ComfyUI、以同一 client_id POST /prompt，邊收採樣預覽邊回呼
    on_preview(bytes, ctype)，執行完成後用 /history 取輸出圖 info 回傳。純標準庫實作的
    最小 WS client（握手＋讀 frame）。握手失敗拋 _WSHandshakeError 讓呼叫端退化。

    ComfyUI 的二進位 preview frame 格式：前 4 bytes 大端＝事件型別（1=PREVIEW_IMAGE）、
    次 4 bytes＝影像格式（1=JPEG、2=PNG），其後為影像位元組。"""
    import struct
    u = urllib.parse.urlparse(base)
    host = u.hostname or "127.0.0.1"
    port = u.port or (443 if u.scheme == "https" else 80)
    client_id = uuid.uuid4().hex
    # --- 握手 ---
    try:
        sock = socket.create_connection((host, port), timeout=15)
        sock.settimeout(max(60.0, float(timeout)))
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET /ws?clientId={client_id} HTTP/1.1\r\nHost: {host}:{port}\r\n"
               "Upgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise _WSHandshakeError("握手時連線中斷")
            buf += chunk
            if len(buf) > 65536:
                raise _WSHandshakeError("握手回應過長")
        head, _, rest = buf.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise _WSHandshakeError("非 101：" + head.split(b"\r\n", 1)[0].decode("latin1", "replace"))
    except _WSHandshakeError:
        raise
    except Exception as e:
        raise _WSHandshakeError(f"{type(e).__name__}: {e}")

    inbuf = bytearray(rest)

    def _need(n):
        while len(inbuf) < n:
            chunk = sock.recv(65536)
            if not chunk:
                raise ConnectionError("WS 連線關閉")
            inbuf.extend(chunk)

    def read_frame():
        _need(2)
        b0, b1 = inbuf[0], inbuf[1]; del inbuf[:2]
        opcode = b0 & 0x0f
        masked = b1 & 0x80; ln = b1 & 0x7f
        if ln == 126:
            _need(2); ln = struct.unpack(">H", inbuf[:2])[0]; del inbuf[:2]
        elif ln == 127:
            _need(8); ln = struct.unpack(">Q", inbuf[:8])[0]; del inbuf[:8]
        mask = b""
        if masked:
            _need(4); mask = bytes(inbuf[:4]); del inbuf[:4]
        _need(ln); payload = bytes(inbuf[:ln]); del inbuf[:ln]
        if masked:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return opcode, payload

    # --- 握手成功後才 POST（確保 client 已註冊，收得到自己這次的預覽）---
    result = http_json("POST", f"{base}/prompt", {"prompt": wf, "client_id": client_id}, timeout=60)
    if not result or "prompt_id" not in result:
        try: sock.close()
        except Exception: pass
        raise RuntimeError(f"queue 失敗：{result}")
    prompt_id = result["prompt_id"]
    if on_prompt_id:
        on_prompt_id(prompt_id)     # 交給呼叫端記錄，取消時才能請 ComfyUI 移除/中斷這個 prompt

    cancelled = False
    try:
        while True:
            if should_cancel and should_cancel():
                cancelled = True; break     # 頻繁收到採樣 frame，每收一張就能檢查一次
            opcode, payload = read_frame()
            if opcode == 0x8:            # close
                break
            if opcode == 0x9:            # ping → pong
                _ws_send(sock, 0xA, payload); continue
            if opcode == 0x2:            # binary → 可能是預覽
                if len(payload) >= 8 and payload[0:4] == b"\x00\x00\x00\x01":
                    fmt = struct.unpack(">I", payload[4:8])[0]
                    on_preview(payload[8:], "image/jpeg" if fmt == 1 else "image/png")
                continue
            if opcode == 0x1:            # text json
                try:
                    msg = json.loads(payload.decode("utf-8"))
                except Exception:
                    continue
                t = msg.get("type"); d = msg.get("data") or {}
                if t == "executing" and d.get("node") is None and d.get("prompt_id") == prompt_id:
                    break                # 本次全部節點執行完
                if t == "execution_error" and d.get("prompt_id") == prompt_id:
                    raise RuntimeError("ComfyUI 執行錯誤：" + str(d.get("exception_message") or d.get("node_type") or d))
    except (ConnectionError, socket.timeout) as e:
        plog(f"[genmode] WS 中斷改用 history 取圖：{type(e).__name__}")   # 生成仍在 ComfyUI 跑，退化取結果
    finally:
        try: sock.close()
        except Exception: pass

    if cancelled:
        raise _GenCancelled()

    # --- 取輸出圖（executing-done 後 history 可能略慢，短重試）---
    for _ in range(8):
        hist = http_json("GET", f"{base}/history/{prompt_id}", timeout=15)
        if hist and prompt_id in hist:
            outputs = hist[prompt_id].get("outputs") or {}
            images = []
            for node_id in sorted(outputs.keys(), key=lambda x: int(x) if str(x).isdigit() else 0):
                for img in outputs[node_id].get("images") or []:
                    if img.get("type") == "temp":
                        continue
                    images.append(img)
            if images:
                return images
        time.sleep(1.0)
    raise RuntimeError("執行完成但取不到輸出圖")


def _gen_cancelled(gid):
    with _gen_lock:
        return bool(_gen_status.get(gid, {}).get("cancel"))


def _gen_one_worker(gid, rel, lora_name, strength, trigger):
    with STATE["gen_sem"]:
        # 排在信號量後面等的那幾張，若在等待期間被取消（該分頁刷新/關閉）就別再送出去
        if _gen_cancelled(gid):
            with _gen_lock:
                if _gen_status.get(gid, {}).get("status") == "pending":
                    _gen_status[gid].update(status="cancelled")
            plog(f"[genmode] 略過（已取消）{rel}")
            return
        try:
            if not STATE["comfy_base"]:
                raise RuntimeError("ComfyUI 未連線")
            py = py_of(rel)
            req, pos, neg = load_lib(py)
            positive = build_prompt(req, pos)
            if trigger:
                positive = (positive + ", " + trigger) if positive else trigger
            negative = build_negative(neg)
            seed = random.randint(0, 2**63 - 1)
            wf = prepare_workflow(STATE["template"], positive=positive, negative=negative,
                                  seed=seed, filename_prefix=f"genmode/{py.stem}"[:180],
                                  steps=STATE["steps"])
            if lora_name:
                inject_lora(wf, lora_name, strength)

            def on_prev(b, ct):
                with _gen_lock:
                    _gen_preview[gid] = {"bytes": b, "ctype": ct}
                    if gid in _gen_status:
                        _gen_status[gid]["pv"] = _gen_status[gid].get("pv", 0) + 1

            def on_pid(pid):
                with _gen_lock:
                    if gid in _gen_status:
                        _gen_status[gid]["pid"] = pid

            base = STATE["comfy_base"]
            try:
                images = _comfy_ws_generate(base, wf, STATE["timeout"], on_prev,
                                            should_cancel=lambda: _gen_cancelled(gid),
                                            on_prompt_id=on_pid)
            except _WSHandshakeError as e:
                plog(f"[genmode] 無即時預覽（WS 握手失敗：{e}），改純輪詢")
                images = queue_and_wait(base, wf, timeout=STATE["timeout"])
            data = download_image(base, images[0])
            with _gen_lock:
                _gen_results[gid] = {"bytes": data, "ctype": "image/webp"}
                _gen_preview.pop(gid, None)
                # seed 以字串回傳：seed 可達 2^63，超過 JS Number.MAX_SAFE_INTEGER（2^53），
                # 用數字會在前端 JSON.parse 掉精度（末幾位變 0），資訊面板顯示的 seed 會失真。
                _gen_status[gid].update(status="done", seed=str(seed))
                while len(_gen_results) > _GEN_MAX:
                    old = next(iter(_gen_results))
                    _gen_results.pop(old, None)
                    _gen_preview.pop(old, None)
            plog(f"[genmode] OK {rel} seed={seed}")
        except _GenCancelled:
            with _gen_lock:
                _gen_preview.pop(gid, None)
                if gid in _gen_status and _gen_status[gid].get("status") != "done":
                    _gen_status[gid].update(status="cancelled")
            plog(f"[genmode] 取消 {rel}")
        except Exception as e:
            with _gen_lock:
                _gen_preview.pop(gid, None)
                if gid in _gen_status:
                    _gen_status[gid].update(status="error", err=f"{type(e).__name__}: {e}")
            plog(f"[genmode] ERR {rel} {type(e).__name__}: {e}")


def start_gen(rels, lora_name, strength, trigger, client=""):
    """為每個 rel 起背景生成，回傳 [{id, rel, name}]（gen_sem 限併發）。client 記錄是哪個
    分頁送的，供該分頁刷新/關閉時只取消自己這批（見 cancel_client_gen）。"""
    out = []
    for rel in rels:
        gid = os.urandom(6).hex()
        try:
            name = strip_rarity(py_of(rel).stem)
        except Exception:
            name = rel
        with _gen_lock:
            _gen_status[gid] = {"status": "pending", "rel": rel, "name": name, "err": "",
                                "pv": 0, "cancel": False, "pid": "", "client": client}
        out.append({"id": gid, "rel": rel, "name": name})
        threading.Thread(target=_gen_one_worker,
                         args=(gid, rel, lora_name, strength, trigger), daemon=True).start()
    return out


def cancel_client_gen(client):
    """只取消某個分頁（client）自己還在途的生圖。等信號量的那幾張標記 cancel 就不會送出；
    已排進 ComfyUI 的請 ComfyUI 移除排隊中的、並中斷正在跑的——只針對這個 client 自己的
    gen prompt_id，不動別的分頁、也不誤傷同時在跑的批次預覽生成。client 空字串則不做任何事。"""
    if not client:
        return 0
    pids = []
    with _gen_lock:
        for gid, s in _gen_status.items():
            if s.get("status") == "pending" and s.get("client") == client:
                s["cancel"] = True
                if s.get("pid"):
                    pids.append(s["pid"])
    base = STATE.get("comfy_base")
    if base and pids:
        try:
            q = http_json("GET", f"{base}/queue", timeout=10) or {}
            running = {it[1] for it in (q.get("queue_running") or []) if isinstance(it, list) and len(it) > 1}
            http_json("POST", f"{base}/queue", {"delete": pids}, timeout=10)   # 移除還在排隊的（ComfyUI 忽略不存在的）
            if running & set(pids):
                http_json("POST", f"{base}/interrupt", {}, timeout=10)         # 正在跑的是這個 client 的才中斷
        except Exception as e:
            plog(f"[genmode] 取消時通知 ComfyUI 失敗：{e}")
    plog(f"[genmode] 取消分頁 {client[:8]} 的在途生圖（{len(pids)} 筆已在 ComfyUI）")
    return len(pids)


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    # HTTP/1.1 → 開 keep-alive：瀏覽器重用連線，不再每張縮圖/圖片都重開 TCP 握手。
    # 這是跟 Jellyfin/Stash 載入順暢度最大的差別（它們是 keep-alive/HTTP2）。所有回應
    # 都有 Content-Length（304 無 body），符合 keep-alive 的前提。
    protocol_version = "HTTP/1.1"
    timeout = 30          # 閒置的 keep-alive 連線 30s 後關掉，不長期佔著執行緒

    def log_message(self, format, *args):
        pass

    # 文字類回應壓縮：/api/libs 是 2.2MB 的 JSON，gzip 後只剩 9%（實測 0.19MB，
    # 壓縮成本 12ms）。對手機走 Tailscale 連是數量級差異。圖片已經是壓縮格式，
    # 不走這裡（_send_cacheable 不壓）。小回應壓了反而虧，設下限。
    GZIP_MIN = 1400

    def _gzip_ok(self, body: bytes, content_type: str) -> bool:
        if len(body) < self.GZIP_MIN:
            return False
        if not any(t in content_type for t in ("json", "text/", "javascript")):
            return False
        return "gzip" in (self.headers.get("Accept-Encoding") or "")

    def _write_body(self, body: bytes, content_type: str, code: int, extra: dict | None = None):
        gz = self._gzip_ok(body, content_type)
        if gz:
            body = gzip.compress(body, 5)
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, obj, code: int = 200, extra: dict | None = None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        headers = {"Cache-Control": "no-store"}
        if extra:
            headers.update(extra)
        self._write_body(body, "application/json; charset=utf-8", code, headers)

    def _send_bytes(self, body: bytes, content_type: str = "application/octet-stream", code: int = 200):
        self._write_body(body, content_type, code, {"Cache-Control": "no-store"})

    def _send_cacheable(self, body: bytes, content_type: str, etag: str, max_age: int = 604800):
        """帶 ETag + max-age;若 If-None-Match 命中則回 304(不重送 body)。"""
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", f"private, max-age={max_age}")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", f"private, max-age={max_age}")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        try:
            if u.path in STATIC_FILES:
                fname, ctype = STATIC_FILES[u.path]
                try:
                    self._send_bytes((DARKROOM_DIR / fname).read_bytes(), ctype)
                except OSError:
                    self._send_bytes(b"darkroom asset missing", "text/plain", 404)
                return
            if u.path == "/api/libs":
                self._send_json({
                    "items": scan_libraries(force=qs.get("force", [""])[0] == "1"),
                    "workflow": str(STATE["workflow_path"]),
                    "comfy": STATE["comfy_base"],
                    "steps": STATE["steps"],
                    "special_dir": str(SPECIAL_DIR),
                })
                return
            if u.path == "/api/thumb":
                rel = qs.get("rel", [""])[0]
                img = find_image(py_of(rel))
                if img is None:
                    self._send_bytes(b"not found", "text/plain", 404)
                    return
                data, etag = make_thumb(img)
                ct = "image/webp" if _HAS_PIL else (
                    "image/webp" if img.suffix.lower() == ".webp" else "image/png")
                self._send_cacheable(data, ct, etag)
                return
            if u.path == "/api/image":
                rel = qs.get("rel", [""])[0]
                img = find_image(py_of(rel))
                if img is None:
                    self._send_bytes(b"not found", "text/plain", 404)
                    return
                ct = "image/webp" if img.suffix.lower() == ".webp" else "image/png"
                st = img.stat()
                etag = '"' + hashlib.sha1(
                    f"{img}|{int(st.st_mtime)}|{st.st_size}".encode("utf-8")
                ).hexdigest() + '"'
                self._send_cacheable(img.read_bytes(), ct, etag)
                return
            if u.path == "/api/prompt":
                rel = qs.get("rel", [""])[0]
                py = py_of(rel)
                req, pos, neg = load_lib(py)
                self._send_json({
                    "positive": build_prompt(req, pos),
                    "negative": build_negative(neg),
                    "required": req,
                    "positive_list": pos,
                    "negative_list": neg,
                })
                return
            if u.path == "/api/status":
                self._send_json(get_job(qs.get("rel", [""])[0]))
                return
            if u.path == "/api/batch_status":
                self._send_json(get_batch())
                return
            if u.path == "/api/loras":
                self._send_json(list_loras())
                return
            if u.path == "/api/lora-preview":
                p = lora_preview_path(qs.get("folder", [""])[0], qs.get("file", [""])[0])
                if p is None:
                    self._send_bytes(b"not found", "text/plain", 404)
                    return
                ctype = mimetypes.guess_type(str(p))[0] or "image/png"
                st = p.stat()
                etag = hashlib.sha1(f"{p}|{int(st.st_mtime)}|{st.st_size}".encode("utf-8")).hexdigest()
                self._send_cacheable(p.read_bytes(), ctype, etag)
                return
            if u.path == "/api/gen-status":
                ids = [x for x in (qs.get("ids", [""])[0]).split(",") if x]
                skip = {"rel", "pid", "cancel", "client"}   # 內部欄位不外送
                with _gen_lock:
                    out = {gid: {k: v for k, v in _gen_status[gid].items() if k not in skip}
                           for gid in ids if gid in _gen_status}
                self._send_json(out)
                return
            if u.path == "/api/gen-result":
                gid = qs.get("id", [""])[0]
                with _gen_lock:
                    r = _gen_results.get(gid)
                if not r:
                    self._send_bytes(b"not ready", "text/plain", 404)
                    return
                self._send_cacheable(r["bytes"], r["ctype"], gid)
                return
            if u.path == "/api/gen-preview":
                # 採樣中的即時預覽（ComfyUI 經 WS 送的中途影像）。前端靠 gen-status 的 pv
                # 遞增才來抓，抓不到（尚無預覽/已生完清掉）就 404。附 pv 進 etag 避免快取。
                gid = qs.get("id", [""])[0]
                with _gen_lock:
                    p = _gen_preview.get(gid)
                    pv = _gen_status.get(gid, {}).get("pv", 0)
                if not p:
                    self._send_bytes(b"no preview", "text/plain", 404)
                    return
                self._send_cacheable(p["bytes"], p["ctype"], f"{gid}:{pv}")
                return
            if u.path == "/api/lora-push":
                # 前端每 ~1s 輪詢一次；帶 since 才回新資料，版本沒變就只回 ver（省流量）。
                since = int(qs.get("since", ["0"])[0] or 0)
                with _lora_push_lock:
                    ver, data = _lora_push["ver"], _lora_push["data"]
                out = {"ver": ver}
                if ver > since:
                    out["data"] = data
                self._send_json(out)
                return
            self._send_bytes(b"not found", "text/plain", 404)
        except Exception as e:
            self._send_json({"error": f"{type(e).__name__}: {e}"}, 500)

    def do_OPTIONS(self):
        # 只有 lora-push 需要跨源（LoRA Manager 站在自己的 port 7861，POST 這裡）。
        # application/json 的 POST 會先觸發瀏覽器的 CORS 預檢，這裡答覆放行。
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/lora-push":
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            data = {}
        try:
            if u.path == "/api/flag":
                rel = data.get("rel") or ""
                try:
                    py = py_of(rel)
                except Exception:
                    self._send_json({"error": "路徑不合法"}, 400)
                    return
                if not py.is_file():
                    self._send_json({"error": "詞庫不存在"}, 404)
                    return
                now = set_flag(rel, bool(data.get("flagged")))
                plog(f"[flag] {'標記不優質' if now else '取消標記'} {rel}")
                self._send_json({"ok": True, "rel": rel, "flagged": now})
                return
            if u.path == "/api/favorite":
                rel = data.get("rel") or ""
                try:
                    py = py_of(rel)
                except Exception:
                    self._send_json({"error": "路徑不合法"}, 400)
                    return
                if not py.is_file():
                    self._send_json({"error": "詞庫不存在"}, 404)
                    return
                now = set_fav(rel, bool(data.get("favorited")))
                plog(f"[fav] {'收藏' if now else '取消收藏'} {rel}")
                self._send_json({"ok": True, "rel": rel, "favorited": now})
                return
            if u.path == "/api/rarity":
                # 稀有度存側檔（不改檔名）。rarity ∈ common/rare/special/legendary 設定，
                # ""（或省略）清除。即時反映（scan 回應時疊加），不必重掃。
                rel = data.get("rel") or ""
                key = data.get("rarity", "") or ""
                if key and key not in RARITY_KEYS:
                    self._send_json({"error": "未知稀有度"}, 400)
                    return
                try:
                    py = py_of(rel)
                except Exception:
                    self._send_json({"error": "路徑不合法"}, 400)
                    return
                if not py.is_file():
                    self._send_json({"error": "詞庫不存在"}, 404)
                    return
                now = set_rarity(rel, key, bool(rarity_of(py.stem)[0]))
                plog(f"[rarity] {rel} → {now or '(清除)'}")
                self._send_json({"ok": True, "rel": rel, "rarity": now})
                return
            if u.path == "/api/steps":
                try:
                    s = max(1, min(150, int(data.get("steps"))))
                except Exception:
                    self._send_json({"error": "steps 需為整數"}, 400)
                    return
                STATE["steps"] = s
                plog(f"[steps] 生成步數設為 {s}")
                self._send_json({"ok": True, "steps": s})
                return
            if u.path == "/api/gen":
                # 生圖模式：對選中的詞庫套 LoRA 背景生成，結果進 _gen_results（不覆蓋詞庫預覽）。
                rels = data.get("rels") or []
                if not isinstance(rels, list) or not rels:
                    self._send_json({"error": "沒有選取詞庫"}, 400)
                    return
                lora = data.get("lora") or {}
                lname = ""
                if lora.get("file"):
                    lname = (lora["folder"] + "\\" + lora["file"]) if lora.get("folder") else lora["file"]
                try:
                    strength = float(data.get("strength", 0.8))
                except Exception:
                    strength = 0.8
                trigger = (data.get("trigger") or "").strip()
                client = (data.get("client") or "")[:64]
                items = start_gen(rels[:64], lname, strength, trigger, client)   # 一次最多 64 張保險
                plog(f"[genmode] 起 {len(items)} 張 · lora={lname or '(無)'} · str={strength}")
                self._send_json({"ok": True, "items": items})
                return
            if u.path == "/api/gen-cancel":
                # 該分頁刷新/關閉時由 sendBeacon 打來：只停掉這個 client 自己在途的生圖，別動別的分頁。
                n = cancel_client_gen(data.get("client") or "")
                self._send_json({"ok": True, "cancelled_queued": n})
                return
            if u.path == "/api/lora-push":
                # LoRA Manager（獨立埠 7861）點「送到 workflow」時 POST 這裡。folder/name
                # 對應 /api/loras 回應的 folder/name（name 不含副檔名）。單一 slot、版本號
                # 遞增，暗房前端輪詢偵測到新版本就自動選進生圖大面板——見 darkroom.js。
                folder = str(data.get("folder") or "").strip()
                name = str(data.get("name") or "").strip()
                if not name:
                    self._send_json({"error": "缺少 name"}, 400, {"Access-Control-Allow-Origin": "*"})
                    return
                with _lora_push_lock:
                    _lora_push["ver"] += 1
                    _lora_push["data"] = {"folder": folder, "name": name}
                    ver = _lora_push["ver"]
                plog(f"[lora-push] {folder}/{name} (ver={ver})")
                self._send_json({"ok": True, "ver": ver}, extra={"Access-Control-Allow-Origin": "*"})
                return
            if u.path == "/api/generate":
                rel = data.get("rel") or ""
                py = py_of(rel)
                if not py.is_file():
                    self._send_json({"error": "詞庫不存在"}, 404)
                    return
                current = get_job(rel)
                if current.get("status") in ("queued", "running"):
                    self._send_json({"status": current["status"], "message": current.get("message", "")})
                    return
                seed = data.get("seed")
                set_job(rel, "queued", "排隊中...")
                threading.Thread(
                    target=do_generate, args=(rel, seed), daemon=True
                ).start()
                self._send_json({"status": "queued"})
                return
            if u.path == "/api/batch_generate":
                if get_batch().get("running"):
                    self._send_json({"error": "已有批次進行中"}, 409)
                    return
                rels_in = data.get("rels") or []
                regenerate = bool(data.get("regenerate"))
                # 過濾:合法路徑(regenerate=False 時只留還沒圖的)
                rels = []
                for rel in rels_in:
                    try:
                        py = py_of(rel)
                    except Exception:
                        continue
                    if not py.is_file():
                        continue
                    if regenerate or find_image(py) is None:
                        rels.append(rel)
                if not rels:
                    self._send_json({"error": "沒有需要生成的項目"}, 400)
                    return
                for rel in rels:
                    set_job(rel, "queued", "批次排隊中...")
                threading.Thread(target=do_batch, args=(rels,), daemon=True).start()
                self._send_json({"status": "started", "total": len(rels)})
                return
            if u.path == "/api/batch_stop":
                set_batch(stop=True)
                self._send_json({"status": "stopping"})
                return
            self._send_json({"error": "not found"}, 404)
        except Exception as e:
            self._send_json({"error": f"{type(e).__name__}: {e}"}, 500)




# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main():
    # 行緩衝：讓 log 即時出現，就算 bat 把輸出導向檔案也不會卡在緩衝區
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    cfg = load_config()

    ap = argparse.ArgumentParser(description="Special Prompts 詞庫可視化管理 UI")
    # 預設值一律先吃 config，再讓 CLI 覆寫（省略欄位就用內建預設）
    ap.add_argument("--special-dir", default=cfg.get("special_dir"),
                    help="詞庫資料夾（覆寫 config 的 special_dir；不同 bat 可指不同路徑）")
    ap.add_argument("--host", default=cfg.get("host", "0.0.0.0"),
                    help="綁定介面(預設 0.0.0.0=所有介面;auto=只綁 Tailscale;127.0.0.1=僅本機)")
    ap.add_argument("--port", type=int, default=int(cfg.get("port", 7860)))
    ap.add_argument("--comfy", default=cfg.get("comfy", "http://127.0.0.1:8188"))
    ap.add_argument("--workflow", default=cfg.get("workflow", str(NEW_WORKFLOW)))
    ap.add_argument("--steps", type=int, default=int(cfg.get("steps", 25)))
    ap.add_argument("--timeout", type=int, default=int(cfg.get("timeout", 600)))
    ap.add_argument("--concurrency", type=int, default=int(cfg.get("concurrency", 2)),
                    help="同時最多跑幾張(預設 2)")
    ap.add_argument("--no-open", action="store_true", help="啟動時不自動開瀏覽器")
    args = ap.parse_args()

    # 詞庫資料夾：CLI --special-dir > config > gsp 預設。設定後 scan/生成都指向這裡。
    if args.special_dir:
        apply_special_dir(args.special_dir)

    if not SPECIAL_DIR.is_dir():
        print(f"[warn] 找不到詞庫資料夾:{SPECIAL_DIR}")
    else:
        print(f"[special ] {SPECIAL_DIR}")

    wf_path = Path(args.workflow)
    if not wf_path.is_file():
        candidates = [NEW_WORKFLOW, Path.home() / "Downloads" / "ANIMESTYLE (1).json", *DEFAULT_WORKFLOWS]
        wf_path = next((p for p in candidates if p.is_file()), None)
    if wf_path is None:
        print(r"找不到工作流。請確認 C:\Users\boshe\Downloads\ANIMESTYLE (1).json 存在,或用 --workflow 指定")
        sys.exit(1)
    STATE["workflow_path"] = wf_path
    STATE["template"] = load_workflow(wf_path)
    STATE["steps"] = args.steps
    STATE["timeout"] = args.timeout
    STATE["concurrency"] = max(1, args.concurrency)
    STATE["gen_sem"] = threading.Semaphore(STATE["concurrency"])

    print(f"[workflow] {wf_path}")
    print(f"[special ] {SPECIAL_DIR}")
    print(f"[輸出    ] 存為 {OUT_EXT}(舊 png 仍可顯示)")
    print(f"[並發    ] 一次最多 {STATE['concurrency']} 張")
    print(f"[comfy   ] 探測 {args.comfy} ...")
    try:
        STATE["comfy_base"] = resolve_comfy_base(args.comfy)
        print(f"[comfy   ] OK → {STATE['comfy_base']}")
    except Exception as e:
        print(f"[comfy   ] 連不上:{e}")
        print("[comfy   ] UI 仍會啟動,但按「生成」會失敗;確認 ComfyUI 啟動後可直接重試")
        STATE["comfy_base"] = None

    port = args.port
    # 解析綁定介面:auto = 只綁 Tailscale
    if args.host == "auto":
        ts_ip = get_tailscale_ip()
        if ts_ip:
            bind_host = ts_ip
            open_url = f"http://{ts_ip}:{port}/"
            print(f"[serve   ] 只綁 Tailscale  {open_url}")
            print("[serve   ] 手機開同一網址即可(區網其他裝置連不到)")
        else:
            bind_host = "0.0.0.0"
            open_url = f"http://127.0.0.1:{port}/"
            print("[serve   ] 未偵測到 Tailscale,退回綁所有介面 0.0.0.0")
            print("[serve   ] 確認電腦已登入 Tailscale;或用 --host 0.0.0.0 明確指定")
    elif args.host in ("0.0.0.0", "::"):
        bind_host = args.host
        open_url = f"http://127.0.0.1:{port}/"
        ts_ip = get_tailscale_ip()
        print(f"[serve   ] 本機     {open_url}")
        if ts_ip:
            print(f"[serve   ] 手機/Tailscale  http://{ts_ip}:{port}/")
    else:
        bind_host = args.host
        open_url = f"http://{args.host}:{port}/"
        print(f"[serve   ] {open_url}")
    print("[serve   ] 若手機連不上:Windows 防火牆首次可能跳出提示,請允許 Python 存取")

    _load_flags()                 # 載入品質旗標黑名單（依 dataset 分檔）
    _load_favs()                  # 載入收藏清單（依 dataset 分檔）
    _load_rarities()              # 載入稀有度側檔（依 dataset 分檔）
    srv = ThreadingHTTPServer((bind_host, port), Handler)
    # 開機就先在背景把詞庫掃一遍暖快取，第一次開頁的 /api/libs 才不用等 ~1s 掃描
    threading.Thread(target=lambda: scan_libraries(), daemon=True).start()
    if not args.no_open:
        try:
            import webbrowser
            webbrowser.open(open_url)
        except Exception:
            pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
