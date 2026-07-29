#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
啟動 AI 助理的語音服務（huggingface/speech-to-speech）。

管線：VAD（Silero）→ STT（Whisper）→ LLM（Groq，唯一走雲端的一段）→ TTS（Qwen3-TTS）
全部跑在本地，只有 LLM 轉呼叫 Groq——那個專案本來就支援指向任意 OpenAI
相容端點，所以不需要改它的任何程式碼。

金鑰直接從 config.js 讀，不用另外設環境變數、也不會散落在啟動指令裡。

用法：
    python start_assistant.py              # 預設埠 8765
    python start_assistant.py --port 8770  # 換埠（記得同步改 config.js 的 ASSISTANT_WS）
"""
import os
import re
import subprocess
import sys
import pathlib

BASE = pathlib.Path(__file__).resolve().parent
VENV = pathlib.Path(r"C:\projects\s2s")
S2S_EXE = VENV / "Scripts" / "speech-to-speech.exe"

GROQ_BASE = "https://api.groq.com/openai/v1"
GROQ_MODEL = "llama-3.3-70b-versatile"


def groq_key():
    """從 config.js 取金鑰。那份檔案已 gitignore，是專案放密鑰的既定位置。"""
    cfg = BASE / "config.js"
    if not cfg.is_file():
        sys.exit("找不到 config.js。請先建立並填入 GROQ_API_KEY。")
    m = re.search(r"GROQ_API_KEY\s*:\s*['\"]([^'\"]+)", cfg.read_text(encoding="utf-8"))
    if not m:
        sys.exit("config.js 裡找不到 GROQ_API_KEY。")
    return m.group(1)


def main():
    if not S2S_EXE.is_file():
        sys.exit(
            f"找不到 {S2S_EXE}\n\n請先建立環境（torch 一定要用 CUDA 版，\n"
            f"直接 pip install 會拿到 CPU 版、Whisper 與 TTS 會慢到不能用）：\n"
            f"  python -m venv C:\\projects\\s2s\n"
            f"  C:\\projects\\s2s\\Scripts\\python.exe -m pip install torch torchaudio "
            f"--index-url https://download.pytorch.org/whl/cu130\n"
            f"  C:\\projects\\s2s\\Scripts\\python.exe -m pip install speech-to-speech"
        )

    port = "8765"
    argv = sys.argv[1:]
    if "--port" in argv:
        port = argv[argv.index("--port") + 1]

    cmd = [
        str(S2S_EXE),
        # STT 預設是 Parakeet（英語導向），中文一定要換 Whisper
        "--stt", "whisper",
        # 而 whisper 的預設模型是 distil-whisper/distil-large-v3——那是純英語的
        # 蒸餾模型，完全不會中文，不換的話中文會被硬聽成英文（實測聽成 "Go-"、"Yeah,"）。
        "--stt_model_name", "openai/whisper-large-v3-turbo",
        # 語言不指定的話 VAD 與 Whisper 都會當英語處理
        "--language", "zh",
        # LLM 走 Groq。旗標名稱雖叫 responses_api_*，chat-completions 後端也是用這組
        "--llm_backend", "chat-completions",
        "--model_name", GROQ_MODEL,
        "--responses_api_base_url", GROQ_BASE,
        "--responses_api_api_key", groq_key(),
        # 預設會送 chat_template_kwargs.enable_thinking=false（給 Together 的 Qwen3.5 用），
        # Groq 不支援這個屬性，會直接回 400 property 'chat_template_kwargs' is unsupported
        "--no_responses_api_disable_thinking",
        # TTS 預設走 ggml 後端，需要另外編譯的 qwentts_cpp（pip 裝不到）。
        # torch 後端用已經裝好的 CUDA PyTorch，不用額外依賴。
        "--qwen3_tts_backend", "torch",
        "--qwen3_tts_device", "cuda",
        "--ws_port", port,
    ]
    # --tts qwen3 與 --ws_port 8765 本來就是預設值，這裡明寫是為了自我說明

    print(f"▶ 語音服務啟動中… ws://127.0.0.1:{port}/v1/realtime")
    print(f"  STT=whisper  LLM={GROQ_MODEL}@Groq  TTS=Qwen3-TTS(預設)")
    print("  第一次執行會下載模型權重，請耐心等候。\n")
    # 金鑰不印出來
    try:
        subprocess.run(cmd, cwd=str(BASE))
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
