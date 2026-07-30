# LiveTalking 對嘴數字人搭建指引

給接手的人（或 AI）：這份是把 **LiveTalking**（即時對嘴數字人）接上「本地 Qwen3-TTS 克隆音色 + Groq LLM」的完整步驟。目標是**女友模式的陪聊有嘴型對嘴**。

> **狀態：wav2lip 路線已跑通並整合進面板**（2026-07-30）。venv、依賴、模型、Groq LLM、本地 Qwen3-TTS 模組、自建 avatar、啟動 bat、以及**助理抽屜的對嘴整合**都已驗證。**還沒做的**：MuseTalk 路線（權重只在夸克網盤）、EdgeTTS 路線實跑、跟助理對話的端到端體感。標「⚠️ 未驗證」的才是還沒跑過的。

---

## 0. 先搞清楚架構（很重要，別搞混）

LiveTalking 是一套**完整且獨立**的語音數字人系統（自帶對話 LLM + TTS + 對嘴 + WebRTC 串流）。它跟本專案現有的 `start_assistant.py`（speech-to-speech）是**兩套平行的東西**：

| 你要幹嘛 | 開哪個 | 有對嘴嗎 |
|---|---|---|
| **女友陪聊** | LiveTalking（本文件） | ✅ 有對嘴 |
| **叫助理操作面板生圖** | 現有的 `start_assistant.py` | ❌ 只有音量驅動頭像 |

**LiveTalking 不能操作面板**（沒有本專案的 tool calling）。所以它只取代「陪聊」那半，兩者依用途二選一開、不同時跑。

### 費用：不用阿里、全免費
- **TTS**：本地 Qwen3-TTS 克隆音色（免費、本地）
- **LLM**：Groq（走本專案的 `groq_proxy.py` 多 key 輪替，免費 tier）
- **對嘴**：wav2lip / MuseTalk 本地（免費）
- LiveTalking 內建的 `--tts qwentts` 是 **DashScope 雲端**、要阿里 key——**我們不用它**，改用自製的 `--tts qwen3local`。

---

## 1. 前置需求（本機實測值）

- NVIDIA RTX 5070 Ti，16GB，**sm_120（Blackwell）**
- CUDA 驅動 13.0
- LiveTalking clone 在 `C:\projects\LiveTalking`（upstream: github.com/lipku/LiveTalking，實測 commit `a5a77f4`）
- 參考音訊 `voices/my_voice_10s.wav`

**✅ Blackwell 相容性已驗證**：`torch 2.13.0+cu130` 的 `get_arch_list()` 含 `sm_120`，`cuda.is_available()` 為 True。（別照 LiveTalking README 裝 torch 2.0.x/cu118——那個沒有 sm_120 核心，在這張卡上跑不動。）

**✅ mmcv 完全沒用到**：走 wav2lip + 官方預建 avatar 的路線，從安裝到執行都沒碰 mmcv，不需要 nvcc 或 VS Build Tools。只有「自己從影片建 avatar」才會觸發 `avatars/musetalk/utils/preprocessing.py` 的 mmcv 相依。

**✅ aiortc 沒有編譯問題**：`aiortc 1.15.0` 在 Windows + Python 3.10 直接裝好，沒有 README FAQ 提到的那些問題。

---

## 2. 建虛擬環境 + 裝依賴（已驗證）

**venv 放 `E:\lt`**，不是 C 槽——C 槽只剩 ~57GB（95% 滿），而 E 槽有 1.4TB。LiveTalking 本身與模型仍在 C。

```bash
# Python 3.10（README 用 3.12，但 3.10 的套件相容性更好，實測沒問題）
C:\Users\<you>\AppData\Local\Programs\Python\Python310\python.exe -m venv E:\lt

# torch 對齊本機 CUDA 13.0。**一定要 cu130 以上**，才有 sm_120 核心
E:\lt\Scripts\python.exe -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130

# LiveTalking 依賴
E:\lt\Scripts\python.exe -m pip install -r C:\projects\LiveTalking\requirements.txt

# 本地克隆音色要用的（會把 transformers 降到 4.57.3，正常）
E:\lt\Scripts\python.exe -m pip install faster-qwen3-tts
```

驗證：
```bash
E:\lt\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_arch_list())"
```
要看到 `True` 且 arch list 含 `sm_120`。

**選配**：本地語音輸入（麥克風講話）需要 `pip install funasr modelscope`。沒裝的話啟動時會印 `[ASR] funasr not installed — local ASR endpoint disabled`，**打字對話照樣可用**。

---

## 3. 下載模型 + avatar（wav2lip 已自動下載完成）

**wav2lip 路線的兩個檔可以用 gdown 自動抓**（Google Drive 那個夾裡就只有這兩個）：

```bash
E:\lt\Scripts\python.exe -m pip install gdown
# wav2lip256.pth -> models/wav2lip.pth（215MB）
E:\lt\Scripts\python.exe -m gdown 1wu6XujFL9rF-0P2l44G6kpeapeY0cME7 -O C:\projects\LiveTalking\models\wav2lip.pth
# avatar（353MB），解壓後可刪壓縮檔
E:\lt\Scripts\python.exe -m gdown 1aU-9SMEAZWN00hbvAGlRHG2iB17r9dEW -O C:\projects\LiveTalking\data\avatars\wav2lip256_avatar1.tar.gz
cd C:\projects\LiveTalking\data\avatars && tar -xzf wav2lip256_avatar1.tar.gz && del wav2lip256_avatar1.tar.gz
```
解開後是 `wav2lip256_avatar1/`（`coords.pkl` + `face_imgs` + `full_imgs`，550 幀）。

**⚠️ MuseTalk 的權重與 avatar 不在 Google Drive**，只在[夸克網盤](https://pan.quark.cn/s/83a750323ef0)（要登入客戶端，無法自動下載）。要對嘴品質才需要，得手動抓。

---

## 4. 我們對 LiveTalking 的改動（用腳本管理，別手改）

**改動在第三方 clone 裡、不受本專案版控**，LiveTalking 一 `git pull` 就可能被蓋掉。所以集中在一支冪等腳本：

```bash
python livetalking_patch.py          # 套用
python livetalking_patch.py --check  # 只檢查狀態
```

它做四件事（來源檔在本專案 `livetalking/`）：

| 檔案 | 改什麼 |
|---|---|
| `tts/qwen3local.py` | **新增**：本地 Qwen3-TTS 克隆音色模組 |
| `avatars/base_avatar.py` | 在 `_tts_modules` 註冊 `qwen3local` |
| `config.py` | `--tts` 的 help 補上 `qwen3local` |
| `llm.py` | DashScope → Groq（走 `groq_proxy` 輪替）＋女友人設 |

LiveTalking 更新後重跑腳本即可還原。若上游改了被替換的那段，腳本會明確報「找不到要替換的內容」而不是靜默失敗。

### TTS 外掛的正確寫法（實作時踩過的坑）

- 註冊機制是 **`registry.py` 的 `@register("tts", "名稱")` 裝飾器** ＋ `avatars/base_avatar.py` 的 `_tts_modules` 字典做 lazy import。**不是**改 `app.py`。
- 介面：繼承 `BaseTTS`、覆寫 `txt_to_audio(msg)`，`msg` 是 `(text, textevent)`。把 float32 單聲道音訊切成 `self.chunk`（**320 樣本 = 20ms @ 16kHz**）用 `self.parent.put_audio_frame(frame, eventpoint)` 送出。`sample_rate` 是 **16000**（正好對上本專案的 `PIPELINE_SR`，見進度.md 的 `8485463`）。
- `eventpoint` 要在第一幀標 `{'status':'start','text':text}`、最後一幀標 `'end'`，最簡範本看 `tts/edge.py`。
- **`faster_qwen3_tts` 的 API 跟先前計畫寫的不一樣**：類別是 **`FasterQwen3TTS`**、用 **`from_pretrained(model_name, device, backend)`**；`ref_audio` / `xvec_only` / `language` 是傳給 **`generate_voice_clone_streaming()`**，不是建構子。
- **`language` 不吃 `"zh"`**！要傳模型 config `codec_language_id` 的 key，中文是 **`"chinese"`**。傳 `zh` 會 `NotImplementedError: Language zh not implemented`。模組內有 alias 表自動轉換。
- **模型必須模組層級共用**：`build_avatar_session()` 是**每個 WebRTC session 呼叫一次**，若在 `__init__` 各自載入，每開一個 session 就多一份 ~3.5GB 模型（`max_session` 預設 5，直接爆顯存），重連也要再等十幾秒。已用 `_get_model()` + lock 只載一次。
- **要預熱**：第一次合成要捕獲 CUDA graph，實測 6.6 秒（即時率 3.8x）；預熱後每次只要 **0.35~0.37x**（比即時快約 3 倍）。預熱放模型載入時，別讓那 6 秒落在使用者第一句話上。

### 實測效能（RTX 5070 Ti）

| 項目 | 數字 |
|---|---|
| 模型載入 + 預熱 | 16.1 秒（一次性） |
| 合成即時率（穩定狀態） | **0.35~0.37x**（1 秒音訊約 0.36 秒算完） |
| 第二個 session 建立 | 0.000 秒（共用模型） |
| 顯存：wav2lip | ~3.1 GB |
| 顯存：Qwen3-TTS 1.7B | ~3.5 GB |

---

## 4b. 用自己的圖建 avatar（已驗證，bat 預設就用這個）

bat 預設的 `my_avatar` 是從面板那張人像建出來的。**不需要 mmcv**——wav2lip 自帶
`face_detection`，s3fd 權重第一次跑會自動下載。

```bash
# 1) 靜態圖轉成 25fps 短片（身體不動、只有嘴會被驅動，正是想要的效果）
#    尺寸要偶數；576x768 夠清晰也處理得快
ffmpeg -y -loop 1 -i <你的圖.png> -t 6 -r 25 \
  -vf "scale=576:-2,crop=576:768:0:0" -pix_fmt yuv420p -c:v libx264 avatar_src.mp4

# 2) 建 avatar（在 LiveTalking 目錄下跑）
cd C:\projects\LiveTalking
E:\lt\Scripts\python.exe -m avatars.wav2lip.genavatar ^
  --video_path <上一步的 avatar_src.mp4> --avatar_id my_avatar --img_size 256
```

產出在 `data/avatars/my_avatar/`：`coords.pkl` + `face_imgs/` + `full_imgs/`（各 150 張），
結構與官方 avatar 一致。**檢查 `face_imgs/00000000.png`**：要能看到完整五官**且含下巴**，
wav2lip 靠下巴對嘴，裁太緊會糊。

**avatar 不進版控**（在 LiveTalking 的 `data/avatars` 下、且是幾百張圖）。換機器要重跑這節。
bat 有存在性檢查：缺 `my_avatar` 會印警告並退回官方 avatar，不會直接炸。

---

## 5. 啟動（bat 已寫好，純 ASCII）

| bat | 用途 |
|---|---|
| `start_livetalking_edge.bat` | EdgeTTS 雲端語音（`zh-TW-HsiaoChenNeural`）。**先用這個驗證管線**，不載本地 TTS、啟動快、省顯存 |
| `start_livetalking_qwen.bat` | 本地 Qwen3-TTS **你的克隆音色** |
| `start_livetalking.bat` | 兩者共用的底層，不直接跑 |

兩支都會：
- **自動偵測並啟動 `groq_proxy.py`（8756）**，多 key 輪替避開每日上限
- 設好 `LLM_BASE_URL` / `LLM_MODEL` 與 `QWEN3_TTS_*` 環境變數
- 缺 venv / 缺 `wav2lip.pth` / 缺參考音訊 / 8010 被占用時，印清楚的錯誤而不是直接炸
- 缺 `my_avatar` 時印警告並自動退回官方 avatar

可帶參數覆寫：`start_livetalking_qwen.bat <model> <avatar_id>`。**預設是 `wav2lip` + `my_avatar`**
（用面板那張人像建的，見 4b）。要用官方附的：`start_livetalking_qwen.bat wav2lip wav2lip256_avatar1`。

`start_livetalking_qwen.bat` 裡可調的音色設定：
- `QWEN3_TTS_REF_AUDIO` — 參考音訊路徑
- `QWEN3_TTS_XVEC_ONLY=1` — 只取聲紋（不需逐字稿）。設 `0` 走 ICL 模式，**連腔調與語氣一起學**，但 `QWEN3_TTS_REF_TEXT` 必須是參考音訊的正確逐字稿（填錯音色會走樣）
- `QWEN3_TTS_CHUNK_SIZE=8` — 每塊 codec 步數，調小 = 第一個音更快出來

---

## 6. 開起來之後

1. 跑其中一個 bat。⚠️ 服務端要開 **TCP:8010、UDP 1-65536**（防火牆）。
2. 瀏覽器開 `http://127.0.0.1:8010/index.html`，按 **開始連接** → 數字人出現 → 在 `txtMessage` 打字按**發送** → 對嘴回應。
   - 本地 TTS 模式下，**模型是在你按「開始連接」時才載入**（16 秒），不是啟動時。第一次連會等一下。
3. **✅ 已整合進面板抽屜**（見進度.md `53a3de4`）。**不是**用 iframe 嵌 8010 那頁——那樣會失去助理的 tool calling（LiveTalking 不會操作面板）。實際做法是把它當**純對嘴渲染服務**：
   - `serve.py` 同源代理 `/offer` `/human` `/humanaudio` `/interrupt_talk` `/is_speaking` `/set_audiotype`（跨埠有 CORS，面板走 HTTPS 時打 http:8010 也會被當混合內容擋掉）
   - 助理照常對話與操作面板，TTS 語音收進緩衝、於 `response.done` 打包成 wav 送 `/humanaudio` 驅動嘴型
   - 影像走 WebRTC 回來蓋在 `#asst-avatar`；LiveTalking 沒開就安靜退回靜態頭像
   - **開抽屜到出現影像約 15~25 秒**（建 session 時要載入 TTS 模型，`/offer` 就要 6.5 秒）

---

## 7. 驗證 checklist

- [x] `torch.cuda.is_available()` → True，arch list 含 `sm_120`
- [x] `aiortc` 在 Windows 裝好
- [x] wav2lip 權重 + 官方 avatar 下載解壓
- [x] `app.py --model wav2lip` 能起、8010 回 200、web UI 元件正常
- [x] `llm.py` 指 Groq：走 proxy 拿到女友人設的繁中回覆
- [x] 本地 Qwen3-TTS 模組：輸出 320 樣本/幀、16kHz、start/end 事件正確、即時率 0.36x
- [x] bat 一鍵啟動（含自動起 proxy）
- [x] 用自己的圖建 avatar（`my_avatar`，bat 已設為預設）
- [x] **嵌進面板抽屜**：助理講話時 TTS 語音轉送 `/humanaudio` 驅動嘴型，影像走 WebRTC 顯示在頭像位置（見進度.md `53a3de4`）
- [x] 對嘴畫面（使用者確認過）
- [ ] EdgeTTS 路線實跑
- [ ] 換 MuseTalk（權重要手動從夸克網盤下載）
- [ ] 跟助理實際對話的端到端體感與延遲

---

## 8. 已知問題 / 風險

1. **llama 偶爾漏簡體字**：prompt 已按本專案 `df98467` 明講「用字必須是台灣正體字」，實測仍會出現如「一會**儿**」。因為 儿/兒 同音，**TTS 念出來沒差**，只影響畫面文字。要徹底解決得加簡→繁後處理（如 opencc），目前判斷不值得為此加依賴。
2. **動漫頭像嘴部會糊**：MuseTalk 對動漫臉效果差。若要用 illustrious 畫的動漫頭像，考慮 [Ditto](https://github.com/antgroup/ditto-talkinghead) 或接受糊。
3. **顯存**：wav2lip(3.1G) + Qwen3-TTS(3.5G) + 桌面(~7.5G) ≈ 14G / 16G，**女友模式不生圖所以不跟 ComfyUI 搶**（這就是女友模式的意義）。但要同時開 ComfyUI 生圖會爆——別同時開。
4. **TTS 在第一個 session 建立時才載入**（不是啟動時），所以第一次「開始連接」要等 16 秒。
5. **mmcv**：只有「自建 avatar」才需要。用官方預建 avatar 完全不碰。
6. **funasr 未裝**：麥克風語音輸入停用，打字可用。要語音輸入補 `pip install funasr modelscope`。

---

## 9. 相關檔案對照（本專案這邊）

- `livetalking_patch.py` — 把我們的改動套到 LiveTalking clone（冪等，可重複跑）
- `livetalking/qwen3local.py` — 本地 Qwen3-TTS 模組原始檔
- `livetalking/llm.py` — 改指 Groq 的 llm.py 原始檔（含女友人設）
- `start_livetalking*.bat` — 啟動器
- `groq_proxy.py` — 多 key 輪替代理（8756），bat 會自動起
- `start_assistant.py` — 另一套（能操作面板的助理），本地 Qwen3-TTS 參數範本也在這
- `voices/my_voice_10s.wav` — 克隆音色參考音訊（已 gitignore）
- `進度.md` 的 `8485463` — 為什麼取樣率是 16000
- `app.js` 的 `ASST_PROMPT_GF` — 女友人設來源
