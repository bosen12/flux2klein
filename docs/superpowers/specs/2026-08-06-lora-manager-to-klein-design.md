# LoRA Manager 送到 KLEIN Illustrious 面板 — 設計

## 背景與目的

LoRA Manager（`lora-manager/`，vendor 進來的第三方專案，獨立埠 7861）的「送到 workflow」目前只有一個目標：暗房（`darkroom/`，埠 7860）。使用者希望同一個動作也能把 LoRA 選進 KLEIN 主面板（埠 7801）的 Illustrious 引擎——KLEIN 是唯一支援 LoRA 的引擎（`ENGINES.illustrious.lora`），選單在 app.js 的「LoRA 風格」欄位。

## 決策（已跟使用者確認）

1. **推送目標：同時推兩邊，不是二選一。** LoRA Manager 點「送到 workflow」時，平行 POST 給暗房（`/api/lora-push`，既有）與 KLEIN（`/panel/lora-push`，新增）。哪邊的分頁開著，哪邊就自動選中；沒開的那邊下次打開時輪詢照樣拿得到。
2. **KLEIN 目前引擎不是 Illustrious 時：自動切換。** 收到推送時若 `state.engine !== 'illustrious'`，直接呼叫 `selectEngine('illustrious')`，跟暗房「收到推送自動切 gen 模式」是同一套邏輯，一次到位不用使用者自己切。
3. **單一格、最新覆蓋前一個，不排隊。** 沿用暗房既有的 `{"ver": int, "data": {...}|None}` 版本號機制：POST 一次 `ver` +1、`data` 整個覆蓋。面板端輪詢帶自己上次看到的版本號，`ver` 比自己新就拿最新那筆——不管中間錯過幾次推送。也就是說，若面板沒開時連續推送兩次，之後打開只會選中**第二次**那個，第一次悄悄被蓋掉、不補送。已跟使用者確認這個語意可接受（LoRA 本來就單選，也沒有「排隊處理歷史推送」的需求）。

## 架構

```
LoRA Manager (:7861)  --點「送到 workflow」-->
  ├── POST http://127.0.0.1:7860/api/lora-push   （既有，不動）
  └── POST http://127.0.0.1:7801/panel/lora-push  （新增）
        両次 fetch 平行送出、互不等待、任一邊失敗只在 console 記錄，不彈窗打斷使用者

darkroom (:7860)  每 1s 輪詢 /api/lora-push?since=  （既有，不動）
KLEIN    (:7801)  每 1s 輪詢 /panel/lora-push?since=  （新增，照抄暗房那套）
```

## 各檔案改動

### `serve.py`（KLEIN 後端，手寫 socket、不是 `http.server`）

新增模組級狀態（緊鄰現有 `LORA_ROOT`/`LORA_FOLDERS` 附近）：

```python
_LORA_PUSH = {"ver": 0, "data": None}   # {"ver": int, "data": {"folder","name"}|None}
_LORA_PUSH_LOCK = threading.Lock()
```

（`serve.py` 第 23 行已經 `import threading`，不用新增 import。）

`handle()` 的路由判斷（現有 `elif method == "GET" and path == "/panel/loras" ...` 那一串）加：

- `GET /panel/lora-push`：照 `serve_lora_preview` 現有寫法 `from urllib.parse import urlparse, parse_qs; q = parse_qs(urlparse(raw_path).query)` 拿 `since`（沒帶當 0），回 `{"ver": 目前版本}`；若 `ver > since` 才多帶 `data` 欄位（省流量，跟暗房那支一模一樣的邏輯）。
- `POST /panel/lora-push`：**serve.py 目前所有 panel 端點都是 GET，沒有現成的「讀 body 並 parse JSON」邏輯**，這是這次唯一要新寫的底層機制——讀 `Content-Length`、從 `initial`（`recv_headers` 回傳、可能已經包含部分 body）接著讀滿所需長度、`json.loads`。拿到 `folder`/`name` 後更新 `_LORA_PUSH`（`ver` +1、覆蓋 `data`），回 `{"ok": true, "ver": ...}`。
- `OPTIONS /panel/lora-push`：CORS 預檢（7861 跨源打 7801，`application/json` 的 POST 一定會先觸發預檢）。回 204，帶 `Access-Control-Allow-Origin: *`、`Access-Control-Allow-Methods: POST, GET, OPTIONS`、`Access-Control-Allow-Headers: Content-Type`——這幾個標頭字面上照抄 `darkroom/preview_ui.py` 的 `do_OPTIONS`，同一個需求。
- GET/POST 的正常回應也要帶 `Access-Control-Allow-Origin: *`（GET 是面板自己同源輪詢用不到 CORS，但 POST 是跨源打進來的，回應也要有這個標頭瀏覽器才會把結果交給呼叫端的 JS）。

`serve.py` 目前完全沒有處理過 POST body、也沒有 OPTIONS 分支——這是這次改動裡風險最高、需要小心測試的一塊（socket 層級手動讀 body，跟 `http.server` 的 `self.rfile.read(length)` 不是同一回事）。

### `app.js`（KLEIN 前端）

新增（緊鄰現有 LoRA 相關函式之後，或檔案尾端跟其他背景輪詢同一區）：

```js
let LORA_PUSH_VER = 0;
async function pollLoraPush() {
  try {
    const st = await fetch('/panel/lora-push?since=' + LORA_PUSH_VER).then(r => r.json());
    if (st.ver > LORA_PUSH_VER) {
      LORA_PUSH_VER = st.ver;
      if (st.data) await applyLoraPush(st.data);
    }
  } catch (e) { /* 靜默；下一輪再試 */ }
  setTimeout(pollLoraPush, 1000);
}
async function applyLoraPush(d) {
  if (state.engine !== 'illustrious') selectEngine('illustrious');
  if (state.lora.list === null) await fetchLoras(ENG.illustrious);
  const match = (state.lora.list || []).find(l => l.name === d.name && (!d.folder || l.folder === d.folder));
  if (!match) { log(`LoRA Manager 送來的「${d.name}」在這裡的清單找不到——可能還沒重新整理過清單`, 'err'); return; }
  state.lora.enabled = true;
  $('lora-on').checked = true;
  $('lora-toggle').classList.add('on');
  show('lora-panel', true);
  selectLora(match);
  $('lora-field').scrollIntoView({ behavior: 'smooth', block: 'center' });
  log(`已從 LoRA Manager 選入「${match.title || match.name}」`, 'ok');
}
pollLoraPush();
```

需要確認/處理的細節：
- `selectEngine('illustrious')` 內部用 `document.startViewTransition` 做換色過渡，是非同步但不 await 也沒關係（不影響後續邏輯，畫面過渡跟 LoRA 選取是兩件事）；`applyEngine` 內部同步呼叫 `selectMode` → `setupLora` → 可能觸發 `fetchLoras`（fire-and-forget），跟本函式自己 `await fetchLoras(...)` 可能重複打一次 `/panel/loras`，兩次都會成功、只是稍微浪費一次請求，可接受（不強求去重，保持邏輯單純）。
- `log()` 的第二參數已確認：app.js 現有呼叫裡 `'ok'`（如 1223 行）、`'err'`（如多處）都是實際在用的類別字串（對應 CSS class `l-ok`/`l-err`），上面程式碼直接照用沒問題。
- 若 KLEIN 分頁一開始就在 Illustrious 引擎、LoRA 面板已經開著，這段邏輯一樣適用（`state.engine !== 'illustrious'` 為假，直接跳過切換）。

### `lora-manager/static/js/utils/uiHelpers.js`

現有實作（`sendLoraToDarkroom`，第 662-684 行）：

```js
const DARKROOM_ORIGIN = 'http://127.0.0.1:7860';

export async function sendLoraToDarkroom(folder, fileNameNoExt) {
  try {
    const res = await fetch(`${DARKROOM_ORIGIN}/api/lora-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder, name: fileNameNoExt }),
    });
    const result = await res.json().catch(() => ({}));
    if (res.ok && result.ok) {
      showToast('toast.general.sentToDarkroom', {}, 'success', `已送到暗房：${fileNameNoExt}`);
    } else {
      showToast('toast.general.sendToDarkroomFailed', {}, 'error', `暗房回應失敗：${result.error || res.status}`);
    }
  } catch (error) {
    console.error('Failed to send LoRA to darkroom:', error);
    showToast('toast.general.sendToDarkroomFailed', {}, 'error', `連不到暗房（${DARKROOM_ORIGIN}）：${error.message}`);
  }
}
```

`showToast(key, params, type, fallback)` 的第 4 個參數是字面中文 fallback 文字（翻譯 key 還沒建就直接顯示這段），這份專案沒有補完整的多語系檔，實際顯示的就是 fallback 字串。

改法：函式名稱不動（`ModelCard.js`/`LoraContextMenu.js` 兩處呼叫點都不用跟著改），內部改成同時打兩個目標、**合併成一則 toast**（不要兩則疊在一起，兩邊都成功/失敗的組合有 4 種，訊息文字要涵蓋）：

```js
const DARKROOM_ORIGIN = 'http://127.0.0.1:7860';
const KLEIN_ORIGIN = 'http://127.0.0.1:7801';

async function pushLora(origin, path, folder, fileNameNoExt) {
  const res = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, name: fileNameNoExt }),
  });
  const result = await res.json().catch(() => ({}));
  if (!(res.ok && result.ok)) throw new Error(result.error || String(res.status));
}

export async function sendLoraToDarkroom(folder, fileNameNoExt) {
  const [dr, kl] = await Promise.allSettled([
    pushLora(DARKROOM_ORIGIN, '/api/lora-push', folder, fileNameNoExt),
    pushLora(KLEIN_ORIGIN, '/panel/lora-push', folder, fileNameNoExt),
  ]);
  if (dr.status === 'rejected') console.error('Failed to send LoRA to darkroom:', dr.reason);
  if (kl.status === 'rejected') console.error('Failed to send LoRA to KLEIN:', kl.reason);
  if (dr.status === 'fulfilled' && kl.status === 'fulfilled') {
    showToast('toast.general.sentToDarkroom', {}, 'success', `已送到暗房、KLEIN 面板：${fileNameNoExt}`);
  } else if (dr.status === 'fulfilled') {
    showToast('toast.general.sentToDarkroom', {}, 'success', `已送到暗房：${fileNameNoExt}（KLEIN 面板沒連上，略過）`);
  } else if (kl.status === 'fulfilled') {
    showToast('toast.general.sentToDarkroom', {}, 'success', `已送到 KLEIN 面板：${fileNameNoExt}（暗房沒連上，略過）`);
  } else {
    showToast('toast.general.sendToDarkroomFailed', {}, 'error', `暗房、KLEIN 面板都送失敗：${fileNameNoExt}`);
  }
}
```

函式名稱刻意保留 `sendLoraToDarkroom`（雖然現在語意已經是「送到兩邊」）——改名要跟著改 `ModelCard.js`/`LoraContextMenu.js` 的 import／呼叫處，範圍不必要地擴大；用註解說明現況即可（`VENDORED.md` 也會補充）。

### `VENDORED.md`

「對照上游改了什麼」段落補一筆：`sendLoraToDarkroom()` 現在會同時推送給暗房與 KLEIN 面板兩個目標（函式名稱沒改，只是內部行為擴充），並記錄這是為了避免使用者要多學一個「送到哪裡」的選擇。

## 測試計畫（沿用整個對話一貫的「直接實作＋真實環境驗證」，這專案沒有測試框架）

1. `node --check app.js`、`python -c "import ast; ast.parse(...)"` 驗證 `serve.py` 語法。
2. 在測試埠起 `serve.py`（**絕對不能用 7801**，比照暗房那次找一個沒人用的埠，例如 7802）+ 一個假的 LoRA Manager 端（直接用 `curl -X POST` 模擬，不需要真的跑 lora-manager），驗證：
   - `OPTIONS /panel/lora-push` 回 204 + CORS 標頭
   - `POST /panel/lora-push` 帶 JSON body 能正確寫入 `_LORA_PUSH`（用後續 GET 驗證 `ver` 有遞增、`data` 正確）
   - `GET /panel/lora-push?since=0` 拿到完整 `data`；`since=` 目前版本號時只回 `ver` 沒有 `data`
3. 用 `mcp__Claude_Browser__javascript_tool` 在瀏覽器內直接呼叫 `applyLoraPush({folder, name})` 驗證：引擎自動切到 Illustrious、`state.lora.selected` 正確、`#lora-field` 在畫面上、log 訊息出現。
4. 驗證「面板沒開時推送兩次、之後打開只選中第二次」的語意（用兩次連續 `curl POST` 模擬，再開頁面確認）。
5. 全程比照這次對話一貫的規矩：測試埠跑完立刻收掉、每次操作前後 `netstat` 確認沒動到正式的 7801/7860/7861/8188。
6. 更新 `README.md`（「LoRA Manager」一節，補「送到 workflow 現在會同時推去暗房與 KLEIN 面板」）與 `進度.md`（commit 後照慣例補一筆）。

## 風險 / 已知限制

- `serve.py` 讀 POST body 是這次唯一要新寫的底層機制（其他 panel 端點都是 GET），要小心 `Content-Length` 沒送、body 分段到達等邊界情況——照抄 `recv_headers` 已經讀到的部分 body、不足再用 `client.recv()` 補讀到指定長度即可，不需要處理 chunked transfer encoding（LoRA Manager 端固定會帶 `Content-Length`，不會用 chunked）。
- `selectEngine('illustrious')` 若 `ENG.illustrious` 沒載入（理論上不該發生，Illustrious 是四個引擎之一必定載入），會走現有的「尚未就緒」錯誤分支——這是既有行為，不用特別處理。
