let ALL = [];
let CUR_FOLDER = null;      // 目前選中的資料夾;null = 尚未選
let VIEW = 'all';           // all | missing | have
let SEARCH = '';
let RAIL_SEARCH = '';       // 資料夾側欄搜尋
let VISIBLE = [];           // 目前 grid 呈現的清單(供 modal 前後導覽)
const pollers = new Set();
const REDUCE_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = id => document.getElementById(id);

async function loadAll() {
  const r = await fetch('/api/libs');
  const j = await r.json();
  ALL = j.items;
  const conn = $('conn');
  conn.classList.toggle('on', !!j.comfy);
  $('conn-text').textContent = j.comfy ? `ComfyUI 就緒 · steps ${j.steps}` : 'ComfyUI 未連線';
  const total = ALL.length, have = ALL.filter(x => x.has_image).length;
  $('total-tag').textContent = `${have}/${total} 已生成`;
  if (CUR_FOLDER === null) {
    const folders = folderStats();
    CUR_FOLDER = folders.length ? folders[0].name : '';
  }
  buildRail();
  render();
  for (const it of ALL)
    if (it.job && (it.job.status === 'queued' || it.job.status === 'running')) pollStatus(it.rel);
}

function folderStats() {
  const map = new Map();
  for (const x of ALL) {
    const f = x.folder || '(根目錄)';
    if (!map.has(f)) map.set(f, { name: f, total: 0, have: 0 });
    const s = map.get(f); s.total++; if (x.has_image) s.have++;
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
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

function currentList() {
  let list;
  if (SEARCH) {
    const q = SEARCH.toLowerCase();
    list = ALL.filter(x => x.name.toLowerCase().includes(q) || (x.folder || '').toLowerCase().includes(q));
  } else {
    list = ALL.filter(x => (x.folder || '(根目錄)') === CUR_FOLDER);
  }
  if (VIEW === 'missing') list = list.filter(x => !x.has_image);
  else if (VIEW === 'have') list = list.filter(x => x.has_image);
  return list;
}

function render() {
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

function cardOf(it) {
  const el = document.createElement('div');
  el.className = 'card' + (it.has_image ? '' : ' missing');
  el.dataset.rel = it.rel;
  const relEnc = encodeURIComponent(it.rel);
  const thumbHtml = it.has_image
    ? `<span class="badge has">已生成</span><img loading="lazy" decoding="async" width="360" height="360" src="/api/thumb?rel=${relEnc}&v=${it.image_mtime}" alt="">`
    : `<span class="badge">未生成</span><div class="empty">${ICON_EMPTY}<span>尚無圖片</span></div>`;
  el.innerHTML = `
    <div class="thumb">${thumbHtml}</div>
    <div class="card-body">
      <div class="card-name"></div>
      ${SEARCH ? '<div class="card-folder"></div>' : ''}
    </div>
    <div class="status"></div>
    <div class="card-actions">
      <button class="gen-btn">${it.has_image ? '重新生成' : '生成'}</button>
    </div>`;
  el.querySelector('.card-name').textContent = it.name;
  if (SEARCH) el.querySelector('.card-folder').textContent = it.folder || '(根目錄)';
  el.querySelector('.thumb').onclick = () => openModal(it.rel);
  el.querySelector('.gen-btn').onclick = (e) => { e.stopPropagation(); generate(it.rel); };
  if (it.job && it.job.status) updateStatusEl(el.querySelector('.status'), it.job);
  return el;
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
  card.classList.remove('missing');
  const thumb = card.querySelector('.thumb');
  thumb.innerHTML = `<span class="badge has">已生成</span><img loading="lazy" decoding="async" width="360" height="360" src="/api/thumb?rel=${encodeURIComponent(rel)}&v=${Date.now()}" alt="">`;
  thumb.onclick = () => openModal(rel);
  const btn = card.querySelector('.gen-btn');
  if (btn) btn.textContent = '重新生成';
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
  $('modal-title').textContent = item.name;
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
$('rescan').onclick = loadAll;
$('menu-btn').onclick = () => $('rail').classList.toggle('open');

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
  if (!$('modal').classList.contains('open')) return;
  if (e.key === 'Escape') closeModal();
  else if (e.key === 'ArrowLeft') modalStep(-1);
  else if (e.key === 'ArrowRight') modalStep(1);
});

loadAll().then(() => pollBatch());
