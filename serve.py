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
import time
import mimetypes
import datetime
import gzip
import hashlib
import urllib.request
import urllib.error
import ssl
import shutil
import subprocess
import re
import json as _json

import groq_proxy
import lora_scan

try:
    from PIL import Image
    _HAS_PIL = True
except Exception:
    _HAS_PIL = False

BASE = os.path.dirname(os.path.abspath(__file__))
# 有些 Python 的 mimetypes 不認 .webp（guess_type 回 None）→ 預覽圖會被當 image/png
# 送。明確註冊，讓 LoRA／詞庫的 .webp 預覽 Content-Type 正確。
mimetypes.add_type("image/webp", ".webp")
CERT_FILE = os.path.join(BASE, "cert.pem")
KEY_FILE = os.path.join(BASE, "key.pem")

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
    "/three.min.js": "three.min.js",             # Vanta.js 依賴（本機 vendored，r134）
    "/vanta.fog.min.js": "vanta.fog.min.js",     # WebGL 流動彩霧背景
    "/styles.css": "styles.css",
    "/workflow.json": "workflow.json",
    "/zimage_t2i.json": "zimage_t2i.json",
    "/zimage_controlnet.json": "zimage_controlnet.json",
    "/krea2.json": "krea2.json",
    "/illustrious.json": "illustrious.json",
    "/favicon.svg": "favicon.svg",
    "/favicon.ico": "favicon.ico",
    "/favicon.png": "favicon.png",
    "/assets/avatar.webp": "assets/avatar.webp",  # 助理頭像（512²，30KB）
    "/assets/avatar.png": "assets/avatar.png",   # 舊的 310KB PNG，留著讓已快取的頁面不會 404
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


# --https 可放在任何位置；先剝掉再做位置參數解析
USE_HTTPS = "--https" in sys.argv
if USE_HTTPS:
    sys.argv = [a for a in sys.argv if a != "--https"]

COMFY_HOST, COMFY_PORT, LISTEN_PORT = parse_args()
# 語音服務（voice-assistant/start_assistant.py）跑在本機這個埠。助理的 WebSocket 由本代理
# 同源轉發過去——手機走 HTTPS 面板時才能用（同源 wss、無混合內容，麥克風也可用）。
ASST_HOST, ASST_PORT = "127.0.0.1", 8765
# LiveTalking（對嘴數字人）跑在這個埠。助理講話時把 TTS 音訊送去 /humanaudio
# 渲染嘴型，影像走 WebRTC 回來顯示在助理抽屜。同樣走同源代理：跨埠會有 CORS，
# 而面板走 HTTPS 時直接打 http://127.0.0.1:8010 會被當混合內容擋掉。
LT_HOST, LT_PORT = "127.0.0.1", 8010
# 需要同源轉發給 LiveTalking 的路徑（見它的 docs/api.md）
LT_PATHS = ("/offer", "/human", "/humanaudio", "/interrupt_talk", "/is_speaking", "/set_audiotype")
# Illustrious 的 LoRA 選單來源：跟暗房共用 lora_scan.py（同一份 LORA_ROOT／副檔名／剝標）。
# 換機器或改路徑時設環境變數 LORA_ROOT 覆寫根目錄即可。新增分類改 lora_scan.LORA_FOLDERS。
# LoRA Manager（獨立埠 7861，見 lora-manager/）點「送到 workflow」時 POST 這裡；
# 暗房（darkroom/preview_ui.py 的 /api/lora-push）已經有一份一模一樣的機制，這裡
# 是 KLEIN 面板自己的版本——單一格、版本號遞增、最新覆蓋前一個（不排隊）。
_LORA_PUSH = {"ver": 0, "data": None}   # {"ver": int, "data": {"folder","name"}|None}
_LORA_PUSH_LOCK = threading.Lock()
# Illustrious 的「詞庫」來源：special_prompts（C:\projects\special_prompts），底下是數十個分類子夾，
# 每個 .py 是一組情境提示詞（REQUIRED_POSITIVE / POSITIVE / NEGATIVE 三個 list），
# 旁邊可能有同名 .webp 預覽圖。面板用 ast 安全解析（只取那三個 list，不 import／不執行）。
# 路徑來源優先序：環境變數 PROMPTS_ROOT > preview_config.json 的 special_dir >
# 內建預設。這樣詞庫選單（這裡）跟詞庫暗房（preview_ui.py）指向同一份資料——
# preview_config.json 跟著 preview_ui.py 住在 darkroom/ 底下（2026-08 整理專案結構），
# 不是跟這支 serve.py 同一層，讀取路徑要往那邊找。
def _prompts_root_default():
    cfg = os.path.join(BASE, "darkroom", "preview_config.json")
    if os.path.isfile(cfg):
        try:
            import json as _json
            with open(cfg, "r", encoding="utf-8") as f:
                sd = (_json.load(f) or {}).get("special_dir")
            if sd:
                return sd
        except Exception:
            pass
    return r"C:\projects\special_prompts"


PROMPTS_ROOT = os.environ.get("PROMPTS_ROOT") or _prompts_root_default()
LISTEN_HOST = "0.0.0.0"   # 綁所有介面是為了讓 Tailscale 虛擬網卡收得到；區網仍由 _client_allowed 擋
_blocked_log = {}
_blocked_log_lock = threading.Lock()


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


def _in_cgnat(ip):
    """是否落在 Tailscale 用的 100.64.0.0/10。"""
    try:
        parts = ip.split(".")
        return parts[0] == "100" and 64 <= int(parts[1]) <= 127
    except (ValueError, IndexError):
        return False


def _client_allowed(ip):
    """只放行本機（127.0.0.1／::1）與 Tailscale 來源（100.64.0.0/10）；
    其餘一律拒絕——面板沒有登入驗證，綁 0.0.0.0 是為了讓 Tailscale 這類
    虛擬網卡收得到封包，不代表要讓區網或公網任意連線進來。"""
    if ip in ("127.0.0.1", "::1"):
        return True
    return _in_cgnat(ip)


def tailscale_ip():
    """取本機 Tailscale IPv4（100.64.0.0/10）。先問 tailscale CLI，失敗再掃本機介面。
    沒裝或沒連 Tailscale 就回 None。"""
    exe = shutil.which("tailscale")
    if not exe:
        fallback = r"C:\Program Files\Tailscale\tailscale.exe"
        if os.path.isfile(fallback):
            exe = fallback
    if exe:
        try:
            out = subprocess.run([exe, "ip", "-4"], capture_output=True, text=True, timeout=5)
            for line in out.stdout.splitlines():
                ip = line.strip()
                if _in_cgnat(ip):
                    return ip
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        for res in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = res[4][0]
            if _in_cgnat(ip):
                return ip
    except OSError:
        pass
    return None


def _san_value():
    """組 subjectAltName：localhost + 127.0.0.1 + 本機區網 IP +（若有）Tailscale IP。"""
    entries = ["IP:127.0.0.1", "DNS:localhost"]
    ip = lan_ip()
    if ip and ip != "127.0.0.1":
        entries.append("IP:" + ip)
    ts = tailscale_ip()
    if ts:
        entries.append("IP:" + ts)
    return ",".join(entries)


def ensure_cert():
    """HTTPS 需要憑證。用 openssl 自簽，SAN 含 localhost / 區網 IP / Tailscale IP，
    這樣手機不論走區網或 Tailscale IP 連都不會憑證主機不符。SAN 內容變了（換網路、
    Tailscale 上線）會自動重產，不必手動刪 cert.pem。回傳 True 表示憑證就緒。"""
    san = _san_value()
    marker = CERT_FILE + ".san"
    have = os.path.isfile(CERT_FILE) and os.path.isfile(KEY_FILE)
    if have and os.path.isfile(marker):
        try:
            if open(marker, encoding="utf-8").read().strip() == san:
                return True   # 現有憑證已涵蓋目前所有位址
        except OSError:
            pass
    openssl = shutil.which("openssl")
    if not openssl:
        if have:
            print("[HTTPS] 找不到 openssl，沿用現有憑證（SAN 可能未含新位址）。")
            return True
        print("[HTTPS] 找不到 openssl，無法自動產生憑證。")
        print("        請自備 cert.pem / key.pem 放專案目錄，或拿掉 --https 改用 HTTP。")
        return False
    cmd = [openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes",
           "-keyout", KEY_FILE, "-out", CERT_FILE, "-days", "3650",
           "-subj", "/CN=flux2klein-panel", "-addext", "subjectAltName=" + san]
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (subprocess.CalledProcessError, OSError) as e:
        print("[HTTPS] 產生憑證失敗：%s" % e)
        return have   # 產失敗但有舊憑證就先用
    try:
        with open(marker, "w", encoding="utf-8") as f:
            f.write(san)
    except OSError:
        pass
    print("[HTTPS] 已自簽憑證（SAN: %s）" % san)
    return True


def make_ssl_context():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)
    return ctx


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
                    "krea2.js", "illustrious.js", "styles.css", "favicon.svg",
                    "three.min.js", "vanta.fog.min.js", "assets/avatar.webp")


def asset_version():
    # cfg-sanitize-1：config.js 改成送出前剝 key。舊版 ?v= 曾以 immutable 快取
    # 含金鑰的檔，雜湊要變一次才會重抓。後續只靠各檔 mtime。
    stamps = ["cfg-sanitize-1"]
    for name in VERSIONED_ASSETS:
        p = os.path.join(BASE, name)
        if os.path.isfile(p):
            stamps.append("%s:%d" % (name, os.path.getmtime(p)))
    if len(stamps) == 1:
        return "1"
    return hashlib.md5("|".join(stamps).encode("utf-8")).hexdigest()[:8]


# ---- 回應輸出：gzip + 快取標頭 ------------------------------------------
# 這裡以前一律「不壓縮 + no-store」。實測一次開頁要送 868KB 未壓縮的 js/css
# （three.min.js 601KB、app.js 143KB、styles.css 71KB）加 352KB 的 workflow.json，
# 而 index.html 裡的資產網址**早就帶了 ?v=<檔案 mtime 雜湊>**（見 asset_version），
# 等於「做了內容定址的網址，然後又叫瀏覽器不要快取」，兩件事互相抵銷。
#
# 現在：帶 ?v= 的資產可以永久快取（改了檔案→雜湊變→網址變→瀏覽器自然重抓，
# 不可能吃到舊版）；沒帶 ?v= 的（直接輸網址進來、或 app.js 裡寫死 fetch 的
# workflow.json）走 ETag 重新驗證，內容沒變就回 304。index.html 本身維持
# no-store——它是版本雜湊的來源，永遠要拿最新的。
GZIP_MIN = 1400          # 跟 darkroom/preview_ui.py 同一個門檻：小回應壓了反而虧
GZIP_TYPES = ("json", "text/", "javascript", "image/svg")
NO_STORE = "no-store, no-cache, must-revalidate, max-age=0"
IMMUTABLE = "public, max-age=31536000, immutable"
KEEPALIVE_S = 30         # 跟暗房 ThreadingHTTPServer.timeout 同一檔。面板以前每請求
                         # Connection: close，LoRA 選單一頁 80 張縮圖 = 80 次 TCP（HTTPS
                         # 還要 80 次 TLS）。暗房已經 keep-alive，這裡比照辦理。
_GROQ_ARR_RE = re.compile(r"GROQ_API_KEYS\s*:\s*\[[^\]]*\]\s*,?", re.S)
_GROQ_KEY_RE = re.compile(r"GROQ_API_KEY\s*:\s*['\"][^'\"]*['\"]\s*,?")


def _serve_config_js():
    """給瀏覽器的 config.js：剝掉 Groq key，只留非機密欄位 + groqConfigured。

    金鑰只給 groq_proxy / serve.py 的 /panel/groq 在伺服器端用。config.js 曾被
    當靜態檔送出，區網或 Tailscale 能開面板就能讀到 key。"""
    path = os.path.join(BASE, "config.js")
    if not os.path.isfile(path):
        return b"window.YZ_CONFIG = { groqConfigured: false };\n"
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        return b"window.YZ_CONFIG = { groqConfigured: false };\n"
    has = bool(groq_proxy.load_keys())
    s = _GROQ_ARR_RE.sub("", text)
    s = _GROQ_KEY_RE.sub("", s)
    s = re.sub(
        r"(window\.YZ_CONFIG\s*=\s*\{)",
        r"\1 groqConfigured: %s," % ("true" if has else "false"),
        s,
        count=1,
    )
    return s.encode("utf-8")


def _want_keepalive(initial):
    """HTTP/1.1 預設 keep-alive，除非對方寫 Connection: close。HTTP/1.0 要明確要求。"""
    if not initial:
        return False
    first = initial.split(b"\r\n", 1)[0].decode("latin1", "replace")
    ver = first.rsplit(" ", 1)[-1] if first else ""
    conn = (header_value(initial, "Connection") or "").lower()
    if "close" in conn:
        return False
    if "HTTP/1.0" in ver:
        return "keep-alive" in conn
    return True   # HTTP/1.1 與未知版本：我們自己是 1.1，預設開


def _conn_hdr(keep):
    if keep:
        return "Connection: keep-alive\r\nKeep-Alive: timeout=%d\r\n" % KEEPALIVE_S
    return "Connection: close\r\n"


def _empty(client, code, keep=False):
    reason = {400: "Bad Request", 404: "Not Found"}.get(code, "Error")
    client.sendall((
        "HTTP/1.1 %d %s\r\nContent-Length: 0\r\n" % (code, reason)
        + _conn_hdr(keep) + "\r\n"
    ).encode("utf-8"))


def _gzip_for(body, ctype, initial):
    """回傳 (body, Content-Encoding 標頭字串)。initial=None 代表呼叫端沒把原始請求
    傳進來（不知道對方支不支援 gzip），一律不壓，維持舊行為。"""
    if initial is None or len(body) < GZIP_MIN:
        return body, ""
    if not any(t in ctype for t in GZIP_TYPES):
        return body, ""
    if "gzip" not in (header_value(initial, "Accept-Encoding") or "").lower():
        return body, ""
    return gzip.compress(body, 5), "Content-Encoding: gzip\r\n"


def send_body(client, body, ctype, initial=None, cache=NO_STORE, etag=None):
    keep = _want_keepalive(initial)
    if etag and initial is not None and header_value(initial, "If-None-Match") == etag:
        client.sendall((
            "HTTP/1.1 304 Not Modified\r\n"
            f"ETag: {etag}\r\n"
            f"Cache-Control: {cache}\r\n"
            + _conn_hdr(keep) +
            "\r\n"
        ).encode("utf-8"))
        return
    body, enc = _gzip_for(body, ctype, initial)
    header = (
        "HTTP/1.1 200 OK\r\n"
        f"Content-Type: {ctype}; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\n"
        + enc +
        "Vary: Accept-Encoding\r\n"
        + (f"ETag: {etag}\r\n" if etag else "") +
        f"Cache-Control: {cache}\r\n"
        + _conn_hdr(keep) +
        "\r\n"
    ).encode("utf-8")
    client.sendall(header + body)


def send_file(client, filename, initial=None, raw_path=""):
    if filename is None:  # favicon 之類
        client.sendall(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
        return
    path = os.path.join(BASE, filename)
    if filename == "config.js":
        send_body(client, _serve_config_js(), "application/javascript", initial, NO_STORE)
        return
    if not os.path.isfile(path):
        body = ("找不到檔案：" + filename).encode("utf-8")
        client.sendall(
            b"HTTP/1.1 404 Not Found\r\n"
            b"Content-Type: text/plain; charset=utf-8\r\n"
            b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
        )
        return
    ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
    if filename == "index.html":
        # index.html 不快取：它負責把 ?v=1 換成目前的資產雜湊，永遠要拿最新的。
        with open(path, "rb") as f:
            body = f.read()
        send_body(client, body.replace(b"?v=1", b"?v=" + asset_version().encode("ascii")),
                  ctype, initial, NO_STORE)
        return
    st = os.stat(path)
    etag = '"%s"' % hashlib.md5(
        ("%s|%d|%d" % (filename, st.st_mtime_ns, st.st_size)).encode("utf-8")
    ).hexdigest()[:16]
    # 網址帶 ?v= 就是 index.html 產生的內容定址網址 → 可以永久快取；直接輸網址
    # 進來的（沒有 ?v=）走 ETag 重新驗證，跟以前一樣不可能吃到舊版。
    cache = IMMUTABLE if "?v=" in raw_path else "no-cache"
    if initial is not None and header_value(initial, "If-None-Match") == etag:
        send_body(client, b"", ctype, initial, cache, etag)   # 命中 → 回 304，不用讀檔
        return
    with open(path, "rb") as f:
        body = f.read()
    send_body(client, body, ctype, initial, cache, etag)


def serve_lora_list(client, initial=None):
    """列出各分類子夾內每個 LoRA 的觸發詞與預覽圖，給 Illustrious 面板選單用。
    掃描／SWR／副檔名／<lora:…> 剝除都在 lora_scan.py，跟暗房同一支。"""
    body = _json.dumps(lora_scan.list_loras(), ensure_ascii=False).encode("utf-8")
    etag = '"%s"' % hashlib.md5(body).hexdigest()[:16]
    send_body(client, body, "application/json", initial, "no-cache", etag)


_LORA_THUMB_DIR = os.path.join(BASE, ".lora_thumb_cache")
_LORA_THUMB_MAX = 360   # 跟暗房 darkroom/preview_ui.py 的 THUMB_MAX 同一個級距，面板選單
                         # 一樣是小格子，用不到更大的


def _lora_thumb(path: str) -> tuple[bytes, str, str]:
    """回傳 (bytes, content_type, etag)。實測抓到的真正瓶頸：LORA_ROOT 底下不少
    「.preview.png」其實是使用者從 CivitAI 存下來的原圖，3~7MB 稀鬆平常，這支端點
    以前直接整包送出去，遠端連線同時載幾個就會把頻寬擠爆，個別請求卡到 10~20 秒。
    面板選單只拿去當小預覽格，用不到原始解析度，跟暗房共用同一套「Pillow 縮圖 +
    磁碟快取」做法（cache key 含來源路徑/mtime/size，來源換了會自動重算，不用手動
    清快取）。Pillow 不可用（沒裝）就退回送原圖，至少功能還在，只是沒省頻寬。"""
    st = os.stat(path)
    sig = f"{path}|{int(st.st_mtime)}|{st.st_size}|{_LORA_THUMB_MAX}"
    etag = hashlib.sha1(sig.encode("utf-8")).hexdigest()
    if not _HAS_PIL:
        with open(path, "rb") as f:
            return f.read(), mimetypes.guess_type(path)[0] or "image/png", etag
    os.makedirs(_LORA_THUMB_DIR, exist_ok=True)
    cache_file = os.path.join(_LORA_THUMB_DIR, etag + ".webp")
    if os.path.isfile(cache_file):
        with open(cache_file, "rb") as f:
            return f.read(), "image/webp", etag
    with Image.open(path) as im:
        im = im.convert("RGB")
        im.thumbnail((_LORA_THUMB_MAX, _LORA_THUMB_MAX), Image.LANCZOS)
        import io as _io
        buf = _io.BytesIO()
        im.save(buf, format="WEBP", quality=72, method=1)
    data = buf.getvalue()
    tmp = cache_file + f".tmp-{os.getpid()}"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, cache_file)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return data, "image/webp", etag


def _lower_thread_priority_background():
    """把目前這個執行緒切到 Windows 的「背景模式」（THREAD_MODE_BACKGROUND_BEGIN）——
    CPU、磁碟 I/O、記憶體優先權一起降低，讓排程器自動把前景應用擺在前面，這個
    背景暖快取任務盡量不去搶。不用另外恢復——執行緒跑完就結束，優先權設定跟著
    消失。只在 Windows 有效，失敗就當沒這回事，不影響功能。"""
    if os.name != "nt":
        return
    try:
        import ctypes
        THREAD_MODE_BACKGROUND_BEGIN = 0x00010000
        ctypes.windll.kernel32.SetThreadPriority(
            ctypes.windll.kernel32.GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN)
    except Exception:
        pass


def _warm_lora_thumbs():
    """開機背景任務：清單裡所有圖片預覽先跑過 _lora_thumb() 一輪。走 list_loras()
    而不是自己再 walk 一遍——副檔名優先序跟選單對得上，也順便把 SWR 快取暖好。
    影片略過（Pillow 縮不了）。順便清 .lora_thumb_cache 孤兒。"""
    _lower_thread_priority_background()
    n = 0
    live_etags = set()
    try:
        items = lora_scan.list_loras().get("items") or []
    except Exception as e:
        print(f"[warm] 掃描 LoRA 失敗：{type(e).__name__}: {e}", flush=True)
        return
    for l in items:
        preview = l.get("preview")
        if not preview or lora_scan.is_video_preview(preview):
            continue
        p = lora_scan.preview_path(l.get("folder") or "", preview)
        if p is None:
            continue
        try:
            _, _, etag = _lora_thumb(str(p))
            live_etags.add(etag)
            n += 1
        except Exception:
            pass
    removed = 0
    try:
        if os.path.isdir(_LORA_THUMB_DIR):
            for name in os.listdir(_LORA_THUMB_DIR):
                if not name.endswith(".webp"):
                    continue
                if name[: -len(".webp")] not in live_etags:
                    try:
                        os.remove(os.path.join(_LORA_THUMB_DIR, name))
                        removed += 1
                    except OSError:
                        pass
    except Exception as e:
        print(f"[warm] 清孤兒縮圖失敗：{type(e).__name__}: {e}", flush=True)
    print(f"[warm] LoRA 預覽縮圖預熱完成：{n} 張"
          + (f"，清掉 {removed} 個孤兒快取" if removed else ""), flush=True)


def serve_lora_preview(client, raw_path, initial=None):
    """送出單一 LoRA 的預覽。路徑驗證走 lora_scan.preview_path()（跟暗房同一支）。
    帶 ETag：換檔會重抓，沒換就 304。以前只掛 max-age=86400 且丟掉 etag，來源
    被換成同名檔後面板會鎖舊圖 24 小時。"""
    from urllib.parse import urlparse, parse_qs, unquote
    q = parse_qs(urlparse(raw_path).query)
    folder = unquote((q.get("folder") or [""])[0])
    fn = unquote((q.get("file") or [""])[0])
    p = lora_scan.preview_path(folder, fn)
    keep = _want_keepalive(initial)
    if p is None:
        _empty(client, 404, keep)
        return
    path = str(p)
    if lora_scan.is_video_preview(fn):
        # 影片 Pillow 縮不了，本來就不大（實測 ~700KB 級別），維持原樣直送。
        ctype = mimetypes.guess_type(path)[0] or "video/mp4"
        st = os.stat(path)
        etag = hashlib.sha1(f"{path}|{int(st.st_mtime)}|{st.st_size}".encode("utf-8")).hexdigest()
        with open(path, "rb") as f:
            body = f.read()
    else:
        body, ctype, etag = _lora_thumb(path)
    if etag and initial is not None and header_value(initial, "If-None-Match") == etag:
        client.sendall((
            "HTTP/1.1 304 Not Modified\r\n"
            f"ETag: {etag}\r\n"
            "Cache-Control: no-cache\r\n"
            + _conn_hdr(keep) +
            "\r\n"
        ).encode("utf-8"))
        return
    header = (
        "HTTP/1.1 200 OK\r\n"
        f"Content-Type: {ctype}\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"ETag: {etag}\r\n"
        "Cache-Control: no-cache\r\n"
        + _conn_hdr(keep) +
        "\r\n"
    ).encode("utf-8")
    client.sendall(header + body)


def _lora_push_json(client, obj, status=200, initial=None):
    """跟 send_body() 類似但可指定狀態碼、固定帶 CORS 標頭——只有 /panel/lora-push
    需要（LoRA Manager 站在 7861 跨源打過來，瀏覽器要看到 Access-Control-Allow-Origin
    才會把回應交給呼叫端的 JS；GET 是面板自己同源輪詢用不到，但一起帶不影響行為，
    兩支共用一個 helper 比較簡單）。"""
    import json as _json
    body = _json.dumps(obj, ensure_ascii=False).encode("utf-8")
    status_line = "200 OK" if status == 200 else "400 Bad Request"
    header = (
        f"HTTP/1.1 {status_line}\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Cache-Control: no-store\r\n"
        + _conn_hdr(_want_keepalive(initial)) +
        "\r\n"
    ).encode("utf-8")
    client.sendall(header + body)


def serve_lora_push_get(client, raw_path, initial=None):
    """前端每 ~1s 輪詢一次；帶 since 才回新資料，版本沒變就只回 ver（省流量）。"""
    from urllib.parse import urlparse, parse_qs
    q = parse_qs(urlparse(raw_path).query)
    try:
        since = int((q.get("since", ["0"])[0]) or 0)
    except ValueError:
        since = 0
    with _LORA_PUSH_LOCK:
        ver, data = _LORA_PUSH["ver"], _LORA_PUSH["data"]
    out = {"ver": ver}
    if ver > since:
        out["data"] = data
    _lora_push_json(client, out, initial=initial)


def serve_lora_push_post(client, initial):
    """LoRA Manager（獨立埠 7861）POST 這裡推送一個 LoRA。initial 是 recv_headers()
    回傳的位元組，標頭後面可能已經帶了部分／全部 body——先從這裡切開，不夠再從
    socket 補讀到 Content-Length 指定的長度。LoRA Manager 固定會帶 Content-Length，
    不用處理 chunked transfer encoding。"""
    import json as _json
    head, _, body = initial.partition(b"\r\n\r\n")
    length = 0
    for line in head.split(b"\r\n")[1:]:
        if line.lower().startswith(b"content-length:"):
            try:
                length = int(line.split(b":", 1)[1].strip())
            except ValueError:
                length = 0
            break
    while len(body) < length:
        chunk = client.recv(min(65536, length - len(body)))
        if not chunk:
            break
        body += chunk
    try:
        data = _json.loads(body.decode("utf-8")) if body else {}
    except Exception:
        data = {}
    folder = str(data.get("folder") or "").strip()
    name = str(data.get("name") or "").strip()
    if not name:
        _lora_push_json(client, {"error": "缺少 name"}, 400, initial=initial)
        return
    with _LORA_PUSH_LOCK:
        _LORA_PUSH["ver"] += 1
        _LORA_PUSH["data"] = {"folder": folder, "name": name}
        ver = _LORA_PUSH["ver"]
    print(f"[lora-push] {folder}/{name} (ver={ver})")
    _lora_push_json(client, {"ok": True, "ver": ver}, initial=initial)


def serve_lora_push_options(client, initial=None):
    """CORS 預檢：7861 跨源打 7801，application/json 的 POST 瀏覽器一定先送 OPTIONS。"""
    client.sendall((
        "HTTP/1.1 204 No Content\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: POST, GET, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type\r\n"
        "Content-Length: 0\r\n"
        + _conn_hdr(_want_keepalive(initial)) +
        "\r\n"
    ).encode("utf-8"))


def _prompt_folders():
    """special_prompts 底下的分類子夾（排序、略過 __ 開頭與非目錄）。"""
    try:
        return sorted(d for d in os.listdir(PROMPTS_ROOT)
                      if not d.startswith("__") and os.path.isdir(os.path.join(PROMPTS_ROOT, d)))
    except OSError:
        return []


_prompt_list_cache = {"payload": None, "at": 0.0, "etag": None, "refreshing": False}
_PROMPT_LIST_TTL = 60.0   # 詞庫檔案會被暗房生成預覽圖就地改變（preview 欄位），不能像
                           # LoRA 那樣快取 5 分鐘；60 秒足以吃掉「開選單→搜尋→再開」
                           # 這種連續操作，又不會讓剛生成的預覽狀態太久才反映。
_prompt_list_lock = threading.Lock()


def _build_prompt_list_payload():
    items, counts = [], {}
    folders = _prompt_folders()
    for folder in folders:
        d = os.path.join(PROMPTS_ROOT, folder)
        try:
            names = sorted(os.listdir(d))
        except OSError:
            counts[folder] = 0
            continue
        # 判斷有沒有預覽圖，直接查 names 這個 set（已經是這次 listdir 的結果），
        # 不要對每個 .py 各自再開一次 os.path.isfile()——資料夾在本機磁碟上這樣
        # 寫沒差，但這支服務常常是透過 Docker bind mount／網路磁碟讀取
        # PROMPTS_ROOT，每一次獨立的檔案系統呼叫都要跨一層掛載開銷，詞庫上萬個
        # .py 檔案時，逐檔 isfile() 會讓這支 API 從幾百毫秒變成幾十秒。
        name_set = set(names)
        n = 0
        for fn in names:
            if not fn.endswith(".py") or fn.startswith("__"):
                continue
            stem = fn[:-3]
            items.append({
                "folder": folder,
                "file": fn,
                "name": stem,
                "preview": (stem + ".webp") in name_set,
            })
            n += 1
        counts[folder] = n
    body = _json.dumps({"items": items, "counts": counts, "folders": folders},
                       ensure_ascii=False).encode("utf-8")
    with _prompt_list_lock:
        _prompt_list_cache["payload"] = body
        _prompt_list_cache["at"] = time.time()
        _prompt_list_cache["etag"] = '"%s"' % hashlib.md5(body).hexdigest()[:16]
        _prompt_list_cache["refreshing"] = False
    return body


def _refresh_prompt_list_bg():
    def work():
        try:
            _build_prompt_list_payload()
        except Exception:
            with _prompt_list_lock:
                _prompt_list_cache["refreshing"] = False
    threading.Thread(target=work, daemon=True).start()


def serve_prompt_list(client, initial=None):
    """列出各分類夾內的詞庫（.py）與是否有預覽圖，給 Illustrious 詞庫選單用。內容不解析（清單要輕）。

    實測 194 個資料夾、30714 筆詞庫：掃描加序列化 108ms、payload 3.86MB。以前是每次
    開選單都重掃一次、而且未壓縮直送——gzip 之後只剩 0.36MB（10.7 倍）。快取改成
    stale-while-revalidate：過期先回舊的、背景重掃，避免「剛好過期的那一次」由
    使用者在前景買單（LoRA 清單同一類問題，見 serve_lora_list）。"""
    with _prompt_list_lock:
        body = _prompt_list_cache["payload"]
        etag = _prompt_list_cache["etag"]
        stale = (time.time() - _prompt_list_cache["at"]) >= _PROMPT_LIST_TTL
        need_bg = stale and body is not None and not _prompt_list_cache["refreshing"]
        if need_bg:
            _prompt_list_cache["refreshing"] = True
    if body is None:
        body = _build_prompt_list_payload()
        with _prompt_list_lock:
            etag = _prompt_list_cache["etag"]
    elif need_bg:
        _refresh_prompt_list_bg()
    send_body(client, body, "application/json", initial, "no-cache", etag)


def serve_prompt_detail(client, raw_path, initial=None):
    """解析單一詞庫 .py，回 REQUIRED_POSITIVE / POSITIVE / NEGATIVE 三個 list。用 ast，不 import／不執行。"""
    import json as _json
    import ast as _ast
    from urllib.parse import urlparse, parse_qs, unquote
    q = parse_qs(urlparse(raw_path).query)
    folder = unquote((q.get("cat") or [""])[0])
    fn = unquote((q.get("file") or [""])[0])
    bad = (folder not in _prompt_folders() or not fn.endswith(".py")
           or "/" in fn or "\\" in fn or ".." in fn)
    if bad:
        _empty(client, 400, _want_keepalive(initial))
        return
    path = os.path.join(PROMPTS_ROOT, folder, fn)
    out = {"required": [], "positive": [], "negative": []}
    keymap = {"REQUIRED_POSITIVE": "required", "POSITIVE": "positive", "NEGATIVE": "negative"}
    try:
        with open(path, "r", encoding="utf-8") as f:
            tree = _ast.parse(f.read())
        for node in tree.body:
            if not isinstance(node, _ast.Assign):
                continue
            for t in node.targets:
                if isinstance(t, _ast.Name) and t.id in keymap:
                    try:
                        val = _ast.literal_eval(node.value)
                    except Exception:
                        val = []
                    if isinstance(val, list):
                        out[keymap[t.id]] = [str(x) for x in val]
    except OSError:
        _empty(client, 404, _want_keepalive(initial))
        return
    send_body(client, _json.dumps(out, ensure_ascii=False).encode("utf-8"),
               "application/json", initial)


def serve_prompt_preview(client, raw_path, initial=None):
    """送出詞庫的 .webp 預覽圖。cat 須在分類白名單、file 純檔名，擋目錄穿越。"""
    from urllib.parse import urlparse, parse_qs, unquote
    q = parse_qs(urlparse(raw_path).query)
    folder = unquote((q.get("cat") or [""])[0])
    fn = unquote((q.get("file") or [""])[0])
    keep = _want_keepalive(initial)
    bad = (folder not in _prompt_folders() or not fn
           or "/" in fn or "\\" in fn or ".." in fn)
    if bad:
        _empty(client, 400, keep)
        return
    path = os.path.join(PROMPTS_ROOT, folder, fn)
    if not os.path.isfile(path):
        _empty(client, 404, keep)
        return
    ctype = mimetypes.guess_type(path)[0] or "image/webp"
    with open(path, "rb") as f:
        body = f.read()
    header = (
        "HTTP/1.1 200 OK\r\n"
        f"Content-Type: {ctype}\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Cache-Control: max-age=86400\r\n"
        + _conn_hdr(keep) +
        "\r\n"
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


def rewrite_request_path(initial, new_path):
    """把請求行的路徑換成 new_path（助理 WS：/assistant → /v1/realtime）。"""
    idx = initial.find(b"\r\n")
    if idx == -1:
        return initial
    parts = initial[:idx].decode("latin1").split(" ")
    if len(parts) >= 2:
        parts[1] = new_path
    return (" ".join(parts)).encode("latin1") + initial[idx:]


def proxy_upstream(client, initial, host, port, is_ws=False, label="上游"):
    """轉發整段請求到 host:port，雙向透明轉送（涵蓋 WebSocket）。"""
    if not is_ws:
        initial = force_connection_close(initial)
    try:
        upstream = socket.create_connection((host, port), timeout=10)
    except OSError as e:
        msg = (f"無法連線到 {label}（{host}:{port}）：{e}").encode("utf-8")
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
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    pipe(upstream, client)


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
_oi_cache = {"raw": None, "gz": None, "etag": None, "at": 0.0, "refreshing": False}
_OI_TTL = 60.0


def _fetch_object_info():
    url = f"http://{COMFY_HOST}:{COMFY_PORT}/object_info"
    req = urllib.request.Request(url, headers={"User-Agent": "flux2klein-panel"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    with _oi_lock:
        _oi_cache["raw"] = raw
        _oi_cache["gz"] = gzip.compress(raw, 5)
        _oi_cache["etag"] = '"%s"' % hashlib.md5(raw).hexdigest()[:16]
        _oi_cache["at"] = time.time()
        _oi_cache["refreshing"] = False
    return _oi_cache["raw"], _oi_cache["gz"]


def get_object_info():
    """向 ComfyUI 取 /object_info，壓縮並快取。SWR：過期先回舊的、背景重抓。
    以前純 TTL，到期那一次前景等 ComfyUI 回 14MB；LoRA／詞庫清單早已改 SWR，這支沒跟上。
    生命週期快取也不行——ComfyUI 重啟後會一直拿到舊節點。"""
    with _oi_lock:
        raw, gz = _oi_cache["raw"], _oi_cache["gz"]
        stale = raw is None or (time.time() - _oi_cache["at"]) >= _OI_TTL
        need_bg = stale and raw is not None and not _oi_cache["refreshing"]
        if need_bg:
            _oi_cache["refreshing"] = True
    if raw is None:
        return _fetch_object_info()
    if need_bg:
        def work():
            try:
                _fetch_object_info()
            except Exception as e:
                with _oi_lock:
                    _oi_cache["refreshing"] = False
                print(f"[object_info] 背景重抓失敗：{type(e).__name__}: {e}", flush=True)
        threading.Thread(target=work, daemon=True).start()
    return raw, gz


def serve_object_info(client, initial):
    """用壓縮快取回應 /object_info。成功回 True；失敗回 False（讓外層改用一般代理）。

    實測這份 JSON 現在是 14.16MB（gzip 後 2.44MB）——程式碼註解裡寫的「約 10MB」是
    裝更多自訂節點之前的數字。它只有在 ComfyUI 重啟或裝新節點時才會變（快取是伺服器
    生命週期內有效），所以帶 ETag 讓瀏覽器重新驗證：第一次照樣 2.44MB，之後每次開頁
    只要一個 304。不用 max-age 是因為「ComfyUI 換了模型/節點」要能立刻反映。"""
    try:
        raw, gz = get_object_info()
    except Exception:
        return False
    etag = _oi_cache["etag"]
    keep = _want_keepalive(initial)
    if etag and header_value(initial, "If-None-Match") == etag:
        client.sendall((
            "HTTP/1.1 304 Not Modified\r\n"
            f"ETag: {etag}\r\n"
            "Cache-Control: no-cache\r\n"
            + _conn_hdr(keep) +
            "\r\n"
        ).encode("utf-8"))
        return True
    accepts_gzip = "gzip" in (header_value(initial, "Accept-Encoding") or "").lower()
    body = gz if accepts_gzip else raw
    enc = "Content-Encoding: gzip\r\n" if accepts_gzip else ""
    header = (
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\n"
        + enc +
        "Vary: Accept-Encoding\r\n"
        + (f"ETag: {etag}\r\n" if etag else "") +
        "Cache-Control: no-cache\r\n"
        + _conn_hdr(keep) +
        "\r\n"
    ).encode("utf-8")
    client.sendall(header + body)
    return True


def _read_http_body(client, initial, max_len=2 * 1024 * 1024):
    """從已讀的標頭位元組接著把 POST body 收完。超過 max_len 回 None。"""
    cl = header_value(initial, "Content-Length")
    try:
        need = int(cl or 0)
    except ValueError:
        need = 0
    if need > max_len:
        return None
    sep = initial.find(b"\r\n\r\n")
    body = initial[sep + 4:] if sep >= 0 else b""
    while len(body) < need:
        try:
            chunk = client.recv(min(65536, need - len(body)))
        except OSError:
            break
        if not chunk:
            break
        body += chunk
    return body[:need]


def serve_groq(client, initial, raw_path, method):
    """同源 Groq 代理：瀏覽器只 POST /panel/groq/openai/v1/chat/completions，
    key 留在伺服器。路徑白名單與輪替邏輯都在 groq_proxy。"""
    rest = raw_path.split("?", 1)[0][len("/panel/groq"):] or "/"
    if rest not in groq_proxy.ALLOWED_PATHS or method != "POST":
        msg = b'{"error":{"message":"path not allowed"}}'
        client.sendall(
            b"HTTP/1.1 404 Not Found\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: " + str(len(msg)).encode() + b"\r\n"
            b"Connection: close\r\n\r\n" + msg
        )
        return
    body = _read_http_body(client, initial)
    if body is None:
        msg = b'{"error":{"message":"payload too large"}}'
        client.sendall(
            b"HTTP/1.1 413 Payload Too Large\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: " + str(len(msg)).encode() + b"\r\n"
            b"Connection: close\r\n\r\n" + msg
        )
        return
    groq_proxy.Handler.keys = groq_proxy.Handler.keys or groq_proxy.load_keys()
    try:
        r = groq_proxy.groq_open(
            rest, method, body or None,
            content_type=header_value(initial, "Content-Type"),
            user_agent=header_value(initial, "User-Agent") or "flux2klein-panel",
        )
    except groq_proxy.GroqConfigError as e:
        msg = _json.dumps({"error": {"message": str(e)}}).encode()
        client.sendall(
            b"HTTP/1.1 503 Service Unavailable\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: " + str(len(msg)).encode() + b"\r\n"
            b"Connection: close\r\n\r\n" + msg
        )
        return
    except urllib.error.HTTPError as e:
        data = e.read()
        ct = (e.headers.get("Content-Type") or "application/json").encode()
        client.sendall(
            ("HTTP/1.1 %d %s\r\n" % (e.code, e.reason)).encode("ascii", "replace") +
            b"Content-Type: " + ct + b"\r\n"
            b"Content-Length: " + str(len(data)).encode() + b"\r\n"
            b"Connection: close\r\n\r\n" + data
        )
        return
    except Exception as e:
        msg = _json.dumps({"error": {"message": str(e)}}).encode()
        client.sendall(
            b"HTTP/1.1 502 Bad Gateway\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: " + str(len(msg)).encode() + b"\r\n"
            b"Connection: close\r\n\r\n" + msg
        )
        return
    try:
        ct = (r.headers.get("Content-Type") or "application/json").encode()
        client.sendall(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: " + ct + b"\r\n"
            b"Cache-Control: no-store\r\n"
            b"Connection: close\r\n\r\n"
        )
        while True:
            chunk = r.read(2048)
            if not chunk:
                break
            client.sendall(chunk)
    except OSError:
        pass
    finally:
        try:
            r.close()
        except Exception:
            pass


def _dispatch(client, initial):
    """處理一個 HTTP 請求。回傳 "taken" 表示 socket 已交給 WS／上游代理（呼叫端
    不要關、也不要再讀）；其餘本機回應走 keep-alive，呼叫端依對方標頭決定要不要
    繼續讀下一個請求。"""
    first_line = initial.split(b"\r\n", 1)[0].decode("latin1", "replace")
    parts = first_line.split(" ")
    method = parts[0].upper() if parts else ""
    raw_path = parts[1] if len(parts) > 1 else "/"
    path = raw_path.split("?", 1)[0]
    is_ws = b"upgrade: websocket" in initial.lower()

    if method == "POST" and path.startswith("/prompt"):
        log_task(client, initial)

    if method == "GET" and path == "/object_info" and not is_ws:
        if serve_object_info(client, initial):
            return "local"
        # 快取失敗 → 落到下面走一般代理

    if path in STATIC_FILES and not is_ws:
        send_file(client, STATIC_FILES[path], initial, raw_path)
        return "local"
    if method == "GET" and path == "/panel/loras" and not is_ws:
        serve_lora_list(client, initial)
        return "local"
    if method == "GET" and path == "/panel/lora-preview" and not is_ws:
        serve_lora_preview(client, raw_path, initial)
        return "local"
    if method == "GET" and path == "/panel/lora-push" and not is_ws:
        serve_lora_push_get(client, raw_path, initial)
        return "local"
    if method == "POST" and path == "/panel/lora-push" and not is_ws:
        serve_lora_push_post(client, initial)
        return "local"
    if method == "OPTIONS" and path == "/panel/lora-push" and not is_ws:
        serve_lora_push_options(client, initial)
        return "local"
    if method == "GET" and path == "/panel/prompts" and not is_ws:
        serve_prompt_list(client, initial)
        return "local"
    if method == "GET" and path == "/panel/prompt" and not is_ws:
        serve_prompt_detail(client, raw_path, initial)
        return "local"
    if method == "GET" and path == "/panel/prompt-preview" and not is_ws:
        serve_prompt_preview(client, raw_path, initial)
        return "local"
    if path.startswith("/panel/groq") and not is_ws:
        # 串流、沒有 Content-Length，必須關連線才能讓對方知道 body 結束。
        serve_groq(client, initial, raw_path, method)
        return "taken"
    if is_ws and path.startswith("/assistant"):
        initial = rewrite_request_path(initial, "/v1/realtime")
        proxy_upstream(client, initial, ASST_HOST, ASST_PORT, True, "語音服務（請先啟動 voice-assistant/start_assistant.py）")
        return "taken"
    if path in LT_PATHS and not is_ws:
        proxy_upstream(client, initial, LT_HOST, LT_PORT, False,
                       "對嘴服務（請先啟動 start_livetalking_qwen.bat）")
        return "taken"
    proxy_to_comfy(client, initial, is_ws)
    return "taken"


def handle(client, ssl_ctx=None):
    taken = False
    try:
        client.settimeout(KEEPALIVE_S)
        # HTTPS：在 worker thread 內做 TLS 交握（不擋 accept 迴圈）。
        # 非 TLS 連線打到 HTTPS 埠會交握失敗，直接丟掉。
        if ssl_ctx is not None:
            try:
                client = ssl_ctx.wrap_socket(client, server_side=True)
            except (ssl.SSLError, OSError):
                try:
                    client.close()
                except OSError:
                    pass
                return
        while True:
            client.settimeout(KEEPALIVE_S)
            initial = recv_headers(client)
            if not initial:
                break
            client.settimeout(None)
            result = _dispatch(client, initial)
            if result == "taken":
                taken = True
                return
            if not _want_keepalive(initial):
                break
    except Exception:
        pass
    finally:
        if not taken:
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

    ssl_ctx = None
    if USE_HTTPS:
        if ensure_cert():
            ssl_ctx = make_ssl_context()
        else:
            print("[HTTPS] 憑證未就緒，退回 HTTP。")
    scheme = "https" if ssl_ctx else "http"
    ts = tailscale_ip()
    print("=" * 60)
    print("  Flux2 Klein ComfyUI 面板已啟動")
    print(f"  ▶ 本機： {scheme}://127.0.0.1:{LISTEN_PORT}/klein")
    if ts:
        print(f"  ▶ Tailscale： {scheme}://{ts}:{LISTEN_PORT}/klein")
    print(f"  ▶ 代理到 ComfyUI： {COMFY_HOST}:{COMFY_PORT}")
    if ssl_ctx:
        print("  （HTTPS 自簽憑證：手機第一次會跳「不安全」警告，選「繼續前往」即可；")
        print("    語音輸入等需要麥克風的功能只有 HTTPS 或 localhost 才可用；按 Ctrl+C 停止）")
    print("  （綁 0.0.0.0，只放行本機與 Tailscale（100.64.0.0/10）；")
    print("    區網／公網 IP 連進來會被直接斷線。面板沒有登入，不要對 LAN 開放。）")
    print("=" * 60)
    # 開機就先在背景把所有 LoRA 預覽圖縮圖跑過一輪暖快取，見 _warm_lora_thumbs() 說明。
    threading.Thread(target=_warm_lora_thumbs, daemon=True).start()
    try:
        while True:
            client, addr = srv.accept()
            # 關掉 Nagle 演算法——小回應（LoRA 預覽縮圖等）一個個小封包若還要等湊滿
            # 或等對方 ACK 才送，加上 delayed ACK，每個請求平白多出幾十~上百毫秒，
            # 遠端連線（有真實 RTT）特別有感。見 darkroom/preview_ui.py 同一個修復
            # 的說明（那邊用 http.server 內建的 disable_nagle_algorithm 開關，這裡是
            # 手動管 socket，直接下 setsockopt）。
            try:
                client.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
            if not _client_allowed(addr[0]):
                now = time.time()
                with _blocked_log_lock:
                    last = _blocked_log.get(addr[0], 0)
                    if now - last > 30:
                        _blocked_log[addr[0]] = now
                        print(f"[拒絕] {addr[0]}（只放行本機與 Tailscale）", flush=True)
                try:
                    client.close()
                except OSError:
                    pass
                continue
            threading.Thread(target=handle, args=(client, ssl_ctx), daemon=True).start()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        srv.close()


if __name__ == "__main__":
    main()
