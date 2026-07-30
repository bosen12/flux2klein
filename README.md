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
