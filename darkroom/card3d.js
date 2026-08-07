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

  // ---- 朝向計算：完整重現 three.js Object3D.lookAt() 對「一般物件」（不是攝影機/
  // 燈光）的行為，這是 sphere/helix 排列「卡片要面向哪裡」的正確算法來源，不是憑
  // 感覺湊 atan2/asin（上一版就是這樣湊出來的，角度在極點附近會不對）。
  //
  // three.js 對一般物件呼叫 obj.lookAt(target) 時，內部是拿「target 當眼睛、物件
  // 自己的位置當被看的點」建 lookAt 矩陣（跟攝影機的 lookAt 用法相反——這樣算出來
  // 的旋轉才會讓物件的「正面」朝向 target，不是背對它）。這裡把那段矩陣運算＋
  // Euler 'XYZ' 角度反推原封不動搬過來，用 (px,py,pz)＝物件位置、(vx,vy,vz)＝要
  // 面向的點、upY＝世界「上」是 +Y 還是 -Y（CSS 螢幕座標 Y 朝下，跟 three.js 的
  // Y-up 相反，所以呼叫端會傳 -1，讓這裡的矩陣運算全程在同一個座標系裡自洽，不用
  // 另外事後修正符號）。
  function cross3(ax, ay, az, bx, by, bz) { return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]; }
  function norm3(x, y, z) { const l = Math.hypot(x, y, z) || 1e-9; return [x / l, y / l, z / l]; }
  function lookAtEuler(px, py, pz, vx, vy, vz, upY) {
    let zx = vx - px, zy = vy - py, zz = vz - pz;
    if (zx === 0 && zy === 0 && zz === 0) zz = 1;
    [zx, zy, zz] = norm3(zx, zy, zz);
    let [xx, xy, xz] = cross3(0, upY, 0, zx, zy, zz);
    if (Math.hypot(xx, xy, xz) < 1e-6) {   // up 跟 z 幾乎平行的退化情況，微調 z 再重算（跟 three.js 同款保險）
      zx += 1e-4; [zx, zy, zz] = norm3(zx, zy, zz);
      [xx, xy, xz] = cross3(0, upY, 0, zx, zy, zz);
    }
    [xx, xy, xz] = norm3(xx, xy, xz);
    const [yx, yy, yz] = cross3(zx, zy, zz, xx, xy, xz);
    // 矩陣欄 [x軸, y軸, z軸]，對照 three.js Euler.setFromRotationMatrix(order='XYZ')
    // 的元素命名：m11=xx, m12=yx, m13=zx, m22=yy, m23=zy, m32=yz, m33=zz。
    const rY = Math.asin(clamp(zx, -1, 1));
    let rX, rZ;
    if (Math.abs(zx) < 0.9999999) {
      rX = Math.atan2(-zy, zz);
      rZ = Math.atan2(-yx, xx);
    } else {
      rX = Math.atan2(yz, yy);
      rZ = 0;
    }
    return { rotX: rX * 180 / Math.PI, rotY: rY * 180 / Math.PI, rotZ: rZ * 180 / Math.PI };
  }

  // ---- 排列公式：輸入索引 i、總數 n，輸出 {x,y,z,rotX,rotY,rotZ}（角度制）----
  // grid/table 是通用參數化格線公式的重新實作；sphere/helix 的位置公式＋朝向計算
  // 沿用參考範例（three.js css3d_periodictable.html）的結構，不是憑感覺湊的（見上
  // 面 lookAtEuler 的說明）——這是使用者要求「直接照原程式做」之後的版本。座標
  // 全程走 CSS 的 Y-down 世界（跟 grid/table 一致），所以 y 的正負號、lookAtEuler
  // 的 upY 都跟 three.js 原版的 Y-up 相反，不是照抄數字，是照抄「邏輯」換算過來。
  const LAYOUTS = {
    grid(i, n) {
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      const rows = Math.ceil(n / cols);
      const spacing = 190;
      const col = i % cols, row = Math.floor(i / cols);
      return { x: (col - (cols - 1) / 2) * spacing, y: (row - (rows - 1) / 2) * spacing, z: 0, rotX: 0, rotY: 0, rotZ: 0 };
    },
    table(i, n) {
      const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.6)));   // 比 grid 扁一點、密一點，視覺上跟 grid 有區別
      const rows = Math.ceil(n / cols);
      const spacing = 132;
      const col = i % cols, row = Math.floor(i / cols);
      return { x: (col - (cols - 1) / 2) * spacing, y: (row - (rows - 1) / 2) * spacing, z: 0, rotX: 0, rotY: 0, rotZ: 0 };
    },
    sphere(i, n) {
      n = Math.max(n, 1);
      const radius = 70 * Math.sqrt(n) + 420;
      // 跟參考範例同一種螺旋分布：phi 從 0 掃到 π，theta 依 phi 累加，均勻覆蓋整個
      // 球面、兩極不會擠成一團。
      const phi = Math.acos(-1 + (2 * i) / n);
      const theta = Math.sqrt(n * Math.PI) * phi;
      const x = radius * Math.sin(phi) * Math.sin(theta);
      const y = -radius * Math.cos(phi);   // 換算成 CSS 的 Y-down：three.js 原本是 +cos(phi)（Y-up）
      const z = radius * Math.sin(phi) * Math.cos(theta);
      // 面向「自己位置往外延伸兩倍」的點＝法向量朝外，從球外側看得到正面，不是背面。
      const rot = lookAtEuler(x, y, z, x * 2, y * 2, z * 2, -1);
      return { x, y, z, rotX: rot.rotX, rotY: rot.rotY, rotZ: rot.rotZ };
    },
    helix(i, n) {
      n = Math.max(n, 1);
      const radius = 50 * Math.sqrt(n) + 320;
      const theta = i * 0.175 + Math.PI;   // 沿用參考範例的角度增量／起始偏移
      const vStep = clamp(4600 / n, 16, 42);
      const x = radius * Math.cos(theta);
      const z = radius * Math.sin(theta);
      const y = i * vStep - (n / 2) * vStep;   // Y-down 版本：i 越大越往下（參考範例 Y-up 是越大越往上）
      // 面向「水平方向往外延伸兩倍、高度不變」的點——卡片只繞軸轉，不會上下傾斜。
      const rot = lookAtEuler(x, y, z, x * 2, y, z * 2, -1);
      return { x, y, z, rotX: rot.rotX, rotY: rot.rotY, rotZ: rot.rotZ };
    },
  };

  function transformStr(p) {
    return `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, ${p.z.toFixed(1)}px) rotateX(${p.rotX.toFixed(2)}deg) rotateY(${p.rotY.toFixed(2)}deg) rotateZ(${(p.rotZ || 0).toFixed(2)}deg)`;
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
