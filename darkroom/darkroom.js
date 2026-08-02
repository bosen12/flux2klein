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
    b.onclick = () => { CUR_FOLDER = s.name; SEARCH = ''; $('search').value = ''; buildRail(); render(); $('main').scrollTop = 0; };
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
    b.onclick = () => { RARITY_FILTER = key; render(); };
    bar.appendChild(b);
  });
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
  $('mt-sub').textContent = `${total} 個詞庫 · 已生成 ${have} · 缺 ${total - have} · 覆蓋率 ${pct}%`;
  $('coverbar').firstElementChild.style.width = pct + '%';

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
    if (!REDUCE_MOTION) { card.classList.add('reveal'); fresh.push(card); }
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

// 縮圖內部標記：星號、選取框、紅叉、生成鈕全部就地重建（reloadThumb 會覆寫
// thumb.innerHTML，所以這些覆蓋層要有單一來源，避免生成後星號/生成鈕被清掉）。
function thumbInnerHTML(it) {
  const relEnc = encodeURIComponent(it.rel);
  const media = it.has_image
    ? `<img loading="lazy" decoding="async" width="360" height="360" src="/api/thumb?rel=${relEnc}&v=${it.image_mtime}" alt="" onload="this.classList.add('ld')" onerror="this.classList.add('ld')">`
    : `<div class="empty">${ICON_EMPTY}<span>尚無圖片</span></div>`;
  return `${media}` +
    rarTag(it.rarity) +
    `<button class="fav-btn" type="button" aria-label="收藏" aria-pressed="${it.favorited ? 'true' : 'false'}">${ICON_STAR}</button>` +
    `<span class="pick-box" aria-hidden="true"></span>` +
    `<span class="flag-x" aria-hidden="true">✕</span>` +
    `<button class="gen-btn">${it.has_image ? '重新生成' : '生成'}</button>`;
}

function wireThumb(thumb, it) {
  // 選取模式：點縮圖＝標記/取消不優質；平常＝開大圖
  thumb.onclick = () => { if (SELECTING) toggleFlag(it.rel); else openModal(it.rel); };
  thumb.querySelector('.gen-btn').onclick = (e) => { e.stopPropagation(); generate(it.rel); };
  thumb.querySelector('.fav-btn').onclick = (e) => { e.stopPropagation(); toggleFav(it.rel); };
}

function cardOf(it) {
  const el = document.createElement('div');
  el.className = 'card' + (it.has_image ? '' : ' missing') + (it.flagged ? ' flagged' : '')
    + (it.favorited ? ' favorited' : '') + (it.rarity ? ' rar-' + it.rarity : '');
  el.dataset.rel = it.rel;
  el.innerHTML = `
    <div class="thumb">${thumbInnerHTML(it)}</div>
    <div class="card-body">
      <div class="card-name"></div>
      ${SEARCH ? '<div class="card-folder"></div>' : ''}
    </div>
    <div class="status"></div>`;
  el.querySelector('.card-name').textContent = it.display_name || it.name;
  if (SEARCH) el.querySelector('.card-folder').textContent = it.folder || '(根目錄)';
  wireThumb(el.querySelector('.thumb'), it);
  if (it.job && it.job.status) updateStatusEl(el.querySelector('.status'), it.job);
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
  $('modal-close').onclick = closeModal;
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
function cssAttr(s) { return String(s).replace(/["\\]/g, '\\$&'); }

/* 篩選段 */
$('view-seg').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  VIEW = btn.dataset.v;
  $('view-seg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
  moveSegPill();
  render();
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

let searchTimer;
$('search').oninput = e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { SEARCH = e.target.value.trim(); buildRail(); render(); }, 180);
};
$('rescan').onclick = () => loadAll(true);
$('menu-btn').onclick = () => $('rail').classList.toggle('open');
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

$('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
$('m-prev').onclick = () => modalStep(-1);
$('m-next').onclick = () => modalStep(1);
window.addEventListener('keydown', e => {
  if ($('tarot').classList.contains('open') && e.key === 'Escape') { closeTarot(); return; }
  if (!$('modal').classList.contains('open')) return;
  if (e.key === 'Escape') closeModal();
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
         <div class="tarot-front${it.has_image ? ' loading' : ''}">${face}${rarTag(it.rarity)}<div class="tarot-name"></div><div class="tarot-folder"></div><div class="tarot-glare"></div></div>
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

function closeTarot() { $('tarot').classList.remove('open'); }

$('draw-cards').onclick = drawTarot;
$('tarot-redraw').onclick = drawTarot;
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

loadAll().then(() => pollBatch());
