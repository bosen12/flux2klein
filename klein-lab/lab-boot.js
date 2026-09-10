/* lab-boot.js —— KLEIN LAB 的開機層。
 *
 * 這一版刻意「不動 app.js」：/klein 與 /lab 共用同一份 158KB 的主邏輯，原面板修
 * 什麼、這邊就跟著修什麼，不會分叉。所以凡是需要改變 app.js 行為的事情（目前只有
 * 一件：/object_info 要走精簡端點），都在這裡用最小的攔截做掉，並且失敗一定退回
 * 原本的路徑——寧可慢，不能壞。
 *
 * 必須排在 app.js 前面載入。
 */
(() => {
  'use strict';

  /* ── 1. /object_info → /panel/object_info ───────────────────────────────
   * ComfyUI 的 /object_info 是 14.16MB / 3198 個節點類別，而這個面板只查得到
   * 自己四份 workflow 裡出現過的 51 個（converter.js 的 _validInputNames 與
   * fixModelNames 都是拿 class_type 去查表）。serve.py 的 /panel/object_info
   * 會先濾過再送：195KB，gzip 後 41KB。
   *
   * 用攔 fetch 而不是改 app.js，是因為那支檔案兩套前端共用。攔截範圍收到最窄：
   * 只有 same-origin 且 pathname 剛好是 /object_info 的 GET 才改寫。 */
  const nativeFetch = window.fetch.bind(window);
  let slimOk = true;                    // 精簡端點失敗過就不再嘗試（舊版 serve.py）

  window.fetch = function (input, init) {
    try {
      if (slimOk && (!init || !init.method || init.method.toUpperCase() === 'GET')) {
        const raw = typeof input === 'string' ? input : (input && input.url);
        if (raw) {
          const u = new URL(raw, location.href);
          if (u.origin === location.origin && u.pathname === '/object_info') {
            u.pathname = '/panel/object_info';
            return nativeFetch(u.href, init).then(res => {
              if (res.ok || res.status === 304 || res.status === 502) return res;
              // 端點不存在（舊版 serve.py）→ 這次與之後都退回完整版
              slimOk = false;
              return nativeFetch(raw, init);
            }).catch(err => { slimOk = false; return nativeFetch(raw, init).catch(() => { throw err; }); });
          }
        }
      }
    } catch (e) { /* URL 解析失敗就當作沒攔到 */ }
    return nativeFetch(input, init);
  };

  /* ── 2. 深／淺色票 ─────────────────────────────────────────────────────
   * 版面與動效兩套完全一樣，只有色票不同。記在 localStorage，跟原面板互不干擾
   * （key 有 lab 前綴）。沒選過就跟系統走。 */
  const SKIN_KEY = 'klein.lab.skin';
  const THEME_COLOR = { dark: '#1c1a17', light: '#f0ece5' };
  const root = document.documentElement;

  function applySkin(skin) {
    root.dataset.skin = skin;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = THEME_COLOR[skin] || THEME_COLOR.dark;
  }

  let stored = null;
  try { stored = localStorage.getItem(SKIN_KEY); } catch (e) {}
  applySkin(stored || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

  /* ── 3. 顏料牌 ──────────────────────────────────────────────────────────
   * 四個引擎各錨在一個真實顏料上（這是原專案就有的設定，不是我編的），把它寫在
   * 頂樑上：切引擎時整個介面換色，讀得到換的是哪一個顏料。 */
  const PIGMENTS = {
    flux2klein:  { name: '國際克萊因藍', hex: '#002fa7' },
    zimage:      { name: '鎘橙',        hex: '#c2461a' },
    krea2:       { name: '帝王紫',      hex: '#6e2350' },
    illustrious: { name: '茜紅',        hex: '#b93659' },
  };

  function paintPigment() {
    const p = PIGMENTS[root.dataset.engine];
    const nameEl = document.getElementById('pigment-name');
    const hexEl = document.getElementById('pigment-hex');
    if (!p || !nameEl || !hexEl) return;
    nameEl.textContent = p.name;
    hexEl.textContent = p.hex;
  }

  document.addEventListener('DOMContentLoaded', () => {
    /* 色票切換鈕 */
    const btn = document.getElementById('skin-toggle');
    if (btn) btn.addEventListener('click', () => {
      const next = root.dataset.skin === 'dark' ? 'light' : 'dark';
      applySkin(next);
      try { localStorage.setItem(SKIN_KEY, next); } catch (e) {}
    });

    /* app.js 換引擎時只改 documentElement.dataset.engine，沒有事件可聽 —— 用
     * MutationObserver 盯那個屬性，比在 app.js 裡加 hook 乾淨（那支是共用的）。 */
    paintPigment();
    new MutationObserver(paintPigment)
      .observe(root, { attributes: true, attributeFilter: ['data-engine'] });

    /* 送出鍵上的快捷鍵標示要跟平台一致：Windows / Linux 是 Ctrl。
     * 標示畫在 .btn-run::after 上（app.js 會用 textContent 改按鈕字，子節點留不住），
     * 所以這裡設的是 content 用的字串，要自己帶引號。 */
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
    root.style.setProperty('--run-key', mac ? '"⌘ ⏎"' : '"Ctrl ⏎"');

    /* 提示詞字數。自然語言系的引擎建議寫 100–400 字，寫的時候「現在多長」是會
     * 影響判斷的資訊，值得一個常駐讀數。 */
    const ta = document.getElementById('prompt');
    const wrap = ta && ta.closest('.prompt-wrap');
    if (ta && wrap) {
      const count = document.createElement('span');
      count.className = 'prompt-count';
      count.setAttribute('aria-hidden', 'true');
      wrap.appendChild(count);
      const paint = () => { count.textContent = ta.value.length ? ta.value.length + ' 字' : ''; };
      ta.addEventListener('input', paint);
      // app.js 換模式／選詞庫／AI 優化都是直接寫 .value——那既不發 input 事件，
      // 也不動 DOM（textarea 的 value 不是子節點），MutationObserver 一樣收不到。
      // 只在這一個元素上包住 value 的 setter，不用輪詢。
      const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (desc && desc.get && desc.set) {
        Object.defineProperty(ta, 'value', {
          configurable: true,
          get() { return desc.get.call(this); },
          set(v) { desc.set.call(this, v); paint(); },
        });
      }
      paint();
    }

    /* 畫布形狀讀數 */
    buildCanvasRead();
  });

  /* app.js 改欄位值是直接寫 .value（換模式、點比例晶片、AI 優化都是），既不發
   * input 事件、也不動 DOM。要跟上就得包住那個元素的 value setter。 */
  function onValue(el, cb) {
    el.addEventListener('input', cb);
    const desc = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
    if (!desc || !desc.get || !desc.set) return;
    Object.defineProperty(el, 'value', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); cb(); },
    });
  }

  function gcd(a, b) { return b ? gcd(b, a % b) : a; }

  /* 比例晶片只在建立當下比對過一次寬高，之後手打尺寸、或 AI 助理／模式預設改了
   * 尺寸，晶片都還亮在原地——一個會說謊的控制項。改成每次尺寸變動重新判定。
   *
   * 比的是「這個晶片會設出來的實際像素」，不是標籤上的比例：這五組是 SDXL 的
   * bucket，896×1152 標成 3:4 但其實是 0.778（差 3.7%），只有 1:1 是準的。
   * 照標籤的比例比，768×1024 會亮起 3:4 ——但點那顆晶片給的是 896×1152，
   * 亮了等於騙人。表格必須跟 app.js 的 ASPECT_PRESETS 一致（那是 IIFE 裡的
   * 區域常數，外面讀不到，只能抄一份）；不一致的後果只是某顆晶片不會亮，不會壞。 */
  const ASPECTS = [[1024, 1024], [896, 1152], [1152, 896], [768, 1344], [1344, 768]];

  function syncAspects(W, H) {
    const box = document.getElementById('aspect-presets');
    if (!box) return;
    box.querySelectorAll('.aspect').forEach((b, i) => {
      const p = ASPECTS[i];
      b.classList.toggle('active', !!p && p[0] === W && p[1] === H);
    });
  }

  function buildCanvasRead() {
    const sec = document.getElementById('canvas-sec');
    const w = document.getElementById('width');
    const h = document.getElementById('height');
    const sizeField = document.getElementById('size-field');
    const frame = document.getElementById('canvas-frame');
    if (!sec || !w || !h || !sizeField || !frame) return;
    const dims = document.getElementById('canvas-dims');
    const ratio = document.getElementById('canvas-ratio');
    const mp = document.getElementById('canvas-mp');

    const paint = () => {
      // 沒有尺寸欄位的模式（單/雙/三圖編輯、局部重繪、圖像擴展）畫布來自上傳圖，
      // 面板這邊沒有數字可讀，整段收起來比顯示一個假的 1024 誠實。
      const hasSize = sizeField.style.display !== 'none';
      sec.hidden = !hasSize;
      if (!hasSize) return;
      const W = Math.max(1, +w.value || 0), H = Math.max(1, +h.value || 0);
      // 長邊固定 132px 畫出等比例的框
      const long = 132, r = W / H;
      frame.style.width = (r >= 1 ? long : Math.round(long * r)) + 'px';
      frame.style.height = (r >= 1 ? Math.round(long / r) : long) + 'px';
      const g = gcd(W, H);
      dims.textContent = W + ' × ' + H;
      ratio.textContent = (W / g) + ':' + (H / g);
      mp.textContent = (W * H / 1e6).toFixed(2) + ' MP';
      syncAspects(W, H);
    };

    onValue(w, paint);
    onValue(h, paint);
    // 換模式時 app.js 是改 style.display，沒有事件；盯那一個屬性就夠
    new MutationObserver(paint).observe(sizeField, { attributes: true, attributeFilter: ['style'] });
    paint();
  }
})();
