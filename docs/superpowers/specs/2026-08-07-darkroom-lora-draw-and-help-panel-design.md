# 暗房：一般生圖模式抽 LoRA ＋ 使用說明面板

## 背景

使用者回報 Concepts 抽卡的方向鍵、鎖定模板搜尋結果旁的 ✕ 沒反應（已在另一次修復中解決，根源是 outside-click 監聽器對已離線 DOM 節點誤判，見 `進度.md` `e7b50ba`）。排查過程中發現：

1. 暗房的隨機抽 LoRA 功能目前只存在於 Concepts 抽卡（雙 LoRA 配對，`C`/`X` 鍵）。一般生圖模式（手動選 LoRA1/LoRA2、多選詞庫生圖）沒有對應的「一鍵抽」，只能開 LoRA 大面板逐張瀏覽點選。
2. 暗房已有不少滑鼠驅動的功能（右上角步數輸入框、收藏星號、稀有度標記、LoRA 大面板隨機瀏覽…）沒有任何地方統一介紹，使用者容易漏掉（本次事件的起因：使用者以為生成步數鎖定在 25，其實 `#steps-input` 早就可以調到 1~150）。

## 目標

- 一般生圖模式新增「抽 LoRA 直接生圖」的快捷鍵，操作體感對齊 Concepts 的 `C`/`X`。
- 新增一個涵蓋滑鼠驅動功能的「功能總覽」，跟既有「快捷鍵一覽」共用同一個入口與外觀。

## 功能一：一般生圖模式抽 LoRA

### 行為

- 新增快捷鍵 `L`（全庫抽）與 `K`（本分類抽，範圍看 LoRA 大面板左欄目前的分類/子資料夾篩選，即 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER`，跟既有 `loraCatPool()` 同一套狀態）。
- 只在**沒有其他疊層開著**（大圖/抽卡/LoRA 大面板/Concepts 疊層/快捷鍵說明皆未開）、且焦點不在輸入框時生效，插入位置比照現有 `R`/`E`/`C`/`X` 判斷分支（`darkroom.js` 全域 `keydown` handler）。
- 觸發時：
  1. 讀取新設定 `GEN_LORA_DRAW_SCOPE`（`'both'` 或 `'active'`，見下）決定要重新抽哪幾格 `GEN_LORA_SLOTS`。
  2. 對每個要抽的格子：從對應範圍（全庫 `GEN_LORAS` 或依 `L`/`K` 決定的池）隨機選一顆 LoRA，寫入該格 `{ lora, strength: 沿用該格原本的 strength, twPicks: new Set(有觸發詞就是 [0]，否則空) }`（沿用手動點選 LoRA 卡片時的預設邏輯，見 `darkroom.js:1732-1734`）。
  3. 若 `SEL`（目前多選的詞庫）為空 → `toast('請先選要生成的詞庫')`，**不送出生圖**，但抽 LoRA 本身仍然生效（讓使用者看得到抽到什麼、可以先確認再手動按生圖）。
  4. 若 `SEL` 非空 → 直接呼叫既有 `runGen()`（不用改造，`runGen()` 呼叫當下才讀 `GEN_LORA_SLOTS`／`genTriggerText()`，抽卡與送出天然解耦）。

### 設定面板

在 Concepts 設定彈窗新增一列（沿用同一個彈窗，因為抽卡相關設定目前都集中在這裡，不另開新面板）：

```
🎲 抽 LoRA 範圍
○ 兩格都抽   ● 只抽目前作用格
```

- 狀態變數 `GEN_LORA_DRAW_SCOPE`，預設 `'active'`（只抽目前作用格，行為最保守、不會不小心把使用者手動選好的另一格洗掉）。
- 持久化：跟其餘 Concepts 設定（`CONCEPTS_CHAR_STRENGTH` 等）一樣寫進 `localStorage`（既有機制，見 CLAUDE.md 待辦「狀態持久化」已完成的那套）。
- `'both'`：兩格都重抽，**不**尊重個別格子的手動選擇（不同於 Concepts 的「鎖定側不動」邏輯——一般生圖模式的 LoRA1/2 沒有 Character/concepts 這種角色區分，沒有「鎖定」的語意可套用，兩格都抽就是字面上的兩格都抽）。
- `'active'`：只重抽 `GEN_ACTIVE_SLOT` 指到的那一格。

### 快捷鍵一覽補充

`SHORTCUT_GROUPS` 的「抽卡／生成」分組新增兩行：

```js
{ keys: ['L'], desc: '<b>一般生圖</b>——依「抽 LoRA 範圍」設定隨機抽 LoRA 塞進 LoRA1/2，直接對目前選取的詞庫生圖' },
{ keys: ['K'], desc: '<b>一般生圖</b>——跟 L 一樣，但只在 LoRA 大面板左欄目前的分類/子資料夾範圍內抽' },
```

## 功能二：使用說明面板

### 架構

沿用現有「快捷鍵一覽」疊層（`#shortcuts-overlay`、`openShortcuts()`/`closeShortcuts()`、`?` 鍵與 topbar 按鈕開關），**不新增疊層、不新增進入點**。改動：

1. 疊層標題從「快捷鍵」改成「使用說明」（`shortcuts-head` 裡的 `<h2>`）。
2. `shortcuts-panel` 內、`shortcuts-groups` 之上加一列分頁切換：`快捷鍵` / `功能總覽`，視覺沿用暗房既有「✦ 瀏覽 · 🏷 打標」頁內分段切換元件（`.seg`/`.seg-pill` 那一套，見 `darkroom.css`），不重新設計元件樣式。
3. `renderShortcuts()` 保留原邏輯渲染「快捷鍵」分頁；新增 `renderFeatures()` 依同樣的 DOM 結構（`.shortcut-group` / `.shortcut-row`，只是這裡沒有 `kbd` 鍵位、`shortcut-desc` 佔滿整列）渲染「功能總覽」分頁內容。
4. 分頁切換只是 `display` 兩個 group 容器，不重新整個疊層開關動畫。

### 內容：`FEATURE_GROUPS`

比照 `SHORTCUT_GROUPS` 的資料結構（`{ title, rows: [{ desc }] }`，沒有 `keys`），初稿分組：

- **瀏覽／打標**：收藏星號（hover 浮現、已收藏常亮）、稀有度標記（選取後點稀有度即時寫入）、資料夾搜尋、缺圖/已有篩選
- **生圖**：多選詞庫＋選 LoRA 生圖流程、LoRA 大面板（含 🎲 隨機瀏覽疊層）、雙 LoRA 疊加（LoRA1/LoRA2 兩格分頁卡）、**生成步數輸入框**（topbar 右側，範圍 1~150，即時套用到之後的生成）
- **抽卡**：一般抽卡（全庫/本分類）、Concepts 抽卡（角色×concepts 配對）、鎖定模板／鎖定 LoRA1-2
- **圖庫**：即時預覽生成中畫面、取消生圖（單批／全部）、大圖資訊（詞庫/LoRA/強度/觸發詞/seed）

具體文案在實作階段依現有功能逐條核對撰寫，此處只定分組與涵蓋範圍。

## 不做的事

- 不做「抽 LoRA 範圍」以外的抽卡個人化設定（例如強度隨機化），維持跟手動選 LoRA 一樣讀格子既有的 `strength`。
- 使用說明面板的「功能總覽」分頁純展示，不做搜尋/篩選——內容量遠小於詞庫搜尋，不需要。
- 不改動 Concepts 抽卡本身的行為或鍵位。

## 驗收方式

沒有測試框架，比照專案既有驗證手段：

- `node --check darkroom/darkroom.js` 語法檢查
- 用隔離的 `preview_ui.py` 實例＋Browser 工具手動操作：切換抽 LoRA 範圍設定、按 `L`/`K` 確認對應格子改變且不動到不該動的格、`SEL` 為空時的 toast、`SEL` 非空時真的送出生圖；開「使用說明」確認兩個分頁都能切換、內容正確渲染
