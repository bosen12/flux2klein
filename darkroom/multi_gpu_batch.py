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
的 endpoint 接手（同一項目最多重試 20 次才真的放棄標成失敗），該台連續失敗
3 次就先**冷卻**（預設 90 秒，見 COOLDOWN_SECONDS）暫停領新工作，不會卡在
失敗迴圈裡把項目白白吃掉——**不是永久放棄**，冷卻時間到會自動再試。這是
刻意選擇：像 Cloudflare quick tunnel（`trycloudflare.com`）這種偶爾自己斷線
又會自動重連的情況很常見，永久放棄反而會白白浪費一整台其實還活著的 GPU。
如果真的全部 endpoint 都掛了，程式不會馬上放棄，但超過 10 分鐘沒有任何新
完成的項目會印一次提醒（不會強制中止，可能只是剛好同時都在冷卻）。
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
    atomic_write_bytes,
    build_negative,
    build_prompt,
    download_image,
    http_json,
    iter_libraries,
    parse_lib_ast,
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

# 同一個項目最多被重試幾次（不同 endpoint／同一 endpoint 冷卻恢復後再試都算）
# 才真的放棄標成失敗。故意設得比 MAX_CONSECUTIVE_FAILS 大很多——如果只有
# 1~2 台 endpoint、其中一台在冷卻，項目要撐過冷卻時間才等得到它恢復；設太低
# （例如等於 MAX_CONSECUTIVE_FAILS）會讓項目在冷卻機制救回它之前就先被判定
# 「重試次數用完」永久放棄，等於冷卻設計形同虛設。
MAX_ITEM_RETRIES = 20
# 同一台 endpoint 連續失敗幾次，就先讓它冷卻一陣子、不要繼續派工作給它
# （不然一台暫時斷線的話，它的 worker 會一直領新項目、一直失敗，白白把項目
# 從佇列吃掉又標成失敗，本來可以留給還活著的那幾台做）。**不是永久放棄**——
# 冷卻時間到了會自動重新試。像 Cloudflare quick tunnel 這種偶爾自己斷線又
# 自動重連（重連 backoff 最長約 64s）的情況，永久放棄反而會白白浪費一整台
# 其實還活著的 GPU。
MAX_CONSECUTIVE_FAILS = 3
COOLDOWN_SECONDS = 90.0


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
           endpoint_cooldown: dict, cooldown_lock: threading.Lock):
    consecutive_fails = 0
    while not stop_flag[0]:
        with cooldown_lock:
            cooldown_until = endpoint_cooldown.get(base, 0.0)
        now = time.time()
        if now < cooldown_until:
            time.sleep(min(1.0, cooldown_until - now))
            continue  # 還在冷卻，不領新工作，但一直有在檢查——冷卻時間到就自動恢復
        try:
            py, retry = task_q.get(timeout=0.5)
        except queue.Empty:
            # 佇列暫時空了，但可能是別的 worker 領走的項目待會失敗又會放回來，
            # 不能直接當作「沒工作了」——這裡只是先繼續等，真正的收尾判斷交給
            # main() 的 task_q.join()。
            continue
        try:
            req, pos, neg = parse_lib_ast(py)
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
            atomic_write_bytes(out_img, img_bytes)
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
                with cooldown_lock:
                    endpoint_cooldown[base] = time.time() + COOLDOWN_SECONDS
                plog(f"[{name}] 連續失敗 {consecutive_fails} 次，{base} 先冷卻 {COOLDOWN_SECONDS:.0f}s "
                     f"再重試（不是永久放棄——冷卻時間到就會自動再試）")
                consecutive_fails = 0
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
    missing = [py for py in iter_libraries(None) if find_image(py) is None]
    # 打亂順序（跟暗房本體「補缺少」同一個道理）：iter_libraries() 回傳的是照
    # 資料夾排序，不打亂的話中途沒跑完會變成前面幾個資料夾補滿、後面完全沒碰，
    # 隨機分佈才能讓「跑到一半」的結果也大致涵蓋全部資料夾。
    random.shuffle(missing)
    task_q: "queue.Queue[tuple[Path, int]]" = queue.Queue()
    for py in missing:
        task_q.put((py, 0))
    total = len(missing)
    plog(f"共 {total} 筆缺圖（已打亂順序）")
    if total == 0:
        plog("沒有缺圖，結束。")
        return

    concurrency = max(1, int(cfg.get("concurrency", 2)))
    plog(f"每台 ComfyUI 併發 {concurrency}（跟 preview_config.json 的 concurrency 一致）")

    stats = {"done": 0, "ok": 0, "fail": 0, "total": total}
    stats_lock = threading.Lock()
    stop_flag = [False]
    endpoint_cooldown: dict = {}
    cooldown_lock = threading.Lock()
    threads = []
    for i, base in enumerate(live_endpoints):
        for slot in range(concurrency):
            name = f"worker{i}.{slot}({base})"
            t = threading.Thread(target=worker,
                                  args=(name, base, task_q, template, steps, stats, stats_lock,
                                        stop_flag, endpoint_cooldown, cooldown_lock),
                                  daemon=True)
            t.start()
            threads.append(t)

    # 用 task_q.join() 判斷「真的全部做完了」（含重試被放回去的項目）——不能只看
    # 佇列是否清空一次，失敗重試會讓佇列暫時空了又補回東西。背景 thread 等 join()
    # 回來就設旗標。endpoint 冷卻是暫時的、不是永久放棄（見 worker() 註解），所以
    # 這裡不會因為某些 endpoint 正在冷卻就提早中止——只在完全沒進度太久時提醒一下，
    # 不強制停止（可能只是全部剛好都在冷卻，等一下就自己恢復）。
    done_event = threading.Event()

    def _joiner():
        task_q.join()
        done_event.set()
    threading.Thread(target=_joiner, daemon=True).start()

    STALL_WARN_SECONDS = 600.0
    last_progress = time.time()
    last_done_seen = 0
    try:
        while not done_event.is_set():
            done_event.wait(timeout=5.0)
            with stats_lock:
                done_now = stats["done"]
            if done_now != last_done_seen:
                last_done_seen = done_now
                last_progress = time.time()
            elif not done_event.is_set() and time.time() - last_progress > STALL_WARN_SECONDS:
                with cooldown_lock:
                    cooling = sum(1 for t_ in endpoint_cooldown.values() if t_ > time.time())
                plog(f"提醒：已經 {STALL_WARN_SECONDS:.0f}s 沒有新完成的項目"
                     f"（{cooling}/{len(live_endpoints)} 台目前冷卻中），仍在繼續嘗試、沒有中止。")
                last_progress = time.time()  # 避免同一個停滯狀態一直重複印
    except KeyboardInterrupt:
        plog("收到中止：停止派新工作；在途 worker 最多等 5 秒收尾後結束程序...")
        stop_flag[0] = True

    stop_flag[0] = True  # 讓還卡在 task_q.get(timeout=0.5) 裡等的 worker 自然退出
    for t in threads:
        t.join(timeout=5.0)

    plog(f"完成：{stats['done']}/{stats['total']} · ok {stats['ok']} · fail {stats['fail']}")


if __name__ == "__main__":
    main()
