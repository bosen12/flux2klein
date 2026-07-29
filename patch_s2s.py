#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
修補 speech-to-speech 套件裡的 Whisper handler。

問題：whisper_stt_handler.py 有兩處寫死 pred_ids[0, 1] 去取語言標記 token，
但強制指定語言（--language zh）時，短音段的輸出可能只有 1 個 token，於是

    IndexError: index 1 is out of bounds for dimension 1 with size 1

每個短音段都會噴一次，那一段的辨識結果直接丟失。這是套件本身的 bug，
不是設定問題。

修法：取 token 前先檢查長度，不足就退回上一次偵測到的語言。

這個檔案可重複執行（已修補會直接跳過）。pip 升級 speech-to-speech 之後
要再跑一次。
"""
import pathlib
import re
import sys

TARGET = pathlib.Path(
    r"C:\projects\s2s\lib\site-packages\speech_to_speech\STT\whisper_stt_handler.py"
)

OLD = 'self.processor.tokenizer.decode(pred_ids[0, 1])[2:-2]'
NEW = ('(self.processor.tokenizer.decode(pred_ids[0, 1])[2:-2]\n'
       '                         if pred_ids.shape[1] > 1 else (self.last_language or ""))')


def main():
    if not TARGET.is_file():
        sys.exit(f"找不到 {TARGET}\n請確認虛擬環境路徑，或先安裝 speech-to-speech。")

    src = TARGET.read_text(encoding="utf-8")

    if "pred_ids.shape[1] > 1" in src:
        print("已經修補過，不需要再做。")
        return

    n = src.count(OLD)
    if n == 0:
        sys.exit("找不到要修補的程式碼——套件版本可能變了，請重新確認 "
                 "whisper_stt_handler.py 裡取 language_code 的那兩行。")

    # 備份一次就好，重跑不覆蓋
    bak = TARGET.with_suffix(".py.orig")
    if not bak.exists():
        bak.write_text(src, encoding="utf-8")
        print(f"已備份原檔 → {bak.name}")

    TARGET.write_text(src.replace(OLD, NEW), encoding="utf-8")
    print(f"已修補 {n} 處：pred_ids[0, 1] 取值前先檢查長度")
    print("請重新啟動語音服務（start_assistant.bat）。")


if __name__ == "__main__":
    main()
