# 暗房：LoRA 抽取設定改成置中大 Modal ＋ 範圍改晶片式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 齒輪 ⚙ 設定入口從貼著按鈕的小型錨定彈窗（`.concepts-settings`）改成置中大 modal（`.cs-modal`），LoRA1/LoRA2 範圍選擇器從 `<select>` 改成晶片式。

**Architecture:** 新增一組獨立的置中彈窗類別 `.cs-modal`/`.cs-modal-inner`，結構與開關行為（`fadeIn`/`modalPop` 進場、`element.animate()` 淡出縮小退場、背景遮罩點擊關閉、`Esc` 關閉）完全比照既有的 `.lora-modal`。範圍選擇器直接重用 LoRA 大面板左欄晶片的既有 CSS 類別（`.lm-cats`/`.lm-cat`/`.lm-subcats`/`.lm-subcat`），新增 `renderCsScopeChips(slot)`/`renderCsScopeSubChips(slot)` 取代原本畫 `<select>` 的 `renderCsScopeSelects()`/`renderCsScopeSubSelect()`。原本用來關閉小彈窗的 document 層級 outside-click 偵測整段刪除，換成標準的背景遮罩點擊（跟 `#tarot`/`#lora-modal` 同一套寫法）。

**Tech Stack:** Vanilla JS（無建置步驟，改完存檔重整瀏覽器即生效）、原生 CSS（無預處理器）。

## Global Constraints

- 這是無建置步驟的純前端 vanilla JS 專案，不可引入框架、npm、打包工具（見 `CLAUDE.md`）。
- 沒有測試框架。驗證手段固定兩個：`node --check darkroom/darkroom.js`（語法檢查）＋用隔離埠的 `python darkroom/preview_ui.py --port <非預設埠> --no-open` 實例搭配瀏覽器工具手動操作驗證。
- UI 文案、commit message、註解一律繁體中文。
- **`.cs-tab-panel[hidden] { display: none; }` 這條 CSS 規則必須保留**（已存在，不要刪掉）——這是先前一輪功能修過的坑：`.cs-tab-panel` 是 `display:flex`，沒有這條覆寫規則的話分頁切換的 `hidden` 屬性不會有視覺效果。這次只是換外殼容器，分頁機制本身不變，這條規則跟它保護的分頁結構都原封不動留著。
- 手動驗證一律用隔離埠的 `preview_ui.py` 測試實例，驗證完要找到並停掉該測試行程，不得影響使用者可能正在跑的正式服務（預設埠 `7801`/`8188`）。
- `darkroom.js`/`darkroom.css`/`index.html` 已經被多輪改動累積修改過，**下面每個程式碼片段旁邊都附了「怎麼找到插入點」的錨點文字**，implementer 要用這些錨點在檔案裡搜尋定位，不要依賴本文件寫的行號（行號僅供參考，可能已經偏移）。
- 每完成一項獨立改動就 commit；commit 之後要在 `進度.md` 最上方補一筆 `### YYYY-MM-DD HH:MM · <hash> <標題>`。

---

## 現有程式碼速查（撰寫本計畫時的實際內容，供 implementer 核對錨點）

**`darkroom/index.html`，齒輪按鈕 + 現有 `.concepts-settings` 小彈窗整段（在 `.concepts-group` 內）：**
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
          <select class="cs-scope-cat" data-slot="0" aria-label="LoRA1 分類範圍"></select>
          <select class="cs-scope-sub" data-slot="0" aria-label="LoRA1 子資料夾範圍"></select>
        </div>
        <div class="cs-row cs-row-scope">
          <span>LoRA2 範圍</span>
          <select class="cs-scope-cat" data-slot="1" aria-label="LoRA2 分類範圍"></select>
          <select class="cs-scope-sub" data-slot="1" aria-label="LoRA2 子資料夾範圍"></select>
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

**`darkroom/index.html`，`#lora-modal` 開頭（新的 `#cs-modal` 會插在這一行之前）：**
```html
<div id="lora-modal" class="lora-modal">
```

**`darkroom/darkroom.css`，`.lora-modal` 完整既有規則（新的 `.cs-modal` 直接照這套規則抄）：**
```css
.lora-modal { position: fixed; inset: 0; z-index: 140; display: none;
  align-items: center; justify-content: center; padding: 24px;
  background: rgba(8,8,11,.8); backdrop-filter: blur(6px); }
.lora-modal.open { display: flex; animation: fadeIn var(--d-pop) var(--ease-out); }
.lora-modal-inner { position: relative; width: min(1080px, 95vw); height: min(740px, 88vh);
  background: var(--panel); border: 1px solid var(--line-2); border-radius: var(--radius);
  box-shadow: var(--shadow); display: grid; grid-template-columns: 320px 1fr; overflow: hidden;
  animation: modalPop var(--d-pop) var(--ease-entrance); }
@media (prefers-reduced-motion: reduce) { .lora-modal.open, .lora-modal-inner { animation: none; } }
.lora-modal-close { position: absolute; top: 10px; right: 10px; z-index: 2;
  width: 32px; height: 32px; padding: 0; border-radius: 8px; border: 0; background: var(--sunk); color: var(--dim);
  display: grid; place-items: center; cursor: pointer; font-size: 15px; line-height: 1;
  transition: color var(--d-micro) var(--ease-out), background var(--d-micro) var(--ease-out), transform var(--d-micro) var(--ease-out); }
.lora-modal-close:hover { color: var(--ink); background: var(--line-2); }
.lora-modal-close:active { transform: scale(.9); }
```

**`darkroom/darkroom.css`，目前 `.concepts-settings` 區塊（第 672-699 行附近，含要保留跟要刪除的規則）：**
```css
.concepts-settings { position: absolute; top: calc(100% + 8px); right: 0; z-index: 60;
  width: 260px; background: var(--panel); border: 1px solid var(--line-2); border-radius: 12px;
  box-shadow: var(--shadow); padding: 14px 16px; display: flex; flex-direction: column; gap: 12px;
  animation: lmFadeUp var(--d-ui) var(--ease-entrance) both; }
.concepts-settings[hidden] { display: none; }
@media (prefers-reduced-motion: reduce) { .concepts-settings { animation: none; } }
.cs-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dim); cursor: default; }
.cs-row > span:first-child { flex: none; width: 92px; }
.cs-row input[type=range] { flex: 1; }
.cs-row output { font-family: var(--mono); font-size: 11px; min-width: 30px; text-align: right; color: var(--faint); }
.cs-row-count input[type=number] { flex: 1; width: 0; min-width: 0; padding: 4px 8px; font-size: 12px; }
.cs-row-check { cursor: pointer; }
.cs-row-check span { width: auto; flex: 1; line-height: 1.4; }
.cs-row-check input { accent-color: var(--amber); flex: none; }
.cs-row-radio { flex-direction: column; align-items: flex-start; gap: 4px; cursor: default; }
.cs-row-radio > span:first-child { width: auto; }
.cs-row-radio label { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dim); cursor: pointer; }
.cs-row-radio label:hover { color: var(--ink); }
.cs-row-radio input { accent-color: var(--amber); }

.cs-tab-seg { margin-bottom: 4px; }
.cs-tab-panel { display: flex; flex-direction: column; gap: 12px; }
.cs-tab-panel[hidden] { display: none; }
.cs-row-scope select { flex: 1; min-width: 0; font-size: 11.5px; padding: 3px 6px; }
.cs-row-scope select[hidden] { display: none; }
```

**`darkroom/darkroom.css`，LoRA 大面板左欄晶片既有 CSS（新的範圍晶片直接重用這幾個 class，不寫新樣式）：**
```css
.lm-cats { display: flex; flex-wrap: wrap; gap: 6px; padding: 14px 14px 0; flex: none; }
.lm-cat { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--line-2); background: var(--sunk); ... }
.lm-cat.on { border-color: var(--amber); background: var(--amber-soft); color: var(--ink); }
.lm-cat-n { font-family: var(--mono); font-size: 10px; opacity: .75; }
.lm-subcats { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 14px; flex: none; overflow: hidden; }
.lm-subcats:empty { padding: 0 14px; }
.lm-subcat { display: inline-flex; align-items: center; gap: 4px; border: 1px solid transparent; background: transparent; ... }
.lm-subcat.on { border-color: var(--line-2); background: var(--sunk); color: var(--ink); }
.lm-subcat-n { font-family: var(--mono); font-size: 9.5px; opacity: .7; }
```
（`.lm-cats`/`.lm-subcats` 原本是給 LoRA 大面板左欄用的固定容器 padding，`14px`/`0 14px` 是配合那個側欄的版面——這次要重用在設定 modal 裡的兩個獨立小區塊，padding 不合適，Task 1 Step 2 會另外包一層容器覆寫 padding，不動這幾條原始規則本身。）

**`darkroom/darkroom.js`，目前 `renderCsScopeSelects()`/`renderCsScopeSubSelect()`（要整段刪除，改成晶片版）：**
```js
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

**`darkroom/darkroom.js`，兩處 `renderLmCats()`/`renderLmSubcats()` 點擊 handler 呼叫 `renderCsScopeSelects()` 的那一行（各出現一次）：**
```js
      renderCsScopeSelects();   // 設定彈窗的下拉要跟著晶片同步（Task 3 定義，此時已存在於檔案中）
```

**`darkroom/darkroom.js`，設定彈窗開關與分頁邏輯整段（要大幅改寫的區塊）：**
```js
// Concepts 設定彈窗：強度×2／張數／模板開關。開關用 hidden 屬性切換（不是 class），
// 點按鈕本身或彈窗外任一處都會關閉——跟 .tw-tip 那種「跟著游標移動」的提示不同，這是
// 「點開、設定完、點外面關掉」的一般彈窗互動，用 document 層級的 click 監聽最單純。
const $csPanel = $('concepts-settings');
$('concepts-settings-btn').onclick = (e) => {
  e.stopPropagation();
  $csPanel.hidden = !$csPanel.hidden;
  if (!$csPanel.hidden) { fetchGenLoras().then(renderCsScopeSelects); moveCsTabPill(); }
};
document.addEventListener('click', (e) => {
  if (!$csPanel.hidden && !$csPanel.contains(e.target) && e.target.id !== 'concepts-settings-btn') {
    $csPanel.hidden = true;
  }
});
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

**`darkroom/darkroom.js`，`openLoraModal()`/`closeLoraModal()`（新的 `openCsModal()`/`closeCsModal()` 照這套動畫收尾寫法抄）：**
```js
async function openLoraModal() {
  $('lora-modal').classList.add('open');
  if (!GEN_LORAS) $('lm-list').innerHTML = '<div class="lora-empty">載入中…</div>';
  renderLmCurrent();
  await fetchGenLoras();
  renderLmCats();
  renderLmSubcats();
  renderLmList($('lm-search').value, true);
  $('lm-search').focus();
}
function closeLoraModal() {
  const modal = $('lora-modal');
  if (!modal.classList.contains('open')) return;
  if (REDUCE_MOTION || document.visibilityState !== 'visible' || !modal.animate) {
    modal.classList.remove('open');
    return;
  }
  const inner = modal.querySelector('.lora-modal-inner');
  const ease = 'cubic-bezier(.4,0,1,1)';
  const anims = [modal.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: ease })];
  if (inner) anims.push(inner.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }],
    { duration: 160, easing: ease }));
  let done = false;
  const finish = () => { if (done) return; done = true; modal.classList.remove('open'); };
  Promise.all(anims.map(a => a.finished)).then(finish).catch(finish);
  setTimeout(finish, 260);
}
$('lora-modal-close').onclick = closeLoraModal;
$('lora-modal').addEventListener('click', e => { if (e.target.id === 'lora-modal') closeLoraModal(); });
```

**`darkroom/darkroom.js`，全域 `keydown` handler 的疊層優先權鏈，`lora-modal` 分支（新分支插在這之前）：**
```js
  if ($('lora-modal').classList.contains('open')) {
    if (e.key === 'Escape') closeLoraModal();
    return;
  }
```

---

### Task 1: HTML + CSS——`.cs-modal` 殼與晶片容器

**Files:**
- Modify: `darkroom/index.html`（齒輪按鈕旁移除舊彈窗、在 `#lora-modal` 前插入新的 `#cs-modal`）
- Modify: `darkroom/darkroom.css`（新增 `.cs-modal` 規則、移除不再需要的舊規則、範圍晶片容器覆寫 padding）

**Interfaces:**
- Produces: `#cs-modal`／`#cs-modal-inner`／`#cs-modal-close` DOM 結構，`.cs-scope-cats[data-slot]`／`.cs-scope-subs[data-slot]` 晶片容器（沿用既有 `.lm-cats`/`.lm-subcats` class）——Task 2 的 JS 會綁定這些元素。
- Consumes: 無（純結構調整）。

- [ ] **Step 1: `index.html` 從 `.concepts-group` 移除舊彈窗，只留齒輪按鈕**

搜尋「現有程式碼速查」裡的「齒輪按鈕 + 現有 `.concepts-settings` 小彈窗整段」原文，整段換成只留這一行：

```html
    <button class="ghost icon-btn" id="concepts-settings-btn" title="設定：一般 LoRA 抽取／Concepts 抽卡" aria-label="設定">⚙</button>
```

（`#cs-tab-seg`/`#cs-tab-general`/`#cs-tab-concepts`/`#cs-tpl-lock` 等等原本在裡面的所有子元素，整段搬到 Step 2 的新結構裡，一個都不遺漏，只是外層容器換掉。）

- [ ] **Step 2: `index.html` 在 `#lora-modal` 前插入新的 `#cs-modal`**

搜尋「現有程式碼速查」裡 `<div id="lora-modal" class="lora-modal">` 這一行，在它之前插入：

```html
<!-- LoRA 抽取設定：⚙ 鈕開，跟 .lora-modal 同一種置中彈窗慣例（背景遮罩＋Esc＋✕都能關）。
     內部兩分頁「一般」（L/K 抽取範圍設定，含 LoRA1/LoRA2 各自的分類/子資料夾晶片）／
     「Concepts」（Concepts 抽卡強度/張數/模板鎖定，跟原本完全一樣，只是換了外殼）。 -->
<div class="cs-modal" id="cs-modal">
  <div class="cs-modal-inner" id="cs-modal-inner">
    <button class="cs-modal-close" id="cs-modal-close" aria-label="關閉" title="關閉 (Esc)">✕</button>
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
      <div class="cs-scope-block">
        <span class="cs-scope-label">LoRA1 範圍</span>
        <div class="lm-cats cs-scope-cats" data-slot="0"></div>
        <div class="lm-subcats cs-scope-subs" data-slot="0"></div>
      </div>
      <div class="cs-scope-block">
        <span class="cs-scope-label">LoRA2 範圍</span>
        <div class="lm-cats cs-scope-cats" data-slot="1"></div>
        <div class="lm-subcats cs-scope-subs" data-slot="1"></div>
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
</div>
```

注意：`<select class="cs-scope-cat"...>`/`<select class="cs-scope-sub"...>` 這兩組下拉**沒有**出現在新結構裡——被 `<div class="lm-cats cs-scope-cats" data-slot="...">`/`<div class="lm-subcats cs-scope-subs" data-slot="...">` 取代，容器留空由 Task 2 的 JS 動態填晶片（跟 LoRA 大面板左欄 `#lm-cats`/`#lm-subcats` 的填法一樣，只是這裡容器 id 沒有寫死、改用 `data-slot` 屬性讓 JS 能選到兩組各自的容器——`document.querySelector('.cs-scope-cats[data-slot="0"]')`）。

- [ ] **Step 3: `darkroom.css` 移除不再需要的舊規則**

搜尋「現有程式碼速查」裡「目前 `.concepts-settings` 區塊」那整段原文，把以下幾條規則**刪除**（其餘保留）：

```css
.concepts-settings { position: absolute; top: calc(100% + 8px); right: 0; z-index: 60;
  width: 260px; background: var(--panel); border: 1px solid var(--line-2); border-radius: 12px;
  box-shadow: var(--shadow); padding: 14px 16px; display: flex; flex-direction: column; gap: 12px;
  animation: lmFadeUp var(--d-ui) var(--ease-entrance) both; }
.concepts-settings[hidden] { display: none; }
@media (prefers-reduced-motion: reduce) { .concepts-settings { animation: none; } }
```

以及：

```css
.cs-row-scope select { flex: 1; min-width: 0; font-size: 11.5px; padding: 3px 6px; }
.cs-row-scope select[hidden] { display: none; }
```

**保留不動**：`.cs-row`／`.cs-row-count`／`.cs-row-check`／`.cs-row-radio`（含子選擇器）、`.cs-tab-seg`／`.cs-tab-panel`／`.cs-tab-panel[hidden]`——這幾條都跟 `<select>` 或舊的錨定小彈窗無關，新結構一樣用得到。

- [ ] **Step 4: `darkroom.css` 新增 `.cs-modal` 規則**

在剛剛刪除 `.concepts-settings` 規則的同一個位置（或緊接在後面，維持這個功能的 CSS 規則聚在一起），加：

```css
/* LoRA 抽取設定：⚙ 鈕開，比照 .lora-modal 同一套置中彈窗慣例（見該規則旁的說明），
   這裡不重用 .lora-modal 這個 class，是因為兩個彈窗的開關時機、內容都各自獨立，
   共用 class 容易在其中一個開著時被另一個的開關邏輯誤觸。 */
.cs-modal { position: fixed; inset: 0; z-index: 200; display: none;
  align-items: center; justify-content: center; padding: 24px;
  background: rgba(8,8,11,.8); backdrop-filter: blur(6px); }
.cs-modal.open { display: flex; animation: fadeIn var(--d-pop) var(--ease-out); }
.cs-modal-inner { position: relative; width: min(720px, 92vw); max-height: 86vh; overflow-y: auto;
  background: var(--panel); border: 1px solid var(--line-2); border-radius: var(--radius);
  box-shadow: var(--shadow); padding: 24px; display: flex; flex-direction: column; gap: 14px;
  animation: modalPop var(--d-pop) var(--ease-entrance); }
@media (prefers-reduced-motion: reduce) { .cs-modal.open, .cs-modal-inner { animation: none; } }
.cs-modal-close { position: absolute; top: 10px; right: 10px; z-index: 2;
  width: 32px; height: 32px; padding: 0; border-radius: 8px; border: 0; background: var(--sunk); color: var(--dim);
  display: grid; place-items: center; cursor: pointer; font-size: 15px; line-height: 1;
  transition: color var(--d-micro) var(--ease-out), background var(--d-micro) var(--ease-out), transform var(--d-micro) var(--ease-out); }
.cs-modal-close:hover { color: var(--ink); background: var(--line-2); }
.cs-modal-close:active { transform: scale(.9); }
.cs-scope-block { display: flex; flex-direction: column; gap: 4px; }
.cs-scope-label { font-size: 12px; color: var(--dim); }
/* .lm-cats/.lm-subcats 原本的 padding（14px 14px 0 / 0 14px）是配合 LoRA 大面板左欄
   那個側欄版面，這裡是彈窗裡的獨立區塊，蓋掉 padding 改用 gap 控制間距。 */
.cs-scope-cats, .cs-scope-subs { padding: 0; }
```

- [ ] **Step 5: 語法檢查**

Run: `node --check darkroom/darkroom.js`
Expected: 無輸出（exit code 0）——這個任務沒有動 JS，這一步是確保 HTML/CSS 的改動沒有連帶弄壞什麼（理論上不會，但每個任務結束都跑一次是這個專案的習慣）。

- [ ] **Step 6: Commit**

```bash
git add darkroom/index.html darkroom/darkroom.css
git commit -m "$(cat <<'EOF'
LoRA 抽取設定：HTML/CSS 改成置中大 modal 殼＋晶片容器

齒輪⚙設定彈窗原本是貼著按鈕右下角的小型錨定彈窗（.concepts-settings，
width:260px），這次改成跟 .lora-modal 同一套置中大彈窗慣例（背景遮罩
＋fadeIn/modalPop 進場），新增 .cs-modal/.cs-modal-inner，不是拿
.lora-modal 這個 class 來重用——兩個彈窗開關時機、內容都各自獨立。

LoRA1/LoRA2 範圍選擇器原本的兩組 <select> 換成空的晶片容器（重用
LoRA 大面板左欄現成的 .lm-cats/.lm-subcats/.lm-cat/.lm-subcat class，
不用寫新樣式），JS 動態填入邏輯留給下一個 commit。
EOF
)"
```

---

### Task 2: JS——modal 開關、晶片渲染、雙向同步、移除舊邏輯

**Files:**
- Modify: `darkroom/darkroom.js`（新增 `openCsModal()`/`closeCsModal()`/`renderCsScopeChips()`/`renderCsScopeSubChips()`，改寫齒輪按鈕綁定與分頁切換段落，移除舊的 `renderCsScopeSelects()`/`renderCsScopeSubSelect()`／change 委派／outside-click 偵測，keydown 優先權鏈插入新分支，兩處 `renderLmCats()`/`renderLmSubcats()` 呼叫點改名）

**Interfaces:**
- Consumes: Task 1 產生的 `#cs-modal`／`#cs-modal-inner`／`#cs-modal-close`／`.cs-scope-cats[data-slot]`／`.cs-scope-subs[data-slot]`（DOM）、既有的 `GEN_LORA_SLOT_SCOPE`／`GEN_ACTIVE_SLOT`／`GEN_LORAS`／`fetchGenLoras()`／`renderLmCats()`／`renderLmSubcats()`／`renderLmList()`（狀態與函式）、`REDUCE_MOTION`（既有全域常數）。
- Produces: `function openCsModal()`、`function closeCsModal()`、`function renderCsScopeChips(slot)`、`function renderCsScopeSubChips(slot)`——這四個是這次改動後設定 modal 的公開介面，之後任何要開關這個 modal 或重繪範圍晶片的地方都該呼叫這幾個，不要重新發明。

- [ ] **Step 1: 刪除舊的 `renderCsScopeSelects()`/`renderCsScopeSubSelect()`，換成晶片版**

搜尋「現有程式碼速查」裡「目前 `renderCsScopeSelects()`/`renderCsScopeSubSelect()`」那整段原文，整段刪除，換成：

```js
// 設定 modal「一般」分頁的 LoRA1/LoRA2 範圍晶片——跟大面板左欄晶片（renderLmCats/
// renderLmSubcats）是同一份 GEN_LORA_SLOT_SCOPE 資料，視覺邏輯也完全比照（分類晶片＋
// 子資料夾晶片，選了分類才出現、只有一種子資料夾值時不顯示），差別只在這裡固定畫兩份
// （slot 0/1 都要看得到），不是只畫「目前作用格」那一份；晶片點擊直接改
// GEN_LORA_SLOT_SCOPE[slot]，不透過 curScope()（curScope() 只會指到作用格）。
function renderCsScopeChips(slot) {
  const box = document.querySelector(`.cs-scope-cats[data-slot="${slot}"]`); if (!box) return;
  const scope = GEN_LORA_SLOT_SCOPE[slot];
  const items = GEN_LORAS || [];
  const counts = {};
  for (const l of items) counts[l.category] = (counts[l.category] || 0) + 1;
  const cats = Object.keys(counts).sort();
  box.innerHTML = '';
  const mk = (key, label, n) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'lm-cat' + (scope.cat === key ? ' on' : '');
    const lb = document.createElement('span'); lb.textContent = label;
    const nb = document.createElement('span'); nb.className = 'lm-cat-n'; nb.textContent = n;
    b.append(lb, nb);
    b.addEventListener('click', () => {
      scope.cat = key; scope.subfolder = '';
      renderCsScopeChips(slot);
      if (slot === GEN_ACTIVE_SLOT) { renderLmCats(); renderLmSubcats(); renderLmList($('lm-search').value, true); }
    });
    box.appendChild(b);
  };
  mk('all', '全部', items.length);
  cats.forEach(c => mk(c, c, counts[c]));
  renderCsScopeSubChips(slot);
}
function renderCsScopeSubChips(slot) {
  const box = document.querySelector(`.cs-scope-subs[data-slot="${slot}"]`); if (!box) return;
  const scope = GEN_LORA_SLOT_SCOPE[slot];
  box.innerHTML = '';
  if (scope.cat === 'all') return;
  const items = (GEN_LORAS || []).filter(l => l.category === scope.cat);
  const counts = {};
  for (const l of items) counts[l.folder] = (counts[l.folder] || 0) + 1;
  const subfolders = Object.keys(counts).sort();
  if (subfolders.length <= 1) return;
  const mk = (key, label, n) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'lm-subcat' + (scope.subfolder === key ? ' on' : '');
    const lb = document.createElement('span'); lb.textContent = label;
    const nb = document.createElement('span'); nb.className = 'lm-subcat-n'; nb.textContent = n;
    b.append(lb, nb);
    b.addEventListener('click', () => {
      scope.subfolder = key;
      renderCsScopeSubChips(slot);
      if (slot === GEN_ACTIVE_SLOT) { renderLmCats(); renderLmSubcats(); renderLmList($('lm-search').value, true); }
    });
    box.appendChild(b);
  };
  mk('', '全部', items.length);
  subfolders.forEach(f => {
    const label = f === scope.cat ? '(根目錄)' : f.slice(scope.cat.length + 1);
    mk(f, label, counts[f]);
  });
}
```

- [ ] **Step 2: 兩處呼叫點改名**

搜尋「現有程式碼速查」裡「兩處 `renderLmCats()`/`renderLmSubcats()` 點擊 handler 呼叫 `renderCsScopeSelects()`」那一行，**兩處都要改**，各自換成：

```js
      renderCsScopeChips(GEN_ACTIVE_SLOT);   // 設定 modal 的晶片要跟著大面板左欄同步
```

（兩處分別在 `renderLmCats()` 的分類晶片點擊 handler、`renderLmSubcats()` 的子資料夾晶片點擊 handler 裡，各自原本呼叫 `renderCsScopeSelects()` 那一行——用「搜尋這行文字」在檔案裡會找到兩個匹配，兩個都要改。）

- [ ] **Step 3: 改寫齒輪按鈕綁定與分頁切換段落**

搜尋「現有程式碼速查」裡「設定彈窗開關與分頁邏輯整段」那一大段原文（從 `const $csPanel = ...` 開始到 `$('cs-tab-general').addEventListener('change', ...)` 那個區塊結束），**整段刪除**，換成：

```js
// LoRA 抽取設定：⚙ 鈕開置中大 modal，比照 .lora-modal 同一套開關方式——背景遮罩點擊、
// ✕、Esc 都能關（見 keydown handler），不再用 document 層級 outside-click 偵測（那個
// 機制本身就是先前修過的一個 bug 的根源模式：click handler 若把被點擊的元素自己從
// DOM 移除，冒泡到 document 判斷式時 Node.contains() 對離線節點一律回傳 false，會被
// 誤判成「點在外面」而自動關閉——這次直接用背景遮罩點擊取代，整類問題不會再發生）。
async function openCsModal() {
  $('cs-modal').classList.add('open');
  await fetchGenLoras();
  renderCsScopeChips(0);
  renderCsScopeChips(1);
  moveCsTabPill();
}
function closeCsModal() {
  const modal = $('cs-modal');
  if (!modal.classList.contains('open')) return;
  if (REDUCE_MOTION || document.visibilityState !== 'visible' || !modal.animate) {
    modal.classList.remove('open');
    return;
  }
  const inner = $('cs-modal-inner');
  const ease = 'cubic-bezier(.4,0,1,1)';
  const anims = [modal.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: ease })];
  if (inner) anims.push(inner.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }],
    { duration: 160, easing: ease }));
  let done = false;
  const finish = () => { if (done) return; done = true; modal.classList.remove('open'); };
  Promise.all(anims.map(a => a.finished)).then(finish).catch(finish);
  setTimeout(finish, 260);
}
$('concepts-settings-btn').onclick = (e) => { e.stopPropagation(); openCsModal(); };
$('cs-modal-close').onclick = closeCsModal;
$('cs-modal').addEventListener('click', e => { if (e.target.id === 'cs-modal') closeCsModal(); });
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
```

**注意這裡刻意移除了什麼、為什麼**：
- 沒有 `const $csPanel = ...` 了——舊的 `.concepts-settings` 元素已經在 Task 1 被拿掉，`#cs-modal`／`#cs-modal-inner` 直接用 `$('cs-modal')`／`$('cs-modal-inner')` 現查現用（跟 `openLoraModal()`/`closeLoraModal()` 的寫法一致，不另外快取成頂層常數）。
- 沒有 `document.addEventListener('click', ...)` 的 outside-click 判斷了——換成 `$('cs-modal').addEventListener('click', e => { if (e.target.id === 'cs-modal') closeCsModal(); })`，只有直接點在遮罩本身（`e.target.id === 'cs-modal'`）才關，點面板內部任何東西都不會誤觸關閉。
- 沒有 `$('cs-tab-general').addEventListener('change', ...)` 了——晶片版的範圍選擇器每個按鈕自己綁 `click` handler（見 Step 1 的 `renderCsScopeChips`/`renderCsScopeSubChips`），不再需要對 `<select>` 的 `change` 事件做委派判斷。

- [ ] **Step 4: keydown 優先權鏈插入 `cs-modal` 的 `Esc` 處理**

搜尋「現有程式碼速查」裡全域 `keydown` handler 的這段原文：
```js
  if ($('lora-modal').classList.contains('open')) {
    if (e.key === 'Escape') closeLoraModal();
    return;
  }
```
在它之前插入（`cs-modal` 排在 `lora-modal` 之前判斷，兩者理論上都可能同時開著，`Esc` 優先關 `cs-modal`，跟 `.cs-modal` 的 `z-index: 200` 大於 `.lora-modal` 的 `z-index: 140`、視覺上蓋在上面一致）：

```js
  if ($('cs-modal').classList.contains('open')) {
    if (e.key === 'Escape') closeCsModal();
    return;
  }
```

- [ ] **Step 5: 語法檢查**

Run: `node --check darkroom/darkroom.js`
Expected: 無輸出（exit code 0）

- [ ] **Step 6: 手動驗證**

啟動隔離埠：
```bash
python darkroom/preview_ui.py --port 8917 --no-open
```
瀏覽器工具開 `http://127.0.0.1:8917/`，依序驗證：

**冷開不空白**（模擬使用者還沒開過 LoRA 大面板就先點齒輪）：
```js
(function(){
  document.getElementById('concepts-settings-btn').click();
  return new Promise(res => setTimeout(() => {
    const cat0 = document.querySelector('.cs-scope-cats[data-slot="0"]');
    res(JSON.stringify({
      modalOpen: document.getElementById('cs-modal').classList.contains('open'),
      chipCount: cat0 ? cat0.children.length : 0,
      firstChipText: cat0 && cat0.children[0] ? cat0.children[0].textContent : null,
    }));
  }, 400));
})();
```
Expected：`modalOpen: true`；`chipCount` 大於 0（至少「全部」那一顆，若測試環境有真實 LoRA 資料則更多）；`firstChipText` 類似 `全部XXX`（不是空的）。

**分頁切換仍正確隱藏/顯示**（沿用既有教訓，用 `getComputedStyle` 不只看 `hidden`）：
```js
(function(){
  const before = {
    generalDisplay: getComputedStyle(document.getElementById('cs-tab-general')).display,
    conceptsDisplay: getComputedStyle(document.getElementById('cs-tab-concepts')).display,
  };
  document.querySelector('#cs-tab-seg [data-tab="concepts"]').click();
  const after = {
    generalDisplay: getComputedStyle(document.getElementById('cs-tab-general')).display,
    conceptsDisplay: getComputedStyle(document.getElementById('cs-tab-concepts')).display,
  };
  document.querySelector('#cs-tab-seg [data-tab="general"]').click();
  return JSON.stringify({ before, after });
})();
```
Expected：`before` general `flex`／concepts `none`；`after` general `none`／concepts `flex`。

**晶片點擊與雙向同步**（需要測試環境的 `GEN_LORAS` 有多個分類；若只有一個分類，記錄下來、跳過雙向同步的細節驗證，改成只確認點擊不報錯）：
```js
(function(){
  switchMode('gen');
  return fetchGenLoras().then(loras => {
    if (!loras.length) return '沒有可用的 LoRA，換一個有設定 LORA_ROOT 的環境測';
    const cats = [...new Set(loras.map(l => l.category))];
    if (cats.length < 2) return JSON.stringify({ note: '只有一個分類，測不出雙向同步細節', cats });
    document.getElementById('concepts-settings-btn').click();
    renderCsScopeChips(0); renderCsScopeChips(1);
    const targetCat = cats.find(c => c !== GEN_LORA_SLOT_SCOPE[0].cat) || cats[1];
    const chip = [...document.querySelectorAll('.cs-scope-cats[data-slot="0"] .lm-cat')].find(b => b.textContent.startsWith(targetCat));
    if (!chip) return JSON.stringify({ note: '找不到對應分類的晶片按鈕', targetCat, cats });
    chip.click();
    return JSON.stringify({
      scope0Cat: GEN_LORA_SLOT_SCOPE[0].cat,
      targetCat,
      bigPanelChipSynced: GEN_ACTIVE_SLOT === 0
        ? (document.querySelector('.lm-cat.on') ? document.querySelector('.lm-cat.on').textContent.startsWith(targetCat) : null)
        : '目前作用格不是 0，不驗證這個分支',
    });
  });
})();
```
Expected：`scope0Cat === targetCat`；若 `GEN_ACTIVE_SLOT` 剛好是 `0`（預設情況），`bigPanelChipSynced` 應為 `true`。

**三種關閉方式**：
```js
(function(){
  const modal = document.getElementById('cs-modal');
  document.getElementById('concepts-settings-btn').click();
  const r1 = modal.classList.contains('open');
  document.getElementById('cs-modal-close').click();
  return new Promise(res => setTimeout(() => {
    const r2 = modal.classList.contains('open');
    document.getElementById('concepts-settings-btn').click();
    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // 上面這行模擬點在 modal 本身（背景），因為 dispatchEvent 的 target 就是 modal 元素本身
    setTimeout(() => {
      const r3 = modal.classList.contains('open');
      document.getElementById('concepts-settings-btn').click();
      setTimeout(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        setTimeout(() => {
          const r4 = modal.classList.contains('open');
          res(JSON.stringify({ openedThenTrue: r1, afterCloseBtn: r2, afterBackdropClick: r3, afterEscape: r4 }));
        }, 400);
      }, 300);
    }, 400);
  }, 300));
})();
```
Expected：`openedThenTrue: true`，`afterCloseBtn/afterBackdropClick/afterEscape` 全部 `false`（每次關閉動畫約 160ms + `setTimeout(finish, 260)` 保險，所以每個關閉判斷前都留了至少 300-400ms 緩衝）。

驗證完停掉這個測試行程（找到 port 8917 的 python 行程 kill 掉）。

- [ ] **Step 7: Commit**

```bash
git add darkroom/darkroom.js
git commit -m "$(cat <<'EOF'
LoRA 抽取設定：JS 改成置中 modal 開關＋範圍改晶片渲染

openCsModal()/closeCsModal() 比照 openLoraModal()/closeLoraModal()
同一套開關與退場動畫寫法（element.animate() 淡出縮小，REDUCE_MOTION
與分頁背景時的保險 setTimeout 都照抄）。renderCsScopeChips(slot)/
renderCsScopeSubChips(slot) 取代原本畫 <select> 的 renderCsScopeSelects()/
renderCsScopeSubSelect()，視覺與互動邏輯比照大面板左欄的
renderLmCats()/renderLmSubcats()，差別是這裡固定畫兩份（LoRA1/LoRA2
都要看得到，不是只畫目前作用格那份）、晶片點擊直接寫
GEN_LORA_SLOT_SCOPE[slot] 而不是透過只會指到作用格的 curScope()。

移除原本的 document 層級 outside-click 偵測，換成標準的背景遮罩
點擊關閉（跟 #tarot/#lora-modal 同一套寫法）——那個 outside-click
機制正是先前修過的一個 bug 的根源模式（click handler 把自己從 DOM
移除、冒泡到 document 判斷式時 Node.contains() 對離線節點一律回傳
false，被誤判成點在外面而自動關閉），換掉之後這整類問題不會再犯。

keydown 優先權鏈裡 cs-modal 的 Esc 判斷排在 lora-modal 之前，跟兩者
的 z-index（200 vs 140）一致——理論上都可能同時開著，Esc 先關視覺上
蓋在上面的那個。
EOF
)"
```

---

### Task 3: 文件同步檢查

**Files:**
- Modify（如有需要）: `darkroom/darkroom.js`（`FEATURE_GROUPS`）、`README.md`
- Modify: `進度.md`

**Interfaces:**
- Consumes: 無新介面，純文案檢查與更新。

- [ ] **Step 1: 檢查 `FEATURE_GROUPS` 措辭是否過時**

搜尋 `darkroom.js` 裡的 `FEATURE_GROUPS`，找生圖分組裡提到「LoRA1/LoRA2 各自獨立抽取範圍」的那一條。如果原文只說「設定彈窗」沒有具體描述成小型下拉彈窗的樣子，不用改；如果原文有跟這次改動衝突的描述（例如提到「下拉選單」），改成描述晶片式即可，一句話帶過，不用大改。

- [ ] **Step 2: 檢查 README.md**

找到 README 裡上一輪補過的「LoRA1/LoRA2 各自記住自己的分類/子資料夾範圍」那段文字，確認沒有跟這次外觀改動（modal + 晶片）衝突的描述；如果有提到具體 UI 型態（下拉選單），順手改成一致的措辭。

- [ ] **Step 3: 更新 `進度.md`**

在 `進度.md` 最上方補一筆，取得這次兩個 commit 的實際 hash（`git log --oneline -2`），格式沿用既有慣例 `### YYYY-MM-DD HH:MM · <hash> <標題>`，說明：設定彈窗從小型錨定彈窗改成置中大 modal（比照 `.lora-modal`）、範圍選擇器從 `<select>` 改成晶片式（重用大面板左欄的 `.lm-cat`/`.lm-subcat`）、outside-click 偵測換成背景遮罩點擊。

- [ ] **Step 4: Commit**

```bash
git add darkroom/darkroom.js README.md 進度.md
git commit -m "README/進度.md：補上設定改置中 modal＋範圍改晶片式的紀錄"
git push
```

（如果 Step 1/2 都沒有實際改動 `darkroom.js`/`README.md`，`git add` 時這兩個檔案就不會有變更可加，只需要 `git add 進度.md` 即可——不要為了湊 commit 內容硬改不需要改的文字。）

---

## Self-Review 對照表（spec → task）

- 新增 `.cs-modal`/`.cs-modal-inner`，比照 `.lora-modal` 慣例 → Task 1
- 移除舊的小型錨定彈窗 CSS/HTML → Task 1
- 範圍選擇器改晶片式，重用 `.lm-cats`/`.lm-cat`/`.lm-subcats`/`.lm-subcat` → Task 1（容器）+ Task 2（渲染邏輯）
- `openCsModal()`/`closeCsModal()`，比照 `openLoraModal()`/`closeLoraModal()` 動畫收尾 → Task 2
- 三種關閉方式（✕／背景遮罩／Esc）→ Task 2，驗證步驟涵蓋全部三種
- `Esc` 優先權鏈插入點（`lora-modal` 判斷之前）→ Task 2 Step 4
- 整段刪除舊的 outside-click 偵測邏輯 → Task 2 Step 3（並在 commit message、程式碼註解裡都說明為什麼）
- `.cs-tab-panel[hidden]` 規則保留不動 → Task 1 Step 3 明確排除在刪除清單外
- 雙向同步（晶片改→大面板同步、大面板改→晶片同步）→ Task 2 Step 1（晶片點擊時機）+ Step 2（大面板點擊呼叫 `renderCsScopeChips`）
- 「不做的事」（不改 Concepts 分頁內容、不新增分頁、不動 `L`/`K`/`GEN_LORA_SLOT_SCOPE`/`curScope()` 資料層邏輯）→ 全程沒有觸碰這些範圍，符合
