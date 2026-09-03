# CLAUDE.md

給 Claude Code 的專案指引。這份檔案記錄看程式碼不會立刻發現的事——架構上的關鍵差異、慣例、以及已經踩過的坑。

## 這是什麼

呼叫本機 ComfyUI 的網頁面板，支援四組繪圖引擎。**純前端 vanilla JS，沒有建置步驟、沒有框架、沒有 npm**；後端 `serve.py` 只用 Python 標準函式庫。改完存檔重整瀏覽器就生效，**不要引入打包工具、前端框架或 npm 建置流程**。

**依賴政策（2026-07-29 起放寬）**：可以使用第三方前端函式庫來提升體驗（例如 WebGL 背景用的 `three.min.js` + `vanta.fog.min.js`），但必須：① **本機 vendored**——把 min.js 檔案下載進專案，不掛外部 CDN（面板可能離線跑）；② 加進 `serve.py` 的 `STATIC_FILES` 與 `VERSIONED_ASSETS`；③ 在 `index.html` 用 `?v=1` 引用（serve.py 會換成雜湊）；④ 尊重 `prefers-reduced-motion`、並提供退化方案（WebGL 失敗時要能 fallback）。仍然**不引入 build step / npm / 前端框架**。

**專案結構（2026-08 整理）**：根目錄只留 KLEIN 面板本體（`serve.py`/`app.js`/`index.html`/各引擎設定與 workflow）。三個獨立資料夾：`darkroom/`（詞庫暗房，`preview_ui.py` 等全部併進去，見下方檔案職責）、`voice-assistant/`（語音助理＋LiveTalking 數字人）、`design-ref/`（hero_demo.html 等純設計參考，非面板一部分）。`config.js`／`groq_proxy.py` 因為同時被面板與語音助理共用，**留在根目錄**沒有跟著搬——改動這兩個檔案時要記得兩邊都會受影響。詳細檔案清單見 [README.md](README.md) 的「檔案結構」一節。

## 怎麼跑與怎麼驗證

```bash
python serve.py                      # ComfyUI=127.0.0.1:8188, 面板=7801
python serve.py 127.0.0.1:8188 8190  # 自訂
python serve.py --https              # HTTPS 模式（手機才能用麥克風/語音輸入）
```

Windows 上有 `start.bat` / `stop_panel.bat` 可用。

`--https` 會用 `openssl` 自動產生自簽憑證（`cert.pem` / `key.pem` / `cert.pem.san`，皆 gitignore）。憑證 SAN 自動含 `localhost`、`127.0.0.1`、本機**區網 IP** 與 **Tailscale IP**（100.64.0.0/10，先問 `tailscale ip -4`，失敗再掃介面）。**連線白名單只放行本機與 Tailscale**——面板沒有登入，綁 `0.0.0.0` 是為了讓 Tailscale 虛擬網卡收得到，區網／公網 IP 會被直接斷線並印 `[拒絕]`。手機請走 `https://<Tailscale IP>:7801/klein`。**SAN 變了會自動重產**（換網路、Tailscale 上線都不用手動刪 `cert.pem`）——靠 `cert.pem.san` marker 比對目前 SAN 決定要不要重簽。**為什麼需要 HTTPS**：`getUserMedia`／Web Speech API 這類要麥克風的功能只在「安全來源」可用——桌面 `localhost` 算安全、但手機透過 `http://100.x.x.x` 連都不算，只有 HTTPS 能解。前端已 HTTPS-ready（WS 用 `location.protocol` 選 `wss`、API 用 `location.origin`），不用改。

AI 提示詞優化走同源 `/panel/groq`（`groq_proxy.py`），`config.js` 送給瀏覽器前會剝掉 `GROQ_API_KEY(S)`。不要再讓前端直打 `api.groq.com`。

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
| `design-ref/hero_demo.html` | **設計參考，不是面板的一部分。** 獨立單檔，用 `file://` 直接開；刻意不列入 `STATIC_FILES`，不要把它加進去 |
| `darkroom/preview_ui.py` | 詞庫暗房後端，獨立工具（見上「專案結構」）。改路徑相關程式碼前先確認 `Path(__file__).resolve().parent` 現在指的是 `darkroom/`，不是根目錄 |
| `darkroom/agent_draw.py` | 給外部 AI agent 用的抽卡 CLI／函式庫，呼叫 `preview_ui.py` 的 `/api/agent-draw` 等端點，不重複實作抽卡邏輯。`--discord-dm` 額外直接用 bot token 送真正的 Discord embed（繞過 agent 框架的訊息工具） |
| `darkroom/AGENT_DRAW.md` | 給只能打 HTTP API（function calling）的 agent 看的端點說明與呼叫範例 |
| `groq_proxy.py` | Groq 多 key 輪替代理。留根目錄（跟 `config.js` 同層），被面板 AI 優化與 `voice-assistant/` 的語音助理／LiveTalking 三邊共用 |

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
- **每次改動都要同步更新 [README.md](README.md)。** README 是給使用者看的說明書（功能、檔案結構、快速開始、疑難排解），只要改動影響到這些就要一起更新，不能讓它跟實際行為脫節。進度.md 記「為什麼」給接手的人，README.md 記「怎麼用」給使用者，兩份都要維護
- 註解只寫程式碼本身表達不出來的約束（例如「膠囊是 absolute 定位在捲動容器內，offsetLeft 不受捲動影響」），不要寫「這行在做什麼」

## 事實查證

涉及**模型行為、token 限制、提示詞寫法**這類聲明時，要上網查證再寫進程式碼或 system prompt，不要憑記憶。這份專案已經因此出過錯（見下方 77 token 那條）。

## 踩過的坑

**響應式的斷點區塊寫在元件基礎規則「前面」，會被整條蓋掉，而且症狀是「部分生效」不是「完全沒效果」。** 面板手機版把頂列從五行壓成兩行時，第一版把覆寫寫進 `styles.css` 第 600 行既有的 `@media (max-width: 680px)` 區塊，但 `.assistant-btn`／`.conn`／`.brand` 的基礎規則分散在 900~1000 行——**特異性相同、順序在後，後者贏**。量出來的結果是 topbar 只從 216px 降到 148px、齒輪鈕（`display: inline-flex`）根本沒出現，很容易誤判成「我的選擇器寫錯了」而去改選擇器本身。`.brand` 那條更隱蔽：`.brand { width: 280px }`（「品牌固定寬度→引擎切換器位置不跳動」那條）在更前面，覆寫只寫了 `flex: 0 0 auto` 沒寫 `width: auto`，於是 logo 旁邊留了 280px 的空白，看起來像 flex 沒生效。**規則**：這份專案的 CSS 慣例是把手機規則寫在元件旁邊，但只有當那個元件的基礎規則在更前面時才安全；**跨越多個元件的版面重排一律放檔案最後**，並在該處註明為什麼放這裡。**判斷方法**：覆寫「有一半生效」時，直接對那個元素 `getComputedStyle(el).<屬性>` 逐一比對你以為會贏的值，不要盯著選擇器猜——Chrome DevTools 的 Styles 面板會把被劃掉的規則列出來，比讀原始碼快得多。

**`min-height` 這種「補下限」的規則會砍掉原本更高的下限，而且畫面上看不出來。** 手機觸控目標那一輪在 `@media (pointer: coarse)` 裡寫了 `textarea, input[...] { min-height: 44px }`，用意是「把 42px 的輸入框補到 44」，但提示詞框自己的 `min-height: 92px` 寫在檔案前段，這條較晚、特異性相同，實際效果是把 92 **調低**成 44（`getComputedStyle` 量到真的是 44px）。當下完全看不出異常——`rows=2` 加上內距算出來的高度本來就超過 44px——只有使用者拖右下角縮放時才會發現提示詞框可以被縮成一行高。**規則**：寫 `min-*` 前先確認目標元素現有的下限是不是已經更高；批次補下限的選擇器要把「本來就更高」的那些排除掉，不要用逗號一次掃一票元素。同理 `max-width`／`max-height` 反過來也一樣（補上限會抬高原本更嚴的上限）。

**寫給外部 agent 呼叫的腳本，輸出路徑一律給絕對路徑——不要假設呼叫端的工作目錄。** `darkroom/agent_draw.py` 原本把結果存進相對路徑 `agent_draws/`，印給呼叫端的 `out_path` 也跟著是相對的。這支腳本是給 [Hermes](https://github.com/nousresearch/hermes-agent) 這類 agent 呼叫的，而 Hermes 送 Discord 圖片的機制是在訊息文字裡夾 `MEDIA:<本機絕對路徑>` 標籤——查過它的原始碼確認 `validate_media_delivery_path()` 對相對路徑一律回 `None`，**不報錯，就是那個附件靜默不投遞**。agent 呼叫腳本時的工作目錄不一定跟腳本檔案同一個資料夾，「相對路徑」對它而言解析出來的位置是不確定的。修法是輸出目錄一開始就 `.resolve()`。**這類坑的共同特徵是「呼叫端跟開發時的環境不一樣」**：本機手動跑腳本時相對路徑通常湊巧是對的（工作目錄剛好在對的地方），只有透過另一支程式呼叫、且那支程式的工作目錄跟你預期不同時才會發作，本機測試因此很難自己發現。

**不要憑 agent 框架的名稱猜它怎麼運作，去讀它的原始碼確認。** 一開始以為使用者說的「AI agent」是只能打 HTTP API（function calling）的那種，照這個假設寫的整份文件在使用者說「他是 AI」之後才發現完全用不上——實際是 [Hermes](https://github.com/nousresearch/hermes-agent)，一個有終端機權限、多平台閘道的全功能框架。本機剛好有 git 安裝（`C:\Users\<user>\AppData\Local\hermes\hermes-agent\`），直接讀 `tools/send_message_tool.py` 跟 `plugins/platforms/discord/adapter.py` 才確認它送 Discord 圖片走的是 `MEDIA:<路徑>` 標籤而不是圖片網址——這個機制沒有文件字面提到「HTTP API」或「function calling」就能猜到，必須讀送訊息那個工具的原始碼。**判斷方法**：agent 框架通常在本機有安裝目錄（`~/.hermes`、`~/.claude` 這類），先確認有沒有裝、能不能直接讀原始碼，比只靠框架名稱去查文件或猜測可靠得多——文件會過時，正在跑的程式碼不會。

**用 inline `transition-delay` 做 stagger，動畫跑完一定要拆掉——它對那個元素上「所有」過渡都生效。** 暗房卡片的 reveal-on-scroll（`darkroom.js` `_revealIO`）把 stagger 寫成 `e.target.style.transitionDelay = i * 30 + 'ms'`，進場後就沒人清。後果不是進場本身出問題，而是**之後每一次 hover 都被延遲**：進場排在第 12 位的卡片，滑鼠移上去要先等 0.36 秒才浮起來，感覺像整個頁面在卡。同一組 class（`.card.reveal.in`）自帶的 `transition` 清單只有 `opacity/transform`，比 `.card` 的基礎清單更具體，**還會整條蓋掉 hover 的邊框色與陰影過渡**，那兩個屬性因此直接跳色、完全沒有動畫。兩件事都不會報錯，看起來只是「這個介面手感有點怪」。修法是 `settleReveal()`：進場時長跑完就把 class 與 inline delay 一起拆掉，讓元素回到基礎規則。**判斷方法**：懷疑 hover 手感不對時，直接讀 `getComputedStyle(el).transitionDelay / transitionProperty / transitionDuration`——這三個值會誠實說出目前生效的是哪一組，比盯著 CSS 猜哪條規則贏了快得多。順帶一提收尾**不能靠 `transitionend`**（分頁在背景時 rAF 不跑、事件永遠不結算，見下方那條），要用 `setTimeout` 算好時間拆。

**詞庫規模是 28000 筆，不是幾百筆——任何「掃一遍 `ALL`」的寫法都要當成熱路徑看待。** 暗房的程式碼裡曾經有 13 處 `ALL.find(x => x.rel === rel)`，寫的時候都覺得無所謂，實際上 `/api/libs` 現在回 27951 筆，一次 `find` 就是最多 28000 次字串比較（實測 200 次 ≈ 25ms）。最痛的是 `restoreCard()`：超大範圍啟用卡片修剪後，每張卡片捲回視野都要查一次，等於在**捲動的每一幀**裡掃全庫。同類問題還有搜尋分支每筆現算 `toLowerCase()`（每按一鍵配置五萬多個暫時字串）、`folderStats()` 每次左欄按鍵都重新分組加排序。現在有 `BY_REL`／`itemOf()`、預先算好的 `_lname`／`_lfolder`、以及 `folderStats()`／`baseList()` 的快取。**加快取時要分清楚欄位會不會就地變動**：`rel`／`name`／`folder` 從載入後永不改變（可以進快取鍵），但 `has_image`／`rarity`／`flagged`／`favorited` 會被 `toggleFav()`／打標／生成完成就地改掉——所以 `baseList()` 只快取依前者決定的「範圍」，後者一律留在 `currentList()` 現篩；`folderStats()` 因為要數 `has_image` 才需要 `invalidateFolderStats()`，生成完成那條路徑有補呼叫。**判斷方法**：改暗房前先 `curl /api/libs | ...` 看一眼實際筆數，不要照著「一個資料夾約 400 筆」的直覺估算——那是單一資料夾，跨資料夾／「全部」視圖面對的是全部 28000 筆。

**指標事件裡「寫 style 再讀 `getBoundingClientRect()`」會每次強制同步版面。** 暗房的兩個聚光效果（`.thumb` / `.gc-square` 的 `--mx/--my`）與塔羅牌 3D 傾斜（`tiltCard`）原本都是在 `pointermove`/`mousemove` 裡直接量矩形再寫樣式。指標事件一秒可以來上百次，而上一次的樣式寫入會讓這一次的幾何讀取變成強制 reflow（layout thrashing）——在 28000 筆的卡片牆上這個 layout 一點都不便宜。修法是統一的 rAF 節流（一幀最多寫一次，螢幕本來也就更新這麼多次，多寫的都是丟掉的工）＋把矩形快取在「目前這個元素」上，只有換到別的元素才重量。捲動中快取的矩形會過期，但那只是柔光位置差幾像素，捲完第一次移動就修正回來，不值得為它每幀重新 layout。**驗證方法**：包一層 `el.getBoundingClientRect` 與 `el.style.setProperty` 數呼叫次數，連灌 50 次假事件——改前是 50/50，改後是 1/1。（注意 Browser 窗格隱藏時 rAF 不會跑，要手動呼叫 flush 函式代替，見下方窗格那條。）

**`threading.Semaphore` 不保證 FIFO 喚醒順序。** 暗房抽卡生圖（`darkroom/preview_ui.py` 的 `start_gen()`/`_gen_one_worker()`）原本是「每張 rel 各自起一條 thread、全部同時搶同一個 `STATE["gen_sem"]`」，理論上該照排隊順序（＝牌面順序）依序拿到執行名額，但 CPython 的 `Semaphore` 只保證公平釋放不保證誰先醒來——thread 幾乎同時抵達 `acquire()` 時，OS 排程決定誰先搶到，順序沒有保證。使用者反映「抽卡有時候是從第二張開始生圖」，正是這個非決定性競態：牌面 2 的 thread 偶爾比牌面 1 先搶到 semaphore。修法是用 `threading.Event` 把每個 worker 串成鏈（`wait_for`/`mark_started`），逼下一張要等上一張「已經拿到 semaphore」才能開始搶，代價是犧牲一點點理論並發啟動速度，換來嚴格 FIFO。**判斷方法**：這類「大部分時候正常、偶爾亂序」的 bug 很難用眼睛抓到，寫一個獨立的最小重現腳本（起 N 條 thread 搶同一個 semaphore、記錄實際拿到的順序、跑幾十輪）比盯著真實生成的網路請求時序有效率得多。

**`--comfy` 指到需要經過反向代理（例如 RunPod 的 proxy 網址）的 ComfyUI 時，`resolve_comfy_base()` 探測失敗會靜默 fallback 回本機 `127.0.0.1:8188`，表面上「連上了」，其實整個生成都在用本機顯卡、不是遠端租的那張。** 根因是 `generate_special_previews.py` 的 `http_json()`/`http_bytes()` 用 `urllib.request` 送出去的請求沒有帶 `User-Agent`，RunPod 的代理會把沒有 UA 的請求當爬蟲直接回 403——本機直連 ComfyUI 不會踩到（沒有代理層），只有經過這類反向代理才會。日誌會印出「探測 https://xxx.proxy.runpod.net ... / OK → http://127.0.0.1:8188」，兩行網址對不起來就是這個問題，但很容易被忽略。修法是幫 `http_json`/`http_bytes` 統一加一個 `User-Agent` header。另外 `preview_ui.py` 裡手刻的最小 WebSocket client（`_comfy_ws_generate()`，用來接即時採樣預覽）是直接對 host:port 開 raw socket、沒有包 TLS，`base` 是 `https://`（RunPod 這類代理的 TLS 是在代理端終結，原始連線必須自己包一層）時握手一定失敗、退化成純輪詢（看不到即時預覽，但生成本身不受影響，因為 `queue_and_wait()` 走的是 `http_json()`）——已經補上 `ssl.wrap_socket`，`scheme == "https"` 時才包。**判斷方法**：懷疑「明明給了遠端網址卻好像沒用到」時，先比對日誌裡「探測」跟「OK →」兩行的網址是否一致，而不是去查生成邏輯——這條坑的症狀（生成看似正常）完全不會讓人聯想到網路層的 UA 過濾。

**寫給多台 ComfyUI 用的一次性工具（`darkroom/multi_gpu_batch.py`）第一版直接用 `SPECIAL_DIR`（`generate_special_previews.py` 的模組層常數，預設指向 `darkroom/special_prompts`），沒有讀 `preview_config.json`，導致掃出「0 筆缺圖」——不是真的沒有缺圖，是掃錯資料夾（不存在的 `darkroom/special_prompts`，`iter_libraries()` 直接回空清單，靜默沒有任何錯誤）。** `preview_ui.py` 本體會在 `main()` 裡呼叫 `apply_special_dir()` 把 `SPECIAL_DIR` 換成設定檔裡的值，但這是要主動呼叫才會生效的動作，不是 import 就自動套用；任何**不透過 `preview_ui.main()`、只是 import 它的函式來重用邏輯**的獨立腳本，都必須自己呼叫 `load_config()` + `apply_special_dir()`，不能預設 `generate_special_previews.py` 的模組層常數已經是對的。另外 RunPod 這類代理網址是每次租用機器才有的，**不要寫進會 git push 的 `.py` 檔案**——`multi_gpu_batch.py` 改成讀 `preview_config.json` 新增的 `comfy_endpoints` 欄位（已 gitignore），程式碼本身完全不含機器相關資訊。

**vast.ai 的網路架構跟 RunPod 不一樣，`portal.yaml` 裡列的 `external_port` 不代表真的能從外面連到。** vast.ai instance 卡片上「Open」按鈕給的直連 `IP:port`（例如 `http://1.2.3.4:8188`）常常 TCP 連線直接逾時——那個 port 沒有真的被轉發到外網，即使 SSH 進去 `cat /etc/portal.yaml` 看到 ComfyUI 的 `external_port: 8188` 也一樣連不到。實際能連的是 vast.ai 自動建的 **Cloudflare quick tunnel**（`https://隨機四個英文單字.trycloudflare.com`），這個網址才是要放進 `comfy_endpoints` 的。另外 vast.ai 對外 port 一律要 **Basic Auth**（帳號固定 `vastai`，密碼是每台 instance 專屬的 `OPEN_BUTTON_TOKEN`，SSH 進去 `echo $OPEN_BUTTON_TOKEN` 或看 `/etc/portal.yaml` 旁邊的設定能找到）——`generate_special_previews.py` 的 `http_json()`/`http_bytes()` 已經支援 `comfy_endpoints` 寫成 `https://vastai:token@xxx.trycloudflare.com` 這種帶認證的 URL（`_split_basic_auth()` 會自動拆出來組 `Authorization` header，urllib 不會自動處理 URL 裡的 `user:pass@`）。**判斷方法**：連線逾時（不是被拒絕、不是 401）先懷疑是不是走錯了直連 port，改用 tunnel 網址；連線通了但回 401，是缺 Basic Auth 或密碼錯。

**`multi_gpu_batch.py` 的「endpoint 連續失敗就判斷斷線」不能做成永久放棄，要做成冷卻重試。** 第一版連續失敗 3 次就把那台永久加進黑名單、worker 直接退出，結果使用者回報某台 vast.ai「久了會自己停掉」——實測那台其實還活著（`/queue` 顯示正在跑），只是我們自己的程式不再送工作給它。根因是 Cloudflare quick tunnel（`trycloudflare.com`）本來就會偶爾自己斷線又自動重連（backoff 最長約 64s），這種暫時性斷線被誤判成永久死亡。改成 `endpoint_cooldown`（`{endpoint: 恢復時間戳}`）：連續失敗一樣暫停領工作，但只冷卻 90 秒，時間到自動恢復，不是永久放棄。**改冷卻機制時要順便檢查 `MAX_ITEM_RETRIES` 有沒有跟 `MAX_CONSECUTIVE_FAILS` 設成一樣的數字**——設一樣的話，單一（或只剩一台存活）endpoint 情境下，項目會在冷卻期滿之前就先被「重試次數用完」判定永久放棄，冷卻機制形同虛設；`MAX_ITEM_RETRIES` 要設得比 `MAX_CONSECUTIVE_FAILS` 大很多，讓項目撐得過一次冷卻週期。**判斷方法**：懷疑「明明那台還活著卻不再被使用」時，先手動打 `/system_stats`／`/queue` 確認 endpoint 真實狀態，不要假設程式的斷線判定是對的。

**同一個 `STATE["gen_sem"]` 被單張生成/抽卡跟批次共用時，原生 `Semaphore` 沒有優先權概念，批次幾乎必贏。** 使用者想要「點單張生成/重新生成可以插隊到批次（補缺少／全部重生）前面」，但批次 worker thread 從 `release()` 到下一次 `acquire()` 幾乎是同一瞬間就搶線；單張生成是 HTTP 請求進來才臨時起 thread，多了 handler／建立 thread 的延遲，跟批次公平搶同一個 `Semaphore` 實務上幾乎每次都輸，被迫排在批次剩下的所有項目後面（而不是隨機——上面那條 FIFO 不保證的坑是「誰先醒」不確定，這裡是系統性劣勢，批次幾乎穩贏）。修法是寫一個 `PrioritySemaphore`（`darkroom/preview_ui.py`）：等待佇列依 `(priority, seq)` 排序，`release()` 永遠先喚醒優先權數字較小的等待者。單張生成/抽卡用 priority 0、批次（`do_generate(..., in_batch=True)`）用 priority 1，同優先權內仍照抵達順序排隊。跟 `_gen_one_worker()` 既有的 `wait_for`/`mark_started` 鏈不衝突——那條鏈只決定「誰先呼叫 `acquire()`」，優先權只決定「`release()` 時先叫醒誰」，兩者正交。

**搬檔案前先找出所有靠 `Path(__file__).resolve().parent` 算出來的路徑常數。** 2026-08 把散在根目錄的暗房相關檔案整理進 `darkroom/` 時，`preview_ui.py` 裡有好幾個常數都是這樣算的（`CONFIG_PATH`／`META_DIR`／`.thumb_cache` 的 `THUMB_DIR`／舊遷移檔 `FLAGS_OLD_PATH`）——這些**因為所有相關檔案跟著一起搬，不用改**；但 `DARKROOM_DIR = Path(__file__).resolve().parent / "darkroom"` 原本是「往下找子資料夾」，`preview_ui.py` 本身搬進 `darkroom/` 之後這行必須改成直接是自己的目錄，不然會去找不存在的 `darkroom/darkroom/`。另外 `serve.py` 讀 `darkroom/preview_config.json` 的 `_prompts_root_default()` 也要跟著改路徑（它跟 `preview_ui.py` 不同目錄，讀的是同一份設定檔）——這種**兩支腳本各自用 `Path(__file__)` 算路徑、但读同一份共用檔**的模式最容易漏改，因為兩邊都「看起來沒錯」（各自都能正常算出一個路徑），只是其中一邊算出來的路徑檔案不存在，會靜默 fallback 成內建預設值而不是報錯。搬檔案時務必對每一個路徑常數想清楚：這個檔案的其他相關檔案有沒有跟著搬？

**PreviewImage 的輸出會被結果區過濾掉。** `addResults()` 會跳過 `type === 'temp'` 的圖片，而 `PreviewImage` 節點回傳的正是 `temp`。要讓成品出現在結果區，workflow 裡必須用 `SaveImage`（需要 `filename_prefix`）。Illustrious 原本六個輸出全是 `PreviewImage`，導致生成完全沒有成品。

**新增前端檔案必須同時加進 `serve.py` 的 `STATIC_FILES`。** 白名單以外的路徑會被轉發給 ComfyUI，結果就是檔案根本沒送出、功能靜默失效。`config.js` 就這樣壞過一次，AI 優化功能完全沒作用卻沒有任何錯誤訊息。

**模型檔名會在 ComfyUI 那端被改掉。** 提交被拒時如果看到 `value_not_in_list`，錯誤訊息裡會列出目前實際可用的檔名，對照後改引擎設定檔即可。例如 `qwen3vl_4b_fp8_mixed` 曾被改名為 `qwen3vl_4b_fp8_scaled`。

**checkpoint／LoRA 只要放在 `models/checkpoints`（或 `loras`）底下的子資料夾，ComfyUI 認的名字就一定要帶資料夾前綴，純檔名送出整批 400 Bad Request。** 暗房的 checkpoint 選擇器（`apply_checkpoint_override()`）第一版只送純檔名，實測切到 `illurtrious/` 資料夾裡任一非預設的 checkpoint 就整批失敗。用 `GET /object_info/CheckpointLoaderSimple` 直接查 ComfyUI 回報的合法 `ckpt_name` 清單，確認清單裡是 `"illurtrious\prefectIllustriousXL_v8.safetensors"` 這種帶資料夾的相對路徑，純檔名根本不在清單裡——跟 `_convert_loras()` 處理 LoRA 子資料夾早就記過的坑（見上面「新增 LoRA 選擇器」附近的 `_convert_loras` 說明）是同一類問題，這次是在新功能裡又踩了一次。**判斷方法**：懷疑「切了模型就 400」時，直接打 `GET http://<comfy>/object_info/<LoaderNodeType>`，看 `input.required.<欄位名>[0]` 那個陣列裡實際列出來的字串長什麼樣，不要假設「檔名資料夾平放就好」——這個端點永遠是最新、最準的合法值來源，比對照面板介面顯示的檔名更可靠（面板通常只顯示 basename，藏起了實際要送的相對路徑）。**這次連帶發現一個外部檔案裡的既有問題**：瀏覽模式「重新生成」用的外部 workflow.json（`ANIMESTYLE (1).json`，在 git repo 外面，是使用者自己的 ComfyUI 匯出檔）裡的 `ckpt_name` 也是裸檔名，同樣不在 ComfyUI 的合法清單裡——這代表瀏覽模式的重新生成目前可能也是壞的，只是還沒被觸發；因為那個檔案不在版控範圍內，屬於使用者自己維護，沒有主動去改，只在查出根因時一併告知。

**「內容定址的網址」跟 `no-store` 同時存在＝兩件事互相抵銷，而且不會有任何症狀。** `serve.py` 早就會把 `index.html` 裡的 `?v=1` 換成前端檔案 mtime 的雜湊（`asset_version()`），但送出時每一支靜態檔又都掛 `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`——等於做了 cache busting 之後再叫瀏覽器完全不要快取。**結果是每次重整都重新下載全部資產**（實測 868KB 未壓縮的 js/css＋352KB 的 workflow.json＋2.44MB 的 `/object_info`＝3.65MB），而且因為本機 localhost 每個檔案只要 1~2ms，桌面上完全看不出來，只有手機走 Tailscale 才痛。修法是分清楚兩種網址：**帶內容雜湊的（`?v=`）走 `immutable`**（改檔案→雜湊變→網址變→瀏覽器自然重抓，不可能吃到舊版），**沒有雜湊的（`workflow.json`、暗房的 `darkroom.js`／`darkroom.css`）走 ETag + `no-cache`**（每次問一下、內容沒變就回 304）。改完實測重整的傳輸量：面板 3.65MB → 3,660 bytes、暗房 1.95MB → 3,781 bytes。**驗證一定要做兩件事**：① 確認改了檔案之後雜湊／ETag 真的會變（不然 `immutable` 會把舊版永遠鎖在瀏覽器裡，這是這條唯一的真風險）；② 用 `performance.getEntriesByType('resource')` 的 `transferSize` 看實際傳輸量，不要看 `decodedBodySize`——後者不管有沒有命中快取都是原始大小。

**純 TTL 快取的成本是「過期的那一次由使用者在前景買單」，這種 bug 只在剛好過期時出現、幾乎不可能歸因。** `list_loras()`（暗房）與 `serve_lora_list()`（面板）都是「超過 300 秒就重掃」，而重掃要讀數百個 `metadata.json`——**實測 5.93 秒，快取命中只要 11ms**。使用者的感受是「LoRA 面板偶爾會卡好幾秒」，但因為五分鐘內只會發生一次、而且下一次就正常了，回報起來就是模糊的「有時候很慢」。同一個檔案裡的 `scan_libraries()` 早就用 stale-while-revalidate 解掉同一個問題（過期先回舊的、同時背景重掃），只是後來寫的這兩支沒跟上。**判斷方法**：看到 `if time.time() - cache["at"] < TTL: return cache[...]` 這個形狀，就問一句「TTL 到期那一次要等多久？」——只要答案超過 100ms，就該改成 SWR。代價只是資料可能晚一次請求才更新。

**瀏覽器快取。** `index.html` 裡的 `?v=` 原本是寫死的 `?v=1`，等於沒有 cache busting，改過 JS 後瀏覽器仍可能跑舊版——同一個模型檔名錯誤因此重現了兩次。現在 `serve.py` 會在送出 `index.html` 時把 `?v=1` 換成前端檔案 mtime 的雜湊，改任何一支檔案網址就會變。**新增前端檔案時記得加進 `VERSIONED_ASSETS`。**

**放大分支不該強制走二次採樣。** SeedVR2 與 SD 放大的圖片輸入原本硬接在 hires 的 VAEDecode 上，等於開放大就一定會多跑一輪採樣。現在改為 hires 關閉時動態改接 base 的 VAEDecode。

**favicon 換了卻沒生效，先確認是不是瀏覽器挑錯檔案而非快取。** 同時宣告多個 `<link rel=icon>` 時瀏覽器會自行挑選，Chrome 會偏好高解析度的點陣圖而不是 SVG。本專案已改為只宣告 `favicon.svg`，並讓 `favicon.png` / `.ico` 保持同一設計，避免瀏覽器自行抓根目錄的 `/favicon.ico` 時拿到舊圖。**判斷方法**：把檔案 fetch 下來畫進 canvas 取樣像素，就能客觀分辨是檔案不對還是瀏覽器挑錯，不要靠肉眼猜。

**WebGL 的 uniform 屬於 program，畫布尺寸屬於元素——不要把兩者綁在同一個「沒變就 return」的判斷裡。** 進場「顯影盤」的 `introResize()` 原本寫成「畫布尺寸沒變就整段 return」，而 `uRes` 的設定也在那個 return 後面。單次使用看不出問題；但只要在畫布已經是正確尺寸的情況下重建 program（重開進場、切換樣式、context 還原），新 program 的 `uRes` 就停在預設的 0，shader 裡 `aspect = uRes.x / uRes.y` 變成 NaN，**整片畫面全黑而且沒有任何 GL 錯誤**（`getError()` 回 0、link/compile 都 ok，非常難聯想）。規則：只有真正會動到畫布緩衝區的操作（`canvas.width/height`、`gl.viewport`）才需要判斷尺寸，uniform 一律每次寫。**判斷方法**：畫面全黑但 compile/link/getError 都正常時，直接 `gl.getUniform(prog, loc)` 把每個 uniform 印出來，一眼就看得到誰是 0。另外附帶一條：**GLSL 的 `half` 是保留字**，用它當變數名會編譯失敗——寫著色器時務必把 `getShaderInfoLog()` 印出來，不要只看有沒有畫面。

**會動的 3D 元素「文字也在閃、邊緣在抖」＝次像素重新取樣，跟圖片內容無關——別再去查圖片。** 進場無限畫布被回報閃爍時，我連續猜錯三次（縮圖尺寸、遠處縮小走樣、透明度過渡），因為一直往「圖片」的方向找。真正決定性的一句話是使用者說「**連詞庫名稱文字跟卡片邊緣也在閃**」——文字與 1px 邊框裡沒有任何照片內容，這一句直接排除掉整條圖片路線。根因是 3D 透視下元素幾乎不可能落在整數像素上（螢幕位置 =（世界座標＋位移）× 縮放，縮放不是 1 就有小數），合成器每一幀都要把貼圖用雙線性取樣重畫在不同的次像素位置：1px 邊框的亮度在相鄰兩欄像素間來回分配＝邊緣抖，文字反鋸齒每幀重新分配＝文字閃，整塊平均亮度跟著變＝忽明忽暗。**量測方法（不需要看得到畫面，這點很重要）**：手動推進動畫迴圈，記錄元素每一幀 `getBoundingClientRect()` 的小數部分——實測 6 張卡連續 8 幀「0/8 對齊整數」，而且小數在 .84→.27→.78→.30 這種接近兩幀一循環地跳，那個週期讀起來就是「在閃」而不是平滑移動。**修法是超取樣**：元素用 `--ss` 倍尺寸繪製、再用 `transform: scale(1/--ss)` 縮回來，合成器拿到 `--ss` 倍解析度的貼圖，次像素位移被平均掉（＝遊戲的 SSAA），畫面設計完全不變，代價是貼圖記憶體 `--ss²` 倍。**做的時候有三個地方漏一個就白做**：① 所有內部尺寸都要乘 `--ss`（字級、內距、圓角、邊框、陰影），否則縮回去會比原本小；② 圖片來源也要 `--ss` 倍解析度，不然文字邊框變好、照片還是沒有像素可取樣；③ 任何 `filter: blur()` 的半徑也要乘 `--ss`，因為它作用在元素自己那個已經變密的座標系。

**縮圖「送太大」在會動的畫面上會變成閃爍／摩爾紋——而且靜止的畫面完全看不出來，所以很容易漏掉。** `/api/thumb` 預設回 360px（當初照「格子 180px @2x DPR」訂的），但進場動畫把同一張圖顯示成 108～130px；在 1x DPR 的螢幕上就是縮小 2.8～3.3 倍。**走樣在靜止畫面只是「有點銳利過頭」，一動起來才會現形**：每一幀取樣到的來源像素子集都不同，於是細節逐幀跳動（紋理在跳）、整塊平均亮度跟著抖（整張圖忽明忽暗）、規律紋理互相干涉（摩爾紋）。同樣被縮小 1.96 倍的格線縮圖從來沒人抱怨，就是因為它不會動。治本是「顯示多大就送多大」：`/api/thumb?w=` 會收斂到 `THUMB_SIZES` 的固定級距（用級距不是任意數字，否則 `.thumb_cache` 會無限膨脹），前端用 `thumbURL(it, displayPx)` 依 `displayPx × devicePixelRatio` 要圖。**改這裡要記得三件事**：① 沒帶 `w` 時後端行為必須維持原樣，格線／塔羅／LoRA 面板都靠這個預設；② **所有預熱（prefetch）的網址必須跟真正要用的完全一致**，差一個 `&w=` 就是暖到另一份快取、完全白費；③ 尺寸要進 etag／快取鍵，否則不同尺寸會互相覆蓋。**判斷方法**：回報「會閃／有摩爾紋」時，先算「來源像素 ÷（CSS 顯示尺寸 × DPR）」，大於約 1.5 就是這條，不要從動畫程式碼開始找——而且要記得問「**其他會動的地方是不是也有**」，共同點通常就指向根因（這次就是馬燈也有，才排除掉 3D 專屬的解釋）。

**CSS 3D 裡把東西縮小超過約 1.5 倍就會走樣，看起來像在閃或有摩爾紋——那不是動畫邏輯的 bug。** 進場無限畫布的卡片曾經被回報「往遠處消失時很像在閃」。根因是 GPU 的**縮小取樣走樣**：一個 130px 的 CSS 盒子會先被點陣化成一張 130px 貼圖，之後每一幀由 GPU 依 3D 變換縮小畫上畫面，而 GPU 用的是雙線性取樣、**沒有 mipmap**。縮小 2.6 倍時每個螢幕像素涵蓋約 7 個貼圖像素卻只取樣 4 個，鏡頭一漂移「取到哪 4 個」就變，高頻細節逐幀跳動＝閃，規律紋理互相干涉＝摩爾紋。**修法是自己補上 mipmap 那一步：依縮小倍率做低通濾波**（`filter: blur()`，縮小 m 倍理論上用 σ≈m/2，實務取六成左右，全套會糊成一團）。注意三件事：① `filter: blur()` 是逐元素的**繪製**成本，一定要把半徑量化成級距、只在跨級距時才寫 style，不能每幀寫；② 近處的元素要留在門檻之外維持全銳利，不然整體看起來就只是「畫面糊掉」；③ `filter` 是 grouping property，理論上會讓元素被扁平化——這裡沒問題是因為卡片本來就有 `opacity < 1`（同樣是 grouping property）而且沒有 3D 子元素，**但換到別的場景要先驗證**：比對同一個元素加不加 `filter` 的 `getBoundingClientRect`，一致就代表它還在父層的 3D context 裡。**判斷方法**：先算「這東西在螢幕上實際被縮到幾像素」，跟它的 CSS 尺寸相除得到縮小倍率——超過 1.5 就先懷疑走樣，不要從動畫程式碼開始找。

**暗房的圓角是「連續曲率」（squircle），不是正圓角——改圓角前先看 `darkroom.css` 開頭的 `corner-shape` 那一節。** `*, *::before, *::after { corner-shape: squircle; }` 一條掃全部（`squircle` = `superellipse(2)` = 超橢圓指數 n=4，就是 Apple `.continuous` 的角）。新增元件**不用做任何事**就會自動拿到正確的角形狀。要注意的只有兩件：① **真圓（`border-radius: 50%`）與膠囊（`999px`）必須在那條規則裡自己標 `corner-shape: round`**，否則會被萬用選擇器變成鼓起來的方塊／兩端削平的橢圓——半徑接近短邊一半的細長條（進度條那種）也算膠囊；② **squircle 在相同半徑下切掉的角比正圓少**（對角線上 0.225r vs 0.414r），所以面級元素的半徑比一般專案大約 1.25 倍是刻意的，照抄別處的半徑數字過來會顯得角太尖。10px 以下的小元件維持原半徑，那個尺寸下形狀差異看不出來。主面板 `styles.css` 目前還是正圓角，兩邊不一致是已知的。

**動效有 token 系統，不要再寫字面值。** 時長用 `--dur-1`～`--dur-5`（micro / UI / 小過渡 / 區塊進場 / 大範圍換色），緩動用 `--ease-out` / `--ease-entrance` / `--ease-spring` / `--ease-toggle`。**例外是迴圈類動畫**（spinner、光環、脈動、條紋）——它們各有自己的節奏，維持字面值。切換引擎的編排節拍集中在 `app.js` 的 `BEAT` 物件。進場慢收、退場快走：退場時長要比進場短並用 ease-in。

**任何靠 `finished` / `animationend` 收尾的動畫都要加 `setTimeout` 保險。** 這個專案已經三次踩到同一件事：分頁在背景時 `requestAnimationFrame` 不觸發、動畫不前進，那兩個事件永遠不會結算，收尾邏輯就永遠不執行（logo 卡在舊色、結果清不掉）。

**驗證動畫時，預覽窗格收起會讓你誤判。** 窗格不顯示時 `document.visibilityState` 是 `hidden`，`requestAnimationFrame` 不觸發、動畫完全不前進，WAAPI 的 `finished` 與 `animationend` 都不會結算——看起來就像程式壞了。測動畫前先確認 `document.visibilityState === 'visible'`。順帶一提這也是真實情境的 bug 來源：使用者切走分頁時動畫不會跑完，任何寫在 `finished`／`animationend` 裡的收尾都要另外加 `setTimeout` 保險。

**用 class 加減重啟 CSS 動畫並不可靠。** `remove → void offsetWidth → add` 這個常見招式，在連續快速觸發時第二次之後可能完全不觸發（實測連 `animationstart` 都收不到）。需要重複播放的動畫改用 `element.animate()`，並用 `finished` promise 收尾。

**新增 DOM 元素前先確認 id 沒被佔用。** 曾經給執行階段列加了 `id="steps"`，跟既有的「步數」輸入框撞名——`getElementById` 回傳那個 `input`，於是渲染函式把 `<li>` 寫進步數欄位，而送出時讀的正是 `$('steps').value`，直接炸掉生成。

**要表現 ComfyUI 的執行流程時，用引擎設定裡的「分支」而不是節點的 `class_type`。** ComfyUI 的執行順序是相依驅動的，不照階段分組——SD 放大的 `UpscaleModelLoader` 會拖到最後才跑，任何「載入→編碼→取樣」的固定順序假設都會失準。而每條增強分支的節點 ID 在 `illustrious.js` / `krea2.js` 裡本來就有，天然有序、也才是使用者認得的說法。

**引擎主題色一律用 `color-mix` 從 `--accent` 衍生，不要為各引擎另寫覆寫規則。** 陰影、條紋、選取色等透明度變體全部寫成 `color-mix(in srgb, var(--accent) N%, transparent)`，四個引擎自動跟隨。曾經有 33 條規則只是把同一件事寫四遍。新增引擎只需在 `:root[data-engine="..."]` 裡給 4 個變數。同理，內嵌 SVG 要換色時用 class + 變數，**不要用 `[stroke="#xxxxxx"]` 屬性選擇器比對硬編色碼**——SVG 一改就無聲失效。

**顏色值來自 CSS 變數又要過渡時，不能直接 transition 那個屬性。** `background: var(--x)` 搭配 `transition: background-color`，當引擎切換改了 `--x`，Chrome 不會重啟過渡，顏色會卡在舊值（頂部開關就這樣四個引擎全停在同一色）。註冊 `@property` 沒用，反而會被釘在 `initial-value`。正解是兩層堆疊、只對 `opacity` 過渡：把新顏色放在 `::after` 上淡入淡出，變數變動立即生效。

**捲軸出現會讓欄寬跳動。** 左右欄都是 `overflow-y: auto`，展開會增高的區塊（例如 Illustrious 的 ControlNet 參考圖上傳區，多 153px）時，捲軸突然出現會吃掉 15px，內容區變窄、卡片被壓到文字折行，看起來像欄寬自己變了。已用 `scrollbar-gutter: stable` 永遠預留空間。**除錯這類問題要先量出「展開前後的內容高度差」，推算出會觸發的視窗高度區間再重現**——視窗太矮兩種狀態都有捲軸、太高兩種都沒有，都測不出來。另外 `scrollHeight` 在內容比容器矮時會回傳容器高度，要量內容真實高度得改量內層元素。**同一條坑在暗房重演過一次，而且更嚴重**：`darkroom.css` 的 `.main` 是 `repeat(auto-fill, minmax(184px, 1fr))` 的卡片牆，捲軸吃掉的 15px 不只是「變窄一點」，是**整排少排一欄**（實測常見視窗寬度下 5 欄變 4 欄），從一頁裝得下的資料夾切到要捲的資料夾時整面圖重排。`.rail`（左欄搜尋篩剩幾個資料夾時捲軸消失）與 `.modal-inner`（兩欄版面，連續按上一張/下一張時大圖一張一個尺寸）也是同一回事。**教訓是：這條規則要套在「每一個」`overflow-y: auto` 的容器上，不是只有當初出問題的那個**；新增捲動容器時順手加。驗證方法很簡單——切一個 2 筆的資料夾和一個 400 筆的資料夾，比對 `getComputedStyle(grid).gridTemplateColumns.split(' ').length`。

**每個捲動容器都要想一下 `overscroll-behavior`。** 暗房有八個捲動容器（大圖 modal、提示詞區塊、抽取設定、LoRA 說明／清單／右欄、詞庫跳轉結果、快捷鍵面板）原本都沒設，捲到底會繼續帶動背後的卡片牆。在「全部」視圖下這不只是視覺干擾——背後動的是 28000 筆的格線，捲到 sentinel 還會觸發 `appendPage()` 在背後默默長出更多卡片。凡是疊在主捲動區之上的面板一律 `overscroll-behavior: contain`。

**`state` 物件初始化時不能引用後面才 `const` 宣告的模組變數。** `app.js` 開頭 `const state = {…}` 在第 9 行，而 `const I = window.YZ_I` 在第 29 行。曾經在 state 裡寫 `strength: I.lora.defaultStrength`，觸發 TDZ（暫時性死區）——`const` 在宣告前存取會直接拋 `ReferenceError`，整個 IIFE 載入即掛，所有事件都沒綁上（引擎切換按鈕 `onclick` 是 `false`、頁面像壞掉但 console 不一定抓得到）。要用引擎設定的預設值就寫字面值、另在該設定檔用註解標明兩邊要一致。**判斷方法**：頁面互動全失效但版面正常時，先在 console 查某個按鈕的 `.onclick` 是不是 `null`，是的話就是 init 中途拋錯，不是事件邏輯問題。

**驗證動畫或互動時，Browser 窗格沒顯示會讓 `startViewTransition` 的 callback 不結算。** 引擎換色走 View Transitions，窗格隱藏（不合成畫面）時 `document.startViewTransition(cb)` 的 `cb` 不會執行，`applyEngine` 就沒跑、引擎切不動，看起來像切換壞了。這跟既有的「`requestAnimationFrame` 不觸發」是同一個根源。要用 `javascript_tool` 自動驗證時，先 `document.startViewTransition = null` 強制走同步 fallback 再點擊，才測得到後續邏輯。

**CLIP 的 77 token 不是截斷點。** 77 token 是 CLIP 編碼器的架構上限沒錯，但 ComfyUI 會把長提示詞切成 75 token 一組分別編碼再串接 embedding，超過的內容不會被丟棄也不會被稀釋。「重要特徵放前面」這個建議仍然正確，但理由是靠前的 tag 權重較高、且分塊各自獨立編碼會斷開跨塊語意，不是因為會被截斷。

**hover 預覽泡泡跟觸發它的元素綁在一起時，泡泡裡的按鈕點下去不會讓泡泡自己收起。** 暗房 LoRA 大面板的分頁卡（`.lm-slot-tab`）`mouseenter` 顯示 hover 預覽、`mouseleave` 收起，卡片右上角疊了一顆 `.lm-slot-clear`（✕，清空這格 LoRA）。清空鈕在卡片**裡面**，點下去滑鼠沒有真的離開卡片邊界，`mouseleave` 不會觸發——預覽泡泡因此停在清空前的內容一直浮著，跟畫面上已經變成「未選擇」的狀態對不上（使用者截圖回報：清空後大頭貼還飄在那）。同一個檔案裡另一顆做同樣事情的清空鈕（`.cs-locked-clear`，抽取設定裡的固定 LoRA 卡）有正確在 click handler 裡手動呼叫 `hideLoraPreviewTip()`，`.lm-slot-clear` 那顆單純漏寫。**規則**：任何「hover 顯示浮層」的元素，只要浮層內容會因為裡面的按鈕點擊而過期（清空、刪除、切換），那顆按鈕的 click handler 都要手動關浮層，不能指望 `mouseleave`——按鈕在觸發元素內部時，滑鼠根本不會離開。**判斷方法**：搜尋同一個浮層函式（這裡是 `showSingleLoraPreviewTip`/`showLoraPreviewTip`）在檔案裡所有呼叫點，一顆一顆看它們的內部按鈕有沒有對應的關閉呼叫——這類 bug 通常是「同一個模式抄了兩三次，其中一次漏掉一行」，不會只出現一次，抓到一個要順手檢查所有兄弟版本。
