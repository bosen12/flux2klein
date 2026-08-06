import { appCore } from './core.js';
import { state } from './state/index.js';
import { updateCardsForBulkMode } from './components/shared/ModelCard.js';
import { createPageControls } from './components/controls/index.js';
import { confirmDelete, closeDeleteModal, confirmExclude, closeExcludeModal } from './utils/modalUtils.js';
import { ModelDuplicatesManager } from './components/ModelDuplicatesManager.js';
import { showModelModal } from './components/shared/ModelModal.js';
import { MODEL_TYPES } from './api/apiConfig.js';
import { showToast } from './utils/uiHelpers.js';

// Initialize the LoRA page
export class LoraPageManager {
    constructor() {
        // Add bulk mode to state
        state.bulkMode = false;
        state.selectedLoras = new Set();
        
        // Initialize page controls
        this.pageControls = createPageControls('loras');
        
        // Initialize the ModelDuplicatesManager
        this.duplicatesManager = new ModelDuplicatesManager(this);
        
        // Expose necessary functions to the page that still need global access
        // These will be refactored in future updates
        this._exposeRequiredGlobalFunctions();
    }
    
    _exposeRequiredGlobalFunctions() {
        // Only expose what's still needed globally
        // Most functionality is now handled by the PageControls component
        window.confirmDelete = confirmDelete;
        window.closeDeleteModal = closeDeleteModal;
        window.confirmExclude = confirmExclude;
        window.closeExcludeModal = closeExcludeModal;
        
        // Expose duplicates manager
        window.modelDuplicatesManager = this.duplicatesManager;
    }
    
    async initialize() {
        // Initialize cards for current bulk mode state (should be false initially)
        updateCardsForBulkMode(state.bulkMode);

        // Initialize common page features (including context menus and virtual scroll)
        appCore.initializePageFeatures();
    }
}

// flux2klein 整合（見 ../VENDORED.md）：暗房 LoRA 大面板每個選中的 LoRA 有一顆
// 「查看詳情」連結，網址帶 ?open=<folder>/<file.safetensors>，讓使用者一鍵直達這個
// LoRA 在 LoRA Manager 的完整詳情 modal（不用自己在清單裡找）。清單頁是分頁+虛擬
// 捲動，目標項目未必已經載入到目前畫面/state 裡，所以不依賴已渲染的卡片或 state，
// 直接呼叫 /list API 精準查一次（folder+file_name 精確比對，用法跟暗房既有的
// LoRA 推送機制同一套識別方式）。找不到就留在列表頁、彈 toast 提示——不是失敗，
// 只是還沒掃到或檔案動過。
async function openModelFromUrlParam() {
    const raw = new URLSearchParams(location.search).get('open');
    if (!raw) return;
    // 清掉網址上的 open 參數，之後重整/分享網址不會又跳一次
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('open');
    history.replaceState(null, '', cleanUrl);

    const slashAt = raw.lastIndexOf('/');
    const folder = slashAt >= 0 ? raw.slice(0, slashAt) : '';
    const fileName = slashAt >= 0 ? raw.slice(slashAt + 1) : raw;
    const stem = fileName.replace(/\.[^./]+$/, '');
    try {
        const qs = new URLSearchParams({ folder, search: stem, search_filename: 'true', page_size: '100' });
        const res = await fetch(`/api/lm/loras/list?${qs}`);
        const data = await res.json();
        // 注意：這裡的 file_name 是「不含副檔名」的檔名(跟 ModelCard.js 塞進 card.dataset
        // 那個含副檔名的 file_name 語意不同——實測 /list API 回的是 stem，不是 fn)，要跟
        // stem 比對，不能跟含副檔名的 fileName 比對。
        const model = (data.items || []).find(m => m.folder === folder && m.file_name === stem);
        if (!model) {
            showToast('toast.general.openFromUrlNotFound', {}, 'error', `找不到「${fileName}」——可能還沒掃到，試試重新整理或重掃`);
            return;
        }
        await showModelModal(model, MODEL_TYPES.LORA);
    } catch (e) {
        console.error('openModelFromUrlParam failed:', e);
    }
}

export async function initializeLoraPage() {
    // Initialize core application
    await appCore.initialize();

    // Initialize page-specific functionality
    const loraPage = new LoraPageManager();
    await loraPage.initialize();

    // 一定要等清單頁機制都就緒（虛擬捲動/context menu 等）才去開 modal
    await openModelFromUrlParam();

    return loraPage;
}

// Initialize everything when DOM is ready
document.addEventListener('DOMContentLoaded', initializeLoraPage);