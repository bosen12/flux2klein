#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
multi_gpu_batch.py
===================
補齊 special_prompts 缺圖的詞庫預覽圖，同時對多台 ComfyUI（本機 + RunPod 租的
GPU...）平行送生成。複製 preview_ui.py 的 do_batch() 邏輯，把「N 條 worker
thread 搶同一個 STATE['gen_sem']（同一台 ComfyUI）」改成「每條 worker thread
各自綁一台不同的 ComfyUI」——同一份任務佇列大家搶著領，誰先做完手上這張，誰就
馬上再領下一張，天生照各自實際速度分配，不用猜比例、不用另外配置。

只補缺圖（跟暗房「補缺少」同一個判斷：find_image() 找不到才算缺），不會覆蓋
已經有圖的詞庫。要全部重生請用暗房本體（preview_ui.py）的「全部重生」。

用法：在 darkroom/preview_config.json（已 gitignore）加一個 comfy_endpoints
欄位，填想用的 ComfyUI 位址（本機 ComfyUI、RunPod pod 的代理網址...要幾台填
幾台），沒設就只用本機那張。範例見 preview_config.example.json。設定好後跑：
    python multi_gpu_batch.py
或雙擊 multi_gpu_batch.bat。

注意：endpoint 探測**不會**像 preview_ui.py 的 resolve_comfy_base() 那樣在
連不上時 fallback 回本機——那是給單一使用者本機開發用的便利設計，這裡如果
沿用，RunPod 那個位址連不上時會靜默退回本機 127.0.0.1:8188，導致兩個 worker
其實都在打本機那張卡，多卡平行就變假的了（跟 CLAUDE.md 記錄過的那個坑一樣）。
這裡連不上的 endpoint 會直接跳過、印出來，不會偷偷換成別的位址。
"""

from __future__ import annotations

import queue
import random
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_special_previews as gsp
from generate_special_previews import (
    DEFAULT_WORKFLOWS,
    build_negative,
    build_prompt,
    download_image,
    http_json,
    iter_libraries,
    load_lib,
    load_workflow,
    prepare_workflow,
    queue_and_wait,
)
# 跟暗房本體共用同一份設定讀取（preview_config.json 的 special_dir/workflow/steps）、
# 同一份「有沒有圖」判斷（find_image）——不要另外重寫一套，免得跟本體的行為兜不起來。
from preview_ui import NEW_WORKFLOW, apply_special_dir, find_image, load_config

# ---------------------------------------------------------------------------
# 要用的 ComfyUI 位址（本機 + 租的都放這裡）不寫死在這支檔案裡——RunPod 網址是
# 每次租用機器才有的，寫死進 .py 會跟著 git push 出去。讀 preview_config.json
# 的 comfy_endpoints 欄位（已 gitignore），沒設就只用本機那張，見
# preview_config.example.json 的說明。詞庫目錄／workflow／steps 同理，都讀
# 同一份設定檔，兩邊才不會兜不起來。
# ---------------------------------------------------------------------------
DEFAULT_COMFY_ENDPOINTS = ["http://127.0.0.1:8188"]

TIMEOUT = 600
OUT_EXT = ".webp"


def plog(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def check_endpoint(base: str, timeout: float = 5.0) -> bool:
    """直接測給定的位址，不做任何 fallback——連不上就是連不上。"""
    try:
        http_json("GET", f"{base.rstrip('/')}/system_stats", timeout=timeout)
        return True
    except Exception:
        return False


def worker(name: str, base: str, task_q: "queue.Queue[Path]", template: dict, steps: int,
           stats: dict, stats_lock: threading.Lock, stop_flag: list):
    while not stop_flag[0]:
        try:
            py = task_q.get_nowait()
        except queue.Empty:
            return
        try:
            req, pos, neg = load_lib(py)
            positive = build_prompt(req, pos)
            negative = build_negative(neg)
            seed = random.randint(0, 2**63 - 1)
            prefix = f"special/{py.parent.name}/{py.stem}"[:180]
            wf = prepare_workflow(template, positive=positive, negative=negative,
                                   seed=seed, filename_prefix=prefix, steps=steps)
            t0 = time.time()
            images = queue_and_wait(base, wf, timeout=TIMEOUT)
            img_bytes = download_image(base, images[0])
            out_img = py.with_suffix(OUT_EXT)
            out_img.write_bytes(img_bytes)
            dt = time.time() - t0
            with stats_lock:
                stats["ok"] += 1
                stats["done"] += 1
                done, ok, fail, total = stats["done"], stats["ok"], stats["fail"], stats["total"]
            plog(f"[{name}] OK  {py.parent.name}/{py.stem}  {dt:.1f}s  "
                 f"{len(img_bytes)//1024}KB  ({done}/{total} · ok {ok} · fail {fail})")
        except Exception as e:
            with stats_lock:
                stats["fail"] += 1
                stats["done"] += 1
                done, ok, fail, total = stats["done"], stats["ok"], stats["fail"], stats["total"]
            plog(f"[{name}] ERR {py.parent.name}/{py.stem}  {type(e).__name__}: {e}  "
                 f"({done}/{total} · ok {ok} · fail {fail})")
        finally:
            task_q.task_done()


def main():
    cfg = load_config()
    if cfg.get("special_dir"):
        apply_special_dir(cfg["special_dir"])
    plog(f"詞庫目錄：{gsp.SPECIAL_DIR}")

    wf_path = Path(cfg.get("workflow", str(NEW_WORKFLOW)))
    if not wf_path.is_file():
        candidates = [NEW_WORKFLOW, Path.home() / "Downloads" / "ANIMESTYLE (1).json", *DEFAULT_WORKFLOWS]
        found = next((p for p in candidates if p.is_file()), None)
        if found is None:
            plog(f"找不到工作流（試過 {wf_path} 跟其他預設路徑），確認 preview_config.json 的 workflow 欄位")
            sys.exit(1)
        wf_path = found
    plog(f"工作流：{wf_path}")
    template = load_workflow(wf_path)
    steps = int(cfg.get("steps", 25))

    comfy_endpoints = cfg.get("comfy_endpoints") or DEFAULT_COMFY_ENDPOINTS
    plog(f"探測 ComfyUI 端點...（{len(comfy_endpoints)} 個，來自 preview_config.json 的 comfy_endpoints）")
    live_endpoints = []
    for base in comfy_endpoints:
        base = base.rstrip("/")
        if check_endpoint(base):
            live_endpoints.append(base)
            plog(f"  OK  {base}")
        else:
            plog(f"  跳過（連不上，不會 fallback 到別的位址）{base}")
    if not live_endpoints:
        plog("沒有任何 ComfyUI 端點連得上，中止。")
        sys.exit(1)
    plog(f"共 {len(live_endpoints)} 台可用")

    plog("掃描缺圖的詞庫...")
    task_q: "queue.Queue[Path]" = queue.Queue()
    total = 0
    for py in iter_libraries(None):
        if find_image(py) is None:
            task_q.put(py)
            total += 1
    plog(f"共 {total} 筆缺圖")
    if total == 0:
        plog("沒有缺圖，結束。")
        return

    concurrency = max(1, int(cfg.get("concurrency", 2)))
    plog(f"每台 ComfyUI 併發 {concurrency}（跟 preview_config.json 的 concurrency 一致）")

    stats = {"done": 0, "ok": 0, "fail": 0, "total": total}
    stats_lock = threading.Lock()
    stop_flag = [False]
    threads = []
    for i, base in enumerate(live_endpoints):
        for slot in range(concurrency):
            name = f"worker{i}.{slot}({base})"
            t = threading.Thread(target=worker,
                                  args=(name, base, task_q, template, steps, stats, stats_lock, stop_flag),
                                  daemon=True)
            t.start()
            threads.append(t)

    try:
        while any(t.is_alive() for t in threads):
            for t in threads:
                t.join(timeout=1.0)
    except KeyboardInterrupt:
        plog("收到中止：在途的生成會跑完，還沒領到的項目不會再送出去...")
        stop_flag[0] = True
        try:
            while True:
                task_q.get_nowait()
                task_q.task_done()
        except queue.Empty:
            pass
        for t in threads:
            t.join()

    plog(f"完成：{stats['done']}/{stats['total']} · ok {stats['ok']} · fail {stats['fail']}")


if __name__ == "__main__":
    main()
