let ALL = [];
let CUR_FOLDER = null;      // 目前選中的資料夾;null = 尚未選
let VIEW = 'all';           // all | missing | have
let RARITY_FILTER = 'all';  // all | untagged | common | rare | special | legendary
let SEARCH = '';
let RAIL_SEARCH = '';       // 資料夾側欄搜尋
let VISIBLE = [];           // 目前 grid 呈現的清單(供 modal 前後導覽)
const pollers = new Set();
const REDUCE_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = id => document.getElementById(id);

// 顯示目前操作的詞庫資料夾（兩個 bat 不同 special_dir 都開 7860，避免搞混改到別份）。
// 顯示路徑尾兩段就足以分辨（…/projects/special_prompts vs …/animebot/special_prompts）。
function setDataset(dir) {
  const el = $('dataset');
  if (!el || !dir) return;
  const parts = String(dir).replace(/\\/g, '/').split('/').filter(Boolean);
  el.textContent = parts.slice(-2).join('/');
  el.title = '目前操作的詞庫資料夾：' + dir;
}

// force=true 才讓後端重掃檔案系統（「重掃」鈕）；一般開頁吃後端快取，秒回。
async function loadAll(force = false) {
  const r = await fetch('/api/libs' + (force ? '?force=1' : ''));
  const j = await r.json();
  ALL = j.items;
  const conn = $('conn');
  conn.classList.toggle('on', !!j.comfy);
  $('conn-text').textContent = j.comfy ? `ComfyUI 就緒 · steps ${j.steps}` : 'ComfyUI 未連線';
  const total = ALL.length, have = ALL.filter(x => x.has_image).length;
  $('total-tag').textContent = `${have}/${total} 已生成`;
  setDataset(j.special_dir);
  if (typeof j.steps === 'number' && document.activeElement !== $('steps-input')) $('steps-input').value = j.steps;
  updateReviewCount();
  if (CUR_FOLDER === null) {
    const folders = folderStats();
    CUR_FOLDER = folders.length ? folders[0].name : '';
  }
  buildRail();
  render();
  // 只對「正在跑」的起輪詢（最多 = 併發數）。批次會把上萬個標成 queued，若也
  // 對 queued 起輪詢會瞬間開幾萬個 /api/status 迴圈灌爆瀏覽器 → 白畫面。批次進度
  // 由 pollBatch（單一 batch_status 輪詢）＋ running_rels 處理，queued 不需個別輪詢。
  for (const it of ALL)
    if (it.job && it.job.status === 'running') pollStatus(it.rel);
}

function folderStats() {
  const map = new Map();
  for (const x of ALL) {
    const f = x.folder || '(根目錄)';
    if (!map.has(f)) map.set(f, { name: f, total: 0, have: 0 });
    const s = map.get(f); s.total++; if (x.has_image) s.have++;
  }
  // 有數字前綴的照數值排（9 < 10 < 100，不會像字串序把 100 排到 99 前）；
  // 沒數字前綴的（如 _tools）排在後面、彼此照名稱序。
  const numOf = s => { const m = /^(\d+)/.exec(s); return m ? +m[1] : null; };
  const arr = [...map.values()].sort((a, b) => {
    const na = numOf(a.name), nb = numOf(b.name);
    if (na !== null && nb !== null) return na - nb;
    if (na !== null) return -1;
    if (nb !== null) return 1;
    return a.name.localeCompare(b.name, 'zh-Hant', { numeric: true });
  });
  if (RAIL_DESC) arr.reverse();
  return arr;
}
let RAIL_DESC = localStorage.getItem('yz-rail-desc') === '1';   // 資料夾排序方向（預設升冪）

let _railSig = '';
function buildRail() {
  const list = $('rail-list');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  const q = RAIL_SEARCH.toLowerCase();
  let stats = folderStats();
  if (q) stats = stats.filter(s =>
    s.name.toLowerCase().includes(q) ||
    s.name.replace(/^\d+[_\-\s]*/, '').toLowerCase().includes(q));
  $('rail-empty').style.display = stats.length ? 'none' : '';
  // 只有當「清單內容」變了(搜尋/首次)才播入場動畫;純切換 active 不重播
  const sig = stats.map(s => s.name).join('|');
  const animate = !REDUCE_MOTION && sig !== _railSig;
  _railSig = sig;
  stats.forEach((s, i) => {
    const pct = s.total ? Math.round(s.have / s.total * 100) : 0;
    const full = s.have === s.total && s.total > 0;
    const b = document.createElement('button');
    b.className = 'folder' + (s.name === CUR_FOLDER && !SEARCH ? ' active' : '');
    if (animate && i < 22) { b.classList.add('rin'); b.style.animationDelay = (i * 18) + 'ms'; }
    b.dataset.folder = s.name;
    const idx = /^\d+/.exec(s.name);
    b.innerHTML = `
      <div class="folder-top">
        <span class="folder-idx">${idx ? idx[0] : '·'}</span>
        <span class="folder-name"></span>
        <span class="folder-count">${s.have}/${s.total}</span>
      </div>
      <div class="cover${full ? ' full' : ''}"><span style="width:${pct}%"></span></div>`;
    b.querySelector('.folder-name').textContent = s.name.replace(/^\d+[_\-\s]*/, '') || s.name;
    b.onclick = () => withTransition(() => { CUR_FOLDER = s.name; SEARCH = ''; $('search').value = ''; buildRail(); render(); $('main').scrollTop = 0; });
    frag.appendChild(b);
  });
  list.appendChild(frag);
}

// 只套資料夾／搜尋範圍（不含 view 與稀有度篩選）——稀有度分布數就是算這個
function baseList() {
  if (SEARCH) {
    const q = SEARCH.toLowerCase();
    return ALL.filter(x => x.name.toLowerCase().includes(q) || (x.folder || '').toLowerCase().includes(q));
  }
  return ALL.filter(x => (x.folder || '(根目錄)') === CUR_FOLDER);
}

function currentList() {
  let list = baseList();
  if (VIEW === 'missing') list = list.filter(x => !x.has_image);
  else if (VIEW === 'have') list = list.filter(x => x.has_image);
  if (RARITY_FILTER === 'untagged') list = list.filter(x => !x.rarity);
  else if (RARITY_FILTER !== 'all') list = list.filter(x => x.rarity === RARITY_FILTER);
  return list;
}

// 稀有度分布條：算目前資料夾／搜尋範圍各等級數量，點晶片只看該等級
const RARITY_BAR_DEFS = [
  ['all', '全部'], ['untagged', '未標'], ['common', '普通'],
  ['rare', '稀有'], ['special', '特別'], ['legendary', '傳奇'],
];
function buildRarityBar() {
  const bar = $('rarity-bar');
  if (!bar) return;
  const base = baseList();
  const cnt = { all: base.length, untagged: 0, common: 0, rare: 0, special: 0, legendary: 0 };
  for (const x of base) { if (!x.rarity) cnt.untagged++; else if (cnt[x.rarity] != null) cnt[x.rarity]++; }
  // 篩選在新範圍內數量為 0 就回到全部
  if (RARITY_FILTER !== 'all' && !cnt[RARITY_FILTER]) RARITY_FILTER = 'all';
  bar.innerHTML = '';
  RARITY_BAR_DEFS.forEach(([key, label]) => {
    if (key !== 'all' && !cnt[key]) return;                 // 沒有的等級不顯示晶片
    const b = document.createElement('button');
    b.className = 'rar-chip rc-' + key + (RARITY_FILTER === key ? ' on' : '');
    b.innerHTML = `<span class="rc-dot"></span><span class="rc-label"></span><span class="rc-count">${cnt[key]}</span>`;
    b.querySelector('.rc-label').textContent = label;
    b.onclick = () => withTransition(() => { RARITY_FILTER = key; render(); });
    bar.appendChild(b);
  });
}

// 切資料夾／篩選／搜尋時，用同文件 View Transitions 讓格線交叉淡入（見 css 的
// dr-grid）。守 REDUCE_MOTION 與 visibilityState——窗格隱藏時 startViewTransition
// 的 callback 不結算（CLAUDE.md 老坑），退化成直接更新。_switching 期間 appendPage
// 不套 reveal，讓 VT 截到的新內容是「已可見」而非 opacity:0 的空白。
let _switching = false;
function withTransition(update) {
  if (document.startViewTransition && !REDUCE_MOTION && document.visibilityState === 'visible') {
    const grid = $('grid');
    // 同文件切換：把格線名字暫改成會交叉淡入的 dr-grid-live（CSS 預設的 dr-grid 是
    // 給換頁用的靜止版）。結束後還原成 CSS 名字，換頁時才會維持不動。
    grid.style.viewTransitionName = 'dr-grid-live';
    const restore = () => { _switching = false; grid.style.viewTransitionName = ''; };
    _switching = true;
    const t = document.startViewTransition(update);
    t.finished.finally(restore);
    setTimeout(restore, 1200);   // 保險：VT 未結算也不卡住後續分頁進場、且還原名字
  } else {
    update();
  }
}

function render() {
  buildRarityBar();          // 先算分布（可能把失效的篩選重置回全部），再取清單
  const list = currentList();
  VISIBLE = list;
  const total = list.length, have = list.filter(x => x.has_image).length;
  const pct = total ? Math.round(have / total * 100) : 0;

  if (SEARCH) {
    $('mt-num').textContent = '';
    $('mt-name').textContent = `搜尋:「${SEARCH}」`;
  } else {
    const idx = /^\d+/.exec(CUR_FOLDER || '');
    $('mt-num').textContent = idx ? idx[0] : '';
    $('mt-name').textContent = (CUR_FOLDER || '').replace(/^\d+[_\-\s]*/, '') || CUR_FOLDER || '—';
  }
  // 覆蓋率條在兩模式都顯示（避免切模式時它消失導致下方格線上下跳）：瀏覽=已生成比例、
  // 打標=已標稀有度比例。摘要文字同步。
  if (MODE === 'tag') {
    const tagged = list.filter(x => x.rarity).length;
    const pctT = total ? Math.round(tagged / total * 100) : 0;
    $('mt-sub').textContent = `${total} 個詞庫 · 已標稀有度 ${tagged} · 打標 ${pctT}%`;
    $('coverbar').firstElementChild.style.width = pctT + '%';
  } else {
    $('mt-sub').textContent = `${total} 個詞庫 · 已生成 ${have} · 缺 ${total - have} · 覆蓋率 ${pct}%`;
    $('coverbar').firstElementChild.style.width = pct + '%';
  }

  const grid = $('grid');
  grid.innerHTML = '';
  if (_io) { _io.disconnect(); _io = null; }
  if (_revealIO) { _revealIO.disconnect(); _revealIO = null; }
  if (!total) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="big">這裡沒有符合的詞庫</div>換個資料夾或篩選條件</div>`;
    return;
  }
  // 卡片進場觀察器：卡片捲進視野就淡入。同一批一起進來的（首屏）依回呼順序
  // 小 stagger 串成瀑布；捲動時分批進來的各自淡入。animate once（進場即取消觀察）。
  if (!REDUCE_MOTION) {
    _revealIO = new IntersectionObserver((entries) => {
      let i = 0;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.style.transitionDelay = (Math.min(i, 12) * 30) + 'ms';
        e.target.classList.add('in');
        _revealIO.unobserve(e.target);
        i++;
      }
    }, { root: $('main'), rootMargin: '0px 0px -6% 0px', threshold: 0.02 });
  }
  _rendered = 0;
  appendPage();          // 先渲染第一頁
  if (_rendered < total) {
    const sentinel = document.createElement('div');
    sentinel.id = 'scroll-sentinel';
    sentinel.style.cssText = 'grid-column:1/-1;height:1px;';
    grid.appendChild(sentinel);
    _io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting) appendPage();
    }, { root: $('main'), rootMargin: '800px 0px' });   // 提前 800px 預載
    _io.observe(sentinel);
  }
}

const PAGE = 120;
let _rendered = 0, _io = null, _revealIO = null;

function appendPage() {
  const grid = $('grid');
  const slice = VISIBLE.slice(_rendered, _rendered + PAGE);
  if (!slice.length) return;
  const frag = document.createDocumentFragment();
  const fresh = [];
  slice.forEach((it) => {
    const card = cardOf(it);
    // 入場動畫改走 reveal-on-scroll：每張捲進視野時才淡入上升（見 _revealIO），
    // 這樣所有卡片都會依序animate，不再只有前 14 張。
    if (!REDUCE_MOTION && !_switching) { card.classList.add('reveal'); fresh.push(card); }
    frag.appendChild(card);
  });
  const sentinel = $('scroll-sentinel');
  if (sentinel) grid.insertBefore(frag, sentinel); else grid.appendChild(frag);
  if (_revealIO) {
    fresh.forEach(c => _revealIO.observe(c));
    // 保險：IO 若因分頁在背景（不合成畫面）等原因沒觸發，逾時仍把還沒進場的
    // 顯示出來，避免卡片永遠停在 opacity:0（CLAUDE.md 隱藏分頁的教訓）。
    setTimeout(() => fresh.forEach(c => c.classList.add('in')), 2500);
  }
  _rendered += slice.length;
  if (_rendered >= VISIBLE.length && _io) {
    _io.disconnect(); _io = null;
    const s = $('scroll-sentinel'); if (s) s.remove();
  }
}

const ICON_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m21 15-5-5L5 21"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.1l2.63 5.33 5.88.85-4.25 4.15 1 5.86L12 16.79 6.74 19.6l1-5.86L3.49 9.28l5.88-.85z"/></svg>';
const RARITY_LABEL = { common: '普通', rare: '稀有', special: '特別', legendary: '傳奇' };
const rarTag = (r) => r ? `<span class="rar-tag ${r}">${RARITY_LABEL[r] || ''}</span>` : '';
// 傳奇卡的閃爍火花層（Aceternity Sparkles 的 vanilla 版）：隨機位置＋延遲的小星點
function sparklesHTML(n = 7) {
  let s = '';
  for (let i = 0; i < n; i++)
    s += `<i style="left:${(Math.random() * 92 + 4).toFixed(1)}%;top:${(Math.random() * 92 + 4).toFixed(1)}%;--sz:${(2 + Math.random() * 2).toFixed(1)}px;animation-delay:${(Math.random() * 2.4).toFixed(2)}s"></i>`;
  return `<span class="sparkles" aria-hidden="true">${s}</span>`;
}

// 縮圖內部標記：星號、選取框、紅叉、生成鈕全部就地重建（reloadThumb 會覆寫
// thumb.innerHTML，所以這些覆蓋層要有單一來源，避免生成後星號/生成鈕被清掉）。
function thumbInnerHTML(it) {
  const relEnc = encodeURIComponent(it.rel);
  const media = it.has_image
    ? `<img loading="lazy" decoding="async" width="360" height="360" src="/api/thumb?rel=${relEnc}&v=${it.image_mtime}" alt="" onload="this.classList.add('ld')" onerror="this.classList.add('ld')">`
    : `<div class="empty">${ICON_EMPTY}<span>尚無圖片</span></div>`;
  return `${media}` +
    (it.rarity === 'legendary' ? sparklesHTML() : '') +
    rarTag(it.rarity) +
    `<button class="fav-btn" type="button" aria-label="收藏" aria-pressed="${it.favorited ? 'true' : 'false'}">${ICON_STAR}</button>` +
    `<span class="pick-box" aria-hidden="true"></span>` +
    `<span class="flag-x" aria-hidden="true">✕</span>` +
    `<button class="gen-btn">${it.has_image ? '重新生成' : '生成'}</button>`;
}

function wireThumb(thumb, it) {
  // 點縮圖：打標模式＝選取；瀏覽的篩選模式＝標記紅叉；瀏覽平常＝開大圖。
  thumb.onclick = () => {
    if (MODE === 'tag') toggleSel(it.rel, thumb.closest('.card'));
    else if (SELECTING) toggleFlag(it.rel);
    else openModalFromThumb(it.rel, thumb.querySelector('img'));
  };
  thumb.querySelector('.gen-btn').onclick = (e) => { e.stopPropagation(); generate(it.rel); };
  thumb.querySelector('.fav-btn').onclick = (e) => { e.stopPropagation(); toggleFav(it.rel); };
}

function cardOf(it) {
  const el = document.createElement('div');
  el.className = 'card' + (it.has_image ? '' : ' missing') + (it.flagged ? ' flagged' : '')
    + (it.favorited ? ' favorited' : '') + (it.rarity ? ' rar-' + it.rarity : '')
    + (SEL.has(it.rel) ? ' selected' : '');
  el.dataset.rel = it.rel;
  // 卡片不顯示每張的生成狀態小標（完成/排隊/生成中/失敗）——批次時每張都冒出來太吵。
  // 整體進度看頂部的「批次 X/Y」，完成靠縮圖自己更新。生成狀態仍會顯示在點開的大圖裡。
  el.innerHTML = `
    <div class="thumb">${thumbInnerHTML(it)}</div>
    <div class="card-body">
      <div class="card-name"></div>
      ${SEARCH ? '<div class="card-folder"></div>' : ''}
    </div>`;
  el.querySelector('.card-name').textContent = it.display_name || it.name;
  if (SEARCH) el.querySelector('.card-folder').textContent = it.folder || '(根目錄)';
  wireThumb(el.querySelector('.thumb'), it);
  return el;
}

// 標記/取消「不優質」：樂觀更新（先變色再送），失敗回退。狀態同步到 ALL、
// 兩種介面（格線卡片、審核網格）與計數。
async function toggleFlag(rel, force) {
  const it = ALL.find(x => x.rel === rel);
  const next = (typeof force === 'boolean') ? force : !(it && it.flagged);
  if (it) it.flagged = next;
  applyFlagVisual(rel, next);
  try {
    const r = await fetch('/api/flag', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel, flagged: next }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    if (it) it.flagged = j.flagged;
    applyFlagVisual(rel, j.flagged);
  } catch (e) {
    if (it) it.flagged = !next;               // 回退
    applyFlagVisual(rel, !next);
    alert('標記失敗：' + e.message);
  }
  updateReviewCount();
}

// 把某 rel 的旗標狀態套到畫面上（格線卡片）
function applyFlagVisual(rel, flagged) {
  document.querySelectorAll(`#grid .card[data-rel="${cssAttr(rel)}"]`)
    .forEach(el => el.classList.toggle('flagged', flagged));
}

// 收藏／取消收藏：樂觀更新（先變色再送），失敗回退。點右上角星號直接切換，
// 不需要進選取模式。
async function toggleFav(rel, force) {
  const it = ALL.find(x => x.rel === rel);
  const next = (typeof force === 'boolean') ? force : !(it && it.favorited);
  if (it) it.favorited = next;
  applyFavVisual(rel, next, true);          // 立刻反映＋播放收藏動畫
  try {
    const r = await fetch('/api/favorite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel, favorited: next }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    if (it) it.favorited = j.favorited;
    applyFavVisual(rel, j.favorited, false);
  } catch (e) {
    if (it) it.favorited = !next;           // 回退
    applyFavVisual(rel, !next, false);
    alert('收藏失敗：' + e.message);
  }
}

// 把收藏狀態套到畫面（格線卡片）。animate=true 且是「加入收藏」時，星號彈跳一下。
// 用 element.animate（class 重啟動畫在連續觸發時不可靠，見 CLAUDE.md）。
function applyFavVisual(rel, favorited, animate) {
  document.querySelectorAll(`#grid .card[data-rel="${cssAttr(rel)}"]`).forEach(el => {
    el.classList.toggle('favorited', favorited);
    const btn = el.querySelector('.fav-btn');
    if (!btn) return;
    btn.setAttribute('aria-pressed', favorited ? 'true' : 'false');
    if (animate && favorited && document.visibilityState === 'visible'
        && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      btn.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.4)' }, { transform: 'scale(1)' }],
        { duration: 340, easing: 'cubic-bezier(.34,1.56,.64,1)' },   // spring 過衝
      );
    }
  });
}

function updateStatusEl(el, job) {
  if (!el) return;
  if (!job || !job.status) { el.textContent = ''; el.className = 'status'; return; }
  el.className = 'status ' + job.status;
  const map = { queued: '排隊中', running: '生成中', done: '完成', error: '失敗' };
  el.textContent = (map[job.status] || job.status) + (job.message ? ' · ' + job.message : '');
}

async function generate(rel) {
  const r = await fetch('/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rel })
  });
  const j = await r.json();
  if (j.error) { alert(j.error); return; }
  const it = ALL.find(x => x.rel === rel);
  if (it) it.job = { status: 'queued', message: '排隊中...' };
  const card = document.querySelector(`.card[data-rel="${cssAttr(rel)}"]`);
  if (card) updateStatusEl(card.querySelector('.status'), it.job);
  pollStatus(rel);
}

async function pollStatus(rel) {
  if (pollers.has(rel)) return;
  pollers.add(rel);
  try {
    while (true) {
      const r = await fetch('/api/status?rel=' + encodeURIComponent(rel));
      const job = await r.json();
      const it = ALL.find(x => x.rel === rel);
      if (it) it.job = job;
      const card = document.querySelector(`.card[data-rel="${cssAttr(rel)}"]`);
      if (card) updateStatusEl(card.querySelector('.status'), job);
      const mstat = $('modal-status');
      if (mstat && mstat.dataset.rel === rel) updateStatusEl(mstat, job);
      if (job.status === 'done' || job.status === 'error') {
        if (job.status === 'done') {
          if (it) { it.has_image = true; it.image_mtime = Math.floor(Date.now() / 1000); }
          reloadThumb(rel); reloadModalImage(rel); buildRail();
        }
        break;
      }
      await sleep(1500);
    }
  } finally { pollers.delete(rel); }
}

function reloadThumb(rel) {
  const card = document.querySelector(`.card[data-rel="${cssAttr(rel)}"]`);
  if (!card) return;
  const it = ALL.find(x => x.rel === rel);
  if (!it) return;
  card.classList.remove('missing');
  const thumb = card.querySelector('.thumb');
  thumb.innerHTML = thumbInnerHTML(it);   // 連星號/選取框/生成鈕一起重建，不會被清掉
  wireThumb(thumb, it);
}

function reloadModalImage(rel) {
  const inner = $('modal-inner');
  if (inner && inner.dataset.rel === rel) openModal(rel, false);
}

function openModal(rel, resetNav = true) {
  const item = ALL.find(x => x.rel === rel);
  if (!item) return;
  const inner = $('modal-inner');
  inner.dataset.rel = rel;
  const relEnc = encodeURIComponent(rel);
  const imgHtml = item.has_image
    ? `<img id="modal-image" data-rel="${escapeAttr(rel)}" src="/api/image?rel=${relEnc}&t=${item.image_mtime}">`
    : `<div class="no-image">尚無圖片</div>`;
  inner.innerHTML = `
    <div>
      ${imgHtml}
      <div id="modal-status" data-rel="${escapeAttr(rel)}" class="status" style="margin-top:10px;padding:0;"></div>
      <div style="margin-top:12px; display:flex; gap:8px;">
        <button class="primary" id="modal-gen">${item.has_image ? '重新生成' : '生成'}</button>
        <button id="modal-close">關閉 (Esc)</button>
      </div>
    </div>
    <div>
      <div class="m-title" id="modal-title"></div>
      <div class="m-folder" id="modal-folder"></div>
      <div class="prompt-label">正向 Prompt</div>
      <div class="prompt-block" id="pos">載入中…</div>
      <div class="prompt-label">負向 Prompt</div>
      <div class="prompt-block" id="neg">載入中…</div>
    </div>`;
  $('modal-title').textContent = item.display_name || item.name;
  $('modal-folder').textContent = item.folder || '(根目錄)';
  $('modal-gen').onclick = () => generate(rel);
  $('modal-close').onclick = closeModalWithMorph;
  $('modal').classList.add('open');
  if (item.job && item.job.status) updateStatusEl($('modal-status'), item.job);
  fetch('/api/prompt?rel=' + relEnc).then(r => r.json()).then(j => {
    if (j.error) { $('pos').textContent = j.error; return; }
    $('pos').textContent = j.positive || '(空)';
    $('neg').textContent = j.negative || '(空)';
  }).catch(e => { $('pos').textContent = String(e); });
}

function modalStep(dir) {
  const inner = $('modal-inner');
  const rel = inner && inner.dataset.rel;
  if (!rel || !VISIBLE.length) return;
  const i = VISIBLE.findIndex(x => x.rel === rel);
  if (i < 0) return;
  const ni = (i + dir + VISIBLE.length) % VISIBLE.length;
  openModal(VISIBLE[ni].rel);
}

function closeModal() {
  $('modal').classList.remove('open');
  const inner = $('modal-inner');
  if (inner) delete inner.dataset.rel;
}

// 開大圖：縮圖 morph 放大成大圖（shared-element，view-transition-name: hero-img）。
// 老套路——舊快照在 callback 前截（此時縮圖有名字），callback 裡先清掉縮圖名字再開
// modal（大圖經 css 帶 hero-img），新快照只有大圖有名字 → 縮圖平滑長成大圖。
// 守 REDUCE_MOTION 與 visibilityState（窗格隱藏 callback 不結算，CLAUDE.md 老坑）。
function openModalFromThumb(rel, thumbImg) {
  const item = ALL.find(x => x.rel === rel);
  const canMorph = document.startViewTransition && !REDUCE_MOTION
    && document.visibilityState === 'visible' && item && item.has_image && thumbImg;
  if (!canMorph) { openModal(rel); return; }
  thumbImg.style.viewTransitionName = 'hero-img';
  const clear = () => { thumbImg.style.viewTransitionName = ''; };
  const t = document.startViewTransition(() => { clear(); openModal(rel); });
  t.finished.finally(clear);
  setTimeout(clear, 1200);
}

// 關大圖：反向 morph——大圖縮回它在格線裡的縮圖。舊快照有大圖（hero-img），callback
// 裡關掉 modal（大圖隨 .modal display:none 消失、不再被截）並把對應縮圖接手 hero-img，
// 新快照只有縮圖有名字 → 大圖縮回縮圖位置。找不到縮圖（已捲離/換了資料夾）就直接關。
function closeModalWithMorph() {
  const inner = $('modal-inner');
  const rel = inner && inner.dataset.rel;
  const modalImg = $('modal-image');
  const canMorph = document.startViewTransition && !REDUCE_MOTION
    && document.visibilityState === 'visible' && modalImg && rel;
  if (!canMorph) { closeModal(); return; }
  const thumbImg = document.querySelector(`#grid .card[data-rel="${cssAttr(rel)}"] .thumb img`);
  const clear = () => { if (thumbImg) thumbImg.style.viewTransitionName = ''; };
  const t = document.startViewTransition(() => {
    closeModal();
    if (thumbImg) thumbImg.style.viewTransitionName = 'hero-img';
  });
  t.finished.finally(clear);
  setTimeout(clear, 1200);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
function cssAttr(s) { return String(s).replace(/["\\]/g, '\\$&'); }

/* 篩選段 */
$('view-seg').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  VIEW = btn.dataset.v;
  $('view-seg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
  moveSegPill();          // 膠囊自己的滑動保持在過渡外（不被格線淡入影響）
  withTransition(render);
});

// 篩選段的滑動膠囊：量目前 .on 按鈕的位置/寬度，讓膠囊滑過去（比照主面板分頁）
function moveSegPill() {
  const seg = $('view-seg'), pill = $('seg-pill');
  const active = seg && seg.querySelector('button.on');
  if (!active || !pill) return;
  pill.style.width = active.offsetWidth + 'px';
  pill.style.transform = `translateX(${active.offsetLeft}px)`;
}
moveSegPill();
addEventListener('resize', moveSegPill);

/* ── 模式：瀏覽/生成 ↔ 打標（合併成一頁，切模式只設 body[data-mode]，不換頁） ──
   初始模式：網址 /tag 或 ?mode=tag → 打標；否則沿用上次（localStorage）。 */
function initialMode() {
  if (location.pathname === '/tag' || new URLSearchParams(location.search).get('mode') === 'tag') return 'tag';
  return localStorage.getItem('yz-mode') === 'tag' ? 'tag' : 'browse';
}
let MODE = initialMode();
function moveModePill() {
  const seg = $('mode-seg'), pill = $('mode-pill');
  const active = seg && seg.querySelector('button.on');
  if (!active || !pill) return;
  pill.style.width = active.offsetWidth + 'px';
  pill.style.transform = `translateX(${active.offsetLeft}px)`;
}
function applyMode(mode) {
  MODE = (mode === 'tag') ? 'tag' : 'browse';
  document.body.dataset.mode = MODE;
  localStorage.setItem('yz-mode', MODE);
  $('mode-seg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === MODE));
  const h1 = document.querySelector('.brand h1');
  if (h1) h1.textContent = MODE === 'tag' ? '詞庫打標' : '詞庫暗房';
  moveModePill();
}
$('mode-seg').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  // 切模式用 withTransition：消失/出現的控制項柔和交叉淡入，共用按鈕因靠右錨定不位移。
  // 換模式時清掉打標選取（避免殘留），並重置底部稀有度列狀態。
  if (btn.dataset.mode !== MODE) withTransition(() => { SEL.clear(); applyMode(btn.dataset.mode); render(); updateTagbar(); });
});
applyMode(MODE);
addEventListener('resize', moveModePill);

let searchTimer;
$('search').oninput = e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => withTransition(() => { SEARCH = e.target.value.trim(); buildRail(); render(); }), 180);
};
$('rescan').onclick = () => loadAll(true);
$('menu-btn').onclick = () => $('rail').classList.toggle('open');
// 卡片聚光：游標在縮圖上移動時更新 --mx/--my（委派在 grid 上，只有 hover 的縮圖會算）
$('grid').addEventListener('pointermove', e => {
  const thumb = e.target.closest('.thumb');
  if (!thumb) return;
  const r = thumb.getBoundingClientRect();
  thumb.style.setProperty('--mx', (e.clientX - r.left) + 'px');
  thumb.style.setProperty('--my', (e.clientY - r.top) + 'px');
});
// 資料夾排序方向切換（升冪 ↑ / 降冪 ↓），記住選擇
function updateRailSortLabel() {
  const b = $('rail-sort'); if (b) b.textContent = RAIL_DESC ? '降冪 ↓' : '升冪 ↑';
}
updateRailSortLabel();
$('rail-sort').onclick = () => {
  RAIL_DESC = !RAIL_DESC;
  localStorage.setItem('yz-rail-desc', RAIL_DESC ? '1' : '0');
  updateRailSortLabel();
  buildRail();
};

let railTimer;
$('folder-search').oninput = e => {
  const v = e.target.value.trim();
  $('folder-search-clear').style.display = v ? '' : 'none';
  clearTimeout(railTimer);
  railTimer = setTimeout(() => { RAIL_SEARCH = v; buildRail(); }, 120);
};
$('folder-search').onkeydown = e => {
  if (e.key === 'Escape') { e.target.value = ''; RAIL_SEARCH = ''; $('folder-search-clear').style.display = 'none'; buildRail(); }
  // Enter:若只剩一個資料夾,直接進入
  if (e.key === 'Enter') {
    const only = $('rail-list').querySelectorAll('.folder');
    if (only.length === 1) only[0].click();
  }
};
$('folder-search-clear').onclick = () => {
  $('folder-search').value = ''; RAIL_SEARCH = '';
  $('folder-search-clear').style.display = 'none'; buildRail(); $('folder-search').focus();
};

async function launchBatch(scope, regenerate) {
  // scope: 'page' = 目前檢視;'all' = 全部詞庫(不受資料夾/搜尋/篩選影響)
  const source = scope === 'all' ? ALL : currentList();
  const rels = (regenerate ? source : source.filter(x => !x.has_image)).map(x => x.rel);
  if (!rels.length) {
    alert(regenerate ? '目前範圍沒有可生成的項目' : '目前範圍沒有缺圖的項目');
    return;
  }
  // 補缺少：打亂順序（不從頭跑到尾，每次補到的是隨機分佈的詞庫）
  if (!regenerate) {
    for (let i = rels.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rels[i], rels[j]] = [rels[j], rels[i]];
    }
  }
  const scopeTxt = scope === 'all' ? '全部詞庫' : (SEARCH ? '搜尋結果' : '此資料夾');
  const modeTxt = regenerate ? '重新生成(會覆蓋既有圖)' : '補齊缺少的';
  if (!confirm(`${scopeTxt} · ${modeTxt}\n共 ${rels.length} 張,將以每次 2 張並行處理,可能耗時很久。確定?`)) return;
  const r = await fetch('/api/batch_generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rels, regenerate })
  });
  const j = await r.json();
  if (j.error) { alert(j.error); return; }
  pollBatch();
}
$('gen-page-missing').onclick = () => launchBatch('page', false);
$('gen-page-all').onclick     = () => launchBatch('page', true);
$('gen-all-missing').onclick  = () => launchBatch('all', false);
$('gen-all-regen').onclick    = () => launchBatch('all', true);

$('batch-stop').onclick = async () => {
  if (!confirm('停止批次?當前這張仍會跑完。')) return;
  await fetch('/api/batch_stop', { method: 'POST' });
};

const GEN_BTNS = ['gen-page-missing', 'gen-page-all', 'gen-all-missing', 'gen-all-regen'];
function setGenDisabled(v) { GEN_BTNS.forEach(id => { const el = $(id); if (el) el.disabled = v; }); }

async function pollBatch() {
  const progEl = $('batch-progress'), stopBtn = $('batch-stop');
  while (true) {
    const b = await (await fetch('/api/batch_status')).json();
    if (b.running) {
      stopBtn.style.display = ''; setGenDisabled(true);
      const rels = b.running_rels || [];
      const cur = rels.length ? ' · 生成中 ' + rels.map(r => r.split('/').pop().replace(/\.py$/, '')).join(' + ') : '';
      progEl.innerHTML = `<span class="led" style="background:var(--amber);box-shadow:0 0 7px var(--amber)"></span>批次 ${b.done}/${b.total} · ok ${b.ok} · fail ${b.fail}${cur}`;
      for (const rel of rels) pollStatus(rel);
    } else {
      stopBtn.style.display = 'none'; setGenDisabled(false);
      progEl.textContent = b.total > 0 ? `批次完成 ${b.done}/${b.total} · ok ${b.ok} · fail ${b.fail}` : '';
      break;
    }
    await sleep(1500);
  }
}

$('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModalWithMorph(); });
$('m-prev').onclick = () => modalStep(-1);
$('m-next').onclick = () => modalStep(1);
window.addEventListener('keydown', e => {
  if ($('tarot').classList.contains('open')) {
    if (e.key === 'Escape') { closeTarot(); return; }
    if (MODE === 'tag') {                                  // 抽卡打標：全鍵盤逐張標
      const cards = tarotCards();
      if (e.key === 'r' || e.key === 'R' || e.key === 'Enter') { e.preventDefault(); drawTagTarot(); return; }
      if (!cards.length) return;
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); advanceFocus(); return; }   // 跳過
      if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); undoTarot(); return; }       // 復原
      const cols = tarotCols();
      const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
      if (e.key in move) { e.preventDefault(); setTarotFocus(TAROT_FOCUS + move[e.key]); return; }
      const rar = { '1': 'common', '2': 'rare', '3': 'special', '4': 'legendary' };
      if (rar[e.key]) {
        e.preventDefault();
        const card = cards[TAROT_FOCUS] || cards[0];
        assignTarot(card.dataset.rel, card, rar[e.key]);
        advanceFocus();
        return;
      }
      return;
    }
    if (e.key === 'r' || e.key === 'R' || e.key === 'Enter') { e.preventDefault(); drawTarot(); return; }  // 瀏覽：R 重抽
    return;
  }
  if (!$('modal').classList.contains('open')) return;
  if (e.key === 'Escape') closeModalWithMorph();
  else if (e.key === 'ArrowLeft') modalStep(-1);
  else if (e.key === 'ArrowRight') modalStep(1);
});

/* ---------------- 抽卡（塔羅式發牌 + 翻牌） ---------------- */
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

// 洗牌取樣 n 張（不重複）。ALL 上萬筆，複製一次成本可接受（只在抽卡時）。
function sampleN(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八'];
const isMobile = () => matchMedia('(max-width: 640px)').matches || matchMedia('(pointer: coarse)').matches;

function drawTarot() {
  const pool = ALL.filter(x => x.has_image);             // 只抽有 webp（旁邊有圖）的詞庫
  if (!pool.length) { alert('目前沒有任何已生成預覽圖的詞庫可抽'); return; }
  const want = isMobile() ? 1 : 8;                        // 手機一次一張，桌面 8 張（4+4）
  const picks = sampleN(pool, Math.min(want, pool.length));
  const n = picks.length;
  const title = document.querySelector('.tarot-title');
  if (title) title.textContent = `✦ 抽選${CN_NUM[n] || n}張 ✦`;
  const wrap = $('tarot-cards');
  wrap.classList.remove('ttag');                          // 瀏覽抽卡：清掉打標抽卡的 5×3 排版
  $('tarot-stage').classList.remove('ttag-stage');
  $('tarot-hint').textContent = '點任一張看大圖與提示詞；R 重抽一批、Esc 關閉';
  wrap.innerHTML = '';
  picks.forEach((it, i) => {
    const card = document.createElement('div');
    card.className = 'tarot-card' + (it.rarity ? ' rar-' + it.rarity : '');
    card.style.animationDelay = REDUCE ? '0ms' : (i * 48) + 'ms';                 // 發牌 stagger（平行排列，無弧度）
    const relEnc = encodeURIComponent(it.rel);
    // 抽卡的牌面圖是「上方可見」的少數幾張 → 直接載入（不 lazy）。翻牌不再乾等它載入，
    // 圖較慢時牌面先顯示載入微光（.tarot-front.loading），圖到了 onload 淡入並收掉微光。
    const face = it.has_image
      ? `<img decoding="async" src="/api/thumb?rel=${relEnc}&v=${it.image_mtime}" alt="" onload="this.classList.add('ld');this.closest('.tarot-front').classList.remove('loading')" onerror="this.closest('.tarot-front').classList.remove('loading')">`
      : `<div class="tarot-noimg">${ICON_EMPTY}<span>尚無圖</span></div>`;
    card.innerHTML =
      `<div class="tarot-inner">
         <div class="tarot-back"><span class="tarot-emblem">✦</span></div>
         <div class="tarot-front${it.has_image ? ' loading' : ''}">${face}${it.rarity === 'legendary' ? sparklesHTML(9) : ''}${rarTag(it.rarity)}<div class="tarot-name"></div><div class="tarot-folder"></div><div class="tarot-glare"></div></div>
       </div>`;
    card.querySelector('.tarot-name').textContent = it.display_name || it.name;
    card.querySelector('.tarot-folder').textContent = it.folder || '(根目錄)';
    card.addEventListener('click', () => { closeTarot(); openModal(it.rel); });
    if (!REDUCE) {                                        // 3D 傾斜（參考 Aceternity 3D card）
      card.addEventListener('mousemove', e => tiltCard(card, e));
      card.addEventListener('mouseleave', () => { card.style.transform = ''; });
    }
    wrap.appendChild(card);
  });
  $('tarot').classList.add('open');
  // 發牌完成後依序翻牌；reduced-motion 直接全開
  const cards = [...wrap.children];
  if (REDUCE) { cards.forEach(c => c.classList.add('revealed')); return; }
  const dealDone = n * 48 + 220;
  cards.forEach((c, i) => {
    // 照固定節奏翻牌，不再等圖片載入（否則慢圖會把整段動畫拖到數秒）。已快取的圖
    // 立刻收掉載入微光；未快取的翻開先顯示微光，onload 再淡入。
    const img = c.querySelector('.tarot-front img');
    if (img && img.complete && img.naturalWidth) c.querySelector('.tarot-front').classList.remove('loading');
    setTimeout(() => c.classList.add('revealed'), dealDone + i * 80);
  });
}

// 卡片隨滑鼠 3D 傾斜（參考 Aceternity 3D card）：依游標相對卡片中心算 rotateX/Y，
// 並讓光澤跟著游標。翻牌後牌面已非鏡像，傾斜方向自然。
// 不加 scale——縮放會把整張(含文字/圖)當點陣圖放大而糊掉；只留傾斜，內容較清晰。
function tiltCard(card, e) {
  const r = card.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width - 0.5;    // -0.5 ~ 0.5
  const py = (e.clientY - r.top) / r.height - 0.5;
  const MAX = 11;
  card.style.transform =
    `rotateX(${(-py * MAX).toFixed(2)}deg) rotateY(${(px * MAX).toFixed(2)}deg)`;
  const g = card.querySelector('.tarot-glare');
  if (g) {
    g.style.setProperty('--gx', ((px + 0.5) * 100).toFixed(1) + '%');
    g.style.setProperty('--gy', ((py + 0.5) * 100).toFixed(1) + '%');
  }
}

function closeTarot() {
  $('tarot').classList.remove('open');
  TAROT_FOCUS = -1;
  if (MODE === 'tag') { render(); updateTagbar(); }   // 反映剛標的
}

/* ── 抽卡打標（打標模式）：抽 15 張「有圖且尚未打標」的，逐張鍵盤/點按標稀有度，
   即時寫側檔。與瀏覽抽卡共用同一個 #tarot 覆蓋層，靠 .ttag class 切排版與卡片內容。 */
const RARITY_KEYS = ['common', 'rare', 'special', 'legendary'];
const DRAW_N = 15;
let TAROT_FOCUS = -1;
const TAROT_HISTORY = [];
const tarotPool = () => ALL.filter(x => x.has_image && !x.rarity);   // 有圖、尚未打標
const tarotCards = () => [...$('tarot-cards').children];
const isAssigned = c => RARITY_KEYS.some(k => c.classList.contains('assigned-' + k));

function setTarotFocus(i) {
  const cards = tarotCards();
  if (!cards.length) return;
  TAROT_FOCUS = Math.max(0, Math.min(i, cards.length - 1));
  cards.forEach((c, idx) => c.classList.toggle('focused', idx === TAROT_FOCUS));
  cards[TAROT_FOCUS].scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function tarotCols() {
  const cards = tarotCards();
  if (cards.length < 2) return 1;
  const top0 = cards[0].offsetTop;
  let n = 1;
  while (n < cards.length && cards[n].offsetTop === top0) n++;
  return n;
}
function advanceFocus() {
  const cards = tarotCards(), n = cards.length;
  for (let step = 1; step <= n; step++) {
    const idx = (TAROT_FOCUS + step) % n;
    if (!isAssigned(cards[idx])) { setTarotFocus(idx); return; }
  }
}
function drawTagTarot() {
  const pool = tarotPool();
  if (!pool.length) { toast('沒有「有圖且尚未打標」的詞庫可抽了'); return; }
  const picks = sampleN(pool, Math.min(DRAW_N, pool.length));
  const wrap = $('tarot-cards');
  wrap.classList.add('ttag');
  $('tarot-stage').classList.add('ttag-stage');
  const title = document.querySelector('.tarot-title');
  if (title) title.textContent = '✦ 抽卡打標 ✦';
  $('tarot-hint').textContent = '方向鍵移動焦點，1 普通・2 稀有・3 特別・4 傳奇打標（自動跳下一張），S 跳過・Z 復原・R 重抽；也可直接點卡片按鈕。隨標即時生效。';
  wrap.innerHTML = '';
  TAROT_HISTORY.length = 0;
  picks.forEach((it, i) => {
    const card = document.createElement('div');
    card.className = 'tarot-card ttag-card' + (it.rarity ? ' rar-' + it.rarity : '');
    card.dataset.rel = it.rel;
    card.style.animationDelay = REDUCE_MOTION ? '0ms' : (i * 24) + 'ms';
    const relEnc = encodeURIComponent(it.rel);
    card.innerHTML =
      `<div class="tarot-inner">
         <div class="tarot-back"><span class="tarot-emblem">✦</span></div>
         <div class="tarot-front">
           <img decoding="async" src="/api/thumb?rel=${relEnc}&v=${it.image_mtime}" alt="">
           <div class="tarot-name"></div>
           <div class="ttag-rar">
             <button data-r="common">普通</button><button data-r="rare">稀有</button>
             <button data-r="special">特別</button><button data-r="legendary">傳奇</button>
           </div>
         </div>
       </div>`;
    card.querySelector('.tarot-name').textContent = it.display_name || it.name;
    card.querySelectorAll('.ttag-rar button').forEach(b =>
      b.onclick = () => { setTarotFocus(i); assignTarot(it.rel, card, b.dataset.r); });
    card.addEventListener('mouseenter', () => setTarotFocus(i));
    wrap.appendChild(card);
  });
  $('tarot').classList.add('open');
  setTarotFocus(0);
  updateTarotProgress();
  const cards = [...wrap.children];
  if (REDUCE_MOTION) { cards.forEach(c => c.classList.add('revealed')); return; }
  const dealDone = picks.length * 24 + 170;
  cards.forEach((c, i) => setTimeout(() => c.classList.add('revealed'), dealDone + i * 32));
}
function assignTarot(rel, card, key) {
  const it = ALL.find(x => x.rel === rel);
  TAROT_HISTORY.push({ rel, prev: it ? (it.rarity || '') : '' });   // 供 Z 復原
  applyRarity(rel, key);                                            // 即時寫側檔
  RARITY_KEYS.forEach(k => card.classList.remove('assigned-' + k, 'rar-' + k));
  card.classList.add('assigned-' + key);
  if (key !== 'common') card.classList.add('rar-' + key);
  const front = card.querySelector('.tarot-front');
  const oldSpark = front && front.querySelector('.sparkles');
  if (oldSpark) oldSpark.remove();
  if (key === 'legendary') { legendaryBurst(card); if (front) front.insertAdjacentHTML('beforeend', sparklesHTML(9)); }
  updateTarotProgress();
  updateTagbar();
}
function legendaryBurst(card) {
  if (REDUCE_MOTION) return;
  const front = card.querySelector('.tarot-front'); if (!front) return;
  const b = document.createElement('span'); b.className = 'ttag-burst'; front.appendChild(b);
  b.animate([{ opacity: .95, transform: 'scale(.35)' }, { opacity: 0, transform: 'scale(1.15)' }],
    { duration: 560, easing: 'cubic-bezier(.22,.61,.36,1)' }).onfinish = () => b.remove();
}
function undoTarot() {
  const last = TAROT_HISTORY.pop();
  if (!last) { toast('沒有可復原的'); return; }
  const { rel, prev } = last;
  applyRarity(rel, prev);
  const cards = tarotCards();
  const card = cards.find(c => c.dataset.rel === rel);
  if (card) {
    RARITY_KEYS.forEach(k => card.classList.remove('assigned-' + k, 'rar-' + k));
    if (prev) { card.classList.add('assigned-' + prev); if (prev !== 'common') card.classList.add('rar-' + prev); }
    setTarotFocus(cards.indexOf(card));
  }
  updateTarotProgress();
  updateTagbar();
}
function updateTarotProgress() {
  const cards = tarotCards();
  const done = cards.filter(isAssigned).length;
  const el = $('ttag-progress'); if (el) el.textContent = `已標 ${done} / ${cards.length}`;
}

const drawDispatch = () => (MODE === 'tag' ? drawTagTarot() : drawTarot());
$('draw-cards').onclick = drawDispatch;
$('tarot-redraw').onclick = drawDispatch;
$('tarot-close').onclick = closeTarot;
$('tarot').addEventListener('click', e => { if (e.target.id === 'tarot') closeTarot(); });

/* ---------------- 生成步數（右上角，即時套用到之後的生成） ---------------- */
let stepsTimer;
$('steps-input').oninput = () => {
  clearTimeout(stepsTimer);
  stepsTimer = setTimeout(async () => {
    let s = parseInt($('steps-input').value, 10);
    if (!Number.isFinite(s)) return;
    s = Math.max(1, Math.min(150, s));
    try {
      const r = await fetch('/api/steps', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps: s }),
      });
      const j = await r.json();
      if (j.ok && $('conn').classList.contains('on')) $('conn-text').textContent = `ComfyUI 就緒 · steps ${j.steps}`;
    } catch (e) { /* 下次生成前會再送，不打擾 */ }
  }, 400);
};
$('steps-input').onblur = () => {   // 失焦時把值夾回合法範圍
  let s = parseInt($('steps-input').value, 10);
  if (Number.isFinite(s)) $('steps-input').value = Math.max(1, Math.min(150, s));
};

/* ---------------- 選取模式（品質篩選） ----------------
   點「篩選」進入選取模式：格線每張卡出現選取框，點卡片＝標記不優質（明顯紅叉、
   不開大圖），再點取消；再按「篩選」退出、回到正常（點卡片開大圖）。 */
let SELECTING = false;

function updateReviewCount() {
  const el = $('flag-count'); if (!el) return;
  const n = ALL.filter(x => x.flagged).length;
  el.textContent = n ? ` ${n}` : '';
}

function setSelecting(on) {
  SELECTING = on;
  document.body.classList.toggle('selecting', on);
  $('review-btn').classList.toggle('on', on);
  $('review-btn').firstChild.textContent = on ? '✓ 篩選中' : '🚩 篩選';
}

$('review-btn').onclick = () => setSelecting(!SELECTING);
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && SELECTING) setSelecting(false);
});

/* ── 打標模式：選取詞庫 → 點稀有度即時寫側檔（POST /api/rarity，不改檔名）。 ── */
const RARITY_FULL = { common: '普通版', rare: '稀有版', special: '特別版', legendary: '傳奇版' };
const SEL = new Set();                 // 打標模式選取的 rel

let _toastT = null;
function toast(msg) {
  const t = $('toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

function toggleSel(rel, cardEl) {
  if (SEL.has(rel)) SEL.delete(rel); else SEL.add(rel);
  if (cardEl) cardEl.classList.toggle('selected', SEL.has(rel));
  updateTagbar();
}
function clearSel() {
  SEL.clear();
  document.querySelectorAll('#grid .card.selected').forEach(c => c.classList.remove('selected'));
  updateTagbar();
}
function updateTagbar() {
  const n = SEL.size, c = $('tagbar-count');
  if (c) { c.textContent = `已選 ${n}`; c.classList.toggle('has', n > 0); }
  document.querySelectorAll('.rar-pick').forEach(b => { b.disabled = n === 0; });
}

// 即時把某詞庫的稀有度寫進側檔（樂觀更新本地 ALL[].rarity、失敗回退＋toast）。
async function applyRarity(rel, key) {
  const it = ALL.find(x => x.rel === rel);
  const prev = it ? (it.rarity || '') : '';
  if (key === prev) return true;
  if (it) it.rarity = key;
  try {
    const r = await fetch('/api/rarity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel, rarity: key }),
    }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    if (it) it.rarity = r.rarity;
    return true;
  } catch (e) {
    if (it) it.rarity = prev;
    toast('標記失敗：' + e.message);
    return false;
  }
}

// 把選取的詞庫即時標成某稀有度（隨標隨寫），清空選取、重繪反映。
async function tagSelected(key) {
  if (!SEL.size) return;
  const rels = [...SEL];
  clearSel();
  let ok = 0;
  for (const rel of rels) { if (await applyRarity(rel, key)) ok++; }
  withTransition(render);
  toast(`已標「${RARITY_FULL[key] || '移除'}」${ok} 筆`);
}

$('sel-all').onclick = () => { VISIBLE.forEach(x => SEL.add(x.rel)); withTransition(render); updateTagbar(); };
$('sel-clear').onclick = () => { clearSel(); withTransition(render); };
document.querySelectorAll('.rar-pick').forEach(b =>
  b.addEventListener('click', () => { if (!b.disabled) tagSelected(b.dataset.r); }));

function hideBoot() {
  const b = document.getElementById('boot');
  if (!b || b.classList.contains('hide')) return;
  b.classList.add('hide');
  setTimeout(() => b.remove(), 600);
}
// boot 只等「資料到＋首屏渲染完」就關。pollBatch 是常駐背景輪詢——批次執行中它
// 的 while(true) 永不 resolve，所以**不能**把 hideBoot 鏈在它後面（`() => pollBatch()`
// 會回傳那個永不結算的 promise），否則只要背景有批次在跑，boot 就會一直等到下面
// 的 20s 保險逾時才關＝每次刷新都卡整整 20 秒。改成 loadAll 完成後「不 return」地
// 啟動 pollBatch，讓 finally(hideBoot) 立刻收尾、pollBatch 自行在背景跑。
loadAll().then(() => { pollBatch(); }).finally(hideBoot);
setTimeout(hideBoot, 20000);   // 保險：萬一 loadAll 本身卡住也別讓載入畫面永遠蓋著
