# 暗房：新增 18+ 年齡確認視窗

## 背景

暗房目前一進頁面就開始播 `#boot`（沖洗動畫）並同步呼叫 `loadAll()` 抓資料，之後接進場動畫（跑馬燈／無限畫布）。這個工具管理的是成人向詞庫，需要在任何內容（含 boot 動畫本身）出現之前，先跟使用者確認已滿 18 歲。

## 目標

- 頁面最先出現的畫面是年齡確認視窗，`#boot` 與 `loadAll()` 都要等確認之後才開始。
- 只需要在同一次瀏覽階段問一次：分頁或瀏覽器沒關過，重整（含硬重整 Ctrl+F5）都不用再問；分頁或瀏覽器關掉後回來要重新問。
- 選「未滿 18 歲」或「離開」時，畫面留在原地顯示拒絕文字，不觸發任何載入。

## 設計

### 為什麼用 `sessionStorage`

`sessionStorage` 在分頁／瀏覽器關閉時自動清空，一般重整與硬重整都不會清除、也不需要特別處理——瀏覽器原生行為剛好等於「只問一次，除非關掉分頁或瀏覽器」，不用寫額外的「偵測硬重整」邏輯。用 `localStorage` 則會永久記住，不符合「關掉分頁要再問」的需求。

### HTML 結構（`darkroom/index.html`）

`#age-gate` 放在 `<body>` 最前面、`#boot` 之前：

```html
<div id="age-gate">
  <div class="age-gate-card">
    <div class="age-gate-mark">18+</div>
    <h1>年齡確認</h1>
    <p>本站包含成人向詞庫與生成內容，僅限已年滿 18 歲人士使用。</p>
    <div class="age-gate-actions">
      <button id="age-gate-enter" class="age-gate-yes">我已年滿 18 歲，進入</button>
      <button id="age-gate-leave" class="age-gate-no">離開</button>
    </div>
  </div>
</div>
<div id="boot" style="display:none;">
  ...（既有內容不動）
</div>
```

`#boot` 加上初始 `display:none`（原本沒有這個屬性、預設就顯示）——沖洗動畫不再是「一進頁面就播」，改成年齡閘通過後才由 JS 顯示。

### CSS（`darkroom.css`）：獨立的警示風格，不沿用 boot/intro 的毛玻璃質感

- 滿版深底（比 `#boot` 更暗更沉，帶一點紅褐警示色調），置中卡片，大字警語。
- 兩顆按鈕對比明顯：「我已年滿 18 歲」用實心強調色（`--accent`），「離開」用低調的 ghost 樣式——避免視覺上引導使用者誤按離開。
- `z-index` 要高於 `#boot`（以及所有既有疊層），確保是頁面最先看到、也是唯一能互動的內容。
- 拒絕後的文字替換沿用同一張卡片、同一組排版，只是把標題/內文/按鈕换成拒絕訊息，不用另外做一個畫面。

### JS（`darkroom.js`）：擋在既有初始化最前面

在檔案最前面（所有其他初始化邏輯之前）新增：

```js
const AGE_GATE_KEY = 'yz-age-verified';

function startApp() {
  document.getElementById('boot').style.display = '';
  loadAll().then(() => { maybeStartIntro(); pollBatch(); }).finally(hideBoot);
}

function initAgeGate() {
  if (sessionStorage.getItem(AGE_GATE_KEY) === '1') {
    document.getElementById('age-gate').remove();
    startApp();
    return;
  }
  document.getElementById('age-gate-enter').addEventListener('click', () => {
    sessionStorage.setItem(AGE_GATE_KEY, '1');
    document.getElementById('age-gate').remove();
    startApp();
  });
  document.getElementById('age-gate-leave').addEventListener('click', () => {
    document.querySelector('.age-gate-card').innerHTML =
      '<div class="age-gate-mark">18+</div><h1>無法使用</h1><p>很抱歉，本站僅限已滿 18 歲人士使用。</p>';
  });
}

initAgeGate();
```

原本檔案最後一行：

```js
loadAll().then(() => { maybeStartIntro(); pollBatch(); }).finally(hideBoot);
```

搬進 `startApp()`，原位置刪除——`loadAll()` 不再是腳本執行到底就自動跑，改成由 `initAgeGate()` 通過後才觸發。

`initAgeGate()`/`startApp()` 兩個函式宣告可以放在檔案任何位置（`function` 宣告會被提升），但**呼叫** `initAgeGate()` 這一行要放在檔案最後、原本 `loadAll().then(...)` 那一行的位置，不要提前——檔案裡其他模組級變數（`ALL`、`GEN_LORAS` 等）都是照原本順序初始化，`initAgeGate()` 提前呼叫沒有任何好處，反而可能在變數尚未賦值前就被其他程式路徑間接用到，踩到 CLAUDE.md 記錄過的 TDZ 坑。

## 邊界情況

- 遮罩背景、`Esc` 鍵都不觸發任何動作——這不是一般可隨意關閉的疊層，只能透過兩顆按鈕離開。
- 拒絕後手動重整頁面：`sessionStorage` 沒寫入，年齡閘會重新出現，這是預期行為。
- `#age-gate` 通過後直接從 DOM 移除（不是 `display:none`），避免殘留元素影響後續版面或被誤觸。

## 不做的事

- 不做生日輸入或年齡計算，只有「是／否」兩個按鈕。
- 不影響 `#boot`／進場動畫本身的既有邏輯，只是延後觸發時機。
- 不用 `localStorage`，也不做「記住我」之類的加強持久化選項。

## 驗收方式

- `node --check darkroom/darkroom.js`
- 瀏覽器工具驗證：
  - 開新分頁進暗房，確認畫面最先出現的是年齡確認卡片，`#boot` 沖洗動畫與任何內容都還沒出現。
  - 點「我已年滿 18 歲」，確認年齡閘消失、`#boot` 動畫接著播放、資料正常載入。
  - 在同一分頁重整（一般重整與模擬硬重整皆測），確認不再出現年齡閘、直接進沖洗動畫。
  - 用 `sessionStorage.clear()` 模擬「關閉分頁再打開」，確認重整後年齡閘重新出現。
  - 點「離開」，確認卡片內容換成拒絕文字、`#boot` 沒有顯示、network 沒有任何 `/api/*` 請求被觸發（`loadAll()` 沒被呼叫）。
