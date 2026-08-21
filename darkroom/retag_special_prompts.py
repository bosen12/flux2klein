#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
retag_special_prompts.py
=========================
獨立打標工具：把 special_prompts 底下每一筆詞庫的舊 json（手寫 series/intro/tags，
跟圖片實際內容脫節）整份刪除重寫成 wd-tagger 分析代表圖產生的視覺標籤。跟前端
「打標」按鈕（POST /api/tag-backfill）共用同一個 run_tag_backfill()，差別只在
觸發方式跟進度輸出目的地——見 preview_ui.py 的 _write_visual_tags()/_needs_tagging()。

用法：
    python retag_special_prompts.py
    python retag_special_prompts.py --special-dir "C:\\projects\\special_prompts"
    python retag_special_prompts.py --dry-run

前提：wd-tagger 服務要先啟動（它的 run.bat，預設 http://127.0.0.1:8001），
本腳本不會自動幫你開。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview_ui as pu


def main():
    ap = argparse.ArgumentParser(description="special_prompts 詞庫自動標籤（wd-eva02-large-tagger-v3）")
    ap.add_argument("--special-dir", default=None,
                    help="詞庫資料夾（不給就用 preview_config.json 的 special_dir）")
    ap.add_argument("--dry-run", action="store_true", help="只列出待打標筆數，不實際呼叫模型/寫檔")
    args = ap.parse_args()

    cfg = pu.load_config()
    special_dir = args.special_dir or cfg.get("special_dir")
    if special_dir:
        pu.apply_special_dir(special_dir)
    if not pu.SPECIAL_DIR.is_dir():
        print(f"[錯誤] 找不到詞庫資料夾：{pu.SPECIAL_DIR}")
        sys.exit(1)
    print(f"[special] {pu.SPECIAL_DIR}")

    if args.dry_run:
        items = pu.scan_libraries()
        todo = [it for it in items if it.get("has_image") and pu._needs_tagging(pu.py_of(it["rel"]))]
        print(f"[dry-run] 待打標 {len(todo)} / {len(items)} 筆（含還沒圖的）")
        for it in todo[:20]:
            print(" ", it["rel"])
        if len(todo) > 20:
            print(f"  ... 還有 {len(todo)-20} 筆")
        return

    if not pu._tag_service_available():
        print("[錯誤] 連不上 wd-tagger 服務（http://127.0.0.1:8001）。請先執行它的 run.bat。")
        sys.exit(1)

    def progress(done, total):
        print(f"\r已打標 {done}/{total}", end="", flush=True)

    pu.run_tag_backfill(progress_cb=progress)
    print()


if __name__ == "__main__":
    main()
