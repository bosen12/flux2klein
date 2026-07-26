# Flux2 Klein · ComfyUI 本地面板

一個可呼叫本地 ComfyUI 的網頁，內建**即時速度（it/s）與 ETA 顯示**、即時預覽縮圖、完成音效／通知。
把 `YZ金鱼-Flux2 Klein 超級多合一` 這份 workflow 包成好用的表單介面，支援 6 種模式：

| 模式 | 說明 |
|------|------|
| 文生圖 | 純文字生成，可設定尺寸／批次 |
| 單圖編輯 | 上傳 1 張圖 + 指令 |
| 雙圖編輯 | 上傳 2 張圖，提示詞用「圖1／圖2」指涉 |
| 三圖編輯 | 上傳 3 張圖，提示詞用「圖1／圖2／圖3」指涉 |
| 局部重繪 | 上傳圖片，用筆刷塗抹要重繪的區域 |
| 圖像擴展 | 往上下左右外補繪 |

> （原 workflow 的 SeedVR2 高清放大未納入本面板。）

---

## 怎麼跑

### 1. 先啟動你的 ComfyUI
照你平常的方式啟動即可，**不需要**加任何 `--enable-cors-header` 參數。
預設位址是 `127.0.0.1:8188`。

### 2. 啟動這個面板（同源反向代理）
在這個資料夾裡執行：

```bash
python serve.py
```

看到這行就成功了：

```
▶ 開啟瀏覽器： http://127.0.0.1:7801/klein
```

### 3. 打開瀏覽器
前往 **http://127.0.0.1:7801/klein** ，右上角顯示「已連線」即代表接上 ComfyUI。

---

## 自訂位址 / 埠

```bash
python serve.py 127.0.0.1:8188 7801     # ComfyUI位址  面板埠
python serve.py 192.168.1.50:8188       # ComfyUI 在另一台機器
python serve.py 127.0.0.1:8188 8190     # 面板改用 8190（7801 被占用時）
```

---

## 運作原理（重點）

- **為什麼要 `serve.py`？** 瀏覽器直接從網頁打 ComfyUI 會遇到 CORS 阻擋，WebSocket 也需要同源。
  `serve.py` 讓網頁與 API 變成同源：靜態網頁由它提供，其餘請求（`/prompt`、`/object_info`、
  `/upload/image`、`/view`、`/ws`）以原始位元組透明轉發到 ComfyUI，**零設定、不用改 ComfyUI 啟動參數**。
  只用 Python 標準函式庫，免安裝套件。

- **UI → API 轉換**：ComfyUI 的 `/prompt` 只吃 API 格式，而 `workflow.json` 是 UI 格式。
  `converter.js` 在瀏覽器內即時完成轉換（重建 ComfyUI 的 `graphToPrompt`）：
  依模式切換群組 bypass、穿透 Reroute／SetNode／GetNode／被 bypass 的節點、
  並把你的輸入（提示詞、圖片、種子、步數、尺寸、遮罩、擴圖邊界）注入對應節點。

- **即時進度**：透過 ComfyUI 的 WebSocket 取得每一步的 `progress`，
  換算成 it/s（或 s/it）與 ETA；二進位訊息即為即時預覽縮圖。

---

## 檔案

| 檔案 | 用途 |
|------|------|
| `serve.py` | 同源反向代理伺服器（啟動這個） |
| `index.html` | 面板頁面 |
| `styles.css` | 樣式（繁體中文、簡潔淺色） |
| `converter.js` | UI→API workflow 轉換器 + 各模式節點設定 |
| `app.js` | 主邏輯：表單、上傳、遮罩畫布、WebSocket 進度 |
| `workflow.json` | 你的 ComfyUI workflow（UI 格式） |
| `_test_convert.js` | 離線驗證轉換器（`node _test_convert.js`，不需 ComfyUI） |

---

## 疑難排解

- **右上角一直「未連線」** → 確認 ComfyUI 已啟動、位址正確（`python serve.py <host:port>`）。
- **提交後跳「提交被拒 / node_errors」** → 通常是模型檔名不符。這份 workflow 用
  `flux-2-klein-9b-fp8.safetensors` 等模型，請確認你的 ComfyUI 已安裝對應模型與自訂節點
  （rgthree、KJNodes、Comfyroll、LayerStyle、Flux2 相關節點）。
- **局部重繪沒效果** → 塗抹的紅色區域＝會被重新生成的區域；記得先上傳圖片再塗抹。
- **面板埠被占用** → 換一個埠：`python serve.py 127.0.0.1:8188 8190`。

---

## 注意
本面板只在你本機與你的 ComfyUI 之間溝通，不會把圖片或提示詞送到任何外部服務。
