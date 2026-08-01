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


def plog(msg: str):
    """主控台 log：帶時間戳、立即 flush，讓 bat 視窗看得到即時進度。
    HTTP 請求那種雜訊仍靜音（Handler.log_message），只印生成/批次這類有用的事件。"""
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# 前端靜態檔（拆成 darkroom/ 資料夾，跟主面板一樣分 html/css/js，不再內嵌字串）
# ---------------------------------------------------------------------------
DARKROOM_DIR = Path(__file__).resolve().parent / "darkroom"
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/darkroom.css": ("darkroom.css", "text/css; charset=utf-8"),
    "/darkroom.js": ("darkroom.js", "application/javascript; charset=utf-8"),
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
            if u.path in STATIC_FILES:
                fname, ctype = STATIC_FILES[u.path]
                try:
                    self._send_bytes((DARKROOM_DIR / fname).read_bytes(), ctype)
                except OSError:
                    self._send_bytes(b"darkroom asset missing", "text/plain", 404)
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
# main
# ---------------------------------------------------------------------------
def main():
    # 行緩衝：讓 log 即時出現，就算 bat 把輸出導向檔案也不會卡在緩衝區
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
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
