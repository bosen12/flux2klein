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
import hashlib
import io
import json
import random
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
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


# --- 縮圖快取 -------------------------------------------------------------
THUMB_MAX = 360           # 縮圖最長邊(px);格子 ~180px @2x DPR 剛好
THUMB_QUALITY = 72
THUMB_DIR = Path(__file__).resolve().parent / ".thumb_cache"
_thumb_locks: dict[str, threading.Lock] = {}
_thumb_locks_guard = threading.Lock()


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
        with Image.open(src) as im:
            im = im.convert("RGB")
            im.thumbnail((THUMB_MAX, THUMB_MAX), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, format="WEBP", quality=THUMB_QUALITY, method=4)
        data = buf.getvalue()
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


def scan_libraries() -> list[dict]:
    items = []
    for py in gsp.iter_libraries(None):
        img = find_image(py)
        rel = rel_of(py)
        items.append({
            "rel": rel,
            "name": py.stem,
            "folder": py.parent.name if py.parent != SPECIAL_DIR else "",
            "has_image": img is not None,
            "image_mtime": int(img.stat().st_mtime) if img else 0,
            "job": get_job(rel),
        })
    return items


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
                do_generate(rel)
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

    n = max(1, int(STATE["concurrency"]))
    threads = [threading.Thread(target=worker, daemon=True) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    set_batch(running=False, running_rels=[])


def do_generate(rel: str, seed: int | None = None):
    if not STATE["comfy_base"]:
        set_job(rel, "error", "ComfyUI 未連線")
        return
    with STATE["gen_sem"]:
        try:
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
            dt = time.time() - t0
            set_job(
                rel,
                "done",
                f"完成 · {dt:.1f}s · {len(img_bytes)//1024}KB · seed={seed}",
            )
        except Exception as e:
            set_job(rel, "error", f"{type(e).__name__}: {e}")
            traceback.print_exc()


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def _send_json(self, obj, code: int = 200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, body: bytes, content_type: str = "application/octet-stream", code: int = 200):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

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
            if u.path == "/":
                self._send_bytes(INDEX_HTML.encode("utf-8"), "text/html; charset=utf-8")
                return
            if u.path == "/api/libs":
                self._send_json({
                    "items": scan_libraries(),
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
            self._send_bytes(b"not found", "text/plain", 404)
        except Exception as e:
            self._send_json({"error": f"{type(e).__name__}: {e}"}, 500)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            data = {}
        try:
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
# HTML
# ---------------------------------------------------------------------------
INDEX_HTML = r"""<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>詞庫暗房 · Special Prompts</title>
<style>
/* ── 暗房安全燈 palette ───────────────────────────────────────── */
:root {
  color-scheme: dark;
  /* 沖淡的暗房：近黑提亮成藍調炭色，少了純黑的硬，多了層次 */
  --bg:      #181920;   /* 底 */
  --panel:   #1f212b;   /* 面板 */
  --rail:    #1b1d26;   /* 導覽列 */
  --sunk:    #141520;   /* 凹陷/縮圖底 */
  --line:    #2e3140;   /* 分隔線 */
  --line-2:  #3a3e50;   /* 強調分隔 */
  --ink:     #eeece4;   /* 暖白文字 */
  --dim:     #a2a8b8;   /* 次要文字 */
  --faint:   #676c7e;   /* 更淡 */
  --amber:   #eaad57;   /* 安全燈琥珀 = 品牌/已曝光 */
  --amber-d: #c08a35;
  --amber-soft: rgba(234,173,87,.14);
  --ok:      #6fd39a;
  --run:     #eaad57;
  --err:     #f0796d;
  --focus:   #eaad57;
  --mono: ui-monospace, "Cascadia Code", "Cascadia Mono", Consolas, "Roboto Mono", monospace;
  --sans: -apple-system, "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif;
  --radius: 13px;
  --shadow: 0 12px 34px -8px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.35);
  /* motion tokens */
  --ease-out: cubic-bezier(.22,.61,.36,1);   /* 柔和加速、緩降落定 */
  --ease-in:  cubic-bezier(.4,0,1,1);
  --d-micro: 140ms;   /* hover/press */
  --d-ui:    220ms;   /* 狀態切換 */
  --d-pop:   280ms;   /* modal/popover */
  --d-enter: 440ms;   /* 卡片入場 */
}
@keyframes cardIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes modalPop { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes railIn { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: none; } }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; font-family: var(--sans); background: var(--bg); color: var(--ink);
       display: flex; flex-direction: column; overflow: hidden; }
::selection { background: rgba(230,163,74,.28); }

/* focus 一律可見 */
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 6px; }

button, input, select { font-family: inherit; }
button { cursor: pointer; background: #21232c; color: var(--ink); border: 1px solid var(--line);
         padding: 7px 12px; border-radius: 8px; font-size: 13px; transition: background .12s, border-color .12s; }
button:hover:not(:disabled) { background: #2a2d38; border-color: #3a3d49; }
button:disabled { opacity: .45; cursor: not-allowed; }
button.primary { background: linear-gradient(180deg, #eaad57, var(--amber-d)); border-color: var(--amber-d);
                 color: #241a08; font-weight: 650; }
button.primary:hover:not(:disabled) { filter: brightness(1.06); }
button.ghost { background: transparent; border-color: var(--line); color: var(--dim); }
button.danger { color: #ffd9d3; border-color: #5a2e2a; background: #2a1a18; }
input[type=text] { background: var(--sunk); color: var(--ink); border: 1px solid var(--line);
                   padding: 8px 12px 8px 30px; border-radius: 8px; font-size: 13px; }
input[type=text]::placeholder { color: var(--faint); }

/* ── 頂欄 ─────────────────────────────────────────────────────── */
.topbar { flex: none; display: flex; align-items: center; gap: 14px; padding: 11px 18px;
          background: linear-gradient(180deg, var(--panel), color-mix(in srgb, var(--panel) 92%, #000));
          border-bottom: 1px solid var(--line);
          box-shadow: 0 1px 0 rgba(255,255,255,.02) inset, 0 6px 20px -12px rgba(0,0,0,.6); }
.brand { display: flex; align-items: baseline; gap: 9px; }
.brand .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--amber);
              box-shadow: 0 0 10px 1px rgba(230,163,74,.6); transform: translateY(-1px); }
.brand h1 { font-size: 15px; margin: 0; font-weight: 650; letter-spacing: .3px; }
.brand .sub { font-family: var(--mono); font-size: 11px; color: var(--faint); letter-spacing: .5px; }
.search-wrap { position: relative; flex: 1; max-width: 420px; }
.search-wrap svg { position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
                   width: 14px; height: 14px; color: var(--faint); pointer-events: none; }
.search-wrap input { width: 100%; }
.spacer { flex: 1; }
.conn { font-family: var(--mono); font-size: 11px; color: var(--dim); display: flex; align-items: center; gap: 6px; }
.conn .led { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
.conn.on .led { background: var(--ok); box-shadow: 0 0 7px var(--ok); }

/* ── 主體 ─────────────────────────────────────────────────────── */
.body { flex: 1; display: flex; min-height: 0; }

/* 資料夾導覽列 */
.rail { flex: none; width: 264px; background: var(--rail); border-right: 1px solid var(--line);
        overflow-y: auto; padding: 8px; }
.rail-head { font-family: var(--mono); font-size: 10px; letter-spacing: 1.2px; text-transform: uppercase;
             color: var(--faint); padding: 8px 10px 6px; }
.rail-search { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 6px;
               background: var(--rail); padding: 4px 4px 8px; margin-bottom: 4px; }
.rail-search svg { width: 14px; height: 14px; color: var(--faint); flex: none; }
.rail-search input { flex: 1; min-width: 0; background: var(--sunk); border: 1px solid var(--line);
                     color: var(--ink); border-radius: 8px; padding: 6px 9px; font-size: 12.5px;
                     transition: border-color var(--d-micro) var(--ease-out), box-shadow var(--d-micro) var(--ease-out); }
.rail-search input:focus { outline: none; border-color: rgba(230,163,74,.55);
                           box-shadow: 0 0 0 3px rgba(230,163,74,.12); }
.rail-search button { flex: none; background: transparent; border: none; color: var(--faint);
                      font-size: 12px; padding: 2px 4px; }
.rail-search button:hover { color: var(--ink); }
.rail-empty { color: var(--faint); font-size: 12px; padding: 12px 10px; }
.folder { width: 100%; text-align: left; background: transparent; border: 1px solid transparent;
          border-radius: 10px; padding: 9px 11px; margin-bottom: 2px; display: block;
          transition: background var(--d-micro) var(--ease-out), border-color var(--d-micro) var(--ease-out); }
.folder.rin { animation: railIn var(--d-ui) var(--ease-out) both; }
.folder:hover { background: #1d1f27; }
.folder.active { background: #23252f; border-color: rgba(230,163,74,.35);
                 box-shadow: inset 2px 0 0 var(--amber); }
.folder-top { display: flex; align-items: baseline; gap: 8px; }
.folder-idx { font-family: var(--mono); font-size: 11px; color: var(--amber); flex: none; min-width: 20px; }
.folder-name { font-size: 13px; color: var(--ink); line-height: 1.3; word-break: break-all;
               overflow: hidden; text-overflow: ellipsis; }
.folder-count { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--faint); flex: none; }
.cover { height: 4px; border-radius: 3px; background: #24262f; margin-top: 7px; overflow: hidden; }
.cover > span { display: block; height: 100%; background: linear-gradient(90deg, var(--amber-d), var(--amber));
                border-radius: 3px; transition: width .3s ease; }
.cover.full > span { background: linear-gradient(90deg, #4f9e6d, var(--ok)); }

/* 內容區 */
.main { flex: 1; min-width: 0; overflow-y: auto; }
.main-head { position: sticky; top: 0; z-index: 5; background: linear-gradient(180deg, var(--bg) 82%, transparent);
             padding: 16px 20px 12px; display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
.main-title { display: flex; align-items: baseline; gap: 10px; }
.main-title .num { font-family: var(--mono); font-size: 13px; color: var(--amber); }
.main-title h2 { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: .2px; }
.main-sub { font-family: var(--mono); font-size: 12px; color: var(--dim); margin-top: 4px; }
.head-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.seg { display: inline-flex; background: var(--sunk); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button { border: 0; border-radius: 0; background: transparent; color: var(--dim); padding: 6px 12px; font-size: 12px; }
.seg button.on { background: #23252f; color: var(--ink); }
.seg button + button { border-left: 1px solid var(--line); }
.gen-group { display: inline-flex; align-items: center; gap: 6px; padding: 4px 6px 4px 10px;
             background: var(--sunk); border: 1px solid var(--line); border-radius: 10px; }
.gen-group .gen-label { font-family: var(--mono); font-size: 10px; letter-spacing: 1px; color: var(--faint); }
.gen-group button { padding: 5px 10px; font-size: 12px; }

/* 大覆蓋率條 */
.coverbar { margin: 0 20px 10px; height: 6px; border-radius: 4px; background: #1e2028; overflow: hidden; }
.coverbar > span { display: block; height: 100%; background: linear-gradient(90deg, var(--amber-d), var(--amber)); transition: width .35s; }

/* 卡片牆 */
.grid { display: grid; gap: 14px; padding: 6px 20px 40px;
        grid-template-columns: repeat(auto-fill, minmax(184px, 1fr)); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
        overflow: hidden; display: flex; flex-direction: column;
        transition: border-color var(--d-micro) var(--ease-out),
                    transform var(--d-micro) var(--ease-out),
                    box-shadow var(--d-micro) var(--ease-out);
        content-visibility: auto; contain-intrinsic-size: auto 260px; }
.card:hover { border-color: rgba(234,173,87,.5); transform: translateY(-4px);
              box-shadow: 0 14px 30px -8px rgba(0,0,0,.5), 0 0 0 3px var(--amber-soft); }
.card.missing { border-style: dashed; border-color: #34363f; }
.card.anim { animation: cardIn var(--d-enter) var(--ease-out) both; }
.thumb { aspect-ratio: 1/1; background: var(--sunk); cursor: pointer; overflow: hidden;
         display: flex; align-items: center; justify-content: center; position: relative; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block;
             transition: transform var(--d-ui) var(--ease-out); }
.card:hover .thumb img { transform: scale(1.04); }
.thumb .empty { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--faint); font-size: 12px; }
.thumb .empty svg { width: 26px; height: 26px; opacity: .5; }
.badge { position: absolute; top: 8px; left: 8px; font-family: var(--mono); font-size: 10px;
         padding: 2px 7px; border-radius: 20px; background: rgba(19,19,24,.82); backdrop-filter: blur(4px);
         border: 1px solid var(--line); color: var(--dim); }
.badge.has { color: var(--amber); border-color: rgba(230,163,74,.4); }
.card-body { padding: 9px 11px 4px; }
.card-name { font-size: 12.5px; font-weight: 550; word-break: break-all; line-height: 1.35; }
.card-folder { font-family: var(--mono); font-size: 10.5px; color: var(--faint); margin-top: 3px; }
.status { font-size: 10.5px; padding: 3px 11px 0; min-height: 15px; font-family: var(--mono); color: var(--faint);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status.queued, .status.running { color: var(--run); }
.status.done { color: var(--ok); }
.status.error { color: var(--err); }
.status.running::before { content: "◐ "; display: inline-block; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.card-actions { padding: 7px 11px 11px; }
.card-actions button { width: 100%; font-size: 12px; padding: 6px; }

.empty-state { padding: 80px 20px; text-align: center; color: var(--faint); }
.empty-state .big { font-size: 15px; color: var(--dim); margin-bottom: 6px; }

/* ── 大圖 modal ───────────────────────────────────────────────── */
.modal { position: fixed; inset: 0; background: rgba(8,8,11,.8); backdrop-filter: blur(6px);
         display: none; align-items: center; justify-content: center; z-index: 100; padding: 24px; }
.modal.open { display: flex; animation: fadeIn var(--d-pop) var(--ease-out); }
.modal-inner { max-width: 1040px; width: 100%; max-height: 92vh; overflow: auto; box-shadow: var(--shadow);
               background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 22px;
               display: grid; grid-template-columns: minmax(0,1.05fr) minmax(0,1fr); gap: 22px; }
.modal.open .modal-inner { animation: modalPop var(--d-pop) var(--ease-out) both; }
.modal-inner img { max-width: 100%; border-radius: 10px; background: #000; display: block; }
.no-image { aspect-ratio: 1/1; display: flex; align-items: center; justify-content: center;
            color: var(--faint); background: var(--sunk); border-radius: 10px; border: 1px dashed var(--line); }
.m-title { font-size: 17px; font-weight: 650; word-break: break-all; }
.m-folder { font-family: var(--mono); font-size: 12px; color: var(--amber); margin-top: 4px; }
.prompt-label { font-family: var(--mono); font-size: 10px; color: var(--faint); margin: 14px 0 5px;
                text-transform: uppercase; letter-spacing: 1px; }
.prompt-block { font-size: 12px; line-height: 1.6; color: #d4d0c8; background: var(--sunk); border: 1px solid var(--line);
                padding: 11px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }
.m-nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(19,19,24,.7);
         border: 1px solid var(--line); width: 40px; height: 56px; display: flex; align-items: center; justify-content: center;
         font-size: 20px; color: var(--ink); }
.m-nav.prev { left: 10px; } .m-nav.next { right: 10px; }

@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
@media (max-width: 860px) {
  .rail { position: fixed; z-index: 30; height: 100%; left: 0; top: 0; box-shadow: var(--shadow); transform: translateX(-100%); transition: transform .2s; }
  .rail.open { transform: none; }
  .modal-inner { grid-template-columns: 1fr; }
  .menu-btn { display: inline-flex !important; }
}
.menu-btn { display: none; }
</style>
</head>
<body>
<div class="topbar">
  <button class="menu-btn ghost" id="menu-btn" aria-label="開關資料夾列">☰</button>
  <div class="brand">
    <span class="dot"></span>
    <h1>詞庫暗房</h1>
    <span class="sub" id="total-tag">…</span>
  </div>
  <div class="search-wrap">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
    <input type="text" id="search" placeholder="跨資料夾搜尋名稱…" autocomplete="off">
  </div>
  <div class="spacer"></div>
  <button class="ghost" id="rescan" title="重新掃描">↻ 重掃</button>
  <div class="conn" id="conn"><span class="led"></span><span id="conn-text">…</span></div>
</div>

<div class="body">
  <nav class="rail" id="rail" aria-label="資料夾">
    <div class="rail-head">資料夾 · Chapters</div>
    <div class="rail-search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      <input type="text" id="folder-search" placeholder="搜尋資料夾…" autocomplete="off">
      <button id="folder-search-clear" aria-label="清除" title="清除" style="display:none;">✕</button>
    </div>
    <div id="rail-list"></div>
    <div id="rail-empty" class="rail-empty" style="display:none;">找不到符合的資料夾</div>
  </nav>

  <main class="main" id="main">
    <div class="main-head">
      <div>
        <div class="main-title"><span class="num" id="mt-num"></span><h2 id="mt-name">載入中…</h2></div>
        <div class="main-sub" id="mt-sub"></div>
      </div>
      <div class="head-actions">
        <div class="seg" id="view-seg" role="group" aria-label="篩選">
          <button data-v="all" class="on">全部</button>
          <button data-v="missing">缺圖</button>
          <button data-v="have">已有</button>
        </div>
        <div class="gen-group">
          <span class="gen-label">本頁</span>
          <button class="primary" id="gen-page-missing">補缺少</button>
          <button class="ghost" id="gen-page-all">全部重生</button>
        </div>
        <div class="gen-group">
          <span class="gen-label">全部</span>
          <button class="primary" id="gen-all-missing">補缺少</button>
          <button class="ghost" id="gen-all-regen">全部重生</button>
        </div>
        <button class="danger" id="batch-stop" style="display:none;">停止</button>
        <span class="conn" id="batch-progress" style="font-family:var(--mono);"></span>
      </div>
    </div>
    <div class="coverbar" id="coverbar"><span style="width:0"></span></div>
    <div id="grid" class="grid"></div>
  </main>
</div>

<div id="modal" class="modal">
  <button class="m-nav prev" id="m-prev" aria-label="上一個">‹</button>
  <div class="modal-inner" id="modal-inner"></div>
  <button class="m-nav next" id="m-next" aria-label="下一個">›</button>
</div>

<script>
let ALL = [];
let CUR_FOLDER = null;      // 目前選中的資料夾;null = 尚未選
let VIEW = 'all';           // all | missing | have
let SEARCH = '';
let RAIL_SEARCH = '';       // 資料夾側欄搜尋
let VISIBLE = [];           // 目前 grid 呈現的清單(供 modal 前後導覽)
const pollers = new Set();
const REDUCE_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = id => document.getElementById(id);

async function loadAll() {
  const r = await fetch('/api/libs');
  const j = await r.json();
  ALL = j.items;
  const conn = $('conn');
  conn.classList.toggle('on', !!j.comfy);
  $('conn-text').textContent = j.comfy ? `ComfyUI 就緒 · steps ${j.steps}` : 'ComfyUI 未連線';
  const total = ALL.length, have = ALL.filter(x => x.has_image).length;
  $('total-tag').textContent = `${have}/${total} 已生成`;
  if (CUR_FOLDER === null) {
    const folders = folderStats();
    CUR_FOLDER = folders.length ? folders[0].name : '';
  }
  buildRail();
  render();
  for (const it of ALL)
    if (it.job && (it.job.status === 'queued' || it.job.status === 'running')) pollStatus(it.rel);
}

function folderStats() {
  const map = new Map();
  for (const x of ALL) {
    const f = x.folder || '(根目錄)';
    if (!map.has(f)) map.set(f, { name: f, total: 0, have: 0 });
    const s = map.get(f); s.total++; if (x.has_image) s.have++;
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
}

let _railSig = '';
function buildRail() {
  const list = $('rail-list');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  const q = RAIL_SEARCH.toLowerCase();
  let stats = folderStats();
  if (q) stats = stats.filter(s =>
    s.name.toLowerCase().includes(q) ||
    s.name.replace(/^\d+[_\-\s]*/, '').toLowerCase().includes(q));
  $('rail-empty').style.display = stats.length ? 'none' : '';
  // 只有當「清單內容」變了(搜尋/首次)才播入場動畫;純切換 active 不重播
  const sig = stats.map(s => s.name).join('|');
  const animate = !REDUCE_MOTION && sig !== _railSig;
  _railSig = sig;
  stats.forEach((s, i) => {
    const pct = s.total ? Math.round(s.have / s.total * 100) : 0;
    const full = s.have === s.total && s.total > 0;
    const b = document.createElement('button');
    b.className = 'folder' + (s.name === CUR_FOLDER && !SEARCH ? ' active' : '');
    if (animate && i < 22) { b.classList.add('rin'); b.style.animationDelay = (i * 18) + 'ms'; }
    b.dataset.folder = s.name;
    const idx = /^\d+/.exec(s.name);
    b.innerHTML = `
      <div class="folder-top">
        <span class="folder-idx">${idx ? idx[0] : '·'}</span>
        <span class="folder-name"></span>
        <span class="folder-count">${s.have}/${s.total}</span>
      </div>
      <div class="cover${full ? ' full' : ''}"><span style="width:${pct}%"></span></div>`;
    b.querySelector('.folder-name').textContent = s.name.replace(/^\d+[_\-\s]*/, '') || s.name;
    b.onclick = () => { CUR_FOLDER = s.name; SEARCH = ''; $('search').value = ''; buildRail(); render(); $('main').scrollTop = 0; };
    frag.appendChild(b);
  });
  list.appendChild(frag);
}

function currentList() {
  let list;
  if (SEARCH) {
    const q = SEARCH.toLowerCase();
    list = ALL.filter(x => x.name.toLowerCase().includes(q) || (x.folder || '').toLowerCase().includes(q));
  } else {
    list = ALL.filter(x => (x.folder || '(根目錄)') === CUR_FOLDER);
  }
  if (VIEW === 'missing') list = list.filter(x => !x.has_image);
  else if (VIEW === 'have') list = list.filter(x => x.has_image);
  return list;
}

function render() {
  const list = currentList();
  VISIBLE = list;
  const total = list.length, have = list.filter(x => x.has_image).length;
  const pct = total ? Math.round(have / total * 100) : 0;

  if (SEARCH) {
    $('mt-num').textContent = '';
    $('mt-name').textContent = `搜尋:「${SEARCH}」`;
  } else {
    const idx = /^\d+/.exec(CUR_FOLDER || '');
    $('mt-num').textContent = idx ? idx[0] : '';
    $('mt-name').textContent = (CUR_FOLDER || '').replace(/^\d+[_\-\s]*/, '') || CUR_FOLDER || '—';
  }
  $('mt-sub').textContent = `${total} 個詞庫 · 已生成 ${have} · 缺 ${total - have} · 覆蓋率 ${pct}%`;
  $('coverbar').firstElementChild.style.width = pct + '%';

  const grid = $('grid');
  grid.innerHTML = '';
  if (_io) { _io.disconnect(); _io = null; }
  if (!total) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="big">這裡沒有符合的詞庫</div>換個資料夾或篩選條件</div>`;
    return;
  }
  _rendered = 0;
  appendPage();          // 先渲染第一頁
  if (_rendered < total) {
    const sentinel = document.createElement('div');
    sentinel.id = 'scroll-sentinel';
    sentinel.style.cssText = 'grid-column:1/-1;height:1px;';
    grid.appendChild(sentinel);
    _io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting) appendPage();
    }, { root: $('main'), rootMargin: '800px 0px' });   // 提前 800px 預載
    _io.observe(sentinel);
  }
}

const PAGE = 120;
let _rendered = 0, _io = null;

function appendPage() {
  const grid = $('grid');
  const slice = VISIBLE.slice(_rendered, _rendered + PAGE);
  if (!slice.length) return;
  const frag = document.createDocumentFragment();
  slice.forEach((it, p) => {
    const card = cardOf(it);
    // 入場動畫:每頁前 14 張做小 stagger,其餘直接顯示(避免長尾)
    if (!REDUCE_MOTION && p < 14) {
      card.classList.add('anim');
      card.style.animationDelay = (p * 34) + 'ms';
    }
    frag.appendChild(card);
  });
  const sentinel = $('scroll-sentinel');
  if (sentinel) grid.insertBefore(frag, sentinel); else grid.appendChild(frag);
  _rendered += slice.length;
  if (_rendered >= VISIBLE.length && _io) {
    _io.disconnect(); _io = null;
    const s = $('scroll-sentinel'); if (s) s.remove();
  }
}

const ICON_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m21 15-5-5L5 21"/></svg>';

function cardOf(it) {
  const el = document.createElement('div');
  el.className = 'card' + (it.has_image ? '' : ' missing');
  el.dataset.rel = it.rel;
  const relEnc = encodeURIComponent(it.rel);
  const thumbHtml = it.has_image
    ? `<span class="badge has">已生成</span><img loading="lazy" decoding="async" width="360" height="360" src="/api/thumb?rel=${relEnc}&v=${it.image_mtime}" alt="">`
    : `<span class="badge">未生成</span><div class="empty">${ICON_EMPTY}<span>尚無圖片</span></div>`;
  el.innerHTML = `
    <div class="thumb">${thumbHtml}</div>
    <div class="card-body">
      <div class="card-name"></div>
      ${SEARCH ? '<div class="card-folder"></div>' : ''}
    </div>
    <div class="status"></div>
    <div class="card-actions">
      <button class="gen-btn">${it.has_image ? '重新生成' : '生成'}</button>
    </div>`;
  el.querySelector('.card-name').textContent = it.name;
  if (SEARCH) el.querySelector('.card-folder').textContent = it.folder || '(根目錄)';
  el.querySelector('.thumb').onclick = () => openModal(it.rel);
  el.querySelector('.gen-btn').onclick = (e) => { e.stopPropagation(); generate(it.rel); };
  if (it.job && it.job.status) updateStatusEl(el.querySelector('.status'), it.job);
  return el;
}

function updateStatusEl(el, job) {
  if (!el) return;
  if (!job || !job.status) { el.textContent = ''; el.className = 'status'; return; }
  el.className = 'status ' + job.status;
  const map = { queued: '排隊中', running: '生成中', done: '完成', error: '失敗' };
  el.textContent = (map[job.status] || job.status) + (job.message ? ' · ' + job.message : '');
}

async function generate(rel) {
  const r = await fetch('/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rel })
  });
  const j = await r.json();
  if (j.error) { alert(j.error); return; }
  const it = ALL.find(x => x.rel === rel);
  if (it) it.job = { status: 'queued', message: '排隊中...' };
  const card = document.querySelector(`.card[data-rel="${cssAttr(rel)}"]`);
  if (card) updateStatusEl(card.querySelector('.status'), it.job);
  pollStatus(rel);
}

async function pollStatus(rel) {
  if (pollers.has(rel)) return;
  pollers.add(rel);
  try {
    while (true) {
      const r = await fetch('/api/status?rel=' + encodeURIComponent(rel));
      const job = await r.json();
      const it = ALL.find(x => x.rel === rel);
      if (it) it.job = job;
      const card = document.querySelector(`.card[data-rel="${cssAttr(rel)}"]`);
      if (card) updateStatusEl(card.querySelector('.status'), job);
      const mstat = $('modal-status');
      if (mstat && mstat.dataset.rel === rel) updateStatusEl(mstat, job);
      if (job.status === 'done' || job.status === 'error') {
        if (job.status === 'done') {
          if (it) { it.has_image = true; it.image_mtime = Math.floor(Date.now() / 1000); }
          reloadThumb(rel); reloadModalImage(rel); buildRail();
        }
        break;
      }
      await sleep(1500);
    }
  } finally { pollers.delete(rel); }
}

function reloadThumb(rel) {
  const card = document.querySelector(`.card[data-rel="${cssAttr(rel)}"]`);
  if (!card) return;
  card.classList.remove('missing');
  const thumb = card.querySelector('.thumb');
  thumb.innerHTML = `<span class="badge has">已生成</span><img loading="lazy" decoding="async" width="360" height="360" src="/api/thumb?rel=${encodeURIComponent(rel)}&v=${Date.now()}" alt="">`;
  thumb.onclick = () => openModal(rel);
  const btn = card.querySelector('.gen-btn');
  if (btn) btn.textContent = '重新生成';
}

function reloadModalImage(rel) {
  const inner = $('modal-inner');
  if (inner && inner.dataset.rel === rel) openModal(rel, false);
}

function openModal(rel, resetNav = true) {
  const item = ALL.find(x => x.rel === rel);
  if (!item) return;
  const inner = $('modal-inner');
  inner.dataset.rel = rel;
  const relEnc = encodeURIComponent(rel);
  const imgHtml = item.has_image
    ? `<img id="modal-image" data-rel="${escapeAttr(rel)}" src="/api/image?rel=${relEnc}&t=${item.image_mtime}">`
    : `<div class="no-image">尚無圖片</div>`;
  inner.innerHTML = `
    <div>
      ${imgHtml}
      <div id="modal-status" data-rel="${escapeAttr(rel)}" class="status" style="margin-top:10px;padding:0;"></div>
      <div style="margin-top:12px; display:flex; gap:8px;">
        <button class="primary" id="modal-gen">${item.has_image ? '重新生成' : '生成'}</button>
        <button id="modal-close">關閉 (Esc)</button>
      </div>
    </div>
    <div>
      <div class="m-title" id="modal-title"></div>
      <div class="m-folder" id="modal-folder"></div>
      <div class="prompt-label">正向 Prompt</div>
      <div class="prompt-block" id="pos">載入中…</div>
      <div class="prompt-label">負向 Prompt</div>
      <div class="prompt-block" id="neg">載入中…</div>
    </div>`;
  $('modal-title').textContent = item.name;
  $('modal-folder').textContent = item.folder || '(根目錄)';
  $('modal-gen').onclick = () => generate(rel);
  $('modal-close').onclick = closeModal;
  $('modal').classList.add('open');
  if (item.job && item.job.status) updateStatusEl($('modal-status'), item.job);
  fetch('/api/prompt?rel=' + relEnc).then(r => r.json()).then(j => {
    if (j.error) { $('pos').textContent = j.error; return; }
    $('pos').textContent = j.positive || '(空)';
    $('neg').textContent = j.negative || '(空)';
  }).catch(e => { $('pos').textContent = String(e); });
}

function modalStep(dir) {
  const inner = $('modal-inner');
  const rel = inner && inner.dataset.rel;
  if (!rel || !VISIBLE.length) return;
  const i = VISIBLE.findIndex(x => x.rel === rel);
  if (i < 0) return;
  const ni = (i + dir + VISIBLE.length) % VISIBLE.length;
  openModal(VISIBLE[ni].rel);
}

function closeModal() {
  $('modal').classList.remove('open');
  const inner = $('modal-inner');
  if (inner) delete inner.dataset.rel;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
function cssAttr(s) { return String(s).replace(/["\\]/g, '\\$&'); }

/* 篩選段 */
$('view-seg').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  VIEW = btn.dataset.v;
  [...$('view-seg').children].forEach(b => b.classList.toggle('on', b === btn));
  render();
});

let searchTimer;
$('search').oninput = e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { SEARCH = e.target.value.trim(); buildRail(); render(); }, 180);
};
$('rescan').onclick = loadAll;
$('menu-btn').onclick = () => $('rail').classList.toggle('open');

let railTimer;
$('folder-search').oninput = e => {
  const v = e.target.value.trim();
  $('folder-search-clear').style.display = v ? '' : 'none';
  clearTimeout(railTimer);
  railTimer = setTimeout(() => { RAIL_SEARCH = v; buildRail(); }, 120);
};
$('folder-search').onkeydown = e => {
  if (e.key === 'Escape') { e.target.value = ''; RAIL_SEARCH = ''; $('folder-search-clear').style.display = 'none'; buildRail(); }
  // Enter:若只剩一個資料夾,直接進入
  if (e.key === 'Enter') {
    const only = $('rail-list').querySelectorAll('.folder');
    if (only.length === 1) only[0].click();
  }
};
$('folder-search-clear').onclick = () => {
  $('folder-search').value = ''; RAIL_SEARCH = '';
  $('folder-search-clear').style.display = 'none'; buildRail(); $('folder-search').focus();
};

async function launchBatch(scope, regenerate) {
  // scope: 'page' = 目前檢視;'all' = 全部詞庫(不受資料夾/搜尋/篩選影響)
  const source = scope === 'all' ? ALL : currentList();
  const rels = (regenerate ? source : source.filter(x => !x.has_image)).map(x => x.rel);
  if (!rels.length) {
    alert(regenerate ? '目前範圍沒有可生成的項目' : '目前範圍沒有缺圖的項目');
    return;
  }
  const scopeTxt = scope === 'all' ? '全部詞庫' : (SEARCH ? '搜尋結果' : '此資料夾');
  const modeTxt = regenerate ? '重新生成(會覆蓋既有圖)' : '補齊缺少的';
  if (!confirm(`${scopeTxt} · ${modeTxt}\n共 ${rels.length} 張,將以每次 2 張並行處理,可能耗時很久。確定?`)) return;
  const r = await fetch('/api/batch_generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rels, regenerate })
  });
  const j = await r.json();
  if (j.error) { alert(j.error); return; }
  pollBatch();
}
$('gen-page-missing').onclick = () => launchBatch('page', false);
$('gen-page-all').onclick     = () => launchBatch('page', true);
$('gen-all-missing').onclick  = () => launchBatch('all', false);
$('gen-all-regen').onclick    = () => launchBatch('all', true);

$('batch-stop').onclick = async () => {
  if (!confirm('停止批次?當前這張仍會跑完。')) return;
  await fetch('/api/batch_stop', { method: 'POST' });
};

const GEN_BTNS = ['gen-page-missing', 'gen-page-all', 'gen-all-missing', 'gen-all-regen'];
function setGenDisabled(v) { GEN_BTNS.forEach(id => { const el = $(id); if (el) el.disabled = v; }); }

async function pollBatch() {
  const progEl = $('batch-progress'), stopBtn = $('batch-stop');
  while (true) {
    const b = await (await fetch('/api/batch_status')).json();
    if (b.running) {
      stopBtn.style.display = ''; setGenDisabled(true);
      const rels = b.running_rels || [];
      const cur = rels.length ? ' · 生成中 ' + rels.map(r => r.split('/').pop().replace(/\.py$/, '')).join(' + ') : '';
      progEl.innerHTML = `<span class="led" style="background:var(--amber);box-shadow:0 0 7px var(--amber)"></span>批次 ${b.done}/${b.total} · ok ${b.ok} · fail ${b.fail}${cur}`;
      for (const rel of rels) pollStatus(rel);
    } else {
      stopBtn.style.display = 'none'; setGenDisabled(false);
      progEl.textContent = b.total > 0 ? `批次完成 ${b.done}/${b.total} · ok ${b.ok} · fail ${b.fail}` : '';
      break;
    }
    await sleep(1500);
  }
}

$('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
$('m-prev').onclick = () => modalStep(-1);
$('m-next').onclick = () => modalStep(1);
window.addEventListener('keydown', e => {
  if (!$('modal').classList.contains('open')) return;
  if (e.key === 'Escape') closeModal();
  else if (e.key === 'ArrowLeft') modalStep(-1);
  else if (e.key === 'ArrowRight') modalStep(1);
});

loadAll().then(() => pollBatch());
</script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main():
    cfg = load_config()
    # 詞庫資料夾：config > gsp 預設。設定後 scan/生成都指向這裡。
    if cfg.get("special_dir"):
        apply_special_dir(cfg["special_dir"])

    ap = argparse.ArgumentParser(description="Special Prompts 詞庫可視化管理 UI")
    # 預設值一律先吃 config，再讓 CLI 覆寫（省略欄位就用內建預設）
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

    srv = ThreadingHTTPServer((bind_host, port), Handler)
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
