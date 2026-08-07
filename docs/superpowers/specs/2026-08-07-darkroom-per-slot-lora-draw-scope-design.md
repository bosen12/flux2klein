# 暗房：LoRA1/LoRA2 各自獨立的抽取範圍 ＋ 設定彈窗改兩分頁

## 背景

上一輪功能（`docs/superpowers/specs/2026-08-07-darkroom-lora-draw-and-help-panel-design.md`）做完 `L`/`K` 一鍵抽 LoRA 之後，使用者發現兩個問題：

1. `K` 鍵（本分類抽）依賴 LoRA 大面板左欄的 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER`，這是**整個面板共用的一份全域狀態**——LoRA1、LoRA2 沒辦法各自設定不同的子路徑範圍（例如 LoRA1 想固定抽 Character/若雞、LoRA2 想固定抽 HENTAI/杜情）。
2. 「抽 LoRA 範圍（兩格都抽／只抽目前作用格）」這顆設定目前塞在 Concepts 設定彈窗裡，跟 Concepts 抽卡本身的強度/張數/模板鎖定混在一起，語意上不是同一件事。
3. 就算範圍分格記住了，要改某一格的範圍還是得先切到 LoRA 大面板、點對分頁卡、再點左欄晶片，使用者希望能直接在設定彈窗裡把兩格的範圍都看到、都改掉，不用來回切面板。

## 目標

- LoRA1、LoRA2 各自獨立記住自己的分類/子資料夾抽取範圍。
- 現有齒輪 ⚙ 設定彈窗改分兩分頁：「一般」（L/K 抽取範圍 + LoRA1/LoRA2 範圍選擇器）／「Concepts」（原本的強度/張數/模板鎖定），不新增別的入口。
- 「一般」分頁跟 LoRA 大面板左欄晶片是同一份狀態、雙向同步：不管從哪邊改，另一邊都要跟著更新。

## 設計：單一真相來源，不做手動同步

**把 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER` 這兩個全域變數整個拿掉**，改成一個以格為索引的陣列，所有讀寫都直接對這個陣列操作：

```js
const GEN_LORA_SLOT_SCOPE = [{ cat: 'all', subfolder: '' }, { cat: 'all', subfolder: '' }];
function curScope() { return GEN_LORA_SLOT_SCOPE[GEN_ACTIVE_SLOT]; }
```

Session-only，不存 localStorage——跟 `GEN_LORA_SLOTS` 同一個理由：LoRA 內容可能隨重掃變動，跨分頁留著一個可能已經不存在的分類沒有意義。

**為什麼不做「切格時存舊、還原新」的複製同步：** 那種寫法有兩份資料（全域目前值 + 每格快照），任何一個新增的讀寫點忘記同步就會兜不起來（例如這次新增的設定彈窗雙格選擇器，如果沿用複製同步，改「非作用格」時要嘛也要弄一份 mini 版全域狀態、要嘛得直接戳陣列，两條路都容易在跟原本的複製同步邏輯打架時出錯）。改成單一陣列 + 一個 index 指標，任何地方讀寫都只有一個地方可能是真相，不會不同步。

### 所有既有讀寫點的改法

- `renderLmCats()`（`darkroom.js`，找 `function renderLmCats() {` 這行）：內部所有 `GEN_LORA_CAT` 讀取改成 `curScope().cat`；點擊分類晶片的 handler 裡 `GEN_LORA_CAT = key; GEN_LORA_SUBFOLDER = '';` 改成 `curScope().cat = key; curScope().subfolder = '';`。
- `renderLmSubcats()`（找 `function renderLmSubcats() {` 這行）：同樣把 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER` 讀寫換成 `curScope().cat`/`curScope().subfolder`。
- `loraCatPool()`（找 `function loraCatPool() {` 這行）：篩選條件裡的 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER` 換成 `curScope().cat`/`curScope().subfolder`。
- `loraCatLabel()`：同樣換成 `curScope()`。
- Concepts 的 `X` 鍵（`drawConceptsTarotByCategory()` 裡引用 `GEN_LORA_CAT === 'Character'`/`GEN_LORA_CAT === 'HENTAI'` 那兩處）：換成 `curScope().cat`。這是刻意的行為延續——`X` 鍵本來就該跟著「目前作用格」的分類篩選走（上一輪已跟使用者確認過這個副作用可接受）。

### `setActiveSlot()`：不用再手動搬資料

因為範圍已經是「以格為索引」的陣列、`curScope()` 永遠讀當下 `GEN_ACTIVE_SLOT`，切格不需要複製任何東西，只要換 index、重繪晶片：

```js
function setActiveSlot(i) {
  GEN_ACTIVE_SLOT = i;
  renderLmCats();
  renderLmSubcats();
}
```

所有目前直接寫 `GEN_ACTIVE_SLOT = i` 或 `GEN_ACTIVE_SLOT = emptyIdx` 的三個地方都要改叫這個函式（叫完之後跟原本一樣，呼叫端自己接著呼叫 `renderLmCurrent()`/`renderLmList(...)`，`setActiveSlot()` 不做這兩件事）：

1. `renderLmSlotTabs()` 裡分頁卡的 `click` handler：`GEN_ACTIVE_SLOT = i;` → `setActiveSlot(i);`
2. 同一個函式裡「清空 LoRA」按鈕的 `click` handler：`GEN_ACTIVE_SLOT = i;` → `setActiveSlot(i);`
3. `applyLoraPush()` 裡：`if (emptyIdx !== -1) GEN_ACTIVE_SLOT = emptyIdx;` → `if (emptyIdx !== -1) setActiveSlot(emptyIdx);`

## 設定彈窗改兩分頁：一般／Concepts

沿用「使用說明」疊層已經做好的兩分頁模式（`.seg`/`.seg-pill` 分段切換 + 兩個內容容器切 `hidden`），套在既有的 `#concepts-settings` 彈窗上，不新增彈窗、不新增進入點。

`darkroom/index.html`：`#concepts-settings` 內部最上方加一列分頁切換，原本內容整段搬進「Concepts」分頁容器，「一般」分頁新增 L/K 單選 + LoRA1/LoRA2 兩組範圍下拉：

```html
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
    <div class="cs-row cs-row-scope" data-slot="0">
      <span>LoRA1 範圍</span>
      <select class="cs-scope-cat" data-slot="0"></select>
      <select class="cs-scope-sub" data-slot="0"></select>
    </div>
    <div class="cs-row cs-row-scope" data-slot="1">
      <span>LoRA2 範圍</span>
      <select class="cs-scope-cat" data-slot="1"></select>
      <select class="cs-scope-sub" data-slot="1"></select>
    </div>
  </div>
  <div class="cs-tab-panel" id="cs-tab-concepts" hidden>
    <!-- 原本 Character 強度／concepts 強度／每次抽幾張／同時抽詞庫模板／模板只抽目前資料夾／
         鎖定模板搜尋 這幾列整段搬進來，內容不變 -->
  </div>
</div>
```

### 下拉選單的資料與行為

兩組下拉（`.cs-scope-cat`／`.cs-scope-sub`，各自用 `data-slot` 標記對應哪一格）是 `renderLmCats()`/`renderLmSubcats()` 的下拉版本，資料來源相同（`GEN_LORAS` 依 `category`/`folder`分組計數），但畫成 `<select>` 而不是晶片——設定彈窗窄，兩組並排用晶片會擠爆。

新增 `renderCsScopeSelects()`：

```js
function renderCsScopeSelects() {
  const items = GEN_LORAS || [];
  const counts = {};
  for (const l of items) counts[l.category] = (counts[l.category] || 0) + 1;
  const cats = Object.keys(counts).sort();
  [0, 1].forEach((slot) => {
    const scope = GEN_LORA_SLOT_SCOPE[slot];
    const catSel = document.querySelector(`.cs-scope-cat[data-slot="${slot}"]`);
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

change 事件（用事件委派掛在 `#cs-tab-general` 上，兩組下拉共用同一套邏輯）：

```js
$('cs-tab-general').addEventListener('change', (e) => {
  const slot = e.target.dataset.slot; if (slot === undefined) return;
  const i = Number(slot);
  const scope = GEN_LORA_SLOT_SCOPE[i];
  if (e.target.classList.contains('cs-scope-cat')) {
    scope.cat = e.target.value;
    scope.subfolder = '';   // 換分類，子資料夾篩選跟著清掉，跟 renderLmCats() 晶片版同一個規則
    renderCsScopeSubSelect(i);
  } else if (e.target.classList.contains('cs-scope-sub')) {
    scope.subfolder = e.target.value;
  } else {
    return;
  }
  if (i === GEN_ACTIVE_SLOT) { renderLmCats(); renderLmSubcats(); renderLmList($('lm-search').value, true); }
});
```

`i === GEN_ACTIVE_SLOT` 這個判斷就是雙向同步的關鍵：改到「目前作用格」那組下拉，大面板左欄晶片跟著重繪；改到「另一格」，大面板當下看不到那格的晶片，不用重繪。

**反向同步**（從大面板左欄晶片改，設定彈窗要跟著變）：`renderLmCats()`/`renderLmSubcats()` 的晶片點擊 handler 結尾，除了原本呼叫 `renderLmCats(); renderLmSubcats();`，都要加一行 `renderCsScopeSelects()`（設定彈窗沒開著時呼叫這個函式是安全的、便宜的 DOM 操作，不用另外判斷彈窗是否可見）。

彈窗打開時（`#concepts-settings-btn` 的 `onclick`）也要呼叫一次 `renderCsScopeSelects()`，確保每次開啟都是最新狀態。

### CSS

`.cs-row-scope` 沿用 `.cs-row` 的排版（`display:flex; align-items:center; gap:8px`），兩個 `<select>` 各自 `flex:1; min-width:0`：

```css
.cs-row-scope select { flex: 1; min-width: 0; font-size: 11.5px; padding: 3px 6px; }
.cs-row-scope select[hidden] { display: none; }
```

`.cs-tab-panel` 沿用 `.concepts-settings` 本來的 `display:flex; flex-direction:column; gap:12px`，並**務必**加：

```css
.cs-tab-panel[hidden] { display: none; }
```

這正是上一輪最終審查抓到的「共用 flex class 蓋掉 `[hidden]`」那個坑（`.shortcuts-groups[hidden]`），這次從一開始就直接加對，不要重蹈覆轍。

### JS：分頁切換

分頁切換邏輯直接複製「使用說明」那組 `moveHelpPill()`/click handler 的寫法：

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
```

`#concepts-settings-btn` 的 `onclick`（開關彈窗那個既有 handler）要加一行 `moveCsTabPill()`，確保每次開啟時分頁指示條位置正確（比照 `openShortcuts()` 的做法）。

齒輪按鈕 `#concepts-settings-btn` 的 `title`/`aria-label` 從「Concepts 抽卡設定：強度／張數／是否抽詞庫模板」改成「設定：一般 LoRA 抽取／Concepts 抽卡」，反映裡面現在有兩件不同的事。

## 文件同步

上一輪的 `SHORTCUT_GROUPS`（`L`/`K` 說明）、`FEATURE_GROUPS`（生圖分組提到「抽 LoRA 範圍」設定位置）、`README.md` 要補：這顆設定在「設定彈窗的『一般』分頁」；LoRA1/LoRA2 各自獨立記住分類/子資料夾範圍，設定彈窗跟大面板左欄晶片雙向同步。

## 不做的事

- 不做「範圍」以外的每格獨立設定（例如每格獨立的抽取池排除清單）。
- 不持久化 `GEN_LORA_SLOT_SCOPE` 到 localStorage，理由同 `GEN_LORA_SLOTS`。
- 不改動 `L` 鍵（全庫抽）的行為——全庫抽本來就跟分類/子資料夾範圍無關。
- 不做兩組下拉之間的連動限制（例如「LoRA1、LoRA2 不能選一樣的範圍」）——使用者本來就可能故意兩格都想抽同一個分類，不用擋。

## 驗收方式

- `node --check darkroom/darkroom.js`
- 隔離 `preview_ui.py` 實例＋瀏覽器工具：
  - 切 LoRA1 分頁卡、左欄選 Character/若雞；切 LoRA2 分頁卡、左欄選 HENTAI/杜情；切回 LoRA1 確認晶片還原成 Character/若雞。
  - 打開設定彈窗「一般」分頁，確認 LoRA1／LoRA2 兩組下拉分別顯示 Character/若雞、HENTAI/杜情；在設定彈窗把 LoRA2 範圍改成別的分類，確認**大面板此時看不到變化**（因為 LoRA2 不是作用格）；切到 LoRA2 分頁卡，確認晶片變成剛剛在設定彈窗選的新分類。
  - 在設定彈窗把 LoRA1（目前作用格）範圍改掉，確認大面板左欄晶片**立刻**跟著變。
  - 按 `K` 確認抽取池符合目前作用格記住的範圍。
  - 切到「Concepts」分頁確認強度/張數/模板鎖定都還在且功能正常；用 `getComputedStyle(...).display` 而不是只看 `hidden` 屬性驗證分頁切換真的有隱藏/顯示對應內容。
