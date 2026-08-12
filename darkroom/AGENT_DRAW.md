# 給外部 agent 用的抽卡 API

暗房本身沒有「抽卡」這個動作——一般抽卡是前端瀏覽器自己隨機挑幾筆再送生成。這裡是
給**只能打 HTTP API（function calling）**的 agent 用的伺服器端版本：抽幾張、直接
生成，一個小請求換一個小回應，不用把 27000+ 筆詞庫塞進 agent 的 context。

前提：暗房要在跑（`python preview_ui.py`），agent 跟暗房同一台機器（這個伺服器沒有
任何身份驗證，不要對外網開放）。改完 `preview_ui.py` 要重啟才會生效，改前端檔案
（`.js`/`.css`）只需要重整瀏覽器。

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
| `loras` | **不給這個欄位＝套伺服器端的預設畫風 LoRA**（目前是 `ATRex_style-12V2Rev`）。想指定別的：`[{"folder": "style", "file": "foo.safetensors", "strength": 0.8}]`，最多兩個。想完全不套 LoRA：明確傳 `"loras": []` |
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
```
它會抽、送生成、等完成、把圖存到 `agent_draws/` 資料夾，一次做完。

## 改預設 LoRA

伺服器端的預設 LoRA 寫在 `preview_ui.py` 的 `AGENT_DRAW_DEFAULT_LORAS`（靠近檔案開頭
`LORA_ROOT` 那一段）。改完要重啟 `preview_ui.py` 才會生效。
