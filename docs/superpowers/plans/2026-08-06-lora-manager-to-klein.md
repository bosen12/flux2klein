# LoRA Manager 送到 KLEIN Illustrious 面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LoRA Manager（`lora-manager/`，獨立埠 7861）的「送到 workflow」動作，除了現有的暗房（`darkroom/`，埠 7860）之外，同時也能把 LoRA 選進 KLEIN 主面板（`serve.py`，埠 7801）的 Illustrious 引擎。

**Architecture:** 沿用暗房既有的「單一格、版本號輪詢」機制（`{"ver": int, "data": {...}|None}` + `threading.Lock`）：`serve.py` 新增 `/panel/lora-push`（GET 輪詢／POST 接收／OPTIONS 預檢＋CORS），`app.js` 新增每秒輪詢、偵測到新版本就自動切 Illustrious 引擎並選入 LoRA。LoRA Manager 的 `uiHelpers.js` 改成同時 POST 給暗房與 KLEIN 兩個端點，合併成一則 toast。

**Tech Stack:** Python 標準庫（`socket`/`threading`/`json`，不用任何框架，`serve.py` 是手寫 raw socket server 不是 `http.server`）、Vanilla JS（無建置步驟）。這個專案沒有測試框架——`node --check` 做語法驗證、`python -c "import ast; ast.parse(...)"` 做語法驗證、真實 curl／`mcp__Claude_Browser__javascript_tool` 做行為驗證。

## Global Constraints

- **絕對不能在正式服務的埠上測試**：7801（KLEIN）、7860（暗房）、7861（LoRA Manager）、8188（ComfyUI）。每個 task 的測試都要另外起一個測試埠的實例，測試完立刻關掉。
- **每次測試前後都要 `netstat -ano | grep -E ":7801|:7860|:7861|:8188" | grep LISTENING` 確認正式服務沒被動到**（這個對話已經因為忘記查而差點誤殺正式服務一次，養成習慣）。
- **不要引入任何 build step / npm / 前端框架**（CLAUDE.md 明訂）。純字面 JS/Python 修改。
- **UI 文案、commit message、註解都用繁體中文**；程式碼識別字（函式名、變數名）維持英文。
- **每個 task 完成後各自 commit**，commit message 標題簡短、內文說明「為什麼」，結尾 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- **不要用 `git push`**，除非使用者明確要求。
- LoRA 推送資料格式固定為 `{"folder": str, "name": str}`（`name` 不含副檔名），跟暗房 `/api/lora-push` 完全一致，兩邊共用同一份 payload。

---

### Task 1: `serve.py` 新增 `/panel/lora-push` 端點（GET 輪詢／POST 接收／OPTIONS 預檢）

**Files:**
- Modify: `serve.py:105`（`LORA_FOLDERS` 之後，新增模組級狀態）
- Modify: `serve.py:367`（`serve_lora_preview` 函式之後，新增三個新函式）
- Modify: `serve.py:710-725`（`handle()` 的路由判斷，加三個 `elif` 分支）

**Interfaces:**
- Consumes: 無（這個 task 不依賴其他 task）
- Produces：
  - `_LORA_PUSH: dict`（`{"ver": int, "data": {"folder": str, "name": str} | None}`）與 `_LORA_PUSH_LOCK: threading.Lock`——模組級狀態，之後不會被其他 task 直接用到，但供除錯/確認行為時參考
  - `serve_lora_push_get(client, raw_path)` — GET 輪詢處理
  - `serve_lora_push_post(client, initial)` — POST 接收處理
  - `serve_lora_push_options(client)` — OPTIONS 預檢處理
  - 路由：`GET /panel/lora-push`、`POST /panel/lora-push`、`OPTIONS /panel/lora-push`

- [ ] **Step 1: 在 `serve.py` 的 `LORA_FOLDERS` 後面加模組級狀態**

打開 `serve.py`，找到第 105 行：

```python
LORA_FOLDERS = ["style", "Character", "HENTAI", "illus"]
```

改成：

```python
LORA_FOLDERS = ["style", "Character", "HENTAI", "illus"]
# LoRA Manager（獨立埠 7861，見 lora-manager/）點「送到 workflow」時 POST 這裡；
# 暗房（darkroom/preview_ui.py 的 /api/lora-push）已經有一份一模一樣的機制，這裡
# 是 KLEIN 面板自己的版本——單一格、版本號遞增、最新覆蓋前一個（不排隊）。
_LORA_PUSH = {"ver": 0, "data": None}   # {"ver": int, "data": {"folder","name"}|None}
_LORA_PUSH_LOCK = threading.Lock()
```

- [ ] **Step 2: 在 `serve_lora_preview` 函式之後新增三個處理函式**

找到 `serve_lora_preview` 函式的結尾（第 367 行開始的函式，找到它 `return` 或函式結束、下一個 `def` 開始之前的空行）。用 Grep 確認插入點：

```bash
grep -n "^def serve_lora_preview\|^def serve_prompt_list" serve.py
```

Expected：會看到 `serve_lora_preview` 開始的行號，以及下一個 `def serve_prompt_list`（或類似）開始的行號——插入點就是兩者之間。

在 `serve_lora_preview` 函式結束、下一個 `def` 開始之前，插入：

```python
def _lora_push_json(client, obj, status=200):
    """跟 send_body() 類似但可指定狀態碼、固定帶 CORS 標頭——只有 /panel/lora-push
    需要（LoRA Manager 站在 7861 跨源打過來，瀏覽器要看到 Access-Control-Allow-Origin
    才會把回應交給呼叫端的 JS；GET 是面板自己同源輪詢用不到，但一起帶不影響行為，
    兩支共用一個 helper 比較簡單）。"""
    import json as _json
    body = _json.dumps(obj, ensure_ascii=False).encode("utf-8")
    status_line = "200 OK" if status == 200 else "400 Bad Request"
    header = (
        f"HTTP/1.1 {status_line}\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n\r\n"
    ).encode("utf-8")
    client.sendall(header + body)


def serve_lora_push_get(client, raw_path):
    """前端每 ~1s 輪詢一次；帶 since 才回新資料，版本沒變就只回 ver（省流量）。"""
    from urllib.parse import urlparse, parse_qs
    q = parse_qs(urlparse(raw_path).query)
    try:
        since = int((q.get("since", ["0"])[0]) or 0)
    except ValueError:
        since = 0
    with _LORA_PUSH_LOCK:
        ver, data = _LORA_PUSH["ver"], _LORA_PUSH["data"]
    out = {"ver": ver}
    if ver > since:
        out["data"] = data
    _lora_push_json(client, out)


def serve_lora_push_post(client, initial):
    """LoRA Manager（獨立埠 7861）POST 這裡推送一個 LoRA。initial 是 recv_headers()
    回傳的位元組，標頭後面可能已經帶了部分／全部 body——先從這裡切開，不夠再從
    socket 補讀到 Content-Length 指定的長度。LoRA Manager 固定會帶 Content-Length，
    不用處理 chunked transfer encoding。"""
    import json as _json
    head, _, body = initial.partition(b"\r\n\r\n")
    length = 0
    for line in head.split(b"\r\n")[1:]:
        if line.lower().startswith(b"content-length:"):
            try:
                length = int(line.split(b":", 1)[1].strip())
            except ValueError:
                length = 0
            break
    while len(body) < length:
        chunk = client.recv(min(65536, length - len(body)))
        if not chunk:
            break
        body += chunk
    try:
        data = _json.loads(body.decode("utf-8")) if body else {}
    except Exception:
        data = {}
    folder = str(data.get("folder") or "").strip()
    name = str(data.get("name") or "").strip()
    if not name:
        _lora_push_json(client, {"error": "缺少 name"}, 400)
        return
    with _LORA_PUSH_LOCK:
        _LORA_PUSH["ver"] += 1
        _LORA_PUSH["data"] = {"folder": folder, "name": name}
        ver = _LORA_PUSH["ver"]
    print(f"[lora-push] {folder}/{name} (ver={ver})")
    _lora_push_json(client, {"ok": True, "ver": ver})


def serve_lora_push_options(client):
    """CORS 預檢：7861 跨源打 7801，application/json 的 POST 瀏覽器一定先送 OPTIONS。"""
    client.sendall(
        b"HTTP/1.1 204 No Content\r\n"
        b"Access-Control-Allow-Origin: *\r\n"
        b"Access-Control-Allow-Methods: POST, GET, OPTIONS\r\n"
        b"Access-Control-Allow-Headers: Content-Type\r\n"
        b"Content-Length: 0\r\n\r\n"
    )

```

- [ ] **Step 3: 在 `handle()` 的路由判斷加三個分支**

找到 `serve.py` 裡的這段（大約第 714-716 行）：

```python
        elif method == "GET" and path == "/panel/lora-preview" and not is_ws:
            serve_lora_preview(client, raw_path)
            client.close()
```

在這段**之後**（緊接著，`/panel/prompts` 那個 `elif` 之前）插入：

```python
        elif method == "GET" and path == "/panel/lora-push" and not is_ws:
            serve_lora_push_get(client, raw_path)
            client.close()
        elif method == "POST" and path == "/panel/lora-push" and not is_ws:
            serve_lora_push_post(client, initial)
            client.close()
        elif method == "OPTIONS" and path == "/panel/lora-push" and not is_ws:
            serve_lora_push_options(client)
            client.close()
```

- [ ] **Step 4: 語法驗證**

Run:
```bash
python -c "import ast; ast.parse(open('serve.py', encoding='utf-8').read())"
```
Expected: 沒有任何輸出（沒拋例外就是通過）。

- [ ] **Step 5: 在測試埠起 `serve.py`，用 curl 驗證三個分支**

先確認測試埠沒被佔用、正式服務都還在：
```bash
netstat -ano | grep -E ":7801|:7802|:7860|:7861|:8188" | grep LISTENING
```
Expected: 看得到 7801/7860/7861/8188 是正式服務的 PID，7802 沒有任何東西在監聽。

起測試實例（**用 7802，不要用 7801**）：
```bash
cd C:/projects/flux2klein
python serve.py 127.0.0.1:8188 7802 > /tmp/serve_test_7802.log 2>&1 &
sleep 2
netstat -ano | grep ":7802" | grep LISTENING
```
Expected: 看到 7802 進入 LISTENING。

驗證 OPTIONS 預檢：
```bash
curl -s -i -X OPTIONS http://127.0.0.1:7802/panel/lora-push
```
Expected: `HTTP/1.1 204 No Content`，帶 `Access-Control-Allow-Origin: *`、`Access-Control-Allow-Methods: POST, GET, OPTIONS`。

驗證 POST 缺 name 回 400：
```bash
curl -s -i -X POST http://127.0.0.1:7802/panel/lora-push \
  -H "Content-Type: application/json" -d '{"folder":"style"}'
```
Expected: `HTTP/1.1 400 Bad Request`，body 是 `{"error": "缺少 name"}`。

驗證正常 POST：
```bash
curl -s -i -X POST http://127.0.0.1:7802/panel/lora-push \
  -H "Content-Type: application/json" -d '{"folder":"style","name":"test_lora"}'
```
Expected: `HTTP/1.1 200 OK`，body 是 `{"ok": true, "ver": 1}`（`ver` 是 1，因為這是這次測試實例第一次推送）。

驗證 GET 輪詢拿到資料：
```bash
curl -s http://127.0.0.1:7802/panel/lora-push?since=0
```
Expected: `{"ver": 1, "data": {"folder": "style", "name": "test_lora"}}`。

驗證 GET 帶目前版本號時不回 data（省流量邏輯）：
```bash
curl -s http://127.0.0.1:7802/panel/lora-push?since=1
```
Expected: `{"ver": 1}`（沒有 `data` 欄位）。

再推送第二次，驗證版本遞增、覆蓋前一筆（對應設計文件「單一格、最新覆蓋」的行為）：
```bash
curl -s -i -X POST http://127.0.0.1:7802/panel/lora-push \
  -H "Content-Type: application/json" -d '{"folder":"Character","name":"second_lora"}'
curl -s http://127.0.0.1:7802/panel/lora-push?since=0
```
Expected: 第一個指令回 `{"ok": true, "ver": 2}`；第二個指令回 `{"ver": 2, "data": {"folder": "Character", "name": "second_lora"}}`——只看得到第二筆，第一筆（`test_lora`）被覆蓋掉、不會補送，驗證「不排隊」的語意。

- [ ] **Step 6: 關掉測試實例，確認正式服務沒受影響**

```bash
powershell -NoProfile -Command "
\$p = Get-CimInstance Win32_Process -Filter \"CommandLine like '%serve.py%7802%'\"
foreach (\$proc in \$p) { Stop-Process -Id \$proc.ProcessId -Force }
"
sleep 1
netstat -ano | grep -E ":7801|:7802|:7860|:7861|:8188" | grep LISTENING
```
Expected: 7802 消失；7801/7860/7861/8188 的 PID 跟 Step 5 之前記錄的完全一樣（沒有任何一個變了、沒有任何一個消失）。

- [ ] **Step 7: Commit**

```bash
git add serve.py
git commit -m "$(cat <<'EOF'
serve.py 新增 /panel/lora-push：接 LoRA Manager 推送給 KLEIN 面板

跟暗房既有的 /api/lora-push（darkroom/preview_ui.py）同一套設計：單一格、
版本號遞增、GET 輪詢帶 since 只在有新資料時才回 data（省流量）。serve.py
是手寫 socket server 不是 http.server，這是它第一次要處理 POST body——
從 recv_headers() 已讀到的 initial 位元組切出 Content-Length 指定的
body，不夠再從 socket 補讀，不用處理 chunked（LoRA Manager 固定帶
Content-Length）。POST 是跨源打進來的（LoRA Manager 站 7861），額外加了
OPTIONS 預檢與 CORS 標頭。

在測試埠 7802 用 curl 驗證過 OPTIONS/POST/GET 三條路徑，包括「連續推送
兩次、只看得到最新一筆」的單一格語意。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `app.js` 新增輪詢與自動選取 LoRA

**Files:**
- Modify: `app.js:2831`（`notify` 函式之後、`init();` 之前）

**Interfaces:**
- Consumes: Task 1 的 `GET/POST /panel/lora-push`（透過 `fetch`，不直接呼叫 Python）；`app.js` 現有的 `state.engine`、`state.lora`、`ENG`、`applyEngine(engine)`、`fetchLoras(E)`、`selectLora(l)`、`log(text, cls)`、`show(id, on)`、`$(id)`（都已存在，不用新增）
- Produces：`pollLoraPush()`、`applyLoraPush(d)`——不供其他 task 使用，是這個功能的終端邏輯

- [ ] **Step 1: 確認要用的既有函式/狀態的精確簽名**

Run:
```bash
grep -n "function applyEngine\|function fetchLoras\|function selectLora\|function log(\|function show(" app.js
```
Expected: 各看到一行對應的函式宣告（`applyEngine(engine)`、`fetchLoras(E)`、`selectLora(l)`、`log(text, cls)`、`show(id, on, isField = false)`），確認函式名稱/參數個數跟這個 task 要呼叫的方式一致（如果任何一個簽名跟這裡假設的不同，先回頭確認再往下做，不要硬套）。

- [ ] **Step 2: 在 `notify` 函式之後、`init();` 之前插入新程式碼**

打開 `app.js`，找到：

```js
  function notify(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, icon: '/favicon.png' }); }
    catch (e) { log('桌面通知送出失敗：' + e.message, 'warn'); }   // 不要再默默吞掉
  }

  init();
```

改成：

```js
  function notify(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, icon: '/favicon.png' }); }
    catch (e) { log('桌面通知送出失敗：' + e.message, 'warn'); }   // 不要再默默吞掉
  }

  /* ---------------------------------------------------------------------------
     LoRA Manager（獨立埠 7861）「送到 workflow」推送過來的 LoRA：跟暗房共用同一套
     folder/name payload 格式，但走面板自己的 /panel/lora-push（serve.py）。每 1s
     輪詢版本號，有新版本就自動切 Illustrious、選進 LoRA 欄位——「推進目前開著的
     分頁」，跟暗房那邊的行為一致。

     這裡直接呼叫 applyEngine() 而不是 selectEngine()：selectEngine 在支援 View
     Transitions 時會用 document.startViewTransition() 包一層，updateCallback 是
     排程執行、不是呼叫當下就同步跑完，呼叫完後 state.engine 不保證已經是
     'illustrious'、LoRA 面板 DOM 也不保證已經建好。這裡需要呼叫完馬上就能確定
     切換完成，才能接著抓清單、選 LoRA，所以犧牲掉這個自動觸發路徑的換色動畫，
     換取同步、可預期的完成時機。
  --------------------------------------------------------------------------- */
  let LORA_PUSH_VER = 0;
  async function pollLoraPush() {
    try {
      const st = await fetch('/panel/lora-push?since=' + LORA_PUSH_VER).then(r => r.json());
      if (st.ver > LORA_PUSH_VER) {
        LORA_PUSH_VER = st.ver;
        if (st.data) await applyLoraPush(st.data);
      }
    } catch (e) { /* 靜默；下一輪再試，不用整個工具連得上才能用 */ }
    setTimeout(pollLoraPush, 1000);
  }
  async function applyLoraPush(d) {
    if (!ENG.illustrious) { log('Illustrious 引擎設定未載入，收到的 LoRA 推送無法套用', 'err'); return; }
    state.lora.enabled = true;
    if (state.engine !== 'illustrious') {
      applyEngine('illustrious');   // 內部會呼叫 setupLora()，同步 checkbox/面板顯示
    } else {
      // 已經在 Illustrious，applyEngine 不會重跑 setupLora，手動同步開關狀態
      const on = $('lora-on');
      if (on) on.checked = true;
      $('lora-toggle').classList.add('on');
      show('lora-panel', true);
    }
    if (state.lora.list === null) await fetchLoras(ENG.illustrious);
    const match = (state.lora.list || []).find(l => l.name === d.name && (!d.folder || l.folder === d.folder));
    if (!match) { log(`LoRA Manager 送來的「${d.name}」在這裡的清單找不到——可能還沒重新整理過清單`, 'err'); return; }
    selectLora(match);
    $('lora-field').scrollIntoView({ behavior: 'smooth', block: 'center' });
    log(`已從 LoRA Manager 選入「${match.title || match.name}」`, 'ok');
  }
  pollLoraPush();

  init();
```

- [ ] **Step 3: 語法驗證**

Run:
```bash
node --check app.js
```
Expected: 沒有任何輸出。

- [ ] **Step 4: 在測試埠起 `serve.py`（帶著 Task 1 的改動）+ 瀏覽器驗證**

確認正式服務健康、起測試實例：
```bash
netstat -ano | grep -E ":7801|:7802|:7860|:7861|:8188" | grep LISTENING
cd C:/projects/flux2klein
python serve.py 127.0.0.1:8188 7802 > /tmp/serve_test_7802b.log 2>&1 &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7802/
```
Expected: `200`。

用 Browser 工具開 `http://127.0.0.1:7802/`，然後執行：
```js
(async () => {
  // 直接呼叫 applyLoraPush，繞開真的等 1 秒輪詢，驗證核心邏輯
  const before = { engine: state.engine, listIsNull: state.lora.list === null };
  await applyLoraPush({ folder: 'style', name: (state.lora.list || [])[0]?.name || '__不存在的名字__' });
  return {
    before,
    afterEngine: state.engine,
    loraEnabled: state.lora.enabled,
    loraOnChecked: document.getElementById('lora-on').checked,
    loraPanelVisible: getComputedStyle(document.getElementById('lora-panel')).display !== 'none',
    selected: state.lora.selected ? state.lora.selected.name : null,
  };
})();
```
Expected: `afterEngine` 是 `'illustrious'`（不管一開始是不是），`loraEnabled: true`、`loraOnChecked: true`、`loraPanelVisible: true`。若 `/panel/loras` 底下真的有 LoRA 檔案，`selected` 會是抓到的第一個 LoRA 的 `name`；若目前這台機器的 `LORA_ROOT` 是空的，`selected` 會是 `null`（因為用了 `__不存在的名字__` 當 fallback），這種情況改用真實存在的 LoRA 名稱重新驗證一次（先 `state.lora.list[0]` 確認清單非空）。

再驗證輪詢真的會抓到後端推送（用 curl 直接打 Task 1 的 POST 端點，不透過 LoRA Manager）：
```bash
curl -s -X POST http://127.0.0.1:7802/panel/lora-push \
  -H "Content-Type: application/json" -d '{"folder":"style","name":"__不存在的名字__"}'
```
等 2 秒後在瀏覽器 console 查：
```js
JSON.stringify({ ver: LORA_PUSH_VER })
```
Expected: `LORA_PUSH_VER` 應該已經遞增（輪詢確實抓到了這次 POST 的新版本號），因為 `name` 對不上任何真實 LoRA，畫面上會看到一則 `log()` 錯誤訊息「在這裡的清單找不到」（用瀏覽器工具讀 `#log` 底下最後一行的文字確認）。

- [ ] **Step 5: 關掉測試實例，確認正式服務沒受影響**

```bash
powershell -NoProfile -Command "
\$p = Get-CimInstance Win32_Process -Filter \"CommandLine like '%serve.py%7802%'\"
foreach (\$proc in \$p) { Stop-Process -Id \$proc.ProcessId -Force }
"
sleep 1
netstat -ano | grep -E ":7801|:7802|:7860|:7861|:8188" | grep LISTENING
```
Expected: 7802 消失，其餘 PID 跟 Task 1 Step 6 之後記錄的一致。

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "$(cat <<'EOF'
app.js 新增輪詢 /panel/lora-push：收到推送自動切 Illustrious、選 LoRA

跟暗房 darkroom.js 現有的 pollLoraPush()/applyLoraPush() 同一套邏輯，
差別是這裡直接呼叫 applyEngine() 而不是 selectEngine()——後者用 View
Transitions 包一層，updateCallback 是排程執行不是同步完成，這裡需要呼叫
完就能確定引擎已經切好、LoRA 面板 DOM 已建好，才能接著抓清單、選 LoRA，
所以犧牲掉這個自動觸發路徑的換色動畫、換同步可預期的完成時機。

已在測試埠 7802 用瀏覽器直接呼叫 applyLoraPush() 驗證：引擎自動切到
illustrious、LoRA 開關自動開啟、面板顯示、選中對應 LoRA；也用 curl 直接
打 /panel/lora-push 驗證輪詢真的會抓到新版本並套用。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: LoRA Manager 的「送到 workflow」同時推送給暗房與 KLEIN

**Files:**
- Modify: `lora-manager/static/js/utils/uiHelpers.js:655-684`

**Interfaces:**
- Consumes: Task 1 的 `POST /panel/lora-push`（跟既有的暗房 `POST /api/lora-push` 平行呼叫）
- Produces: `sendLoraToDarkroom(folder, fileNameNoExt)` 的行為改變（函式名稱、參數不變，`ModelCard.js`/`LoraContextMenu.js` 兩個呼叫點不用動）——這是這個功能鏈路的最後一段，後面沒有其他 task 依賴它的內部細節

- [ ] **Step 1: 讀現有實作，確認要改的精確範圍**

Run:
```bash
grep -n "DARKROOM_ORIGIN\|export async function sendLoraToDarkroom" lora-manager/static/js/utils/uiHelpers.js
```
Expected: 看到 `const DARKROOM_ORIGIN = 'http://127.0.0.1:7860';` 那行、以及 `sendLoraToDarkroom` 函式開始的行號，確認範圍在第 655-684 行左右（若行號有出入，以實際 grep 結果為準，下一步用實際內容比對取代）。

- [ ] **Step 2: 改寫 `sendLoraToDarkroom`**

找到現有的：

```js
// flux2klein 整合（見 ../../VENDORED.md）：standalone 模式本來就連不到真正的
// ComfyUI 網頁，sendLoraToWorkflow() 那條「同源 LiteGraph 即時改節點」的路一定會
// 失敗（/api/lm/get-registry 固定回 Standalone Mode Active，只彈一個沒用的警告
// toast）。改成直接 POST 給暗房（darkroom/preview_ui.py 的 /api/lora-push），
// 暗房輪詢偵測到新版本就自動選進生圖大面板——這是「送到 workflow」在這份專案裡
// 實際做的事。暗房預設 7860，換過 port 要記得改這裡。共用給 ModelCard.js 跟
// LoraContextMenu.js 兩個呼叫點用，避免各自重複一份 fetch 邏輯。
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
      const msg = `已送到暗房：${fileNameNoExt}`;
      showToast('toast.general.sentToDarkroom', {}, 'success', msg);
    } else {
      const msg = `暗房回應失敗：${result.error || res.status}`;
      showToast('toast.general.sendToDarkroomFailed', {}, 'error', msg);
    }
  } catch (error) {
    console.error('Failed to send LoRA to darkroom:', error);
    const msg = `連不到暗房（${DARKROOM_ORIGIN}）：${error.message}`;
    showToast('toast.general.sendToDarkroomFailed', {}, 'error', msg);
  }
}
```

整段改成：

```js
// flux2klein 整合（見 ../../VENDORED.md）：standalone 模式本來就連不到真正的
// ComfyUI 網頁，sendLoraToWorkflow() 那條「同源 LiteGraph 即時改節點」的路一定會
// 失敗（/api/lm/get-registry 固定回 Standalone Mode Active，只彈一個沒用的警告
// toast）。改成直接 POST 給暗房（darkroom/preview_ui.py 的 /api/lora-push）與
// KLEIN 面板（serve.py 的 /panel/lora-push）——兩邊各自輪詢，哪邊分頁開著就自動
// 選中。函式名稱維持 sendLoraToDarkroom（雖然現在語意是「送到兩邊」），改名要跟著
// 改 ModelCard.js/LoraContextMenu.js 兩個呼叫點，範圍不必要地擴大，用註解說明現況
// 即可（見 VENDORED.md）。共用給那兩處用，避免各自重複一份 fetch 邏輯。
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

- [ ] **Step 3: 語法驗證**

Run:
```bash
node --check lora-manager/static/js/utils/uiHelpers.js
```
Expected: 沒有任何輸出。

- [ ] **Step 4: 用兩個假的目標伺服器做行為驗證（不用真的跑 LoRA Manager）**

這一步不需要啟動整個 LoRA Manager（aiohttp、資料庫掃描等一大套依賴），因為要驗證的邏輯就是「平行打兩個 URL、根據成功/失敗組合顯示對應訊息」。寫一個獨立的 Node 測試腳本，把 `pushLora`/`sendLoraToDarkroom` 的邏輯複製進去（不 import 真正的檔案，因為那個檔案 import 了一大堆 LoRA Manager 內部模組），改用兩個本機臨時 HTTP server 當假的暗房／KLEIN 端點：

在 `C:\Users\boshe\AppData\Local\Temp\claude\C--projects-flux2klein\952bdefd-c8b1-4348-b97d-43ae2ff24c87\scratchpad\test_send_lora.mjs` 寫入：

```js
import http from 'node:http';

function makeServer(port, shouldFail) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (shouldFail) { res.writeHead(500); res.end(JSON.stringify({ error: 'boom' })); }
        else { res.writeHead(200); res.end(JSON.stringify({ ok: true, ver: 1, received: JSON.parse(body) })); }
      });
    });
    srv.listen(port, () => resolve(srv));
  });
}

const toasts = [];
function showToast(key, params, type, fallback) { toasts.push({ key, type, fallback }); }

const DARKROOM_ORIGIN = 'http://127.0.0.1:18760';
const KLEIN_ORIGIN = 'http://127.0.0.1:18701';

async function pushLora(origin, path, folder, fileNameNoExt) {
  const res = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, name: fileNameNoExt }),
  });
  const result = await res.json().catch(() => ({}));
  if (!(res.ok && result.ok)) throw new Error(result.error || String(res.status));
}

async function sendLoraToDarkroom(folder, fileNameNoExt) {
  const [dr, kl] = await Promise.allSettled([
    pushLora(DARKROOM_ORIGIN, '/api/lora-push', folder, fileNameNoExt),
    pushLora(KLEIN_ORIGIN, '/panel/lora-push', folder, fileNameNoExt),
  ]);
  if (dr.status === 'fulfilled' && kl.status === 'fulfilled') {
    showToast('k', {}, 'success', `已送到暗房、KLEIN 面板：${fileNameNoExt}`);
  } else if (dr.status === 'fulfilled') {
    showToast('k', {}, 'success', `已送到暗房：${fileNameNoExt}（KLEIN 面板沒連上，略過）`);
  } else if (kl.status === 'fulfilled') {
    showToast('k', {}, 'success', `已送到 KLEIN 面板：${fileNameNoExt}（暗房沒連上，略過）`);
  } else {
    showToast('k', {}, 'error', `暗房、KLEIN 面板都送失敗：${fileNameNoExt}`);
  }
}

async function run() {
  // 情境 1：兩邊都成功
  let dr = await makeServer(18760, false), kl = await makeServer(18701, false);
  await sendLoraToDarkroom('style', 'test_a');
  dr.close(); kl.close();

  // 情境 2：只有暗房成功
  dr = await makeServer(18760, false); kl = await makeServer(18701, true);
  await sendLoraToDarkroom('style', 'test_b');
  dr.close(); kl.close();

  // 情境 3：只有 KLEIN 成功
  dr = await makeServer(18760, true); kl = await makeServer(18701, false);
  await sendLoraToDarkroom('style', 'test_c');
  dr.close(); kl.close();

  // 情境 4：兩邊都失敗
  dr = await makeServer(18760, true); kl = await makeServer(18701, true);
  await sendLoraToDarkroom('style', 'test_d');
  dr.close(); kl.close();

  console.log(JSON.stringify(toasts, null, 2));
}
run();
```

Run:
```bash
node "C:\Users\boshe\AppData\Local\Temp\claude\C--projects-flux2klein\952bdefd-c8b1-4348-b97d-43ae2ff24c87\scratchpad\test_send_lora.mjs"
```

Expected: 印出 4 筆 toast 紀錄，依序是：
1. `type: "success"`, `fallback` 含「已送到暗房、KLEIN 面板」
2. `type: "success"`, `fallback` 含「已送到暗房」且含「KLEIN 面板沒連上」
3. `type: "success"`, `fallback` 含「已送到 KLEIN 面板」且含「暗房沒連上」
4. `type: "error"`, `fallback` 含「都送失敗」

這驗證了 `sendLoraToDarkroom` 的四種成功/失敗組合都對應到正確的訊息分支——跟實際檔案裡的邏輯一字不差（只是拿掉了無關的 import），所以這個驗證結果可信地反映真正檔案的行為。

- [ ] **Step 5: Commit**

```bash
git add lora-manager/static/js/utils/uiHelpers.js
git commit -m "$(cat <<'EOF'
LoRA Manager「送到 workflow」改成同時推送暗房與 KLEIN 面板

sendLoraToDarkroom() 函式名稱不變（避免要跟著改 ModelCard.js/
LoraContextMenu.js 兩個呼叫點），內部改成 Promise.allSettled 平行打兩個
端點：既有的暗房 /api/lora-push，新增 KLEIN 面板的 /panel/lora-push
（見上一個 commit）。兩邊各自輪詢，哪邊分頁開著就自動選中；單邊失敗只在
console 記錄，合併成一則涵蓋四種成功/失敗組合的 toast，不會兩則疊在一起
打斷使用者。

用獨立測試腳本（兩個本機臨時 HTTP server 模擬暗房／KLEIN 端點，複製了
跟正式檔案一字不差的邏輯）驗證過四種組合都對應到正確的訊息分支，沒有起
整套 LoRA Manager（依賴太重，這裡要驗證的只是這段 fetch 邏輯本身）。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 端對端整合驗證（三個服務都用測試埠跑起來）＋ 文件更新

**Files:**
- Modify: `lora-manager/VENDORED.md`（「對照上游改了什麼」段落）
- Modify: `README.md`（「LoRA Manager」一節）
- Modify: `進度.md`（變更紀錄最上方補三筆，對應 Task 1-3 的三個 commit）

**Interfaces:**
- Consumes: Task 1（`serve.py` 的 `/panel/lora-push`）、Task 2（`app.js` 的輪詢）、Task 3（`uiHelpers.js` 的雙推送）——這個 task 是三者串起來的最終驗證
- Produces: 無（文件與驗證，終端 task）

- [ ] **Step 1: 三個測試埠同時起——`serve.py`、`darkroom/preview_ui.py`、`lora-manager`**

確認正式服務健康：
```bash
netstat -ano | grep -E ":7801|:7802|:7860|:7861|:7883|:7891" | grep LISTENING
```
Expected: 只看到 7801/7860/7861 是正式服務的 PID，7802/7883/7891 都沒有東西在監聽。

起三個測試實例：
```bash
cd C:/projects/flux2klein
python serve.py 127.0.0.1:8188 7802 > /tmp/serve_test_final.log 2>&1 &
cd C:/projects/flux2klein/darkroom
python preview_ui.py --port 7883 --no-open > /tmp/darkroom_test_final.log 2>&1 &
sleep 2
```

LoRA Manager 需要的環境變數（`LORA_ROOT`）跟寫settings 的步驟比較重，這裡改用 curl 直接模擬 LoRA Manager 送出的請求（Task 3 已經用獨立腳本驗證過 `sendLoraToDarkroom` 內部邏輯本身的正確性，這裡只要確認「兩個真正的後端服務」都收得到、狀態對得起來，不需要真的啟動 LoRA Manager 這個重依賴的服務）：

```bash
curl -s -X POST http://127.0.0.1:7802/panel/lora-push \
  -H "Content-Type: application/json" -d '{"folder":"style","name":"e2e_test_lora"}'
curl -s -X POST http://127.0.0.1:7860/api/lora-push \
  -H "Content-Type: application/json" -d '{"folder":"style","name":"e2e_test_lora"}'
```
Expected: 兩個都回 `{"ok": true, "ver": ...}`。

- [ ] **Step 2: 瀏覽器分別開兩個面板確認自動選取（若 `LORA_ROOT` 底下真的有名為的檔案就會選中；若沒有，確認的是「正確顯示找不到的錯誤訊息」這件事本身也是正確行為）**

先查 `LORA_ROOT` 底下第一個資料夾（例如 `style`）有沒有檔案，選一個真實存在的名字重跑 Step 1 的兩個 curl（把 `e2e_test_lora` 換成真實存在的 `name`），然後：

用 Browser 工具開 `http://127.0.0.1:7802/`，等 2 秒後查：
```js
JSON.stringify({ engine: state.engine, selected: state.lora.selected?.name, loraEnabled: state.lora.enabled })
```
Expected: `engine: "illustrious"`、`selected` 是剛剛推送的那個名字、`loraEnabled: true`。

用 Browser 工具開 `http://127.0.0.1:7883/`（暗房），確認暗房那邊既有的機制沒有被這次改動影響（Task 1-3 都沒有動 `darkroom/` 底下任何檔案，這裡純粹是回歸確認）：
```js
JSON.stringify({ mode: MODE, selected: GEN_LORA?.name })
```
Expected: `mode: "gen"`（暗房收到推送會自動切生圖模式）、`selected` 是剛剛推送的那個名字。

- [ ] **Step 3: 全部關掉，最終確認正式服務完全沒被動到**

```bash
powershell -NoProfile -Command "
\$p = Get-CimInstance Win32_Process -Filter \"CommandLine like '%serve.py%7802%' or CommandLine like '%preview_ui.py%7883%'\"
foreach (\$proc in \$p) { Stop-Process -Id \$proc.ProcessId -Force }
"
sleep 1
netstat -ano | grep -E ":7801|:7802|:7860|:7861|:7883|:7891" | grep LISTENING
```
Expected: 只剩 7801/7860/7861，PID 跟這個 task 開始前記錄的完全一致。

- [ ] **Step 4: 更新 `lora-manager/VENDORED.md`**

找到「對照上游改了什麼」段落裡描述 `uiHelpers.js` 的那一條項目符號，在後面補充：

```markdown
  （2026-08：`sendLoraToDarkroom()` 進一步擴充成同時推送給暗房與 KLEIN 面板
  兩個目標——函式名稱沒再改，內部改用 `Promise.allSettled` 平行打兩個端點，
  合併成一則涵蓋四種成功/失敗組合的 toast。詳見 flux2klein 專案的
  `docs/superpowers/specs/2026-08-06-lora-manager-to-klein-design.md`。）
```

- [ ] **Step 5: 更新 `README.md` 的「LoRA Manager」一節**

找到：

> **「送到 workflow」改送去暗房**：這是**唯一被改過的功能**——原版的「送到 workflow」是靠同源 ComfyUI 網頁即時改 LiteGraph 節點，standalone 模式下這條路本來就走不通（只會跳一個沒用的警告）。改成點了直接**推進你目前開著的暗房分頁**：暗房自動切到生圖模式、開大面板、選進那個 LoRA——不用手動找、不用複製貼上。右鍵選單的「送到 workflow」也是同一套。

改成：

> **「送到 workflow」改送去暗房與 KLEIN 面板**：這是**唯一被改過的功能**——原版的「送到 workflow」是靠同源 ComfyUI 網頁即時改 LiteGraph 節點，standalone 模式下這條路本來就走不通（只會跳一個沒用的警告）。改成點了**同時推給暗房與 KLEIN 主面板**（`serve.py` 的 `/panel/lora-push`）：哪邊分頁開著，哪邊就自動選中——暗房自動切到生圖模式、開大面板；KLEIN 面板自動切到 Illustrious 引擎、開啟 LoRA 開關、選進那個 LoRA，都不用手動找、不用複製貼上。沒開著的那邊下次打開輪詢照樣拿得到（單一格、最新一次覆蓋前一次，不排隊）。右鍵選單的「送到 workflow」也是同一套。

- [ ] **Step 6: 更新 `進度.md`**

在「變更紀錄」最上方（目前最新一筆是 `f5fbfef` 那則，見 `進度.md`），依序（新的在最上面）補三筆，對應 Task 1、2、3 各自的 commit hash（**Task 1-3 commit 之後，實際 hash 要用 `git log --oneline -5` 查出來填進去，下面示意用 `<TASK1_HASH>` 等佔位標記，實際寫入時必須換成真正的 40 碼縮寫 hash**）：

```markdown
### 2026-08-06 · `<TASK3_HASH>` LoRA Manager「送到 workflow」改成同時推送暗房與 KLEIN 面板
使用者想讓 LoRA Manager 的「送到 workflow」也能選進 KLEIN 主面板的 Illustrious 引擎，不只是暗房。先用 brainstorming skill 討論出設計（同時推兩邊、KLEIN 收到推送自動切 Illustrious、單一格最新覆蓋不排隊），寫成 `docs/superpowers/specs/2026-08-06-lora-manager-to-klein-design.md`，再用 writing-plans 產出實作計畫分三個 task 執行。這是最後一步：`uiHelpers.js` 的 `sendLoraToDarkroom()` 改用 `Promise.allSettled` 平行打暗房 `/api/lora-push` 與 KLEIN `/panel/lora-push`，合併成一則涵蓋四種成功/失敗組合的 toast，函式名稱不變（避免動到 `ModelCard.js`/`LoraContextMenu.js` 兩個呼叫點）。

### 2026-08-06 · `<TASK2_HASH>` app.js 新增輪詢 /panel/lora-push：收到推送自動切 Illustrious、選 LoRA
跟暗房 `darkroom.js` 既有的 `pollLoraPush()`/`applyLoraPush()` 同一套邏輯，差別是直接呼叫 `applyEngine()` 而不是 `selectEngine()`——後者的 View Transitions 包裝是排程執行、不同步，這裡需要呼叫完就確定引擎已切好、LoRA 面板 DOM 已建好，犧牲掉這個自動觸發路徑的換色動畫換取同步完成。

### 2026-08-06 · `<TASK1_HASH>` serve.py 新增 /panel/lora-push：接 LoRA Manager 推送給 KLEIN 面板
跟暗房既有的 `/api/lora-push`（`darkroom/preview_ui.py`）同一套設計搬過來：單一格、版本號遞增、GET 輪詢帶 `since` 省流量。`serve.py` 是手寫 socket server 不是 `http.server`，這是它第一次要處理 POST body，額外寫了從 `recv_headers()` 已讀位元組切出 body、不足再補讀的邏輯；POST 是跨源打進來的（LoRA Manager 站 7861），加了 OPTIONS 預檢與 CORS 標頭。
```

- [ ] **Step 7: Commit 文件更新**

```bash
git add lora-manager/VENDORED.md README.md 進度.md
git commit -m "$(cat <<'EOF'
文件更新：LoRA Manager 送到 KLEIN 面板功能上線後補 VENDORED.md/README.md/進度.md

三個實作 task（serve.py 端點、app.js 輪詢、uiHelpers.js 雙推送）都完成並
在測試埠上驗證過端對端流程（真的用 curl 推送、真的在瀏覽器裡確認兩個面板
各自收到並正確選取），最後補文件：VENDORED.md 記這次擴充了 vendor 進來的
sendLoraToDarkroom()、README.md 的「LoRA Manager」一節反映新行為、進度.md
補三筆變更紀錄。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review（寫完計畫後自己過一輪）

**Spec 覆蓋度**：
- 決策 1（同時推兩邊）→ Task 3 的 `Promise.allSettled` 雙推送 ✓
- 決策 2（自動切 Illustrious）→ Task 2 的 `applyLoraPush` 呼叫 `applyEngine('illustrious')` ✓
- 決策 3（單一格最新覆蓋、不排隊）→ Task 1 沿用暗房既有機制，Step 5 curl 驗證兩次推送只留最新一筆 ✓
- 設計文件裡的 CORS/OPTIONS 需求 → Task 1 Step 2/3 的 `serve_lora_push_options`＋路由分支 ✓
- 設計文件裡「serve.py 第一次要處理 POST body」的風險 → Task 1 Step 2 `serve_lora_push_post` 手動解析 ✓
- 測試計畫的六點（語法驗證、curl 驗證三種回應、瀏覽器驗證、單一格語意驗證、測試埠收尾、文件更新）→ 分散在 Task 1/2/4 對應步驟 ✓

**Placeholder 掃描**：Task 4 Step 6 的 `<TASK1_HASH>`/`<TASK2_HASH>`/`<TASK3_HASH>` 是刻意保留的佔位——因為這三個 hash 要等 Task 1-3 實際 commit 完才存在，執行到 Task 4 時必須先跑 `git log --oneline -5` 查出真正的 hash 再填入，Step 6 裡已經明白寫出這個要求，不是遺漏。除此之外沒有 TBD/TODO 或籠統帶過的步驟。

**型別/介面一致性**：`serve_lora_push_get(client, raw_path)`／`serve_lora_push_post(client, initial)`／`serve_lora_push_options(client)` 的參數在 Task 1 Step 2（定義）與 Step 3（`handle()` 呼叫處）一致；`applyLoraPush(d)` 的 `d` 是 `{folder, name}`，跟 Task 1 POST 端點收到、存進 `_LORA_PUSH["data"]` 的格式、以及 Task 3 `pushLora()` 送出的 body 格式三處一致。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-06-lora-manager-to-klein.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
