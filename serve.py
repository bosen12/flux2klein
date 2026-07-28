#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Flux2 Klein ComfyUI 面板 —— 同源反向代理伺服器

作用：
  1. 在本機開一個埠（預設 7801），提供這個資料夾裡的網頁靜態檔。
  2. 其餘所有請求（/object_info、/prompt、/upload/image、/view、/ws …）
     以「原始位元組」轉發到你的 ComfyUI（預設 127.0.0.1:8188）。
  因為網頁與 API 變成同源，瀏覽器不會有 CORS 問題，
  也不需要用 --enable-cors-header 重啟 ComfyUI；WebSocket 也一併透明代理。

用法：
  python serve.py                       # ComfyUI=127.0.0.1:8188, 面板=127.0.0.1:7801
  python serve.py 127.0.0.1:8188 7801   # 自訂 ComfyUI 位址 與 面板埠
  python serve.py 192.168.1.50:8188     # ComfyUI 在別台機器

只用 Python 標準函式庫，不需安裝任何套件。Python 3.7+。
"""
import os
import sys
import socket
import threading
import mimetypes
import datetime
import gzip
import hashlib
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))

# 只有這些路徑會由本伺服器提供本地檔案，其餘一律轉發給 ComfyUI
STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/klein": "index.html",       # 全新網址：避開瀏覽器對 / 的舊快取
    "/panel": "index.html",
    "/app.js": "app.js",
    "/config.js": "config.js",
    "/converter.js": "converter.js",
    "/zimage.js": "zimage.js",
    "/krea2.js": "krea2.js",
    "/illustrious.js": "illustrious.js",
    "/styles.css": "styles.css",
    "/workflow.json": "workflow.json",
    "/zimage_t2i.json": "zimage_t2i.json",
    "/zimage_controlnet.json": "zimage_controlnet.json",
    "/krea2.json": "krea2.json",
    "/illustrious.json": "illustrious.json",
    "/favicon.ico": "favicon.ico",
    "/favicon.png": "favicon.png",
}


def parse_args():
    comfy_host, comfy_port = "127.0.0.1", 8188
    listen_port = 7801
    if len(sys.argv) >= 2 and sys.argv[1]:
        hp = sys.argv[1]
        if ":" in hp:
            comfy_host, p = hp.rsplit(":", 1)
            comfy_port = int(p)
        else:
            comfy_host = hp
    if len(sys.argv) >= 3 and sys.argv[2]:
        listen_port = int(sys.argv[2])
    return comfy_host, comfy_port, listen_port


COMFY_HOST, COMFY_PORT, LISTEN_PORT = parse_args()
LISTEN_HOST = "0.0.0.0"   # 綁所有介面，同網路的手機/其他電腦可用區網 IP 連


def lan_ip():
    """取得本機區網 IP（給其他裝置連用）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def recv_headers(sock):
    """讀取到 HTTP 標頭結束（\r\n\r\n）。回傳已讀取的所有位元組（可能含部分 body）。"""
    data = b""
    while b"\r\n\r\n" not in data:
        try:
            chunk = sock.recv(4096)
        except OSError:
            break
        if not chunk:
            break
        data += chunk
        if len(data) > 1024 * 1024:  # 標頭異常過大，保護一下
            break
    return data


# index.html 裡的 ?v= 會被換成這些檔案 mtime 的雜湊：只要改過任何一支，
# 網址就不同，瀏覽器一定重抓，不會再發生「改了 JS 但頁面跑舊版」。
VERSIONED_ASSETS = ("app.js", "config.js", "converter.js", "zimage.js",
                    "krea2.js", "illustrious.js", "styles.css")


def asset_version():
    stamps = []
    for name in VERSIONED_ASSETS:
        p = os.path.join(BASE, name)
        if os.path.isfile(p):
            stamps.append("%s:%d" % (name, os.path.getmtime(p)))
    if not stamps:
        return "1"
    return hashlib.md5("|".join(stamps).encode("utf-8")).hexdigest()[:8]


def send_body(client, body, ctype):
    header = (
        "HTTP/1.1 200 OK\r\n"
        f"Content-Type: {ctype}; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Cache-Control: no-store, no-cache, must-revalidate, max-age=0\r\n"
        "Connection: close\r\n\r\n"
    ).encode("utf-8")
    client.sendall(header + body)


def send_file(client, filename):
    if filename is None:  # favicon 之類
        client.sendall(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
        return
    path = os.path.join(BASE, filename)
    if not os.path.isfile(path):
        # config.js 是選用的（含 API key，不進版控），沒有就回空檔避免 console 噴 404
        if filename == "config.js":
            send_body(client, b"/* config.js \xe4\xb8\x8d\xe5\xad\x98\xe5\x9c\xa8 */\n",
                      "application/javascript")
            return
        body = ("找不到檔案：" + filename).encode("utf-8")
        client.sendall(
            b"HTTP/1.1 404 Not Found\r\n"
            b"Content-Type: text/plain; charset=utf-8\r\n"
            b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
        )
        return
    ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
    with open(path, "rb") as f:
        body = f.read()
    if filename == "index.html":
        body = body.replace(b"?v=1", b"?v=" + asset_version().encode("ascii"))
    header = (
        "HTTP/1.1 200 OK\r\n"
        f"Content-Type: {ctype}; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Cache-Control: no-store, no-cache, must-revalidate, max-age=0\r\n"
        "Connection: close\r\n\r\n"
    ).encode("utf-8")
    client.sendall(header + body)


def pipe(src, dst):
    """把 src 的資料持續搬到 dst，直到任一端關閉。"""
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def force_connection_close(initial):
    """把請求標頭的 Connection 改成 close，避免瀏覽器重用「已接到 ComfyUI」的 keep-alive 連線。"""
    sep = b"\r\n\r\n"
    idx = initial.find(sep)
    if idx == -1:
        return initial
    head, body = initial[:idx], initial[idx + 4:]
    lines = head.split(b"\r\n")
    out = [lines[0]]  # 保留請求行
    for ln in lines[1:]:
        low = ln.lower()
        if low.startswith((b"connection:", b"proxy-connection:", b"keep-alive:")):
            continue
        out.append(ln)
    out.append(b"Connection: close")
    return b"\r\n".join(out) + sep + body


def proxy_to_comfy(client, initial, is_ws=False):
    """把整段請求（含已讀 body）轉發給 ComfyUI，並雙向透明轉送（涵蓋 WebSocket）。"""
    if not is_ws:
        initial = force_connection_close(initial)  # 一般 HTTP 請求：用完即關，杜絕連線重用錯亂
    try:
        upstream = socket.create_connection((COMFY_HOST, COMFY_PORT), timeout=10)
    except OSError as e:
        msg = (f"無法連線到 ComfyUI ({COMFY_HOST}:{COMFY_PORT})：{e}\n"
               "請先啟動 ComfyUI，或用 python serve.py <host:port> 指定正確位址。").encode("utf-8")
        client.sendall(
            b"HTTP/1.1 502 Bad Gateway\r\n"
            b"Content-Type: text/plain; charset=utf-8\r\n"
            b"Content-Length: " + str(len(msg)).encode() + b"\r\n\r\n" + msg
        )
        client.close()
        return
    upstream.settimeout(None)
    try:
        upstream.sendall(initial)
    except OSError:
        client.close()
        upstream.close()
        return
    t = threading.Thread(target=pipe, args=(client, upstream), daemon=True)
    t.start()
    pipe(upstream, client)


def header_value(initial, name):
    """從請求位元組中取出某個 HTTP 標頭的值（不分大小寫），沒有就回 None。"""
    key = b"\r\n" + name.lower().encode() + b":"
    low = initial.lower()
    idx = low.find(key)
    if idx == -1:
        return None
    start = idx + len(key)
    end = initial.find(b"\r\n", start)
    if end == -1:
        end = len(initial)
    return initial[start:end].decode("latin1", "replace").strip()


def client_ip(client, initial):
    """取得真正的來源 IP：優先用 X-Forwarded-For（Funnel/代理會帶），否則用 TCP 對端。"""
    xff = header_value(initial, "X-Forwarded-For")
    if xff:
        return xff.split(",")[0].strip()
    try:
        return client.getpeername()[0]
    except OSError:
        return "?"


def log_task(client, initial):
    """有人送出生成任務 (POST /prompt) 時，印出時間 + 來源 IP（+ Tailscale 使用者，如果有）。"""
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ip = client_ip(client, initial)
    who = header_value(initial, "Tailscale-User-Login")
    tail = f"  使用者 {who}" if who else ""
    print(f"[{ts}]  ▶ 送出任務   來源 IP: {ip}{tail}", flush=True)


# ---- /object_info 壓縮快取（10MB JSON gzip 後約 1MB，手機/遠端載入快很多）----
_oi_lock = threading.Lock()
_oi_cache = {"raw": None, "gz": None}


def get_object_info():
    """向 ComfyUI 取一次 /object_info，壓縮並快取（伺服器生命週期內有效）。"""
    if _oi_cache["gz"] is not None:
        return _oi_cache["raw"], _oi_cache["gz"]
    with _oi_lock:
        if _oi_cache["gz"] is None:
            url = f"http://{COMFY_HOST}:{COMFY_PORT}/object_info"
            with urllib.request.urlopen(url, timeout=30) as resp:
                raw = resp.read()
            _oi_cache["raw"] = raw
            _oi_cache["gz"] = gzip.compress(raw, 5)
    return _oi_cache["raw"], _oi_cache["gz"]


def serve_object_info(client, initial):
    """用壓縮快取回應 /object_info。成功回 True；失敗回 False（讓外層改用一般代理）。"""
    try:
        raw, gz = get_object_info()
    except Exception:
        return False
    accepts_gzip = "gzip" in (header_value(initial, "Accept-Encoding") or "").lower()
    body = gz if accepts_gzip else raw
    enc = "Content-Encoding: gzip\r\n" if accepts_gzip else ""
    header = (
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\n"
        + enc +
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n\r\n"
    ).encode("utf-8")
    client.sendall(header + body)
    return True


def handle(client):
    try:
        client.settimeout(30)
        initial = recv_headers(client)
        if not initial:
            client.close()
            return
        client.settimeout(None)
        first_line = initial.split(b"\r\n", 1)[0].decode("latin1", "replace")
        parts = first_line.split(" ")
        method = parts[0].upper() if parts else ""
        raw_path = parts[1] if len(parts) > 1 else "/"
        path = raw_path.split("?", 1)[0]
        is_ws = b"upgrade: websocket" in initial.lower()

        if method == "POST" and path.startswith("/prompt"):
            log_task(client, initial)

        # /object_info 走壓縮快取（大幅減少手機/遠端載入時間）
        if method == "GET" and path == "/object_info" and not is_ws:
            if serve_object_info(client, initial):
                client.close()
                return
            # 快取失敗 → 落到下面走一般代理

        if path in STATIC_FILES and not is_ws:
            send_file(client, STATIC_FILES[path])
            client.close()
        else:
            proxy_to_comfy(client, initial, is_ws)
    except Exception:
        try:
            client.close()
        except OSError:
            pass


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    # Windows：用 SO_EXCLUSIVEADDRUSE 獨占 port，避免多個實例偷偷搶同一埠（會造成回應損毀）
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        try:
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        except OSError:
            pass
    else:
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind((LISTEN_HOST, LISTEN_PORT))
    except OSError as e:
        print(f"[錯誤] 無法綁定 {LISTEN_HOST}:{LISTEN_PORT} —— {e}")
        print("       這個埠可能已被占用（也許已有另一個面板在跑）。")
        print("       換一個埠：start.bat 127.0.0.1:8188 7802")
        sys.exit(1)
    srv.listen(128)
    print("=" * 60)
    print("  Flux2 Klein ComfyUI 面板已啟動")
    print(f"  ▶ 本機： http://127.0.0.1:{LISTEN_PORT}/klein")
    print(f"  ▶ 區網（手機/其他電腦）： http://{lan_ip()}:{LISTEN_PORT}/klein")
    print(f"  ▶ 代理到 ComfyUI： {COMFY_HOST}:{COMFY_PORT}")
    print("  （綁 0.0.0.0：同網路皆可連，無登入驗證；按 Ctrl+C 停止）")
    print("=" * 60)
    try:
        while True:
            client, _ = srv.accept()
            threading.Thread(target=handle, args=(client,), daemon=True).start()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        srv.close()


if __name__ == "__main__":
    main()
