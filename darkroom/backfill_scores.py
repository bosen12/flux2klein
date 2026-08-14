#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
backfill_scores.py
===================
獨立補分工具：把已經有圖但還沒評分的卡片跑一次 waifu-score 評分，寫進跟
preview_ui.py 相同的側檔（.darkroom_meta/scores.<tag>.json）。跟前端「評分」
按鈕（POST /api/score-backfill）共用同一個 run_score_backfill()，差別只在
觸發方式跟進度輸出目的地——見 docs/superpowers/specs/
2026-08-14-darkroom-model-scoring-design.md。

用法：
    python backfill_scores.py
    python backfill_scores.py --special-dir "C:\\projects\\special_prompts"

前提：waifu-score 服務要先啟動（它的 run.bat），本腳本不會自動幫你開。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview_ui as pu


def main():
    ap = argparse.ArgumentParser(description="暗房卡片補分（waifu-score 三模型加權評分）")
    ap.add_argument("--special-dir", default=None,
                    help="詞庫資料夾（不給就用 preview_config.json 的 special_dir）")
    args = ap.parse_args()

    # 比照 preview_ui.main() 的初始化順序：先套 special_dir，才能正確算出
    # dataset 分檔用的雜湊（_dataset_tag），不然會讀到別的 dataset 的側檔。
    cfg = pu.load_config()
    special_dir = args.special_dir or cfg.get("special_dir")
    if special_dir:
        pu.apply_special_dir(special_dir)
    if not pu.SPECIAL_DIR.is_dir():
        print(f"[錯誤] 找不到詞庫資料夾：{pu.SPECIAL_DIR}")
        sys.exit(1)
    print(f"[special] {pu.SPECIAL_DIR}")

    if not pu._score_service_available():
        print("[錯誤] 連不上 waifu-score 服務（http://localhost:8000）。請先執行它的 run.bat。")
        sys.exit(1)

    def progress(done, total):
        print(f"\r已評分 {done}/{total}", end="", flush=True)

    pu.run_score_backfill(progress_cb=progress)
    print()   # 收掉上面 \r 覆寫的那一行，讓後面的輸出換到新行


if __name__ == "__main__":
    main()
