# 暗房 checkpoint 選擇器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在暗房「⚙ LoRA 抽取設定」彈窗的「一般」分頁加一個 checkpoint 下拉選單，
只列 `illurtrious` 資料夾底下的幾顆 Illustrious 系底模，選擇寫回
`preview_config.json`（撐過重啟），只影響生圖模式（手動生圖／塔羅抽卡／
`/api/agent-draw`），瀏覽模式的「重新生成」單張縮圖不受影響。

**Architecture:** 後端新增兩個端點（`GET /api/checkpoints` 列清單、
`POST /api/checkpoint` 切換並持久化），套用點是 `_gen_one_worker()` 裡一個獨立的
`apply_checkpoint_override(wf)` 函式（`do_generate()` 刻意不呼叫它，這是範圍隔離
的關鍵）。前端在既有的 `cs-modal` 加一個 `<select>`，開彈窗時打 API 填選項、選擇
變更立刻打 API 存檔。

**Tech Stack:** Python 標準函式庫（`preview_ui.py`，沿用既有的 `http.server` 手刻
路由），vanilla JS（`darkroom.js`／`index.html`／`darkroom.css`，無框架無建置）。

## Global Constraints

- **UI 文案、commit message、註解都用繁體中文**；節點 ID／`class_type`／模型檔名
  保持原文。
- **這個專案沒有測試框架**（見 `CLAUDE.md`）。驗證手段是：Python 端用
  `python -c "import ast; ast.parse(...)"` 語法檢查 + 真實呼叫（獨立測試行程或直接
  呼叫函式）；前端用瀏覽器 devtools／`javascript_tool` 直接呼叫函式檢查結果。不要
  引入 pytest 或任何測試框架。
- **每完成一個獨立改動就 commit + push**，不要累積成一個大 commit。commit message
  標題簡短、內文說明為什麼這樣改（照 `git log` 現有風格）。
- **commit 之後要在 `進度.md` 最上方補一筆**（格式 `### YYYY-MM-DD HH:MM ·
  <hash> <標題>`），並同步更新 `README.md` 裡受影響的段落——這是專案的既有規矩，
  不是這次新加的。
- **不要引入前端建置工具、框架或 npm 流程**——`darkroom.js`／`darkroom.css`／
  `index.html` 改完存檔、重整瀏覽器即生效。
- **新增後端 API 端點要放進既有的 `do_GET`／`do_POST` 大 if-elif 鏈**，不要另外
  拆路由表——這是這個檔案目前的既有寫法，不要單獨為這個功能引入新的路由機制。
- **改到 `preview_config.json` 讀寫的地方，一定要保留檔案裡其他既有欄位**（讀-改-
  寫，不能整份覆蓋）——這個專案已經因為忽略這件事出過錯（`agent_draw.py` 那次），
  每個會寫這個檔案的地方都要照這個規矩。

---

### Task 1: 後端常數、STATE 初始化、`GET /api/checkpoints`

**Files:**
- Modify: `darkroom/preview_ui.py:310`（在 `AGENT_DRAW_DEFAULT_LORAS` 區塊後面加新常數）
- Modify: `darkroom/preview_ui.py:493`（`STATE` dict 加一個鍵）
- Modify: `darkroom/preview_ui.py:1951`（`main()` 裡 `STATE["gen_sem"] = ...` 那行後面加載入邏輯）
- Modify: `darkroom/preview_ui.py:1598`（`/api/loras` 那個 GET 分支旁邊加新分支）

**Interfaces:**
- Produces：常數 `DARKROOM_CHECKPOINT_ROOT`（`Path`）、`DARKROOM_DEFAULT_CHECKPOINT`
  （`str`，值為 `"waiIllustriousSDXL_v170.safetensors"`）；`STATE["checkpoint"]`
  （`str | None`，`None` 代表「不覆寫，沿用 workflow.json 原本內建的底模」）。
  Task 2、Task 3 都會讀 `STATE["checkpoint"]`。

- [ ] **Step 1: 在 `AGENT_DRAW_DEFAULT_LORAS` 區塊後面（約第 310 行、`LORA_PREVIEW_EXTS`
      定義之前）加入常數**

打開 `darkroom/preview_ui.py`，找到這段（第 308-310 行）：

```python
AGENT_DRAW_DEFAULT_LORAS = [
    {"folder": "style", "file": "Takeda_HiromitsuV3.safetensors", "strength": 0.8},
]
```

在它後面（`LORA_PREVIEW_EXTS = (...)` 之前）插入：

```python
# ---------------------------------------------------------------------------
# checkpoint 選擇（給「生圖」模式用，見 docs/superpowers/specs/
# 2026-08-12-darkroom-checkpoint-picker-design.md）。只鎖定這一個資料夾，不是整個
# checkpoints 樹——裡面放的都是跟現有 LoRA 相容的 Illustrious 系底模，其他底模套進
# 這條管線不會有意義的結果。**只影響生圖模式**（手動生圖／塔羅抽卡／agent-draw），
# 瀏覽模式的「重新生成」單張縮圖刻意不受影響，見 apply_checkpoint_override() 的
# 說明與它唯一的呼叫點。
# ---------------------------------------------------------------------------
DARKROOM_CHECKPOINT_ROOT = Path(os.environ.get(
    "DARKROOM_CHECKPOINT_ROOT",
    r"C:\ComfyUI\ComfyUI_windows_portable_nvidia\ComfyUI_windows_portable\ComfyUI\models\checkpoints\illurtrious",
))
DARKROOM_DEFAULT_CHECKPOINT = "waiIllustriousSDXL_v170.safetensors"
```

- [ ] **Step 2: 在 `STATE` dict 加一個鍵**

找到第 488-493 行的 `STATE = {...}` 開頭：

```python
STATE = {
    "workflow_path": None,
    "template": None,
    "comfy_base": None,
    "steps": 25,
```

把 `"steps": 25,` 那行後面加一行：

```python
STATE = {
    "workflow_path": None,
    "template": None,
    "comfy_base": None,
    "steps": 25,
    "checkpoint": None,   # 生圖模式的底模覆寫；None＝不覆寫，見 DARKROOM_CHECKPOINT_ROOT 說明
```

- [ ] **Step 3: 在 `main()` 裡載入設定值**

找到第 1946-1951 行：

```python
    STATE["workflow_path"] = wf_path
    STATE["template"] = load_workflow(wf_path)
    STATE["steps"] = args.steps
    STATE["timeout"] = args.timeout
    STATE["concurrency"] = max(1, args.concurrency)
    STATE["gen_sem"] = PrioritySemaphore(STATE["concurrency"])
```

在 `STATE["gen_sem"] = PrioritySemaphore(STATE["concurrency"])` 後面加：

```python
    checkpoint_cfg = cfg.get("checkpoint") or DARKROOM_DEFAULT_CHECKPOINT
    if (DARKROOM_CHECKPOINT_ROOT / checkpoint_cfg).is_file():
        STATE["checkpoint"] = checkpoint_cfg
        print(f"[checkpoint] 生圖模式底模：{checkpoint_cfg}")
    else:
        print(f"[checkpoint] 找不到 {checkpoint_cfg}（{DARKROOM_CHECKPOINT_ROOT}），"
              f"生圖模式沿用 workflow.json 原本內建的底模")
        STATE["checkpoint"] = None
```

（`cfg` 在這個函式最上面 `cfg = load_config()` 已經有了，不用另外讀。）

- [ ] **Step 4: 加 `GET /api/checkpoints` 端點**

找到第 1598-1600 行：

```python
            if u.path == "/api/loras":
                self._send_json(list_loras())
                return
```

在它後面加一個新分支：

```python
            if u.path == "/api/checkpoints":
                try:
                    items = sorted(p.name for p in DARKROOM_CHECKPOINT_ROOT.glob("*.safetensors"))
                except OSError:
                    items = []
                self._send_json({"items": items, "current": STATE.get("checkpoint")})
                return
```

- [ ] **Step 5: 語法檢查**

Run: `cd C:/projects/flux2klein/darkroom && python -c "import ast; ast.parse(open('preview_ui.py',encoding='utf-8').read()); print('SYNTAX OK')"`
Expected: `SYNTAX OK`

- [ ] **Step 6: 用獨立測試行程驗證（不動正在跑的正式伺服器）**

Run（背景啟動一個測試行程，用不會撞到正式服務的埠 7878）：
```bash
cd C:/projects/flux2klein/darkroom && python preview_ui.py --port 7878 --no-open > "$TEMP/dr7878.log" 2>&1 &
sleep 6
curl -s "http://127.0.0.1:7878/api/checkpoints"
```
Expected: 回傳類似
`{"items": ["hassakuXLIllustrious_v34.safetensors", "illustriousXL_v01.safetensors", "noobaiXLNAIXL_vPred10Version.safetensors", "novaAnimeXL_ilV190.safetensors", "prefectIllustriousXL_v8.safetensors", "susamix4Noobai_v10.safetensors", "waiIllustriousSDXL_v170.safetensors"], "current": "waiIllustriousSDXL_v170.safetensors"}`
（清單順序是 `sorted()` 排出來的字母序，`current` 應該是預設值，因為這個測試行程
沒有 `preview_config.json` 裡的 `checkpoint` 欄位。）

驗證完關掉測試行程：
```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { \$_.CommandLine -like '*preview_ui.py*7878*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
```

- [ ] **Step 7: Commit**

```bash
cd C:/projects/flux2klein
git add darkroom/preview_ui.py
git commit -m "$(cat <<'EOF'
新增：暗房 checkpoint 選擇器後端第一步——常數、STATE、GET /api/checkpoints

見 docs/superpowers/specs/2026-08-12-darkroom-checkpoint-picker-design.md。
這個 commit 只加清單端點，還不能切換（Task 2）、還沒套用到生成（Task 3）。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
git push
```

---

### Task 2: `POST /api/checkpoint`（驗證＋持久化）

**Files:**
- Modify: `darkroom/preview_ui.py:90`（`load_config()` 後面加一個存檔 helper）
- Modify: `darkroom/preview_ui.py:1727`（`/api/steps` 那個 POST 分支旁邊加新分支）

**Interfaces:**
- Consumes：Task 1 的 `DARKROOM_CHECKPOINT_ROOT`、`STATE["checkpoint"]`、
  `CONFIG_PATH`（既有常數，`preview_ui.py:78` 已定義）。
- Produces：函式 `_save_checkpoint_to_config(file: str) -> None`；
  端點 `POST /api/checkpoint`，body `{"file": "<檔名>"}`，成功回
  `{"ok": True, "checkpoint": "<檔名>"}`，檔名不在清單裡回 400
  `{"error": "..."}`。

- [ ] **Step 1: 在 `load_config()` 後面加存檔 helper**

找到第 81-90 行 `load_config()` 的結尾（`return {}`），在它後面（`apply_special_dir`
之前）插入：

```python
def _save_checkpoint_to_config(file: str) -> None:
    """讀-改-寫 preview_config.json，只改 checkpoint 這個欄位，其餘既有欄位不動——
    跟 agent_draw.py 寫入 loras 那次教訓一樣，不能整份覆蓋。"""
    cfg = {}
    if CONFIG_PATH.is_file():
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            cfg = {}
    cfg["checkpoint"] = file
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
```

- [ ] **Step 2: 加 `POST /api/checkpoint` 端點**

找到第 1727-1736 行的 `/api/steps` 分支：

```python
            if u.path == "/api/steps":
                try:
                    s = max(1, min(150, int(data.get("steps"))))
                except Exception:
                    self._send_json({"error": "steps 需為整數"}, 400)
                    return
                STATE["steps"] = s
                plog(f"[steps] 生成步數設為 {s}")
                self._send_json({"ok": True, "steps": s})
                return
```

在它後面加一個新分支：

```python
            if u.path == "/api/checkpoint":
                file = data.get("file") or ""
                try:
                    valid = {p.name for p in DARKROOM_CHECKPOINT_ROOT.glob("*.safetensors")}
                except OSError:
                    valid = set()
                if file not in valid:
                    self._send_json({"error": "不在允許的 checkpoint 清單裡"}, 400)
                    return
                STATE["checkpoint"] = file
                _save_checkpoint_to_config(file)
                plog(f"[checkpoint] 生圖模式底模設為 {file}")
                self._send_json({"ok": True, "checkpoint": file})
                return
```

- [ ] **Step 3: 語法檢查**

Run: `cd C:/projects/flux2klein/darkroom && python -c "import ast; ast.parse(open('preview_ui.py',encoding='utf-8').read()); print('SYNTAX OK')"`
Expected: `SYNTAX OK`

- [ ] **Step 4: 用獨立測試行程驗證——合法檔名、非法檔名、其他設定欄位不受影響**

Run：
```bash
cd C:/projects/flux2klein/darkroom
cp preview_config.json "$TEMP/dr_config_backup.json"   # 備份正式設定，這個測試行程會共用同一個檔案路徑
python preview_ui.py --port 7878 --no-open > "$TEMP/dr7878.log" 2>&1 &
sleep 6

echo "=== 合法檔名 ==="
curl -s -X POST "http://127.0.0.1:7878/api/checkpoint" -H "Content-Type: application/json" \
  -d '{"file":"prefectIllustriousXL_v8.safetensors"}'

echo "=== 非法檔名 ==="
curl -s -o /dev/null -w "%{http_code}\n" -X POST "http://127.0.0.1:7878/api/checkpoint" \
  -H "Content-Type: application/json" -d '{"file":"../../evil.safetensors"}'

echo "=== current 有更新 ==="
curl -s "http://127.0.0.1:7878/api/checkpoints" | python -c "import json,sys; print(json.load(sys.stdin)['current'])"

echo "=== preview_config.json 其他欄位沒被動到 ==="
python -c "
import json
before = json.load(open(r'$TEMP/dr_config_backup.json', encoding='utf-8'))
after = json.load(open('preview_config.json', encoding='utf-8'))
for k in before:
    if k == 'checkpoint': continue
    assert after.get(k) == before[k], f'{k} 被改動了！before={before[k]!r} after={after.get(k)!r}'
assert after.get('checkpoint') == 'prefectIllustriousXL_v8.safetensors'
print('其他欄位全部一致，checkpoint 正確更新')
"
```
Expected：
- 合法檔名回 `{"ok": true, "checkpoint": "prefectIllustriousXL_v8.safetensors"}`
- 非法檔名回 `400`
- `current` 變成 `prefectIllustriousXL_v8.safetensors`
- 最後一段印出 `其他欄位全部一致，checkpoint 正確更新`，沒有 `AssertionError`

驗證完把設定檔還原、關掉測試行程：
```bash
cp "$TEMP/dr_config_backup.json" preview_config.json
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { \$_.CommandLine -like '*preview_ui.py*7878*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
```

- [ ] **Step 5: Commit**

```bash
cd C:/projects/flux2klein
git add darkroom/preview_ui.py
git commit -m "$(cat <<'EOF'
新增：暗房 checkpoint 選擇器後端第二步——POST /api/checkpoint 驗證＋持久化

驗證檔名必須在 DARKROOM_CHECKPOINT_ROOT 掃到的清單裡（擋任意路徑輸入），
合法就寫進 STATE 也寫回 preview_config.json（讀-改-寫，不動其他既有欄位）。
還沒套用到實際生成（Task 3）。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
git push
```

---

### Task 3: 套用到生圖模式，瀏覽模式的重新生成刻意不套用

**Files:**
- Modify: `darkroom/preview_ui.py`（加一個新函式 `apply_checkpoint_override()`，
  唯一呼叫點在 `_gen_one_worker()` 裡）

**Interfaces:**
- Consumes：`STATE["checkpoint"]`（Task 1 已定義）、`gsp.find_node`
  （`generate_special_previews.py` 既有函式，透過 `import generate_special_previews
  as gsp` 這個既有 alias 呼叫，`preview_ui.py:54` 已 import）。
- Produces：函式 `apply_checkpoint_override(wf: dict) -> None`（原地修改 `wf`）。

- [ ] **Step 1: 加 `apply_checkpoint_override()` 函式**

找到第 1015 行附近的 `inject_lora()` 函式定義（在它上面或下面都可以，這裡放在它
前面）：

```python
def inject_lora(wf: dict, lora_name: str, strength: float):
```

在它之前插入：

```python
def apply_checkpoint_override(wf: dict) -> None:
    """如果 STATE["checkpoint"] 有設定，把 wf 裡的 CheckpointLoaderSimple 節點換成它。

    只有生圖模式（_gen_one_worker）呼叫這個函式；瀏覽模式的 do_generate()
    刻意不呼叫，維持 workflow.json 原本內建的底模——見
    docs/superpowers/specs/2026-08-12-darkroom-checkpoint-picker-design.md
    的範圍決定。"""
    if not STATE.get("checkpoint"):
        return
    ckpt_node = gsp.find_node(wf, "CheckpointLoaderSimple")
    if ckpt_node:
        wf[ckpt_node]["inputs"]["ckpt_name"] = STATE["checkpoint"]
```

- [ ] **Step 2: 在 `_gen_one_worker()` 裡呼叫**

找到第 1266-1268 行：

```python
            wf = prepare_workflow(STATE["template"], positive=positive, negative=negative,
                                  seed=seed, filename_prefix=prefix,
                                  steps=STATE["steps"])
```

在這三行後面（`for lora_name, strength in loras:` 之前）加一行：

```python
            wf = prepare_workflow(STATE["template"], positive=positive, negative=negative,
                                  seed=seed, filename_prefix=prefix,
                                  steps=STATE["steps"])
            apply_checkpoint_override(wf)
```

**不要碰 `do_generate()`**（第 956 行開始那個函式）——它自己也呼叫
`prepare_workflow()`（第 975 行），但**不要**在那裡加 `apply_checkpoint_override()`。
這是這次範圍隔離的關鍵，加了就等於瀏覽模式也套用了，違反設計規格。

- [ ] **Step 3: 語法檢查**

Run: `cd C:/projects/flux2klein/darkroom && python -c "import ast; ast.parse(open('preview_ui.py',encoding='utf-8').read()); print('SYNTAX OK')"`
Expected: `SYNTAX OK`

- [ ] **Step 4: 驗證邏輯正確（純函式呼叫，不用真的送 ComfyUI，不花 GPU 時間）**

Run：
```bash
cd C:/projects/flux2klein/darkroom && python -c "
import preview_ui as p

mock_wf = {'4': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': 'original.safetensors'}}}

# ① STATE['checkpoint'] 是 None 時，不覆寫
p.STATE['checkpoint'] = None
wf1 = {k: dict(v) for k, v in mock_wf.items()}
p.apply_checkpoint_override(wf1)
assert wf1['4']['inputs']['ckpt_name'] == 'original.safetensors', '沒設定時不該被覆寫'
print('① 沒設定時不覆寫：OK')

# ② STATE['checkpoint'] 有設定時，套用
p.STATE['checkpoint'] = 'override.safetensors'
wf2 = {k: dict(v) for k, v in mock_wf.items()}
p.apply_checkpoint_override(wf2)
assert wf2['4']['inputs']['ckpt_name'] == 'override.safetensors', '有設定時該被覆寫'
print('② 有設定時套用：OK')

# ③ 找不到 CheckpointLoaderSimple 節點時不拋例外
p.STATE['checkpoint'] = 'override.safetensors'
wf3 = {'4': {'class_type': 'SomeOtherNode', 'inputs': {}}}
p.apply_checkpoint_override(wf3)  # 不該拋例外
print('③ 找不到節點時不拋例外：OK')
"
```
Expected：三行都印 `OK`，沒有 `AssertionError` 或例外。

- [ ] **Step 5: 確認 `do_generate()` 真的沒呼叫這個函式（結構性檢查，不是靠人眼看）**

Run：
```bash
cd C:/projects/flux2klein/darkroom && python -c "
import ast

tree = ast.parse(open('preview_ui.py', encoding='utf-8').read())
funcs = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}

def calls_apply_override(fn_node):
    return any(
        isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'apply_checkpoint_override'
        for n in ast.walk(fn_node)
    )

assert calls_apply_override(funcs['_gen_one_worker']), '_gen_one_worker 應該要呼叫 apply_checkpoint_override'
assert not calls_apply_override(funcs['do_generate']), 'do_generate 不該呼叫 apply_checkpoint_override——這會讓瀏覽模式也被套用，違反範圍決定'
print('_gen_one_worker 有呼叫、do_generate 沒呼叫：OK')
"
```
Expected：`_gen_one_worker 有呼叫、do_generate 沒呼叫：OK`

- [ ] **Step 6: Commit**

```bash
cd C:/projects/flux2klein
git add darkroom/preview_ui.py
git commit -m "$(cat <<'EOF'
新增：checkpoint 選擇器套用到生圖模式，瀏覽模式的重新生成刻意不套用

apply_checkpoint_override() 只有 _gen_one_worker()（手動生圖／塔羅抽卡／
agent-draw 共用的那個 worker）呼叫；do_generate()（瀏覽模式重新生成單張
縮圖）刻意不呼叫，維持 workflow.json 原本內建的底模——這是設計規格裡跟
使用者確認過的範圍，兩個方向都要測不能只測其中一個。

驗證：純函式呼叫測試（沒設定不覆寫／有設定會覆寫／節點找不到不拋例外），
加一個用 ast 走過語法樹的結構檢查確認 do_generate 真的沒呼叫這個函式，
不是只靠人眼看程式碼確認。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
git push
```

---

### Task 4: 前端——`cs-modal`「一般」分頁加下拉選單

**Files:**
- Modify: `darkroom/index.html:218`（`cs-tab-general` 分頁裡加 `<select>`）
- Modify: `darkroom/darkroom.js`（加 `loadCheckpointPicker()`、`onchange` 處理、在
  `openCsModal()` 裡呼叫）
- Modify: `darkroom/darkroom.css`（加 `.cs-row-checkpoint select` 樣式）

**Interfaces:**
- Consumes：Task 1 的 `GET /api/checkpoints`、Task 2 的 `POST /api/checkpoint`；
  既有的 `toast(msg)` 函式（`darkroom.js` 既有，不用新增）。
- Produces：無其他任務依賴這個任務的輸出（這是最終的 UI 層）。

- [ ] **Step 1: `index.html` 加下拉選單**

找到第 216-218 行：

```html
    <div class="cs-tab-panel" id="cs-tab-general">
      <p class="cs-hint">這裡是 LoRA1／LoRA2 的全域控制面板，跟 LoRA 大面板互相即時同步（強度、固定的 LoRA 都共用同一份狀態，改哪邊另一邊都會跟著變）。按 <b>Concepts</b> 抽卡時：哪格固定放著 LoRA 就鎖定用它，沒有固定但範圍晶片設了分類就縮小範圍隨機抽；情境（concepts）兩格都沒覆蓋到時會自動從全部 concepts 隨機補一顆，其他分類沒有這個補位。標「已跳過」的格子完全不參與這個判斷。</p>
      <button type="button" class="ghost lora-help-btn" id="lora-help-btn">？ 詳細教學</button>
```

在 `lora-help-btn` 那個按鈕後面（`<div class="cs-scope-block" data-slot="0">` 之前）
加：

```html
      <label class="cs-row cs-row-checkpoint">
        <span>底模</span>
        <select id="cs-checkpoint"></select>
      </label>
```

- [ ] **Step 2: `darkroom.css` 加樣式**

在檔案結尾加（或找 `.cs-row-count input[type=number]` 那條規則，加在它附近）：

```css
.cs-row-checkpoint select { flex: 1; padding: 4px 8px; font-size: 12px;
  background: var(--sunk); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; }
.cs-row-checkpoint select:disabled { opacity: .5; }
```

- [ ] **Step 3: `darkroom.js` 加載入與切換邏輯**

找到 `openCsModal()`（約第 2954 行）：

```javascript
async function openCsModal() {
  $('cs-modal').classList.add('open');
  await fetchGenLoras();
  renderCsScopeChips(0);
  renderCsScopeChips(1);
  moveCsTabPill();
}
```

改成：

```javascript
async function openCsModal() {
  $('cs-modal').classList.add('open');
  await fetchGenLoras();
  renderCsScopeChips(0);
  renderCsScopeChips(1);
  moveCsTabPill();
  loadCheckpointPicker();
}
```

在 `openCsModal()` 前面（或後面都可以）加兩個新函式：

```javascript
// checkpoint 選擇器：只列 DARKROOM_CHECKPOINT_ROOT 那個資料夾（見後端 /api/checkpoints），
// 只影響生圖模式，見 preview_ui.py 的 apply_checkpoint_override() 說明。
async function loadCheckpointPicker() {
  const sel = $('cs-checkpoint');
  if (!sel) return;
  try {
    const r = await fetch('/api/checkpoints');
    const j = await r.json();
    sel.innerHTML = '';
    if (!j.items || !j.items.length) {
      const opt = document.createElement('option');
      opt.textContent = '（找不到 checkpoint 資料夾）';
      opt.disabled = true; opt.selected = true;
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    for (const file of j.items) {
      const opt = document.createElement('option');
      opt.value = file;
      opt.textContent = file.replace(/\.safetensors$/i, '');
      if (file === j.current) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch (e) {
    sel.innerHTML = '<option disabled selected>載入失敗</option>';
  }
}
$('cs-checkpoint').onchange = async (e) => {
  const file = e.target.value;
  try {
    const r = await fetch('/api/checkpoint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    const j = await r.json();
    if (j.error) { toast('設定失敗：' + j.error); return; }
    toast('底模已切換：' + file.replace(/\.safetensors$/i, ''));
  } catch (e) {
    toast('設定失敗，連不到伺服器');
  }
};
```

- [ ] **Step 4: 語法檢查**

Run: `cd C:/projects/flux2klein/darkroom && node --check darkroom.js`
Expected: 沒有輸出（沒有語法錯誤就不會印任何東西，`exit code 0`）

- [ ] **Step 5: 在瀏覽器裡驗證（需要 preview_ui.py 在跑，用正式服務 7860 即可，這步
      只讀不寫不影響資料）**

用 `mcp__Claude_Browser__navigate` 開 `http://127.0.0.1:7860/`，然後用
`mcp__Claude_Browser__javascript_tool` 執行：

```javascript
(async () => {
  const out = {};
  await openCsModal();
  const sel = document.getElementById('cs-checkpoint');
  out.optionCount = sel.options.length;
  out.options = [...sel.options].map(o => o.value);
  out.selectedValue = sel.value;
  out.disabled = sel.disabled;
  return JSON.stringify(out, null, 1);
})()
```

Expected：`optionCount` 是 7（或跟當時 `illurtrious` 資料夾實際檔案數一致）、
`options` 陣列裡有 `waiIllustriousSDXL_v170.safetensors`、`selectedValue` 是目前
`STATE["checkpoint"]` 的值、`disabled` 是 `false`。

再驗證切換：

```javascript
(async () => {
  const sel = document.getElementById('cs-checkpoint');
  const other = [...sel.options].map(o => o.value).find(v => v !== sel.value);
  sel.value = other;
  sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 500));   // 等 POST 打完
  const r = await fetch('/api/checkpoints');
  const j = await r.json();
  return JSON.stringify({ 切換到: other, 伺服器現在回報的current: j.current, 一致: other === j.current });
})()
```

Expected：`一致: true`。

**驗證完記得把 checkpoint 切回 `waiIllustriousSDXL_v170.safetensors`**（用同一段
程式碼、把 `other` 換成 `'waiIllustriousSDXL_v170.safetensors'`），不要把正式服務
的設定留在測試用的隨機值上。

- [ ] **Step 6: Commit**

```bash
cd C:/projects/flux2klein
git add darkroom/index.html darkroom/darkroom.js darkroom/darkroom.css
git commit -m "$(cat <<'EOF'
新增：checkpoint 選擇器前端——「⚙ LoRA 抽取設定」的「一般」分頁加下拉選單

開彈窗時打 GET /api/checkpoints 填選項、標記目前選的；選擇變更立刻打
POST /api/checkpoint，成功用既有的 toast() 提示，不用另外的「儲存」按鈕、
不用重整頁面。

驗證：瀏覽器裡開彈窗確認選項數與內容正確、切換後打 /api/checkpoints
確認伺服器端真的記到新值。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
git push
```

---

### Task 5: 文件——規格套用 config 範例、README、進度.md

**Files:**
- Modify: `darkroom/preview_config.example.json`（補上 `checkpoint` 欄位範例）
- Modify: `README.md`（生圖模式那節補一句）
- Modify: `進度.md`（補一筆變更紀錄，含前面幾個 commit 的完整 hash）

**Interfaces:** 無（純文件，不影響其他任務）。

- [ ] **Step 1: `preview_config.example.json` 補欄位**

在既有的 `"discord_dm_user_id": ""` 那行後面（`}` 之前）加：

```json
  "_checkpoint說明": "生圖模式（手動生圖／塔羅抽卡／agent-draw）用的底模，只能是 darkroom/preview_ui.py 的 DARKROOM_CHECKPOINT_ROOT 資料夾底下的檔案（預設 illurtrious 子資料夾）。不影響瀏覽模式的重新生成。省略就用 DARKROOM_DEFAULT_CHECKPOINT（目前是 waiIllustriousSDXL_v170.safetensors）。由暗房介面的 ⚙ 設定彈窗寫入，通常不用手動編輯。",
  "checkpoint": "waiIllustriousSDXL_v170.safetensors"
```

Run 驗證 JSON 合法：
```bash
cd C:/projects/flux2klein/darkroom && python -c "import json; json.load(open('preview_config.example.json', encoding='utf-8')); print('JSON OK')"
```
Expected: `JSON OK`

- [ ] **Step 2: `README.md` 補一句**

找到「生圖模式（頂列切「🎨 生圖」）」那節（`grep -n "生圖模式（頂列切" README.md`
找到確切行號），在描述 LoRA 大面板／生成那幾條 `-` 項目附近，加一條新的：

```markdown
- **底模選擇**：「⚙ LoRA 抽取設定」彈窗的「一般」分頁有一個底模下拉選單，只列
  `illurtrious` 資料夾底下的 Illustrious 系 checkpoint（跟現有 LoRA 相容），選擇
  立即生效並寫回設定檔（重啟也記得）。**只影響生圖模式**（手動生圖／塔羅抽卡／
  agent-draw），瀏覽模式的「重新生成」單張詞庫縮圖不受影響、一律用 workflow.json
  原本內建的底模。
```

- [ ] **Step 3: `進度.md` 補變更紀錄**

在 `## 變更紀錄` 底下（最上面那筆之前）插入一筆，`<hash>` 要填 Task 4 commit 完
之後、實際的最新 commit hash（用 `git log --oneline -1` 查）：

```markdown
### 2026-08-12 · `<hash>` 新增：暗房 checkpoint 選擇器（只影響生圖模式）

見 docs/superpowers/specs/2026-08-12-darkroom-checkpoint-picker-design.md 完整
設計過程。「⚙ LoRA 抽取設定」彈窗的「一般」分頁新增底模下拉選單，只列
`illurtrious` 資料夾底下的 Illustrious 系 checkpoint。選擇寫回
`preview_config.json`（重啟也記得），只套用在生圖模式（手動生圖／塔羅抽卡／
`/api/agent-draw` 共用的 `_gen_one_worker()`），瀏覽模式的「重新生成」單張縮圖
（`do_generate()`）刻意不套用——這是跟使用者確認過的範圍決定，不是共用
`prepare_workflow()` 就該有同一種行為。

新增 `apply_checkpoint_override()` 獨立函式、只有一個呼叫點，搭配一個用 `ast`
走語法樹的結構檢查（不是只靠人眼看）確認 `do_generate()` 真的沒呼叫它。

跟 KLEIN 主面板（`illustrious.js` 的 `CKPT` 常數）刻意不自動同步——那是完全獨立
的另一條生成管線，目前兩邊值剛好一致，之後要換主面板底模照舊有模式直接講。
```

- [ ] **Step 4: Commit**

```bash
cd C:/projects/flux2klein
git add darkroom/preview_config.example.json README.md 進度.md
git commit -m "$(cat <<'EOF'
文件：補上 checkpoint 選擇器的設定範例、README 說明、進度紀錄

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
git push
```

- [ ] **Step 5: 提醒使用者重啟**

這次的改動全部在 `preview_ui.py`（Python 後端），**要重啟 `preview_ui.py` 才會
生效**——這是給執行這個計畫的工作者的提醒，最後要把這句話帶回給使用者，不是
自己默默重啟正式服務。
