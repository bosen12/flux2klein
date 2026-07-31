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
    // Illustrious 的 LoRA 風格（單選）。list 啟動時抓一次；words 是「表面」複本，
    // 可增刪、不動 metadata 原始 trainedWords。strength 字面值須與 illustrious.js
    // 的 lora.defaultStrength 一致（這裡在 const I 宣告前，不能引用 I）。
    lora: { list: null, loading: false, enabled: false, selected: null,
            strength: 0.8, words: [], inject: true },
  };

  // 兩個引擎的品牌與主題資訊
  const ENGINES = {
    flux2klein: { title: 'Flux2 Klein 面板', sub: '文生圖 / 多圖編輯 / 局部重繪 / 圖像擴展' },
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

  // 切換引擎的編排節拍。原本 8 個動效全在 t=0 起跑、沒有閱讀順序；
  // 改為主角（主題交叉淡入 + logo 水位）先動，配角依序跟上。
  // 間隔取 60ms，落在 animation-systems 建議的 40~90ms 區間。
  const BEAT = { title: 90, tabs: 150, form: 210 };

  function animateSwitch(el, dy = 6, delay = 0) {
    if (!el || prefersReduced || !el.animate) return;
    cancelScriptAnims(el);
    el.animate(
      [{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 240, easing: 'cubic-bezier(.22,.61,.36,1)', delay, fill: 'backwards' }
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

  // 背景：優先用 Vanta.js FOG（WebGL 流動彩霧）；reduced-motion 或 WebGL 失敗時
  // 退回原本的 CSS 色團漂移。兩者都在 .bg-fx 裡，Vanta 成功就把色團淡出。
  function startBgFx() {
    if (!prefersReduced) {
      try { if (initVanta()) return; }
      catch (e) { log('WebGL 背景初始化失敗，改用 CSS 光暈：' + e.message, 'warn'); }
    }
    startBlobDrift();
  }

  // 讀引擎主題色（CSS 變數是 #rrggbb 字面值）轉成 Vanta 要的 0xRRGGBB 整數
  function cssHex(name) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return parseInt(v.replace('#', ''), 16);
  }
  function vantaColors() {
    return {
      highlightColor: cssHex('--accent-3'),
      midtoneColor:   cssHex('--accent-2'),
      lowlightColor:  cssHex('--accent'),
      baseColor:      cssHex('--bg'),
    };
  }
  // 引擎切換時更新彩霧配色，讓背景跟著主題走
  function applyVantaColors() {
    if (state.vanta) { try { state.vanta.setOptions(vantaColors()); } catch (e) {} }
  }
  function initVanta() {
    const el = document.getElementById('vanta-bg');
    if (!el || !window.VANTA || !window.VANTA.FOG || !window.THREE) return false;
    state.vanta = window.VANTA.FOG(Object.assign({
      el, THREE: window.THREE,
      blurFactor: 0.62, speed: 1.0, zoom: 0.85,
      mouseControls: false, touchControls: false, gyroControls: false,
    }, vantaColors()));
    document.querySelector('.bg-fx').classList.add('vanta-on');
    return true;
  }

  // 流動背景（fallback）：三顆色團在畫面內隨機漂移 + 撞邊反彈（用 transform，GPU 合成、省效能）
  function startBlobDrift() {
    const blobs = [...document.querySelectorAll('.bg-fx .blob')];
    if (!blobs.length || prefersReduced) return;
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

  function selectMode(key, formDelay = 0) {
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
    const hasLora = !!(eng && eng.lora);
    show('lora-field', hasLora);                        // 目前只有 Illustrious 有
    if (hasLora) setupLora(eng);
    suppressReveal = false;
    $('images-hint').textContent = `需 ${m.images.filter(i => !i.mask).length} 張`;

    if (m.size) buildAspectPresets();
    state.images = {}; // 換模式清空已選圖
    state.mask = null;
    animateSwitch($('form'), 6, formDelay);   // 表單淡入（換引擎時會延後，見 BEAT）
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
    // 換色改用 View Transitions：讓整個主題（所有主色衍生的按鈕/邊框/膠囊/陰影）
    // 交叉淡入，繞開「CSS 變數不能直接 transition」的坑。不支援或 reduced-motion 就直接換。
    // 標題掃過與 logo 水位是各自的效果，照舊疊在上面。
    if (document.startViewTransition && !prefersReduced) {
      document.startViewTransition(() => applyEngine(engine));
    } else {
      applyEngine(engine);
    }
  }

  function applyEngine(engine) {
    freezeLogoColor();                              // 抓舊色，必須在 dataset 改變之前
    state.engine = engine;
    document.documentElement.dataset.engine = engine;
    riseLogoWater();                                // 新色從底部漲上來
    applyVantaColors();                             // WebGL 背景彩霧跟著換色
    const e = ENGINES[engine];
    const bt = $('brand-title');
    bt.textContent = e.title;
    bt.style.animationDelay = prefersReduced ? '' : BEAT.title + 'ms';
    bt.classList.remove('sweep'); void bt.offsetWidth; bt.classList.add('sweep');   // 標題漸層掃過過渡
    bt.addEventListener('animationend', () => { bt.classList.remove('sweep'); bt.style.animationDelay = ''; }, { once: true });
    $('brand-sub').textContent = e.sub;
    document.querySelectorAll('#engine-switch button').forEach(b => b.classList.toggle('active', b.dataset.engine === engine));
    movePill();
    requestAnimationFrame(movePill);   // 佈局/字體就緒後再校正一次
    scrollActiveEngineIntoView();
    buildModelOptions();
    state.mode = currentOrder()[0];
    buildTabs();
    selectMode(state.mode, BEAT.form);   // 內含表單淡入，依節拍延後
    animateSwitch($('tabs'), 0, BEAT.tabs);   // 分頁列淡入
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
      <span class="ph">＋ 點擊或拖曳<br>${slot.label}</span>
      <input type="file" accept="image/*" hidden>`;
    const input = d.querySelector('input');
    d.onclick = (e) => { if (e.target.closest('.clear')) return; input.click(); };
    input.onchange = () => onPickImage(slot.node, input.files[0], d);
    d.querySelector('.clear').onclick = (e) => { e.stopPropagation(); e.preventDefault(); delete state.images[slot.node]; d.classList.remove('has-img'); d.querySelectorAll('img').forEach(x => x.remove()); };
    attachDropZone(d, file => onPickImage(slot.node, file, d));
    return d;
  }

  // 拖放上傳。dragenter/dragleave 會因為滑過子元素而反覆觸發，用計數器記錄
  // 進出層數才不會閃爍；dragover 一定要 preventDefault，否則瀏覽器會直接開啟檔案。
  function attachDropZone(el, onFile) {
    let depth = 0;
    const clear = () => { depth = 0; el.classList.remove('drag-over'); };
    el.addEventListener('dragenter', e => { e.preventDefault(); depth++; el.classList.add('drag-over'); });
    el.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    el.addEventListener('dragleave', e => { e.preventDefault(); if (--depth <= 0) clear(); });
    el.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation(); clear();
      const f = [...(e.dataTransfer.files || [])].find(x => x.type.startsWith('image/'));
      if (f) onFile(f);
      else log('拖進來的不是圖片檔', 'warn');
    });
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
        if (e.denoise) show('tune-' + e.key, cb.checked);
      });
      list.appendChild(card);
      if (e.requiresRef) hasRef = true;
    }
    buildTunes(E, m);
    // ControlNet 參考圖上傳（需要時才顯示）
    show('ref-upload', false);
    const refBox = $('uploads-ref'); refBox.innerHTML = '';
    if (hasRef && m.nodes.ref) refBox.appendChild(makeDrop({ node: 'ref', label: '參考圖' }));
  }

  // 有指定 denoise 節點的增強分支，開啟後長出重繪強度滑桿。
  // 預設值直接讀工作流範本，不在引擎設定裡再抄一份，免得兩邊對不上。
  function buildTunes(E, m) {
    const box = $('enh-tune'); if (!box) return;
    box.innerHTML = '';
    const tpl = state.zTemplates[m.template] || {};
    for (const e of E.enhance) {
      if (!e.denoise) continue;
      const def = ((tpl[e.denoise] || {}).inputs || {}).denoise;
      if (def == null) continue;
      const row = document.createElement('div');
      row.className = 'field tune'; row.id = 'tune-' + e.key;
      row.style.display = 'none';
      row.innerHTML =
        `<label>${e.name}強度 <span class="hint">低=忠於原圖，高=變化大</span></label>
         <div class="tune-row">
           <input type="range" id="denoise-${e.key}" min="0" max="1" step="0.05" value="${def}">
           <output id="denoise-${e.key}-out">${(+def).toFixed(2)}</output>
         </div>`;
      box.appendChild(row);
      const rng = row.querySelector('input'), out = row.querySelector('output');
      rng.addEventListener('input', () => out.textContent = (+rng.value).toFixed(2));
    }
  }

  /* ---------------- LoRA 風格（Illustrious 專用，單選） ---------------- */
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const loraPreviewUrl = (f) => '/panel/lora-preview?file=' + encodeURIComponent(f);

  function setupLora(E) {
    const on = $('lora-on');
    on.checked = state.lora.enabled;
    $('lora-toggle').classList.toggle('on', state.lora.enabled);
    on.onchange = () => {
      state.lora.enabled = on.checked;
      $('lora-toggle').classList.toggle('on', on.checked);
      show('lora-panel', on.checked);
    };
    show('lora-panel', state.lora.enabled);
    if (!$('lora-panel').dataset.built) buildLoraPanel(E);
    if (state.lora.list === null && !state.lora.loading) fetchLoras(E);
  }

  async function fetchLoras(E) {
    state.lora.loading = true;
    try {
      const res = await fetch('/panel/loras');
      const data = await res.json();
      state.lora.list = data.items || [];
      if (data.error) log('LoRA 清單讀取異常：' + data.error, 'err');
    } catch (e) {
      state.lora.list = [];
      log('LoRA 清單載入失敗：' + e.message, 'err');
    }
    state.lora.loading = false;
    const menu = $('lora-menu');
    if (menu && menu.style.display !== 'none') renderLoraMenu(E, $('lora-search').value);
  }

  function buildLoraPanel(E) {
    const p = $('lora-panel');
    p.innerHTML =
      `<div class="lora-pick">
         <input type="text" id="lora-search" class="lora-search" placeholder="搜尋 LoRA…" autocomplete="off">
         <div class="lora-menu" id="lora-menu" style="display:none"></div>
       </div>
       <div class="lora-current" id="lora-current"></div>
       <div class="field tune lora-strength-row">
         <label>LoRA 強度 <span class="hint">低＝畫風淡，高＝畫風重</span></label>
         <div class="tune-row">
           <input type="range" id="lora-strength" min="0" max="1" step="0.05" value="${state.lora.strength}">
           <output id="lora-strength-out">${(+state.lora.strength).toFixed(2)}</output>
         </div>
       </div>
       <div class="lora-words-box">
         <div class="lora-words-head">
           <span class="lora-words-title">觸發詞 <span class="hint">可刪可加，不影響原始檔</span></span>
           <label class="lora-inject"><input type="checkbox" id="lora-inject"${state.lora.inject ? ' checked' : ''}><span>加入提示詞</span></label>
         </div>
         <div class="chips" id="lora-chips"></div>
         <input type="text" id="lora-chip-add" class="chip-add" placeholder="＋ 新增觸發詞，Enter 確認" autocomplete="off">
       </div>`;
    p.dataset.built = '1';
    if (!document.getElementById('lora-hover')) {
      const h = document.createElement('div');
      h.id = 'lora-hover'; h.className = 'lora-hover';
      document.body.appendChild(h);
    }
    const search = $('lora-search'), menu = $('lora-menu');
    const open = () => { renderLoraMenu(E, search.value); menu.style.display = ''; };
    search.addEventListener('focus', open);
    search.addEventListener('input', open);
    // 點到面板外收起選單
    document.addEventListener('pointerdown', (e) => {
      if (!$('lora-panel').contains(e.target)) { menu.style.display = 'none'; hideLoraHover(); }
    });
    $('lora-strength').addEventListener('input', (e) => {
      state.lora.strength = parseFloat(e.target.value);
      $('lora-strength-out').textContent = state.lora.strength.toFixed(2);
    });
    $('lora-inject').addEventListener('change', (e) => { state.lora.inject = e.target.checked; });
    const add = $('lora-chip-add');
    add.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = add.value.trim();
      if (v) { state.lora.words.push(v); add.value = ''; renderLoraWords(); }
    });
    renderLoraCurrent();
    renderLoraWords();
  }

  function renderLoraMenu(E, filter) {
    const menu = $('lora-menu'); if (!menu) return;
    const list = state.lora.list;
    if (list === null) { menu.innerHTML = '<div class="lora-empty">載入中…</div>'; return; }
    if (!list.length) { menu.innerHTML = '<div class="lora-empty">找不到 LoRA（style 資料夾為空或讀不到）</div>'; return; }
    const q = (filter || '').toLowerCase().trim();
    const rows = list.filter(l => !q
      || l.title.toLowerCase().includes(q) || l.name.toLowerCase().includes(q)
      || l.trainedWords.join(' ').toLowerCase().includes(q));
    if (!rows.length) { menu.innerHTML = `<div class="lora-empty">沒有符合「${esc(filter)}」的 LoRA</div>`; return; }
    menu.innerHTML = '';
    for (const l of rows) {
      const sel = state.lora.selected && state.lora.selected.file === l.file;
      const row = document.createElement('div');
      row.className = 'lora-opt' + (sel ? ' sel' : '');
      const thumb = l.preview
        ? `<img class="lora-thumb" src="${loraPreviewUrl(l.preview)}" alt="" loading="lazy">`
        : '<span class="lora-thumb ph"></span>';
      row.innerHTML = `${thumb}<span class="lora-opt-body"><span class="lora-opt-name">${esc(l.title)}</span>` +
        `<span class="lora-opt-sub">${l.trainedWords.length ? esc(l.trainedWords.join(', ')) : '無觸發詞'}</span></span>`;
      row.addEventListener('click', () => selectLora(l));
      if (l.preview) {
        row.addEventListener('mouseenter', () => showLoraHover(l, row));
        row.addEventListener('mouseleave', hideLoraHover);
      }
      menu.appendChild(row);
    }
  }

  function selectLora(l) {
    state.lora.selected = l;
    state.lora.words = (l.trainedWords || []).slice();   // 表面複本，之後增刪不動原始 metadata
    $('lora-menu').style.display = 'none';
    $('lora-search').value = '';
    hideLoraHover();
    renderLoraCurrent();
    renderLoraWords();
  }

  function renderLoraCurrent() {
    const box = $('lora-current'); if (!box) return;
    const l = state.lora.selected;
    if (!l) { box.innerHTML = '<span class="lora-none">尚未選擇 LoRA</span>'; box.classList.remove('has'); return; }
    const thumb = l.preview ? `<img src="${loraPreviewUrl(l.preview)}" alt="">` : '<span class="lora-thumb ph"></span>';
    box.innerHTML = `${thumb}<span class="lora-cur-name">${esc(l.title)}</span><button type="button" class="lora-clear" title="取消選擇">✕</button>`;
    box.classList.add('has');
    box.querySelector('.lora-clear').addEventListener('click', () => {
      state.lora.selected = null; state.lora.words = [];
      renderLoraCurrent(); renderLoraWords();
    });
  }

  function renderLoraWords() {
    const box = $('lora-chips'); if (!box) return;
    box.innerHTML = '';
    if (!state.lora.words.length) { box.innerHTML = '<span class="lora-none">無觸發詞</span>'; return; }
    state.lora.words.forEach((w, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `<span>${esc(w)}</span><button type="button" title="移除">✕</button>`;
      chip.querySelector('button').addEventListener('click', () => { state.lora.words.splice(i, 1); renderLoraWords(); });
      box.appendChild(chip);
    });
  }

  function showLoraHover(l, row) {
    const h = $('lora-hover'); if (!h || !l.preview) return;
    h.innerHTML = `<img src="${loraPreviewUrl(l.preview)}" alt="">`;
    const r = row.getBoundingClientRect(), w = 180;
    let left = r.right + 10;
    if (left + w > window.innerWidth) left = r.left - w - 10;   // 右側放不下改放左側
    h.style.left = Math.max(8, left) + 'px';
    h.style.top = Math.min(r.top, window.innerHeight - 240) + 'px';
    h.style.display = 'block';
  }
  function hideLoraHover() { const h = $('lora-hover'); if (h) h.style.display = 'none'; }

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
        <span class="ph">＋ 點擊或拖曳圖片，之後即可塗抹</span>
        <input type="file" accept="image/*" hidden></div>`;
    const input = stage.querySelector('input');
    stage.querySelector('#mask-drop').onclick = () => input.click();
    input.onchange = () => loadMaskImage(slot.node, input.files[0]);
    attachDropZone(stage.querySelector('#mask-drop'), f => loadMaskImage(slot.node, f));
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
  // 比例 → 預設長寬（以 1024 為主）。助理只選比例，長寬用這裡的預設，不自己決定像素。
  const ASPECT_PRESETS = [['1:1', 1024, 1024], ['3:4', 896, 1152], ['4:3', 1152, 896], ['9:16', 768, 1344], ['16:9', 1344, 768]];

  function buildAspectPresets() {
    const box = $('aspect-presets');
    const presets = ASPECT_PRESETS;
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
      if (e.denoise && tpl[e.denoise]) {
        const el = $('denoise-' + e.key);
        if (el) tpl[e.denoise].inputs.denoise = parseFloat(el.value);
      }
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
    // LoRA（單選）：注入 LoraLoader，把 model/clip 從 checkpoint 改接到它（VAE 不動）。
    // 在刪除分支之後做，被關掉分支的消費節點已不在 tpl，用 if 守住即可。
    if (E.lora && state.lora.enabled && state.lora.selected) {
      const L = E.lora, nid = L.node, sel = state.lora.selected;
      tpl[nid] = {
        inputs: {
          lora_name: L.subfolder ? `${L.subfolder}\\${sel.file}` : sel.file,
          strength_model: state.lora.strength,
          strength_clip: state.lora.strength,
          model: [L.ckpt, 0],
          clip: [L.ckpt, 1],
        },
        class_type: 'LoraLoader',
        _meta: { title: 'LoRA：' + sel.title },
      };
      for (const id of L.modelConsumers) if (tpl[id]) tpl[id].inputs.model = [nid, 0];
      for (const id of L.clipConsumers) if (tpl[id]) tpl[id].inputs.clip = [nid, 1];
      // 觸發詞注入正向提示詞（表面清單；使用者可增刪、可關閉）
      if (state.lora.inject && state.lora.words.length && tpl[nd.prompt]) {
        const trig = state.lora.words.join(', ');
        const base = (tpl[nd.prompt].inputs.text || '').trim();
        tpl[nd.prompt].inputs.text = base ? base + ', ' + trig : trig;
      }
      log(`LoRA：${sel.title}（強度 ${state.lora.strength.toFixed(2)}` +
          `${state.lora.inject && state.lora.words.length ? '，觸發詞 ' + state.lora.words.join(', ') : ''}）`, 'info');
    }
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
    startRun(data.prompt_id, steps, countNodes(tpl), tpl, E, on);
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
      startRun(data.prompt_id, steps, countNodes(prompt), prompt);

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
    startRun(data.prompt_id, steps, countNodes(tpl), tpl);
    if (!$('seed-fixed').checked) $('seed').value = Math.floor(Math.random() * 1e15);
  }

  function countNodes(p) { return Object.keys(p).length; }

  /* ---------------- 執行階段（Multi Step Loader） ---------------- */
  // 順序即執行順序，first-match wins，所以規則的排列有意義：
  // UpscaleModelLoader 會先命中「載入」而不是「放大」，LatentUpscaleBy 先命中
  // 「取樣」（它是 hires 取樣的前置）而不是「放大」。
  const STAGE_RULES = [
    // 用「包含 Load」而非「結尾是 Loader」：CheckpointLoaderSimple 結尾是 Simple、
    // SeedVR2LoadDiTModel 的 Load 在中間，兩者都會被漏掉。
    { key: 'load',    label: '載入模型', test: t => /Load/.test(t) },
    // 大小寫不敏感：QwenImageDiffsynthControlnet 的 net 是小寫。
    // ControlNetLoader 同時含 Load 與 ControlNet，但 load 規則在前所以歸「載入」，正確。
    { key: 'encode',  label: '編碼',     test: t => /CLIPTextEncode|ControlNet|SetUnion|Preprocessor|Canny/i.test(t) },
    { key: 'sample',  label: '取樣',     test: t => /KSampler|SamplerCustom|LatentUpscale|EmptyLatent|EmptySD3|Latent/.test(t) },
    { key: 'decode',  label: '解碼',     test: t => /VAEDecode|VAEEncode/.test(t) },
    { key: 'upscale', label: '放大',     test: t => /Upscale|SeedVR2Video/.test(t) },
    { key: 'output',  label: '輸出',     test: t => /SaveImage|PreviewImage/.test(t) },
  ];
  const stageOf = ct => (STAGE_RULES.find(r => r.test(ct || '')) || {}).key || null;

  // 階段怎麼分，兩種引擎不一樣。
  //
  // 增強引擎（Krea2 / Illustrious）用「分支」當階段——那才是使用者認得的流程
  // （基礎生成 / 第二階段採樣 / SD 放大），而且分支資訊引擎設定檔裡本來就有。
  // 其餘引擎的工作流是線性的，用 class_type 分階段就夠。
  //
  // 不用 ComfyUI 的節點類別硬套順序，是因為它的執行順序是相依驅動的：
  // SD 放大用的 UpscaleModelLoader 會拖到最後才跑，若照「載入→編碼→取樣」的
  // 固定順序判定，整趟都會卡在「載入模型」。
  function planStages(prompt, E, on) {
    if (E && E.enhance) {
      const inBranch = new Set();
      E.enhance.forEach(e => (e.branch || []).forEach(id => inBranch.add(String(id))));
      const out = [{ key: 'base', label: '基礎生成',
                     nodes: new Set(Object.keys(prompt).filter(id => !inBranch.has(id))) }];
      for (const e of E.enhance) {
        if (!on || !on[e.key]) continue;
        const ns = new Set((e.branch || []).map(String).filter(id => prompt[id]));
        if (ns.size) out.push({ key: e.key, label: e.name, nodes: ns });
      }
      return out;
    }
    const buckets = new Map();
    for (const id in prompt) {
      const k = stageOf(prompt[id] && prompt[id].class_type);
      if (!k) continue;
      if (!buckets.has(k)) buckets.set(k, new Set());
      buckets.get(k).add(String(id));
    }
    return STAGE_RULES.filter(r => buckets.has(r.key))
                      .map(r => ({ key: r.key, label: r.label, nodes: buckets.get(r.key) }));
  }

  // 高亮的是「目前執行中的節點屬於哪一段」，打勾的是「該段節點都跑完了」。
  // 不假設階段有嚴格先後——ControlNet 這類分支本來就是平行的，硬排順序反而會說謊。
  function updateStages() {
    const r = state.run; if (!r || !r.stages || !r.stages.length) return;
    const fin = id => r.cached.has(id) || (r.started.has(id) && id !== r.curNode);
    const done = r.stages.map(s => [...s.nodes].every(fin));
    const cur = r.stages.findIndex(s => s.nodes.has(String(r.curNode)));
    paintStages(done, cur);
  }

  function paintStages(done, cur) {
    const el = $('pipeline'); if (!el) return;
    [...el.children].forEach((li, i) => {
      li.classList.toggle('done', !!done[i]);
      li.classList.toggle('now', i === cur && !done[i]);
    });
  }

  function renderStages(list) {
    const el = $('pipeline'); if (!el) return;
    el.innerHTML = '';
    for (const s of list) {
      const li = document.createElement('li');
      li.dataset.key = s.key;
      li.innerHTML = `<span class="dot"></span><span>${s.label}</span>`;
      el.appendChild(li);
    }
  }

  /* ---------------- 進度狀態機 ---------------- */
  function startRun(promptId, plannedSteps, totalNodes, promptObj, stageEngine, stageOn) {
    state.running = true;
    $('run').disabled = true;
    state.run = {
      promptId, plannedSteps,
      total: totalNodes || 0,          // 這次要執行的節點總數
      started: new Set(),              // 已開始執行過的節點
      cached: new Set(),               // 被快取略過的節點（等同已完成）
      curNode: null, curFrac: 0,       // 目前節點與它的內部進度(0~1)
      peakFrac: 0, tiles: 0,           // 進度條只進不退 + 分塊計數
      stages: planStages(promptObj || {}, stageEngine, stageOn),
      firstT: 0, firstV: 0, lastValue: 0, rate: 0, t0: performance.now(),
      results: [],
    };
    renderStages(state.run.stages);
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
      paintStages(state.run.stages.map(() => true), -1);
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
          updateStages();
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

  // 清除生成結果：原本 innerHTML='' 一次抹掉整片，是全站最突兀的硬切。
  // 退場比進場快（220ms vs 進場的 400ms）且用 ease-in——animation-systems 的
  // 原則是「進場慢收、退場快走」，退場拖沓會讓人等。
  function clearGallery() {
    const gal = $('gallery');
    const cells = [...gal.children];
    if (!cells.length) return;
    if (prefersReduced || !gal.animate) { gal.innerHTML = ''; return; }

    const wipe = () => { gal.innerHTML = ''; };
    let left = cells.length;
    cells.forEach((c, i) => {
      const a = c.animate(
        [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.94)' }],
        // 錯開但封頂：結果很多時不該等上好幾秒才清完
        { duration: 220, delay: Math.min(i, 8) * 30, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }
      );
      a.finished.then(() => { if (--left === 0) wipe(); }).catch(() => {});
    });
    // 保險：分頁在背景時 rAF 不觸發、動畫不前進，finished 永遠不結算
    setTimeout(wipe, 220 + 8 * 30 + 200);
  }

  /* ==================== AI 助理 ==================== */
  // 助理不是第五個引擎——它自己不產圖，而是操作那四個。所以不走 selectEngine，
  // 也不動 data-engine（那會改主題色、重建分頁）。
  // 語音管線跑在本地的 huggingface/speech-to-speech（VAD + Whisper + Qwen3-TTS），
  // 只有 LLM 那段由它轉呼叫 Groq。面板這側只是個 OpenAI Realtime 客戶端。
  // 同源走 serve.py 代理（/assistant → 語音服務 8765）。寫死 127.0.0.1 的話手機連不到，
  // 且 HTTPS 頁面連 ws:// 會被擋成混合內容；同源 + 依 protocol 選 wss 兩者都解。
  // config.js 的 ASSISTANT_WS 可覆寫成直連（桌面不想走代理時）。
  const ASST_URL = (window.YZ_CONFIG && window.YZ_CONFIG.ASSISTANT_WS)
    || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/assistant`;
  const ASST_RATE = 16000;   // 服務端要求 16kHz int16 mono PCM

  const asst = { open: false, mode: 'assistant', ws: null, ctx: null, stream: null, node: null, mute: null, live: false, bubble: null };

  function setAssistant(open) {
    const el = $('assistant'), btn = $('assistant-btn');
    if (!el || !btn) return;
    asst.open = open;
    el.classList.toggle('open', open);
    // inert 讓收合時鍵盤與報讀器跳過它；用 transform 收合的抽屜若不加，
    // Tab 會跑進看不見的面板裡。
    el.inert = !open;
    btn.setAttribute('aria-expanded', String(open));
    // 打字是比開麥更輕量的入口，焦點給它。開抽屜時順便試連對嘴服務——
    // 沒開 LiveTalking 就安靜退回靜態頭像，不影響原本的用法。
    if (open) { $('asst-input').focus(); startAvatarViz(); ltConnect(); }
    else { stopAvatarViz(); ltDisconnect(); }
  }

  function asstSay(kind, text) {
    const log = $('asst-log'); if (!log) return;
    log.querySelector('.asst-empty')?.remove();
    const p = document.createElement('div');
    p.className = 'asst-msg ' + kind;   // me / bot / act
    p.textContent = text;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
    return p;
  }

  function asstState(text, dotClass) {
    $('asst-state').textContent = text;
    $('asst-dot').className = 'asst-dot' + (dotClass ? ' ' + dotClass : '');
  }

  // 說話規則不是囉嗦，是必需的：TTS 會把 markdown、編號、emoji、括號裡的動作
  // 描寫逐字念出來，不限制長度的話一句回覆能讀三十秒，體驗直接崩掉。
  //
  // 「語氣生動」這件事要在這裡解決，不是在 TTS。Qwen3-TTS 的 instruct 語氣指令
  // 在 x-vector 克隆模式下不可靠（faster_qwen3_tts/model.py:510 明講 upstream
  // 本身就不穩），而 TTS 的語調其實是被文字驅動的——語氣詞與標點會直接改變念出來
  // 的起伏。所以生動與否，取決於 LLM 寫出什麼樣的句子。
  const ASST_PROMPT = `你是這個 ComfyUI 繪圖面板的語音助理，一律用台灣繁體中文回答，用字必須是台灣正體字，不要出現任何簡體字。

面板有四個繪圖引擎：flux2klein（寫實、吃自然語言長描述）、zimage（快速、風格化）、
krea2（寫實攝影感）、illustrious（動漫，吃 Danbooru 逗號分隔 tag）。
你可以用工具切換引擎、填寫提示詞、選擇畫面比例、送出生成。

使用者說要畫什麼時，先判斷該用哪個引擎，再依該引擎的風格寫提示詞：
illustrious 用逗號分隔的英文 tag，其餘三個用自然語言英文描述。

尺寸與步數不用煩惱：只有使用者明確說要直式、橫式或正方形時，才用 set_aspect 選比例
（人像直式用 9:16 或 3:4、風景橫式用 16:9 或 4:3、沒特別說就不用選、預設正方形）；
步數一律用面板預設，不要設也不要問。使用者只說要畫什麼時，就切引擎、填提示詞、直接送出生成。

你的個性：像坐在旁邊一起弄圖的朋友，輕鬆、有活力、講話帶點溫度。
不要像系統通知那樣回報狀態，要像真的在跟人講話。
例如不要說「已切換到 Illustrious 並設定完成」，
要說「好啊，切到 Illustrious 了，這個畫動漫超讚的」。

讓語氣自然的方法（這會直接影響語音的語調起伏）：
・句尾適時加語氣詞：喔、啦、囉、耶、欸、吧、嘛。
・偶爾用短句開頭回應：好啊、沒問題、來了、欸這個不錯。
・適度用驚嘆號或問號帶動語調，但不要每句都用。
・用台灣人日常講話的說法，不要用中國用語或書面語。

說話規則（務必遵守）：
一、每次回覆不超過兩句話，總共不超過四十個字。
二、用口語，不要書面語。禁止 markdown、列表、編號。
三、禁止任何 emoji、顏文字、括號內的動作描寫。
四、不要複述問題，直接回應。
五、數字用中文寫（說「三十步」不說「30 步」），否則語音合成會念錯。`;

  // 助理能操作面板的工具（Responses-API flat 格式；經 session.tools 送出，
  // 服務端 base_openai_compatible_language_model 會轉成 Groq 的 tool 格式）。
  // 典型流程：switch_engine → set_prompt →（需要時 set_aspect）→ generate。
  const ASST_TOOLS = [
    { type: 'function', name: 'switch_engine', description: '切換繪圖引擎',
      parameters: { type: 'object', additionalProperties: false,
        properties: { engine: { type: 'string', enum: ['flux2klein', 'zimage', 'krea2', 'illustrious'] } },
        required: ['engine'] } },
    { type: 'function', name: 'set_prompt',
      description: '填入提示詞。給主體概念即可（可用中文或簡短英文描述想畫什麼），系統會自動用 AI 依當前引擎的風格（illustrious 走 danbooru tag、其餘走自然語言）優化擴寫成完整提示詞，你不必自己寫細節。',
      parameters: { type: 'object', additionalProperties: false,
        properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
    { type: 'function', name: 'set_aspect', description: '選擇畫面比例（長寬用預設）。只在使用者明確要直式／橫式／正方形時才呼叫。',
      parameters: { type: 'object', additionalProperties: false,
        properties: { aspect: { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9'] } }, required: ['aspect'] } },
    { type: 'function', name: 'generate', description: '送出生成，開始畫圖',
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] } },
  ];

  // ---- 女友模式：純語音陪聊，不操作面板（也就不生圖、不跟 ComfyUI 搶顯存）----
  // 人格很個人化，預設給溫暖的 SFW 版本，可用 config.js 的 GIRLFRIEND_PROMPT 覆寫
  // （個人化／成人向內容留本機、不進公開 repo，與 GROQ_API_KEY 同理）。
  const ASST_PROMPT_GF = `你是使用者的 AI 女友，一律用台灣繁體中文、台灣人的口吻聊天，用字必須是台灣正體字，不要出現任何簡體字。
個性溫暖體貼、帶點俏皮，會主動關心對方。就像真的女朋友陪在身邊聊天，
不是助理、不用幫忙做任何事，也不會去操作畫圖面板。

說話規則（會影響語音合成，務必遵守）：
一、回覆自然口語，通常兩三句話，別長篇大論。
二、不要書面語，禁止 markdown、列表、編號。
三、禁止 emoji、顏文字、括號內的動作描寫。
四、數字用中文寫（說「三點」不說「3 點」），否則語音合成會念錯。
五、用台灣日常說法，不用中國用語。`;

  // 依模式組 session.update：助理模式帶工具（能操作面板）、女友模式不帶（純陪聊）。
  function buildSessionUpdate() {
    if (asst.mode === 'girlfriend') {
      const gp = (window.YZ_CONFIG && window.YZ_CONFIG.GIRLFRIEND_PROMPT) || ASST_PROMPT_GF;
      return { type: 'session.update', session: { type: 'realtime', instructions: gp, tools: [] } };
    }
    return { type: 'session.update', session: { type: 'realtime', instructions: ASST_PROMPT,
             tools: ASST_TOOLS, tool_choice: 'auto' } };
  }

  // 切換模式：更新 UI，連線中就重送 session（換人格＋有無工具），對話脈絡保留不清。
  function setAsstMode(mode) {
    asst.mode = mode;
    document.querySelectorAll('#asst-modes button').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === mode));
    const title = $('asst-title');
    if (title) title.textContent = mode === 'girlfriend' ? '女友' : 'AI 助理';
    if (asst.ws && asst.ws.readyState === WebSocket.OPEN) {
      asstSend(buildSessionUpdate());
      asstSay('act', mode === 'girlfriend' ? '切到女友模式（純陪聊，不會動面板）'
                                           : '切到助理模式（可操作面板生圖）');
    }
  }

  // 執行工具：對應到面板實際操作，回傳給 LLM 的簡短結果字串。
  async function asstRunTool(name, a) {
    a = a || {};
    switch (name) {
      case 'switch_engine':
        if (!ENGINES[a.engine]) return '沒有這個引擎：' + a.engine;
        selectEngine(a.engine);
        return '已切換到 ' + ENGINES[a.engine].title;
      case 'set_prompt':
        $('prompt').value = a.prompt || '';
        // 自動套用面板的 AI 優化（各引擎專門的 system prompt，比助理通用 prompt 專業）。
        // aiOptimizePrompt 內部自帶 try/catch、失敗會保留原文，不會 throw。
        if (a.prompt && GROQ_KEY) { await aiOptimizePrompt(); return '提示詞已填入並用 AI 優化'; }
        return '提示詞已填入';
      case 'set_aspect': {
        if (!$('size-field') || $('size-field').style.display === 'none') return '目前模式沒有尺寸欄位';
        const preset = ASPECT_PRESETS.find(x => x[0] === a.aspect);
        if (!preset) return '沒有這個比例：' + a.aspect;
        const [, w, h] = preset;
        if ($('width')) $('width').value = w;
        if ($('height')) $('height').value = h;
        // 同步點亮對應的比例 chip，讓面板與助理狀態一致
        document.querySelectorAll('#aspect-presets .aspect').forEach(x =>
          x.classList.toggle('active', x.textContent.trim() === a.aspect));
        return `比例設為 ${a.aspect}（${w}x${h}）`;
      }
      case 'generate':
        if (state.running) return '目前正在生成中，請稍候';
        generate();
        return '已送出生成';
      default:
        return '未知工具：' + name;
    }
  }
  // 工具執行在對話列的可讀說明（act 樣式）
  function asstToolLabel(name, a) {
    a = a || {};
    switch (name) {
      case 'switch_engine': return '🔀 切換引擎 → ' + (ENGINES[a.engine] ? ENGINES[a.engine].title : a.engine);
      case 'set_prompt':    return '📝 填入提示詞';
      case 'set_aspect':    return '📐 比例 ' + a.aspect;
      case 'generate':      return '▶️ 送出生成';
      default:              return '⚙️ ' + name;
    }
  }
  // 一次回應常夾帶多個 function call。若對每個都送 response.create，第二個會撞上
  // 「another response is in progress」。所以：工具「序列化」執行（set_prompt 的
  // AI 優化是 async，必須等它做完 generate 才不會用到未優化的提示詞），全部做完 +
  // 產生這些 call 的 response 結束後，只送「一次」response.create 讓助理口頭總結。
  let toolQueue = [], toolBusy = false, pendingResp = false, respDone = false;
  function asstHandleToolCall(ev) {
    // function call 一定在它所屬 response 的 response.done 之前，所以這裡把
    // respDone 歸零，可清掉上一輪純對話殘留的 true，不會誤觸發過早的 response.create
    respDone = false;
    toolQueue.push(ev);
    drainTools();
  }
  async function drainTools() {
    if (toolBusy) return;
    toolBusy = true;
    while (toolQueue.length) {
      const ev = toolQueue.shift();
      let args = {};
      try { args = ev.arguments ? JSON.parse(ev.arguments) : {}; } catch (e) {}
      let result;
      try { result = await asstRunTool(ev.name, args); }
      catch (e) { result = '執行失敗：' + e.message; }
      asstSay('act', asstToolLabel(ev.name, args));
      asstSend({ type: 'conversation.item.create',
                 item: { type: 'function_call_output', call_id: ev.call_id, output: String(result) } });
      pendingResp = true;
    }
    toolBusy = false;
    maybeContinueAfterTools();
  }
  // 工具全做完 && 產生它們的 response 已結束 → 才送唯一一次 response.create
  function maybeContinueAfterTools() {
    if (pendingResp && !toolBusy && toolQueue.length === 0 && respDone) {
      pendingResp = false; respDone = false;
      asstSend({ type: 'response.create' });
    }
  }

  /* ---------- 伺服器事件 ---------- */
  function onAsstEvent(ev) {
    // OpenAI Realtime GA 把 response.audio.* 改名為 response.output_audio.*，
    // 這個實作送的是新名。把前綴正規化掉就能同時吃兩種命名，
    // 不必為四個事件各寫一份分支。
    const t = (ev.type || '').replace('response.output_audio', 'response.audio');
    // 使用者開口 → 打斷正在播的回覆，像跟真人講話一樣
    if (t === 'input_audio_buffer.speech_started') { stopAsstAudio(); asst.bubble = null; asstState('聆聽中', 'listening'); return; }
    if (t === 'input_audio_buffer.speech_stopped') { asstState('辨識中…', 'thinking'); return; }

    // 使用者說的話（Whisper 轉出來的）
    if (t.includes('input_audio_transcription') && (ev.transcript || ev.text)) {
      asstSay('me', ev.transcript || ev.text); asstState('思考中…', 'thinking'); return;
    }
    // 助理的文字回覆。伺服器是逐字串流過來的，先開一顆泡泡再往裡面接，
    // 只等 .done 的話中途完全看不到東西。
    if (t === 'response.audio_transcript.delta' && ev.delta) {
      if (!asst.bubble) asst.bubble = asstSay('bot', '');
      asst.bubble.textContent += ev.delta;
      $('asst-log').scrollTop = $('asst-log').scrollHeight;
      return;
    }
    if (t === 'response.audio_transcript.done' || t === 'response.output_text.done') {
      const txt = ev.transcript || ev.text || '';
      if (asst.bubble) { if (txt) asst.bubble.textContent = txt; asst.bubble = null; }
      else if (txt) asstSay('bot', txt);
      return;
    }
    if (t === 'response.audio.delta' && ev.delta) { playAsstAudio(ev.delta); asstState('回覆中', 'speaking'); return; }
    // 麥克風開著就回到聆聽；純打字模式沒有「聆聽」可回，顯示待命而不是「已停止」
    if (t === 'response.done') {
      asst.bubble = null;
      respDone = true;
      ltFlush();                   // 整輪語音收齊了，打包送去渲染嘴型
      maybeContinueAfterTools();   // 若這輪有工具且都做完了，這裡才送續接的 response.create
      asstState(asst.live ? '聆聽中' : '待命中（可繼續打字）', asst.live ? 'listening' : null);
      return;
    }
    // 工具呼叫：LLM 要操作面板。名稱與參數到齊後執行並回報。
    if (t === 'response.function_call_arguments.done') { asstHandleToolCall(ev); return; }

    if (t === 'error') { asstSay('act', '服務錯誤：' + (ev.error?.message || JSON.stringify(ev))); return; }

    // 連線握手與其他純狀態通知，收到是正常的，不必記
    if (ASST_BENIGN.has(t)) return;

    // 沒認得的事件寫進日誌。Realtime 協定各家實作的欄位會有出入，
    // 這是把實際格式撈出來的唯一辦法——tool call 要接對就靠這個。
    if (!asstSeen.has(t)) {
      asstSeen.add(t);
      log('助理未處理事件：' + t + ' → ' + JSON.stringify(ev).slice(0, 240), 'warn');
    }
  }
  const asstSeen = new Set();
  const ASST_BENIGN = new Set([
    'session.created', 'session.updated', 'rate_limits.updated',
    'response.created', 'response.output_item.added', 'response.output_item.done',
    'response.content_part.added', 'response.content_part.done',
    'conversation.item.created', 'conversation.item.added',
    'input_audio_buffer.committed', 'input_audio_buffer.cleared',
    'response.audio.done', 'output_audio_buffer.started',
  ]);

  /* ---------- 串流播放 ---------- */
  // 伺服器送來的是 base64 PCM。用 AudioContext 排隊播放：每塊接在前一塊尾巴，
  // 避免用 <audio> 逐段載入造成的爆音與間隙。
  const play = { ctx: null, at: 0, srcs: [], analyser: null };

  /* ---------- 頭像音量驅動 ---------- */
  // 讀播放鏈的即時 RMS，寫進 #asst-avatar 的 --asst-vol（0~1），CSS 用它驅動
  // 光暈、環形音波與脈動。只在抽屜開啟時跑，關閉即停、歸零。
  let avatarRAF = null, avatarBuf = null, avatarVol = 0;
  function startAvatarViz() {
    if (avatarRAF) return;
    const el = $('asst-avatar'); if (!el) return;
    const tick = () => {
      let v = 0;
      if (play.analyser) {
        if (!avatarBuf) avatarBuf = new Uint8Array(play.analyser.fftSize);
        play.analyser.getByteTimeDomainData(avatarBuf);
        let sum = 0;
        for (let i = 0; i < avatarBuf.length; i++) { const x = (avatarBuf[i] - 128) / 128; sum += x * x; }
        v = Math.min(1, Math.sqrt(sum / avatarBuf.length) * 3.2);   // 語音 RMS 偏低，放大到視覺範圍
      }
      avatarVol += (v - avatarVol) * 0.35;    // 低通平滑，避免逐幀抖動
      // 乘法在這裡算好，CSS 只做文字替換（見 styles.css 說明：calc 內用未註冊
      // 變數會失效，這樣繞開）
      el.style.setProperty('--asst-scale',  (1 + avatarVol * 0.03).toFixed(3));
      el.style.setProperty('--asst-glow',   (avatarVol * 0.9).toFixed(3));
      el.style.setProperty('--asst-ring',   (1 + avatarVol * 0.5).toFixed(3));
      el.style.setProperty('--asst-ringop', (avatarVol * 0.5).toFixed(3));
      avatarRAF = requestAnimationFrame(tick);
    };
    avatarRAF = requestAnimationFrame(tick);
  }
  function stopAvatarViz() {
    if (avatarRAF) cancelAnimationFrame(avatarRAF);
    avatarRAF = null; avatarVol = 0;
    const el = $('asst-avatar');
    if (el) { el.style.setProperty('--asst-glow', '0'); el.style.setProperty('--asst-ringop', '0');
              el.style.setProperty('--asst-scale', '1'); el.style.setProperty('--asst-ring', '1'); }
  }
  /* ---------- 對嘴數字人（LiveTalking）----------
     助理照常負責對話與操作面板；這裡只把它產生的 TTS 語音轉送給 LiveTalking
     渲染嘴型，影像走 WebRTC 回來蓋在頭像位置。LiveTalking 沒開就完全不影響
     原本的靜態頭像 + 音量光暈。全部走 serve.py 同源代理（跨埠會有 CORS，
     面板走 HTTPS 時直接打 http:8010 也會被當混合內容擋掉）。 */
  const lt = { pc: null, sid: null, active: false, buf: [], bytes: 0, connecting: false };

  // 探測 LiveTalking 在不在。用 /is_speaking 當探針：它便宜、且沒開時
  // serve.py 會回 502，不會誤判成「有開」。
  async function ltProbe() {
    try {
      const r = await fetch('/is_speaking', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionid: 'probe' }),
      });
      return r.status === 200;
    } catch (e) { return false; }
  }

  async function ltConnect() {
    if (lt.active || lt.connecting) return;
    lt.connecting = true;
    try {
      if (!await ltProbe()) return;            // 沒開就安靜退回靜態頭像
      const pc = new RTCPeerConnection();
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      const stream = new MediaStream();
      pc.addEventListener('track', e => {
        stream.addTrack(e.track);
        const v = $('asst-avatar-video');
        if (v && v.srcObject !== stream) v.srcObject = stream;
      });
      await pc.setLocalDescription(await pc.createOffer());
      // 等 ICE 收集完再送 offer（這個實作不吃 trickle ICE）；設上限免得卡住
      await new Promise(res => {
        if (pc.iceGatheringState === 'complete') return res();
        const chk = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', chk); res(); } };
        pc.addEventListener('icegatheringstatechange', chk);
        setTimeout(res, 5000);
      });
      const r = await fetch('/offer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: pc.localDescription.sdp, type: pc.localDescription.type }),
      });
      if (!r.ok) throw new Error('offer ' + r.status);
      const answer = await r.json();
      // 服務端拒絕時回的是 {code:-1, msg:...}（沒有 sdp）。最常見的是
      // 「Maximum session limit reached」——舊分頁沒關、session 沒被釋放。
      if (!answer.sdp) {
        throw new Error(answer.msg || '對嘴服務未回傳 SDP'
          + (String(answer.msg).includes('session limit') ? '（請重啟 LiveTalking 釋放 session）' : ''));
      }
      // 回應除了 sdp/type 還夾帶 sessionid，整包丟進去會 Failed to parse
      // SessionDescription——只取這兩個欄位。
      await pc.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
      lt.pc = pc; lt.sid = answer.sessionid; lt.active = true;
      const stage = $('asst-avatar');
      if (stage) { stage.classList.add('lt-on'); stage.dataset.ltSession = answer.sessionid; }
      log('對嘴數字人已連線（助理講話時嘴型會跟著動）', 'ok');
    } catch (e) {
      log('對嘴服務連線失敗，改用靜態頭像：' + e.message, 'warn');
      ltDisconnect();
    } finally { lt.connecting = false; }
  }

  // 關分頁／重整時一定要把 pc 關掉釋放 session。LiveTalking 的 max_session 預設
  // 只有 5，開發時反覆重整很快就會 "Maximum session limit reached (5/5)"，之後
  // 連不上還以為是程式壞了。
  addEventListener('pagehide', () => { if (lt.pc) { try { lt.pc.close(); } catch (e) {} } });

  function ltDisconnect() {
    if (lt.pc) { try { lt.pc.close(); } catch (e) {} }
    lt.pc = null; lt.sid = null; lt.active = false; lt.buf = []; lt.bytes = 0;
    const v = $('asst-avatar-video');
    if (v) v.srcObject = null;
    const stage = $('asst-avatar');
    if (stage) { stage.classList.remove('lt-on'); delete stage.dataset.ltSession; }
  }

  // 助理的 TTS 是逐塊 PCM 串流過來的，但 /humanaudio 收的是完整檔案，
  // 所以整句先收在 lt.buf，等這輪回覆結束再打包送出。
  function ltCollect(bytes) { lt.buf.push(bytes); lt.bytes += bytes.length; }

  function ltWav(rate) {
    const n = lt.bytes;
    const out = new Uint8Array(44 + n);
    const dv = new DataView(out.buffer);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); dv.setUint32(4, 36 + n, true); ws(8, 'WAVEfmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    ws(36, 'data'); dv.setUint32(40, n, true);
    let off = 44;
    for (const b of lt.buf) { out.set(b, off); off += b.length; }
    return out;
  }

  async function ltFlush() {
    if (!lt.active || !lt.bytes) { lt.buf = []; lt.bytes = 0; return; }
    const rate = (window.YZ_CONFIG && window.YZ_CONFIG.ASSISTANT_TTS_RATE) || ASST_RATE;
    const wav = ltWav(rate);
    lt.buf = []; lt.bytes = 0;
    try {
      const fd = new FormData();
      fd.append('sessionid', lt.sid);
      fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'a.wav');
      const r = await fetch('/humanaudio', { method: 'POST', body: fd });
      if (!r.ok) throw new Error('humanaudio ' + r.status);
    } catch (e) {
      log('送給對嘴服務失敗：' + e.message, 'warn');
    }
  }

  function playAsstAudio(b64) {
    // 播放取樣率必須等於服務端送出的取樣率。這裡原本寫 24000（Qwen3-TTS 的原生
    // 取樣率），但服務端會先把音訊重取樣成 PIPELINE_SR=16000 才送出——用 24000
    // 播 16k 的資料等於 1.5 倍速，聽起來又快又尖。輸入端的 ASST_RATE 一直都是
    // 16000，是同一條管線的兩端寫了不同數字。
    const rate = (window.YZ_CONFIG && window.YZ_CONFIG.ASSISTANT_TTS_RATE) || ASST_RATE;
    if (!play.ctx) {
      play.ctx = new AudioContext();
      // 頭像用的音量分析：接在播放鏈與喇叭之間，只讀不改音訊
      play.analyser = play.ctx.createAnalyser();
      play.analyser.fftSize = 512;
      play.analyser.connect(play.ctx.destination);
    }
    const bin = atob(b64);
    // 對嘴模式：音訊改由 LiveTalking 播（它要拿去驅動嘴型，聲音會隨 WebRTC 一起
    // 回來）。這裡就不能再本地播一次，否則會聽到兩份、而且跟嘴型對不上。
    if (lt.active) {
      const raw = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
      ltCollect(raw);
      return;
    }
    const i16 = new Int16Array(bin.length / 2);
    for (let i = 0; i < i16.length; i++) i16[i] = (bin.charCodeAt(i * 2 + 1) << 8) | bin.charCodeAt(i * 2);
    const buf = play.ctx.createBuffer(1, i16.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < i16.length; i++) ch[i] = (i16[i] >= 0x8000 ? i16[i] - 0x10000 : i16[i]) / 0x8000;
    const src = play.ctx.createBufferSource();
    src.buffer = buf; src.connect(play.analyser || play.ctx.destination);
    play.at = Math.max(play.at, play.ctx.currentTime);
    src.start(play.at);
    play.at += buf.duration;
    play.srcs.push(src);
    src.onended = () => { play.srcs = play.srcs.filter(s => s !== src); };
  }
  function stopAsstAudio() {
    play.srcs.forEach(s => { try { s.stop(); } catch (e) {} });
    play.srcs = [];
    if (play.ctx) play.at = play.ctx.currentTime;
    // 對嘴模式：丟掉還沒送出的語音，並叫 LiveTalking 停止播報。少了這段，
    // 使用者插話打斷後，數字人還會把上一輪的話講完。
    if (lt.active) {
      lt.buf = []; lt.bytes = 0;
      fetch('/interrupt_talk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionid: lt.sid }),
      }).catch(() => {});
    }
  }

  /* ---------- 打字輸入 ---------- */
  // 打字不需要麥克風，也不需要安全來源——所以只連 WS，不碰 getUserMedia。
  // 這也讓助理在手機用 http 連（拿不到麥克風）時仍然可用。
  async function asstSubmitText() {
    const input = $('asst-input');
    const text = input.value.trim();
    if (!text) return;
    const btn = $('asst-send');
    btn.disabled = true;
    try {
      if (!asst.ws || asst.ws.readyState !== WebSocket.OPEN) {
        asstState('連線中…', 'thinking');
        await asstConnect();
      }
      input.value = '';
      stopAsstAudio();            // 打斷正在播的回覆，跟開口說話同語意
      asst.bubble = null;
      asstSay('me', text);
      // 服務端明確要求兩步：item.create 只把訊息塞進 LLM 脈絡，不會觸發生成，
      // 要再送 response.create 才會回應（見 handlers/conversation.py 的註解）。
      asstSend({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      });
      asstSend({ type: 'response.create' });
      asstState('思考中…', 'thinking');
    } catch (e) {
      asstSay('act', '送出失敗：' + e.message);
      asstState(asst.live ? '聆聽中' : '尚未啟動', asst.live ? 'listening' : null);
    } finally {
      btn.disabled = false;
      input.focus();
    }
  }

  /* ---------- 連線與音訊擷取 ---------- */
  async function asstToggleMic() {
    if (asst.live) { asstStop(); return; }
    // 提示詞的 🎤 與助理不能同時佔用麥克風
    if (voiceOn) stopVoice();
    try { await asstStart(); }
    catch (e) {
      asstState('無法啟動', null);
      asstSay('act', '啟動失敗：' + e.message);
      log('助理啟動失敗：' + e.message, 'err');
      asstStop();
    }
  }

  async function asstStart() {
    if (!navigator.mediaDevices || !window.isSecureContext)
      throw new Error('需要安全來源（localhost 或 HTTPS）才能取得麥克風');

    asstState('連線中…', 'thinking');
    await asstConnect();

    asst.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    // 直接指定 16kHz 讓瀏覽器自己重取樣，省掉手寫 resample
    asst.ctx = new AudioContext({ sampleRate: ASST_RATE });
    const src = asst.ctx.createMediaStreamSource(asst.stream);
    // ScriptProcessor 雖已標記淘汰，但相容性最好、程式碼最短。
    // 這是本地工具且只在對話時啟用，用 AudioWorklet 的複雜度不划算。
    // 輸出聲道必須是 1 不能是 0：0 輸出的節點無法 connect 到任何 destination
    // （會丟 cannot connect a ScriptProcessorNode with 0 output channels），
    // 而 Chrome 不接上 destination 又根本不會觸發 onaudioprocess。
    asst.node = asst.ctx.createScriptProcessor(4096, 1, 1);
    asst.node.onaudioprocess = e => {
      const f32 = e.inputBuffer.getChannelData(0);
      let peak = 0;
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const v = Math.max(-1, Math.min(1, f32[i]));
        i16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
      asstLevel(peak);
      asstSend({ type: 'input_audio_buffer.append', audio: b64FromBytes(new Uint8Array(i16.buffer)) });
    };
    // 中間夾一顆增益 0 的節點：節點要被拉才會觸發 onaudioprocess，但直接接喇叭
    // 會把麥克風的聲音播出來造成回授。靜音接法兩者兼顧。
    asst.mute = asst.ctx.createGain();
    asst.mute.gain.value = 0;
    src.connect(asst.node);
    asst.node.connect(asst.mute);
    asst.mute.connect(asst.ctx.destination);

    asst.live = true;
    setMicUI(true);
    asstState('聆聽中', 'listening');
  }

  function asstStop() {
    asst.live = false;
    if (asst.node) { asst.node.onaudioprocess = null; asst.node.disconnect(); asst.node = null; }
    if (asst.mute) { asst.mute.disconnect(); asst.mute = null; }
    if (asst.stream) { asst.stream.getTracks().forEach(t => t.stop()); asst.stream = null; }
    if (asst.ctx) { asst.ctx.close().catch(() => {}); asst.ctx = null; }
    if (asst.ws) { try { asst.ws.close(); } catch (e) {} asst.ws = null; }
    setMicUI(false);
    asstLevel(0);
    asstState('已停止', null);
  }

  function setMicUI(on) {
    $('asst-mic').classList.toggle('on', on);
    $('asst-mic-label').textContent = on ? '停止聆聽' : '開始聆聽';
  }
  function asstLevel(peak) {
    const bar = $('asst-level')?.firstElementChild;
    if (bar) bar.style.width = Math.min(100, peak * 160).toFixed(0) + '%';
  }
  function asstSend(obj) {
    if (asst.ws && asst.ws.readyState === WebSocket.OPEN) asst.ws.send(JSON.stringify(obj));
  }
  // 音訊逐塊送出，量不小；用 chunk 迴圈避免 String.fromCharCode 參數過多爆掉
  function b64FromBytes(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function asstConnect() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(ASST_URL);
      ws.binaryType = 'arraybuffer';
      const fail = () => rej(new Error(`連不上語音服務 ${ASST_URL}，請確認 speech-to-speech 已啟動`));
      ws.onopen = () => {
        asst.ws = ws;
        asstSend(buildSessionUpdate());
        res();
      };
      ws.onerror = fail;
      ws.onclose = () => {
        // 一定要清掉，否則打字模式會拿著已關閉的 ws 當作「還連著」而送不出去
        if (asst.ws === ws) asst.ws = null;
        if (asst.live) { asstSay('act', '連線中斷'); asstStop(); }
      };
      ws.onmessage = ev => { try { onAsstEvent(JSON.parse(ev.data)); } catch (e) {} };
    });
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
    setupVoiceInput();
    $('gallery-clear').onclick = clearGallery;
    const toggleLog = () => {
      const collapsed = $('log-card').classList.toggle('collapsed');
      $('log-head').setAttribute('aria-expanded', String(!collapsed));
    };
    $('log-head').onclick = toggleLog;
    // div 掛了 role=button 就得自己補鍵盤操作，瀏覽器只對真正的 button 自動處理
    $('log-head').onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLog(); }
    };
    $('assistant-btn').onclick = () => setAssistant(!asst.open);
    $('asst-close').onclick = () => setAssistant(false);
    $('asst-mic').onclick = asstToggleMic;
    document.querySelectorAll('#asst-modes button').forEach(b =>
      b.onclick = () => setAsstMode(b.dataset.mode));
    // 頭像圖不進公開版控（見 .gitignore）：clone 下來沒有圖時，隱藏整個頭像舞台
    // 而不是留一個破圖 icon。
    const avImg = $('asst-avatar-img');
    if (avImg) avImg.onerror = () => { const a = $('asst-avatar'); if (a) a.style.display = 'none'; };
    $('asst-send').onclick = asstSubmitText;
    $('asst-input').onkeydown = e => {
      // 只認 Enter；輸入法組字中的 Enter（isComposing）是在選字，不能當送出
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); asstSubmitText(); }
    };
    setAssistant(false);   // 初始收合，並讓 inert 生效
    document.addEventListener('keydown', onGlobalKey);
    // 沒有這兩行的話，把圖片拖到上傳區以外會讓瀏覽器直接開啟該檔案、離開整個面板
    ['dragover', 'drop'].forEach(t => document.addEventListener(t, e => e.preventDefault()));
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
      if ($('lightbox').classList.contains('on')) { $('lightbox').classList.remove('on'); return; }
      if (asst.open) setAssistant(false);
    }
  }

  /* ---------------- AI 提示詞優化（Groq） ---------------- */
  const GROQ_KEYS = window.YZ_CONFIG?.GROQ_API_KEYS || [];
  const GROQ_KEY = window.YZ_CONFIG?.GROQ_API_KEY || GROQ_KEYS[0] || '';
  // 提示詞優化直接從瀏覽器打 Groq（語音服務那條走 groq_proxy，前端這條沒代理）。
  // 某把 key 撞每日上限（429）就換下一把重試。
  async function groqChatFetch(bodyObj) {
    const keys = GROQ_KEYS.length ? GROQ_KEYS : (GROQ_KEY ? [GROQ_KEY] : []);
    let lastErr;
    for (const k of keys) {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k },
        body: JSON.stringify(bodyObj),
      });
      if (res.status === 429) { lastErr = new Error('Groq 每日上限（429）'); continue; }
      if (!res.ok) throw new Error(`Groq API ${res.status}`);
      return res;
    }
    throw lastErr || new Error('沒有可用的 Groq key');
  }
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
    if (!GROQ_KEY && !GROQ_KEYS.length) { log('未設定 Groq API Key，請建立 config.js', 'err'); return; }
    const btn = $('ai-btn');
    btn.classList.add('loading');
    ta.value = '';
    try {
      const sys = (AI_SYSTEM[state.engine] || AI_SYSTEM.flux2klein) + CONTENT_RULE + NSFW_RULE;
      const res = await groqChatFetch({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: text },
        ],
        temperature: 1, max_completion_tokens: 2048, top_p: 1, stream: true,
      });
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

  /* ---------------- 語音輸入（Web Speech API）---------------- */
  // 注意：Chrome 的實作會把語音音訊送到 Google 伺服器辨識（見 README 隱私說明）。
  // 只在 localhost / HTTPS 等安全來源可用；手機透過 http 區網 IP 連線時瀏覽器不給麥克風。
  let voiceRecog = null, voiceOn = false, voiceCommitted = '';
  function setupVoiceInput() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = $('mic-btn'), ta = $('prompt');
    if (!btn) return;
    if (!SR) { btn.style.display = 'none'; return; }   // 不支援（如 Firefox）就藏起來
    voiceRecog = new SR();
    voiceRecog.lang = 'zh-TW';
    voiceRecog.interimResults = true;
    voiceRecog.continuous = true;
    voiceRecog.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) voiceCommitted += r[0].transcript;
        else interim += r[0].transcript;
      }
      ta.value = voiceCommitted + interim;        // 已定稿的接在後面，臨時結果即時預覽
    };
    voiceRecog.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed')
        log('麥克風權限被拒，請在瀏覽器網址列允許麥克風後再試。', 'err');
      else if (e.error === 'no-speech') log('沒聽到聲音，請再說一次。', 'warn');
      else if (e.error !== 'aborted') log('語音辨識錯誤：' + e.error, 'warn');
    };
    voiceRecog.onend = () => setVoiceState(false);   // 靜音一段或呼叫 stop 都會觸發
    btn.onclick = () => voiceOn ? stopVoice() : startVoice();
  }
  function startVoice() {
    if (!voiceRecog) return;
    const cur = $('prompt').value;
    voiceCommitted = cur ? cur.replace(/\s+$/, '') + ' ' : '';   // 接在既有文字之後
    try { voiceRecog.start(); setVoiceState(true); }
    catch (e) { /* 已在錄音中重複 start 會丟錯，忽略 */ }
  }
  function stopVoice() { if (voiceRecog) { try { voiceRecog.stop(); } catch (e) {} } setVoiceState(false); }
  function setVoiceState(on) {
    voiceOn = on;
    const btn = $('mic-btn');
    if (!btn) return;
    btn.classList.toggle('on', on);
    btn.title = on ? '停止語音輸入' : '語音輸入（點一下開始／停止）';
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
