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
import contextlib
import gzip
import hashlib
import io
import json
import mimetypes
import os
import random
import re
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
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
    parse_lib_ast,
    prepare_workflow,
    queue_and_wait,
    resolve_comfy_base,
    split_tags,
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


def _save_checkpoint_to_config(file: str) -> None:
    """讀-改-寫 preview_config.json，只改 checkpoint 這個欄位，其餘既有欄位不動——
    跟 agent_draw.py 寫入 loras 那次教訓一樣，不能整份覆蓋。"""
    cfg = {}
    if CONFIG_PATH.is_file():
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            cfg = {}
    cfg["checkpoint"] = file
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


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
    """kind ∈ {flags, favorites, rarities, scores}。回傳本 dataset 專屬的 json 路徑。"""
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
# 卡片評分（waifu-score 三模型的加權分數）：結構同上面幾組側檔，但只有瀏覽模式
# 生成（do_generate）落地的圖片才會寫進這份側檔，抽卡/生圖模式的暫時結果不落地，
# 見 docs/superpowers/specs/2026-08-14-darkroom-model-scoring-design.md。
# key 是詞庫 rel，value 是 waifu-score /api/darkroom-score 的原始回應 + "at" 時間戳。
# ---------------------------------------------------------------------------
_scores: dict = {}   # rel -> {blackroot, waifu, kawai_tier, kawai_score, kawai_norm, final, at}
_scores_lock = threading.Lock()


def _load_scores():
    global _scores
    path = _meta_path("scores")
    if not path.is_file():
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        sc = d.get("scores") if isinstance(d, dict) else None
        if isinstance(sc, dict):
            _scores = sc
        plog(f"[score] 載入 {len(_scores)} 筆分數")
    except Exception as e:
        plog(f"[score] 讀取失敗，從空白開始：{e}")


def _save_scores_locked():
    """呼叫端須已持有 _scores_lock。"""
    _atomic_write_json(_meta_path("scores"), {"scores": _scores})


def set_score(rel: str, data: dict) -> None:
    with _scores_lock:
        _scores[rel] = data
        _save_scores_locked()


def clear_score(rel: str) -> None:
    """從側檔移除一筆——補分（run_score_backfill）清孤兒紀錄用。"""
    with _scores_lock:
        if rel in _scores:
            _scores.pop(rel, None)
            _save_scores_locked()


def _flush_scores() -> None:
    """把 _scores 落地，但序列化/寫檔在鎖外做——只在鎖內複製一份，不讓其他請求
    （例如 /api/libs 的 score_map()）在磁碟 I/O 期間排隊等鎖。"""
    with _scores_lock:
        snapshot = dict(_scores)
    _atomic_write_json(_meta_path("scores"), {"scores": snapshot})


def score_map() -> dict:
    with _scores_lock:
        return dict(_scores)


def get_score(rel: str) -> dict | None:
    """單筆查詢——給 /api/score 用，不用像 score_map() 那樣整份 dict 複製一次。
    給前端在生成/補分完成後輪詢「這張到底評完了沒」用。"""
    with _scores_lock:
        return dict(_scores[rel]) if rel in _scores else None


# ---------------------------------------------------------------------------
# 呼叫 waifu-score 評分服務（獨立 FastAPI 服務，使用者自己跑 run.bat 啟動，
# 見 waifu-score/README.md）。位址寫死本機，這次沒有遠端部署需求。
# 用 127.0.0.1 不要用 localhost：urllib.request 在這台機器上解析 "localhost"
# 主機名要花將近 2 秒（Windows 常見的 IPv6/IPv4 雙棧解析延遲），跟三個模型
# 實際算分時間無關，純粹是連線前的名稱解析拖慢的——實測直打 IP 從 2.2s/張
# 降到 0.15s/張，14 倍差距。
# ---------------------------------------------------------------------------
SCORE_SERVICE_BASE = "http://127.0.0.1:8000"
SCORE_TIMEOUT = 30.0
_score_sem = threading.Semaphore(1)   # 序列化評分請求，見下方說明


def _score_image_bytes(img_bytes: bytes) -> dict | None:
    """POST 圖片 bytes 給 waifu-score 的合併端點，回傳 Task 1 定義的分數 dict；
    連線失敗/timeout/非 200 一律安靜回 None（呼叫端負責 log），不拋例外——評分
    是錦上添花的背景動作，不能因為服務沒開就影響生成本身。"""
    try:
        boundary = f"----darkroomscore{uuid.uuid4().hex}"
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="card.webp"\r\n'
            f"Content-Type: image/webp\r\n\r\n"
        ).encode("utf-8") + img_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")
        headers = {
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": "darkroom-preview-ui/1.0",
        }
        req = urllib.request.Request(f"{SCORE_SERVICE_BASE}/api/darkroom-score",
                                     data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=SCORE_TIMEOUT) as resp:
            raw = resp.read()
        return json.loads(raw.decode("utf-8"))
    except Exception as e:
        plog(f"[score] 評分失敗：{type(e).__name__}: {e}")
        return None


def _score_service_available() -> bool:
    """輕量健康檢查，給補分按鈕/腳本啟動前用。短 timeout，連不上直接回 False，
    不拋例外。"""
    req = urllib.request.Request(f"{SCORE_SERVICE_BASE}/api/health",
                                 headers={"User-Agent": "darkroom-preview-ui/1.0"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def _score_and_persist(rel: str, img_bytes: bytes):
    """瀏覽模式生成成功後的背景評分：算完就永久寫進側檔。見 do_generate() 裡
    的呼叫點——緊接在 _scan_note_image() 之後，用同一份剛寫出的圖片 bytes，
    不用另外重讀檔案。"""
    with _score_sem:
        result = _score_image_bytes(img_bytes)
    if result:
        result["at"] = time.time()
        set_score(rel, result)


# ---------------------------------------------------------------------------
# LoRA（給「生圖」模式用）：讀 ComfyUI 的 loras 資料夾，列出每個 .safetensors 的觸發詞
# 與預覽圖。沿用主面板 serve.py 的做法與路徑（可用環境變數 LORA_ROOT 覆寫）。這些檔在
# ComfyUI 磁碟上、不透過 ComfyUI API，直接讀資料夾。
# ---------------------------------------------------------------------------
LORA_ROOT = Path(os.environ.get(
    "LORA_ROOT",
    r"E:\Comfyui\loras",
))
LORA_FOLDERS = ["style", "Character", "HENTAI", "illus"]
# /api/agent-draw 沒帶 loras 欄位時套用的預設 LoRA——給外部 agent 用，讓它不用每次
# 抽卡都要知道確切的 LoRA 檔名。想抽「不套 LoRA」要明確傳 `"loras": []`——不給
# loras 這個欄位才會落到這個預設值。
AGENT_DRAW_DEFAULT_LORAS = [
    {"folder": "style", "file": "Takeda_HiromitsuV3.safetensors", "strength": 0.8},
]
# ---------------------------------------------------------------------------
# checkpoint 選擇（給「生圖」模式用，見 docs/superpowers/specs/
# 2026-08-12-darkroom-checkpoint-picker-design.md）。只鎖定這一個資料夾，不是整個
# checkpoints 樹——裡面放的都是跟現有 LoRA 相容的 Illustrious 系底模，其他底模套進
# 這條管線不會有意義的結果。**只影響生圖模式**（手動生圖／塔羅抽卡／agent-draw），
# 瀏覽模式的「重新生成」單張縮圖刻意不受影響，見 apply_checkpoint_override() 的
# 說明與它唯一的呼叫點。
# ---------------------------------------------------------------------------
DARKROOM_CHECKPOINT_ROOT = Path(os.environ.get(
    "DARKROOM_CHECKPOINT_ROOT",
    r"C:\ComfyUI\ComfyUI_windows_portable_nvidia\ComfyUI_windows_portable\ComfyUI\models\checkpoints\illurtrious",
))
DARKROOM_DEFAULT_CHECKPOINT = "waiIllustriousSDXL_v170.safetensors"
LORA_PREVIEW_EXTS = (".preview.png", ".preview.jpeg", ".preview.jpg", ".preview.webp",
                     ".preview.mp4", ".preview.webm",
                     ".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm")
mimetypes.add_type("image/webp", ".webp")   # 有些 Python 的 mimetypes 不認 webp
LORA_VIDEO_EXTS = (".mp4", ".webm")   # 有些 LoRA 的預覽是短片，前端要改用 <video> 渲染


_lora_cache = {"data": None, "at": 0.0}
_LORA_TTL = 300.0   # LoRA 很少變動，快取 5 分鐘（每次要讀數百個 metadata.json，約 5 秒）

# 有些 LoRA 的 trainedWords 是直接從 CivitAI 頁面複製貼上的，會混進 A1111/Forge 用的
# <lora:xxx:1> 語法（那邊的提示詞處理器認得這個、ComfyUI 不認得，送進去只是沒意義的
# 文字 token）。這裡只是「讀取時清掉、不落地」——不改 metadata.json 本身，每次讀都重新
# 過濾一次，之後 LoRA Manager 或使用者自己改了原始檔也不會被這裡卡住。
_ANGLE_TAG_RE = re.compile(r"<[^<>]*>")


def _strip_angle_tags(word: str) -> str:
    """拿掉 <...> 這類標籤，並清掉因此留下的空白/多餘逗點（不然「, , 」這種空段會殘留）。"""
    cleaned = _ANGLE_TAG_RE.sub("", word)
    parts = [p.strip() for p in cleaned.split(",")]
    parts = [p for p in parts if p]
    return ", ".join(parts)


def list_loras() -> dict:
    """列出各分類夾內每個 LoRA 的觸發詞與預覽圖檔名。trainedWords 保留為「多組」陣列。
    讀數百個 metadata.json 很慢（約 5s），用 TTL 快取。

    用 rglob 遞迴掃描（不是只掃頂層）：LoRA Manager 那邊本來就允許在 style/Character/
    HENTAI/illus 底下建子資料夾整理（例如 Character/other、Character/manhwa），舊版只掃
    頂層會讓子資料夾裡的 LoRA 在暗房完全消失不見——LoRA Manager 點「送到 workflow」推送
    時帶的 folder 是完整相對路徑（如 "Character/other"），暗房這邊的清單卻找不到對應項目、
    比對永遠失敗，大面板開了卻是空的。item 的 "folder" 現在是完整相對路徑（用來跟推送比對、
    顯示、組預覽/詳情連結），"category" 才是頂層四分類（用來給左欄篩選晶片分組計數）。"""
    if _lora_cache["data"] is not None and (time.time() - _lora_cache["at"]) < _LORA_TTL:
        return _lora_cache["data"]
    items, counts = [], {}
    for category in LORA_FOLDERS:
        base = LORA_ROOT / category
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
                    words = [_strip_angle_tags(w) for w in raw_words]
                    title = md.get("model_name") or stem
                    # base_model 是頂層欄位(LoRA Manager 掃描時寫入)，civitai.baseModel
                    # 當備援(理論上兩者同值,防極少數 metadata.json 只有其中一個)。
                    base_model = md.get("base_model") or (md.get("civitai") or {}).get("baseModel") or ""
                except Exception:
                    pass
            preview = None
            for ext in LORA_PREVIEW_EXTS:
                if (d / (stem + ext)).is_file():
                    preview = stem + ext
                    break
            items.append({"folder": folder, "category": category, "file": fn, "name": stem,
                          "title": title, "trainedWords": words, "preview": preview,
                          "base_model": base_model})
            n += 1
        counts[category] = n
    data = {"items": items, "counts": counts, "folders": LORA_FOLDERS}
    _lora_cache["data"] = data
    _lora_cache["at"] = time.time()
    return data


def lora_preview_path(folder: str, fn: str):
    """回傳 LoRA 預覽圖的實體路徑。folder 現在可能帶子資料夾（如 "Character/other"，見
    list_loras()），所以驗證改成：第一段須在白名單、每一段不得是 ".."；fn 仍是純檔名
    （擋目錄穿越），最後再確認解析後的路徑真的落在 LORA_ROOT 底下，雙重保險。

    fn 的traversal 檢查用「整段等於 ".."」而不是「字串包含 ".."」——後者會誤傷合法檔名
    裡剛好連續兩個點的情況（實測踩到：某個 LoRA 原始檔名是 "...with....jpeg"，字面上
    含 ".."，但沒有路徑分隔符，整段當一個檔名用完全安全，不構成目錄穿越）。fn 已經先
    擋過 "/" 和 "\\"，不可能被拆成多段，所以只有「fn 剛好整個等於 ".." 或 "."」才是
    真正的穿越風險，字串包含不是。"""
    if not fn or "/" in fn or "\\" in fn or fn in (".", ".."):
        return None
    parts = (folder or "").split("/")
    if not parts or parts[0] not in LORA_FOLDERS or any(part in ("", "..") for part in parts) or "\\" in folder:
        return None
    p = LORA_ROOT / folder / fn
    try:
        p.resolve().relative_to(LORA_ROOT.resolve())
    except ValueError:
        return None
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

class PrioritySemaphore:
    """介面相容 threading.Semaphore，但釋放名額時優先喚醒優先權數字較小的等待者，
    而不是像原生 Semaphore 一樣「醒來順序不保證」（見 CLAUDE.md「踩過的坑」）。

    用途：單張生成／重新生成／抽卡都算高優先權（0），批次（補缺少／全部重生）算低
    優先權（1）。批次一次會佔滿 concurrency 個名額連續跑很久，若用原生 Semaphore，
    批次 worker thread 從 release 到下一次 acquire 幾乎是同一瞬間就搶線，而單張生成
    是請求進來才臨時起 thread，多了 HTTP handler／建立 thread 的延遲，實務上幾乎每次
    都搶輸、被迫排在批次剩下的所有項目後面。加優先權讓單張生成/抽卡可以插隊到批次
    前面，不用等整批跑完。同優先權內仍照抵達順序（seq）排隊，不會互搶。"""

    def __init__(self, value):
        self._value = value
        self._lock = threading.Lock()
        self._waiters = []  # [(priority, seq, threading.Event), ...]，已排序
        self._seq = 0

    def acquire(self, priority: int = 0):
        with self._lock:
            if self._value > 0:
                self._value -= 1
                return
            seq = self._seq
            self._seq += 1
            ev = threading.Event()
            self._waiters.append((priority, seq, ev))
            self._waiters.sort(key=lambda w: (w[0], w[1]))
        ev.wait()

    def release(self):
        with self._lock:
            if self._waiters:
                _, _, ev = self._waiters.pop(0)
                ev.set()
                return
            self._value += 1

    def __enter__(self):
        self.acquire(0)
        return self

    def __exit__(self, *exc):
        self.release()


@contextlib.contextmanager
def gen_slot(priority: int = 0):
    """跟 `with STATE["gen_sem"]:` 等價，但可以指定優先權（見 PrioritySemaphore）。"""
    STATE["gen_sem"].acquire(priority)
    try:
        yield
    finally:
        STATE["gen_sem"].release()


# ---------------------------------------------------------------------------
# 全域狀態
# ---------------------------------------------------------------------------
STATE = {
    "workflow_path": None,
    "template": None,
    "comfy_base": None,
    "comfy_pref": None,   # 使用者原本指定的 --comfy，斷線後重新探測用
    "steps": 25,
    "checkpoint": None,   # 生圖模式的底模覆寫；None＝不覆寫，見 DARKROOM_CHECKPOINT_ROOT 說明
    "timeout": 600,
    "jobs": {},                     # rel(str) -> {status, message, updated}
    "jobs_lock": threading.Lock(),
    "concurrency": 2,               # 一次最多同時跑幾張
    "gen_sem": PrioritySemaphore(2),  # 全域併發上限(單張+批次共用，見 PrioritySemaphore)
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
    "score_backfill": {"running": False, "done": 0, "total": 0},
    "score_backfill_lock": threading.Lock(),
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
# 允許用 ?w= 指定較小的尺寸。動機是「進場動畫的圖片在動的時候會閃/出現摩爾紋」:
# 縮圖固定 360px,但進場畫面把它顯示成 108~130px(1x DPR),等於縮小 2.8~3.3 倍。
# 靜止的格線看不出來(走樣在靜態畫面只是「有點鋭利過頭」),但只要內容在動,每一幀
# 取樣到的來源像素子集都不一樣,細節就會逐幀跳動 —— 看起來就是整張圖在閃、密集
# 紋理處出現摩爾紋。治本的做法是「顯示多大就送多大」,讓縮放比例接近 1。
# 用固定的尺寸級距(不是任意數字)是為了限制磁碟快取的條目數:每多一個尺寸就多一
# 份快取,開放任意 w 會讓 .thumb_cache 無限膨脹。
THUMB_SIZES = (128, 192, 256, 360)
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


def thumb_size_for(raw: str) -> int:
    """把 ?w= 收斂到 THUMB_SIZES 裡的級距;沒給或不合法一律回 THUMB_MAX。

    取「不小於需求的最小級距」——寧可送稍大一點讓瀏覽器再縮一點點,也不要送比
    需求小的然後被放大成糊的。
    """
    try:
        want = int(raw)
    except (TypeError, ValueError):
        return THUMB_MAX
    for s in THUMB_SIZES:
        if s >= want:
            return s
    return THUMB_MAX


def make_thumb(src: Path, size: int = THUMB_MAX) -> tuple[bytes, str]:
    """回傳 (webp bytes, etag)。磁碟快取,靠來源 mtime+size 失效。

    size 必須是 THUMB_SIZES 裡的值(由 thumb_size_for 收斂),它會進 etag/快取鍵,
    不同尺寸各自一份快取檔,不會互相覆蓋。

    Pillow 不可用時,退回原圖(較大但仍可顯示)。
    """
    st = src.stat()
    sig = f"{src}|{int(st.st_mtime)}|{st.st_size}|{size}"
    etag = hashlib.sha1(sig.encode("utf-8")).hexdigest()

    if not _HAS_PIL:
        return src.read_bytes(), '"' + etag + '"'

    THUMB_DIR.mkdir(exist_ok=True)
    cache_file = THUMB_DIR / f"{etag}.webp"
    if cache_file.is_file():
        return cache_file.read_bytes(), '"' + etag + '"'

    lk = _thumb_lock(etag)
    with lk:
        try:
            if cache_file.is_file():  # 可能剛被別的執行緒建好
                return cache_file.read_bytes(), '"' + etag + '"'
            # 只有「真的要現場生成」才佔用併發額度;快取命中在上面就回了、不進這裡。
            # method=1 比預設 4 快很多、檔案只大一點點(縮圖不在意)。
            with _thumb_gen_sem:
                t0 = time.time()
                plog(f"[thumb] Pillow 縮圖 {src.parent.name}/{src.name}")
                with Image.open(src) as im:
                    im = im.convert("RGB")
                    im.thumbnail((size, size), Image.LANCZOS)
                    buf = io.BytesIO()
                    im.save(buf, format="WEBP", quality=THUMB_QUALITY, method=1)
                data = buf.getvalue()
                plog(f"[thumb] 完成 {src.parent.name}/{src.name}  {time.time()-t0:.2f}s  {len(data)//1024}KB")
            # data 已在上面取得。不能直接 write_bytes(cache_file)——open(mode='wb')
            # 會先把檔案截斷成 0 位元組再開始寫，另一個請求若在這個空窗期打中上面
            # 那個沒鎖保護的快速路徑（第 518 行 is_file() 快取命中判斷），就會讀到
            # 一個還沒寫完（甚至是 0 位元組）的檔案，瀏覽器收到的縮圖就是破圖。
            # 改成先寫到同目錄下的臨時檔，寫完再用 os.replace() 原子性地覆蓋成正式
            # 檔名——os.replace 在 POSIX／Windows 都是單一系統呼叫，其他執行緒的
            # is_file() 檢查只會看到「舊檔不存在」或「新檔已完整」兩種狀態之一，
            # 不會看到寫到一半的中間狀態。
            tmp_file = cache_file.with_name(f"{cache_file.name}.tmp-{os.getpid()}-{threading.get_ident()}")
            try:
                tmp_file.write_bytes(data)
                os.replace(tmp_file, cache_file)
            except OSError:
                try:
                    tmp_file.unlink(missing_ok=True)
                except OSError:
                    pass
            return data, '"' + etag + '"'
        finally:
            # etag 含來源 mtime,同一張圖重生成一次就是全新的 key——不清掉的話
            # _thumb_locks 會隨「規模 × 重生成次數」無限增長。用完就丟,只要還是
            # 同一把鎖物件才丟(避免誤刪掉別的執行緒剛建立、正在等的新鎖)。
            with _thumb_locks_guard:
                if _thumb_locks.get(etag) is lk:
                    _thumb_locks.pop(etag, None)


def _lower_thread_priority_background():
    """把目前這個執行緒切到 Windows 的「背景模式」（THREAD_MODE_BACKGROUND_BEGIN）——
    CPU、磁碟 I/O、記憶體優先權一起降低，讓排程器自動把前景應用（不管是你自己在
    用電腦，還是遠端連進來的人在瀏覽）擺在前面，這個背景暖快取任務盡量不去搶。
    不用另外呼叫 THREAD_MODE_BACKGROUND_END 恢復——這個執行緒的唯一工作就是暖
    快取，跑完就結束，優先權設定跟著執行緒一起消失，不影響其他執行緒。只在
    Windows 有效（這專案本來就是 Windows 專用），失敗就當沒這回事，不影響功能。"""
    if os.name != "nt":
        return
    try:
        import ctypes
        THREAD_MODE_BACKGROUND_BEGIN = 0x00010000
        ctypes.windll.kernel32.SetThreadPriority(
            ctypes.windll.kernel32.GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN)
    except Exception:
        pass


def _warm_all_thumbs():
    """開機背景任務：圖庫縮圖／LoRA 預覽縮圖全部先跑過一輪，快取全部建好。
    不這麼做的話，永遠是「誰先點到誰倒楣」——第一個瀏覽某張圖/某個 LoRA 的人
    要付冷快取生成的成本，遠端連線碰上這個又疊加傳輸延遲，就是我們這幾輪抓到
    的那種「感覺卡」。開機後不管是本機還是遠端，第一次點開永遠都是暖快取（幾
    毫秒），不用等。用既有的 _thumb_gen_sem（同時最多 2 張現場生成，見上面）
    自然節流，不會把 CPU/上傳頻寬榨乾，背景慢慢跑完就好，不趕時間、不卡主執行緒。
    make_thumb() 本身有磁碟快取，重複呼叫（例如上次開機已經暖過的）幾乎零成本，
    每次開機重跑這個不是浪費，是自我修復——手動加了新圖/新 LoRA 也會自動補上。

    順便清掉 .thumb_cache 裡的孤兒縮圖：make_thumb() 只會「生成/命中」，從來不會
    反向偵測「來源已經被刪掉了」，刪詞庫/刪圖不會連帶清掉對應的快取檔，快取只會
    越長越大、永遠不會瘦身。做法：把「目前所有還存在的來源，在每一種合法尺寸級距
    下」該有的 etag 全部先算出來（不用真的重新生成——mtime/size 沒變就是同一把
    etag），跟資料夾實際內容比對，不在這份「合法清單」裡的就是孤兒，刪掉。"""
    _lower_thread_priority_background()
    n_gallery = n_lora = 0
    live_etags: set[str] = set()
    try:
        items = scan_libraries()
    except Exception as e:
        plog(f"[warm] 掃描詞庫失敗，略過圖庫縮圖預熱：{type(e).__name__}: {e}")
        items = []
    for it in items:
        if not it.get("has_image"):
            continue
        try:
            img = find_image(py_of(it["rel"]))
            if img is None:
                continue
            make_thumb(img, THUMB_MAX)
            n_gallery += 1
            # 這張圖在「所有」合法尺寸級距下都算活的，不是只有這次現場生成的
            # THUMB_MAX——不然開場動畫等地方用到的其他尺寸快取會被孤兒清理誤刪。
            st = img.stat()
            for sz in THUMB_SIZES:
                sig = f"{img}|{int(st.st_mtime)}|{st.st_size}|{sz}"
                live_etags.add(hashlib.sha1(sig.encode("utf-8")).hexdigest())
        except Exception:
            pass
    try:
        loras = list_loras().get("items", [])
    except Exception as e:
        plog(f"[warm] 掃描 LoRA 失敗，略過 LoRA 預覽縮圖預熱：{type(e).__name__}: {e}")
        loras = []
    for l in loras:
        preview = l.get("preview")
        if not preview or preview.lower().endswith((".mp4", ".webm")):
            continue   # 影片 Pillow 縮不了，不用預熱，也不算進活清單
        try:
            p = lora_preview_path(l["folder"], preview)
            if p is None:
                continue
            make_thumb(p, THUMB_MAX)
            n_lora += 1
            st = p.stat()
            sig = f"{p}|{int(st.st_mtime)}|{st.st_size}|{THUMB_MAX}"
            live_etags.add(hashlib.sha1(sig.encode("utf-8")).hexdigest())
        except Exception:
            pass
    removed = 0
    try:
        if THUMB_DIR.is_dir():
            for f in THUMB_DIR.glob("*.webp"):
                if f.stem not in live_etags:
                    try:
                        f.unlink()
                        removed += 1
                    except OSError:
                        pass
    except Exception as e:
        plog(f"[warm] 清孤兒縮圖失敗：{type(e).__name__}: {e}")
    plog(f"[warm] 縮圖預熱完成：圖庫 {n_gallery} 張、LoRA 預覽 {n_lora} 張"
         + (f"，清掉 {removed} 個孤兒快取" if removed else ""))


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
    smap = score_map()
    return [
        dict(it,
             job=dict(jobs.get(it["rel"]) or {}),
             flagged=(it["rel"] in fl),
             favorited=(it["rel"] in fv),
             rarity=(rmap[it["rel"]] if it["rel"] in rmap else it["rarity"]),
             # 分數跟圖片存在性綁定：has_image=False 一律回 None，即使側檔裡還留著
             # 舊紀錄（圖被刪了/還沒生成過），不能顯示分數——見設計文件「分數跟圖片
             # 存在性綁定」一節，這個不變量只在這個唯一的讀取點保證，不用到處掛
             # 刪除 hook。
             score=(smap.get(it["rel"]) if it["has_image"] else None))
        for it in cached
    ]


def run_score_backfill(progress_cb=None):
    """掃 has_image=True 但側檔沒分數的卡片跑評分；has_image=False 但側檔仍有
    孤兒分數紀錄的一併清掉（見設計文件「分數跟圖片存在性綁定」）。同步函式，
    給 /api/score-backfill 的背景 thread 跟 backfill_scores.py 共用，不重複實作
    掃描/評分邏輯。progress_cb(done, total) 是可選的外部回呼，CLI 腳本用來印
    進度到 stdout。"""
    items = scan_libraries()
    scores = score_map()
    by_rel = {it["rel"]: it for it in items}
    orphans = [rel for rel in scores if not by_rel.get(rel, {}).get("has_image")]
    if orphans:
        # 一次性從記憶體清掉整批孤兒紀錄再落地一次，不要逐筆呼叫 clear_score()
        # （逐筆＝逐筆都整份 dict 序列化寫檔，孤兒多的話一樣是 O(n²) I/O）。
        with _scores_lock:
            for rel in orphans:
                _scores.pop(rel, None)
        _flush_scores()

    todo = [it for it in items if it.get("has_image") and it["rel"] not in scores]
    total = len(todo)
    with STATE["score_backfill_lock"]:
        STATE["score_backfill"] = {"running": True, "done": 0, "total": total,
                                    "last_rel": None, "last_score": None}
    plog(f"[score-backfill] 開始 · 待評分 {total} 筆 · 清掉 {len(orphans)} 筆孤兒紀錄")

    # 逐筆評分還是逐筆更新記憶體（前端輪詢 last_rel／last_score 需要即時性），但
    # 落地改成每隔一段時間才 flush 一次——補幾千~28000 筆時，寫檔成本不再隨已補
    # 筆數線性增加成 O(n²)，且落地本身已搬到 _scores_lock 外面做（見 _flush_scores）。
    _FLUSH_INTERVAL = 2.0
    done = 0
    dirty = False
    last_flush = time.time()
    try:
        for it in todo:
            rel = it["rel"]
            result = None
            try:
                py = py_of(rel)
                img = find_image(py)
                if img is None:
                    continue
                img_bytes = img.read_bytes()
                with _score_sem:
                    result = _score_image_bytes(img_bytes)
                if result:
                    result["at"] = time.time()
                    with _scores_lock:
                        _scores[rel] = result
                    dirty = True
            except Exception as e:
                plog(f"[score-backfill] {rel} 失敗：{type(e).__name__}: {e}")
            done += 1
            with STATE["score_backfill_lock"]:
                STATE["score_backfill"]["done"] = done
                # 前端輪詢 last_rel／last_score 就能逐張即時更新卡片分數徽章，不用
                # 等整輪跑完才整批重新整理——result 是 None（評分失敗/圖讀不到）
                # 時故意不更新這兩個欄位，前端才不會誤把上一筆成功的結果套到這筆。
                if result:
                    STATE["score_backfill"]["last_rel"] = rel
                    STATE["score_backfill"]["last_score"] = result
            if progress_cb:
                progress_cb(done, total)
            now = time.time()
            if dirty and now - last_flush >= _FLUSH_INTERVAL:
                _flush_scores()
                dirty = False
                last_flush = now
    finally:
        if dirty:
            _flush_scores()
        with STATE["score_backfill_lock"]:
            STATE["score_backfill"]["running"] = False
    plog(f"[score-backfill] 完成 · {done}/{total}")


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


# --- 標籤搜尋索引 ----------------------------------------------------------
# rel -> frozenset(原子標籤，小寫)。跟 _scan 同一套 stale-while-revalidate：
# 首次請求同步建（實測 25744 個檔案 ast 解析約 3.3s），之後吃快取秒回，
# 超過 TTL 只在背景重建。用 ast（parse_lib_ast）不用 load_lib 的 importlib
# exec_module——建索引要一次掃全部詞庫，exec 每個檔案太重。
_tag_index = {"items": None, "at": 0.0, "refreshing": False}
_tag_index_lock = threading.Lock()


def _build_tag_index() -> dict[str, frozenset[str]]:
    t0 = time.time()
    idx: dict[str, frozenset[str]] = {}
    for py in gsp.iter_libraries(None):
        try:
            req, pos, neg = parse_lib_ast(py)
        except Exception:
            continue
        tags = split_tags(req) + split_tags(pos) + split_tags(neg)
        idx[rel_of(py)] = frozenset(t.lower() for t in tags)
    plog(f"[tagidx] 建立標籤索引 {len(idx)} 筆 · {time.time() - t0:.2f}s")
    return idx


def _tag_index_refresh_bg():
    def work():
        try:
            items = _build_tag_index()
            with _tag_index_lock:
                _tag_index["items"] = items
                _tag_index["at"] = time.time()
        finally:
            with _tag_index_lock:
                _tag_index["refreshing"] = False
    threading.Thread(target=work, daemon=True).start()


_tag_index_build_lock = threading.Lock()


def get_tag_index(force: bool = False) -> dict[str, frozenset[str]]:
    with _tag_index_lock:
        cached = _tag_index["items"]
        stale = (time.time() - _tag_index["at"]) > SCAN_TTL
        if cached is not None and not force:
            if stale and not _tag_index["refreshing"]:
                _tag_index["refreshing"] = True
                need_bg = True
            else:
                need_bg = False
        else:
            need_bg = False
    if cached is not None and not force:
        if need_bg:
            _tag_index_refresh_bg()
        return cached
    # 還沒建過索引（或要求強制重建）：用一把鎖序列化「真的動手建」這一步。開機暖快取
    # 的背景執行緒跟使用者第一次搜尋標籤幾乎同時抵達時，兩邊都會走到這裡；沒有這把鎖
    # 兩邊會各自掃一次全部詞庫（實測真的重現過：同時建了兩次索引，各花 5~8s）。鎖住後
    # 第二個呼叫等第一個建完，重新讀一次快取直接吃現成的，不用再掃一次。
    with _tag_index_build_lock:
        with _tag_index_lock:
            cached = _tag_index["items"]
        if cached is not None and not force:
            return cached
        cached = _build_tag_index()
        with _tag_index_lock:
            _tag_index["items"] = cached
            _tag_index["at"] = time.time()
        return cached


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
    if stopped:
        # 中止時 idx 之後的項目從沒被 worker 撈到，job 停在 batch_generate
        # 一開始就設的 "queued/批次排隊中..."，do_generate 從未跑過所以永遠不會
        # 被改掉。不清掉的話 /api/generate 會看到 status=queued 就直接短路
        # 回舊狀態、不重新送生成——使用者點「重新生成」沒反應就是這樣來的。
        for rel in rels[idx["i"]:]:
            if get_job(rel).get("status") == "queued":
                set_job(rel, "", "")
    plog(f"[batch] {'已停止' if stopped else '完成'} · {b.get('done')}/{total} · ok {b.get('ok')} · fail {b.get('fail')}")


_COMFY_RETRY_COOLDOWN = 15.0   # 秒。resolve_comfy_base() 會試好幾個候選位址，每個
                                # 都帶 timeout=3s，ComfyUI 沒開的時候一次探測可能要好
                                # 幾秒——/api/libs 等好幾個地方每次都會呼叫這裡，若沒有
                                # 冷卻時間，ComfyUI 關著的時候每一次請求都要重新完整
                                # 探測一輪，暗房會變得非常慢（這是真的量到的回歸，不是
                                # 錯覺：之前只在啟動時探測一次，這個修復讓它變成「沒接上
                                # 就每次都探測」，忘記加冷卻時間）。
STATE.setdefault("comfy_last_probe", 0.0)


def ensure_comfy_base():
    """回傳目前可用的 ComfyUI base URL；若上次探測失敗，隔一段冷卻時間後才會重
    試一次（不是每次呼叫都重探測，見 _COMFY_RETRY_COOLDOWN 說明）。啟動時
    ComfyUI 還沒開會被 resolve_comfy_base 判定失敗、STATE["comfy_base"] 存成
    None，過去這個 None 就永遠卡住，就算之後才把 ComfyUI 開起來也連不上、只能
    重開暗房。改成 comfy_base 是 None、且距上次探測超過冷卻時間時才重探測一次。"""
    if STATE["comfy_base"]:
        return STATE["comfy_base"]
    now = time.time()
    if now - STATE["comfy_last_probe"] < _COMFY_RETRY_COOLDOWN:
        return None
    STATE["comfy_last_probe"] = now
    pref = STATE.get("comfy_pref") or "http://127.0.0.1:8188"
    try:
        STATE["comfy_base"] = resolve_comfy_base(pref)
        print(f"[comfy   ] 重新連上 → {STATE['comfy_base']}")
    except Exception:
        STATE["comfy_base"] = None
    return STATE["comfy_base"]


def do_generate(rel: str, seed: int | None = None, in_batch: bool = False):
    if not ensure_comfy_base():
        set_job(rel, "error", "ComfyUI 未連線")
        if not in_batch:
            plog(f"[gen] ERR {rel} — ComfyUI 未連線")
        return
    with gen_slot(1 if in_batch else 0):
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
            threading.Thread(target=_score_and_persist, args=(rel, img_bytes),
                             daemon=True).start()
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
def apply_checkpoint_override(wf: dict) -> None:
    """如果 STATE["checkpoint"] 有設定，把 wf 裡的 CheckpointLoaderSimple 節點換成它。

    只有生圖模式（_gen_one_worker）呼叫這個函式；瀏覽模式的 do_generate()
    刻意不呼叫，維持 workflow.json 原本內建的底模——見
    docs/superpowers/specs/2026-08-12-darkroom-checkpoint-picker-design.md
    的範圍決定。"""
    if not STATE.get("checkpoint"):
        return
    ckpt_node = gsp.find_node(wf, "CheckpointLoaderSimple")
    if ckpt_node:
        # ComfyUI 認的 ckpt_name 是「資料夾\檔名」的相對路徑，不是純檔名——實測用
        # object_info 查過，bare 檔名根本不在 ComfyUI 回報的合法清單裡，直接送整批
        # 400 Bad Request（跟 _convert_loras 處理 LoRA 子資料夾同一類坑）。
        # STATE["checkpoint"] 存的是純檔名（跟 DARKROOM_CHECKPOINT_ROOT.glob() 掃出來
        # 的一致，GET /api/checkpoints、POST /api/checkpoint 的驗證都用這個），只有
        # 這裡、真正要送進 ComfyUI 的最後一刻才組成它要的相對路徑。
        wf[ckpt_node]["inputs"]["ckpt_name"] = f"{DARKROOM_CHECKPOINT_ROOT.name}\\{STATE['checkpoint']}"


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
_GEN_STATUS_MAX = 500  # _gen_status 獨立上限——面板長開、抽卡/生成次數遠多於 _GEN_MAX
                        # 能保留的圖片結果數，不能只靠 _gen_results 滿了才連帶清，否則
                        # 無限增長（尤其是 error/cancelled 那些從不進 _gen_results 的紀錄）


def _evict_gen_status_locked():
    """呼叫端須已持有 _gen_lock。只清已結束的（pending 還在等前端輪詢/使用者取消，
    不能清），FIFO 砍到剩 _GEN_STATUS_MAX 筆。"""
    if len(_gen_status) <= _GEN_STATUS_MAX:
        return
    for gid in list(_gen_status.keys()):
        if len(_gen_status) <= _GEN_STATUS_MAX:
            break
        if _gen_status[gid].get("status") in ("done", "error", "cancelled"):
            _gen_status.pop(gid, None)

# ---------------------------------------------------------------------------
# 2026-08 lora-manager 整合：LoRA Manager（standalone、獨立埠，見 ../lora-manager/）
# 點「送到 workflow」時，因為 standalone 模式本來就連不到真正的 ComfyUI 網頁（那條路
# 是靠同源 LiteGraph 即時改節點，見 lora-manager/VENDORED.md），改成直接 POST 這裡，
# 暗房前端輪詢偵測到新版本就自動選進生圖大面板。單一 slot（不排隊、後到蓋掉先到）——
# 這是「推進目前開著的分頁」的單次動作，不是佇列。
_lora_push = {"ver": 0, "data": None}   # {"ver": int, "data": {"folder","name"}|None}
_lora_push_lock = threading.Lock()
# 開機 epoch：ver 只存在記憶體、伺服器一重啟就歸零，但瀏覽器 localStorage 記的
# 「已看過的版本號」不會跟著清掉——重啟後新推送的 ver（1、2、3…）永遠小於瀏覽器
# 記住的舊版本號，於是被永久當成「已看過」而略過（真實發生過：伺服器重啟後三次
# 推送都收到了、前端卻完全沒反應）。epoch 每次啟動都不同，前端發現 epoch 變了
# 就知道「這是新的伺服器行程，舊版本號作廢」，見 darkroom.js pollLoraPush。
_lora_push_epoch = uuid.uuid4().hex


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
        if u.scheme == "https":
            # base 是 https（例如 RunPod 代理）時，ComfyUI 那端的 TLS 是代理終結的，
            # 這個原始 socket 沒包 TLS 會直接對著加密流量做明文 HTTP 握手，保證失敗
            # （退化成純輪詢，看不到即時預覽）。本機 http://127.0.0.1 不受影響。
            ctx = ssl.create_default_context()
            sock = ctx.wrap_socket(sock, server_hostname=host)
        sock.settimeout(max(60.0, float(timeout)))
        key = base64.b64encode(os.urandom(16)).decode()
        auth_line = ""
        if u.username:
            userinfo = u.username + (f":{u.password}" if u.password else "")
            auth_line = "Authorization: Basic " + base64.b64encode(userinfo.encode("utf-8")).decode("ascii") + "\r\n"
        req = (f"GET /ws?clientId={client_id} HTTP/1.1\r\nHost: {host}:{port}\r\n"
               "Upgrade: websocket\r\nConnection: Upgrade\r\n"
               "User-Agent: darkroom-preview-ui/1.0\r\n"
               f"{auth_line}"
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


def _gen_one_worker(gid, rel, loras, trigger, wait_for=None, mark_started=None):
    # wait_for/mark_started 串成一條鏈，逼 gen_sem 照 rels 的順序被搶到——不然多張同時
    # 起的 thread 搶同一個 semaphore，OS 排程先讓誰醒來沒有保證順序，抽卡偶爾會變成
    # 「牌面 1 還在等、牌面 2 先開始跑」，使用者感覺像「從第二張開始生圖」。見
    # start_gen() 呼叫端怎麼串起這條鏈。
    if wait_for is not None:
        wait_for.wait()
    with gen_slot(0):
        if mark_started is not None:
            mark_started.set()      # 讓下一張現在才開始搶 gen_sem，保證搶到的順序＝排隊順序
        # 排在信號量後面等的那幾張，若在等待期間被取消（該分頁刷新/關閉）就別再送出去
        if _gen_cancelled(gid):
            with _gen_lock:
                if _gen_status.get(gid, {}).get("status") == "pending":
                    _gen_status[gid].update(status="cancelled")
            plog(f"[genmode] 略過（已取消）{rel}")
            return
        try:
            if not ensure_comfy_base():
                raise RuntimeError("ComfyUI 未連線")
            # rel 可以是空字串——Concepts 抽卡「不抽詞庫模板」時就是這樣：沒有場景模板，
            # positive 只有品質標籤（build_prompt([],[]）留下的固定開頭）+ LoRA 的 trigger，
            # negative 只有 DEFAULT_NEG（build_negative([]) 的行為）。
            if rel:
                py = py_of(rel)
                req, pos, neg = load_lib(py)
                positive = build_prompt(req, pos)
                negative = build_negative(neg)
                prefix = f"genmode/{py.stem}"[:180]
            else:
                positive = build_prompt([], [])
                negative = build_negative([])
                prefix = "genmode/concepts"
            if trigger:
                positive = (positive + ", " + trigger) if positive else trigger
            seed = random.randint(0, 2**63 - 1)
            wf = prepare_workflow(STATE["template"], positive=positive, negative=negative,
                                  seed=seed, filename_prefix=prefix,
                                  steps=STATE["steps"])
            apply_checkpoint_override(wf)
            # loras 是 0~2 筆 (lora_name, strength)；inject_lora 每呼叫一次都會把「目前
            # 所有吃 checkpoint model/clip 輸出的節點」重新接到新插的 LoraLoader，所以連
            # 呼叫兩次會自動疊成一條鏈（ckpt → LoraLoader2 → LoraLoader1 → 其餘節點），
            # 不用另外改 inject_lora 本身去處理「串接第二個」這件事。
            for lora_name, strength in loras:
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
            threading.Thread(target=_score_gen_result, args=(gid, data), daemon=True).start()
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


def _score_gen_result(gid: str, img_bytes: bytes):
    """抽卡/生圖模式的背景評分：只附進 _gen_status[gid]["score"]，不寫側檔——
    這條路徑的結果本來就只存在記憶體（_gen_results），評分自然也只是暫時的。"""
    with _score_sem:
        result = _score_image_bytes(img_bytes)
    if result:
        with _gen_lock:
            if gid in _gen_status:
                _gen_status[gid]["score"] = result


def _convert_loras(loras_in):
    """把前端送來的 loras（陣列，每筆 {folder, file, strength}）轉成 _gen_one_worker 要的
    [(lora_name, strength), …]（0~2 筆）。folder 現在可能是子資料夾的完整路徑，用 "/"
    分隔（list_loras() 用 as_posix() 產生）；但 ComfyUI 認的 lora_name 是全部用 "\\"
    分隔的相對路徑（Windows 上 os.sep）。folder 只有一段（無子資料夾）時 replace 是
    no-op；有子資料夾時才需要這次轉換，不然會變成 "Character/Hanime\\file.safetensors"
    正反斜線混用，ComfyUI 找不到這個檔名，生成整批 400 Bad Request。"""
    if not isinstance(loras_in, list):
        return []
    out = []
    for lora in loras_in[:2]:
        lora = lora or {}
        if not lora.get("file"):
            continue
        folder = (lora.get("folder") or "").replace("/", "\\")
        lname = (folder + "\\" + lora["file"]) if folder else lora["file"]
        try:
            strength = float(lora.get("strength", 0.8))
        except Exception:
            strength = 0.8
        out.append((lname, strength))
    return out


def _default_trigger_for_loras(loras_in) -> str:
    """把 loras_in（/api/agent-draw 用的原始 {folder,file,strength} 陣列，_convert_loras
    轉換之前那個格式）裡每個 LoRA 的觸發詞（civitai.trainedWords）串成一句話。

    這是為了讓 agent-draw 的行為跟面板一致：面板選 LoRA 時會自動把觸發詞帶進提示詞框
    （見 README「自動把該 LoRA 的觸發詞...帶進一個像提示詞的文字框」，list_loras()
    读的是同一個 metadata 欄位）。agent-draw 預設就套用一顆 LoRA
    （AGENT_DRAW_DEFAULT_LORAS），如果不比照面板的行為，這顆 LoRA需要觸發詞才生效的
    部分就會套用不到——只呼叫端明確給了 trigger 才不會走到這裡（見呼叫處）。"""
    if not isinstance(loras_in, list):
        return ""
    words = []
    for lora in loras_in[:2]:
        lora = lora or {}
        file = lora.get("file")
        if not file:
            continue
        stem = file[:-len(".safetensors")] if file.endswith(".safetensors") else file
        meta_path = LORA_ROOT / (lora.get("folder") or "") / (stem + ".metadata.json")
        if not meta_path.is_file():
            continue
        try:
            md = json.loads(meta_path.read_text(encoding="utf-8"))
            raw_words = (md.get("civitai") or {}).get("trainedWords") or []
            words.extend(_strip_angle_tags(w) for w in raw_words if w)
        except Exception:
            pass
    return ", ".join(w for w in words if w)


def _job_display_name(rel, loras):
    """算這個生成工作在圖庫/塔羅卡片上要顯示的名字。有 rel（詞庫模板）就用它的檔名；
    沒有（Concepts 抽卡「不抽詞庫模板」時）就退而求其次，把用到的 LoRA 檔名接起來，
    至少讓使用者看得出這張是哪個組合、不是一片空白。"""
    if rel:
        try:
            return strip_rarity(py_of(rel).stem)
        except Exception:
            return rel
    names = [Path(n).stem for n, _ in loras if n]
    return " + ".join(names) if names else "(無)"


def start_gen(jobs, client=""):
    """為每筆 job 各自起背景生成，回傳 [{id, rel, name}]（gen_sem 限併發）。
    job 格式：{"rel": str（可為空字串，見 _gen_one_worker）, "loras": [(lora_name, strength)…]
    （0~2 筆）, "trigger": str}——每筆完全獨立，不像舊版整批共用同一組 loras/trigger，
    Concepts 抽卡（每張卡各自隨機配對不同 LoRA）需要這個彈性。client 記錄是哪個分頁送的，
    供該分頁刷新/關閉時只取消自己這批（見 cancel_client_gen）。"""
    out = []
    prev_started = None   # 第一張不用等任何人
    for job in jobs:
        rel = job.get("rel") or ""
        loras = job.get("loras") or []
        trigger = job.get("trigger") or ""
        gid = os.urandom(6).hex()
        name = _job_display_name(rel, loras)
        with _gen_lock:
            _gen_status[gid] = {"status": "pending", "rel": rel, "name": name, "err": "",
                                "pv": 0, "cancel": False, "pid": "", "client": client}
            _evict_gen_status_locked()
        out.append({"id": gid, "rel": rel, "name": name})
        my_started = threading.Event()
        threading.Thread(target=_gen_one_worker,
                         args=(gid, rel, loras, trigger, prev_started, my_started),
                         daemon=True).start()
        prev_started = my_started
    return out


def _cancel_gen(pred, label):
    """共用的取消邏輯：pred(gid, status_dict) 決定哪些還在途的生圖要取消。等信號量的那幾張
    標記 cancel 就不會送出；已排進 ComfyUI 的請 ComfyUI 移除排隊中的、並中斷正在跑的。
    label 只用來寫 log，說明這次取消的範圍（哪個分頁／哪一批／全部）。"""
    pids = []
    with _gen_lock:
        for gid, s in _gen_status.items():
            if s.get("status") == "pending" and pred(gid, s):
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
                http_json("POST", f"{base}/interrupt", {}, timeout=10)         # 正在跑的是這批的才中斷
        except Exception as e:
            plog(f"[genmode] 取消時通知 ComfyUI 失敗：{e}")
    plog(f"[genmode] 取消{label}（{len(pids)} 筆已在 ComfyUI）")
    return len(pids)


def cancel_client_gen(client):
    """只取消某個分頁（client）自己還在途的生圖，別動別的分頁、也不誤傷同時在跑的批次預覽
    生成。分頁刷新/關閉時由 sendBeacon 打（見 darkroom.js pagehide）。client 空字串則不做任何事。"""
    if not client:
        return 0
    return _cancel_gen(lambda gid, s: s.get("client") == client, f"分頁 {client[:8]} 的在途生圖")


def cancel_gen_ids(ids):
    """只取消這組 gid（抽卡生圖某一批，或圖庫「取消全部」時傳目前所有還在途的 gid）——
    跟 cancel_client_gen 不同的是不管 client，只認 gid 本身；抽卡疊層的「取消」鈕只想
    停掉正在看的這批，不該連使用者更早抽的其他批次（還在圖庫背景跑）也一起停掉。"""
    if not ids:
        return 0
    idset = set(ids)
    return _cancel_gen(lambda gid, s: gid in idset, f"指定的 {len(idset)} 筆生圖")


class _QuietThreadingHTTPServer(ThreadingHTTPServer):
    """跟 ThreadingHTTPServer 一樣,只是客戶端斷線（ConnectionReset/Aborted/BrokenPipe）
    不印整串 traceback——手機瀏覽器切背景、網路切換、頁面關掉時中斷 keep-alive 連線
    很常見,對面板本身無害（每個請求本來就在自己的 thread 裡處理,不影響其他連線),
    但預設的 handle_error() 每次都會把完整 traceback 印到主控台,長時間掛機使用時
    是最吵的雜訊來源。真正未預期的例外還是照樣印,只是換成不帶 traceback 的一行。"""

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            plog(f"[serve] 連線中斷（{client_address[0]}）：{type(exc).__name__}")
            return
        super().handle_error(request, client_address)


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
def _in_cgnat(ip: str) -> bool:
    """是否落在 Tailscale 用的 100.64.0.0/10。"""
    try:
        parts = ip.split(".")
        return parts[0] == "100" and 64 <= int(parts[1]) <= 127
    except (ValueError, IndexError):
        return False


def _client_allowed(ip: str) -> bool:
    """只放行本機（127.0.0.1／::1）與 Tailscale 來源（100.64.0.0/10），跟主面板
    serve.py 的 _client_allowed 同一套邏輯——暗房沒有登入驗證，之前綁 0.0.0.0
    誰都能連，跟面板比起來風險不對稱（都能操控 ComfyUI 生圖），統一收斂成同一
    條門檻。原生直接在 Windows 上跑（不經 Docker），client_address 本來就是
    Tailscale 介面給的真實來源 IP，不用另外處理。"""
    if ip in ("127.0.0.1", "::1"):
        return True
    return _in_cgnat(ip)


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.1 → 開 keep-alive：瀏覽器重用連線，不再每張縮圖/圖片都重開 TCP 握手。
    # 這是跟 Jellyfin/Stash 載入順暢度最大的差別（它們是 keep-alive/HTTP2）。所有回應
    # 都有 Content-Length（304 無 body），符合 keep-alive 的前提。
    protocol_version = "HTTP/1.1"
    timeout = 30          # 閒置的 keep-alive 連線 30s 後關掉，不長期佔著執行緒

    def log_message(self, format, *args):
        pass

    _SLOW_REQUEST_LOG_SEC = 0.5   # 遠端連線的「有時候很卡」一直是猜的，沒有實際數字可查——
                                   # 這裡包住 handle_one_request()（BaseHTTPRequestHandler
                                   # 每個請求都會經過的單一入口，不用動 do_GET/do_POST 本體）
                                   # 記下處理時間，超過門檻才印，之後真的卡的時候直接看記錄
                                   # 就有「哪個來源 IP、哪個 path、卡了幾秒」可查，不用再猜。

    def handle_one_request(self):
        t0 = time.time()
        super().handle_one_request()
        dt = time.time() - t0
        # keep-alive 連線閒置等下一個請求、真的等到 self.timeout（30s）逾時關閉，也會
        # 讓這個函式跑滿 30 秒——那不是「請求很慢」，是「根本沒有新請求進來」（等待期間
        # socket.timeout 直接跳出，self.command/self.path 不會被更新到新值）。用「耗時
        # 是不是卡在 timeout 邊界」濾掉這種誤報，不然每次連線閒置逾時都會被當成一筆假的
        # 慢請求記錄下來，混淆真正的資料。
        if self._SLOW_REQUEST_LOG_SEC <= dt < self.timeout - 0.5:
            plog(f"[慢請求] {self.client_address[0]} {getattr(self, 'command', '?')} "
                 f"{getattr(self, 'path', '?')} — {dt:.2f}s")

    def _blocked(self) -> bool:
        """來源 IP 不在白名單就直接斷線、不回應（跟 serve.py 面板一致的行為，
        不回 403 body 是刻意的——沒有登入驗證的服務，連「這裡有東西」都不該讓
        掃描者知道)。回傳 True 時呼叫端要立刻 return，不要再往下處理。"""
        if _client_allowed(self.client_address[0]):
            return False
        try:
            self.connection.close()
        except OSError:
            pass
        return True

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
        if self._blocked():
            return
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
                    "comfy": ensure_comfy_base(),
                    "steps": STATE["steps"],
                    "special_dir": str(SPECIAL_DIR),
                })
                return
            if u.path == "/api/tag_search":
                q = qs.get("q", [""])[0]
                query_tags = [t.lower() for t in split_tags([q])]
                if not query_tags:
                    self._send_json({"rels": []})
                    return
                idx = get_tag_index(force=qs.get("force", [""])[0] == "1")
                rels = [rel for rel, tags in idx.items() if all(t in tags for t in query_tags)]
                self._send_json({"rels": rels, "tags": query_tags})
                return
            if u.path == "/api/thumb":
                rel = qs.get("rel", [""])[0]
                img = find_image(py_of(rel))
                if img is None:
                    self._send_bytes(b"not found", "text/plain", 404)
                    return
                data, etag = make_thumb(img, thumb_size_for(qs.get("w", [""])[0]))
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
            if u.path == "/api/score":
                # 給前端在瀏覽模式生成完成後短暫輪詢用：評分是 do_generate() 完成後
                # 另起的背景 thread（見 _score_and_persist），job.status 變 done 的
                # 當下分數通常還沒算完，這支端點讓前端不用整份 /api/libs 重抓就能
                # 問「這張到底評完了沒」。單筆查表，成本可忽略。
                self._send_json({"score": get_score(qs.get("rel", [""])[0])})
                return
            if u.path == "/api/batch_status":
                self._send_json(get_batch())
                return
            if u.path == "/api/loras":
                self._send_json(list_loras())
                return
            if u.path == "/api/checkpoints":
                try:
                    items = sorted(p.name for p in DARKROOM_CHECKPOINT_ROOT.glob("*.safetensors"))
                except OSError:
                    items = []
                self._send_json({"items": items, "current": STATE.get("checkpoint")})
                return
            if u.path == "/api/lora-preview":
                p = lora_preview_path(qs.get("folder", [""])[0], qs.get("file", [""])[0])
                if p is None:
                    self._send_bytes(b"not found", "text/plain", 404)
                    return
                # 這支端點以前直接把原始檔案整包送出去——「.preview.png」這種命名很
                # 唬人，實際上很多是使用者從 CivitAI 存下來的原圖，3~7MB 稀鬆平常。
                # 前端只拿去當小預覽格（列表縮圖、抽卡牌面、hover tip），沒有任何地方
                # 需要原始解析度，實測遠端連線同時載幾個這種檔案就會把頻寬擠爆，個別
                # 請求卡到 10~20 秒——真正瓶頸不是併發數，是檔案本身太大。跟暗房自己
                # 圖庫縮圖共用 make_thumb()，縮完通常只剩幾十 KB。影片（.mp4/.webm）
                # Pillow 縮不了，本來就不大（實測 ~700KB 級別），維持原樣直送。
                if p.suffix.lower() in (".mp4", ".webm"):
                    ctype = mimetypes.guess_type(str(p))[0] or "video/mp4"
                    st = p.stat()
                    etag = hashlib.sha1(f"{p}|{int(st.st_mtime)}|{st.st_size}".encode("utf-8")).hexdigest()
                    self._send_cacheable(p.read_bytes(), ctype, etag)
                    return
                data, etag = make_thumb(p, thumb_size_for(qs.get("w", [""])[0]))
                ctype = "image/webp" if _HAS_PIL else (mimetypes.guess_type(str(p))[0] or "image/png")
                self._send_cacheable(data, ctype, etag)
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
            if u.path == "/api/score-backfill-status":
                with STATE["score_backfill_lock"]:
                    self._send_json(dict(STATE["score_backfill"]))
                return
            if u.path == "/api/lora-push":
                # 前端每 ~1s 輪詢一次；帶 since 才回新資料，版本沒變就只回 ver（省流量）。
                since = int(qs.get("since", ["0"])[0] or 0)
                with _lora_push_lock:
                    ver, data = _lora_push["ver"], _lora_push["data"]
                out = {"ver": ver, "epoch": _lora_push_epoch}
                if ver > since:
                    out["data"] = data
                self._send_json(out)
                return
            self._send_bytes(b"not found", "text/plain", 404)
        except Exception as e:
            self._send_json({"error": f"{type(e).__name__}: {e}"}, 500)

    def do_OPTIONS(self):
        if self._blocked():
            return
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
        if self._blocked():
            return
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
            if u.path == "/api/score-backfill":
                with STATE["score_backfill_lock"]:
                    if STATE["score_backfill"]["running"]:
                        self._send_json({"ok": True, "already_running": True})
                        return
                if not _score_service_available():
                    self._send_json({"error": "waifu-score 服務未啟動，請先執行 run.bat"}, 400)
                    return
                threading.Thread(target=run_score_backfill, daemon=True).start()
                plog("[score-backfill] 已由前端觸發")
                self._send_json({"ok": True, "started": True})
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
            if u.path == "/api/checkpoint":
                file = data.get("file") or ""
                try:
                    valid = {p.name for p in DARKROOM_CHECKPOINT_ROOT.glob("*.safetensors")}
                except OSError:
                    valid = set()
                if file not in valid:
                    self._send_json({"error": "不在允許的 checkpoint 清單裡"}, 400)
                    return
                STATE["checkpoint"] = file
                _save_checkpoint_to_config(file)
                plog(f"[checkpoint] 生圖模式底模設為 {file}")
                self._send_json({"ok": True, "checkpoint": file})
                return
            if u.path == "/api/gen":
                # 生圖模式：對選中的詞庫套 LoRA 背景生成，結果進 _gen_results（不覆蓋詞庫預覽）。
                # 兩種送法：① jobs（陣列，每筆各自 rel/loras/trigger，互不相同）——Concepts
                # 抽卡用，每張卡隨機配對不同 LoRA；② 舊版 rels + 共用 loras/trigger——一般
                # 抽卡生圖／手動生圖，整批套同一組 LoRA。start_gen() 底層統一吃 jobs 陣列。
                jobs_in = data.get("jobs")
                if isinstance(jobs_in, list) and jobs_in:
                    jobs = []
                    for j in jobs_in[:64]:
                        j = j or {}
                        jobs.append({
                            "rel": str(j.get("rel") or ""),
                            "loras": _convert_loras(j.get("loras")),
                            "trigger": (j.get("trigger") or "").strip(),
                        })
                else:
                    rels = data.get("rels") or []
                    if not isinstance(rels, list) or not rels:
                        self._send_json({"error": "沒有選取詞庫"}, 400)
                        return
                    # 雙 LoRA：loras 是 0~2 筆 {folder, file, strength}（LoRA 2 常留空，前端只送
                    # 有選的格子，見 darkroom.js runGen）。
                    loras = _convert_loras(data.get("loras"))
                    if not loras and data.get("lora"):
                        loras = _convert_loras([data.get("lora")])   # 舊格式相容（單一 lora 物件）
                    trigger = (data.get("trigger") or "").strip()
                    jobs = [{"rel": r, "loras": loras, "trigger": trigger} for r in rels[:64]]
                if not jobs:
                    self._send_json({"error": "沒有可生成的項目"}, 400)
                    return
                client = (data.get("client") or "")[:64]
                items = start_gen(jobs, client)
                # jobs 陣列時（Concepts 抽卡）每筆 LoRA 可能都不同，log 只印第一筆當樣本＋
                # 總筆數，不然一次列出 8 組會洗版；舊版 rels+共用 loras 全部 job 的 loras
                # 本來就相同，印第一筆等於印全部。
                first_desc = "、".join(f"{n}@{s}" for n, s in jobs[0]["loras"]) or "(無)"
                sample = first_desc if len(jobs) == 1 else f"{first_desc}（等 {len(jobs)} 筆，各自可能不同）"
                plog(f"[genmode] 起 {len(items)} 張 · lora={sample}")
                self._send_json({"ok": True, "items": items})
                return
            if u.path == "/api/agent-draw":
                # 給只能打 HTTP API（function calling）、不能看整份 /api/libs 的外部 agent
                # 用的「抽卡」端點——把隨機挑選這一步搬進伺服器端做，agent 只需要送一個小
                # 請求、收一個小回應，不用把 27000+ 筆詞庫塞進自己的 context 才能挑。
                # 語意等同 darkroom.js 的 tarotPool() + drawTarot()：從「有圖、未標稀有度」
                # 的池子（或指定 folder/rarity）隨機不重複抽 n 張，直接送生成。
                try:
                    n = int(data.get("n") or 8)
                except (TypeError, ValueError):
                    n = 8
                n = max(1, min(n, 32))   # 上限只是防呆（避免打錯字打成幾千張），不是使用限制——
                                          # 每張都要真的排隊生成，n 隨便講都行，但別超過這個
                folder = data.get("folder") or None
                rarity = data.get("rarity") or None
                pool = scan_libraries()
                if folder is not None:
                    pool = [x for x in pool if (x.get("folder") or "(根目錄)") == folder]
                if rarity is not None:
                    pool = [x for x in pool if x.get("rarity") == rarity]
                else:
                    pool = [x for x in pool if x.get("has_image") and not x.get("rarity")]
                if not pool:
                    self._send_json({"error": "候選池是空的（folder/rarity 篩選太窄，或詞庫還沒生過圖）"}, 400)
                    return
                seed = data.get("seed")
                rng = random.Random(seed) if seed is not None else random
                picks = rng.sample(pool, k=min(n, len(pool)))
                # 沒帶 loras 這個欄位＝用預設畫風 LoRA；帶了（就算是空陣列）＝照 agent 說的走，
                # 這樣 agent 想抽「不套 LoRA」時傳 "loras": [] 才有辦法明確表達。
                loras_in = data["loras"] if "loras" in data else AGENT_DRAW_DEFAULT_LORAS
                loras = _convert_loras(loras_in)
                trigger = (data.get("trigger") or "").strip()
                if not trigger:
                    # 呼叫端沒明確給 trigger 才自動帶入 LoRA 的觸發詞——跟面板選 LoRA
                    # 的行為一致（見 _default_trigger_for_loras 的說明）。
                    trigger = _default_trigger_for_loras(loras_in)
                jobs = [{"rel": p["rel"], "loras": loras, "trigger": trigger} for p in picks]
                client = (data.get("client") or "agent")[:64]
                items = start_gen(jobs, client)
                lora_desc = "、".join(f"{n_}@{s}" for n_, s in loras) or "(無)"
                plog(f"[agent-draw] 抽 {len(items)} 張 · folder={folder or '(全部)'} · rarity={rarity or '(預設池)'} · lora={lora_desc} · trigger={trigger or '(無)'}")
                # 把實際套用的 loras 一起回傳——呼叫端沒帶 loras 時套的是伺服器端的
                # AGENT_DRAW_DEFAULT_LORAS，呼叫端不該自己重複那份預設值才知道套了
                # 什麼（例如組 Discord embed 要顯示 LoRA 名稱時），單一事實來源在這裡。
                self._send_json({"ok": True, "items": items, "loras": [[n_, s] for n_, s in loras]})
                return
            if u.path == "/api/gen-cancel":
                # 帶 ids（陣列）＝只取消這幾張——抽卡疊層的「取消」鈕（只停當批）、圖庫的
                # 「取消全部」鈕（傳目前所有還在途的 gid）都走這條。沒帶 ids 才退回舊行為：
                # 分頁刷新/關閉時 sendBeacon 打來，用 client 停掉這個分頁自己全部在途的生圖。
                ids = data.get("ids")
                if isinstance(ids, list) and ids:
                    n = cancel_gen_ids([str(i) for i in ids])
                else:
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
    STATE["gen_sem"] = PrioritySemaphore(STATE["concurrency"])

    checkpoint_cfg = cfg.get("checkpoint") or DARKROOM_DEFAULT_CHECKPOINT
    if (DARKROOM_CHECKPOINT_ROOT / checkpoint_cfg).is_file():
        STATE["checkpoint"] = checkpoint_cfg
        print(f"[checkpoint] 生圖模式底模：{checkpoint_cfg}")
    else:
        print(f"[checkpoint] 找不到 {checkpoint_cfg}（{DARKROOM_CHECKPOINT_ROOT}），"
              f"生圖模式沿用 workflow.json 原本內建的底模")
        STATE["checkpoint"] = None

    print(f"[workflow] {wf_path}")
    print(f"[special ] {SPECIAL_DIR}")
    print(f"[輸出    ] 存為 {OUT_EXT}(舊 png 仍可顯示)")
    print(f"[並發    ] 一次最多 {STATE['concurrency']} 張")
    STATE["comfy_pref"] = args.comfy
    print(f"[comfy   ] 探測 {args.comfy} ...")
    try:
        STATE["comfy_base"] = resolve_comfy_base(args.comfy)
        print(f"[comfy   ] OK → {STATE['comfy_base']}")
    except Exception as e:
        print(f"[comfy   ] 連不上:{e}")
        print("[comfy   ] UI 仍會啟動,之後 ComfyUI 開起來會自動接上,不用重開暗房")
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
    _load_scores()                # 載入卡片評分側檔（依 dataset 分檔）
    srv = _QuietThreadingHTTPServer((bind_host, port), Handler)
    # 開機就先在背景把詞庫掃一遍暖快取（第一次開頁的 /api/libs 才不用等 ~1s 掃描），
    # 順便把圖庫縮圖／LoRA 預覽縮圖也全部跑過一輪暖好，見 _warm_all_thumbs() 說明。
    threading.Thread(target=_warm_all_thumbs, daemon=True).start()
    # 標籤索引同一招暖快取：不暖的話，第一次有人用「搜尋標籤」要現場建索引
    # （25744 個檔案實測約 3.3~4.8s），使用者會覺得標籤搜尋「第一次特別慢」。
    threading.Thread(target=lambda: get_tag_index(), daemon=True).start()
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
