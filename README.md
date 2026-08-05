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
- 77 token 上限，重要特徵放前面
- 支援 Negative prompt

---

## 功能特色

### 即時進度
- WebSocket 連線取得每步進度，顯示 it/s（或 s/it）與 ETA
- 分塊操作（如 Ultimate SD Upscale）進度條只進不退，顯示「第 N 塊」
- 二進位訊息即時預覽縮圖

### 前後對照
- 開啟增強（Hires / SeedVR2 / SD 放大）後，自動生成前後對照拉桿
- 點擊對照圖開啟全螢幕 overlay，支援滾輪縮放 + 拖曳平移 + 分隔線比較

### AI 提示詞優化
- 提示詞框右下角 hover 顯示 ✦ 按鈕
- 點擊後透過 Groq API（Llama 3.3 70B）串流優化提示詞
- 根據當前引擎自動切換 system prompt（自然語言 vs Danbooru tag）
- 需要設定 API Key（見下方）

### 語音輸入
- 提示詞框右下角 🎤 按鈕，點一下開始講、再點一下停止，辨識結果即時接在現有文字後面
- 使用瀏覽器內建的 Web Speech API（預設 zh-TW 中文），只在 **Chrome / Edge** 且**安全來源**（`localhost` 或 HTTPS）可用
- ⚠️ Chrome 的實作會把**語音音訊送到 Google 伺服器**辨識（見下方隱私說明）；不支援的瀏覽器會自動隱藏此按鈕
- 手機透過區網 IP（`http://192.168.x.x`）連線時，瀏覽器不會授予麥克風權限

### 增強分支
- Illustrious：Hires 二次採樣 / ControlNet / SeedVR2 放大 / SD 放大（可獨立開關）
- Krea2：SeedVR2 放大 / 二次採樣
- 放大可不經過二次採樣，直接從 base 輸出放大

### LoRA 風格（Illustrious 專用）
- 開關開啟後可從 ComfyUI 的多個 LoRA 分類夾（`style` / `Character` / `HENTAI` / `illus`）**單選**一個
- **分類 chip 列**（各帶數量）快速縮小範圍，搭配搜尋框跨全部搜（名稱／觸發詞）；LoRA 數百個也好找
- 可搜尋的縮圖清單，**滑鼠移到某個 LoRA 會浮出預覽圖**（讀該檔旁的同名圖，支援 `.preview.png/.jpeg/.jpg/.webp` 與 `.png/.jpg/.jpeg/.webp`，先命中先用），每頁 80 個、底部可**翻上一頁／下一頁**（切分類或搜尋會回第 1 頁）
- 一支 **0~1 強度滑桿**（預設 0.8），同時套用在 model 與 clip
- 自動把該 LoRA 的**觸發詞**（讀 `.metadata.json` 的 `trainedWords`）帶進一個
  **像提示詞的文字框**，可直接打字自由增刪（**只改面板這份、不動原始檔**），
  並用開關決定要不要把框裡的內容加進提示詞
- 送出時面板會即時插入一個 `LoraLoader` 節點、把 model/clip 從 checkpoint 改接到它（VAE 不受影響）

### 詞庫（Illustrious 專用）
- 從 `special_prompts` 的數十個分類夾**單選**一個情境詞庫（2000＋個），介面與 LoRA 選單同款（分類＋搜尋＋hover `.webp` 預覽＋每頁 80 分頁）
- 分類多（＞8）時自動**收合成一行**（「分類：目前 ▾」），點開才用高度動畫攤出完整 grid、選完自動收起；分類少（如 LoRA）維持平鋪。**展開後上方有「搜尋分類…」框**，打字即時篩選分類晶片（詞庫有上百個分類時，不用在一堆晶片裡找）——展開就自動聚焦、可直接打
- 選取後：把該詞庫的 `REQUIRED_POSITIVE + POSITIVE` 以逗號串接**填進正向提示詞框**（可再手動編輯），並記住它的 `NEGATIVE`
- 送出時自動把該詞庫的 `NEGATIVE` 寫進負向節點
- 後端用 `ast` **安全解析** `.py`（只取那三個 list，不 import、不執行）

### 動態背景
- 整頁 WebGL 流動彩霧背景（Vanta.js FOG），配色自動跟隨當前引擎主題色
- 函式庫（`three.min.js` + `vanta.fog.min.js`）**已 vendored 在專案內、離線可用**，不需另外安裝
- 尊重系統「減少動態」設定：開啟時自動退回靜態柔光背景；WebGL 不可用時也會 fallback，不會空白

---

## 快速開始

### 1. 啟動 ComfyUI
照平常方式啟動，**不需要**加 `--enable-cors-header`。預設位址 `127.0.0.1:8188`。

### 2. 設定 AI 提示詞優化（可選）
建立 `config.js`（已加入 .gitignore，不會被提交）：

```javascript
window.YZ_CONFIG = {
  GROQ_API_KEY: '你的 Groq API Key',
};
```

到 [console.groq.com](https://console.groq.com) 免費申請 API Key。

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
- **打字**：抽屜底部輸入框，Enter 送出。不需要麥克風、不需要 HTTPS，手機用區網 http 連也能用
- **語音**：按「開始聆聽」直接說話，可隨時插話打斷回覆

**手機使用**：助理的 WebSocket 走 `serve.py` 同源代理（`/assistant` → 本機語音服務 8765），所以手機連面板就連得到語音服務、打字直接可用。**語音**還需要麥克風權限，而麥克風只在安全來源給——手機得用 HTTPS 啟動面板（`python serve.py --https`，見下方「手機語音輸入」），這樣助理走同源 `wss` 且麥克風可用。

**需要先啟動語音服務**（獨立於面板）：

```bash
python start_assistant.py
```

管線是 VAD（Silero）→ STT（Whisper large-v3-turbo）→ LLM（Groq）→ TTS（Qwen3-TTS），除 LLM 外都在本機跑。首次啟動會下載模型權重，需要 NVIDIA 顯示卡與 CUDA 版 PyTorch（缺環境時腳本會印出建立步驟）。

**自訂音色**：把一段自己的錄音轉成 24kHz 單聲道 wav 放進 `voices/`，改 `start_assistant.py` 上方的 `REF_AUDIO` 即可。預設走 x-vector 聲紋模式，不需要提供逐字稿。`voices/` 已 gitignore——聲音樣本不進版控。

> 只克隆你自己或已取得同意的聲音。未經同意複製他人（尤其是公眾人物）的聲音在許多地區有法律風險。

---

## 對嘴數字人（LiveTalking，女友陪聊）

上面的助理只有音量驅動的頭像。想要**嘴型真的對上聲音**的數字人陪聊，用 LiveTalking——它是**獨立的一套**，跟助理二選一開、不同時跑（會搶顯存）。

| 你要幹嘛 | 開哪個 | 有對嘴嗎 |
|---|---|---|
| 陪聊 | LiveTalking | ✅ |
| 叫助理操作面板生圖 | `start_assistant.py` | ❌ 只有音量驅動頭像 |

Windows 雙擊即可（會自動啟動 Groq 多 key 代理）：

| bat | 說明 |
|---|---|
| `start_livetalking_edge.bat` | EdgeTTS 雲端語音。**先用這個驗證**，啟動快、省顯存 |
| `start_livetalking_qwen.bat` | 本地 Qwen3-TTS **你的克隆音色**，全在本機跑 |

啟動後開 `http://127.0.0.1:8010/index.html`，按「開始連接」，在文字框打字送出即可。本地音色模式**第一次連線要等約 16 秒**載入並預熱模型（之後合成比即時快約 3 倍）。

環境與模型的完整搭建步驟、實測數字與已知問題見 [LiveTalking.md](LiveTalking.md)。LiveTalking 是第三方 repo，我們的改動用 `python livetalking_patch.py` 套用（冪等，上游更新後重跑即可還原）。

---

## 詞庫暗房（預覽圖產生器）

`preview_ui.py` 是一個**獨立工具**，用來幫 `special_prompts` 的每個詞庫透過 ComfyUI 生成 `.webp` 預覽圖（也就是 Illustrious 詞庫選單 hover 顯示的那些圖）。深色「暗房」介面：左側資料夾導覽（含覆蓋率條）、縮圖牆、點圖看大圖與正/負向 prompt、單張或**批次**補齊缺圖／重生、資料夾／缺圖／已有／名稱篩選。

- **啟動**：跑 `preview_ui.bat`（或 `python preview_ui.py`），預設開在 `http://localhost:7860/`。要真的生成圖需先開 ComfyUI。詞庫很多時開頁/重整要幾秒（掃描＋渲染），會先顯示一個**科技感載入畫面**（相機光圈 logo 自轉＋掃描光弧＋掃描進度條），載入完自動淡出。頁面品牌與分頁圖示（favicon）都用**相機光圈**當 logo。
- **面板按鈕**：主面板頂部「AI Assistant」旁有「**詞庫暗房**」按鈕，點了用新視窗開這個工具（不嵌入面板）。工具沒啟動的話新視窗會連不上——先跑 `preview_ui.bat`。
- **設定**：機器相關路徑放 `preview_config.json`（已 gitignore，複製 `preview_config.example.json` 來改）——`special_dir`（詞庫資料夾，預設指向 `C:\projects\special_prompts`）、`comfy`、`workflow`、`port` 等。**面板的詞庫選單（`serve.py`）也讀同一個 `special_dir`**，所以兩邊看的是同一份詞庫。
- **兩份詞庫別搞混**：`preview_ui.bat`（`special_prompts`）與 `preview_ui_animebot.bat`（`animebot\special_prompts`）**共用同一個 port 7860、一次只能開一個**。改名等操作在後端就被限制在啟動時的 `special_dir` 內、**動不到另一份**；但兩個頁面長得一樣，所以頂列會顯示**目前操作的資料夾**（如 `animebot/special_prompts`），切換 bat 時看一眼就知道現在是哪份。
- **「重掃」鈕的用途**：詞庫清單在伺服器端有快取，開頁／重整都直接吃快取（秒回）。**在暗房外面新增或刪除詞庫檔之後，按「重掃」才會看到**（重掃是唯一會重走檔案系統的操作，約 1 秒）。快取超過 60 秒會自動在背景更新，不會擋住畫面；用暗房自己生成的圖則是立刻反映，不用重掃。
- **收藏**：每張縮圖右上角有**星號**，點一下就收藏（金色實心星常駐）、再點取消。桌面平常藏起、hover 卡片才浮現，已收藏的則一直亮著。收藏清單存後端 `favorites.json`（已 gitignore，跟品質旗標 `flags.json` 同一套機制），只記錄、不影響抽卡與顯示。
- **稀有度**：四個等級——`普通版`（灰、無光環）、`稀有版`（黃光）、`特別版`（藍光）、`傳奇版`（彩色循環光暈）。存**側檔** `.darkroom_meta/rarities.<dataset>.json`（不改檔名，見打標頁一節），格線與**抽卡**都會顯示對應顏色的光暈＋角標。舊版寫在檔名前綴（`傳奇版xxx.py`）的檔案仍會被辨識、顯示名稱自動去掉前綴。
- **稀有度分布條**：覆蓋率條下方一排晶片，顯示目前資料夾／搜尋範圍內各等級的數量（全部／未標／普通／稀有／特別／傳奇，帶色點），點一下只看該等級、再點「全部」清除。暗房與打標頁都有；切資料夾時數字即時更新，是分布概覽也是篩選。
- **卡片聚光＋傳奇火花**（參考 Aceternity、以 vanilla 重現）：滑鼠移到縮圖上會有一圈**跟著游標的琥珀柔光**；**傳奇**卡（格線與抽卡）會多一層**閃爍火花**點綴。
- **瀏覽/打標模式切換**：暗房與打標**合併成同一頁**，頂列有「✦ 瀏覽 · 🏷 打標」分段切換，切模式是**頁內瞬間切換、不換頁**——共用按鈕（切換鈕/抽卡/重掃/連線）位置固定不位移、覆蓋率條兩模式都在所以圖片不上下跳，只有各自的控制項柔和交叉淡入。切模式用同文件 View Transitions。頁內**切資料夾、稀有度篩選、缺圖/已有篩選、搜尋**時，只有格線交叉淡入（較快、220ms），不再硬切。**點縮圖開大圖**時，縮圖會**平滑放大**成大圖（shared-element morph）、關閉時縮回原位。動效與主面板同一套 token；開啟系統「減少動態效果」時自動關閉、直接切。

### 生圖模式（頂列切「🎨 生圖」）

用**詞庫 + LoRA** 生圖來試效果的模式，跟瀏覽/打標**在同一頁**（頂列「✦ 瀏覽 · 🏷 打標 · 🎨 生圖」切換）。

- **多選詞庫**：點縮圖多選（跟打標一樣，可全選/清除）。
- **選 LoRA**：底部「🎨 選 LoRA」開挑選器——可搜尋、有預覽縮圖，選一個；**強度**滑桿；LoRA 若有**多組觸發詞**會列成晶片可勾選要加哪組（沿用主面板那套）。LoRA 清單/預覽由 `preview_ui.py` 直接讀 ComfyUI 的 `loras` 資料夾（同 `serve.py` 的路徑，`LORA_ROOT` 可覆寫）。
- **生圖**：點「🎨 生圖」→ 對每個選中詞庫，用其正/負向 +（選的）LoRA 觸發詞、**注入一個 LoraLoader** 到暗房工作流（底模就是 `waiIllustriousSDXL_v170`，Illustrious LoRA 相容）送 ComfyUI 生成。
- **抽卡生圖**：先選好 LoRA，點「✦ 抽卡」→ 從目前資料夾/搜尋範圍**隨機抽 8 個詞庫**（手機一張），用**塔羅發牌動畫**呈現（跟瀏覽抽卡同一套），每張牌面**即時顯示生成中的採樣畫面**、生完換成成品；點卡片看大圖（大圖疊在牌上，關掉回到那批牌、不會消失），`R` 重抽新的一批來生。
- **即時預覽**：後端用內建的**最小 WebSocket client**（純標準庫）連 ComfyUI，邊採樣邊把中途影像串到牌面（牌面先轉圈、預覽到就一步步變清晰）。前端靠 `/api/gen-status` 的 `pv`（預覽版本號）遞增才去抓 `/api/gen-preview`，避免無謂重載。**若你的 ComfyUI 沒開預覽**（未加 `--preview-method auto`）就不會有中途畫面、只轉圈到出圖，功能仍正常。
- **結果區**：所有生成結果都同時進底部結果區（**累加**、新的在前，點「結果」開合、點縮圖看大圖）。**只在結果區顯示、存記憶體，不覆蓋詞庫的預覽圖**。
- **各分頁獨立 · 刷新只停自己**：生圖是後端背景生成、由 ComfyUI 自己排隊。每個分頁載入時發一個 `client` id 帶給後端，**刷新/關閉分頁只會取消「這個分頁自己」在途的生圖**（還沒送出的不送、正在跑的請 ComfyUI 中斷），**別的分頁完全不受影響**照常跑完進結果區。並發上限由 `--concurrency`（預設 2）控制，只是別一次對 ComfyUI 開太多連線，排隊本身交給 ComfyUI。

### 打標模式（`/tag` 或頂列切「🏷 打標」）

大量標稀有度的模式，跟瀏覽/生成/生圖**在同一頁**——頂列「✦ 瀏覽 · 🏷 打標 · 🎨 生圖」切換即可，或直接開 `http://localhost:7860/tag`（自動進打標模式）。切模式是頁內瞬間切、不換頁、不位移。

稀有度共四級：**普通版／稀有版／特別版／傳奇版**（`普通版` 只有灰色角標、無光環，用途是「看過確認是普通、別再被抽到」）。

**稀有度存側檔、不改檔名**：標註寫進 `.darkroom_meta/rarities.<dataset>.json`（跟品質旗標、收藏同一套機制），**不再動到 `.py` 檔名**。好處：即時生效、隨時可改可清、不會撞名、檔名保持乾淨（主面板詞庫選單不會出現前綴）。舊版把稀有度寫在檔名前綴（`傳奇版xxx.py`）的檔案**檔名不動、自動沿用**，之後在此頁改的以側檔為準。

**兩個 bat 各自獨立**：`preview_ui.bat` 與 `preview_ui_animebot.bat` 指向不同的 `special_dir`，側檔（旗標／收藏／稀有度）**依 special_dir 分檔**，兩份詞庫的標註互不干擾。

標註方式（**即時生效**，像收藏星號那樣，不需要確認步驟）：左側選資料夾、主區點縮圖多選（跨資料夾保留選取），下方點稀有度就**立刻**把選取的標成該級（含「移除標記」）；卡片馬上亮起對應光環／角標、選取清空可繼續下一批。

**抽卡打標（隨機散布在各分類）**：頂列「✦ 抽卡打標」一次抽 **15 張「有圖且尚未打標」**的（5 欄 × 3 列，塔羅式發牌翻牌，較快）。**全鍵盤操作**：方向鍵移動焦點卡、按 **1 普通・2 稀有・3 特別・4 傳奇**打標（**即時生效**、標完自動跳下一張沒標的）、**S 跳過**、**Z 復原上一步**、**R 重抽一批**、Esc 關閉；也可直接點卡片下方按鈕。標好的會亮起對應稀有度光環（普通無），標**傳奇**時牌面會有一下光爆特效。已打標（含普通版）下次不會再被抽到；關閉即可，不需要再按任何「改名」。

**打標覆蓋率**：打標頁左側資料夾列的進度條顯示各分類**已打標比例**（全部標完＝綠色滿格），頂列顯示**全域打標 %**；資料夾排序鈕可切「名稱↑／名稱↓／**未標多優先**」，一眼看出哪些分類還沒標完、優先去標。

改名會**連同旁邊的預覽圖 `.webp`／`.png` 一起改名**，並把該詞庫的旗標／收藏記錄遷到新檔名；重新標記會**替換**既有前綴而非疊加。

---

## 手機語音輸入（HTTPS）

語音輸入需要麥克風權限，而瀏覽器只在「安全來源」給麥克風——桌面用 `localhost` 沒問題，但**手機透過 `http://192.168.x.x` 或 `http://100.x.x.x`（Tailscale）連都不算安全來源**，語音按鈕不會出現。要讓手機能用語音，改用 HTTPS 啟動：

```bash
python serve.py --https
```

Windows 可直接**雙擊 `start_https.bat`**（等同 `start.bat 127.0.0.1:8188 7801 https`）。

- 第一次會用 `openssl` 自動產生自簽憑證（`cert.pem` / `key.pem`，不進版控）
- 憑證 SAN 自動含**區網 IP 與 Tailscale IP**，所以手機開 `https://<區網IP>:7801/klein` **或** `https://<Tailscale IP>:7801/klein` 都可以，不會憑證主機不符
- 第一次會跳「不安全」警告（自簽憑證正常現象），選「繼續前往」即可
- 換網路或 Tailscale 上線導致 IP 變動時，**憑證會自動重新產生**，不用手動刪
- Android Chrome 可用；**iOS Safari 對語音辨識支援不穩**，可能仍無法使用

> 若你用 Tailscale 且想**完全免除警告**：改用 `tailscale serve --https=443 http://127.0.0.1:7801`（需在 Tailscale 後台開啟 MagicDNS 與 HTTPS Certificates），它會用真憑證代理到面板，手機開 `https://<裝置>.<tailnet>.ts.net/klein` 就沒有任何警告。

---

## 運作原理

- **`serve.py` 同源反向代理** — 瀏覽器直接打 ComfyUI 會被 CORS 擋。`serve.py` 把靜態網頁與 API 變成同源，所有請求（`/prompt`、`/object_info`、`/upload/image`、`/view`、`/ws`）透明轉發到 ComfyUI。純 Python 標準函式庫，免安裝。

- **UI → API 轉換** — Flux2 Klein 的 `workflow.json` 是 ComfyUI UI 格式，`converter.js` 在瀏覽器內即時轉為 API 格式（重建 `graphToPrompt`）。其他引擎（Z-Image / Krea2 / Illustrious）的 JSON 本身就是 API 格式，直接注入欄位送出。

- **增強分支裁剪** — Krea2 和 Illustrious 的增強功能（放大、二次採樣等）透過開關控制：關閉時從 prompt 物件刪除該分支的所有節點，ComfyUI 就不會執行。

- **LoRA 清單端點** — `serve.py` 另外提供兩個面板專屬端點（不轉發給 ComfyUI）：`/panel/loras` 掃多個分類夾（`LORA_FOLDERS`）、回每個 LoRA 的所屬分類、觸發詞與預覽圖檔名；`/panel/lora-preview?folder=…&file=…` 送出預覽圖（分類須在白名單、擋目錄穿越）。LoRA 根目錄可用環境變數 `LORA_ROOT` 覆寫。

- **詞庫端點** — 同樣是面板專屬（不轉發）：`/panel/prompts` 掃 `PROMPTS_ROOT`（`special_prompts`）的分類夾、回每個詞庫的分類/名稱/有無預覽；`/panel/prompt?cat=…&file=…` 用 `ast` 安全解析單一 `.py` 回三個 list；`/panel/prompt-preview?cat=…&file=…` 送 `.webp`。根目錄用 `PROMPTS_ROOT` 覆寫。

---

## 檔案結構

| 檔案 | 用途 |
|------|------|
| `serve.py` | 同源反向代理伺服器 |
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
| `three.min.js` | Three.js r134（Vanta 依賴，vendored） |
| `vanta.fog.min.js` | Vanta.js FOG WebGL 背景（vendored） |
| `preview_ui.py` | 詞庫暗房：獨立工具的後端（供 `darkroom/` 靜態檔＋ `/api/*`，見上節） |
| `darkroom/` | 暗房前端（瀏覽/生成 ＋ 打標**合併成一頁**）：`index.html` / `darkroom.css` / `darkroom.js`。舊網址 `/tag` 保留，回同一頁並自動進打標模式 |
| `generate_special_previews.py` | 暗房的 ComfyUI 生成邏輯（`preview_ui.py` 依賴） |
| `preview_ui.bat` | 啟動詞庫暗房 |
| `preview_config.example.json` | 暗房設定範本（複製成 `preview_config.json`，後者已 gitignore） |
| `config.js` | 本地設定（API Key，不進版控） |

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
