# 暗房 Discord 互動機器人 設計文件

## 背景與目的

暗房目前已有 `darkroom/agent_draw.py`，讓外部 AI agent（Hermes）用終端機權限跑指令抽卡、把結果透過 `--discord-dm` 送成 Discord embed。這次要做的是不同的東西：一個**獨立、常駐的 Discord 機器人**，直接在 Discord 伺服器上用 slash command 互動——不透過 AI agent 中介，使用者直接在 Discord 打 `/gacha`、`/lora`、`/chkp`、`/intro`。

完成後使用者會自己叫他的 AI agent「用這個機器人」——這代表機器人本身要能獨立運作、指令清楚，不依賴 agent 幫忙解讀。

## 架構

新開一個獨立頂層資料夾 `discord-bot/`，跟 `darkroom/`、`voice-assistant/`、`design-ref/` 同一層。用 `discord.py`（環境裡已安裝 2.7.1）常駐執行，走 Gateway 連線 + slash command（`discord.app_commands`），跟 `darkroom/preview_ui.py`（port 7860）是完全獨立的行程，只透過 HTTP 打暗房現有的 API：

- `GET /api/loras` — 取得 LoRA 清單（`items[]`，每筆含 `folder`/`file`/`name`/`category`）
- `GET /api/checkpoints` — 取得 checkpoint 清單（`items[]`）與目前值（`current`）
- `POST /api/checkpoint` — 切換 checkpoint（`{file}` → `{ok, checkpoint}` 或 `{error}`）
- `POST /api/agent-draw` — 抽卡＋送生成（`{n, loras?}` → `{items: [{id, rel, name}], loras}`）
- `GET /api/gen-status?ids=` — 輪詢生成狀態
- `GET /api/gen-result?id=` — 取生成完的圖片 bytes

機器人**不 import** `darkroom/` 底下任何檔案（`agent_draw.py` 那些函式是給同進程呼叫用的，這裡改成獨立行程各自發 HTTP request，邏輯簡單、耦合度低）。

設定存 `discord-bot/config.json`（新建、加進 `.gitignore`，不跟暗房的 `preview_config.json` 共用）：

```json
{
  "bot_token": "",
  "guild_id": "",
  "darkroom_base_url": "http://127.0.0.1:7860",
  "gacha_output_channel_id": "",
  "selected_lora": null
}
```

- `bot_token` — Discord bot token（使用者稍後提供，可以跟暗房既有 `discord_bot_token` 是同一個 bot，也可以是新的——這份設定不影響暗房那邊）
- `guild_id` — 伺服器 id，slash command 註冊成 guild-scoped（`bot.tree.sync(guild=...)`）而非全域，指令會立即生效（全域註冊最長要等一小時才會全部使用者看到）
- `darkroom_base_url` — 暗房 API 位址，預設本機
- `gacha_output_channel_id` — `/gacha` 圖片結果固定送去的頻道 id（例：在 A 頻道呼叫、圖固定出現在 C 頻道）
- `selected_lora` — `/lora` 選定的值 `{folder, file}`，全局共用、跨重啟保留；`null` 代表沒選過，`/gacha` 呼叫 `/api/agent-draw` 時不帶 `loras` 欄位（套暗房伺服器端自己的預設 LoRA）

## 四個指令

### `/intro`

純文字或簡短 embed，說明機器人能做什麼、其他三個指令的用法。不呼叫暗房 API。

### `/lora`（點選式，2026-08-13 定案——中間繞了一圈，過程見下）

無參數，靠 Discord message component（按鈕／下拉選單）一步步往下選，全程不用打字：

1. `/lora` → 回一則 ephemeral 訊息＋4 個分類按鈕（`style`／`Character`／`HENTAI`／`illus`，對應暗房 `LORA_FOLDERS`）＋一顆「🔍 搜尋」按鈕（見下）＋一顆「🚫 不套用 LoRA」按鈕（點了直接把 `selected_lora` 存成空陣列 `[]`，跟「還沒選過」的 `null` 是不同語意，見下方 config 說明）
2. 點分類 → 打 `GET /api/loras`、篩出該分類，`edit_message` 換成該分類的分頁下拉選單（見下）
3. 選單選某一筆 → `edit_message` 換成**詳情畫面**（見下）
4. 詳情畫面確認 → 把 `{folder, file, strength, trigger}` 寫進 `discord-bot/config.json` 的 `selected_lora`，`edit_message` 顯示「LoRA 已設為 `<title>`（強度 X.XX）」；取消 → 回到剛才那一頁的選單（從🔍搜尋結果進來的沒有「那一頁」，取消就單純清空）

**分頁下拉選單**：每頁最多 25 筆（Discord `Select` 元件單一頁的選項數硬上限），`SelectOption.label` 用 LoRA 標題（`item.title or item.name or item.file`，跟暗房自己 `darkroom.js` 的 `lora.title || lora.name` 同一套慣例，截斷到 100 字元）。選單下方一列放「◀ 上一頁」「下一頁 ▶」（到頁首/頁尾自動 `disabled`）「🔙 換分類」三顆按鈕。

**🔍 搜尋按鈕**（2026-08-13 四次改版最後追加）：使用者確認「選單本身沒搜尋功能也接受」之後又問「有沒有辦法選單+搜尋都要」。真正的答案是 Discord 選單元件本身仍然做不到，但可以組合另一個元件達成同樣效果——`discord.ui.Modal`（跳出的表單彈窗）。點「🔍 搜尋」→ `interaction.response.send_modal(LoraSearchModal())` 跳出一個帶單一文字欄位的表單→使用者打關鍵字送出→`Modal.on_submit` 收到後**由機器人自己**過濾 `GET /api/loras` 的結果（`file`/`title`/`name`，不分大小寫，跨全部分類，最多 25 筆命中）→組成 `LoraSearchResultView`（單一 `Select`，選項就是命中結果）用**新的一則 ephemeral 訊息**顯示（不能沿用原本那則訊息：送出 modal 本身就耗盡了那次按鈕互動的回應額度，`on_submit` 收到的是 modal 提交產生的全新一輪互動，只能開新訊息，這是 Discord API 的限制不是實作選擇）。選中結果一樣導去**詳情畫面**，`category` 帶 `None`（搜尋結果沒有「頁」的概念，取消直接清空）。

**這個互動方式繞了四次才定案，記錄一下避免以後重踩**：① 一開始以為 Discord 的字串 `Select` 元件跟角色/頻道選單一樣有內建打字過濾，實作後使用者實測回報「沒辦法打字」；② 改成 slash command 的 `query` 參數 + autocomplete（真正能跨全部 921 筆即時打字搜尋，技術上是對的）；③ 使用者表態要的是「點開一個真正的下拉選單」這個互動形式本身，不是打指令參數，改回分類→分頁 select，接受選單本身沒搜尋；④ 使用者接著問「有沒有辦法選單又能搜尋」，才想到 Modal + Select 的組合可以兩者都要——**Discord 的字串 Select 元件本身確實沒有內建搜尋框**（這點從頭到尾沒有變過，只有使用者/角色/頻道這幾種拉取 Discord 自己伺服器資料的 entity select 才有），但透過另一個元件（Modal）收集查詢字串、伺服器端自己過濾、再用 Select 呈現結果，可以組合出「選單＋搜尋」的體驗，不违反 Discord 元件本身的限制。

**詳情畫面**（2026-08-13 追加——使用者要求能調強度、能像暗房面板一樣勾選要套用哪些觸發詞段落）：

- 有 `trainedWords` 的 LoRA 會多一列下拉式多選選單（`discord.ui.Select`，`min_values=0`），列出每個觸發詞段落，預設全選（比照暗房面板選 LoRA 時「自動把觸發詞帶進提示詞框」的既有行為），可以複選/全不選；選單變動時即時 `edit_message` 更新 embed 顯示目前組出來的觸發詞句子
- 強度用「➖ 0.05」「➕ 0.05」兩顆按鈕逐步調整（跟暗房自己的強度滑桿 `darkroom.js` 的 `min=0 max=1 step=0.05` 同一組上下限與步進，到邊界自動 `disabled`），初始值 `0.8`；embed 即時顯示目前強度
- 「✅ 確認」「❌ 取消」跟原本一樣

### `selected_lora` 的三種狀態（config.json）

因為新增了「不套用 LoRA」跟強度/觸發詞，`selected_lora` 不再只是「有沒有選」的二元狀態，`/gacha` 呼叫 `/api/agent-draw` 時要分三種情況組 payload：

| `selected_lora` 的值 | 意思 | `/api/agent-draw` 的 `loras` 欄位 |
|---|---|---|
| `null`（初始值，從沒點過 `/lora`） | 還沒選過 | 不帶這個欄位，讓暗房套伺服器端自己的預設 LoRA（`AGENT_DRAW_DEFAULT_LORAS`） |
| `[]`（點過「🚫 不套用 LoRA」） | 明確選了不套用 | 帶空陣列 `[]`，暗房收到空陣列就真的不套任何 LoRA |
| `{folder, file, strength, trigger}`（選過某個 LoRA） | 套用這個 | 帶 `[{folder, file, strength}]`，`trigger` 欄位帶使用者勾選的觸發詞句子 |

`GET /api/loras` 每次點分類按鈕才打一次（不是每次翻頁/調整強度都重打），項目清單在整條互動鏈裡用 view 的屬性帶著走。分頁數視分類而定（實測 `Character` 496 筆 ÷ 20 ≈ 25 頁，`illus` 7 筆只有 1 頁）——比打字搜尋慢，但符合使用者明確要的「遷點式」體驗，不是打字。

### `/chkp`（點選式，同上一併改版）

無參數：

1. `/chkp` → 打 `GET /api/checkpoints`，回一則 ephemeral 訊息＋每個 checkpoint 各一顆按鈕（檔案少，通常一頁放得下，不用分頁；目前選中的那顆用綠色 `success` 樣式跟其他顆區分）
2. 點某個 → `edit_message` 換成確認畫面＋「✅ 確認」「❌ 取消」
3. 確認 → 呼叫 `POST /api/checkpoint {file}`。暗房回 `{error}` 就照原文顯示；成功就顯示「checkpoint 已設為 `<file>`」；取消 → 顯示「已取消」

這是暗房自己的全局狀態（跟面板上的 checkpoint 選擇器同一份 `STATE["checkpoint"]`），機器人不在 `config.json` 存這個值——每次要顯示目前值都直接 `GET /api/checkpoints` 讀 `current` 欄位。

### `/gacha n:<1~100，不給預設 1>`

1. 立即（3 秒內）回覆呼叫頻道一則 ephemeral 的輕量 ack：「🎴 已排入 {n} 張，開始生成…」（`interaction.response.send_message`，只是滿足 Discord 3 秒回應窗口，不是真正的進度顯示）
2. 背景呼叫 `POST /api/agent-draw`，`loras`/`trigger` 依 `selected_lora` 的三種狀態組出對應 payload（見上方「`selected_lora` 的三種狀態」表格）。回應拿到 `items`（含 `id`/`rel`/`name`）與實際套用的 `loras`
3. 用一般頻道訊息（`reply_channel.send()`，不是 interaction 的一部分）送出**進度訊息**：embed 顯示「🎴 生成中…（0/{n} 完成）」，掛一顆「❌ 取消剩餘」按鈕（2026-08-13 追加，見下）
4. 輪詢 `GET /api/gen-status?ids=<全部 id 逗號接>`（間隔 1 秒），任何一個 id 第一次轉成 `done` 就：
   - `GET /api/gen-result?id=<id>` 拿圖片 bytes
   - 組一則 embed：title = 資料夾（系列）＋詞庫名稱、欄位放套用的 LoRA（沒套就顯示「無」）、圖片用 embed 的 `attachment://`
   - `channel.send(embed=..., file=...)` 送到 `gacha_output_channel_id` 指定的頻道（不是呼叫的頻道，也不是 interaction followup——避開 15 分鐘 webhook 過期限制）
   - 每有一張新完成或新失敗，就把步驟 3 的進度訊息 `.edit()` 成最新的「X/{n} 完成」（`Message.edit()`，一般 bot API 呼叫，不是 interaction followup，同樣不受 15 分鐘限制）
   - 轉 `error` 的 id 計入失敗數，不額外送訊息
5. 全部 id 結束（`done`／`error`，或使用者按了取消）後，把進度訊息 `.edit()` 成最終狀態（「✅ 完成 X/{n} 張」或「🚫 已取消（X/{n} 張已完成）」），拿掉取消按鈕（`view=None`）

**❌ 取消剩餘按鈕**（2026-08-13 追加）：按下只設一個 `asyncio.Event`，不直接碰 `pending` 那個字典（活在 `_run_gacha` 迴圈的區域變數裡，按鈕的 callback 拿不到）。輪詢迴圈每輪開頭先檢查這個旗標，設了就呼叫 `POST /api/gen-cancel {ids: <目前還 pending 的全部 id>}` 然後跳出迴圈——**已經送進 ComfyUI 開始跑的那張不會被中途打斷**，暗房那邊只能取消「還在排隊、還沒真的開始生成」的項目，這個限制在 UI 上沒有特別提示，按鈕文字用「取消剩餘」而不是「停止生成」是刻意的用詞選擇。

**技術限制與因應**：Discord interaction 的 followup webhook 只在原始 interaction 建立後 15 分鐘內有效。`n` 上限 100、單張生成 10~30 秒時，全部跑完可能遠超過 15 分鐘，所以步驟 1 之後的所有輸出（包含進度訊息本身跟它的每一次更新）都改用機器人身分的一般頻道訊息／`Message.edit()`，不依賴 interaction 的 followup token，沒有時間限制。

## LoRA 預覽縮圖（2026-08-13 追加）

選定 LoRA 進入詳情畫面時，`embed.set_thumbnail()` 帶上暗房 `GET /api/lora-preview?folder=&file=` 回傳的圖片（用 `attachment://` 附件參照，跟 `/gacha` 的成品圖同一套做法，因為暗房通常跑在 `127.0.0.1`，Discord 的伺服器沒辦法直接抓那個網址，一定要機器人自己下載再當附件傳上去）。強度／觸發詞調整時重建畫面**不重抓圖**——縮圖 bytes 跟著 `LoraDetailView` 的建構子一路傳下去，只有第一次選中這個 LoRA 時才真的打一次 API。

**踩過的坑**：實測抓到一顆 228MB 的「縮圖」（LoRA Manager 掃描進來的素材，副檔名寫 `.jpeg` 但實際內容是 PNG、而且尺寸離譜地大——這是既有詞庫的資料品質問題，不是這次改動造成的）。Discord 附件有上限（免費伺服器約 8~10MB），直接把這種檔案包成 `discord.File` 上傳會讓整個互動失敗。`darkroom_client.get_lora_preview()` 因此在讀 body 前先檢查 `resp.content_length`，超過 `MAX_LORA_PREVIEW_BYTES`（8MB）就直接回 `None`（不顯示縮圖，不是拋錯中斷選擇流程）——**判斷方法**：這類「大部分正常、少數素材異常」的問題很難靠讀程式碼發現，是拿真實資料跑過一輪（用 `curl -w "size=%{size_download}"` 量實際大小）才踩到的，加防護前記得先用真實資料測一輪，不要只用小樣本。短片格式（`.mp4`/`.webm`）也一律跳過，Discord embed 縮圖放不了影片。

## 錯誤處理

- 所有錯誤訊息（暗房連不上、選擇不合法、輸入找不到符合項目等）一律用紅色（`ERROR_COLOR = 0xE74C3C`）的 embed 顯示，跟正常訊息的琥珀色（`EMBED_COLOR`）一眼分得出來，不再用純文字內容
- 暗房 API 連不上（`ConnectionError`/timeout）→ 回覆「暗房伺服器連不上，確認 preview_ui.py 有在跑」，不丟原始 traceback
- `/api/checkpoint` 回 400（不在允許清單）→ 照暗房回傳的錯誤訊息原文回覆
- `/api/agent-draw` 候選池是空的（400）→ 照原文回覆
- `gacha_output_channel_id` 沒設定或機器人拿不到該頻道 → `/gacha` 一開始就回覆錯誤，不執行後續流程

## 不做的事（YAGNI）

- 不支援多台 Discord 伺服器（單一 `guild_id`）
- 不支援每個使用者各自的 LoRA/checkpoint 偏好（已確認全局共用）
- 不把 `/lora` 選的值同步回暗房伺服器（`/api/agent-draw` 本身就支援每次呼叫帶 `loras` 覆寫，不需要碰暗房的全局預設）

（`/lora` 可調 strength、`/gacha` 可中途取消——原本列在這裡的兩項，2026-08-13 使用者要求後已經做了，見上方對應章節）

## 驗證方式

專案沒有測試框架，比照既有慣例用真實系統驗證：

1. `python -m py_compile` 過語法檢查
2. 暗房 `preview_ui.py` 開著、機器人也跑起來，在真實 Discord 伺服器裡實際打 `/intro`、`/lora`、`/chkp`、`/gacha n:1`，確認回覆與圖片都正確送達指定頻道
3. 刻意在暗房沒開的狀態下打指令，確認錯誤訊息合理（不是丟 500/traceback）
4. `darkroom_client.py` 新增的 `get_lora_preview()`／`gen_cancel()` 用獨立腳本對真實 `preview_ui.py`（port 7860）測過：抓一顆已知有正常大小預覽圖的 LoRA 確認能拿到圖；抓那顆 228MB 的異常縮圖確認會被 `MAX_LORA_PREVIEW_BYTES` 擋下回 `None`（不是拋例外炸掉整個互動）；`gen_cancel` 對不存在的 id 呼叫確認回 `{"ok": true, "cancelled_queued": 0}`，不報錯
