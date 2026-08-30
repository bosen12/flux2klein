# 暗房後端這次改了什麼（給 Darkroom iOS App 那邊看）

寫給在 Mac 上接手 Darkroom iOS App 的 Claude Code。這份**只講伺服器端
（`darkroom/preview_ui.py`）2026-08-30 的改動**，以及它對 App 的意義。看完可以直接
決定 App 端要不要跟著改、哪些現有的 workaround 可以拆掉。

對應 commit：`f2a5e62`（程式）＋`baf4044`（進度紀錄）。來源是一份從 App 端反推寫的
後端優化筆記（`preview_ui-backend-optimization.md`），逐條核對後採納三點、否決兩點。

---

## 1. 圖片／影片端點現在支援 HTTP Range（最重要）

**受影響的端點**（全部共用同一支 `_send_cacheable()`）：

- `/api/thumb`
- `/api/image`
- `/api/lora-preview`
- `/api/gen-preview`
- `/api/gen-result`

**現在的行為**：

| 請求 | 回應 |
|------|------|
| 沒帶 `Range` | `200` + `Accept-Ranges: bytes`（body 與以前完全一樣） |
| `Range: bytes=0-99` | `206` + `Content-Range: bytes 0-99/<total>` |
| `Range: bytes=1000-` | `206`，end 補成 `total-1` |
| `Range: bytes=-500` | `206`，**檔案最後 500 bytes**（suffix 形式，播放器讀 moov 用的就是這個） |
| `Range: bytes=99999999-` | `416` + `Content-Range: bytes */<total>` |
| `Range: bytes=0-99,200-299`（多區間） | 忽略 Range，回整包 `200`（不實作 multipart/byteranges，規格允許） |
| `Range` 語法壞掉 | 忽略 Range，回整包 `200` |
| `If-None-Match` 命中 | `304`（現在也帶 `Accept-Ranges`） |
| `If-Range` 跟 ETag 對不上 | 回整包 `200`，**不會**回 206（避免拼接到新舊兩份檔案的片段） |

`206` 回應一樣帶 `ETag` 與 `Cache-Control: private, max-age=604800`，跟 200 一致。
`HEAD` 也走同一套（只是不寫 body），headers 正確。

**ETag 格式提醒（沒有改，但 App 端要知道）**：不是所有端點都用引號包的 strong ETag——
`/api/thumb`、`/api/image`、`/api/lora-preview` 是 `"<sha1>"`，但 `/api/gen-result`
是裸的 `gid`、`/api/gen-preview` 是 `"<gid>:<pv>"` 沒引號。伺服器對 `If-None-Match`／
`If-Range` 都是**整串字串相等比對**，所以只要把收到的 ETag 原封不動送回去就對，不要
自己加／去引號。

### App 端可以拆掉的 workaround

`VideoPreviewCache`「先用一般 GET 把整支 mp4 下載到本機暫存檔，再交給 `AVPlayer`」這
條路現在可以改成**直接把伺服器 URL 交給 `AVPlayer`**，它會自己發 Range 請求。

**但先讀完這段再決定要不要拆**：我用剛做好的 Range 功能實際驗過這台機器上目前 21 支
LoRA 影片預覽，**全部都是 faststart**（`ftyp` 之後緊接著就是 `moov`）。也就是說筆記裡
「現在播不出來」的描述，對**現有這批檔案**並不成立——Range 修的是「將來從 CivitAI 抓到
非 faststart 檔案」和「播放器要 seek／拖進度條」這兩種情況，不是修一個當下正在壞掉的
東西。所以：

- 如果現況（整支下載再播）在 App 裡運作良好、而且這些檔案都只有幾百 KB～1MB，**留著也
  完全合理**（本機檔案 100% 可 seek，還順便有離線快取）。
- 想改成串流播放的話現在後端撐得住，但記得 `AVPlayer` 對 HTTP 來源會發很多小 Range
  請求，而 `preview_ui.py` 是 `ThreadingHTTPServer`＋每個請求把整個檔案讀進記憶體再切
  片（見下方「已知限制」），量大時不見得比整支下載划算。

### 怎麼自己驗（不需要 App）

```bash
curl -s -D - -o /dev/null -H "Range: bytes=-1024" "http://<host>:7860/api/lora-preview?folder=style&file=xxx.mp4"
```

看到 `206 Partial Content` 與 `Content-Range: bytes <total-1024>-<total-1>/<total>`
就是對的。

---

## 2. 縮圖生成的排隊改成有優先權

`_thumb_gen_sem`（同時最多 2 張現場生成）從 `threading.Semaphore` 換成專案裡既有的
`PrioritySemaphore`：**真人請求 priority 0、背景暖快取 priority 1**。

為什麼：名額只有 2，而開機的 `_warm_all_thumbs()` 會連續好幾分鐘一直搶這兩個名額；
原生 `Semaphore` 沒有優先權概念，背景 thread 從 `release()` 到下一次 `acquire()` 幾乎
同一瞬間就搶線，真人請求（HTTP handler 進來才臨時起 thread）幾乎穩輸。

**對 App 的意義**：開機後那幾分鐘打 `/api/thumb`，不再排在幾千張暖快取後面。
`RemoteImageLoader` 那套「縮圖失敗重試 3 次（1.5s／3s）」的機制**建議留著**——它防的是
冷快取生成期間的空窗，這次只是讓等待變短，沒有把等待消滅。

順帶一提，筆記建議的「把 `_thumb_gen_sem` 從 2 調到 3~4」**沒有採納**：問題不是名額太
少，是排隊沒有優先權；那個 `2` 是當初實測（CPU 一直 55%+／溫度飆高）調出來的，沒有重
新量測就不該動。

---

## 3. 生成完成後會順手把新圖的縮圖做好

`do_generate()`（瀏覽模式的生成／重新生成／批次補圖）寫完 `.webp` 之後，會背景
（priority=1）先把 `w=360` 的縮圖生出來。

為什麼：開機的暖快取只暖「開機當下已存在」的圖；剛寫出來的新檔 mtime 變了＝全新的
etag，對快取而言是冷的。不預先做的話，成本會落在「生成完成後第一個看到它的人」身上。

**對 App 的意義**：生成完成後第一次拉 `/api/thumb` 通常已經是暖快取。注意這條**只影響
瀏覽模式**——抽卡／生圖模式的結果走 `/api/gen-result`（記憶體裡的原始 bytes，本來就不
經過縮圖快取），行為完全沒變。

---

## 沒有做的事（筆記有建議，但刻意否決）

- **SSE 推播取代 `/api/gen-status` 輪詢**：筆記自己也說不急。個人規模（一台電腦＋一支
  手機）下 500ms 輪詢不是瓶頸，而且要同時動前後端。**App 端維持現在的 500ms 輪詢節奏
  就好，不用等後端。**
- **換成 HTTP/2**：等於放棄 `http.server`、重寫整個伺服器骨架，代價和收益不成比例。
  App 端 `httpMaximumConnectionsPerHost = 4` 的作法維持不變（那個數字對齊
  `darkroom.js` 的 `_PREVIEW_MAX_CONCURRENT`，是量出來的，不要自己調高）。
- **開機預熱 `w=360` 縮圖**：筆記把這條列為建議，但**這件事本來就已經有了**
  （`_warm_all_thumbs()`，`main()` 最後起的背景 thread，暖的正是 `THUMB_MAX=360`，還
  附帶清 `.thumb_cache` 的孤兒檔）。筆記作者沒讀到 `main()`。

---

## 已知限制（改的時候要記得）

- **Range 是「先把整個檔案讀進記憶體再切片」**，不是 `seek()` 到檔案的那個位置。
  `_send_cacheable()` 收到的參數本來就是 `bytes`（呼叫端 `img.read_bytes()` 就讀完了），
  這次沒有改動呼叫端。以目前的檔案大小（縮圖幾十 KB、LoRA 影片 ~700KB、原圖幾 MB）完全
  沒問題；哪天要送幾百 MB 的東西才需要重做成串流式讀取。
- **`/api/gen-preview` 的 ETag 含 `pv`**，採樣預覽每更新一幀 ETag 就變。對它發 Range
  沒有意義（就是張小圖），維持整包抓即可。
- 伺服器只放行 `127.0.0.1`／`::1`／Tailscale（`100.64.0.0/10`）來源，其他來源直接斷線、
  不回應（不是 403）。App 走 Tailscale 連沒問題，這次沒動這塊。

---

## 驗證這次改動用的方法（要回歸測試時可以照抄）

1. **17 條 Range 單元測試**：直接把 `Handler._parse_range` / `_send_cacheable` 綁到一個
   假物件（假的 `send_response`／`send_header`／`wfile`），不用起伺服器。涵蓋
   一般區間／開放結尾／suffix／超界 clamp／416／語法錯／多區間／HEAD／304／`If-Range`
   命中與不命中／空 body。
2. **真的起一份伺服器打真實端點**：`python darkroom/preview_ui.py --port 7899 --no-open`，
   然後 curl 各種 Range，並把同一張圖切成兩段抓回來 `cat` 起來跟整包 `cmp` 比對（要完全
   一致）。
3. **優先權**：先佔滿 2 個名額，再依序排 4 個 priority=1 與 2 個 priority=0 的工作，
   放開名額後檢查真人請求確實排在已經在等的背景工作前面。

---

# 追加（2026-08-30 晚）：JSON 端點加了 ETag

commit `bdca114`。上面那三項（Range／縮圖優先權／生成後暖快取）之外，又做了一輪快取
優化。**對 App 只有一件事值得動手，其餘只要知道就好。**

## 1. `/api/libs`、`/api/loras` 現在帶 ETag（值得動手）

以前是 `Cache-Control: no-store`，每次都得整包重下。現在：

```
Cache-Control: no-cache
ETag: "45a5e1042c0f012f282a"
Content-Encoding: gzip
```

`no-cache` 不是「不要快取」，是「可以存，但每次用之前要問一下」。帶
`If-None-Match: <上次的 ETag>` 再打一次，內容沒變就回 **304、body 0 bytes**。

**這件事的量級**：`/api/libs` 實測 **12.65MB 原始 / 1.81MB gzip**（30785 筆）。App 每次
冷啟動都會在背景打一次這支——現在只要詞庫沒變動（沒生新圖、沒改收藏/稀有度/評分），
那 1.81MB 可以整包省掉。

**建議做法：自己存 ETag，不要依賴 `URLCache`。** App 本來就有
`Caches/libs-cache.json` 那套自己的快取，順手把 ETag 一起存起來最省事也最好預測：

```swift
// 存：連同 libs-cache.json 一起寫進 UserDefaults 或旁邊的小檔
// 讀：
var req = URLRequest(url: libsURL)
if let etag = savedLibsETag {
    req.setValue(etag, forHTTPHeaderField: "If-None-Match")
}
req.cachePolicy = .reloadIgnoringLocalCacheData   // 走自己的條件請求，不要讓 URLCache 插手
let (data, resp) = try await session.data(for: req)
guard let http = resp as? HTTPURLResponse else { ... }
if http.statusCode == 304 {
    return cachedLibs          // 本機那份還是對的，直接用，不用解碼
}
savedLibsETag = http.value(forHTTPHeaderField: "ETag")
// 照原本的流程解碼 data、覆蓋 libs-cache.json
```

**為什麼不建議直接靠 `URLSession` 自動處理**：預設的 `URLCache.shared` 容量不大，而且
它對「單一回應能不能進快取」有大小門檻——1.81MB 這種尺寸有可能根本不會被存下來，於是
`If-None-Match` 永遠不會被送出、看起來像「加了 ETag 但沒效果」。要走自動路線的話，得先
在 `DarkroomAPI.session` 的 `URLSessionConfiguration` 上換一個夠大的 `URLCache`（例如
記憶體 8MB／磁碟 200MB）**並實測確認真的有送出 `If-None-Match`**。自己管 ETag 沒有這個
不確定性，而且跟現有的 `libs-cache.json` 邏輯天然吻合。

**⚠️ 一定要處理 304**：只要你手動送了 `If-None-Match`，就會拿到 **HTTP 304 加上空的
body**。這時候不能往 `JSONDecoder` 丟——會直接丟解碼錯誤，症狀是「明明伺服器好好的，
App 卻說載入失敗」。上面範例裡那個 `if http.statusCode == 304` 分支不能省。

## 2. 靜態檔也加了 ETag（App 用不到，知道就好）

`/`、`/darkroom.css`、`/darkroom.js` 從 `no-store` 改成 ETag + `no-cache`。那是給瀏覽器
用的，App 不載這些檔案。

## 3. 圖片端點完全沒動

`/api/thumb`、`/api/image`、`/api/lora-preview`、`/api/gen-preview`、`/api/gen-result`
維持 `private, max-age=604800` + ETag（跟以前一樣），Range 支援也還在。
`RemoteImageLoader` 那套 `NSCache` ＋ ImageIO ＋ 重試機制**一行都不用改**。

## 4. payload 瘦身：要 App 先動，後端才能跟上（有興趣再說）

我逐欄位量過 `/api/libs` 的 9.68MB 欄位內容：

| 欄位 | 佔比 | 說明 |
|---|---|---|
| `score` | **45.1%** | 整包 7 個欄位都送（`blackroot`/`waifu`/`kawai_tier`/`kawai_score`/`kawai_norm`/`final`/`at`），但格線徽章只用得到 `final` |
| `display_name` | 7.6% | 絕大多數跟 `name` 一模一樣 |
| `favorited` + `flagged` | 10.3% | 目前幾乎全部是 `false` |
| `rarity` | 3.4% | 多數是空字串 |
| `job` | 2.4% | **30785 筆全部都是 `{}`** |

網頁前端那邊全部是真值判斷（`it.display_name || it.name`、`it.job && ...`、
`it.favorited ?`、`!x.rarity`），所以後端「預設值就不送」不會弄壞瀏覽器。**卡住的是
App**：Swift 的 `Codable` 只要少一個非 optional 欄位就整包解碼失敗，所以我沒有單方面改
——欄位形狀是跨客戶端的契約。

想做的話順序是：**App 先把這些欄位改成 optional（`decodeIfPresent`／`var favorited:
Bool?`＋預設值），確認新舊 payload 都能解，後端再改成稀疏輸出。** 效果是 `/api/libs`
大約砍半（第一次冷啟動 1.81MB → 約 0.95MB）。不急——加了 ETag 之後，真正會付這 1.81MB
的只剩「詞庫真的變動過」的那幾次。

## 5. 主面板（`serve.py`，port 7801）那邊的改動跟 App 無關

同一個 commit 系列還改了 KLEIN 主面板的 gzip 與快取（`5634f23`）。那是給瀏覽器面板用
的，跟 App 講話的是 `preview_ui.py`（port 7860）。**看到那份 diff 不用管。**
