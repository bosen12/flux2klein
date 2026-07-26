/* converter.js —— 把 ComfyUI 的「UI workflow」轉成可提交的「API prompt」
 *
 * 重點原理：
 *  - ComfyUI 的 /prompt 只吃 API 格式：{ nodeId: { class_type, inputs } }。
 *  - 這份 workflow 是 UI 格式（nodes / links / groups）。
 *  - 每個模式是一條獨立管線，用「群組 bypass」切換（node.mode 0=啟用, 4=略過）。
 *  - widget 值在 node.inputs[].widget 有名稱標記，且與 widgets_values 位置對齊。
 *  - 連線要穿透虛擬節點：Reroute、SetNode/GetNode，以及被 bypass 的節點。
 */

// 這些節點是「虛擬 / 只在前端」的，不會出現在 API prompt 裡
const VIRTUAL_TYPES = new Set([
  'Reroute', 'Note', 'MarkdownNote', 'PrimitiveNode',
  'Image Comparer (rgthree)', 'Fast Groups Bypasser (rgthree)',
  'GetNode', 'SetNode',
]);

// 前端專用 widget，伺服器不接受（例如 LoadImage 的上傳按鈕）
const FRONTEND_ONLY_WIDGET_TYPES = new Set(['IMAGEUPLOAD']);

// 這份圖裡的 7 個模式群組標題（用來做 bypass 切換）
const MODE_GROUP_TITLES = new Set([
  '文生图', '单图编辑', '双图编辑', '三图编辑', '局部重绘', '图像扩展', 'SeedVR2高清放大',
]);

class WorkflowGraph {
  constructor(wf) {
    this.wf = wf;
    this.nodes = new Map();
    for (const n of wf.nodes) this.nodes.set(n.id, n);
    this.links = new Map();
    for (const l of (wf.links || [])) {
      // link tuple: [id, from_node, from_slot, to_node, to_slot, type]
      this.links.set(l[0], { id: l[0], from: l[1], fromSlot: l[2], to: l[3], toSlot: l[4], type: l[5] });
    }
    this.groups = wf.groups || [];
  }

  static clone(wf) {
    return new WorkflowGraph(JSON.parse(JSON.stringify(wf)));
  }

  // 依幾何位置判斷節點屬於哪個群組（若多個包含，取面積最小者）
  groupTitleOf(node) {
    const x = node.pos[0], y = node.pos[1];
    let best = null, bestArea = Infinity;
    for (const g of this.groups) {
      const b = g.bounding; // [x, y, w, h]
      if (x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3]) {
        const area = b[2] * b[3];
        if (area < bestArea) { bestArea = area; best = g.title; }
      }
    }
    return best;
  }

  // 啟用某個模式群組，略過其他所有模式群組（含 SeedVR2）
  applyMode(activeGroupTitle) {
    for (const n of this.nodes.values()) {
      const g = this.groupTitleOf(n);
      if (g && MODE_GROUP_TITLES.has(g)) {
        n.mode = (g === activeGroupTitle) ? 0 : 4;
      }
      // 不屬於任何模式群組的共用節點（都是虛擬節點）維持原狀
    }
  }

  // 取出節點的 widget 輸入清單（與 widgets_values 位置對齊）
  widgetInputs(node) {
    const res = [];
    const wv = node.widgets_values;
    const arr = Array.isArray(wv) ? wv : null;
    let wi = 0;
    for (let s = 0; s < (node.inputs || []).length; s++) {
      const slot = node.inputs[s];
      if (slot && slot.widget) {
        let value;
        if (arr) value = arr[wi];
        else if (wv && typeof wv === 'object') value = wv[slot.widget.name];
        wi++;
        res.push({
          name: slot.name,
          value,
          linked: slot.link != null,
          type: slot.type,
          slotIndex: s,
        });
      }
    }
    return res;
  }

  findSetNode(varName) {
    for (const n of this.nodes.values()) {
      if (n.type === 'SetNode' && n.widgets_values && n.widgets_values[0] === varName) return n;
    }
    return null;
  }

  // 從被 bypass 的節點，找同型別的輸入接續往回追
  bypassInputLink(node, throughType) {
    const inputs = node.inputs || [];
    // 先找型別相符且有連線的輸入
    for (const inp of inputs) {
      if (inp.link != null && inp.type === throughType) return this.links.get(inp.link);
    }
    // 退而求其次：第一個有連線的輸入
    for (const inp of inputs) {
      if (inp.link != null) return this.links.get(inp.link);
    }
    return null;
  }

  // 追一條連線到「真正啟用的實體節點」，穿透 Reroute / SetNode / GetNode / 被 bypass 的節點
  followLink(link) {
    let guard = 0;
    while (link && guard++ < 500) {
      const origin = this.nodes.get(link.from);
      if (!origin) return null;
      const t = origin.type;

      if (t === 'Reroute') {
        const inLink = origin.inputs && origin.inputs[0] ? origin.inputs[0].link : null;
        link = inLink != null ? this.links.get(inLink) : null;
        continue;
      }
      if (t === 'GetNode') {
        const setter = this.findSetNode(origin.widgets_values && origin.widgets_values[0]);
        if (!setter) return null;
        const inLink = setter.inputs && setter.inputs[0] ? setter.inputs[0].link : null;
        link = inLink != null ? this.links.get(inLink) : null;
        continue;
      }
      if (t === 'SetNode') {
        const inLink = origin.inputs && origin.inputs[0] ? origin.inputs[0].link : null;
        link = inLink != null ? this.links.get(inLink) : null;
        continue;
      }
      if (origin.mode === 4 || origin.mode === 2) {
        link = this.bypassInputLink(origin, link.type);
        continue;
      }
      // 真正啟用的實體節點
      return [String(origin.id), link.fromSlot];
    }
    return null;
  }

  // 產出 API prompt。objectInfo 可為 null（此時只用內建黑名單過濾）
  toPrompt(objectInfo) {
    const out = {};
    const warnings = [];

    for (const node of this.nodes.values()) {
      if (VIRTUAL_TYPES.has(node.type)) continue;
      if (node.mode === 2 || node.mode === 4) continue;

      const cls = node.type;
      const validNames = this._validInputNames(objectInfo, cls);
      const inputs = {};

      // 1) widget 值
      for (const w of this.widgetInputs(node)) {
        if (w.linked) continue; // 有連線的話由下面的連線覆蓋
        if (FRONTEND_ONLY_WIDGET_TYPES.has(w.type)) continue;
        if (validNames && !validNames.has(w.name)) continue; // 過濾伺服器不認的欄位
        inputs[w.name] = w.value;
      }

      // 2) 連線輸入
      for (let s = 0; s < (node.inputs || []).length; s++) {
        const slot = node.inputs[s];
        if (!slot || slot.link == null) continue;
        const resolved = this.followLink(this.links.get(slot.link));
        if (resolved) {
          inputs[slot.name] = resolved;
        } else {
          warnings.push(`節點 ${node.id}(${cls}) 的輸入「${slot.name}」找不到來源`);
        }
      }

      out[String(node.id)] = { inputs, class_type: cls };
    }

    return { prompt: out, warnings };
  }

  // 依 object_info 自動修正模型檔名：若目前值不在可用清單，換成關鍵字最接近的可用模型
  fixModelNames(objectInfo) {
    const fixes = [];
    if (!objectInfo) return fixes;
    // UNET 與 CLIP 由面板「模型」下拉自選，故不在此自動修正（避免覆蓋使用者選擇 / 誤把 4B 換成 9B）
    const targets = {
      'VAELoader': { field: 'vae_name', keywords: ['flux2', 'vae'] },
      'CheckpointLoaderSimple': { field: 'ckpt_name', keywords: ['klein', 'flux'] },
    };
    for (const node of this.nodes.values()) {
      if (node.mode === 4 || node.mode === 2) continue;
      const t = targets[node.type];
      const def = objectInfo[node.type];
      if (!t || !def) continue;
      const list = this._comboList(def, t.field);
      if (!list || !list.length) continue;
      const cur = this._getWidgetValue(node, t.field);
      if (cur == null || list.includes(cur)) continue; // 已合法
      const repl = this._pickReplacement(list, cur, t.keywords);
      if (repl && repl !== cur) {
        setWidgetByName(this, node.id, t.field, repl);
        fixes.push({ node: node.id, type: node.type, field: t.field, from: cur, to: repl });
      }
    }
    return fixes;
  }

  _comboList(def, fieldName) {
    const inp = def.input || {};
    for (const grp of ['required', 'optional']) {
      const spec = inp[grp] && inp[grp][fieldName];
      if (spec && Array.isArray(spec[0])) return spec[0];
    }
    return null;
  }

  _getWidgetValue(node, fieldName) {
    for (const w of this.widgetInputs(node)) if (w.name === fieldName) return w.value;
    return null;
  }

  _pickReplacement(list, cur, keywords) {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const nCur = norm(cur);
    // 1) 依關鍵字（由具體到一般）找第一個符合的可用項
    for (const kw of keywords) {
      const matches = list.filter(o => norm(o).includes(kw));
      if (matches.length) {
        // 若有多個，挑與原始名稱共同字元最多者
        matches.sort((a, b) => this._overlap(norm(b), nCur) - this._overlap(norm(a), nCur));
        return matches[0];
      }
    }
    return null; // 找不到就不動（會在日誌警告）
  }

  _overlap(a, b) {
    let n = 0;
    for (let i = 3; i <= a.length; i++) if (b.includes(a.slice(0, i))) n = i; else break;
    return n;
  }

  _validInputNames(objectInfo, cls) {
    if (!objectInfo || !objectInfo[cls] || !objectInfo[cls].input) return null;
    const inp = objectInfo[cls].input;
    const names = new Set();
    for (const grp of ['required', 'optional']) {
      if (inp[grp]) for (const k of Object.keys(inp[grp])) names.add(k);
    }
    return names.size ? names : null;
  }
}

// ---- 各模式設定：節點 id 對應到要注入的使用者輸入 ----
// prompt=正向提示詞(CLIPTextEncode), seed=RandomNoise, steps=Flux2Scheduler
// images=[{node, label, mask?}], size=文生圖尺寸, pad=擴圖, grow=遮罩擴張
const MODES = {
  t2i: {
    key: 't2i', label: '文生圖', group: '文生图',
    desc: '純文字生成圖片',
    prompt: 92, seed: 88, steps: 80,
    size: { latent: 84, scheduler: 80 }, // 直接注入寬高（切斷長寬比節點的連線）
    images: [],
    save: 9,
  },
  edit1: {
    key: 'edit1', label: '單圖編輯', group: '单图编辑',
    desc: '上傳 1 張圖 + 指令進行編輯',
    prompt: 148, seed: 142, steps: 151,
    images: [{ node: 158, label: '圖片' }],
    save: 153,
  },
  edit2: {
    key: 'edit2', label: '雙圖編輯', group: '双图编辑',
    desc: '上傳 2 張圖，提示詞用「圖1 / 圖2」指涉',
    prompt: 193, seed: 185, steps: 176,
    images: [{ node: 194, label: '圖1' }, { node: 200, label: '圖2' }],
    save: 198,
  },
  edit3: {
    key: 'edit3', label: '三圖編輯', group: '三图编辑',
    desc: '上傳 3 張圖，提示詞用「圖1 / 圖2 / 圖3」指涉',
    prompt: 353, seed: 354, steps: 328,
    images: [{ node: 352, label: '圖1' }, { node: 357, label: '圖2' }, { node: 355, label: '圖3' }],
    save: 341,
  },
  inpaint: {
    key: 'inpaint', label: '局部重繪', group: '局部重绘',
    desc: '上傳圖片、用筆刷塗抹要重繪的區域',
    prompt: 227, seed: 219, steps: 210,
    images: [{ node: 228, label: '圖片', mask: true }],
    grow: 243,
    save: 233,
  },
  outpaint: {
    key: 'outpaint', label: '圖像擴展', group: '图像扩展',
    desc: '往上下左右擴展畫面（外補繪）',
    prompt: 276, seed: 266, steps: 249,
    images: [{ node: 260, label: '圖片' }],
    pad: 282, // ImagePadForOutpaint: [left, top, right, bottom, feathering]
    save: 272,
  },
};

const MODE_ORDER = ['t2i', 'edit1', 'edit2', 'edit3', 'inpaint', 'outpaint'];

// 設定某節點的 widget 值（依 widget 名稱）
function setWidgetByName(graph, nodeId, widgetName, value) {
  const node = graph.nodes.get(nodeId);
  if (!node) return false;
  const wv = node.widgets_values;
  if (!Array.isArray(wv)) return false;
  let wi = 0;
  for (const slot of (node.inputs || [])) {
    if (slot && slot.widget) {
      if (slot.name === widgetName) { wv[wi] = value; return true; }
      wi++;
    }
  }
  return false;
}

// 直接注入寬高：切斷 width/height 的連線，改用 widget 值（避開長寬比節點）
function injectSize(graph, nodeId, width, height, keepFirst = false) {
  const node = graph.nodes.get(nodeId);
  if (!node) return;
  const wv = node.widgets_values;
  let wi = 0;
  for (const slot of (node.inputs || [])) {
    if (slot && slot.widget) {
      if (slot.name === 'width') { slot.link = null; if (Array.isArray(wv)) wv[wi] = width; }
      if (slot.name === 'height') { slot.link = null; if (Array.isArray(wv)) wv[wi] = height; }
      wi++;
    }
  }
}

// 設定 LoadImage 的檔名（來自 /upload/image 回傳）
function setLoadImage(graph, nodeId, uploaded) {
  const node = graph.nodes.get(nodeId);
  if (!node || !Array.isArray(node.widgets_values)) return;
  const name = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
  // LoadImage 第一個 widget 就是 image
  node.widgets_values[0] = name;
}

// 匯出到全域（給 app.js 用）
window.YZ = { WorkflowGraph, MODES, MODE_ORDER, setWidgetByName, injectSize, setLoadImage };
