# 暗房：可互動的 3D 卡片展示模式（table/sphere/helix/grid）

## 背景

使用者參考 three.js 官方範例 [css3d_periodictable](https://threejs.org/examples/css3d_periodictable.html)：118 個化學元素方塊可以在 `table`／`sphere`／`helix`／`grid` 四種排列間動畫切換，還能滑鼠拖曳整個場景旋轉、滾輪縮放。想在暗房裡做一個類似的、真正好玩／炫的互動展示模式，套用在暗房既有的兩個卡片格線上：**詞庫瀏覽格線**與**LoRA 大面板左欄清單**。要求全程考慮效能。

## 目標

- 一個共用的 vanilla JS 元件，把一批卡片元素排成 `grid`／`sphere`／`helix`／`table` 四種 3D 排列，並能動畫切換。
- 場景整體可以滑鼠拖曳旋轉（帶慣性）、滾輪／雙指縮放。
- 套用在詞庫瀏覽格線與 LoRA 大面板清單兩處，各自一顆進入按鈕。
- 效能：不因為卡片數量（詞庫上千筆、LoRA 895 筆）卡死或塞爆 DOM；尊重 `prefers-reduced-motion`；沒有 3D transform 支援時直接不顯示入口，不做醜陋降級。

## 不做的事

- 不用 three.js 的 `CSS3DRenderer`／`TWEEN.js`——矩陣運算＋緩動手刻，理由見下方「技術選型」。這個元件本身**不依賴 three.js**，跟現有的 Vanta.js 背景（`three.min.js`／`vanta.fog.min.js`）完全獨立，不共用、不互相影響。
- 不做「真正的透視相機投影」（camera frustum、near/far clipping）——用 CSS `perspective` 模擬即可，跟參考範例的視覺效果已經足夠接近，沒必要重造一個投影矩陣系統。
- 不支援兩個格線以外的內容（例如抽卡塔羅牌陣、圖庫）——這次只做這兩個入口，未來要擴充再說。

## 技術選型：手刻 matrix3d，不用 three.js CSS3DRenderer

`CSS3DRenderer` 本質不是 WebGL：它是「用 three.js 的場景圖＋相機數學算出每個物件的變換矩陣，寫進真實 DOM 元素的 `transform: matrix3d(...)`」，實際渲染完全交給瀏覽器合成器。對這個專案來說，為了一段矩陣運算多背一個已經 vendor 但這裡用不到 WebGL 能力的重庫（`three.min.js`）不划算，尤其專案本來就是「vanilla JS、無 build step」的路線。四種排列公式（grid 平面座標、sphere 球面座標、helix 螺旋座標、table 沿用平面格線位置）都是通用參數化數學，直接手刻成「輸入索引 i、輸出 `{x,y,z,rotX,rotY}`」的函式即可，不需要場景圖。

緩動用 Web Animations API（`element.animate()`）——這是這個專案既有的主要動畫手段（`darkroom.js`／`app.js` 到處都是），不用另外引入 TWEEN.js。

## 效能：資料量上限

這是這次要求特別注意的地方。詞庫瀏覽格線曾經因為「上千筆全部塞進 DOM」出過效能問題（`darkroom.js` 已有的「大資料夾虛擬捲動」就是為了解決同一個量級的問題），3D 展示模式一樣會踩到——要動畫切排列，素材必須同時是真實 DOM 節點，不能虛擬捲動。

- **詞庫瀏覽格線**：進入 3D 模式時，不管目前篩選了多少筆，固定從目前篩選結果裡**隨機抽樣 100~150 筆**（可調常數）展示。只在「進入 3D 模式」那個時間點抽樣一次，之後在 `grid`／`sphere`／`helix`／`table` 之間切換都是同一批卡片變換隊形，不會每切一次排列就重新抽樣（不然會失去「同一批卡片變換隊形」的樂趣，也違背使用者要的效果）。
- **LoRA 大面板清單**：直接用目前左欄篩選結果（分類/子資料夾晶片篩過的範圍），不用額外抽樣；但一樣設數量上限（例如 200），超過就 toast 提示「先用左欄晶片縮小範圍」再開 3D 模式，不強行硬塞。

兩處都不會把整個資料庫（詞庫可能上千、LoRA 895）無條件塞進 3D 場景。

## 架構

### 新檔案：`darkroom/card3d.js`

獨立、無依賴的 vanilla JS 模組（比照 `converter.js`／`zimage.js` 這種「一個檔案一個職責」的慣例），對外暴露一個建構函式，大致介面：

```js
function createCard3DScene({ container, cards, onCardClick }) {
  // container: 場景容器 DOM 元素（3D 疊層裡的一個 div）
  // cards: DOM 元素陣列（已經存在的卡片，不負責建立卡片本身——
  //         沿用呼叫端各自現有的卡片渲染邏輯，這個模組只負責排位+動畫+互動）
  // onCardClick(card, index): 點卡片時的回呼，讓呼叫端決定選中/開大圖等行為

  return {
    setLayout(name),  // 'grid' | 'sphere' | 'helix' | 'table'，動畫切換到該排列
    destroy(),        // 清掉所有事件監聽、取消進行中的 animate()、還原卡片 transform
  };
}
```

呼叫端（`darkroom.js`）負責：
1. 準備好卡片 DOM 元素（沿用既有的卡片建立邏輯，複用 renderLmList/renderTemplateGrid 等既有函式產生的節點，或克隆一份縮圖版本）。
2. 開一個新的全螢幕疊層（見下方 HTML 結構），把卡片丟給 `createCard3DScene()`。
3. 疊層關閉時呼叫 `.destroy()`。

### HTML 結構（新增）

```html
<div class="c3d-modal" id="c3d-modal">
  <div class="c3d-stage" id="c3d-stage">
    <div class="c3d-scene" id="c3d-scene"><!-- 卡片們動態插入這裡 --></div>
  </div>
  <div class="c3d-controls">
    <button data-layout="grid" class="on">格線</button>
    <button data-layout="sphere">球形</button>
    <button data-layout="helix">螺旋</button>
    <button data-layout="table">陣列</button>
  </div>
  <button class="c3d-close" id="c3d-close" aria-label="關閉 (Esc)">✕</button>
</div>
```

`.c3d-modal` 是 `position:fixed; inset:0` 的疊層，比照專案既有的 `.lora-modal`／`.tarot` 開關動畫慣例（`fadeIn`/`modalPop` 進場，`element.animate()` 淡出＋`setTimeout` 保險收尾）。`.c3d-stage` 套 `perspective`，`.c3d-scene` 是實際會被拖曳旋轉（`rotateX`/`rotateY`）、縮放（`translateZ`）的容器，每張卡片是 `.c3d-scene` 底下的絕對定位子元素。

### 進入點

- 詞庫瀏覽格線：格線上方新增一顆「🌐 3D 展示」按鈕（比照現有「🎲 隨機瀏覽」按鈕的視覺與位置慣例）。
- LoRA 大面板左欄：分類晶片下方、`lm-random-btn`（隨機瀏覽）旁邊加同一顆按鈕。

兩處都呼叫同一個 `openCard3D(cards, opts)` 包裝函式（在 `darkroom.js` 裡，負責準備卡片、開疊層、呼叫 `createCard3DScene`），不重複寫兩份邏輯。

## 排列公式

四種排列各自是「輸入索引 `i`、總數 `n`，輸出 `{x, y, z, rotX, rotY}`」的純函式，沿用參考範例的通用參數化數學（不是複製範例的程式碼或文字內容，純數學公式重新實作）：

- **grid**：平面網格，依 `sqrt(n)` 抓欄數，`x = col * spacing - offset`、`y = row * spacing - offset`、`z = 0`，無旋轉。
- **table**：跟 `grid` 同一種平面排列，只是 spacing/欄數常數不同（呼應原範例「元素週期表」跟「純網格」是兩種不同間距的平面排列）。
- **sphere**：球面座標，`theta`/`phi` 依索引均勻分布（fibonacci sphere 或緯度環算法皆可），卡片面向球心（`rotY`/`rotX` 由法向量算出）。
- **helix**：圓柱螺旋，`theta = i * 角度增量`、`y = i * 垂直間距`、半徑固定，卡片面向螺旋軸心。

## 互動：拖曳旋轉＋縮放

- **拖曳**：`pointerdown` 記錄起點，`pointermove` 依位移差更新 `.c3d-scene` 的 `rotateY`（水平位移）／`rotateX`（垂直位移，限制在 ±90° 內避免翻轉詭異）。`pointerup` 後依放開瞬間的速度做慣性衰減（rAF 迴圈，每幀乘一個衰減係數，速度低於閾值就停止並取消 rAF）。
- **縮放**：滑鼠滾輪（`wheel` 事件）或雙指 pinch（`touchmove` 計算兩指距離變化）調整 `.c3d-scene` 的 `translateZ`，限制在一個合理範圍內（避免縮到卡片消失在相機後面，或拉遠到看不見）。
- 觸控：拖曳用單指 `touchmove`（位移邏輯跟滑鼠共用同一份計算函式），縮放用雙指，兩者靠觸點數量互斥。
- 這段拖曳/縮放狀態獨立於排列切換動畫——排列切換只動每張卡片各自的 transform，場景整體的旋轉/縮放是疊加在外層 `.c3d-scene` 上的另一層 transform，兩者互不干擾（`.c3d-scene` 的 rotate/translateZ + 每張卡片自己的 x/y/z/rot，各自獨立 CSS 屬性，不會互相覆蓋）。

## 無障礙／效能保險

- **`prefers-reduced-motion: reduce`**：排列切換動畫（`element.animate()`）改成直接跳到目標 transform，不跑緩動；拖曳旋轉本身是使用者主動操作，不受限制（不算自動動畫），但放開後的**慣性衰減**要跳過，一放開立即停止在當下角度。
- **特徵偵測**：進疊層前用 `CSS.supports('transform', 'perspective(1px) rotateX(1deg)')` 檢查，不支援就整顆「🌐 3D 展示」按鈕不渲染（不是點了才顯示錯誤訊息）。
- **背景分頁保險**：疊層關閉時（`destroy()`）務必 `cancel()` 掉所有進行中的 `Animation` 物件、取消慣性衰減的 rAF——這專案已經因為「分頁在背景時 `finished`/`animationend` 不結算」踩過好幾次坑（CLAUDE.md 有記錄），這次動手前就要避開，不是修出來的。
- **記憶體**：`destroy()` 要把卡片節點從 `.c3d-scene` 移除（不留著，畢竟卡片節點是每次開啟時準備的縮圖版本，關閉後不需要），並解除所有 `pointerdown`/`wheel`/`touchmove` 監聽。

## 測試計畫

沒有測試框架，比照專案既有驗證手段：

- `node --check darkroom/card3d.js`／`node --check darkroom/darkroom.js` 語法檢查。
- 瀏覽器實測：開兩個入口各自進 3D 模式，四種排列都能正常切換、拖曳旋轉有慣性、滾輪縮放有效、Esc/✕ 正常關閉且沒有殘留動畫或事件監聽（可以用 `getEventListeners`／重複開關多次觀察有沒有累積）。
- 效能實測：LoRA 895 筆篩到「全部」時的行為（應該被上限擋下 toast，不強行塞 895 張進 3D 場景）；詞庫格線在一個上千筆的資料夾開 3D 模式，確認固定抽樣 100~150 筆、沒有卡頓。
- `prefers-reduced-motion` 模擬（DevTools 或 `matchMedia` mock）下排列切換是否跳過緩動、慣性是否直接停止。
