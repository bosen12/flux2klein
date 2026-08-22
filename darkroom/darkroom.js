let ALL = [];
let CUR_FOLDER = null;      // 目前選中的資料夾;null = 尚未選
let ALL_FOLDERS = false;    // 「全部」釘選項是否啟用（跨資料夾看全部詞庫，不靠搜尋）
let VIEW = 'all';           // all | missing | have
let RARITY_FILTER = 'all';  // all | untagged | common | rare | special | legendary
let SCORE_FILTER = 'all';   // all | lt4 | mid | gte7（見 scoreBandOf，跟評分面板的區間門檻不同，這裡照使用者要求分 <4/4~7/>=7）
let SEARCH = '';
let RAIL_SEARCH = '';       // 資料夾側欄搜尋
let TAG_QUERY = '';         // 標籤搜尋原始輸入（逗號分隔多個）
let TAG_MATCH_SET = null;   // 標籤搜尋結果：Set(rel)，null = 未啟用標籤篩選
let VISIBLE = [];           // 目前 grid 呈現的清單(供 modal 前後導覽)
const pollers = new Set();
const REDUCE_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = id => document.getElementById(id);

// 疊層開關：display:none 的 overlay 關掉時 CSS 過渡播不完（拿掉 .open 畫面立刻沒了），
// 所以關閉一律走 WAAPI 先淡出、再拆 class。開啟時要取消進行中的關閉，不然 160ms 後
// finish() 會把剛打開的疊層又關掉。分頁在背景時 finished 不結算（CLAUDE.md 老坑），
// 另用 setTimeout 保險。inner 可省略（只淡外層）；onDone 在拿掉 .open 之後呼叫。
function cancelOverlayClose(el) {
  if (!el) return;
  el._closeGen = (el._closeGen || 0) + 1;
  delete el.dataset.closing;
  if (el.getAnimations) el.getAnimations().forEach(a => a.cancel());
}
function overlayOpen(el) {
  cancelOverlayClose(el);
  el.classList.add('open');
}
function fadeCloseOverlay(el, inner, onDone) {
  if (!el || !el.classList.contains('open') || el.dataset.closing === '1') return;
  const gen = (el._closeGen = (el._closeGen || 0) + 1);
  el.dataset.closing = '1';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (el._closeGen !== gen) return;
    delete el.dataset.closing;
    el.classList.remove('open');
    if (onDone) onDone();
  };
  if (REDUCE_MOTION || document.visibilityState !== 'visible' || !el.animate) {
    finish();
    return;
  }
  const ease = 'cubic-bezier(.4,0,1,1)';   // --ease-in，退場快走
  const opt = { duration: 160, easing: ease, fill: 'forwards' };  // forwards：結束停在透明，避免拆 class 前閃一幀
  const anims = [el.animate([{ opacity: 1 }, { opacity: 0 }], opt)];
  if (inner) anims.push(inner.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }],
    opt));
  Promise.all(anims.map(a => a.finished)).then(finish).catch(finish);
  setTimeout(finish, 260);
}

// ── ALL 的索引層 ───────────────────────────────────────────────
// 實測詞庫規模約 28000 筆，任何 `itemOf(rel)` 都是一次全庫線性掃描。
// 最痛的是 restoreCard()——超大範圍（「全部」/跨資料夾搜尋）啟用卡片修剪後，每張卡片
// 捲回視野都要查一次，等於在捲動的每一幀裡做 28000 次字串比較。改用 Map 查表。
let BY_REL = new Map();
const itemOf = rel => BY_REL.get(rel);
// 資料夾統計（folderStats）快取：那是一次 28000 筆的分組 + 排序，而 buildRail() 在
// 左欄搜尋的每一次按鍵都會呼叫。只有「ALL 換一份」或「有圖狀態改變」會讓它失真。
let _folderStatsCache = null;
function invalidateFolderStats() { _folderStatsCache = null; }
// baseList() 的「範圍」快取：一次 render() 裡 updateStats()/buildRarityBar() 等會各算
// 一次，搜尋時每次都是 28000 筆 filter。快取只涵蓋依 rel/name/folder（永不變動的欄位）
// 決定的範圍篩選；has_image / rarity / flagged 這些會就地變動的欄位是在 currentList()
// 才篩的，不進快取，所以標記／生成完成不會讓它失真。
let _baseCache = null, _baseKey = '', _baseTagSet = null;
function invalidateBaseList() { _baseCache = null; }

function indexAll() {
  BY_REL = new Map();
  for (const x of ALL) {
    BY_REL.set(x.rel, x);
    // 搜尋用的小寫鍵先算好存著：baseList() 與跳轉搜尋都是每按一鍵掃全庫，現算
    // toLowerCase() 等於每一鍵配置五萬多個暫時字串，光 GC 就足以讓輸入卡頓。
    x._lname = x.name.toLowerCase();
    x._lfolder = (x.folder || '').toLowerCase();
  }
  invalidateFolderStats();
  invalidateBaseList();
}
// 滾動數字：見 darkroom.css .count-num（CSS counter 補間，這裡只需要設 --n）。
const setCount = (el, value) => { if (el) el.style.setProperty('--n', String(value)); };

// 縮圖網址。displayPx 給了就依「實際顯示尺寸 × devicePixelRatio」跟後端要對應級距的
// 縮圖（見 preview_ui.py 的 THUMB_SIZES）——不給就是後端預設的 360px，格線／塔羅／
// LoRA 面板都走這條，行為不變。
function thumbURL(it, displayPx) {
  const u = `/api/thumb?rel=${encodeURIComponent(it.rel)}&v=${it.image_mtime}`;
  if (!displayPx) return u;
  return u + '&w=' + Math.round(displayPx * (window.devicePixelRatio || 1));
}

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
  indexAll();
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
      if (saved.allFolders === true) ALL_FOLDERS = true;
      if (typeof saved.tagQuery === 'string' && saved.tagQuery) {
        $('tag-search').value = saved.tagQuery;
        $('tag-search-clear').style.display = '';
        runTagSearch(saved.tagQuery);   // 非同步；resolve 後自己會再 buildRail()/render()
      }
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
  // 快取的是「升冪那份」；RAIL_DESC 只影響回傳順序，不同方向切換不必重算。回傳前
  // 複製一份再 reverse，避免呼叫端拿到的陣列跟快取是同一個物件而被就地改動。
  if (_folderStatsCache) return RAIL_DESC ? _folderStatsCache.slice().reverse() : _folderStatsCache;
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
  _folderStatsCache = arr;
  return RAIL_DESC ? arr.slice().reverse() : arr;
}
let RAIL_DESC = localStorage.getItem('yz-rail-desc') === '1';   // 資料夾排序方向（預設升冪）

let _railSig = '';
function buildRail() {
  const list = $('rail-list');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();

  // 「全部」固定釘在最上面，不受 RAIL_SEARCH（資料夾名稱篩選）影響——資料夾清單
  // 本身沒有代表「不篩資料夾」的項目，點了某個資料夾之後除了重打一次搜尋字串
  // 沒有別的路能回到跨資料夾的全部範圍，加這顆給明確、常駐的入口。
  const totalAll = ALL.length, haveAll = ALL.filter(x => x.has_image).length;
  const pctAll = totalAll ? Math.round(haveAll / totalAll * 100) : 0;
  const allBtn = document.createElement('button');
  allBtn.className = 'folder folder-all' + (ALL_FOLDERS && !SEARCH && !TAG_MATCH_SET ? ' active' : '');
  allBtn.innerHTML = `
    <div class="folder-top">
      <span class="folder-idx">${ICON_SPARKLE}</span>
      <span class="folder-name">全部</span>
      <span class="folder-count">${haveAll}/${totalAll}</span>
    </div>
    <div class="cover${haveAll === totalAll && totalAll > 0 ? ' full' : ''}"><span style="width:${pctAll}%"></span></div>`;
  allBtn.onclick = () => withTransition(() => {
    ALL_FOLDERS = true; SEARCH = ''; $('search').value = '';
    TAG_QUERY = ''; TAG_MATCH_SET = null; tagSearchReq++;
    $('tag-search').value = ''; $('tag-search-clear').style.display = 'none';
    buildRail(); render(); $('main').scrollTop = 0;
  });
  frag.appendChild(allBtn);

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
    b.className = 'folder' + (s.name === CUR_FOLDER && !SEARCH && !TAG_MATCH_SET && !ALL_FOLDERS ? ' active' : '');
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
    b.onclick = () => withTransition(() => {
      CUR_FOLDER = s.name; ALL_FOLDERS = false; SEARCH = ''; $('search').value = '';
      TAG_QUERY = ''; TAG_MATCH_SET = null; tagSearchReq++;
      $('tag-search').value = ''; $('tag-search-clear').style.display = 'none';
      buildRail(); render(); $('main').scrollTop = 0;
    });
    frag.appendChild(b);
  });
  list.appendChild(frag);
}

// 只套資料夾／搜尋範圍（不含 view 與稀有度篩選）——稀有度分布數就是算這個
//
// 名稱搜尋／標籤搜尋都改成「跟著左欄目前選的資料夾走」：選了某個資料夾就只在
// 該資料夾裡搜，點「全部」才是跨資料夾搜尋。左欄選資料夾／點「全部」本來就會
// 清空搜尋框，所以「先選範圍、再輸入關鍵字」是既有操作順序，這裡只是讓搜尋
// 真的尊重那個選擇，而不是不管選了什麼都跨資料夾。
function baseList() {
  const key = SEARCH + '\u0000' + CUR_FOLDER + '\u0000' + (ALL_FOLDERS ? '1' : '0');
  if (_baseCache && _baseKey === key && _baseTagSet === TAG_MATCH_SET) return _baseCache;
  let list = (!ALL_FOLDERS && CUR_FOLDER !== null)
    ? ALL.filter(x => (x.folder || '(根目錄)') === CUR_FOLDER)
    : ALL;
  if (SEARCH) {
    const q = SEARCH.toLowerCase();
    list = list.filter(x => x._lname.includes(q) || x._lfolder.includes(q));
  }
  if (TAG_MATCH_SET) list = list.filter(x => TAG_MATCH_SET.has(x.rel));
  _baseCache = list; _baseKey = key; _baseTagSet = TAG_MATCH_SET;
  return list;
}

// 評分篩選用的區間門檻——使用者要求 <4 / 4~7 / >=7 / >=8，跟大圖 modal 評分
// 面板上色用的 5.5/7.5 門檻是兩件事，各自獨立，不要混用。>=8 是 >=7 的子集
// （不是互斥分段），刻意設計成獨立小旗標而非切分區間——使用者是額外要一顆
// 「更嚴格」的快速篩選，不是要把 >=7 拆成兩段。
const SCORE_BAND_PREDICATES = {
  lt4:  s => s.final < 4,
  mid:  s => s.final >= 4 && s.final < 7,
  gte7: s => s.final >= 7,
  gte8: s => s.final >= 8,
};
function scoreMatchesFilter(it, key) {
  return !!it.score && typeof it.score.final === 'number' && SCORE_BAND_PREDICATES[key](it.score);
}
function currentList() {
  let list = baseList();
  if (VIEW === 'missing') list = list.filter(x => !x.has_image);
  else if (VIEW === 'have') list = list.filter(x => x.has_image);
  if (SCORE_FILTER !== 'all') list = list.filter(x => scoreMatchesFilter(x, SCORE_FILTER));
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
  buildScoreBar(bar, base);
}

// 評分分布晶片，接在稀有度分布條同一排後面（使用者原話「這裡也要有分數」，
// 指的就是這個條）。門檻跟 SCORE_BAND_PREDICATES 一致：<4 / 4~7 / >=7 / >=8，
// 跟大圖 modal 評分面板上色用的 5.5/7.5 是兩件事，不要搞混。>=8 是 >=7 的子集
// （見 SCORE_BAND_PREDICATES 註解），四顆晶片的數量因此不會剛好加總等於已評分
// 總數，是預期行為，不是算錯。沒有分數的卡片不計入任何一桶。
const SCORE_BAR_DEFS = [['lt4', '<4分'], ['mid', '4~7分'], ['gte7', '≥7分'], ['gte8', '≥8分']];
function buildScoreBar(bar, base) {
  const cnt = { lt4: 0, mid: 0, gte7: 0, gte8: 0 };
  for (const x of base) {
    for (const key in cnt) { if (scoreMatchesFilter(x, key)) cnt[key]++; }
  }
  if (SCORE_FILTER !== 'all' && !cnt[SCORE_FILTER]) SCORE_FILTER = 'all';
  if (!cnt.lt4 && !cnt.mid && !cnt.gte7) return;   // 這個範圍完全沒有評分過的卡片，不顯示這排晶片
  const sep = document.createElement('span'); sep.className = 'rc-sep'; sep.setAttribute('aria-hidden', 'true');
  bar.appendChild(sep);
  SCORE_BAR_DEFS.forEach(([key, label]) => {
    if (!cnt[key]) return;
    const b = document.createElement('button');
    b.className = 'rar-chip sc-chip sc-' + key + (SCORE_FILTER === key ? ' on' : '');
    b.innerHTML = `<span class="rc-dot"></span><span class="rc-label">${label}</span><span class="rc-count">${cnt[key]}</span>`;
    b.onclick = () => withTransition(() => { SCORE_FILTER = (SCORE_FILTER === key ? 'all' : key); render(); });
    const pct = base.length ? Math.round(cnt[key] / base.length * 100) : 0;
    b.addEventListener('mouseenter', () => showStatTip(b, `佔目前範圍 ${pct}%（${cnt[key]}／${base.length}）`));
    b.addEventListener('mouseleave', () => hideTwTip(b));
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
    $('mt-name').textContent = TAG_QUERY ? `搜尋:「${SEARCH}」+ 標籤「${TAG_QUERY}」` : `搜尋:「${SEARCH}」`;
  } else if (TAG_MATCH_SET) {
    $('mt-num').textContent = '';
    $('mt-name').textContent = `標籤:「${TAG_QUERY}」`;
  } else if (ALL_FOLDERS) {
    $('mt-num').textContent = '';
    $('mt-name').textContent = '全部';
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
    localStorage.setItem('yz-view-state', JSON.stringify({ folder: CUR_FOLDER, search: SEARCH, view: VIEW, rarity: RARITY_FILTER, tagQuery: TAG_QUERY, allFolders: ALL_FOLDERS }));
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
  if (_pruneIO) { _pruneIO.disconnect(); _pruneIO = null; }
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
        e.target.style.transitionDelay = (Math.min(i, 12) * REVEAL_STAGGER) + 'ms';
        e.target.classList.add('in');
        _revealIO.unobserve(e.target);
        settleReveal(e.target, Math.min(i, 12) * REVEAL_STAGGER);
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
let _rendered = 0, _io = null, _revealIO = null, _pruneIO = null;

const REVEAL_STAGGER = 30;   // ms/張，最多 12 張份（見 _revealIO）
const REVEAL_DUR = 440;      // = CSS --d-enter，.card.reveal.in 的過渡時長
// 進場動畫「收尾」：把 .reveal/.in 與 inline transition-delay 一併拆掉。
// 這一步不是可有可無的清理——不拆的話有兩個看得見的後果：
//   ① inline 的 transition-delay 對這個元素上「所有」過渡都生效，於是進場排在後面的
//      卡片，之後每次 hover 都要先等 0.36 秒才會浮起來，感覺像頁面在卡；
//   ② .card.reveal.in 自帶的 transition 清單（只有 opacity/transform）比 .card 的
//      基礎清單更具體，會蓋掉它，hover 的邊框色與陰影因此完全沒有過渡、直接跳色。
// 依 CLAUDE.md 的教訓不靠 transitionend 收尾（分頁在背景時 rAF 不跑、事件永遠不結算），
// 直接用 setTimeout 算好時間拆。
function settleReveal(card, delay) {
  setTimeout(() => {
    card.classList.remove('reveal', 'in');
    card.style.transitionDelay = '';
  }, delay + REVEAL_DUR + 60);
}

// 全庫瀏覽／跨資料夾搜尋時 VISIBLE 可能有上萬筆，appendPage() 只增不減會讓 DOM 裡
// 累積的縮圖（解碼後的點陣圖）越捲越多、越捲越頓。只在筆數超過 AUTO_LOAD_CAP（跟
// 「自動載入上限」同一個門檻——一般資料夾最大 ~400 筆，完全不會觸發）時才啟用：
// 卡片捲出很遠（rootMargin 遠大於進場觀察器）就清空 .thumb 內部（圖片/按鈕/監聽器），
// 只留外層 .card 這個 wrapper（data-rel、selected/flagged/favorited/rar-* 這些 class
// 都掛在它身上，見 cardOf()），捲回來再用 thumbInnerHTML()/wireThumb() 重建。
// .thumb 本身用 aspect-ratio:1/1 固定佔位（見 darkroom.css），清空內容不會讓格線
// 跳動，不需要另外做 spacer 或處理捲動位置。
// 外層 class 一直是即時同步的（toggleFlag/toggleFav 等都直接操作 wrapper 的
// classList，不管卡片有沒有被修剪都照常運作），修剪/還原完全不用碰它們。
function ensurePruneIO() {
  if (_pruneIO || VISIBLE.length <= AUTO_LOAD_CAP) return;
  _pruneIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) restoreCard(e.target);
      else pruneCard(e.target);
    }
  }, { root: $('main'), rootMargin: '2400px 0px' });
}
function pruneCard(card) {
  if (card.classList.contains('pruned')) return;
  const thumb = card.querySelector('.thumb');
  if (!thumb) return;
  thumb.onclick = null;
  thumb.innerHTML = '';
  card.classList.add('pruned');
}
function restoreCard(card) {
  if (!card.classList.contains('pruned')) return;
  const it = itemOf(card.dataset.rel);
  if (!it) return;   // 極少數情況：修剪期間這筆資料被移除（例如重掃後消失），留空等下次 render() 清掉
  const thumb = card.querySelector('.thumb');
  if (thumb) {
    thumb.classList.toggle('loading', !!it.has_image);
    thumb.innerHTML = thumbInnerHTML(it);
    wireThumb(thumb, it);
    // 圖是瀏覽器快取的（多半是——同一個 URL 之前就載過），onload 可能不會再等一輪
    // 事件迴圈才觸發，這裡跟塔羅牌面同一招：載完就是載完，不用等微光空轉一輪才發現。
    const img = thumb.querySelector('img');
    if (img && img.complete && img.naturalWidth) thumb.classList.remove('loading');
  }
  card.classList.remove('pruned');
}

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
  const cards = [];
  slice.forEach((it) => {
    const card = cardOf(it);
    cards.push(card);
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
    // 走這條路的卡片沒有經過 _revealIO，也就沒人幫它們收尾，要自己補 settleReveal()，
    // 不然 .reveal.in 會永久留著、把 hover 的過渡蓋掉（見 settleReveal 的說明）。
    setTimeout(() => fresh.forEach(c => {
      if (!c.classList.contains('reveal')) return;   // 已經進場並收尾過了
      c.classList.add('in');
      settleReveal(c, 0);
    }), 2500);
  }
  ensurePruneIO();
  if (_pruneIO) cards.forEach(c => _pruneIO.observe(c));
  _rendered += slice.length;
  if (_rendered >= VISIBLE.length && _io) {
    _io.disconnect(); _io = null;
    const s = $('scroll-sentinel'); if (s) s.remove();
  }
}

const ICON_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m21 15-5-5L5 21"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.1l2.63 5.33 5.88.85-4.25 4.15 1 5.86L12 16.79 6.74 19.6l1-5.86L3.49 9.28l5.88-.85z"/></svg>';

// 全站按鈕圖示——統一走這套 line-icon 風格（viewBox 0 0 24 24、stroke=currentColor、
// stroke-width=2），不用表情符號：不同系統/字型算繪出來色調、粗細都不一致，跟
// brand-logo 那個線條羅盤圖示放在一起會很突兀。這裡集中定義，按鈕/JS 動態文字
// 都從這裡取用，不要各自散著寫字面 emoji。
const ICON_MENU = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';
const ICON_FLAG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4"/><path d="M5 4h13l-2.5 4L18 12H5"/></svg>';
const ICON_GALLERY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m21 15-5-5L5 21"/></svg>';
const ICON_DNA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4c0 4 12 4 12 8s-12 4-12 8"/><path d="M18 4c0 4-12 4-12 8s12 4 12 8"/><line x1="7.5" y1="7.3" x2="16.5" y2="7.3"/><line x1="7.5" y1="16.7" x2="16.5" y2="16.7"/></svg>';
const ICON_SETTINGS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
const ICON_SPARKLE = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M12 2c.6 3.6 2.2 6 6 6.6-3.8.6-5.4 3-6 6.6-.6-3.6-2.2-6-6-6.6 3.8-.6 5.4-3 6-6.6z"/></svg>';
const ICON_TAG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.24L4 3a1 1 0 0 0-1 1l.24 5.59a2 2 0 0 0 .59 1.41l9.58 9.59a2 2 0 0 0 2.83 0l4.35-4.35a2 2 0 0 0 0-2.83Z"/><circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" stroke="none"/></svg>';
const ICON_PALETTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22a9.4 9.4 0 0 1 0-18.8A8.4 8.4 0 0 1 20.4 11.6c0 1.5-1.2 2.7-2.7 2.7h-1.5a1.7 1.7 0 0 0-1 3c.4.3.6.7.6 1.1 0 1.5-1.4 2.7-2.9 2.6z"/><circle cx="7.6" cy="10.2" r="1.1" fill="currentColor" stroke="none"/><circle cx="11.5" cy="6.8" r="1.1" fill="currentColor" stroke="none"/><circle cx="16" cy="8.5" r="1.1" fill="currentColor" stroke="none"/></svg>';
const ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>';
const ICON_STAR_OUTLINE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.1l2.63 5.33 5.88.85-4.25 4.15 1 5.86L12 16.79 6.74 19.6l1-5.86L3.49 9.28l5.88-.85z"/></svg>';
const ICON_DICE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.3" cy="8.3" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.7" cy="8.3" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="8.3" cy="15.7" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.7" cy="15.7" r="1.2" fill="currentColor" stroke="none"/></svg>';
const ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const ICON_ARROW_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
const ICON_ARROW_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>';
const RARITY_LABEL = { common: '普通', rare: '稀有', special: '特別', legendary: '傳奇' };
const rarTag = (r) => r ? `<span class="rar-tag ${r}">${RARITY_LABEL[r] || ''}</span>` : '';
// 徽章光環門檻——使用者原話「6.5到7.5用淺藍，7.5以上淺紫」，跟大圖 modal
// 上色（5.5/7.5）、評分分布晶片（4/7/8）都是各自獨立的門檻，三套系統故意
// 不共用，各自服務不同情境（modal 是「這張好不好」、分布晶片是「篩選範圍」、
// 這裡是「縮圖上一眼認出高分」），不要為了統一而互相牽動。
function scoreHaloBand(final) {
  if (typeof final !== 'number') return '';
  if (final >= 7.5) return 'halo-purple';
  if (final >= 6.5) return 'halo-blue';
  return '';
}
const scoreBadgeHTML = (score) => (score && typeof score.final === 'number')
  ? `<span class="score-badge ${scoreHaloBand(score.final)}" tabindex="0" role="button" aria-label="評分明細：${score.final.toFixed(1)} 分">${score.final.toFixed(1)}</span>`
  : '';
function scoreDetailHTML(score) {
  return `<div class="score-tip-row"><b>加權總分</b><b>${score.final.toFixed(2)}</b></div>
    <div class="score-tip-row"><span>Blackroot</span><span>${score.blackroot.toFixed(2)}</span></div>
    <div class="score-tip-row"><span>Waifu Scorer</span><span>${score.waifu.toFixed(2)}</span></div>
    <div class="score-tip-row"><span>Kawai</span><span>${score.kawai_tier} · ${score.kawai_score.toFixed(2)}</span></div>`;
}
function scoreBand(final) {
  if (typeof final !== 'number') return '';
  if (final >= 7.5) return 'high';
  if (final >= 5.5) return 'mid';
  return 'low';
}
// 光度計風格的單一子分數列：標籤 + 細長度量條（0~10 對應 0~100%）+ 數值。
// track 一律用安全燈琥珀色（跟三個子分數本身的高低無關，那是總分光環的事），
// 呼應暗房既有的曝光表視覺語言。三列的數值欄一律是同一種 0~10 格式的數字
// （對齊、等寬），Kawai 額外的分級（tier）用獨立的小徽章附在數字後面，不
// 混進數值本身——原本 Kawai 那列顯示「B · -0.35」，跟另外兩列的純數字格式
// 不一樣，掃視起來像是三列裡「壞掉的那一列」，其實只是資訊塞太多。
function scoreMeterRowHTML(label, val10, tier) {
  const v = Number(val10) || 0;
  const pct = Math.max(0, Math.min(100, v / 10 * 100));
  const tierBadge = tier ? `<span class="score-meter-tier">${tier}</span>` : '';
  return `<div class="score-meter">
    <span class="score-meter-lbl">${label}</span>
    <span class="score-meter-track"><span class="score-meter-fill" style="width:${pct}%"></span></span>
    <span class="score-meter-val">${v.toFixed(2)}${tierBadge}</span>
  </div>`;
}
// openModal()／openGalleryItem() 共用：大圖 modal 的評分明細面板——「光度計」造型，
// 總分是一圈依分數比例填色的光環（呼應 #boot 開機畫面的 .boot-ring 同一種
// conic-gradient 遮罩手法）包著大數字，下面三條細量條是子分數，取代原本純文字
// key-value 列表（那個版本標籤欄位固定 52px，"Waifu Scorer" 這種較長的英文標籤會
// 被擠成兩行，且三個分數視覺權重完全一樣，掃視不出總分/子分的主從關係）。
function modalScoreRowsHTML(score) {
  if (!score || typeof score.final !== 'number') {
    return `<div class="score-panel score-panel-empty">
      <span class="score-empty-dot" aria-hidden="true"></span>
      <span class="score-empty-txt">尚未評分</span>
    </div>`;
  }
  const band = scoreBand(score.final);
  const pct = Math.max(0, Math.min(100, score.final / 10 * 100));
  // 儀表板佈局：大光環在左（一眼看到加權總分），右邊是小標題＋三條細量條，
  // 取代原本「光環+標籤」一列、量條另起一段的上下堆疊——那個版本兩塊視覺上
  // 各自獨立，看不出主從關係，現在光環直接錨定整個面板左側，右邊三條線是
  // 從屬細節，一眼就懂「一個總分，三個子分數撐出來的」。
  return `<div class="score-panel score-panel-${band}" style="--score-pct:${pct}%">
    <span class="score-dial" aria-hidden="true">
      <span class="score-dial-ring"></span>
      <span class="score-dial-num">${score.final.toFixed(2)}</span>
    </span>
    <div class="score-body">
      <div class="score-dial-lbl">加權總分</div>
      <div class="score-meters">
        ${scoreMeterRowHTML('Blackroot', score.blackroot)}
        ${scoreMeterRowHTML('Waifu', score.waifu)}
        ${scoreMeterRowHTML('Kawai', score.kawai_norm, score.kawai_tier)}
      </div>
    </div>
  </div>`;
}
let SCORE_TIP_EL = null;
function ensureScoreTip() {
  if (SCORE_TIP_EL) return SCORE_TIP_EL;
  SCORE_TIP_EL = document.createElement('div');
  SCORE_TIP_EL.className = 'score-tip';
  document.body.appendChild(SCORE_TIP_EL);
  return SCORE_TIP_EL;
}
function showScoreTip(anchor, score) {
  if (!score) return;
  const tip = ensureScoreTip();
  tip.innerHTML = scoreDetailHTML(score);
  const r = anchor.getBoundingClientRect();
  const w = 180;
  let left = r.left;
  if (left + w > window.innerWidth) left = window.innerWidth - w - 8;
  tip.style.left = Math.max(8, left) + 'px';
  tip.style.top = (r.bottom + 8) + 'px';
  tip.classList.add('show');
}
function hideScoreTip() {
  if (SCORE_TIP_EL) SCORE_TIP_EL.classList.remove('show');
}
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
  // 圖還沒載入時 .thumb 跑跟塔羅牌面（.tarot-front.loading）同一套微光——共用
  // tarotShimmer 這個 keyframe，不重新定義一份。onload/onerror 都要收掉 loading
  // （失敗也不能讓微光一直轉，見 CLAUDE.md「hover 泡泡」那條同類型的教訓：載入
  // 狀態一定要有明確的收尾，不能只處理成功路徑）。
  // src 故意不直接填（存 data-src），交給 wireThumb() 掛上跟 LoRA 預覽同一套併發
  // 佇列（見 makeLoraPreviewEl 那則長註解）——單靠 <img loading="lazy"> 實測還是會在
  // 虛擬捲動快速跳動、大量卡片一次進入緩衝範圍時同時觸發，把上傳頻寬擠爆。
  const media = it.has_image
    ? `<img decoding="async" width="360" height="360" data-src="/api/thumb?rel=${relEnc}&v=${it.image_mtime}" alt="" onload="this.classList.add('ld');this.closest('.thumb').classList.remove('loading')" onerror="this.closest('.thumb').classList.remove('loading')">`
    : `<div class="empty">${ICON_EMPTY}<span>尚無圖片</span></div>`;
  return `${media}` +
    (it.rarity === 'legendary' ? sparklesHTML() : '') +
    rarTag(it.rarity) +
    scoreBadgeHTML(it.score) +
    `<button class="fav-btn" type="button" aria-label="收藏" aria-pressed="${it.favorited ? 'true' : 'false'}">${ICON_STAR}</button>` +
    `<span class="pick-box" aria-hidden="true"></span>` +
    `<span class="flag-x" aria-hidden="true">${ICON_CLOSE}</span>` +
    `<button class="gen-btn">${it.has_image ? '重新生成' : '生成'}</button>`;
}

function wireThumb(thumb, it) {
  // thumbInnerHTML() 把 img 的下載來源存在 data-src，這裡才真的掛上「捲到才排隊
  // 下載」（跟 LoRA 預覽共用同一套 _loraPreviewIO／併發佇列，見 makeLoraPreviewEl）。
  const thumbImg = thumb.querySelector('img[data-src]');
  if (thumbImg) _loraPreviewIO.observe(thumbImg);
  // 點縮圖：打標模式＝選取；瀏覽的篩選模式＝標記紅叉；瀏覽平常＝開大圖。
  thumb.onclick = () => {
    if (MODE === 'tag' || MODE === 'gen') toggleSel(it.rel, thumb.closest('.card'));
    else if (SELECTING) toggleFlag(it.rel);
    else openModalFromThumb(it.rel, thumb.querySelector('img'));
  };
  thumb.querySelector('.gen-btn').onclick = (e) => { e.stopPropagation(); generate(it.rel); };
  thumb.querySelector('.fav-btn').onclick = (e) => { e.stopPropagation(); toggleFav(it.rel); };
  const badge = thumb.querySelector('.score-badge');
  if (badge) {
    badge.addEventListener('mouseenter', () => showScoreTip(badge, it.score));
    badge.addEventListener('mouseleave', hideScoreTip);
    badge.addEventListener('click', (e) => { e.stopPropagation(); showScoreTip(badge, it.score); });
    badge.addEventListener('focus', () => showScoreTip(badge, it.score));
    badge.addEventListener('blur', hideScoreTip);
  }
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
    <div class="thumb${it.has_image ? ' loading' : ''}">${thumbInnerHTML(it)}</div>
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
  const it = itemOf(rel);
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
    toast('標記失敗：' + e.message, true);
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
  const it = itemOf(rel);
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
    toast('收藏失敗：' + e.message, true);
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
  if (j.error) { toast(j.error, true); return; }
  const it = itemOf(rel);
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
      const it = itemOf(rel);
      if (it) it.job = job;
      const card = document.querySelector(`.card[data-rel="${cssAttr(rel)}"]`);
      if (card) updateStatusEl(card.querySelector('.status'), job);
      const mstat = $('modal-status');
      if (mstat && mstat.dataset.rel === rel) updateStatusEl(mstat, job);
      if (job.status === 'done' || job.status === 'error') {
        if (job.status === 'done') {
          if (it) { it.has_image = true; it.image_mtime = Math.floor(Date.now() / 1000); }
          invalidateFolderStats();   // 「有圖」數變了，左欄的 have/total 與覆蓋率條要重算
          reloadThumb(rel); reloadModalImage(rel); buildRail();
          pollScoreAfterGenerate(rel);   // 評分是背景另起的 thread，圖片完成當下分數通常還沒算完
        }
        break;
      }
      await sleep(1500);
    }
  } finally { pollers.delete(rel); }
}

// 瀏覽模式生成/重新生成完成後，分數通常還要再等幾秒（背景評分 thread 才剛起步），
// 用單筆查詢（/api/score）輪詢幾輪把它追上，不用整份 /api/libs 重抓。跟 Task 13
// （抽卡/生圖模式的 GEN_SCORE_WAIT_MAX）是同一套邏輯，只是資料來源換成這支
// 專用端點——瀏覽模式的完成訊號走 /api/status 而不是 /api/gen-status，沒有現成
// 欄位可以搭車帶出分數。等不到就放棄，不影響圖片本身已經生成完成。
async function pollScoreAfterGenerate(rel) {
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    let score;
    try {
      score = (await fetch('/api/score?rel=' + encodeURIComponent(rel)).then(r => r.json())).score;
    } catch (e) { continue; }
    if (score) {
      const it = itemOf(rel);
      if (it) it.score = score;
      reloadThumb(rel);
      const inner = $('modal-inner');
      if (inner && inner.dataset.rel === rel) {
        const el = $('modal-score');
        if (el) el.innerHTML = modalScoreRowsHTML(score);
      }
      return;
    }
  }
}

function reloadThumb(rel) {
  const card = document.querySelector(`.card[data-rel="${cssAttr(rel)}"]`);
  if (!card) return;
  const it = itemOf(rel);
  if (!it) return;
  card.classList.remove('missing', 'pruned');   // pruned：見 pruneCard()，這裡重建了內容就不算修剪狀態了
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
  if (MODAL_FROM_TAROT) { MODAL_FROM_TAROT = false; fadeCloseModal(); }   // 露出底下那批抽到的牌
  else closeModalWithMorph();
}

/* ---------------------------------------------------------------------------
   大圖的橫向卡片列
   ---------------------------------------------------------------------------
   手感參考 GreenSock 的「Infinite Scrolling Cards（continuous snap）」：一列橫向
   卡片、左右鄰卡露邊，按一次滑一格並緩動吸附回中央，走到清單頭尾無縫接回另一端。

   **沒有引進 GSAP**。那個 pen 的份量幾乎都在 ScrollTrigger／Draggable 的捲動與
   拖曳物理，而這裡要的只是「按鍵走一格」——WAAPI 一行動畫就夠，不值得為此 vendored
   一整包（專案的依賴政策允許 vendored，但這筆划不來）。

   **無限循環不是特例處理出來的**，是「窗口永遠以目前這張為中心重建」的自然結果：
   每次都取 (i + d + n) % n 的 2*MODAL_WIN+1 張，在清單頭尾一樣鋪得滿，不需要判斷
   邊界。動畫因此永遠是同一件事——重建完先把整列推回「上一張還在中央」的位置，再
   滑回 0，跟目前走到哪裡無關。

   置中位置整條寫在 CSS 的 calc 裡（見 darkroom.css 的 .m-track），JS 只算「一格有
   多寬」——而且是量實際算好的卡片寬度，不是把 78% 這個數字在兩邊各寫一次。
   --------------------------------------------------------------------------- */
const MODAL_WIN = 2;          // 中央左右各鋪幾張，要跟 darkroom.css 的 --k 一致
const MODAL_SLIDE_MS = 420;   // 要跟 darkroom.css 的 --d-slide 一致
let MODAL_RAIL_ANIM = null;

// 大圖現在是「在哪一份清單裡走」。由每個開大圖的地方各自設定：格線縮圖 → VISIBLE、
// 圖庫縮圖 → galleryOrder()、抽卡 → 那批牌。方向鍵、‹ › 鈕與卡片列的鄰卡全部讀這
// 一份，三者永遠一致。
//
// 以前沒有這個東西，方向鍵寫死認 VISIBLE／GALLERY，所以抽卡開的大圖只能整個停掉
// 左右切（MODAL_FROM_TAROT 那條 early return）——但抽八張的時候「翻完這張看下一張」
// 正是最想要的操作。MODAL_FROM_TAROT 仍然留著，它管的是**關閉行為**（回到那批牌
// 而不是縮回格線縮圖），跟「往左右走哪一份清單」是兩件事。
let MODAL_LIST = null;        // { kind: 'lib' | 'gallery', items: [...] }

// kind 對得上就用它，否則退回該類型的預設清單。openModal() 可能被重新整理用途地
// 呼叫（例如生成完成後刷新同一張），那時 MODAL_LIST 可能是別的情境留下的，所以
// 使用端還要再確認「目前這張真的在裡面」。
function modalListFor(kind) {
  if (MODAL_LIST && MODAL_LIST.kind === kind && MODAL_LIST.items.length) return MODAL_LIST.items;
  return kind === 'gallery' ? galleryOrder() : VISIBLE;
}

// render(entry, isCenter) 回傳一張卡片的內容元素。
function buildModalStage(list, index, render) {
  const stage = document.createElement('div');
  stage.className = 'm-stage';
  const rail = document.createElement('div'); rail.className = 'm-rail';
  const track = document.createElement('div'); track.className = 'm-track';
  const n = list.length;
  for (let d = -MODAL_WIN; d <= MODAL_WIN; d++) {
    const slide = document.createElement('div');
    slide.className = 'm-slide' + (d === 0 ? ' is-current' : '');
    // 只有一張時鄰卡留空：五格鋪同一張圖會看起來像壞掉，而不是「循環」
    if (n > 1 || d === 0) slide.appendChild(render(list[((index + d) % n + n) % n], d === 0));
    track.appendChild(slide);
  }
  rail.appendChild(track); stage.appendChild(rail);
  return stage;
}

// 重建前先讀整列目前的視覺偏移。連按方向鍵時要把它接下去，不然每一次都從整整
// 一格外重新開始滑，看起來會一頓一頓的。只在按鍵時讀一次，不是每幀。
function modalRailOffset() {
  const rail = document.querySelector('#modal-inner .m-rail');
  if (!rail || !MODAL_RAIL_ANIM) return 0;
  const t = getComputedStyle(rail).transform;
  if (!t || t === 'none') return 0;
  try { return new DOMMatrixReadOnly(t).m41; } catch (e) { return 0; }
}

// 換一張：rebuild() 負責把整個大圖以新的中心重建，這裡只做那段滑動。
function modalSlide(dir, rebuild) {
  const carry = modalRailOffset();
  if (MODAL_RAIL_ANIM) { MODAL_RAIL_ANIM.cancel(); MODAL_RAIL_ANIM = null; }
  rebuild();
  const rail = document.querySelector('#modal-inner .m-rail');
  const track = rail && rail.firstElementChild;
  const slide = track && track.children[MODAL_WIN];
  if (!slide) return;
  const stage = rail.parentElement;
  stage.classList.add('stepping');
  // 剛剛還在中央的那張現在退到 MODAL_WIN - dir 的位置，讓它跟著把亮度收回去
  const outgoing = track.children[MODAL_WIN - dir];
  if (outgoing) outgoing.classList.add('was-current');
  if (REDUCE_MOTION || document.visibilityState !== 'visible' || !rail.animate) return;
  const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
  const step = slide.getBoundingClientRect().width + gap;
  if (!step) return;
  const anim = rail.animate(
    [{ transform: `translateX(${dir * step + carry}px)` }, { transform: 'translateX(0px)' }],
    { duration: MODAL_SLIDE_MS, easing: 'cubic-bezier(.22,.61,.36,1)' });
  MODAL_RAIL_ANIM = anim;
  const settle = () => { if (MODAL_RAIL_ANIM === anim) MODAL_RAIL_ANIM = null; };
  anim.finished.then(settle).catch(settle);
  setTimeout(settle, MODAL_SLIDE_MS + 80);   // 分頁在背景時 finished 不結算的保險
}

// 詞庫的一張卡。鄰卡只用縮圖——網址跟格線那邊完全一樣（沒帶 w），所以是**已經在
// 快取裡的同一份**，等於免費；中央那張也先鋪縮圖當底，全解析度疊上去淡入。
function renderLibSlide(item, isCenter) {
  if (!item || !item.has_image) {
    const ph = document.createElement('div');
    ph.className = 'no-image'; ph.textContent = '尚無圖片';
    return ph;
  }
  const relEnc = encodeURIComponent(item.rel);
  const thumb = new Image();
  thumb.className = 'm-img'; thumb.decoding = 'async'; thumb.alt = '';
  thumb.src = `/api/thumb?rel=${relEnc}&v=${item.image_mtime}`;
  if (!isCenter) { thumb.fetchPriority = 'low'; return thumb; }
  // hero morph 接在縮圖這張：它一定已經在快取裡，View Transitions 截得到圖；
  // 接在還沒載完的大圖上會截到一片空白。
  thumb.id = 'modal-image';
  thumb.dataset.rel = item.rel;
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;inset:0';
  const full = new Image();
  full.className = 'm-img m-full'; full.decoding = 'async'; full.alt = '';
  full.addEventListener('load', () => full.classList.add('in'), { once: true });
  full.src = `/api/image?rel=${relEnc}&t=${item.image_mtime}`;
  box.append(thumb, full);
  return box;
}

function openModal(rel, resetNav = true) {
  const item = itemOf(rel);
  if (!item) return;
  const inner = $('modal-inner');
  inner.dataset.rel = rel;
  delete inner.dataset.gid;   // 清掉圖庫大圖可能留下的 gid，不然方向鍵分支會誤判成還在切圖庫
  const relEnc = encodeURIComponent(rel);
  inner.innerHTML = `
    <div>
      <div id="m-stage-slot"></div>
      <div id="modal-status" data-rel="${escapeAttr(rel)}" class="status" style="margin-top:10px;padding:0;"></div>
      <div style="margin-top:12px; display:flex; gap:8px;">
        <button class="primary" id="modal-gen">${item.has_image ? '重新生成' : '生成'}</button>
        <button id="modal-close">關閉 (Esc)</button>
      </div>
    </div>
    <div>
      <div class="m-title" id="modal-title"></div>
      <div class="m-folder" id="modal-folder"></div>
      <div class="gi-score" id="modal-score"></div>
      <div class="prompt-label">自動標籤</div>
      <div class="tag-chip-list" id="modal-tags">載入中…</div>
      <div class="prompt-label">正向 Prompt</div>
      <div class="prompt-block" id="pos">載入中…</div>
      <div class="prompt-label">負向 Prompt</div>
      <div class="prompt-block" id="neg">載入中…</div>
    </div>`;
  // 卡片列鋪的是「畫面上這份清單」（VISIBLE），跟方向鍵切的順序是同一份，所以
  // 露在兩側的鄰卡就是等一下真的會切到的那兩張。VISIBLE 是空的（例如從搜尋結果
  // 直接開）就只鋪目前這一張。
  // 卡片列鋪的清單要跟方向鍵走的完全同一份（見 MODAL_LIST），露在兩側的鄰卡才會
  // 真的是等一下會切到的那兩張。找不到目前這張就只鋪一張——硬套 index 0 會讓中央
  // 顯示的是別人。
  let list = modalListFor('lib'), idx = list.findIndex(x => x.rel === rel);
  if (idx < 0) { list = [item]; idx = 0; }
  $('m-stage-slot').replaceWith(buildModalStage(list, idx, renderLibSlide));
  $('modal-folder').textContent = item.folder || '(根目錄)';
  $('modal-score').innerHTML = modalScoreRowsHTML(item.score);
  $('modal-gen').onclick = () => generate(rel);
  $('modal-close').onclick = dismissModal;
  overlayOpen($('modal'));
  if (item.job && item.job.status) updateStatusEl($('modal-status'), item.job);
  fetch('/api/prompt?rel=' + relEnc).then(r => r.json()).then(j => {
    if (j.error) { $('pos').textContent = j.error; return; }
    $('pos').textContent = j.positive || '(空)';
    $('neg').textContent = j.negative || '(空)';
    const tagsEl = $('modal-tags');
    if (tagsEl) { tagsEl.innerHTML = modalTagsHTML(j.visual_tags); wireModalTagTranslate(tagsEl); }
  }).catch(e => { $('pos').textContent = String(e); });
}

// 方向鍵與 ‹ › 鈕共用這一個入口。大圖是詞庫還是圖庫，由 openGalleryItem() 設的
// dataset.gid ／ openModal() 設的 dataset.rel 分辨；要走的清單一律問 MODAL_LIST，
// 所以格線、圖庫、抽卡三種來源都能左右切，各自走各自那一份。
function modalNav(dir) {
  const inner = $('modal-inner');
  if (!inner) return;
  const gid = inner.dataset.gid;
  const kind = gid ? 'gallery' : 'lib';
  const list = modalListFor(kind);
  if (!list || list.length < 2) return;                 // 只有一張（例如手機抽一張）就沒得切
  const i = gid ? list.findIndex(g => g.id === gid) : list.findIndex(x => x.rel === inner.dataset.rel);
  if (i < 0) return;
  const ni = (i + dir + list.length) % list.length;
  modalSlide(dir, () => (gid ? openGalleryItem(list[ni].id) : openModal(list[ni].rel)));
}

function closeModal() {
  const modal = $('modal');
  cancelOverlayClose(modal);
  modal.classList.remove('open');
  const inner = $('modal-inner');
  if (inner) { delete inner.dataset.rel; delete inner.dataset.gid; }
}
// 沒有縮圖可 morph 回去時（抽卡開的大圖、缺圖、減動）走跟其他疊層同一套淡出，
// 不要瞬間 display:none。closeModal() 本身保持同步——View Transitions 的 callback
// 裡必須當幀關掉，否則 morph 截不到「大圖消失、縮圖接手」的新快照。
function fadeCloseModal() {
  const modal = $('modal');
  fadeCloseOverlay(modal, $('modal-inner'), () => {
    const inner = $('modal-inner');
    if (inner) { delete inner.dataset.rel; delete inner.dataset.gid; }
  });
}

// 圖庫大圖的預設順序要跟畫面上看到的一致——renderGallery() 是新到舊（陣列反過來
// 疊代），這裡用同一個順序，不然「按右鍵」跟「畫面往右移一張」對不起來。
function galleryOrder() { return [...GALLERY].reverse(); }

// 圖庫的一張卡。生成結果沒有縮圖端點，鄰卡就用同一個網址（看過的已經在快取裡）。
function renderGallerySlide(g, isCenter) {
  const img = new Image();
  img.className = 'm-img'; img.decoding = 'async'; img.alt = '';
  if (!isCenter) img.fetchPriority = 'low';
  img.src = '/api/gen-result?id=' + encodeURIComponent(g.id);
  return img;
}
// 開大圖：縮圖 morph 放大成大圖（shared-element，view-transition-name: hero-img）。
// 老套路——舊快照在 callback 前截（此時縮圖有名字），callback 裡先清掉縮圖名字再開
// modal（大圖經 css 帶 hero-img），新快照只有大圖有名字 → 縮圖平滑長成大圖。
// 守 REDUCE_MOTION 與 visibilityState（窗格隱藏 callback 不結算，CLAUDE.md 老坑）。
function openModalFromThumb(rel, thumbImg) {
  MODAL_FROM_TAROT = false;                 // 格線縮圖開的大圖：關閉走 morph 縮回縮圖
  MODAL_LIST = { kind: 'lib', items: VISIBLE };   // 左右切就是畫面上這份格線的順序
  const item = itemOf(rel);
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
  if (!canMorph) { fadeCloseModal(); return; }
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
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 大圖 modal 的自動標籤區塊——wd-tagger 分析代表圖產生的視覺標籤，跟正向/負向
// prompt 是兩回事（prompt 是「要生成什麼」，這裡是「圖片實際長怎樣」，見打標
// 提案）。信心分數高的（>=70%）視覺上強調一點，低的淡化，但不砍掉，使用者
// 自己判斷準不準。rating 是 wd-tagger 對整張圖的分級（general/sensitive/
// questionable/explicit），放在標籤列最前面當一個小標籤。
function modalTagsHTML(vt) {
  if (!vt || !vt.tagged || !(vt.tags || []).length) {
    return `<div class="score-panel score-panel-empty">
      <span class="score-empty-dot" aria-hidden="true"></span>
      <span class="score-empty-txt">尚未打標</span>
    </div>`;
  }
  const rating = vt.rating
    ? `<span class="tag-chip tag-chip-rating" data-name="${escapeAttr(vt.rating)}">${escapeHtml(vt.rating)}</span>` : '';
  const chips = vt.tags.map(t => {
    const pct = Math.round((t.conf || 0) * 100);
    const dim = pct < 70 ? ' tag-chip-dim' : '';
    return `<span class="tag-chip${dim}" data-name="${escapeAttr(t.name)}">${escapeHtml(t.name)}<b>${pct}%</b></span>`;
  }).join('');
  return rating + chips;
}
// 標籤 chip hover 送 Google 翻譯——跟 LoRA 觸發詞卡（renderLoraDetail 裡的
// lm-tw-item）共用同一套 showTwTip/hideTwTip/translateTriggerWord，這裡是
// innerHTML 插入的靜態字串，沒有現成的 DOM 節點可以在建立時掛監聽，所以
// 插入後另外掃一次 .tag-chip 補上 hover 事件，不是重寫一套翻譯機制。
function wireModalTagTranslate(container) {
  container.querySelectorAll('.tag-chip[data-name]').forEach(chip => {
    const name = chip.dataset.name;
    chip.addEventListener('mouseenter', () => showTwTip(chip, name));
    chip.addEventListener('mouseleave', () => hideTwTip(chip));
  });
}
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

// 標籤搜尋：逗號分隔多個標籤，需同時符合全部（AND）。詞庫檔案裡同一組標籤有時寫成
// 獨立元素、有時整串塞一個字串（"A,B,C"／"A, B, C,"／"A,B, C," 都有人寫過），比對邏輯
// 統一在後端 split_tags() 處理，前端只管把查詢字串原樣送過去。用遞增的請求序號擋過期
// 回應（使用者打字很快時，先送出的請求可能比後送出的晚回來）。
let tagSearchReq = 0;
async function runTagSearch(query) {
  TAG_QUERY = query;
  if (!query) {
    TAG_MATCH_SET = null;
    buildRail(); render();
    return;
  }
  const myReq = ++tagSearchReq;
  try {
    const r = await fetch('/api/tag_search?q=' + encodeURIComponent(query));
    const j = await r.json();
    if (myReq !== tagSearchReq) return;   // 已經有更新的查詢送出，這筆回應過期，忽略
    TAG_MATCH_SET = new Set(j.rels || []);
  } catch (e) {
    if (myReq !== tagSearchReq) return;
    console.error('標籤搜尋失敗：', e);
    TAG_MATCH_SET = new Set();
  }
  buildRail(); render();
}
let tagSearchTimer;
$('tag-search').oninput = e => {
  const v = e.target.value;
  $('tag-search-clear').style.display = v.trim() ? '' : 'none';
  clearTimeout(tagSearchTimer);
  tagSearchTimer = setTimeout(() => runTagSearch(v.trim()), 220);
};
$('tag-search').onkeydown = e => {
  if (e.key === 'Escape') {
    e.target.value = ''; $('tag-search-clear').style.display = 'none';
    clearTimeout(tagSearchTimer); runTagSearch('');
  }
};
$('tag-search-clear').onclick = () => {
  $('tag-search').value = ''; $('tag-search-clear').style.display = 'none';
  clearTimeout(tagSearchTimer); runTagSearch('');
  $('tag-search').focus();
};
async function startScoreBackfill() {
  const btn = $('score-backfill-btn');
  btn.disabled = true; btn.textContent = '評分中…';
  try {
    const r = await fetch('/api/score-backfill', { method: 'POST' });
    const j = await r.json();
    if (j.error) { toast(j.error, true); btn.disabled = false; btn.innerHTML = ICON_STAR_OUTLINE.replace('<svg ', '<svg class="btn-svg" ') + '評分'; return; }
    pollScoreBackfill();
  } catch (e) {
    toast('評分請求失敗：' + e, true);
    btn.disabled = false; btn.innerHTML = ICON_STAR_OUTLINE.replace('<svg ', '<svg class="btn-svg" ') + '評分';
  }
}
// 補分跑到哪張就即時幫哪張補上分數徽章，不用等整輪跑完才整批 loadAll 重整。
// 只在該卡片目前確實在畫面上（DOM 裡找得到）才重繪縮圖；找不到就只更新資料
// 本身（it.score），下次它捲進視野或整批重整時自然是對的。
function applyLiveScore(rel, score) {
  if (!score) return;
  const it = itemOf(rel);
  if (it) it.score = score;
  if (document.querySelector(`.card[data-rel="${cssAttr(rel)}"]`)) reloadThumb(rel);
  const inner = $('modal-inner');
  if (inner && inner.dataset.rel === rel) {
    const el = $('modal-score');
    if (el) el.innerHTML = modalScoreRowsHTML(score);
  }
}
async function pollScoreBackfill() {
  const btn = $('score-backfill-btn');
  let lastRel = null;
  try {
    while (true) {
      try {
        const st = await fetch('/api/score-backfill-status').then(r => r.json());
        if (st.last_rel && st.last_rel !== lastRel) {
          lastRel = st.last_rel;
          applyLiveScore(lastRel, st.last_score);
        }
        if (!st.running) break;
        btn.textContent = st.total ? `評分中 ${st.done}/${st.total}` : '評分中…';
      } catch (e) {
        /* 暫時抓失敗就等下一輪 */
        console.error('評分狀態查詢失敗:', e);
      }
      await sleep(1000);
    }
  } finally {
    btn.disabled = false; btn.innerHTML = ICON_STAR_OUTLINE.replace('<svg ', '<svg class="btn-svg" ') + '評分';
    await loadAll(true);   // 補分完重新整理，新分數與清掉的孤兒紀錄才會反映在畫面上
  }
}
$('score-backfill-btn').onclick = startScoreBackfill;
async function startTagBackfill() {
  const btn = $('tag-backfill-btn');
  btn.disabled = true; btn.textContent = '打標中…';
  try {
    const r = await fetch('/api/tag-backfill', { method: 'POST' });
    const j = await r.json();
    if (j.error) { toast(j.error, true); btn.disabled = false; btn.innerHTML = ICON_TAG.replace('<svg ', '<svg class="btn-svg" ') + '打標'; return; }
    pollTagBackfill();
  } catch (e) {
    toast('打標請求失敗：' + e, true);
    btn.disabled = false; btn.innerHTML = ICON_TAG.replace('<svg ', '<svg class="btn-svg" ') + '打標';
  }
}
async function pollTagBackfill() {
  const btn = $('tag-backfill-btn');
  try {
    while (true) {
      try {
        const st = await fetch('/api/tag-backfill-status').then(r => r.json());
        if (!st.running) break;
        btn.textContent = st.total ? `打標中 ${st.done}/${st.total}` : '打標中…';
      } catch (e) {
        console.error('打標狀態查詢失敗:', e);
      }
      await sleep(1000);
    }
  } finally {
    btn.disabled = false; btn.innerHTML = ICON_TAG.replace('<svg ', '<svg class="btn-svg" ') + '打標';
  }
}
$('tag-backfill-btn').onclick = startTagBackfill;
$('rescan').onclick = () => loadAll(true);
$('menu-btn').onclick = () => $('rail').classList.toggle('open');
// 卡片聚光：游標在縮圖上移動時更新 --mx/--my（委派在 grid 上，只有 hover 的縮圖會算）
//
// 兩個聚光委派共用 spotlight()。原本每一次 pointermove 都「讀 getBoundingClientRect()
// → 寫 style」，指標事件一秒可以來上百次，而每次寫完樣式再讀幾何就是一次強制同步版面
// （layout thrashing）——在 28000 筆的卡片牆上這個 layout 一點都不便宜。改成：
//   ① 只在 rAF 裡寫，一幀最多一次（螢幕本來也就更新這麼多次，多寫的都是丟掉的工）；
//   ② 矩形量測快取在元素上，只有換到另一個元素才重新量。捲動中矩形會過期，但那只是
//      柔光的位置差幾像素，捲完第一次移動就修正回來——不值得為它每幀重新 layout。
let _spotEl = null, _spotRect = null, _spotX = 0, _spotY = 0, _spotRAF = 0;
function spotFlush() {
  _spotRAF = 0;
  if (!_spotEl || !_spotRect) return;
  _spotEl.style.setProperty('--mx', (_spotX - _spotRect.left) + 'px');
  _spotEl.style.setProperty('--my', (_spotY - _spotRect.top) + 'px');
}
function spotlight(e, sel) {
  const el = e.target.closest(sel);
  if (!el) { _spotEl = null; _spotRect = null; return; }
  if (el !== _spotEl) { _spotEl = el; _spotRect = el.getBoundingClientRect(); }
  _spotX = e.clientX; _spotY = e.clientY;
  if (!_spotRAF) _spotRAF = requestAnimationFrame(spotFlush);
}
$('grid').addEventListener('pointermove', e => spotlight(e, '.thumb'), { passive: true });
// 圖庫卡同一招聚光（見 .gc-square::after）
$('gallery-grid').addEventListener('pointermove', e => spotlight(e, '.gc-square'), { passive: true });
// 資料夾排序方向切換（升冪 ↑ / 降冪 ↓），記住選擇
function updateRailSortLabel() {
  const b = $('rail-sort'); if (!b) return;
  $('rail-sort-label').textContent = RAIL_DESC ? '降冪' : '升冪';
  $('rail-sort-icon').innerHTML = RAIL_DESC
    ? '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>'
    : '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>';
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
    toast(regenerate ? '目前範圍沒有可生成的項目' : '目前範圍沒有缺圖的項目', true);
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
  if (!(await confirmDialog(`${scopeTxt} · ${modeTxt}\n共 ${rels.length} 張,將以每次 2 張並行處理,可能耗時很久。確定?`))) return;
  const r = await fetch('/api/batch_generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rels, regenerate })
  });
  const j = await r.json();
  if (j.error) { toast(j.error, true); return; }
  pollBatch();
}
$('gen-page-missing').onclick = () => launchBatch('page', false);
$('gen-page-all').onclick     = () => launchBatch('page', true);
$('gen-all-missing').onclick  = () => launchBatch('all', false);
$('gen-all-regen').onclick    = () => launchBatch('all', true);

$('batch-stop').onclick = async () => {
  if (!(await confirmDialog('停止批次?當前這張仍會跑完。'))) return;
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
$('m-prev').onclick = () => modalNav(-1);
$('m-next').onclick = () => modalNav(1);
window.addEventListener('keydown', e => {
  // 這個 app 的快捷鍵全部是單一按鍵（R/E/C/X/1~4/S/Z/?/方向鍵…），沒有一個需要搭配
  // Ctrl/Cmd/Alt。沒有這條擋在最前面，按 Ctrl+C 複製、Ctrl+X 剪下、Ctrl+Z 復原、
  // Ctrl+S 存檔這些瀏覽器/系統原生快捷鍵會被底下對應字母的分支攔截、擋掉
  // preventDefault——使用者回報「很多 Windows 預設快捷鍵都不能用」就是這個。任何組合鍵
  // 一律直接放行給瀏覽器/系統處理，不進這支 handler 的判斷邏輯。
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // 確認對話框（z-index 90，取代 window.confirm）排最最前面：它可能疊在任何畫面之上
  // （批次生成鈕在頂列，不屬於任何其他 modal 的子層級），Esc 一律當取消，不往下傳。
  if ($('confirm-modal').classList.contains('open')) {
    if (e.key === 'Escape') { e.preventDefault(); _confirmModalResolve(false); }
    return;
  }
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
    if ($('tarot').dataset.closing) return;
    if (e.key === 'Escape') { closeTarot(); return; }
    if (e.key === 'r' || e.key === 'R' || e.key === 'Enter') { e.preventDefault(); drawLoraTarot(); return; }   // 全庫重抽
    if (e.key === 'e' || e.key === 'E') { e.preventDefault(); drawLoraCategoryDispatch(); return; }             // 只抽目前左欄選的分類/子資料夾
    return;
  }
  // Concepts 抽卡同樣要排在「MODE==='tag' 就全鍵盤逐張標」那條之前——不然使用者剛好停在
  // 打標模式時按 C 開了 Concepts 疊層，R/1~4 這些鍵會被下面通用分支誤判成打標快捷鍵。
  if (CONCEPTS_TAROT && $('tarot').classList.contains('open')) {
    if ($('tarot').dataset.closing) return;
    if (e.key === 'Escape') { closeTarot(); return; }
    // C／Enter 是「照設定彈窗的判斷邏輯」重抽；R／E 差別只在模板池（全庫／目前資料夾），
    // 且都不做 C 專屬的「角色/情境都沒訊號、自動補一顆全庫 concepts」補位——見
    // drawConceptsTarot()/drawConceptsTarotFull()/drawConceptsTarotFolder() 開頭的說明。
    if (e.key === 'c' || e.key === 'C' || e.key === 'Enter') { e.preventDefault(); drawConceptsTarot(); return; }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); drawConceptsTarotFull(); return; }
    if (e.key === 'e' || e.key === 'E') { e.preventDefault(); drawConceptsTarotFolder(); return; }
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
    if ($('modal').dataset.closing) return;
    if (e.key === 'Escape') { dismissModal(); return; }
    // 切哪一份清單由 modalNav() 依 MODAL_LIST 決定（‹ › 兩顆鈕走同一個入口）。
    // 抽卡開的大圖也能左右切——走的是那批牌，不是格線的 VISIBLE。
    if (e.key === 'ArrowLeft') modalNav(-1);
    else if (e.key === 'ArrowRight') modalNav(1);
    return;
  }
  if ($('tarot').classList.contains('open')) {
    if ($('tarot').dataset.closing) return;
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
  if (!pool.length) { toast(label ? `「${label}」沒有已生成預覽圖的詞庫可抽` : '目前沒有任何已生成預覽圖的詞庫可抽', true); return; }
  const want = isMobile() ? 1 : 8;                        // 手機一次一張，桌面 8 張（4+4）
  const picks = sampleN(pool, Math.min(want, pool.length));
  const n = picks.length;
  const title = document.querySelector('.tarot-title');
  if (title) title.innerHTML = label ? `${ICON_SPARKLE}${label}　抽選${CN_NUM[n] || n}張${ICON_SPARKLE}` : `${ICON_SPARKLE}抽選${CN_NUM[n] || n}張${ICON_SPARKLE}`;
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
         <div class="tarot-back"><span class="tarot-emblem">${ICON_SPARKLE}</span></div>
         <div class="tarot-front${it.has_image ? ' loading' : ''}">${face}${it.rarity === 'legendary' ? sparklesHTML(9) : ''}${rarTag(it.rarity)}<div class="tarot-badges">${scoreBadgeHTML(it.score)}</div><div class="tarot-name"></div><div class="tarot-folder"></div><div class="tarot-glare"></div></div>
       </div>`;
    card.querySelector('.tarot-name').textContent = it.display_name || it.name;
    card.querySelector('.tarot-folder').textContent = it.folder || '(根目錄)';
    // 大圖疊上層，關掉回到這批牌；左右切走的就是**這批牌**（picks），不是格線的 VISIBLE
    card.addEventListener('click', () => {
      MODAL_FROM_TAROT = true;
      MODAL_LIST = { kind: 'lib', items: picks };
      openModal(it.rel);
    });
    if (!REDUCE) {                                        // 3D 傾斜（參考 Aceternity 3D card）
      card.addEventListener('mousemove', e => tiltCard(card, e));
      card.addEventListener('mouseleave', () => tiltReset(card));
    }
    wrap.appendChild(card);
  });
  overlayOpen($('tarot'));
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
// 跟聚光（spotlight）同一個理由做 rAF 節流＋矩形快取：mousemove 一秒上百次，每次都
// 「寫 transform 再讀 getBoundingClientRect()」會逼瀏覽器在事件迴圈裡同步重算版面，
// 而這裡量的還是一張正在跑 3D transform 的牌。矩形只在換牌時重量——牌是浮層置中的，
// 滑鼠停在同一張牌上時它不會移動，快取不會過期。
let _tiltCard = null, _tiltRect = null, _tiltGlare = null, _tiltX = 0, _tiltY = 0, _tiltRAF = 0;
function tiltFlush() {
  _tiltRAF = 0;
  const card = _tiltCard, r = _tiltRect;
  if (!card || !r || !r.width || !r.height) return;
  const px = (_tiltX - r.left) / r.width - 0.5;    // -0.5 ~ 0.5
  const py = (_tiltY - r.top) / r.height - 0.5;
  const MAX = 11;
  card.style.transform =
    `rotateX(${(-py * MAX).toFixed(2)}deg) rotateY(${(px * MAX).toFixed(2)}deg)`;
  if (_tiltGlare) {
    _tiltGlare.style.setProperty('--gx', ((px + 0.5) * 100).toFixed(1) + '%');
    _tiltGlare.style.setProperty('--gy', ((py + 0.5) * 100).toFixed(1) + '%');
  }
}
function tiltCard(card, e) {
  if (card !== _tiltCard) {
    _tiltCard = card;
    _tiltRect = card.getBoundingClientRect();
    _tiltGlare = card.querySelector('.tarot-glare');
  }
  _tiltX = e.clientX; _tiltY = e.clientY;
  if (!_tiltRAF) _tiltRAF = requestAnimationFrame(tiltFlush);
}
// 離開牌面時把快取清掉，不然下次滑回同一張牌會沿用可能已經過期的矩形（牌會重新發牌、
// 位置可能不同），而且 tiltFlush 若在 transform 被清空之後才跑會把傾斜又寫回去。
function tiltReset(card) {
  if (_tiltCard === card) { _tiltCard = null; _tiltRect = null; _tiltGlare = null; }
  card.style.transform = '';
}

function closeTarot() {
  const el = $('tarot');
  fadeCloseOverlay(el, el.querySelector('.tarot-stage'), () => {
    TAROT_FOCUS = -1;
    if (MODE === 'tag') { render(); updateTagbar(); }   // 反映剛標的
    if (LORA_TAROT) { LORA_TAROT = false; document.body.classList.remove('lora-tarot-open'); }
    if (CONCEPTS_TAROT) { CONCEPTS_TAROT = false; document.body.classList.remove('concepts-tarot-open'); }
  });
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
  if (title) title.innerHTML = label ? `${ICON_SPARKLE}${label} 隨機 ${CN_NUM[n] || n} 個 LoRA${ICON_SPARKLE}` : `${ICON_SPARKLE}隨機瀏覽 ${CN_NUM[n] || n} 個 LoRA${ICON_SPARKLE}`;
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
    // src 故意先不填（存 data-src），等下面依發牌順序透過 _previewEnqueue 排隊才真的
    // 開始下載——一次翻 8 張，若同時把 8 個 src 都設好，瀏覽器會同時開 8 條下載，實測
    // 抓到過遠端連線同時擠很多個下載時，個別檔案伺服器端只要 1~2ms 卻要等好幾秒才傳完
    // （頻寬被擠爆，見 makeLoraPreviewEl 上面那則長註解），這裡跟 LoRA 清單共用同一套
    // 節流機制，不會因為「只有 8 張」就假設沒事。
    const face = l.preview
      ? (isLoraPreviewVideo(l)
          ? `<video muted loop playsinline preload="none" data-src="${loraPreviewUrl(l)}"></video>`
          : `<img decoding="async" data-src="${loraPreviewUrl(l)}" alt="" onload="this.classList.add('ld');this.closest('.tarot-front').classList.remove('loading')" onerror="this.closest('.tarot-front').classList.remove('loading')">`)
      : `<div class="tarot-noimg">${ICON_EMPTY}<span>尚無預覽</span></div>`;
    card.innerHTML =
      `<div class="tarot-inner">
         <div class="tarot-back"><span class="tarot-emblem">${ICON_SPARKLE}</span></div>
         <div class="tarot-front${l.preview ? ' loading' : ''}">${face}<div class="tarot-name"></div><div class="tarot-folder"></div><div class="tarot-glare"></div></div>
       </div>`;
    card.querySelector('.tarot-name').textContent = l.title || l.name;
    card.querySelector('.tarot-folder').textContent = l.folder || '(根目錄)';
    card.addEventListener('click', () => { selectGenLora(l); closeTarot(); });
    if (!REDUCE) {
      card.addEventListener('mousemove', e => tiltCard(card, e));
      card.addEventListener('mouseleave', () => tiltReset(card));
    }
    wrap.appendChild(card);
  });
  overlayOpen($('tarot'));
  const cards = [...wrap.children];
  if (REDUCE) {
    // 沒有發牌動畫可以掛，直接把每張的 data-src 排進下載佇列，不然永遠不會開始
    // 下載（reduced-motion 使用者會看到一片空白）。還是走佇列限流，不是直接賦值。
    cards.forEach(c => {
      const media = c.querySelector('.tarot-front img, .tarot-front video');
      if (media && media.dataset.src) _previewEnqueue((done) => _previewStart(media, done));
      c.classList.add('revealed');
    });
    return;
  }
  const dealDone = n * 48 + 220;
  cards.forEach((c, i) => {
    const media = c.querySelector('.tarot-front img, .tarot-front video');
    setTimeout(() => {
      if (media && media.dataset.src) {
        // 這張輪到揭示了才排進下載佇列（跟 LoRA 清單共用同一套併發上限，見
        // makeLoraPreviewEl 那則長註解），不是「揭示＝立刻下載」，佇列滿的話
        // 要等前面的騰出名額。
        _previewEnqueue((done) => _previewStart(media, done));
      }
      if (media && (media.tagName === 'VIDEO' || (media.complete && media.naturalWidth))) {
        c.querySelector('.tarot-front').classList.remove('loading');
      }
      c.classList.add('revealed');
    }, dealDone + i * 80);
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
  // ✕ 直接清空這格——跟 LoRA 大面板分頁卡的清空鈕（.lm-slot-clear）是同一份
  // GEN_LORA_SLOTS，清了這裡大面板會跟著變空，反過來也一樣，不用另外同步。
  const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'cs-locked-clear';
  clear.title = `清空 LoRA ${slot + 1}`; clear.setAttribute('aria-label', `清空 LoRA ${slot + 1}`); clear.innerHTML = ICON_CLOSE;
  clear.addEventListener('click', (e) => {
    e.stopPropagation();
    hideLoraPreviewTip();
    GEN_LORA_SLOTS[slot] = { lora: null, strength: GEN_LORA_SLOTS[slot].strength, twPicks: new Set() };
    if (GEN_ACTIVE_SLOT === slot) renderLmCurrent(); else renderLmSlotTabsRefresh();
    renderGenCurrent();
    renderLmList($('lm-search').value);
    renderCsScopeChips(slot);
  });
  card.appendChild(clear);
  fixedBox.appendChild(card);
}
// LoRA 大面板分頁卡（LoRA1/LoRA2 兩張小卡）只在 renderLmCurrent() 裡重建，清空「非作用格」
// 時不會走那條路徑（renderLmCurrent 只畫作用格的內容），但分頁卡本身兩格都要重繪，所以
// 額外補一個只重畫分頁卡列的輕量版本，不用把整個右欄（含清單/強度/觸發詞）都重建一次。
function renderLmSlotTabsRefresh() {
  const box = $('lm-current'); if (!box) return;
  const old = box.querySelector('.lm-slot-tabs');
  if (old) old.replaceWith(renderLmSlotTabs());
}
// 這格的「參與判斷／跳過」切換——跳過的格子，不管放了什麼固定 LoRA、範圍晶片設什麼，
// drawConceptsTarot() 判斷角色/情境時都當它不存在（見 slotSignal() 的 GEN_LORA_SLOT_SKIP
// 過濾）。切換按鈕跟顯示區塊都在「一般」分頁這裡集中管理——
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
// 「一般」分頁每格自己的強度滑桿——跟 LoRA 大面板的 #lm-strength 是同一份
// GEN_LORA_SLOTS[slot].strength，兩邊即時互相同步（見 #cs-tab-general 的 input
// 委派、#lm-current 的 input 監聽各自呼叫對方的 render 函式）。
function renderCsStrength(slot) {
  const el = document.querySelector(`#cs-str-${slot}`);
  const out = document.querySelector(`#cs-str-${slot}-out`);
  if (!el) return;
  const v = GEN_LORA_SLOTS[slot].strength;
  el.value = v;
  if (out) out.textContent = v.toFixed(2);
}
// 設定 modal「一般」分頁的 LoRA1/LoRA2 範圍晶片——跟大面板左欄晶片（renderLmCats/
// renderLmSubcats）是同一份 GEN_LORA_SLOT_SCOPE 資料，視覺邏輯也完全比照(分類晶片＋
// 子資料夾晶片，選了分類才出現、只有一種子資料夾值時不顯示），差別只在這裡固定畫兩份
// （slot 0/1 都要看得到），不是只畫「目前作用格」那一份；晶片點擊直接改
// GEN_LORA_SLOT_SCOPE[slot]，不透過 curScope()（curScope() 只會指到作用格）。
function renderCsScopeChips(slot) {
  renderCsSkipToggle(slot);
  renderCsSlotFixedState(slot);
  renderCsStrength(slot);
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
      GEN_LORA_SLOT_SKIP[slot] = false;   // 選了範圍就是明確的參與意圖，自動切回「參與判斷」
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
      GEN_LORA_SLOT_SKIP[slot] = false;   // 選了子資料夾一樣是明確的參與意圖
      renderCsSkipToggle(slot);
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
// 這裡要能算「任一格」自己的池，Concepts 判斷時才能各自套用各自記住的範圍，不會被目前
// 作用格的範圍蓋掉。slotSignal()/signalPicker() 是 Concepts 用的入口。
function scopePool(i) {
  const scope = GEN_LORA_SLOT_SCOPE[i];
  return (GEN_LORAS || []).filter(l =>
    (scope.cat === 'all' || l.category === scope.cat) &&
    (!scope.subfolder || l.folder === scope.subfolder));
}

// Concepts 抽卡角色沒訊號時的退場全庫池：固定的 HENTAI/concepts 資料夾（情境/動作 LoRA）。
function fullConceptsPool() { return (GEN_LORAS || []).filter(l => l.folder === 'HENTAI/concepts'); }

// drawConceptsTarot() 判斷邏輯的核心：每一格算出「這格現在的訊號」，跟分類完全無關——
// 固定了什麼 LoRA 就是什麼、範圍晶片設什麼分類就是什麼，character/concepts 只是眾多
// 分類裡剛好有對應角色的兩種，其他分類（style…）一樣算數，只是不會被指派成角色/情境，
// 照字面套用。跳過的格子回傳 null，drawConceptsTarot() 當它不存在。
function slotSignal(i) {
  if (GEN_LORA_SLOT_SKIP[i]) return null;
  const slot = GEN_LORA_SLOTS[i];
  if (slot.lora) return { i, fixed: true, cat: slot.lora.category, isConcept: slot.lora.folder === 'HENTAI/concepts' };
  return { i, fixed: false, cat: GEN_LORA_SLOT_SCOPE[i].cat, isConcept: GEN_LORA_SLOT_SCOPE[i].cat === 'HENTAI' };
}
// 兩格的訊號裡找第一個符合條件的（slot0→slot1 優先序，跟舊版 findLockedSlot 一致）。
function findRoleSignal(signals, matchFn) { return signals.find(s => s && matchFn(s)); }
// 把一格訊號轉成「抽一次」的函式：固定的每次都回傳同一顆（每張卡一樣），範圍的每次呼叫
// 各自重新隨機（同一份 pool 先算好，每張卡不用重算 GEN_LORAS 過濾）。範圍池是空的就回
// null，呼叫端負責 toast——這裡不處理 UI 副作用。
function signalPicker(sig, strength) {
  if (sig.fixed) {
    const slot = GEN_LORA_SLOTS[sig.i];
    const lora = slot.lora;
    return () => ({ lora, strength, trigger: slotTriggerText(slot) });
  }
  const pool = scopePool(sig.i);
  if (!pool.length) return null;
  return () => ({ lora: pool[Math.floor(Math.random() * pool.length)], strength });
}
// 算出這次抽卡實際要套用的 LoRA picker 陣列（每張卡呼叫一次拿到實際 LoRA）。每格的強度
// 一律用該格自己的 GEN_LORA_SLOTS[i].strength——跟 LoRA 大面板、設定彈窗「一般」分頁的
// 每格強度滑桿是同一份數字，不分角色（不再有「角色強度／情境強度」兩種特殊值）。
// autoFillConcept 只有 C 鍵開——情境沒有格子覆蓋、且至少有一格是「跳過」（代表還有空位）
// 時，自動補一顆全庫隨機 concepts，強度沿用那個空位格子自己設定的強度；R/E 兩鍵單純照
// 兩格現在的樣子字面套用，不做這個補位（例：兩格都固定了跟 concepts 無關的 LoRA，R/E
// 只套那兩顆，不會多抽一顆 concepts）。兩格都覆蓋掉（沒有空位）時同樣不補。
function buildConceptsPickers(autoFillConcept) {
  const signals = [slotSignal(0), slotSignal(1)];
  const conceptSig = findRoleSignal(signals, s => s.isConcept);
  const pickers = [];
  for (const sig of signals) {
    if (!sig) continue;
    const pick = signalPicker(sig, GEN_LORA_SLOTS[sig.i].strength);
    if (!pick) { toast(`LoRA${sig.i + 1} 的範圍內沒有 LoRA 可抽`); return null; }
    pickers.push(pick);
  }
  if (autoFillConcept && !conceptSig) {
    const freeIdx = signals.findIndex(s => !s);
    if (freeIdx !== -1) {
      const pool = fullConceptsPool();
      if (!pool.length) { toast('concepts 底下沒有 LoRA 可抽'); return null; }
      const strength = GEN_LORA_SLOTS[freeIdx].strength;
      pickers.push(() => ({ lora: pool[Math.floor(Math.random() * pool.length)], strength }));
    }
  }
  if (!pickers.length) { toast('LoRA1/LoRA2 都是跳過狀態，沒有東西可以套用'); return null; }
  return pickers;
}

// 一般手動生圖／R／E（非 Concepts 疊層）套用的 LoRA picker，跟 Concepts 的 R/E 共用同一套
// slotSignal()/signalPicker() 判斷——已跳過的格子當它不存在、固定的直接套用、只設了範圍
// （沒固定）的每次呼叫各自重新隨機一顆。**跟 buildConceptsPickers() 唯一的差別**：兩格都
// 空手是完全正常的情況（單純不套 LoRA 生圖），不當錯誤、不擋生圖，直接回傳空陣列，不像
// Concepts 那樣兩格都跳過要 toast 擋下來。回傳 picker 函式（不是直接抽好的結果）是因為
// runGen() 一次可能對好幾個詞庫生圖，範圍隨機的那格要讓**每張圖各自重新抽一次**，不是整批
// 共用同一顆——使用者選範圍就是要「這批裡每張都可能不一樣」，不是變相的另一種固定。
function buildGenPickers() {
  const pickers = [];
  for (const sig of [slotSignal(0), slotSignal(1)]) {
    if (!sig) continue;
    const pick = signalPicker(sig, GEN_LORA_SLOTS[sig.i].strength);
    if (!pick) { toast(`LoRA${sig.i + 1} 的範圍內沒有 LoRA 可抽`); return null; }
    pickers.push(pick);
  }
  return pickers;
}

// 「鎖定」機制：不做另一套選單 UI，直接偵測 LoRA1/LoRA2 面板現在有沒有選到符合分類的
// LoRA——有選到就鎖定那顆（用它跟它設定的強度，每張卡都一樣，不重新隨機）。標成「跳過」
// 的格子（GEN_LORA_SLOT_SKIP）完全不參與這個判斷，當它不存在。依 slot0→slot1 順序找
// 第一個符合的，兩格剛好都是同分類時只有先出現的那格算數。
function findLockedSlot(matchFn) { return GEN_LORA_SLOTS.find((s, i) => !GEN_LORA_SLOT_SKIP[i] && s.lora && matchFn(s.lora)); }
function lockedCharacterSlot() { return findLockedSlot(l => l.category === 'Character'); }
function lockedConceptSlot() { return findLockedSlot(l => l.folder === 'HENTAI/concepts'); }
// Concepts 按鈕旁的鎖定狀態文字，隨 LoRA1/LoRA2 選擇即時更新（見 renderGenCurrent）。
// 純文字版給 title tooltip／變動偵測用（title 屬性不能塞 HTML）；HTML 版才是畫面
// 顯示用的，鎖頭圖示換成 ICON_LOCK。
function conceptsLockLabel() {
  const c = lockedCharacterSlot(), k = lockedConceptSlot();
  if (!c && !k) return '隨機 × 隨機';
  const cText = c ? (c.lora.title || c.lora.name) : '隨機';
  const kText = k ? (k.lora.title || k.lora.name) : '隨機';
  return `${cText} × ${kText}`;
}
function conceptsLockLabelHTML() {
  const c = lockedCharacterSlot(), k = lockedConceptSlot();
  if (!c && !k) return '隨機 × 隨機';
  const cText = c ? `${ICON_LOCK}${c.lora.title || c.lora.name}` : '隨機';
  const kText = k ? `${ICON_LOCK}${k.lora.title || k.lora.name}` : '隨機';
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
  if (title) title.innerHTML = `${ICON_SPARKLE}抽卡打標${ICON_SPARKLE}`;
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
         <div class="tarot-back"><span class="tarot-emblem">${ICON_SPARKLE}</span></div>
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
  overlayOpen($('tarot'));
  setTarotFocus(0);
  updateTarotProgress();
  const cards = [...wrap.children];
  if (REDUCE_MOTION) { cards.forEach(c => c.classList.add('revealed')); return; }
  const dealDone = picks.length * 24 + 170;
  cards.forEach((c, i) => setTimeout(() => c.classList.add('revealed'), dealDone + i * 32));
}
function assignTarot(rel, card, key) {
  const it = itemOf(rel);
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
// #tarot-redraw 鈕標的是「再抽一次 (R)」，Concepts 疊層開著時要對應 R 鍵的語意
// （drawConceptsTarotFull，不補位、模板固定全庫），不是 C 鍵那顆。
const drawDispatch = () => (LORA_TAROT ? drawLoraTarot() : CONCEPTS_TAROT ? drawConceptsTarotFull() : MODE === 'gen' ? drawGenTarot() : MODE === 'tag' ? drawTagTarot() : drawTarot());
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
  const btn = $('review-btn');
  btn.classList.toggle('on', on);
  // 換的是 svg 內容（path），不是整個 svg 元素——那個元素本身的 class="btn-svg"
  // 等屬性要留著，只換裡面畫的圖案。
  btn.querySelector('svg').innerHTML = on
    ? '<path d="M5 13l4 4L19 7"/>'
    : '<path d="M5 21V4"/><path d="M5 4h13l-2.5 4L18 12H5"/>';
  $('review-btn-label').textContent = on ? '篩選中' : '篩選';
}

$('review-btn').onclick = () => setSelecting(!SELECTING);
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && SELECTING) setSelecting(false);
});

/* ── 打標模式：選取詞庫 → 點稀有度即時寫側檔（POST /api/rarity，不改檔名）。 ── */
const RARITY_FULL = { common: '普通版', rare: '稀有版', special: '特別版', legendary: '傳奇版' };
const SEL = new Set();                 // 打標模式選取的 rel

let _toastT = null;
function toast(msg, isError) {
  const t = $('toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  t.classList.toggle('error', !!isError);
  clearTimeout(_toastT);
  _toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

/* 取代 window.confirm——同一套彈窗慣例（squircle、背景遮罩、Esc／✕都能關，Esc 的
   攔截寫在上面的全域 keydown 最前面，因為這個對話框可能疊在任何畫面之上）。
   回傳 Promise<boolean>，呼叫端一律 `if (!(await confirmDialog('...'))) return;`。 */
let _confirmModalResolve = null;
function confirmDialog(message) {
  const modal = $('confirm-modal');
  $('confirm-modal-msg').textContent = message;
  modal.classList.add('open');
  return new Promise(resolve => {
    _confirmModalResolve = (ok) => {
      modal.classList.remove('open');
      _confirmModalResolve = null;
      resolve(ok);
    };
  });
}
$('confirm-modal-ok').onclick = () => _confirmModalResolve && _confirmModalResolve(true);
$('confirm-modal-cancel').onclick = () => _confirmModalResolve && _confirmModalResolve(false);
$('confirm-modal').onclick = (e) => { if (e.target.id === 'confirm-modal') _confirmModalResolve && _confirmModalResolve(false); };

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
  const it = itemOf(rel);
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
// 記過的老坑）。強度不在這裡——Concepts 套用每格 LoRA 時直接讀 GEN_LORA_SLOTS[i].strength，
// 跟 LoRA 大面板、設定彈窗「一般」分頁的每格強度滑桿是同一份數字、即時互相同步（見
// renderCsStrength()），不再另外維護一組獨立的「角色/情境強度」。
function _readNum(key, fallback) {
  const v = parseFloat(localStorage.getItem(key));
  return Number.isFinite(v) ? v : fallback;
}
// 張數沒存過時才用裝置判斷給預設值（手機小螢幕塔羅牌面擠不下太多張）；一旦使用者自己
// 調過就記住那個數字，之後不再依裝置改變——使用者的選擇優先於自動判斷的預設。
let CONCEPTS_COUNT = _readNum('yz-concepts-count', isMobile() ? 1 : 8);
let CONCEPTS_WITH_TEMPLATE = localStorage.getItem('yz-concepts-tpl') === '1';
// 模板要不要鎖在左邊詞庫資料夾列表目前選中的那個（CUR_FOLDER）——不勾就跟原本一樣從
// 全部詞庫（ALL）抽。刻意沿用 CUR_FOLDER 而不是另做一個詞庫分類選單：使用者已經在用
// 左邊列表瀏覽/選資料夾了，不用為 Concepts 抽卡另外重複一套選擇 UI。
let CONCEPTS_TPL_CUR_FOLDER = localStorage.getItem('yz-concepts-tpl-cur-folder') === '1';
// 每格是否要參與 Concepts 抽卡的角色/情境判斷——標成「跳過」的格子，不管放了什麼固定
// LoRA、範圍晶片設什麼，drawConceptsTarot() 判斷時都當它不存在（見 slotSignal()）。
// **預設是跳過（true）**：使用者要明確切成「參與判斷」，這格的
// LoRA/範圍才會影響 Concepts——不然單純想用 LoRA1/2 手動生圖，會不小心也悄悄改變
// Concepts 抽卡的行為，使用者反映過這個預設方向。跟 GEN_LORA_SLOTS 一樣 session-only，
// 不存 localStorage：這是「這次生圖想怎麼搭」的暫時決定，不是需要跨分頁記住的偏好。
// 切換入口集中在設定彈窗「一般」分頁（renderCsSkipToggle()），不是 LoRA 大面板——
// 使用者明確要求「一般」分頁要是全域控制面板，不要拆到兩個地方。
const GEN_LORA_SLOT_SKIP = [true, true];
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

// 實測抓到的真正瓶頸（不是猜的）：LoRA 清單一頁最多 80 列，就算每個 <img>/<video>
// 都各自「捲到才載」，只要使用者一次展開/篩選出一批同時進入可視範圍，瀏覽器還是會
// 幾乎同時對十幾二十個檔案開下載——遠端連線的上行頻寬被這樣瞬間塞爆，個別檔案伺服器
// 端只要 1~2 毫秒就處理完，實際卻要等 3~20 秒才傳完，使用者感覺到的「卡」全部發生在
// 這個「同時擠爆頻寬」的階段。用 IntersectionObserver 只解決「該不該載」，解決不了
// 「同時載太多」，這裡再加一層真正的併發上限：不管瀏覽器怎麼判斷，全站 LoRA 預覽
// 同時最多 _PREVIEW_MAX_CONCURRENT 個真的在下載，其餘排隊，上一個真正下載完（或失敗）
// 才輪到下一個——把原本「一次擠爆」攤平成「排隊依序通過」，頻寬永遠只被少數幾個
// 請求佔用，不會全部搶成一團。
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

// src 先存 data-src，捲進視窗（或抽卡等一定會顯示的情境直接呼叫）才透過上面的併發
//佇列排隊真正賦值下載；img/video 共用同一套，load/loadeddata/error 任一個觸發都算
// 「這個名額騰出來了」，輪到下一個排隊的。
//
// 遠端連線偶爾會瞬斷（Tailscale 兩端 peering 有時候會掉幾個封包，是量到過的真實
// 現象，不是臆測），以前失敗一次縮圖就永遠是空白格子，要整批重新整理才會補回來。
// 改成有限次數、間隔遞增的重試——只有第一次嘗試會佔用併發佇列名額（settleOnce
// 在第一次 load/error 就釋放），重試是對已經失敗那格的獨立掛起，不能再讓它占著
// 隊伍名額卡住其他還沒下載過的縮圖。
const _PREVIEW_RETRY_DELAYS_MS = [600, 1800, 4500];

function _previewStart(el, done) {
  const src = el.dataset.src;
  delete el.dataset.src;
  if (!src) { done(); return; }
  let settled = false;
  const settleOnce = () => { if (!settled) { settled = true; done(); } };
  const attemptLoad = (attempt) => {
    const onSettled = () => {
      el.removeEventListener('load', onSettled);
      el.removeEventListener('loadeddata', onSettled);
      el.removeEventListener('error', onError);
      settleOnce();
    };
    const onError = () => {
      el.removeEventListener('load', onSettled);
      el.removeEventListener('loadeddata', onSettled);
      el.removeEventListener('error', onError);
      settleOnce();
      if (attempt < _PREVIEW_RETRY_DELAYS_MS.length) {
        setTimeout(() => attemptLoad(attempt + 1), _PREVIEW_RETRY_DELAYS_MS[attempt]);
      }
    };
    el.addEventListener('load', onSettled);
    el.addEventListener('loadeddata', onSettled);
    el.addEventListener('error', onError);
    // 重試才加 cache-busting query，避免瀏覽器/中介 proxy 對失敗回應做負面快取，
    // 重試打到的是同一個快取住的失敗結果。第一次嘗試維持原始 URL 不變。
    el.src = attempt === 0 ? src : src + (src.includes('?') ? '&' : '?') + '_retry=' + attempt;
    if (el.tagName === 'VIDEO') el.play().catch(() => {});
  };
  attemptLoad(0);
}

const _loraPreviewIO = new IntersectionObserver((entries, obs) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    obs.unobserve(entry.target);
    _previewEnqueue((done) => _previewStart(entry.target, done));
  }
}, { rootMargin: '300px' });   // 提前一點觸發，捲到剛好看到時已經排在佇列裡等下載

// 建一個 LoRA 預覽用的 <img> 或 <video>（依副檔名判斷），呼叫端自己 append 進要放的容器。
function makeLoraPreviewEl(l) {
  let el;
  if (isLoraPreviewVideo(l)) {
    el = document.createElement('video');
    el.muted = true; el.loop = true; el.playsInline = true; el.preload = 'none';
  } else {
    el = document.createElement('img');
  }
  el.dataset.src = loraPreviewUrl(l);
  _loraPreviewIO.observe(el);
  return el;
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
      GEN_LORA_SLOT_SKIP[GEN_ACTIVE_SLOT] = false;   // 選了範圍就是明確的參與意圖，自動切回「參與判斷」
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
      GEN_LORA_SLOT_SKIP[GEN_ACTIVE_SLOT] = false;   // 選了子資料夾一樣是明確的參與意圖
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
  GEN_LORA_SLOT_SKIP[GEN_ACTIVE_SLOT] = false;   // 在大面板選定一顆 LoRA 就是明確的參與意圖，自動切回「參與判斷」
  renderGenCurrent();
  renderLmCurrent();
  renderLmList($('lm-search').value);   // 只重繪列表刷新選中的高亮，不重置頁碼/搜尋
  renderCsScopeChips(0); renderCsScopeChips(1);   // 設定彈窗鎖定卡片的縮圖/名稱可能因為換選而過時，一併刷新
}

// LoRA Manager 是獨立埠（7861），連結不能寫死 127.0.0.1——遠端（手機/Tailscale）連
// 暗房時網址列已經是區網或 Tailscale IP，寫死 127.0.0.1 只有在本機瀏覽器上才連得到，
// 遠端點下去會變成連自己裝置的 loopback，當然打不通。改用 location.hostname 現拼，
// 這樣連暗房走的是哪個位址，連 LoRA Manager 就跟著走同一個位址。固定用 http（LoRA
// Manager 本身沒有另外做 HTTPS/憑證），不是 location.protocol，即使暗房開 --https
// 也一樣連 http 的 7861。
const LORA_MGR_ORIGIN = `http://${location.hostname}:7861`;
if ($('lm-manager-link')) $('lm-manager-link').href = `${LORA_MGR_ORIGIN}/loras`;
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
      clear.title = `清空 LoRA ${i + 1}`; clear.setAttribute('aria-label', `清空 LoRA ${i + 1}`); clear.innerHTML = ICON_CLOSE;
      clear.addEventListener('click', (e) => {
        e.stopPropagation();
        // ✕ 在 tab 裡面，點下去滑鼠沒有真的離開 tab，mouseleave 不會觸發，預覽圖
        // 會停在清空前的內容一直浮著——要自己手動關掉（跟 .cs-locked-clear 那顆
        // 清空鈕同一個坑，見上面那份的註解）。
        hideLoraPreviewTip();
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
  detailLink.href = `${LORA_MGR_ORIGIN}/loras?open=${encodeURIComponent((lora.folder || '') + '/' + (lora.file || ''))}`;
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
  overlayOpen($('lora-modal'));
  if (!GEN_LORAS) $('lm-list').innerHTML = '<div class="lora-empty">載入中…</div>';
  renderLmCurrent();
  await fetchGenLoras();
  renderLmCats();
  renderLmSubcats();
  renderLmList($('lm-search').value, true);
  $('lm-search').focus();
}
function closeLoraModal() {
  const modal = $('lora-modal');
  // 關面板時強制收掉 hover 預覽——這個面板裡好幾個地方（LoRA1/2 分頁卡、左欄清單列）
  // 靠 mouseleave 收預覽卡，但關面板（Esc／背景遮罩／點 ✕）當下滑鼠通常還停在被 hover
  // 的元素上沒有真的移開，mouseleave 不一定會觸發，預覽卡會卡住不消失。不能只靠
  // mouseleave，關閉動作本身就要保證收掉。
  hideLoraPreviewTip();
  fadeCloseOverlay(modal, modal.querySelector('.lora-modal-inner'));
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
    { desc: '<b>LoRA 大面板</b>——左欄分類/子資料夾篩選＋搜尋＋翻頁，右欄每段觸發詞各自一張完整文字卡（勾選要用哪幾段）＋強度滑桿＋參考圖；左欄下方「隨機瀏覽」疊一批塔羅卡讓你點選' },
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
  overlayOpen($('shortcuts-overlay'));
  moveHelpPill();
}
function closeShortcuts() {
  const ov = $('shortcuts-overlay');
  fadeCloseOverlay(ov, $('shortcuts-panel'));
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
  renderCsStrength(GEN_ACTIVE_SLOT);   // 設定彈窗「一般」分頁的強度滑桿跟著同步
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
// 已經在畫面上出現過的卡片 id。renderGallery() 是整格重建，若不記著誰是舊的，每按一次
// 生圖都會讓所有既有卡片重播一次進場動畫——整面圖突然一起閃，看起來像畫面壞掉。
const _gcSeen = new Set();
function buildGalleryCard(g, i) {
  const card = document.createElement('div');
  const fresh = !_gcSeen.has(g.id);
  _gcSeen.add(g.id);
  card.className = 'gcard' + (g.done ? '' : ' pending') + (g.err ? ' gr-err' : '') + (fresh ? '' : ' seen');
  card.dataset.gid = g.id;
  // stagger 上限：新卡永遠疊在最前面（陣列反過來走），所以 i 小的就是新的那幾張。
  // 不設上限的話一批 50 張會排到 1.4 秒後才出現最後一張，尾巴看起來像卡住沒反應。
  card.style.setProperty('--i', Math.min(i || 0, 11));
  const sq = document.createElement('div'); sq.className = 'gc-square';
  const img = document.createElement('img'); img.className = 'gen-live'; img.alt = ''; img.decoding = 'async';
  img.onload = () => img.classList.add('ld');
  if (g.done) img.src = '/api/gen-result?id=' + g.id;
  img.onclick = () => {
    const gg = GALLERY.find(x => x.id === g.id);
    if (!gg || !gg.done) return;
    MODAL_FROM_TAROT = false;
    // 左右切走整個圖庫（畫面上的順序），還在生的沒有圖可看、跳過
    MODAL_LIST = { kind: 'gallery', items: galleryOrder().filter(x => x.done) };
    openGalleryItem(g.id);
  };
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
  // 開啟圖庫是一次「換頁」，整批卡片一起進場才有進到新畫面的感覺——清掉已見過的名單，
  // 讓這一次全部重播（之後在圖庫裡新增才只動新卡，見 buildGalleryCard）。
  _gcSeen.clear();
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
  overlayOpen($('cs-modal'));
  await fetchGenLoras();
  renderCsScopeChips(0);
  renderCsScopeChips(1);
  moveCsTabPill();
  loadCheckpointPicker();
}
// checkpoint 選擇器：只列 DARKROOM_CHECKPOINT_ROOT 那個資料夾（見後端 /api/checkpoints），
// 只影響生圖模式，見 preview_ui.py 的 apply_checkpoint_override() 說明。
async function loadCheckpointPicker() {
  const sel = $('cs-checkpoint');
  if (!sel) return;
  try {
    const r = await fetch('/api/checkpoints');
    const j = await r.json();
    sel.innerHTML = '';
    if (!j.items || !j.items.length) {
      const opt = document.createElement('option');
      opt.textContent = '（找不到 checkpoint 資料夾）';
      opt.disabled = true; opt.selected = true;
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    for (const file of j.items) {
      const opt = document.createElement('option');
      opt.value = file;
      opt.textContent = file.replace(/\.safetensors$/i, '');
      if (file === j.current) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch (e) {
    sel.innerHTML = '<option disabled selected>載入失敗</option>';
  }
}
$('cs-checkpoint').onchange = async (e) => {
  const file = e.target.value;
  try {
    const r = await fetch('/api/checkpoint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    const j = await r.json();
    if (j.error) { toast('設定失敗：' + j.error); return; }
    toast('底模已切換：' + file.replace(/\.safetensors$/i, ''));
  } catch (e) {
    toast('設定失敗，連不到伺服器');
  }
};
function closeCsModal() {
  hideLoraPreviewTip();   // 鎖定卡片（.cs-locked-card）hover 預覽同樣的收尾保險，見 closeLoraModal()
  fadeCloseOverlay($('cs-modal'), $('cs-modal-inner'));
}
$('concepts-settings-btn').onclick = (e) => { e.stopPropagation(); openCsModal(); };
$('cs-modal-close').onclick = closeCsModal;
$('cs-modal').addEventListener('click', e => { if (e.target.id === 'cs-modal') closeCsModal(); });
// 教學疊層：純展示、不影響任何狀態，開關動畫跟 closeCsModal() 同一套寫法。從 cs-modal
// 裡的「？ 詳細教學」按鈕開，關掉只是收起這層，cs-modal 本身還開著。
function openLoraHelpModal() { overlayOpen($('lora-help-modal')); }
function closeLoraHelpModal() {
  fadeCloseOverlay($('lora-help-modal'), $('lora-help-inner'));
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
// 每格自己的強度滑桿——跟 #lm-strength 是同一份 GEN_LORA_SLOTS[i].strength，這裡改了
// 也要同步更新 LoRA 大面板（面板當下顯示的剛好是這格才需要動，見 renderLmCurrent 開面板
// 時本來就會照 slot.strength 設定初始值，不用另外處理）。
$('cs-tab-general').addEventListener('input', (e) => {
  const el = e.target.closest('input[id^="cs-str-"]'); if (!el) return;
  const i = Number(el.id.slice('cs-str-'.length));
  const v = parseFloat(el.value);
  GEN_LORA_SLOTS[i].strength = v;
  const out = document.querySelector(`#cs-str-${i}-out`); if (out) out.textContent = v.toFixed(2);
  if (GEN_ACTIVE_SLOT === i) {
    const lmS = $('lm-strength'), lmOut = $('lm-strength-out');
    if (lmS) lmS.value = v;
    if (lmOut) lmOut.textContent = v.toFixed(2);
  }
});
const $csCount = $('cs-count');
const $csTpl = $('cs-tpl');
const $csTplCurFolder = $('cs-tpl-cur-folder');
renderCsStrength(0); renderCsStrength(1);
$csCount.value = CONCEPTS_COUNT;
$csTpl.checked = CONCEPTS_WITH_TEMPLATE;
$csTplCurFolder.checked = CONCEPTS_TPL_CUR_FOLDER;
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
  // 只要前 30 筆：湊滿就停，不必為了丟掉而掃完整個 28000 筆詞庫（每次按鍵都會跑）。
  // 比對用預先算好的小寫鍵（見 indexAll），省掉每筆兩次 toLowerCase() 的字串配置。
  const hits = [];
  for (const x of ALL) {
    if (x._lname.includes(q) || x._lfolder.includes(q)) { hits.push(x); if (hits.length >= 30) break; }
  }
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
  if (label === el.dataset.plain) return;
  el.dataset.plain = label;
  el.innerHTML = conceptsLockLabelHTML();   // 畫面顯示用，鎖頭圖示是 SVG
  el.title = label;   // CSS 會截斷過長的 LoRA 標題（見 darkroom.css .concepts-lock），完整內容靠原生 hover tooltip 補回來；title 不能塞 HTML，用純文字版
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
  const order = galleryOrder();
  let gi = order.findIndex(x => x.id === gid);
  const list = gi < 0 ? (g ? [g] : []) : order;
  if (gi < 0) gi = 0;
  const stage = buildModalStage(list, gi, renderGallerySlide);
  // 生成結果不一定是正方形（各引擎的預設尺寸不同），舞台的長寬比跟著中央那張走，
  // 不然直幅圖會被上下留一大片黑。詞庫預覽都是 1:1，走 CSS 的 --ar 預設值就好。
  const cur = stage.querySelectorAll('.m-slide')[MODAL_WIN];
  const curImg = cur && cur.querySelector('img');
  if (curImg) curImg.addEventListener('load', () => {
    if (curImg.naturalWidth && curImg.naturalHeight)
      stage.style.setProperty('--ar', curImg.naturalWidth + ' / ' + curImg.naturalHeight);
  }, { once: true });
  left.appendChild(stage);
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
  if (g) right.insertAdjacentHTML('beforeend', modalScoreRowsHTML(g.score));
  inner.append(left, right);
  overlayOpen($('modal'));
}

// Concepts 抽卡：跟一般抽卡生圖不同，不是「固定 LoRA、抽不同詞庫」，而是**每張卡各自**
// 隨機配一組 LoRA。強度直接讀 GEN_LORA_SLOTS[i].strength（跟 LoRA 大面板、「一般」分頁
// 每格強度滑桿同一份，見 buildConceptsPickers()）；張數／是否抽詞庫模板讀獨立的 Concepts
// 設定彈窗（CONCEPTS_COUNT／CONCEPTS_WITH_TEMPLATE，宣告都在上面、跟 GEN_LORA_SLOTS 同一
// 區——不是這裡，理由是彈窗控制項的初始值要在腳本載入當下就同步設定，寫在後面會撞 TDZ：
// CLAUDE.md 記過的老坑，這次是動手前就避開，不是修出來的）。沒開模板就只用這張卡的 LoRA
// trainword 當 prompt（rel 送空字串，後端 _gen_one_worker 會跳過詞庫載入，只留品質標籤）。
//
// C／R／E 三鍵共用 buildConceptsPickers() 算出來的「這格現在的訊號」（見該函式），差別
// 只在兩處：
//   ① autoFillConcept——只有 C 開：角色/情境都沒被覆蓋、且還有空著的格子時，自動補一顆
//     全庫隨機 concepts。R／E 單純照兩格現在的樣子字面套用，不做這個補位。
//   ② 模板池——C 照設定彈窗的兩個 checkbox（同時抽詞庫模板／只抽目前資料夾）；R 固定
//     全庫、E 固定目前資料夾，都無視 checkbox（跟 R／E 在瀏覽/生圖模式的既有語意一致）。
function drawConceptsTarot() {
  const pickers = buildConceptsPickers(true);
  if (!pickers) return;
  _runConceptsDraw(pickers, { useTemplate: CONCEPTS_WITH_TEMPLATE, folderOnly: CONCEPTS_TPL_CUR_FOLDER });
}
function drawConceptsTarotFull() {   // R：不補位，模板固定全庫
  const pickers = buildConceptsPickers(false);
  if (!pickers) return;
  _runConceptsDraw(pickers, { useTemplate: true, folderOnly: false });
}
function drawConceptsTarotFolder() {   // E：不補位，模板固定目前資料夾
  const pickers = buildConceptsPickers(false);
  if (!pickers) return;
  _runConceptsDraw(pickers, { useTemplate: true, folderOnly: true });
}

// Concepts 抽卡核心：pickers 是 buildConceptsPickers() 算好的一組「抽一次」函式（0~2 個，
// 固定的每次都回傳同一顆、範圍的每次呼叫各自重新隨機），每張卡呼叫一輪 pickers 湊出這張
// 卡要套的 LoRA 陣列。tplMode.useTemplate 決定要不要抽模板，folderOnly 決定模板池是全庫
// 還是只限目前資料夾。
function _runConceptsDraw(pickers, tplMode) {
  // 鎖定了固定模板就不用管隨機池——鎖定自動視同「要抽模板」，跟 tplMode 無關（不用強制
  // 連動去改 UI 上的勾選框，鎖定本身就是更高優先權的判斷）。
  const lockedTpl = CONCEPTS_LOCKED_TEMPLATE;
  const useTemplate = tplMode.useTemplate || !!lockedTpl;
  const tplPool = lockedTpl ? null : (tplMode.folderOnly
    ? ALL.filter(x => (x.folder || '(根目錄)') === CUR_FOLDER)
    : ALL);
  if (useTemplate && !lockedTpl && !tplPool.length) {
    toast(tplMode.folderOnly ? `「${CUR_FOLDER || '(根目錄)'}」底下沒有詞庫可抽模板` : '要同時抽詞庫模板，但目前沒有任何詞庫');
    return;
  }
  CONCEPTS_TAROT = true;
  document.body.classList.add('concepts-tarot-open');
  const want = CONCEPTS_COUNT;
  // 隨機側沒有使用者勾選狀態可用，退而求其次只抓第一段當代表；固定側（signalPicker 的
  // fixed 分支）本來就會帶上照 twPicks 算好的 trigger（見 slotTriggerText），這裡用 ??
  // 不是 ||，是因為「使用者把全部段落都取消勾選」得到的空字串 "" 要保留原樣，不能被 ||
  // 誤判成假值又退回抓第一段。
  const firstTw = (l) => (l.trainedWords || [])[0] || '';
  const jobs = [], picks = [];
  for (let i = 0; i < want; i++) {
    const picked = pickers.map(fn => fn());   // [{lora,strength,trigger?}, ...]，0~2 個
    const loras = picked.map(p => ({ folder: p.lora.folder, file: p.lora.file, title: p.lora.title || p.lora.name, strength: p.strength }));
    // 強度 0 等於這顆 LoRA 完全不生效（inject_lora 送 strength_model/clip=0，數學上是
    // no-op），對應的觸發詞就不該還寫進 prompt——使用者拿「設強度 0」當「這次不要套用」
    // 的手動關閉開關，回報過如果沒濾掉會很意外：明明調成 0 了，prompt 裡卻還看得到那些詞。
    let trigger = joinTriggerParts(picked.map(p => p.strength > 0 ? (p.trigger ?? firstTw(p.lora)) : ''));
    let rel = '';
    let label = picked.map(p => p.lora.title || p.lora.name).join(' × ') || '（無 LoRA）';
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
  // 每格「參與判斷」時：固定的 LoRA 直接套用、已跳過的當它不存在；只設了範圍（沒固定）的
  // 這批裡**每張圖各自重新隨機抽一次**，不是整批共用同一顆——跟 Concepts 疊層裡 R/E 的
  // 判斷完全同一套（buildGenPickers()/slotSignal()/signalPicker()），不再是只認「格子裡
  // 有沒有實際放一顆 LoRA」。後端依陣列長度注入 0~2 個 LoraLoader（見 preview_ui.py
  // /api/gen）。範圍隨機側沒有使用者勾選狀態可用，觸發詞退而求其次抓第一段當代表（跟
  // Concepts 一致）；固定側的觸發詞已經包含在 baseTrigger 裡（genTriggerText 讀
  // GEN_LORA_SLOTS 本尊），這裡只需要補範圍隨機側缺的那份——signalPicker 的固定分支才
  // 會帶 trigger 欄位，用這個分辨是不是固定側，不用另外傳旗標。
  const pickers = buildGenPickers();
  if (pickers === null) return;   // 範圍內沒有 LoRA 可抽，buildGenPickers() 已經 toast 過了
  const baseTrigger = genTriggerText();
  const firstTw = (l) => (l.trainedWords || [])[0] || '';
  const jobs = rels.slice(0, 64).map(rel => {
    const picked = pickers.map(fn => fn());
    const loras = picked.map(p => ({ folder: p.lora.folder, file: p.lora.file, title: p.lora.title || p.lora.name, strength: p.strength }));
    const extra = joinTriggerParts(picked.filter(p => p.trigger === undefined && p.strength > 0).map(p => firstTw(p.lora)));
    return { rel, loras, trigger: joinTriggerParts([baseTrigger, extra]) };
  });
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
    GALLERY.push({ id: it.id, name: it.name, rel: it.rel, folder: (itemOf(it.rel) || {}).folder || '',
                   loras: job.loras || [], trigger: job.trigger || '', ts, done: false, err: false, seed: null });
  });
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
    GALLERY.push({ id: it.id, name: it.name, rel: it.rel, folder: (itemOf(it.rel) || {}).folder || '',
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
  if (title) title.innerHTML = label ? `${ICON_SPARKLE}${label}　抽選${CN_NUM[n] || n}張生圖${ICON_SPARKLE}` : `${ICON_SPARKLE}抽選${CN_NUM[n] || n}張生圖${ICON_SPARKLE}`;
  const wrap = $('tarot-cards');
  wrap.classList.remove('ttag');
  $('tarot-stage').classList.remove('ttag-stage');
  $('tarot-cancel-gen').hidden = false;
  $('tarot-hint').textContent = CONCEPTS_TAROT
    ? '牌面即時顯示生成中的採樣畫面；完成後點卡片看大圖，C 照「一般」分頁判斷重抽、R 模板改全庫、E 模板限目前資料夾、Esc 關閉'
    : label
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
         <div class="tarot-back"><span class="tarot-emblem">${ICON_SPARKLE}</span></div>
         <div class="tarot-front gen-front">
           <img class="gen-live" decoding="async" alt="" onload="this.classList.add('ld')">
           <div class="gen-spin"><i class="gen-loader"></i></div>
           <div class="tarot-badges"></div>
           <div class="tarot-name"></div>
           <div class="tarot-folder"></div>
           <div class="tarot-glare"></div>
         </div>
       </div>`;
    card.querySelector('.tarot-name').textContent = item.display_name || item.name || it.name;
    card.querySelector('.tarot-folder').textContent = item.folder || '(根目錄)';
    // 疊上層，關掉回到這批牌；左右切走的是**這批生圖裡已經完成的那些**（還在生的
    // 沒有圖可看，切過去只會是空的）
    card.addEventListener('click', () => {
      if (card.classList.contains('pending')) return;
      MODAL_FROM_TAROT = true;
      MODAL_LIST = { kind: 'gallery',
        items: CUR_GEN_TAROT_IDS.map(id => GALLERY.find(g => g.id === id)).filter(g => g && g.done) };
      openGalleryItem(it.id);
    });
    if (!REDUCE) {
      card.addEventListener('mousemove', e => tiltCard(card, e));
      card.addEventListener('mouseleave', () => tiltReset(card));
    }
    wrap.appendChild(card);
  });
  overlayOpen($('tarot'));
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
    if (s.status === 'done') { g.done = true; g.seed = s.seed; if (s.score) g.score = s.score; }
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
      if (s.score && !card.querySelector('.score-badge')) {
        // .gen-front/.tarot-front 把名稱/資料夾文字跟圖片放在同一個 flex 欄位裡，徽章要塞進
        // .tarot-badges（跟圖片疊在一起、大小卡在同一個正方形區域，見該 class 的 CSS 註解），
        // 不能直接塞進整個卡片最後面——那樣 bottom:8px 會貼齊「整張卡片」的底部，疊到文字
        // 行上而不是圖片上。.gc-square 沒有這個問題（裡面只有圖片，文字是外面的手足元素），
        // 找不到 .tarot-badges 就照舊塞進容器本身。
        const front = card.querySelector('.gen-front, .tarot-front, .gc-square');
        const anchor = front && (front.querySelector('.tarot-badges') || front);
        if (anchor) anchor.insertAdjacentHTML('beforeend', scoreBadgeHTML(s.score));
      }
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
// 評分是生成完成後另起的背景任務，status 變 done 的當下分數通常還沒算完；
// 多等幾輪（~5s）讓它有機會追上，等不到就放棄——不影響圖片本身已經顯示完成。
const GEN_SCORE_WAIT_MAX = 10;
const _genScoreWaits = new Map();   // gid -> 已經多等了幾輪
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
      if (s.status === 'error' || s.status === 'cancelled') {
        GEN_PENDING.delete(gid); _genScoreWaits.delete(gid);
        continue;
      }
      if (s.status === 'done') {
        if (s.score) { GEN_PENDING.delete(gid); _genScoreWaits.delete(gid); continue; }
        const waits = (_genScoreWaits.get(gid) || 0) + 1;
        if (waits >= GEN_SCORE_WAIT_MAX) { GEN_PENDING.delete(gid); _genScoreWaits.delete(gid); }
        else _genScoreWaits.set(gid, waits);
      }
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
  introReveal();   // 印樣的顯影要等 boot 讓開才開始播，不然全被蓋著跑完了
  setTimeout(() => b.remove(), 600);
}
/* ---------------------------------------------------------------------------
   進場畫面「印樣瀑布」
   ---------------------------------------------------------------------------
   整片詞庫的接觸印樣鋪滿畫面，滿版、不減光，而且**一直在往下流**——每一欄各有
   自己的速度與起始相位，所以看起來是好幾道各流各的水，不是一張大圖在平移。

   實作是**單一全螢幕片段著色器**，原生 WebGL、不依賴任何函式庫（也就不用動
   STATIC_FILES、不用重啟伺服器）。64 張縮圖畫進一張 atlas canvas 上傳成單一材質，
   全畫面一次 draw call；捲動只是著色器裡的 uv 運算，沒有任何圖層在搬移。

   **不用 mipmap，改成「顯示多大就送多大」**：atlas 的格子邊長依實際會顯示的畫布
   像素挑 THUMB_SIZES 的級距（見 introCellSize），讓縮小倍率待在 1.5 以下。這條是
   CLAUDE.md 記過的坑——會動的畫面上縮小取樣就是閃爍與摩爾紋的來源。反過來說也
   不能用 mipmap 解決：atlas 的 uv 在每個格子邊界都是不連續的，GPU 依導數挑 mip
   會在每一條格線上挑到最低階，變成一圈糊掉的邊。

   退化路徑：WebGL 拿不到 → DOM 版（CSS transform 的欄式瀑布）；系統要求減少動態
   → 走退化版、靜止不動。
   --------------------------------------------------------------------------- */
const INTRO_COLS = 8, INTRO_ROWS = 8;   // atlas 的格數；縱向 8 格 = 一欄要跑很久才重複
// 每欄的流速（格/秒）區間。下限不能太低，否則看起來是「畫面在飄」而不是「在流」。
const INTRO_FLOW_MIN = 0.30, INTRO_FLOW_VAR = 0.22;
const INTRO_FADE_MS = 900;         // 一格從底色顯影到滿的時間
const INTRO_CELL_FAILED = -2;      // at[i] 的哨兵值：這格的縮圖載入失敗，永遠不會顯影
// boot 載入畫面至少要等到這個比例的格子到齊才收（上限 INTRO_WARMUP_MAX_MS）。
// 沒有這段等待的話，boot 一收起看到的是一整片底色，圖才陸續補上——那個空窗比
// 多轉半秒的載入動畫難看得多。
const INTRO_WARMUP_RATIO = 0.55, INTRO_WARMUP_MAX_MS = 2200;

let introGL = null;         // { gl, prog, loc, tex, canvas, … } 或 null（退化模式）
let introRAF = null;
let introT0 = 0;
let introPool = [];         // 候選詞庫（有圖的）
let introAtlas = null;      // { canvas, ctx, cell, dirty, any }

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
// 每格的顯影進度（0..1）。用一張 COLS×ROWS 的 NEAREST 材質而不是 uniform 陣列：
// GLSL ES 1.0 的片段著色器不保證能用算出來的索引讀 uniform 陣列，而格號本來就是
// 算出來的。這張圖只有 64 bytes，每幀重傳的成本可以忽略。
uniform sampler2D uCell;

const float COLS = ${INTRO_COLS}.0;
const float ROWS = ${INTRO_ROWS}.0;

float hash11(float n) { return fract(sin(n * 127.1) * 43758.5453); }

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
  float cw = aspect / COLS;                   // 一格的邊長（場景單位）。格子是正方形

  float cf = (p.x + aspect * 0.5) / cw;
  float ci = floor(cf);
  float fx = cf - ci;

  // 每欄自己的流速與起始相位：整片等速下滑會讀成「一張大圖在平移」，錯開才有瀑布
  float sp = ${INTRO_FLOW_MIN.toFixed(2)} + ${INTRO_FLOW_VAR.toFixed(2)} * hash11(ci + 0.5);
  float rf = (0.5 - p.y) / cw - uTime * sp + hash11(ci + 11.7) * ROWS;
  float ri = floor(rf);
  float fy = rf - ri;

  // mod 把格號捲回 atlas 範圍。uv 在格子邊界是不連續的——LINEAR 取樣不在意（只有
  // mipmap 會依導數挑階），所以這裡刻意沒有 mipmap，見上方 darkroom.js 的說明。
  vec2 cell = vec2(mod(ci, COLS), mod(ri, ROWS));
  vec2 uv = (cell + vec2(fx, fy)) / vec2(COLS, ROWS);
  vec3 bg = vec3(0.031, 0.035, 0.051);

  // 每格自己的顯影：縮圖到齊時不是「啪一下出現」，而是從底色淡上來。取格子中心
  // 的 texel，uCell 是 NEAREST，所以整格拿到同一個值。
  float f = texture2D(uCell, (cell + 0.5) / vec2(COLS, ROWS)).r;
  // smoothstep 曲線（兩頭慢、中段快）比線性淡入更像顯影，也不會有「開始」的硬邊
  vec3 col = mix(bg, texture2D(uTex, uv).rgb, f * f * (3.0 - 2.0 * f));

  // 只有很輕的暗角：印樣本身是滿版不減光的，這裡單純把視線收回來。
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

  // 全螢幕兩個三角形
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // atlas 可能是 NPOT（1536²）：CLAMP_TO_EDGE + LINEAR、不產 mipmap 才合法，
  // 而且不產 mipmap 本來就是這個著色器要的（uv 在格線上不連續，見上方說明）。
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([8, 9, 13]));

  // 每格的顯影進度：COLS×ROWS 的 LUMINANCE 材質，NEAREST（整格要拿到同一個值，
  // 不能被相鄰格內插）。UNPACK_ALIGNMENT 設 1，否則列寬不是 4 的倍數時會錯位。
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
  return { gl, prog, loc, tex, cellTex, canvas, maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
}

function introResize() {
  if (!introGL) return;
  const { gl, canvas, loc } = introGL;
  // DPR 夾在 1.5：整片著色器的成本跟像素數成正比，2x 螢幕上翻四倍不值得
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  // uRes 每次都要寫：它是**程式**的 uniform，而畫布尺寸是**元素**的屬性。兩者
  // 生命週期不同——重開進場（畫布已經是對的尺寸、但 program 是新建的）時，若跟著
  // 尺寸一起提早 return，新 program 的 uRes 會停在 0，著色器裡 aspect = 0/0 = NaN，
  // 畫面整片全黑。只有真正會改變畫布緩衝區的那兩行需要判斷尺寸。
  gl.uniform2f(loc.uRes, w, h);
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w; canvas.height = h;
  gl.viewport(0, 0, w, h);
}

// 一格要送多大的縮圖：依「這一格實際會佔幾個畫布像素」挑 THUMB_SIZES 的級距，
// 取「大於等於它的最小級距」——寧可放大一點點糊，也不要縮小造成閃爍與摩爾紋。
// 上限壓在 256（8 格 = 2048² 材質，再上去記憶體不划算，而放大的糊不會閃）。
function introCellSize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const want = (window.innerWidth * dpr) / INTRO_COLS;
  for (const s of [128, 192, 256]) if (s >= want) return s;
  return 256;
}

// 建立印樣 atlas：每格畫一張縮圖，四邊各內縮 2px 露出底色＝格線。接觸印樣本來
// 就長這樣，而且這條縫也順便蓋掉格子邊界上的取樣溢出。
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
    reveal: 0,                          // 顯影可以開始播的時間戳（0 = boot 還蓋著）
    at: new Float64Array(n).fill(-1),   // 每格縮圖到齊的時間戳（-1 = 還沒到）
    // 縮圖常常是一整批同時回來（尤其後端有快取時），全部同時淡入就跟「啪一下
    // 出現」沒兩樣。每格再加一點隨機延遲，讓它們錯開成一片陸續浮現。
    lag: Float64Array.from({ length: n }, () => Math.random() * 420),
    px: new Uint8Array(n),              // 送進 uCell 的進度值
    fading: true,                       // 還有格子在動就要每幀重傳 uCell
  };
}

// 逐格載入縮圖。每到一張就標記 dirty，由幀迴圈**一幀最多重傳一次**材質——
// 64 張各自觸發一次 texImage2D 會在網路密集回來時連續丟出幾十次十幾 MB 的上傳。
//
// 這裡曾經是實測抓到的真正卡頓元兇：開場動畫一開頁就對 INTRO_COLS×INTRO_ROWS
// （8×8＝64 張）縮圖同時發出請求，完全沒有節流——不是 <img loading="lazy">，是
// 畫布材質貼圖，連瀏覽器原生的捲動延遲載入都套用不上。伺服器端每張縮圖只要幾十
// 毫秒，但 64 張同時搶同一條上傳頻寬，遠端連線量到單張要等好幾秒甚至幾十秒，
// 而且每次開頁都會重演一次。改成跟 LoRA 預覽／主圖庫縮圖共用同一套併發佇列
// （_previewEnqueue，見 makeLoraPreviewEl 的長註解），同時最多幾個真的在下載，
// 其餘排隊，不再一次性擠爆。
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
        const s = Math.min(img.width, img.height);      // cover 裁切自己算，drawImage 不做
        introAtlas.ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s,
                                 cx + 2, cy + 2, cell - 4, cell - 4);
        introAtlas.dirty = true;
        if (introAtlas.at[i] < 0) { introAtlas.at[i] = performance.now(); introAtlas.count++; }
        introAtlas.fading = true;
      }
      if (img._releasePreviewSlot) img._releasePreviewSlot();
    };
    // 載入失敗的格子留空（底色），不影響其餘；標成哨兵值免得顯影迴圈一直等它
    img.onerror = () => {
      if (introAtlas && introAtlas.at[i] < 0) { introAtlas.at[i] = INTRO_CELL_FAILED; introAtlas.count++; }
      if (img._releasePreviewSlot) img._releasePreviewSlot();
    };
    // 這裡要的是「正好 cell 像素」的來源，不隨 DPR 再放大，所以不走 thumbURL(it, px)。
    // src 賦值本身（真正觸發網路請求）交給佇列排隊，輪到才做。
    _previewEnqueue((done) => {
      img._releasePreviewSlot = done;
      img.src = `/api/thumb?rel=${encodeURIComponent(it.rel)}&v=${it.image_mtime}&w=${cell}`;
    });
  }
}

// boot 開始淡出時呼叫：這一刻起才播顯影。已經到齊的格子會從這裡一起（各自帶著
// lag 錯開地）浮現，之後才到的則以自己的到齊時間為準。
function introReveal() {
  if (introAtlas && !introAtlas.reveal) {
    introAtlas.reveal = performance.now() + 180;   // 讓 boot 先讓開一點點再開始
    introAtlas.fading = true;
  }
}

// boot 載入畫面多轉一下，等印樣鋪到看得出是一片圖再收。用 setTimeout 而不是 rAF——
// 分頁在背景時 rAF 不觸發，那樣會一路撐到上限才放行（CLAUDE.md 記過的老坑）。
function introWarmup() {
  if (!introAtlas) return Promise.resolve();
  const need = Math.ceil(INTRO_COLS * INTRO_ROWS * INTRO_WARMUP_RATIO);
  const t0 = performance.now();
  return new Promise(res => {
    const tick = () => {
      if (!introAtlas || introAtlas.count >= need || performance.now() - t0 > INTRO_WARMUP_MAX_MS) res();
      else setTimeout(tick, 70);
    };
    tick();
  });
}

function introFrame(now) {
  if (!introGL || !$('intro-modal').classList.contains('open')) { introRAF = null; return; }
  const { gl, loc } = introGL;
  if (!introT0) introT0 = now;
  introResize();

  // atlas 重傳：一幀最多一次（十幾 MB 的上傳，不能每張縮圖各觸發一次）
  if (introAtlas && introAtlas.dirty) {
    gl.bindTexture(gl.TEXTURE_2D, introGL.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, introAtlas.canvas);
    introAtlas.dirty = false;
  }
  // 每格的顯影進度。全部跑完就不再重傳——這張圖雖然只有 64 bytes，但 texImage2D
  // 本身有固定開銷，穩定播放時沒必要每幀都付。
  if (introAtlas && introAtlas.fading) {
    let moving = false;
    for (let i = 0; i < introAtlas.px.length; i++) {
      const t0 = introAtlas.at[i];
      if (t0 === INTRO_CELL_FAILED) continue;           // 這格永遠不會來，別讓它一直撐著
      if (t0 < 0) { moving = true; continue; }          // 縮圖還沒到，之後才會開始
      // 起算點取「縮圖到齊」與「boot 讓開」兩者的晚者：warmup 期間到齊的那批不能
      // 在 boot 底下就把顯影跑完，要留到畫面露出來才一起（錯開地）浮現。
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

// 退化模式：拿不到 WebGL（或系統要求減少動態）時用 DOM 做同一件事——每欄一個
// 直條，內容重複兩份、用 CSS transform 平移 -50% 無縫循環。沒有 shader，但「印樣
// 一直往下流」這件事還在，題字與進入鈕照常可用。
function introFallback() {
  const box = $('intro-fallback');
  if (!box || !introPool.length) return;
  box.hidden = false;
  box.innerHTML = '';
  const cell = introCellSize();
  for (let c = 0; c < INTRO_COLS; c++) {
    const colEl = document.createElement('div');
    colEl.className = 'intro-fb-col';
    // 速度換算成「跑完 ROWS 格要幾秒」，跟著色器那組流速對齊，欄與欄之間錯開
    const sp = INTRO_FLOW_MIN + INTRO_FLOW_VAR * ((c * 7 % 5) / 5);
    colEl.style.setProperty('--dur', (INTRO_ROWS / sp).toFixed(1) + 's');
    colEl.style.setProperty('--delay', (-((c * 3.7) % INTRO_ROWS) / sp).toFixed(1) + 's');
    const inner = document.createElement('div');
    inner.className = 'intro-fb-run';
    for (let k = 0; k < INTRO_ROWS * 2; k++) {      // 兩份，平移 -50% 才接得上
      const it = introPool[(c * INTRO_ROWS + (k % INTRO_ROWS)) % introPool.length];
      const img = new Image();
      img.alt = ''; img.decoding = 'async'; img.fetchPriority = 'low';
      // 跟 WebGL 版一樣不要「啪一下出現」：到齊才加 .in，由 CSS 過渡淡上來。
      // inline 的 transition-delay 播完一定要拆掉——它對這個元素上「所有」過渡都
      // 生效，留著會拖累之後的任何過渡（CLAUDE.md 記過的坑）。
      const lag = Math.round(Math.random() * 420);
      img.style.transitionDelay = lag + 'ms';
      img.addEventListener('load', () => {
        img.classList.add('in');
        setTimeout(() => { img.style.transitionDelay = ''; }, lag + INTRO_FADE_MS + 60);
      }, { once: true });
      // 退化模式一次要跑 INTRO_COLS×INTRO_ROWS×2（8×8×2＝128 張），比 WebGL 版更多，
      // 一樣不能不排隊直接發——見 introLoadCells() 那則長註解，同一個病根、同一套
      // _previewEnqueue 佇列解法。src 賦值本身交給佇列，輪到才做；沒有另外的
      // release 收尾動作要做（load/error 各自的效果已經在上面/下面接好了），所以
      // 這裡的 done 直接掛在 load/error 上就好。
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

function maybeStartIntro() {
  if (!ALL.length) return;
  introPool = ALL.filter(x => x.has_image);
  if (introPool.length > 400) {   // 只抽樣就夠，不必為了隨機掃全庫
    const s = [];
    for (let i = 0; i < 160; i++) s.push(introPool[Math.floor(Math.random() * introPool.length)]);
    introPool = s;
  }
  // 卡片上的數字全部是真的，不是裝飾性編號——這個工具本來就在追蹤這三個。
  const total = ALL.length;
  const have = ALL.filter(x => x.has_image).length;
  const folders = new Set(ALL.map(x => x.folder)).size;
  const stats = $('intro-stats');
  if (stats) {
    const n = (v) => v.toLocaleString('en-US');
    // 全都有圖時「27,951 / 27,951」是廢話，改成百分比才有資訊
    const cover = have >= total ? '100%' : n(have);
    stats.innerHTML = '';
    for (const [v, k] of [[n(total), '詞庫'], [n(folders), '資料夾'], [cover, '已顯影']]) {
      const box = document.createElement('div');
      box.className = 'stat';
      const nv = document.createElement('span'); nv.className = 'stat-n'; nv.textContent = v;
      const kv = document.createElement('span'); kv.className = 'stat-k'; kv.textContent = k;
      box.append(nv, kv);
      stats.appendChild(box);
    }
  }
  // 目前操作的詞庫資料夾。跟頂欄用同一個來源（setDataset 已經截好尾兩段），
  // 兩個 bat 開同一個 port 但指不同 special_dir，這行是進門前就能分辨的依據。
  const kicker = $('intro-kicker');
  if (kicker) kicker.textContent = ($('dataset') && $('dataset').textContent) || '';

  overlayOpen($('intro-modal'));
  introGL = REDUCE_MOTION ? null : introInitGL();
  if (!introGL) { introFallback(); return; }
  introAtlas = introBuildAtlas();
  introResize();
  introLoadCells();
  introT0 = 0;
  introRAF = requestAnimationFrame(introFrame);
}

function closeIntro() {
  const modal = $('intro-modal');
  if (introRAF) { cancelAnimationFrame(introRAF); introRAF = null; }
  fadeCloseOverlay(modal, null, () => {
    // 釋放 GL 資源——進場只播一次，留著等於白佔一張材質與一個 context
    if (introGL) {
      const { gl, tex, cellTex, prog } = introGL;
      gl.deleteTexture(tex); gl.deleteTexture(cellTex); gl.deleteProgram(prog);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      introGL = null;
    }
    introAtlas = null;
    const fb = $('intro-fallback'); if (fb) { fb.innerHTML = ''; fb.hidden = true; }
  });
}

$('intro-enter-btn').addEventListener('click', closeIntro);
window.addEventListener('resize', introResize);
window.addEventListener('keydown', (e) => {
  if (!$('intro-modal').classList.contains('open')) return;
  if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); closeIntro(); }
});

// 18+ 年齡確認擋在 boot 沖洗動畫之前：sessionStorage 記錄「這次瀏覽階段已確認」，
// 分頁/瀏覽器關掉才重問，一般重整與硬重整都不會清掉這個記錄。boot 本身初始
// display:none（見 index.html），確認通過才由 startApp() 顯示、開始跑 loadAll()。
const AGE_GATE_KEY = 'yz-age-verified';
function startApp() {
  // boot 只等「資料到＋首屏渲染完」就關。pollBatch 是常駐背景輪詢——批次執行中它
  // 的 while(true) 永不 resolve，所以**不能**把 hideBoot 鏈在它後面（`() => pollBatch()`
  // 會回傳那個永不結算的 promise），否則只要背景有批次在跑，boot 就會一直等到下面
  // 的 20s 保險逾時才關＝每次刷新都卡整整 20 秒。改成 loadAll 完成後「不 return」地
  // 啟動 pollBatch，讓 finally(hideBoot) 立刻收尾、pollBatch 自行在背景跑。
  // maybeStartIntro() 排在 pollBatch() 之前：進場疊層（z-index 230）比 #boot（300）
  // 低，boot 淡出的 600ms 期間進場畫面已經在底下跑，boot 一收起就無縫接上。
  // introWarmup() 讓 boot 再多轉一下、等印樣鋪到看得出是一片圖才收（有上限），
  // 否則 boot 收起的瞬間是一整片底色。pollBatch() 刻意不 return——它的 while(true)
  // 永不 resolve，鏈在後面會讓 boot 一直等到下面的 20s 保險才關。
  $('boot').style.display = '';
  loadAll().then(() => { maybeStartIntro(); pollBatch(); return introWarmup(); }).finally(hideBoot);
  setTimeout(hideBoot, 20000);   // 保險：萬一 loadAll 本身卡住也別讓載入畫面永遠蓋著
}
function initAgeGate() {
  if (sessionStorage.getItem(AGE_GATE_KEY) === '1') {
    $('age-gate').remove();
    startApp();
    return;
  }
  let ageEntering = false;
  $('age-gate-enter').addEventListener('click', () => {
    if (ageEntering) return;
    ageEntering = true;
    sessionStorage.setItem(AGE_GATE_KEY, '1');
    const gate = $('age-gate');
    const go = () => { gate.remove(); startApp(); };
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
    if (!REDUCE_MOTION && card.animate) {
      card.animate(
        [{ opacity: .4, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
        { duration: 220, easing: 'cubic-bezier(.22,.61,.36,1)' });
    }
  });
}
initAgeGate();
