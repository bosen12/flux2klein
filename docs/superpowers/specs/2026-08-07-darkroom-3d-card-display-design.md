# 暗房：可互動的 3D 卡片展示模式（table/sphere/helix/grid）

## 背景

使用者參考 three.js 官方範例 [css3d_periodictable](https://threejs.org/examples/css3d_periodictable.html)：118 個化學元素方塊可以在 `table`／`sphere`／`helix`／`grid` 四種排列間動畫切換，還能滑鼠拖曳整個場景旋轉、滾輪縮放。想在暗房裡做一個類似的、真正好玩／炫的互動展示模式，套用在暗房既有的兩個卡片格線上：**詞庫瀏覽格線**與**LoRA 大面板左欄清單**。要求全程考慮效能。

## 目標

- 一個共用的 vanilla JS 元件，把一批卡片元素排成 `grid`／`sphere`／`helix`／`table` 四種 3D 排列，並能動畫切換。
- 場景整體可以滑鼠拖曳旋轉（帶慣性）、滾輪／雙指縮放。
- 套用在詞庫瀏覽格線與 LoRA 大面板清單兩處，各自一顆進入按鈕。
- **兩種觸發情境共用同一份底層邏輯**：① topbar 搜尋欄旁的「🌐」按鈕，隨時可點開、可自由切換四種排列＋互動；② 首次進暗房的全螢幕進場動畫（`grid` 排列、播完出現「Enter」鈕/按 Enter 鍵才進入真正介面），只是進場動畫的編排（choreography）比①更盛大、播一次就收起控制項。
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

- **詞庫瀏覽格線**：topbar 主搜尋欄（`.search-wrap`，`#search` 輸入框）右邊新增一顆圓形圖示按鈕 `#c3d-launch-btn`，圖示是線框地球儀（經緯線球體，使用者指定的樣式）——inline SVG，跟 `.search-wrap` 裡現有的放大鏡圖示同一種「`stroke="currentColor"`、無填色」畫法，不額外拉圖檔。點下去開全螢幕 3D 疊層，預設排列 `grid`，可自由切換＋互動（見下方「兩種觸發情境」）。
- **LoRA 大面板左欄**：分類晶片下方、`lm-random-btn`（隨機瀏覽）旁邊加同一顆按鈕（沿用同一顆 SVG，view 大小依情境縮放）。

兩處都呼叫同一個 `openCard3D(cards, opts)` 包裝函式（在 `darkroom.js` 裡，負責準備卡片、開疊層、呼叫 `createCard3DScene`），不重複寫兩份邏輯。

### 兩種觸發情境：隨時開／首次進場

同一份底層元件（`createCard3DScene`）＋同一個疊層 DOM，`openCard3D(cards, opts)` 用 `opts.mode` 分辨：

**`opts.mode = 'ondemand'`**（topbar／LoRA 面板按鈕觸發）
- 疊層開啟：比照現有 modal 慣例，`fadeIn` + `.c3d-scene` 內卡片直接 `scale:.98→1, opacity:0→1` 一次性淡入（UI 狀態變化量級，250–320ms，不做逐卡 stagger——這是使用者「隨手開來玩」的功能，不需要每次都放一段隆重進場，儀式感留給首次進場那個情境）。
- 排列切換控制列（格線/球形/螺旋/陣列 4 顆鈕）全程顯示，`Esc`／✕ 隨時關閉回到原本畫面。

**`opts.mode = 'intro'`**（首次進暗房自動播放，見下方「首次進場動畫」）
- 疊層開啟即是整個頁面的入口——蓋在真正介面**之上**（真正介面在背後已經渲染好，只是被疊層蓋住，不是還沒載入），播完進場動畫才收起疊層、露出底下已經就緒的介面。
- 排列固定 `grid`，不顯示排列切換控制列（沒有意義，使用者都還沒進去，不用讓他分心切排列）；拖曳旋轉／縮放互動維持開放（使用者要求的「也可以在裡面互動」），可以在卡片飛入定位的過程中或定位後把玩。
- 進場動畫跑完（見下方時間軸）才淡入「Enter 暗房」按鈕；按下按鈕或按 `Enter` 鍵，疊層淡出收起，露出後面的真實介面。

### 首次進場動畫：時間軸

套用 hero-sequence 等級的編排（800–1600ms 主動畫＋分批進場），卡片是這個時刻的主角：

1. **0ms**：疊層瞬間可見（無淡入，因為這是頁面載入後第一個畫面，不需要「從別的畫面過渡過來」的淡入感），`.c3d-scene` 裡固定抽樣好的 100~150 張卡片全部先放在畫面中央、`scale:0, opacity:0` 疊在一起（尚未飛散）。
2. **80ms 起**：卡片依序飛向 `grid` 排列的各自定位——**不是逐卡等差 stagger**（150 張 × 60ms 會拖到 9 秒，太久），改用「分批」：把卡片依索引分成 6~8 批，每批同時飛（`element.animate()` 一次對一批卡片下手），批與批之間間隔 90–120ms，單批動畫本身 500–650ms（`ease-out`，位移 `translate3d` + `scale` + `opacity`），總長控制在 1.1–1.4 秒內結束，符合 hero 量級但不失控。
3. **動畫最後一批飛入的同時**：淡入標題文字（例如「詞庫暗房」+ 副標，30ms stagger），呼應「hero 先動、次要元素跟隨」的編排慣例。
4. **全部定位完成後 200ms**：淡入「進入暗房 →」按鈕（`opacity:0→1` + 微幅 `translateY`，320ms），這是這個畫面最後出現的元素，視覺上「一切就緒才給你按」。
5. 按下按鈕／`Enter` 鍵：`.c3d-modal` 整層 `opacity:1→0`（180–220ms，`ease-in`，比進場快——CLAUDE.md 既有的「進場慢收、退場快走」慣例），淡出完 `display:none`／移除節點，露出背後真實介面（此時介面內容早就緒，沒有「等載入」的空窗）。

**`prefers-reduced-motion: reduce`**：整段 1~4 直接跳過，卡片瞬間出現在最終 `grid` 位置、標題與「進入暗房」按鈕同時可見（保留內容、拿掉動態），使用者立刻可以按 Enter 或點按鈕進入——不強迫等一段跑不動的動畫。

### 「首次」的判定：`localStorage` 一次性旗標

- `localStorage['yz-c3d-intro-seen'] === '1'` 就不自動播，直接進暗房（不會每次重新整理都要看一遍，正式使用時才不會覺得煩）。
- 沒有這個旗標（真正的第一次，或使用者手動清過 `localStorage`）才自動播 `intro` 模式；播完（不管是動畫跑完還是被 `Enter` 提前跳過）就寫入旗標。
- 想回味／展示這個進場動畫，topbar 的「🌐」按鈕本來就能隨時開（`ondemand` 模式），不用另外做一個「重播進場動畫」的入口。

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
- `prefers-reduced-motion` 模擬（DevTools 或 `matchMedia` mock）下排列切換是否跳過緩動、慣性是否直接停止；`intro` 模式下是否直接跳到最終畫面。
- **`intro` 模式**：清掉 `localStorage['yz-c3d-intro-seen']` 後重整頁面，確認自動播放、時間軸各階段（卡片飛入分批、標題淡入、Enter 鈕最後出現）順序正確、總長落在 1.5~2 秒內；按 `Enter` 鍵與點按鈕都能正常收起疊層並寫入旗標；重整第二次確認不再自動播放。過程中確認拖曳旋轉／縮放在動畫進行中跟結束後都可用。
