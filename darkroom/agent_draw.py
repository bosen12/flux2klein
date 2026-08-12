#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
agent_draw.py
=============
給外部 AI agent 用的「抽卡」工具：連正在跑的 preview_ui.py（暗房），從詞庫抽 N 筆、
送去生成、等完成、把結果圖存下來。

抽卡（隨機挑選）這一步是在**伺服器端**做的（preview_ui.py 的 /api/agent-draw），
不是這支腳本自己抓 /api/libs 全部 27000+ 筆再篩選——那樣的回應大到不適合真的要
「看」內容的呼叫端（例如只能打 HTTP API、把回應塞進自己 context 的 LLM agent）。
這支腳本只是把「送出 → 等完成 → 下載」包成好用的 CLI／函式庫，本身不做挑選。
只依賴標準函式庫 + urllib，跟 preview_ui.py 同一個依賴政策。

前提：暗房已經在跑（python preview_ui.py），而且這支腳本跟它在同一台機器
（preview_ui.py 沒有任何身份驗證，預設監聽 0.0.0.0，不要對外網開放）。

CLI 用法：
    python agent_draw.py --n 3
    python agent_draw.py --n 5 --folder 01_NTR偷情 --out ./drawn
    python agent_draw.py --n 1 --rarity legendary   # 只抽某個稀有度
    python agent_draw.py --n 3 --lora style/foo.safetensors:0.8

當函式庫用：
    from agent_draw import draw_and_generate
    results, loras_used = draw_and_generate(n=3, base_url="http://127.0.0.1:7860")
    for r in results:
        print(r["rel"], r["out_path"])

只用 HTTP 呼叫（不能跑 shell/python 的 agent）：直接呼叫 /api/agent-draw，
不需要這支腳本——見同目錄 AGENT_DRAW.md。

Discord 真正的 rich embed（不是 MEDIA: 附件那種）：
    python agent_draw.py --n 8 --discord-dm
需要先在 preview_config.json（已 gitignore，跟 comfy_endpoints 那些機器相關設定
同一份檔案）填 discord_bot_token 與 discord_dm_user_id，見 AGENT_DRAW.md。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_BASE_URL = "http://127.0.0.1:7860"
POLL_INTERVAL_S = 0.8   # 前端是 500ms，這裡沒有即時預覽的需求，放寬一點不必要地打伺服器
POLL_TIMEOUT_S = 300.0  # 單張生成逾時（跟前端 preview_config 的 timeout 概念一致）
DISCORD_API = "https://discord.com/api/v10"
DISCORD_EMBED_COLOR = 0xEAAD57   # 面板安全燈琥珀色，跟暗房其他地方的 accent 一致
DISCORD_MAX_EMBEDS_PER_MSG = 10  # Discord 平台限制，不是我們自己定的

# preview_config.json 跟 preview_ui.py 共用同一份（同目錄），機器相關的路徑／密鑰都
# 放這裡、已 gitignore。這支腳本刻意不 import preview_ui（那邊會拉 Pillow 等依賴，
# 這支腳本要維持「只依賴標準函式庫」），所以自己讀一次，邏輯跟 preview_ui.load_config()
# 一致但不共用程式碼——各自獨立、互不影響。
CONFIG_PATH = Path(__file__).resolve().parent / "preview_config.json"


def _load_darkroom_config() -> dict:
    if CONFIG_PATH.is_file():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            if isinstance(cfg, dict):
                return cfg
        except Exception as e:
            print(f"[config] 讀取 {CONFIG_PATH.name} 失敗：{e}", file=sys.stderr)
    return {}


class DarkroomError(RuntimeError):
    pass


def _http_json(method: str, url: str, payload: dict | None = None, timeout: float = 30.0) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        raise DarkroomError(f"連不到暗房（{url}）：{e}。先確認 preview_ui.py 有在跑。") from e


def _http_bytes(url: str, timeout: float = 30.0) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read()


def submit_draw(n: int, *, base_url: str = DEFAULT_BASE_URL,
                 folder: str | None = None, rarity: str | None = None,
                 loras: list[tuple[str, float]] | None = None,
                 no_lora: bool = False,
                 trigger: str = "", client: str = "agent",
                 seed: int | None = None) -> tuple[list[dict], list[tuple[str, float]]]:
    """POST /api/agent-draw——伺服器端隨機抽 n 張並直接送生成。
    回傳 (items, loras_used)：items 是 [{"id", "rel", "name"}, ...]，用 id 去
    gen-status / gen-result 追蹤；loras_used 是伺服器端**實際套用**的 LoRA
    [(name, strength), ...]——不給 loras 時伺服器套的是它自己的
    AGENT_DRAW_DEFAULT_LORAS，呼叫端不用（也不該）自己重複那份預設值，跟伺服器
    要回來的才是單一事實來源。

    loras 不給（且 no_lora 不是 True）＝套伺服器端的預設畫風 LoRA。no_lora=True
    會明確送 "loras": []，關掉預設值。"""
    payload: dict = {"n": n, "client": client}
    if folder is not None:
        payload["folder"] = folder
    if rarity is not None:
        payload["rarity"] = rarity
    if loras:
        payload["loras"] = [{"file": f, "strength": s} for f, s in loras]
    elif no_lora:
        payload["loras"] = []
    if trigger:
        payload["trigger"] = trigger
    if seed is not None:
        payload["seed"] = seed
    j = _http_json("POST", f"{base_url}/api/agent-draw", payload)
    if j.get("error"):
        raise DarkroomError(j["error"])
    loras_used = [(name, strength) for name, strength in j.get("loras", [])]
    return j.get("items", []), loras_used


def wait_for_results(ids: list[str], *, base_url: str = DEFAULT_BASE_URL,
                      timeout: float = POLL_TIMEOUT_S,
                      on_update=None) -> dict[str, dict]:
    """輪詢 /api/gen-status 直到全部 id 都 done/error 或逾時。回傳 {id: status_dict}。
    on_update(status_map) 給了就每輪呼叫一次，方便 agent 自己接進度回報。"""
    pending = set(ids)
    final: dict[str, dict] = {}
    t0 = time.monotonic()
    while pending:
        if time.monotonic() - t0 > timeout:
            for gid in pending:
                final[gid] = {"status": "error", "err": "逾時（agent_draw.py 端）"}
            break
        status_map = _http_json("GET", f"{base_url}/api/gen-status?ids={','.join(pending)}")
        if on_update:
            on_update(status_map)
        for gid in list(pending):
            st = status_map.get(gid, {})
            if st.get("status") in ("done", "error"):
                final[gid] = st
                pending.discard(gid)
        if pending:
            time.sleep(POLL_INTERVAL_S)
    return final


def fetch_result_bytes(gid: str, *, base_url: str = DEFAULT_BASE_URL) -> bytes:
    """GET /api/gen-result?id=... —— 只有對應項目 status=done 才拿得到，回傳 webp bytes。"""
    return _http_bytes(f"{base_url}/api/gen-result?id={urllib.parse.quote(gid)}")


def draw_and_generate(n: int, *, base_url: str = DEFAULT_BASE_URL,
                       folder: str | None = None, rarity: str | None = None,
                       loras: list[tuple[str, float]] | None = None,
                       no_lora: bool = False,
                       trigger: str = "", out_dir: str | Path = "agent_draws",
                       seed: int | None = None) -> tuple[list[dict], list[tuple[str, float]]]:
    """一次做完：抽 n 張 → 送生成 → 等完成 → 存檔。回傳 (results, loras_used)：
    results 是每張的 [{"rel", "name", "id", "status", "out_path" 或 "error"}, ...]，
    loras_used 是伺服器端實際套用的 LoRA（見 submit_draw 的說明）。

    n 大於候選池時會抽到全部（不重複抽同一張——暗房塔羅抽卡也是這樣，一批裡不重複）。
    不給 loras 就套伺服器端的預設畫風 LoRA；no_lora=True 明確關掉。
    """
    submitted, loras_used = submit_draw(n, base_url=base_url, folder=folder, rarity=rarity,
                                         loras=loras, no_lora=no_lora, trigger=trigger, seed=seed)
    id_to_meta = {it["id"]: it for it in submitted}

    def progress(status_map):
        for gid, st in status_map.items():
            name = id_to_meta.get(gid, {}).get("name", gid)
            print(f"  [{st.get('status', '?'):8}] {name}", file=sys.stderr)

    final = wait_for_results([it["id"] for it in submitted], base_url=base_url, on_update=progress)

    # 絕對路徑——這不是隨便的整潔習慣：Hermes 的 send_message 工具用 MEDIA:<路徑> 夾在
    # 訊息文字裡投遞附件，那條路徑必須是絕對路徑（gateway/platforms/base.py 的
    # validate_media_delivery_path 對相對路徑直接回 None，不會報錯、就是靜默不投遞）。
    # out_dir 預設是 "agent_draws" 這種相對路徑，agent 呼叫這支腳本時的工作目錄不一定
    # 是這裡，用 .resolve() 在寫檔當下就固定成絕對路徑，之後不管誰在哪裡讀這個值都對。
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for it in submitted:
        gid, rel, name = it["id"], it["rel"], it["name"]
        st = final.get(gid, {})
        if st.get("status") == "done":
            data = fetch_result_bytes(gid, base_url=base_url)
            safe_name = "".join(c if c.isalnum() or c in "-_." else "_" for c in name)[:80]
            out_path = out_dir / f"{safe_name}.{gid}.webp"
            out_path.write_bytes(data)
            results.append({"rel": rel, "name": name, "id": gid, "status": "done", "out_path": str(out_path)})
        else:
            results.append({"rel": rel, "name": name, "id": gid, "status": st.get("status", "error"),
                             "error": st.get("err", "")})
    return results, loras_used


def _parse_lora_arg(spec: str) -> tuple[str, float]:
    """"style/foo.safetensors:0.8" -> ("style/foo.safetensors", 0.8)；沒帶強度就預設 0.8。"""
    if ":" in spec:
        path, strength = spec.rsplit(":", 1)
        return path, float(strength)
    return spec, 0.8


# ── Discord 真正的 rich embed（DM，用 bot token 直接打 REST API）─────────────
# 為什麼不是走 Hermes 的 send_message 工具：那個工具是 Hermes 十幾個平台共用的
# 「最大公約數」介面，只有純文字 + MEDIA: 附件，沒有 embed 參數（Telegram/WhatsApp
# 沒有 embed 這個概念，Hermes 沒把它做進跨平台抽象裡）。Hermes 內部其實有
# discord.Embed，但那是它自己系統訊息用的，沒開放給模型呼叫。
# 為什麼不是走 webhook：webhook 綁定的是伺服器頻道，Discord 不支援 webhook 投遞到
# DM。要嘛換頻道用 webhook，要嘛用一個真正有 bot token 的身分直接呼叫 REST API
# 送 DM——這裡走後者，好處是不用换收圖的地方，仍然留在 DM。

def _lora_desc(loras: list[tuple[str, float]] | None) -> str:
    if not loras:
        return "無"
    return "、".join(f"{Path(name).stem} @ {strength}" for name, strength in loras)


def build_discord_embeds(results: list[dict], loras: list[tuple[str, float]] | None) -> list[tuple[dict, str, bytes]]:
    """把 draw_and_generate() 的結果轉成 [(embed_dict, filename, file_bytes), ...]，
    只含 status=done 的項目（失敗的沒有圖可以嵌）。

    標題＝系列（資料夾）＋詞庫名稱；欄位只放 LoRA——使用者只要這兩件事，不多加
    seed/steps 這些暗房本來就沒有特別強調的資訊，需要的話之後再加。
    """
    lora_text = _lora_desc(loras)
    out = []
    for r in results:
        if r.get("status") != "done":
            continue
        rel = r["rel"]
        folder = rel.rsplit("/", 1)[0] if "/" in rel else "(根目錄)"
        title = f"{folder} ・ {r['name']}"
        out_path = Path(r["out_path"])
        filename = f"{r['id']}.webp"
        embed = {
            "title": title[:256],   # Discord embed title 上限 256 字元
            "color": DISCORD_EMBED_COLOR,
            "fields": [{"name": "LoRA", "value": lora_text, "inline": True}],
            "image": {"url": f"attachment://{filename}"},
        }
        out.append((embed, filename, out_path.read_bytes()))
    return out


def _multipart_body(fields: dict, files: list[tuple[str, str, bytes]]) -> tuple[bytes, str]:
    """組 multipart/form-data 的 body。fields 是一般表單欄位（{name: value}），
    files 是 [(form_field_name, filename, bytes), ...]。回傳 (body, content_type)。
    只依賴標準函式庫——這專案的依賴政策不用 requests。"""
    boundary = "----darkroomAgentDraw" + os.urandom(8).hex()
    parts = []
    for name, value in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8")
            + value.encode("utf-8") + b"\r\n"
        )
    for field_name, filename, data in files:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'
            f'Content-Type: image/webp\r\n\r\n'.encode("utf-8")
            + data + b"\r\n"
        )
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _resolve_dm_channel(bot_token: str, user_id: str) -> str:
    """開（或拿到既有的）跟這個使用者的 DM 頻道 id。Discord 這端要求 bot 跟這個
    使用者share 過至少一個伺服器，不然開不了。"""
    req = urllib.request.Request(
        f"{DISCORD_API}/users/@me/channels",
        data=json.dumps({"recipient_id": user_id}).encode("utf-8"),
        method="POST",
        headers={"Authorization": f"Bot {bot_token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))["id"]


def send_discord_embeds_dm(embeds_with_files: list[tuple[dict, str, bytes]], *,
                            bot_token: str, user_id: str) -> None:
    """把 build_discord_embeds() 的結果送成 DM。超過 10 個 embed 自動分成多則訊息
    （Discord 平台上限），每則各自帶自己的圖片附件。"""
    if not embeds_with_files:
        return
    channel_id = _resolve_dm_channel(bot_token, user_id)
    chunks = [embeds_with_files[i:i + DISCORD_MAX_EMBEDS_PER_MSG]
              for i in range(0, len(embeds_with_files), DISCORD_MAX_EMBEDS_PER_MSG)]
    for chunk in chunks:
        embeds = [e for e, _, _ in chunk]
        files = [(f"files[{i}]", fname, data) for i, (_, fname, data) in enumerate(chunk)]
        attachments = [{"id": i, "filename": fname} for i, (_, fname, _) in enumerate(chunk)]
        payload = {"embeds": embeds, "attachments": attachments}
        body, content_type = _multipart_body({"payload_json": json.dumps(payload)}, files)
        req = urllib.request.Request(
            f"{DISCORD_API}/channels/{channel_id}/messages",
            data=body, method="POST",
            headers={"Authorization": f"Bot {bot_token}", "Content-Type": content_type},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            raise DarkroomError(f"Discord 回傳 {e.code}：{detail}") from e


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", type=int, default=1, help="抽幾張")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"暗房位址（預設 {DEFAULT_BASE_URL}）")
    ap.add_argument("--folder", default=None, help="只從這個資料夾抽")
    ap.add_argument("--rarity", default=None, choices=["common", "rare", "special", "legendary"],
                     help="只抽這個稀有度（不給就是預設池：有圖且未標稀有度）")
    ap.add_argument("--lora", action="append", default=[], metavar="路徑[:強度]",
                     help="套用 LoRA，可重複兩次（雙 LoRA 上限）。例：style/foo.safetensors:0.8"
                          "。不給就用伺服器端的預設畫風 LoRA")
    ap.add_argument("--no-lora", action="store_true", help="明確不套任何 LoRA（覆蓋伺服器端的預設值）")
    ap.add_argument("--trigger", default="", help="額外觸發詞，附加在詞庫本身的提示詞後面")
    ap.add_argument("--out", default="agent_draws", help="輸出資料夾（預設 ./agent_draws）")
    ap.add_argument("--seed", type=int, default=None, help="抽卡隨機種子，給了就可重現同一批")
    ap.add_argument("--json", action="store_true",
                     help="stdout 改印一個 JSON 物件（{\"ok\":[...], \"fail\":[...]}），"
                          "給會解析工具輸出的呼叫端（例如 LLM agent）用，比逐行文字穩")
    ap.add_argument("--discord-dm", action="store_true",
                     help="抽完直接用真正的 Discord embed 送 DM（title=系列＋詞庫名稱、"
                          "LoRA 欄位、圖片）。需要 preview_config.json 設好 "
                          "discord_bot_token 與 discord_dm_user_id，見 AGENT_DRAW.md")
    args = ap.parse_args()

    loras = [_parse_lora_arg(s) for s in args.lora] or None
    try:
        results, loras_used = draw_and_generate(
            args.n, base_url=args.base_url, folder=args.folder, rarity=args.rarity,
            loras=loras, no_lora=args.no_lora, trigger=args.trigger, out_dir=args.out, seed=args.seed,
        )
    except DarkroomError as e:
        if args.json:
            print(json.dumps({"error": str(e)}, ensure_ascii=False))
        else:
            print(f"錯誤：{e}", file=sys.stderr)
        return 1

    ok = [r for r in results if r["status"] == "done"]
    fail = [r for r in results if r["status"] != "done"]

    if args.discord_dm:
        cfg = _load_darkroom_config()
        bot_token = cfg.get("discord_bot_token")
        user_id = cfg.get("discord_dm_user_id")
        if not bot_token or not user_id:
            msg = ("--discord-dm 需要 preview_config.json 設好 discord_bot_token 與 "
                   "discord_dm_user_id，目前缺少其中之一")
            if args.json:
                print(json.dumps({"error": msg}, ensure_ascii=False))
            else:
                print(f"錯誤：{msg}", file=sys.stderr)
            return 1
        try:
            embeds = build_discord_embeds(ok, loras_used)
            send_discord_embeds_dm(embeds, bot_token=bot_token, user_id=str(user_id))
            print(f"已送出 {len(embeds)} 張到 Discord DM", file=sys.stderr)
        except DarkroomError as e:
            print(f"Discord 送出失敗：{e}", file=sys.stderr)
            return 1

    if args.json:
        # 只留呼叫端真正用得到的欄位：done 的要 out_path（絕對路徑，可直接餵給
        # Hermes 的 MEDIA: 標籤）+ name（拿來當圖片說明文字）；失敗的只留原因。
        print(json.dumps({
            "ok": [{"name": r["name"], "rel": r["rel"], "out_path": r["out_path"]} for r in ok],
            "fail": [{"name": r["name"], "rel": r["rel"], "status": r["status"], "error": r.get("error", "")}
                     for r in fail],
        }, ensure_ascii=False))
    else:
        for r in ok:
            print(f"{r['out_path']}\t{r['rel']}")
        for r in fail:
            print(f"# 失敗：{r['rel']}（{r.get('status')}：{r.get('error', '')}）", file=sys.stderr)
        print(f"完成 {len(ok)}/{len(results)}", file=sys.stderr)
    return 0 if not fail else 2


if __name__ == "__main__":
    raise SystemExit(main())
