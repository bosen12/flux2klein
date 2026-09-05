# Flux2 Klein · ComfyUI 多引擎本地面板

呼叫本地 ComfyUI 的網頁面板，內建 **4 組 AI 繪圖引擎**、即時進度（it/s + ETA）、串流預覽、完成音效／通知、前後對照拉桿、AI 提示詞優化。

![架構](https://img.shields.io/badge/純前端-無需安裝套件-blue)
![Python](https://img.shields.io/badge/Python_3.7+-標準函式庫-green)

---

## 支援引擎

| 引擎 | 模型 | 提示詞風格 | 功能 |
|------|------|-----------|------|
| **Flux2 Klein** | flux-2-klein-4b | 自然語言描述（100–400 字） | 文生圖 / 單雙三圖編輯 / 局部重繪 / 圖像擴展 |
| **Z-Image Turbo** | pornmaster V35 / redcraft HD | 自然語言句子 | 文生圖 / ControlNet (Canny) |
| **Krea2** | redcraft Krea2 | 自然語言（攝影細節） | 文生圖 + SeedVR2 放大 / 二次採樣 |
| **Illustrious** | waiIllustrious SDXL v170 | Danbooru 逗號分隔 tag | 文生圖 + Hires / ControlNet / SeedVR2 / SD 放大 |

### 各引擎提示詞寫法

**Flux2 Klein / Z-Image / Krea2**（自然語言系）
- 寫完整描述句，不要堆逗號分隔的關鍵字
- 主體放最前面，不要被場景描述埋掉
- Flux2 Klein 用 Qwen 編碼器，不需要品質詞（masterpiece 等無效）
- Krea2 描述攝影細節（光線、鏡頭感、材質）效果特別好

**Illustrious**（Danbooru tag 系）
- 使用逗號分隔 tag，不是自然語言
- 順序：品質詞 → 人數 → 角色/系列 → 外觀/服裝 → 姿勢/背景
- 重要特徵放前面（CLIP 會分塊編碼，靠前的 tag 權重較高；77 不是截斷點）
- 支援 Negative prompt（面板有輸入框；選詞庫負向時會覆蓋）

---

## 功能特色

### 狀態持久化
- 引擎、模式、提示詞、尺寸、步數、種子、增強開關、偏好（音效／通知／預覽）記在 `localStorage`，重整後還原
- 切模式時若提示詞已被改過，不會用該模式的預設稿蓋掉

### 圖片編輯的畫布形狀
- 文生圖用尺寸欄位／比例 chip
- **單圖／雙圖／三圖編輯、局部重繪、圖像擴展**沒有尺寸欄位（Flux2 用上傳圖的像素）。上傳後面板會讀實際寬高：AI 優化與助理 `set_aspect` 拿得到畫布形狀，不會再當成「沒有尺寸」

### 即時進度
- WebSocket 連線取得每步進度，顯示 it/s（或 s/it）與 ETA
- 分塊操作（如 Ultimate SD Upscale）進度條只進不退，顯示「第 N 塊」
- 二進位訊息即時預覽縮圖

### 前後對照
- 開啟增強（Hires / SeedVR2 / SD 放大）後，自動生成前後對照拉桿
- 點擊對照圖開啟全螢幕 overlay，支援滾輪縮放 + 拖曳平移 + 分隔線比較

### AI 提示詞優化
- 提示詞框右下角 hover 顯示 ✦ 按鈕
- 點擊後透過同源 `/panel/groq`（Groq Llama 3.3 70B）串流優化提示詞；key 不進瀏覽器
- 根據當前引擎自動切換 system prompt（自然語言 vs Danbooru tag）
- 優化後可用「還原優化前」救回原文
- 需要在本機 `config.js` 設定 API Key（見下方）

### 語音輸入
- 提示詞框右下角 🎤 按鈕，點一下開始講、再點一下停止，辨識結果即時接在現有文字後面
- 使用瀏覽器內建的 Web Speech API（預設 zh-TW 中文），只在 **Chrome / Edge** 且**安全來源**（`localhost` 或 HTTPS）可用
- ⚠️ Chrome 的實作會把**語音音訊送到 Google 伺服器**辨識（見下方隱私說明）；不支援的瀏覽器會自動隱藏此按鈕
- 手機請走 HTTPS + Tailscale；區網 IP 會被面板拒絕（沒有登入）

### 增強分支
- Illustrious：Hires 二次採樣 / ControlNet / SeedVR2 放大 / SD 放大（可獨立開關）
- Krea2：SeedVR2 放大 / 二次採樣
- 放大可不經過二次採樣，直接從 base 輸出放大

### LoRA 風格（Illustrious 專用）
- 開關開啟後可從 ComfyUI 的多個 LoRA 分類夾（`style` / `Character` / `HENTAI` / `illus`）**單選**一個
- **分類 chip 列**（各帶數量）快速縮小範圍，搭配搜尋框跨全部搜（名稱／觸發詞）；LoRA 數百個也好找
- 可搜尋的縮圖清單，**滑鼠移到某個 LoRA 會浮出預覽**（讀該檔旁的同名圖或短片，支援 `.preview.png/.jpeg/.jpg/.webp/.mp4/.webm` 與同名 `.png/.jpg/.jpeg/.webp/.mp4/.webm`，先命中先用；影片靜音循環），每頁 80 個、底部可**翻上一頁／下一頁**（切分類或搜尋會回第 1 頁）
- 一支 **0~1 強度滑桿**（預設 0.8），同時套用在 model 與 clip
- 自動把該 LoRA 的**觸發詞**（讀 `.metadata.json` 的 `trainedWords`，會剝掉 CivitAI 複製來的 `<lora:…>` 語法——ComfyUI 不認得）帶進一個
  **像提示詞的文字框**，可直接打字自由增刪（**只改面板這份、不動原始檔**），
  並用開關決定要不要把框裡的內容加進提示詞
- 送出時面板會即時插入一個 `LoraLoader` 節點、把 model/clip 從 checkpoint 改接到它（VAE 不受影響）

### 詞庫（Illustrious 專用）
- 從 `special_prompts` 的數十個分類夾**單選**一個情境詞庫（2000＋個），介面與 LoRA 選單同款（分類＋搜尋＋hover `.webp` 預覽＋每頁 80 分頁）
- 分類多（＞8）時自動**收合成一行**（「分類：目前 ▾」），點開才用高度動畫攤出完整 grid、選完自動收起；分類少（如 LoRA）維持平鋪。**展開後上方有「搜尋分類…」框**，打字即時篩選分類晶片（詞庫有上百個分類時，不用在一堆晶片裡找）——展開就自動聚焦、可直接打
- 選取後：把該詞庫的 `REQUIRED_POSITIVE + POSITIVE` 以逗號串接**填進正向提示詞框**（可再手動編輯），並記住它的 `NEGATIVE`
- 選到帶有 `NEGATIVE` 的詞庫時，會出現「負向來源」二選一：**詞庫負向**（送出時整段覆蓋掉負向節點，預設選項）或**預設負向**（不覆蓋，保留 workflow 內建的負向）
- 後端用 `ast` **安全解析** `.py`（只取那三個 list，不 import、不執行）

### 引擎主題色
每個引擎錨在一個真實顏料上，切引擎時整個介面跟著換色：

| 引擎 | 顏料 | 色值 |
|------|------|------|
| Flux2 Klein | 國際克萊因藍 IKB | `#002fa7` |
| Z-Image Turbo | 鎘橙 Cadmium Orange | `#c2461a` |
| Krea2 | 帝王紫 Tyrian Purple | `#6e2350` |
| Illustrious | 茜紅 Rose Madder | `#b93659` |

新增引擎只要在 `styles.css` 的 `:root[data-engine="..."]` 給四個變數：`--accent`（主色，
白字按鈕底，要 ≥4.5:1）、`--accent-3`（同色淺階，只當漸層第二站，必須是主色的鄰居）、
`--accent-2`（對比火花，只用在光束與 loader 描邊）、`--accent-soft`（淺色底）。

### 動態背景
- 淡淡的柔光色團，跟著引擎主題色走。強度刻意很低（opacity .14 / blur 100px）——
  它是背景，不該比內容還醒目
- 尊重系統「減少動態」設定：開啟時停止漂移，保留靜態柔光
- 原本這裡是 Vanta.js FOG 的 WebGL 流動彩霧，2026-09 停用：它是畫面上最強的視覺
  元素，而 `three.min.js` 傳輸 154KB 全花在一個不能互動的背景上（佔首次載入 26%）。
  `three.min.js` / `vanta.fog.min.js` 與 `serve.py` 的白名單條目都留著，把 `app.js`
  的 `startBgFx()` 換回原本的 `loadScript` 流程就會復原

---

## 快速開始

### 1. 啟動 ComfyUI
照平常方式啟動，**不需要**加 `--enable-cors-header`。預設位址 `127.0.0.1:8188`。

### 2. 設定 AI 提示詞優化（可選）
建立 `config.js`（已加入 .gitignore，不會被提交）：

```javascript
window.YZ_CONFIG = {
  GROQ_API_KEY: '你的 Groq API Key',
  // 多把輪替：GROQ_API_KEYS: ['key1', 'key2'],
};
```

到 [console.groq.com](https://console.groq.com) 免費申請 API Key。

金鑰只留在伺服器：面板送出 `config.js` 時會剝掉 key，優化請求走同源 `/panel/groq`（與語音助理共用 `groq_proxy.py` 輪替）。不要把 key 寫進會進 git 的檔案。

### 3. 啟動面板
```bash
python serve.py
```

看到這行就成功了：
```
▶ 開啟瀏覽器： http://127.0.0.1:7801/klein
```

### 4. 開始使用
前往 **http://127.0.0.1:7801/klein**，右上角顯示「已連線」即代表接上 ComfyUI。
頂部膠囊切換引擎，左側表單輸入提示詞、調整參數，按「生成」送出。

---

## 自訂位址 / 埠

```bash
python serve.py 127.0.0.1:8188 7801     # ComfyUI位址  面板埠
python serve.py 192.168.1.50:8188       # ComfyUI 在另一台機器
python serve.py 127.0.0.1:8188 8190     # 面板改用 8190
```

---

## AI 助理（語音／打字操作面板）

右上角的膠囊會開啟助理抽屜。它不是第五個引擎——它**操作**那四個引擎：切換引擎、寫提示詞、設尺寸步數、開關增強分支、送出生成。

**兩種輸入方式**
- **打字**：抽屜底部輸入框，Enter 送出。不需要麥克風、不需要 HTTPS；遠端請走 Tailscale（面板不放行區網 IP，見下方 HTTPS 一節）
- **語音**：按「開始聆聽」直接說話，可隨時插話打斷回覆

**手機使用**：助理的 WebSocket 走 `serve.py` 同源代理（`/assistant` → 本機語音服務 8765），所以手機連面板就連得到語音服務、打字直接可用。**語音**還需要麥克風權限，而麥克風只在安全來源給——手機得用 HTTPS 啟動面板（`python serve.py --https`，見下方「手機語音輸入」），這樣助理走同源 `wss` 且麥克風可用。

**需要先啟動語音服務**（獨立於面板）：

```bash
python voice-assistant/start_assistant.py
```

或直接雙擊 `voice-assistant/start_assistant.bat`。管線是 VAD（Silero）→ STT（Whisper large-v3-turbo）→ LLM（Groq）→ TTS（Qwen3-TTS），除 LLM 外都在本機跑。首次啟動會下載模型權重，需要 NVIDIA 顯示卡與 CUDA 版 PyTorch（缺環境時腳本會印出建立步驟）。

**自訂音色**：把一段自己的錄音轉成 24kHz 單聲道 wav 放進 `voice-assistant/voices/`，改 `voice-assistant/start_assistant.py` 上方的 `REF_AUDIO` 即可。預設走 x-vector 聲紋模式，不需要提供逐字稿。`voice-assistant/voices/` 已 gitignore——聲音樣本不進版控。

> 只克隆你自己或已取得同意的聲音。未經同意複製他人（尤其是公眾人物）的聲音在許多地區有法律風險。

---

## 對嘴數字人（LiveTalking，女友陪聊）

上面的助理只有音量驅動的頭像。想要**嘴型真的對上聲音**的數字人陪聊，用 LiveTalking——它是**獨立的一套**，跟助理二選一開、不同時跑（會搶顯存）。

| 你要幹嘛 | 開哪個 | 有對嘴嗎 |
|---|---|---|
| 陪聊 | LiveTalking | ✅ |
| 叫助理操作面板生圖 | `voice-assistant/start_assistant.py` | ❌ 只有音量驅動頭像 |

Windows 雙擊即可（會自動啟動 Groq 多 key 代理）：

| bat | 說明 |
|---|---|
| `voice-assistant/start_livetalking_edge.bat` | EdgeTTS 雲端語音。**先用這個驗證**，啟動快、省顯存 |
| `voice-assistant/start_livetalking_qwen.bat` | 本地 Qwen3-TTS **你的克隆音色**，全在本機跑 |

啟動後開 `http://127.0.0.1:8010/index.html`，按「開始連接」，在文字框打字送出即可。本地音色模式**第一次連線要等約 16 秒**載入並預熱模型（之後合成比即時快約 3 倍）。

環境與模型的完整搭建步驟、實測數字與已知問題見 [LiveTalking.md](voice-assistant/LiveTalking.md)。LiveTalking 是第三方 repo，我們的改動用 `python voice-assistant/livetalking_patch.py` 套用（冪等，上游更新後重跑即可還原）。

---

## 詞庫暗房（預覽圖產生器）

`darkroom/preview_ui.py` 是一個**獨立工具**（跟前端檔案、暗房的 Python「大腦」都收在 `darkroom/` 底下，2026-08 整理專案結構時把散在根目錄的暗房相關檔案全部併過去），用來幫 `special_prompts` 的每個詞庫透過 ComfyUI 生成 `.webp` 預覽圖（也就是 Illustrious 詞庫選單 hover 顯示的那些圖）。深色「暗房」介面：左側資料夾導覽（含覆蓋率條，最上面釘一顆**「全部」**跨資料夾看完整詞庫，不用重打搜尋字串就能從單一資料夾回到全部範圍）、縮圖牆、點圖看大圖與正/負向 prompt、單張或**批次**補齊缺圖／重生、資料夾／缺圖／已有／名稱篩選。

- **18+ 年齡確認**：暗房是成人向詞庫工具，**任何畫面（含 boot 沖洗動畫）出現之前**都會先看到一個近黑底、紅色警示配色的年齡確認視窗（「你已年滿 18 歲了嗎？」），要點「已滿 18 歲」才會繼續往下走。確認記錄在 `sessionStorage`，**同一次瀏覽階段（分頁/瀏覽器沒關過）只問一次**——一般重整、硬重整（Ctrl+F5）都不會再問；分頁或瀏覽器關掉後回來要重新確認。點「離開」會原地把卡片內容換成拒絕文字，不會載入任何資料。
- **介紹頁 `/intro`**：獨立的產品門面，同一個暗房 port（預設 `http://localhost:7860/intro`）。先過 18+ 年齡確認。頂列是浮起來的膠囊導覽。摺上是左右兩欄：左邊一句「先看這張紙」加真實統計，右邊是印樣瀑布。往下是四個 16:9 小框，各自用這份詞庫的真縮圖演示瀏覽／打標／生圖／抽卡（抽卡是暗房同一套落紙再顯影，捲出畫面會暫停）。再往下是一張藥液流程單（開／換夾／別把埠對公網開放）。最底下「進去才算數」。「進入暗房」連回 `/`。HTML/CSS/JS 重整即生效。
- **進場畫面「印樣瀑布」**：每次打開（或重整）暗房都會先看到——整片詞庫的**接觸印樣鋪滿畫面**（8 欄 × 8 列，隨機抽自你自己的詞庫圖），滿版不減光，而且**一直往下流**。每一欄有自己的速度（約每秒 50～70 像素）與起始位置，所以看起來是好幾道各流各的水，不是一張大圖在平移。畫面正中央浮著一張**液態玻璃卡片**（背景模糊透光、邊緣有一圈高光、蘋果那種連續曲率的圓角）。卡片由上到下是四層：目前操作的**詞庫資料夾**（兩個 bat 開同一個 port 但指不同資料夾，這行進門前就能分辨）、題字、這個工具的三個模式（瀏覽 · 打標 · 生圖），再來是三個真數字（詞庫總數 / 資料夾數 / 已顯影比例）。按「進入暗房」、`Enter` 或 `Esc` 收起。玻璃卡下方有「介紹」連到 `/intro`。
  **圖不會突然蹦出來**：載入畫面會多轉一下、等印樣鋪到過半才收（最多等 2.2 秒），收起之後每一格再**各自錯開時間淡入**（像顯影一樣陸續浮現），不是一次全部出現。
  技術上是**單一全螢幕片段著色器**（原生 WebGL，沒有用 three.js 之類的函式庫，也不需要額外安裝任何東西）：64 張縮圖畫進一張 atlas 圖，捲動只是著色器裡的座標運算，沒有任何圖層在搬移，所以不會有縮圖動畫常見的閃爍。縮圖尺寸會依你的視窗寬度自動挑（128／192／256），確保是「顯示多大就送多大」。**顯示卡不支援 WebGL 時會自動退回** DOM 版本（同樣的欄式瀑布與淡入，改用 CSS 動畫），畫面不會開天窗；開啟系統「減少動態效果」時也走這個退化版、但靜止不動。進場關閉時會釋放顯示卡資源，不會留著佔用。
- **啟動**：跑 `darkroom/preview_ui.bat`（或 `python darkroom/preview_ui.py`），預設開在 `http://localhost:7860/`。要真的生成圖需先開 ComfyUI。詞庫很多時開頁/重整要幾秒（掃描＋渲染），會先顯示一個**科技感載入畫面**（相機光圈 logo 自轉＋掃描光弧＋掃描進度條），載入完自動淡出。頁面品牌與分頁圖示（favicon）都用**相機光圈**當 logo。**iPhone Safari**：頂列改成標題／搜尋／工具三層、卡片兩欄、資料夾從左側滑出；避開劉海與 Home 條，對焦搜尋框不會整頁放大。
- **大圖的橫向卡片列**：點縮圖開的大圖，圖片是**一列滿版的正方形卡片**（詞庫預覽都是 1:1，不會有黑邊或留白），鄰卡整張在畫面外、平常看不到。按 `←`／`→`（或大圖左右的 `‹` `›` 鈕）整列滑一格、緩動吸附回中央，**走到清單頭尾會無縫接回另一端**，不會停住。連按不會一頓一頓，會從目前滑到一半的位置接下去。鄰卡用的是格線已經載過的縮圖（等於免費），中央那張才載全解析度並淡入疊上去，所以換張時不會先閃一格空白。**大圖會記得自己是從哪份清單開的**，左右切就走那一份：格線縮圖 → 目前篩選出來的詞庫、圖庫縮圖 → 整個圖庫（只算生完的）、**抽卡 → 那批牌**（抽八張時可以直接一路往下看完，`Esc` 一樣回到牌面）。圖庫與抽卡的大圖也都是同一套卡片列，左右鈕跟方向鍵走同一個入口。
- **面板按鈕**：主面板頂部「AI Assistant」旁有「**詞庫暗房**」按鈕，點了用新視窗開這個工具（不嵌入面板）。工具沒啟動的話新視窗會連不上——先跑 `darkroom/preview_ui.bat`。
- **設定**：機器相關路徑放 `darkroom/preview_config.json`（已 gitignore，複製 `darkroom/preview_config.example.json` 來改）——`special_dir`（詞庫資料夾，預設指向 `C:\projects\special_prompts`）、`comfy`、`workflow`、`port` 等。**面板的詞庫選單（`serve.py`）也讀同一個 `special_dir`**（從 `darkroom/preview_config.json` 讀），所以兩邊看的是同一份詞庫。
- **兩份詞庫別搞混**：`darkroom/preview_ui.bat`（`special_prompts`）與 `darkroom/preview_ui_animebot.bat`（`animebot\special_prompts`）**共用同一個 port 7860、一次只能開一個**。改名等操作在後端就被限制在啟動時的 `special_dir` 內、**動不到另一份**；但兩個頁面長得一樣，所以頂列會顯示**目前操作的資料夾**（如 `animebot/special_prompts`），切換 bat 時看一眼就知道現在是哪份。
- **重整不用重新下載**：面板與暗房的前端檔案、詞庫／LoRA 清單、`/object_info` 都會快取——第一次載入照常，之後重整只需要幾 KB（實測：面板 3.65MB → 3.7KB、暗房 1.95MB → 3.8KB）。靜態檔也會 gzip（`app.js` 147KB → 49KB、`three.min.js` 601KB → 154KB、`workflow.json` 352KB → 28KB）。**改了 JS/CSS 之後重整一樣立刻生效**，不用清快取。
- **縮圖不用等**：開機時背景會把整份詞庫與 LoRA 預覽的縮圖先跑過一輪存進 `darkroom/.thumb_cache/`，之後不管本機還是手機遠端連，第一次點開都是暖快取（幾毫秒）。暖快取跑在**低優先權**，開機那幾分鐘你自己點進去要看的那張永遠排在它前面，不用等它跑完。生成／重新生成／批次補圖產生的新圖也會在生成完成當下順手把縮圖做好，不會留給「第一個看到它的人」現場等。
- **圖片與影片端點支援續傳（HTTP Range）**：`/api/thumb`、`/api/image`、`/api/lora-preview`、`/api/gen-preview`、`/api/gen-result` 都會回應 `Range` 請求（206 Partial Content，含「讀檔尾」的 `bytes=-N` 形式）。影響到的是**影片播放器**：LoRA 的 `.mp4/.webm` 預覽片如果不是 faststart 編碼（metadata 在檔尾），播放器一定要能先讀檔尾才播得起來，以前一律回整包會讓它卡在載入中；行動端 App 也不必再「整支下載完才交給播放器」。一般瀏覽行為完全不變。
- **「重掃」鈕的用途**：詞庫清單在伺服器端有快取，開頁／重整都直接吃快取（秒回）。**在暗房外面新增或刪除詞庫檔之後，按「重掃」才會看到**（重掃是唯一會重走檔案系統的操作，約 1 秒）。快取超過 60 秒會自動在背景更新，不會擋住畫面；用暗房自己生成的圖則是立刻反映，不用重掃。
- **收藏**：每張縮圖右上角有**星號**，點一下就收藏（金色實心星常駐）、再點取消。桌面平常藏起、hover 卡片才浮現，已收藏的則一直亮著。收藏清單存後端 `darkroom/favorites.json`（已 gitignore，跟品質旗標 `darkroom/flags.json` 同一套機制），只記錄、不影響抽卡與顯示。
- **稀有度**：四個等級——`普通版`（灰、無光環）、`稀有版`（黃光）、`特別版`（藍光）、`傳奇版`（彩色循環光暈）。存**側檔** `darkroom/.darkroom_meta/rarities.<dataset>.json`（不改檔名，見打標頁一節），**格線**顯示對應顏色的光暈＋角標；**抽卡**只留邊框色（傳奇再加一道只播一次的金屬光，沒有彩虹迴圈）。舊版寫在檔名前綴（`傳奇版xxx.py`）的檔案仍會被辨識、顯示名稱自動去掉前綴。
- **稀有度分布條**：覆蓋率條下方一排晶片，顯示目前資料夾／搜尋範圍內各等級的數量（全部／未標／普通／稀有／特別／傳奇，帶色點），點一下只看該等級、再點「全部」清除。暗房與打標頁都有；切資料夾時數字即時更新，是分布概覽也是篩選。
- **卡片評分**：每張卡片跑三個 waifu-score 模型（Blackroot／Waifu Scorer／Kawai）算出加權總分（`Blackroot×0.40 + Waifu×0.40 + Kawai×0.20`，正規化到 0~10），顯示在縮圖左下角小徽章（抽卡牌面也有），6.5~7.5 分自動加淺藍光環、≥7.5 分加淺紫光環，一眼認出高分卡片，hover/點擊看三項原始分數明細。**需要另外啟動 waifu-score 服務**（`C:\projects\waifu-score\run.bat`，預設 port 8000）——沒開的話卡片就是沒分數，不影響暗房其他功能。瀏覽模式生成/重新生成的分數會永久保存；抽卡／生圖模式產生的圖只是暫存結果，分數也只是暫時的，不會留到重整之後。topbar「☆ 評分」鈕可以幫已有圖但還沒評分的舊卡片一次補齊（也可以用 `darkroom/backfill_scores.py` 跑，適合大批量離峰時間執行），補分過程中卡片分數是評一張就即時更新一張，不用等整輪跑完；瀏覽模式生成/重新生成完成後也會在幾秒內自動補上分數徽章，都不用手動重整頁面。點開任一張卡片或抽卡結果的大圖，也能看到三個模型的原始分數，加權總分依分數區間上色（≥7.5 綠、5.5~7.5 黃、<5.5 紅）。稀有度分布條旁邊也有評分分布晶片（<4／4~7／≥7／≥8 分），點一下依分數篩選，可以跟稀有度篩選同時套用。
- **卡片聚光＋傳奇火花**（參考 Aceternity、以 vanilla 重現）：滑鼠移到縮圖上會有一圈**跟著游標的琥珀柔光**；格線上的**傳奇**卡會多一層**閃爍火花**點綴（抽卡相紙不加火花）。
- **本分類抽卡**（瀏覽／生圖模式）：分類標題（`01 甲夾`這種）旁邊有一顆小小的「✦」鈕，或直接按鍵盤 **`E`**，抽卡池會換成**目前選中的分類**（跨資料夾搜尋時換成**搜尋結果範圍**），而不是整個詞庫——想讓抽卡集中在某個分類裡隨機看/生時用這個。抽到的標題會標出分類名（例：`01_甲夾　抽選八張`），一眼看出跟全庫抽卡（`R`）不一樣；牌疊開著時 `E` 原地重抽本分類、`R` 改抽全庫，兩者互不影響。打標模式沒有這顆鈕（打標有自己一套 R/S/Z 抽卡打標流程）。
- **瀏覽/打標模式切換**：暗房與打標**合併成同一頁**，頂列有「✦ 瀏覽 · 🏷 打標」分段切換，切模式是**頁內瞬間切換、不換頁**——共用按鈕（切換鈕/抽卡/重掃/連線）位置固定不位移、覆蓋率條兩模式都在所以圖片不上下跳，只有各自的控制項柔和交叉淡入。切模式用同文件 View Transitions。頁內**切資料夾、稀有度篩選、缺圖/已有篩選、搜尋**時，只有格線交叉淡入（較快、220ms），不再硬切。**點縮圖開大圖**時，縮圖會**平滑放大**成大圖（shared-element morph）、關閉時縮回原位；抽卡／LoRA 面板／設定／快捷鍵關閉時淡出，關過再開不會只剩霧面。批次等確認對話框會蓋在所有面板之上。頂列／晶片等短按鈕按下會微縮一下當回饋，搜尋框聚焦時有琥珀色光暈。卡片捲進視野時依序淡入上升（小 stagger 串成瀑布），滑鼠移上去浮起一點、移開時收得比浮起來更快。動效與主面板同一套 token；開啟系統「減少動態效果」時自動關閉、直接切。

  詞庫很大時（跨資料夾／「全部」視圖是**全部近 28000 筆**）介面仍然順：`rel` 查表、搜尋用的小寫鍵、資料夾統計與篩選範圍都有索引或快取，滑鼠移動的聚光／傾斜效果也做了每幀節流，不會每動一下就重算版面。

  **圓角是 Apple 那種「連續曲率」**（squircle）：一般網頁的圓角是正圓弧，直邊接進圓弧的地方曲率會突然改變，看得出兩個接點；暗房用 CSS 的 `corner-shape: squircle`（超橢圓，跟 iOS app icon、SwiftUI `.continuous` 同一種形狀），曲率漸進變化、角落與直邊融成一條線。卡片、面板、按鈕、輸入框全部套用；**圓點與膠囊維持原本的正圓**（Apple 自己也是這樣分）。舊版瀏覽器不支援時自動退回一般圓角，不影響使用。

  **版面不會因為捲軸出現就跳動**：切資料夾時（有的一頁裝得下、有的要捲）卡片牆維持同樣的欄數，左欄資料夾與大圖 modal 也一樣，捲軸的位置永遠預留著。**在大圖、LoRA 面板、快捷鍵等疊層裡捲動，捲到底不會帶動背後的卡片牆**。
- **標籤搜尋**：頂列「搜尋名稱」旁邊有一個獨立的「搜尋標籤」框，輸入逗號分隔的多個標籤（例：`loli, 教室`）搜正向/負向/必要標籤裡**同時含有全部標籤**的詞庫，**跨資料夾**（不受目前選的資料夾限制，點任一資料夾會清掉標籤搜尋回到該資料夾）。詞庫檔案裡同一組標籤有時寫成獨立元素、有時整串塞一個字串（`"A,B,C"`／`"A, B, C,"`／`"A,B, C,"` 格式都有人寫過），比對前會統一再拆一次逗號、去空白，不管原始寫法為何都能命中。首次搜尋要等後端建索引（掃全部詞庫檔案，約幾秒），之後有 60 秒快取、近乎秒回；期間新增/修改詞庫檔案要等快取過期或重新搜尋才會反映。

### 生圖模式（頂列切「🎨 生圖」）

用**詞庫 + LoRA** 生圖來試效果的模式，跟瀏覽/打標**在同一頁**（頂列「✦ 瀏覽 · 🏷 打標 · 🎨 生圖」切換）。

- **多選詞庫**：點縮圖多選（跟打標一樣，可全選/清除）。
- **選 LoRA（大面板）**：topbar 那顆印著 **LoRA Manager logo** 的鈕（**只在生圖模式顯示**，位置緊接在「🖼 圖庫」右邊）或 genbar 同樣印著 logo 的「選 LoRA」摘要鈕都會開同一個**置中大面板**——左欄**資料夾分類晶片**（全部／各分類＋張數，先粗篩）＋搜尋（再細篩）＋**翻頁**（每頁 80 個，總數上百不會卡也不會截斷丟資料，清單可正常滾動）＋預覽縮圖清單（縮圖直接放大顯示在列上，不用 hover 才跳一張大圖；**選中的那列會有左側琥珀色細條**常駐標示，跟單純滑鼠移過去的效果分得清楚）；右欄是選中 LoRA 的**每段觸發詞各自一張完整文字卡**（**不截斷**，長的段落也整段讀得完，一眼看懂哪段在講什麼）＋勾選要用哪幾段＋強度滑桿＋**放大版參考圖**（在強度滑桿下方，完整顯示不裁切，不用另外點開或 hover）。**搜尋依相關度排序**：名稱／標題有命中的排前面，只靠觸發詞命中的排後面，不會把名稱完全不相關的結果混在前面。**預覽支援圖片與影片**（`.png/.jpg/.jpeg/.webp` 或 `.mp4/.webm`，含 `.preview.*` 命名），影片自動靜音循環播放，大預覽額外有播放控制列。**觸發詞卡 hover 顯示中文翻譯**（滑鼠移到某段文字卡跳出淡入的提示框，用 Google 翻譯免費端點即時翻譯、不用設定 API key，有快取存在瀏覽器 `localStorage`，同一段文字第二次 hover 不會再打 API）。選一個 LoRA 時，縮圖/標題→每段觸發詞卡（小 stagger 依序浮現）→強度／參考圖 依序淡入，讀起來有層次而不是整塊瞬間換掉；清單本身翻頁/篩選/搜尋切換也有淡入。選擇即時生效，關閉（✕／Esc／點背景）只是收起檢視。右欄選中的 LoRA 標題旁有一顆帶 **LoRA Manager logo** 的「詳情」小連結，開新分頁**直接跳到那個 LoRA 在 LoRA Manager 的完整詳情頁**（civitai 資訊、範例圖、備註…）——LoRA Manager 原生沒有這種深連結，是這個專案在 vendor 進來的 `lora-manager/static/js/loras.js` 加的小功能（讀網址 `?open=` 參數自動開對應詳情，見 `lora-manager/VENDORED.md`）；找不到就留在列表頁彈提示，不會卡住。「詳情」旁邊還有一顆**基礎模型標籤**（Illustrious／Pony／SDXL 1.0…），資料直接讀 `.metadata.json`（LoRA Manager 掃描時寫入的頂層 `base_model` 欄位），沒有就不顯示。LoRA 清單/預覽由 `darkroom/preview_ui.py` 直接讀 ComfyUI 的 `loras` 資料夾（同 `serve.py` 的路徑，`LORA_ROOT` 可覆寫）。左欄清單下方有一顆帶 **LoRA Manager logo** 的「用 LoRA Manager 管理」連結，開新分頁跳去更完整的管理工具（見下方「LoRA Manager」一節）；在那邊點「送到 workflow」會自動推進回這個面板、選好 LoRA。左欄分類晶片下方有「🎲 隨機瀏覽」，沿用**詞庫抽卡同一套落紙／顯影**改抽 LoRA（桌面 8 張、手機 1 張），疊在大面板之上、大面板保持開著；點任一張直接選中並返回、`R` 重抽一批、`Esc` 只關掉這個疊層（不會連帶關掉大面板）。
- **生圖**：點「🎨 生圖」→ 對每個選中詞庫，用其正/負向 +（選的）LoRA 觸發詞、**注入一個 LoraLoader** 到暗房工作流（底模預設 `waiIllustriousSDXL_v170`，可在「⚙ LoRA 抽取設定」換成別顆，見下方「底模選擇」）送 ComfyUI 生成。
- **替換詞**：genbar「選 LoRA」鈕旁邊的「替換詞」鈕，把 positive 裡**整個標籤完全相符**的詞換成別的字（不分大小寫，不是子字串比對），例如 `milf → cute girl`。每條規則可設**權重**（不等於 1 時自動包成 ComfyUI 的 `(替換成:權重)` 格式，權重恰好 1 就不加括號），**替換成留空 = 直接刪掉這個標籤**；替換成裡若剛好打了字面括號會自動跳脫（`\(` `\)`），不會弄壞權重語法。同一批規則裡啟用中的不能有重複原詞（存檔前會擋下並提示）。**只套用在正向，負向不動**，生圖與抽卡（含 Concepts 抽卡）共用同一套替換邏輯，一次設定兩邊都生效。面板會即時顯示套用在**目前選取的第一個詞庫**上的前後對照，送出前先看得到「真的會變成這樣」。每列改動即時存檔（跟 LoRA 大面板同一套慣例），有規則啟用時 genbar 會常駐一顆摘要 chip 提醒你目前開著替換。規則依 `special_dir` 分檔存放（`darkroom/.darkroom_meta/replacements.<dataset>.json`，已 gitignore），兩份詞庫（`preview_ui.bat`／`preview_ui_animebot.bat`）的替換規則互不影響。
- **底模選擇**：「⚙ LoRA 抽取設定」彈窗的「一般」分頁有一個底模下拉選單，只列 `illurtrious` 資料夾底下的 Illustrious 系 checkpoint（跟現有 LoRA 相容），選擇立即生效並寫回設定檔（重啟也記得）。**只影響生圖模式**（手動生圖／塔羅抽卡／agent-draw），瀏覽模式的「重新生成」單張詞庫縮圖不受影響、一律用 workflow.json 原本內建的底模。
- **抽卡動效（暗房顯影）**：五種抽卡共用同一個疊層。先全黑、放大機點燈，相紙**一張接一張**落入光裡（略帶旋轉、約 64px），落地時正方形上是暗房光圈 logo，不是空白。每張落地後才輪到自己顯影，光圈淡出、圖片密度長出來；名稱落地就出現所以順序讀得出來。傳奇只掃一道金屬光。生圖完成前停在光圈＋淡預覽，成品到位才壓密度。開啟系統「減少動態效果」時跳過整段、直接出圖。
- **抽卡生圖**：先選好 LoRA，點「✦ 抽卡」→ 從**全分類**（不限目前資料夾/搜尋範圍）**隨機抽 8 個詞庫**（手機一張），用上面那套顯影呈現，每張牌面**即時顯示生成中的採樣畫面**、生完換成成品；點卡片看大圖（大圖疊在牌上，關掉回到那批牌、不會消失），`R` 重抽新的一批來生。分類標題旁的「✦」鈕／按 `E` 則是**只抽目前分類的詞庫來生**，同樣的顯影呈現。
- **鍵盤 `R`／`E` 抽卡**：任何模式下（焦點不在輸入框、未開大圖/抽卡浮層時）按 `R` 直接抽卡（全庫）——依目前模式：瀏覽=看圖、打標=逐張標、生圖=抽詞庫來生。瀏覽／生圖模式下按 `E` 則改成**只抽目前選中的分類**（或搜尋結果範圍）。**生圖模式套用的 LoRA1/LoRA2（含手動點「生成」）** 跟 Concepts 疊層裡的 R/E 判斷邏輯完全一樣：已跳過的格子當它不存在、固定了 LoRA 就直接套用、只設了範圍晶片（沒固定）就從那個範圍隨機抽一顆——不再是「只認格子裡有沒有實際放一顆 LoRA」，設定彈窗「一般」分頁選了範圍、且那格是「參與判斷」，一樣會套用。兩格都跳過是正常情況（單純不套 LoRA 生圖），不會被擋下來。**只設範圍的那格，同一批裡每張圖各自重新隨機一次**（不是整批共用同一顆）——固定的那格則整批都是同一顆，不隨機。
- **Concepts 抽卡（快捷鍵 `C`／`R`／`E`）**：每張卡各自配一組 LoRA 直接生圖，判斷邏輯完全看設定彈窗齒輪 ⚙「一般」分頁的狀態，這個分頁是 LoRA1/LoRA2 的**全域控制面板**，跟 LoRA 大面板即時互相同步（固定的 LoRA、強度滑桿都是同一份狀態，改哪邊另一邊都跟著變；在「一般」按每格卡片的 ✕ 會連 LoRA 大面板一起清空）：
  - **LoRA1、LoRA2 各有一顆「參與判斷／已跳過」切換**（預設「已跳過」）——只有切成「參與判斷」的格子，Concepts 才會去看它放了什麼 LoRA、範圍晶片設什麼；預設跳過是為了讓「單純手動在 LoRA1/2 放 LoRA 做一般生圖」不會不小心也悄悄改變 Concepts 抽卡的結果。**在大面板選一顆 LoRA、或在「一般」點任一個範圍晶片，都會自動把那格切回「參與判斷」**，不用先手動切開關再回去選；「已跳過」狀態下範圍晶片跟已固定的 LoRA 卡片一樣看得到、點得動，只是整塊淡化提示「這格現在不算數」。
  - 每個「參與判斷」的格子照這個優先序決定套用哪顆 LoRA：①格子已經固定放著一顆 LoRA → 每張卡都鎖定用它（**不限分類**，放什麼就是什麼）②沒有固定 LoRA 但範圍晶片縮小了分類/子資料夾 → 每張卡在那個範圍內各自重新隨機。兩格都沒有「情境」（HENTAI/concepts 分類）訊號、且至少有一格還空著（已跳過）時，`C` 會自動幫那個空格補一顆全庫隨機 concepts；`R`／`E` 不會自動補，只照兩格現在的樣子字面套用。
  - 每格的 LoRA 強度就是「一般」分頁（或 LoRA 大面板）那格自己的強度滑桿——不再有另一組「角色/情境專用強度」，自動補位的那顆 concepts 也是沿用那個空格自己設定的強度。
  - **LoRA1／LoRA2 各自獨立記住自己的分類/子資料夾範圍晶片**，跟 LoRA 大面板左欄分類晶片雙向同步；哪格已經放了固定 LoRA，範圍晶片會自動換成顯示那顆 LoRA（含縮圖跟強度滑桿、滑鼠移上去有放大預覽、旁邊有 ✕ 可以直接清空這格）。
  - `C`／`R`／`E` 三鍵在 Concepts 疊層開著時分別對應：`C` 照上面「自動補位」的完整邏輯，模板池照設定彈窗「Concepts」分頁的兩個勾選（同時抽詞庫模板／只抽目前資料夾）；`R` 不補位、模板固定從全庫抽；`E` 不補位、模板固定限目前左欄選中的資料夾。三鍵套用的 LoRA 本身（固定/範圍隨機）邏輯完全一樣，差別只在「要不要補位」跟「模板池」。
  - 設定彈窗「一般」分頁有一顆「？ 詳細教學」，開一個完整說明上面這套判斷邏輯的疊層。
- **使用說明面板（`?` 鍵開關）**：topbar 有一顆「使用說明」鈕（或按 `?`）開啟疊層，分兩個分頁——「快捷鍵」列出全部鍵盤操作（含上面的 R/E、打標的 1-4/S/Z、Concepts 抽卡的 C），「功能總覽」則是滑鼠/UI 驅動、沒有鍵位可標的功能速查（收藏、稀有度標記、LoRA 大面板、雙 LoRA 疊加、生成步數輸入框、Concepts 抽卡、圖庫大圖資訊等），兩邊都是點一下切換、不用重新整理。
- **即時預覽**：後端用內建的**最小 WebSocket client**（純標準庫）連 ComfyUI，邊採樣邊把中途影像串到牌面（牌面先跑載入動畫、置中在方形圖區，預覽到就一步步變清晰）。前端每 **0.5s** 輪詢 `/api/gen-status`（自排程、跨批次共用一個輪詢），`pv`（預覽版本號）遞增才去抓 `/api/gen-preview`——所以預覽更新幾乎追上 ComfyUI 每步一幀的速度，同時 pv 沒變就不重載。**若你的 ComfyUI 沒開預覽**（未加 `--preview-method auto`）就不會有中途畫面、只跑載入動畫到出圖，功能仍正常。
- **生成圖庫（`🖼 圖庫`）**：生成的圖不進詞庫格線、不落地磁碟，而是集中到獨立的**「🖼 圖庫」**——按鈕在「✦瀏覽 · 🏷打標 · 🎨生圖」分段的**左邊**（分開、不混在一起）。點它把主區切成圖庫格線（本次生成、**新→舊**、切換交叉淡入；開啟圖庫時整批卡片依序淡入，之後在圖庫裡再生新圖只有**新卡**會進場，既有的圖不會跟著閃）；再點它或任一模式鈕切回詞庫。**手動生圖**（選詞庫→生圖）按下會自動切到圖庫、新圖在最上方邊生邊即時預覽；**抽卡**維持塔羅浮層，生成的圖同時進圖庫。點圖庫縮圖看**大圖＋資訊**（詞庫、資料夾、LoRA、強度、觸發詞、seed、生成時間）。**圖庫是本次生成的暫存**：前端只記在記憶體，**刷新／關頁就清空**（後端仍記憶體暫存供圖，`_GEN_MAX` 上限汰舊）。
- **各分頁獨立 · 刷新只停自己**：生圖是後端背景生成、由 ComfyUI 自己排隊。每個分頁載入時發一個 `client` id 帶給後端，**刷新/關閉分頁只會取消「這個分頁自己」在途的生圖**（還沒送出的不送、正在跑的請 ComfyUI 中斷），**別的分頁完全不受影響**照常跑完。並發上限由 `--concurrency`（預設 2）控制，只是別一次對 ComfyUI 開太多連線，排隊本身交給 ComfyUI。**單張生成/重新生成/抽卡會插隊到批次（補缺少／全部重生）前面**：批次佔滿名額時，手動點的單張生成不用等整批跑完，下一個空出來的名額會先給它，批次剩下的項目繼續排在後面。

### 打標模式（`/tag` 或頂列切「🏷 打標」）

大量標稀有度的模式，跟瀏覽/生成/生圖**在同一頁**——頂列「✦ 瀏覽 · 🏷 打標 · 🎨 生圖」切換即可，或直接開 `http://localhost:7860/tag`（自動進打標模式）。切模式是頁內瞬間切、不換頁、不位移。

稀有度共四級：**普通版／稀有版／特別版／傳奇版**（`普通版` 只有灰色角標、無光環，用途是「看過確認是普通、別再被抽到」）。

**稀有度存側檔、不改檔名**：標註寫進 `darkroom/.darkroom_meta/rarities.<dataset>.json`（跟品質旗標、收藏同一套機制），**不再動到 `.py` 檔名**。好處：即時生效、隨時可改可清、不會撞名、檔名保持乾淨（主面板詞庫選單不會出現前綴）。舊版把稀有度寫在檔名前綴（`傳奇版xxx.py`）的檔案**檔名不動、自動沿用**，之後在此頁改的以側檔為準。

**兩個 bat 各自獨立**：`darkroom/preview_ui.bat` 與 `darkroom/preview_ui_animebot.bat` 指向不同的 `special_dir`，側檔（旗標／收藏／稀有度）**依 special_dir 分檔**，兩份詞庫的標註互不干擾。

標註方式（**即時生效**，像收藏星號那樣，不需要確認步驟）：左側選資料夾、主區點縮圖多選（跨資料夾保留選取），下方點稀有度就**立刻**把選取的標成該級（含「移除標記」）；卡片馬上亮起對應光環／角標、選取清空可繼續下一批。

**抽卡打標（隨機散布在各分類）**：頂列「✦ 抽卡打標」一次抽 **10 張「有圖且尚未打標」**的（5 欄 × 2 列，同一套落紙顯影）。**全鍵盤操作**：方向鍵移動焦點卡、按 **1 普通・2 稀有・3 特別・4 傳奇**打標（**即時生效**、標完自動跳下一張沒標的）、**S 跳過**、**Z 復原上一步**、**R 重抽一批**、Esc 關閉；也可直接點卡片下方按鈕。標好的會亮起對應稀有度邊框（普通無），標**傳奇**時牌面掃一道金屬光。已打標（含普通版）下次不會再被抽到；關閉即可，不需要再按任何「改名」。

**打標覆蓋率**：打標頁左側資料夾列的進度條顯示各分類**已打標比例**（全部標完＝綠色滿格），頂列顯示**全域打標 %**；資料夾排序鈕可切「名稱↑／名稱↓／**未標多優先**」，一眼看出哪些分類還沒標完、優先去標。

改名會**連同旁邊的預覽圖 `.webp`／`.png` 一起改名**，並把該詞庫的旗標／收藏記錄遷到新檔名；重新標記會**替換**既有前綴而非疊加。

### 給外部 AI agent 用的抽卡 API

暗房本身沒有「抽卡」這個 API——瀏覽器裡的抽卡是前端自己從 `/api/libs` 的清單隨機挑幾筆再送生成。`darkroom/agent_draw.py` 是給**外部 AI agent**用的等價功能：

- **能跑 shell/python 的 agent**（例如 [Hermes](https://github.com/nousresearch/hermes-agent)）：直接 `python darkroom/agent_draw.py --n 8`，一次做完抽卡、送生成、等完成、把結果存到 `darkroom/agent_draws/`；加 `--json` 讓 stdout 印結構化結果方便 agent 解析。**Hermes 接在 Discord 上要另外注意**：它送圖片用的是夾在訊息文字裡的 `MEDIA:<絕對路徑>` 標籤，不是圖片網址，也沒有真正的 embed（title/image 這些結構化欄位）——完整說明跟可以直接貼給它的指令見 [darkroom/AGENT_DRAW.md](darkroom/AGENT_DRAW.md) 的「Hermes agent 專用」一節。想要真正的 Discord embed 卡片（標題＝系列＋詞庫名稱、LoRA 欄位、圖片），加 `--discord-dm`：直接用 bot token 打 Discord REST API 送 DM，繞過 agent 框架的訊息工具限制，見同份文件的「真正的 Discord embed」一節。
- **只能打 HTTP API（function calling）的 agent**：新增的 `POST /api/agent-draw` 端點把「隨機挑選」搬到伺服器端做，agent 只需要送一個小請求（`{"n": 8}`）換一個小回應（幾個 id），不用把 27000+ 筆詞庫的完整清單塞進自己的 context 才能挑。完整的三步驟呼叫順序（`/api/agent-draw` → 輪詢 `/api/gen-status` → `/api/gen-result` 取圖）見 [darkroom/AGENT_DRAW.md](darkroom/AGENT_DRAW.md)。

兩條路徑都預設套用同一顆畫風 LoRA（見 `preview_ui.py` 的 `AGENT_DRAW_DEFAULT_LORAS`，改完要重啟才生效），想不套 LoRA 就明確傳 `"loras": []`（CLI 是 `--no-lora`）。

⚠️ `preview_ui.py` 沒有任何身份驗證、預設監聽 `0.0.0.0`——agent 要跟暗房在同一台機器用，不要把這個埠對外網開放。

---

## LoRA Manager（完整的 LoRA 瀏覽／標記／下載工具）

`lora-manager/` 是 vendor 進來的第三方專案（[willmiao/ComfyUI-Lora-Manager](https://github.com/willmiao/ComfyUI-Lora-Manager)，GPLv3），比暗房的 LoRA 大面板更完整：搜尋、tag、CivitAI 抓 metadata／下載、找重複檔案、統計等。跑在**自己的獨立埠**（預設 **7861**），跟面板（7801）、暗房（7860）、ComfyUI（8188）都不衝突，可以同時開好幾個分頁。

- **啟動**：雙擊 `lora-manager/start_lora_manager.bat`（第一次會 `pip install` 幾個輕量套件如 aiohttp，之後很快），開啟 `http://localhost:7861/loras`。
- **跟 KLEIN／暗房共用同一份 LoRA 收藏**：啟動時會自動把設定檔的掃描路徑同步成 `LORA_ROOT` 環境變數（跟 `darkroom/preview_ui.py`、`serve.py` 用同一個變數、同一個預設值），看到的是同一批檔案，不用另外設定兩份。
- **「送到 workflow」改送去暗房與 KLEIN 面板**：這是**唯一被改過的功能**——原版的「送到 workflow」是靠同源 ComfyUI 網頁即時改 LiteGraph 節點，standalone 模式下這條路本來就走不通（只會跳一個沒用的警告）。改成點了**同時推給暗房與 KLEIN 主面板**（`serve.py` 的 `/panel/lora-push`）：哪邊分頁開著，哪邊就自動選中——暗房自動切到生圖模式、開大面板；KLEIN 面板自動切到 Illustrious 引擎、開啟 LoRA 開關、選進那個 LoRA，都不用手動找、不用複製貼上。沒開著的那邊下次打開輪詢照樣拿得到（單一格、最新一次覆蓋前一次，不排隊）。右鍵選單的「送到 workflow」也是同一套。
- 暗房的 LoRA 大面板裡也有一顆「🧰 用 LoRA Manager 管理」連結（含每顆 LoRA 旁的「詳情」深連結），開新分頁直接過去（互相連通）——連結網址跟著目前連暗房用的主機位址走（讀 `location.hostname`），不是寫死 `127.0.0.1`，所以手機/Tailscale 遠端連暗房時點過去也連得到同一台機器上的 LoRA Manager，不用手動改網址。
- 改了什麼、vendor 的細節見 [`lora-manager/VENDORED.md`](lora-manager/VENDORED.md)。其餘功能（CivitAI 下載、統計、recipes、checkpoint／embedding 管理⋯）都是上游原樣，沒有動。

---

## 手機語音輸入（HTTPS）

語音輸入需要麥克風權限，而瀏覽器只在「安全來源」給麥克風——桌面用 `localhost` 沒問題，但**手機透過 `http://100.x.x.x`（Tailscale）連都不算安全來源**，語音按鈕不會出現。要讓手機能用語音，改用 HTTPS 啟動：

面板**不放行區網 IP**（`192.168.x.x` / `10.x`）：沒有登入驗證，綁 `0.0.0.0` 只是為了讓 Tailscale 虛擬網卡收得到封包。手機請走 Tailscale IP 或本機。連線被拒時伺服器會印 `[拒絕] <ip>`。

```bash
python serve.py --https
```

Windows 可直接**雙擊 `start_https.bat`**（等同 `start.bat 127.0.0.1:8188 7801 https`）。

- 第一次會用 `openssl` 自動產生自簽憑證（`cert.pem` / `key.pem`，不進版控）
- 憑證 SAN 自動含本機區網 IP 與 Tailscale IP（換網路會重簽），但**連線白名單只放行本機與 Tailscale**；手機請開 `https://<Tailscale IP>:7801/klein`
- 第一次會跳「不安全」警告（自簽憑證正常現象），選「繼續前往」即可
- 換網路或 Tailscale 上線導致 IP 變動時，**憑證會自動重新產生**，不用手動刪
- Android Chrome 可用；**iOS Safari 對語音辨識支援不穩**，可能仍無法使用

> 若你用 Tailscale 且想**完全免除警告**：改用 `tailscale serve --https=443 http://127.0.0.1:7801`（需在 Tailscale 後台開啟 MagicDNS 與 HTTPS Certificates），它會用真憑證代理到面板，手機開 `https://<裝置>.<tailnet>.ts.net/klein` 就沒有任何警告。

---

## 手機上的操作差異

同一個網址在手機開，版面會自動換成手機版，不用另外設定。跟桌面比有這些不同：

- **頂部列收成兩行**——「AI Assistant」與「詞庫暗房」只剩圖示（長按會顯示名稱）、
  品牌只留 logo（目前是哪個引擎看下面那排切換器就知道）。
- **完成音效／桌面通知／即時預覽三個開關收在齒輪鈕 ⚙ 裡**，點一下展開、再點收起。
  這三個是設定一次就不再動的偏好，攤在外面會永久佔掉一行。
- **「生成」按鈕會黏在畫面底部**，捲到表單哪裡都按得到（Illustrious 把 LoRA、詞庫、
  增強全開時，表單長度超過兩個螢幕）。捲到結果區之後它才會跟著離開。
- **引擎切換器可以左右滑**，四個引擎放不下時往旁邊撥；切換後選中的那個會自動捲到中間。
- **轉成橫向**時頂部列會再收成一行，把高度讓給遮罩畫布與預覽圖。

若手機上看起來還是舊版面（例如頂部列仍是五行），是瀏覽器快取了舊的 CSS，**強制重新整理**
一次即可（iOS Safari：長按重新整理鈕 →「要求桌面版網站」再切回；或關掉分頁重開）。

---

## 運作原理

- **`serve.py` 同源反向代理** — 瀏覽器直接打 ComfyUI 會被 CORS 擋。`serve.py` 把靜態網頁與 API 變成同源，所有請求（`/prompt`、`/object_info`、`/upload/image`、`/view`、`/ws`）透明轉發到 ComfyUI。純 Python 標準函式庫，免安裝。本機靜態檔與 `/panel/*`（LoRA／詞庫縮圖）走 HTTP/1.1 keep-alive，一頁 80 張縮圖不必重開 80 次 TCP；轉發到 ComfyUI／Groq 串流仍關連線。

- **UI → API 轉換** — Flux2 Klein 的 `workflow.json` 是 ComfyUI UI 格式，`converter.js` 在瀏覽器內即時轉為 API 格式（重建 `graphToPrompt`）。其他引擎（Z-Image / Krea2 / Illustrious）的 JSON 本身就是 API 格式，直接注入欄位送出。

- **增強分支裁剪** — Krea2 和 Illustrious 的增強功能（放大、二次採樣等）透過開關控制：關閉時從 prompt 物件刪除該分支的所有節點，ComfyUI 就不會執行。

- **LoRA 清單端點** — `serve.py` 另外提供兩個面板專屬端點（不轉發給 ComfyUI）：`/panel/loras` 掃多個分類夾、回每個 LoRA 的所屬分類、觸發詞與預覽檔名；`/panel/lora-preview?folder=…&file=…` 送出預覽（圖或短片；分類須在白名單、擋目錄穿越）。掃描邏輯在根目錄 `lora_scan.py`，跟暗房共用同一份（副檔名表、`<lora:…>` 剝除、SWR 快取），避免兩邊各掃一次之後開始漂移。LoRA 根目錄可用環境變數 `LORA_ROOT` 覆寫。

- **詞庫端點** — 同樣是面板專屬（不轉發）：`/panel/prompts` 掃 `PROMPTS_ROOT`（`special_prompts`）的分類夾、回每個詞庫的分類/名稱/有無預覽；`/panel/prompt?cat=…&file=…` 用 `ast` 安全解析單一 `.py` 回三個 list；`/panel/prompt-preview?cat=…&file=…` 送 `.webp`。根目錄用 `PROMPTS_ROOT` 覆寫。

---

## 檔案結構

2026-08 整理過專案結構：根目錄只留 **KLEIN 面板本體**（最常用、最多東西依賴它），暗房、語音助理／LiveTalking、設計參考各自收進獨立資料夾。`serve.py`／`darkroom/preview_ui.py`／`voice-assistant/groq_proxy.py`(留根目錄) 之間有幾個共用檔案（`config.js`、`darkroom/preview_config.json`），拆資料夾時特別處理過路徑，見下方各表格附註。

### 根目錄（KLEIN 面板本體）

| 檔案 | 用途 |
|------|------|
| `serve.py` | 同源反向代理伺服器（面板、暗房、助理、LiveTalking 都經過它轉發） |
| `index.html` | 面板頁面 |
| `styles.css` | 樣式（繁體中文、淺色主題、各引擎主題色） |
| `app.js` | 主邏輯：表單、上傳、遮罩、WebSocket 進度、AI 優化 |
| `converter.js` | Flux2 Klein UI→API workflow 轉換器 |
| `workflow.json` | Flux2 Klein workflow（UI 格式） |
| `zimage.js` | Z-Image Turbo 引擎設定 |
| `zimage_t2i.json` | Z-Image 文生圖 workflow（API 格式） |
| `zimage_controlnet.json` | Z-Image ControlNet workflow（API 格式） |
| `krea2.js` | Krea2 引擎設定 |
| `krea2.json` | Krea2 workflow（API 格式） |
| `illustrious.js` | Illustrious SDXL 引擎設定 |
| `illustrious.json` | Illustrious workflow（API 格式） |
| `three.min.js` | Three.js r134（Vanta 依賴，vendored）。目前沒有被載入，見「動態背景」 |
| `vanta.fog.min.js` | Vanta.js FOG WebGL 背景（vendored）。同上 |
| `assets/avatar.webp` | AI 助理頭像（已 gitignore）。換圖用 `ffmpeg -i 新圖.png -c:v libwebp -quality 92 assets/avatar.webp`，PNG 直上會大十倍 |
| `config.js` | 本地設定（Groq API Key，不進版控）。**面板 AI 優化、`groq_proxy.py`、語音助理都讀這份**，所以留根目錄，沒有跟著語音助理搬進 `voice-assistant/` |
| `groq_proxy.py` | Groq 多 key 輪替代理（429 打到上限自動換下一把）。同時被面板 AI 優化與 `voice-assistant/` 的語音助理／LiveTalking 用，是三邊共用的檔案，所以留根目錄 |
| `lora_scan.py` | LoRA 清單掃描（副檔名、觸發詞剝標、SWR）。面板 `serve.py` 與暗房 `preview_ui.py` 共用，留根目錄 |
| `_test_convert.js` | 離線驗證 `converter.js` 的 UI→API 轉換，`node _test_convert.js` 從根目錄執行 |
| `start.bat` / `start_https.bat` | 啟動面板（後者走 HTTPS，手機麥克風要用） |
| `panel_funnel.bat` / `panel_funnel_off.bat` | Tailscale funnel 開關（讓面板能從外網連） |
| `stop_panel.bat` | 停掉 `serve.py` |
| `cert.pem` / `key.pem` / `cert.pem.san` | HTTPS 自簽憑證（已 gitignore，每台機器自己產） |

### `darkroom/`（詞庫暗房：獨立工具，自己一整套）

| 檔案 | 用途 |
|------|------|
| `preview_ui.py` | 暗房後端（靜態檔＋`/api/*`，見上節） |
| `generate_special_previews.py` | 暗房的 ComfyUI 生成邏輯（`preview_ui.py` 依賴，同目錄 sibling import） |
| `index.html` / `darkroom.css` / `darkroom.js` | 暗房前端（瀏覽/生成 ＋ 打標**合併成一頁**）。舊網址 `/tag` 保留，回同一頁並自動進打標模式 |
| `intro.html` / `intro.css` / `intro.js` | 產品門面（`/intro`）。年齡確認 + 印樣瀑布 + 四個動態小框（瀏覽／打標／生圖／抽卡）+ 藥液流程單，不載入整份詞庫 |
| `tokens.css` / `fonts/` | 介紹頁設計 token 與本機字型（Instrument Serif、Geist、IBM Plex Mono）。字型是 Latin-only 子集，中文走系統字；主應用 `darkroom.css` 也接了 Geist（介面）與 IBM Plex Mono（數字／標籤） |
| `preview_ui.bat` | 啟動詞庫暗房（`special_prompts`） |
| `preview_ui_animebot.bat` | 啟動詞庫暗房（改讀 `animebot\special_prompts`，同 port 一次只能開一個） |
| `multi_gpu_batch.py` / `multi_gpu_batch.bat` | **一次性**多 GPU 補缺圖工具，跟 `preview_ui.py` 分開、不是常駐服務。讀 `preview_config.json` 的 `comfy_endpoints` 清單（本機＋租的 GPU，例如 RunPod／vast.ai 的代理網址），每台開 `concurrency` 條 worker thread 搶同一份缺圖佇列，誰先做完誰先領下一張，天生照各自速度分配。`comfy_endpoints` 可以用 `https://帳號:密碼@主機` 這種帶認證的網址（vast.ai 對外 port 一律要 Basic Auth）。某台跑到一半斷線會自動把失敗的項目放回佇列給還活著的接手（最多重試 20 次），連續失敗 3 次就讓那台冷卻 90 秒（不是永久放棄——Cloudflare quick tunnel 這類偶爾自己斷線又自動重連的情況，冷卻時間到會自動恢復），不會卡住或錯殺項目。平常瀏覽/單張生成還是用 `preview_ui.bat`，這支只在需要一次補完一大批缺圖時跑 |
| `preview_config.example.json` | 暗房設定範本（複製成同目錄的 `preview_config.json`，後者已 gitignore）。**`serve.py` 也讀這份**（`darkroom/preview_config.json` 的 `special_dir`），兩邊詞庫選單同步。`comfy_endpoints` 欄位只給 `multi_gpu_batch.py` 用 |
| `.darkroom_meta/` | 依 dataset 分檔的旗標／收藏／稀有度側檔（已 gitignore） |
| `.thumb_cache/` | 縮圖快取（已 gitignore） |
| `flags.json` / `favorites.json` | 舊版共用檔，僅供首次遷移用（現行資料在 `.darkroom_meta/`，這兩份已是歷史遺留、不影響功能） |

### `lora-manager/`（vendor 的第三方 LoRA 管理工具，見上「LoRA Manager」一節）

| 檔案 | 用途 |
|------|------|
| （上游原始檔） | 整份 [ComfyUI-Lora-Manager](https://github.com/willmiao/ComfyUI-Lora-Manager) 原始碼，vendor 進來（無 `.git`，用 flux2klein 自己的版控） |
| `VENDORED.md` | 來源 commit、GPLv3 授權提醒、對照上游改了什麼（只動「送到 workflow」那條路） |
| `start_lora_manager.bat` | 啟動腳本（flux2klein 自己加的，不是上游帶的） |
| `write_settings.py` | 每次啟動前把 `settings.json` 的 `loras`／`checkpoints` 路徑同步成 `LORA_ROOT`／`CHECKPOINT_ROOT` 環境變數（flux2klein 自己加的） |
| `settings.json` | 本機設定（已 gitignore，由 `write_settings.py` 每次啟動自動產生／更新） |

### `voice-assistant/`（語音助理／LiveTalking 數字人）

| 檔案 | 用途 |
|------|------|
| `start_assistant.py` / `start_assistant.bat` | 啟動語音助理（見上「AI 助理」一節） |
| `LiveTalking.md` | LiveTalking 環境搭建、實測數字、已知問題 |
| `start_livetalking.bat` | LiveTalking 共用啟動腳本（`start_livetalking_edge.bat`／`start_livetalking_qwen.bat` 呼叫它） |
| `start_livetalking_edge.bat` / `start_livetalking_qwen.bat` | 兩種 TTS 模式的啟動捷徑 |
| `livetalking_patch.py` | 把 `livetalking/` 底下維護的原始檔套進外部 LiveTalking clone（冪等） |
| `livetalking/` | 我們維護的 LiveTalking 補丁原始檔（`llm.py`、`qwen3local.py`） |
| `patch_s2s.py` | 修補外部 `speech-to-speech`（s2s）套件，語音助理管線用 |
| `voices/` | 聲音克隆參考音檔（已 gitignore，屬個人生物特徵資料） |

### `design-ref/`（設計參考，非面板一部分）

| 檔案 | 用途 |
|------|------|
| `hero_demo.html` | 首頁視覺設計參考，獨立單檔用 `file://` 直接開，不進 `serve.py` 的 `STATIC_FILES` |
| `logo_options.html` | logo 設計選項比較頁 |
| `logo.png` | logo 原始圖檔 |

### `discord-bot/`（暗房 Discord 互動機器人，獨立工具）

獨立常駐的 Discord 機器人，讓使用者直接在 Discord 用 slash command（`/intro`／
`/lora`／`/chkp`／`/gacha`）操作暗房，不透過 AI agent 中介。跟 `darkroom/preview_ui.py`
完全分開的行程，只透過 HTTP 打它現有的 API，不 import `darkroom/` 底下任何檔案。
詳見 [discord-bot/README.md](discord-bot/README.md)。

| 檔案 | 用途 |
|------|------|
| `bot.py` | 主程式：slash command 定義與 `/gacha` 的逐張輪詢送圖邏輯 |
| `darkroom_client.py` | 打暗房 API 的 async 小工具（用 aiohttp，不阻塞 bot 的事件迴圈） |
| `config.example.json` | 設定範本（複製成同目錄的 `config.json`，已 gitignore） |
| `start_bot.bat` | Windows 啟動捷徑（等同 `python bot.py`） |
| `requirements.txt` | `discord.py`／`aiohttp` |

---

## 需要的 ComfyUI 節點 / 模型

### 自訂節點
- rgthree-comfy
- KJNodes
- ComfyUI-LayerStyle
- ComfyUI-Flux2（Flux2 Klein 相關節點）
- SeedVR2 Video Upscaler（放大功能）
- Ultimate SD Upscale（Illustrious SD 放大）
- ControlNet Aux Preprocessors（ControlNet 功能）

### 模型（依引擎）
- **Flux2 Klein**：`flux-2-klein-4b` 系列
- **Z-Image**：`pornmasterZImage_turboV35`、`redcraft HD`
- **Krea2**：`redcraft Krea2`
- **Illustrious**：`waiIllustriousSDXL_v170`
- **共用**：Qwen CLIP 編碼器、SeedVR2 模型、RealESRGAN 放大模型

---

## 疑難排解

| 問題 | 解法 |
|------|------|
| 右上角一直「未連線」 | 確認 ComfyUI 已啟動、位址正確 |
| 提交被拒 / node_errors | 模型檔名不符，確認已安裝對應模型與自訂節點 |
| 局部重繪沒效果 | 紅色塗抹區 = 重繪區域，先上傳圖片再塗抹 |
| 面板埠被占用 | `python serve.py 127.0.0.1:8188 8190` |
| AI 優化按鈕無反應 | 建立 `config.js` 並填入 Groq API Key |
| Illustrious 生成後沒成品 | 確認使用最新版 `illustrious.json`（輸出節點需為 SaveImage） |
| 手機看不到 🎤 語音鈕 | 手機需要 HTTPS：改用 `python serve.py --https`（見「手機語音輸入」） |

---

## 隱私
- 面板在本機與 ComfyUI 之間溝通，圖片和提示詞不會送到外部服務
- 例外一：AI 提示詞優化會將提示詞文字送到 Groq API（可選功能，不開就不送）
- 例外二：語音輸入使用 Chrome 內建 Web Speech API，語音音訊會送到 Google 伺服器辨識（不點 🎤 就不送）
