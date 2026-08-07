# 暗房：LoRA1/LoRA2 各自獨立的抽取範圍 ＋ 設定彈窗改兩分頁

## 背景

上一輪功能（`docs/superpowers/specs/2026-08-07-darkroom-lora-draw-and-help-panel-design.md`）做完 `L`/`K` 一鍵抽 LoRA 之後，使用者發現兩個問題：

1. `K` 鍵（本分類抽）依賴 LoRA 大面板左欄的 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER`，這是**整個面板共用的一份全域狀態**——LoRA1、LoRA2 沒辦法各自設定不同的子路徑範圍（例如 LoRA1 想固定抽 Character/若雞、LoRA2 想固定抽 HENTAI/杜情）。
2. 「抽 LoRA 範圍（兩格都抽／只抽目前作用格）」這顆設定目前塞在 Concepts 設定彈窗裡，跟 Concepts 抽卡本身的強度/張數/模板鎖定混在一起，語意上不是同一件事（一個是給一般生圖模式的 L/K 用，一個是給 Concepts 的 C/X 用）。

## 目標

- LoRA1、LoRA2 各自記住自己的分類/子資料夾抽取範圍，切分頁卡時自動切換範圍顯示。
- 現有齒輪 ⚙ 設定彈窗改分兩分頁：「一般」（L/K 抽取範圍）／「Concepts」（原本的強度/張數/模板鎖定），不搬去別的地方，維持同一個入口。

## 設計：範圍跟「作用格」綁定，直接重用左欄晶片

不新增另一套範圍選擇器。左欄的分類/子資料夾晶片本來就是「目前在瀏覽/設定的範圍」，現在讓它變成**跟目前作用格（`GEN_ACTIVE_SLOT`）綁定**——切到哪一格，晶片就顯示、也控制那一格的範圍。

### 狀態

新增（`darkroom.js`，跟 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER` 宣告放一起）：

```js
const GEN_LORA_SLOT_SCOPE = [{ cat: 'all', subfolder: '' }, { cat: 'all', subfolder: '' }];
```

Session-only，不存 localStorage——跟 `GEN_LORA_SLOTS` 同一個理由：LoRA 內容可能隨重掃變動，跨分頁留著一個可能已經不存在的分類沒有意義。

### 切格時存舊、還原新

所有目前直接寫 `GEN_ACTIVE_SLOT = i` 的地方（`renderLmSlotTabs()` 的分頁卡點擊、清空按鈕、`selectGenLora()` 自動選空格那三處）統一改呼叫新函式：

```js
function setActiveSlot(i) {
  GEN_LORA_SLOT_SCOPE[GEN_ACTIVE_SLOT] = { cat: GEN_LORA_CAT, subfolder: GEN_LORA_SUBFOLDER };
  GEN_ACTIVE_SLOT = i;
  const restored = GEN_LORA_SLOT_SCOPE[i];
  GEN_LORA_CAT = restored.cat;
  GEN_LORA_SUBFOLDER = restored.subfolder;
  renderLmCats(); renderLmSubcats(); renderLmList($('lm-search').value, true);
}
```

左欄晶片渲染（`renderLmCats()`/`renderLmSubcats()`）、`loraCatPool()`、`K` 鍵完全不用改——它們讀寫的還是同一個 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER`，現在這兩個全域變數的內容代表的是「目前作用格的範圍」。

### 副作用（已跟使用者確認 OK）

`E`（🎲 隨機瀏覽疊層本分類重抽）與 Concepts 的 `X` 鍵也讀同一份 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER`，行為會自動跟著「目前作用格」走——以前這兩個鍵抽的是「你上次點的分類」，之後會變成「目前作用格記住的分類」。這是設計的自然結果，不用另外處理例外。

## 設定彈窗改兩分頁：一般／Concepts

沿用 `使用說明` 疊層剛做好的兩分頁模式（`.seg`/`.seg-pill` 分段切換 + 兩個內容容器切 `hidden`），套在既有的 `#concepts-settings` 彈窗上，不新增彈窗、不新增進入點。

`darkroom/index.html`：`#concepts-settings` 內部最上方加一列分頁切換，原本的內容拆成兩個容器：

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
  </div>
  <div class="cs-tab-panel" id="cs-tab-concepts" hidden>
    <!-- 原本 Character 強度／concepts 強度／每次抽幾張／同時抽詞庫模板／模板只抽目前資料夾／
         鎖定模板搜尋 這幾列整段搬進來，內容不變 -->
  </div>
</div>
```

`darkroom.css`：`.cs-tab-panel` 沿用 `.concepts-settings` 本來的 `display:flex; flex-direction:column; gap:12px`，並**務必**加 `.cs-tab-panel[hidden] { display: none; }`——這正是上一輪最終審查抓到的「共用 flex class 蓋掉 `[hidden]`」那個坑（`.shortcuts-groups[hidden]`），這次從一開始就直接加對，不要重蹈覆轍。

`darkroom.js`：分頁切換邏輯直接複製「使用說明」那組 `moveHelpPill()`/click handler 的寫法（`moveCsTabPill()` + `#cs-tab-seg` 的 click handler，toggle `#cs-tab-general`/`#cs-tab-concepts` 的 `hidden`）。

齒輪按鈕 `#concepts-settings-btn` 的 `title`/`aria-label` 從「Concepts 抽卡設定：強度／張數／是否抽詞庫模板」改成「設定：一般 LoRA 抽取／Concepts 抽卡」，反映裡面現在有兩件不同的事。

## 文件同步

上一輪的 `SHORTCUT_GROUPS`（`L`/`K` 說明）、`FEATURE_GROUPS`（生圖分組提到「抽 LoRA 範圍」設定位置）、`README.md` 目前沒特別點名「在哪個分頁」，這次要補一句「設定彈窗的『一般』分頁」，並補一句「LoRA1/LoRA2 各自記住自己的分類/子資料夾範圍」。

## 不做的事

- 不做「範圍」以外的每格獨立設定（例如每格獨立的抽取池排除清單）。
- 不持久化 `GEN_LORA_SLOT_SCOPE` 到 localStorage，理由同 `GEN_LORA_SLOTS`。
- 不改動 `L` 鍵（全庫抽）的行為——全庫抽本來就跟分類/子資料夾範圍無關，不受這次改動影響。

## 驗收方式

- `node --check darkroom/darkroom.js`
- 隔離 `preview_ui.py` 實例＋瀏覽器工具：切 LoRA1 選 Character/若雞、切 LoRA2 選 HENTAI/杜情，切回 LoRA1 確認晶片＋列表都還原成 Character/若雞；按 `K` 確認抽取池符合目前作用格記住的範圍；打開設定彈窗確認預設在「一般」分頁看得到 L/K 抽取範圍單選，切到「Concepts」分頁確認強度/張數/模板鎖定都還在且功能正常，且**用 `getComputedStyle(...).display` 而不是只看 `hidden` 屬性**驗證分頁切換真的有隱藏/顯示對應內容（上一輪的教訓）。
