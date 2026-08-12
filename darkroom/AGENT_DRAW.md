# 給外部 agent 用的抽卡 API

暗房本身沒有「抽卡」這個動作——一般抽卡是前端瀏覽器自己隨機挑幾筆再送生成。這裡是
給外部 AI agent 用的伺服器端版本：抽幾張、直接生成，一個小請求換一個小回應，不用
把 27000+ 筆詞庫塞進 agent 的 context。

前提：暗房要在跑（`python preview_ui.py`），agent 跟暗房同一台機器（這個伺服器沒有
任何身份驗證，不要對外網開放）。改完 `preview_ui.py` 要重啟才會生效，改前端檔案
（`.js`/`.css`）只需要重整瀏覽器。

**如果你的 agent 是 [Hermes](https://github.com/NousResearch/hermes-agent)（跑在
Discord／Telegram／Slack 等平台上、有 `terminal`／`send_message` 這類工具的那種），
直接跳到下面「Hermes agent 專用」那節——它有終端機權限，不需要走 HTTP API 那一套，
而且 Discord 的圖片投遞機制（`MEDIA:` 標籤）跟一般「圖片網址」完全不同，用錯會送不
出去。

## 三個端點，依序呼叫

### 1. 抽卡＋送生成
```
POST http://127.0.0.1:7860/api/agent-draw
Content-Type: application/json

{ "n": 8 }
```

回傳：
```json
{ "ok": true, "items": [
  { "id": "a1b2c3", "rel": "01_NTR偷情/xxx.py", "name": "..." },
  ...
]}
```
`n` 最多 32、預設 8，不給就是 8。其他可選欄位：

| 欄位 | 說明 |
|------|------|
| `folder` | 只從這個資料夾抽（不給＝跨全部資料夾） |
| `rarity` | 只抽這個稀有度：`common`/`rare`/`special`/`legendary`（不給＝預設池：有圖且未標稀有度） |
| `loras` | **不給這個欄位＝套伺服器端的預設畫風 LoRA**（目前是 `Takeda_HiromitsuV3`）。想指定別的：`[{"folder": "style", "file": "foo.safetensors", "strength": 0.8}]`，最多兩個。想完全不套 LoRA：明確傳 `"loras": []` |
| `trigger` | 額外觸發詞 |
| `seed` | 給了就是固定亂數種子，同樣的 seed+n+folder+rarity 會抽到同一批 |
| `client` | 自訂識別字串，預設 `"agent"` |

### 2. 等待完成
```
GET http://127.0.0.1:7860/api/gen-status?ids=a1b2c3,d4e5f6,...
```
（把上一步拿到的所有 `id` 用逗號接起來）回傳每個 id 對應的狀態：
```json
{ "a1b2c3": { "status": "done", ... }, "d4e5f6": { "status": "running", ... } }
```
`status` 會是 `pending` → `queued` → `running` → `done`／`error`。每隔約 1 秒重打一次，
直到全部 `done`／`error`。單張生成正常約 10～30 秒（依 steps 與顯示卡而定）。

### 3. 取結果圖
```
GET http://127.0.0.1:7860/api/gen-result?id=a1b2c3
```
只有 `status: "done"` 的 id 才拿得到，回傳 webp 圖片的 bytes。這個 URL 可以直接當
圖片來源用（`<img src="...">` 或任何能吃圖片 URL 的介面）。

## 給 agent 的指令範例

如果你的 agent 框架讓你寫「工具使用說明」或系統提示，可以貼近似這樣的話：

> 當使用者說「抽卡」時：
> 1. 呼叫 `POST http://127.0.0.1:7860/api/agent-draw`，body 是 `{"n": <使用者說的張數，沒說就用 8>}`，拿到一組 id。
> 2. 每隔 1 秒呼叫 `GET http://127.0.0.1:7860/api/gen-status?ids=<所有 id 用逗號接起來>`，直到每個 id 的 status 都是 done 或 error。
> 3. 把每個 done 的 id 組成圖片網址 `http://127.0.0.1:7860/api/gen-result?id=<id>`。
> 4. **每兩張圖片組成一則訊息**送出，直到全部送完。error 的那幾張跳過，可以另外提一句「N 張失敗」。

「每兩張一則訊息」是分批邏輯，跟 API 本身無關——三個端點一次就能拿到全部 8 張的
id，剩下是 agent 自己怎麼分批呈現。

## 驗證過的範例（curl）

```bash
curl -s -X POST http://127.0.0.1:7860/api/agent-draw -H "Content-Type: application/json" -d "{\"n\": 2}"
# {"ok": true, "items": [{"id": "...", "rel": "...", "name": "..."}, {"id": "...", ...}]}

curl -s "http://127.0.0.1:7860/api/gen-status?ids=<id1>,<id2>"
# 重複打到全部 done

curl -s "http://127.0.0.1:7860/api/gen-result?id=<id1>" -o card1.webp
```

## 如果你的 agent 能跑 shell / python

不用管上面這些端點，直接用同目錄的 `agent_draw.py`：
```bash
python agent_draw.py --n 8               # 用伺服器端的預設畫風 LoRA
python agent_draw.py --n 8 --no-lora     # 不套任何 LoRA
python agent_draw.py --n 8 --json        # stdout 印 JSON，給會解析工具輸出的 agent 用
```
它會抽、送生成、等完成、把圖存到 `agent_draws/` 資料夾，一次做完。`--json` 印出來的
`out_path` 一律是**絕對路徑**——這點在下面 Hermes 那節很重要。

## Hermes agent 專用

Hermes（[NousResearch/hermes-agent](https://github.com/nousresearch/hermes-agent)）
是全功能的 agent 框架，接在 Discord 上時**有終端機權限、不是只能打 HTTP API**——
直接叫它跑 `agent_draw.py` 就好，不用管上面三個端點。

**圖片是怎麼送到 Discord 的（讀過 Hermes 原始碼確認，不是猜的）**：Hermes 送訊息用
的是一個叫 `send_message` 的工具，圖片不是用網址，是在**訊息文字裡夾
`MEDIA:<本機絕對路徑>` 標籤**——閘道器（gateway）會把這個標籤抽出來，直接把那個
檔案當成原生 Discord 附件上傳（`discord.File`），不是貼連結。**一則訊息裡可以放多個
`MEDIA:` 標籤**，全部會變成同一則訊息的多個附件（Hermes 內部一次最多包 10 個，
超過會自動幫你分批，不用自己管）。

⚠️ 三個容易踩的坑：
1. **路徑一定要絕對路徑**——相對路徑會被閘道器的安全檢查直接吃掉、靜默不送、也不
   會報錯。`agent_draw.py --json` 印出來的 `out_path` 已經是絕對路徑，直接用即可。
2. **`MEDIA:` 標籤不支援逐張圖片各自的說明文字**——一則訊息只有一段共用的文字，
   不是「每張圖配一行標題」。想讓每張圖看得出對應哪個詞庫名稱，就在文字段落裡照
   順序把名稱列出來，再接著放對應數量的 `MEDIA:` 標籤，順序要對上。
3. **暗房的伺服器沒有身份驗證**——不要把 Discord 那個管道跟遠端存取搞混，`agent_draw.py`
   要在暗房那台機器上跑。

**貼給 Hermes 的指令範例：**

> 當使用者在這個頻道說「抽卡」時：
> 1. 判斷張數：只說「抽卡」沒講數字 → n=1；有講數字（「抽卡 8 張」「抽 5 張」）→ 用那個數字。
> 2. 用 terminal 工具在 `C:\projects\flux2klein\darkroom` 底下跑
>    `python agent_draw.py --n <張數> --json`，等它結束（生成一張約 10～30 秒，
>    n 張會排隊跑，抓比較長的逾時）。
> 3. 解析 stdout 的 JSON：`ok` 陣列裡每筆有 `name`（詞庫名稱）、`out_path`（絕對路徑）。
> 4. 用 `send_message` 送到這個頻道：
>    - **n=1**：訊息文字放詞庫名稱，換行後接 `MEDIA:<out_path>`。
>    - **n>1**：每兩筆包成一則訊息——文字段落先列這兩張的名稱（例如
>      `1. 書桌椅上癱坐作業打不開神` `2. 桑拿休息室門後抱起`），接著放
>      兩個 `MEDIA:` 標籤，順序要跟名稱列表對上。重複直到全部送完。
> 5. 如果 `fail` 陣列不是空的，最後補一句「N 張生成失敗」。

## 真正的 Discord embed（不是 MEDIA: 附件）

`MEDIA:` 標籤送出去的是「文字訊息 + 附件」，不是官方 embed 卡片（沒有 title／
image／footer 這些結構化欄位，Discord 不會渲染成卡片樣式）。原因不是 Discord
擋你，是 Hermes 開放給模型的 `send_message` 工具本身沒有 embed 參數——它要同時
支援 Telegram／WhatsApp／Signal 等十幾個平台，這些平台大多沒有「embed」這個概念，
所以 Hermes 的跨平台訊息工具只給「純文字 + 附件」這種各平台都有的最大公約數。
Hermes 內部其實有 `discord.Embed`（讀過原始碼確認），但那是它自己系統訊息用的，
沒開放給模型呼叫。

要拿到真正的 embed，得繞過 Hermes 的訊息工具，直接用一個**真正的 Discord bot
token** 打 Discord 官方 REST API。webhook 做不到這件事——webhook 綁定的是伺服器
頻道，Discord 不支援 webhook 投遞到 DM；bot token 沒有這個限制，一樣可以 DM。

```bash
python agent_draw.py --n 8 --discord-dm
```

抽完會自動組出 embed（**title = 系列（資料夾）＋詞庫名稱、一個 LoRA 欄位、圖片**）
直接送到指定使用者的 DM，不用另外跑 `send_message`／組 `MEDIA:` 標籤。超過 10
張自動分成多則訊息（Discord 平台上限）。

**設定**（`preview_config.json`，已 gitignore，跟 `comfy_endpoints` 那些機器相關
設定同一份檔案）：
```json
{
  "discord_bot_token": "你的 bot token",
  "discord_dm_user_id": "你的 Discord 使用者 ID（數字）"
}
```
⚠️ 這個 bot **必須跟你至少共用一個伺服器**，Discord 才允許它主動幫你開 DM 頻道
（`POST /users/@me/channels`）——如果你們純粹只在一個沒有共同伺服器的地方互動，
這條路打不通，只能退回 `MEDIA:` 方案。bot token 洩漏出去等於任何人都能用它發訊息
到你的帳號能看到的地方，比暗房本身的無驗證還敏感，不要貼進聊天視窗或提交進 git。

## 改預設 LoRA

伺服器端的預設 LoRA 寫在 `preview_ui.py` 的 `AGENT_DRAW_DEFAULT_LORAS`（靠近檔案開頭
`LORA_ROOT` 那一段）。改完要重啟 `preview_ui.py` 才會生效。
