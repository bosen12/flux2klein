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
// 滾動數字：見 darkroom.css .count-num（CSS counter 補間，這裡只需要設 --n）。
const setCount = (el, value) => { if (el) el.style.setProperty('--n', String(value)); };

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
  setCount($('total-have'), have);
  setCount($('total-all'), total);
  setDataset(j.special_dir);
  if (typeof j.steps === 'number' && document.activeElement !== $('steps-input')) $('steps-input').value = j.steps;
  updateReviewCount();
  if (CUR_FOLDER === null) {
    const folders = folderStats();
    const saved = loadViewState();
    if (saved) {
      // 資料夾要先確認現在還存在才能還原（詞庫可能被刪掉/改名），其餘三個直接還原即可，
      // 就算值已經不合法，buildRarityBar()/currentList() 本來就有各自的防呆邏輯。
      if (folders.some(f => f.name === saved.folder)) CUR_FOLDER = saved.folder;
      if (typeof saved.search === 'string') { SEARCH = saved.search; $('search').value = SEARCH; }
      if (saved.view === 'all' || saved.view === 'missing' || saved.view === 'have') VIEW = saved.view;
      if (typeof saved.rarity === 'string') RARITY_FILTER = saved.rarity;
    }
    if (CUR_FOLDER === null) CUR_FOLDER = folders.length ? folders[0].name : '';
    syncViewSeg();
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
    // hover 顯示這個等級佔目前範圍的比例，沿用觸發詞卡同一套浮動提示框（見
    // showStatTip，跟 showTwTip 共用 .tw-tip 元素與定位邏輯，只是不用打翻譯 API）。
    if (key !== 'all') {
      const pct = base.length ? Math.round(cnt[key] / base.length * 100) : 0;
      b.addEventListener('mouseenter', () => showStatTip(b, `佔目前範圍 ${pct}%（${cnt[key]}／${base.length}）`));
      b.addEventListener('mouseleave', () => hideTwTip(b));
    }
    bar.appendChild(b);
  });
}

// 切資料夾／篩選／搜尋：直接更新，**不走 View Transitions**。VT 對「很高且有捲動偏移」
// 的格線群組交叉淡會出現怪異位移（尤其先捲動再切資料夾），而且隱藏窗格根本沒法驗證。
// 改成瞬間換內容，新卡片靠既有的逐張淡入（reveal-on-scroll，見 render 的 _revealIO）
// 進場，穩定不怪。保留這個包裝函式只為讓呼叫端不必改。
let _switching = false;   // 保留給 appendPage 判斷（現在恆為 false＝新卡片一律逐張淡入）
function withTransition(update) { update(); }

// 更新標頭統計（分類名、摘要、覆蓋率條）＋算出 VISIBLE。**不動格線 DOM**——所以
// 切模式只要呼叫這個（內容相同、不必重建格線＝圖片不會重繪暗一下）。
function updateStats() {
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
  // 覆蓋率條兩模式都顯示：瀏覽=已生成比例、打標=已標稀有度比例。摘要文字同步。
  if (MODE === 'tag') {
    const tagged = list.filter(x => x.rarity).length;
    const pctT = total ? Math.round(tagged / total * 100) : 0;
    $('mt-sub').textContent = `${total} 個詞庫 · 已標稀有度 ${tagged} · 打標 ${pctT}%`;
    $('coverbar').firstElementChild.style.width = pctT + '%';
  } else {
    $('mt-sub').textContent = `${total} 個詞庫 · 已生成 ${have} · 缺 ${total - have} · 覆蓋率 ${pct}%`;
    $('coverbar').firstElementChild.style.width = pct + '%';
  }
  return total;
}

// 狀態持久化：資料夾/搜尋/缺圖篩選/稀有度篩選記到 localStorage，重整後恢復（跟既有
// yz-mode/yz-rail-desc 同一套慣例）。寫在 render() 最前面（唯一收斂點，每次狀態變動
// 最後都會呼叫 render，不用在每個 onclick 各自補一行、容易漏）。
function saveViewState() {
  try {
    localStorage.setItem('yz-view-state', JSON.stringify({ folder: CUR_FOLDER, search: SEARCH, view: VIEW, rarity: RARITY_FILTER }));
  } catch (e) { /* 存取被封鎖或滿了，忽略即可，不影響核心功能 */ }
}
function loadViewState() {
  try { return JSON.parse(localStorage.getItem('yz-view-state') || 'null'); }
  catch (e) { return null; }
}
// 恢復 VIEW 的視覺狀態（RARITY_FILTER 由 buildRarityBar() 每次 render 自己讀變數重建，
// 不用另外同步；VIEW 的分段按鈕是靠 click handler 手動切 class，重整時要補這一步）。
function syncViewSeg() {
  const seg = $('view-seg'); if (!seg) return;
  seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === VIEW));
  moveSegPill();
}

function render() {
  saveViewState();
  const total = updateStats();
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
      if (!es[0].isIntersecting) return;
      // 安全網：目前實際最大的資料夾約 400 筆，自動捲動完全撐得住。這個上限是給
      // 「萬一某天有資料夾長到幾千筆」預留的——超過就改成手動按「載入更多」才繼續，
      // 不再自動觸發，避免病態情況下 DOM 節點無上限疊加拖垮分頁。目前規模下完全不會
      // 觸發，是 0 風險的預防性措施；不是真正的虛擬捲動（不移除已渲染卡片，不牽動
      // 選取狀態/hover/點擊等既有邏輯，沒有重寫風險）。
      if (_rendered >= AUTO_LOAD_CAP) { convertSentinelToLoadMoreButton(); return; }
      appendPage();
    }, { root: $('main'), rootMargin: '800px 0px' });   // 提前 800px 預載
    _io.observe(sentinel);
  }
}

const PAGE = 120;
const AUTO_LOAD_CAP = 600;
let _rendered = 0, _io = null, _revealIO = null;

function convertSentinelToLoadMoreButton() {
  if (_io) { _io.disconnect(); _io = null; }
  const old = $('scroll-sentinel');
  if (!old) return;
  const btn = document.createElement('button');
  btn.id = 'scroll-sentinel';
  btn.className = 'ghost load-more-btn';
  btn.style.gridColumn = '1/-1';
  btn.textContent = `載入更多（還有 ${VISIBLE.length - _rendered} 筆）`;
  btn.onclick = () => {
    appendPage();
    // 全部載完：appendPage() 自己的清除邏輯只在 _io 還在時才會拿掉 sentinel，
    // 這裡走的是手動按鈕、_io 已經是 null，要自己補移除，不然按鈕會留在格線最後面。
    const now = $('scroll-sentinel');
    if (!now) return;
    if (_rendered >= VISIBLE.length) { now.remove(); return; }
    if (now.tagName === 'BUTTON') now.textContent = `載入更多（還有 ${VISIBLE.length - _rendered} 筆）`;
  };
  old.replaceWith(btn);
}

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
    if (MODE === 'tag' || MODE === 'gen') toggleSel(it.rel, thumb.closest('.card'));
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

// 抽卡點卡片開大圖時，大圖疊在塔羅之上（不關塔羅）；關大圖就回到那批牌而非主頁。
// 由各開啟點設定：抽卡的卡片設 true、格線縮圖/結果區設 false。
let MODAL_FROM_TAROT = false;
function dismissModal() {
  if (MODAL_FROM_TAROT) { MODAL_FROM_TAROT = false; closeModal(); }   // 露出底下那批抽到的牌
  else closeModalWithMorph();
}

function openModal(rel, resetNav = true) {
  const item = ALL.find(x => x.rel === rel);
  if (!item) return;
  const inner = $('modal-inner');
  inner.dataset.rel = rel;
  delete inner.dataset.gid;   // 清掉圖庫大圖可能留下的 gid，不然方向鍵分支會誤判成還在切圖庫
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
  $('modal-close').onclick = dismissModal;
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
  if (inner) { delete inner.dataset.rel; delete inner.dataset.gid; }
}

// 圖庫大圖的左右切換：跟 modalStep()（切詞庫格線的 VISIBLE）是不同清單，圖庫大圖切的是
// GALLERY，順序要跟畫面上看到的一致——renderGallery() 是新到舊（陣列反過來疊代），這裡
// 用同一個順序，不然「按右鍵」跟「畫面往右移一張」對不起來。
function galleryOrder() { return [...GALLERY].reverse(); }
function galleryModalStep(dir) {
  const inner = $('modal-inner');
  const gid = inner && inner.dataset.gid;
  if (!gid) return;
  const order = galleryOrder();
  const i = order.findIndex(g => g.id === gid);
  if (i < 0 || !order.length) return;
  const ni = (i + dir + order.length) % order.length;
  openGalleryItem(order[ni].id);
}

// 開大圖：縮圖 morph 放大成大圖（shared-element，view-transition-name: hero-img）。
// 老套路——舊快照在 callback 前截（此時縮圖有名字），callback 裡先清掉縮圖名字再開
// modal（大圖經 css 帶 hero-img），新快照只有大圖有名字 → 縮圖平滑長成大圖。
// 守 REDUCE_MOTION 與 visibilityState（窗格隱藏 callback 不結算，CLAUDE.md 老坑）。
function openModalFromThumb(rel, thumbImg) {
  MODAL_FROM_TAROT = false;                 // 格線縮圖開的大圖：關閉走 morph 縮回縮圖
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

/* ── 模式：瀏覽 / 打標 / 生圖（合併成一頁，切模式只設 body[data-mode]，不換頁） ──
   初始模式：網址 /tag 或 ?mode=xxx → 指定；否則沿用上次（localStorage）。 */
const MODES = ['browse', 'tag', 'gen'];
function initialMode() {
  if (location.pathname === '/tag') return 'tag';
  const q = new URLSearchParams(location.search).get('mode');
  if (MODES.includes(q)) return q;
  const saved = localStorage.getItem('yz-mode');
  return MODES.includes(saved) ? saved : 'browse';
}
let MODE = initialMode();
function moveModePill() {
  const seg = $('mode-seg'), pill = $('mode-pill');
  const active = seg && seg.querySelector('button.on');
  if (!active || !pill) return;
  pill.style.width = active.offsetWidth + 'px';
  pill.style.transform = `translateX(${active.offsetLeft}px)`;
}
const MODE_TITLE = { browse: '詞庫暗房', tag: '詞庫打標', gen: '詞庫生圖' };
function applyMode(mode) {
  MODE = MODES.includes(mode) ? mode : 'browse';
  document.body.dataset.mode = MODE;
  localStorage.setItem('yz-mode', MODE);
  $('mode-seg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === MODE));
  const h1 = document.querySelector('.brand h1');
  if (h1) h1.textContent = MODE_TITLE[MODE] || '詞庫暗房';
  moveModePill();
}
// 切模式**不重建格線、不走 VT**：各模式的卡片 DOM 相同（只差 CSS 顯隱與點擊行為，由
// body[data-mode] 控制），所以只要切 body[data-mode]＋更新標頭統計＋清選取即可。
// 不動格線 = 不重建 <img> = 圖片不會重繪暗一下；不碰 VT = 不會閃。
function switchMode(mode) {
  document.querySelectorAll('#grid .card.selected').forEach(c => c.classList.remove('selected'));
  SEL.clear();
  applyMode(mode);
  updateStats();
  updateTagbar();
  updateGenbar();
}
$('mode-seg').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  if (!GALLERY_OPEN && btn.dataset.mode === MODE) return;
  const apply = () => {
    if (GALLERY_OPEN) { GALLERY_OPEN = false; document.body.classList.remove('gallery-open'); $('gallery-btn').classList.remove('on'); }
    switchMode(btn.dataset.mode);
  };
  if (GALLERY_OPEN) switchView(apply);   // 從圖庫切回某模式：交叉淡入
  else apply();
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
// 圖庫卡同一招聚光（見 .gc-square::after）
$('gallery-grid').addEventListener('pointermove', e => {
  const sq = e.target.closest('.gc-square');
  if (!sq) return;
  const r = sq.getBoundingClientRect();
  sq.style.setProperty('--mx', (e.clientX - r.left) + 'px');
  sq.style.setProperty('--my', (e.clientY - r.top) + 'px');
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

$('modal').addEventListener('click', e => { if (e.target.id === 'modal') dismissModal(); });
$('m-prev').onclick = () => modalStep(-1);
$('m-next').onclick = () => modalStep(1);
window.addEventListener('keydown', e => {
  // 這個 app 的快捷鍵全部是單一按鍵（R/E/C/X/1~4/S/Z/?/方向鍵…），沒有一個需要搭配
  // Ctrl/Cmd/Alt。沒有這條擋在最前面，按 Ctrl+C 複製、Ctrl+X 剪下、Ctrl+Z 復原、
  // Ctrl+S 存檔這些瀏覽器/系統原生快捷鍵會被底下對應字母的分支攔截、擋掉
  // preventDefault——使用者回報「很多 Windows 預設快捷鍵都不能用」就是這個。任何組合鍵
  // 一律直接放行給瀏覽器/系統處理，不進這支 handler 的判斷邏輯。
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // 快捷鍵一覽（z-index 210，蓋過所有其他疊層）排最前面：不管現在開著什麼，Esc 都先關
  // 這個說明疊層，不去動底下真正在操作的東西。
  if ($('shortcuts-overlay').classList.contains('open')) {
    if (e.key === 'Escape' || e.key === '?') { closeShortcuts(); }
    return;
  }
  // 隨機瀏覽疊在 LoRA 大面板之上：優先處理，不能讓下面「lora-modal 開著時 Esc
  // 關大面板」的分支把這個疊層的按鍵也吃掉（那樣 Esc 會直接關掉整個大面板，
  // 而不是只關疊層回到大面板）。
  if (LORA_TAROT && $('tarot').classList.contains('open')) {
    if (e.key === 'Escape') { closeTarot(); return; }
    if (e.key === 'r' || e.key === 'R' || e.key === 'Enter') { e.preventDefault(); drawLoraTarot(); return; }   // 全庫重抽
    if (e.key === 'e' || e.key === 'E') { e.preventDefault(); drawLoraCategoryDispatch(); return; }             // 只抽目前左欄選的分類/子資料夾
    return;
  }
  // Concepts 抽卡同樣要排在「MODE==='tag' 就全鍵盤逐張標」那條之前——不然使用者剛好停在
  // 打標模式時按 C 開了 Concepts 疊層，R/1~4 這些鍵會被下面通用分支誤判成打標快捷鍵。
  if (CONCEPTS_TAROT && $('tarot').classList.contains('open')) {
    if (e.key === 'Escape') { closeTarot(); return; }
    // R/C 在疊層內都是「重抽」，用同一份 drawConceptsTarot（C/X 已經合併成一顆，不再
    // 需要分兩個版本各自記住怎麼重抽）。
    if (e.key === 'r' || e.key === 'R' || e.key === 'Enter' || e.key === 'c' || e.key === 'C') {
      e.preventDefault(); drawConceptsTarot(); return;
    }
    return;
  }
  // 教學疊層排在 cs-modal 之前：它是從 cs-modal 裡開的、疊在上面（z-index 220 > 200），
  // Esc 要先關疊在最上面的那個，不能讓下面 cs-modal 的判斷先把整個設定彈窗關掉。
  if ($('lora-help-modal').classList.contains('open')) {
    if (e.key === 'Escape') closeLoraHelpModal();
    return;
  }
  if ($('cs-modal').classList.contains('open')) {
    if (e.key === 'Escape') closeCsModal();
    return;
  }
  if ($('lora-modal').classList.contains('open')) {
    if (e.key === 'Escape') closeLoraModal();
    return;
  }
  // 大圖疊在抽卡之上時，鍵盤先歸大圖：Esc 關大圖回到那批牌（而非關掉整個抽卡）
  if ($('modal').classList.contains('open')) {
    if (e.key === 'Escape') { dismissModal(); return; }
    if (MODAL_FROM_TAROT) return;                // 從抽卡開的大圖不左右切（那批牌不在 VISIBLE/GALLERY 順序裡）
    // 大圖是從圖庫還是詞庫格線開的，各自左右切不同的清單——見 openGalleryItem() 設的
    // dataset.gid／openModal() 設的 dataset.rel。之前只接了 modalStep()（只認 VISIBLE），
    // 圖庫開的大圖完全沒有對應的清單可切，方向鍵沒有反應，使用者回報過。
    const inner = $('modal-inner');
    const isGallery = !!(inner && inner.dataset.gid);
    if (e.key === 'ArrowLeft') (isGallery ? galleryModalStep(-1) : modalStep(-1));
    else if (e.key === 'ArrowRight') (isGallery ? galleryModalStep(1) : modalStep(1));
    return;
  }
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
    if (e.key === 'r' || e.key === 'R' || e.key === 'Enter') {   // R 重抽（生圖模式抽新的一批來生；一律抽全庫）
      e.preventDefault(); (MODE === 'gen' ? drawGenTarot : drawTarot)(); return;
    }
    if ((e.key === 'e' || e.key === 'E') && (MODE === 'browse' || MODE === 'gen')) {   // E 重抽本分類
      e.preventDefault(); drawCategoryDispatch(); return;
    }
    return;
  }
  // 全域：未開大圖/抽卡浮層、焦點不在輸入框時，R 抽全庫（依目前模式）、E 只在瀏覽/生圖抽本分類
  if ((e.key === 'r' || e.key === 'R') && !isTyping()) { e.preventDefault(); drawDispatch(); return; }
  if ((e.key === 'e' || e.key === 'E') && !isTyping() && (MODE === 'browse' || MODE === 'gen')) {
    e.preventDefault(); drawCategoryDispatch(); return;
  }
  // C：Concepts 抽卡，跟模式無關（不像 R/E 限定瀏覽/生圖）。走到這裡代表沒有任何大圖/
  // 抽卡浮層／LoRA 大面板開著（前面幾個分支都會提早 return），所以不用再另外判斷。
  // 原本另有一個 X 鍵（分類縮小範圍版）——角色/情境的判斷邏輯改成直接看 LoRA1/LoRA2
  // 固定放的 LoRA／範圍晶片之後，C／X 的差異已經不存在，合併成一顆。
  if ((e.key === 'c' || e.key === 'C') && !isTyping()) {
    e.preventDefault();
    fetchGenLoras().then(() => { updateConceptsLockLabel(); drawConceptsTarot(); });
    return;
  }
  // ?：開快捷鍵一覽。用 e.key 而不是判斷 Shift+/，跨鍵盤配置（含中文輸入法英數模式）
  // 都拿得到同一個字元，不用另外處理 shiftKey。
  if (e.key === '?' && !isTyping()) { e.preventDefault(); openShortcuts(); }
});
function isTyping() {
  const el = document.activeElement;
  return !!el && (/^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable);
}

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

// pool/label 未傳＝原本行為（全庫抽卡，R 鍵）；傳了就是分類抽卡（E 鍵／標題旁按鈕），
// label 會併進塔羅標題與空池提示，讓使用者看得出這批是從哪裡抽的。
function drawTarot(pool, label) {
  pool = pool || ALL.filter(x => x.has_image);            // 只抽有 webp（旁邊有圖）的詞庫
  if (!pool.length) { alert(label ? `「${label}」沒有已生成預覽圖的詞庫可抽` : '目前沒有任何已生成預覽圖的詞庫可抽'); return; }
  const want = isMobile() ? 1 : 8;                        // 手機一次一張，桌面 8 張（4+4）
  const picks = sampleN(pool, Math.min(want, pool.length));
  const n = picks.length;
  const title = document.querySelector('.tarot-title');
  if (title) title.textContent = label ? `✦ ${label}　抽選${CN_NUM[n] || n}張 ✦` : `✦ 抽選${CN_NUM[n] || n}張 ✦`;
  const wrap = $('tarot-cards');
  wrap.classList.remove('ttag');                          // 瀏覽抽卡：清掉打標抽卡的 5×3 排版
  $('tarot-stage').classList.remove('ttag-stage');
  $('tarot-cancel-gen').hidden = true;   // 瀏覽抽卡不是生圖，沒有「取消生圖」這回事
  $('tarot-hint').textContent = label
    ? '點任一張看大圖與提示詞；E 重抽本分類、R 改抽全庫、Esc 關閉'
    : '點任一張看大圖與提示詞；R 重抽一批、Esc 關閉';
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
    card.addEventListener('click', () => { MODAL_FROM_TAROT = true; openModal(it.rel); });   // 大圖疊上層，關掉回到這批牌
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
  if (LORA_TAROT) { LORA_TAROT = false; document.body.classList.remove('lora-tarot-open'); }
  if (CONCEPTS_TAROT) { CONCEPTS_TAROT = false; document.body.classList.remove('concepts-tarot-open'); }
}

// ── LoRA 大面板「隨機瀏覽」：沿用詞庫抽卡同一套塔羅發牌/翻牌，改抽 LoRA。跟瀏覽
// 抽卡共用同一個 #tarot 覆蓋層與卡片動畫邏輯，只是牌面內容、點擊行為（選中而非
// 開大圖）不同。LORA_TAROT 旗標讓 R/Esc 鍵盤處理與 closeTarot() 知道現在是這個
// 情境（大面板本身保持開著、疊在它上面，見 body.lora-tarot-open 的 z-index 覆寫）。
let LORA_TAROT = false;
// Concepts 抽卡疊層開著時的旗標——道理跟 LORA_TAROT 一樣：R 鍵重抽、closeTarot()
// 收尾、z-index 拉高（body.concepts-tarot-open，見 darkroom.css）都要認得現在是這個
// 情境，不然會被 MODE 判斷出來的一般抽卡邏輯誤觸（見 drawDispatch() 與 keydown 分支）。
let CONCEPTS_TAROT = false;
// pool/label 可選（沿用 drawTarot/drawGenTarot 那套：不傳＝原本行為，全庫隨機）。
// E 鍵重抽本分類靠 drawLoraCategoryDispatch() 帶 pool/label 進來。
function drawLoraTarot(pool, label) {
  pool = pool || GEN_LORAS || [];
  if (!pool.length) { toast(label ? `「${label}」底下沒有 LoRA` : 'LoRA 清單還沒載入或是空的'); return; }
  LORA_TAROT = true;
  document.body.classList.add('lora-tarot-open');
  const want = isMobile() ? 1 : 8;
  const picks = sampleN(pool, Math.min(want, pool.length));
  const n = picks.length;
  const title = document.querySelector('.tarot-title');
  if (title) title.textContent = label ? `✦ ${label} 隨機 ${CN_NUM[n] || n} 個 LoRA ✦` : `✦ 隨機瀏覽 ${CN_NUM[n] || n} 個 LoRA ✦`;
  const wrap = $('tarot-cards');
  wrap.classList.remove('ttag');
  $('tarot-stage').classList.remove('ttag-stage');
  $('tarot-cancel-gen').hidden = true;   // 隨機瀏覽 LoRA 不是生圖
  $('tarot-hint').textContent = '點任一張直接選中並返回；R 重抽全庫、E 重抽本分類、Esc 關閉';
  wrap.innerHTML = '';
  picks.forEach((l, i) => {
    const card = document.createElement('div');
    card.className = 'tarot-card';
    card.style.animationDelay = REDUCE ? '0ms' : (i * 48) + 'ms';
    const face = l.preview
      ? (isLoraPreviewVideo(l)
          ? `<video muted loop autoplay playsinline src="${loraPreviewUrl(l)}"></video>`
          : `<img decoding="async" src="${loraPreviewUrl(l)}" alt="" onload="this.classList.add('ld');this.closest('.tarot-front').classList.remove('loading')" onerror="this.closest('.tarot-front').classList.remove('loading')">`)
      : `<div class="tarot-noimg">${ICON_EMPTY}<span>尚無預覽</span></div>`;
    card.innerHTML =
      `<div class="tarot-inner">
         <div class="tarot-back"><span class="tarot-emblem">✦</span></div>
         <div class="tarot-front${l.preview ? ' loading' : ''}">${face}<div class="tarot-name"></div><div class="tarot-folder"></div><div class="tarot-glare"></div></div>
       </div>`;
    card.querySelector('.tarot-name').textContent = l.title || l.name;
    card.querySelector('.tarot-folder').textContent = l.folder || '(根目錄)';
    card.addEventListener('click', () => { selectGenLora(l); closeTarot(); });
    if (!REDUCE) {
      card.addEventListener('mousemove', e => tiltCard(card, e));
      card.addEventListener('mouseleave', () => { card.style.transform = ''; });
    }
    wrap.appendChild(card);
  });
  $('tarot').classList.add('open');
  const cards = [...wrap.children];
  if (REDUCE) { cards.forEach(c => c.classList.add('revealed')); return; }
  const dealDone = n * 48 + 220;
  cards.forEach((c, i) => {
    const media = c.querySelector('.tarot-front img, .tarot-front video');
    if (media && (media.tagName === 'VIDEO' || (media.complete && media.naturalWidth))) c.querySelector('.tarot-front').classList.remove('loading');
    setTimeout(() => c.classList.add('revealed'), dealDone + i * 80);
  });
}

// LoRA 隨機瀏覽的「E 重抽本分類」：跟左欄篩選晶片（renderLmCats/renderLmSubcats）共用
// 同一套 curScope() 狀態，池子跟清單畫面看到的完全一致——不是另外
// 發明一套篩選邏輯，使用者選好分類/子資料夾再按 E，抽到的就是清單裡當下看得到的那些。
function loraCatPool() {
  return (GEN_LORAS || []).filter(l =>
    (curScope().cat === 'all' || l.category === curScope().cat) &&
    (!curScope().subfolder || l.folder === curScope().subfolder));
}
function loraCatLabel() {
  if (curScope().subfolder) return curScope().subfolder === curScope().cat ? curScope().cat : curScope().subfolder;
  return curScope().cat === 'all' ? null : curScope().cat;
}

// 這格如果已經放了固定 LoRA，範圍晶片對 Concepts 判斷就沒意義了（固定 LoRA 的優先權
// 比範圍晶片高，見 drawConceptsTarot() 的判斷順序）——改顯示「目前放的是哪顆 LoRA」，
// hover 用既有的 showSingleLoraPreviewTip 預覽（跟大面板左欄清單/分頁卡 hover 同一套，
// 不用另外做一套預覽邏輯）。
function renderCsSlotFixedState(slot) {
  const fixedBox = document.querySelector(`.cs-scope-locked[data-slot="${slot}"]`);
  const catBox = document.querySelector(`.cs-scope-cats[data-slot="${slot}"]`);
  const subBox = document.querySelector(`.cs-scope-subs[data-slot="${slot}"]`);
  if (!fixedBox || !catBox || !subBox) return;
  const lora = GEN_LORA_SLOTS[slot].lora;
  fixedBox.hidden = !lora;
  catBox.hidden = !!lora;
  subBox.hidden = !!lora;
  if (!lora) return;
  fixedBox.innerHTML = '';
  const card = document.createElement('div'); card.className = 'cs-locked-card';
  if (lora.preview) {
    card.appendChild(makeLoraPreviewEl(lora));
    card.addEventListener('mouseenter', () => showSingleLoraPreviewTip(card, lora));
    card.addEventListener('mouseleave', hideLoraPreviewTip);
  } else {
    const ph = document.createElement('span'); ph.className = 'ph'; card.appendChild(ph);
  }
  const label = document.createElement('span'); label.className = 'cs-locked-name';
  label.textContent = lora.title || lora.name;
  card.appendChild(label);
  fixedBox.appendChild(card);
}
// 這格的「參與判斷／跳過」切換——跳過的格子，不管放了什麼固定 LoRA、範圍晶片設什麼，
// drawConceptsTarot() 判斷角色/情境時都當它不存在（見 findLockedSlot()/findScopePool()
// 的 GEN_LORA_SLOT_SKIP 過濾）。切換按鈕跟顯示區塊都在「一般」分頁這裡集中管理——
// 這是使用者明確要求的：「一般」分頁要是全域控制面板，不要拆到 LoRA 大面板分頁卡上。
function renderCsSkipToggle(slot) {
  const btn = document.querySelector(`.cs-skip-toggle[data-slot="${slot}"]`);
  const block = document.querySelector(`.cs-scope-block[data-slot="${slot}"]`);
  if (!btn) return;
  const skip = GEN_LORA_SLOT_SKIP[slot];
  btn.textContent = skip ? '已跳過' : '參與判斷';
  btn.classList.toggle('skipped', skip);
  btn.setAttribute('aria-pressed', skip ? 'true' : 'false');
  if (block) block.classList.toggle('skipped', skip);
}
// 設定 modal「一般」分頁的 LoRA1/LoRA2 範圍晶片——跟大面板左欄晶片（renderLmCats/
// renderLmSubcats）是同一份 GEN_LORA_SLOT_SCOPE 資料，視覺邏輯也完全比照(分類晶片＋
// 子資料夾晶片，選了分類才出現、只有一種子資料夾值時不顯示），差別只在這裡固定畫兩份
// （slot 0/1 都要看得到），不是只畫「目前作用格」那一份；晶片點擊直接改
// GEN_LORA_SLOT_SCOPE[slot]，不透過 curScope()（curScope() 只會指到作用格）。
function renderCsScopeChips(slot) {
  renderCsSkipToggle(slot);
  renderCsSlotFixedState(slot);
  if (GEN_LORA_SLOTS[slot].lora) return;   // 有固定 LoRA，晶片不用建內容
  const box = document.querySelector(`.cs-scope-cats[data-slot="${slot}"]`); if (!box) return;
  const scope = GEN_LORA_SLOT_SCOPE[slot];
  const items = GEN_LORAS || [];
  const counts = {};
  for (const l of items) counts[l.category] = (counts[l.category] || 0) + 1;
  const cats = Object.keys(counts).sort();
  box.innerHTML = '';
  const mk = (key, label, n) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'lm-cat' + (scope.cat === key ? ' on' : '');
    const lb = document.createElement('span'); lb.textContent = label;
    const nb = document.createElement('span'); nb.className = 'lm-cat-n'; nb.textContent = n;
    b.append(lb, nb);
    b.addEventListener('click', () => {
      scope.cat = key; scope.subfolder = '';
      renderCsScopeChips(slot);
      if (slot === GEN_ACTIVE_SLOT) { renderLmCats(); renderLmSubcats(); renderLmList($('lm-search').value, true); }
    });
    box.appendChild(b);
  };
  mk('all', '全部', items.length);
  cats.forEach(c => mk(c, c, counts[c]));
  renderCsScopeSubChips(slot);
}
function renderCsScopeSubChips(slot) {
  const box = document.querySelector(`.cs-scope-subs[data-slot="${slot}"]`); if (!box) return;
  const scope = GEN_LORA_SLOT_SCOPE[slot];
  box.innerHTML = '';
  if (scope.cat === 'all') return;
  const items = (GEN_LORAS || []).filter(l => l.category === scope.cat);
  const counts = {};
  for (const l of items) counts[l.folder] = (counts[l.folder] || 0) + 1;
  const subfolders = Object.keys(counts).sort();
  if (subfolders.length <= 1) return;
  const mk = (key, label, n) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'lm-subcat' + (scope.subfolder === key ? ' on' : '');
    const lb = document.createElement('span'); lb.textContent = label;
    const nb = document.createElement('span'); nb.className = 'lm-subcat-n'; nb.textContent = n;
    b.append(lb, nb);
    b.addEventListener('click', () => {
      scope.subfolder = key;
      renderCsScopeSubChips(slot);
      if (slot === GEN_ACTIVE_SLOT) { renderLmCats(); renderLmSubcats(); renderLmList($('lm-search').value, true); }
    });
    box.appendChild(b);
  };
  mk('', '全部', items.length);
  subfolders.forEach(f => {
    const label = f === scope.cat ? '(根目錄)' : f.slice(scope.cat.length + 1);
    mk(f, label, counts[f]);
  });
}

function drawLoraCategoryDispatch() { drawLoraTarot(loraCatPool(), loraCatLabel()); }

// 每格自己的分類/子資料夾範圍算出來的抽取池——跟 loraCatPool()（永遠讀目前作用格）不同，
// 這裡要能算「任一格」自己的池，Concepts 判斷角色/情境時才能各自套用各自記住的範圍，
// 不會被目前作用格的範圍蓋掉。findScopePool(cat) 是 Concepts 用的入口：在沒被標記
// 「跳過判斷」的格子裡找一個範圍設成 cat 的，回傳它的抽取池；找不到就回 null（代表這個
// 角色沒有範圍訊號，drawConceptsTarot() 會接著決定要整個跳過還是退回全庫）。
function scopePool(i) {
  const scope = GEN_LORA_SLOT_SCOPE[i];
  return (GEN_LORAS || []).filter(l =>
    (scope.cat === 'all' || l.category === scope.cat) &&
    (!scope.subfolder || l.folder === scope.subfolder));
}
function findScopePool(cat) {
  const i = [0, 1].find(i => !GEN_LORA_SLOT_SKIP[i] && GEN_LORA_SLOT_SCOPE[i].cat === cat);
  return i === undefined ? null : scopePool(i);
}

// Concepts 抽卡的兩個抽選池：Character（角色 LoRA）與固定的 HENTAI/concepts 資料夾
// （情境/動作 LoRA）。
function fullCharacterPool() { return (GEN_LORAS || []).filter(l => l.category === 'Character'); }
function fullConceptsPool() { return (GEN_LORAS || []).filter(l => l.folder === 'HENTAI/concepts'); }

// 「鎖定」機制：不做另一套選單 UI，直接偵測 LoRA1/LoRA2 面板現在有沒有選到符合分類的
// LoRA——有選到就鎖定那顆（用它跟它設定的強度，每張卡都一樣，不重新隨機）。標成「跳過」
// 的格子（GEN_LORA_SLOT_SKIP）完全不參與這個判斷，當它不存在。依 slot0→slot1 順序找
// 第一個符合的，兩格剛好都是同分類時只有先出現的那格算數。
function findLockedSlot(matchFn) { return GEN_LORA_SLOTS.find((s, i) => !GEN_LORA_SLOT_SKIP[i] && s.lora && matchFn(s.lora)); }
function lockedCharacterSlot() { return findLockedSlot(l => l.category === 'Character'); }
function lockedConceptSlot() { return findLockedSlot(l => l.folder === 'HENTAI/concepts'); }
// Concepts 按鈕旁的鎖定狀態文字，隨 LoRA1/LoRA2 選擇即時更新（見 renderGenCurrent）。
function conceptsLockLabel() {
  const c = lockedCharacterSlot(), k = lockedConceptSlot();
  if (!c && !k) return '隨機 × 隨機';
  const cText = c ? `🔒${c.lora.title || c.lora.name}` : '隨機';
  const kText = k ? `🔒${k.lora.title || k.lora.name}` : '隨機';
  return `${cText} × ${kText}`;
}

/* ── 抽卡打標（打標模式）：抽 15 張「有圖且尚未打標」的，逐張鍵盤/點按標稀有度，
   即時寫側檔。與瀏覽抽卡共用同一個 #tarot 覆蓋層，靠 .ttag class 切排版與卡片內容。 */
const RARITY_KEYS = ['common', 'rare', 'special', 'legendary'];
const DRAW_N = 10;   // 打標抽卡一次 10 張（5 欄 × 2 列）
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
  $('tarot-cancel-gen').hidden = true;   // 抽卡打標不是生圖
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
           <div class="tarot-folder"></div>
           <div class="ttag-rar">
             <button data-r="common">普通</button><button data-r="rare">稀有</button>
             <button data-r="special">特別</button><button data-r="legendary">傳奇</button>
           </div>
         </div>
       </div>`;
    card.querySelector('.tarot-name').textContent = it.display_name || it.name;
    card.querySelector('.tarot-folder').textContent = it.folder || '(根目錄)';
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

// LORA_TAROT/CONCEPTS_TAROT 要排最前面：#tarot-redraw 鈕（「再抽一次 (R)」）在各種抽卡
// 情境共用同一顆，原本沒檢查這兩個旗標，LoRA 隨機瀏覽／Concepts 抽卡疊層開著時點下去
// 會誤觸目前 MODE 對應的一般抽卡（詞庫/生圖），不是重抽當下這種——鍵盤 R 走另一條
// keydown 分支，同樣要各自補上判斷（見下方 window.addEventListener('keydown', …)）。
const drawDispatch = () => (LORA_TAROT ? drawLoraTarot() : CONCEPTS_TAROT ? drawConceptsTarot() : MODE === 'gen' ? drawGenTarot() : MODE === 'tag' ? drawTagTarot() : drawTarot());
$('draw-cards').onclick = drawDispatch;
$('tarot-redraw').onclick = drawDispatch;
$('tarot-close').onclick = closeTarot;
// 取消「目前這批」抽卡生圖：送出這批的 gid（不是整個分頁），按下才自動關閉疊層——
// 使用者已經明確要放棄看這批結果，留著空殼疊層沒有意義（跟其他抽卡類型「取消」點
// 選卡片才關閉」不同，這裡是主動放棄整批，語意上更接近直接關閉）。
$('tarot-cancel-gen').onclick = () => {
  const ids = CUR_GEN_TAROT_IDS;
  if (!ids.length) { closeTarot(); return; }
  fetch('/api/gen-cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }) }).catch(() => {});
  closeTarot();
  toast(`已取消這批 ${ids.length} 張生圖`);
};

// E 鍵／標題旁「✦」鈕：只在瀏覽／生圖模式，抽卡池換成「目前選中的分類」（跨資料夾搜尋時
// 換成搜尋結果範圍）而不是整個詞庫。重用 baseList()（本來就是「只套資料夾/搜尋」，不含
// 缺圖/已有、稀有度篩選——跟 R 的全庫抽卡一樣無視這兩層篩選，行為才會一致）。
function catPool(requireImage) {
  const list = baseList();
  return requireImage ? list.filter(x => x.has_image) : list;
}
function categoryLabel() {
  return SEARCH ? `搜尋「${SEARCH}」` : (CUR_FOLDER || '(根目錄)');
}
function drawCategoryDispatch() {
  const label = categoryLabel();
  if (MODE === 'gen') drawGenTarot(catPool(false), label);
  else drawTarot(catPool(true), label);
}
$('draw-cat').onclick = drawCategoryDispatch;
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
  updateGenbar();
}
function clearSel() {
  SEL.clear();
  document.querySelectorAll('#grid .card.selected').forEach(c => c.classList.remove('selected'));
  updateTagbar();
  updateGenbar();
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

$('sel-all').onclick = () => { VISIBLE.forEach(x => SEL.add(x.rel)); withTransition(render); updateTagbar(); updateGenbar(); };
$('sel-clear').onclick = () => { clearSel(); withTransition(render); };
document.querySelectorAll('.rar-pick').forEach(b =>
  b.addEventListener('click', () => { if (!b.disabled) tagSelected(b.dataset.r); }));

/* ── 生圖模式：多選詞庫 + 選一個 LoRA（大面板，完整顯示每段 trainedWords）+ 強度 → 生圖。 ──
   面板由 topbar「🧩」（只在生圖模式顯示）或 genbar「🧩 選 LoRA」開啟，同一個
   #lora-modal；左欄資料夾分類/搜尋/翻頁/預覽選 LoRA，右欄完整攤開每段 trainedWords
   （勾選要用哪幾段）＋強度，選擇即時生效、關閉只是收起檢視，不需要另外「確定」。 */
let GEN_LORAS = null;                 // /api/loras 的 items（快取）
// 雙 LoRA 疊加：兩個固定格子（不是不限層數的清單），各自獨立強度／觸發詞勾選。
// GEN_ACTIVE_SLOT 記錄右欄「編輯中」是哪一格——左欄清單、隨機瀏覽塔羅點卡都塞進這一格
// （見 selectGenLora）。curSlot()/otherSlot() 是讀寫時的簡寫，避免到處寫
// GEN_LORA_SLOTS[GEN_ACTIVE_SLOT]。
const GEN_LORA_SLOTS = [
  { lora: null, strength: 0.8, twPicks: new Set() },
  { lora: null, strength: 0.8, twPicks: new Set() },
];
let GEN_ACTIVE_SLOT = 0;
function curSlot() { return GEN_LORA_SLOTS[GEN_ACTIVE_SLOT]; }
function otherSlotIndex() { return GEN_ACTIVE_SLOT === 0 ? 1 : 0; }
function setActiveSlot(i) {
  GEN_ACTIVE_SLOT = i;
  renderLmCats();
  renderLmSubcats();
}
let GEN_LORA_PAGE = 0;                // LoRA 清單目前頁（搜尋變動時歸零，見 renderLmList）
// Concepts 抽卡設定（強度×2／張數／「同時抽詞庫模板」開關，見 _runConceptsDraw）。
// 宣告放這裡、不是靠近 drawConceptsTarot 本身，是因為設定彈窗控制項的初始值要在腳本
// 載入當下就同步設定（見 concepts-settings 事件綁定），寫在後面會撞 TDZ（CLAUDE.md
// 記過的老坑）。這組設定是 Concepts 抽卡唯一的強度／張數來源，不讀 LoRA1/2 面板自己的
// 強度滑桿——那是給手動選 LoRA 生圖用的，語意不一樣（見使用者原話「以這裡為主」）。
function _readNum(key, fallback) {
  const v = parseFloat(localStorage.getItem(key));
  return Number.isFinite(v) ? v : fallback;
}
let CONCEPTS_CHAR_STRENGTH = _readNum('yz-concepts-char-str', 0.8);
let CONCEPTS_KEY_STRENGTH = _readNum('yz-concepts-key-str', 0.8);
// 張數沒存過時才用裝置判斷給預設值（手機小螢幕塔羅牌面擠不下太多張）；一旦使用者自己
// 調過就記住那個數字，之後不再依裝置改變——使用者的選擇優先於自動判斷的預設。
let CONCEPTS_COUNT = _readNum('yz-concepts-count', isMobile() ? 1 : 8);
let CONCEPTS_WITH_TEMPLATE = localStorage.getItem('yz-concepts-tpl') === '1';
// 模板要不要鎖在左邊詞庫資料夾列表目前選中的那個（CUR_FOLDER）——不勾就跟原本一樣從
// 全部詞庫（ALL）抽。刻意沿用 CUR_FOLDER 而不是另做一個詞庫分類選單：使用者已經在用
// 左邊列表瀏覽/選資料夾了，不用為 Concepts 抽卡另外重複一套選擇 UI。
let CONCEPTS_TPL_CUR_FOLDER = localStorage.getItem('yz-concepts-tpl-cur-folder') === '1';
// 每格是否要參與 Concepts 抽卡的角色/情境判斷——標成「跳過」的格子，不管放了什麼固定
// LoRA、範圍晶片設什麼，drawConceptsTarot() 判斷時都當它不存在（見 findLockedSlot()/
// findScopePool()）。**預設是跳過（true）**：使用者要明確切成「參與判斷」，這格的
// LoRA/範圍才會影響 Concepts——不然單純想用 LoRA1/2 手動生圖，會不小心也悄悄改變
// Concepts 抽卡的行為，使用者反映過這個預設方向。跟 GEN_LORA_SLOTS 一樣 session-only，
// 不存 localStorage：這是「這次生圖想怎麼搭」的暫時決定，不是需要跨分頁記住的偏好。
// 切換入口集中在設定彈窗「一般」分頁（renderCsSkipToggle()），不是 LoRA 大面板——
// 使用者明確要求「一般」分頁要是全域控制面板，不要拆到兩個地方。
const GEN_LORA_SLOT_SKIP = [true, true];
function setConceptsCharStrength(v) { CONCEPTS_CHAR_STRENGTH = v; localStorage.setItem('yz-concepts-char-str', v); }
function setConceptsKeyStrength(v) { CONCEPTS_KEY_STRENGTH = v; localStorage.setItem('yz-concepts-key-str', v); }
function setConceptsCount(v) { CONCEPTS_COUNT = v; localStorage.setItem('yz-concepts-count', v); }
function setConceptsWithTemplate(v) {
  CONCEPTS_WITH_TEMPLATE = v;
  localStorage.setItem('yz-concepts-tpl', v ? '1' : '0');
}
function setConceptsTplCurFolder(v) {
  CONCEPTS_TPL_CUR_FOLDER = v;
  localStorage.setItem('yz-concepts-tpl-cur-folder', v ? '1' : '0');
}
// 鎖定一個固定的詞庫模板（見 Concepts 設定彈窗的搜尋清單）。跟 LoRA1/2 的鎖定同一種
// 設計：不存 localStorage（session-only，跟 GEN_LORA_SLOTS 一致——詞庫內容可能隨掃描
// 變動，跨分頁/重整保留一個可能已經不存在的 rel 沒有意義）。鎖定了就自動視同要抽模板，
// 不需要另外勾「同時抽詞庫模板」；兩個控制項見 _runConceptsDraw 怎麼合併判斷。
let CONCEPTS_LOCKED_TEMPLATE = null;
function setConceptsLockedTemplate(item) {
  CONCEPTS_LOCKED_TEMPLATE = item;
  updateConceptsTemplateLockUI();
}
// 這個分頁的識別碼：生圖時帶給後端，讓「刷新/關閉這個分頁」只取消自己送的生圖，別的分頁不受影響。
const GEN_CLIENT = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());

async function fetchGenLoras() {
  if (GEN_LORAS) return GEN_LORAS;
  try { GEN_LORAS = (await fetch('/api/loras').then(r => r.json())).items || []; }
  catch (e) { GEN_LORAS = []; toast('LoRA 清單載入失敗：' + e.message); }
  return GEN_LORAS;
}

function updateGenbar() {
  const c = $('gen-count'); if (!c) return;
  const n = SEL.size;
  c.textContent = `已選 ${n}`; c.classList.toggle('has', n > 0);
  const run = $('gen-run'); if (run) run.disabled = n === 0;
}

const GEN_LORA_PAGE_SIZE = 80;          // 每頁列數（總數上百，全渲染會卡；改翻頁而非截斷丟資料）
const GEN_LORA_SLOT_SCOPE = [{ cat: 'all', subfolder: '' }, { cat: 'all', subfolder: '' }];  // 每格各自的分類/子資料夾抽取範圍，見 curScope()
function curScope() { return GEN_LORA_SLOT_SCOPE[GEN_ACTIVE_SLOT]; }   // 目前作用格的範圍——左欄晶片、loraCatPool()、K 鍵都讀寫這個
function loraPreviewUrl(l) { return `/api/lora-preview?folder=${encodeURIComponent(l.folder)}&file=${encodeURIComponent(l.preview)}`; }

/* ---------------- 觸發詞卡 hover 翻譯（Google 翻譯免費端點，不用 API key）----------------
   用的是 translate.googleapis.com 的 gtx client（瀏覽器擴充套件常用的免金鑰端點，非官方
   Cloud Translation API，回應是巢狀 JSON array，Access-Control-Allow-Origin: * 所以瀏覽器
   直接 fetch 可用）。不保證永遠穩定（Google 隨時可能擋掉/改格式），但不用管使用者有沒有設
   config.js，開箱即用。 */
const TW_CACHE_KEY = 'yz-tw-translate';
const TW_CACHE_MAX = 3000;   // 上限，避免 localStorage 無限長大（觸發詞短語重複率很高，這個上限很夠用）
let TW_CACHE = null;
function loadTwCache() {
  if (TW_CACHE) return TW_CACHE;
  try { TW_CACHE = JSON.parse(localStorage.getItem(TW_CACHE_KEY) || '{}'); }
  catch { TW_CACHE = {}; }
  return TW_CACHE;
}
function saveTwCache() {
  const keys = Object.keys(TW_CACHE);
  if (keys.length > TW_CACHE_MAX) {   // 物件屬性插入順序＝寫入順序，砍最舊的一批
    for (const k of keys.slice(0, keys.length - TW_CACHE_MAX)) delete TW_CACHE[k];
  }
  try { localStorage.setItem(TW_CACHE_KEY, JSON.stringify(TW_CACHE)); } catch {}
}
const TW_PENDING = new Map();   // text -> 正在跑的 Promise，同一段文字重覆 hover 不重複打 API
// 回傳中文翻譯（有快取先吃快取）。
function translateTriggerWord(text) {
  const cache = loadTwCache();
  if (Object.prototype.hasOwnProperty.call(cache, text)) return Promise.resolve(cache[text]);
  if (TW_PENDING.has(text)) return TW_PENDING.get(text);
  const p = (async () => {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-TW&dt=t&q='
      + encodeURIComponent(text);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`翻譯服務 ${res.status}`);
    const data = await res.json();
    // 回應格式：[[[譯文, 原文, ...], [下一段, ...], ...], ...]——長句會被切成多段，全部接起來。
    const zh = (data[0] || []).map(seg => seg[0]).join('').trim();
    cache[text] = zh;
    saveTwCache();
    return zh;
  })();
  TW_PENDING.set(text, p);
  p.finally(() => TW_PENDING.delete(text));
  return p;
}

// 共用的浮動翻譯提示框：貼齊 hover 的觸發詞卡下方，跟著捲動就重新定位。
let TW_TIP_EL = null, TW_TIP_FOR = null;
function ensureTwTip() {
  if (TW_TIP_EL) return TW_TIP_EL;
  TW_TIP_EL = document.createElement('div');
  TW_TIP_EL.className = 'tw-tip';
  document.body.appendChild(TW_TIP_EL);
  return TW_TIP_EL;
}
function positionTwTip(anchor) {
  const tip = ensureTwTip();
  const r = anchor.getBoundingClientRect();
  tip.style.left = r.left + 'px';
  tip.style.top = (r.bottom + 6) + 'px';
  tip.style.maxWidth = Math.max(180, r.width) + 'px';
}
function showTwTip(anchor, text) {
  TW_TIP_FOR = anchor;
  const tip = ensureTwTip();
  positionTwTip(anchor);
  tip.textContent = '翻譯中…';
  tip.classList.add('show');
  translateTriggerWord(text).then(zh => {
    if (TW_TIP_FOR !== anchor) return;   // hover 已經換到別段，不要蓋掉
    tip.textContent = zh || '(空)';
  }).catch(e => {
    if (TW_TIP_FOR !== anchor) return;
    tip.textContent = `翻譯失敗：${e.message}`;
  });
}
function hideTwTip(anchor) {
  if (TW_TIP_FOR !== anchor) return;
  TW_TIP_FOR = null;
  if (TW_TIP_EL) TW_TIP_EL.classList.remove('show');
}
// 靜態文字版：跟 showTwTip 共用同一個 .tw-tip 元素/定位/顯隱邏輯，差別只是不用打
// 翻譯 API、文字立即顯示（給稀有度分布條 hover 用，見 buildRarityBar）。
function showStatTip(anchor, text) {
  TW_TIP_FOR = anchor;
  const tip = ensureTwTip();
  positionTwTip(anchor);
  tip.textContent = text;
  tip.classList.add('show');
}

// 有些 LoRA 的預覽檔是短片（.mp4/.webm）而不是圖片，要用 <video> 而不是 <img> 渲染。
function isLoraPreviewVideo(l) { return /\.(mp4|webm)$/i.test(l.preview || ''); }

// 建一個 LoRA 預覽用的 <img> 或 <video>（依副檔名判斷），呼叫端自己 append 進要放的容器。
function makeLoraPreviewEl(l) {
  if (isLoraPreviewVideo(l)) {
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    v.src = loraPreviewUrl(l);
    return v;
  }
  const im = document.createElement('img'); im.loading = 'lazy';
  im.src = loraPreviewUrl(l);
  return im;
}

// 大面板左欄最上面：依資料夾分類的篩選晶片（全部＋各資料夾＋各自張數），跟搜尋框疊加
// 篩選。點了重繪清單並回第一頁。
function renderLmCats() {
  const box = $('lm-cats'); if (!box) return;
  const items = GEN_LORAS || [];
  const counts = {};
  // 用 category（頂層四分類）分組，不是 folder——folder 現在可能是子資料夾的完整路徑
  // （如 "Character/other"），照它分組會讓晶片暴增成一個子資料夾一顆,不是原本的四類。
  for (const l of items) counts[l.category] = (counts[l.category] || 0) + 1;
  const folders = Object.keys(counts).sort();
  box.innerHTML = '';
  const mk = (key, label, n) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'lm-cat' + (curScope().cat === key ? ' on' : '');
    const lb = document.createElement('span'); lb.textContent = label;
    const nb = document.createElement('span'); nb.className = 'lm-cat-n'; nb.textContent = n;
    b.append(lb, nb);
    b.addEventListener('click', () => {
      curScope().cat = key;
      curScope().subfolder = '';   // 換頂層分類，子資料夾篩選跟著清掉——上次選的子資料夾對新分類沒意義
      renderLmCats(); renderLmSubcats(); renderLmList($('lm-search').value, true);
      renderCsScopeChips(GEN_ACTIVE_SLOT);   // 設定 modal 的晶片要跟著大面板左欄同步
    });
    box.appendChild(b);
  };
  mk('all', '全部', items.length);
  folders.forEach(f => mk(f, f, counts[f]));
}

// 子資料夾晶片：只在選了非「全部」的頂層分類、且該分類底下確實有多個 folder 值時才顯示
// （folder 是完整路徑，如 "Character/other"；folder === category 代表沒放進子資料夾）。
// 只有一種 folder 值時代表這個分類根本沒細分，顯示晶片沒意義、直接清空容器。
function renderLmSubcats() {
  const box = $('lm-subcats'); if (!box) return;
  box.innerHTML = '';
  if (curScope().cat === 'all') return;
  const items = (GEN_LORAS || []).filter(l => l.category === curScope().cat);
  const counts = {};
  for (const l of items) counts[l.folder] = (counts[l.folder] || 0) + 1;
  const subfolders = Object.keys(counts).sort();
  if (subfolders.length <= 1) return;   // 沒有子資料夾可挑，不用出現一顆「全部」孤零零杵著
  const mk = (key, label, n) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'lm-subcat' + (curScope().subfolder === key ? ' on' : '');
    const lb = document.createElement('span'); lb.textContent = label;
    const nb = document.createElement('span'); nb.className = 'lm-subcat-n'; nb.textContent = n;
    b.append(lb, nb);
    b.addEventListener('click', () => {
      curScope().subfolder = key;
      renderLmSubcats(); renderLmList($('lm-search').value, true);
      renderCsScopeChips(GEN_ACTIVE_SLOT);   // 設定 modal 的晶片要跟著大面板左欄同步
    });
    box.appendChild(b);
  };
  mk('', '全部', items.length);
  subfolders.forEach(f => {
    // f === curScope().cat：直接放在分類頂層、沒再分子資料夾的那些；其餘去掉「分類/」前綴只顯示子資料夾名
    const label = f === curScope().cat ? '(根目錄)' : f.slice(curScope().cat.length + 1);
    mk(f, label, counts[f]);
  });
}

// 大面板左欄：分類＋搜尋＋翻頁的 LoRA 清單（跟原本底部彈出小選單同一套渲染邏輯，只是容器
// 換成大面板、可視高度更高）。縮圖直接放大顯示，不用 hover 才跳一張大圖——少一層互動。
function renderLmList(filter, resetPage) {
  const box = $('lm-list'); if (!box) return;
  if (resetPage) GEN_LORA_PAGE = 0;
  const q = (filter || '').toLowerCase().trim();
  // 名稱／標題有命中的排前面，只靠 trainedWords 命中的排後面——不然「查名稱完全不相關
  // 的東西」也會混進來，使用者以為搜尋壞了。無搜尋字串時維持原本依資料夾排序。
  let items = (GEN_LORAS || []).filter(l =>
    (curScope().cat === 'all' || l.category === curScope().cat) &&
    (!curScope().subfolder || l.folder === curScope().subfolder));
  if (q) {
    items = items
      .map(l => {
        const nameHit = l.name.toLowerCase().includes(q) || (l.title || '').toLowerCase().includes(q);
        const twHit = (l.trainedWords || []).join(' ').toLowerCase().includes(q);
        return { l, tier: nameHit ? 0 : (twHit ? 1 : -1) };
      })
      .filter(x => x.tier >= 0)
      .sort((a, b) => a.tier - b.tier)
      .map(x => x.l);
  }
  box.innerHTML = '';
  if (!items.length) { box.innerHTML = '<div class="lora-empty">找不到 LoRA</div>'; return; }
  const pages = Math.ceil(items.length / GEN_LORA_PAGE_SIZE);
  if (GEN_LORA_PAGE >= pages) GEN_LORA_PAGE = pages - 1;
  if (GEN_LORA_PAGE < 0) GEN_LORA_PAGE = 0;
  const page = GEN_LORA_PAGE;
  const shown = items.slice(page * GEN_LORA_PAGE_SIZE, page * GEN_LORA_PAGE_SIZE + GEN_LORA_PAGE_SIZE);
  // 搜尋時清單已依相關度排序、不再依資料夾連續分組，資料夾標頭意義不大，直接不顯示。
  let curFolder = '';
  for (const l of shown) {
    if (!q && l.folder !== curFolder) {
      curFolder = l.folder;
      const h = document.createElement('div'); h.className = 'lora-cat-head'; h.textContent = curFolder;
      box.appendChild(h);
    }
    const slotIdx = GEN_LORA_SLOTS.findIndex(s => s.lora && s.lora.folder === l.folder && s.lora.file === l.file);
    const row = document.createElement('button');
    row.type = 'button';
    // .on 只標「編輯中那格選的是不是這項」；不管哪格選中都額外掛數字徽章（①/②），
    // 不然使用者選 LoRA 2 時完全看不出這項其實已經是 LoRA 1、點下去會觸發交換。
    row.className = 'lora-row' + (slotIdx === GEN_ACTIVE_SLOT ? ' on' : '');
    if (l.preview) {
      row.appendChild(makeLoraPreviewEl(l));
    } else { const ph = document.createElement('span'); ph.className = 'ph'; row.appendChild(ph); }
    const rn = document.createElement('span'); rn.className = 'rn';
    if (slotIdx !== -1) {
      const badge = document.createElement('span'); badge.className = 'lora-slot-badge';
      badge.textContent = slotIdx === 0 ? '①' : '②';
      rn.appendChild(badge);
    }
    const rt = document.createElement('span'); rt.className = 'rt'; rt.textContent = l.title || l.name;
    const rf = document.createElement('span'); rf.className = 'rf'; rf.textContent = l.folder;
    rn.append(rt, rf); row.appendChild(rn);
    row.addEventListener('click', () => { hideLoraPreviewTip(); selectGenLora(l); });
    row.addEventListener('mouseenter', () => showSingleLoraPreviewTip(row, l));
    row.addEventListener('mouseleave', hideLoraPreviewTip);
    box.appendChild(row);
  }
  if (pages > 1) {
    const nav = document.createElement('div'); nav.className = 'lora-pager';
    const prev = document.createElement('button'); prev.type = 'button'; prev.className = 'lora-page-btn';
    prev.textContent = '‹ 上一頁'; prev.disabled = page === 0;
    const info = document.createElement('span'); info.className = 'lora-page-info';
    info.textContent = `第 ${page + 1} / ${pages} 頁 · 共 ${items.length} 個`;
    const next = document.createElement('button'); next.type = 'button'; next.className = 'lora-page-btn';
    next.textContent = '下一頁 ›'; next.disabled = page >= pages - 1;
    prev.addEventListener('click', (e) => { e.stopPropagation(); GEN_LORA_PAGE = page - 1; renderLmList(filter); box.scrollTop = 0; });
    next.addEventListener('click', (e) => { e.stopPropagation(); GEN_LORA_PAGE = page + 1; renderLmList(filter); box.scrollTop = 0; });
    nav.append(prev, info, next);
    box.appendChild(nav);
  }
}

// 點左欄某個 LoRA：選中它、預設勾第一段觸發詞，右欄換成它的完整內容。面板**不關閉**——
// 這是個瀏覽/比較用的大面板，選完通常還要勾段落、調強度，關掉留給使用者自己按 ✕/Esc。
function selectGenLora(l) {
  const otherIdx = otherSlotIndex();
  const other = GEN_LORA_SLOTS[otherIdx];
  // 選到的 LoRA 已經在另一格：直接把兩格內容互換，不是把同一個 LoRA 塞進兩格
  // （那樣等於同一個 LoRA 疊加兩次，沒有意義，使用者也會覺得「怎麼點沒反應」）。
  if (other.lora && other.lora.folder === l.folder && other.lora.file === l.file) {
    const tmp = GEN_LORA_SLOTS[GEN_ACTIVE_SLOT];
    GEN_LORA_SLOTS[GEN_ACTIVE_SLOT] = other;
    GEN_LORA_SLOTS[otherIdx] = tmp;
  } else {
    const tw = l.trainedWords || [];
    const twPicks = new Set();
    if (tw.length) twPicks.add(0);   // 預設選第一組觸發詞
    GEN_LORA_SLOTS[GEN_ACTIVE_SLOT] = { lora: l, strength: curSlot().strength, twPicks };
  }
  renderGenCurrent();
  renderLmCurrent();
  renderLmList($('lm-search').value);   // 只重繪列表刷新選中的高亮，不重置頁碼/搜尋
  renderCsScopeChips(0); renderCsScopeChips(1);   // 設定彈窗鎖定卡片的縮圖/名稱可能因為換選而過時，一併刷新
}

// genbar 摘要鈕：只顯示「目前選的是誰」，實際挑選都在大面板。圖示用 LoRA Manager
// 本尊 logo（跟 topbar 大面板鈕、左欄管理連結同一張圖）而非通用符號。innerHTML 只在第
// 一次呼叫時建立（img 不用每次重繪），之後只更新文字節點，避免每次選 LoRA 都重建 DOM。
const LORA_MGR_LOGO_B64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAA/lJREFUWEeVV0trFEEQ/ubiRRQPInoTDwo+jhpRRAUR4wNFkywBEdw1ia+LBxUVRUHwIir4QPABIngTPHry5i/IWcFHdteYRCKJm5np7ZLu6Z7p6emenexhd7anp+urqq++qgnGv7cIAAIQCIG4lP8AuZz/iCW9xbuTAArUPvO6eJy0lADQxrRhy4oTkgON20bpqgEgMZr5rnDJZRNQb68Sh4pOmEhSV3UK5E35nOthY41InZ03kAIvnOEDkzgSjH9rEoIgB9rNgOpe9Y5AdpZKgfBeeyYcFJQs+/QAk95WFyXbg/HvTWXZJKI23tvrDGbJ3hygPKcMACkJHK6bHDDqzxUkGUmLgC5uKX+zFOQO0xWgDiLgwqX7aH/5AeIhunGEE7V+nGoM9GR7cmzigMmt5JqEDugUON1JJIoIpy89QOvrT+DvHMAXMDh8EGfODaeHV6g8J6kcEdDhzn5FVOuXH6P5ow3MzAJxiKHh/WiMDZUw1dILOzUyBSIC3xIpznRDM1f9igolQv3KU0y0p0CMIZifR+3wLjRGj7sBuIx5dCmJgElgB4kEgMbV55hoT4I4R9DpoHZgJ+pnjmbSKQQs7QHVNdlNQquiBICRay8w0ZoCUQyKGWr7tqHeOKI4ZjDfrkajAnIyL0IuHstJsY9JBIxcfyUBcGIgYhjq34nG8D43scxeKiIqKkCJrV1smRTbd6xmMnrjDX42pwAw8C7D4KE+NGoKwGL0yrRTjIBHjAgYvfkWrfY0OGcgzjBwsA/1ob1WBOwK6i3nnjLUZZEcKL7Hbr1Dsz2NgHNwFmHg0DacHtxdsQoc6qh89Sih7Rhh7O57tFrT4HEEdBm2blmL3X3rZRMj4jIqq1auwOaN6/xSbqSqOA842KurSvDo7L0PaP36A4oiUBwi4F10WQxiMTgLwaMQS8I5PHx0Ges3rPXEvtjoEyFyiYRkr8hAIsXnH35EszkjhYjCBZCIBGMyIpwtAFEEPjOFNauX48nL21i2bKmzB6TIdHXky1DdLugAcOHZJ0zO/pOeR9Oz4J0OKFoAOCkQISjsgDpz2L5jE+7cGlVNsWQ0k1WgJyJn0LKB4uLrz/g9O48AHOHkH/BOCEQhKBLp4LJD8lgAYujyGCMn92Pg2B6llHpKLhrxp8ASJS4Ika5Z7cOX8fK5NMmwMwW2InqHDCtluZ7iaHAZAdKb/nnAp26VVM/oqPZ0JEFkgiUjIINrHex5N6re5hw79RSU2FfvIXkSqtIz22olj7W1jLSpfWnHGvGM7X4lzBnu0etLWnDpO0JShmoi0vLvack6Tc62uojE2Kmt1gs0cYzcLcJm6dYCgAL5CqVVgRTOLVoUFM8UrP/DbkWRXoaOTQAAAABJRU5ErkJggg==";
function renderGenCurrent() {
  const btn = $('lora-pick-btn');
  if (!btn) return;
  // 初始 HTML 已有 .gen-pick-label（沒有 img），第一次呼叫才補上 img；之後兩者都在
  // 就只更新文字節點，不重建 DOM。
  if (!btn.querySelector('img')) {
    btn.innerHTML = `<img src="data:image/png;base64,${LORA_MGR_LOGO_B64}" alt="" class="lora-logo" width="15" height="15"><span class="gen-pick-label"></span>`;
  }
  const [s0, s1] = GEN_LORA_SLOTS;
  let label;
  if (s0.lora && s1.lora) label = `${s0.lora.title || s0.lora.name} +1`;
  else if (s0.lora || s1.lora) label = (s0.lora || s1.lora).title || (s0.lora || s1.lora).name;
  else label = '選 LoRA';
  btn.querySelector('.gen-pick-label').textContent = label;
  btn.classList.toggle('has', !!(s0.lora || s1.lora));
  updateConceptsLockLabel();   // LoRA1/LoRA2 選擇一變，Concepts 鈕旁的鎖定狀態要跟著更新
}

// 右欄最上面的「LoRA 1 / LoRA 2」分頁卡：點哪張就把它設為編輯中（GEN_ACTIVE_SLOT），
// 左欄清單/隨機瀏覽點選都塞進編輯中那格。有選的顯示縮圖+標題，沒選顯示「未選擇」；
// LoRA 2 常常留空（見 selectGenLora 的可留空設計），有選才顯示清空 ✕。「參與判斷／跳過」
// 切換不在這裡——集中在設定彈窗「一般」分頁（renderCsSkipToggle()），這裡只管選 LoRA。
function renderLmSlotTabs() {
  const wrap = document.createElement('div'); wrap.className = 'lm-slot-tabs';
  GEN_LORA_SLOTS.forEach((slot, i) => {
    const tab = document.createElement('button'); tab.type = 'button';
    tab.className = 'lm-slot-tab' + (GEN_ACTIVE_SLOT === i ? ' on' : '');
    if (slot.lora && slot.lora.preview) tab.appendChild(makeLoraPreviewEl(slot.lora));
    else { const ph = document.createElement('span'); ph.className = 'ph'; tab.appendChild(ph); }
    const meta = document.createElement('span'); meta.className = 'lm-slot-tab-meta';
    const lb = document.createElement('span'); lb.className = 'lm-slot-tab-label'; lb.textContent = `LoRA ${i + 1}`;
    const ti = document.createElement('span'); ti.className = 'lm-slot-tab-title' + (slot.lora ? '' : ' empty');
    ti.textContent = slot.lora ? (slot.lora.title || slot.lora.name) : '未選擇';
    meta.append(lb, ti);
    tab.appendChild(meta);
    tab.addEventListener('click', () => { hideLoraPreviewTip(); setActiveSlot(i); renderLmCurrent(); renderLmList($('lm-search').value); });
    if (slot.lora) {
      tab.addEventListener('mouseenter', () => showSingleLoraPreviewTip(tab, slot.lora));
      tab.addEventListener('mouseleave', hideLoraPreviewTip);
    }
    if (slot.lora) {
      const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'lm-slot-clear';
      clear.title = `清空 LoRA ${i + 1}`; clear.setAttribute('aria-label', `清空 LoRA ${i + 1}`); clear.textContent = '✕';
      clear.addEventListener('click', (e) => {
        e.stopPropagation();
        GEN_LORA_SLOTS[i] = { lora: null, strength: slot.strength, twPicks: new Set() };
        setActiveSlot(i);
        renderGenCurrent(); renderLmCurrent(); renderLmList($('lm-search').value);
        renderCsScopeChips(i);
      });
      tab.appendChild(clear);
    }
    wrap.appendChild(tab);
  });
  return wrap;
}

// 大面板右欄：分頁卡 + 編輯中那格的 LoRA 縮圖/標題 + 每段 trainedWords 各自一張完整
// 文字卡（不截斷）+ 強度滑桿。這是「淺顯易懂」的重點——每段獨立成塊、可以整段讀完，
// 勾選決定要不要用。只展開「編輯中」那格的完整內容，不是兩格同時攤開——避免大面板
// 塞進兩份縮圖/觸發詞卡/預覽圖，閱讀負擔加倍。
function renderLmCurrent() {
  const box = $('lm-current'); if (!box) return;
  box.innerHTML = '';
  box.appendChild(renderLmSlotTabs());
  const slot = curSlot();
  const lora = slot.lora;
  if (!lora) {
    const none = document.createElement('div'); none.className = 'lm-none';
    none.textContent = `LoRA ${GEN_ACTIVE_SLOT + 1} 尚未選擇——從左邊清單點一個`;
    box.appendChild(none);
    return;
  }
  const head = document.createElement('div'); head.className = 'lm-cur-head';
  if (lora.preview) { head.appendChild(makeLoraPreviewEl(lora)); }
  else { const ph = document.createElement('span'); ph.className = 'ph'; head.appendChild(ph); }
  const meta = document.createElement('div');
  const t = document.createElement('div'); t.className = 'lm-cur-title'; t.textContent = lora.title || lora.name;
  const f = document.createElement('div'); f.className = 'lm-cur-folder'; f.textContent = lora.folder || '(根目錄)';
  meta.append(t, f);
  // 一鍵直達 LoRA Manager 那邊這個 LoRA 的完整詳情 modal（觸發詞來源、civitai 資訊、範例圖…）。
  // LoRA Manager 原生沒有這種深連結，這是我們在 lora-manager/static/js/loras.js 加的小功能
  // （讀 ?open=<folder>/<file> 自動開對應 modal，見 VENDORED.md）。folder/file 是暗房既有
  // LoRA 資料的欄位，跟推送機制用同一套識別方式。
  const detailLink = document.createElement('a');
  detailLink.className = 'lm-detail-link';
  detailLink.target = '_blank'; detailLink.rel = 'noopener';
  detailLink.title = '在 LoRA Manager 開這個 LoRA 的完整詳情（新分頁）';
  detailLink.href = `http://127.0.0.1:7861/loras?open=${encodeURIComponent((lora.folder || '') + '/' + (lora.file || ''))}`;
  detailLink.innerHTML = `<img src="data:image/png;base64,${LORA_MGR_LOGO_B64}" alt="" width="13" height="13"><span>詳情</span>`;
  // 「詳情」旁邊的基礎模型小標籤（Illustrious／Pony／SDXL 1.0…），資料來自 LoRA Manager
  // 掃描時寫的 .metadata.json 頂層 base_model 欄位（見 preview_ui.py list_loras()）。
  // 跟 .lm-cur-folder 同一套字體/顏色語彙（mono、faint），只是做成小圓角標籤跟 rar-tag
  // 那類徽章一致，不是純文字——base model 是分類性資訊，用標籤視覺上更好辨識。
  const actionsRow = document.createElement('div');
  actionsRow.className = 'lm-actions-row';
  if (lora.base_model) {
    const bm = document.createElement('span');
    bm.className = 'lm-base-model';
    bm.textContent = lora.base_model;
    bm.title = '基礎模型（來自 metadata.json）';
    actionsRow.appendChild(bm);
  }
  actionsRow.appendChild(detailLink);
  meta.appendChild(actionsRow);
  head.appendChild(meta);
  box.appendChild(head);

  const tw = lora.trainedWords || [];
  if (tw.length) {
    const label = document.createElement('div'); label.className = 'lm-tw-label';
    label.textContent = tw.length > 1 ? `觸發詞（共 ${tw.length} 段，勾選要用哪幾段）` : '觸發詞';
    box.appendChild(label);
    const list = document.createElement('div'); list.className = 'lm-tw-list';
    tw.forEach((w, i) => {
      const item = document.createElement('label');
      item.className = 'lm-tw-item' + (slot.twPicks.has(i) ? ' on' : '');
      item.style.setProperty('--i', i);   // 進場 stagger 用（見 darkroom.css .lm-tw-item）
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = slot.twPicks.has(i); cb.dataset.i = i;
      const idx = document.createElement('span'); idx.className = 'lm-tw-idx'; idx.textContent = (i + 1) + '.';
      const txt = document.createElement('span'); txt.className = 'lm-tw-text'; txt.textContent = w;
      item.append(cb, idx, txt);
      item.addEventListener('mouseenter', () => showTwTip(item, w));
      item.addEventListener('mouseleave', () => hideTwTip(item));
      list.appendChild(item);
    });
    box.appendChild(list);
  }

  // 段落卡片依序浮現完之後，強度列跟大預覽圖才出場——段數愈多，這兩個愈晚出現，順序感
  // 才對（呼應 animation-systems「hero 先動、次要元素跟隨」，這裡文字段落是重點）。
  const tailDelay = 90 + tw.length * 45 + 70;

  const strengthRow = document.createElement('div'); strengthRow.className = 'lm-strength';
  strengthRow.style.animationDelay = tailDelay + 'ms';
  const sLabel = document.createElement('span'); sLabel.textContent = '強度';
  const sInput = document.createElement('input'); sInput.type = 'range'; sInput.id = 'lm-strength';
  sInput.min = '0'; sInput.max = '1'; sInput.step = '0.05'; sInput.value = String(slot.strength);
  const sOut = document.createElement('output'); sOut.id = 'lm-strength-out'; sOut.textContent = slot.strength.toFixed(2);
  strengthRow.append(sLabel, sInput, sOut);
  box.appendChild(strengthRow);

  // 大預覽圖：強度列下方，不用另外 hover 才跳出來——直接看得到整張參考圖。
  if (lora.preview) {
    const pv = document.createElement('div'); pv.className = 'lm-preview';
    pv.style.animationDelay = (tailDelay + 60) + 'ms';
    const pvEl = makeLoraPreviewEl(lora);
    if (isLoraPreviewVideo(lora)) pvEl.controls = true;
    pv.appendChild(pvEl);
    box.appendChild(pv);
  }
}

// 單一格（LoRA1 或 LoRA2）依 twPicks 組合出來的觸發詞——genTriggerText()、Concepts
// 抽卡鎖定側（見 drawConceptsTarot）共用同一份邏輯，不要各自重寫一次「只取第一段」的
// 簡化版，那樣使用者在面板勾的段落就白勾了。
// 段落之間該不該加逗點是動態判斷、不是寫死加或寫死不加：每段 trainedWords 常常自己
// 結尾就帶逗點（civitai metadata 常見格式），這種情況直接接空格就好，硬加 ", " 會變成
// 連續逗點；但也有些段落沒有結尾逗點（純文字描述、或就是最後一段），這種不加分隔會讓
// 兩段文字黏在一起變成一個詞，對 CLIP 來說語意整個跑掉。joinTriggerParts() 逐段檢查
// 前一段結尾是不是逗點，決定要不要補一個。
function joinTriggerParts(parts) {
  parts = parts.filter(Boolean).map(p => p.trim()).filter(Boolean);
  let out = '';
  for (const p of parts) {
    if (!out) { out = p; continue; }
    out = out.endsWith(',') ? `${out} ${p}` : `${out}, ${p}`;
  }
  return out;
}
// 純粹算「這格勾了哪些段落」，不管強度——強度是否為 0 由呼叫端決定要不要用這份文字
// （見 genTriggerText() 跟 Concepts 抽卡鎖定側的呼叫點）。不在這裡內建強度判斷是刻意
// 的：Concepts 抽卡鎖定某一格 LoRA 時，實際套用的強度是 CONCEPTS_CHAR/KEY_STRENGTH
// （面板自己的滑桿），不是這格在 LoRA1/2 面板原本設定的 slot.strength——兩個強度
// 可能不一樣，這裡如果直接看 slot.strength 判斷，會在「LoRA1/2 面板強度是 0 但
// Concepts 強度不是 0」這種情況誤刪本該存在的觸發詞。
function slotTriggerText(slot) {
  if (!slot.lora) return '';
  const tw = slot.lora.trainedWords || [];
  if (tw.length <= 1) return tw[0] || '';
  return joinTriggerParts([...slot.twPicks].sort((a, b) => a - b).map(i => tw[i]));
}
// 目前兩格 LoRA 合併後的觸發詞（依各自 twPicks 組合，供生成時注入正向）。
// LoRA 1 的詞在前、LoRA 2 的接在後面——跟兩者在畫面上由上到下的順序一致。強度 0 的
// 格子觸發詞不寫進去，理由跟 _runConceptsDraw() 那條一樣：強度 0 等於這格 LoRA 完全
// 不生效，使用者拿「調成 0」當手動關閉開關，觸發詞還留著會讓人以為調 0 沒用。
function genTriggerText() {
  return joinTriggerParts(GEN_LORA_SLOTS.map(slot => slot.strength > 0 ? slotTriggerText(slot) : ''));
}

async function openLoraModal() {
  $('lora-modal').classList.add('open');
  if (!GEN_LORAS) $('lm-list').innerHTML = '<div class="lora-empty">載入中…</div>';
  renderLmCurrent();
  await fetchGenLoras();
  renderLmCats();
  renderLmSubcats();
  renderLmList($('lm-search').value, true);
  $('lm-search').focus();
}
// 關閉走淡出＋輕微縮小（呼應開啟的 fadeIn+modalPop），不像開啟時瞬間消失。用
// element.animate() 而不是加 class 再等 animationend——分頁在背景時 finished 不會
// 結算（CLAUDE.md 記過的老坑），所以另外用 setTimeout 保險收尾。
function closeLoraModal() {
  const modal = $('lora-modal');
  if (!modal.classList.contains('open')) return;
  // 關面板時強制收掉 hover 預覽——這個面板裡好幾個地方（LoRA1/2 分頁卡、左欄清單列）
  // 靠 mouseleave 收預覽卡，但關面板（Esc／背景遮罩／點 ✕）當下滑鼠通常還停在被 hover
  // 的元素上沒有真的移開，mouseleave 不一定會觸發，預覽卡會卡住不消失。不能只靠
  // mouseleave，關閉動作本身就要保證收掉。
  hideLoraPreviewTip();
  if (REDUCE_MOTION || document.visibilityState !== 'visible' || !modal.animate) {
    modal.classList.remove('open');
    return;
  }
  const inner = modal.querySelector('.lora-modal-inner');
  const ease = 'cubic-bezier(.4,0,1,1)';   // --ease-in
  const anims = [modal.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: ease })];
  if (inner) anims.push(inner.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }],
    { duration: 160, easing: ease }));
  let done = false;
  const finish = () => { if (done) return; done = true; modal.classList.remove('open'); };
  Promise.all(anims.map(a => a.finished)).then(finish).catch(finish);
  setTimeout(finish, 260);
}
// 快捷鍵一覽：純展示疊層，內容按「使用情境」分組（不是按字母），因為使用者記的是
// 「我在做什麼時按什麼」。只在第一次開啟時建 DOM（內容固定不會變，不用每次重繪）。
const SHORTCUT_GROUPS = [
  { title: '抽卡／生成', rows: [
    { keys: ['R'], desc: '重抽——依目前情境：一般抽卡（瀏覽/生圖/打標）、LoRA 隨機瀏覽、或 Concepts 疊層各自對應的重抽' },
    { keys: ['E'], desc: '重抽本分類（瀏覽/生圖模式看目前資料夾；LoRA 隨機瀏覽看左欄篩選晶片）' },
    { keys: ['C'], desc: '<b>Concepts 抽卡</b>——角色/情境各自照「一般」分頁的設定判斷（固定 LoRA→鎖定，範圍晶片→縮小範圍，都沒有→角色跳過／情境全隨機），標「已跳過」的格子不參與判斷' },
  ]},
  { title: '打標模式', rows: [
    { keys: ['←', '→', '↑', '↓'], desc: '移動焦點到上／下一張或上／下一列' },
    { keys: ['1'], desc: '標「普通」並自動跳下一張' },
    { keys: ['2'], desc: '標「稀有」並自動跳下一張' },
    { keys: ['3'], desc: '標「特別」並自動跳下一張' },
    { keys: ['4'], desc: '標「傳奇」並自動跳下一張' },
    { keys: ['S'], desc: '跳過這張，不標記' },
    { keys: ['Z'], desc: '復原上一次標記' },
  ]},
  { title: '導覽／關閉', rows: [
    { keys: ['Esc'], desc: '關閉目前開著的疊層／大圖／面板（一次只關最上層的那個）' },
    { keys: ['←', '→'], desc: '看大圖時切換上一張／下一張（從格線點開才能切，抽卡開的大圖不行）' },
    { keys: ['?'], desc: '開／關這份快捷鍵一覽' },
  ]},
];
function renderShortcuts() {
  const box = $('shortcuts-groups'); if (!box || box.children.length) return;   // 只建一次
  SHORTCUT_GROUPS.forEach((group, gi) => {
    const g = document.createElement('div'); g.className = 'shortcut-group';
    g.style.setProperty('--i', gi);
    const h = document.createElement('h3'); h.textContent = group.title; g.appendChild(h);
    group.rows.forEach(row => {
      const r = document.createElement('div'); r.className = 'shortcut-row';
      const keys = document.createElement('div'); keys.className = 'shortcut-keys';
      row.keys.forEach(k => { const kbd = document.createElement('span'); kbd.className = 'kbd'; kbd.textContent = k; keys.appendChild(kbd); });
      const desc = document.createElement('div'); desc.className = 'shortcut-desc'; desc.innerHTML = row.desc;
      r.append(keys, desc);
      g.appendChild(r);
    });
    box.appendChild(g);
  });
}
// 「功能總覽」分頁：跟 SHORTCUT_GROUPS 同一種分組資料結構，但這裡列的是滑鼠/UI 驅動的
// 功能（沒有鍵位可標），內容固定不會變，只在第一次切到這頁時建 DOM（見 renderFeatures）。
const FEATURE_GROUPS = [
  { title: '瀏覽／打標', rows: [
    { desc: '<b>收藏</b>——縮圖右上角星號，點一下收藏（金色實心星常駐），再點取消；桌面平常隱藏、hover 卡片才浮現' },
    { desc: '<b>稀有度標記</b>——打標模式選取縮圖，下方點稀有度即時寫入（含「移除標記」），選取自動清空可接著標下一批' },
    { desc: '<b>資料夾搜尋</b>——左側導覽列上方的搜尋框，即時篩選資料夾清單' },
    { desc: '<b>缺圖／已有篩選</b>——主區右上「全部／缺圖／已有」分段，只看還沒生預覽圖或已經有的詞庫' },
  ]},
  { title: '生圖', rows: [
    { desc: '<b>多選詞庫＋選 LoRA 生圖</b>——瀏覽格線點縮圖多選，右上「選 LoRA」開大面板挑 LoRA，genbar 按「生圖」送出' },
    { desc: '<b>LoRA 大面板</b>——左欄分類/子資料夾篩選＋搜尋＋翻頁，右欄每段觸發詞各自一張完整文字卡（勾選要用哪幾段）＋強度滑桿＋參考圖；左欄下方「🎲 隨機瀏覽」疊一批塔羅卡讓你點選' },
    { desc: '<b>雙 LoRA 疊加</b>——右欄「LoRA 1／LoRA 2」兩張分頁卡各自獨立選擇與強度，可疊加使用' },
    { desc: '<b>各格獨立抽取範圍</b>——LoRA1/LoRA2 各自獨立記住自己的分類/子資料夾抽取範圍，設定彈窗「一般」分頁跟大面板左欄晶片雙向同步；哪格已經放了固定 LoRA，範圍晶片會自動換成顯示那顆 LoRA（含縮圖，滑鼠移上去有預覽）' },
    { desc: '<b>Concepts 參與判斷</b>——設定彈窗「一般」分頁 LoRA1/LoRA2 各有一顆「參與判斷／已跳過」切換（預設跳過），只有切成參與的格子才會影響 <b>Concepts</b> 抽卡的角色/情境判斷，點旁邊「？ 詳細教學」看完整說明' },
    { desc: '<b>生成步數輸入框</b>——topbar 右側，範圍 1～150，即時套用到之後的生成（不是鎖 25，25 只是預設值）' },
  ]},
  { title: '抽卡', rows: [
    { desc: '<b>一般抽卡</b>——R 全庫、E 本分類，瀏覽模式看圖、打標模式逐張標稀有度、生圖模式隨機生圖' },
    { desc: '<b>Concepts 抽卡</b>——C／X 鍵，每張卡隨機配對一顆 Character LoRA＋一顆 concepts LoRA 直接生圖，強度／張數／是否同時抽詞庫模板在齒輪設定裡調' },
    { desc: '<b>鎖定模板／鎖定 LoRA</b>——Concepts 設定裡搜尋鎖定固定模板；LoRA1/2 面板選好某個 Character 或 concepts 分類的 LoRA 就自動視為鎖定那一側' },
  ]},
  { title: '圖庫', rows: [
    { desc: '<b>即時預覽</b>——生成中的卡片直接顯示採樣過程畫面，不用等完成才看得到' },
    { desc: '<b>取消生圖</b>——塔羅疊層上取消當批；圖庫左上「取消全部」一次停掉所有還在跑的' },
    { desc: '<b>大圖資訊</b>——點圖庫縮圖看大圖，附詞庫／資料夾／LoRA／強度／觸發詞／seed／生成時間' },
  ]},
];
function renderFeatures() {
  const box = $('feature-groups'); if (!box || box.children.length) return;   // 只建一次
  FEATURE_GROUPS.forEach((group, gi) => {
    const g = document.createElement('div'); g.className = 'shortcut-group';
    g.style.setProperty('--i', gi);
    const h = document.createElement('h3'); h.textContent = group.title; g.appendChild(h);
    group.rows.forEach(row => {
      const r = document.createElement('div'); r.className = 'shortcut-row no-keys';
      const desc = document.createElement('div'); desc.className = 'shortcut-desc'; desc.innerHTML = row.desc;
      r.appendChild(desc);
      g.appendChild(r);
    });
    box.appendChild(g);
  });
}
function moveHelpPill() {
  const seg = $('help-seg'), pill = $('help-pill');
  const active = seg && seg.querySelector('button.on');
  if (!active || !pill) return;
  pill.style.width = active.offsetWidth + 'px';
  pill.style.transform = `translateX(${active.offsetLeft}px)`;
}
$('help-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  $('help-seg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
  moveHelpPill();
  $('shortcuts-groups').hidden = btn.dataset.tab !== 'shortcuts';
  $('feature-groups').hidden = btn.dataset.tab !== 'features';
});
function openShortcuts() {
  renderShortcuts();
  renderFeatures();
  $('shortcuts-overlay').classList.add('open');
  moveHelpPill();
}
// 收尾邏輯跟 closeLoraModal 同一套（element.animate() 取代加減 class，分頁在背景時
// finished 不結算的老坑靠 setTimeout 保險），這裡不獨立寫註解重複解釋。
function closeShortcuts() {
  const ov = $('shortcuts-overlay');
  if (!ov.classList.contains('open')) return;
  if (REDUCE_MOTION || document.visibilityState !== 'visible' || !ov.animate) {
    ov.classList.remove('open');
    return;
  }
  const panel = $('shortcuts-panel');
  const ease = 'cubic-bezier(.4,0,1,1)';
  const anims = [ov.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: ease })];
  if (panel) anims.push(panel.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }],
    { duration: 160, easing: ease }));
  let done = false;
  const finish = () => { if (done) return; done = true; ov.classList.remove('open'); };
  Promise.all(anims.map(a => a.finished)).then(finish).catch(finish);
  setTimeout(finish, 260);
}
$('shortcuts-btn').onclick = openShortcuts;
$('shortcuts-close').onclick = closeShortcuts;
$('shortcuts-overlay').addEventListener('click', e => { if (e.target.id === 'shortcuts-overlay') closeShortcuts(); });

// genbar「選 LoRA」摘要鈕 hover 預覽：跟 .tw-tip 同一套單例 fixed 元素＋淡入淡出，
// 差別是往上彈（genbar 貼在畫面最下方，往下彈會被裁掉看不到）、內容是圖片不是文字。
// 選了幾格 LoRA 就顯示幾張，滑鼠移過去就能比對，不用先開大面板。
let LORA_PREVIEW_TIP_EL = null;
function ensureLoraPreviewTip() {
  if (LORA_PREVIEW_TIP_EL) return LORA_PREVIEW_TIP_EL;
  LORA_PREVIEW_TIP_EL = document.createElement('div');
  LORA_PREVIEW_TIP_EL.className = 'lora-preview-tip';
  document.body.appendChild(LORA_PREVIEW_TIP_EL);
  return LORA_PREVIEW_TIP_EL;
}
function positionLoraPreviewTip(anchor) {
  const tip = ensureLoraPreviewTip();
  const r = anchor.getBoundingClientRect();
  tip.style.left = r.left + 'px';
  tip.style.top = 'auto';
  tip.style.bottom = (window.innerHeight - r.top + 8) + 'px';
}
function showLoraPreviewTip(anchor) {
  if (!(GEN_LORA_SLOTS[0].lora || GEN_LORA_SLOTS[1].lora)) return;   // 都沒選就沒什麼好預覽的
  const tip = ensureLoraPreviewTip();
  tip.innerHTML = '';
  GEN_LORA_SLOTS.forEach((slot, i) => {
    if (!slot.lora) return;   // LoRA2 常留空（見 selectGenLora），沒選就不佔一格
    const item = document.createElement('div'); item.className = 'lpt-item';
    if (slot.lora.preview) item.appendChild(makeLoraPreviewEl(slot.lora));
    else { const ph = document.createElement('span'); ph.className = 'ph'; item.appendChild(ph); }
    const label = document.createElement('span'); label.className = 'lpt-label';
    label.textContent = `LoRA${i + 1}：${slot.lora.title || slot.lora.name}`;
    item.appendChild(label);
    tip.appendChild(item);
  });
  positionLoraPreviewTip(anchor);
  tip.classList.add('show');
}
function hideLoraPreviewTip() {
  if (LORA_PREVIEW_TIP_EL) LORA_PREVIEW_TIP_EL.classList.remove('show');
}
$('lora-pick-btn').addEventListener('mouseenter', () => showLoraPreviewTip($('lora-pick-btn')));
$('lora-pick-btn').addEventListener('mouseleave', hideLoraPreviewTip);

// LoRA 大面板內部（左欄清單列、右欄 LoRA1/2 分頁卡）hover 放大預覽：面板裡的縮圖本來就
// 比 genbar 摘要鈕上小很多（52x52／28x28），選之前想看清楚長什麼樣得先點下去才知道。
// 沿用同一顆 .lora-preview-tip 單例元素（跟 genbar 那顆共用，同一時間只會有一個 hover
// 目標，不會衝突），但這裡是「單張、貼在滑鼠旁邊」，不是「依 LoRA1/2 slot 狀態固定顯示
// 一到兩張」，所以另外寫一個單張版本的顯示函式，位置也改成貼右側（面板內容通常還有
// 空間、貼右不會被自己清單擋住），超出視窗右緣才改貼左側。
function showSingleLoraPreviewTip(anchor, lora) {
  if (!lora || !lora.preview) return;   // 沒預覽圖就不彈——清單/分頁卡本身已經有 🧩 佔位圖示，夠清楚了
  const tip = ensureLoraPreviewTip();
  tip.innerHTML = '';
  const item = document.createElement('div'); item.className = 'lpt-item';
  item.appendChild(makeLoraPreviewEl(lora));
  const label = document.createElement('span'); label.className = 'lpt-label';
  label.textContent = lora.title || lora.name;
  item.appendChild(label);
  tip.appendChild(item);
  const r = anchor.getBoundingClientRect();
  const w = 220;   // 跟 .lpt-item 寬度對應（200 + padding）
  let left = r.right + 10;
  if (left + w > window.innerWidth) left = r.left - w - 10;
  tip.style.left = left + 'px';
  tip.style.bottom = 'auto';
  tip.style.top = Math.max(8, Math.min(window.innerHeight - 240, r.top + r.height / 2 - 120)) + 'px';
  tip.classList.add('show');
}

$('lora-panel-btn').onclick = openLoraModal;   // topbar 入口（只在生圖模式看得到，見 CSS）
$('lora-pick-btn').onclick = () => { hideLoraPreviewTip(); openLoraModal(); };    // genbar 摘要鈕，同一個面板
$('lora-modal-close').onclick = closeLoraModal;
$('lm-random-btn').onclick = () => { fetchGenLoras().then(drawLoraTarot); };
$('lora-modal').addEventListener('click', e => { if (e.target.id === 'lora-modal') closeLoraModal(); });
$('lm-search').addEventListener('input', () => renderLmList($('lm-search').value, true));
// 強度滑桿／trainedWords 勾選都是動態生成（見 renderLmCurrent），用事件委派在容器上聽，
// 不用每次重繪都重綁一次。
$('lm-current').addEventListener('input', (e) => {
  if (e.target.id !== 'lm-strength') return;
  const slot = curSlot();
  slot.strength = parseFloat(e.target.value);
  const out = $('lm-strength-out'); if (out) out.textContent = slot.strength.toFixed(2);
});
$('lm-current').addEventListener('change', (e) => {
  if (!e.target.matches('input[type=checkbox]')) return;
  const i = +e.target.dataset.i;
  const twPicks = curSlot().twPicks;
  if (e.target.checked) twPicks.add(i); else twPicks.delete(i);
  const item = e.target.closest('.lm-tw-item'); if (item) item.classList.toggle('on', e.target.checked);
});
$('gen-run').onclick = () => runGen();

/* ---------------------------------------------------------------------------
   2026-08 lora-manager 整合：LoRA Manager（vendor 在 ../lora-manager/，獨立埠 7861）
   點「送到 workflow」會 POST 到 /api/lora-push（見 preview_ui.py），這裡每 ~1s 輪詢
   一次版本號，偵測到新推送就自動切生圖模式、選進大面板——「推進目前開著的分頁」。
   自排程 setTimeout（不用 setInterval）：等前一次抓完才排下一次，跟生圖預覽輪詢
   同一套節奏，慢速環境不會疊請求；沒人在跑 LoRA Manager 時這支請求也很輕量。
--------------------------------------------------------------------------- */
// 版本號記到 localStorage、不從 0 起算：後端 _lora_push 是單一 slot、只增不減、
// 存在記憶體直到伺服器重啟，重整頁面不會清掉「已經推送過」這件事。若每次重整都從
// 0 開始輪詢，會把上次已經套用過的舊推送當成新推送再套一次——這就是「刷新網頁一直
// 跳傳送的 LoRA」的成因。記住已看過的版本號，重整後只會忽略舊版本、不會重複套用；
// 使用者真的再按一次「送到 workflow」時，伺服器 ver 會再遞增，仍然正確觸發。
//
// 但這帶出另一個問題（實際發生過：伺服器重啟後連推 3 次、暗房完全沒反應）：ver 只存在
// 記憶體，伺服器一重啟就歸零；瀏覽器 localStorage 卻不會跟著清掉，於是重啟後的新 ver
// （1、2、3…）永遠小於瀏覽器記住的舊版本號，被永久當成「已看過」而略過。後端加了開機
// epoch（每次啟動一個新亂數）解決這個問題：epoch 變了就代表換了一個新的伺服器行程，
// 舊版本號對新行程沒有意義，要重置。
let LORA_PUSH_EPOCH = localStorage.getItem('yz-lora-push-epoch') || '';
let LORA_PUSH_VER = +(localStorage.getItem('yz-lora-push-ver') || 0);
async function pollLoraPush() {
  try {
    const st = await fetch('/api/lora-push?since=' + LORA_PUSH_VER).then(r => r.json());
    if (st.epoch && st.epoch !== LORA_PUSH_EPOCH) {
      // 伺服器重啟過：重置成 0、記住新 epoch。這一輪的 since 是用重置前的舊值送出的，
      // 伺服器可能因此沒附 data；不強行套用，下一輪（1s 後）用正確的 since=0 重新問，
      // 自然會正確拿到並套用，只晚一輪、不會漏掉。
      LORA_PUSH_EPOCH = st.epoch;
      LORA_PUSH_VER = 0;
      localStorage.setItem('yz-lora-push-epoch', LORA_PUSH_EPOCH);
      localStorage.setItem('yz-lora-push-ver', '0');
    } else if (st.ver > LORA_PUSH_VER) {
      LORA_PUSH_VER = st.ver;
      localStorage.setItem('yz-lora-push-ver', LORA_PUSH_VER);
      if (st.data) await applyLoraPush(st.data);
    }
  } catch (e) { /* 靜默；下一輪再試，不用整個工具連得上才能用 */ }
  setTimeout(pollLoraPush, 1000);
}
async function applyLoraPush(d) {
  if (GALLERY_OPEN) { GALLERY_OPEN = false; document.body.classList.remove('gallery-open'); $('gallery-btn').classList.remove('on'); }
  if (MODE !== 'gen') switchMode('gen');
  await openLoraModal();
  const match = (GEN_LORAS || []).find(l => l.name === d.name && (!d.folder || l.folder === d.folder));
  if (!match) { toast(`LoRA Manager 送來的「${d.name}」在這裡的清單找不到——按「重掃」也許有幫助`); return; }
  // 自動找空格：LoRA 1 空就填 LoRA 1，LoRA 1 滿了才填 LoRA 2；兩格都滿了才蓋掉目前
  // 編輯中那格（GEN_ACTIVE_SLOT 是「上次編輯到哪」的殘留狀態，不該直接沿用來決定
  // 推送蓋到哪一格，否則使用者很難預期會蓋掉哪個）。
  const emptyIdx = GEN_LORA_SLOTS.findIndex(s => !s.lora);
  if (emptyIdx !== -1) setActiveSlot(emptyIdx);
  selectGenLora(match);
  toast(`已從 LoRA Manager 選入 LoRA ${GEN_ACTIVE_SLOT + 1}：「${match.title || match.name}」`);
}
pollLoraPush();

/* ---------------- 生成圖庫（本 session、記憶體、刷新即清空） ----------------
   生成的圖不落地磁碟：前端維護 GALLERY 清單（含 metadata），後端仍記憶體暫存供圖。
   刷新/關頁 → 清單消失 → 圖庫空。用獨立「🖼 圖庫」鈕切換視圖，蓋掉詞庫格線。 */
const GALLERY = [];          // {id, name, rel, folder, loras:[{folder,file,title,strength}], trigger, ts, done, err, seed}
let GALLERY_OPEN = false;

function switchView(fn) {     // 視圖切換交叉淡入（root VT）；窗格隱藏/減動時直接切
  if (!document.startViewTransition || REDUCE_MOTION || document.visibilityState !== 'visible') { fn(); return; }
  document.startViewTransition(fn);
}
// 兩個 LoRA 用「、」隔開列出；一個沒選就跳過（不是印一個空白項）。
function galleryLoraText(g) {
  const loras = g.loras || [];
  if (!loras.length) return '（無 LoRA）';
  return loras.map(l => (l.folder ? l.folder + '\\' : '') + l.file).join('、');
}
function updateGalleryHead() {
  const n = GALLERY.length;
  const sub = $('gallery-sub'); if (sub) sub.textContent = n ? `${n} 張` : '';
  const badge = $('gallery-n'); if (badge) badge.textContent = n ? String(n) : '';
  const empty = $('gallery-empty'); if (empty) empty.style.display = n ? 'none' : '';
  updateCancelAllBtn();
}
function buildGalleryCard(g, i) {
  const card = document.createElement('div');
  card.className = 'gcard' + (g.done ? '' : ' pending') + (g.err ? ' gr-err' : '');
  card.dataset.gid = g.id;
  card.style.setProperty('--i', i || 0);
  const sq = document.createElement('div'); sq.className = 'gc-square';
  const img = document.createElement('img'); img.className = 'gen-live'; img.alt = ''; img.decoding = 'async';
  img.onload = () => img.classList.add('ld');
  if (g.done) img.src = '/api/gen-result?id=' + g.id;
  img.onclick = () => { const gg = GALLERY.find(x => x.id === g.id); if (gg && gg.done) { MODAL_FROM_TAROT = false; openGalleryItem(g.id); } };
  const spin = document.createElement('div'); spin.className = 'gen-spin'; spin.innerHTML = '<i class="gen-loader"></i>';
  sq.append(img, spin);
  const nm = document.createElement('div'); nm.className = 'gc-name'; nm.textContent = g.name;
  card.append(sq, nm);
  return card;
}
function renderGallery() {
  const grid = $('gallery-grid'); if (!grid) return;
  grid.innerHTML = '';
  for (let k = GALLERY.length - 1, i = 0; k >= 0; k--, i++) grid.appendChild(buildGalleryCard(GALLERY[k], i));   // 新→舊
  updateGalleryHead();
}
function openGallery() {
  if (GALLERY_OPEN) return;
  switchView(() => { GALLERY_OPEN = true; document.body.classList.add('gallery-open'); $('gallery-btn').classList.add('on'); renderGallery(); });
}
function closeGallery() {
  if (!GALLERY_OPEN) return;
  switchView(() => { GALLERY_OPEN = false; document.body.classList.remove('gallery-open'); $('gallery-btn').classList.remove('on'); });
}
$('gallery-btn').onclick = () => (GALLERY_OPEN ? closeGallery() : openGallery());
// 取消「目前所有」還在跑的生圖，跨批次——跟塔羅疊層那顆只取消當批不同。圖庫本身不用
// 關閉（使用者還在看結果），卡片會由既有的輪詢（_genTick/applyGenState）自然轉成
// 「已取消」，不用在這裡手動改 DOM。
$('gallery-cancel-all').onclick = () => {
  const ids = [...GEN_PENDING];
  if (!ids.length) return;
  fetch('/api/gen-cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }) }).catch(() => {});
  toast(`已取消全部 ${ids.length} 張在途生圖`);
};
$('concepts-btn').onclick = () => { fetchGenLoras().then(() => { updateConceptsLockLabel(); drawConceptsTarot(); }); };

// LoRA 抽取設定：⚙ 鈕開置中大 modal，比照 .lora-modal 同一套開關方式——背景遮罩點擊、
// ✕、Esc 都能關（見 keydown handler），不再用 document 層級 outside-click 偵測（那個
// 機制本身就是先前修過的一個 bug 的根源模式：click handler 若把被點擊的元素自己從
// DOM 移除，冒泡到 document 判斷式時 Node.contains() 對離線節點一律回傳 false，會被
// 誤判成「點在外面」而自動關閉——這次直接用背景遮罩點擊取代，整類問題不會再發生）。
async function openCsModal() {
  $('cs-modal').classList.add('open');
  await fetchGenLoras();
  renderCsScopeChips(0);
  renderCsScopeChips(1);
  moveCsTabPill();
}
function closeCsModal() {
  const modal = $('cs-modal');
  if (!modal.classList.contains('open')) return;
  hideLoraPreviewTip();   // 鎖定卡片（.cs-locked-card）hover 預覽同樣的收尾保險，見 closeLoraModal()
  if (REDUCE_MOTION || document.visibilityState !== 'visible' || !modal.animate) {
    modal.classList.remove('open');
    return;
  }
  const inner = $('cs-modal-inner');
  const ease = 'cubic-bezier(.4,0,1,1)';
  const anims = [modal.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: ease })];
  if (inner) anims.push(inner.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }],
    { duration: 160, easing: ease }));
  let done = false;
  const finish = () => { if (done) return; done = true; modal.classList.remove('open'); };
  Promise.all(anims.map(a => a.finished)).then(finish).catch(finish);
  setTimeout(finish, 260);
}
$('concepts-settings-btn').onclick = (e) => { e.stopPropagation(); openCsModal(); };
$('cs-modal-close').onclick = closeCsModal;
$('cs-modal').addEventListener('click', e => { if (e.target.id === 'cs-modal') closeCsModal(); });
// 教學疊層：純展示、不影響任何狀態，開關動畫跟 closeCsModal() 同一套寫法。從 cs-modal
// 裡的「？ 詳細教學」按鈕開，關掉只是收起這層，cs-modal 本身還開著。
function openLoraHelpModal() { $('lora-help-modal').classList.add('open'); }
function closeLoraHelpModal() {
  const modal = $('lora-help-modal');
  if (!modal.classList.contains('open')) return;
  if (REDUCE_MOTION || document.visibilityState !== 'visible' || !modal.animate) {
    modal.classList.remove('open');
    return;
  }
  const inner = $('lora-help-inner');
  const ease = 'cubic-bezier(.4,0,1,1)';
  const anims = [modal.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: ease })];
  if (inner) anims.push(inner.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }],
    { duration: 160, easing: ease }));
  let done = false;
  const finish = () => { if (done) return; done = true; modal.classList.remove('open'); };
  Promise.all(anims.map(a => a.finished)).then(finish).catch(finish);
  setTimeout(finish, 260);
}
$('lora-help-btn').addEventListener('click', (e) => { e.stopPropagation(); openLoraHelpModal(); });
$('lora-help-close').onclick = closeLoraHelpModal;
$('lora-help-modal').addEventListener('click', e => { if (e.target.id === 'lora-help-modal') closeLoraHelpModal(); });
function moveCsTabPill() {
  const seg = $('cs-tab-seg'), pill = $('cs-tab-pill');
  const active = seg && seg.querySelector('button.on');
  if (!active || !pill) return;
  pill.style.width = active.offsetWidth + 'px';
  pill.style.transform = `translateX(${active.offsetLeft}px)`;
}
$('cs-tab-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  $('cs-tab-seg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
  moveCsTabPill();
  $('cs-tab-general').hidden = btn.dataset.tab !== 'general';
  $('cs-tab-concepts').hidden = btn.dataset.tab !== 'concepts';
});
// 「參與判斷／已跳過」切換——事件委派掛在 cs-tab-general 上，用 data-slot 判斷是哪一格。
$('cs-tab-general').addEventListener('click', (e) => {
  const btn = e.target.closest('.cs-skip-toggle'); if (!btn) return;
  const i = Number(btn.dataset.slot);
  GEN_LORA_SLOT_SKIP[i] = !GEN_LORA_SLOT_SKIP[i];
  renderCsSkipToggle(i);
  updateConceptsLockLabel();   // Concepts 鈕旁的鎖定狀態文字可能因為跳過切換而改變，跟著更新
});
const $csCharStrength = $('cs-char-strength'), $csCharStrengthOut = $('cs-char-strength-out');
const $csKeyStrength = $('cs-key-strength'), $csKeyStrengthOut = $('cs-key-strength-out');
const $csCount = $('cs-count');
const $csTpl = $('cs-tpl');
const $csTplCurFolder = $('cs-tpl-cur-folder');
$csCharStrength.value = CONCEPTS_CHAR_STRENGTH; $csCharStrengthOut.textContent = CONCEPTS_CHAR_STRENGTH.toFixed(2);
$csKeyStrength.value = CONCEPTS_KEY_STRENGTH; $csKeyStrengthOut.textContent = CONCEPTS_KEY_STRENGTH.toFixed(2);
$csCount.value = CONCEPTS_COUNT;
$csTpl.checked = CONCEPTS_WITH_TEMPLATE;
$csTplCurFolder.checked = CONCEPTS_TPL_CUR_FOLDER;
$csCharStrength.addEventListener('input', () => {
  const v = parseFloat($csCharStrength.value);
  $csCharStrengthOut.textContent = v.toFixed(2);
  setConceptsCharStrength(v);
});
$csKeyStrength.addEventListener('input', () => {
  const v = parseFloat($csKeyStrength.value);
  $csKeyStrengthOut.textContent = v.toFixed(2);
  setConceptsKeyStrength(v);
});
$csCount.addEventListener('change', () => {
  let v = parseInt($csCount.value, 10);
  if (!Number.isFinite(v) || v < 1) v = 1;
  if (v > 24) v = 24;
  $csCount.value = v;
  setConceptsCount(v);
});
$csTpl.addEventListener('change', () => setConceptsWithTemplate($csTpl.checked));
$csTplCurFolder.addEventListener('change', () => setConceptsTplCurFolder($csTplCurFolder.checked));

// 鎖定模板小選擇器：跟 LoRA 面板搜尋同一套「輸入就篩選、點一項就選中」互動，但這裡是
// 純文字清單（不用縮圖），畢竟重點是「選中哪個詞庫」。搜尋比對名稱/資料夾，跟
// renderLmList() 的 nameHit/twHit 分級邏輯不同——詞庫沒有觸發詞可比對，用簡單的
// includes 就夠，結果數量也用 30 筆封頂，不用全部渲染（詞庫可能上萬筆）。
const $csTplLock = $('cs-tpl-lock');
const $csTplLockCurrent = $('cs-tpl-lock-current');
const $csTplLockName = $('cs-tpl-lock-name');
const $csTplSearch = $('cs-tpl-search');
const $csTplResults = $('cs-tpl-results');
function updateConceptsTemplateLockUI() {
  const locked = CONCEPTS_LOCKED_TEMPLATE;
  if (locked) { $csTplLock.dataset.locked = '1'; } else { delete $csTplLock.dataset.locked; }
  $csTplLockCurrent.hidden = !locked;
  if (locked) $csTplLockName.textContent = locked.name;
}
function renderConceptsTplResults() {
  const q = $csTplSearch.value.trim().toLowerCase();
  $csTplResults.innerHTML = '';
  if (!q) return;
  const hits = ALL.filter(x => x.name.toLowerCase().includes(q) || (x.folder || '').toLowerCase().includes(q)).slice(0, 30);
  if (!hits.length) { $csTplResults.innerHTML = '<div class="cs-tpl-empty">找不到符合的詞庫</div>'; return; }
  hits.forEach(item => {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'cs-tpl-row';
    if (item.has_image) {
      const img = document.createElement('img');
      img.className = 'ctr-thumb'; img.loading = 'lazy'; img.decoding = 'async'; img.alt = '';
      img.src = `/api/thumb?rel=${encodeURIComponent(item.rel)}&v=${item.image_mtime}`;
      row.appendChild(img);
    }
    const text = document.createElement('span'); text.className = 'ctr-text';
    const name = document.createElement('span'); name.className = 'ctr-name'; name.textContent = item.name;
    const folder = document.createElement('span'); folder.className = 'ctr-folder'; folder.textContent = item.folder || '(根目錄)';
    text.append(name, folder);
    row.appendChild(text);
    row.addEventListener('click', (e) => {
      // 一定要 stopPropagation：這個 handler 會把自己（row）從 DOM 移除
      // （$csTplResults.innerHTML = ''），等事件冒泡到 document 層級的「點外面關閉」
      // 判斷式時 e.target 已經不在文件裡，Node.contains() 對已離線節點一律回傳
      // false，面板會被誤判成「點在外面」而自動關閉。使用者回報選詞庫模板、清除
      // 鎖定的 ✕ 都「沒反應」，根源其實是同一個：選模板當下面板就被關掉了，✕
      // 是在一個已經（看似還開著，實則下一步就要關）的面板上點的，時序上很難注意到。
      e.stopPropagation();
      setConceptsLockedTemplate(item);
      $csTplSearch.value = '';
      $csTplResults.innerHTML = '';
    });
    $csTplResults.appendChild(row);
  });
}
let csTplSearchTimer = null;
$csTplSearch.addEventListener('input', () => {
  clearTimeout(csTplSearchTimer);
  csTplSearchTimer = setTimeout(renderConceptsTplResults, 150);
});
$('cs-tpl-lock-clear').addEventListener('click', () => setConceptsLockedTemplate(null));
updateConceptsTemplateLockUI();
// 鎖定狀態指示：讀 GEN_LORA_SLOTS 現在有沒有選到 Character/concepts 分類的 LoRA（見
// conceptsLockLabel）。頁面剛載入時兩格都是空的，顯示「隨機 × 隨機」；之後每次
// LoRA1/LoRA2 選擇變動（selectGenLora／清空／交換）都要重繪一次，不然按鈕旁的文字會
// 跟實際狀態脫節，使用者以為鎖定了其實沒有、或反過來。
function updateConceptsLockLabel() {
  const el = $('concepts-lock'); if (!el) return;
  const label = conceptsLockLabel();
  if (label === el.textContent) return;
  el.textContent = label;
  el.title = label;   // CSS 會截斷過長的 LoRA 標題（見 darkroom.css .concepts-lock），完整內容靠原生 hover tooltip 補回來
  // class 加減重啟動畫不可靠（見 CLAUDE.md），改用 element.animate() 直接播放
  el.animate(
    [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
    { duration: 220, easing: 'cubic-bezier(.22,.61,.36,1)' } // 對齊 --d-ui / --ease-out
  );
}
updateConceptsLockLabel();

// 點圖庫（或抽卡塔羅）縮圖看大圖＋資訊。MODAL_FROM_TAROT 由呼叫端設：塔羅來的關掉回牌、圖庫來的正常關。
function openGalleryItem(gid) {
  const g = GALLERY.find(x => x.id === gid);
  const inner = $('modal-inner'); if (!inner) return;
  delete inner.dataset.rel;
  inner.dataset.gid = gid;   // 讓方向鍵知道現在切的是圖庫清單，不是詞庫格線（見 keydown 分支）
  inner.innerHTML = '';
  const left = document.createElement('div');
  const img = document.createElement('img');
  img.style.cssText = 'max-width:100%;border-radius:10px;background:#000';
  img.src = '/api/gen-result?id=' + encodeURIComponent(gid);
  left.appendChild(img);
  const right = document.createElement('div'); right.className = 'gi-info';
  const rows = g ? [
    ['詞庫', g.name], ['資料夾', g.folder || '(根目錄)'],
    ['LoRA', galleryLoraText(g)],
    ['強度', (g.loras || []).length ? g.loras.map(l => (+l.strength).toFixed(2)).join('、') : '—'],
    ['觸發詞', g.trigger || '（無）'],
    ['seed', g.seed != null ? String(g.seed) : '—'],
    ['時間', new Date(g.ts).toLocaleString()],
  ] : [];
  for (const [k, v] of rows) {
    const row = document.createElement('div'); row.className = 'gi-row';
    const kk = document.createElement('span'); kk.className = 'gi-k'; kk.textContent = k;
    const vv = document.createElement('span'); vv.className = 'gi-v'; vv.textContent = v;
    row.append(kk, vv); right.appendChild(row);
  }
  inner.append(left, right);
  $('modal').classList.add('open');
}

// Concepts 抽卡：跟一般抽卡生圖不同，不是「固定 LoRA、抽不同詞庫」，而是**每張卡各自**
// 隨機配一組全新的 Character LoRA＋concepts LoRA。強度／張數／是否抽詞庫模板不是讀
// LoRA1/2 面板，是讀獨立的 Concepts 設定彈窗（CONCEPTS_CHAR_STRENGTH／
// CONCEPTS_KEY_STRENGTH／CONCEPTS_COUNT／CONCEPTS_WITH_TEMPLATE，宣告都在上面、跟
// GEN_LORA_SLOTS 同一區——不是這裡，理由是彈窗控制項的初始值要在腳本載入當下就同步
// 設定，寫在後面會撞 TDZ：CLAUDE.md 記過的老坑，這次是動手前就避開，不是修出來的）。
// 沒開模板就只用該卡那組 LoRA 的 trainword 當 prompt（rel 送空字串，後端
// _gen_one_worker 會跳過詞庫載入，只留品質標籤）。
// 唯一的 Concepts 抽卡入口（原本 C／X 兩顆鍵合併——角色/情境的判斷邏輯改成直接看
// LoRA1/LoRA2 現在的樣子之後，兩鍵的差異已經不存在）。角色、情境分別照這個優先序判斷
// （標「跳過」的格子，見 GEN_LORA_SLOT_SKIP，兩步都不看）：
//   ①有格子固定放著符合分類的 LoRA → 鎖定用它，每張卡都一樣，不重新隨機
//   ②沒有固定 LoRA，但有格子的範圍晶片設成符合的分類 → 隨機池縮小到那個範圍
//   ③角色兩者都沒有 → 整個跳過，這次不套角色 LoRA；情境兩者都沒有 → 從全部 concepts 隨機抽
// 情境跟角色不對稱：情境一定會套用一顆（至少全庫隨機），角色只有在有訊號時才套用——
// 這是使用者要的行為，理由是「沒放角色 LoRA 就代表這次不想要角色」，不是「隨便配一個」。
function drawConceptsTarot() {
  const lockedChar = lockedCharacterSlot(), lockedConcept = lockedConceptSlot();
  const charPool = lockedChar ? null : findScopePool('Character');
  const hasCharSignal = !!(lockedChar || charPool);
  const conceptPool = lockedConcept ? null : (findScopePool('HENTAI') || fullConceptsPool());
  if (hasCharSignal && !lockedChar && !charPool.length) { toast('角色範圍內沒有 LoRA 可抽'); return; }
  if (!lockedConcept && !conceptPool.length) { toast('concepts 底下沒有 LoRA 可抽'); return; }
  // 鎖定側的觸發詞要照 LoRA1/2 面板實際勾的段落組（slotTriggerText），不是隨便抓第一段
  // ——這是使用者選了一顆 LoRA 之後，那顆的觸發詞理應完全照面板上勾選的來，跟隨機側
  // 「沒有勾選狀態、只能抓第一段當預設」的情境不一樣（見 _runConceptsDraw 的 firstTw 退場）。
  const pickChar = !hasCharSignal ? null : (lockedChar
    ? () => ({ lora: lockedChar.lora, strength: CONCEPTS_CHAR_STRENGTH, trigger: slotTriggerText(lockedChar) })
    : () => ({ lora: charPool[Math.floor(Math.random() * charPool.length)], strength: CONCEPTS_CHAR_STRENGTH }));
  const pickConcept = lockedConcept
    ? () => ({ lora: lockedConcept.lora, strength: CONCEPTS_KEY_STRENGTH, trigger: slotTriggerText(lockedConcept) })
    : () => ({ lora: conceptPool[Math.floor(Math.random() * conceptPool.length)], strength: CONCEPTS_KEY_STRENGTH });
  _runConceptsDraw(pickChar, pickConcept, CONCEPTS_WITH_TEMPLATE);
}

// Concepts 抽卡核心：pickConcept() 決定「這張卡」的情境 LoRA＋強度（每張卡呼叫一次，
// 讓隨機的一側可以每張卡都不一樣，鎖定的一側每次都回傳同一個）。pickChar 可以是
// null——代表角色沒有訊號、整個跳過，這次每張卡都只套情境 LoRA 一顆。
function _runConceptsDraw(pickChar, pickConcept, withTemplate) {
  // 鎖定了固定模板就不用管隨機池——鎖定自動視同「要抽模板」，checkbox 的狀態在這時候
  // 不重要（不用強制連動去改 UI 上的勾選框，鎖定本身就是更高優先權的判斷）。
  const lockedTpl = CONCEPTS_LOCKED_TEMPLATE;
  const useTemplate = withTemplate || !!lockedTpl;
  // CONCEPTS_TPL_CUR_FOLDER 開著就把隨機模板池鎖在左邊詞庫資料夾列表目前選中的那個
  // （CUR_FOLDER），不是整個 ALL——沿用 E 鍵「本分類」同一份 CUR_FOLDER 狀態，不用
  // 另外做一套詞庫分類選單。有鎖定固定模板時完全不需要這個池，略過檢查。
  const tplPool = lockedTpl ? null : (CONCEPTS_TPL_CUR_FOLDER
    ? ALL.filter(x => (x.folder || '(根目錄)') === CUR_FOLDER)
    : ALL);
  if (useTemplate && !lockedTpl && !tplPool.length) {
    toast(CONCEPTS_TPL_CUR_FOLDER ? `「${CUR_FOLDER || '(根目錄)'}」底下沒有詞庫可抽模板` : '要同時抽詞庫模板，但目前沒有任何詞庫');
    return;
  }
  CONCEPTS_TAROT = true;
  document.body.classList.add('concepts-tarot-open');
  const want = CONCEPTS_COUNT;
  // 隨機側沒有使用者勾選狀態可用，退而求其次只抓第一段當代表；鎖定側呼叫端（pickChar/
  // pickConcept）本來就會帶上照 twPicks 算好的 trigger（見 slotTriggerText），這裡用
  // ?? 不是 ||，是因為「使用者把全部段落都取消勾選」得到的空字串 "" 要保留原樣，不能
  // 被 || 誤判成假值又退回抓第一段。
  const firstTw = (l) => (l.trainedWords || [])[0] || '';
  const jobs = [], picks = [];
  for (let i = 0; i < want; i++) {
    // pickChar 是 null 代表角色沒訊號、整個跳過——這張卡只套情境 LoRA 一顆，loras
    // 陣列長度變成 1（後端 /api/gen 依陣列長度注入 0~2 個 LoraLoader，本來就支援）。
    const charPick = pickChar ? pickChar() : null;
    const { lora: k, strength: kStrength, trigger: kTrigger } = pickConcept();
    const loras = [];
    if (charPick) loras.push({ folder: charPick.lora.folder, file: charPick.lora.file, title: charPick.lora.title || charPick.lora.name, strength: charPick.strength });
    loras.push({ folder: k.folder, file: k.file, title: k.title || k.name, strength: kStrength });
    // 強度 0 等於這顆 LoRA 完全不生效（inject_lora 送 strength_model/clip=0，數學上是
    // no-op），對應的觸發詞就不該還寫進 prompt——使用者拿「設強度 0」當「這次不要套用
    // concepts/character」的手動關閉開關，回報過如果沒濾掉會很意外：明明調成 0 了，
    // prompt 裡卻還看得到那些詞。
    let trigger = joinTriggerParts([
      charPick && charPick.strength > 0 ? (charPick.trigger ?? firstTw(charPick.lora)) : '',
      kStrength > 0 ? (kTrigger ?? firstTw(k)) : '',
    ]);
    let rel = '';
    let label = charPick ? `${charPick.lora.title || charPick.lora.name} × ${k.title || k.name}` : `${k.title || k.name}`;
    if (useTemplate) {
      const t = lockedTpl || tplPool[Math.floor(Math.random() * tplPool.length)];
      rel = t.rel;
      label += ` · ${t.name}`;
    }
    jobs.push({ rel, loras, trigger });
    picks.push({ display_name: label, folder: 'Concepts' });
  }
  runGenJobs(jobs, picks, 'Concepts');
}

// 抽卡生圖：pool/label 未傳＝原本行為（從**全分類**隨機抽 8 個詞庫，R 鍵）；傳了就是
// 分類抽卡生圖（E 鍵／標題旁按鈕），label 會併進塔羅標題。
function drawGenTarot(pool, label) {
  pool = pool || ALL;
  if (!pool.length) { toast(label ? `「${label}」沒有詞庫可抽` : '目前沒有詞庫可抽'); return; }
  const want = isMobile() ? 1 : 8;
  const picks = sampleN(pool, Math.min(want, pool.length));
  runGen(picks.map(x => x.rel), picks, label);
}

// 起一批生圖：每張推進 GALLERY（帶 metadata），並掛 gid 到卡片上；抽卡另開塔羅浮層、
// 手動生圖則切到圖庫視圖。startGenPoll 統一更新卡片：pending 抓 /api/gen-preview 顯示採樣
// 中畫面、done 換成品；同時把 seed/done 回填進 GALLERY 供大圖資訊用。
let _genPoll = null;
const GEN_PENDING = new Set();     // 所有還在生的 gid（跨批次共用一個輪詢，避免第二批把第一批的輪詢頂掉）
async function runGen(rels, tarotItems, label) {
  rels = rels || [...SEL];
  if (!rels.length) return;
  // 只送有選 LoRA 的格子（LoRA 2 常留空，見 selectGenLora）；後端依陣列長度注入 0~2 個
  // LoraLoader（見 preview_ui.py /api/gen）。
  const loras = GEN_LORA_SLOTS.filter(s => s.lora).map(s => (
    { folder: s.lora.folder, file: s.lora.file, title: s.lora.title || s.lora.name, strength: s.strength }));
  const trigger = genTriggerText();
  const payload = { rels, loras: loras.map(l => ({ folder: l.folder, file: l.file, strength: l.strength })), trigger, client: GEN_CLIENT };
  let res;
  try {
    res = await fetch('/api/gen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json());
  } catch (e) { toast('生圖失敗：' + e.message); return; }
  if (res.error) { toast(res.error); return; }
  const items = res.items || [];
  const ts = Date.now();
  for (const it of items) {
    GALLERY.push({ id: it.id, name: it.name, rel: it.rel, folder: (ALL.find(x => x.rel === it.rel) || {}).folder || '',
                   loras, trigger, ts, done: false, err: false, seed: null });
  }
  updateGalleryHead();
  if (tarotItems) {
    openGenTarot(items, tarotItems, label);   // 抽卡：塔羅浮層（圖同時已進圖庫）
    if (GALLERY_OPEN) renderGallery();
  } else if (GALLERY_OPEN) {
    renderGallery();                          // 已在圖庫：直接重繪把新卡帶進來
  } else {
    openGallery();                            // 手動生圖：切到圖庫，新卡在最上方即時長出
  }
  toast(`生圖 ${items.length} 張…`);
  startGenPoll(items.map(x => x.id));
}

// 起一批「各自獨立」的生圖：跟 runGen() 不同，每個 job 自己的 loras/trigger/rel 都可能
// 不一樣（Concepts 抽卡用——8 張卡各自配對不同 LoRA）。永遠走塔羅浮層呈現，沒有
// runGen() 那套「已在圖庫就重繪／否則切圖庫」分支，因為 Concepts 抽卡本來就是抽卡
// 情境，不會有「手動生圖不用塔羅」的用法。
async function runGenJobs(jobs, picks, label) {
  if (!jobs.length) return;
  const payload = {
    jobs: jobs.map(j => ({ rel: j.rel, loras: j.loras.map(l => ({ folder: l.folder, file: l.file, strength: l.strength })), trigger: j.trigger })),
    client: GEN_CLIENT,
  };
  let res;
  try {
    res = await fetch('/api/gen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json());
  } catch (e) { toast('生圖失敗：' + e.message); return; }
  if (res.error) { toast(res.error); return; }
  const items = res.items || [];
  const ts = Date.now();
  items.forEach((it, i) => {
    const job = jobs[i] || {};
    GALLERY.push({ id: it.id, name: it.name, rel: it.rel, folder: (ALL.find(x => x.rel === it.rel) || {}).folder || '',
                   loras: job.loras || [], trigger: job.trigger || '', ts, done: false, err: false, seed: null });
  });
  updateGalleryHead();
  openGenTarot(items, picks, label);
  if (GALLERY_OPEN) renderGallery();
  toast(`生圖 ${items.length} 張…`);
  startGenPoll(items.map(x => x.id));
}

// 生圖抽卡的塔羅呈現：沿用瀏覽抽卡的發牌／翻牌動畫，牌面是生成中的即時預覽而非既有圖。
// 目前塔羅疊層顯示的這一批生圖 gid——「取消生圖」只停這批，不影響使用者更早抽的其他
// 批次（那些已經看不到牌面了，但還在圖庫背景繼續跑，見 runGen/startGenPoll）。每次
// openGenTarot 呼叫都整批換掉，不是累加。
let CUR_GEN_TAROT_IDS = [];
function openGenTarot(items, picks, label) {
  const n = items.length;
  CUR_GEN_TAROT_IDS = items.map(it => it.id);
  const title = document.querySelector('.tarot-title');
  if (title) title.textContent = label ? `✦ ${label}　抽選${CN_NUM[n] || n}張生圖 ✦` : `✦ 抽選${CN_NUM[n] || n}張生圖 ✦`;
  const wrap = $('tarot-cards');
  wrap.classList.remove('ttag');
  $('tarot-stage').classList.remove('ttag-stage');
  $('tarot-cancel-gen').hidden = false;
  $('tarot-hint').textContent = label
    ? '牌面即時顯示生成中的採樣畫面；完成後點卡片看大圖，E 重抽本分類、R 改抽全庫、Esc 關閉'
    : '牌面即時顯示生成中的採樣畫面；完成後點卡片看大圖，R 重抽、Esc 關閉';
  wrap.innerHTML = '';
  items.forEach((it, i) => {
    const item = picks[i] || {};
    const card = document.createElement('div');
    card.className = 'tarot-card gen-card pending';
    card.dataset.gid = it.id;
    card.style.animationDelay = REDUCE ? '0ms' : (i * 48) + 'ms';
    card.innerHTML =
      `<div class="tarot-inner">
         <div class="tarot-back"><span class="tarot-emblem">✦</span></div>
         <div class="tarot-front gen-front">
           <img class="gen-live" decoding="async" alt="" onload="this.classList.add('ld')">
           <div class="gen-spin"><i class="gen-loader"></i></div>
           <div class="tarot-name"></div>
           <div class="tarot-folder"></div>
           <div class="tarot-glare"></div>
         </div>
       </div>`;
    card.querySelector('.tarot-name').textContent = item.display_name || item.name || it.name;
    card.querySelector('.tarot-folder').textContent = item.folder || '(根目錄)';
    card.addEventListener('click', () => { if (!card.classList.contains('pending')) { MODAL_FROM_TAROT = true; openGalleryItem(it.id); } });   // 疊上層，關掉回到這批牌
    if (!REDUCE) {
      card.addEventListener('mousemove', e => tiltCard(card, e));
      card.addEventListener('mouseleave', () => { card.style.transform = ''; });
    }
    wrap.appendChild(card);
  });
  $('tarot').classList.add('open');
  const cards = [...wrap.children];
  if (REDUCE) { cards.forEach(c => c.classList.add('revealed')); return; }
  const dealDone = n * 48 + 220;
  cards.forEach((c, i) => setTimeout(() => c.classList.add('revealed'), dealDone + i * 80));
}

// 更新某 gid 的所有卡片（圖庫＋塔羅），pending 顯示即時預覽、done 換成品、error 標記；
// 並把 done/seed/err 回填進 GALLERY 資料，供大圖資訊面板用。
// 生成完成的「收成」瞬間：方形圖上短促跑一圈 CSS 動畫（見 .just-done/genFinishPop）。
// 只播一次，不需要 remove→reflow→add 那套（CLAUDE.md 提過重複觸發不可靠，但這裡本來
// 就是單次事件，直接加 class＋setTimeout 收尾即可；respect REDUCE_MOTION）。
function triggerFinishFlourish(card) {
  if (REDUCE_MOTION) return;
  const target = card.querySelector('.gc-square, .gen-front');
  if (!target) return;
  target.classList.add('just-done');
  setTimeout(() => target.classList.remove('just-done'), 650);
}

function applyGenState(gid, s) {
  const g = GALLERY.find(x => x.id === gid);
  if (g) {
    if (s.status === 'done') { g.done = true; g.seed = s.seed; }
    else if (s.status === 'error' || s.status === 'cancelled') { g.err = true; }
  }
  const cards = document.querySelectorAll(`[data-gid="${cssAttr(gid)}"]`);
  cards.forEach(card => {
    const img = card.querySelector('img');
    if (s.status === 'done') {
      const wasPending = card.classList.contains('pending');
      card.classList.remove('pending');
      if (img) img.src = '/api/gen-result?id=' + gid;
      if (wasPending) triggerFinishFlourish(card);   // 「收成」瞬間：只在真的從生成中轉為完成時播
    } else if (s.status === 'error' || s.status === 'cancelled') {
      card.classList.remove('pending'); card.classList.add('gr-err');
      const nm = card.querySelector('.gc-name, .gr-name, .tarot-name');
      if (nm && !nm.dataset.tag) { nm.dataset.tag = '1'; nm.textContent += s.status === 'cancelled' ? ' · 已取消' : (' ✕ ' + (s.err || '失敗')); }
    } else if (img && (s.pv || 0) > (+card.dataset.pv || 0)) {
      // 有新的採樣預覽才換 src（pv 遞增），避免每 2s 無謂重載
      card.dataset.pv = s.pv;
      img.src = '/api/gen-preview?id=' + gid + '&v=' + s.pv;
    }
  });
}

// 生圖輪詢間隔：ComfyUI 每個採樣步約 0.5s 送一張預覽，後端即時存進 _gen_preview；
// 前端這裡每 GEN_POLL_MS 抓一次 gen-status，pv 有增才換預覽圖。設 500ms（原本 2000ms）
// 讓即時預覽幾乎追上 ComfyUI 的出幀速度——再快也超不過 ComfyUI 每步一幀的上限。
const GEN_POLL_MS = 500;
function updateCancelAllBtn() {
  const btn = $('gallery-cancel-all'); if (btn) btn.disabled = !GEN_PENDING.size;
}
async function _genTick() {
  if (!GEN_PENDING.size) { _genPoll = null; updateCancelAllBtn(); return; }
  try {
    const st = await fetch('/api/gen-status?ids=' + [...GEN_PENDING].join(',')).then(r => r.json());
    for (const gid of [...GEN_PENDING]) {
      const s = st[gid]; if (!s) continue;
      applyGenState(gid, s);
      if (s.status === 'done' || s.status === 'error' || s.status === 'cancelled') GEN_PENDING.delete(gid);
    }
  } catch (e) { /* 暫時抓失敗就等下一輪 */ }
  updateCancelAllBtn();
  _genPoll = GEN_PENDING.size ? setTimeout(_genTick, GEN_POLL_MS) : null;
}
function startGenPoll(ids) {
  ids.forEach(id => GEN_PENDING.add(id));
  if (!_genPoll) _genPoll = setTimeout(_genTick, 0);   // 自排程單一輪詢；已在跑就沿用
}

// 刷新/關閉這個分頁時，只停掉「這個分頁自己」在途的生圖（帶 GEN_CLIENT），別的分頁照跑。
// 用 sendBeacon 才保證 unload 期間送得出去；只有還有生圖在跑（_genPoll 未清）才送。
// pagehide 不像 visibilitychange 會在切分頁時誤觸。
window.addEventListener('pagehide', () => {
  if (!_genPoll) return;
  try { navigator.sendBeacon('/api/gen-cancel', new Blob([JSON.stringify({ client: GEN_CLIENT })], { type: 'application/json' })); } catch (e) {}
});

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
