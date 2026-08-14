# 暗房卡片模型評分設計

日期：2026-08-14 ／ 狀態：待使用者確認

## 背景

暗房的 28000+ 張詞庫卡片目前只有人工標的稀有度（`rarity`），沒有任何客觀的畫質/美感
分數。獨立專案 `C:\projects\waifu-score` 已經有三個訓練好的美感評分模型（Blackroot
Predictor、Waifu Scorer、Kawai Aesthetic Scorer），包成一個常駐 FastAPI 服務。這次
要把暗房的卡片接上這三個模型，算出加權總分並顯示在卡片上。

## 範圍

**要做**：
- waifu-score 新增一個合併評分端點（不改三個既有模型類別、不改既有三個端點）
- darkroom 生成成功後背景觸發評分，永久分數（瀏覽模式生成）存側檔、暫時分數（抽卡/
  生圖模式）只留在記憶體
- **分數跟圖片的存在性綁死**：圖片不在了，分數也不該留著
- 前端縮圖角落分數徽章 + hover/click 明細
- 前端一顆「評分」按鈕，點下去觸發背景補分（掃有圖但沒分數的卡片），有進度可看
- waifu-score 服務沒開時，這顆按鈕要有明顯的失敗提示（不是靜默）
- 一支獨立補分腳本（CLI 版本，給大批量離線補分用）

**不做**：
- 不改 waifu-score 三個模型類別本身的推論邏輯或權重
- 不做「單張卡片重新評分」的按鈕（只有整批補分這一種主動觸發）
- 不處理 waifu-score 服務的自動啟動/生命週期管理（使用者手動 `run.bat`）
- KLEIN 主面板（根目錄）完全不受影響，這次只動 `darkroom/`

## 路徑對應：兩種生成 = 兩種持久化程度

darkroom 只有兩條會產生新圖的路徑，評分的持久化行為完全跟著現有的持久化行為走：

| 路徑 | 觸發點 | 圖片本身 | 分數 |
|---|---|---|---|
| 瀏覽模式生成/重新生成（`/api/generate`、`/api/batch_generate` → `do_generate()`） | `_scan_note_image()`（`preview_ui.py:828`）之後 | 落地存進詞庫（`py.with_suffix(OUT_EXT)`） | **永久寫進 `.darkroom_meta/scores.<tag>.json`** |
| 生圖模式（`/api/gen` 內部抽卡/手動套 LoRA、`/api/agent-draw` 外部 agent 抽卡，都走 `_gen_one_worker()`） | 結果寫入 `_gen_results[gid]` 之後 | 只留記憶體 `_gen_results`，不覆蓋詞庫預覽 | **只附在 `_gen_results[gid]["score"]`，隨結果一起過期，不落地** |

重新生成一張已有分數的卡片＝用新分數覆蓋舊分數（`set_score()` 直接覆蓋，不是累加/平均）。

## 一、waifu-score：新增合併端點

`app.py` 新增一個端點，重用既有的 `_predict_one()`：

```python
@app.post("/api/darkroom-score")
async def darkroom_score(file: UploadFile = File(...)):
    ...
```

- 輸入：單張圖片（multipart，一個 `file` 欄位）——跟既有三端點一樣先過
  `ALLOWED_TYPES`/`MAX_BYTES` 檢查
- 依序呼叫三個模型的 `_predict_one("blackroot"/"waifu"/"kawai", image)`
- 任一模型 `get_model()` 拋錯（沒載入成功）→ 整個端點回 500 + 錯誤訊息，**不做部分
  分數**（三模型本來就是啟動時一起背景預熱，分開失敗是邊緣情況，為此在 darkroom 端
  處理「缺一項」的複雜度不值得）
- 正規化：Kawai 的 `weighted_score`（-1~1）線性換算到 0~10：
  `kawai_norm = (weighted_score + 1) / 2 * 10`
- 加權：`final = blackroot * 0.50 + waifu * 0.20 + kawai_norm * 0.30`

成功回應：
```json
{
  "blackroot": 7.82,
  "waifu": 6.10,
  "kawai_tier": "A",
  "kawai_score": 0.42,
  "kawai_norm": 7.10,
  "final": 7.28
}
```

不動 `/api/score`、`/api/kawai-score`、`/api/blackroot-score` 三個既有端點，也不動
`scorer.py`/`blackroot_scorer.py`/`kawai_scorer.py` 三個模型類別。

## 二、darkroom 後端：儲存

比照 `flags`/`favorites`/`rarities` 的既有 pattern（`preview_ui.py:169-305`），新增
一組平行的函式，側檔 `.darkroom_meta/scores.<tag>.json`：

```python
_load_scores()          # 啟動/首次存取時載入
_save_scores_locked()   # 原子寫入（沿用 _atomic_write_json）
set_score(rel, data)    # 覆蓋寫入單筆
score_map()             # 回傳 rel -> data 的完整 dict
```

每筆結構：
```python
{"blackroot": 7.82, "waifu": 6.10, "kawai_tier": "A", "kawai_score": 0.42,
 "kawai_norm": 7.10, "final": 7.28, "at": 1734000000.0}
```

用獨立的 `threading.Lock()`（`_scores_lock`），跟 flags/favs/rarities 三個鎖分開，
互不阻塞。

`scan_libraries()`（`preview_ui.py:789-825`）比照 `flagged`/`favorited`/`rarity` 的
疊加寫法，多一行把 `score_map().get(rel)` 疊進每筆項目的 `it["score"]`（沒有分數就是
`None`，前端據此判斷要不要顯示徽章）。

**分數跟圖片存在性綁定**：疊加時多一個條件——`it["score"] = score_map().get(rel) if
it.get("has_image") else None`。也就是說即使側檔裡還留著舊分數紀錄，只要
`has_image=False`（圖片被刪了、還沒生成過），`scan_libraries()` 回傳給前端的
`it["score"]` 一律是 `None`，前端自然不顯示徽章——不需要在每一個「圖片可能消失」的
地方（使用者手動砍檔案、之後如果有刪除功能等）都個別掛勾清側檔，用讀取時的單一條件
就能保證「沒圖片不會顯示分數」這個不變量，比到處補刪除 hook 更不容易漏。

側檔本身允許暫時留著孤兒紀錄（`rel` 對應的圖片已經不在，但 `scores.<tag>.json`
裡還有那筆），不影響正確性，只是佔一點磁碟空間。**補分腳本/補分按鈕跑的時候**
（見下方「六、補分」）順便清掉這類孤兒紀錄——掃描時發現 `score_map()` 有紀錄但
`has_image=False` 的 `rel`，一併從側檔刪除，讓側檔不會無限累積用不到的資料。

## 三、darkroom 後端：呼叫評分服務

新增 helper（放在 `preview_ui.py` 或抽成同目錄小模組都可以，實作時再定）：

```python
def _score_image_bytes(img_bytes: bytes) -> dict | None:
    # urllib.request 送 multipart POST 到 http://localhost:8000/api/darkroom-score
    # 仿 generate_special_previews.py 的 http_bytes() 風格：帶 User-Agent、
    # 合理 timeout（30s）
    # 連線失敗 / timeout / 非 200 一律 log 一行、回 None，呼叫端安靜跳過
```

waifu-score 服務位址目前寫死 `http://localhost:8000`（跟 `run.bat` 印的位址一致，
兩者都在同一台機器）；不做成可設定項——這次沒有遠端部署的需求，YAGNI。

再加一個輕量健康檢查 helper，給補分按鈕啟動前用：

```python
def _score_service_available() -> bool:
    # GET http://localhost:8000/api/health，短 timeout（例如 2s）
    # 連線失敗/timeout 回 False，不拋例外
```

## 四、darkroom 後端：併發

新增 `_score_sem = threading.Semaphore(1)`。

原因：`app.py` 的端點是 `async def` 但內部呼叫 `_predict_one()` 是同步阻塞的 torch
呼叫，沒有 offload 到 threadpool，所以並發請求在 waifu-score 那邊本來就會互相卡住
（事件迴圈被佔用）。darkroom 這邊乾脆用 1 個名額天然序列化評分請求，不會有多個
thread 同時卡在同一個阻塞呼叫上白白佔資源。這個 semaphore 跟既有的 `gen_sem`（GPU
生圖用）、`_thumb_gen_sem`（縮圖用）完全獨立，互不影響。

## 五、darkroom 後端：觸發點

**兩處各自 spawn 一條 daemon thread**，不阻塞原本的生成回應：

1. `_scan_note_image()`（`preview_ui.py:828-838`）結尾：讀剛存的 webp 檔案 bytes →
   背景 thread 呼叫 `_score_image_bytes()` → 成功就 `set_score(rel, {...})`。這個
   函式是 `do_generate()` 唯一的圖片落地掛勾點，涵蓋單張生成跟批次生成，不用個別
   修改呼叫點。

2. `_gen_one_worker()`（`preview_ui.py:1277-1367`）產生結果、寫進
   `_gen_results[gid]` 之後：背景 thread 呼叫 `_score_image_bytes()` → 成功就把分數
   字典塞進 `_gen_results[gid]["score"]`。純記憶體操作，`_gen_results` 既有的過期/
   清理機制會連分數一起清掉，不需要額外處理。

兩處都用 `with _score_sem:` 包住實際的 HTTP 呼叫。

## 六、前端

**`darkroom.js` `thumbInnerHTML(it)`**：`it.score?.final` 存在時，縮圖角落顯示一個
圓角小徽章（顯示 `final` 分數，例如 `7.3`，仿 `rarTag()` 的 CSS class 模式）。沒有
分數（尚未評分中/評分失敗/服務未開）就不顯示徽章，不佔位、不顯示「載入中」骨架
（跟稀有度標籤同樣的「沒有就不畫」邏輯）。

**明細**：hover 或 click 徽章彈出小 tooltip，列三項原始分數（Blackroot／Waifu
Scorer／Kawai 分級 + 原始分）。沿用既有 hover 泡泡機制（`showSingleLoraPreviewTip`
類似模式）。這個 tooltip 內部不含任何按鈕（純顯示），所以不會踩到 CLAUDE.md 記錄過
的「hover 泡泡裡的按鈕點擊不觸發 mouseleave」那個坑。

**抽卡/生圖模式的暫存結果**：`/api/gen-status`／`/api/gen-result` 回應多帶一個
`score` 欄位（來自 `_gen_results[gid]["score"]`），前端對應的暫存結果卡片疊層用
同一個徽章元件顯示。

## 七、補分：共用核心邏輯 + 兩個入口

補分（掃有圖但沒分數的卡片、自動評分）只寫一份核心邏輯，被 API 觸發的按鈕跟獨立 CLI
腳本共用，不重複實作。

### 核心函式（`preview_ui.py` 內）

```python
def run_score_backfill(progress_cb=None):
    # 1. 掃 scan_libraries() 等價邏輯：has_image=True 的全部項目
    # 2. 依 score_map() 分兩類：
    #    - 沒有分數紀錄 → 呼叫 _score_image_bytes() 評分，成功就 set_score()
    #    - 有分數紀錄但 has_image=False（孤兒紀錄）→ 從側檔刪除（見上方「分數跟
    #      圖片存在性綁定」）
    # 3. 每處理完一筆就更新 STATE["score_backfill"]（done/total/current_rel），
    #    progress_cb 是可選的外部回呼（CLI 腳本用來印進度）
    # 4. 用 _score_sem 序列化實際的評分 HTTP 呼叫，跟自動評分共用同一個名額
```

跑之前先呼叫 `_score_service_available()`（見下）確認 waifu-score 服務有回應；
服務不可用就整個補分操作直接中止並回報錯誤，不會掃完一輪卻全部失敗才發現。

### 入口一：前端「評分」按鈕（`POST /api/score-backfill`）

- 點擊呼叫 `POST /api/score-backfill`。若已經有一輪在跑，回
  `{"ok": true, "already_running": true}`（不重複啟動第二輪）；否則起一條 daemon
  thread 跑 `run_score_backfill()`，立刻回 `{"ok": true, "started": true}`
- **啟動前先做健康檢查**：對 `http://localhost:8000/api/health` 送一個短 timeout
  的請求，連不上就**不啟動背景執行緒**，直接回 `{"error": "waifu-score 服務未啟動，
  請先執行 run.bat"}`（400），前端收到這個錯誤要跳出明顯的提示（toast/alert）——
  跟平常生成後自動評分的「靜默失敗」不同，這是使用者主動觸發的操作，失敗要讓
  使用者知道，不能悄悄沒反應
- `GET /api/score-backfill-status` 回傳 `STATE["score_backfill"]`
  （`{"running": bool, "done": N, "total": M}`），前端用短間隔輪詢顯示進度、
  跑完自動停止輪詢並重新整理卡片分數
- 按鈕在補分執行中顯示進度（例如「評分中 120/430」）並 disable，避免重複點擊

### 入口二：獨立 CLI 腳本 `darkroom/backfill_scores.py`

- 直接 `import preview_ui` 呼叫同一個 `run_score_backfill(progress_cb=...)`，
  `progress_cb` 印到 stdout（`已評分 N/M`）
- 比照 `multi_gpu_batch.py` 踩過的教訓：`import` 進來後自己呼叫
  `load_config()`／`apply_special_dir()` 之類的初始化，不假設模組層常數已經是對的
  （如果 `preview_ui.py` 的 `main()` 才會做這些初始化，`import` 時要自己補呼叫）
- 給大批量、使用者想挑離峰時間手動跑的情境用；跟按鈕入口的差別只在觸發方式跟進度
  輸出目的地，掃描/評分/側檔寫入邏輯完全共用

## 錯誤處理總結

| 情境 | 行為 |
|---|---|
| 自動評分（生成/重新生成後）時 waifu-score 服務沒開 | `_score_image_bytes()` 連線失敗，log 一行，`set_score` 不會被呼叫，卡片留無分數狀態，不影響生成本身的回應（靜默） |
| 自動評分時服務有開但某模型還在冷啟動/載入失敗 | 合併端點回 500，darkroom 視為評分失敗，同上（靜默） |
| **使用者點「評分」按鈕，但服務沒開** | `POST /api/score-backfill` 直接回錯誤，**前端跳出明顯提示**，不啟動背景任務 |
| 生成成功但評分還沒跑完 | 卡片顯示「無分數」（不是「評分中」骨架），下次 `/api/libs` 刷新後分數自然出現——不額外做評分中狀態輪詢，YAGNI |
| 重新生成已有分數的卡片 | 新分數覆蓋舊分數 |
| 圖片被刪掉（`has_image` 變 `False`） | `scan_libraries()` 疊加時強制 `score=None`，前端不顯示徽章；側檔裡的孤兒紀錄留到下次補分時被清掉 |

## 驗收標準

1. waifu-score 起服務後，暗房生成一張新卡片，幾秒內 `.darkroom_meta/scores.<tag>.json`
   出現該卡片的分數紀錄，`final` 落在 0~10 之間
2. 關掉 waifu-score 服務再生成一張卡片：生成本身正常完成、回應不被拖慢，該卡片沒有
   分數紀錄，`preview_ui.py` 的 log 有一行評分失敗訊息
3. 瀏覽模式重新生成一張已有分數的卡片：分數側檔裡該筆被新分數覆蓋，不是新增一筆
4. 內部抽卡（`/api/gen`）跟外部 agent 抽卡（`/api/agent-draw`）產生的卡片有分數
   附在 `_gen_results`，但 `.darkroom_meta/scores.<tag>.json` 完全沒有新增紀錄
5. 前端縮圖角落正確顯示分數徽章，hover/click 顯示三項原始分數明細；沒有分數的卡片
   不顯示徽章
6. `backfill_scores.py` 對一個小測試資料夾跑完，全部 `has_image=True` 的卡片都補上
   分數，中途 Ctrl+C 不會遺失已經算完的部分
7. 手動刪掉一張已評分卡片的 `.webp`，重新整理後該卡片不再顯示分數徽章（`has_image`
   變 `False`）；跑一次補分（按鈕或腳本皆可）後，`scores.<tag>.json` 裡那筆孤兒
   紀錄被清掉
8. 關掉 waifu-score 服務，點前端「評分」按鈕：不會啟動背景任務、不會卡住轉圈，前端
   立刻跳出明確提示「waifu-score 服務未啟動」一類的訊息
9. 開著 waifu-score 服務，點「評分」按鈕：按鈕顯示進度並 disable，補分跑完後卡片
   分數徽章正確出現，按鈕恢復可點擊狀態；跑到一半再點一次按鈕不會啟動第二輪重複
   補分
