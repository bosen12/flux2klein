/* zimage.js —— Z-Image Turbo 引擎設定
 * 這兩份工作流本來就是 ComfyUI API 格式，執行時 fetch 後直接注入欄位、POST /prompt，
 * 不需要像 Flux2 那樣做 UI→API 轉換。
 */
window.YZ_Z = {
  // 固定值（三個模型共用）
  VAE: 'zimage\\ae.safetensors',
  CLIP: 'qwen_3_4b_fp8_mixed.safetensors',   // type: lumina2

  // 三個可選的 diffusion 模型（UNET）
  MODELS: [
    { value: 'pornmasterZImage_turboV35Fp8.safetensors', label: 'pornmaster V35 Fp8' },
    { value: 'pornmasterZImage_turboV35Bf16.safetensors', label: 'pornmaster V35 Bf16' },
    { value: 'redcraft23INT8INT4FP8_redzit222026HD.safetensors', label: 'redcraft HD' },
  ],

  MODE_ORDER: ['zt2i', 'zcanny'],
  MODES: {
    zt2i: {
      key: 'zt2i', label: '文生圖', desc: 'Z-Image Turbo 純文字生成',
      template: 'zimage_t2i.json',
      nodes: { unet: '57:28', clip: '57:30', vae: '57:29', prompt: '57:27', ksampler: '57:3', latent: '57:13' },
      images: [],
      size: true,     // 自訂寬高 → EmptySD3LatentImage
    },
    zcanny: {
      key: 'zcanny', label: 'ControlNet (Canny)', desc: '上傳參考圖，依邊緣線生成',
      template: 'zimage_controlnet.json',
      nodes: { unet: '70:46', clip: '70:39', vae: '70:40', prompt: '70:45', ksampler: '70:44' },
      images: [{ node: '58', label: '參考圖' }],
      size: false,    // 尺寸依參考圖（GetImageSize）
    },
  },
};
