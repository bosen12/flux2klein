# 這份是 vendor 進來的第三方專案

原始碼：https://github.com/willmiao/ComfyUI-Lora-Manager
Clone 的 commit：`186ef4da786a039ee2a429508c93f5bffaedf1e3`（2026-08-03）
License：GNU GPL v3（見 `LICENSE`）——只在本機自己用、不重新散布沒有法律疑慮；
如果之後要公開這個 repo，記得這份子資料夾受 GPLv3 拘束。

**沒有帶 `.git`**：clone 下來後把 `.git/` 拿掉了，改成跟 `three.min.js`／
`vanta.fog.min.js` 一樣直接 vendor 成一般檔案，用 flux2klein 自己的 git 歷史追蹤，
不用 submodule（這個專案的其他部分也沒有用 submodule，維持一致、使用者不用學
額外的 git 指令）。

## 對照上游改了什麼

動了三個檔案（都只動 LoRA 的「送到 workflow」路徑，checkpoint／embedding／recipe
那幾條沒碰，維持上游原樣）：

- **`static/js/utils/uiHelpers.js`**：新增 `sendLoraToDarkroom(folder, fileNameNoExt)`，
  直接 `POST` 到 `darkroom/preview_ui.py` 新增的 `/api/lora-push` 端點；暗房那邊輪詢
  偵測到新的推送就自動選進生圖大面板。原本的 `sendLoraToWorkflow()` 機制是「同源
  ComfyUI 網頁即時改 LiteGraph 節點」（送 registry 給後端、後端經 ComfyUI 自己的
  WebSocket 推回去、graph 頁面的 JS 收到後直接改 widget 值）——**standalone 模式下
  這條路本來就是壞的**（`/api/lm/get-registry` 一定回 `Standalone Mode Active`，
  只會跳一個警告 toast，完全沒作用），改用新函式後才真的有事發生。
- **`static/js/components/shared/ModelCard.js`** 的 `handleSendToWorkflow()`——LoRA
  分支改呼叫 `sendLoraToDarkroom()`。
- **`static/js/components/ContextMenu/LoraContextMenu.js`** 的 `sendLoraToWorkflow()`
  方法——右鍵選單「送到 workflow（附加／取代）」兩個項目改成都呼叫
  `sendLoraToDarkroom()`（暗房沒有附加/取代的概念，兩個選單項目現在做同一件事，
  是已知的、可接受的小瑕疵——菜單文字沒有跟著改，優先度不高）。

**沒有動到的已知範圍**：`BulkContextMenu.js` 的「全部送到 workflow」（多選批次）、
checkpoint／embedding／recipe 各自的送出路徑，都維持上游原樣——在 standalone 模式
一樣是原本就壞的（跳警告 toast），沒有變得更差，只是還沒接去暗房。之後真的需要
再補。詳細改動位置與函式，見上面「對照上游改了什麼」段。

## 新增的檔案（不是上游帶的，flux2klein 自己加的）

- `write_settings.py`：每次啟動前把 `settings.json` 的 `loras` 路徑同步成
  `LORA_ROOT` 環境變數（跟 darkroom/serve.py 共用同一份 LoRA 收藏）。
- `start_lora_manager.bat`：啟動腳本。
- 這份 `VENDORED.md`。

## 要拿上游更新時

這是單純 vendor（沒有 fork/submodule 追蹤），要拿新版本得手動重新 clone 一份
覆蓋過來，再對照上面「對照上游改了什麼」那段把三個檔案的改動重新套一次。
