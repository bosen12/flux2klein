# 暗房：LoRA 抽取設定改成置中大 Modal ＋ 範圍改晶片式

## 背景

上一輪功能把齒輪 ⚙ 設定彈窗拆成「一般」／「Concepts」兩分頁，「一般」分頁裡 LoRA1/LoRA2 的抽取範圍用兩組 `<select>` 下拉選單——因為當時彈窗還是貼著齒輪按鈕右下角的小型錨定彈窗（`.concepts-settings`，`position:absolute; width:260px`），空間窄，只能用下拉選單。使用者覺得應該改成跟 LoRA 大面板同級別、置中顯示的大面板，這樣空間夠大，範圍選擇也能改成跟 LoRA 大面板左欄一樣直觀的晶片式（看得到張數、選中有高亮），不用擠在下拉選單裡。

## 目標

- 齒輪 ⚙ 設定入口從小型錨定彈窗改成置中大 modal，視覺語言跟既有的 `.lora-modal`／`.shortcuts-overlay` 一致。
- 「一般」分頁的 LoRA1/LoRA2 範圍選擇器從 `<select>` 改成分類/子資料夾晶片。
- 「Concepts」分頁內容原封不動搬進新殼。

## 設計：新增 `.cs-modal`，不是改造既有疊層

新增一組獨立的置中彈窗類別 `.cs-modal`/`.cs-modal-inner`，結構與行為完全比照專案裡既有的兩個同級疊層（`.lora-modal`／`.shortcuts-overlay`），不是把這兩個既有疊層拿來重用——那兩個各自是獨立實作，這次也一樣獨立開一組，理由是三個疊層各自的內容/開關時機都不同，共用 class 容易在其中一個疊層開著時被另一個的開關邏輯誤觸。

### HTML 結構

```html
<div class="cs-modal" id="cs-modal">
  <div class="cs-modal-inner" id="cs-modal-inner">
    <button class="cs-modal-close" id="cs-modal-close" aria-label="關閉">✕</button>
    <div class="seg cs-tab-seg" id="cs-tab-seg" role="group" aria-label="設定分頁">
      <span class="seg-pill" id="cs-tab-pill" aria-hidden="true"></span>
      <button data-tab="general" class="on">一般</button>
      <button data-tab="concepts">Concepts</button>
    </div>
    <div class="cs-tab-panel" id="cs-tab-general">
      <!-- L/K 範圍單選（原樣）+ LoRA1/LoRA2 晶片式範圍選擇器（見下） -->
    </div>
    <div class="cs-tab-panel" id="cs-tab-concepts" hidden>
      <!-- 原本 Concepts 內容整段搬進來，不動 -->
    </div>
  </div>
</div>
```

`#concepts-settings-btn`（齒輪鈕）不再是開關 `hidden` 屬性的 toggle，改成呼叫 `openCsModal()`。

### CSS：比照 `.lora-modal`/`.shortcuts-overlay` 的置中彈窗慣例

```css
.cs-modal { position: fixed; inset: 0; z-index: 200; display: none;
  align-items: center; justify-content: center; background: rgba(8,8,11,.8); backdrop-filter: blur(6px); }
.cs-modal.open { display: flex; animation: fadeIn var(--d-pop) var(--ease-out); }
.cs-modal-inner { position: relative; width: min(720px, 92vw); max-height: 86vh; overflow-y: auto;
  background: var(--panel); border: 1px solid var(--line-2); border-radius: 14px; box-shadow: var(--shadow);
  padding: 24px; animation: modalPop var(--d-pop) var(--ease-out) both; }
@media (prefers-reduced-motion: reduce) { .cs-modal.open, .cs-modal-inner { animation: none; } }
.cs-modal-close { position: absolute; top: 10px; right: 10px; }
```

（`z-index: 200`：略低於 `.shortcuts-overlay` 的 `210`，這樣「使用說明」疊層理論上永遠蓋在最上層，跟其他疊層的堆疊順序維持既有慣例——高優先權的說明/導覽類疊層蓋過功能性疊層。）

### JS：開關函式比照 `openLoraModal()`/`closeShortcuts()` 的動畫收尾寫法

```js
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
```

`openCsModal()` 直接 `await fetchGenLoras()` 再渲染，這樣就不會重蹈上一輪修過的「冷開空白」問題——不需要額外的 timing 技巧，開啟本身就是非同步流程的自然起點。

**關閉三種方式**：
1. `#cs-modal-close`（✕ 鈕）點擊呼叫 `closeCsModal()`。
2. 點背景遮罩：`$('cs-modal').addEventListener('click', e => { if (e.target.id === 'cs-modal') closeCsModal(); });`（比照 `#tarot` 的背景點擊判斷）。
3. `Esc` 鍵：在全域 `keydown` handler 的疊層優先權鏈裡插入新分支。目前鏈的順序是「快捷鍵一覽 → LoRA 隨機瀏覽疊層 → Concepts 抽卡疊層 → **這裡新增 cs-modal** → lora-modal → 大圖 → 抽卡」，插入點在 `lora-modal` 判斷之前（比照 `shortcuts-overlay` 排最前面的邏輯，`cs-modal` 不需要排到最前面，但要早於 `lora-modal`，因為兩者都可能同時開著——`Esc` 應該先關最後開的那個，這裡簡化成固定順序，跟現有 `LORA_TAROT`／`CONCEPTS_TAROT` 兩個疊層固定順序判斷是同一種簡化）：

```js
if ($('cs-modal').classList.contains('open')) {
  if (e.key === 'Escape') { closeCsModal(); return; }
  return;
}
```

**移除**：原本 `document.addEventListener('click', ...)` 那個「點外面關閉」的判斷式（連同它修過的 `e.stopPropagation()` 那個 bug 的上下文）整段刪除——`cs-modal` 用背景遮罩點擊關閉取代，不再需要 outside-click 偵測，這個機制本身就是上一輪那個「選模板面板自動關閉」bug 的根源模式，換掉之後這整類 bug 也一併消失。

### 範圍晶片：`renderCsScopeChips(slot)` 取代 `renderCsScopeSelects()`/`renderCsScopeSubSelect()`

視覺與互動邏輯完全比照 `renderLmCats()`/`renderLmSubcats()`（分類晶片 + 子資料夾晶片，選了分類才顯示子資料夾晶片、只有一種子資料夾值時不顯示），差別只在：這裡固定畫兩份（`slot 0`/`slot 1`），不是畫「目前作用格」那一份；晶片點擊直接改 `GEN_LORA_SLOT_SCOPE[slot]`，不透過 `curScope()`。

```js
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

反向同步（LoRA 大面板左欄晶片被點擊時，`cs-modal` 的晶片要跟著變）：`renderLmCats()`/`renderLmSubcats()` 的點擊 handler 裡，把原本呼叫 `renderCsScopeSelects()` 的那一行改呼叫 `renderCsScopeChips(GEN_ACTIVE_SLOT)`。

`.cs-row-scope` 的 HTML 從 `<select>` 改成兩個晶片容器：

```html
<div class="cs-row-scope-block">
  <span class="cs-scope-label">LoRA1 範圍</span>
  <div class="cs-scope-cats" data-slot="0"></div>
  <div class="cs-scope-subs" data-slot="0"></div>
</div>
<div class="cs-row-scope-block">
  <span class="cs-scope-label">LoRA2 範圍</span>
  <div class="cs-scope-cats" data-slot="1"></div>
  <div class="cs-scope-subs" data-slot="1"></div>
</div>
```

晶片本身沿用既有的 `.lm-cat`/`.lm-subcat` class（跟大面板左欄視覺完全一致），只需要幫 `.cs-scope-cats`/`.cs-scope-subs` 容器加 `display:flex; flex-wrap:wrap; gap:6px` 讓晶片能換行（大面板左欄是固定高度可捲動側欄，這裡是彈性寬度的區塊，排版容器不同但晶片本身樣式不用重寫）。

### 移除項目

- `#cs-lora-scope-both`/`#cs-lora-scope-active` 兩個 radio 本身**不動**（L/K 兩格都抽／只抽作用格的單選，跟這次改動無關）。
- `renderCsScopeSelects()`/`renderCsScopeSubSelect()` 兩個函式與對應的 `<select>` change 事件委派整段刪除，取代成上面的晶片版本。
- 原本 `$('concepts-settings-btn').onclick` 裡 `$csPanel.hidden = !$csPanel.hidden` 的 toggle 邏輯、`document.addEventListener('click', ...)` 的 outside-click 判斷整段刪除，換成 `openCsModal()`/`closeCsModal()`。

## 不做的事

- 不改 Concepts 分頁內容本身（強度/張數/模板勾選/鎖定模板搜尋），只是換容器。
- 不做 modal 內部再細分更多分頁或功能，範圍就是「一般」／「Concepts」兩頁。
- 不影響 `L`/`K` 快捷鍵、`GEN_LORA_SLOT_SCOPE`/`curScope()` 的既有邏輯——這次純粹是 UI 容器與範圍選擇器外觀的改動，資料層不變。

## 驗收方式

- `node --check darkroom/darkroom.js`
- 隔離 `preview_ui.py` 實例＋瀏覽器工具：
  - 點齒輪鈕開啟，確認是置中大面板（不是貼著按鈕的小彈窗），且冷開（沒開過 LoRA 大面板）就能看到晶片有正確張數（驗證 `openCsModal()` 的 `await fetchGenLoras()` 真的解決了冷開空白問題）。
  - 點 LoRA1 範圍的分類晶片，確認子資料夾晶片正確出現/消失、大面板左欄（如果 LoRA1 剛好是作用格）跟著同步。
  - 改 LoRA2（非作用格）的晶片，確認 `cs-modal` 內部立刻反映、但大面板左欄當下不變。
  - 點背景遮罩、點 ✕、按 `Esc` 三種方式都能關閉。
  - 用 `getComputedStyle` 確認「一般」/「Concepts」分頁切換依然正確隱藏/顯示（沿用上一輪的驗證習慣，`.cs-tab-panel[hidden]` 這條規則要留著，容器換了外殼不代表這個坑不會再犯）。
