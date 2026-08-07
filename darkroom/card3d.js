/* card3d.js —— 可互動、可切換排列（grid/table/sphere/helix）的 3D 卡片場景。
 *
 * 純 vanilla JS，不依賴 three.js（CSS3DRenderer 本質只是拿場景圖數學去寫
 * DOM 的 transform: matrix3d(...)，這裡直接手刻矩陣運算＋Web Animations API
 * 緩動，不用多背一個依賴，也不跟現有的 Vanta.js 背景共用/互相影響）。
 *
 * 呼叫端負責準備卡片 DOM 元素（已經是場景容器的子元素）、負責資料量上限
 * （這個模組不做抽樣/篩選），這個模組只管「這批卡片怎麼排、怎麼互動」。
 * 詳見 docs/superpowers/specs/2026-08-07-darkroom-3d-card-display-design.md。
 */
(function () {
  const REDUCE_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ---- 排列公式：輸入索引 i、總數 n，輸出 {x,y,z,rotX,rotY}（角度制）----
  // 四種都是通用參數化數學公式的重新實作，不是複製任何範例的程式碼。尺度（間距/
  // 半徑）刻意抓比較開闊的數字，配合 CSS perspective 拉遠的鏡頭感，不然卡片會擠成
  // 一團、看起來很平、沒有縱深。
  const LAYOUTS = {
    grid(i, n) {
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      const rows = Math.ceil(n / cols);
      const spacing = 190;
      const col = i % cols, row = Math.floor(i / cols);
      return { x: (col - (cols - 1) / 2) * spacing, y: (row - (rows - 1) / 2) * spacing, z: 0, rotX: 0, rotY: 0 };
    },
    table(i, n) {
      const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.6)));   // 比 grid 扁一點、密一點，視覺上跟 grid 有區別
      const rows = Math.ceil(n / cols);
      const spacing = 132;
      const col = i % cols, row = Math.floor(i / cols);
      return { x: (col - (cols - 1) / 2) * spacing, y: (row - (rows - 1) / 2) * spacing, z: 0, rotX: 0, rotY: 0 };
    },
    sphere(i, n) {
      const radius = 80 * Math.sqrt(Math.max(n, 1)) + 480;
      // Fibonacci sphere：均勻分布在球面上，不會兩極擠成一團。
      const phi = Math.acos(1 - 2 * (i + 0.5) / Math.max(n, 1));
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const x = radius * Math.sin(phi) * Math.cos(theta);
      const y = radius * Math.sin(phi) * Math.sin(theta);
      const z = radius * Math.cos(phi);
      // 卡片面向球心外側（法向量方向朝外，從外面看得到正面，不是看到卡片背面）。
      const rotY = Math.atan2(x, z) * 180 / Math.PI;
      const rotX = -Math.asin(clamp(y / radius, -1, 1)) * 180 / Math.PI;
      return { x, y, z, rotX, rotY };
    },
    helix(i, n) {
      const radius = 55 * Math.sqrt(Math.max(n, 1)) + 380;
      const angleStep = 0.5;   // 每張卡片繞軸多轉的弧度
      const vStep = clamp(4200 / Math.max(n, 1), 18, 50);
      const theta = i * angleStep;
      const x = radius * Math.sin(theta);
      const z = radius * Math.cos(theta);
      const y = (i - n / 2) * vStep;
      const rotY = theta * 180 / Math.PI;
      return { x, y, z, rotX: 0, rotY };
    },
  };

  function transformStr(p) {
    return `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, ${p.z.toFixed(1)}px) rotateX(${p.rotX.toFixed(2)}deg) rotateY(${p.rotY.toFixed(2)}deg)`;
  }
  function randRange(a, b) { return a + Math.random() * (b - a); }
  // 起始散開位置：仿照參考範例，卡片一開始隨機散在一個大立方體裡（不是疊在原點），
  // 這樣第一次排列動畫才有「從亂序飛向定位」的動態，不是原地淡入。
  function scatterPos(spread) {
    return { x: randRange(-spread, spread), y: randRange(-spread, spread), z: randRange(-spread, spread), rotX: 0, rotY: 0 };
  }

  // scene: 場景容器（會被拖曳旋轉/縮放的那層，卡片各自的排列 transform 疊加在
  //   個別卡片上，跟場景整體的 transform 是各自獨立的 CSS 屬性，互不覆蓋）。
  // cards: 已經是 scene 子元素的卡片 DOM 陣列。
  // onCardClick(card, index)：點卡片（非拖曳）時的回呼。stage：實際承接拖曳/滾輪
  // 事件的容器（預設用 scene.parentElement）。scene 本身是 width:0/height:0、靠子
  // 元素（卡片）撐出視覺範圍的容器，點在卡片之間的空白處時事件目標是 stage 不是
  // scene——事件不會從 stage（scene 的父層）「往下」冒泡到 scene，所以拖曳監聽器
  // 一定要掛在 stage，不能掛在 scene，否則點空白處拖曳完全沒反應。
  function createCard3DScene({ scene, cards, onCardClick, stage }) {
    stage = stage || scene.parentElement;
    let rotX = -16, rotY = 8, zoom = -420;   // 往後拉一點，剛進場時就看得到整批卡片的散開範圍，不用先手動縮小
    let dragging = false, dragDist = 0, lastX = 0, lastY = 0, velX = 0, velY = 0;
    let inertiaRAF = null, pinchDist = null;

    // 每張卡片「目前邏輯位置」——不是從 inline style/computed style 反推（WAAPI
    // 動畫進行中，inline style 要等 finished 才會被寫回，中途讀到的永遠是舊值；
    // finished 在分頁背景時可能整個不結算，見 CLAUDE.md）。用這份陣列當唯一真相，
    // 每次切排列都从「上一次記錄的位置」動畫到新位置，不管前一段動畫是否真的播完。
    const current = cards.map(() => scatterPos(1600));
    cards.forEach((c, i) => { c.style.transform = transformStr(current[i]); c.style.opacity = '0'; });

    function applySceneTransform() {
      scene.style.transform = `translateZ(${zoom}px) rotateX(${rotX}deg) rotateY(${rotY}deg)`;
    }
    // 帶「有機」感的組群飛行：每張卡片各自隨機的時長/延遲（不是整批同步的等差
    // stagger），效果比較像一群卡片各自飛向定位，不是一批批機械式地分批挪動。
    function animateCardTo(card, idx, target, opts) {
      const from = current[idx];
      current[idx] = target;   // 樂觀更新：不等動畫真的播完，下一次切排列就從這個新值繼續算
      if (REDUCE_MOTION) {
        card.style.transform = transformStr(target);
        card.style.opacity = '1';
        return;
      }
      if (card._c3dAnim) { try { card._c3dAnim.cancel(); } catch (e) {} }
      const duration = randRange(opts.minDuration, opts.maxDuration);
      const delay = opts.maxDelay ? randRange(0, opts.maxDelay) : 0;
      const fromOpacity = getComputedStyle(card).opacity || '0';
      const anim = card.animate(
        [{ transform: transformStr(from), opacity: fromOpacity },
         { transform: transformStr(target), opacity: '1' }],
        { duration, delay, easing: opts.easing || 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' }
      );
      card._c3dAnim = anim;
      const settle = () => { card.style.transform = transformStr(target); card.style.opacity = '1'; };
      anim.finished.then(settle).catch(() => {});   // catch：被下一次 setLayout 的 cancel() 中斷時 finished 會 reject，不是錯誤
    }
    function stopInertia() { if (inertiaRAF) { cancelAnimationFrame(inertiaRAF); inertiaRAF = null; } }
    function startInertia() {
      if (REDUCE_MOTION) { velX = 0; velY = 0; return; }   // 放開就是使用者主動操作的延伸，但慣性屬於自動延續動畫，reduced-motion 下不跑
      function step() {
        velX *= 0.94; velY *= 0.94;
        if (Math.abs(velX) < 0.02 && Math.abs(velY) < 0.02) { inertiaRAF = null; return; }
        rotY += velX * 0.35;
        rotX = clamp(rotX - velY * 0.35, -85, 85);
        applySceneTransform();
        inertiaRAF = requestAnimationFrame(step);
      }
      inertiaRAF = requestAnimationFrame(step);
    }

    function onPointerDown(e) {
      stopInertia();
      dragging = true; dragDist = 0;
      lastX = e.clientX; lastY = e.clientY; velX = 0; velY = 0;
    }
    function onPointerMove(e) {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      dragDist += Math.abs(dx) + Math.abs(dy);
      rotY += dx * 0.35;
      rotX = clamp(rotX - dy * 0.35, -85, 85);
      velX = dx; velY = dy;
      applySceneTransform();
    }
    function onPointerUp() {
      if (!dragging) return;
      dragging = false;
      startInertia();
    }
    function onWheel(e) {
      e.preventDefault();
      zoom = clamp(zoom - e.deltaY * 0.6, -900, 500);
      applySceneTransform();
    }
    function touchDist(t0, t1) { return Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY); }
    function onTouchStart(e) {
      stopInertia();
      if (e.touches.length === 2) { pinchDist = touchDist(e.touches[0], e.touches[1]); dragging = false; }
      else if (e.touches.length === 1) { dragging = true; dragDist = 0; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; velX = 0; velY = 0; }
    }
    function onTouchMove(e) {
      if (e.touches.length === 2 && pinchDist != null) {
        e.preventDefault();
        const d = touchDist(e.touches[0], e.touches[1]);
        zoom = clamp(zoom + (d - pinchDist) * 1.2, -900, 500);
        pinchDist = d;
        applySceneTransform();
      } else if (e.touches.length === 1 && dragging) {
        e.preventDefault();
        const t = e.touches[0];
        const dx = t.clientX - lastX, dy = t.clientY - lastY;
        lastX = t.clientX; lastY = t.clientY;
        dragDist += Math.abs(dx) + Math.abs(dy);
        rotY += dx * 0.35;
        rotX = clamp(rotX - dy * 0.35, -85, 85);
        velX = dx; velY = dy;
        applySceneTransform();
      }
    }
    function onTouchEnd(e) { if (e.touches.length === 0) { pinchDist = null; onPointerUp(); } }

    function onCardClickInternal(e) {
      if (dragDist > 6) return;   // 拖曳超過一點距離就不算點擊，避免拖完鬆手誤觸
      const card = e.currentTarget;
      const idx = cards.indexOf(card);
      onCardClick(card, idx);
    }

    stage.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('touchstart', onTouchStart, { passive: true });
    stage.addEventListener('touchmove', onTouchMove, { passive: false });
    stage.addEventListener('touchend', onTouchEnd, { passive: true });
    if (onCardClick) cards.forEach((c) => c.addEventListener('click', onCardClickInternal));

    applySceneTransform();

    return {
      // name: 'grid'|'table'|'sphere'|'helix'；opts: {minDuration, maxDuration, maxDelay, easing}。
      // 每張卡片各自 randRange(minDuration,maxDuration) 時長、[0,maxDelay) 隨機延遲才開始飛，
      // 組群看起來是「陸續飛向定位」而不是同步挪動或分批切段——回傳的 Promise 用估計時間
      // （最長可能的 duration+delay）近似完成，不掛在每張卡的 finished 上：分頁在背景時
      // finished 不結算的話（CLAUDE.md 記過的老坑），只有視覺動畫暫停，不會連 Promise 也卡死。
      setLayout(name, opts) {
        const fn = LAYOUTS[name];
        if (!fn) return Promise.resolve();
        opts = Object.assign({ minDuration: 500, maxDuration: 900, maxDelay: 0, easing: undefined }, opts);
        const n = cards.length;
        cards.forEach((card, i) => animateCardTo(card, i, fn(i, n), opts));
        if (REDUCE_MOTION) return Promise.resolve();
        return new Promise((resolve) => setTimeout(resolve, opts.maxDuration + opts.maxDelay + 40));
      },
      destroy() {
        stopInertia();
        cards.forEach((c) => { if (c._c3dAnim) { try { c._c3dAnim.cancel(); } catch (e) {} } });
        stage.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        stage.removeEventListener('wheel', onWheel);
        stage.removeEventListener('touchstart', onTouchStart);
        stage.removeEventListener('touchmove', onTouchMove);
        stage.removeEventListener('touchend', onTouchEnd);
        if (onCardClick) cards.forEach((c) => c.removeEventListener('click', onCardClickInternal));
      },
    };
  }

  window.Card3D = { create: createCard3DScene, LAYOUTS, REDUCE_MOTION };
})();
