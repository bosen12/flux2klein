#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
極小的 Groq 代理：多把 API key 輪替備援。

為什麼需要：語音服務（speech-to-speech）的 LLM 呼叫在套件內部、只吃單一
key，撞到 Groq 每日 token 上限（429 rate_limit_exceeded）整條就斷。這個
代理夾在語音服務與 Groq 之間，某把 key 回 429 就自動換下一把重試，兩個
帳號的額度接力用。

- 純標準庫（http.server + urllib），符合 serve.py 的精神、不依賴 torch。
- 串流轉發：Groq 回 SSE（邊生成邊送）時逐塊轉發，保住 TTS 的即時性；
  一次讀完的話 LLM 要整句生成完才開始念，首字延遲會爆增。
- 429 是在回應標頭階段就回（HTTPError），還沒進串流，所以能在 urlopen
  當下攔到、換 key；200 之後才 chunked 轉發 body。
- 記住目前用到第幾把，下次從那把開始，不必每次都從撞頂的第一把重試。

可獨立跑（python groq_proxy.py），或被 voice-assistant/start_assistant.py import 後
用 start(keys, port) 在背景執行緒起代理。
"""
import http.server
import json
import re
import sys
import threading
import urllib.error
import urllib.request
import pathlib

GROQ = "https://api.groq.com"


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


class Handler(http.server.BaseHTTPRequestHandler):
    keys = []
    idx = [0]           # 用 list 當可變共享狀態（記住目前用到第幾把）
    lock = threading.Lock()

    def do_POST(self):
        self._proxy()

    def do_GET(self):
        self._proxy()

    def _proxy(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else None
        n = len(self.keys) or 1
        last_429 = None

        for _ in range(n):
            with self.lock:
                k = self.keys[self.idx[0] % n]
            req = urllib.request.Request(GROQ + self.path, data=body, method=self.command)
            ct = self.headers.get("Content-Type")
            if ct:
                req.add_header("Content-Type", ct)
            # Groq 在 Cloudflare 後面，會擋掉 urllib 的預設 UA（403 code 1010）。
            # 帶一個 SDK 風格的 UA 才放行；來源有帶就沿用、沒有就給預設。
            req.add_header("User-Agent", self.headers.get("User-Agent") or "openai-python/1.55.0")
            req.add_header("Authorization", "Bearer " + k)
            try:
                r = urllib.request.urlopen(req)
                # 200：逐塊轉發（支援 SSE 串流）
                self.send_response(r.status)
                fwd_ct = r.headers.get("Content-Type", "application/json")
                self.send_header("Content-Type", fwd_ct)
                self.end_headers()
                while True:
                    chunk = r.read(2048)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
                return
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    with self.lock:
                        self.idx[0] += 1        # 這把撞頂，換下一把
                    last_429 = e.read()
                    continue
                # 其他錯誤原樣回
                data = e.read()
                self.send_response(e.code)
                self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
                self.end_headers()
                self.wfile.write(data)
                return
            except Exception as e:
                data = json.dumps({"error": {"message": str(e)}}).encode()
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(data)
                return

        # 每把都 429
        self.send_response(429)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(last_429 or b'{"error":{"message":"all keys rate limited"}}')

    def log_message(self, *a):
        pass   # 靜音，不洗版


def start(keys, port=8756):
    """在背景執行緒起代理，回傳 port。給 start_assistant.py import 用。"""
    Handler.keys = list(keys)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
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
