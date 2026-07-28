/* illustrious.js —— Illustrious SDXL 引擎（API 工作流，lora 已跳過）
 * 基礎文生圖 + 4 條可選分支（關閉時從 prompt 移除節點）。輸出皆為 PreviewImage。
 */
window.YZ_I = {
  CKPT: 'waiIllustriousSDXL_v170.safetensors',   // 固定 checkpoint (node 4)
  MODE_ORDER: ['it2i'],
  MODES: {
    it2i: {
      key: 'it2i', label: '文生圖', desc: 'Illustrious SDXL 文生圖（可選放大）',
      template: 'illustrious.json',
      nodes: { ckpt: '4', prompt: '5', neg: '6', ksampler: '77:75', latent: '7', ref: '39' },
      images: [],
      size: true,
    },
  },
  // ComfyUI 內建比較節點（面板自己做對照）→ 一律移除
  alwaysDelete: ['22', '34', '35', '51'],
  // 增強分支（預設不開；關閉時移除該分支所有節點，含其 PreviewImage）
  enhance: [
    { key: 'hires', name: '第二階段採樣', desc: 'latent 放大 1.5× 後重採樣補細節',
      branch: ['48', '78:58', '78:57', '56'], seedFollow: '78:58' },
    { key: 'controlnet', name: 'ControlNet', desc: '上傳參考圖，用深度控制構圖',
      branch: ['39', '79:44', '79:38', '79:37', '79:36', '79:62', '79:63', '64', '45'],
      requiresRef: true, seedFollow: '79:62' },
    { key: 'seedvr2', name: 'SeedVR2 放大', desc: '成品再用 SeedVR2 放大到 4K',
      branch: ['80:31', '80:32', '80:30', '81'], imageNode: '80:30' },
    { key: 'sdupscale', name: 'SD 放大', desc: 'Ultimate SD Upscale 4×（anime）',
      branch: ['82:15', '82:25', '82:14', '83'], imageNode: '82:14' },
  ],
  // 各輸出的 PreviewImage 節點（收集圖片做對照）
  outputs: { base: '73', hires: '56', controlnet: '64', seedvr2: '81', sdupscale: '83' },
  compareLabels: { hires: '第二階段', controlnet: 'ControlNet', seedvr2: 'SeedVR2', sdupscale: 'SD 放大' },
};
