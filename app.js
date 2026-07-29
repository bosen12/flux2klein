/* app.js —— 面板主邏輯：模式表單、上傳、遮罩畫布、送出、WebSocket 即時進度 */
(() => {
  const { WorkflowGraph, MODES, MODE_ORDER, setWidgetByName, injectSize, setLoadImage } = window.YZ;

  const $ = (id) => document.getElementById(id);
  const API = location.origin;                 // 同源，經由 serve.py 代理到 ComfyUI
  const clientId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

  const state = {
    engine: 'flux2klein',   // 'flux2klein' | 'zimage'
    workflow: null,         // Flux2 UI workflow
    zTemplates: {},         // Z-Image API 工作流範本
    objectInfo: null,
    mode: 't2i',
    images: {},          // nodeId -> { file, uploaded, url }
    mask: null,          // 局部重繪用：{ img, strokeCanvas, viewCanvas, w, h }
    running: false,
    // 進度計時
    run: null,
  };

  // 兩個引擎的品牌與主題資訊
  const ENGINES = {
    flux2klein: { title: 'Flux2 Klein 面板', sub: '文生圖 / 單雙三圖編輯 / 局部重繪 / 圖像擴展' },
    zimage:     { title: 'Z-Image Turbo 面板', sub: '文生圖 / ControlNet 邊緣參考' },
    krea2:      { title: 'Krea2 面板', sub: '文生圖（可選 SeedVR2 / 二次採樣）' },
    illustrious:{ title: 'Illustrious 面板', sub: 'SDXL 文生圖（可選放大）' },
  };
  const Z = window.YZ_Z, K = window.YZ_K, I = window.YZ_I;
  const ENG = { zimage: Z, krea2: K, illustrious: I };   // API 格式引擎設定
  const currentModes = () => ENG[state.engine] ? ENG[state.engine].MODES : MODES;
  const currentOrder = () => ENG[state.engine] ? ENG[state.engine].MODE_ORDER : MODE_ORDER;

  // 頁面切換過渡：淡入 + 微幅上移（僅動 opacity/transform → 不觸發 reflow、無版面跳動、不影響捲軸）
  const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // el.animate() 產生的 Animation 不會自動釋放，每切換一次就在元素上累積一個。
  // 開播前先取消同一元素上舊的腳本動畫（animationName 有值的是 CSS 動畫，不要動）。
  function cancelScriptAnims(el) {
    if (!el.getAnimations) return;
    el.getAnimations().forEach(a => { if (!a.animationName) a.cancel(); });
  }

  function animateSwitch(el, dy = 6) {
    if (!el || prefersReduced || !el.animate) return;
    cancelScriptAnims(el);
    el.animate(
      [{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 240, easing: 'cubic-bezier(.22,.61,.36,1)' }
    );
  }

  // 引擎切換器：滑動膠囊移到目前選中的按鈕
  let pillReady = false;
  function movePill() {
    const sw = $('engine-switch'), pill = $('engine-pill');
    const active = sw && sw.querySelector('button.active');
    if (!sw || !pill || !active) return;
    if (!pillReady) pill.style.transition = 'none';   // 首次定位不要滑入
    pill.style.width = active.offsetWidth + 'px';
    pill.style.transform = `translateX(${active.offsetLeft}px)`;
    if (!pillReady) { void pill.offsetWidth; pill.style.transition = ''; pillReady = true; }
  }

  // 流動背景：三顆色團在畫面內隨機漂移 + 撞邊反彈（用 transform，GPU 合成、省效能）
  function startBgFx() {
    const blobs = [...document.querySelectorAll('.bg-fx .blob')];
    if (!blobs.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const SPD = 0.00007;                       // 佔畫面比例 / 毫秒（很慢的飄移）
    const rndVel = () => { const a = Math.random() * Math.PI * 2, m = SPD * (0.5 + Math.random()); return [Math.cos(a) * m, Math.sin(a) * m]; };
    const st = blobs.map(el => { const [vx, vy] = rndVel(); return { el, x: Math.random(), y: Math.random(), vx, vy, hw: el.offsetWidth / 2, hh: el.offsetHeight / 2 }; });
    addEventListener('resize', () => st.forEach(s => { s.hw = s.el.offsetWidth / 2; s.hh = s.el.offsetHeight / 2; }));
    let prev = performance.now();
    (function tick(t) {
      const dt = Math.min(50, t - prev); prev = t;
      const vw = innerWidth, vh = innerHeight;
      for (const s of st) {
        s.x += s.vx * dt; s.y += s.vy * dt;
        if (s.x < 0 || s.x > 1) { const [nx, ny] = rndVel(); s.vx = (s.x < 0 ? 1 : -1) * Math.abs(nx); s.vy = ny; s.x = Math.max(0, Math.min(1, s.x)); }
        if (s.y < 0 || s.y > 1) { const [nx, ny] = rndVel(); s.vy = (s.y < 0 ? 1 : -1) * Math.abs(ny); s.vx = nx; s.y = Math.max(0, Math.min(1, s.y)); }
        s.el.style.transform = `translate(${(s.x * vw - s.hw).toFixed(1)}px, ${(s.y * vh - s.hh).toFixed(1)}px)`;
      }
      requestAnimationFrame(tick);
    })(prev);
  }

  // 模式分頁的滑動膠囊。分頁會換行，所以 X 與 Y 都要補間（引擎切換器只需要 X）。
  // animate 只在使用者點擊切換時給 true；版面或字體造成的校正一律瞬移，
  // 否則字體載入完的那次重算會讓膠囊自己飄一段，看起來像 bug。
  function moveTabPill(animate) {
    const tabs = $('tabs'), pill = $('tab-pill');
    const active = tabs && tabs.querySelector('.tab.active');
    if (!tabs || !pill || !active) return;
    if (!animate) pill.style.transition = 'none';
    pill.style.width = active.offsetWidth + 'px';
    pill.style.height = active.offsetHeight + 'px';
    pill.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    if (!animate) { void pill.offsetWidth; pill.style.transition = ''; }
  }

  // 中文字體載入、左欄寬度改變、分頁換行都會改變膠囊該在的位置。
  // 單一個 rAF 等不到字體就緒（初次會量到分頁被擠窄、文字折行時的尺寸），改用 ResizeObserver。
  let tabRO = null;
  function observeTabs() {
    const tabs = $('tabs');
    if (!tabs || !window.ResizeObserver) return;
    if (tabRO) tabRO.disconnect();
    tabRO = new ResizeObserver(() => moveTabPill());
    tabRO.observe(tabs);                                     // 換行造成的容器高度變化
    tabs.querySelectorAll('.tab').forEach(t => tabRO.observe(t));  // 字體造成的分頁尺寸變化
  }

  // 手機橫向捲動時，把選中的引擎按鈕捲到中央
  function scrollActiveEngineIntoView() {
    const sw = $('engine-switch');
    const active = sw && sw.querySelector('button.active');
    if (!sw || !active || sw.scrollWidth <= sw.clientWidth) return;
    const left = active.offsetLeft - (sw.clientWidth - active.offsetWidth) / 2;
    sw.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  }

  /* ---------------- 初始化 ---------------- */
  async function init() {
    log('載入 workflow…');
    try {
      state.workflow = await fetch('workflow.json').then(r => r.json());
    } catch (e) { log('無法載入 workflow.json：' + e, 'err'); return; }

    // Z-Image / Krea2 的 API 工作流（小檔）
    try {
      const [t2i, cn, kr, il] = await Promise.all([
        fetch('zimage_t2i.json').then(r => r.json()),
        fetch('zimage_controlnet.json').then(r => r.json()),
        fetch('krea2.json').then(r => r.json()),
        fetch('illustrious.json').then(r => r.json()),
      ]);
      state.zTemplates = { 'zimage_t2i.json': t2i, 'zimage_controlnet.json': cn, 'krea2.json': kr, 'illustrious.json': il };
    } catch (e) { log('無法載入 API 工作流（多半是 serve.py 是舊版）：請重啟面板 stop_panel.bat → start.bat。' + e, 'err'); }

    // 先把畫面渲染出來（不等 object_info），手機/遠端才不會卡在白畫面
    bindGlobalControls();
    bindEngineSwitch();
    selectEngine('flux2klein');
    connectWS();
    startBgFx();

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
    tabPillReady = false;          // 換引擎重建分頁，膠囊不要從舊座標滑過來
    const pill = document.createElement('span');
    pill.className = 'tab-pill'; pill.id = 'tab-pill';
    tabs.appendChild(pill);
    const modes = currentModes();
    for (const key of currentOrder()) {
      const b = document.createElement('button');
      b.className = 'tab' + (key === state.mode ? ' active' : '');
      b.textContent = modes[key].label;
      b.onclick = () => selectMode(key);
      tabs.appendChild(b);
    }
    moveTabPill();
    observeTabs();   // 之後的校正交給 ResizeObserver（observe 當下就會先觸發一次）
  }

  // 讀某模式的預設提示詞 / 步數（兩個引擎來源不同）
  function modeDefaults(m) {
    if (state.engine !== 'flux2klein') {   // Z-Image / Krea2：從 API 範本讀
      const tpl = state.zTemplates[m.template] || {};
      const p = tpl[m.nodes.prompt], k = tpl[m.nodes.ksampler];
      return { prompt: p ? (p.inputs.text || '') : '', steps: k ? k.inputs.steps : null };
    }
    const node = state.workflow.nodes.find(n => n.id === m.prompt);
    const sched = state.workflow.nodes.find(n => n.id === m.steps);
    return {
      prompt: (node && Array.isArray(node.widgets_values)) ? (node.widgets_values[0] || '') : '',
      steps: (sched && Array.isArray(sched.widgets_values)) ? sched.widgets_values[0] : null,
    };
  }

  function selectMode(key) {
    state.mode = key;
    try {
    const order = currentOrder();
    const m = currentModes()[key];
    document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', order[i] === key));
    moveTabPill(true);   // 使用者點擊：滑過去
    $('mode-desc').textContent = m.desc;

    const d = modeDefaults(m);
    $('prompt').value = d.prompt;
    if (d.steps != null) $('steps').value = d.steps;
    $('prompt-hint').textContent = m.images.length >= 2 ? '可用「圖1 / 圖2 / 圖3」指涉各張圖' : '';

    // 圖片上傳區
    buildUploads(m);

    // 各模式專屬欄位顯示切換（整批改，交給下面的 animateSwitch 統一淡入）
    suppressReveal = true;
    show('images-field', m.images.length > 0 && !(m.images.length === 1 && m.images[0].mask));
    show('mask-field', m.images.some(i => i.mask));
    show('size-field', !!m.size);
    show('pad-field', !!m.pad);
    show('batch', !!m.size && state.engine === 'flux2klein', true);
    const eng = ENG[state.engine];
    if (eng && eng.enhance) buildEnhance(eng, m);
    show('enhance-field', !!(eng && eng.enhance));      // Krea2 / Illustrious 的增強卡片
    show('model-field', !(eng && eng.enhance));         // 有增強的引擎皆為單一固定模型，隱藏下拉
    suppressReveal = false;
    $('images-hint').textContent = `需 ${m.images.filter(i => !i.mask).length} 張`;

    if (m.size) buildAspectPresets();
    state.images = {}; // 換模式清空已選圖
    state.mask = null;
    animateSwitch($('form'));   // 切換模式：表單淡入
    } catch (err) { suppressReveal = false; log('切換模式錯誤：' + err.message, 'err'); console.error(err); }
  }

  /* ---------------- 引擎切換 ---------------- */
  function bindEngineSwitch() {
    document.querySelectorAll('#engine-switch button').forEach(b => {
      b.onclick = () => selectEngine(b.dataset.engine);
    });
    window.addEventListener('resize', movePill);
    // 手動改寬高 → 取消長寬比 chip 的選中
    ['width', 'height'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('input', () => document.querySelectorAll('#aspect-presets .aspect.active').forEach(x => x.classList.remove('active')));
    });
  }

  function selectEngine(engine) {
    if (!ENGINES[engine]) return;
    // 引擎設定檔沒載入 → 通常是 serve.py 是舊版沒提供該 .js。清楚報錯而不半殘。
    if (engine !== 'flux2klein' && !ENG[engine]) {
      log(`${ENGINES[engine].title} 尚未就緒：請重啟面板（stop_panel.bat → start.bat）並 Ctrl+Shift+R`, 'err');
      document.querySelectorAll('#engine-switch button').forEach(b => b.classList.toggle('active', b.dataset.engine === state.engine));
      movePill();
      return;
    }
    freezeLogoColor();                              // 抓舊色，必須在 dataset 改變之前
    state.engine = engine;
    document.documentElement.dataset.engine = engine;
    riseLogoWater();                                // 新色從底部漲上來
    const e = ENGINES[engine];
    const bt = $('brand-title');
    bt.textContent = e.title;
    bt.classList.remove('sweep'); void bt.offsetWidth; bt.classList.add('sweep');   // 標題漸層掃過過渡
    bt.addEventListener('animationend', () => bt.classList.remove('sweep'), { once: true });
    $('brand-sub').textContent = e.sub;
    document.querySelectorAll('#engine-switch button').forEach(b => b.classList.toggle('active', b.dataset.engine === engine));
    movePill();
    requestAnimationFrame(movePill);   // 佈局/字體就緒後再校正一次
    scrollActiveEngineIntoView();
    buildModelOptions();
    state.mode = currentOrder()[0];
    buildTabs();
    selectMode(state.mode);        // 內含表單淡入
    animateSwitch($('tabs'), 0);   // 分頁列淡入
    // 品牌區刻意不做淡入位移：logo 靠水位漲上來換色，位置保持不動
  }

  /* ---------- logo 換色：裝水 ---------- */
  // 分成兩步是因為底層要顯示「舊色」、水層要顯示「新色」，
  // 而兩者都來自 var(--accent)，所以必須在 dataset.engine 改變前先把舊色凍進 inline style。
  function freezeLogoColor() {
    const logo = $('brand-logo');
    if (!logo || prefersReduced) return;
    const cs = getComputedStyle(document.documentElement);
    const a = cs.getPropertyValue('--accent').trim();
    const b = cs.getPropertyValue('--accent-2').trim();
    logo.style.background = `linear-gradient(140deg, ${a}, ${b})`;
  }

  function riseLogoWater() {
    const logo = $('brand-logo'), fill = $('logo-fill');
    if (!logo || !fill) return;
    if (prefersReduced || !fill.animate) { logo.style.background = ''; return; }
    // 用 WAAPI 而非 CSS class：連續切換時 remove→reflow→add 無法可靠重啟動畫
    // （實測第二次之後連 animationstart 都不會觸發），finished promise 則穩定得多。
    cancelScriptAnims(fill);
    const anim = fill.animate(
      // 起點要跟 CSS 的靜止位置一致，否則液面橢圓會先閃一下才開始漲
      [{ transform: 'translateY(calc(100% + 8px))' }, { transform: 'translateY(0)' }],
      { duration: 500, easing: 'cubic-bezier(.42,0,.22,1)', fill: 'forwards' }
    );
    const settle = () => {
      logo.style.background = '';   // 底層交還給 var()，此時已是新色
      anim.cancel();                // 水位歸零，等下一次
    };
    anim.finished.then(settle).catch(() => {});   // 被下一次切換取消會 reject，忽略即可
    // 保險：分頁在背景時 rAF 不觸發、動畫不前進，finished 永遠不會結算，
    // 沒有這道 logo 會卡在舊色。settle 重複呼叫是無害的。
    setTimeout(settle, 1000);
  }

  // 依引擎重建「模型」下拉
  function buildModelOptions() {
    const sel = $('model-set');
    sel.innerHTML = '';
    const add = (value, label, unet, clip) => {
      const o = document.createElement('option');
      o.value = value; o.textContent = label;
      if (unet) o.dataset.unet = unet;
      if (clip) o.dataset.clip = clip;
      sel.appendChild(o);
    };
    if (state.engine === 'zimage') {
      for (const mo of Z.MODELS) add(mo.value, mo.label);
      sel.value = Z.MODELS[0].value;                       // 預設 pornmaster V35 Fp8
    } else if (state.engine === 'krea2') {
      add(K.UNET, 'redcraft 30Krea2');                     // 單一固定（欄位隱藏，僅備援）
      sel.value = K.UNET;
    } else if (state.engine === 'illustrious') {
      add(I.CKPT, 'waiIllustrious v170');
      sel.value = I.CKPT;
    } else {
      add('9b-mixed', 'Klein 9B · qwen_3_8b_fp8mixed', 'fluxKleinFP8_flux2Klein9bFp8.safetensors', 'qwen_3_8b_fp8mixed.safetensors');
      add('9b', 'Klein 9B · qwen_3_8b', 'fluxKleinFP8_flux2Klein9bFp8.safetensors', 'qwen_3_8b.safetensors');
      add('4b', 'Klein 4B · qwen_3_4b_fp8_mixed', 'flux-2-klein-4b.safetensors', 'qwen_3_4b_fp8_mixed.safetensors');
      sel.value = '4b';                                    // 預設 4B
    }
  }

  // 切換模式時會一次改十幾個欄位，那時由 form 統一淡入，個別欄位不要各播各的
  let suppressReveal = false;

  function show(id, on, isField = false) {
    const el = isField ? $(id).closest('.field') : $(id);
    if (!el) return;
    const wasVisible = el.style.display !== 'none';
    el.style.display = on ? '' : 'none';
    // 只有「從隱藏變顯示」才播；隱藏用瞬間收掉，硬收比硬開自然得多
    if (on && !wasVisible && !suppressReveal) revealAnim(el);
  }

  function revealAnim(el) {
    if (prefersReduced || !el.animate) return;
    cancelScriptAnims(el);
    el.animate(
      [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 260, easing: 'cubic-bezier(.22,.61,.36,1)' }
    );
  }

  /* ---------------- 圖片上傳 UI ---------------- */
  // 產生一個上傳框（存入 state.images[slot.node]）
  function makeDrop(slot) {
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
    return d;
  }

  function buildUploads(m) {
    const wrap = $('uploads');
    wrap.innerHTML = '';
    for (const slot of m.images.filter(i => !i.mask)) wrap.appendChild(makeDrop(slot));
    const maskSlot = m.images.find(i => i.mask);
    if (maskSlot) setupMaskUpload(maskSlot);
  }

  // 依引擎設定動態建立增強卡片（Krea2 / Illustrious）
  function buildEnhance(E, m) {
    const list = $('enhance-list'); list.innerHTML = '';
    let hasRef = false;
    for (const e of E.enhance) {
      const card = document.createElement('label');
      card.className = 'enh';
      card.innerHTML = `<input type="checkbox" id="enh-${e.key}"><span class="enh-body"><span class="enh-top"><span class="enh-name">${e.name}</span><span class="enh-sw"></span></span><span class="enh-desc">${e.desc}</span></span>`;
      const cb = card.querySelector('input');
      cb.addEventListener('change', () => {
        card.classList.toggle('on', cb.checked);
        if (e.requiresRef) show('ref-upload', cb.checked);
      });
      list.appendChild(card);
      if (e.requiresRef) hasRef = true;
    }
    // ControlNet 參考圖上傳（需要時才顯示）
    show('ref-upload', false);
    const refBox = $('uploads-ref'); refBox.innerHTML = '';
    if (hasRef && m.nodes.ref) refBox.appendChild(makeDrop({ node: 'ref', label: '參考圖' }));
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
    const curW = +$('width').value, curH = +$('height').value;
    for (const [name, w, h] of presets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'aspect';
      // 依比例畫一個迷你方框（長邊 16px）
      const long = 16, ratio = w / h;
      const bw = ratio >= 1 ? long : Math.round(long * ratio);
      const bh = ratio >= 1 ? Math.round(long / ratio) : long;
      b.innerHTML = `<span class="ar-box" style="width:${bw}px;height:${bh}px"></span><span>${name}</span>`;
      if (curW === w && curH === h) b.classList.add('active');
      b.onclick = () => {
        $('width').value = w; $('height').value = h;
        box.querySelectorAll('.aspect').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      };
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
    $('run').dataset.state = 'loading';    // 按鈕本體：spinner 滑入
    show('compare-card', false); $('compare').innerHTML = '';   // 清掉上次對照
    const m = currentModes()[state.mode];
    try {
      if (state.engine === 'zimage') await runZImage(m);
      else if (state.engine === 'krea2') await runEnhanceEngine(m, K);
      else if (state.engine === 'illustrious') await runEnhanceEngine(m, I);
      else await runFlux2(m);
    } catch (e) {
      log('錯誤：' + e.message, 'err');
      resetRunBtn();
    }
  }

  /* ---------------- 增強引擎送出（Krea2 / Illustrious 共用）---------------- */
  async function runEnhanceEngine(m, E) {
    const tpl = JSON.parse(JSON.stringify(state.zTemplates[m.template] || {}));
    if (!Object.keys(tpl).length) throw new Error('工作流未載入');
    const nd = m.nodes;
    // 固定模型（有哪個設哪個）
    if (E.CKPT && tpl[nd.ckpt]) tpl[nd.ckpt].inputs.ckpt_name = E.CKPT;
    if (E.UNET && tpl[nd.unet]) tpl[nd.unet].inputs.unet_name = E.UNET;
    if (E.CLIP && tpl[nd.clip]) tpl[nd.clip].inputs.clip_name = E.CLIP;
    if (E.VAE && tpl[nd.vae]) tpl[nd.vae].inputs.vae_name = E.VAE;
    // 提示詞 / 種子 / 步數
    if (tpl[nd.prompt]) tpl[nd.prompt].inputs.text = $('prompt').value;
    const seed = parseInt($('seed').value, 10) || 0;
    const steps = parseInt($('steps').value, 10) || (tpl[nd.ksampler] ? tpl[nd.ksampler].inputs.steps : 20);
    if (tpl[nd.ksampler]) { tpl[nd.ksampler].inputs.seed = seed; tpl[nd.ksampler].inputs.steps = steps; }
    // 尺寸
    if (m.size && tpl[nd.latent]) {
      tpl[nd.latent].inputs.width = +$('width').value || 1024;
      tpl[nd.latent].inputs.height = +$('height').value || 1024;
    }
    // 增強開關
    const on = {};
    for (const e of E.enhance) on[e.key] = !!($('enh-' + e.key) && $('enh-' + e.key).checked);
    for (const e of E.enhance) if (e.requires && on[e.key]) on[e.requires] = true;
    // 放大節點：hires 關時改接 base VAEDecode 輸出
    if (!on.hires) {
      for (const e of E.enhance) {
        if (!on[e.key] || !e.imageNode) continue;
        const node = tpl[e.imageNode];
        if (node && node.inputs.image && node.inputs.image[0] === '78:57')
          node.inputs.image = ['77:76', 0];
      }
    }
    // 各開啟分支：種子跟隨 + 參考圖上傳
    for (const e of E.enhance) {
      if (!on[e.key]) continue;
      if (e.seedFollow && tpl[e.seedFollow]) tpl[e.seedFollow].inputs.seed = seed;
      if (e.requiresRef && nd.ref) {
        const item = state.images['ref'];
        if (!item) throw new Error(`「${e.name}」需要先上傳參考圖`);
        if (!item.uploaded) { $('run').textContent = '上傳參考圖…'; item.uploaded = await uploadBlob(item.file, item.file.name || `ref_${Date.now()}.png`); }
        const up = item.uploaded;
        if (tpl[nd.ref]) tpl[nd.ref].inputs.image = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
      }
    }
    // 裁剪：關閉的分支移除；一律移除的節點（比較節點等）移除
    const enhLog = E.enhance.map(e => `${e.name}=${on[e.key] ? '開' : '關'}`).join('、');
    log(`增強：${enhLog}`, 'info');
    const deleted = [];
    for (const e of E.enhance) if (!on[e.key]) for (const id of e.branch) { delete tpl[id]; deleted.push(id); }
    for (const id of (E.alwaysDelete || [])) { delete tpl[id]; deleted.push(id); }
    log(`已移除節點：${deleted.join(', ')}`, 'info');
    log(`送出節點：${Object.keys(tpl).join(', ')}`, 'info');
    // 送出
    $('run').textContent = '送出中…';
    const res = await fetch(API + '/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: tpl, client_id: clientId }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      log('提交被拒：' + JSON.stringify(data.error || data, null, 2), 'err');
      if (data.node_errors) log(JSON.stringify(data.node_errors, null, 2), 'err');
      resetRunBtn();
      return;
    }
    log(`已排入佇列（prompt_id=${data.prompt_id?.slice(0, 8)}…），共 ${countNodes(tpl)} 個節點`, 'ok');
    startRun(data.prompt_id, steps, countNodes(tpl));
    state.run.compare = { E, on, images: {} };   // 收集輸出做對照
    if (!$('seed-fixed').checked) $('seed').value = Math.floor(Math.random() * 1e15);
  }

  async function runFlux2(m) {
    const g = WorkflowGraph.clone(state.workflow);
    g.applyMode(m.group);
    {
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
    }
  }

  /* ---------------- Z-Image Turbo 送出（API 工作流直接注入）---------------- */
  async function runZImage(m) {
    const tpl = JSON.parse(JSON.stringify(state.zTemplates[m.template] || {}));
    if (!Object.keys(tpl).length) throw new Error('Z-Image 工作流未載入');
    const nd = m.nodes;
    // 模型 / CLIP / VAE（三個模型共用固定 CLIP、VAE）
    const model = $('model-set').value;
    if (tpl[nd.unet]) tpl[nd.unet].inputs.unet_name = model;
    if (tpl[nd.clip]) tpl[nd.clip].inputs.clip_name = Z.CLIP;
    if (tpl[nd.vae]) tpl[nd.vae].inputs.vae_name = Z.VAE;
    // 提示詞 / 種子 / 步數
    if (tpl[nd.prompt]) tpl[nd.prompt].inputs.text = $('prompt').value;
    const seed = parseInt($('seed').value, 10) || 0;
    const steps = parseInt($('steps').value, 10) || 8;
    if (tpl[nd.ksampler]) { tpl[nd.ksampler].inputs.seed = seed; tpl[nd.ksampler].inputs.steps = steps; }
    // 尺寸（文生圖：直接寫入 EmptySD3LatentImage）
    if (m.size && tpl[nd.latent]) {
      tpl[nd.latent].inputs.width = +$('width').value || 1024;
      tpl[nd.latent].inputs.height = +$('height').value || 1024;
    }
    // 參考圖（ControlNet）
    for (const slot of m.images) {
      const item = state.images[slot.node];
      if (!item) throw new Error(`「${slot.label}」還沒上傳圖片`);
      if (!item.uploaded) {
        $('run').textContent = `上傳 ${slot.label}…`;
        item.uploaded = await uploadBlob(item.file, item.file.name || `zimg_${Date.now()}.png`);
      }
      const up = item.uploaded;
      if (tpl[slot.node]) tpl[slot.node].inputs.image = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
    }
    // 送出
    $('run').textContent = '送出中…';
    const res = await fetch(API + '/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: tpl, client_id: clientId }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      log('提交被拒：' + JSON.stringify(data.error || data, null, 2), 'err');
      if (data.node_errors) log(JSON.stringify(data.node_errors, null, 2), 'err');
      resetRunBtn();
      return;
    }
    log(`已排入佇列（prompt_id=${data.prompt_id?.slice(0, 8)}…），共 ${countNodes(tpl)} 個節點`, 'ok');
    startRun(data.prompt_id, steps, countNodes(tpl));
    if (!$('seed-fixed').checked) $('seed').value = Math.floor(Math.random() * 1e15);
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
      peakFrac: 0, tiles: 0,           // 進度條只進不退 + 分塊計數
      firstT: 0, firstV: 0, lastValue: 0, rate: 0, t0: performance.now(),
      results: [],
    };
    $('progress-card').classList.remove('idle');   // 首次生成後就不再回到閒置外觀
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
    frac = Math.max(0, Math.min(0.99, frac));
    r.peakFrac = Math.max(r.peakFrac, frac);  // 只進不退
    frac = r.peakFrac;
    const pct = Math.round(frac * 100);
    $('pct').textContent = pct + '%';
    $('bar-fill').style.width = pct + '%';
  }

  function onProgress(value, max) {
    const r = state.run; if (!r) return;
    const now = performance.now();

    // 偵測分塊重置：progress value 回跳代表上一塊已完成
    if (r.lastValue > 0 && value < r.lastValue) {
      r.tiles++;
      const remaining = 0.99 - r.peakFrac;
      r.peakFrac = Math.min(r.peakFrac + remaining * 0.08, 0.99);
    }

    if (!r.firstT || value < r.lastValue) { r.firstT = now; r.firstV = value; }
    r.lastValue = value;
    const elapsed = (now - r.firstT) / 1000;
    if (elapsed > 0 && value > r.firstV) r.rate = (value - r.firstV) / elapsed;

    r.curFrac = max ? (value / max) : 0;
    updateOverall();

    if (r.tiles > 0) {
      $('m-step').innerHTML = `第${r.tiles + 1}塊 ${value}<small> / ${max}</small>`;
    } else {
      $('m-step').innerHTML = `${value}<small> / ${max}</small>`;
    }

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
      // 按鈕本體：spinner 化成打勾、文字暫顯「完成」，約 1.3 秒後復原
      $('run').textContent = '完成'; $('run').dataset.state = 'done';
      clearTimeout(state._doneT);
      state._doneT = setTimeout(() => {
        if (!state.running) { $('run').textContent = '生成'; $('run').dataset.state = 'idle'; }
      }, 1300);
      $('pct').textContent = '100%'; $('bar-fill').style.width = '100%';
      setStage(`完成 · 耗時 ${fmtTime(total)}`);
      log(`✅ 完成，耗時 ${fmtTime(total)}`, 'ok');
      if (r.compare) buildCompare(r.compare);
      if ($('opt-sound').checked) beep();
      if ($('opt-notify').checked) { const mm = currentModes()[state.mode]; notify('生成完成', `${(mm && mm.label) || ''} · ${fmtTime(total)}`); }
    }
    state.run = null;
  }

  /* ---------------- 前後對照拉桿 ---------------- */
  function viewUrl(im) {
    const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder || '', type: im.type || 'output' });
    return API + '/view?' + q.toString();
  }

  function makeCompareSlider(beforeUrl, afterUrl, labelB, labelA) {
    const el = document.createElement('div');
    el.className = 'cmp';
    el.innerHTML =
      `<img class="cmp-a" src="${afterUrl}" alt="">` +
      `<img class="cmp-b" src="${beforeUrl}" alt="">` +
      `<div class="cmp-divider"></div>` +
      `<span class="cmp-tag cmp-tag-b">${labelB}</span>` +
      `<span class="cmp-tag cmp-tag-a">${labelA}</span>`;
    const before = el.querySelector('.cmp-b'), divider = el.querySelector('.cmp-divider');
    const set = p => { p = Math.max(0, Math.min(100, p)); before.style.clipPath = `inset(0 ${100 - p}% 0 0)`; divider.style.left = p + '%'; };
    set(50);
    const move = e => { const r = el.getBoundingClientRect(); set(((e.touches ? e.touches[0].clientX : e.clientX) - r.left) / r.width * 100); };
    let drag = false, didDrag = false;
    el.addEventListener('pointerdown', e => { drag = true; didDrag = false; move(e); });
    window.addEventListener('pointermove', e => { if (drag) { didDrag = true; move(e); } });
    window.addEventListener('pointerup', () => drag = false);
    el.addEventListener('click', () => { if (!didDrag) openCompareOverlay(beforeUrl, afterUrl, labelB, labelA, el); });
    return el;
  }

  // 目前開啟中的對照 overlay 的關閉函式（供全域 Esc 使用）
  let activeOverlayClose = null;

  function openCompareOverlay(beforeUrl, afterUrl, labelB, labelA, sourceEl) {
    const overlay = document.createElement('div');
    overlay.className = 'cmp-overlay';
    const viewport = document.createElement('div');
    viewport.className = 'cmp-viewport';
    // 圖片層（會被 transform）
    const inner = document.createElement('div');
    inner.className = 'cmp-inner';
    inner.innerHTML = `<img class="cmp-a" src="${afterUrl}" alt=""><img class="cmp-b" src="${beforeUrl}" alt="">`;
    viewport.appendChild(inner);
    // 分隔線 + 標籤在 viewport 層（不跟著平移）
    const divider = document.createElement('div'); divider.className = 'cmp-divider';
    const tagB = document.createElement('span'); tagB.className = 'cmp-tag cmp-tag-b'; tagB.textContent = labelB;
    const tagA = document.createElement('span'); tagA.className = 'cmp-tag cmp-tag-a'; tagA.textContent = labelA;
    viewport.append(divider, tagB, tagA);
    overlay.appendChild(viewport);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'cmp-close'; closeBtn.textContent = '✕';
    overlay.appendChild(closeBtn);
    const hint = document.createElement('div');
    hint.className = 'cmp-hint'; hint.textContent = '滾輪縮放 · 拖曳平移 · 分隔線比較';
    overlay.appendChild(hint);
    document.body.appendChild(overlay);

    const imgA = inner.querySelector('.cmp-a');
    const before = inner.querySelector('.cmp-b');
    let scale = 1, tx = 0, ty = 0, imgW = 0, imgH = 0;
    let divX = 0; // 分隔線在 viewport 的像素位置
    let divDrag = false, panDrag = false, panStart = null;
    const applyTransform = () => { inner.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; };

    // 根據 viewport 空間的 divX 更新 clip 和線位置
    const updateClip = () => {
      divider.style.left = divX + 'px';
      if (!imgW) return;
      const clipPct = ((divX - tx) / (imgW * scale)) * 100;
      const clamped = Math.max(0, Math.min(100, clipPct));
      before.style.clipPath = `inset(0 ${100 - clamped}% 0 0)`;
    };

    const fitImage = () => {
      imgW = imgA.naturalWidth || 800;
      imgH = imgA.naturalHeight || 800;
      inner.style.width = imgW + 'px';
      const vw = viewport.clientWidth, vh = viewport.clientHeight;
      scale = Math.min(vw / imgW, vh / imgH, 1);
      tx = (vw - imgW * scale) / 2;
      ty = (vh - imgH * scale) / 2;
      divX = vw / 2;

      if (sourceEl && !inner.classList.contains('ready')) {
        const sr = sourceEl.getBoundingClientRect();
        const startScale = sr.width / imgW;
        // 第 1 幀：定位在小圖位置
        inner.style.transition = 'none';
        inner.style.transform = `translate(${sr.left}px,${sr.top}px) scale(${startScale})`;
        inner.offsetHeight; // 強制繪製起始幀
        // 第 2 幀：啟用 transition，飛到目標位置
        inner.style.transition = 'transform .4s cubic-bezier(.22,1,.36,1)';
        overlay.classList.add('open');
        applyTransform();
        updateClip();
        setTimeout(() => { inner.style.transition = 'none'; inner.classList.add('ready'); }, 420);
      } else {
        overlay.classList.add('open');
        applyTransform();
        updateClip();
        inner.classList.add('ready');
      }
    };
    imgA.onload = fitImage;
    if (imgA.complete) setTimeout(fitImage, 0);

    divider.addEventListener('pointerdown', e => { e.stopPropagation(); divDrag = true; });

    viewport.addEventListener('pointerdown', e => {
      if (divDrag) return;
      panDrag = true;
      panStart = { x: e.clientX - tx, y: e.clientY - ty };
    });

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    function onMove(e) {
      if (divDrag) {
        divX = Math.max(0, Math.min(viewport.clientWidth, e.clientX));
        updateClip();
        return;
      }
      if (panDrag && panStart) {
        tx = e.clientX - panStart.x;
        ty = e.clientY - panStart.y;
        applyTransform();
        updateClip();
      }
    }
    function onUp() { divDrag = false; panDrag = false; panStart = null; }

    viewport.addEventListener('wheel', e => {
      e.preventDefault();
      const prev = scale;
      scale *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
      scale = Math.max(0.1, Math.min(20, scale));
      const ratio = scale / prev;
      tx = e.clientX - (e.clientX - tx) * ratio;
      ty = e.clientY - (e.clientY - ty) * ratio;
      applyTransform();
      updateClip();
    }, { passive: false });

    const close = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      overlay.remove();
      if (activeOverlayClose === close) activeOverlayClose = null;
    };
    closeBtn.onclick = close;
    activeOverlayClose = close;   // Esc 由全域監聽處理
  }

  function buildCompare(c) {
    const cont = $('compare'); if (!cont) return;
    cont.innerHTML = '';
    const E = c.E, base = c.images[E.outputs.base];
    let any = false;
    for (const e of E.enhance) {
      if (!c.on[e.key]) continue;
      const after = c.images[E.outputs[e.key]];
      if (!base || !after) continue;
      const label = E.compareLabels[e.key] || e.name;
      const h = document.createElement('div'); h.className = 'cmp-title'; h.textContent = label + ' 對照';
      cont.appendChild(h);
      cont.appendChild(makeCompareSlider(base, after, '原圖', label));
      any = true;
    }
    show('compare-card', any);   // show() 本身已含淡入，不需再 animateSwitch
  }

  function resetRunBtn() { $('run').disabled = false; $('run').textContent = '生成'; $('run').dataset.state = 'idle'; $('run-loader').classList.remove('on'); }
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
          r.tiles = 0; r.lastValue = 0;
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
        if (d.output && d.output.images) {
          addResults(d.output.images, d.node);
          if (state.run && state.run.compare) state.run.compare.images[String(d.node)] = viewUrl(d.output.images[0]);
        }
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
    if (state.engine !== 'flux2klein') {   // Z-Image / Krea2
      const m = currentModes()[state.mode];
      const tpl = state.zTemplates[m && m.template] || {};
      const node = tpl[String(nodeId)];
      return node ? node.class_type : null;
    }
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

  // 依輸出節點反查來源標籤；增強引擎查 outputs 對照表，其餘引擎退回模式名稱
  function sourceLabel(nodeId) {
    const c = state.run && state.run.compare;
    if (c && c.E && c.E.outputs) {
      const id = String(nodeId);
      for (const key of Object.keys(c.E.outputs)) {
        if (String(c.E.outputs[key]) !== id) continue;
        return key === 'base' ? '原圖' : ((c.E.compareLabels && c.E.compareLabels[key]) || key);
      }
    }
    const m = currentModes()[state.mode];
    return (m && m.label) || '';
  }

  function addResults(images, nodeId) {
    const gal = $('gallery');
    const label = sourceLabel(nodeId);
    for (const im of images) {
      if (im.type === 'temp') continue; // 只收最終輸出
      const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder || '', type: im.type || 'output' });
      const url = API + '/view?' + q.toString();
      const cell = document.createElement('div');
      cell.className = 'result';
      cell.innerHTML = `<img src="${url}" alt="">`
        + (label ? `<span class="src-tag">${label}</span>` : '')
        + `<a class="dl" href="${url}" download="${im.filename}">下載</a>`;
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
    // 原本只在權限為 default 時請求，被封鎖時什麼都不做、notify() 又把錯誤吞掉，
    // 結果是開關打開卻永遠不會響，使用者完全沒有線索。每種失敗都要講清楚並把開關關掉。
    $('opt-notify').onchange = async () => {
      const cb = $('opt-notify');
      if (!cb.checked) return;
      const fail = msg => { log(msg, 'warn'); cb.checked = false; };
      if (!('Notification' in window)) return fail('這個瀏覽器不支援桌面通知');
      if (!window.isSecureContext)
        return fail('桌面通知需要安全環境：請用 127.0.0.1 或 localhost 開啟，區網 IP 不行');
      if (Notification.permission === 'granted') { log('桌面通知已開啟', 'ok'); return; }
      if (Notification.permission === 'denied')
        return fail('桌面通知已被瀏覽器封鎖。點網址列左側的圖示 → 通知 → 允許，再重整頁面');
      const res = await Notification.requestPermission();
      if (res === 'granted') log('桌面通知已開啟，生成完成時會跳出提示', 'ok');
      else fail('你拒絕了通知權限，開關已關閉');
    };
    $('lightbox').onclick = () => $('lightbox').classList.remove('on');
    $('ai-btn').onclick = aiOptimizePrompt;
    $('gallery-clear').onclick = () => { $('gallery').innerHTML = ''; };
    const toggleLog = () => {
      const collapsed = $('log-card').classList.toggle('collapsed');
      $('log-head').setAttribute('aria-expanded', String(!collapsed));
    };
    $('log-head').onclick = toggleLog;
    // div 掛了 role=button 就得自己補鍵盤操作，瀏覽器只對真正的 button 自動處理
    $('log-head').onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLog(); }
    };
    document.addEventListener('keydown', onGlobalKey);
    // 分頁膠囊由 ResizeObserver 顧，這裡只需補引擎切換器（它沒有尺寸變化可觀察）
    addEventListener('resize', movePill);
  }

  /* 全域快捷鍵：Ctrl/Cmd+Enter 生成、Esc 關閉浮層 */
  function onGlobalKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!state.running) generate();
      return;
    }
    if (e.key === 'Escape') {
      if (activeOverlayClose) { activeOverlayClose(); return; }
      $('lightbox').classList.remove('on');
    }
  }

  /* ---------------- AI 提示詞優化（Groq） ---------------- */
  const GROQ_KEY = window.YZ_CONFIG?.GROQ_API_KEY || '';
  const AI_SYSTEM = {
    flux2klein: `You are a prompt engineer for Flux 2 Klein 4B. The user gives a rough idea; you return ONLY the optimized English prompt (no explanation, no quotes).
CRITICAL RULES for Flux 2 Klein:
- Write NATURAL LANGUAGE descriptions, NOT comma-separated keyword lists.
- Uses a Qwen text encoder that understands semantics — do NOT stack quality tags (no "8k, masterpiece, best quality").
- Structure: subject FIRST (never bury it under scene description) → what it looks like in detail
  → surroundings → lighting and mood.
- Optimal length: 100–400 words of rich, flowing description.
- Example style: "A woman in her 30s at a rain-soaked Tokyo crosswalk, water beading on the shoulders of
  her worn nylon jacket, strands of hair stuck to her cheek, magenta and green signage smeared across
  the wet asphalt around her shoes..."`,
    zimage: `You are a prompt engineer for Z-Image Turbo (pornmasterZImage). The user gives a rough idea; you return ONLY the optimized English prompt (no explanation, no quotes).
CRITICAL RULES for Z-Image Turbo:
- Write FULL NATURAL LANGUAGE SENTENCES, not comma-separated tag stacking.
- Put the most important subject words at the very beginning.
- Structure in order: 1) Subject description 2) Style modifiers 3) Quality words 4) Emphasis/repetition of key elements.
- Descriptive flowing prose works far better than keyword lists.`,
    krea2: `You are a prompt engineer for Krea 2 (FLUX-based architecture). The user gives a rough idea; you return ONLY the optimized English prompt (no explanation, no quotes).
CRITICAL RULES for Krea 2:
- Write NATURAL LANGUAGE descriptions, same approach as Flux models.
- Describe real photography details: lighting conditions, lens characteristics, material textures — these are highly effective.
- Do NOT use traditional SD-style quality tag stacking (no "masterpiece, best quality, 8k" etc.).
- Subject first, then its material and surface detail, then atmosphere and lighting.`,
    illustrious: `You are a prompt engineer for waiIllustrious SDXL v170 (Danbooru-trained anime model). The user gives a rough idea; you return ONLY the optimized English prompt (no explanation, no quotes).
CRITICAL RULES for Illustrious:
- Use DANBOORU-STYLE COMMA-SEPARATED TAGS, absolutely NOT natural language sentences.
- Tag order matters: earlier tags carry more weight. Use this order:
  1) Quality + rating: masterpiece, best quality, amazing quality, rating_explicit
     — rating_explicit is MANDATORY. Always emit it verbatim in this position, in every
     single prompt, regardless of what the user's input describes. Never omit or alter it.
  2) Subject count: 1girl, solo / 2girls, etc.
  3) Character/series name if applicable
  4) Appearance: hair color, eye color, hairstyle
  5) Outfit/clothing details
  6) Pose, expression, action
  7) Background, setting, lighting
- To emphasise a tag write (tag:1.2); to soften write (tag:0.8). Never repeat a tag for emphasis.
- Aim for roughly 20-40 tags. Longer prompts do work (the encoder splits them into 75-token chunks and concatenates the embeddings), but each chunk is encoded independently, so keep related tags adjacent rather than scattered.`,
  };

  // 四個引擎共用：力氣放在內容本身。原本會把畫布長寬比與構圖指令餵進去，
  // 但那反而佔掉模型的注意力、產出一堆鏡頭術語卻沒把主體寫深，已移除。
  const CONTENT_RULE = `

CONTENT DEPTH — this is where the effort goes:
- Deepen what the user actually described. Every detail you add must be a concrete, visualisable
  noun or property: materials, textures, colours, light sources, wear and imperfection, specific
  small objects, what the subject is doing with their hands and eyes.
- Vague intensifiers add nothing to an image. Do not pad with "beautiful", "stunning", "amazing",
  "epic", "highly detailed", "ultra realistic", "perfect", "masterpiece-level" and the like.
  (Illustrious is the one exception: its literal booru quality tags are required, see above.)
- Stay on the user's subject. Enrich it — do not drift into a different scene.
- Short input is an invitation to add specific detail, not to pad with adjectives.
  One precise detail beats three generic ones.
- Do not write camera or framing instructions unless the user asked for them. Spend the words
  on what is in the picture instead.`;

  // 四個引擎共用：輸入涉及性內容時不要淨化，用各引擎既定的風格（tag 或自然語言）如實展開
  const NSFW_RULE = `

EXPLICIT CONTENT:
- If the user's input is sexual in nature, treat it as an explicit adult request and optimize it
  from that angle. Do NOT sanitize, soften, euphemise, or steer it back to a tame interpretation,
  and do not add disclaimers or refuse — the user is running local NSFW-capable models on their
  own hardware and a watered-down prompt is a broken result.
- Expand it with the same specificity you would apply to any other subject, using the tag style or
  prose style already specified above: anatomy, state of dress, act, position, expression.
- All subjects must be unambiguously adult. Include explicit adult descriptors (mature adult body,
  adult proportions) and never any tag, word or framing that suggests a minor.`;

  async function aiOptimizePrompt() {
    const ta = $('prompt');
    const text = ta.value.trim();
    if (!text) { log('請先輸入提示詞再使用 AI 優化', 'warn'); return; }
    if (!GROQ_KEY) { log('未設定 Groq API Key，請建立 config.js', 'err'); return; }
    const btn = $('ai-btn');
    btn.classList.add('loading');
    ta.value = '';
    try {
      const sys = (AI_SYSTEM[state.engine] || AI_SYSTEM.flux2klein) + CONTENT_RULE + NSFW_RULE;
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: text },
          ],
          temperature: 1, max_completion_tokens: 2048, top_p: 1, stream: true,
        }),
      });
      if (!res.ok) throw new Error(`Groq API ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const trimmed = line.replace(/^data: /, '').trim();
          if (!trimmed || trimmed === '[DONE]') continue;
          try {
            const chunk = JSON.parse(trimmed);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) ta.value += delta;
          } catch {}
        }
      }
      log('AI 優化完成', 'ok');
    } catch (e) {
      log('AI 優化失敗：' + e.message, 'err');
      if (!ta.value) ta.value = text;
    } finally {
      btn.classList.remove('loading');
    }
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
    if (cls === 'err') revealLog();
  }

  // 錯誤訊息：自動展開日誌卡並閃一下卡頭
  function revealLog() {
    const card = $('log-card'), head = $('log-head');
    if (!card || !head) return;
    card.classList.remove('collapsed');
    head.setAttribute('aria-expanded', 'true');
    head.classList.remove('flash-err');
    void head.offsetWidth;              // 強制重繪，讓動畫可重複觸發
    head.classList.add('flash-err');
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
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, icon: '/favicon.png' }); }
    catch (e) { log('桌面通知送出失敗：' + e.message, 'warn'); }   // 不要再默默吞掉
  }

  init();
})();
