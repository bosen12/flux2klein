#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate_special_previews.py
============================
為 special_prompts/ 底下每個詞庫 .py 呼叫本地 ComfyUI 生圖，
圖片以「詞庫檔名.png」存到該 .py 旁邊。

用法（在 animebot 目錄）：
    python generate_special_previews.py
    python generate_special_previews.py --folder 32_運動少女走光
    python generate_special_previews.py --limit 10
    python generate_special_previews.py --no-overwrite
    python generate_special_previews.py --comfy http://127.0.0.1:8188

預設：
  - 工作流 C:\\Users\\boshe\\Downloads\\ANIMESTYLE.json（模型 waiIllustriousSDXL_v170）
  - steps=25
  - 每次覆蓋同名 .png

依賴：標準庫 only（urllib / json / pathlib）
需要：ComfyUI 已啟動，且有工作流裡的 checkpoint。
"""

from __future__ import annotations

import argparse
import ast
import base64
import copy
import importlib.util
import json
import random
import sys
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# 路徑
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent
SPECIAL_DIR = ROOT / "special_prompts"
# 預設工作流（含 checkpoint：waiIllustriousSDXL_v170）
DEFAULT_WORKFLOW = Path(r"C:\Users\boshe\Downloads\ANIMESTYLE.json")
DEFAULT_WORKFLOWS = [
    DEFAULT_WORKFLOW,
    Path.home() / "Downloads" / "ANIMESTYLE.json",
    ROOT / "ANIMESTYLE.json",
]

# WAI Illustrious 品質標（若詞庫 REQUIRED 已有會自動去重）
ILLUS_QUALITY = [
    "masterpiece",
    "best quality",
    "amazing quality",
    "absurdres",
    "highres",
    "very aesthetic",
]

DEFAULT_NEG = (
    "text,speech bubble,watermark,signature,username,logo,"
    "bad quality,worst quality,worst detail,sketch,censor,"
    "censored,bar censor,mosaic censoring,lowres,bad anatomy,bad hands,"
    "child,loli,shota,pale skin,belly bulge"
)


# ---------------------------------------------------------------------------
# ComfyUI HTTP
# ---------------------------------------------------------------------------
# urllib 預設不帶 User-Agent（送出去是空的，或某些版本是 "Python-urllib/3.x"）。
# RunPod 的代理會把沒有 UA 的請求當爬蟲擋掉、回 403——本機直連 ComfyUI 不會遇到，
# 只有透過 RunPod 這種反向代理才會踩到，坑很隱蔽：resolve_comfy_base() 探測失敗後
# 靜默 fallback 回本機 127.0.0.1:8188，表面上「連上了」，實際上整個是本機顯卡在跑，
# 不是 RunPod 的 GPU。
_UA_HEADERS = {"User-Agent": "darkroom-preview-ui/1.0"}


def _split_basic_auth(url: str) -> tuple[str, dict]:
    """comfy_endpoints 有些位址帶 user:pass@host（例如 vast.ai 的 Instance Portal，
    對外 port 一律要 Basic Auth，帳號固定 vastai、密碼是每台 instance 專屬的
    OPEN_BUTTON_TOKEN）。urllib 不會自動把 URL 裡的 userinfo 轉成 Authorization
    header，要自己拆出來組。回傳 (拿掉 userinfo 的乾淨 URL, 要疊加的 headers)。"""
    u = urllib.parse.urlsplit(url)
    if not u.username:
        return url, {}
    userinfo = u.username + (f":{u.password}" if u.password else "")
    auth = base64.b64encode(userinfo.encode("utf-8")).decode("ascii")
    netloc = u.hostname + (f":{u.port}" if u.port else "")
    clean = urllib.parse.urlunsplit((u.scheme, netloc, u.path, u.query, u.fragment))
    return clean, {"Authorization": f"Basic {auth}"}


def http_json(method: str, url: str, data: dict | None = None, timeout: float = 60):
    body = None
    clean_url, auth_headers = _split_basic_auth(url)
    headers = dict(_UA_HEADERS, **auth_headers)
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(clean_url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))


def http_bytes(url: str, timeout: float = 120) -> bytes:
    clean_url, auth_headers = _split_basic_auth(url)
    req = urllib.request.Request(clean_url, headers=dict(_UA_HEADERS, **auth_headers), method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def resolve_comfy_base(preferred: str) -> str:
    """試 preferred 與常見 WSL→Windows 位址，回傳可用的 base URL（無結尾 /）。"""
    candidates = [preferred.rstrip("/")]
    # WSL2 常見：Windows host = default gateway
    try:
        import subprocess
        r = subprocess.run(
            ["bash", "-lc", "ip route show | awk '/default/{print $3; exit}'"],
            capture_output=True, text=True, timeout=5,
        )
        gw = (r.stdout or "").strip()
        if gw:
            candidates.append(f"http://{gw}:8188")
    except Exception:
        pass
    candidates += [
        "http://127.0.0.1:8188",
        "http://localhost:8188",
        "http://host.docker.internal:8188",
    ]
    seen = set()
    for base in candidates:
        if base in seen:
            continue
        seen.add(base)
        try:
            http_json("GET", f"{base}/system_stats", timeout=3)
            return base
        except Exception:
            continue
    raise RuntimeError(
        "連不上 ComfyUI。請確認已啟動，並用 --comfy 指定位址。\n"
        f"試過：{', '.join(seen)}"
    )


# ---------------------------------------------------------------------------
# 詞庫載入
# ---------------------------------------------------------------------------
def load_lib(py_path: Path) -> tuple[list[str], list[str], list[str]]:
    """回傳 (REQUIRED_POSITIVE, POSITIVE, NEGATIVE)。"""
    spec = importlib.util.spec_from_file_location(f"_splib_{py_path.stem}", py_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"無法載入：{py_path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    req = list(getattr(mod, "REQUIRED_POSITIVE", []) or [])
    pos = list(getattr(mod, "POSITIVE", []) or [])
    neg = list(getattr(mod, "NEGATIVE", []) or [])
    return req, pos, neg


_TAG_KEYMAP = {"REQUIRED_POSITIVE": 0, "POSITIVE": 1, "NEGATIVE": 2}


def parse_lib_ast(py_path: Path) -> tuple[list[str], list[str], list[str]]:
    """回傳 (REQUIRED_POSITIVE, POSITIVE, NEGATIVE)，跟 load_lib() 同樣的資料，但用
    ast.literal_eval 唯讀解析、不 import／不執行檔案——建標籤索引要一次掃過全部詞庫
    （上萬個檔案），用 load_lib() 的 importlib 逐一 exec_module 太重。跟 serve.py 的
    serve_prompt_detail()（面板詞庫端點）用同一招，兩邊解析結果本來就該一致。"""
    out: list[list[str]] = [[], [], []]
    tree = ast.parse(py_path.read_text(encoding="utf-8"))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for t in node.targets:
            if isinstance(t, ast.Name) and t.id in _TAG_KEYMAP:
                try:
                    val = ast.literal_eval(node.value)
                except Exception:
                    val = []
                if isinstance(val, list):
                    out[_TAG_KEYMAP[t.id]] = [str(x) for x in val]
    return out[0], out[1], out[2]


def split_tags(items: list[str]) -> list[str]:
    """把 REQUIRED_POSITIVE/POSITIVE/NEGATIVE 的字串元素再拆一次：詞庫檔案裡同一個
    標籤有時寫成獨立元素、有時整組塞進一個字串（"A,B,C"／"A, B, C,"／"A,B, C," 都有人
    寫過，逗號後面有沒有空白、結尾有沒有多逗號不一致），這裡統一 split(",") + strip()，
    把每個字串元素再拆成一串「原子標籤」，過濾掉拆出來的空字串。跟 build_prompt()／
    build_negative() 既有的 split(",") 是同一招，只是抽成共用函式給標籤搜尋用。"""
    out: list[str] = []
    for item in items:
        for piece in str(item).split(","):
            t = piece.strip()
            if t:
                out.append(t)
    return out


def build_prompt(req: list[str], pos: list[str]) -> str:
    """品質標 + REQUIRED + POSITIVE，去重保序。"""
    parts: list[str] = []
    seen: set[str] = set()

    def add_chunk(s: str):
        for piece in str(s).split(","):
            t = piece.strip()
            if not t:
                continue
            key = t.lower()
            if key in seen:
                continue
            seen.add(key)
            parts.append(t)

    for q in ILLUS_QUALITY:
        add_chunk(q)
    for r in req:
        add_chunk(r)
    for p in pos:
        add_chunk(p)
    return ", ".join(parts)


def build_negative(neg: list[str]) -> str:
    """跟 Illustrious 面板（app.js 的詞庫負向 negSource）同一套解讀：詞庫自己有
    NEGATIVE 就整段取代掉負向，不跟 DEFAULT_NEG 合併；沒有 NEGATIVE 才退回
    DEFAULT_NEG 當底（等同面板選「預設負向」）。以前這裡不管詞庫有沒有自己的
    NEGATIVE，一律跟 DEFAULT_NEG 合併，跟面板「詞庫負向／預設負向 二選一、
    不合併」的解讀不一致。"""
    if not neg:
        return DEFAULT_NEG
    parts: list[str] = []
    seen: set[str] = set()
    for piece in ",".join(neg).split(","):
        t = piece.strip()
        if not t:
            continue
        key = t.lower()
        if key in seen:
            continue
        seen.add(key)
        parts.append(t)
    return ", ".join(parts)


# ---------------------------------------------------------------------------
# Workflow
# ---------------------------------------------------------------------------
def load_workflow(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def find_node(workflow: dict, class_type: str) -> str | None:
    for nid, node in workflow.items():
        if isinstance(node, dict) and node.get("class_type") == class_type:
            return str(nid)
    return None


def prepare_workflow(
    template: dict,
    positive: str,
    negative: str,
    seed: int | None = None,
    filename_prefix: str = "special_preview",
    steps: int = 25,
) -> dict:
    wf = copy.deepcopy(template)

    pos_id = find_node(wf, "CLIPTextEncode")
    # 找正負：通常 36 正、37 負；依 title 或順序
    pos_node = neg_node = None
    for nid, node in wf.items():
        if not isinstance(node, dict) or node.get("class_type") != "CLIPTextEncode":
            continue
        title = (node.get("_meta") or {}).get("title", "")
        if "負" in title or "neg" in title.lower() or "negative" in title.lower():
            neg_node = nid
        elif "正" in title or "pos" in title.lower() or "positive" in title.lower():
            pos_node = nid
    # fallback：第一個 CLIP 當正、第二個當負
    clip_nodes = [nid for nid, n in wf.items() if isinstance(n, dict) and n.get("class_type") == "CLIPTextEncode"]
    if pos_node is None and clip_nodes:
        pos_node = clip_nodes[0]
    if neg_node is None and len(clip_nodes) > 1:
        neg_node = clip_nodes[1]

    if pos_node is None or neg_node is None:
        raise RuntimeError("工作流找不到正向/負向 CLIPTextEncode 節點")

    wf[pos_node]["inputs"]["text"] = positive
    wf[neg_node]["inputs"]["text"] = negative

    # seed + steps
    for nid, node in wf.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") in ("KSampler", "KSamplerAdvanced"):
            if seed is None:
                seed = random.randint(0, 2**63 - 1)
            if "seed" in node.get("inputs", {}):
                node["inputs"]["seed"] = int(seed)
            if "noise_seed" in node.get("inputs", {}):
                node["inputs"]["noise_seed"] = int(seed)
            if "steps" in node.get("inputs", {}):
                node["inputs"]["steps"] = int(steps)

    # SaveImage prefix（Comfy 輸出用；我們仍會下載另存）
    for nid, node in wf.items():
        if isinstance(node, dict) and node.get("class_type") == "SaveImage":
            node["inputs"]["filename_prefix"] = filename_prefix

    return wf


def queue_and_wait(base: str, workflow: dict, timeout: float = 600) -> list[dict]:
    client_id = str(uuid.uuid4())
    result = http_json(
        "POST",
        f"{base}/prompt",
        {"prompt": workflow, "client_id": client_id},
        timeout=60,
    )
    if not result or "prompt_id" not in result:
        raise RuntimeError(f"queue 失敗：{result}")
    prompt_id = result["prompt_id"]

    deadline = time.time() + timeout
    while time.time() < deadline:
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
        # 檢查 queue 錯誤
        try:
            q = http_json("GET", f"{base}/queue", timeout=10)
            # 若 history 有 error 會在下面超時
        except Exception:
            pass
        time.sleep(1.5)

    raise TimeoutError(f"超過 {timeout}s 未完成：{prompt_id}")


def download_image(base: str, image_info: dict) -> bytes:
    params = urllib.parse.urlencode(
        {
            "filename": image_info["filename"],
            "subfolder": image_info.get("subfolder") or "",
            "type": image_info.get("type") or "output",
        }
    )
    return http_bytes(f"{base}/view?{params}", timeout=120)


# ---------------------------------------------------------------------------
# 掃描詞庫
# ---------------------------------------------------------------------------
def iter_libraries(folder: str | None = None) -> list[Path]:
    base = SPECIAL_DIR
    if folder:
        base = SPECIAL_DIR / folder
        if not base.is_dir():
            raise FileNotFoundError(f"找不到資料夾：{base}")
    libs = sorted(
        p for p in base.rglob("*.py")
        if p.is_file()
        and not p.name.startswith("_")
        and p.name != "__init__.py"
        and "__pycache__" not in p.parts
    )
    return libs


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="為 special_prompts 詞庫批次生圖（ComfyUI）")
    ap.add_argument("--comfy", default="http://127.0.0.1:8188", help="ComfyUI 位址")
    ap.add_argument(
        "--workflow",
        default=str(DEFAULT_WORKFLOW),
        help=r"工作流 JSON（預設 C:\Users\boshe\Downloads\ANIMESTYLE.json）",
    )
    ap.add_argument("--folder", default="", help="只跑某個子資料夾，例如 32_運動少女走光")
    ap.add_argument("--limit", type=int, default=0, help="最多生幾張（0=全部）")
    ap.add_argument(
        "--no-overwrite",
        action="store_true",
        help="已有 png 則跳過（預設：每次覆蓋原 png）",
    )
    ap.add_argument("--seed", type=int, default=-1, help="固定 seed（-1=每張隨機）")
    ap.add_argument("--steps", type=int, default=25, help="KSampler steps（預設 25）")
    ap.add_argument("--timeout", type=int, default=600, help="單張等待秒數")
    ap.add_argument("--dry-run", action="store_true", help="只列清單不生圖")
    args = ap.parse_args()

    # workflow：固定用 Downloads 的 ANIMESTYLE.json（內含 waiIllustriousSDXL_v170）
    wf_path = Path(args.workflow)
    if not wf_path.is_file():
        wf_path = next((p for p in DEFAULT_WORKFLOWS if p.is_file()), None)
    if wf_path is None or not wf_path.is_file():
        print(r"找不到工作流。請確認 C:\Users\boshe\Downloads\ANIMESTYLE.json 存在")
        sys.exit(1)

    template = load_workflow(wf_path)
    ckpt = None
    for node in template.values():
        if isinstance(node, dict) and node.get("class_type") == "CheckpointLoaderSimple":
            ckpt = node.get("inputs", {}).get("ckpt_name")
            break
    print(f"[workflow] {wf_path}")
    print(f"[model]    {ckpt or '(工作流未標示 checkpoint)'}")
    print(f"[steps]    {args.steps}")
    print(f"[png]      每次覆蓋原檔案" if not args.no_overwrite else "[png]      已有則跳過")

    if args.dry_run:
        libs = iter_libraries(args.folder or None)
        print(f"[dry-run] {len(libs)} 個詞庫")
        for p in libs[:20]:
            print(" ", p.relative_to(SPECIAL_DIR))
        if len(libs) > 20:
            print(f"  ... 還有 {len(libs)-20} 個")
        return

    print(f"[comfy] 連線中 {args.comfy} ...")
    try:
        base = resolve_comfy_base(args.comfy)
    except RuntimeError as e:
        print(e)
        sys.exit(1)
    print(f"[comfy] OK → {base}")

    libs = iter_libraries(args.folder or None)
    if args.limit and args.limit > 0:
        libs = libs[: args.limit]

    total = len(libs)
    ok = skip = fail = 0
    print(f"[start] 共 {total} 個詞庫 → 圖片放在各 .py 旁邊\n")

    log_path = ROOT / "generate_special_previews.log"
    with log_path.open("a", encoding="utf-8") as log:
        log.write(f"\n==== {time.strftime('%Y-%m-%d %H:%M:%S')} total={total} ====\n")

        for i, py in enumerate(libs, 1):
            out_png = py.with_suffix(".png")
            rel = py.relative_to(SPECIAL_DIR)

            if out_png.is_file() and args.no_overwrite:
                skip += 1
                print(f"[{i}/{total}] SKIP 已有圖  {rel}")
                continue

            try:
                req, pos, neg = parse_lib_ast(py)
                positive = build_prompt(req, pos)
                negative = build_negative(neg)
                seed = args.seed if args.seed >= 0 else random.randint(0, 2**63 - 1)

                # Comfy 輸出前綴（僅內部）；真正檔名是旁邊的 .png
                safe_prefix = f"special/{py.parent.name}/{py.stem}"[:180]
                wf = prepare_workflow(
                    template,
                    positive=positive,
                    negative=negative,
                    seed=seed,
                    filename_prefix=safe_prefix,
                    steps=args.steps,
                )

                t0 = time.time()
                images = queue_and_wait(base, wf, timeout=args.timeout)
                img_bytes = download_image(base, images[0])
                out_png.write_bytes(img_bytes)
                dt = time.time() - t0
                ok += 1
                msg = f"[{i}/{total}] OK  {rel}  ({dt:.1f}s, {len(img_bytes)//1024}KB, seed={seed})"
                print(msg)
                log.write(msg + "\n")
                log.flush()

            except KeyboardInterrupt:
                print("\n使用者中斷。")
                break
            except Exception as e:
                fail += 1
                msg = f"[{i}/{total}] FAIL {rel}  → {e}"
                print(msg)
                log.write(msg + "\n")
                log.flush()
                time.sleep(1)

    print(f"\n完成：OK={ok}  SKIP={skip}  FAIL={fail}  / total={total}")
    print(f"日誌：{log_path}")


if __name__ == "__main__":
    main()
