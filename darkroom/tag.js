/* 詞庫打標：大量選取詞庫 → 套用稀有度（改檔名加/換/移除前綴）。改名前先預覽
   「舊名 → 新名」清單，確認才動檔。資料與樣式底層跟詞庫暗房共用（/api/libs、
   /api/thumb、darkroom.css）。這是獨立頁面，程式碼自成一格、不與 darkroom.js 共享。 */

let ALL = [];
let CUR_FOLDER = null;
let SEARCH = '';
let RAIL_SEARCH = '';
// 資料夾排序：名稱升／名稱降／未標多優先（找還沒標完的分類）
const RAIL_SORTS = ['name', 'name-desc', 'untagged'];
const RAIL_SORT_LABEL = { 'name': '名稱 ↑', 'name-desc': '名稱 ↓', 'untagged': '未標多 ⚑' };
let RAIL_SORT = localStorage.getItem('yz-tag-railsort') || 'name';
if (!RAIL_SORTS.includes(RAIL_SORT)) RAIL_SORT = 'name';
let VISIBLE = [];
let RARITY_FILTER = 'all';           // all | untagged | common | rare | special | legendary
const SEL = new Set();               // 目前選取的 rel（跨資料夾保留，準備標註）

// 即時把某詞庫的稀有度寫進側檔（POST /api/rarity，不改檔名、隨標隨生效）。樂觀更新
// 本地 ALL[].rarity、失敗回退＋toast。key ∈ common/rare/special/legendary 為設定、
// "" 為清除。取代舊的「暫存 → 統一改名」流程。
async function applyRarity(rel, key) {
  const it = ALL.find(x => x.rel === rel);
  const prev = it ? (it.rarity || '') : '';
  if (key === prev) return true;              // 沒變就不打擾伺服器
  if (it) it.rarity = key;                    // 樂觀更新
  try {
    const r = await fetch('/api/rarity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rel, rarity: key }),
    }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    if (it) it.rarity = r.rarity;             // 以伺服器回傳為準
    return true;
  } catch (e) {
    if (it) it.rarity = prev;                 // 失敗回退
    toast('標記失敗：' + e.message);
    return false;
  }
}
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
const RARITY_LABEL = { common: '普通', rare: '稀有', special: '特別', legendary: '傳奇' };
const RARITY_FULL = { common: '普通版', rare: '稀有版', special: '特別版', legendary: '傳奇版', '': '移除標記' };
// 傳奇卡的閃爍火花層（Aceternity Sparkles 的 vanilla 版）
function sparklesHTML(n = 7) {
  let s = '';
  for (let i = 0; i < n; i++)
    s += `<i style="left:${(Math.random() * 92 + 4).toFixed(1)}%;top:${(Math.random() * 92 + 4).toFixed(1)}%;--sz:${(2 + Math.random() * 2).toFixed(1)}px;animation-delay:${(Math.random() * 2.4).toFixed(2)}s"></i>`;
  return `<span class="sparkles" aria-hidden="true">${s}</span>`;
}

async function loadAll(force = false) {
  const j = await fetch('/api/libs' + (force ? '?force=1' : '')).then(r => r.json());
  ALL = j.items;
  $('conn').classList.toggle('on', !!j.comfy);
  $('conn-text').textContent = j.comfy ? 'ComfyUI 就緒' : 'ComfyUI 未連線';
  const total = ALL.length;
  const tagged = ALL.filter(x => x.rarity).length;
  const pctAll = total ? Math.round(tagged / total * 100) : 0;
  $('total-tag').textContent = `打標 ${pctAll}% · ${tagged}/${total}`;
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
  if (RAIL_SORT === 'name-desc') arr.reverse();
  else if (RAIL_SORT === 'untagged') arr.sort((a, b) => (b.total - b.tagged) - (a.total - a.tagged));  // 未標多的在前
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
    const full = s.total > 0 && s.tagged === s.total;   // 這夾全部標完 → 綠色滿格
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
      <div class="cover${full ? ' full' : ''}"><span style="width:${pct}%"></span></div>`;
    b.querySelector('.folder-name').textContent = s.name.replace(/^\d+[_\-\s]*/, '') || s.name;
    b.onclick = () => withTransition(() => { CUR_FOLDER = s.name; SEARCH = ''; $('search').value = ''; buildRail(); render(); $('main').scrollTop = 0; });
    frag.appendChild(b);
  });
  list.appendChild(frag);
}

function baseList() {
  if (SEARCH) {
    const q = SEARCH.toLowerCase();
    return ALL.filter(x => x.name.toLowerCase().includes(q) || (x.folder || '').toLowerCase().includes(q));
  }
  return ALL.filter(x => (x.folder || '(根目錄)') === CUR_FOLDER);
}

function currentList() {
  let list = baseList();
  if (RARITY_FILTER === 'untagged') list = list.filter(x => !x.rarity);
  else if (RARITY_FILTER !== 'all') list = list.filter(x => x.rarity === RARITY_FILTER);
  return list;
}

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
  if (RARITY_FILTER !== 'all' && !cnt[RARITY_FILTER]) RARITY_FILTER = 'all';
  bar.innerHTML = '';
  RARITY_BAR_DEFS.forEach(([key, label]) => {
    if (key !== 'all' && !cnt[key]) return;
    const b = document.createElement('button');
    b.className = 'rar-chip rc-' + key + (RARITY_FILTER === key ? ' on' : '');
    b.innerHTML = `<span class="rc-dot"></span><span class="rc-label"></span><span class="rc-count">${cnt[key]}</span>`;
    b.querySelector('.rc-label').textContent = label;
    b.onclick = () => withTransition(() => { RARITY_FILTER = key; render(); });
    bar.appendChild(b);
  });
}

/* ---- 格線（分頁 + 捲動預載，沿用暗房 PAGE=120） ---- */
const PAGE = 120;
let _rendered = 0, _io = null;

function cardOf(it) {
  const el = document.createElement('div');
  el.className = 'card tcard' + (it.has_image ? '' : ' missing')
    + (it.rarity ? ' rar-' + it.rarity : '') + (SEL.has(it.rel) ? ' selected' : '');
  el.dataset.rel = it.rel;
  const relEnc = encodeURIComponent(it.rel);
  const media = it.has_image
    ? `<img loading="lazy" decoding="async" width="360" height="360" src="/api/thumb?rel=${relEnc}&v=${it.image_mtime}" alt="" onload="this.classList.add('ld')" onerror="this.classList.add('ld')">`
    : `<div class="empty">${ICON_EMPTY}<span>尚無圖片</span></div>`;
  el.innerHTML = `
    <div class="thumb">${media}${it.rarity === 'legendary' ? sparklesHTML() : ''}${it.rarity ? `<span class="rar-tag ${it.rarity}">${RARITY_LABEL[it.rarity]}</span>` : ''}<span class="sel-box" aria-hidden="true">✓</span></div>
    <div class="card-body"><div class="card-name"></div>${SEARCH ? '<div class="card-folder"></div>' : ''}</div>`;
  el.querySelector('.card-name').textContent = it.display_name || it.name;
  if (SEARCH) el.querySelector('.card-folder').textContent = it.folder || '(根目錄)';
  el.querySelector('.thumb').onclick = () => toggleSel(it.rel, el);
  return el;
}

// 切資料夾／篩選／搜尋時用同文件 View Transitions 讓格線交叉淡入（見 darkroom.css
// 的 dr-grid）。守 REDUCE_MOTION 與 visibilityState——窗格隱藏時 callback 不結算
// （CLAUDE.md 老坑），退化成直接更新。
function withTransition(update) {
  if (document.startViewTransition && !REDUCE_MOTION && document.visibilityState === 'visible') {
    const grid = $('grid');
    grid.style.viewTransitionName = 'dr-grid-live';   // 同文件切換才交叉淡入；換頁維持不動（CSS 的 dr-grid）
    const t = document.startViewTransition(update);
    const restore = () => { grid.style.viewTransitionName = ''; };
    t.finished.finally(restore);
    setTimeout(restore, 1200);
  } else {
    update();
  }
}

function render() {
  buildRarityBar();
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
}

/* ---- 標註：把選取的詞庫即時標成某稀有度（隨標隨寫側檔），清空選取繼續下一批 ---- */
async function tagSelected(key) {
  if (!SEL.size) return;
  const rels = [...SEL];
  SEL.clear();
  updateTagbar();
  let ok = 0;
  for (const rel of rels) { if (await applyRarity(rel, key)) ok++; }
  withTransition(render);          // 重繪反映新稀有度（格線交叉淡入）
  buildRarityBar();
  toast(`已標「${RARITY_FULL[key]}」${ok} 筆`);
}

let _toastT = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------------- 抽卡打標：一次抽 16 張「有圖且尚未打標」的，逐張標稀有度（暫存） ----------------
   目的是讓打標隨機散布在各分類。標好的（含普通版）加入暫存＝之後不會再被抽到。 */
const RARITY_KEYS = ['common', 'rare', 'special', 'legendary'];
const DRAW_N = 15;                      // 一次抽幾張（5 欄 × 3 列）
let TAROT_FOCUS = -1;                   // 鍵盤焦點卡的索引（方向鍵移動、數字鍵打標）
const TAROT_HISTORY = [];              // 打標歷史，供 Z 復原：{rel, prev}

function sampleN(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
// 池：有圖、尚未打標（無稀有度）。標了即時生效，標過的下次自然不會再被抽到
const tarotPool = () => ALL.filter(x => x.has_image && !x.rarity);

const tarotCards = () => [...$('tarot-cards').children];
const isAssigned = c => RARITY_KEYS.some(k => c.classList.contains('assigned-' + k));

// 焦點：只有一張卡有 .focused，方向鍵移動、滑鼠移入也會設定
function setTarotFocus(i) {
  const cards = tarotCards();
  if (!cards.length) return;
  TAROT_FOCUS = Math.max(0, Math.min(i, cards.length - 1));
  cards.forEach((c, idx) => c.classList.toggle('focused', idx === TAROT_FOCUS));
  cards[TAROT_FOCUS].scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// 目前一列有幾張（依實際排版，responsive 會變）：第一列同 offsetTop 的張數
function tarotCols() {
  const cards = tarotCards();
  if (cards.length < 2) return 1;
  const top0 = cards[0].offsetTop;
  let n = 1;
  while (n < cards.length && cards[n].offsetTop === top0) n++;
  return n;
}

// 打標後自動跳到下一張「還沒標」的（從焦點+1 起繞一圈）；全標完就停在原地
function advanceFocus() {
  const cards = tarotCards();
  const n = cards.length;
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
  wrap.innerHTML = '';
  TAROT_HISTORY.length = 0;          // 新一批，清掉復原history
  picks.forEach((it, i) => {
    const card = document.createElement('div');
    card.className = 'tarot-card ttag-card';
    card.dataset.rel = it.rel;
    card.style.animationDelay = REDUCE_MOTION ? '0ms' : (i * 24) + 'ms';   // 發牌 stagger（16 張、快一點）
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
    card.addEventListener('mouseenter', () => setTarotFocus(i));   // 滑鼠移入也設焦點，滑鼠/鍵盤都能用
    wrap.appendChild(card);
  });
  $('tarot').classList.add('open');
  setTarotFocus(0);
  updateTarotProgress();
  const cards = [...wrap.children];
  if (REDUCE_MOTION) { cards.forEach(c => c.classList.add('revealed')); return; }
  const dealDone = picks.length * 24 + 170;
  cards.forEach((c, i) => setTimeout(() => c.classList.add('revealed'), dealDone + i * 32));   // 翻牌 stagger（快一點）
}

// 標一張：即時寫側檔、亮起該稀有度光環（common 無）、對應按鈕填色
function assignTarot(rel, card, key) {
  const it = ALL.find(x => x.rel === rel);
  TAROT_HISTORY.push({ rel, prev: it ? (it.rarity || '') : '' });   // 供 Z 復原（記標之前的值）
  applyRarity(rel, key);                                            // 即時寫側檔（樂觀，失敗會 toast＋回退）
  RARITY_KEYS.forEach(k => card.classList.remove('assigned-' + k, 'rar-' + k));
  card.classList.add('assigned-' + key);
  if (key !== 'common') card.classList.add('rar-' + key);   // 普通版不加光環
  const front = card.querySelector('.tarot-front');
  const oldSpark = front && front.querySelector('.sparkles');
  if (oldSpark) oldSpark.remove();                          // 重標時先清掉舊火花
  if (key === 'legendary') {                                // 傳奇：光爆＋常駐火花
    legendaryBurst(card);
    if (front) front.insertAdjacentHTML('beforeend', sparklesHTML(9));
  }
  updateTarotProgress();
  updateTagbar();
}

// 傳奇打標的小特效：牌面上一圈彩虹光爆快速擴散淡出（純裝飾層，不動內容不會糊）
function legendaryBurst(card) {
  if (REDUCE_MOTION) return;
  const front = card.querySelector('.tarot-front');
  if (!front) return;
  const b = document.createElement('span');
  b.className = 'ttag-burst';
  front.appendChild(b);
  b.animate(
    [{ opacity: .95, transform: 'scale(.35)' }, { opacity: 0, transform: 'scale(1.15)' }],
    { duration: 560, easing: 'cubic-bezier(.22,.61,.36,1)' }
  ).onfinish = () => b.remove();
}

// Z 復原：撤回上一次打標（即時還原成標之前的值），焦點回到那張
function undoTarot() {
  const last = TAROT_HISTORY.pop();
  if (!last) { toast('沒有可復原的'); return; }
  const { rel, prev } = last;
  applyRarity(rel, prev);            // 即時還原（prev 為 "" 代表回到未標）
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
  const cards = [...$('tarot-cards').children];
  const done = cards.filter(c => RARITY_KEYS.some(k => c.classList.contains('assigned-' + k))).length;
  $('ttag-progress').textContent = `已標 ${done} / ${cards.length}`;
}

function closeTarot() {
  $('tarot').classList.remove('open');
  TAROT_FOCUS = -1;
  render();          // 讓格線反映剛暫存的
  updateTagbar();
}

/* ---- 事件綁定 ---- */
function bind() {
  $('search').addEventListener('input', e => withTransition(() => { SEARCH = e.target.value.trim(); buildRail(); render(); }));
  $('folder-search').addEventListener('input', e => {
    RAIL_SEARCH = e.target.value.trim();
    $('folder-search-clear').style.display = RAIL_SEARCH ? '' : 'none';
    buildRail();
  });
  $('folder-search-clear').onclick = () => { RAIL_SEARCH = ''; $('folder-search').value = ''; $('folder-search-clear').style.display = 'none'; buildRail(); };
  $('rail-sort').onclick = () => {
    RAIL_SORT = RAIL_SORTS[(RAIL_SORTS.indexOf(RAIL_SORT) + 1) % RAIL_SORTS.length];
    localStorage.setItem('yz-tag-railsort', RAIL_SORT);
    $('rail-sort').textContent = RAIL_SORT_LABEL[RAIL_SORT];
    _railSig = ''; buildRail();
  };
  $('rescan').onclick = async () => { $('rescan').disabled = true; await loadAll(true); $('rescan').disabled = false; toast('已重掃'); };
  $('menu-btn').onclick = () => $('rail').classList.toggle('open');
  $('grid').addEventListener('pointermove', e => {          // 卡片聚光：游標追蹤
    const thumb = e.target.closest('.thumb');
    if (!thumb) return;
    const r = thumb.getBoundingClientRect();
    thumb.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    thumb.style.setProperty('--my', (e.clientY - r.top) + 'px');
  });
  $('sel-all').onclick = () => { VISIBLE.forEach(x => SEL.add(x.rel)); render(); updateTagbar(); };
  $('sel-clear').onclick = () => { SEL.clear(); render(); updateTagbar(); };
  document.querySelectorAll('.rar-pick').forEach(b =>
    b.addEventListener('click', () => { if (!b.disabled) tagSelected(b.dataset.r); }));
  // 抽卡打標
  $('draw-cards').onclick = drawTagTarot;
  $('tarot-redraw').onclick = drawTagTarot;
  $('tarot-close').onclick = closeTarot;
  $('tarot').addEventListener('click', e => { if (e.target === $('tarot')) closeTarot(); });
  document.addEventListener('keydown', e => {
    if ($('tarot').classList.contains('open')) {
      if (e.key === 'Escape') { closeTarot(); return; }
      const cards = tarotCards();
      if (!cards.length) return;
      const cols = tarotCols();
      if (e.key === 'r' || e.key === 'R' || e.key === 'Enter') { e.preventDefault(); drawTagTarot(); return; }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); advanceFocus(); return; }        // 跳過不標
      if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); undoTarot(); return; }            // 復原上一步
      const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
      if (e.key in move) { e.preventDefault(); setTarotFocus(TAROT_FOCUS + move[e.key]); return; }
      const rar = { '1': 'common', '2': 'rare', '3': 'special', '4': 'legendary' };
      if (rar[e.key]) {
        e.preventDefault();
        const card = cards[TAROT_FOCUS] || cards[0];
        assignTarot(card.dataset.rel, card, rar[e.key]);   // 標目前焦點卡
        advanceFocus();                                    // 自動換下一張沒標的
        return;
      }
      return;
    }
  });
  $('rail-sort').textContent = RAIL_SORT_LABEL[RAIL_SORT];
}

function hideBoot() {
  const b = document.getElementById('boot');
  if (!b || b.classList.contains('hide')) return;
  b.classList.add('hide');
  setTimeout(() => b.remove(), 600);
}
bind();
loadAll().finally(hideBoot);
setTimeout(hideBoot, 20000);   // 保險：萬一載入卡住也別讓載入畫面永遠蓋著
