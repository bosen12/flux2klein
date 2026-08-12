# 暗房 Discord 互動機器人

獨立常駐的 Discord 機器人，讓使用者直接在 Discord 用 slash command 操作暗房
（`darkroom/preview_ui.py`），不透過 AI agent 中介。跟 `preview_ui.py` 完全分開
的行程，只透過 HTTP 打它現有的 API，不 import `darkroom/` 底下任何檔案。

設計文件：[docs/superpowers/specs/2026-08-13-darkroom-discord-bot-design.md](../docs/superpowers/specs/2026-08-13-darkroom-discord-bot-design.md)

## 安裝

```bash
pip install -r discord-bot/requirements.txt
```

## 設定

複製範本並填好：

```bash
cp discord-bot/config.example.json discord-bot/config.json
```

`config.json`（已 gitignore）：

| 欄位 | 說明 |
|------|------|
| `bot_token` | Discord bot token |
| `guild_id` | 伺服器 id，用來立即註冊 slash command（不給就用全域註冊，最長要等一小時才會全部使用者看到） |
| `darkroom_base_url` | 暗房 API 位址，預設 `http://127.0.0.1:7860` |
| `gacha_output_channel_id` | `/gacha` 圖片結果固定送去的頻道 id |
| `selected_lora` | `/lora` 選定的值，機器人自己維護，不用手動填 |

## 跑法

先確認暗房 `preview_ui.py` 已經在跑，再：

```bash
python discord-bot/bot.py
```

## 指令

- `/intro` — 說明
- `/lora category:<style|Character|HENTAI|illus> query:<搜尋>` — 切換 `/gacha` 套用的 LoRA（全局共用，跨重啟保留）
- `/chkp file:<搜尋>` — 切換暗房生圖模式的底模（跟暗房面板自己的 checkpoint 選擇器同一份全局狀態）
- `/gacha n:<1~100，不給預設 1>` — 抽卡生圖，逐張生完就送到 `gacha_output_channel_id` 指定的頻道；確認/完成提示留在呼叫的頻道
