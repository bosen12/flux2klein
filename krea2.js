/* krea2.js —— Krea2 引擎設定（統一「增強引擎」格式）*/
window.YZ_K = {
  // 固定模型
  UNET: 'redcraft23INT8INT4FP8_30Krea2.safetensors',
  CLIP: 'qwen3vl_4b_fp8_scaled.safetensors',   // type: krea2
  VAE: 'qwen_image_vae.safetensors',

  MODE_ORDER: ['kt2i'],
  MODES: {
    kt2i: {
      key: 'kt2i', label: '文生圖', desc: 'Krea2 文生圖（可選 SeedVR2 / 二次採樣）',
      template: 'krea2.json',
      nodes: { unet: '52', clip: '53', vae: '58', prompt: '51', ksampler: '54', latent: '57' },
      images: [],
      size: true,
    },
  },
  alwaysDelete: [],
  enhance: [
    { key: 'seedvr2', name: 'SeedVR2 高清放大', desc: '用 SeedVR2 模型把成品放大到更高解析度',
      branch: ['129', '131', '133', '69'] },
    { key: 'second', name: '二次採樣', desc: 'latent 放大 2× 後重採樣，補更多細節',
      branch: ['154:137', '154:136', '154:130', '179'], seedFollow: '154:136',
      denoise: '154:136' },   // 開啟後 UI 會長出重繪強度滑桿
  ],
  outputs: { base: '29', seedvr2: '69', second: '179' },
  compareLabels: { seedvr2: 'SeedVR2', second: '二次採樣' },
};
