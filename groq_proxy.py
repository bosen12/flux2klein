#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
極小的 Groq 代理：多把 API key 輪替備援。

為什麼需要：語音服務（speech-to-speech）的 LLM 呼叫在套件內部、只吃單一
key，撞到 Groq 每日 token 上限（429 rate_limit_exceeded）整條就斷。這個
代理夾在語音服務與 Groq 之間，某把 key 回 429 就自動換下一把重試，兩個
帳號的額度接力用。

KLEIN 面板的 AI 優化也走這裡（serve.py 的 /panel/groq/...），不要讓瀏覽器
拿到 key。

- 純標準庫（http.server + urllib），符合 serve.py 的精神、不依賴 torch。
- 串流轉發：Groq 回 SSE（邊生成邊送）時逐塊轉發，保住 TTS 的即時性；
  一次讀完的話 LLM 要整句生成完才開始念，首字延遲會爆增。
- 429 / 401 / 5xx 是在回應標頭階段就回（HTTPError），還沒進串流，所以能在
  urlopen 當下攔到、換 key；200 之後才 chunked 轉發 body。
- 記住目前用到第幾把，下次從那把開始，不必每次都從撞頂的第一把重試。

可獨立跑（python groq_proxy.py），或被 voice-assistant/start_assistant.py import 後
用 start(keys, port) 在背景執行緒起代理。serve.py 直接呼叫 groq_open()，不必
再起一個埠。
"""
import errno
import http.server
import json
import re
import sys
import threading
import urllib.error
import urllib.request
import pathlib

GROQ = "https://api.groq.com"
# 只轉發 OpenAI 相容的 chat completions，避免這支代理變成任意 Groq 中繼。
ALLOWED_PATHS = ("/openai/v1/chat/completions",)
ROTATE_STATUSES = {401, 403, 429, 500, 502, 503}
TIMEOUT_S = 60


def load_keys():
    """從 config.js 讀 GROQ_API_KEYS（陣列），退回單把 GROQ_API_KEY。"""
    cfg = pathlib.Path(__file__).resolve().parent / "config.js"
    if not cfg.is_file():
        return []
    s = cfg.read_text(encoding="utf-8")
    m = re.search(r"GROQ_API_KEYS\s*:\s*\[([^\]]+)\]", s)
    if m:
        keys = re.findall(r"'([^']+)'|\"([^\"]+)\"", m.group(1))
        keys = [a or b for a, b in keys]
        if keys:
            return keys
    m = re.search(r"GROQ_API_KEY\s*:\s*['\"]([^'\"]+)", s)
    return [m.group(1)] if m else []


class GroqConfigError(Exception):
    """沒有可用的 key。"""


def groq_open(path, method, body, content_type=None, user_agent=None, timeout=TIMEOUT_S):
    """帶 key 輪替打開 Groq。成功回 urllib 回應（呼叫端負責讀完／關閉）。

    401／403／429／5xx 換下一把；其他 HTTP 錯誤原樣拋出。所有 key 都失敗時
    拋最後一個 HTTPError。path 必須在 ALLOWED_PATHS。"""
    if path not in ALLOWED_PATHS:
        raise PermissionError("path not allowed")
    keys = Handler.keys or load_keys()
    if not keys:
        raise GroqConfigError("config.js 裡找不到 GROQ_API_KEYS 或 GROQ_API_KEY")
    n = len(keys)
    last_err = None
    for _ in range(n):
        with Handler.lock:
            k = keys[Handler.idx[0] % n]
        req = urllib.request.Request(GROQ + path, data=body, method=method)
        if content_type:
            req.add_header("Content-Type", content_type)
        # Groq 在 Cloudflare 後面，會擋掉 urllib 的預設 UA（403 code 1010）。
        req.add_header("User-Agent", user_agent or "openai-python/1.55.0")
        req.add_header("Authorization", "Bearer " + k)
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code in ROTATE_STATUSES:
                with Handler.lock:
                    Handler.idx[0] += 1
                last_err = e
                continue
            raise
    if last_err is not None:
        raise last_err
    raise GroqConfigError("沒有可用的 Groq key")


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    keys = []
    idx = [0]           # 用 list 當可變共享狀態（記住目前用到第幾把）
    lock = threading.Lock()

    def do_POST(self):
        self._proxy()

    def do_GET(self):
        self._proxy()

    def _proxy(self):
        if self.path.split("?", 1)[0] not in ALLOWED_PATHS:
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"path not allowed"}}')
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else None
        try:
            r = groq_open(
                self.path.split("?", 1)[0],
                self.command,
                body,
                content_type=self.headers.get("Content-Type"),
                user_agent=self.headers.get("User-Agent"),
            )
        except GroqConfigError as e:
            data = json.dumps({"error": {"message": str(e)}}).encode()
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        except Exception as e:
            data = json.dumps({"error": {"message": str(e)}}).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        try:
            self.send_response(r.status)
            fwd_ct = r.headers.get("Content-Type", "application/json")
            self.send_header("Content-Type", fwd_ct)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            while True:
                chunk = r.read(2048)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        finally:
            try:
                r.close()
            except Exception:
                pass

    def log_message(self, *a):
        pass   # 靜音，不洗版


def start(keys, port=8756):
    """在背景執行緒起代理，回傳 port。給 start_assistant.py import 用。

    埠已被佔用（LiveTalking 的 bat 可能先起了一份）就沿用現有的，不要讓
    助理整條啟動失敗。"""
    Handler.keys = list(keys)
    try:
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as e:
        in_use = getattr(e, "errno", None) in (errno.EADDRINUSE, 10048) or "address already in use" in str(e).lower()
        if in_use:
            return port
        raise
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return port


def main():
    keys = load_keys()
    if not keys:
        sys.exit("config.js 裡找不到 GROQ_API_KEYS 或 GROQ_API_KEY。")
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8756
    Handler.keys = keys
    print(f"Groq 代理啟動：http://127.0.0.1:{port}  （{len(keys)} 把 key 輪替備援）")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
