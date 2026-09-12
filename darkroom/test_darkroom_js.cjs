const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'darkroom.js'), 'utf8');
const start = source.indexOf('async function loadAll(');
const end = source.indexOf('\nfunction folderStats(', start);
assert.ok(start >= 0 && end > start, '找不到 loadAll()');
const loadAllSource = source.slice(start, end);

let releaseOld;
const oldResponse = new Promise(resolve => { releaseOld = resolve; });
const response = data => ({ ok: true, json: async () => data });
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, {
    id, classList: { toggle() {} }, style: { setProperty() {} }, textContent: '', value: '',
  });
  return elements.get(id);
};

const context = vm.createContext({
  fetch: url => {
    if (url === '/api/libs') return oldResponse;
    if (url === '/api/libs?force=1') return Promise.resolve(response({
      items: [{ rel: 'new.py', name: 'new', folder: 'set' }], comfy: true, steps: 25,
    }));
    if (url === '/api/jobs') return Promise.resolve(response({}));
    throw new Error(`未預期的 fetch：${url}`);
  },
  document: { activeElement: null },
  console,
  setTimeout,
});

vm.runInContext(`
  let ALL = [], CUR_FOLDER = 'set', haveCount = 0, loadAllReq = 0;
  const $ = id => globalThis.element(id);
  const indexAll = () => {};
  const setCount = () => {};
  const setDataset = () => {};
  const updateReviewCount = () => {};
  const buildRail = () => {};
  const render = () => {};
  const pollStatus = () => {};
  ${loadAllSource}
`, Object.assign(context, { element }));

(async () => {
  const older = vm.runInContext('loadAll(false)', context);
  const newer = vm.runInContext('loadAll(true)', context);
  await newer;
  releaseOld(response({
    items: [{ rel: 'old.py', name: 'old', folder: 'set' }], comfy: false, steps: 20,
  }));
  await older;

  assert.equal(vm.runInContext('ALL[0].rel', context), 'new.py', '較晚完成的舊請求覆寫了新資料');
  assert.match(source, /let loadAllReq\s*=\s*0;/, '正式程式缺少載入請求世代');
  console.log('loadAll 競態回歸：OK');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
