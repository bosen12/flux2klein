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
import ssl
import shutil
import subprocess

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
    "/assets/avatar.png": "assets/avatar.png",   # 助理頭像
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
# Illustrious 的 LoRA 選單來源：ComfyUI 的 loras 資料夾底下這幾個分類子夾。
# 面板要讀每個 .safetensors 旁的 .metadata.json（trainedWords）與 .preview.png，
# 這些檔在 ComfyUI 那端的磁碟上、不透過 ComfyUI API 取得，所以直接讀資料夾。
# 換機器或改路徑時設環境變數 LORA_ROOT 覆寫根目錄即可。新增分類就加進 LORA_FOLDERS。
LORA_ROOT = os.environ.get(
    "LORA_ROOT",
    r"E:\Comfyui\loras",
)
LORA_FOLDERS = ["style", "Character", "HENTAI", "illus"]
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
                    "three.min.js", "vanta.fog.min.js")


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


_lora_list_cache = {"payload": None, "at": 0.0}
_LORA_LIST_TTL = 300.0   # 跟 darkroom/preview_ui.py 的 list_loras() 同一套 TTL：LoRA
                          # 很少變動，逐檔讀 metadata.json 本來就慢（本機約 5s，經
                          # Docker bind mount 讀 PROMPTS_ROOT／LORA_ROOT 這種掛載更慢，
                          # 實測 ~10s），沒快取的話每次打開選單都要重掃一次。


def serve_lora_list(client):
    """列出各分類子夾（含任意深度的子資料夾）內每個 LoRA 的觸發詞與預覽圖，給 Illustrious
    面板選單用。LoRA Manager 允許在 style/Character/HENTAI/illus 底下建子資料夾整理
    （例如 Character/Hanime、HENTAI/concepts），舊版只掃頂層會讓子資料夾裡的 LoRA
    完全消失不見——暗房那邊（darkroom/preview_ui.py 的 list_loras()）已經用 rglob
    修過同一個問題，這裡比照辦理。item 的 "folder" 是完整相對路徑（如 "Character/Hanime"，
    用 "/" 分隔，送 ComfyUI 前要轉成 "\\"），"category" 才是頂層四分類（給左欄篩選
    晶片分組計數用，前端比對用這個欄位、不是 folder）。"""
    import json as _json
    if _lora_list_cache["payload"] is not None and (time.time() - _lora_list_cache["at"]) < _LORA_LIST_TTL:
        send_body(client, _lora_list_cache["payload"], "application/json")
        return
    items = []
    counts = {}
    errs = []
    for category in LORA_FOLDERS:
        base = os.path.join(LORA_ROOT, category)
        if not os.path.isdir(base):
            errs.append(f"{category}: 資料夾不存在")
            counts[category] = 0
            continue
        found = []
        for dirpath, _dirnames, filenames in os.walk(base):
            for fn in filenames:
                if fn.lower().endswith(".safetensors"):
                    found.append(os.path.join(dirpath, fn))
        found.sort()
        n = 0
        for full in found:
            d = os.path.dirname(full)
            fn = os.path.basename(full)
            folder = os.path.relpath(d, LORA_ROOT).replace(os.sep, "/")
            stem = fn[: -len(".safetensors")]
            words, title = [], stem
            meta_path = os.path.join(d, stem + ".metadata.json")
            if os.path.isfile(meta_path):
                try:
                    with open(meta_path, "r", encoding="utf-8") as f:
                        md = _json.load(f)
                    words = (md.get("civitai") or {}).get("trainedWords") or []
                    title = md.get("model_name") or stem
                except Exception:
                    pass
            preview = None
            # 預覽圖不限 .png——ComfyUI/civitai 常見 .webp、也可能 jpeg。先找明確的
            # .preview.* ，再找同名 stem.* 。副檔名順序＝優先序（先命中先用）。
            for ext in (".preview.png", ".preview.jpeg", ".preview.jpg", ".preview.webp",
                        ".png", ".jpg", ".jpeg", ".webp"):
                if os.path.isfile(os.path.join(d, stem + ext)):
                    preview = stem + ext
                    break
            items.append({
                "folder": folder,           # 完整相對路徑，送 ComfyUI 時轉 "\\" 當前綴
                "category": category,       # 頂層分類，給篩選晶片比對用
                "file": fn,
                "name": stem,
                "title": title,
                "trainedWords": words,
                "preview": preview,
            })
            n += 1
        counts[category] = n
    payload = {"items": items, "counts": counts, "folders": LORA_FOLDERS}
    if errs:
        payload["error"] = "；".join(errs)
    body = _json.dumps(payload, ensure_ascii=False).encode("utf-8")
    _lora_list_cache["payload"] = body
    _lora_list_cache["at"] = time.time()
    send_body(client, body, "application/json")


def serve_lora_preview(client, raw_path):
    """送出單一 LoRA 的預覽圖。folder 現在可能帶子資料夾（如 "Character/Hanime"，見
    serve_lora_list()），驗證比照 darkroom/preview_ui.py 的 lora_preview_path()：第一段
    須在白名單、每一段不得是空字串或 ".."，file 仍須為純檔名（擋目錄穿越），最後再確認
    解析後的路徑真的落在 LORA_ROOT 底下，雙重保險。"""
    from urllib.parse import urlparse, parse_qs, unquote
    q = parse_qs(urlparse(raw_path).query)
    folder = unquote((q.get("folder") or [""])[0])
    fn = unquote((q.get("file") or [""])[0])
    parts = folder.split("/") if folder else []
    bad = (not fn or "/" in fn or "\\" in fn or fn in (".", "..")
           or "\\" in folder or not parts or parts[0] not in LORA_FOLDERS
           or any(p in ("", "..") for p in parts))
    if bad:
        client.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        return
    path = os.path.join(LORA_ROOT, *parts, fn)
    root_abs = os.path.abspath(LORA_ROOT)
    path_abs = os.path.abspath(path)
    if path_abs != root_abs and not path_abs.startswith(root_abs + os.sep):
        client.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        return
    if not os.path.isfile(path):
        client.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        return
    ctype = mimetypes.guess_type(path)[0] or "image/png"
    with open(path, "rb") as f:
        body = f.read()
    header = (
        "HTTP/1.1 200 OK\r\n"
        f"Content-Type: {ctype}\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Cache-Control: max-age=86400\r\n"
        "Connection: close\r\n\r\n"
    ).encode("utf-8")
    client.sendall(header + body)


def _lora_push_json(client, obj, status=200):
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
        "Connection: close\r\n\r\n"
    ).encode("utf-8")
    client.sendall(header + body)


def serve_lora_push_get(client, raw_path):
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
    _lora_push_json(client, out)


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
        _lora_push_json(client, {"error": "缺少 name"}, 400)
        return
    with _LORA_PUSH_LOCK:
        _LORA_PUSH["ver"] += 1
        _LORA_PUSH["data"] = {"folder": folder, "name": name}
        ver = _LORA_PUSH["ver"]
    print(f"[lora-push] {folder}/{name} (ver={ver})")
    _lora_push_json(client, {"ok": True, "ver": ver})


def serve_lora_push_options(client):
    """CORS 預檢：7861 跨源打 7801，application/json 的 POST 瀏覽器一定先送 OPTIONS。"""
    client.sendall(
        b"HTTP/1.1 204 No Content\r\n"
        b"Access-Control-Allow-Origin: *\r\n"
        b"Access-Control-Allow-Methods: POST, GET, OPTIONS\r\n"
        b"Access-Control-Allow-Headers: Content-Type\r\n"
        b"Content-Length: 0\r\n\r\n"
    )


def _prompt_folders():
    """special_prompts 底下的分類子夾（排序、略過 __ 開頭與非目錄）。"""
    try:
        return sorted(d for d in os.listdir(PROMPTS_ROOT)
                      if not d.startswith("__") and os.path.isdir(os.path.join(PROMPTS_ROOT, d)))
    except OSError:
        return []


def serve_prompt_list(client):
    """列出各分類夾內的詞庫（.py）與是否有預覽圖，給 Illustrious 詞庫選單用。內容不解析（清單要輕）。"""
    import json as _json
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
    send_body(client, _json.dumps({"items": items, "counts": counts, "folders": folders},
                                  ensure_ascii=False).encode("utf-8"), "application/json")


def serve_prompt_detail(client, raw_path):
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
        client.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
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
        client.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        return
    send_body(client, _json.dumps(out, ensure_ascii=False).encode("utf-8"), "application/json")


def serve_prompt_preview(client, raw_path):
    """送出詞庫的 .webp 預覽圖。cat 須在分類白名單、file 純檔名，擋目錄穿越。"""
    from urllib.parse import urlparse, parse_qs, unquote
    q = parse_qs(urlparse(raw_path).query)
    folder = unquote((q.get("cat") or [""])[0])
    fn = unquote((q.get("file") or [""])[0])
    bad = (folder not in _prompt_folders() or not fn
           or "/" in fn or "\\" in fn or ".." in fn)
    if bad:
        client.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        return
    path = os.path.join(PROMPTS_ROOT, folder, fn)
    if not os.path.isfile(path):
        client.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        return
    ctype = mimetypes.guess_type(path)[0] or "image/webp"
    with open(path, "rb") as f:
        body = f.read()
    header = (
        "HTTP/1.1 200 OK\r\n"
        f"Content-Type: {ctype}\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Cache-Control: max-age=86400\r\n"
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


def handle(client, ssl_ctx=None):
    try:
        client.settimeout(30)
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
        elif method == "GET" and path == "/panel/loras" and not is_ws:
            # 面板專屬端點（不轉發給 ComfyUI）：列出 loras/style 的觸發詞與預覽圖
            serve_lora_list(client)
            client.close()
        elif method == "GET" and path == "/panel/lora-preview" and not is_ws:
            serve_lora_preview(client, raw_path)
            client.close()
        elif method == "GET" and path == "/panel/lora-push" and not is_ws:
            serve_lora_push_get(client, raw_path)
            client.close()
        elif method == "POST" and path == "/panel/lora-push" and not is_ws:
            serve_lora_push_post(client, initial)
            client.close()
        elif method == "OPTIONS" and path == "/panel/lora-push" and not is_ws:
            serve_lora_push_options(client)
            client.close()
        elif method == "GET" and path == "/panel/prompts" and not is_ws:
            serve_prompt_list(client)
            client.close()
        elif method == "GET" and path == "/panel/prompt" and not is_ws:
            serve_prompt_detail(client, raw_path)
            client.close()
        elif method == "GET" and path == "/panel/prompt-preview" and not is_ws:
            serve_prompt_preview(client, raw_path)
            client.close()
        elif is_ws and path.startswith("/assistant"):
            # 助理語音 WS：同源代理到本機語音服務，路徑改寫成它期望的 /v1/realtime。
            # 手機走 HTTPS 面板時，這條走同源 wss，本代理做 TLS 終止再轉明文到 8765。
            initial = rewrite_request_path(initial, "/v1/realtime")
            proxy_upstream(client, initial, ASST_HOST, ASST_PORT, True, "語音服務（請先啟動 voice-assistant/start_assistant.py）")
        elif path in LT_PATHS and not is_ws:
            # 對嘴數字人：同源轉發到 LiveTalking。路徑原樣送過去，不改寫。
            proxy_upstream(client, initial, LT_HOST, LT_PORT, False,
                           "對嘴服務（請先啟動 start_livetalking_qwen.bat）")
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

    ssl_ctx = None
    if USE_HTTPS:
        if ensure_cert():
            ssl_ctx = make_ssl_context()
        else:
            print("[HTTPS] 憑證未就緒，退回 HTTP。")
    scheme = "https" if ssl_ctx else "http"
    ip = lan_ip()
    print("=" * 60)
    print("  Flux2 Klein ComfyUI 面板已啟動")
    print(f"  ▶ 本機： {scheme}://127.0.0.1:{LISTEN_PORT}/klein")
    print(f"  ▶ 區網（手機/其他電腦）： {scheme}://{ip}:{LISTEN_PORT}/klein")
    print(f"  ▶ 代理到 ComfyUI： {COMFY_HOST}:{COMFY_PORT}")
    if ssl_ctx:
        print("  （HTTPS 自簽憑證：手機第一次會跳「不安全」警告，選「繼續前往」即可；")
        print("    語音輸入等需要麥克風的功能只有 HTTPS 或 localhost 才可用；按 Ctrl+C 停止）")
    print("  （綁 0.0.0.0，但只放行本機與 Tailscale（100.64.0.0/10）來源；")
    print("    區網／公網其他 IP 連進來會被直接斷線、不回應；按 Ctrl+C 停止）")
    print("=" * 60)
    try:
        while True:
            client, addr = srv.accept()
            if not _client_allowed(addr[0]):
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
