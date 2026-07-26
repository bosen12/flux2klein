/* app.js —— 面板主邏輯：模式表單、上傳、遮罩畫布、送出、WebSocket 即時進度 */
(() => {
  const { WorkflowGraph, MODES, MODE_ORDER, setWidgetByName, injectSize, setLoadImage } = window.YZ;

  const $ = (id) => document.getElementById(id);
  const API = location.origin;                 // 同源，經由 serve.py 代理到 ComfyUI
  const clientId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

  const state = {
    workflow: null,
    objectInfo: null,
    mode: 't2i',
    images: {},          // nodeId -> { file, uploaded, url }
    mask: null,          // 局部重繪用：{ img, strokeCanvas, viewCanvas, w, h }
    running: false,
    // 進度計時
    run: null,
  };

  /* ---------------- 初始化 ---------------- */
  async function init() {
    log('載入 workflow…');
    try {
      state.workflow = await fetch('workflow.json').then(r => r.json());
    } catch (e) { log('無法載入 workflow.json：' + e, 'err'); return; }

    // 先把畫面渲染出來（不等 object_info），手機/遠端才不會卡在白畫面
    buildTabs();
    selectMode('t2i');
    bindGlobalControls();
    connectWS();

    // object_info 很大（約 10MB），改成背景載入，不擋 UI；生成時才需要
    state.objectInfoPromise = fetch(API + '/object_info')
      .then(r => r.ok ? r.json() : null)
      .then(oi => { state.objectInfo = oi; if (oi) log('節點定義就緒（object_info）', 'ok'); return oi; })
      .catch(() => { state.objectInfo = null; log('取不到 object_info，改用內建規則（仍可運作）', 'warn'); return null; });
  }

  /* ---------------- 模式分頁 ---------------- */
  function buildTabs() {
    const tabs = $('tabs');
    tabs.innerHTML = '';
    for (const key of MODE_ORDER) {
      const m = MODES[key];
      const b = document.createElement('button');
      b.className = 'tab' + (key === state.mode ? ' active' : '');
      b.textContent = m.label;
      b.onclick = () => selectMode(key);
      tabs.appendChild(b);
    }
  }

  function selectMode(key) {
    state.mode = key;
    const m = MODES[key];
    document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', MODE_ORDER[i] === key));
    $('mode-desc').textContent = m.desc;

    // 提示詞預設值（帶入原作者範例，方便測試）
    const node = state.workflow.nodes.find(n => n.id === m.prompt);
    $('prompt').value = (node && Array.isArray(node.widgets_values)) ? (node.widgets_values[0] || '') : '';
    $('prompt-hint').textContent = m.images.length >= 2 ? '可用「圖1 / 圖2 / 圖3」指涉各張圖' : '';

    // 步數預設值（讀該模式 Flux2Scheduler 的目前值）
    const sched = state.workflow.nodes.find(n => n.id === m.steps);
    if (sched && Array.isArray(sched.widgets_values)) $('steps').value = sched.widgets_values[0];

    // 圖片上傳區
    buildUploads(m);

    // 各模式專屬欄位顯示切換
    show('images-field', m.images.length > 0 && !(m.images.length === 1 && m.images[0].mask));
    show('mask-field', m.images.some(i => i.mask));
    show('size-field', !!m.size);
    show('pad-field', !!m.pad);
    show('batch', !!m.size, true);
    $('images-hint').textContent = `需 ${m.images.filter(i => !i.mask).length} 張`;

    if (m.size) buildAspectPresets();
    state.images = {}; // 換模式清空已選圖
    state.mask = null;
  }

  function show(id, on, isField = false) {
    const el = isField ? $(id).closest('.field') : $(id);
    if (el) el.style.display = on ? '' : 'none';
  }

  /* ---------------- 圖片上傳 UI ---------------- */
  function buildUploads(m) {
    const wrap = $('uploads');
    wrap.innerHTML = '';
    const slots = m.images.filter(i => !i.mask);
    for (const slot of slots) {
      const d = document.createElement('div');
      d.className = 'drop';
      d.innerHTML = `<span class="tag">${slot.label}</span>
        <button class="clear" type="button" title="移除">✕</button>
        <span class="ph">＋ 點擊上傳<br>${slot.label}</span>
        <input type="file" accept="image/*" hidden>`;
      const input = d.querySelector('input');
      d.onclick = (e) => { if (e.target.closest('.clear')) return; input.click(); };
      input.onchange = () => onPickImage(slot.node, input.files[0], d);
      d.querySelector('.clear').onclick = (e) => { e.stopPropagation(); e.preventDefault(); delete state.images[slot.node]; d.classList.remove('has-img'); d.querySelectorAll('img').forEach(x => x.remove()); };
      wrap.appendChild(d);
    }
    // 局部重繪的圖片走遮罩畫布
    const maskSlot = m.images.find(i => i.mask);
    if (maskSlot) setupMaskUpload(maskSlot);
  }

  function onPickImage(nodeId, file, dropEl) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    state.images[nodeId] = { file, uploaded: null, url };
    dropEl.classList.add('has-img');
    dropEl.querySelectorAll('img').forEach(x => x.remove());
    const img = document.createElement('img');
    img.src = url;
    dropEl.insertBefore(img, dropEl.firstChild);
  }

  /* ---------------- 遮罩畫布（局部重繪） ---------------- */
  function setupMaskUpload(slot) {
    const stage = $('mask-stage');
    stage.innerHTML = `<div class="drop" style="width:100%;aspect-ratio:auto;min-height:120px" id="mask-drop">
        <span class="ph">＋ 點擊上傳圖片後即可塗抹</span>
        <input type="file" accept="image/*" hidden></div>`;
    const input = stage.querySelector('input');
    stage.querySelector('#mask-drop').onclick = () => input.click();
    input.onchange = () => loadMaskImage(slot.node, input.files[0]);
    $('mask-clear').onclick = () => { if (state.mask) { const s = state.mask.strokeCanvas; s.getContext('2d').clearRect(0,0,s.width,s.height); renderMask(); } };
    $('brush').oninput = () => {};
  }

  function loadMaskImage(nodeId, file) {
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const stage = $('mask-stage');
      const maxW = Math.min(stage.clientWidth || 400, 480);
      const scale = Math.min(1, maxW / img.naturalWidth);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      stage.innerHTML = '';
      const view = document.createElement('canvas');
      view.width = w; view.height = h;
      stage.appendChild(view);
      const strokeCanvas = document.createElement('canvas');
      strokeCanvas.width = w; strokeCanvas.height = h;
      state.mask = { img, strokeCanvas, view, w, h, nodeId, file };
      renderMask();
      bindMaskDrawing();
    };
    img.src = URL.createObjectURL(file);
  }

  function renderMask() {
    const m = state.mask; if (!m) return;
    const ctx = m.view.getContext('2d');
    ctx.clearRect(0, 0, m.w, m.h);
    ctx.drawImage(m.img, 0, 0, m.w, m.h);
    ctx.drawImage(m.strokeCanvas, 0, 0);
  }

  function bindMaskDrawing() {
    const m = state.mask;
    const sctx = m.strokeCanvas.getContext('2d');
    let drawing = false;
    const pos = (e) => {
      const r = m.view.getBoundingClientRect();
      const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
      return { x: cx * (m.w / r.width), y: cy * (m.h / r.height) };
    };
    const paint = (p) => {
      const rad = (+$('brush').value) * (m.w / m.view.getBoundingClientRect().width) / 2;
      sctx.fillStyle = 'rgba(255,60,60,.55)';
      sctx.beginPath(); sctx.arc(p.x, p.y, rad, 0, Math.PI * 2); sctx.fill();
      renderMask();
    };
    const down = (e) => { e.preventDefault(); drawing = true; paint(pos(e)); };
    const move = (e) => { if (drawing) { e.preventDefault(); paint(pos(e)); } };
    const up = () => { drawing = false; };
    m.view.addEventListener('pointerdown', down);
    m.view.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // 產生 RGBA PNG：塗抹處 alpha=0（符合 ComfyUI LoadImage 的 MASK 規則）
  async function buildMaskedPng() {
    const m = state.mask;
    const W = m.img.naturalWidth, H = m.img.naturalHeight;
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const octx = out.getContext('2d');
    octx.drawImage(m.img, 0, 0, W, H);
    const imgData = octx.getImageData(0, 0, W, H);
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(m.strokeCanvas, 0, 0, W, H);
    const sd = tctx.getImageData(0, 0, W, H).data;
    const d = imgData.data;
    for (let i = 0; i < W * H; i++) {
      if (sd[i * 4 + 3] > 10) d[i * 4 + 3] = 0; // 塗抹處 → 透明
    }
    octx.putImageData(imgData, 0, 0);
    return await new Promise(res => out.toBlob(res, 'image/png'));
  }

  /* ---------------- 尺寸預設 ---------------- */
  function buildAspectPresets() {
    const box = $('aspect-presets');
    const presets = [['1:1', 1024, 1024], ['3:4', 896, 1152], ['4:3', 1152, 896], ['9:16', 768, 1344], ['16:9', 1344, 768]];
    box.innerHTML = '';
    for (const [name, w, h] of presets) {
      const b = document.createElement('button');
      b.className = 'btn-mini'; b.textContent = name;
      b.onclick = () => { $('width').value = w; $('height').value = h; };
      box.appendChild(b);
    }
  }

  /* ---------------- 上傳到 ComfyUI ---------------- */
  async function uploadBlob(blob, filename) {
    const fd = new FormData();
    fd.append('image', blob, filename);
    fd.append('overwrite', 'true');
    const r = await fetch(API + '/upload/image', { method: 'POST', body: fd });
    if (!r.ok) throw new Error('上傳失敗 ' + r.status);
    return await r.json(); // { name, subfolder, type }
  }

  /* ---------------- 送出生成 ---------------- */
  async function generate() {
    if (state.running) { log('目前有任務進行中，請稍候或按中斷。', 'warn'); return; }
    $('run-loader').classList.add('on');   // 顯示生成中星星動畫
    const m = MODES[state.mode];
    const g = WorkflowGraph.clone(state.workflow);
    g.applyMode(m.group);

    try {
      // 1) 上傳圖片
      const need = m.images.filter(i => !i.mask);
      for (const slot of need) {
        const item = state.images[slot.node];
        if (!item) throw new Error(`「${slot.label}」還沒上傳圖片`);
        if (!item.uploaded) {
          $('run').textContent = `上傳 ${slot.label}…`;
          item.uploaded = await uploadBlob(item.file, item.file.name || `yz_${slot.node}.png`);
        }
        setLoadImage(g, slot.node, item.uploaded);
      }
      // 局部重繪：合成遮罩 PNG 上傳
      const maskSlot = m.images.find(i => i.mask);
      if (maskSlot) {
        if (!state.mask) throw new Error('請先上傳圖片並塗抹要重繪的區域');
        $('run').textContent = '合成遮罩…';
        const blob = await buildMaskedPng();
        const up = await uploadBlob(blob, `yz_mask_${Date.now()}.png`);
        setLoadImage(g, maskSlot.node, up);
        if (m.grow) setWidgetByName(g, m.grow, 'expand', +$('grow').value || 0);
      }

      // 2) 注入文字 / 種子 / 步數
      setWidgetByName(g, m.prompt, 'text', $('prompt').value);
      const seed = parseInt($('seed').value, 10) || 0;
      setWidgetByName(g, m.seed, 'noise_seed', seed);
      const steps = parseInt($('steps').value, 10) || 4;
      setWidgetByName(g, m.steps, 'steps', steps);

      // 3) 尺寸 / 擴圖
      if (m.size) {
        const w = +$('width').value, h = +$('height').value;
        injectSize(g, m.size.latent, w, h);
        injectSize(g, m.size.scheduler, w, h);
        const batch = Math.max(1, +$('batch').value || 1);
        setWidgetByName(g, m.size.latent, 'batch_size', batch);
      }
      if (m.pad) {
        setWidgetByName(g, m.pad, 'left', +$('pad-left').value || 0);
        setWidgetByName(g, m.pad, 'right', +$('pad-right').value || 0);
        setWidgetByName(g, m.pad, 'top', +$('pad-top').value || 0);
        setWidgetByName(g, m.pad, 'bottom', +$('pad-bottom').value || 0);
        setWidgetByName(g, m.pad, 'feathering', +$('pad-feather').value || 0);
      }

      // 若 object_info 還在背景載入，最多等 1.5 秒（用於模型檢查/欄位過濾）；
      // 等不到也沒關係，workflow 的模型名已正確，用內建規則照樣能生成。
      if (!state.objectInfo && state.objectInfoPromise) {
        $('run').textContent = '準備中…';
        await Promise.race([state.objectInfoPromise, new Promise(r => setTimeout(r, 1500))]);
      }

      // 套用選擇的模型組合（UNET + CLIP 成套）到所有 loader
      const opt = $('model-set').selectedOptions[0];
      const unetSel = opt && opt.dataset.unet;
      const clipSel = opt && opt.dataset.clip;
      if (unetSel) for (const n of g.nodes.values()) if (n.type === 'UNETLoader') setWidgetByName(g, n.id, 'unet_name', unetSel);
      if (clipSel) for (const n of g.nodes.values()) if (n.type === 'CLIPLoader') setWidgetByName(g, n.id, 'clip_name', clipSel);

      // 4) 自動修正模型檔名（對不上你機器上的檔名時）
      const fixes = g.fixModelNames(state.objectInfo);
      fixes.forEach(f => log(`自動修正模型：${f.type} ${f.from} → ${f.to}`, 'warn'));

      // 5) 轉成 API prompt
      const { prompt, warnings } = g.toPrompt(state.objectInfo);
      warnings.forEach(w => log(w, 'warn'));

      // 5) 送出
      $('run').textContent = '送出中…';
      const res = await fetch(API + '/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, client_id: clientId }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        log('提交被拒：' + JSON.stringify(data.error || data, null, 2), 'err');
        if (data.node_errors) log(JSON.stringify(data.node_errors, null, 2), 'err');
        resetRunBtn();
        return;
      }
      log(`已排入佇列（prompt_id=${data.prompt_id?.slice(0, 8)}…），共 ${countNodes(prompt)} 個節點`, 'ok');
      startRun(data.prompt_id, steps, countNodes(prompt));

      // 非固定種子 → 下次自動換
      if (!$('seed-fixed').checked) $('seed').value = Math.floor(Math.random() * 1e15);
    } catch (e) {
      log('錯誤：' + e.message, 'err');
      resetRunBtn();
    }
  }

  function countNodes(p) { return Object.keys(p).length; }

  /* ---------------- 進度狀態機 ---------------- */
  function startRun(promptId, plannedSteps, totalNodes) {
    state.running = true;
    $('run').disabled = true;
    state.run = {
      promptId, plannedSteps,
      total: totalNodes || 0,          // 這次要執行的節點總數
      started: new Set(),              // 已開始執行過的節點
      cached: new Set(),               // 被快取略過的節點（等同已完成）
      curNode: null, curFrac: 0,       // 目前節點與它的內部進度(0~1)
      firstT: 0, firstV: 0, lastValue: 0, rate: 0, t0: performance.now(),
      results: [],
    };
    $('pct').textContent = '0%'; $('bar-fill').style.width = '0%';
    setRunning(true);                        // 進行中：後半段流動條紋
    setStage('已排入佇列，等待開始…');
  }

  // 進行中：在未填滿的後半段顯示流動條紋（真實進度照常顯示，不重置）
  function setRunning(on) {
    const bar = document.querySelector('.bar');
    if (bar) bar.classList.toggle('running', on);
  }

  // 整體進度 = (已完成節點 + 目前節點內部進度) ÷ 總節點數
  function updateOverall() {
    const r = state.run; if (!r || !r.total) return;
    const running = r.curNode != null ? 1 : 0;
    const completed = r.cached.size + Math.max(0, r.started.size - running);
    let frac = (completed + r.curFrac) / r.total;
    frac = Math.max(0, Math.min(0.99, frac)); // 收到「完成」訊息前不到 100%
    const pct = Math.round(frac * 100);
    $('pct').textContent = pct + '%';
    $('bar-fill').style.width = pct + '%';
  }

  function onProgress(value, max) {
    const r = state.run; if (!r) return;
    const now = performance.now();
    // 首個進度事件、或進度條重置時，重新錨定起點
    if (!r.firstT || value < r.lastValue) { r.firstT = now; r.firstV = value; }
    r.lastValue = value;
    // 取樣平均 it/s：自第一個進度事件以來 (步數 ÷ 秒)，與 ComfyUI 主控台一致
    const elapsed = (now - r.firstT) / 1000;
    if (elapsed > 0 && value > r.firstV) r.rate = (value - r.firstV) / elapsed;

    r.curFrac = max ? (value / max) : 0;   // 目前節點的內部進度
    updateOverall();                        // 主進度條以節點為準
    $('m-step').innerHTML = `${value}<small> / ${max}</small>`;

    if (r.rate > 0) {
      $('m-speed').innerHTML = r.rate >= 1
        ? `${r.rate.toFixed(2)}<small> it/s</small>`
        : `${(1 / r.rate).toFixed(2)}<small> s/it</small>`;
      const remain = Math.max(0, (max - value)) / r.rate;
      $('m-eta').textContent = fmtTime(remain);
    }
  }

  function finishRun(ok = true) {
    const r = state.run;
    state.running = false;
    resetRunBtn();
    setRunning(false);                       // 結束：停掉流動條紋
    if (!r) return;
    const total = (performance.now() - r.t0) / 1000;
    if (ok) {
      $('pct').textContent = '100%'; $('bar-fill').style.width = '100%';
      setStage(`完成 · 耗時 ${fmtTime(total)}`);
      log(`✅ 完成，耗時 ${fmtTime(total)}`, 'ok');
      if ($('opt-sound').checked) beep();
      if ($('opt-notify').checked) notify('生成完成', `${MODES[state.mode].label} · ${fmtTime(total)}`);
    }
    state.run = null;
  }

  function resetRunBtn() { $('run').disabled = false; $('run').textContent = '生成'; $('run-loader').classList.remove('on'); }
  function setStage(t) { $('stage').textContent = t; }

  /* ---------------- WebSocket ---------------- */
  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?clientId=${clientId}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => setConn(true);
    ws.onclose = () => { setConn(false); setTimeout(connectWS, 2000); };
    ws.onerror = () => setConn(false);
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { onPreviewBinary(ev.data); return; }
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      handleWS(msg);
    };
  }

  function handleWS(msg) {
    const d = msg.data || {};
    switch (msg.type) {
      case 'status': {
        const q = d.status?.exec_info?.queue_remaining;
        if (q != null) $('conn-text').textContent = `已連線 · 佇列 ${q}`;
        break;
      }
      case 'execution_start':
        if (state.run) { setStage('開始執行…'); }
        break;
      case 'execution_cached':
        if (state.run && Array.isArray(d.nodes)) {
          d.nodes.forEach(n => state.run.cached.add(String(n)));
          updateOverall();
        }
        break;
      case 'executing':
        if (d.node == null && d.prompt_id === state.run?.promptId) {
          finishRun(true);
        } else if (d.node != null && state.run) {
          const r = state.run;
          r.started.add(String(d.node));
          r.curNode = String(d.node);
          r.curFrac = 0;
          const cls = classOfNode(d.node);
          const done = r.cached.size + Math.max(0, r.started.size - 1);
          setStage(`執行中：${cls || d.node}` + (r.total ? ` (節點 ${Math.min(done + 1, r.total)}/${r.total})` : ''));
          updateOverall();
        }
        break;
      case 'progress':
        onProgress(d.value, d.max);
        break;
      case 'executed':
        if (d.output && d.output.images) addResults(d.output.images);
        break;
      case 'execution_error':
        log('❌ 執行錯誤：' + (d.exception_message || JSON.stringify(d)), 'err');
        if (d.node_type) log(`  在節點：${d.node_type} (${d.node_id})`, 'err');
        finishRun(false);
        setStage('發生錯誤');
        break;
      case 'execution_interrupted':
        log('已中斷。', 'warn'); finishRun(false); setStage('已中斷');
        break;
    }
  }

  function classOfNode(nodeId) {
    const n = state.workflow.nodes.find(x => String(x.id) === String(nodeId));
    return n ? n.type : null;
  }

  function onPreviewBinary(buf) {
    if (!$('opt-preview').checked) return;
    const view = new DataView(buf);
    const evType = view.getUint32(0);
    if (evType !== 1) return; // 1 = PREVIEW_IMAGE
    const imgType = view.getUint32(4); // 1=jpeg, 2=png
    const mime = imgType === 2 ? 'image/png' : 'image/jpeg';
    const blob = new Blob([buf.slice(8)], { type: mime });
    const url = URL.createObjectURL(blob);
    $('preview-live').classList.add('on');
    const img = $('preview-img');
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    img.src = url; img.dataset.url = url;
  }

  function addResults(images) {
    const gal = $('gallery');
    for (const im of images) {
      if (im.type === 'temp') continue; // 只收最終輸出
      const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder || '', type: im.type || 'output' });
      const url = API + '/view?' + q.toString();
      const cell = document.createElement('div');
      cell.className = 'result';
      cell.innerHTML = `<img src="${url}" alt=""><a class="dl" href="${url}" download="${im.filename}">下載</a>`;
      cell.querySelector('img').onclick = () => openLightbox(url);
      gal.insertBefore(cell, gal.firstChild);
    }
  }

  /* ---------------- 雜項 UI ---------------- */
  function bindGlobalControls() {
    $('run').onclick = generate;
    $('seed-rand').onclick = () => $('seed').value = Math.floor(Math.random() * 1e15);
    $('interrupt').onclick = async () => {
      try { await fetch(API + '/interrupt', { method: 'POST' }); log('已送出中斷指令', 'warn'); }
      catch (e) { log('中斷失敗：' + e, 'err'); }
    };
    $('opt-notify').onchange = () => {
      if ($('opt-notify').checked && Notification && Notification.permission === 'default') Notification.requestPermission();
    };
    $('lightbox').onclick = () => $('lightbox').classList.remove('on');
  }

  function openLightbox(url) { $('lightbox-img').src = url; $('lightbox').classList.add('on'); }
  function setConn(on) {
    $('conn-dot').className = 'dot ' + (on ? 'on' : 'off');
    if (!on) $('conn-text').textContent = '未連線（重試中…）';
    else if ($('conn-text').textContent.startsWith('連線')) $('conn-text').textContent = '已連線';
  }

  function fmtTime(sec) {
    if (!isFinite(sec)) return '–';
    sec = Math.round(sec);
    const mm = Math.floor(sec / 60), ss = sec % 60;
    return mm > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : `${ss}s`;
  }

  function log(text, cls) {
    const el = $('log');
    const t = new Date().toLocaleTimeString('zh-Hant', { hour12: false });
    const line = document.createElement('div');
    if (cls) line.className = 'l-' + cls;
    line.innerHTML = `<span class="t">${t}</span>  ${escapeHtml(text)}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  // 完成音效（WebAudio 合成，不需外部檔案）
  function beep() {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const notes = [660, 880, 1180];
      notes.forEach((f, i) => {
        const o = ac.createOscillator(), gv = ac.createGain();
        o.type = 'sine'; o.frequency.value = f;
        o.connect(gv); gv.connect(ac.destination);
        const t = ac.currentTime + i * 0.12;
        gv.gain.setValueAtTime(0, t);
        gv.gain.linearRampToValueAtTime(0.25, t + 0.02);
        gv.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        o.start(t); o.stop(t + 0.24);
      });
    } catch (e) {}
  }
  function notify(title, body) {
    try { if (Notification && Notification.permission === 'granted') new Notification(title, { body }); } catch (e) {}
  }

  init();
})();
