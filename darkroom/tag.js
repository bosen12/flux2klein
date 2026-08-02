/* 詞庫打標：大量選取詞庫 → 套用稀有度（改檔名加/換/移除前綴）。改名前先預覽
   「舊名 → 新名」清單，確認才動檔。資料與樣式底層跟詞庫暗房共用（/api/libs、
   /api/thumb、darkroom.css）。這是獨立頁面，程式碼自成一格、不與 darkroom.js 共享。 */

let ALL = [];
let CUR_FOLDER = null;
let SEARCH = '';
let RAIL_SEARCH = '';
let RAIL_DESC = localStorage.getItem('yz-rail-desc') === '1';
let VISIBLE = [];
const SEL = new Set();               // 目前選取的 rel（跨資料夾保留，準備標註）
const STAGED = new Map();            // 暫存標註：rel -> 目標稀有度（先不動檔，最後統一改名）
let PENDING = null;                   // 待確認的改名清單 [{rel, rarity}]

const rarityOf = rel => { const it = ALL.find(x => x.rel === rel); return it ? (it.rarity || '') : ''; };
// 暫存中「真的會改」的（目標稀有度 ≠ 目前稀有度）。no-op 不算，數字才誠實。
const stagedChanges = () => [...STAGED].filter(([rel, r]) => r !== rarityOf(rel));
const REDUCE_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 顯示目前操作的詞庫資料夾（尾兩段），避免兩個 bat 的不同 special_dir 搞混改到別份。
function setDataset(dir) {
  const el = $('dataset');
  if (!el || !dir) return;
  const parts = String(dir).replace(/\\/g, '/').split('/').filter(Boolean);
  el.textContent = parts.slice(-2).join('/');
  el.title = '目前操作的詞庫資料夾：' + dir;
}

const ICON_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m21 15-5-5L5 21"/></svg>';
const RARITY_LABEL = { rare: '稀有', special: '特別', legendary: '傳奇' };
const RARITY_FULL = { rare: '稀有版', special: '特別版', legendary: '傳奇版', '': '移除標記' };

async function loadAll(force = false) {
  const j = await fetch('/api/libs' + (force ? '?force=1' : '')).then(r => r.json());
  ALL = j.items;
  $('conn').classList.toggle('on', !!j.comfy);
  $('conn-text').textContent = j.comfy ? 'ComfyUI 就緒' : 'ComfyUI 未連線';
  const total = ALL.length;
  const tagged = ALL.filter(x => x.rarity).length;
  $('total-tag').textContent = `${tagged}/${total} 已標稀有度`;
  setDataset(j.special_dir);
  if (CUR_FOLDER === null) {
    const folders = folderStats();
    CUR_FOLDER = folders.length ? folders[0].name : '';
  }
  buildRail();
  render();
  updateTagbar();
}

/* ---- 資料夾側欄（沿用暗房邏輯：數字前綴照數值排） ---- */
function folderStats() {
  const map = new Map();
  for (const x of ALL) {
    const f = x.folder || '(根目錄)';
    if (!map.has(f)) map.set(f, { name: f, total: 0, tagged: 0 });
    const s = map.get(f); s.total++; if (x.rarity) s.tagged++;
  }
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
  const sig = stats.map(s => s.name).join('|');
  const animate = !REDUCE_MOTION && sig !== _railSig;
  _railSig = sig;
  stats.forEach((s, i) => {
    const pct = s.total ? Math.round(s.tagged / s.total * 100) : 0;
    const b = document.createElement('button');
    b.className = 'folder' + (s.name === CUR_FOLDER && !SEARCH ? ' active' : '');
    if (animate && i < 22) { b.classList.add('rin'); b.style.animationDelay = (i * 18) + 'ms'; }
    b.dataset.folder = s.name;
    const idx = /^\d+/.exec(s.name);
    b.innerHTML = `
      <div class="folder-top">
        <span class="folder-idx">${idx ? idx[0] : '·'}</span>
        <span class="folder-name"></span>
        <span class="folder-count">${s.tagged}/${s.total}</span>
      </div>
      <div class="cover"><span style="width:${pct}%"></span></div>`;
    b.querySelector('.folder-name').textContent = s.name.replace(/^\d+[_\-\s]*/, '') || s.name;
    b.onclick = () => { CUR_FOLDER = s.name; SEARCH = ''; $('search').value = ''; buildRail(); render(); $('main').scrollTop = 0; };
    frag.appendChild(b);
  });
  list.appendChild(frag);
}

function currentList() {
  if (SEARCH) {
    const q = SEARCH.toLowerCase();
    return ALL.filter(x => x.name.toLowerCase().includes(q) || (x.folder || '').toLowerCase().includes(q));
  }
  return ALL.filter(x => (x.folder || '(根目錄)') === CUR_FOLDER);
}

/* ---- 格線（分頁 + 捲動預載，沿用暗房 PAGE=120） ---- */
const PAGE = 120;
let _rendered = 0, _io = null;

function cardOf(it) {
  const el = document.createElement('div');
  const stagedKey = STAGED.has(it.rel) ? STAGED.get(it.rel) : null;
  const stagedChange = stagedKey !== null && stagedKey !== (it.rarity || '');   // 只有真的會改才顯示暫存標
  el.className = 'card tcard' + (it.has_image ? '' : ' missing')
    + (it.rarity ? ' rar-' + it.rarity : '') + (SEL.has(it.rel) ? ' selected' : '')
    + (stagedChange ? ' staged stage-' + (stagedKey || 'none') : '');
  el.dataset.rel = it.rel;
  const relEnc = encodeURIComponent(it.rel);
  const media = it.has_image
    ? `<img loading="lazy" decoding="async" width="360" height="360" src="/api/thumb?rel=${relEnc}&v=${it.image_mtime}" alt="" onload="this.classList.add('ld')" onerror="this.classList.add('ld')">`
    : `<div class="empty">${ICON_EMPTY}<span>尚無圖片</span></div>`;
  const stageTag = stagedChange
    ? `<span class="stage-tag stage-${stagedKey || 'none'}" title="點此取消暫存">→ ${stagedKey ? RARITY_LABEL[stagedKey] : '無'}</span>` : '';
  el.innerHTML = `
    <div class="thumb">${media}${it.rarity ? `<span class="rar-tag ${it.rarity}">${RARITY_LABEL[it.rarity]}</span>` : ''}${stageTag}<span class="sel-box" aria-hidden="true">✓</span></div>
    <div class="card-body"><div class="card-name"></div>${SEARCH ? '<div class="card-folder"></div>' : ''}</div>`;
  el.querySelector('.card-name').textContent = it.display_name || it.name;
  if (SEARCH) el.querySelector('.card-folder').textContent = it.folder || '(根目錄)';
  el.querySelector('.thumb').onclick = () => toggleSel(it.rel, el);
  const st = el.querySelector('.stage-tag');
  if (st) st.onclick = (e) => { e.stopPropagation(); STAGED.delete(it.rel); render(); updateTagbar(); };
  return el;
}

function render() {
  const list = currentList();
  VISIBLE = list;
  const total = list.length, tagged = list.filter(x => x.rarity).length;
  if (SEARCH) {
    $('mt-num').textContent = '';
    $('mt-name').textContent = `搜尋:「${SEARCH}」`;
  } else {
    const idx = /^\d+/.exec(CUR_FOLDER || '');
    $('mt-num').textContent = idx ? idx[0] : '';
    $('mt-name').textContent = (CUR_FOLDER || '').replace(/^\d+[_\-\s]*/, '') || CUR_FOLDER || '—';
  }
  $('mt-sub').textContent = `${total} 個詞庫 · 已標稀有度 ${tagged}`;
  const grid = $('grid');
  grid.innerHTML = '';
  if (_io) { _io.disconnect(); _io = null; }
  if (!total) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="big">這裡沒有符合的詞庫</div>換個資料夾或搜尋</div>`;
    return;
  }
  _rendered = 0;
  appendPage();
  if (_rendered < total) {
    const sentinel = document.createElement('div');
    sentinel.id = 'scroll-sentinel';
    sentinel.style.cssText = 'grid-column:1/-1;height:1px;';
    grid.appendChild(sentinel);
    _io = new IntersectionObserver(es => { if (es[0].isIntersecting) appendPage(); },
      { root: $('main'), rootMargin: '800px 0px' });
    _io.observe(sentinel);
  }
}

function appendPage() {
  const grid = $('grid');
  const slice = VISIBLE.slice(_rendered, _rendered + PAGE);
  if (!slice.length) return;
  const frag = document.createDocumentFragment();
  slice.forEach(it => frag.appendChild(cardOf(it)));
  const sentinel = $('scroll-sentinel');
  if (sentinel) grid.insertBefore(frag, sentinel); else grid.appendChild(frag);
  _rendered += slice.length;
  if (_rendered >= VISIBLE.length && _io) {
    _io.disconnect(); _io = null;
    const s = $('scroll-sentinel'); if (s) s.remove();
  }
}

/* ---- 選取 ---- */
function toggleSel(rel, el) {
  if (SEL.has(rel)) SEL.delete(rel); else SEL.add(rel);
  if (el) el.classList.toggle('selected', SEL.has(rel));
  updateTagbar();
}

function updateTagbar() {
  const n = SEL.size;
  const c = $('tagbar-count');
  c.textContent = `已選 ${n}`;
  c.classList.toggle('has', n > 0);
  document.querySelectorAll('.rar-pick').forEach(b => { b.disabled = n === 0; });
  // 暫存摘要（只算真的會改的）
  const changes = stagedChanges();
  const cnt = { rare: 0, special: 0, legendary: 0, '': 0 };
  changes.forEach(([, r]) => { cnt[r]++; });
  const parts = [];
  if (cnt.rare) parts.push(`稀有 ${cnt.rare}`);
  if (cnt.special) parts.push(`特別 ${cnt.special}`);
  if (cnt.legendary) parts.push(`傳奇 ${cnt.legendary}`);
  if (cnt['']) parts.push(`移除 ${cnt['']}`);
  const m = changes.length;
  $('staged-summary').textContent = m ? `暫存 ${m}（${parts.join('・')}）` : '';
  $('stage-clear').disabled = STAGED.size === 0;
  const apply = $('apply-all');
  apply.disabled = m === 0;
  apply.textContent = m ? `統一改名 (${m})` : '統一改名';
}

/* ---- ①標註：把選取的 rel 暫存成某稀有度（先不動檔），清空選取繼續下一批 ---- */
function stageSelected(rarity) {
  if (!SEL.size) return;
  SEL.forEach(rel => STAGED.set(rel, rarity));
  SEL.clear();
  render();
  updateTagbar();
  toast(`已暫存標註「${RARITY_FULL[rarity]}」`);
}

/* ---- ②統一改名：把所有暫存的一次 dry 預覽 → 確認 → 真改 ---- */
async function applyAll() {
  const changes = stagedChanges();
  if (!changes.length) return;
  const renames = changes.map(([rel, rarity]) => ({ rel, rarity }));
  let j;
  try {
    j = await fetch('/api/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ renames, dry: true }),
    }).then(r => r.json());
  } catch (e) { toast('預覽失敗：' + e.message); return; }
  if (j.error) { toast(j.error); return; }
  showConfirm(j.results);
}

function showConfirm(results) {
  const willChange = results.filter(r => !r.skip && !r.error);
  const skipped = results.filter(r => r.skip);
  const errored = results.filter(r => r.error);
  PENDING = willChange.map(r => ({ rel: r.rel, rarity: r.rarity }));
  $('confirm-title').textContent = '確認統一改名';
  $('confirm-sub').textContent =
    `將改名 ${willChange.length} 筆`
    + (skipped.length ? ` · 略過 ${skipped.length}（已是此狀態）` : '')
    + (errored.length ? ` · 衝突/錯誤 ${errored.length}` : '');
  const order = [...willChange, ...skipped, ...errored];
  $('confirm-list').innerHTML = order.map(r => {
    if (r.error) return `<div class="crow err"><span class="cn">${esc(r.old_name)}</span><span class="ar">✕ ${esc(r.error)}</span></div>`;
    if (r.skip) return `<div class="crow skip"><span class="cn old">${esc(r.old_name)}</span><span class="ar">—</span><span class="cn new">無變化</span></div>`;
    return `<div class="crow"><span class="cn old">${esc(r.old_name)}</span><span class="ar">→</span><span class="cn new">${esc(r.new_name)}</span></div>`;
  }).join('');
  $('confirm-go').disabled = willChange.length === 0;
  $('confirm').classList.add('open');
}

function closeConfirm() { $('confirm').classList.remove('open'); PENDING = null; }

async function confirmGo() {
  if (!PENDING || !PENDING.length) return;
  $('confirm-go').disabled = true;
  let j;
  try {
    j = await fetch('/api/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ renames: PENDING, dry: false }),
    }).then(r => r.json());
  } catch (e) { toast('改名失敗：' + e.message); $('confirm-go').disabled = false; return; }
  const ok = j.results.filter(x => x.ok).length;
  const bad = j.results.filter(x => x.error).length;
  closeConfirm();
  SEL.clear();
  STAGED.clear();
  await loadAll();
  toast(`已統一改名 ${ok} 筆` + (bad ? ` · ${bad} 筆失敗` : ''));
}

let _toastT = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---- 事件綁定 ---- */
function bind() {
  $('search').addEventListener('input', e => { SEARCH = e.target.value.trim(); buildRail(); render(); });
  $('folder-search').addEventListener('input', e => {
    RAIL_SEARCH = e.target.value.trim();
    $('folder-search-clear').style.display = RAIL_SEARCH ? '' : 'none';
    buildRail();
  });
  $('folder-search-clear').onclick = () => { RAIL_SEARCH = ''; $('folder-search').value = ''; $('folder-search-clear').style.display = 'none'; buildRail(); };
  $('rail-sort').onclick = () => {
    RAIL_DESC = !RAIL_DESC;
    localStorage.setItem('yz-rail-desc', RAIL_DESC ? '1' : '0');
    $('rail-sort').textContent = RAIL_DESC ? '降冪 ↓' : '升冪 ↑';
    _railSig = ''; buildRail();
  };
  $('rescan').onclick = async () => { $('rescan').disabled = true; await loadAll(true); $('rescan').disabled = false; toast('已重掃'); };
  $('menu-btn').onclick = () => $('rail').classList.toggle('open');
  $('sel-all').onclick = () => { VISIBLE.forEach(x => SEL.add(x.rel)); render(); updateTagbar(); };
  $('sel-clear').onclick = () => { SEL.clear(); render(); updateTagbar(); };
  document.querySelectorAll('.rar-pick').forEach(b =>
    b.addEventListener('click', () => { if (!b.disabled) stageSelected(b.dataset.r); }));
  $('apply-all').onclick = applyAll;
  $('stage-clear').onclick = () => { STAGED.clear(); render(); updateTagbar(); };
  $('confirm-go').onclick = confirmGo;
  $('confirm-cancel').onclick = closeConfirm;
  $('confirm').addEventListener('click', e => { if (e.target === $('confirm')) closeConfirm(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeConfirm(); });
  $('rail-sort').textContent = RAIL_DESC ? '降冪 ↓' : '升冪 ↑';
}

bind();
loadAll();
