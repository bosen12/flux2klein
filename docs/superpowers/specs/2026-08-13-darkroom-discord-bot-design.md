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

### `/lora category:<choice> query:<autocomplete>`

- `category` 是固定 4 選項的下拉（`style` / `Character` / `HENTAI` / `illus`，對應暗房 `LORA_FOLDERS`），Discord 原生 choice，不用打字
- `query` 是 Discord 原生 autocomplete 欄位：使用者打字時，機器人即時用目前已選的 `category` 過濤 `GET /api/loras` 的結果（`item.category == category` 且 `file`/`name`/`title` 包含打字內容，不分大小寫），回傳最多 25 筆候選（Discord autocomplete 硬上限）
- 選定送出後，把 `{folder: item.folder, file: item.file}` 寫進 `discord-bot/config.json` 的 `selected_lora`，strength 固定 `0.8`（比照暗房 `AGENT_DRAW_DEFAULT_LORAS` 現有慣例，不開放調整——沒人要求，YAGNI）
- 回覆訊息：「LoRA 已設為 `<title>`」，只在呼叫的頻道可見（ephemeral 或一般回覆皆可，這裡用一般回覆，讓同頻道的人也看得到目前套用哪個）
- `/api/loras` 有 5 分鐘 TTL 快取（暗房伺服器端本身就有），機器人這邊不用另外快取，每次 autocomplete 直接打

### `/chkp file:<autocomplete>`

- 單一 autocomplete 欄位：機器人打 `GET /api/checkpoints`，用打字內容過濾 `items[]`（檔案少，通常不用分類）
- 選定送出後直接呼叫 `POST /api/checkpoint {file}`。暗房回 `{error}` 就照原文回覆錯誤；成功就回覆「checkpoint 已設為 `<file>`」
- 這是暗房自己的全局狀態（跟目前面板上的 checkpoint 選擇器同一份 `STATE["checkpoint"]`），機器人不需要在 `config.json` 存這個值——每次要顯示目前值時直接 `GET /api/checkpoints` 讀 `current` 欄位

### `/gacha n:<1~100，不給預設 1>`

1. 立即（3 秒內）回覆呼叫頻道：「🎴 已排入 {n} 張，開始生成…」（`interaction.response.send_message`）
2. 背景呼叫 `POST /api/agent-draw`：`selected_lora` 有值就帶 `{n, loras: [{"folder": selected_lora.folder, "file": selected_lora.file, "strength": 0.8}]}`；`selected_lora` 是 `null` 就只帶 `{n}`（不含 `loras` 欄位，讓暗房套自己的伺服器端預設）。回應拿到 `items`（含 `id`/`rel`/`name`）與實際套用的 `loras`
3. 輪詢 `GET /api/gen-status?ids=<全部 id 逗號接>`（間隔 1 秒），任何一個 id 第一次轉成 `done` 就：
   - `GET /api/gen-result?id=<id>` 拿圖片 bytes
   - 組一則 embed：title = 資料夾（系列）＋詞庫名稱、欄位放套用的 LoRA（沒套就顯示「無」）、圖片用 embed 的 `attachment://`
   - `channel.send(embed=..., file=...)` 送到 `gacha_output_channel_id` 指定的頻道（不是呼叫的頻道，也不是 interaction followup——避開 15 分鐘 webhook 過期限制）
   - 轉 `error` 的 id 只計入失敗數，不送訊息
4. 全部 id 結束（`done` 或 `error`）後，`channel.send()`（一般頻道訊息，送回呼叫的頻道，不是 followup）：「完成 {ok}/{n} 張」，`ok < n` 時附一句「{n-ok} 張失敗」

**技術限制與因應**：Discord interaction 的 followup webhook 只在原始 interaction 建立後 15 分鐘內有效。`n` 上限 100、單張生成 10~30 秒時，全部跑完可能遠超過 15 分鐘，所以步驟 1 之後的所有輸出（包含步驟 4 的完成提示）都改用機器人身分的一般頻道訊息（`channel.send()`），不依賴 interaction 的 followup token，沒有時間限制。

## 錯誤處理

- 暗房 API 連不上（`ConnectionError`/timeout）→ 回覆「暗房伺服器連不上，確認 preview_ui.py 有在跑」，不丟原始 traceback
- `/api/checkpoint` 回 400（不在允許清單）→ 照暗房回傳的錯誤訊息原文回覆
- `/api/agent-draw` 候選池是空的（400）→ 照原文回覆
- `gacha_output_channel_id` 沒設定或機器人拿不到該頻道 → `/gacha` 一開始就回覆錯誤，不執行後續流程

## 不做的事（YAGNI）

- 不支援多台 Discord 伺服器（單一 `guild_id`）
- 不支援每個使用者各自的 LoRA/checkpoint 偏好（已確認全局共用）
- `/lora` 不開放調整 strength（固定 0.8）
- 不做取消中的 gacha 批次的指令（有需要再加）
- 不把 `/lora` 選的值同步回暗房伺服器（`/api/agent-draw` 本身就支援每次呼叫帶 `loras` 覆寫，不需要碰暗房的全局預設）

## 驗證方式

專案沒有測試框架，比照既有慣例用真實系統驗證：

1. `python -m py_compile` 過語法檢查
2. 暗房 `preview_ui.py` 開著、機器人也跑起來，在真實 Discord 伺服器裡實際打 `/intro`、`/lora`、`/chkp`、`/gacha n:1`，確認回覆與圖片都正確送達指定頻道
3. 刻意在暗房沒開的狀態下打指令，確認錯誤訊息合理（不是丟 500/traceback）
