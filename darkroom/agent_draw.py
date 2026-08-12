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
    results = draw_and_generate(n=3, base_url="http://127.0.0.1:7860")
    for r in results:
        print(r["rel"], r["out_path"])

只用 HTTP 呼叫（不能跑 shell/python 的 agent）：直接呼叫 /api/agent-draw，
不需要這支腳本——見同目錄 AGENT_DRAW.md。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_BASE_URL = "http://127.0.0.1:7860"
POLL_INTERVAL_S = 0.8   # 前端是 500ms，這裡沒有即時預覽的需求，放寬一點不必要地打伺服器
POLL_TIMEOUT_S = 300.0  # 單張生成逾時（跟前端 preview_config 的 timeout 概念一致）


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
                 seed: int | None = None) -> list[dict]:
    """POST /api/agent-draw——伺服器端隨機抽 n 張並直接送生成。
    回傳 [{"id", "rel", "name"}, ...]，用 id 去 gen-status / gen-result 追蹤。

    loras 不給（且 no_lora 不是 True）＝套伺服器端的預設畫風 LoRA（見 preview_ui.py
    的 AGENT_DRAW_DEFAULT_LORAS）。no_lora=True 會明確送 "loras": []，關掉預設值。"""
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
    return j.get("items", [])


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
                       seed: int | None = None) -> list[dict]:
    """一次做完：抽 n 張 → 送生成 → 等完成 → 存檔。回傳每張的
    [{"rel", "name", "id", "status", "out_path" 或 "error"}, ...]。

    n 大於候選池時會抽到全部（不重複抽同一張——暗房塔羅抽卡也是這樣，一批裡不重複）。
    不給 loras 就套伺服器端的預設畫風 LoRA；no_lora=True 明確關掉。
    """
    submitted = submit_draw(n, base_url=base_url, folder=folder, rarity=rarity,
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
    return results


def _parse_lora_arg(spec: str) -> tuple[str, float]:
    """"style/foo.safetensors:0.8" -> ("style/foo.safetensors", 0.8)；沒帶強度就預設 0.8。"""
    if ":" in spec:
        path, strength = spec.rsplit(":", 1)
        return path, float(strength)
    return spec, 0.8


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
    args = ap.parse_args()

    loras = [_parse_lora_arg(s) for s in args.lora] or None
    try:
        results = draw_and_generate(
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
