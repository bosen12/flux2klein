// 離線驗證：不需要 ComfyUI，檢查 6 個模式的 UI→API 轉換是否結構正確
const fs = require('fs');
const path = require('path');
global.window = {};
const code = fs.readFileSync(path.join(__dirname, 'converter.js'), 'utf8');
(0, eval)(code); // 在全域範圍 eval，注入 window.YZ，避免與本檔識別字衝突
const { WorkflowGraph, MODES, MODE_ORDER, setWidgetByName, injectSize, setLoadImage } = window.YZ;

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, 'workflow.json'), 'utf8'));

let failures = 0;
for (const key of MODE_ORDER) {
  const m = MODES[key];
  const g = WorkflowGraph.clone(wf);
  g.applyMode(m.group);

  // 注入假輸入（模擬 app.js）
  setWidgetByName(g, m.prompt, 'text', '測試提示詞');
  setWidgetByName(g, m.seed, 'noise_seed', 12345);
  setWidgetByName(g, m.steps, 'steps', 4);
  for (const slot of m.images) setLoadImage(g, slot.node, { name: 'test.png', subfolder: '', type: 'input' });
  if (m.size) { injectSize(g, m.size.latent, 1024, 1024); injectSize(g, m.size.scheduler, 1024, 1024); }
  if (m.pad) ['left', 'right', 'top', 'bottom', 'feathering'].forEach(k => setWidgetByName(g, m.pad, k, 50));
  if (m.grow) setWidgetByName(g, m.grow, 'expand', 10);

  const { prompt, warnings } = g.toPrompt(null);
  const ids = new Set(Object.keys(prompt));

  // 檢查 1：所有連線指向存在且啟用的節點
  const dangling = [];
  for (const [nid, node] of Object.entries(prompt)) {
    for (const [inName, val] of Object.entries(node.inputs)) {
      if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
        if (!ids.has(val[0])) dangling.push(`${nid}(${node.class_type}).${inName} -> ${val[0]} [不存在]`);
      }
    }
  }
  // 檢查 2：SaveImage 有輸出，且它的 images 輸入有接上
  const saveOk = ids.has(String(m.save)) && Array.isArray(prompt[String(m.save)]?.inputs?.images);
  // 檢查 3：不含其他模式群組的 SaveImage
  const otherSaves = MODE_ORDER.filter(k => k !== key).map(k => String(MODES[k].save)).filter(s => ids.has(s));

  const ok = dangling.length === 0 && saveOk && otherSaves.length === 0;
  if (!ok) failures++;
  console.log(`\n=== 模式 ${m.label} (${key}) ===`);
  console.log(`  節點數: ${ids.size}   狀態: ${ok ? '✅ 通過' : '❌ 失敗'}`);
  console.log(`  SaveImage(${m.save}) 輸出正常: ${saveOk}`);
  if (dangling.length) { console.log('  ⚠ 懸空連線:'); dangling.slice(0, 10).forEach(x => console.log('     ' + x)); }
  if (otherSaves.length) console.log('  ⚠ 混入其他模式 SaveImage:', otherSaves);
  if (warnings.length) { console.log('  轉換警告:'); warnings.slice(0, 8).forEach(w => console.log('     ' + w)); }

  // 抽查 SaveImage 的上游鏈是否合理
  if (saveOk) {
    const chain = [];
    let cur = String(m.save), guard = 0;
    while (cur && guard++ < 12) {
      const node = prompt[cur];
      if (!node) break;
      chain.push(node.class_type);
      // 找第一個是連線的輸入往上追
      let next = null;
      for (const v of Object.values(node.inputs)) if (Array.isArray(v)) { next = v[0]; break; }
      cur = next;
    }
    console.log('  SaveImage 上游鏈:', chain.join(' <- '));
  }
}

console.log(`\n${failures === 0 ? '🎉 全部模式通過' : '❌ ' + failures + ' 個模式失敗'}`);
process.exit(failures === 0 ? 0 : 1);
