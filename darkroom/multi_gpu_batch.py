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

跑到一半某台斷線／壞掉怎麼辦：那台生成失敗的項目會**放回共用佇列**給還活著
的 endpoint 接手（同一項目最多重試 3 次才真的放棄標成失敗），該台連續失敗
3 次就判定斷線、自己停止領新工作，不會卡在失敗迴圈裡把項目白白吃掉。全部
endpoint 都斷線的話會直接中止（不會傻等到逐張逾時），剩下沒做完的項目留在
原地——之後端點恢復連線，重跑這支程式會自動只補還缺的那些。
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

# 同一個項目最多被重試幾次（不同 endpoint 各算一次）才真的放棄標成失敗。
MAX_ITEM_RETRIES = 3
# 同一台 endpoint 連續失敗幾次，就判定它斷線／壞掉，停止繼續派工作給它
# （不然一台斷線的話，它的 worker 會一直領新項目、一直失敗，白白把項目
# 從佇列吃掉又標成失敗，本來可以留給還活著的那幾台做）。
MAX_CONSECUTIVE_FAILS = 3


def plog(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def check_endpoint(base: str, timeout: float = 5.0) -> bool:
    """直接測給定的位址，不做任何 fallback——連不上就是連不上。"""
    try:
        http_json("GET", f"{base.rstrip('/')}/system_stats", timeout=timeout)
        return True
    except Exception:
        return False


def worker(name: str, base: str, task_q: "queue.Queue[tuple[Path, int]]", template: dict, steps: int,
           stats: dict, stats_lock: threading.Lock, stop_flag: list,
           dead_endpoints: set, dead_lock: threading.Lock):
    consecutive_fails = 0
    while not stop_flag[0]:
        with dead_lock:
            if base in dead_endpoints:
                return  # 這台已經被判定斷線，這條 worker 不再領新工作
        try:
            py, retry = task_q.get(timeout=0.5)
        except queue.Empty:
            # 佇列暫時空了，但可能是別的 worker 領走的項目待會失敗又會放回來，
            # 不能直接當作「沒工作了」——這裡只是先繼續等，真正的收尾判斷交給
            # main() 的 task_q.join()。
            continue
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
            consecutive_fails = 0
            with stats_lock:
                stats["ok"] += 1
                stats["done"] += 1
                done, ok, fail, total = stats["done"], stats["ok"], stats["fail"], stats["total"]
            plog(f"[{name}] OK  {py.parent.name}/{py.stem}  {dt:.1f}s  "
                 f"{len(img_bytes)//1024}KB  ({done}/{total} · ok {ok} · fail {fail})")
        except Exception as e:
            consecutive_fails += 1
            if retry + 1 < MAX_ITEM_RETRIES:
                task_q.put((py, retry + 1))
                plog(f"[{name}] ERR {py.parent.name}/{py.stem}  {type(e).__name__}: {e}  "
                     f"→ 放回佇列給其他 endpoint 重試（第 {retry + 1} 次）")
            else:
                with stats_lock:
                    stats["fail"] += 1
                    stats["done"] += 1
                    done, ok, fail, total = stats["done"], stats["ok"], stats["fail"], stats["total"]
                plog(f"[{name}] ERR {py.parent.name}/{py.stem}  {type(e).__name__}: {e}  "
                     f"→ 已重試 {MAX_ITEM_RETRIES} 次都失敗，放棄這張 "
                     f"({done}/{total} · ok {ok} · fail {fail})")
            if consecutive_fails >= MAX_CONSECUTIVE_FAILS:
                with dead_lock:
                    dead_endpoints.add(base)
                plog(f"[{name}] 連續失敗 {consecutive_fails} 次，判定 {base} 斷線／異常，"
                     f"這台停止領新工作（還活著的 endpoint 繼續跑）")
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
    task_q: "queue.Queue[tuple[Path, int]]" = queue.Queue()
    total = 0
    for py in iter_libraries(None):
        if find_image(py) is None:
            task_q.put((py, 0))
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
    dead_endpoints: set = set()
    dead_lock = threading.Lock()
    threads = []
    for i, base in enumerate(live_endpoints):
        for slot in range(concurrency):
            name = f"worker{i}.{slot}({base})"
            t = threading.Thread(target=worker,
                                  args=(name, base, task_q, template, steps, stats, stats_lock,
                                        stop_flag, dead_endpoints, dead_lock),
                                  daemon=True)
            t.start()
            threads.append(t)

    # 用 task_q.join() 判斷「真的全部做完了」（含重試被放回去的項目）——不能只看
    # 佇列是否清空一次，失敗重試會讓佇列暫時空了又補回東西。背景 thread 等 join()
    # 回來就設旗標，主迴圈定期醒來檢查有沒有「全部 endpoint 都斷線」這種要提早
    # 中止的情況。
    done_event = threading.Event()

    def _joiner():
        task_q.join()
        done_event.set()
    threading.Thread(target=_joiner, daemon=True).start()

    try:
        while not done_event.is_set():
            done_event.wait(timeout=1.0)
            with dead_lock:
                all_dead = len(dead_endpoints) >= len(live_endpoints)
            if all_dead and not done_event.is_set():
                plog("所有 ComfyUI 端點都判定斷線／異常，中止（還沒做完的項目留在佇列，"
                     "之後端點恢復後重跑這支程式會自動只補剩下的）。")
                stop_flag[0] = True
                break
    except KeyboardInterrupt:
        plog("收到中止：在途的生成會跑完，還沒領到的項目不會再送出去...")
        stop_flag[0] = True

    stop_flag[0] = True  # 讓還卡在 task_q.get(timeout=0.5) 裡等的 worker 自然退出
    for t in threads:
        t.join(timeout=5.0)

    plog(f"完成：{stats['done']}/{stats['total']} · ok {stats['ok']} · fail {stats['fail']}")


if __name__ == "__main__":
    main()
