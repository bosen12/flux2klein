# 暗房：LoRA1/LoRA2 各自獨立的抽取範圍 ＋ 抽取設定搬進大面板

## 背景

上一輪功能（`docs/superpowers/specs/2026-08-07-darkroom-lora-draw-and-help-panel-design.md`）做完 `L`/`K` 一鍵抽 LoRA 之後，使用者發現兩個問題：

1. `K` 鍵（本分類抽）依賴 LoRA 大面板左欄的 `GEN_LORA_CAT`/`GEN_LORA_SUBFOLDER`，這是**整個面板共用的一份全域狀態**——LoRA1、LoRA2 沒辦法各自設定不同的子路徑範圍（例如 LoRA1 想固定抽 Character/若雞、LoRA2 想固定抽 HENTAI/杜情）。
2. 「抽 LoRA 範圍（兩格都抽／只抽目前作用格）」這顆設定目前塞在 Concepts 設定彈窗裡，跟它實際影響的 LoRA1/LoRA2 選擇離得太遠，使用者覺得應該搬進大面板本身、做得更直觀。

## 目標

- LoRA1、LoRA2 各自記住自己的分類/子資料夾抽取範圍，切分頁卡時自動切換範圍顯示。
- 「抽 LoRA 範圍」單選搬進 LoRA 大面板，跟分頁卡放在一起。

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

## 「抽 LoRA 範圍」單選搬進大面板

`renderLmCurrent()`（`darkroom.js:1846`）在 `renderLmSlotTabs()` 之後、`curSlot()` 內容渲染之前插入一小列：

```
🎲 L/K 抽取：●只抽這格　○兩格都抽
```

沿用既有的 `GEN_LORA_DRAW_SCOPE`／`setGenLoraDrawScope()`（上一輪已做好，邏輯不變，只是換渲染位置）。

Concepts 設定彈窗裡原本那顆單選（`#cs-lora-scope-both`/`#cs-lora-scope-active`，含 `.cs-row-radio` CSS）整組移除，改在 LoRA 大面板重新渲染同一套 radio、綁同一個 `setGenLoraDrawScope()`。

## 文件同步

上一輪的 `SHORTCUT_GROUPS`（`L`/`K` 說明）、`FEATURE_GROUPS`（生圖分組提到「抽 LoRA 範圍」設定位置）、`README.md` 都提到這顆設定在 Concepts 設定彈窗——這次要一併改成「LoRA 大面板」，並補一句「LoRA1/LoRA2 各自記住自己的分類/子資料夾範圍」。

## 不做的事

- 不做「範圍」以外的每格獨立設定（例如每格獨立的抽取池排除清單）。
- 不持久化 `GEN_LORA_SLOT_SCOPE` 到 localStorage，理由同 `GEN_LORA_SLOTS`。
- 不改動 `L` 鍵（全庫抽）的行為——全庫抽本來就跟分類/子資料夾範圍無關，不受這次改動影響。

## 驗收方式

- `node --check darkroom/darkroom.js`
- 隔離 `preview_ui.py` 實例＋瀏覽器工具：切 LoRA1 選 Character/若雞、切 LoRA2 選 HENTAI/杜情，切回 LoRA1 確認晶片＋列表都還原成 Character/若雞；按 `K` 確認抽取池符合目前作用格記住的範圍；Concepts 設定彈窗確認舊的單選已移除、大面板分頁卡下方新單選功能正常且雙向同步 `GEN_LORA_DRAW_SCOPE`。
