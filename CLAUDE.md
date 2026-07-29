# CLAUDE.md

給 Claude Code 的專案指引。這份檔案記錄看程式碼不會立刻發現的事——架構上的關鍵差異、慣例、以及已經踩過的坑。

## 這是什麼

呼叫本機 ComfyUI 的網頁面板，支援四組繪圖引擎。**純前端 vanilla JS，沒有建置步驟、沒有框架、沒有 npm 依賴**；後端 `serve.py` 只用 Python 標準函式庫。改完存檔重整瀏覽器就生效，不要引入打包工具或前端框架。

## 怎麼跑與怎麼驗證

```bash
python serve.py                      # ComfyUI=127.0.0.1:8188, 面板=7801
python serve.py 127.0.0.1:8188 8190  # 自訂
```

Windows 上有 `start.bat` / `stop_panel.bat` 可用。

沒有測試框架。可用的驗證手段只有兩個：

```bash
node --check app.js        # 語法檢查（app.js 是瀏覽器 IIFE，不能直接 node 執行）
node _test_convert.js      # 離線驗證 Flux2 的 UI→API 轉換，不需要 ComfyUI
```

改完 JS/CSS 後，**要提醒使用者重整頁面**才會生效。

## 架構：兩種 workflow 格式（最重要的一件事）

ComfyUI 的 `/prompt` 只吃 API 格式，但從 ComfyUI 介面匯出的是 UI 格式。本專案兩種都有，處理路徑完全不同：

| 引擎 | 檔案 | 格式 | 送出路徑 |
|------|------|------|---------|
| Flux2 Klein | `workflow.json` | **UI 格式** | `runFlux2()` → `converter.js` 即時轉換 |
| Z-Image Turbo | `zimage_t2i.json` / `zimage_controlnet.json` | API 格式 | `runZImage()` 直接注入欄位 |
| Krea2 | `krea2.json` | API 格式 | `runEnhanceEngine()` |
| Illustrious | `illustrious.json` | API 格式 | `runEnhanceEngine()` |

API 格式的範本在啟動時一次 fetch 進 `state.zTemplates`，送出前 deep clone 再改，不要直接改到 `state.zTemplates`。

`converter.js` 重建了 ComfyUI 的 `graphToPrompt`：處理群組 bypass、穿透 Reroute / SetNode / GetNode。只有 Flux2 Klein 會用到它。

## 檔案職責

| 檔案 | 用途 |
|------|------|
| `serve.py` | 同源反向代理。靜態檔白名單以外的請求全部轉發給 ComfyUI |
| `app.js` | 主邏輯：表單、上傳、遮罩、WebSocket 進度、對照 overlay、AI 優化 |
| `converter.js` | Flux2 Klein 專用的 UI→API 轉換器 |
| `zimage.js` / `krea2.js` / `illustrious.js` | 各引擎設定：模型檔名、模式、節點對照、增強分支 |
| `config.js` | Groq API key。**已 gitignore**，不要提交，也不要把 key 寫回程式碼 |
| `styles.css` | 樣式。設計 token 在 `:root`，各引擎主題色用 `:root[data-engine="..."]` 覆寫 |
| `hero_demo.html` | **設計參考，不是面板的一部分。** 獨立單檔，用 `file://` 直接開；刻意不列入 `STATIC_FILES`，不要把它加進去 |

## 引擎設定的結構

`krea2.js` / `illustrious.js` 走「增強引擎」統一格式，由 `runEnhanceEngine()` 共用處理：

- `CKPT` / `UNET` / `CLIP` / `VAE` — 固定模型檔名，送出時注入對應節點
- `MODES[key].nodes` — 語意名稱到節點 ID 的對照（`prompt`、`ksampler`、`latent`…）
- `enhance[]` — 可開關的增強分支，每項有 `branch`（該分支的所有節點 ID）
- `alwaysDelete` — 一律移除的節點（例如 ComfyUI 內建的比較節點，面板自己做對照）
- `outputs` / `compareLabels` — 輸出節點對照表，供前後對照與結果角標使用

**增強分支的運作方式是「關閉時從 prompt 物件刪除該分支的所有節點」**，ComfyUI 就不會執行。所以新增分支時務必確認：沒有任何留下來的節點還引用被刪掉的節點，否則提交會失敗。

## 慣例

- **UI 文案、commit message、註解都用繁體中文。** 節點 ID、`class_type`、模型檔名保持原文
- **每完成一項獨立改動就 commit + push**，不要累積成一個大 commit
- **commit message**：標題簡短講做了什麼，內文說明**為什麼**這樣改。git log 現有風格就是如此，照著寫
- **commit 之後要在 [進度.md](進度.md) 最上方補一筆**，格式 `### YYYY-MM-DD HH:MM · <hash> <標題>`，寫改了什麼與為什麼。這份檔案的用途是換 AI 工具時能快速接手，所以要寫得讓沒有對話脈絡的人也看得懂。發現新的待辦或已知問題也一併更新該檔的「待辦與可能的下一步」
- 註解只寫程式碼本身表達不出來的約束（例如「膠囊是 absolute 定位在捲動容器內，offsetLeft 不受捲動影響」），不要寫「這行在做什麼」

## 事實查證

涉及**模型行為、token 限制、提示詞寫法**這類聲明時，要上網查證再寫進程式碼或 system prompt，不要憑記憶。這份專案已經因此出過錯（見下方 77 token 那條）。

## 踩過的坑

**PreviewImage 的輸出會被結果區過濾掉。** `addResults()` 會跳過 `type === 'temp'` 的圖片，而 `PreviewImage` 節點回傳的正是 `temp`。要讓成品出現在結果區，workflow 裡必須用 `SaveImage`（需要 `filename_prefix`）。Illustrious 原本六個輸出全是 `PreviewImage`，導致生成完全沒有成品。

**新增前端檔案必須同時加進 `serve.py` 的 `STATIC_FILES`。** 白名單以外的路徑會被轉發給 ComfyUI，結果就是檔案根本沒送出、功能靜默失效。`config.js` 就這樣壞過一次，AI 優化功能完全沒作用卻沒有任何錯誤訊息。

**模型檔名會在 ComfyUI 那端被改掉。** 提交被拒時如果看到 `value_not_in_list`，錯誤訊息裡會列出目前實際可用的檔名，對照後改引擎設定檔即可。例如 `qwen3vl_4b_fp8_mixed` 曾被改名為 `qwen3vl_4b_fp8_scaled`。

**瀏覽器快取。** `index.html` 裡的 `?v=` 原本是寫死的 `?v=1`，等於沒有 cache busting，改過 JS 後瀏覽器仍可能跑舊版——同一個模型檔名錯誤因此重現了兩次。現在 `serve.py` 會在送出 `index.html` 時把 `?v=1` 換成前端檔案 mtime 的雜湊，改任何一支檔案網址就會變。**新增前端檔案時記得加進 `VERSIONED_ASSETS`。**

**放大分支不該強制走二次採樣。** SeedVR2 與 SD 放大的圖片輸入原本硬接在 hires 的 VAEDecode 上，等於開放大就一定會多跑一輪採樣。現在改為 hires 關閉時動態改接 base 的 VAEDecode。

**favicon 換了卻沒生效，先確認是不是瀏覽器挑錯檔案而非快取。** 同時宣告多個 `<link rel=icon>` 時瀏覽器會自行挑選，Chrome 會偏好高解析度的點陣圖而不是 SVG。本專案已改為只宣告 `favicon.svg`，並讓 `favicon.png` / `.ico` 保持同一設計，避免瀏覽器自行抓根目錄的 `/favicon.ico` 時拿到舊圖。**判斷方法**：把檔案 fetch 下來畫進 canvas 取樣像素，就能客觀分辨是檔案不對還是瀏覽器挑錯，不要靠肉眼猜。

**驗證動畫時，預覽窗格收起會讓你誤判。** 窗格不顯示時 `document.visibilityState` 是 `hidden`，`requestAnimationFrame` 不觸發、動畫完全不前進，WAAPI 的 `finished` 與 `animationend` 都不會結算——看起來就像程式壞了。測動畫前先確認 `document.visibilityState === 'visible'`。順帶一提這也是真實情境的 bug 來源：使用者切走分頁時動畫不會跑完，任何寫在 `finished`／`animationend` 裡的收尾都要另外加 `setTimeout` 保險。

**用 class 加減重啟 CSS 動畫並不可靠。** `remove → void offsetWidth → add` 這個常見招式，在連續快速觸發時第二次之後可能完全不觸發（實測連 `animationstart` 都收不到）。需要重複播放的動畫改用 `element.animate()`，並用 `finished` promise 收尾。

**新增 DOM 元素前先確認 id 沒被佔用。** 曾經給執行階段列加了 `id="steps"`，跟既有的「步數」輸入框撞名——`getElementById` 回傳那個 `input`，於是渲染函式把 `<li>` 寫進步數欄位，而送出時讀的正是 `$('steps').value`，直接炸掉生成。

**要表現 ComfyUI 的執行流程時，用引擎設定裡的「分支」而不是節點的 `class_type`。** ComfyUI 的執行順序是相依驅動的，不照階段分組——SD 放大的 `UpscaleModelLoader` 會拖到最後才跑，任何「載入→編碼→取樣」的固定順序假設都會失準。而每條增強分支的節點 ID 在 `illustrious.js` / `krea2.js` 裡本來就有，天然有序、也才是使用者認得的說法。

**引擎主題色一律用 `color-mix` 從 `--accent` 衍生，不要為各引擎另寫覆寫規則。** 陰影、條紋、選取色等透明度變體全部寫成 `color-mix(in srgb, var(--accent) N%, transparent)`，四個引擎自動跟隨。曾經有 33 條規則只是把同一件事寫四遍。新增引擎只需在 `:root[data-engine="..."]` 裡給 4 個變數。同理，內嵌 SVG 要換色時用 class + 變數，**不要用 `[stroke="#xxxxxx"]` 屬性選擇器比對硬編色碼**——SVG 一改就無聲失效。

**顏色值來自 CSS 變數又要過渡時，不能直接 transition 那個屬性。** `background: var(--x)` 搭配 `transition: background-color`，當引擎切換改了 `--x`，Chrome 不會重啟過渡，顏色會卡在舊值（頂部開關就這樣四個引擎全停在同一色）。註冊 `@property` 沒用，反而會被釘在 `initial-value`。正解是兩層堆疊、只對 `opacity` 過渡：把新顏色放在 `::after` 上淡入淡出，變數變動立即生效。

**捲軸出現會讓欄寬跳動。** 左右欄都是 `overflow-y: auto`，展開會增高的區塊（例如 Illustrious 的 ControlNet 參考圖上傳區，多 153px）時，捲軸突然出現會吃掉 15px，內容區變窄、卡片被壓到文字折行，看起來像欄寬自己變了。已用 `scrollbar-gutter: stable` 永遠預留空間。**除錯這類問題要先量出「展開前後的內容高度差」，推算出會觸發的視窗高度區間再重現**——視窗太矮兩種狀態都有捲軸、太高兩種都沒有，都測不出來。另外 `scrollHeight` 在內容比容器矮時會回傳容器高度，要量內容真實高度得改量內層元素。

**CLIP 的 77 token 不是截斷點。** 77 token 是 CLIP 編碼器的架構上限沒錯，但 ComfyUI 會把長提示詞切成 75 token 一組分別編碼再串接 embedding，超過的內容不會被丟棄也不會被稀釋。「重要特徵放前面」這個建議仍然正確，但理由是靠前的 tag 權重較高、且分塊各自獨立編碼會斷開跨塊語意，不是因為會被截斷。
