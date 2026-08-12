# 暗房 checkpoint 選擇器設計

日期：2026-08-12 ／ 狀態：待使用者確認

## 背景

暗房目前只有一顆固定寫死在 workflow.json 裡的底模（`waiIllustriousSDXL_v170`），
沒有任何方式從介面換掉它。使用者要一個在既有「⚙ LoRA 抽取設定」彈窗裡的下拉選單，
可以在幾顆 Illustrious 系底模之間切換，選擇要能撐過伺服器重啟。

## 範圍

checkpoint 選擇作用在**整個生成管線**，不只是「生圖模式」：手動生圖、塔羅抽卡、
`/api/agent-draw`、瀏覽模式的「重新生成」單張縮圖，全部共用同一份
`STATE["template"]` 與 `prepare_workflow()`。checkpoint 是這個工具唯一的「目前用
哪顆底模」概念，改成套用在共用函式本身，而不是分別在各個呼叫點各自處理一次。

**不在範圍內**：`darkroom/lora-manager/`（那是獨立工具，checkpoint 路徑另外用
`CHECKPOINT_ROOT` 環境變數同步，見 `2026-08-12` 那筆修復，跟這次是兩件事）。

## 限定資料夾

```
C:\ComfyUI\ComfyUI_windows_portable_nvidia\ComfyUI_windows_portable\ComfyUI\models\checkpoints\illurtrious
```

只列這個資料夾底下的 `.safetensors`（目前 7 個檔案：`hassakuXLIllustrious_v34`、
`illustriousXL_v01`、`noobaiXLNAIXL_vPred10Version`、`novaAnimeXL_ilV190`、
`prefectIllustriousXL_v8`、`susamix4Noobai_v10`、`waiIllustriousSDXL_v170`），
**不掃整個 checkpoints 樹**——那些不是 Illustrious 系列，套進這條 LoRA/工作流管線
不會有意義的結果。

## 後端

### 新常數

```python
DARKROOM_CHECKPOINT_ROOT = Path(os.environ.get(
    "DARKROOM_CHECKPOINT_ROOT",
    r"C:\ComfyUI\ComfyUI_windows_portable_nvidia\ComfyUI_windows_portable\ComfyUI\models\checkpoints\illurtrious",
))
DARKROOM_DEFAULT_CHECKPOINT = "waiIllustriousSDXL_v170.safetensors"
```

環境變數可覆寫（跟 `LORA_ROOT`／`CHECKPOINT_ROOT` 同一個模式），但預設值就是使用者
給的實際路徑。

### `GET /api/checkpoints`

掃 `DARKROOM_CHECKPOINT_ROOT` 底下的 `*.safetensors`（只掃這一層，不遞迴——這個
資料夾本身就是使用者刻意圈出來的範圍，沒有子資料夾的必要）。回傳：

```json
{ "items": ["hassakuXLIllustrious_v34.safetensors", "..."],
  "current": "waiIllustriousSDXL_v170.safetensors" }
```

檔案數量小（個位數到十位數），不用比照 `list_loras()` 的 TTL 快取，每次即時掃描。
資料夾本身不存在（環境變數被改指到不存在的路徑）時 `items` 回空陣列，不拋例外——
前端這時下拉選單顯示「（找不到 checkpoint 資料夾）」之類的空狀態，不是白畫面或
永遠轉圈。

### `POST /api/checkpoint`

body `{"file": "xxx.safetensors"}`。**驗證**：檔名必須存在於剛掃到的清單裡（擋任意
路徑輸入／目錄穿越），不合法回 400。合法就：

1. 更新 `STATE["checkpoint"] = file`
2. 寫回 `preview_config.json`（讀-改-寫，只改 `checkpoint` 這個欄位，不動其他既有
   欄位——跟 `agent_draw.py` 寫入 loras 那次教訓一樣，要保留檔案裡原本沒關聯的
   設定）
3. `plog()` 記一筆

### 啟動時載入

`load_config()` 讀到的 `checkpoint` 欄位（沒有就用 `DARKROOM_DEFAULT_CHECKPOINT`）
設進 `STATE["checkpoint"]`。**如果那個檔案在 `DARKROOM_CHECKPOINT_ROOT` 底下已經
不存在**（被刪了、改名了），記警告、`STATE["checkpoint"]` 設為 `None`——`None` 代表
「不覆寫，沿用 workflow.json 原本內建的底模」，不會讓生成失敗或啟動掛掉。

### 套用點：`prepare_workflow()`

```python
if STATE.get("checkpoint"):
    ckpt_node = find_node(wf, "CheckpointLoaderSimple")
    if ckpt_node:
        wf[ckpt_node]["inputs"]["ckpt_name"] = STATE["checkpoint"]
```

放在 `prepare_workflow()` 內部、`deepcopy(template)` 之後——這樣 `do_generate()`
（瀏覽模式重新生成）與 `_gen_one_worker()`（生圖模式／塔羅／agent-draw）都自動吃到，
不用在兩個呼叫點各自重複邏輯。`STATE["checkpoint"]` 讀不到全域 `STATE`（`prepare_
workflow` 目前定義在 `generate_special_previews.py`，`STATE` 是 `preview_ui.py`
的模組層字典）——這是實作時要處理的介面問題，見下方「已知的技術細節」。

## 前端

放進「⚙ LoRA 抽取設定」彈窗（`cs-modal`）的「一般」分頁，一個下拉選單：

- 開彈窗時打 `GET /api/checkpoints`，用 `current` 標記目前選的那個
- 選項顯示去掉 `.safetensors` 副檔名的檔名
- 選擇變更立刻打 `POST /api/checkpoint`，成功後 toast 提示；不用另外的「儲存」按鈕
- 不需要重啟、不需要重整頁面——下一次生成就會用新選的底模

## 已知的技術細節（實作時要注意）

`prepare_workflow()` 目前定義在 `generate_special_previews.py`，是純函式（不碰
`preview_ui.py` 的模組層 `STATE`）。要讓它讀到 `STATE["checkpoint"]`，有兩條路：

1. `prepare_workflow()` 加一個新參數 `checkpoint_override: str | None = None`，
   兩個呼叫點（`do_generate()`、`_gen_one_worker()`）各自傳入
   `STATE.get("checkpoint")`——維持 `prepare_workflow()` 是純函式，不引入跨模組的
   隱性依賴。**這是建議做法**，理由：`generate_special_previews.py` 也被
   `multi_gpu_batch.py` 這類獨立工具 import 使用，不該讓它意外依賴
   `preview_ui.py` 的全域狀態。
2. `prepare_workflow()` 直接 `from preview_ui import STATE` 讀——不建議，會製造
   循環 import 風險（`preview_ui.py` 本來就 import `generate_special_previews`）。

採用方案 1。兩個呼叫點都要記得傳這個新參數，漏了其中一個就會有「重新生成用舊底模、
生圖模式用新底模」這種不一致，是這次實作最容易漏掉的地方。

## 驗收標準

1. `GET /api/checkpoints` 回傳正確的 7 個檔名 + 目前選的那個
2. `POST /api/checkpoint` 帶不在清單裡的檔名要回 400，不能把任意字串寫進
   `ckpt_name`
3. `POST /api/checkpoint` 成功後，`preview_config.json` 的其他既有欄位（`loras`
   相關、`comfy_endpoints` 等）完全不受影響
4. 重啟 `preview_ui.py` 後，`STATE["checkpoint"]` 讀到上次存的值，不是每次都退回
   預設
5. 選了新 checkpoint 之後，`do_generate()`（重新生成單張縮圖）與
   `_gen_one_worker()`（生圖模式）兩條路徑生成出來的 workflow JSON，
   `CheckpointLoaderSimple.inputs.ckpt_name` 都是新選的那個——不能只有其中一條
   路徑生效
6. 設定檔裡存的 `checkpoint` 對應的檔案如果被刪掉，啟動要印警告、不能讓
   `preview_ui.py` 整個掛掉
