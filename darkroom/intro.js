/* 詞庫暗房產品門面。印樣瀑布著色器從 darkroom.js 移植，刻意不重構本體。 */
(() => {
  const $ = (id) => document.getElementById(id);
  const AGE_GATE_KEY = 'yz-age-verified';
  const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const INTRO_COLS = 8, INTRO_ROWS = 8;
  const INTRO_FLOW_MIN = 0.30, INTRO_FLOW_VAR = 0.22;
  const INTRO_FADE_MS = 900;
  const INTRO_CELL_FAILED = -2;
  const INTRO_WARMUP_RATIO = 0.55, INTRO_WARMUP_MAX_MS = 2200;

  const _PREVIEW_MAX_CONCURRENT = 4;
  let _previewActive = 0;
  const _previewQueue = [];
  function _previewRunNext() {
    if (_previewActive >= _PREVIEW_MAX_CONCURRENT) return;
    const job = _previewQueue.shift();
    if (!job) return;
    _previewActive++;
    job(() => { _previewActive--; _previewRunNext(); });
  }
  function _previewEnqueue(job) {
    _previewQueue.push(job);
    _previewRunNext();
  }

  let introGL = null;
  let introRAF = null;
  let introT0 = 0;
  let introPausedAt = 0;
  let introPool = [];
  let introAtlas = null;
  let sheetWanted = false;

  const INTRO_VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  const INTRO_FRAG = `
precision highp float;
varying vec2 vUv;
uniform vec2  uRes;
uniform float uTime;
uniform sampler2D uTex;
uniform sampler2D uCell;

const float COLS = ${INTRO_COLS}.0;
const float ROWS = ${INTRO_ROWS}.0;

float hash11(float n) { return fract(sin(n * 127.1) * 43758.5453); }

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
  float cw = aspect / COLS;

  float cf = (p.x + aspect * 0.5) / cw;
  float ci = floor(cf);
  float fx = cf - ci;

  float sp = ${INTRO_FLOW_MIN.toFixed(2)} + ${INTRO_FLOW_VAR.toFixed(2)} * hash11(ci + 0.5);
  float rf = (0.5 - p.y) / cw - uTime * sp + hash11(ci + 11.7) * ROWS;
  float ri = floor(rf);
  float fy = rf - ri;

  vec2 cell = vec2(mod(ci, COLS), mod(ri, ROWS));
  vec2 uv = (cell + vec2(fx, fy)) / vec2(COLS, ROWS);
  vec3 bg = vec3(0.031, 0.035, 0.051);

  float f = texture2D(uCell, (cell + 0.5) / vec2(COLS, ROWS)).r;
  vec3 col = mix(bg, texture2D(uTex, uv).rgb, f * f * (3.0 - 2.0 * f));
  col *= 1.0 - 0.30 * pow(clamp(length(p) * 0.80, 0.0, 1.0), 2.2);
  gl_FragColor = vec4(col, 1.0);
}`;

  function introCompile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[intro] shader 編譯失敗：', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function introInitGL() {
    const canvas = $('intro-gl');
    if (!canvas) return null;
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' })
            || canvas.getContext('experimental-webgl');
    if (!gl) return null;
    const vs = introCompile(gl, gl.VERTEX_SHADER, INTRO_VERT);
    const fs = introCompile(gl, gl.FRAGMENT_SHADER, INTRO_FRAG);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[intro] program link 失敗：', gl.getProgramInfoLog(prog));
      return null;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([8, 9, 13]));

    const cellTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, cellTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, INTRO_COLS, INTRO_ROWS, 0,
                  gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(INTRO_COLS * INTRO_ROWS));
    gl.activeTexture(gl.TEXTURE0);

    const loc = {};
    for (const n of ['uRes','uTime','uTex','uCell']) loc[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(loc.uTex, 0);
    gl.uniform1i(loc.uCell, 1);
    return { gl, prog, loc, tex, cellTex, canvas };
  }

  function introResize() {
    if (!introGL) return;
    const { gl, canvas, loc } = introGL;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    // uRes 每次都要寫：它是 program 的 uniform，畫布尺寸是元素屬性。重開 program
    // 時若跟著尺寸提早 return，uRes 停在 0，aspect 變 NaN，整片全黑。
    gl.uniform2f(loc.uRes, w, h);
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w; canvas.height = h;
    gl.viewport(0, 0, w, h);
  }

  function introCellSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const want = (window.innerWidth * dpr) / INTRO_COLS;
    for (const s of [128, 192, 256]) if (s >= want) return s;
    return 256;
  }

  function introBuildAtlas() {
    const cell = introCellSize();
    const canvas = document.createElement('canvas');
    canvas.width = INTRO_COLS * cell; canvas.height = INTRO_ROWS * cell;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#08090d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const n = INTRO_COLS * INTRO_ROWS;
    return {
      canvas, ctx, cell, dirty: true, count: 0,
      reveal: performance.now(),
      at: new Float64Array(n).fill(-1),
      lag: Float64Array.from({ length: n }, () => Math.random() * 420),
      px: new Uint8Array(n),
      fading: true,
    };
  }

  function introLoadCells() {
    if (!introAtlas || !introPool.length) return;
    const cell = introAtlas.cell;
    for (let i = 0; i < INTRO_COLS * INTRO_ROWS; i++) {
      const it = introPool[i % introPool.length];
      if (!it) continue;
      const img = new Image();
      img.decoding = 'async';
      img.fetchPriority = 'low';
      img.onload = () => {
        if (introAtlas) {
          const cx = (i % INTRO_COLS) * cell, cy = Math.floor(i / INTRO_COLS) * cell;
          const s = Math.min(img.width, img.height);
          introAtlas.ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s,
                                   cx + 2, cy + 2, cell - 4, cell - 4);
          introAtlas.dirty = true;
          if (introAtlas.at[i] < 0) { introAtlas.at[i] = performance.now(); introAtlas.count++; }
          introAtlas.fading = true;
        }
        if (img._releasePreviewSlot) img._releasePreviewSlot();
      };
      img.onerror = () => {
        if (introAtlas && introAtlas.at[i] < 0) { introAtlas.at[i] = INTRO_CELL_FAILED; introAtlas.count++; }
        if (img._releasePreviewSlot) img._releasePreviewSlot();
      };
      _previewEnqueue((done) => {
        img._releasePreviewSlot = done;
        img.src = `/api/thumb?rel=${encodeURIComponent(it.rel)}&v=${it.image_mtime}&w=${cell}`;
      });
    }
  }

  function introFrame(now) {
    if (!introGL || !sheetWanted) { introRAF = null; return; }
    const { gl, loc } = introGL;
    if (!introT0) introT0 = now;
    introResize();

    if (introAtlas && introAtlas.dirty) {
      gl.bindTexture(gl.TEXTURE_2D, introGL.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, introAtlas.canvas);
      introAtlas.dirty = false;
    }
    if (introAtlas && introAtlas.fading) {
      let moving = false;
      for (let i = 0; i < introAtlas.px.length; i++) {
        const t0 = introAtlas.at[i];
        if (t0 === INTRO_CELL_FAILED) continue;
        if (t0 < 0) { moving = true; continue; }
        const start = Math.max(t0, introAtlas.reveal) + introAtlas.lag[i];
        const k = Math.min(1, Math.max(0, (now - start) / INTRO_FADE_MS));
        introAtlas.px[i] = Math.round(k * 255);
        if (k < 1) moving = true;
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, introGL.cellTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, INTRO_COLS, INTRO_ROWS, 0,
                    gl.LUMINANCE, gl.UNSIGNED_BYTE, introAtlas.px);
      gl.activeTexture(gl.TEXTURE0);
      introAtlas.fading = moving;
    }

    gl.uniform1f(loc.uTime, (now - introT0) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    introRAF = requestAnimationFrame(introFrame);
  }

  function introFallback() {
    const box = $('intro-fallback');
    if (!box || !introPool.length) return;
    box.hidden = false;
    box.innerHTML = '';
    const cell = introCellSize();
    for (let c = 0; c < INTRO_COLS; c++) {
      const colEl = document.createElement('div');
      colEl.className = 'intro-fb-col';
      const sp = INTRO_FLOW_MIN + INTRO_FLOW_VAR * ((c * 7 % 5) / 5);
      colEl.style.setProperty('--dur', (INTRO_ROWS / sp).toFixed(1) + 's');
      colEl.style.setProperty('--delay', (-((c * 3.7) % INTRO_ROWS) / sp).toFixed(1) + 's');
      const inner = document.createElement('div');
      inner.className = 'intro-fb-run';
      for (let k = 0; k < INTRO_ROWS * 2; k++) {
        const it = introPool[(c * INTRO_ROWS + (k % INTRO_ROWS)) % introPool.length];
        const img = new Image();
        img.alt = ''; img.decoding = 'async'; img.fetchPriority = 'low';
        const lag = Math.round(Math.random() * 420);
        img.style.transitionDelay = lag + 'ms';
        img.addEventListener('load', () => {
          img.classList.add('in');
          setTimeout(() => { img.style.transitionDelay = ''; }, lag + INTRO_FADE_MS + 60);
        }, { once: true });
        img.addEventListener('error', () => { if (img._releasePreviewSlot) img._releasePreviewSlot(); }, { once: true });
        img.addEventListener('load', () => { if (img._releasePreviewSlot) img._releasePreviewSlot(); }, { once: true });
        _previewEnqueue((done) => {
          img._releasePreviewSlot = done;
          img.src = `/api/thumb?rel=${encodeURIComponent(it.rel)}&v=${it.image_mtime}&w=${cell}`;
        });
        inner.appendChild(img);
      }
      colEl.appendChild(inner);
      box.appendChild(colEl);
    }
  }

  function pauseSheet() {
    if (!introRAF) return;
    cancelAnimationFrame(introRAF);
    introRAF = null;
    if (introT0) introPausedAt = (performance.now() - introT0) / 1000;
  }

  function resumeSheet() {
    if (!sheetWanted || !introGL || introRAF) return;
    introT0 = performance.now() - introPausedAt * 1000;
    introRAF = requestAnimationFrame(introFrame);
  }

  function fmt(n) { return Number(n).toLocaleString('en-US'); }

  function nameOf(it) {
    const rel = String(it.rel || '').replace(/\\/g, '/');
    return rel.split('/').pop().replace(/\.py$/i, '');
  }

  function thumb(it, w) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = `/api/thumb?rel=${encodeURIComponent(it.rel)}&v=${it.image_mtime}&w=${w}`;
    return img;
  }

  function fillStats(data) {
    const kicker = $('intro-kicker');
    if (kicker) kicker.textContent = data.folder || 'CONTACT SHEET';
    const total = data.total || 0, have = data.developed || 0, folders = data.folders || 0;
    const cover = (total && have >= total) ? '100%' : fmt(have);
    document.querySelectorAll('[data-stat]').forEach((el) => {
      const key = el.dataset.stat;
      if (key === 'total') el.textContent = fmt(total);
      else if (key === 'folders') el.textContent = fmt(folders);
      else if (key === 'developed') el.textContent = cover;
    });
  }

  const MODE_CAP = {
    browse: '點格子看名稱。進工具以後，點開是大圖與正向／負向。',
    tag: '角上的點是稀有／特別的記號。真的標記寫在側檔，不改檔名。',
    gen: '亮的幾格正在顯影。單張生成會插隊到批次前面。',
    draw: '抽出 8 張。R 全庫、E 本分類、C 是 Concepts。'
  };

  function applyMode(mode) {
    const wall = $('wall-grid');
    const cap = $('mode-cap');
    if (!wall) return;
    wall.dataset.mode = mode;
    document.querySelectorAll('.mode-rail [role="tab"]').forEach((btn) => {
      const on = btn.dataset.mode === mode;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
    });
    if (cap) cap.textContent = MODE_CAP[mode] || MODE_CAP.browse;
    const frames = [...wall.querySelectorAll('.frame')];
    frames.forEach((el, i) => {
      el.classList.toggle('dev', mode === 'gen' && i % 7 === 0);
      el.classList.toggle('picked', mode === 'draw' && i < 8);
      if (mode === 'draw' && i < 8) {
        el.style.setProperty('--tilt', ((i % 2 ? 1 : -1) * (1.2 + (i % 5) * 0.6)) + 'deg');
      } else {
        el.style.removeProperty('--tilt');
      }
    });
  }

  function bindModeRail() {
    const rail = document.querySelector('.mode-rail');
    if (!rail) return;
    rail.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mode]');
      if (!btn) return;
      applyMode(btn.dataset.mode);
    });
    rail.addEventListener('keydown', (e) => {
      const tabs = [...rail.querySelectorAll('[role="tab"]')];
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        applyMode(next.dataset.mode);
      }
    });
  }

  function fillWall(sample) {
    const wall = $('wall-grid');
    if (!wall || !sample.length) return;
    const n = Math.min(40, sample.length);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const it = sample[i];
      const fig = document.createElement('figure');
      fig.className = 'frame';
      const cap = document.createElement('figcaption');
      cap.textContent = nameOf(it);
      fig.append(thumb(it, 192), cap);
      frag.appendChild(fig);
    }
    wall.appendChild(frag);
    applyMode('browse');
  }

  function fillStrips(sample) {
    if (!sample.length) return;
    document.querySelectorAll('.bath-strip').forEach((film) => {
      const offset = Number(film.dataset.offset) || 0;
      const run = document.createElement('div');
      run.className = 'strip-run';
      const frames = [];
      for (let i = 0; i < 14; i++) frames.push(sample[(offset + i) % sample.length]);
      const add = (it) => {
        const img = thumb(it, 192);
        img.width = 140; img.height = 140;
        run.appendChild(img);
      };
      frames.forEach(add);
      frames.forEach(add);
      film.appendChild(run);
    });
  }

  function bindKeys() {
    const hint = $('hand-hint');
    const flash = (key) => {
      const card = document.querySelector('.key-card[data-key="' + key + '"]');
      if (!card) return;
      card.classList.add('is-hot');
      setTimeout(() => card.classList.remove('is-hot'), 280);
    };
    document.querySelectorAll('.key-card').forEach((card) => {
      card.addEventListener('click', () => {
        flash(card.dataset.key);
        applyMode('draw');
        if (hint) hint.textContent = '進工具按 ' + card.dataset.key.toUpperCase() + ' 才會真的抽。';
      });
    });
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k !== 'r' && k !== 'e' && k !== 'c') return;
      flash(k);
      applyMode('draw');
    });
  }

  function startSheet() {
    sheetWanted = true;
    introGL = REDUCE_MOTION ? null : introInitGL();
    if (!introGL) { introFallback(); return; }
    introAtlas = introBuildAtlas();
    introResize();
    introLoadCells();
    introT0 = 0;
    introRAF = requestAnimationFrame(introFrame);
  }

  function revealChapters() {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }
    }, { threshold: 0.18 });
    document.querySelectorAll('.sheet, .plate, .quiet').forEach((el) => io.observe(el));
  }

  function watchNav() {
    const nav = $('nav');
    const hero = $('hero');
    if (!nav || !hero) return;
    const io = new IntersectionObserver((entries) => {
      const heroOn = entries.some((e) => e.isIntersecting && e.intersectionRatio > 0.35);
      nav.classList.toggle('is-solid', !heroOn);
    }, { threshold: [0, 0.35, 0.7] });
    io.observe(hero);
  }

  function watchHero() {
    const hero = $('hero');
    if (!hero || REDUCE_MOTION) return;
    const io = new IntersectionObserver((entries) => {
      const vis = entries.some((e) => e.isIntersecting && e.intersectionRatio > 0.08);
      if (vis) resumeSheet(); else pauseSheet();
    }, { threshold: [0, 0.08, 0.4] });
    io.observe(hero);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') pauseSheet();
      else resumeSheet();
    });
  }

  async function startPage() {
    const page = $('page');
    page.hidden = false;
    watchNav();
    revealChapters();
    bindModeRail();
    bindKeys();
    try {
      const r = await fetch('/api/intro');
      if (!r.ok) throw new Error('intro ' + r.status);
      const data = await r.json();
      fillStats(data);
      introPool = data.sample || [];
      fillWall(introPool);
      fillStrips(introPool);
      startSheet();
      watchHero();
    } catch (err) {
      console.warn('[intro] 載入摘要失敗', err);
      fillStats({ total: 0, folders: 0, developed: 0, folder: '' });
    }
  }

  function initAgeGate() {
    const gate = $('age-gate');
    if (sessionStorage.getItem(AGE_GATE_KEY) === '1') {
      gate.remove();
      startPage();
      return;
    }
    let entering = false;
    $('age-gate-enter').addEventListener('click', () => {
      if (entering) return;
      entering = true;
      sessionStorage.setItem(AGE_GATE_KEY, '1');
      const go = () => { gate.remove(); startPage(); };
      if (REDUCE_MOTION || !gate.animate) { go(); return; }
      const anim = gate.animate([{ opacity: 1 }, { opacity: 0 }],
        { duration: 280, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
      let done = false;
      const settle = () => { if (done) return; done = true; go(); };
      anim.finished.then(settle).catch(settle);
      setTimeout(settle, 400);
    });
    $('age-gate-leave').addEventListener('click', () => {
      const card = document.querySelector('.age-gate-card');
      card.innerHTML =
        '<p class="age-gate-eyebrow">年齡限制內容</p><h1>無法使用</h1><p class="age-gate-body">很抱歉，本站僅限已滿 18 歲人士使用。</p>';
    });
  }

  window.addEventListener('resize', introResize);
  initAgeGate();
})();
