# 暗房 checkpoint 選擇器設計

日期：2026-08-12 ／ 狀態：待使用者確認

## 背景

暗房目前只有一顆固定寫死在 workflow.json 裡的底模（`waiIllustriousSDXL_v170`），
沒有任何方式從介面換掉它。使用者要一個在既有「⚙ LoRA 抽取設定」彈窗裡的下拉選單，
可以在幾顆 Illustrious 系底模之間切換，選擇要能撐過伺服器重啟。

## 範圍

**只有生圖模式**（手動生圖、塔羅抽卡、`/api/agent-draw`——這三個都走
`_gen_one_worker()`）會用選定的 checkpoint。**瀏覽模式的「重新生成」單張縮圖
（`do_generate()`）不受影響，一律維持 workflow.json 原本內建的底模**——那是詞庫
預覽圖，要跟既有的縮圖風格一致，不該因為使用者在生圖模式試了別顆底模就跟著變。

這跟前一版草稿的判斷不同：前一版認為兩條路徑共用 `prepare_workflow()` 所以該一併
套用，但「共用同一個函式」不代表「該有同一種行為」——瀏覽模式跟生圖模式的目的不同
（前者是詞庫的標準預覽、後者是使用者主動在試效果），使用者確認要分開。

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

### 套用點：只在 `_gen_one_worker()` 裡，`prepare_workflow()` 呼叫之後

```python
wf = prepare_workflow(STATE["template"], positive=positive, negative=negative,
                      seed=seed, filename_prefix=prefix, steps=STATE["steps"])
if STATE.get("checkpoint"):
    ckpt_node = find_node(wf, "CheckpointLoaderSimple")
    if ckpt_node:
        wf[ckpt_node]["inputs"]["ckpt_name"] = STATE["checkpoint"]
```

**不改 `prepare_workflow()` 本身、不動 `do_generate()`**——直接在 `_gen_one_worker()`
裡、`prepare_workflow()` 回傳之後就地覆寫 `ckpt_name`，這樣瀏覽模式的呼叫點完全碰不到
這段邏輯，不需要靠參數區分「這次要不要套用」。`find_node()` 已經是
`generate_special_previews.py` 現有的 helper（`prepare_workflow()` 內部也在用），
`_gen_one_worker()` 所在的 `preview_ui.py` 本來就 import 了這個模組，直接呼叫即可，
沒有新的跨模組依賴問題。

## 前端

放進「⚙ LoRA 抽取設定」彈窗（`cs-modal`）的「一般」分頁，一個下拉選單：

- 開彈窗時打 `GET /api/checkpoints`，用 `current` 標記目前選的那個
- 選項顯示去掉 `.safetensors` 副檔名的檔名
- 選擇變更立刻打 `POST /api/checkpoint`，成功後 toast 提示；不用另外的「儲存」按鈕
- 不需要重啟、不需要重整頁面——下一次生成就會用新選的底模

## 驗收標準

1. `GET /api/checkpoints` 回傳正確的 7 個檔名 + 目前選的那個
2. `POST /api/checkpoint` 帶不在清單裡的檔名要回 400，不能把任意字串寫進
   `ckpt_name`
3. `POST /api/checkpoint` 成功後，`preview_config.json` 的其他既有欄位（`loras`
   相關、`comfy_endpoints` 等）完全不受影響
4. 重啟 `preview_ui.py` 後，`STATE["checkpoint"]` 讀到上次存的值，不是每次都退回
   預設
5. **選了新 checkpoint 之後，生圖模式（手動生圖／塔羅抽卡／`/api/agent-draw`）生
   出來的 workflow JSON，`CheckpointLoaderSimple.inputs.ckpt_name` 是新選的那個；
   瀏覽模式「重新生成」單張縮圖生出來的 workflow JSON，`ckpt_name` 維持
   workflow.json 原本內建的值，完全不受這個設定影響**——這條要兩個方向都測，只驗
   生圖模式套用了、沒驗瀏覽模式沒被動到，等於沒測到這次範圍縮小的重點。
6. 設定檔裡存的 `checkpoint` 對應的檔案如果被刪掉，啟動要印警告、不能讓
   `preview_ui.py` 整個掛掉
