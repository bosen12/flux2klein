# 暗房卡片模型評分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 暗房（darkroom）的每張卡片接上 waifu-score 的三個評分模型（Blackroot／Waifu Scorer／Kawai），算出加權總分，瀏覽模式生成的圖永久存分數、抽卡/生圖模式的圖只暫存分數，前端顯示分數徽章，並提供一顆「評分」按鈕補齊舊卡片。

**Architecture:** waifu-score（獨立 FastAPI 服務，`C:\projects\waifu-score`）新增一個合併評分端點；darkroom 的 `preview_ui.py` 用 stdlib `urllib.request` 呼叫它，比照既有 `flags`/`favorites`/`rarities` 的側檔 pattern 新增 `scores.<tag>.json`，在兩個既有生成掛勾點（`do_generate()`／`_gen_one_worker()`）背景觸發評分。前端在縮圖角落加分數徽章 + hover 明細，並加一顆「評分」按鈕觸發背景補分。

**Tech Stack:** Python 3 標準庫（darkroom 後端）、FastAPI + torch（waifu-score，不改動其推論邏輯）、vanilla JS（darkroom 前端）。**兩個專案都沒有測試框架**（darkroom 的 `CLAUDE.md` 明確記載這點），所以本計畫的「測試」步驟一律是手動驗證（`curl`、`python -c`、`node --check`、瀏覽器操作），不是 pytest。這跟本專案既有的驗收方式（見其他 spec 文件的「驗收標準」）一致。

## Global Constraints

- **不改** `scorer.py`／`blackroot_scorer.py`／`kawai_scorer.py` 三個模型類別，也不改既有的 `/api/score`／`/api/kawai-score`／`/api/blackroot-score` 三個端點
- **不改** darkroom 的「純標準庫」後端政策——所有新增的 HTTP 呼叫用 `urllib.request`，不裝新套件
- waifu-score 服務位址寫死 `http://localhost:8000`（跟 `run.bat` 一致），不做成可設定項
- Kawai 正規化公式：`kawai_norm = (weighted_score + 1) / 2 * 10`；加權公式：`final = blackroot*0.50 + waifu*0.20 + kawai_norm*0.30`
- 分數跟圖片存在性綁定：`has_image=False` 時 `scan_libraries()` 回傳的 `it["score"]` 一律 `None`
- 瀏覽模式生成（`do_generate`）的分數永久寫進 `.darkroom_meta/scores.<tag>.json`；抽卡/生圖模式（`/api/gen`、`/api/agent-draw`，都走 `_gen_one_worker`）的分數只附在 `_gen_status[gid]["score"]`，不落地
- 每個 task 完成後照專案慣例 commit（標題簡短、內文說明為什麼），不要累積成一個大 commit
- 對應設計文件：[docs/superpowers/specs/2026-08-14-darkroom-model-scoring-design.md](../specs/2026-08-14-darkroom-model-scoring-design.md)

---

### Task 1: waifu-score — 新增合併評分端點

**Files:**
- Modify: `C:\projects\waifu-score\app.py`

**Interfaces:**
- Produces: `POST /api/darkroom-score`（multipart，欄位 `file`），成功回傳
  `{"blackroot": float, "waifu": float, "kawai_tier": str, "kawai_score": float, "kawai_norm": float, "final": float}`；
  檔案類型/大小不合法回 400，任一模型未載入成功回 500。這個回應格式是後面 darkroom
  端 `_score_image_bytes()` 唯一要解析的合約。

- [ ] **Step 1: 在 `app.py` 加入新端點**

在既有 `blackroot_score()` 函式（`app.py:131-134`）後面、`app.mount(...)`（`app.py:137`）前面插入：

```python
@app.post("/api/darkroom-score")
async def darkroom_score(file: UploadFile = File(...)):
    """給 darkroom 用的合併評分端點：一次呼叫三個模型，回傳原始分數 + 正規化 +
    加權總分。不影響上面三個既有的 NDJSON 串流端點。"""
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {file.content_type}")
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=400, detail="File too large (max 15 MB)")
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
        image = image.convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read image file")

    try:
        blackroot = _predict_one("blackroot", image)["score"]
        waifu = _predict_one("waifu", image)["score"]
        kawai = _predict_one("kawai", image)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=f"Model failed to load: {exc}")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Scoring failed: {exc}")

    # Kawai 的 weighted_score 是 -1~1，換算到跟 blackroot/waifu 一致的 0~10 尺度
    # 才能加權相加；README 明確提醒過三個模型的分數尺度不同，不能直接比較。
    kawai_norm = round((kawai["weighted_score"] + 1) / 2 * 10, 3)
    final = round(blackroot * 0.50 + waifu * 0.20 + kawai_norm * 0.30, 3)
    return {
        "blackroot": blackroot,
        "waifu": waifu,
        "kawai_tier": kawai["tier"],
        "kawai_score": kawai["weighted_score"],
        "kawai_norm": kawai_norm,
        "final": final,
    }
```

不需要新的 import——`HTTPException`、`File`、`UploadFile`、`Image`、`io` 在檔案開頭都已經 import 過了。

- [ ] **Step 2: 手動驗證**

啟動服務（第一次啟動要等三個模型載入，看 console 印 `ready`）：

```bash
cd "C:/projects/waifu-score" && ./run.bat
```

另開一個終端機，找一張任意 webp/png 圖片測試（用暗房詞庫裡任一張已生成的圖即可）：

```bash
curl -s -F "file=@C:/projects/special_prompts/某資料夾/某張圖.webp" http://localhost:8000/api/darkroom-score
```

Expected: 回傳 JSON，帶 `blackroot`/`waifu`/`kawai_tier`/`kawai_score`/`kawai_norm`/`final` 六個欄位，`final` 是 0~10 之間的數字，`kawai_norm` 也落在 0~10。

再測錯誤情境（送一個非圖片檔）：

```bash
curl -s -F "file=@app.py;type=image/png" http://localhost:8000/api/darkroom-score
```

Expected: HTTP 400，`{"detail": "Could not read image file"}`。

- [ ] **Step 3: Commit**

```bash
cd "C:/projects/waifu-score"
git add app.py
git commit -m "$(cat <<'EOF'
新增：/api/darkroom-score 合併評分端點

給 darkroom 卡片評分功能用——一次呼叫三個模型、算好正規化與加權總分，
darkroom 那邊不用處理 NDJSON 串流或自己重複實作正規化公式。
EOF
)"
```

---

### Task 2: darkroom — 分數側檔儲存函式

**Files:**
- Modify: `C:\projects\flux2klein\darkroom\preview_ui.py:139-141`（`_meta_path` 註解）、`preview_ui.py:303-308`（`rarity_map()` 之後插入新區塊）

**Interfaces:**
- Consumes: `_meta_path(kind)`（既有）、`_atomic_write_json(path, obj)`（既有）
- Produces: `set_score(rel: str, data: dict) -> None`、`clear_score(rel: str) -> None`、
  `score_map() -> dict`、`_load_scores() -> None`——後面所有 task 都用這四個函式存取分數，
  不直接碰 `_scores` 這個模組變數。

- [ ] **Step 1: 更新 `_meta_path` 的 kind 註解**

`preview_ui.py:139-141`，把：

```python
def _meta_path(kind: str) -> Path:
    """kind ∈ {flags, favorites, rarities}。回傳本 dataset 專屬的 json 路徑。"""
    return META_DIR / f"{kind}.{_dataset_tag()}.json"
```

改成：

```python
def _meta_path(kind: str) -> Path:
    """kind ∈ {flags, favorites, rarities, scores}。回傳本 dataset 專屬的 json 路徑。"""
    return META_DIR / f"{kind}.{_dataset_tag()}.json"
```

- [ ] **Step 2: 在 `rarity_map()` 之後（`preview_ui.py:305` 後）插入分數側檔區塊**

```python
# ---------------------------------------------------------------------------
# 卡片評分（waifu-score 三模型的加權分數）：結構同上面幾組側檔，但只有瀏覽模式
# 生成（do_generate）落地的圖片才會寫進這份側檔，抽卡/生圖模式的暫時結果不落地，
# 見 docs/superpowers/specs/2026-08-14-darkroom-model-scoring-design.md。
# key 是詞庫 rel，value 是 waifu-score /api/darkroom-score 的原始回應 + "at" 時間戳。
# ---------------------------------------------------------------------------
_scores: dict = {}   # rel -> {blackroot, waifu, kawai_tier, kawai_score, kawai_norm, final, at}
_scores_lock = threading.Lock()


def _load_scores():
    global _scores
    path = _meta_path("scores")
    if not path.is_file():
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        sc = d.get("scores") if isinstance(d, dict) else None
        if isinstance(sc, dict):
            _scores = sc
        plog(f"[score] 載入 {len(_scores)} 筆分數")
    except Exception as e:
        plog(f"[score] 讀取失敗，從空白開始：{e}")


def _save_scores_locked():
    """呼叫端須已持有 _scores_lock。"""
    _atomic_write_json(_meta_path("scores"), {"scores": _scores})


def set_score(rel: str, data: dict) -> None:
    with _scores_lock:
        _scores[rel] = data
        _save_scores_locked()


def clear_score(rel: str) -> None:
    """從側檔移除一筆——補分（run_score_backfill）清孤兒紀錄用。"""
    with _scores_lock:
        if rel in _scores:
            _scores.pop(rel, None)
            _save_scores_locked()


def score_map() -> dict:
    with _scores_lock:
        return dict(_scores)
```

- [ ] **Step 3: 在 `main()` 裡呼叫 `_load_scores()`**

`preview_ui.py:2071-2073`，把：

```python
    _load_flags()                 # 載入品質旗標黑名單（依 dataset 分檔）
    _load_favs()                  # 載入收藏清單（依 dataset 分檔）
    _load_rarities()              # 載入稀有度側檔（依 dataset 分檔）
```

改成：

```python
    _load_flags()                 # 載入品質旗標黑名單（依 dataset 分檔）
    _load_favs()                  # 載入收藏清單（依 dataset 分檔）
    _load_rarities()              # 載入稀有度側檔（依 dataset 分檔）
    _load_scores()                # 載入卡片評分側檔（依 dataset 分檔）
```

- [ ] **Step 4: 手動驗證（不啟動伺服器，用 `python -c` 直接測函式）**

```bash
cd "C:/projects/flux2klein/darkroom" && python -c "
import preview_ui as pu
pu.apply_special_dir(r'C:\projects\special_prompts')
pu.set_score('测试/foo.py', {'blackroot': 7.1, 'waifu': 6.0, 'kawai_tier': 'A', 'kawai_score': 0.3, 'kawai_norm': 6.5, 'final': 6.8, 'at': 123.0})
print(pu.score_map())
pu.clear_score('测试/foo.py')
print(pu.score_map())
"
```

Expected: 第一次印出含那筆分數的 dict；`clear_score` 後印出空 dict `{}`。確認
`darkroom/.darkroom_meta/scores.<hash>.json` 這個檔案有被建立過（`clear_score`
後檔案內容會是 `{"scores": {}}`，檔案本身不會消失，這是預期行為）。

- [ ] **Step 5: Commit**

```bash
cd "C:/projects/flux2klein"
git add darkroom/preview_ui.py
git commit -m "$(cat <<'EOF'
新增：暗房卡片評分側檔儲存（scores.<tag>.json）

比照 flags/favorites/rarities 的既有 pattern，先把儲存這一層獨立出來，
之後幾個 task 再接生成流程的觸發點跟 API。
EOF
)"
```

---

### Task 3: darkroom — 呼叫 waifu-score 服務的 HTTP helper

**Files:**
- Modify: `preview_ui.py:42`（imports）、插入新區塊（Task 2 新增區塊之後）

**Interfaces:**
- Consumes: 無（純 stdlib `urllib.request`）
- Produces: `_score_image_bytes(img_bytes: bytes) -> dict | None`（成功回傳 Task 1
  定義的六欄位 dict，失敗回 `None`）、`_score_service_available() -> bool`、
  `_score_sem`（`threading.Semaphore(1)`）——後面 task 3 個都會用到。

- [ ] **Step 1: 加 `urllib.request` import**

`preview_ui.py:42`，把：

```python
import urllib.parse
```

改成：

```python
import urllib.parse
import urllib.request
```

- [ ] **Step 2: 插入 HTTP helper 區塊（接在 Task 2 新增的 `score_map()` 之後）**

```python
# ---------------------------------------------------------------------------
# 呼叫 waifu-score 評分服務（獨立 FastAPI 服務，使用者自己跑 run.bat 啟動，
# 見 waifu-score/README.md）。位址寫死本機，這次沒有遠端部署需求。
# ---------------------------------------------------------------------------
SCORE_SERVICE_BASE = "http://localhost:8000"
SCORE_TIMEOUT = 30.0
_score_sem = threading.Semaphore(1)   # 序列化評分請求，見下方說明


def _score_image_bytes(img_bytes: bytes) -> dict | None:
    """POST 圖片 bytes 給 waifu-score 的合併端點，回傳 Task 1 定義的分數 dict；
    連線失敗/timeout/非 200 一律安靜回 None（呼叫端負責 log），不拋例外——評分
    是錦上添花的背景動作，不能因為服務沒開就影響生成本身。"""
    boundary = f"----darkroomscore{uuid.uuid4().hex}"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="card.webp"\r\n'
        f"Content-Type: image/webp\r\n\r\n"
    ).encode("utf-8") + img_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")
    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "User-Agent": "darkroom-preview-ui/1.0",
    }
    req = urllib.request.Request(f"{SCORE_SERVICE_BASE}/api/darkroom-score",
                                 data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=SCORE_TIMEOUT) as resp:
            raw = resp.read()
        return json.loads(raw.decode("utf-8"))
    except Exception as e:
        plog(f"[score] 評分失敗：{type(e).__name__}: {e}")
        return None


def _score_service_available() -> bool:
    """輕量健康檢查，給補分按鈕/腳本啟動前用。短 timeout，連不上直接回 False，
    不拋例外。"""
    req = urllib.request.Request(f"{SCORE_SERVICE_BASE}/api/health",
                                 headers={"User-Agent": "darkroom-preview-ui/1.0"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False
```

`_score_sem` 序列化實際的評分 HTTP 呼叫的原因：`app.py` 的端點內部呼叫是同步
阻塞的 torch 呼叫、沒有 offload 到 threadpool，並發請求在 waifu-score 那邊本來
就會互相卡住（事件迴圈被佔用），darkroom 這邊乾脆用 1 個名額天然序列化，不會
有多個 thread 同時卡在同一個阻塞呼叫上白白佔資源。

- [ ] **Step 3: 手動驗證（waifu-score 服務要是開著的，接續 Task 1 驗證時的狀態）**

```bash
cd "C:/projects/flux2klein/darkroom" && python -c "
import preview_ui as pu
print('service available:', pu._score_service_available())
data = open(r'C:\projects\special_prompts\某資料夾\某張圖.webp', 'rb').read()
print(pu._score_image_bytes(data))
"
```

Expected: `service available: True`；第二行印出含六個分數欄位的 dict。

再驗證服務沒開時的行為（先 Ctrl+C 停掉 waifu-score 服務）：

```bash
cd "C:/projects/flux2klein/darkroom" && python -c "
import preview_ui as pu
print('service available:', pu._score_service_available())
print(pu._score_image_bytes(b'not a real image'))
"
```

Expected: `service available: False`；第二行印出 `None`，且 console 有一行
`[score] 評分失敗：...` 的 log，沒有拋出例外、程式正常結束。

- [ ] **Step 4: Commit**

```bash
cd "C:/projects/flux2klein"
git add darkroom/preview_ui.py
git commit -m "$(cat <<'EOF'
新增：暗房呼叫 waifu-score 評分服務的 HTTP helper

stdlib urllib.request 手刻 multipart POST，不裝新套件。服務沒開/失敗
一律安靜回 None，評分是背景動作不該影響生成本身。
EOF
)"
```

---

### Task 4: darkroom — 掛勾瀏覽模式生成（永久評分）

**Files:**
- Modify: `preview_ui.py:1024`（`do_generate()` 內）、插入 `_score_and_persist()` 函式

**Interfaces:**
- Consumes: `_score_image_bytes()`、`_score_sem`、`set_score()`（Task 2/3 產出）
- Produces: `_score_and_persist(rel: str, img_bytes: bytes) -> None`（在自己的
  daemon thread 裡跑，沒有回傳值可用，效果是側檔多一筆）

- [ ] **Step 1: 在 Task 3 新增區塊之後插入 `_score_and_persist()`**

```python
def _score_and_persist(rel: str, img_bytes: bytes):
    """瀏覽模式生成成功後的背景評分：算完就永久寫進側檔。見 do_generate() 裡
    的呼叫點——緊接在 _scan_note_image() 之後，用同一份剛寫出的圖片 bytes，
    不用另外重讀檔案。"""
    with _score_sem:
        result = _score_image_bytes(img_bytes)
    if result:
        result["at"] = time.time()
        set_score(rel, result)
```

- [ ] **Step 2: 在 `do_generate()` 呼叫 `_scan_note_image()` 之後 spawn 背景 thread**

`preview_ui.py:1024`，把：

```python
            _scan_note_image(rel, out_img)
```

改成：

```python
            _scan_note_image(rel, out_img)
            threading.Thread(target=_score_and_persist, args=(rel, img_bytes),
                             daemon=True).start()
```

（`img_bytes` 是 `do_generate()` 前面幾行 `download_image()` 拿到、已經寫進
`out_img` 的同一份 bytes，見 `preview_ui.py:1014`，直接重用不用重讀磁碟。）

- [ ] **Step 3: 手動驗證**

確認 waifu-score 服務開著，啟動暗房（`python preview_ui.py`），瀏覽模式對任一
張詞庫按「生成」或「重新生成」。生成完成（前端顯示「完成」）後等個幾秒，檢查
側檔：

```bash
cat "C:/projects/flux2klein/darkroom/.darkroom_meta/scores."*".json"
```

Expected: 剛生成那筆 `rel` 出現在 JSON 裡，帶六個分數欄位 + `at` 時間戳。

再驗證覆蓋行為：對同一張卡片再按一次「重新生成」，確認側檔裡那筆的 `at` 時間戳
變新、分數可能不同（不是新增第二筆，`rel` 底下還是只有一個物件）。

- [ ] **Step 4: Commit**

```bash
cd "C:/projects/flux2klein"
git add darkroom/preview_ui.py
git commit -m "$(cat <<'EOF'
新增：瀏覽模式生成成功後背景評分，永久寫進側檔

掛在 _scan_note_image() 之後，用同一份圖片 bytes 不重讀檔案。背景執行緒
跑，不阻塞生成本身的回應——評分服務沒開的話安靜跳過（見前一個 commit）。
EOF
)"
```

---

### Task 5: darkroom — 掛勾抽卡/生圖模式（暫時評分）

**Files:**
- Modify: `preview_ui.py:1350`（`_gen_one_worker()` 內）、插入 `_score_gen_result()` 函式

**Interfaces:**
- Consumes: `_score_image_bytes()`、`_score_sem`（Task 3 產出）、`_gen_lock`、
  `_gen_status`（既有模組變數）
- Produces: `_score_gen_result(gid: str, img_bytes: bytes) -> None`；副作用是
  `_gen_status[gid]["score"]` 多一個欄位（成功時），`/api/gen-status` 既有的
  回應會自動把它一起送出（`skip` 集合裡沒有 `"score"`，見 `preview_ui.py:1668`）

- [ ] **Step 1: 在 Task 4 新增區塊之後插入 `_score_gen_result()`**

```python
def _score_gen_result(gid: str, img_bytes: bytes):
    """抽卡/生圖模式的背景評分：只附進 _gen_status[gid]["score"]，不寫側檔——
    這條路徑的結果本來就只存在記憶體（_gen_results），評分自然也只是暫時的。"""
    with _score_sem:
        result = _score_image_bytes(img_bytes)
    if result:
        with _gen_lock:
            if gid in _gen_status:
                _gen_status[gid]["score"] = result
```

- [ ] **Step 2: 在 `_gen_one_worker()` 標記完成之後 spawn 背景 thread**

`preview_ui.py:1344-1350`，把：

```python
            data = download_image(base, images[0])
            with _gen_lock:
                _gen_results[gid] = {"bytes": data, "ctype": "image/webp"}
                _gen_preview.pop(gid, None)
                # seed 以字串回傳：seed 可達 2^63，超過 JS Number.MAX_SAFE_INTEGER（2^53），
                # 用數字會在前端 JSON.parse 掉精度（末幾位變 0），資訊面板顯示的 seed 會失真。
                _gen_status[gid].update(status="done", seed=str(seed))
```

改成：

```python
            data = download_image(base, images[0])
            with _gen_lock:
                _gen_results[gid] = {"bytes": data, "ctype": "image/webp"}
                _gen_preview.pop(gid, None)
                # seed 以字串回傳：seed 可達 2^63，超過 JS Number.MAX_SAFE_INTEGER（2^53），
                # 用數字會在前端 JSON.parse 掉精度（末幾位變 0），資訊面板顯示的 seed 會失真。
                _gen_status[gid].update(status="done", seed=str(seed))
            threading.Thread(target=_score_gen_result, args=(gid, data), daemon=True).start()
```

- [ ] **Step 3: 手動驗證**

確認 waifu-score 服務開著，暗房切到「生圖」模式，選一個詞庫套 LoRA 生成（或用
「抽卡」）。生成完成後，用瀏覽器開發者工具或 curl 打：

```bash
curl -s "http://localhost:7860/api/gen-status?ids=<剛才生成的gid>"
```

（`gid` 可以從瀏覽器 Network 面板的 `/api/gen-status` 請求裡看到，或從
`/api/gen` 的回應 `items[].id` 拿）Expected: 生成完成幾秒後，回應裡多一個
`score` 欄位（六個分數子欄位）。確認 `.darkroom_meta/scores.<tag>.json`
**完全沒有新增這次生圖模式產生的 rel**（只有 Task 4 那種瀏覽模式生成才會進
側檔）。

- [ ] **Step 4: Commit**

```bash
cd "C:/projects/flux2klein"
git add darkroom/preview_ui.py
git commit -m "$(cat <<'EOF'
新增：抽卡/生圖模式生成成功後背景評分，只暫存記憶體

掛在 _gen_one_worker() 標記 done 之後，分數附進 _gen_status[gid]["score"]，
/api/gen-status 既有回應直接帶出去，不用新增端點。不寫側檔——這條路徑本來
就不落地存圖，分數也不該落地。
EOF
)"
```

---

### Task 6: darkroom — `scan_libraries()` 疊加分數（含存在性綁定）

**Files:**
- Modify: `preview_ui.py:813-825`

**Interfaces:**
- Consumes: `score_map()`（Task 2）
- Produces: `scan_libraries()` 回傳的每筆 dict 多一個 `"score"` 欄位（`dict | None`）

- [ ] **Step 1: 修改疊加邏輯**

`preview_ui.py:813-825`，把：

```python
    with STATE["jobs_lock"]:
        jobs = dict(STATE["jobs"])
    fl = flagged_set()
    fv = fav_set()
    rmap = rarity_map()
    return [
        dict(it,
             job=dict(jobs.get(it["rel"]) or {}),
             flagged=(it["rel"] in fl),
             favorited=(it["rel"] in fv),
             rarity=(rmap[it["rel"]] if it["rel"] in rmap else it["rarity"]))
        for it in cached
    ]
```

改成：

```python
    with STATE["jobs_lock"]:
        jobs = dict(STATE["jobs"])
    fl = flagged_set()
    fv = fav_set()
    rmap = rarity_map()
    smap = score_map()
    return [
        dict(it,
             job=dict(jobs.get(it["rel"]) or {}),
             flagged=(it["rel"] in fl),
             favorited=(it["rel"] in fv),
             rarity=(rmap[it["rel"]] if it["rel"] in rmap else it["rarity"]),
             # 分數跟圖片存在性綁定：has_image=False 一律回 None，即使側檔裡還留著
             # 舊紀錄（圖被刪了/還沒生成過），不能顯示分數——見設計文件「分數跟圖片
             # 存在性綁定」一節，這個不變量只在這個唯一的讀取點保證，不用到處掛
             # 刪除 hook。
             score=(smap.get(it["rel"]) if it["has_image"] else None))
        for it in cached
    ]
```

- [ ] **Step 2: 手動驗證**

```bash
cd "C:/projects/flux2klein/darkroom" && python -c "
import preview_ui as pu
pu.apply_special_dir(r'C:\projects\special_prompts')
items = pu.scan_libraries(force=True)
scored = [it for it in items if it.get('score')]
print('有分數的筆數:', len(scored))
print('範例:', scored[0] if scored else None)
no_img_with_score = [it for it in items if not it['has_image'] and it.get('rel') in pu.score_map()]
print('has_image=False 但側檔仍有分數的筆數:', len(no_img_with_score))
no_img_scores = [it['score'] for it in no_img_with_score]
print('這些筆的 score 欄位（應該全是 None）:', no_img_scores)
"
```

Expected: 第一行印出 Task 4/5 驗證時已經評過分的卡片數（>0，如果前面步驟有跑
過的話）；最後一行如果有孤兒紀錄，`score` 欄位全部是 `None`（即使側檔裡有值）。

- [ ] **Step 3: Commit**

```bash
cd "C:/projects/flux2klein"
git add darkroom/preview_ui.py
git commit -m "$(cat <<'EOF'
新增：scan_libraries() 疊加卡片分數，綁定圖片存在性

比照 flagged/favorited/rarity 的疊加寫法。has_image=False 時強制回傳
score=None，即使側檔裡還留著舊紀錄——保證「沒圖片不會顯示分數」這個
不變量只需要在這一個讀取點檢查，不用在每個可能刪圖的地方個別清側檔。
EOF
)"
```

---

### Task 7: darkroom — 補分核心邏輯 `run_score_backfill()`

**Files:**
- Modify: `preview_ui.py:514-535`（`STATE` 定義，加欄位）、插入 `run_score_backfill()` 函式

**Interfaces:**
- Consumes: `scan_libraries()`、`score_map()`、`set_score()`、`clear_score()`、
  `py_of()`、`find_image()`、`_score_image_bytes()`、`_score_sem`（皆既有/Task 2/3 產出）
- Produces: `run_score_backfill(progress_cb=None) -> None`（同步函式，呼叫端自己
  決定要不要包 thread）；副作用是更新 `STATE["score_backfill"]`
  （`{"running": bool, "done": int, "total": int}`）——Task 8 的 API 端點、
  Task 9 的 CLI 腳本都呼叫這個函式，不重複實作掃描/評分邏輯

- [ ] **Step 1: 在 `STATE` 加一個欄位**

`preview_ui.py:514-535`，把：

```python
STATE = {
    "workflow_path": None,
    "template": None,
    "comfy_base": None,
    "steps": 25,
    "checkpoint": None,   # 生圖模式的底模覆寫；None＝不覆寫，見 DARKROOM_CHECKPOINT_ROOT 說明
    "timeout": 600,
    "jobs": {},                     # rel(str) -> {status, message, updated}
    "jobs_lock": threading.Lock(),
    "concurrency": 2,               # 一次最多同時跑幾張
    "gen_sem": PrioritySemaphore(2),  # 全域併發上限(單張+批次共用，見 PrioritySemaphore)
    "batch": {                      # 批次狀態
        "running": False,
        "stop": False,
        "total": 0,
        "done": 0,
        "ok": 0,
        "fail": 0,
        "running_rels": [],         # 目前正在跑的項目(可能同時多個)
    },
    "batch_lock": threading.Lock(),
}
```

改成（只加最後三行）：

```python
STATE = {
    "workflow_path": None,
    "template": None,
    "comfy_base": None,
    "steps": 25,
    "checkpoint": None,   # 生圖模式的底模覆寫；None＝不覆寫，見 DARKROOM_CHECKPOINT_ROOT 說明
    "timeout": 600,
    "jobs": {},                     # rel(str) -> {status, message, updated}
    "jobs_lock": threading.Lock(),
    "concurrency": 2,               # 一次最多同時跑幾張
    "gen_sem": PrioritySemaphore(2),  # 全域併發上限(單張+批次共用，見 PrioritySemaphore)
    "batch": {                      # 批次狀態
        "running": False,
        "stop": False,
        "total": 0,
        "done": 0,
        "ok": 0,
        "fail": 0,
        "running_rels": [],         # 目前正在跑的項目(可能同時多個)
    },
    "batch_lock": threading.Lock(),
    "score_backfill": {"running": False, "done": 0, "total": 0},
    "score_backfill_lock": threading.Lock(),
}
```

- [ ] **Step 2: 在 Task 6 修改的 `scan_libraries()` 之後插入 `run_score_backfill()`**

```python
def run_score_backfill(progress_cb=None):
    """掃 has_image=True 但側檔沒分數的卡片跑評分；has_image=False 但側檔仍有
    孤兒分數紀錄的一併清掉（見設計文件「分數跟圖片存在性綁定」）。同步函式，
    給 /api/score-backfill 的背景 thread 跟 backfill_scores.py 共用，不重複實作
    掃描/評分邏輯。progress_cb(done, total) 是可選的外部回呼，CLI 腳本用來印
    進度到 stdout。"""
    items = scan_libraries()
    scores = score_map()
    by_rel = {it["rel"]: it for it in items}
    orphans = [rel for rel in scores if not by_rel.get(rel, {}).get("has_image")]
    for rel in orphans:
        clear_score(rel)

    todo = [it for it in items if it.get("has_image") and it["rel"] not in scores]
    total = len(todo)
    with STATE["score_backfill_lock"]:
        STATE["score_backfill"] = {"running": True, "done": 0, "total": total}
    plog(f"[score-backfill] 開始 · 待評分 {total} 筆 · 清掉 {len(orphans)} 筆孤兒紀錄")

    done = 0
    try:
        for it in todo:
            rel = it["rel"]
            try:
                py = py_of(rel)
                img = find_image(py)
                if img is None:
                    continue
                img_bytes = img.read_bytes()
                with _score_sem:
                    result = _score_image_bytes(img_bytes)
                if result:
                    result["at"] = time.time()
                    set_score(rel, result)
            except Exception as e:
                plog(f"[score-backfill] {rel} 失敗：{type(e).__name__}: {e}")
            done += 1
            with STATE["score_backfill_lock"]:
                STATE["score_backfill"]["done"] = done
            if progress_cb:
                progress_cb(done, total)
    finally:
        with STATE["score_backfill_lock"]:
            STATE["score_backfill"]["running"] = False
    plog(f"[score-backfill] 完成 · {done}/{total}")
```

- [ ] **Step 3: 手動驗證**

先手動塞一筆孤兒紀錄（假裝有張圖被刪了但側檔還留著），確認補分會清掉它，同時
補上真正缺分數的卡片：

```bash
cd "C:/projects/flux2klein/darkroom" && python -c "
import preview_ui as pu
pu.apply_special_dir(r'C:\projects\special_prompts')
pu.set_score('這個rel真的不存在的路徑.py', {'final': 1.0, 'at': 0})
before = pu.score_map()
print('補分前孤兒紀錄還在:', '這個rel真的不存在的路徑.py' in before)
def cb(done, total): print(f'\r{done}/{total}', end='', flush=True)
pu.run_score_backfill(progress_cb=cb)
print()
after = pu.score_map()
print('補分後孤兒紀錄清掉了:', '這個rel真的不存在的路徑.py' not in after)
"
```

Expected: 第一行 `True`（清之前確認塞進去了），最後一行 `True`（跑完
`run_score_backfill` 後那筆孤兒紀錄被清掉了），中間印出進度 `N/total` 遞增。

- [ ] **Step 4: Commit**

```bash
cd "C:/projects/flux2klein"
git add darkroom/preview_ui.py
git commit -m "$(cat <<'EOF'
新增：補分核心邏輯 run_score_backfill()，順便清孤兒分數紀錄

掃 has_image=True 缺分數的卡片跑評分，has_image=False 但側檔仍有紀錄的
（圖被刪了）一併清掉。之後的 API 端點跟 CLI 腳本都呼叫同一份，不重複
實作掃描/評分邏輯。
EOF
)"
```

---

### Task 8: darkroom — `POST /api/score-backfill` + `GET /api/score-backfill-status`

**Files:**
- Modify: `preview_ui.py`（`do_POST` 的 dispatch 區塊、`do_GET` 的 dispatch 區塊）

**Interfaces:**
- Consumes: `run_score_backfill()`、`_score_service_available()`（Task 3/7 產出）
- Produces: `POST /api/score-backfill` → `{"ok": true, "started": true}` /
  `{"ok": true, "already_running": true}` / `{"error": "..."}`（400）；
  `GET /api/score-backfill-status` → `STATE["score_backfill"]` 的內容

- [ ] **Step 1: 在 `do_POST` 加 `/api/score-backfill`**

找到 `preview_ui.py` 裡 `do_POST` 方法中 `/api/rarity` 端點的區塊（在
`/api/steps` 之前，約在 `1762-1782` 之間），在它前面插入：

```python
            if u.path == "/api/score-backfill":
                with STATE["score_backfill_lock"]:
                    if STATE["score_backfill"]["running"]:
                        self._send_json({"ok": True, "already_running": True})
                        return
                if not _score_service_available():
                    self._send_json({"error": "waifu-score 服務未啟動，請先執行 run.bat"}, 400)
                    return
                threading.Thread(target=run_score_backfill, daemon=True).start()
                plog("[score-backfill] 已由前端觸發")
                self._send_json({"ok": True, "started": True})
                return
```

（實際插入位置只要在 `do_POST` 方法裡、`if u.path == ...` 的其中一個判斷式旁邊
都可以，順序不影響行為——照抄現有其他端點緊挨著寫的風格即可。）

- [ ] **Step 2: 在 `do_GET` 加 `/api/score-backfill-status`**

找到 `do_GET` 方法裡 `/api/lora-push` 的 GET 區塊（`preview_ui.py:1695-1704`
附近），在它前面插入：

```python
            if u.path == "/api/score-backfill-status":
                with STATE["score_backfill_lock"]:
                    self._send_json(dict(STATE["score_backfill"]))
                return
```

- [ ] **Step 3: 手動驗證**

啟動暗房（`python preview_ui.py`），waifu-score 服務保持開著：

```bash
curl -s -X POST http://localhost:7860/api/score-backfill
curl -s http://localhost:7860/api/score-backfill-status
```

Expected: 第一個回 `{"ok": true, "started": true}`（除非全部卡片都已評分過，
`total` 是 0 也算正常啟動）；第二個回 `{"running": true/false, "done": N, "total": M}`，
`done` 應該隨時間遞增直到等於 `total`。

再驗證重複觸發不會啟動第二輪：補分還在跑的時候再打一次
`POST /api/score-backfill`，Expected 回 `{"ok": true, "already_running": true}`。

再驗證服務沒開時的行為：停掉 waifu-score 服務，打
`POST /api/score-backfill`，Expected 回 400，`{"error": "waifu-score 服務未啟動..."}`。

- [ ] **Step 4: Commit**

```bash
cd "C:/projects/flux2klein"
git add darkroom/preview_ui.py
git commit -m "$(cat <<'EOF'
新增：POST /api/score-backfill、GET /api/score-backfill-status

給前端「評分」按鈕用。啟動前先健康檢查 waifu-score 服務，連不上直接
回錯誤（不是靜默）——這是使用者主動觸發的操作，失敗要讓使用者知道。
已經在跑的話不會啟動第二輪重複補分。
EOF
)"
```

---

### Task 9: darkroom — 獨立補分 CLI 腳本

**Files:**
- Create: `C:\projects\flux2klein\darkroom\backfill_scores.py`

**Interfaces:**
- Consumes: `preview_ui.run_score_backfill()`、`preview_ui.load_config()`、
  `preview_ui.apply_special_dir()`、`preview_ui._score_service_available()`
  （全部透過 `import preview_ui as pu` 使用）

- [ ] **Step 1: 建立檔案**

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
backfill_scores.py
===================
獨立補分工具：把已經有圖但還沒評分的卡片跑一次 waifu-score 評分，寫進跟
preview_ui.py 相同的側檔（.darkroom_meta/scores.<tag>.json）。跟前端「評分」
按鈕（POST /api/score-backfill）共用同一個 run_score_backfill()，差別只在
觸發方式跟進度輸出目的地——見 docs/superpowers/specs/
2026-08-14-darkroom-model-scoring-design.md。

用法：
    python backfill_scores.py
    python backfill_scores.py --special-dir "C:\\projects\\special_prompts"

前提：waifu-score 服務要先啟動（它的 run.bat），本腳本不會自動幫你開。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview_ui as pu


def main():
    ap = argparse.ArgumentParser(description="暗房卡片補分（waifu-score 三模型加權評分）")
    ap.add_argument("--special-dir", default=None,
                    help="詞庫資料夾（不給就用 preview_config.json 的 special_dir）")
    args = ap.parse_args()

    # 比照 preview_ui.main() 的初始化順序：先套 special_dir，才能正確算出
    # dataset 分檔用的雜湊（_dataset_tag），不然會讀到別的 dataset 的側檔。
    cfg = pu.load_config()
    special_dir = args.special_dir or cfg.get("special_dir")
    if special_dir:
        pu.apply_special_dir(special_dir)
    if not pu.SPECIAL_DIR.is_dir():
        print(f"[錯誤] 找不到詞庫資料夾：{pu.SPECIAL_DIR}")
        sys.exit(1)
    print(f"[special] {pu.SPECIAL_DIR}")

    if not pu._score_service_available():
        print("[錯誤] 連不上 waifu-score 服務（http://localhost:8000）。請先執行它的 run.bat。")
        sys.exit(1)

    def progress(done, total):
        print(f"\r已評分 {done}/{total}", end="", flush=True)

    pu.run_score_backfill(progress_cb=progress)
    print()   # 收掉上面 \r 覆寫的那一行，讓後面的輸出換到新行


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 語法檢查 + 手動驗證**

```bash
cd "C:/projects/flux2klein/darkroom" && python -m py_compile backfill_scores.py
```

Expected: 無輸出（編譯成功）。

實際跑一次（waifu-score 服務開著）：

```bash
cd "C:/projects/flux2klein/darkroom" && python backfill_scores.py
```

Expected: 印出 `[special] ...` 路徑，接著 `已評分 N/M` 持續更新直到完成。中途按
`Ctrl+C` 中斷，重跑一次應該從中斷處剩下的部分繼續（不會重評已經有分數的卡片，
因為 `run_score_backfill()` 每算完一筆就立刻 `set_score()` 落地）。

再驗證服務沒開時的行為：停掉 waifu-score 服務，重跑腳本。Expected: 印出
`[錯誤] 連不上 waifu-score 服務...`，`exit code` 非 0，不會卡住或印出一堆
評分失敗的 log 洗版。

- [ ] **Step 3: Commit**

```bash
cd "C:/projects/flux2klein"
git add darkroom/backfill_scores.py
git commit -m "$(cat <<'EOF'
新增：darkroom/backfill_scores.py 獨立補分 CLI

給大批量、離峰時間手動跑的情境用。直接 import preview_ui 共用
run_score_backfill()，掃描/評分/側檔寫入邏輯跟前端「評分」按鈕完全一致，
只差觸發方式跟進度輸出目的地。
EOF
)"
```

---

### Task 10: darkroom 前端 — 縮圖分數徽章

**Files:**
- Modify: `darkroom.js:509-525`（`thumbInnerHTML`）、`darkroom.css`（新增 `.score-badge` 規則）

**Interfaces:**
- Consumes: `it.score`（`scan_libraries()` 疊加的欄位，Task 6 產出，透過
  `/api/libs` 傳到前端）
- Produces: `scoreBadgeHTML(score) -> string`——Task 11 的 tooltip 也會用到
  同一個徽章元素當 hover/click 的 anchor

- [ ] **Step 1: 在 `darkroom.js` 加 `scoreBadgeHTML()`，並接進 `thumbInnerHTML()`**

`darkroom.js:497-498`（`rarTag` 定義之後）插入：

```js
const scoreBadgeHTML = (score) => (score && typeof score.final === 'number')
  ? `<span class="score-badge" tabindex="0" role="button" aria-label="評分明細：${score.final.toFixed(1)} 分">${score.final.toFixed(1)}</span>`
  : '';
```

`darkroom.js:518-524`，把：

```js
  return `${media}` +
    (it.rarity === 'legendary' ? sparklesHTML() : '') +
    rarTag(it.rarity) +
    `<button class="fav-btn" type="button" aria-label="收藏" aria-pressed="${it.favorited ? 'true' : 'false'}">${ICON_STAR}</button>` +
    `<span class="pick-box" aria-hidden="true"></span>` +
    `<span class="flag-x" aria-hidden="true">✕</span>` +
    `<button class="gen-btn">${it.has_image ? '重新生成' : '生成'}</button>`;
```

改成：

```js
  return `${media}` +
    (it.rarity === 'legendary' ? sparklesHTML() : '') +
    rarTag(it.rarity) +
    scoreBadgeHTML(it.score) +
    `<button class="fav-btn" type="button" aria-label="收藏" aria-pressed="${it.favorited ? 'true' : 'false'}">${ICON_STAR}</button>` +
    `<span class="pick-box" aria-hidden="true"></span>` +
    `<span class="flag-x" aria-hidden="true">✕</span>` +
    `<button class="gen-btn">${it.has_image ? '重新生成' : '生成'}</button>`;
```

- [ ] **Step 2: 在 `darkroom.css` 加樣式**

在 `.rar-tag` 相關規則附近（`darkroom.css:1272-1280` 之後）加：

```css
/* 分數徽章：加權總分，圓角小標籤貼縮圖左下角（右上是 fav-btn/pick-box、左上是
   rar-tag，左下是唯一空著的角落）。膠囊形狀要明確標 corner-shape: round——squircle
   全域規則會讓它變兩端削平的橢圓，見檔案開頭 corner-shape 一節的例外說明。 */
.score-badge { position: absolute; z-index: 3; bottom: 8px; left: 8px;
  font-size: 10px; font-weight: 800; letter-spacing: .02em;
  padding: 2px 7px; border-radius: 999px; corner-shape: round;
  background: rgba(18,19,28,.82); color: var(--amber); cursor: default; }
```

- [ ] **Step 3: 語法檢查**

```bash
cd "C:/projects/flux2klein/darkroom" && node --check darkroom.js
```

Expected: 無輸出（語法正確）。

- [ ] **Step 4: 瀏覽器手動驗證**

啟動暗房，開瀏覽器連 `http://localhost:7860/`。找一張前面 task 已經評過分的
卡片（Task 4/7 驗證時生成/補分過的那些），確認縮圖左下角出現分數徽章（例如
`7.3`）；沒有分數的卡片（包含 `has_image=False` 的）確認不顯示徽章、不佔位。

- [ ] **Step 5: Commit**

```bash
cd "C:/projects/flux2klein"
git add darkroom/darkroom.js darkroom/darkroom.css
git commit -m "$(cat <<'EOF'
新增：暗房縮圖左下角分數徽章

it.score 來自 scan_libraries() 疊加（見前幾個 commit），沒有分數就不
顯示徽章、不佔位，跟稀有度標籤同一套「沒有就不畫」邏輯。
EOF
)"
```

---

### Task 11: darkroom 前端 — 分數明細 hover/click tooltip

**Files:**
- Modify: `darkroom.js`（`wireThumb`、新增 tooltip 相關函式）、`darkroom.css`（新增 `.score-tip` 規則）

**Interfaces:**
- Consumes: `it.score`（同 Task 10）
- Produces: `showScoreTip(anchor, score)`、`hideScoreTip()`——純顯示用，內部不含
  按鈕，不會踩到 CLAUDE.md 記錄過的「hover 泡泡裡按鈕點擊不觸發 mouseleave」那
  個坑

- [ ] **Step 1: 在 `darkroom.js` 加 tooltip 相關函式**

放在 `scoreBadgeHTML` 定義之後（Task 10 加的那一行之後）：

```js
function scoreDetailHTML(score) {
  return `<div class="score-tip-row"><b>加權總分</b><b>${score.final.toFixed(2)}</b></div>
    <div class="score-tip-row"><span>Blackroot</span><span>${score.blackroot.toFixed(2)}</span></div>
    <div class="score-tip-row"><span>Waifu Scorer</span><span>${score.waifu.toFixed(2)}</span></div>
    <div class="score-tip-row"><span>Kawai</span><span>${score.kawai_tier} · ${score.kawai_score.toFixed(2)}</span></div>`;
}
let SCORE_TIP_EL = null;
function ensureScoreTip() {
  if (SCORE_TIP_EL) return SCORE_TIP_EL;
  SCORE_TIP_EL = document.createElement('div');
  SCORE_TIP_EL.className = 'score-tip';
  document.body.appendChild(SCORE_TIP_EL);
  return SCORE_TIP_EL;
}
function showScoreTip(anchor, score) {
  if (!score) return;
  const tip = ensureScoreTip();
  tip.innerHTML = scoreDetailHTML(score);
  const r = anchor.getBoundingClientRect();
  const w = 180;
  let left = r.left;
  if (left + w > window.innerWidth) left = window.innerWidth - w - 8;
  tip.style.left = Math.max(8, left) + 'px';
  tip.style.top = (r.bottom + 8) + 'px';
  tip.classList.add('show');
}
function hideScoreTip() {
  if (SCORE_TIP_EL) SCORE_TIP_EL.classList.remove('show');
}
```

- [ ] **Step 2: 在 `wireThumb()` 綁定分數徽章的事件**

`darkroom.js:527-536`，把：

```js
function wireThumb(thumb, it) {
  // 點縮圖：打標模式＝選取；瀏覽的篩選模式＝標記紅叉；瀏覽平常＝開大圖。
  thumb.onclick = () => {
    if (MODE === 'tag' || MODE === 'gen') toggleSel(it.rel, thumb.closest('.card'));
    else if (SELECTING) toggleFlag(it.rel);
    else openModalFromThumb(it.rel, thumb.querySelector('img'));
  };
  thumb.querySelector('.gen-btn').onclick = (e) => { e.stopPropagation(); generate(it.rel); };
  thumb.querySelector('.fav-btn').onclick = (e) => { e.stopPropagation(); toggleFav(it.rel); };
}
```

改成：

```js
function wireThumb(thumb, it) {
  // 點縮圖：打標模式＝選取；瀏覽的篩選模式＝標記紅叉；瀏覽平常＝開大圖。
  thumb.onclick = () => {
    if (MODE === 'tag' || MODE === 'gen') toggleSel(it.rel, thumb.closest('.card'));
    else if (SELECTING) toggleFlag(it.rel);
    else openModalFromThumb(it.rel, thumb.querySelector('img'));
  };
  thumb.querySelector('.gen-btn').onclick = (e) => { e.stopPropagation(); generate(it.rel); };
  thumb.querySelector('.fav-btn').onclick = (e) => { e.stopPropagation(); toggleFav(it.rel); };
  const badge = thumb.querySelector('.score-badge');
  if (badge) {
    badge.addEventListener('mouseenter', () => showScoreTip(badge, it.score));
    badge.addEventListener('mouseleave', hideScoreTip);
    badge.addEventListener('click', (e) => { e.stopPropagation(); showScoreTip(badge, it.score); });
    badge.addEventListener('focus', () => showScoreTip(badge, it.score));
    badge.addEventListener('blur', hideScoreTip);
  }
}
```

- [ ] **Step 3: 在 `darkroom.css` 加樣式**

在 `.lora-preview-tip` 相關規則附近（`darkroom.css:1149-1160`）加：

```css
.score-tip { position: fixed; z-index: 200; pointer-events: none; opacity: 0;
  transition: opacity var(--d-ui) var(--ease-out);
  background: rgba(18,19,28,.94); border: 1px solid rgba(255,255,255,.08);
  border-radius: 10px; padding: 8px 10px; font-size: 12px; min-width: 160px; }
.score-tip.show { opacity: 1; }
.score-tip-row { display: flex; justify-content: space-between; gap: 14px; padding: 2px 0; }
.score-tip-row b:first-child { color: var(--txt-2, inherit); font-weight: 600; }
.score-tip-row b:last-child { color: var(--amber); }
@media (prefers-reduced-motion: reduce) { .score-tip { transition: none; } }
```

- [ ] **Step 4: 語法檢查 + 瀏覽器手動驗證**

```bash
cd "C:/projects/flux2klein/darkroom" && node --check darkroom.js
```

Expected: 無輸出。瀏覽器裡對有分數的卡片的分數徽章 hover，確認彈出明細（總分
+ 三項原始分數）；滑鼠移開收起；用 Tab 鍵聚焦到徽章也要能看到明細（`focus`/
`blur` 事件）。

- [ ] **Step 5: Commit**

```bash
cd "C:/projects/flux2klein"
git add darkroom/darkroom.js darkroom/darkroom.css
git commit -m "$(cat <<'EOF'
新增：分數徽章 hover/click 顯示三項原始分數明細

沿用既有 hover 泡泡機制的視覺語言，但這顆 tooltip 內部不含按鈕（純
顯示），不會踩到 hover 泡泡裡按鈕點擊不觸發 mouseleave 那個坑。
EOF
)"
```

---

### Task 12: darkroom 前端 — 「評分」按鈕（觸發補分）

**Files:**
- Modify: `index.html`（topbar 加按鈕）、`darkroom.js`（新增輪詢邏輯）

**Interfaces:**
- Consumes: `POST /api/score-backfill`、`GET /api/score-backfill-status`（Task 8）、
  `toast()`（既有）、`loadAll()`（既有，`darkroom.js:67`）

- [ ] **Step 1: 在 `index.html` 加按鈕**

`index.html:85`（`#rescan` 按鈕旁邊），把：

```html
  <button class="ghost" id="rescan" title="重新掃描">↻ 重掃</button>
```

改成：

```html
  <button class="ghost" id="rescan" title="重新掃描">↻ 重掃</button>
  <button class="ghost" id="score-backfill-btn" title="幫已有圖但還沒評分的卡片跑 waifu-score 評分">☆ 評分</button>
```

- [ ] **Step 2: 在 `darkroom.js` 加輪詢邏輯**

放在 `$('rescan').onclick = () => loadAll(true);`（`darkroom.js:1064`）附近，
新增：

```js
async function startScoreBackfill() {
  const btn = $('score-backfill-btn');
  btn.disabled = true; btn.textContent = '評分中…';
  try {
    const r = await fetch('/api/score-backfill', { method: 'POST' });
    const j = await r.json();
    if (j.error) { toast(j.error, true); btn.disabled = false; btn.textContent = '☆ 評分'; return; }
    pollScoreBackfill();
  } catch (e) {
    toast('評分請求失敗：' + e, true);
    btn.disabled = false; btn.textContent = '☆ 評分';
  }
}
async function pollScoreBackfill() {
  const btn = $('score-backfill-btn');
  try {
    while (true) {
      const st = await fetch('/api/score-backfill-status').then(r => r.json());
      if (!st.running) break;
      btn.textContent = st.total ? `評分中 ${st.done}/${st.total}` : '評分中…';
      await sleep(1000);
    }
  } finally {
    btn.disabled = false; btn.textContent = '☆ 評分';
    await loadAll(true);   // 補分完重新整理，新分數與清掉的孤兒紀錄才會反映在畫面上
  }
}
$('score-backfill-btn').onclick = startScoreBackfill;
```

- [ ] **Step 3: 語法檢查**

```bash
cd "C:/projects/flux2klein/darkroom" && node --check darkroom.js
```

Expected: 無輸出。

- [ ] **Step 4: 瀏覽器手動驗證**

waifu-score 服務開著，重整暗房頁面，點「☆ 評分」按鈕。Expected: 按鈕變成
disable、文字顯示「評分中 N/M」並持續更新；跑完自動恢復成「☆ 評分」可點擊，
畫面上原本沒分數的卡片（如果有的話）出現分數徽章。

再驗證服務沒開時的行為：停掉 waifu-score 服務，點「☆ 評分」按鈕。Expected:
按鈕短暫 disable 後立刻恢復、跳出明顯的 toast 提示（紅色/錯誤樣式），不會卡
在「評分中」狀態，也不會啟動背景任務。

再驗證重複點擊：補分跑到一半時再點一次按鈕（此時按鈕應該已經是 disabled，
但用開發工具手動再打一次 API 驗證後端行為）：

```bash
curl -s -X POST http://localhost:7860/api/score-backfill
```

Expected: 回 `{"ok": true, "already_running": true}`，不會啟動第二輪。

- [ ] **Step 5: Commit**

```bash
cd "C:/projects/flux2klein"
git add darkroom/index.html darkroom/darkroom.js
git commit -m "$(cat <<'EOF'
新增：topbar「評分」按鈕，觸發背景補分並顯示進度

服務沒開時立刻跳出明顯提示（跟平常生成後的自動評分靜默失敗不同——這是
使用者主動觸發的操作，失敗要讓使用者知道）。跑完自動重新整理卡片分數。
EOF
)"
```

---

### Task 13: darkroom 前端 — 抽卡/生圖模式結果顯示暫時分數

**Files:**
- Modify: `darkroom.js`（`applyGenState`、`_genTick`）

**Interfaces:**
- Consumes: `/api/gen-status` 回應多出來的 `score` 欄位（Task 5 產出）、
  `scoreBadgeHTML()`（Task 10 產出）

- [ ] **Step 1: 修改 `applyGenState()` 顯示分數徽章**

`darkroom.js:3511-3535`，把：

```js
function applyGenState(gid, s) {
  const g = GALLERY.find(x => x.id === gid);
  if (g) {
    if (s.status === 'done') { g.done = true; g.seed = s.seed; }
    else if (s.status === 'error' || s.status === 'cancelled') { g.err = true; }
  }
  const cards = document.querySelectorAll(`[data-gid="${cssAttr(gid)}"]`);
  cards.forEach(card => {
    const img = card.querySelector('img');
    if (s.status === 'done') {
      const wasPending = card.classList.contains('pending');
      card.classList.remove('pending');
      if (img) img.src = '/api/gen-result?id=' + gid;
      if (wasPending) triggerFinishFlourish(card);   // 「收成」瞬間：只在真的從生成中轉為完成時播
    } else if (s.status === 'error' || s.status === 'cancelled') {
      card.classList.remove('pending'); card.classList.add('gr-err');
      const nm = card.querySelector('.gc-name, .gr-name, .tarot-name');
      if (nm && !nm.dataset.tag) { nm.dataset.tag = '1'; nm.textContent += s.status === 'cancelled' ? ' · 已取消' : (' ✕ ' + (s.err || '失敗')); }
    } else if (img && (s.pv || 0) > (+card.dataset.pv || 0)) {
      // 有新的採樣預覽才換 src（pv 遞增），避免每 2s 無謂重載
      card.dataset.pv = s.pv;
      img.src = '/api/gen-preview?id=' + gid + '&v=' + s.pv;
    }
  });
}
```

改成：

```js
function applyGenState(gid, s) {
  const g = GALLERY.find(x => x.id === gid);
  if (g) {
    if (s.status === 'done') { g.done = true; g.seed = s.seed; if (s.score) g.score = s.score; }
    else if (s.status === 'error' || s.status === 'cancelled') { g.err = true; }
  }
  const cards = document.querySelectorAll(`[data-gid="${cssAttr(gid)}"]`);
  cards.forEach(card => {
    const img = card.querySelector('img');
    if (s.status === 'done') {
      const wasPending = card.classList.contains('pending');
      card.classList.remove('pending');
      if (img) img.src = '/api/gen-result?id=' + gid;
      if (wasPending) triggerFinishFlourish(card);   // 「收成」瞬間：只在真的從生成中轉為完成時播
      if (s.score && !card.querySelector('.score-badge')) {
        const front = card.querySelector('.gen-front, .tarot-front, .gc-square');
        if (front) front.insertAdjacentHTML('beforeend', scoreBadgeHTML(s.score));
      }
    } else if (s.status === 'error' || s.status === 'cancelled') {
      card.classList.remove('pending'); card.classList.add('gr-err');
      const nm = card.querySelector('.gc-name, .gr-name, .tarot-name');
      if (nm && !nm.dataset.tag) { nm.dataset.tag = '1'; nm.textContent += s.status === 'cancelled' ? ' · 已取消' : (' ✕ ' + (s.err || '失敗')); }
    } else if (img && (s.pv || 0) > (+card.dataset.pv || 0)) {
      // 有新的採樣預覽才換 src（pv 遞增），避免每 2s 無謂重載
      card.dataset.pv = s.pv;
      img.src = '/api/gen-preview?id=' + gid + '&v=' + s.pv;
    }
  });
}
```

- [ ] **Step 2: 延長輪詢，讓評分結果有機會追上**

評分是生成完成之後才另外起的背景 thread，`status` 變成 `done` 的那一瞬間分數
通常還沒算完；但既有的 `_genTick()` 一看到 `done` 就把 `gid` 從 `GEN_PENDING`
移除、停止輪詢那個 gid，分數永遠追不上。改成 `done` 後最多再多等幾輪：

`darkroom.js:3540-3560`，把：

```js
const GEN_POLL_MS = 500;
function updateCancelAllBtn() {
  const btn = $('gallery-cancel-all'); if (btn) btn.disabled = !GEN_PENDING.size;
}
async function _genTick() {
  if (!GEN_PENDING.size) { _genPoll = null; updateCancelAllBtn(); return; }
  try {
    const st = await fetch('/api/gen-status?ids=' + [...GEN_PENDING].join(',')).then(r => r.json());
    for (const gid of [...GEN_PENDING]) {
      const s = st[gid]; if (!s) continue;
      applyGenState(gid, s);
      if (s.status === 'done' || s.status === 'error' || s.status === 'cancelled') GEN_PENDING.delete(gid);
    }
  } catch (e) { /* 暫時抓失敗就等下一輪 */ }
  updateCancelAllBtn();
  _genPoll = GEN_PENDING.size ? setTimeout(_genTick, GEN_POLL_MS) : null;
}
function startGenPoll(ids) {
  ids.forEach(id => GEN_PENDING.add(id));
  if (!_genPoll) _genPoll = setTimeout(_genTick, 0);   // 自排程單一輪詢；已在跑就沿用
}
```

改成：

```js
const GEN_POLL_MS = 500;
// 評分是生成完成後另起的背景任務，status 變 done 的當下分數通常還沒算完；
// 多等幾輪（~5s）讓它有機會追上，等不到就放棄——不影響圖片本身已經顯示完成。
const GEN_SCORE_WAIT_MAX = 10;
const _genScoreWaits = new Map();   // gid -> 已經多等了幾輪
function updateCancelAllBtn() {
  const btn = $('gallery-cancel-all'); if (btn) btn.disabled = !GEN_PENDING.size;
}
async function _genTick() {
  if (!GEN_PENDING.size) { _genPoll = null; updateCancelAllBtn(); return; }
  try {
    const st = await fetch('/api/gen-status?ids=' + [...GEN_PENDING].join(',')).then(r => r.json());
    for (const gid of [...GEN_PENDING]) {
      const s = st[gid]; if (!s) continue;
      applyGenState(gid, s);
      if (s.status === 'error' || s.status === 'cancelled') {
        GEN_PENDING.delete(gid); _genScoreWaits.delete(gid);
        continue;
      }
      if (s.status === 'done') {
        if (s.score) { GEN_PENDING.delete(gid); _genScoreWaits.delete(gid); continue; }
        const waits = (_genScoreWaits.get(gid) || 0) + 1;
        if (waits >= GEN_SCORE_WAIT_MAX) { GEN_PENDING.delete(gid); _genScoreWaits.delete(gid); }
        else _genScoreWaits.set(gid, waits);
      }
    }
  } catch (e) { /* 暫時抓失敗就等下一輪 */ }
  updateCancelAllBtn();
  _genPoll = GEN_PENDING.size ? setTimeout(_genTick, GEN_POLL_MS) : null;
}
function startGenPoll(ids) {
  ids.forEach(id => GEN_PENDING.add(id));
  if (!_genPoll) _genPoll = setTimeout(_genTick, 0);   // 自排程單一輪詢；已在跑就沿用
}
```

- [ ] **Step 3: 語法檢查 + 瀏覽器手動驗證**

```bash
cd "C:/projects/flux2klein/darkroom" && node --check darkroom.js
```

Expected: 無輸出。瀏覽器裡切「生圖」模式，套 LoRA 生成一張，確認結果卡片完成
後幾秒內出現分數徽章（同一個 `.score-badge` 樣式）；`Concepts` 抽卡（塔羅牌面）
也走同一條路徑，一併確認。

- [ ] **Step 4: Commit**

```bash
cd "C:/projects/flux2klein"
git add darkroom/darkroom.js
git commit -m "$(cat <<'EOF'
新增：抽卡/生圖模式結果卡片顯示暫時分數徽章

評分是生成完成後才起的背景任務，status=done 當下分數通常還沒算完，輪詢
額外多等最多 ~5s 讓分數有機會追上，超時就放棄（不影響圖片本身已完成）。
EOF
)"
```

---

### Task 14: 文件更新（README.md + 進度.md）

**Files:**
- Modify: `README.md`（詞庫暗房章節）、`進度.md`（變更紀錄最上方）

**Interfaces:** 無（純文件）

- [ ] **Step 1: 在 `README.md` 詞庫暗房章節加一小節說明評分功能**

在 `README.md` 「詞庫暗房」章節裡、適合的位置（例如「稀有度分布條」說明附近，
`README.md:191` 之後）插入一段：

```markdown
- **卡片評分**：每張卡片跑三個 waifu-score 模型（Blackroot／Waifu Scorer／Kawai）算出加權總分（`Blackroot×0.50 + Waifu×0.20 + Kawai×0.30`，正規化到 0~10），顯示在縮圖左下角小徽章，hover/點擊看三項原始分數明細。**需要另外啟動 waifu-score 服務**（`C:\projects\waifu-score\run.bat`，預設 port 8000）——沒開的話卡片就是沒分數，不影響暗房其他功能。瀏覽模式生成/重新生成的分數會永久保存；抽卡／生圖模式產生的圖只是暫存結果，分數也只是暫時的，不會留到重整之後。topbar「☆ 評分」鈕可以幫已有圖但還沒評分的舊卡片一次補齊（也可以用 `darkroom/backfill_scores.py` 跑，適合大批量離峰時間執行）。
```

- [ ] **Step 2: 在 `進度.md` 最上方補一筆**

在 `進度.md` 的「變更紀錄」區段最上方（緊接在既有維護規則說明之後）加一筆，
`<commit hash>` 用 Task 13 最後那次 commit 的實際 hash：

```markdown
### 2026-08-14 HH:MM · <hash> 新增：暗房卡片模型評分功能

接上獨立專案 waifu-score 的三個評分模型（Blackroot／Waifu Scorer／Kawai），
算加權總分（0.50/0.20/0.30，Kawai 正規化到 0~10 才能相加）。瀏覽模式生成
的分數永久存進 `.darkroom_meta/scores.<tag>.json`（比照 flags/favorites/
rarities 的側檔 pattern），抽卡/生圖模式的分數只暫存記憶體、不落地。分數
跟圖片存在性綁定：`has_image=False` 一律不顯示分數，即使側檔裡還留著舊
紀錄（圖被刪了）——這個不變量只在 `scan_libraries()` 疊加時檢查一次，不用
到處掛刪除 hook。前端縮圖左下角有分數徽章、hover 看明細；topbar「☆ 評分」
鈕可以背景補分舊卡片（服務沒開會跳出明顯提示，跟平常生成後自動評分的
靜默失敗不同），也可以用 `darkroom/backfill_scores.py` CLI 跑。詳見
[設計文件](docs/superpowers/specs/2026-08-14-darkroom-model-scoring-design.md)。
```

- [ ] **Step 3: Commit**

```bash
cd "C:/projects/flux2klein"
git add README.md 進度.md
git commit -m "$(cat <<'EOF'
文件：補上暗房卡片評分功能的 README 說明與進度紀錄
EOF
)"
```

---

### Task 15: darkroom 前端 — 大圖 modal 顯示評分明細（含分段上色）

> 這個 task 是 Task 1-14 全部完成、通過審查之後，使用者追加的需求：點開大圖
> （瀏覽模式格線卡片的 `openModal()`，跟抽卡/生圖模式結果的 `openGalleryItem()`）
> 都要看得到各模型分數跟加權總分，加權總分要照分數區間上色（紅/黃/綠）。

**Files:**
- Modify: `darkroom.js`（`openModal()`、`openGalleryItem()`、新增共用 helper）、
  `darkroom.css`（新增分段上色規則）

**Interfaces:**
- Consumes: `item.score` / `g.score`（Task 10 起前端就在用的同一個分數物件形狀：
  `{blackroot, waifu, kawai_tier, kawai_score, kawai_norm, final, at}` 或 `null`）
- Produces: `scoreBand(final) -> 'low'|'mid'|'high'|''`、`modalScoreRowsHTML(score) -> string`
  （回傳一段 `<div class="gi-row">...</div>` 系列字串，openModal 跟
  openGalleryItem 共用同一個函式，不要各寫一份）

**分段門檻（使用者確認）**：`final < 5.5` → 紅（低分）；`5.5 <= final < 7.5` → 黃
（中等）；`final >= 7.5` → 綠（高分）。三個顏色直接沿用 `.rar-tag.legendary`
漸層已經在用的色碼（`#ff5f6d`／`#ffb347`／`#42f5a1`），不要另外發明新色，保持
跟稀有度視覺語言一致。

- [ ] **Step 1: 在 `darkroom.js` 加共用的分段判斷 + HTML 產生函式**

放在 Task 11 的 `scoreDetailHTML` 定義附近：

```js
function scoreBand(final) {
  if (typeof final !== 'number') return '';
  if (final >= 7.5) return 'high';
  if (final >= 5.5) return 'mid';
  return 'low';
}
// openModal()／openGalleryItem() 共用：大圖 modal 的評分明細列，跟格線 hover
// tooltip（scoreDetailHTML，Task 11）內容一樣，但用 .gi-row 這套既有的
// key-value 列樣式（openGalleryItem 的 LoRA/seed/時間資訊欄本來就是這樣排的），
// 加權總分那一列的數字額外套 scoreBand() 算出的顏色 class。
function modalScoreRowsHTML(score) {
  if (!score || typeof score.final !== 'number') {
    return `<div class="gi-row"><span class="gi-k">評分</span><span class="gi-v">尚未評分</span></div>`;
  }
  return `<div class="gi-row"><span class="gi-k">加權總分</span><span class="gi-v score-final ${scoreBand(score.final)}">${score.final.toFixed(2)}</span></div>
    <div class="gi-row"><span class="gi-k">Blackroot</span><span class="gi-v">${score.blackroot.toFixed(2)}</span></div>
    <div class="gi-row"><span class="gi-k">Waifu Scorer</span><span class="gi-v">${score.waifu.toFixed(2)}</span></div>
    <div class="gi-row"><span class="gi-k">Kawai</span><span class="gi-v">${score.kawai_tier} · ${score.kawai_score.toFixed(2)}</span></div>`;
}
```

- [ ] **Step 2: `openGalleryItem()` 加分數列到既有的 `gi-row` 資訊欄**

`darkroom.js` 的 `openGalleryItem()` 函式裡，找到這段（`rows` 陣列組完、
for 迴圈跑完 `right.appendChild(row)` 之後、`inner.append(left, right)` 之前）：

```js
  for (const [k, v] of rows) {
    const row = document.createElement('div'); row.className = 'gi-row';
    const kk = document.createElement('span'); kk.className = 'gi-k'; kk.textContent = k;
    const vv = document.createElement('span'); vv.className = 'gi-v'; vv.textContent = v;
    row.append(kk, vv); right.appendChild(row);
  }
  inner.append(left, right);
```

改成（迴圈本身不動，`inner.append` 前插入分數列）：

```js
  for (const [k, v] of rows) {
    const row = document.createElement('div'); row.className = 'gi-row';
    const kk = document.createElement('span'); kk.className = 'gi-k'; kk.textContent = k;
    const vv = document.createElement('span'); vv.className = 'gi-v'; vv.textContent = v;
    row.append(kk, vv); right.appendChild(row);
  }
  if (g) right.insertAdjacentHTML('beforeend', modalScoreRowsHTML(g.score));
  inner.append(left, right);
```

（`g` 可能是 `undefined`——`gi < 0`、清單裡找不到這筆的邊界情況，既有程式碼在
這種情況下 `rows` 本來就是空陣列，同樣邏輯：沒有 `g` 就不顯示評分區塊。）

- [ ] **Step 3: `openModal()` 加一個評分區塊**

`darkroom.js` 的 `openModal()` 函式裡，找到這段 `inner.innerHTML` 樣板
（`preview_ui.py` 無關，這是純前端字串樣板）：

```js
  inner.innerHTML = `
    <div>
      <div id="m-stage-slot"></div>
      <div id="modal-status" data-rel="${escapeAttr(rel)}" class="status" style="margin-top:10px;padding:0;"></div>
      <div style="margin-top:12px; display:flex; gap:8px;">
        <button class="primary" id="modal-gen">${item.has_image ? '重新生成' : '生成'}</button>
        <button id="modal-close">關閉 (Esc)</button>
      </div>
    </div>
    <div>
      <div class="m-title" id="modal-title"></div>
      <div class="m-folder" id="modal-folder"></div>
      <div class="prompt-label">正向 Prompt</div>
      <div class="prompt-block" id="pos">載入中…</div>
      <div class="prompt-label">負向 Prompt</div>
      <div class="prompt-block" id="neg">載入中…</div>
    </div>`;
```

改成（右欄 `<div class="m-folder">` 之後、Prompt 區塊之前插入一個
`#modal-score` 容器，並在後面用 `modalScoreRowsHTML()` 填內容）：

```js
  inner.innerHTML = `
    <div>
      <div id="m-stage-slot"></div>
      <div id="modal-status" data-rel="${escapeAttr(rel)}" class="status" style="margin-top:10px;padding:0;"></div>
      <div style="margin-top:12px; display:flex; gap:8px;">
        <button class="primary" id="modal-gen">${item.has_image ? '重新生成' : '生成'}</button>
        <button id="modal-close">關閉 (Esc)</button>
      </div>
    </div>
    <div>
      <div class="m-title" id="modal-title"></div>
      <div class="m-folder" id="modal-folder"></div>
      <div class="gi-score" id="modal-score"></div>
      <div class="prompt-label">正向 Prompt</div>
      <div class="prompt-block" id="pos">載入中…</div>
      <div class="prompt-label">負向 Prompt</div>
      <div class="prompt-block" id="neg">載入中…</div>
    </div>`;
```

然後在同一函式裡找到：

```js
  $('modal-folder').textContent = item.folder || '(根目錄)';
```

改成：

```js
  $('modal-folder').textContent = item.folder || '(根目錄)';
  $('modal-score').innerHTML = modalScoreRowsHTML(item.score);
```

- [ ] **Step 4: 在 `darkroom.css` 加分段上色規則**

放在 Task 10 新增的 `.score-badge` 規則附近：

```css
/* 大圖 modal 的評分明細列沿用 .gi-row/.gi-k/.gi-v（openGalleryItem 既有樣式，
   見該規則定義處），只有加權總分那個數字額外分段上色。三色直接借用
   .rar-tag.legendary 漸層已經在用的色碼，不重新發明一組顏色。 */
.gi-score { margin: 10px 0; }
.score-final.low  { color: #ff5f6d; font-weight: 700; }
.score-final.mid  { color: #ffb347; font-weight: 700; }
.score-final.high { color: #42f5a1; font-weight: 700; }
```

- [ ] **Step 5: 語法檢查**

```bash
cd "C:/projects/flux2klein/darkroom" && node --check darkroom.js
```

Expected: 無輸出。

- [ ] **Step 6: 瀏覽器手動驗證**

啟動/確認暗房伺服器在跑，開瀏覽器連 `http://localhost:7860/`。

1. 找一張已評分的卡片（`.darkroom_meta/scores.<tag>.json` 裡任一筆），點開大圖
   （`openModal`）。Expected：右欄「資料夾」下方出現評分區塊，「加權總分」數字
   依分數帶對應顏色（`>=7.5` 綠、`5.5~7.5` 黃、`<5.5` 紅），下面三行列出
   Blackroot／Waifu Scorer／Kawai 的原始分數。
2. 找一張沒有分數（`has_image=False` 或還沒評分過）的卡片，點開大圖。
   Expected：評分區塊顯示「評分：尚未評分」，不是空白或報錯。
3. 切「生圖」模式套 LoRA 生成一張、等分數跑完（前面 Task 13 的輪詢邏輯讓
   `GALLERY` 裡的項目在分數到齊前會多等幾輪），點開這張抽出來的圖（走
   `openGalleryItem`）。Expected：跟一般卡片一樣，右側資訊欄（LoRA／強度／
   seed／時間那個列表）最後面多出評分那幾列，加權總分一樣有顏色。

- [ ] **Step 7: Commit**

```bash
cd "C:/projects/flux2klein"
git add darkroom/darkroom.js darkroom/darkroom.css
git commit -m "$(cat <<'EOF'
新增：大圖 modal 顯示各模型評分明細，加權總分依區間上色

點開格線卡片（openModal）跟抽卡/生圖結果（openGalleryItem）的大圖都能
看到 Blackroot/Waifu Scorer/Kawai 三項原始分數，加權總分 >=7.5 綠、
5.5~7.5 黃、<5.5 紅，色碼借用既有傳奇稀有度漸層，不重新發明一組顏色。
EOF
)"
```

---

### Task 16: 文件更新（README.md + 進度.md，Task 15 追加需求）

**Files:**
- Modify: `README.md`（詞庫暗房章節，Task 14 加的那段評分說明後面）、`進度.md`

**Interfaces:** 無（純文件）

- [ ] **Step 1: 在 `README.md` 評分那段後面補一句**

在 Task 14 加的評分說明段落結尾（`...也可以用 darkroom/backfill_scores.py
跑，適合大批量離峰時間執行。` 之後）接著補一句：

```markdown
點開任一張卡片或抽卡結果的大圖，也能看到三個模型的原始分數，加權總分依
分數區間上色（≥7.5 綠、5.5~7.5 黃、<5.5 紅）。
```

- [ ] **Step 2: 在 `進度.md` 最上方補一筆**

`<hash>` 用 Task 15 的 commit hash：

```markdown
### 2026-08-14 HH:MM · <hash> 新增：大圖 modal 顯示評分明細，加權總分分段上色

Task 1-14（暗房卡片評分功能主體）做完之後追加的需求：點開大圖（格線卡片跟
抽卡/生圖結果）都要看到各模型分數，加權總分依區間上色。共用一個
`modalScoreRowsHTML()` 產生評分列，`openModal()` 跟 `openGalleryItem()`
都呼叫它，顏色借用既有傳奇稀有度漸層色碼（紅/黃/綠對應 <5.5/5.5~7.5/>=7.5）。
```

- [ ] **Step 3: Commit**

```bash
cd "C:/projects/flux2klein"
git add README.md 進度.md
git commit -m "$(cat <<'EOF'
文件：補上大圖 modal 評分明細功能的 README 說明與進度紀錄
EOF
)"
```

---

## Self-Review

**Spec coverage**：對照設計文件逐節檢查——

1. waifu-score 合併端點 → Task 1 ✓
2. 分數側檔儲存 + 覆蓋語意 → Task 2 ✓（`set_score` 直接覆蓋，不是累加）
3. HTTP helper + 併發 semaphore → Task 3 ✓
4. 瀏覽模式生成永久評分 → Task 4 ✓
5. 抽卡/生圖模式暫時評分（不落地）→ Task 5 ✓
6. 分數跟圖片存在性綁定 → Task 6 ✓
7. 補分核心邏輯 + 清孤兒紀錄 → Task 7 ✓
8. 補分按鈕 API + 服務未開時明確提示 → Task 8 ✓
9. 獨立 CLI 補分腳本（共用核心邏輯）→ Task 9 ✓
10. 前端分數徽章 → Task 10 ✓
11. 前端明細 tooltip → Task 11 ✓
12. 前端「評分」按鈕 + 進度顯示 → Task 12 ✓
13. 抽卡/生圖模式結果的暫時分數顯示 → Task 13（spec 提到但未展開技術細節，這裡
    補上輪詢延長的實作，避免規格提到卻做不到「顯示」的落差）
14. README/進度.md → Task 14（CLAUDE.md 的專案慣例，不在原始 spec 裡但是既有
    專案規範要求）

**Placeholder scan**：全文檢查過，沒有 TBD/TODO，每個程式碼步驟都有完整可貼上
執行的程式碼，驗證步驟都有具體指令與預期輸出。

**Type consistency**：`_score_image_bytes()` 回傳的 dict 欄位名（`blackroot`/
`waifu`/`kawai_tier`/`kawai_score`/`kawai_norm`/`final`）在 Task 1（waifu-score
端點定義）、Task 4/5（設進側檔/`_gen_status`）、Task 11（前端 `scoreDetailHTML`
讀取這些欄位）三處保持一致，沒有改名不一致的問題。`run_score_backfill(progress_cb=None)`
的簽名在 Task 7 定義、Task 8（背景 thread 呼叫，不傳 `progress_cb`）、Task 9
（CLI 傳 `progress_cb=progress`）三處呼叫方式一致。

---

Plan complete and saved to `docs/superpowers/plans/2026-08-14-darkroom-model-scoring.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
