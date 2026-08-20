#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Flux2 Klein 管理後台
====================
一個網頁，負責啟動/停止 Klein 面板、暗房、LoRA Manager、waifu-score 這四個
服務，不用再手動雙擊各自的 .bat（會跳出一堆 cmd 黑窗）。子行程一律用
CREATE_NO_WINDOW 開，不會有任何主控台視窗閃出來。

用法：
    python dashboard.py               # 綁 0.0.0.0，面板本身也走 Tailscale
    python dashboard.py --port 7800   # 自訂埠

只用標準函式庫，不需安裝任何套件。Python 3.9+（Windows）。
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DASHBOARD_DIR = Path(__file__).resolve().parent
FLUX_ROOT = DASHBOARD_DIR.parent
WAIFU_ROOT = Path(r"C:\projects\waifu-score")
LOG_DIR = DASHBOARD_DIR / "logs"
LOG_DIR.mkdir(exist_ok=True)

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# ---------------------------------------------------------------------------
# 服務定義：key 是 API 用的識別字，"port" 拿來判斷「有沒有在跑」（直接探測那個
# port 有沒有人監聽，不管是不是這支後台自己啟動的——這樣使用者原本手動開著的
# 服務，後台也認得出來是「已啟動」）。
# ---------------------------------------------------------------------------
PY = sys.executable

SERVICES = {
    "panel": {
        "label": "Klein 面板",
        "port": 7801,
        "url": "http://127.0.0.1:7801/klein",
        "cwd": FLUX_ROOT,
        "pre_cmd": None,
        "cmd": [PY, "serve.py"],
    },
    "darkroom": {
        "label": "暗房",
        "port": 7860,
        "url": "http://127.0.0.1:7860/",
        "cwd": FLUX_ROOT / "darkroom",
        "pre_cmd": None,
        "cmd": [PY, "preview_ui.py", "--no-open"],
    },
    "lora_manager": {
        "label": "LoRA Manager",
        "port": 7861,
        "url": "http://127.0.0.1:7861/loras",
        "cwd": FLUX_ROOT / "lora-manager",
        # settings.json 的路徑要跟 LORA_ROOT/CHECKPOINT_ROOT 同步，開服務前先跑一次
        # （跟 start_lora_manager.bat 的順序一樣），同步完再啟動 standalone.py。
        "pre_cmd": [PY, "write_settings.py"],
        "cmd": [PY, "standalone.py", "--port", "7861"],
    },
    "waifu_score": {
        "label": "Waifu Scorer（GPU）",
        "port": 8000,
        "url": "http://127.0.0.1:8000/",
        "cwd": WAIFU_ROOT,
        "pre_cmd": None,
        "cmd": [
            str(WAIFU_ROOT / ".venv" / "Scripts" / "python.exe"),
            "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000",
        ],
    },
}

_procs = {key: None for key in SERVICES}   # key -> subprocess.Popen | None
_lock = threading.Lock()


def _port_open(port: int, host: str = "127.0.0.1", timeout: float = 0.3) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _log_path(key: str) -> Path:
    return LOG_DIR / f"{key}.log"


def _start(key: str) -> dict:
    cfg = SERVICES[key]
    with _lock:
        proc = _procs.get(key)
        if proc is not None and proc.poll() is None:
            return {"ok": True, "message": "已經在跑了"}
        if _port_open(cfg["port"]):
            return {"ok": True, "message": "已經在跑了（不是這支後台啟動的，但 port 有人在監聽）"}

        if not Path(cfg["cwd"]).is_dir():
            return {"ok": False, "message": f"找不到目錄：{cfg['cwd']}"}
        exe = cfg["cmd"][0]
        if exe.endswith(".exe") and not Path(exe).is_file():
            return {"ok": False, "message": f"找不到 Python 直譯器：{exe}（waifu-score 的 venv 建好了嗎？先手動跑一次 run.bat）"}

        log_file = open(_log_path(key), "w", encoding="utf-8", errors="replace")

        if cfg["pre_cmd"]:
            try:
                subprocess.run(
                    cfg["pre_cmd"], cwd=str(cfg["cwd"]),
                    stdout=log_file, stderr=subprocess.STDOUT,
                    creationflags=CREATE_NO_WINDOW, timeout=60,
                )
            except Exception as e:
                log_file.close()
                return {"ok": False, "message": f"前置指令失敗：{e}"}

        try:
            proc = subprocess.Popen(
                cfg["cmd"], cwd=str(cfg["cwd"]),
                stdout=log_file, stderr=subprocess.STDOUT,
                creationflags=CREATE_NO_WINDOW,
            )
        except Exception as e:
            log_file.close()
            return {"ok": False, "message": f"啟動失敗：{e}"}

        _procs[key] = proc
        return {"ok": True, "message": "已啟動"}


def _kill_by_port(port: int) -> bool:
    """後台重開過、_procs 裡沒有紀錄，但 port 上還有一支孤兒行程時的備援：用
    netstat 找出佔用該 port 的 PID 再砍掉。只在 Stop 找不到自己啟動的行程時用。"""
    try:
        out = subprocess.check_output(
            ["netstat", "-ano", "-p", "TCP"],
            creationflags=CREATE_NO_WINDOW, text=True, timeout=10,
        )
    except Exception:
        return False
    pids = set()
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0] == "TCP" and parts[1].endswith(f":{port}") and parts[3] == "LISTENING":
            pids.add(parts[4])
    ok = False
    for pid in pids:
        try:
            subprocess.run(["taskkill", "/F", "/PID", pid],
                            creationflags=CREATE_NO_WINDOW, timeout=10,
                            capture_output=True)
            ok = True
        except Exception:
            pass
    return ok


def _stop(key: str) -> dict:
    cfg = SERVICES[key]
    with _lock:
        proc = _procs.get(key)
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            _procs[key] = None
            return {"ok": True, "message": "已停止"}
        _procs[key] = None
        if _port_open(cfg["port"]):
            if _kill_by_port(cfg["port"]):
                return {"ok": True, "message": "已停止（不是這支後台啟動的，用 port 找到行程砍掉）"}
            return {"ok": False, "message": "port 上有東西在跑，但找不到/砍不掉那個行程"}
        return {"ok": True, "message": "本來就沒在跑"}


def _status() -> dict:
    out = {}
    for key, cfg in SERVICES.items():
        proc = _procs.get(key)
        managed = proc is not None and proc.poll() is None
        running = managed or _port_open(cfg["port"])
        out[key] = {
            "label": cfg["label"], "port": cfg["port"], "url": cfg["url"],
            "running": running, "managed_by_dashboard": managed,
        }
    return out


def _in_cgnat(ip: str) -> bool:
    """是否落在 Tailscale 用的 100.64.0.0/10。"""
    try:
        parts = ip.split(".")
        return parts[0] == "100" and 64 <= int(parts[1]) <= 127
    except (ValueError, IndexError):
        return False


def _client_allowed(ip: str) -> bool:
    """只放行本機／Tailscale——這支後台能啟動/停止程序，權限比其他面板都大，
    比照 ../serve.py 的白名單，不能比它更寬鬆。"""
    if ip in ("127.0.0.1", "::1"):
        return True
    return _in_cgnat(ip)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        pass

    def _blocked(self) -> bool:
        if _client_allowed(self.client_address[0]):
            return False
        try:
            self.connection.close()
        except OSError:
            pass
        return True

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, name, ctype):
        path = DASHBOARD_DIR / name
        try:
            body = path.read_bytes()
        except OSError:
            self._send_json({"error": "not found"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self._blocked():
            return
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            self._send_file("dashboard.html", "text/html; charset=utf-8")
            return
        if u.path == "/dashboard.js":
            self._send_file("dashboard.js", "application/javascript; charset=utf-8")
            return
        if u.path == "/dashboard.css":
            self._send_file("dashboard.css", "text/css; charset=utf-8")
            return
        if u.path == "/api/status":
            self._send_json(_status())
            return
        if u.path == "/api/logs":
            key = (qs.get("service") or [""])[0]
            if key not in SERVICES:
                self._send_json({"error": "unknown service"}, 400)
                return
            try:
                text = _log_path(key).read_text(encoding="utf-8", errors="replace")
            except OSError:
                text = ""
            lines = text.splitlines()[-200:]
            self._send_json({"lines": lines})
            return
        self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        if self._blocked():
            return
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        key = (qs.get("service") or [""])[0]
        if key not in SERVICES:
            self._send_json({"error": "unknown service"}, 400)
            return
        if u.path == "/api/start":
            self._send_json(_start(key))
            return
        if u.path == "/api/stop":
            self._send_json(_stop(key))
            return
        self._send_json({"error": "not found"}, 404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7800)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print("=" * 60)
    print("  Flux2 Klein 管理後台")
    print(f"  本機： http://127.0.0.1:{args.port}/")
    print("  （只放行本機與 Tailscale 來源；按 Ctrl+C 停止）")
    print("=" * 60)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
