# 暗房：LoRA1/LoRA2 各自獨立抽取範圍 ＋ 設定彈窗兩分頁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LoRA1、LoRA2 各自獨立記住自己的分類/子資料夾抽取範圍（`K` 鍵據此抽取）；齒輪 ⚙ 設定彈窗拆成「一般」（L/K 範圍設定）／「Concepts」（原本內容）兩分頁，一般分頁新增 LoRA1/LoRA2 兩組範圍下拉，跟大面板左欄晶片雙向同步。

**Architecture:** 把目前全域共用的 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER` 兩個變數整個拿掉，改成 `GEN_LORA_SLOT_SCOPE`（以格為索引的陣列）+ `curScope()`（回傳目前作用格那份物件）當唯一讀寫入口。所有既有讀寫點（左欄晶片渲染與點擊、`loraCatPool()`/`loraCatLabel()`、Concepts `X` 鍵、三處切換作用格）改成透過 `curScope()` 或直接操作 `GEN_LORA_SLOT_SCOPE[i]`。因為不再有「全域目前值」與「每格快照」兩份資料，任何地方讀寫都指向同一份物件，不需要手動同步。設定彈窗的兩組下拉直接讀寫 `GEN_LORA_SLOT_SCOPE[0]`/`[1]`，改到作用格那組時重繪左欄晶片，晶片被點擊時重繪設定彈窗下拉，達成雙向同步。分頁殼沿用上一輪「使用說明」疊層已驗證過的 `.seg`/`.seg-pill` 模式。

**Tech Stack:** Vanilla JS（無建置步驟，改完存檔重整瀏覽器即生效）、原生 CSS（無預處理器）。

## Global Constraints

- 這是無建置步驟的純前端 vanilla JS 專案，不可引入框架、npm、打包工具（見 `CLAUDE.md`）。
- 沒有測試框架。驗證手段固定兩個：`node --check darkroom/darkroom.js`（語法檢查）＋用隔離埠的 `python darkroom/preview_ui.py --port <非預設埠> --no-open` 實例搭配瀏覽器工具手動操作驗證。
- UI 文案、commit message、註解一律繁體中文。
- **任何「用 `hidden` 屬性切換顯示/隱藏」的元素，如果它的 CSS class 本身是 `display:flex`（或其他非 `block` 的值），一定要額外加 `.該class[hidden] { display: none; }`**——author-origin 的 `display:flex` 會蓋掉 UA-origin 的 `[hidden]{display:none}`，這是上一輪最終審查抓到的真實 bug（`.shortcuts-groups[hidden]`），這次的 `.cs-tab-panel` 從一開始就要加對。
- 每完成一項獨立改動就 commit；commit 之後要在 `進度.md` 最上方補一筆 `### YYYY-MM-DD HH:MM · <hash> <標題>`。
- 手動驗證一律用隔離埠的 `preview_ui.py` 測試實例，驗證完要找到並停掉該測試行程，不得影響使用者可能正在跑的正式服務（預設埠 `7801`/`8188`）。
- `darkroom.js` 已經被前兩輪改動累積修改過，**下面每個程式碼片段旁邊都附了「怎麼找到插入點」的錨點文字（函式名稱、既有的完整程式碼行）**，implementer 要用這些錨點在檔案裡搜尋定位，不要依賴本文件寫的行號（行號僅供參考，可能已經偏移）。

---

## 現有程式碼速查（撰寫本計畫時的實際內容，供 implementer 核對錨點）

以下是目前 `darkroom/darkroom.js`/`darkroom/index.html` 裡跟本計畫直接相關的既有程式碼原文，每個任務會引用這裡的片段：

**`darkroom.js`，`GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER` 宣告：**
```js
let GEN_LORA_CAT = 'all';               // 目前選的頂層分類（見 renderLmCats）
let GEN_LORA_SUBFOLDER = '';            // 目前選的子資料夾完整路徑，''＝該分類全部（見 renderLmSubcats）
```

**`darkroom.js`，`loraCatPool()`/`loraCatLabel()`：**
```js
function loraCatPool() {
  return (GEN_LORAS || []).filter(l =>
    (GEN_LORA_CAT === 'all' || l.category === GEN_LORA_CAT) &&
    (!GEN_LORA_SUBFOLDER || l.folder === GEN_LORA_SUBFOLDER));
}
function loraCatLabel() {
  if (GEN_LORA_SUBFOLDER) return GEN_LORA_SUBFOLDER === GEN_LORA_CAT ? GEN_LORA_CAT : GEN_LORA_SUBFOLDER;
  return GEN_LORA_CAT === 'all' ? null : GEN_LORA_CAT;
}
```

**`darkroom.js`，`renderLmCats()`：**
```js
function renderLmCats() {
  const box = $('lm-cats'); if (!box) return;
  const items = GEN_LORAS || [];
  const counts = {};
  for (const l of items) counts[l.category] = (counts[l.category] || 0) + 1;
  const folders = Object.keys(counts).sort();
  box.innerHTML = '';
  const mk = (key, label, n) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'lm-cat' + (GEN_LORA_CAT === key ? ' on' : '');
    const lb = document.createElement('span'); lb.textContent = label;
    const nb = document.createElement('span'); nb.className = 'lm-cat-n'; nb.textContent = n;
    b.append(lb, nb);
    b.addEventListener('click', () => {
      GEN_LORA_CAT = key;
      GEN_LORA_SUBFOLDER = '';   // 換頂層分類，子資料夾篩選跟著清掉——上次選的子資料夾對新分類沒意義
      renderLmCats(); renderLmSubcats(); renderLmList($('lm-search').value, true);
    });
    box.appendChild(b);
  };
  mk('all', '全部', items.length);
  folders.forEach(f => mk(f, f, counts[f]));
}
```

**`darkroom.js`，`renderLmSubcats()`：**
```js
function renderLmSubcats() {
  const box = $('lm-subcats'); if (!box) return;
  box.innerHTML = '';
  if (GEN_LORA_CAT === 'all') return;
  const items = (GEN_LORAS || []).filter(l => l.category === GEN_LORA_CAT);
  const counts = {};
  for (const l of items) counts[l.folder] = (counts[l.folder] || 0) + 1;
  const subfolders = Object.keys(counts).sort();
  if (subfolders.length <= 1) return;   // 沒有子資料夾可挑，不用出現一顆「全部」孤零零杵著
  const mk = (key, label, n) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'lm-subcat' + (GEN_LORA_SUBFOLDER === key ? ' on' : '');
    const lb = document.createElement('span'); lb.textContent = label;
    const nb = document.createElement('span'); nb.className = 'lm-subcat-n'; nb.textContent = n;
    b.append(lb, nb);
    b.addEventListener('click', () => {
      GEN_LORA_SUBFOLDER = key;
      renderLmSubcats(); renderLmList($('lm-search').value, true);
    });
    box.appendChild(b);
  };
  mk('', '全部', items.length);
  subfolders.forEach(f => {
    // f === GEN_LORA_CAT：直接放在分類頂層、沒再分子資料夾的那些；其餘去掉「分類/」前綴只顯示子資料夾名
    const label = f === GEN_LORA_CAT ? '(根目錄)' : f.slice(GEN_LORA_CAT.length + 1);
    mk(f, label, counts[f]);
  });
}
```

**`darkroom.js`，`renderLmList()` 開頭的池篩選（大面板左欄清單本身，不是透過 `loraCatPool()`，是自己重複了一次同樣的篩選邏輯）：**
```js
function renderLmList(filter, resetPage) {
  const box = $('lm-list'); if (!box) return;
  if (resetPage) GEN_LORA_PAGE = 0;
  const q = (filter || '').toLowerCase().trim();
  let items = (GEN_LORAS || []).filter(l =>
    (GEN_LORA_CAT === 'all' || l.category === GEN_LORA_CAT) &&
    (!GEN_LORA_SUBFOLDER || l.folder === GEN_LORA_SUBFOLDER));
  ...
```

**兩處提到 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER` 的註解（不是程式碼，但改名之後這兩處會變成講錯變數名稱的過時註解，一併更新）：**

`loraCatPool()` 正上方：
```js
// LoRA 隨機瀏覽的「E 重抽本分類」：跟左欄篩選晶片（renderLmCats/renderLmSubcats）共用
// 同一套 GEN_LORA_CAT/GEN_LORA_SUBFOLDER 狀態，池子跟清單畫面看到的完全一致——不是另外
// 發明一套篩選邏輯，使用者選好分類/子資料夾再按 E，抽到的就是清單裡當下看得到的那些。
```

`drawConceptsTarotByCategory()` 正上方（X 鍵註解）：
```js
// X 鍵版本：跟 C 鍵一樣先看 LoRA1/2 有沒有鎖定（lockedCharacterSlot/lockedConceptSlot），
// 鎖定的那側直接用鎖定的 LoRA；沒鎖定的那側才改用 LoRA 大面板左欄目前停的分類/子資料夾
// 晶片（GEN_LORA_CAT/GEN_LORA_SUBFOLDER，跟隨機瀏覽 LoRA 的 E 鍵、loraCatPool() 同一套
// 狀態）縮小範圍。跟 C 鍵唯一的差別就是「沒鎖定那側的隨機池要不要先被分類晶片縮小」，
// 「鎖定」與「同時抽詞庫模板」開關這兩件事兩鍵完全一致、互相獨立——鎖定看 LoRA1/2，
// 模板看 CONCEPTS_WITH_TEMPLATE，跟你用 C 還是 X 抽無關。
```

**`darkroom.js`，Concepts `X` 鍵（`drawConceptsTarotByCategory()`）：**
```js
function drawConceptsTarotByCategory() {
  const lockedChar = lockedCharacterSlot(), lockedConcept = lockedConceptSlot();
  const cPool = lockedChar ? null : (GEN_LORA_CAT === 'Character' ? loraCatPool() : fullCharacterPool());
  const kPool = lockedConcept ? null : (GEN_LORA_CAT === 'HENTAI' ? loraCatPool() : fullConceptsPool());
  ...
```

**`darkroom.js`，`GEN_ACTIVE_SLOT` 宣告與三處賦值：**
```js
let GEN_ACTIVE_SLOT = 0;
```
```js
    tab.addEventListener('click', () => { hideLoraPreviewTip(); GEN_ACTIVE_SLOT = i; renderLmCurrent(); renderLmList($('lm-search').value); });
```
```js
      clear.addEventListener('click', (e) => {
        e.stopPropagation();
        GEN_LORA_SLOTS[i] = { lora: null, strength: slot.strength, twPicks: new Set() };
        GEN_ACTIVE_SLOT = i;
        renderGenCurrent(); renderLmCurrent(); renderLmList($('lm-search').value);
      });
```
```js
  const emptyIdx = GEN_LORA_SLOTS.findIndex(s => !s.lora);
  if (emptyIdx !== -1) GEN_ACTIVE_SLOT = emptyIdx;
  selectGenLora(match);
```

**`darkroom.js`，設定彈窗開關（`$csPanel`）：**
```js
const $csPanel = $('concepts-settings');
$('concepts-settings-btn').onclick = (e) => {
  e.stopPropagation();
  $csPanel.hidden = !$csPanel.hidden;
};
```

**`darkroom.js`，抽 LoRA 範圍單選初始化與綁定（上一輪已做好，保留不動）：**
```js
const $csLoraScopeBoth = $('cs-lora-scope-both'), $csLoraScopeActive = $('cs-lora-scope-active');
$csLoraScopeBoth.checked = GEN_LORA_DRAW_SCOPE === 'both';
$csLoraScopeActive.checked = GEN_LORA_DRAW_SCOPE === 'active';
```

**`darkroom/index.html`，`#concepts-settings` 整個彈窗（目前是單一容器，沒有分頁）：**
```html
<button class="ghost icon-btn" id="concepts-settings-btn" title="Concepts 抽卡設定：強度／張數／是否抽詞庫模板" aria-label="Concepts 抽卡設定">⚙</button>
<div class="concepts-settings" id="concepts-settings" hidden>
  <label class="cs-row">
    <span>Character 強度</span>
    <input type="range" id="cs-char-strength" min="0" max="1" step="0.05">
    <output id="cs-char-strength-out"></output>
  </label>
  <label class="cs-row">
    <span>concepts 強度</span>
    <input type="range" id="cs-key-strength" min="0" max="1" step="0.05">
    <output id="cs-key-strength-out"></output>
  </label>
  <label class="cs-row cs-row-count">
    <span>每次抽幾張</span>
    <input type="number" id="cs-count" min="1" max="24" step="1">
  </label>
  <label class="cs-row cs-row-check">
    <input type="checkbox" id="cs-tpl">
    <span>同時抽詞庫模板（不勾＝只用兩個 LoRA 的觸發詞）</span>
  </label>
  <label class="cs-row cs-row-check">
    <input type="checkbox" id="cs-tpl-cur-folder">
    <span>模板只抽左邊目前選中的資料夾（不勾＝從全部詞庫抽）</span>
  </label>
  <div class="cs-row cs-row-check cs-row-radio">
    <span>🎲 抽 LoRA 範圍（快捷鍵 L／K）</span>
    <label><input type="radio" name="cs-lora-scope" id="cs-lora-scope-both" value="both">兩格都抽</label>
    <label><input type="radio" name="cs-lora-scope" id="cs-lora-scope-active" value="active">只抽目前作用格</label>
  </div>
  <div class="cs-tpl-lock" id="cs-tpl-lock">
    <div class="cs-tpl-lock-current" id="cs-tpl-lock-current" hidden>
      <span id="cs-tpl-lock-name"></span>
      <button type="button" id="cs-tpl-lock-clear" title="取消鎖定模板" aria-label="取消鎖定模板">✕</button>
    </div>
    <input type="text" id="cs-tpl-search" placeholder="搜尋要鎖定的模板…" autocomplete="off">
    <div class="cs-tpl-results" id="cs-tpl-results"></div>
  </div>
</div>
```

**`darkroom/index.html`，「使用說明」疊層的兩分頁殼（上一輪已做好、驗證過，本計畫的分頁殼直接照抄這個模式）：**
```html
<div class="shortcuts-overlay" id="shortcuts-overlay">
  <div class="shortcuts-panel" id="shortcuts-panel">
    <button class="shortcuts-close" id="shortcuts-close" aria-label="關閉 (Esc)" title="關閉 (Esc)">✕</button>
    <div class="shortcuts-head">...</div>
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
```css
.shortcuts-groups[hidden] { display: none; }
```

---

### Task 1: `GEN_LORA_SLOT_SCOPE` 取代 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER`

**Files:**
- Modify: `darkroom/darkroom.js`（宣告改為陣列＋`curScope()`；`renderLmCats()`/`renderLmSubcats()`/`renderLmList()`/`loraCatPool()`/`loraCatLabel()`/Concepts `X` 鍵全部改讀寫 `curScope()`，另有兩處註解要同步更新）

**Interfaces:**
- Produces: `const GEN_LORA_SLOT_SCOPE`（`[{cat, subfolder}, {cat, subfolder}]`）、`function curScope()`（回傳 `GEN_LORA_SLOT_SCOPE[GEN_ACTIVE_SLOT]`）——Task 2、Task 3 都會用到。
- Consumes: 無（這是最底層的狀態改動，其他任務都疊在這個之上）。

- [ ] **Step 1: 用陣列狀態取代兩個全域變數**

搜尋「現有程式碼速查」裡的「`GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER` 宣告」那兩行，整段換成：

```js
const GEN_LORA_SLOT_SCOPE = [{ cat: 'all', subfolder: '' }, { cat: 'all', subfolder: '' }];  // 每格各自的分類/子資料夾抽取範圍，見 curScope()
function curScope() { return GEN_LORA_SLOT_SCOPE[GEN_ACTIVE_SLOT]; }   // 目前作用格的範圍——左欄晶片、loraCatPool()、K 鍵都讀寫這個
```

- [ ] **Step 2: 改 `loraCatPool()`/`loraCatLabel()`**

搜尋「現有程式碼速查」裡的 `loraCatPool()`/`loraCatLabel()` 原文，換成：

```js
function loraCatPool() {
  return (GEN_LORAS || []).filter(l =>
    (curScope().cat === 'all' || l.category === curScope().cat) &&
    (!curScope().subfolder || l.folder === curScope().subfolder));
}
function loraCatLabel() {
  if (curScope().subfolder) return curScope().subfolder === curScope().cat ? curScope().cat : curScope().subfolder;
  return curScope().cat === 'all' ? null : curScope().cat;
}
```

- [ ] **Step 3: 改 `renderLmCats()`**

搜尋「現有程式碼速查」裡的 `renderLmCats()` 原文，把函式內容換成：

```js
function renderLmCats() {
  const box = $('lm-cats'); if (!box) return;
  const items = GEN_LORAS || [];
  const counts = {};
  for (const l of items) counts[l.category] = (counts[l.category] || 0) + 1;
  const folders = Object.keys(counts).sort();
  box.innerHTML = '';
  const mk = (key, label, n) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'lm-cat' + (curScope().cat === key ? ' on' : '');
    const lb = document.createElement('span'); lb.textContent = label;
    const nb = document.createElement('span'); nb.className = 'lm-cat-n'; nb.textContent = n;
    b.append(lb, nb);
    b.addEventListener('click', () => {
      curScope().cat = key;
      curScope().subfolder = '';   // 換頂層分類，子資料夾篩選跟著清掉——上次選的子資料夾對新分類沒意義
      renderLmCats(); renderLmSubcats(); renderLmList($('lm-search').value, true);
      renderCsScopeSelects();   // 設定彈窗的下拉要跟著晶片同步（Task 3 定義，此時已存在於檔案中）
    });
    box.appendChild(b);
  };
  mk('all', '全部', items.length);
  folders.forEach(f => mk(f, f, counts[f]));
}
```

- [ ] **Step 4: 改 `renderLmSubcats()`**

搜尋「現有程式碼速查」裡的 `renderLmSubcats()` 原文，把函式內容換成：

```js
function renderLmSubcats() {
  const box = $('lm-subcats'); if (!box) return;
  box.innerHTML = '';
  if (curScope().cat === 'all') return;
  const items = (GEN_LORAS || []).filter(l => l.category === curScope().cat);
  const counts = {};
  for (const l of items) counts[l.folder] = (counts[l.folder] || 0) + 1;
  const subfolders = Object.keys(counts).sort();
  if (subfolders.length <= 1) return;
  const mk = (key, label, n) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'lm-subcat' + (curScope().subfolder === key ? ' on' : '');
    const lb = document.createElement('span'); lb.textContent = label;
    const nb = document.createElement('span'); nb.className = 'lm-subcat-n'; nb.textContent = n;
    b.append(lb, nb);
    b.addEventListener('click', () => {
      curScope().subfolder = key;
      renderLmSubcats(); renderLmList($('lm-search').value, true);
      renderCsScopeSelects();   // 設定彈窗的下拉要跟著晶片同步（Task 3 定義，此時已存在於檔案中）
    });
    box.appendChild(b);
  };
  mk('', '全部', items.length);
  subfolders.forEach(f => {
    // f === curScope().cat：直接放在分類頂層、沒再分子資料夾的那些；其餘去掉「分類/」前綴只顯示子資料夾名
    const label = f === curScope().cat ? '(根目錄)' : f.slice(curScope().cat.length + 1);
    mk(f, label, counts[f]);
  });
}
```

**這個函式原本的結尾不是 `subfolders.forEach(f => mk(f, f, counts[f]));`**——子資料夾的顯示文字有一段算「去掉分類名前綴」的邏輯（`f.slice(GEN_LORA_CAT.length + 1)`），這裡也要一起換成 `curScope().cat`，不要漏掉。

- [ ] **Step 5: 改 `renderLmList()` 開頭的池篩選**

`renderLmList()` 不是透過 `loraCatPool()` 篩選的，它在函式一開頭自己重複了一次同樣的篩選條件。搜尋「現有程式碼速查」裡 `renderLmList()` 開頭那段原文，把：

```js
  let items = (GEN_LORAS || []).filter(l =>
    (GEN_LORA_CAT === 'all' || l.category === GEN_LORA_CAT) &&
    (!GEN_LORA_SUBFOLDER || l.folder === GEN_LORA_SUBFOLDER));
```

換成：

```js
  let items = (GEN_LORAS || []).filter(l =>
    (curScope().cat === 'all' || l.category === curScope().cat) &&
    (!curScope().subfolder || l.folder === curScope().subfolder));
```

函式其他部分（`q`/搜尋排序/翻頁邏輯）不動。

- [ ] **Step 6: 更新兩處提到舊變數名稱的註解**

搜尋「現有程式碼速查」裡「兩處提到 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER` 的註解」那兩段原文，各自把裡面的 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER` 換成 `curScope().cat`/`curScope().subfolder`（或簡稱「`curScope()`」，只要語意通順、不再提到已經不存在的變數名稱即可，這是註解不是程式碼，文字不用逐字對應）。這兩段註解分別在 `loraCatPool()` 正上方、`drawConceptsTarotByCategory()` 正上方。

- [ ] **Step 7: 改 Concepts `X` 鍵**

搜尋「現有程式碼速查」裡 `drawConceptsTarotByCategory()` 的那兩行 `cPool`/`kPool`，換成：

```js
  const cPool = lockedChar ? null : (curScope().cat === 'Character' ? loraCatPool() : fullCharacterPool());
  const kPool = lockedConcept ? null : (curScope().cat === 'HENTAI' ? loraCatPool() : fullConceptsPool());
```

- [ ] **Step 8: 全檔案確認沒有漏改的 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER` 殘留**

Run（在 `C:/projects/flux2klein` 目錄下）：
```bash
grep -n "GEN_LORA_CAT\|GEN_LORA_SUBFOLDER" darkroom/darkroom.js
```
Expected: 沒有任何一行還在讀寫這兩個名字（`grep` 不匹配任何東西，指令印出空白或直接沒有輸出）。如果還有殘留（例如某個你沒注意到的地方也讀了 `GEN_LORA_CAT`），要照上面同樣的邏輯換成 `curScope().cat`/`curScope().subfolder`，不要跳過。

- [ ] **Step 9: 語法檢查**

Run: `node --check darkroom/darkroom.js`
Expected: 無輸出（exit code 0）。這一步會因為 `renderCsScopeSelects` 還沒定義而在**執行期**才報錯，不是語法錯誤——`node --check` 只檢查語法，不會執行程式碼，所以這裡應該還是乾淨通過。

- [ ] **Step 10: 手動驗證（先驗證晶片本身還正常，`renderCsScopeSelects()` 的呼叫會在瀏覽器 console 噴 `ReferenceError`，這是預期的、Task 3 會補上，不用現在修）**

啟動隔離埠：
```bash
python darkroom/preview_ui.py --port 8910 --no-open
```
用瀏覽器工具開 `http://127.0.0.1:8910/`，執行：

```js
(function(){
  switchMode('gen');
  fetchGenLoras();
  return new Promise(res => setTimeout(() => {
    try {
      const cats = Object.keys((GEN_LORAS||[]).reduce((a,l)=>{a[l.category]=1;return a;},{}));
      if (!cats.length) { res('沒有可用的 LoRA 分類，換一個有設定 LORA_ROOT 的環境測'); return; }
      const before = JSON.stringify(GEN_LORA_SLOT_SCOPE);
      renderLmCats();
      const catBtn = document.querySelector(`.lm-cat`);
      // catBtn.click() 內部的 handler 會呼叫 renderCsScopeSelects()（Task 3 才定義），
      // 點擊本身務必包在 try/catch 裡——不然這個 ReferenceError 會直接中斷整個 IIFE，
      // 連 curScope().cat 有沒有正確更新都看不到（賦值發生在呼叫 renderCsScopeSelects()
      // 之前，所以就算丟錯，範圍狀態其實已經改對了，只是要小心別讓例外把驗證結果吃掉）。
      try { catBtn && catBtn.click(); } catch (e) {}
      res(JSON.stringify({ before, after: GEN_LORA_SLOT_SCOPE, curScope: curScope() }));
    } catch (e) { res('ERR:' + e.message); }
  }, 1500));
})();
```

Expected: `after`/`curScope` 反映出點擊分類晶片之後 `GEN_LORA_SLOT_SCOPE[GEN_ACTIVE_SLOT]`（預設 `GEN_ACTIVE_SLOT` 是 `0`）的 `cat` 真的變了，`GEN_LORA_SLOT_SCOPE[1]` 維持 `{cat:'all',subfolder:''}` 不變。就算點擊時因為 `renderCsScopeSelects` 未定義丟出 `ReferenceError`（被 `try/catch` 吞掉），只要 `curScope().cat` 有正確更新就代表這一步的核心邏輯是對的。

驗證完停掉這個測試行程（找到 port 8910 的 python 行程 kill 掉）。

- [ ] **Step 11: Commit**

```bash
git add darkroom/darkroom.js
git commit -m "$(cat <<'EOF'
LoRA 分類/子資料夾範圍改成以格為索引：GEN_LORA_SLOT_SCOPE 取代 GEN_LORA_CAT/GEN_LORA_SUBFOLDER

K 鍵抽取範圍原本讀 GEN_LORA_CAT/GEN_LORA_SUBFOLDER，這是整個大面板
共用的一份全域狀態，LoRA1/LoRA2 沒辦法各自設不同範圍。改成以格為
索引的 GEN_LORA_SLOT_SCOPE 陣列 + curScope() 當唯一讀寫入口，
renderLmCats()/renderLmSubcats()/renderLmList()/loraCatPool()/
loraCatLabel()/Concepts X 鍵全部改讀寫這個（renderLmList() 開頭
自己重複了一次跟 loraCatPool() 一樣的篩選條件，容易漏改，這次
一併修掉），不再有「全域目前值」跟「每格快照」兩份資料要保持
同步——只有一份真相，任何地方讀寫都指向同一個物件。

renderLmCats()/renderLmSubcats() 的點擊 handler 這次先加了呼叫
renderCsScopeSelects()（下個 commit 才會定義這個函式）：晶片一被
點，設定彈窗的範圍下拉要跟著同步，這個呼叫點放在這裡最直覺，先寫
好接口、下個 commit 補實作，比事後再回來加更不容易漏掉同步點。
EOF
)"
```

---

### Task 2: `setActiveSlot()` 取代三處 `GEN_ACTIVE_SLOT = i` 賦值

**Files:**
- Modify: `darkroom/darkroom.js`（新增 `setActiveSlot()`；三處直接賦值改呼叫它）

**Interfaces:**
- Consumes: `GEN_ACTIVE_SLOT`、`renderLmCats()`、`renderLmSubcats()`（Task 1 已改好，讀 `curScope()`）。
- Produces: `function setActiveSlot(i)`——之後任何要切換作用格的地方都該呼叫這個，不要再直接寫 `GEN_ACTIVE_SLOT = i`。

- [ ] **Step 1: 新增 `setActiveSlot()`**

搜尋「現有程式碼速查」裡 `let GEN_ACTIVE_SLOT = 0;` 這一行，在它下面（跟 `curSlot()`/`otherSlotIndex()` 那兩個既有的簡寫函式放一起）加：

```js
function setActiveSlot(i) {
  GEN_ACTIVE_SLOT = i;
  renderLmCats();
  renderLmSubcats();
}
```

- [ ] **Step 2: 分頁卡點擊改呼叫 `setActiveSlot()`**

搜尋「現有程式碼速查」裡這一行原文：
```js
    tab.addEventListener('click', () => { hideLoraPreviewTip(); GEN_ACTIVE_SLOT = i; renderLmCurrent(); renderLmList($('lm-search').value); });
```
換成：
```js
    tab.addEventListener('click', () => { hideLoraPreviewTip(); setActiveSlot(i); renderLmCurrent(); renderLmList($('lm-search').value); });
```

- [ ] **Step 3: 清空按鈕改呼叫 `setActiveSlot()`**

搜尋「現有程式碼速查」裡這段原文：
```js
      clear.addEventListener('click', (e) => {
        e.stopPropagation();
        GEN_LORA_SLOTS[i] = { lora: null, strength: slot.strength, twPicks: new Set() };
        GEN_ACTIVE_SLOT = i;
        renderGenCurrent(); renderLmCurrent(); renderLmList($('lm-search').value);
      });
```
把 `GEN_ACTIVE_SLOT = i;` 那一行換成 `setActiveSlot(i);`（其餘不動）。

- [ ] **Step 4: `applyLoraPush()` 改呼叫 `setActiveSlot()`**

搜尋「現有程式碼速查」裡這段原文：
```js
  const emptyIdx = GEN_LORA_SLOTS.findIndex(s => !s.lora);
  if (emptyIdx !== -1) GEN_ACTIVE_SLOT = emptyIdx;
  selectGenLora(match);
```
把 `if (emptyIdx !== -1) GEN_ACTIVE_SLOT = emptyIdx;` 換成 `if (emptyIdx !== -1) setActiveSlot(emptyIdx);`。

- [ ] **Step 5: 確認沒有漏改的直接賦值**

Run:
```bash
grep -n "GEN_ACTIVE_SLOT = " darkroom/darkroom.js
```
Expected: 只剩 `function setActiveSlot(i) {` 裡面那一行 `GEN_ACTIVE_SLOT = i;`——這是 `setActiveSlot()` 自己的實作，本來就該直接賦值，其他所有呼叫端都不該再有 `GEN_ACTIVE_SLOT = ` 這種寫法。如果 grep 還跑出其他行，代表有漏改的地方，要照 Step 2-4 同樣的模式處理。

- [ ] **Step 6: 語法檢查**

Run: `node --check darkroom/darkroom.js`
Expected: 無輸出（exit code 0）

- [ ] **Step 7: 手動驗證**

啟動隔離埠（換一個新埠號，避免跟前一個任務殘留的行程衝突）：
```bash
python darkroom/preview_ui.py --port 8911 --no-open
```
瀏覽器工具開 `http://127.0.0.1:8911/`，執行：

```js
(function(){
  switchMode('gen');
  return fetchGenLoras().then(loras => {
    if (!loras.length) return '沒有可用的 LoRA，換一個有設定 LORA_ROOT 的環境測';
    try { renderLmCats(); } catch (e) {}   // renderCsScopeSelects 還沒定義，吞掉這個預期中的錯誤
    curScope().cat = 'Character';
    curScope().subfolder = 'test-marker';
    const before = { activeSlot: GEN_ACTIVE_SLOT, scope0: JSON.stringify(GEN_LORA_SLOT_SCOPE[0]) };
    setActiveSlot(1);
    const afterSwitch = { activeSlot: GEN_ACTIVE_SLOT, scope1: JSON.stringify(GEN_LORA_SLOT_SCOPE[1]) };
    setActiveSlot(0);
    const afterSwitchBack = { activeSlot: GEN_ACTIVE_SLOT, curScope: JSON.stringify(curScope()) };
    return JSON.stringify({ before, afterSwitch, afterSwitchBack });
  });
})();
```

Expected: `before.scope0` 含 `"cat":"Character"` 和 `"subfolder":"test-marker"`；`afterSwitchBack.curScope` 切回 slot 0 之後**還是** `{"cat":"Character","subfolder":"test-marker"}`（因為 `setActiveSlot()` 現在只是換 index、不做任何複製，`GEN_LORA_SLOT_SCOPE[0]` 這個物件從頭到尾沒被動過）。

驗證完停掉這個測試行程。

- [ ] **Step 8: Commit**

```bash
git add darkroom/darkroom.js
git commit -m "$(cat <<'EOF'
切換 LoRA1/LoRA2 作用格改呼叫統一的 setActiveSlot()

上一個 commit 把範圍狀態改成以格為索引的陣列後，切格不再需要
「存舊、還原新」的複製動作——GEN_LORA_SLOT_SCOPE[i] 本來就一直是
那一格的資料，只要換 GEN_ACTIVE_SLOT 這個 index、重繪左欄晶片
（curScope() 會自動指到新的那一格）即可。三處原本直接寫
GEN_ACTIVE_SLOT = i 的地方（分頁卡點擊、清空按鈕、LoRA Manager
推送自動選空格）統一改叫 setActiveSlot()，往後任何新增的切格邏輯
也該叫這個，不要再直接賦值——不然晶片畫面會跟實際的 GEN_ACTIVE_SLOT
兜不起來。
EOF
)"
```

---

### Task 3: 設定彈窗兩分頁殼 + LoRA1/LoRA2 範圍下拉

**Files:**
- Modify: `darkroom/index.html`（`#concepts-settings` 內部結構改分頁）
- Modify: `darkroom/darkroom.css`（`.cs-tab-panel` 樣式，含 `[hidden]` 覆寫）
- Modify: `darkroom/darkroom.js`（分頁切換邏輯、`renderCsScopeSelects()`/`renderCsScopeSubSelect()`、change 事件委派、彈窗開關時機）

**Interfaces:**
- Consumes: `GEN_LORA_SLOT_SCOPE`、`GEN_ACTIVE_SLOT`、`renderLmCats()`、`renderLmSubcats()`（Task 1、2）、`GEN_LORAS`、`renderLmList()`（既有）。
- Produces: `function renderCsScopeSelects()`、`function renderCsScopeSubSelect(slot)`、`function moveCsTabPill()`——Task 1 的 `renderLmCats()`/`renderLmSubcats()` 已經在呼叫 `renderCsScopeSelects()`，這個任務補上它的定義，之前的 `ReferenceError` 到這裡解除。

- [ ] **Step 1: `index.html` 改分頁結構**

搜尋「現有程式碼速查」裡 `#concepts-settings` 整個彈窗的 HTML 原文，把從 `<button class="ghost icon-btn" id="concepts-settings-btn" ...>` 到對應 `</div>`（`concepts-settings` 那個 `div` 結束）整段換成：

```html
<button class="ghost icon-btn" id="concepts-settings-btn" title="設定：一般 LoRA 抽取／Concepts 抽卡" aria-label="設定">⚙</button>
<div class="concepts-settings" id="concepts-settings" hidden>
  <div class="seg cs-tab-seg" id="cs-tab-seg" role="group" aria-label="設定分頁">
    <span class="seg-pill" id="cs-tab-pill" aria-hidden="true"></span>
    <button data-tab="general" class="on">一般</button>
    <button data-tab="concepts">Concepts</button>
  </div>
  <div class="cs-tab-panel" id="cs-tab-general">
    <div class="cs-row cs-row-check cs-row-radio">
      <span>🎲 抽 LoRA 範圍（快捷鍵 L／K）</span>
      <label><input type="radio" name="cs-lora-scope" id="cs-lora-scope-both" value="both">兩格都抽</label>
      <label><input type="radio" name="cs-lora-scope" id="cs-lora-scope-active" value="active">只抽目前作用格</label>
    </div>
    <div class="cs-row cs-row-scope">
      <span>LoRA1 範圍</span>
      <select class="cs-scope-cat" data-slot="0"></select>
      <select class="cs-scope-sub" data-slot="0"></select>
    </div>
    <div class="cs-row cs-row-scope">
      <span>LoRA2 範圍</span>
      <select class="cs-scope-cat" data-slot="1"></select>
      <select class="cs-scope-sub" data-slot="1"></select>
    </div>
  </div>
  <div class="cs-tab-panel" id="cs-tab-concepts" hidden>
    <label class="cs-row">
      <span>Character 強度</span>
      <input type="range" id="cs-char-strength" min="0" max="1" step="0.05">
      <output id="cs-char-strength-out"></output>
    </label>
    <label class="cs-row">
      <span>concepts 強度</span>
      <input type="range" id="cs-key-strength" min="0" max="1" step="0.05">
      <output id="cs-key-strength-out"></output>
    </label>
    <label class="cs-row cs-row-count">
      <span>每次抽幾張</span>
      <input type="number" id="cs-count" min="1" max="24" step="1">
    </label>
    <label class="cs-row cs-row-check">
      <input type="checkbox" id="cs-tpl">
      <span>同時抽詞庫模板（不勾＝只用兩個 LoRA 的觸發詞）</span>
    </label>
    <label class="cs-row cs-row-check">
      <input type="checkbox" id="cs-tpl-cur-folder">
      <span>模板只抽左邊目前選中的資料夾（不勾＝從全部詞庫抽）</span>
    </label>
    <div class="cs-tpl-lock" id="cs-tpl-lock">
      <div class="cs-tpl-lock-current" id="cs-tpl-lock-current" hidden>
        <span id="cs-tpl-lock-name"></span>
        <button type="button" id="cs-tpl-lock-clear" title="取消鎖定模板" aria-label="取消鎖定模板">✕</button>
      </div>
      <input type="text" id="cs-tpl-search" placeholder="搜尋要鎖定的模板…" autocomplete="off">
      <div class="cs-tpl-results" id="cs-tpl-results"></div>
    </div>
  </div>
</div>
```

**注意**：原本 `#cs-tpl-lock` 那整段（鎖定模板搜尋）現在巢在 `#cs-tab-concepts` 裡面而不是直接在 `#concepts-settings` 底下，`darkroom.js` 裡任何用 `$('cs-tpl-lock')`、`$('cs-tpl-search')` 等 id 選取器抓它的程式碼**不用改**——id 選取器不管巢在哪一層都抓得到，唯一在意的是 id 本身沒變。

- [ ] **Step 2: CSS**

在 `darkroom/darkroom.css` 找到 `.cs-row-radio` 那組規則（Task 1 之前的功能已經加過，搜尋 `.cs-row-radio {` 定位），在附近（同一個 Concepts 設定相關的區塊）加：

```css
.cs-tab-seg { margin-bottom: 4px; }
.cs-tab-panel { display: flex; flex-direction: column; gap: 12px; }
.cs-tab-panel[hidden] { display: none; }
.cs-row-scope select { flex: 1; min-width: 0; font-size: 11.5px; padding: 3px 6px; }
.cs-row-scope select[hidden] { display: none; }
```

`.cs-tab-panel[hidden] { display: none; }` 這一行**不可省略**——`.cs-tab-panel` 是 `display:flex`，author-origin 規則會蓋掉 `[hidden]` 的 UA-origin `display:none`，不加這行分頁會變成兩份內容一直疊在一起顯示（上一輪「使用說明」疊層真實踩過的 bug，這次要在寫的當下就避開，不是事後才補）。

- [ ] **Step 3: `renderCsScopeSelects()`/`renderCsScopeSubSelect()`**

在 `darkroom.js` 裡搜尋 `function loraCatLabel() {`（Task 1 已改過的版本）所在的函式，在它結束的 `}` 之後（`drawLoraCategoryDispatch()` 那一行之前或之後都可以，建議緊接在 `loraCatLabel()` 後面，同一個「範圍相關函式」的區塊）加：

```js
// 設定彈窗「一般」分頁的 LoRA1/LoRA2 範圍下拉——跟左欄晶片（renderLmCats/
// renderLmSubcats）是同一份 GEN_LORA_SLOT_SCOPE 資料，只是畫成 select 而不是晶片
// （設定彈窗窄，兩組並排用晶片會擠爆）。改到「目前作用格」那組會連動重繪左欄晶片，
// 改到「另一格」大面板當下看不到，不用重繪（見 change handler）。
function renderCsScopeSelects() {
  const items = GEN_LORAS || [];
  const counts = {};
  for (const l of items) counts[l.category] = (counts[l.category] || 0) + 1;
  const cats = Object.keys(counts).sort();
  [0, 1].forEach((slot) => {
    const scope = GEN_LORA_SLOT_SCOPE[slot];
    const catSel = document.querySelector(`.cs-scope-cat[data-slot="${slot}"]`);
    if (!catSel) return;
    catSel.innerHTML = '';
    const allOpt = document.createElement('option'); allOpt.value = 'all'; allOpt.textContent = `全部 (${items.length})`;
    catSel.appendChild(allOpt);
    cats.forEach((c) => {
      const opt = document.createElement('option'); opt.value = c; opt.textContent = `${c} (${counts[c]})`;
      catSel.appendChild(opt);
    });
    catSel.value = scope.cat;
    renderCsScopeSubSelect(slot);
  });
}
function renderCsScopeSubSelect(slot) {
  const scope = GEN_LORA_SLOT_SCOPE[slot];
  const subSel = document.querySelector(`.cs-scope-sub[data-slot="${slot}"]`);
  if (!subSel) return;
  subSel.innerHTML = '';
  if (scope.cat === 'all') { subSel.hidden = true; return; }
  const items = (GEN_LORAS || []).filter(l => l.category === scope.cat);
  const counts = {};
  for (const l of items) counts[l.folder] = (counts[l.folder] || 0) + 1;
  const subfolders = Object.keys(counts).sort();
  if (subfolders.length <= 1) { subSel.hidden = true; return; }
  subSel.hidden = false;
  const allOpt = document.createElement('option'); allOpt.value = ''; allOpt.textContent = `${scope.cat} 全部`;
  subSel.appendChild(allOpt);
  subfolders.forEach((f) => {
    const opt = document.createElement('option'); opt.value = f; opt.textContent = `${f} (${counts[f]})`;
    subSel.appendChild(opt);
  });
  subSel.value = scope.subfolder;
}
```

- [ ] **Step 4: 分頁切換邏輯 + change 事件委派**

在 `darkroom.js` 裡搜尋「現有程式碼速查」裡的 `const $csPanel = $('concepts-settings');` 這幾行，在它們之後（`document.addEventListener('click', ...)` 那個 outside-click handler 之後）加：

```js
function moveCsTabPill() {
  const seg = $('cs-tab-seg'), pill = $('cs-tab-pill');
  const active = seg && seg.querySelector('button.on');
  if (!active || !pill) return;
  pill.style.width = active.offsetWidth + 'px';
  pill.style.transform = `translateX(${active.offsetLeft}px)`;
}
$('cs-tab-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  $('cs-tab-seg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
  moveCsTabPill();
  $('cs-tab-general').hidden = btn.dataset.tab !== 'general';
  $('cs-tab-concepts').hidden = btn.dataset.tab !== 'concepts';
});
// 兩組 LoRA1/LoRA2 範圍下拉共用同一個 change 委派，用 data-slot 判斷改的是哪一格。
// i === GEN_ACTIVE_SLOT 是雙向同步的關鍵：改到目前作用格那組，大面板左欄晶片要跟著重繪；
// 改到另一格，那格的晶片畫面當下看不到，不用重繪。
$('cs-tab-general').addEventListener('change', (e) => {
  const slotAttr = e.target.dataset.slot; if (slotAttr === undefined) return;
  const i = Number(slotAttr);
  const scope = GEN_LORA_SLOT_SCOPE[i];
  if (e.target.classList.contains('cs-scope-cat')) {
    scope.cat = e.target.value;
    scope.subfolder = '';
    renderCsScopeSubSelect(i);
  } else if (e.target.classList.contains('cs-scope-sub')) {
    scope.subfolder = e.target.value;
  } else {
    return;
  }
  if (i === GEN_ACTIVE_SLOT) { renderLmCats(); renderLmSubcats(); renderLmList($('lm-search').value, true); }
});
```

- [ ] **Step 5: 彈窗開啟時重繪下拉＋分頁指示條定位**

搜尋「現有程式碼速查」裡的：
```js
$('concepts-settings-btn').onclick = (e) => {
  e.stopPropagation();
  $csPanel.hidden = !$csPanel.hidden;
};
```
換成：

```js
$('concepts-settings-btn').onclick = (e) => {
  e.stopPropagation();
  $csPanel.hidden = !$csPanel.hidden;
  if (!$csPanel.hidden) { renderCsScopeSelects(); moveCsTabPill(); }
};
```

- [ ] **Step 6: 語法檢查**

Run: `node --check darkroom/darkroom.js`
Expected: 無輸出（exit code 0）

- [ ] **Step 7: 手動驗證**

啟動隔離埠：
```bash
python darkroom/preview_ui.py --port 8912 --no-open
```
瀏覽器工具開 `http://127.0.0.1:8912/`，執行分頁切換的渲染驗證（沿用上一輪學到的教訓，用 `getComputedStyle(...).display` 而不是只看 `hidden` 屬性）：

```js
(function(){
  document.getElementById('concepts-settings-btn').click();
  const before = {
    generalDisplay: getComputedStyle(document.getElementById('cs-tab-general')).display,
    conceptsDisplay: getComputedStyle(document.getElementById('cs-tab-concepts')).display,
  };
  document.querySelector('#cs-tab-seg [data-tab="concepts"]').click();
  const afterConcepts = {
    generalDisplay: getComputedStyle(document.getElementById('cs-tab-general')).display,
    conceptsDisplay: getComputedStyle(document.getElementById('cs-tab-concepts')).display,
  };
  document.querySelector('#cs-tab-seg [data-tab="general"]').click();
  const afterGeneral = {
    generalDisplay: getComputedStyle(document.getElementById('cs-tab-general')).display,
    conceptsDisplay: getComputedStyle(document.getElementById('cs-tab-concepts')).display,
  };
  return JSON.stringify({ before, afterConcepts, afterGeneral });
})();
```
Expected：`before` → general `flex`、concepts `none`；`afterConcepts` → general `none`、concepts `flex`；`afterGeneral` → general `flex`、concepts `none`。

再驗證雙向同步（需要環境裡 `GEN_LORAS` 有多個分類/子資料夾才測得出完整效果，如果沒有就只驗證下拉確實跟 `GEN_LORA_SLOT_SCOPE` 同步、不強求分類數量）：

```js
(function(){
  switchMode('gen');
  return fetchGenLoras().then(loras => {
    if (!loras.length) return '沒有可用的 LoRA，換一個有設定 LORA_ROOT 的環境測';
    renderLmCats();
    document.getElementById('concepts-settings-btn').click();
    renderCsScopeSelects();
    const cat0 = document.querySelector('.cs-scope-cat[data-slot="0"]');
    const options = [...cat0.options].map(o => o.value);
    if (options.length < 2) return JSON.stringify({ note: '只有一個分類，測不出切換效果，但下拉本身有渲染', options });
    const target = options.find(v => v !== 'all' && v !== cat0.value) || options[1];
    cat0.value = target;
    cat0.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({
      scope0: GEN_LORA_SLOT_SCOPE[0],
      chipReflectsChange: document.querySelector('.lm-cat.on') ? document.querySelector('.lm-cat.on').textContent.includes(target) : null,
    });
  });
})();
```
Expected：`scope0.cat` 等於 `target`；如果 `GEN_ACTIVE_SLOT` 當下是 `0`（預設情況），`chipReflectsChange` 應該是 `true`——代表改設定彈窗的下拉，大面板左欄晶片真的跟著變了。

驗證完停掉這個測試行程。

- [ ] **Step 8: Commit**

```bash
git add darkroom/index.html darkroom/darkroom.css darkroom/darkroom.js
git commit -m "$(cat <<'EOF'
齒輪設定彈窗拆兩分頁：一般（L/K 範圍）／Concepts（原內容），一般分頁新增 LoRA1/LoRA2 範圍下拉

沿用「使用說明」疊層已經驗證過的 .seg/.seg-pill 兩分頁模式，這次
CSS 從一開始就加對 .cs-tab-panel[hidden]{display:none}（上一輪
最終審查抓到的坑：author-origin 的 display:flex 會蓋掉 [hidden]
的 UA-origin display:none）。

一般分頁新增 LoRA1/LoRA2 兩組分類/子資料夾下拉（renderCsScopeSelects/
renderCsScopeSubSelect），直接讀寫 GEN_LORA_SLOT_SCOPE[0]/[1]——
不用切大面板分頁卡就能把兩格的抽取範圍都設好。跟大面板左欄晶片
雙向同步：改到「目前作用格」那組下拉，晶片立刻重繪；晶片被點擊，
下拉也立刻重繪（change handler 判斷 i === GEN_ACTIVE_SLOT，晶片
點擊 handler 呼叫 renderCsScopeSelects()——這行 Task 1 已經先加好，
這個 commit 補上函式定義，ReferenceError 到此解除）。
EOF
)"
```

---

### Task 4: 文件同步（`SHORTCUT_GROUPS`／`FEATURE_GROUPS`／README／進度.md）

**Files:**
- Modify: `darkroom/darkroom.js`（`SHORTCUT_GROUPS`/`FEATURE_GROUPS` 裡提到「抽 LoRA 範圍」設定位置的文字）
- Modify: `README.md`
- Modify: `進度.md`

**Interfaces:**
- Consumes: 無新介面，純文案更新。

- [ ] **Step 1: 確認 `SHORTCUT_GROUPS`/`FEATURE_GROUPS` 是否需要改字**

搜尋 `darkroom.js` 裡的 `SHORTCUT_GROUPS`（`L`/`K` 那兩行說明）跟 `FEATURE_GROUPS`（生圖分組），檢查文字有沒有指名「抽 LoRA 範圍」設定在哪裡。如果原文只說「依『抽 LoRA 範圍』設定」而沒有指名位置，不用改；如果有指名位置（例如提到彈窗名稱或分頁），改成「設定彈窗『一般』分頁」，並在 `FEATURE_GROUPS` 生圖分組裡緊接著補一句：

```
LoRA1/LoRA2 各自獨立記住自己的分類/子資料夾抽取範圍，設定彈窗跟大面板左欄晶片雙向同步。
```

（用 `<b>` 標記語意重點的慣例跟其他 `FEATURE_GROUPS` 條目一致，參考同分組裡其他行的寫法。）

- [ ] **Step 2: 更新 README.md**

找到 README 裡描述暗房 LoRA 大面板/生圖模式/L、K 快捷鍵的段落（上一輪功能完成時應該已經補過 L/K 說明），補一句 LoRA1/LoRA2 各自獨立範圍、設定彈窗一般分頁可以直接設定兩格範圍的說明。

- [ ] **Step 3: 更新進度.md**

在 `進度.md` 最上方補條目，取得這次 4 個 commit 的實際 hash（`git log --oneline -4`），格式沿用既有慣例 `### YYYY-MM-DD HH:MM · <hash> <標題>`，可以合併成 1-2 條、涵蓋這四個 commit 做了什麼與為什麼（單一真相來源取代複製同步、設定彈窗兩分頁與雙向同步下拉）。

- [ ] **Step 4: Commit**

```bash
git add darkroom/darkroom.js README.md 進度.md
git commit -m "README/進度.md/使用說明文案：補上每格獨立範圍與設定彈窗兩分頁的說明"
git push
```

---

## Self-Review 對照表（spec → task）

- 「單一真相來源，不做手動同步」（`GEN_LORA_SLOT_SCOPE`/`curScope()`）→ Task 1
- 五個既有讀寫點（`renderLmCats`/`renderLmSubcats`/`loraCatPool`/`loraCatLabel`/Concepts `X` 鍵）全部改掉 → Task 1 Step 2-5，Step 6 用 grep 驗證沒有殘留
- `setActiveSlot()` 取代三處直接賦值 → Task 2
- 設定彈窗兩分頁殼，沿用「使用說明」模式 → Task 3 Step 1、4
- **`.cs-tab-panel[hidden]{display:none}`**（上一輪教訓，這次要在 CSS 一開始就加對）→ Task 3 Step 2，並在驗證步驟用 `getComputedStyle` 而非只看 `hidden` 屬性
- LoRA1/LoRA2 兩組範圍下拉（`renderCsScopeSelects`/`renderCsScopeSubSelect`）→ Task 3 Step 3
- 雙向同步（下拉→晶片、晶片→下拉）→ Task 3 Step 4（change handler 的 `i === GEN_ACTIVE_SLOT` 判斷）與 Task 1 Step 3-4（晶片 click handler 呼叫 `renderCsScopeSelects()`）
- 齒輪按鈕 title/aria-label 更新 → Task 3 Step 1
- 文件同步（`SHORTCUT_GROUPS`/`FEATURE_GROUPS`/README/進度.md）→ Task 4
- 「不做的事」（不做每格獨立設定以外的東西、不持久化 `GEN_LORA_SLOT_SCOPE`、不改 `L` 鍵、不做兩組下拉互斥限制）→ 全程沒有實作這些，符合
