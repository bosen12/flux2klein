#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
修補 speech-to-speech 套件裡的兩個 bug（套件本身的問題，不是設定）。

一、whisper_stt_handler.py 的 IndexError
    兩處寫死 pred_ids[0, 1] 取語言標記 token，但強制指定語言（--language zh）時，
    短音段輸出可能只有 1 個 token：
        IndexError: index 1 is out of bounds for dimension 1 with size 1
    每個短音段都會噴一次、那段辨識直接丟失。取值前先檢查長度。

二、chat.py 的 ValidationError（無參數工具）
    無參數的 function call（例如 generate）arguments 是字串 'null'，
    json.loads('null') 回傳 None（合法 JSON、不拋錯），一路傳到 pydantic：
        ValidationError: arguments Input should be a valid dictionary
    導致助理呼叫無參數工具後、下一輪重新注入脈絡時整條炸掉。json.loads 後
    補一個 dict 檢查。

可重複執行（已修補會跳過）。pip 升級 speech-to-speech 之後要再跑一次。
"""
import pathlib
import sys

ROOT = pathlib.Path(r"C:\projects\s2s\lib\site-packages\speech_to_speech")

# 每個修補：(相對路徑, 舊字串, 新字串, 已修補的偵測字串)
PATCHES = [
    (
        "STT/whisper_stt_handler.py",
        "self.processor.tokenizer.decode(pred_ids[0, 1])[2:-2]",
        "(self.processor.tokenizer.decode(pred_ids[0, 1])[2:-2]\n"
        "                         if pred_ids.shape[1] > 1 else (self.last_language or \"\"))",
        "pred_ids.shape[1] > 1",
    ),
    (
        "LLM/chat.py",
        "                        args = json.loads(args) if isinstance(args, str) else args\n",
        "                        args = json.loads(args) if isinstance(args, str) else args\n"
        "                        if not isinstance(args, dict):  # json.loads('null') -> None, pydantic 要 dict\n"
        "                            args = {}\n",
        "if not isinstance(args, dict):",
    ),
]


def apply_one(rel, old, new, done_marker):
    target = ROOT / rel
    if not target.is_file():
        print(f"  跳過 {rel}：找不到檔案")
        return False
    src = target.read_text(encoding="utf-8")
    if done_marker in src:
        print(f"  {rel}：已修補")
        return False
    if old not in src:
        print(f"  {rel}：找不到要修補的程式碼——套件版本可能變了")
        return False
    bak = target.with_suffix(target.suffix + ".orig")
    if not bak.exists():
        bak.write_text(src, encoding="utf-8")
    n = src.count(old)
    target.write_text(src.replace(old, new), encoding="utf-8")
    print(f"  {rel}：已修補 {n} 處")
    return True


def main():
    if not ROOT.is_dir():
        sys.exit(f"找不到 {ROOT}\n請確認虛擬環境路徑，或先安裝 speech-to-speech。")
    changed = sum(apply_one(*p) for p in PATCHES)
    if changed:
        print("完成。請重新啟動語音服務（start_assistant.bat）。")
    else:
        print("沒有需要修補的項目。")


if __name__ == "__main__":
    main()
