/* krea2.js —— Krea2 引擎設定（API 格式工作流，執行時注入 + 依開關裁剪分支）*/
window.YZ_K = {
  // 固定模型
  UNET: 'redcraft23INT8INT4FP8_30Krea2.safetensors',
  CLIP: 'qwen3vl_4b_fp8_scaled.safetensors',   // type: krea2
  VAE: 'qwen_image_vae.safetensors',

  MODE_ORDER: ['kt2i'],
  MODES: {
    kt2i: {
      key: 'kt2i', label: '文生圖', desc: 'Krea2 文生圖（可選 SeedVR2 高清放大 / 二次採樣）',
      template: 'krea2.json',
      nodes: { unet: '52', clip: '53', vae: '58', prompt: '51', ksampler: '54', latent: '57' },
      images: [], size: true,
    },
  },

  // 增強分支節點：關閉時從 prompt 移除（base 不依賴它們，可安全刪除）
  branch: {
    seedvr2: ['129', '131', '133', '69'],          // SeedVR2 高清放大
    second: ['154:137', '154:136', '154:130', '179'], // 二次採樣（latent 放大 + 重採樣）
  },
  // 輸出節點（前後對照用）
  outputs: { base: '29', seedvr2: '69', second: '179' },
  secondSampler: '154:136',   // 二次採樣的 KSampler（種子跟隨主種子）
};
