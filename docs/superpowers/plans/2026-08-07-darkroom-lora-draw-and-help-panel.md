# 暗房：一般生圖模式抽 LoRA ＋ 使用說明面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一般生圖模式新增 `L`/`K` 快捷鍵「抽 LoRA 直接生圖」；「快捷鍵一覽」疊層加分頁變成「使用說明」（快捷鍵／功能總覽）。

**Architecture:** 純前端改動，只動 `darkroom/index.html`、`darkroom/darkroom.js`、`darkroom/darkroom.css` 三個既有檔案，不新增檔案、不動後端。功能一完全靠既有 `runGen()` 讀取 `GEN_LORA_SLOTS` 這個解耦設計達成；功能二沿用既有 `.seg`/`.seg-pill` 分段切換元件與 `SHORTCUT_GROUPS`/`renderShortcuts()` 的資料驅動渲染模式，新增一份平行的 `FEATURE_GROUPS`/`renderFeatures()`。

**Tech Stack:** Vanilla JS（無建置步驟，改完存檔重整瀏覽器即生效）、原生 CSS（無預處理器）。

## Global Constraints

- 這是無建置步驟的純前端 vanilla JS 專案，不可引入框架、npm、打包工具（見 `CLAUDE.md`）。
- 沒有測試框架。驗證手段固定兩個：`node --check darkroom/darkroom.js`（語法檢查）＋用隔離的 `python darkroom/preview_ui.py --port <非預設埠> --no-open` 實例搭配瀏覽器工具手動操作驗證（`darkroom/preview_ui.py` 是獨立工具，見 `CLAUDE.md`「檔案職責」）。
- UI 文案、commit message、註解一律繁體中文；節點 ID／`class_type`／模型檔名保持原文。
- 每完成一項獨立改動就 commit；commit 之後要在 `進度.md` 最上方補一筆 `### YYYY-MM-DD HH:MM · <hash> <標題>`。
- 新增前端檔案要記得加進 `serve.py`/`preview_ui.py` 的白名單與版本化清單——本計畫沒有新增檔案，此條僅供提醒，不適用。
- 動效要用既有 token（`--dur-*`/`--ease-*`），本計畫沿用既有 `.seg-pill` 過渡樣式，不新增動畫。

---

## 現有邏輯速查（後續任務會用到，先列出來避免重複翻找）

- `runGen(rels, tarotItems, label)`（`darkroom.js` 約 2517 行）：`rels` 預設 `[...SEL]`；呼叫當下才讀 `GEN_LORA_SLOTS` 組 `loras` payload、讀 `genTriggerText()` 組觸發詞。**不用改這個函式**，抽 LoRA 跟送出生圖天然解耦。
- `GEN_LORA_SLOTS`（約 1410 行）：`[{ lora, strength, twPicks: Set }, { lora, strength, twPicks: Set }]`，`GEN_ACTIVE_SLOT` 記錄目前作用格（0 或 1）。
- `selectGenLora(l)`（約 1721 行）手動點選 LoRA 卡片時的預設邏輯：`const tw = l.trainedWords || []; const twPicks = new Set(); if (tw.length) twPicks.add(0);` 然後 `GEN_LORA_SLOTS[GEN_ACTIVE_SLOT] = { lora: l, strength: curSlot().strength, twPicks };`——新功能抽到 LoRA 時要套用同一套「預設勾第一段觸發詞」規則。
- `loraCatPool()`（約 1097 行）：`(GEN_LORAS || []).filter(l => (GEN_LORA_CAT === 'all' || l.category === GEN_LORA_CAT) && (!GEN_LORA_SUBFOLDER || l.folder === GEN_LORA_SUBFOLDER))`——LoRA 大面板左欄目前分類/子資料夾範圍內的池子。
- `loraCatLabel()`（約 1102 行）：回傳目前分類篩選的顯示字串，`null` 代表沒篩選（全部）。
- `fetchGenLoras()`（約 1460 行）：`async`，回傳快取的 `GEN_LORAS`（第一次呼叫才會 fetch `/api/loras`）。
- `renderGenCurrent()`（約 1745 行）：更新 genbar 上「選 LoRA」摘要按鈕文字＋呼叫 `updateConceptsLockLabel()`。**抽完 LoRA 一定要呼叫這個**，否則 UI 不會反映新選到的 LoRA。
- `toast(msg)`（約 1339 行）：顯示 2.6 秒的提示訊息。
- `isMobile()`（約 945 行）、`sampleN(arr, n)`（約 935 行，Fisher-Yates 洗牌取前 n 個）。
- 全域 `keydown` handler（約 825-925 行）：`R`/`E`/`C`/`X` 的判斷分支都在 904-920 行這段「全域：未開大圖/抽卡浮層、焦點不在輸入框時」區塊，新的 `L`/`K` 要插在這裡，同樣的 `!isTyping()` 守衛。
- Concepts 設定的 localStorage 持久化慣例（約 1432-1446 行）：`let X = localStorage.getItem('yz-key') === '1';` + `function setX(v){ X=v; localStorage.setItem('yz-key', v?'1':'0'); }`。
- `.seg`/`.seg-pill` 分段切換元件（`darkroom.css` 223-233 行）與其 JS 慣例（`darkroom.js` 660-707 行 `mode-seg`）：`.seg-pill` 用 `offsetWidth`/`offsetLeft` 算出目前 `.on` 按鈕的位置，`transform: translateX()` 定位；切換時對按鈕群組 `classList.toggle('on', ...)` 後呼叫算位置的函式。

---

### Task 1: 抽 LoRA 範圍設定（狀態 + UI + persistence）

**Files:**
- Modify: `darkroom/index.html`（Concepts 設定面板內新增一列，緊接在 `cs-tpl-cur-folder` checkbox 之後、`cs-tpl-lock` div 之前，約第 78 行）
- Modify: `darkroom/darkroom.js`（新增狀態變數與 setter，靠近既有 Concepts 設定變數，約第 1436 行之後；新增 DOM 綁定，靠近既有 `$csTplCurFolder` 綁定，約第 2266、2285 行）

**Interfaces:**
- Produces: `let GEN_LORA_DRAW_SCOPE`（值為 `'both'` 或 `'active'`，預設 `'active'`）、`function setGenLoraDrawScope(v)`——Task 2 會讀 `GEN_LORA_DRAW_SCOPE` 決定要重抽幾格。

- [ ] **Step 1: 在 index.html 加設定面板的 UI**

在 `darkroom/index.html` 第 77-78 行之間（`cs-tpl-cur-folder` 那個 `</label>` 之後、`<!-- 鎖定一個固定模板...` 註解之前）插入：

```html
      <div class="cs-row cs-row-check cs-row-radio">
        <span>🎲 抽 LoRA 範圍（快捷鍵 L／K）</span>
        <label><input type="radio" name="cs-lora-scope" id="cs-lora-scope-both" value="both">兩格都抽</label>
        <label><input type="radio" name="cs-lora-scope" id="cs-lora-scope-active" value="active">只抽目前作用格</label>
      </div>
```

- [ ] **Step 2: 在 darkroom.css 補上 `.cs-row-radio` 的排版**

`.cs-row-check` 原本假設只有一個 `<span>` + 一個 `<input>`（`darkroom.css` 686-688 行），這裡是「一個說明文字 + 兩個 radio label」，直接沿用會擠成一行擠不下。在 `darkroom.css` 688 行（`.cs-row-check input { ... }` 那行）之後加：

```css
.cs-row-radio { flex-direction: column; align-items: flex-start; gap: 4px; cursor: default; }
.cs-row-radio > span:first-child { width: auto; }
.cs-row-radio label { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dim); cursor: pointer; }
.cs-row-radio label:hover { color: var(--ink); }
.cs-row-radio input { accent-color: var(--amber); }
```

- [ ] **Step 3: 在 darkroom.js 加狀態變數與 setter**

在 `darkroom.js` 第 1436 行（`let CONCEPTS_TPL_CUR_FOLDER = localStorage.getItem('yz-concepts-tpl-cur-folder') === '1';`）之後加一行，並在 1444-1447 行（`setConceptsTplCurFolder` 函式結束）之後加：

```js
let GEN_LORA_DRAW_SCOPE = localStorage.getItem('yz-lora-draw-scope') === 'both' ? 'both' : 'active';
function setGenLoraDrawScope(v) {
  GEN_LORA_DRAW_SCOPE = v === 'both' ? 'both' : 'active';
  localStorage.setItem('yz-lora-draw-scope', GEN_LORA_DRAW_SCOPE);
}
```

- [ ] **Step 4: 綁定 radio 到狀態，載入時同步 checked**

在 `darkroom.js` 第 2266 行（`$csTplCurFolder.checked = CONCEPTS_TPL_CUR_FOLDER;`）之後加初始化，並在 2285 行（`$csTplCurFolder.addEventListener(...)`）之後加事件綁定：

```js
const $csLoraScopeBoth = $('cs-lora-scope-both'), $csLoraScopeActive = $('cs-lora-scope-active');
$csLoraScopeBoth.checked = GEN_LORA_DRAW_SCOPE === 'both';
$csLoraScopeActive.checked = GEN_LORA_DRAW_SCOPE === 'active';
$csLoraScopeBoth.addEventListener('change', () => { if ($csLoraScopeBoth.checked) setGenLoraDrawScope('both'); });
$csLoraScopeActive.addEventListener('change', () => { if ($csLoraScopeActive.checked) setGenLoraDrawScope('active'); });
```

- [ ] **Step 5: 語法檢查**

Run: `node --check darkroom/darkroom.js`
Expected: 無輸出（exit code 0）

- [ ] **Step 6: 手動驗證**

用隔離埠啟動（跟本次對話排查 bug 用的方式一樣，避免佔用使用者正在跑的 7801/8188）：

```bash
python darkroom/preview_ui.py --port 8903 --no-open
```

用瀏覽器工具開 `http://127.0.0.1:8903/`，執行以下 JS 確認狀態與 DOM 同步、且能持久化：

```js
document.getElementById('concepts-settings-btn').click();
document.getElementById('cs-lora-scope-both').click();
JSON.stringify({ scope: GEN_LORA_DRAW_SCOPE, stored: localStorage.getItem('yz-lora-draw-scope'), bothChecked: document.getElementById('cs-lora-scope-both').checked });
// 預期：{"scope":"both","stored":"both","bothChecked":true}
```

驗證完用 PowerShell/Bash 依 PID 關掉這個測試用的 preview_ui.py 行程（比照本次對話排查 bug 時的收尾方式）。

- [ ] **Step 7: Commit**

```bash
git add darkroom/index.html darkroom/darkroom.css darkroom/darkroom.js
git commit -m "$(cat <<'EOF'
Concepts 設定新增「抽 LoRA 範圍」開關，供功能一使用

一般生圖模式的一鍵抽 LoRA（下個 commit）需要知道要重抽 LoRA1/2
兩格還是只抽目前作用格，這裡先把設定跟持久化準備好，比照既有
Concepts 設定（yz-concepts-tpl 等）的 localStorage 慣例。
EOF
)"
```

---

### Task 2: 抽 LoRA 核心函式 + `L`/`K` 快捷鍵

**Files:**
- Modify: `darkroom/darkroom.js`（新增函式，放在 `loraCatPool()`/`loraCatLabel()` 附近，約第 1106 行之後；新增 keydown 分支，約第 906-908 行之間）

**Interfaces:**
- Consumes: `GEN_LORA_DRAW_SCOPE`（Task 1）、`GEN_LORA_SLOTS`／`GEN_ACTIVE_SLOT`／`curSlot()`／`otherSlotIndex()`（既有）、`loraCatPool()`／`loraCatLabel()`／`fetchGenLoras()`／`renderGenCurrent()`／`runGen()`／`toast()`／`sampleN()`（既有）、`SEL`（既有多選詞庫 Set）。
- Produces: `function drawGenLoraSlots(pool, label)`、`function drawGenLoraDispatch()`、`function drawGenLoraCategoryDispatch()`——Task 3 的快捷鍵說明文字會引用這兩個 dispatch 函式的行為描述（不是函式本身）。

- [ ] **Step 1: 寫核心函式**

在 `darkroom.js` 第 1106 行（`function drawLoraCategoryDispatch() { drawLoraTarot(loraCatPool(), loraCatLabel()); }`）之後插入：

```js
// 一般生圖模式的「一鍵抽 LoRA」：跟 LoRA 隨機瀏覽（🎲 疊層，要點卡片選）不同層級——
// 這裡是抽完直接套用、直接對目前選取的詞庫送出生圖，比照 Concepts C/X 鍵的操作體感。
// 抽幾格看 GEN_LORA_DRAW_SCOPE：'both' 兩格都重抽（不判斷原本有沒有手動選，字面上就是
// 兩格都換掉——這裡沒有 Concepts 那種 Character/concepts 角色區分，沒有「鎖定」的語意可
// 套用）；'active' 只重抽 GEN_ACTIVE_SLOT 指到的那一格，另一格完全不動。
function drawGenLoraSlots(pool, label) {
  if (!pool.length) { toast(label ? `「${label}」沒有 LoRA 可抽` : '目前沒有 LoRA 可抽'); return; }
  const indices = GEN_LORA_DRAW_SCOPE === 'both' ? [0, 1] : [GEN_ACTIVE_SLOT];
  // 兩格都抽時各自獨立取樣、允許抽到同一顆（機率極低且沒有語意上的問題，不特別排除，
  // 跟 Concepts 抽卡的 Character／concepts 兩側各自獨立隨機同一套邏輯）。
  indices.forEach((i) => {
    const l = pool[Math.floor(Math.random() * pool.length)];
    const tw = l.trainedWords || [];
    const twPicks = new Set();
    if (tw.length) twPicks.add(0);   // 預設勾第一段觸發詞，跟 selectGenLora() 手動點選同一套規則
    GEN_LORA_SLOTS[i] = { lora: l, strength: GEN_LORA_SLOTS[i].strength, twPicks };
  });
  renderGenCurrent();
  if (!SEL.size) { toast('已抽到 LoRA，請先選要生成的詞庫再生圖'); return; }
  runGen();
}
function drawGenLoraDispatch() {
  fetchGenLoras().then((loras) => drawGenLoraSlots(loras, null));
}
function drawGenLoraCategoryDispatch() {
  fetchGenLoras().then(() => drawGenLoraSlots(loraCatPool(), loraCatLabel()));
}
```

- [ ] **Step 2: 加 `L`/`K` 快捷鍵分支**

在 `darkroom.js` 第 906-908 行這段（`E` 鍵分支）之後插入（維持同樣的 `!isTyping()` 守衛；只在生圖模式有意義，比照 `E` 鍵已經用 `MODE === 'gen'` 限定範圍的寫法）：

```js
  // L：一般生圖模式一鍵抽 LoRA（全庫）＋直接生圖，跟 R/E 對詞庫的「全庫／本分類」
  // 配對邏輯一致，只是抽的對象換成 LoRA。只在生圖模式有意義。
  if ((e.key === 'l' || e.key === 'L') && !isTyping() && MODE === 'gen') {
    e.preventDefault(); drawGenLoraDispatch(); return;
  }
  // K：跟 L 一樣，但只在 LoRA 大面板左欄目前的分類/子資料夾範圍內抽。
  if ((e.key === 'k' || e.key === 'K') && !isTyping() && MODE === 'gen') {
    e.preventDefault(); drawGenLoraCategoryDispatch(); return;
  }
```

- [ ] **Step 3: 語法檢查**

Run: `node --check darkroom/darkroom.js`
Expected: 無輸出（exit code 0）

- [ ] **Step 4: 手動驗證**

沿用 Task 1 Step 6 起的隔離實例（`--port 8903`）。在瀏覽器工具裡執行：

```js
(function(){
  // 切到生圖模式、選一個詞庫、設定成「只抽目前作用格」
  switchMode('gen');
  SEL.add(ALL[0].rel);
  setGenLoraDrawScope('active');
  GEN_LORA_SLOTS[1] = { lora: { folder: 'x', file: 'y.safetensors', title: '占位', trainedWords: [] }, strength: 0.8, twPicks: new Set() };
  const before1 = GEN_LORA_SLOTS[1].lora.file;
  return fetchGenLoras().then(loras => {
    if (!loras.length) return 'GEN_LORAS 是空的，換一顆真的有 LoRA 的環境測';
    drawGenLoraSlots(loras, null);
    return JSON.stringify({ slot0: GEN_LORA_SLOTS[0].lora && GEN_LORA_SLOTS[0].lora.file, slot1Unchanged: GEN_LORA_SLOTS[1].lora.file === before1 });
  });
})();
// 預期：slot0 變成隨機抽到的某個 LoRA 檔名；slot1Unchanged 為 true（'active' 範圍不該動到 slot1）
```

再測 `SEL` 為空時只抽不生圖（改用 toast 訊息判斷）：

```js
(function(){
  SEL.clear();
  let toastMsg = null;
  const origToast = toast;
  toast = (m) => { toastMsg = m; origToast(m); };
  return fetchGenLoras().then(loras => {
    drawGenLoraSlots(loras, null);
    toast = origToast;
    return toastMsg;
  });
})();
// 預期輸出包含「已抽到 LoRA，請先選要生成的詞庫再生圖」
```

驗證完關掉測試用的 preview_ui.py 行程。

- [ ] **Step 5: Commit**

```bash
git add darkroom/darkroom.js
git commit -m "$(cat <<'EOF'
一般生圖模式新增 L/K 快捷鍵：一鍵抽 LoRA 直接生圖

Concepts 抽卡的 C/X 鍵可以「按一下就抽好套上直接生圖」，但一般生圖
模式（手動選 LoRA1/2）只有 LoRA 大面板的 🎲 隨機瀏覽，還是得點卡片
選，操作層級不一樣。runGen() 本來就是呼叫當下才讀 GEN_LORA_SLOTS，
抽 LoRA 跟送出生圖天然解耦，新功能不用碰 runGen() 或後端，純粹是
隨機挑 LoRA 寫進 slot(s) 再呼叫既有的 runGen()。

L 全庫抽、K 只在 LoRA 大面板左欄目前分類/子資料夾範圍內抽，比照
R/E、C/X 既有的「全庫／本分類」配對慣例。抽幾格看 Concepts 設定
面板新增的「抽 LoRA 範圍」開關（上個 commit）。
EOF
)"
```

---

### Task 3: 快捷鍵一覽補上 `L`/`K` 說明

**Files:**
- Modify: `darkroom/darkroom.js`（`SHORTCUT_GROUPS` 的「抽卡／生成」分組，約第 1966-1972 行）

**Interfaces:**
- Consumes: `SHORTCUT_GROUPS` 陣列結構（既有）。

- [ ] **Step 1: 加兩行**

在 `darkroom.js` 第 1971 行（`{ keys: ['X'], desc: ... }` 那行）之後、`]},`（第 1972 行）之前插入：

```js
    { keys: ['L'], desc: '<b>一般生圖模式</b>——依「抽 LoRA 範圍」設定隨機抽 LoRA 塞進 LoRA1/2，直接對目前選取的詞庫生圖' },
    { keys: ['K'], desc: '<b>一般生圖模式</b>——跟 L 一樣，但只在 LoRA 大面板左欄目前的分類/子資料夾範圍內抽' },
```

- [ ] **Step 2: 語法檢查**

Run: `node --check darkroom/darkroom.js`
Expected: 無輸出（exit code 0）

- [ ] **Step 3: 手動驗證**

隔離實例開起來，瀏覽器工具執行：

```js
openShortcuts();
[...document.querySelectorAll('.shortcut-row')].map(r => r.querySelector('.shortcut-keys').textContent).filter(k => k === 'L' || k === 'K');
// 預期輸出 ["L", "K"]
```

- [ ] **Step 4: Commit**

```bash
git add darkroom/darkroom.js
git commit -m "快捷鍵一覽補上 L/K（一般生圖模式一鍵抽 LoRA）的說明"
```

---

### Task 4: 使用說明面板——分頁殼

**Files:**
- Modify: `darkroom/index.html`（`shortcuts-panel` 結構，約第 113-125 行）
- Modify: `darkroom/darkroom.js`（分頁切換邏輯，靠近既有 `renderShortcuts()`/`openShortcuts()`，約第 1988-2009 行）

**Interfaces:**
- Consumes: `.seg`/`.seg-pill` CSS（既有，`darkroom.css` 223-233 行）。
- Produces: `#help-seg` 分頁按鈕（`data-tab="shortcuts"`／`data-tab="features"`）、`#shortcuts-groups`（既有 id，內容不變）、新增 `#feature-groups` 容器——Task 5 的 `renderFeatures()` 會把內容渲染進 `#feature-groups`。

- [ ] **Step 1: 改 index.html 結構**

把 `darkroom/index.html` 第 113-125 行整段換成：

```html
<!-- 使用說明：按 ? 或 topbar ⌨ 鈕開。純展示，不影響任何狀態，Esc／點背景關閉。
     分兩頁：快捷鍵（照使用情境分組，不是照字母排，使用者記的是「我在做什麼時按什麼」
     而不是「這個鍵是什麼」）／功能總覽（滑鼠驅動、容易被忽略的功能，例如生成步數輸入
     框——這個分頁存在的起因）。兩頁共用同一個疊層外觀、同一組開關方式，不新增按鈕。 -->
<div class="shortcuts-overlay" id="shortcuts-overlay">
  <div class="shortcuts-panel" id="shortcuts-panel">
    <button class="shortcuts-close" id="shortcuts-close" aria-label="關閉 (Esc)" title="關閉 (Esc)">✕</button>
    <div class="shortcuts-head">
      <span class="shortcuts-emblem">⌨</span>
      <div>
        <h2>使用說明</h2>
        <p>焦點不在輸入框、沒有其他疊層開著時皆可使用</p>
      </div>
    </div>
    <div class="seg help-seg" id="help-seg" role="group" aria-label="說明分頁">
      <span class="seg-pill" id="help-pill" aria-hidden="true"></span>
      <button data-tab="shortcuts" class="on">快捷鍵</button>
      <button data-tab="features">功能總覽</button>
    </div>
    <div class="shortcuts-groups" id="shortcuts-groups"></div>
    <div class="shortcuts-groups" id="feature-groups" hidden></div>
  </div>
</div>
```

- [ ] **Step 2: 補 `.help-seg` 排版**（`.seg` 本身是 inline-flex，疊層裡要獨佔一行、跟上下內容留間距）

在 `darkroom.css` 第 1126 行（`.shortcuts-groups { ... }`）之前加：

```css
.help-seg { margin-bottom: 18px; }
```

- [ ] **Step 3: 寫分頁切換邏輯**

在 `darkroom.js` 第 2004 行（`renderShortcuts()` 函式結束的 `}`）之後、`function openShortcuts() {`（第 2005 行）之前插入分頁切換函式，並修改 `openShortcuts()` 加上初始 pill 定位：

```js
function moveHelpPill() {
  const seg = $('help-seg'), pill = $('help-pill');
  const active = seg && seg.querySelector('button.on');
  if (!active || !pill) return;
  pill.style.width = active.offsetWidth + 'px';
  pill.style.transform = `translateX(${active.offsetLeft}px)`;
}
$('help-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  $('help-seg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
  moveHelpPill();
  $('shortcuts-groups').hidden = btn.dataset.tab !== 'shortcuts';
  $('feature-groups').hidden = btn.dataset.tab !== 'features';
});
```

然後把既有 `function openShortcuts() { renderShortcuts(); $('shortcuts-overlay').classList.add('open'); }`（第 2005-2008 行）改成：

```js
function openShortcuts() {
  renderShortcuts();
  $('shortcuts-overlay').classList.add('open');
  moveHelpPill();
}
```

- [ ] **Step 4: 語法檢查**

Run: `node --check darkroom/darkroom.js`
Expected: 無輸出（exit code 0）

- [ ] **Step 5: 手動驗證**

隔離實例開起來，瀏覽器工具執行：

```js
openShortcuts();
document.querySelector('[data-tab="features"]').click();
JSON.stringify({
  groupsHidden: document.getElementById('shortcuts-groups').hidden,
  featuresHidden: document.getElementById('feature-groups').hidden,
  pillTransform: document.getElementById('help-pill').style.transform,
});
// 預期：{"groupsHidden":true,"featuresHidden":false,"pillTransform":"translateX(...)"}（非 0px，因為切到第二個按鈕）
```

- [ ] **Step 6: Commit**

```bash
git add darkroom/index.html darkroom/darkroom.css darkroom/darkroom.js
git commit -m "$(cat <<'EOF'
快捷鍵一覽疊層加分頁，改名「使用說明」

暗房有不少滑鼠驅動的功能（收藏星號、稀有度標記、生成步數輸入框…）
沒有任何地方統一介紹，這次事件的起因就是使用者不知道右上角步數
輸入框早就能調，以為鎖 25。這個 commit 先把疊層改成「快捷鍵／功能
總覽」兩分頁的殼，沿用既有 .seg/.seg-pill 分段切換元件（跟頂列
「✦瀏覽・🏷打標」同一套視覺語言），不新增按鈕、不新增疊層樣式。
功能總覽分頁的實際內容留給下一個 commit。
EOF
)"
```

---

### Task 5: `FEATURE_GROUPS` 資料 + `renderFeatures()`

**Files:**
- Modify: `darkroom/darkroom.js`（新增資料與渲染函式，放在 `SHORTCUT_GROUPS`/`renderShortcuts()` 之後，約第 1987 行之後；`openShortcuts()` 要呼叫 `renderFeatures()`）
- Modify: `darkroom/darkroom.css`（`.shortcut-row` 目前假設一定有 `.shortcut-keys` 佔 108px，功能總覽的列沒有鍵位，要補一個沒有 keys 欄位時的樣式）

**Interfaces:**
- Consumes: `.shortcut-group`/`.shortcut-row`/`.shortcut-desc` CSS 類別（既有）、`#feature-groups` 容器（Task 4 產生）。
- Produces: `function renderFeatures()`——`openShortcuts()` 呼叫。

- [ ] **Step 1: 定義 `FEATURE_GROUPS` 資料**

在 `darkroom.js` 第 1987 行（`SHORTCUT_GROUPS` 陣列結束的 `];`）之後插入：

```js
// 「功能總覽」分頁：跟 SHORTCUT_GROUPS 同一種分組資料結構，但這裡列的是滑鼠/UI 驅動的
// 功能（沒有鍵位可標），內容固定不會變，只在第一次切到這頁時建 DOM（見 renderFeatures）。
const FEATURE_GROUPS = [
  { title: '瀏覽／打標', rows: [
    { desc: '<b>收藏</b>——縮圖右上角星號，點一下收藏（金色實心星常駐），再點取消；桌面平常隱藏、hover 卡片才浮現' },
    { desc: '<b>稀有度標記</b>——打標模式選取縮圖，下方點稀有度即時寫入（含「移除標記」），選取自動清空可接著標下一批' },
    { desc: '<b>資料夾搜尋</b>——左側導覽列上方的搜尋框，即時篩選資料夾清單' },
    { desc: '<b>缺圖／已有篩選</b>——主區右上「全部／缺圖／已有」分段，只看還沒生預覽圖或已經有的詞庫' },
  ]},
  { title: '生圖', rows: [
    { desc: '<b>多選詞庫＋選 LoRA 生圖</b>——瀏覽格線點縮圖多選，右上「選 LoRA」開大面板挑 LoRA，genbar 按「生圖」送出' },
    { desc: '<b>LoRA 大面板</b>——左欄分類/子資料夾篩選＋搜尋＋翻頁，右欄每段觸發詞各自一張完整文字卡（勾選要用哪幾段）＋強度滑桿＋參考圖；左欄下方「🎲 隨機瀏覽」疊一批塔羅卡讓你點選' },
    { desc: '<b>雙 LoRA 疊加</b>——右欄「LoRA 1／LoRA 2」兩張分頁卡各自獨立選擇與強度，可疊加使用' },
    { desc: '<b>生成步數輸入框</b>——topbar 右側，範圍 1～150，即時套用到之後的生成（不是鎖 25，25 只是預設值）' },
  ]},
  { title: '抽卡', rows: [
    { desc: '<b>一般抽卡</b>——R 全庫、E 本分類，瀏覽模式看圖、打標模式逐張標稀有度、生圖模式隨機生圖' },
    { desc: '<b>Concepts 抽卡</b>——C／X 鍵，每張卡隨機配對一顆 Character LoRA＋一顆 concepts LoRA 直接生圖，強度／張數／是否同時抽詞庫模板在齒輪設定裡調' },
    { desc: '<b>鎖定模板／鎖定 LoRA</b>——Concepts 設定裡搜尋鎖定固定模板；LoRA1/2 面板選好某個 Character 或 concepts 分類的 LoRA 就自動視為鎖定那一側' },
  ]},
  { title: '圖庫', rows: [
    { desc: '<b>即時預覽</b>——生成中的卡片直接顯示採樣過程畫面，不用等完成才看得到' },
    { desc: '<b>取消生圖</b>——塔羅疊層上取消當批；圖庫左上「取消全部」一次停掉所有還在跑的' },
    { desc: '<b>大圖資訊</b>——點圖庫縮圖看大圖，附詞庫／資料夾／LoRA／強度／觸發詞／seed／生成時間' },
  ]},
];
function renderFeatures() {
  const box = $('feature-groups'); if (!box || box.children.length) return;   // 只建一次
  FEATURE_GROUPS.forEach((group, gi) => {
    const g = document.createElement('div'); g.className = 'shortcut-group';
    g.style.setProperty('--i', gi);
    const h = document.createElement('h3'); h.textContent = group.title; g.appendChild(h);
    group.rows.forEach(row => {
      const r = document.createElement('div'); r.className = 'shortcut-row no-keys';
      const desc = document.createElement('div'); desc.className = 'shortcut-desc'; desc.innerHTML = row.desc;
      r.appendChild(desc);
      g.appendChild(r);
    });
    box.appendChild(g);
  });
}
```

- [ ] **Step 2: 補 `.shortcut-row.no-keys` 樣式**（原本 `.shortcut-row` 是 `display:flex` 假設兩個子元素 `.shortcut-keys` + `.shortcut-desc`，這裡只有一個 `.shortcut-desc`，flex 預設行為已經沒問題，但手機版 media query 第 1144-1145 行針對 `.shortcut-row`/`.shortcut-keys` 的樣式對只有一個子元素的情況是安全的 no-op，不用特別排除，只需確認桌面版不會意外壓縮寬度）

在 `darkroom.css` 第 1136 行（`.shortcut-desc { ... }`）之後加：

```css
.shortcut-row.no-keys .shortcut-desc { flex: 1; }
```

- [ ] **Step 3: 讓 `openShortcuts()` 也渲染功能總覽**

把 Task 4 Step 3 改過的 `openShortcuts()`（`darkroom.js`）再改一次：

```js
function openShortcuts() {
  renderShortcuts();
  renderFeatures();
  $('shortcuts-overlay').classList.add('open');
  moveHelpPill();
}
```

- [ ] **Step 4: 語法檢查**

Run: `node --check darkroom/darkroom.js`
Expected: 無輸出（exit code 0）

- [ ] **Step 5: 手動驗證**

隔離實例開起來，瀏覽器工具執行：

```js
openShortcuts();
document.querySelector('[data-tab="features"]').click();
JSON.stringify({
  groupCount: document.querySelectorAll('#feature-groups .shortcut-group').length,
  rowCount: document.querySelectorAll('#feature-groups .shortcut-row').length,
  firstDesc: document.querySelector('#feature-groups .shortcut-desc').textContent.slice(0, 20),
});
// 預期：groupCount 4、rowCount 14（4+4+3+3）、firstDesc 以「收藏」開頭
```

再切回快捷鍵分頁確認沒壞：

```js
document.querySelector('[data-tab="shortcuts"]').click();
JSON.stringify({ shortcutsHidden: document.getElementById('shortcuts-groups').hidden, rowCount: document.querySelectorAll('#shortcuts-groups .shortcut-row').length });
// 預期：shortcutsHidden false、rowCount 大於 0（含 Task 3 新加的 L/K 兩行）
```

驗證完關掉測試用的 preview_ui.py 行程。

- [ ] **Step 6: Commit**

```bash
git add darkroom/darkroom.js darkroom/darkroom.css
git commit -m "$(cat <<'EOF'
使用說明面板：功能總覽分頁填入內容

FEATURE_GROUPS 比照 SHORTCUT_GROUPS 同一種資料結構，分四組列出
滑鼠/UI 驅動的功能：瀏覽／打標、生圖、抽卡、圖庫。內容涵蓋容易被
忽略的既有功能，尤其是這次事件的起因——topbar 右側的生成步數輸入
框，範圍 1~150 早就能調，不是鎖 25。
EOF
)"
```

- [ ] **Step 7: 更新 README.md 與進度.md**

`README.md` 描述使用者可見功能，這次新增了 `L`/`K` 快捷鍵與使用說明面板兩個使用者可見的東西，要照 `CLAUDE.md` 慣例同步更新（找 README 裡描述暗房快捷鍵/使用說明的段落，補上這兩點；沒有現成段落就在暗房功能描述區塊補一句）。

在 `進度.md` 最上方補一筆，把 Task 1-6 的五個 commit hash 依序列出（`git log --oneline -6` 取得），格式沿用既有慣例：

```markdown
### 2026-08-07 · `<hash5>` 使用說明面板：功能總覽分頁填入內容
### 2026-08-07 · `<hash4>` 快捷鍵一覽疊層加分頁，改名「使用說明」
### 2026-08-07 · `<hash3>` 快捷鍵一覽補上 L/K（一般生圖模式一鍵抽 LoRA）的說明
### 2026-08-07 · `<hash2>` 一般生圖模式新增 L/K 快捷鍵：一鍵抽 LoRA 直接生圖
### 2026-08-07 · `<hash1>` Concepts 設定新增「抽 LoRA 範圍」開關，供功能一使用
```

（實際可以合併成更少條目，只要涵蓋這五個 commit 做了什麼、為什麼——不用五條各自獨立，重點是接手的人看得懂整個功能是怎麼疊出來的。）

```bash
git add README.md 進度.md
git commit -m "README/進度.md：補上 L/K 抽LoRA、使用說明面板的紀錄"
git push
```

---

## Self-Review 對照表（spec → task）

- 功能一 · 快捷鍵 `L`/`K` → Task 2
- 功能一 · 抽幾格設定（開關、預設 `active`、`both`/`active` 語意）→ Task 1
- 功能一 · `SEL` 為空的 toast 邊界情況 → Task 2 Step 1（`drawGenLoraSlots`）
- 功能一 · 觸發詞段落預設勾第一段 → Task 2 Step 1
- 功能一 · 快捷鍵一覽補充 → Task 3
- 功能二 · 疊層標題改名、分頁殼、沿用 `.seg` → Task 4
- 功能二 · `FEATURE_GROUPS` 四個分組內容（含步數輸入框）→ Task 5
- 「不做的事」（不做強度隨機化、功能總覽不做搜尋、不改 Concepts 鍵位）→ 本計畫全程沒有觸碰這些範圍，符合
