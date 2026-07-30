#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把本專案對 LiveTalking 的改動套用到那個 clone 上（可重複執行）。

LiveTalking 是第三方 repo（github.com/lipku/LiveTalking），clone 在 C:\\projects\\LiveTalking。
我們的改動直接寫在那邊、不受本專案版控——所以 LiveTalking 一 git pull 就可能被覆蓋。
這支腳本把那些改動集中管理：改完跑一次就還原，內容都是冪等的字串替換，重複跑不會疊加。

改了什麼：
  1. tts/qwen3local.py     —— 新增：本地 Qwen3-TTS 克隆音色（不走 DashScope 雲端）
  2. avatars/base_avatar.py —— 在 _tts_modules 註冊 qwen3local
  3. config.py             —— --tts 的 help 補上 qwen3local
  4. llm.py                —— DashScope 改為 Groq（走 groq_proxy 多 key 輪替）＋女友人設

用法：
    python livetalking_patch.py          # 套用
    python livetalking_patch.py --check  # 只檢查目前狀態，不改檔
"""
import os
import shutil
import sys
import pathlib

BASE = pathlib.Path(__file__).resolve().parent
LT = pathlib.Path(os.getenv("LIVETALKING_DIR", r"C:\projects\LiveTalking"))
SRC = BASE / "livetalking"          # 我們維護的原始檔放這裡

CHECK = "--check" in sys.argv
changed, ok, failed = [], [], []


def report(kind, msg):
    (ok if kind == "ok" else changed if kind == "chg" else failed).append(msg)


def patch_text(rel, old, new, desc):
    """把 old 換成 new。new 已存在 → 視為已套用。old 也找不到 → 記為失敗（上游可能改了）。"""
    p = LT / rel
    if not p.is_file():
        report("err", f"{rel}: 檔案不存在")
        return
    s = p.read_text(encoding="utf-8")
    if new in s:
        report("ok", f"{rel}: {desc}（已套用）")
        return
    if old not in s:
        report("err", f"{rel}: 找不到要替換的內容——上游可能改版了，需人工確認：{desc}")
        return
    if CHECK:
        report("chg", f"{rel}: {desc}（待套用）")
        return
    p.write_text(s.replace(old, new, 1), encoding="utf-8")
    report("chg", f"{rel}: {desc} ✔")


def copy_file(rel, desc):
    """把 livetalking/<name> 複製過去（內容不同才複製）。"""
    src, dst = SRC / pathlib.Path(rel).name, LT / rel
    if not src.is_file():
        report("err", f"{rel}: 來源 {src} 不存在")
        return
    if dst.is_file() and dst.read_bytes() == src.read_bytes():
        report("ok", f"{rel}: {desc}（已是最新）")
        return
    if CHECK:
        report("chg", f"{rel}: {desc}（待複製）")
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    report("chg", f"{rel}: {desc} ✔")


def main():
    if not LT.is_dir():
        sys.exit(f"找不到 LiveTalking：{LT}\n"
                 f"先 git clone https://github.com/lipku/LiveTalking.git 到那裡，"
                 f"或用環境變數 LIVETALKING_DIR 指到正確位置。")

    # 1) 新增本地 TTS 模組
    copy_file("tts/qwen3local.py", "本地 Qwen3-TTS 模組")

    # 2) 註冊到 _tts_modules（lazy import 表）
    patch_text(
        "avatars/base_avatar.py",
        "            'omnitts': 'tts.omnitts'\n        }",
        "            'omnitts': 'tts.omnitts',\n"
        "            'qwen3local': 'tts.qwen3local'   # 本地 Qwen3-TTS 克隆音色（非 DashScope 雲端）\n        }",
        "註冊 qwen3local",
    )

    # 3) --tts 的 help 補上新選項
    patch_text(
        "config.py",
        'help="tts plugin: edgetts/gpt-sovits/cosyvoice/fishtts/tencent/doubao/indextts2/azuretts/qwentts")',
        'help="tts plugin: edgetts/gpt-sovits/cosyvoice/fishtts/tencent/doubao/indextts2/azuretts/qwentts/qwen3local"\n'
        '                             " (qwen3local = 本地 Qwen3-TTS 克隆音色，非 DashScope 雲端)")',
        "--tts help 補 qwen3local",
    )

    # 4) llm.py：DashScope → Groq。整支換掉（它很小、且我們大幅改寫了設定與人設）。
    copy_file("llm.py", "llm.py 指向 Groq ＋女友人設")

    for m in ok:
        print("  =", m)
    for m in changed:
        print("  +", m)
    for m in failed:
        print("  !", m)
    print()
    if failed:
        print(f"有 {len(failed)} 項需要人工處理（多半是 LiveTalking 上游改版）。")
        sys.exit(1)
    if CHECK:
        print("僅檢查，未改檔。" + ("有待套用項目。" if changed else "全部已套用。"))
    else:
        print("完成。" if changed else "本來就是最新狀態，沒改任何東西。")


if __name__ == "__main__":
    main()
