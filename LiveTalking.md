# LiveTalking 對嘴數字人搭建指引

給接手的人（或 AI）：這份是把 **LiveTalking**（即時對嘴數字人）接上「本地 Qwen3-TTS 克隆音色 + Groq LLM」的完整步驟。目標是**女友模式的陪聊有嘴型對嘴**。

> **這份文件是探路後寫的計畫，不是已完成的紀錄。** 下面的程式碼與步驟基於實際看過的 LiveTalking 原始碼（已 clone 在 `C:\projects\LiveTalking`），但 **GPU 推論、mmcv 編譯、WebRTC 串流都還沒實測過**——寫這份的 session 無法連到 GPU/瀏覽器。標「⚠️ 未驗證」的地方要自己跑過確認。

---

## 0. 先搞清楚架構（很重要，別搞混）

LiveTalking 是一套**完整且獨立**的語音數字人系統（自帶對話 LLM + TTS + 對嘴 + WebRTC 串流）。它跟本專案現有的 `start_assistant.py`（speech-to-speech）是**兩套平行的東西**：

| 你要幹嘛 | 開哪個 | 有對嘴嗎 |
|---|---|---|
| **女友陪聊** | LiveTalking（本文件） | ✅ 有 MuseTalk 對嘴 |
| **叫助理操作面板生圖** | 現有的 `start_assistant.py` | ❌ 只有音量驅動頭像 |

**LiveTalking 不能操作面板**（沒有本專案的 tool calling）。所以它只取代「陪聊」那半，兩者依用途二選一開、不同時跑。

### 費用：不用阿里、全免費
選的是「C 方案」——每一塊都繞開阿里雲 DashScope：
- **TTS**：本地 Qwen3-TTS 克隆音色（`C:\projects\s2s` 那套，免費、本地）
- **LLM**：Groq（改 `llm.py`，用 `config.js` 的 key，免費 tier）
- **對嘴**：MuseTalk 本地（免費）
- LiveTalking 內建的 `--tts qwen` 是 **DashScope 雲端**、要阿里 key——**我們不用它**，改用本地模組（步驟 5）。

---

## 1. 前置需求

- NVIDIA 顯卡（本機是 RTX 5070 Ti，16GB，sm_120 Blackwell）
- 已裝 CUDA 驅動（`nvidia-smi` 確認，本機是 CUDA 13.0）
- LiveTalking 已 clone 在 `C:\projects\LiveTalking`
- 本地 Qwen3-TTS 已可用（`C:\projects\s2s` venv，`faster-qwen3-tts` + `voices/my_voice_10s.wav`）

**⚠️ Blackwell 相容性**：LiveTalking README 測試環境是 Python 3.12 + torch 2.9.1 / cu128，torch 2.6+ 才有 sm_120 核心。本機 torch 走 cu130（更新，OK）。**mmcv 只在 `avatars/musetalk/utils/preprocessing.py`（建 avatar 的預處理）出現，即時推論看來不碰**——如果只用官方預建的 avatar、不自己從影片建，也許能完全避開 mmcv 編譯。若真的要 mmcv 而報錯，得裝 CUDA Toolkit（nvcc）+ VS Build Tools 後 `MMCV_WITH_OPS=1 FORCE_CUDA=1 pip install mmcv==2.1.0 --no-build-isolation`（別人在 RTX 5090 上這樣建成功）。

---

## 2. 建虛擬環境 + 裝依賴

LiveTalking 跟 `s2s` 的 torch 版本可能不同，**用獨立環境**，別混進 `C:\projects\s2s`。

```bash
# 用 venv（README 用 conda，但本專案慣例是 venv；擇一即可）
python -m venv C:\projects\lt

# torch：對齊本機 CUDA 13.0（跟 s2s 一樣）。README 給的是 cu128，本機用 cu130。
C:\projects\lt\Scripts\python.exe -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130

# LiveTalking 依賴
cd C:\projects\LiveTalking
C:\projects\lt\Scripts\python.exe -m pip install -r requirements.txt
```

裝完驗證 CUDA：
```bash
C:\projects\lt\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```
要看到 `True`。⚠️ 未驗證：requirements 裡若有 `aiortc`（WebRTC）在 Windows 編不過，看 [LiveTalking FAQ](https://doc.livetalking.ai/docs/faq/)。

---

## 3. 下載模型 + avatar

模型在官方網盤（[夸克](https://pan.quark.cn/s/83a750323ef0) / [Google Drive](https://drive.google.com/drive/folders/1FOC_MD6wdogyyX_7V1d4NDIO7P9NlSAJ)）。

**先用 wav2lip 驗證整條管線通不通（最省事，~1GB、無 mmcv），再換 MuseTalk 求品質：**
1. `wav2lip256.pth` → 放 `models/`、改名 `wav2lip.pth`
2. `wav2lip256_avatar1.tar.gz` → 解壓整個資料夾放 `data/avatars/`

**MuseTalk（要對嘴品質）**：同網盤找 MuseTalk 的權重與 avatar，依 README/docs 放對位置（⚠️ 未驗證確切檔名，以網盤實際為準）。要自訂頭像用 `http://localhost:8010/avatar.html` 上傳影片自動生成（這步可能觸發 mmcv 預處理）。

---

## 4. 改 llm.py 指向 Groq

`C:\projects\LiveTalking\llm.py` 現在寫死 DashScope。改三個地方（key 別硬編，從環境變數讀）：

```python
        client = OpenAI(
            api_key=os.getenv("GROQ_API_KEY"),              # 改：原本 DASHSCOPE_API_KEY
            base_url="https://api.groq.com/openai/v1",       # 改：原本 dashscope 那串
        )
        ...
        completion = client.chat.completions.create(
            model="llama-3.3-70b-versatile",                 # 改：原本 qwen-plus
            messages=[{'role': 'system', 'content': '（放女友人設，見下）'},
                    {'role': 'user', 'content': message}],
            stream=True,
            stream_options={"include_usage": True}
        )
```

**女友人設**（system content）照本專案 `app.js` 的 `ASST_PROMPT_GF` 精神寫，並保留那幾條 TTS 硬限制（禁 markdown/emoji/括號動作、數字用中文、繁體台灣用語），否則對嘴會念出「星號」跟簡體。

**多 key 輪替**：要接本專案的 `groq_proxy.py`（8756）——把 `base_url` 改成 `http://127.0.0.1:8756/openai/v1`，並先跑 `python C:\projects\flux2klein\groq_proxy.py`，就能兩把 key 接力、避開每日上限。

---

## 5. 本地 Qwen3-TTS 模組（C 方案的核心）

LiveTalking 的 `--tts qwen` 是雲端 DashScope，不是你的克隆音色。要用本地音色，**新增一個 TTS 模組**。

LiveTalking 的 TTS 介面（`tts/base_tts.py`）：繼承 `BaseTTS`、覆寫 `txt_to_audio(msg)`，把音訊切成 `self.chunk`（16kHz、20ms/塊）塞回串流佇列。**`sample_rate` 是 16000**——正好對上本專案發現的 `PIPELINE_SR=16000`（見 `進度.md` 的 8485463）。

新增 `C:\projects\LiveTalking\tts\qwen3local.py`：

```python
# 本地 Qwen3-TTS（克隆音色），輸出 16kHz 塞回 LiveTalking 串流。
# ⚠️ 未驗證：txt_to_audio 把音訊塞回 parent 的確切呼叫，要「對照 tts/edge.py」補完
#    （edge.py 是最簡單的範本，看它 txt_to_audio 怎麼把 chunk 交給 parent）。
import numpy as np, resampy
from .base_tts import BaseTTS
from faster_qwen3_tts import Qwen3TTS   # 與 s2s 同一套；lt venv 也要 pip install faster-qwen3-tts

class Qwen3LocalTTS(BaseTTS):
    def __init__(self, opt, parent):
        super().__init__(opt, parent)
        self.model = Qwen3TTS(               # 參數對照 s2s 的 start_assistant.py
            model_name="Qwen/Qwen3-TTS-12Hz-1.7B-Base",
            device="cuda", backend="torch",
            ref_audio=r"C:\projects\flux2klein\voices\my_voice_10s.wav",
            xvec_only=True, language="zh",
        )

    def txt_to_audio(self, msg):
        text, datainfo = msg
        pcm24k = self.model.synthesize(text)          # ⚠️ 確切 API 名對照 faster_qwen3_tts
        pcm16k = resampy.resample(pcm24k.astype(np.float32), 24000, 16000)
        # ⚠️ 以下切塊 + 塞回 parent 的方式「照抄 tts/edge.py 的 txt_to_audio 尾段」
        # 大致是：for chunk in 分塊(pcm16k, self.chunk): self.parent.put_audio_frame(chunk, datainfo)
```

註冊：在 `app.py` 選 TTS 的地方（搜 `edgetts` / `--tts`）加一個分支 `elif opt.tts == "qwen3local": tts = Qwen3LocalTTS(opt, avatar)`，或看它的 registry 機制。⚠️ 未驗證確切註冊點——搜 `edgetts` 字串找到 TTS 分派處照樣加。

---

## 6. 兩個啟動 bat（純 ASCII，中文會讓 bat 閃退，見 3a994ac）

`start_livetalking_edge.bat`（雲端 EdgeTTS，免費、省顯存，先用這個驗證）：
```bat
@echo off
cd /d C:\projects\LiveTalking
set "GROQ_API_KEY=<貼第一把 key，或先跑 groq_proxy 走輪替>"
C:\projects\lt\Scripts\python.exe app.py --transport webrtc --model musetalk --avatar_id <你的avatar> --tts edgetts --REF_FILE zh-CN-XiaoxiaoNeural
pause
```

`start_livetalking_qwen.bat`（本地克隆音色）：
```bat
@echo off
cd /d C:\projects\LiveTalking
set "GROQ_API_KEY=<同上>"
C:\projects\lt\Scripts\python.exe app.py --transport webrtc --model musetalk --avatar_id <你的avatar> --tts qwen3local
pause
```

先用 `--model wav2lip --avatar_id wav2lip256_avatar1` 跑通，再換 `musetalk`。

---

## 7. 啟動、看畫面、嵌進面板

1. 跑其中一個 bat。⚠️ 服務端要開 **TCP:8010、UDP 1-65536**（防火牆）。
2. 瀏覽器開 `http://localhost:8010/index.html`，按「開始連接」→ 數字人出現，文字框打字或講話 → 對嘴回應。
3. **嵌進本專案面板**：把這個 WebRTC 頁面用 `<iframe>` 放進助理抽屜的頭像舞台位置（`index.html` 的 `#asst-avatar`）。因為是跨埠（7801→8010），iframe 直接嵌最省事；或用 LiveTalking 的 API（`docs/api.md`）自己接 WebRTC。⚠️ 未驗證：混合內容（HTTPS 面板嵌 http:8010）可能被擋，屆時 8010 也要 TLS，或走 serve.py 代理（參考本專案 `/assistant` WS 代理 3c1121d 的做法，加一條 `/livetalking` 路由）。

---

## 8. 驗證 checklist（照順序，一關一關來）

- [ ] `torch.cuda.is_available()` → True
- [ ] wav2lip + 官方 avatar：`app.py --model wav2lip` 能起、8010/index.html 出現數字人（先不管品質，驗證管線）
- [ ] llm.py 指 Groq：打字對話有回應（看 console 的 `llm Time to first chunk`）
- [ ] EdgeTTS：講中文、對嘴會動
- [ ] 換 MuseTalk：品質提升（⚠️ 動漫頭像嘴部可能糊，見下）
- [ ] 本地 Qwen3-TTS 模組：`--tts qwen3local` 出你的克隆音色
- [ ] 嵌進面板抽屜

---

## 9. 已知障礙 / 風險（誠實記錄）

1. **動漫頭像嘴部會糊**：MuseTalk 對動漫臉效果差（實作者原話）。若頭像是 illustrious 畫的動漫風，考慮改用 [Ditto](https://github.com/antgroup/ditto-talkinghead)（2026 diffusion 對嘴，品質可能更好，但生態新、Blackwell 未驗證），或接受糊。
2. **顯存**：MuseTalk 常駐 + 本地 Qwen3-TTS，女友模式不生圖所以不跟 ComfyUI 搶（這就是女友模式的意義）。但兩者仍要塞進 16GB，⚠️ 未實測峰值。
3. **mmcv**：只在建 avatar 的預處理需要。用官方預建 avatar 可能完全避開；自建頭像才會撞到，那時要 nvcc+VS 編 mmcv 2.1.0。
4. **WebRTC on Windows**：`aiortc` 在 Windows 偶有編譯/執行問題，看官方 FAQ。
5. **這份全部未在本機實測**：寫的 session 連不到 GPU/瀏覽器。第一次跑一定有東西要修，把報錯貼給下一個 session。

---

## 10. 相關檔案對照（本專案這邊）

- `start_assistant.py` — 現有 speech-to-speech，本地 Qwen3-TTS 的參數範本（ref_audio、xvec_only、language）都在這
- `groq_proxy.py` — 多 key 輪替代理，LiveTalking 的 llm.py 可指向它（8756）
- `voices/my_voice_10s.wav` — 你的克隆音色參考音訊
- `進度.md` 的 `8485463` — 為什麼取樣率是 16000（Qwen3-TTS 原生 24000 但管線降 16000）
- `app.js` 的 `ASST_PROMPT_GF` — 女友人設 + TTS 硬限制，llm.py 的 system prompt 照抄
