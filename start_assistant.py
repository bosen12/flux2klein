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

# ---- 斷句靈敏度（收音環境不同差很多，這三個最值得自己調）----
# thresh：VAD 觸發門檻。預設 0.6 偏高，要講得夠大聲清楚才會觸發，感覺「不靈敏」。
#         調低比較容易聽到你，但太低會被環境噪音誤觸發。建議 0.35~0.45 之間試。
VAD_THRESH = "0.4"
# min_silence_ms：靜音多久算你講完。預設 64ms 短得離譜——中文句子中間的自然停頓
#         都不只 64ms，於是一句話被切成好幾段各自送去辨識，就會聽成片段。
VAD_MIN_SILENCE = "500"
# min_speech_ms：短於這個長度的聲音不算說話，用來擋掉咳嗽、鍵盤聲。
VAD_MIN_SPEECH = "384"

# ---- 音色 ----
# 套件預設用 CustomVoice 模型配內建 speaker「Aiden」（英語男聲）。要用自己的聲音
# 就得換成 Base 模型——只有 Base 支援 ref_audio 音色克隆，CustomVoice 給的是預設音色。
TTS_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
# 參考音訊：24kHz 單聲道 wav。官方建議 5~10 秒、純淨人聲無背景音。
# voices/ 已 gitignore——這是本人聲音，不進公開版控。
REF_AUDIO = "voices/my_voice_10s.wav"
# 克隆模式二選一（見 faster_qwen3_tts/cli.py 的 _validate_clone_refs）：
#   xvec_only=True  只取聲紋嵌入。不需要逐字稿，但**只有音色會跟過來**——
#                   腔調、語調、說話節奏都不會（model.py 的 docstring：xvec 是
#                   "instead of the full ICL acoustic prompt"）。
#   xvec_only=False ICL 模式，完整參考音訊的聲學 token 進脈絡，**連腔調與語氣
#                   一起學**，但必須提供正確的 ref_text，填錯音色會走樣。
#
# 要讓台灣腔跟過來就得用 ICL。模型本身沒有腔調開關——config 的
# codec_language_id 只有籠統的 "chinese"，沒有 zh-TW 或方言變體，
# 腔調的唯一來源就是參考音訊。
#
# 換 ICL 的做法：照下面 REF_SCRIPT 唸一遍錄下來（用聊天語氣，不要用朗讀語氣
# ——ICL 會把語氣一起學走），存成 24kHz 單聲道 wav 放進 voices/，把 REF_AUDIO
# 指過去，再把這裡改成 False。逐字稿照稿唸就保證正確，不必靠 Whisper 轉
# （實測它對舊的參考音訊辨識不可靠，同一段切 3 秒與 10 秒轉出的內容對不起來）。
TTS_XVEC_ONLY = True

# 錄音講稿。REF_TEXT 必須與實際唸出來的內容逐字一致，所以兩者共用同一個常數：
# 改稿就一起改，不會出現稿子與逐字稿不同步的情況。
REF_SCRIPT = "欸，這張圖真的拍得不錯耶！我昨天去河邊走走，天氣超好的，就順手拍了幾張。等一下傳給你看看，你應該會喜歡。"
REF_TEXT = REF_SCRIPT   # 僅 TTS_XVEC_ONLY = False 時才會用到


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
        # 斷句靈敏度，三個常數的說明見檔案上方
        "--thresh", VAD_THRESH,
        "--min_silence_ms", VAD_MIN_SILENCE,
        "--min_speech_ms", VAD_MIN_SPEECH,
        # 預設是貪婪解碼（beams=1）。中文同音字多，加一點 beam search 明顯少聽錯，
        # Whisper turbo 夠快，多這點運算不影響對話節奏。
        "--stt_gen_num_beams", "3",
        # TTS 預設走 ggml 後端，需要另外編譯的 qwentts_cpp（pip 裝不到）。
        # torch 後端用已經裝好的 CUDA PyTorch，不用額外依賴。
        "--qwen3_tts_backend", "torch",
        "--qwen3_tts_device", "cuda",
        # 音色克隆：Base 模型 + 參考音訊，說明見檔案上方
        "--qwen3_tts_model_name", TTS_MODEL,
        "--qwen3_tts_ref_audio", str(BASE / REF_AUDIO),
        # TTS 也要講中文，否則會用英語音素念中文
        "--qwen3_tts_language", "zh",
        "--ws_port", port,
    ]
    # --tts qwen3 與 --ws_port 8765 本來就是預設值，這裡明寫是為了自我說明

    # 兩種克隆模式擇一，不能混用：xvec_only 不吃 ref_text，ICL 模式則非給不可
    if TTS_XVEC_ONLY:
        cmd.append("--qwen3_tts_xvec_only")
    else:
        if not REF_TEXT:
            sys.exit("ICL 模式（TTS_XVEC_ONLY = False）必須填 REF_TEXT，"
                     "內容要與 REF_AUDIO 的語音完全一致。")
        cmd += ["--qwen3_tts_ref_text", REF_TEXT]

    print(f"▶ 語音服務啟動中… ws://127.0.0.1:{port}/v1/realtime")
    print(f"  STT=whisper-large-v3-turbo  LLM={GROQ_MODEL}@Groq  TTS=Qwen3-TTS(Base)")
    print(f"  音色：克隆自 {REF_AUDIO}"
          f"（{'x-vector 聲紋模式，不需逐字稿' if TTS_XVEC_ONLY else 'ICL 模式'}）")
    print(f"  斷句：thresh={VAD_THRESH}（越低越靈敏）"
          f"  靜音={VAD_MIN_SILENCE}ms（越大越不會把句子切斷）"
          f"  最短語音={VAD_MIN_SPEECH}ms")
    print("  覺得不靈敏就把 thresh 調小、句子被切碎就把靜音調大，改本檔上方的常數。")
    print("  第一次執行會下載模型權重，請耐心等候。\n")
    # 金鑰不印出來
    try:
        subprocess.run(cmd, cwd=str(BASE))
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
