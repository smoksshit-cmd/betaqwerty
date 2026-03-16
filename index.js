/**
 * ════════════════════════════════════════════════════════════════════
 * Inline Image Generation + Wardrobe (Inline Grid)
 * Based on: notsosillynotsoimages by aceeenvw
 *           + inline wardrobe system (grid-based, no modal)
 *
 * v2.2: Replaced SillyWardrobe modal with inline outfit grids
 *        in settings panel. Wardrobe + Hairstyles support.
 * ════════════════════════════════════════════════════════════════════
 */

/* ╔═══════════════════════════════════════════════════════════════╗
   ║  INLINE IMAGE GENERATION + WARDROBE                          ║
   ╚═══════════════════════════════════════════════════════════════╝ */

const MODULE_NAME = 'inline_image_gen';

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const FETCH_TIMEOUT = IS_IOS ? 180000 : 300000;

function robustFetch(url, options = {}) {
    if (!IS_IOS) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
        return fetch(url, { ...options, signal: controller.signal })
            .then(r => { clearTimeout(timeoutId); return r; })
            .catch(e => {
                clearTimeout(timeoutId);
                if (e.name === 'AbortError') throw new Error('Request timed out after 5 minutes');
                throw e;
            });
    }
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(options.method || 'GET', url);
        xhr.timeout = FETCH_TIMEOUT;
        xhr.responseType = 'text';
        if (options.headers) {
            for (const [key, value] of Object.entries(options.headers)) xhr.setRequestHeader(key, value);
        }
        xhr.onload = () => resolve({
            ok: xhr.status >= 200 && xhr.status < 300,
            status: xhr.status, statusText: xhr.statusText,
            text: () => Promise.resolve(xhr.responseText),
            json: () => Promise.resolve(JSON.parse(xhr.responseText)),
            headers: { get: (name) => xhr.getResponseHeader(name) }
        });
        xhr.ontimeout = () => reject(new Error('Request timed out after 3 minutes (iOS)'));
        xhr.onerror = () => reject(new Error('Network error (iOS)'));
        xhr.onabort = () => reject(new Error('Request aborted (iOS)'));
        xhr.send(options.body || null);
    });
}

const processingMessages = new Set();

let sessionGenCount = 0;
let sessionErrorCount = 0;

function updateSessionStats() {
    const el = document.getElementById('iig_session_stats');
    if (!el) return;
    if (sessionGenCount === 0 && sessionErrorCount === 0) { el.textContent = ''; return; }
    const parts = [];
    if (sessionGenCount > 0) parts.push(`${sessionGenCount} сгенерировано`);
    if (sessionErrorCount > 0) parts.push(`${sessionErrorCount} ошибок`);
    el.textContent = `Сессия: ${parts.join(' · ')}`;
}

const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

function iigLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    logBuffer.push(`[${timestamp}] [${level}] ${message}`);
    if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
    if (level === 'ERROR') console.error('[IIG]', ...args);
    else if (level === 'WARN') console.warn('[IIG]', ...args);
    else console.log('[IIG]', ...args);
}

function exportLogs() {
    const blob = new Blob([logBuffer.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iig-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Логи экспортированы', 'Генерация картинок');
}

const defaultSettings = Object.freeze({
    enabled: true,
    apiType: 'openai',
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 0,
    retryDelay: 1000,
    aspectRatio: '1:1',
    imageSize: '1K',
    naisteraAspectRatio: '1:1',
    naisteraPreset: '',
    imageContextEnabled: false,
    imageContextCount: 1,
    charRef: { name: '', imageBase64: '' },
    userRef: { name: '', imageBase64: '' },
    npcReferences: [],
    // ── Wardrobe (inline grid) ──
    wardrobeItems: [],
    activeWardrobeChar: null,
    activeWardrobeUser: null,
    // ── Hairstyles ──
    hairstyleItems: [],
    activeHairstyleChar: null,
    activeHairstyleUser: null,
    // ── Wardrobe injection ──
    injectWardrobeToChat: true,
    wardrobeInjectionDepth: 1,
    injectHairstyleToChat: true,
    // ── Wardrobe description API ──
    wardrobeDescEndpoint: '',
    wardrobeDescApiKey: '',
    wardrobeDescModel: '',
    wardrobeDescPrompt: 'Describe this clothing outfit in detail for a character in a roleplay. Focus on: type of garment, color, material/texture, style, notable features, accessories. Be concise but thorough (2-4 sentences). Write in English.',
    hairstyleDescPrompt: 'Describe ONLY the shape and form of the hairstyle in this image. STRICTLY FORBIDDEN: do NOT mention hair color. Focus EXCLUSIVELY on: length, texture, cut style, bangs, volume, parting, how hair falls, updos/ponytails/braids if present, and any accessories. Write 2-3 sentences in English.',
    // ── Collapsible sections ──
    collapsedSections: {},
});

const MAX_CONTEXT_IMAGES = 3;

function normalizeImageContextCount(value) {
    const n = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, MAX_CONTEXT_IMAGES);
}

function extractGeneratedImageUrlsFromText(text) {
    const urls = [];
    const seen = new Set();
    const rawText = String(text || '');
    const legacyMatches = Array.from(rawText.matchAll(/\[IMG:✓:([^\]]+)\]/g));
    for (let i = legacyMatches.length - 1; i >= 0; i--) {
        const src = String(legacyMatches[i][1] || '').trim();
        if (!src || seen.has(src)) continue;
        seen.add(src); urls.push(src);
    }
    if (!rawText.includes('<img')) return urls;
    const template = document.createElement('template');
    template.innerHTML = rawText;
    const nodes = Array.from(template.content.querySelectorAll('img[data-iig-instruction]')).reverse();
    for (const node of nodes) {
        const src = String(node.getAttribute('src') || '').trim();
        if (!src || src.startsWith('data:') || src.includes('[IMG:') || src.endsWith('/error.svg') || seen.has(src)) continue;
        seen.add(src); urls.push(src);
    }
    return urls;
}

function getPreviousGeneratedImageUrls(messageId, requestedCount) {
    const count = normalizeImageContextCount(requestedCount);
    if (!Number.isInteger(messageId) || messageId <= 0) return [];
    const context = SillyTavern.getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const urls = [];
    const seen = new Set();
    for (let idx = messageId - 1; idx >= 0 && urls.length < count; idx--) {
        const message = chat[idx];
        if (!message || message.is_user || message.is_system) continue;
        for (const url of extractGeneratedImageUrlsFromText(message.mes || '')) {
            if (seen.has(url)) continue;
            seen.add(url); urls.push(url);
            if (urls.length >= count) break;
        }
    }
    return urls;
}

async function collectPreviousContextReferences(messageId, format, requestedCount) {
    const urls = getPreviousGeneratedImageUrls(messageId, requestedCount);
    if (urls.length === 0) return [];
    const convert = format === 'dataUrl' ? imageUrlToDataUrl : imageUrlToBase64;
    const converted = await Promise.all(urls.map(url => convert(url)));
    return converted.filter(Boolean);
}

const IMAGE_MODEL_KEYWORDS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gpt-image', 'wanx', 'qwen'
];
const VIDEO_MODEL_KEYWORDS = [
    'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
    'video', 'gen-3', 'minimax', 'cogvideo', 'mochi', 'seedance',
    'vidu', 'wan-ai', 'hunyuan', 'hailuo'
];

function isImageModel(modelId) {
    const mid = modelId.toLowerCase();
    for (const kw of VIDEO_MODEL_KEYWORDS) { if (mid.includes(kw)) return false; }
    if (mid.includes('vision') && mid.includes('preview')) return false;
    for (const kw of IMAGE_MODEL_KEYWORDS) { if (mid.includes(kw)) return true; }
    return false;
}

function isGeminiModel(modelId) {
    return modelId.toLowerCase().includes('nano-banana');
}

function getSettings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    // Migrate items without description
    for (const key of ['wardrobeItems', 'hairstyleItems']) {
        for (const item of (context.extensionSettings[MODULE_NAME][key] || [])) {
            if (!Object.hasOwn(item, 'description')) item.description = '';
        }
    }
    return context.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const context = SillyTavern.getContext();
    if (typeof window.saveSettings === 'function') {
        try { window.saveSettings(); } catch(e) { context.saveSettingsDebounced(); }
    } else {
        context.saveSettingsDebounced();
    }
    persistRefsToLocalStorage();
}

function saveSettingsNow() { saveSettings(); }

const LS_KEY = 'iig_npc_refs_v3';

function persistRefsToLocalStorage() {
    try {
        const settings = getSettings();
        const refs = JSON.parse(JSON.stringify(settings.npcReferences || {}));
        localStorage.setItem(LS_KEY, JSON.stringify(refs));
    } catch(e) { iigLog('WARN', 'persistRefsToLocalStorage failed:', e.message); }
}

function restoreRefsFromLocalStorage() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        const backup = JSON.parse(raw);
        if (!backup || typeof backup !== 'object') return;
        const settings = getSettings();
        settings.npcReferences = backup;
    } catch(e) { iigLog('WARN', 'restoreRefsFromLocalStorage failed:', e.message); }
}

function initMobileSaveListeners() {
    const flush = () => {
        persistRefsToLocalStorage();
        try { SillyTavern.getContext().saveSettingsDebounced(); } catch(e) {}
        if (typeof window.saveSettings === 'function') { try { window.saveSettings(); } catch(e) {} }
    };
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
}

function getCurrentCharacterRefs() {
    const settings = getSettings();
    if (!settings.charRef) settings.charRef = { name: '', imageBase64: '', imagePath: '' };
    if (!settings.userRef) settings.userRef = { name: '', imageBase64: '', imagePath: '' };
    if (!Array.isArray(settings.npcReferences)) settings.npcReferences = [];
    return settings;
}

function matchNpcReferences(prompt, npcList) {
    if (!prompt || !npcList || npcList.length === 0) return [];
    const lowerPrompt = prompt.toLowerCase();
    const matched = [];
    for (const npc of npcList) {
        if (!npc || !npc.name || (!npc.imagePath && !npc.imageBase64)) continue;
        const words = npc.name.trim().split(/\s+/).filter(w => w.length > 2);
        if (words.length === 0) continue;
        if (words.some(word => lowerPrompt.includes(word.toLowerCase()))) {
            matched.push({ name: npc.name, imageBase64: npc.imageBase64, imagePath: npc.imagePath });
        }
    }
    return matched;
}

async function fetchModels() {
    const settings = getSettings();
    if (!settings.endpoint || !settings.apiKey) return [];
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/models`;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${settings.apiKey}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return (data.data || []).filter(m => isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        toastr.error(`Ошибка загрузки моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

async function fetchDescriptionModels() {
    const settings = getSettings();
    const endpoint = settings.wardrobeDescEndpoint || settings.endpoint;
    const apiKey = settings.wardrobeDescApiKey || settings.apiKey;
    if (!endpoint || !apiKey) return [];
    const url = `${endpoint.replace(/\/$/, '')}/v1/models`;
    try {
        const response = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return (data.data || []).filter(m => !isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        toastr.error(`Ошибка загрузки текстовых моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

function compressBase64Image(rawBase64, maxDim = 768, quality = 0.8) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            let w = img.width, h = img.height;
            if (w > maxDim || h > maxDim) {
                const scale = maxDim / Math.max(w, h);
                w = Math.round(w * scale);
                h = Math.round(h * scale);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality).split(',')[1]);
        };
        img.onerror = () => reject(new Error('Failed to load image for compression'));
        img.src = 'data:image/jpeg;base64,' + rawBase64;
    });
}

async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) { return null; }
}

async function imageUrlToDataUrl(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) { return null; }
}

async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();
    if (typeof dataUrl !== 'string') throw new Error(`saveImageToFile: expected string, got ${typeof dataUrl}`);
    if (dataUrl.startsWith('http://') || dataUrl.startsWith('https://')) {
        const fetched = await fetch(dataUrl);
        if (!fetched.ok) throw new Error(`Failed to fetch image URL: ${fetched.status}`);
        const blob = await fetched.blob();
        const base64Data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        const format = blob.type.split('/')[1] || 'png';
        let charName = 'generated';
        if (context.characterId !== undefined && context.characters?.[context.characterId]) charName = context.characters[context.characterId].name || 'generated';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const response = await fetch('/api/images/upload', {
            method: 'POST', headers: context.getRequestHeaders(),
            body: JSON.stringify({ image: base64Data, format, ch_name: charName, filename: `iig_${timestamp}` })
        });
        if (!response.ok) { const e = await response.json().catch(() => ({ error: 'Unknown' })); throw new Error(e.error || `Upload failed: ${response.status}`); }
        return (await response.json()).path;
    }
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) throw new Error(`Invalid data URL format (got: ${String(dataUrl).substring(0, 80)})`);
    const format = match[1];
    const base64Data = match[2];
    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) charName = context.characters[context.characterId].name || 'generated';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const response = await fetch('/api/images/upload', {
        method: 'POST', headers: context.getRequestHeaders(),
        body: JSON.stringify({ image: base64Data, format, ch_name: charName, filename: `iig_${timestamp}` })
    });
    if (!response.ok) { const e = await response.json().catch(() => ({ error: 'Unknown' })); throw new Error(e.error || `Upload failed: ${response.status}`); }
    const result = await response.json();
    iigLog('INFO', 'Image saved to:', result.path);
    return result.path;
}

async function saveRefImageToFile(base64Data, label) {
    const context = SillyTavern.getContext();
    const safeName = label.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
    const response = await fetch('/api/images/upload', {
        method: 'POST', headers: context.getRequestHeaders(),
        body: JSON.stringify({ image: base64Data, format: 'jpeg', ch_name: 'iig_refs', filename: `iig_ref_${safeName}_${Date.now()}` })
    });
    if (!response.ok) { const e = await response.json().catch(() => ({ error: 'Unknown' })); throw new Error(e.error || `Upload failed: ${response.status}`); }
    return (await response.json()).path;
}

async function loadRefImageAsBase64(path) {
    try {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch(e) { iigLog('WARN', `loadRefImageAsBase64 failed for ${path}:`, e.message); return null; }
}

function sanitizeForHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================================
// OUTFIT SYSTEM (wardrobe + hairstyle) — inline grid
// Replaces SillyWardrobe modal
// ============================================================

const OUTFIT_SYSTEMS = {
    wardrobe: {
        itemsKey: 'wardrobeItems', activeCharKey: 'activeWardrobeChar', activeUserKey: 'activeWardrobeUser',
        idPrefix: 'ward_', defaultName: 'Outfit', injectEnabledKey: 'injectWardrobeToChat',
        descPromptKey: 'wardrobeDescPrompt', injectionKey: MODULE_NAME + '_wardrobe',
    },
    hairstyle: {
        itemsKey: 'hairstyleItems', activeCharKey: 'activeHairstyleChar', activeUserKey: 'activeHairstyleUser',
        idPrefix: 'hair_', defaultName: 'Hairstyle', injectEnabledKey: 'injectHairstyleToChat',
        descPromptKey: 'hairstyleDescPrompt', injectionKey: MODULE_NAME + '_hairstyle',
    }
};

function addOutfitItem(sys, name, imageData, target = 'char') {
    const cfg = OUTFIT_SYSTEMS[sys], settings = getSettings();
    const item = { id: cfg.idPrefix + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
        name: name || cfg.defaultName, imageData, description: '', target, createdAt: Date.now() };
    settings[cfg.itemsKey].push(item);
    saveSettings();
    return item;
}

function removeOutfitItem(sys, itemId) {
    const cfg = OUTFIT_SYSTEMS[sys], settings = getSettings();
    if (settings[cfg.activeCharKey] === itemId) settings[cfg.activeCharKey] = null;
    if (settings[cfg.activeUserKey] === itemId) settings[cfg.activeUserKey] = null;
    settings[cfg.itemsKey] = settings[cfg.itemsKey].filter(i => i.id !== itemId);
    saveSettings();
    updateOutfitInjection(sys);
}

function setActiveOutfit(sys, itemId, target) {
    const cfg = OUTFIT_SYSTEMS[sys], settings = getSettings();
    const key = target === 'char' ? cfg.activeCharKey : cfg.activeUserKey;
    settings[key] = settings[key] === itemId ? null : itemId;
    saveSettings();
    updateOutfitInjection(sys);
}

function getActiveOutfitItem(sys, target) {
    const cfg = OUTFIT_SYSTEMS[sys], settings = getSettings();
    const activeId = settings[target === 'char' ? cfg.activeCharKey : cfg.activeUserKey];
    return activeId ? (settings[cfg.itemsKey].find(i => i.id === activeId) || null) : null;
}

function updateOutfitItemDescription(sys, itemId, description) {
    const cfg = OUTFIT_SYSTEMS[sys], settings = getSettings();
    const item = settings[cfg.itemsKey].find(i => i.id === itemId);
    if (item) {
        item.description = description;
        saveSettings();
        updateOutfitInjection(sys);
        iigLog('INFO', `Updated ${sys} description for "${item.name}" (${itemId})`);
    }
}

async function generateOutfitDescription(sys, itemId) {
    const cfg = OUTFIT_SYSTEMS[sys], settings = getSettings();
    const item = settings[cfg.itemsKey].find(i => i.id === itemId);
    if (!item?.imageData) throw new Error('Нет данных изображения');
    const endpoint = settings.wardrobeDescEndpoint || settings.endpoint;
    const apiKey = settings.wardrobeDescApiKey || settings.apiKey;
    const model = settings.wardrobeDescModel;
    if (!endpoint) throw new Error('Не настроен эндпоинт для генерации описаний');
    if (!apiKey) throw new Error('Не настроен API ключ');
    if (!model) throw new Error('Не выбрана модель');
    const promptText = settings[cfg.descPromptKey] || defaultSettings[cfg.descPromptKey];
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model, max_tokens: 500, temperature: 0.3,
            messages: [{ role: 'user', content: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${item.imageData}` } },
                { type: 'text', text: promptText }
            ]}],
        })
    });
    if (!response.ok) throw new Error(`API ошибка (${response.status}): ${await response.text().catch(() => '?')}`);
    const result = await response.json();
    const description = result.choices?.[0]?.message?.content?.trim();
    if (!description) throw new Error('Модель вернула пустой ответ');
    iigLog('INFO', `Generated ${sys} description for "${item.name}": ${description.substring(0, 100)}...`);
    return description;
}

function updateOutfitInjection(sys) {
    try {
        const cfg = OUTFIT_SYSTEMS[sys], context = SillyTavern.getContext(), settings = getSettings();
        if (!settings[cfg.injectEnabledKey]) {
            if (typeof context.setExtensionPrompt === 'function') context.setExtensionPrompt(cfg.injectionKey, '', 0, 0);
            return;
        }
        const parts = [];
        for (const [target, getName] of [['char', () => context.characters?.[context.characterId]?.name || 'Character'], ['user', () => context.name1 || 'User']]) {
            const item = getActiveOutfitItem(sys, target);
            if (item?.description) {
                const name = getName();
                parts.push(sys === 'wardrobe' ? `[${name} is currently wearing: ${item.description}]` : `[${name}'s current hairstyle shape (hair color unchanged): ${item.description}]`);
            }
        }
        const depth = settings.wardrobeInjectionDepth || 1;
        if (typeof context.setExtensionPrompt === 'function') {
            context.setExtensionPrompt(cfg.injectionKey, parts.join('\n'), 1, depth);
        }
    } catch (error) { iigLog('ERROR', `Error updating ${sys} injection:`, error); }
}

// Outfit UI config
const OUTFIT_UI = {
    wardrobe: { prefix: 'iig_wardrobe', icon: 'fa-shirt', emptyText: 'Нет одежды. Нажмите + чтобы добавить.', deleteMsg: 'Одежда удалена',
        placeholder: 'Описание одежды (вручную или через AI)...', saveMsg: 'Описание сохранено', clearMsg: 'Описание очищено', genMsg: 'Описание сгенерировано через AI' },
    hairstyle: { prefix: 'iig_hairstyle', icon: 'fa-scissors', emptyText: 'Нет причёсок. Нажмите + чтобы добавить.', deleteMsg: 'Причёска удалена',
        placeholder: 'Описание причёски (вручную или через AI)...', saveMsg: 'Описание причёски сохранено', clearMsg: 'Описание причёски очищено', genMsg: 'Описание причёски сгенерировано через AI' },
};

function renderOutfitGrid(sys, target) {
    const ui = OUTFIT_UI[sys], cfg = OUTFIT_SYSTEMS[sys], settings = getSettings();
    const container = document.getElementById(`${ui.prefix}_${target}`);
    if (!container) return;
    const items = settings[cfg.itemsKey].filter(i => i.target === target);
    const activeId = settings[target === 'char' ? cfg.activeCharKey : cfg.activeUserKey];
    if (items.length === 0) {
        container.innerHTML = `<div class="iig-wardrobe-empty">${ui.emptyText}</div>`;
        renderOutfitDescriptionPanel(sys, target);
        return;
    }
    container.innerHTML = items.map(item => `
        <div class="iig-wardrobe-card ${item.id === activeId ? 'iig-wardrobe-active' : ''}" data-outfit-id="${item.id}" data-outfit-target="${target}" data-outfit-sys="${sys}">
            <img src="data:image/png;base64,${item.imageData}" class="iig-wardrobe-img" alt="${sanitizeForHtml(item.name)}">
            <div class="iig-wardrobe-card-overlay">
                <span class="iig-wardrobe-card-name" title="${sanitizeForHtml(item.name)}">${sanitizeForHtml(item.name)}</span>
                <div class="iig-wardrobe-card-actions">
                    ${item.description ? '<i class="fa-solid fa-file-lines iig-wardrobe-has-desc" title="Есть описание"></i>' : ''}
                    <i class="fa-solid fa-trash iig-wardrobe-delete" data-outfit-del="${item.id}" title="Удалить"></i>
                </div>
            </div>
            ${item.id === activeId ? '<div class="iig-wardrobe-check"><i class="fa-solid fa-check"></i></div>' : ''}
        </div>
    `).join('');
    container.querySelectorAll('.iig-wardrobe-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.iig-wardrobe-delete')) return;
            setActiveOutfit(card.dataset.outfitSys, card.dataset.outfitId, card.dataset.outfitTarget);
            renderOutfitGrid(card.dataset.outfitSys, card.dataset.outfitTarget);
        });
    });
    container.querySelectorAll('[data-outfit-del]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeOutfitItem(sys, btn.dataset.outfitDel);
            renderOutfitGrid(sys, target);
            toastr.info(ui.deleteMsg);
        });
    });
    renderOutfitDescriptionPanel(sys, target);
}

function renderOutfitDescriptionPanel(sys, target) {
    const ui = OUTFIT_UI[sys];
    const panelId = `${ui.prefix}_desc_${target}`;
    let panel = document.getElementById(panelId);
    if (!panel) {
        const grid = document.getElementById(`${ui.prefix}_${target}`);
        if (!grid) return;
        panel = document.createElement('div');
        panel.id = panelId;
        panel.className = 'iig-wardrobe-desc-panel';
        grid.parentNode.insertBefore(panel, grid.nextSibling);
    }
    const activeItem = getActiveOutfitItem(sys, target);
    if (!activeItem) { panel.innerHTML = ''; panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    panel.innerHTML = `
        <div class="iig-wardrobe-desc-header"><i class="fa-solid ${ui.icon}"></i><span>Описание: <b>${sanitizeForHtml(activeItem.name)}</b></span></div>
        <textarea class="text_pole iig-wardrobe-desc-textarea" rows="3" placeholder="${ui.placeholder}" data-outfit-id="${activeItem.id}">${activeItem.description || ''}</textarea>
        <div class="iig-wardrobe-desc-actions">
            <div class="menu_button iig-outfit-desc-generate" data-outfit-id="${activeItem.id}" title="Сгенерировать через Vision AI"><i class="fa-solid fa-robot"></i> AI</div>
            <div class="menu_button iig-outfit-desc-save" data-outfit-id="${activeItem.id}"><i class="fa-solid fa-floppy-disk"></i> Сохранить</div>
            <div class="menu_button iig-outfit-desc-clear" data-outfit-id="${activeItem.id}"><i class="fa-solid fa-eraser"></i></div>
        </div>
    `;
    const textarea = panel.querySelector('.iig-wardrobe-desc-textarea');
    textarea?.addEventListener('blur', () => updateOutfitItemDescription(sys, textarea.dataset.outfitId, textarea.value));
    panel.querySelector('.iig-outfit-desc-save')?.addEventListener('click', () => {
        updateOutfitItemDescription(sys, textarea.dataset.outfitId, textarea.value);
        toastr.success(ui.saveMsg); renderOutfitGrid(sys, target);
    });
    panel.querySelector('.iig-outfit-desc-clear')?.addEventListener('click', () => {
        textarea.value = ''; updateOutfitItemDescription(sys, textarea.dataset.outfitId, '');
        toastr.info(ui.clearMsg); renderOutfitGrid(sys, target);
    });
    panel.querySelector('.iig-outfit-desc-generate')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget, itemId = btn.dataset.outfitId;
        btn.classList.add('disabled'); btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        try {
            const desc = await generateOutfitDescription(sys, itemId);
            textarea.value = desc; updateOutfitItemDescription(sys, itemId, desc);
            toastr.success(ui.genMsg); renderOutfitGrid(sys, target);
        } catch (error) {
            iigLog('ERROR', `Failed to generate ${sys} description:`, error);
            toastr.error(`Ошибка: ${error.message}`);
        } finally {
            btn.classList.remove('disabled'); btn.innerHTML = '<i class="fa-solid fa-robot"></i> AI';
        }
    });
}

function bindOutfitAddEvents(sys, target) {
    const ui = OUTFIT_UI[sys], cfg = OUTFIT_SYSTEMS[sys];
    const addBtn = document.getElementById(`${ui.prefix}_${target}_add`);
    const fileInput = document.getElementById(`${ui.prefix}_${target}_file`);
    const nameInput = document.getElementById(`${ui.prefix}_${target}_name`);
    addBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onloadend = async () => {
            const resized = await compressBase64Image(reader.result.split(',')[1], 768, 0.85);
            const name = nameInput?.value?.trim() || file.name.replace(/\.[^.]+$/, '') || cfg.defaultName;
            addOutfitItem(sys, name, resized, target);
            if (nameInput) nameInput.value = '';
            fileInput.value = '';
            renderOutfitGrid(sys, target);
            toastr.success(`${cfg.defaultName} "${name}" добавлен(а)`);
        };
        reader.readAsDataURL(file);
    });
}

// Collapsible sections helper
function isSectionCollapsed(sectionId) {
    const settings = getSettings();
    return settings.collapsedSections?.[sectionId] === true;
}

function toggleSectionCollapsed(sectionId) {
    const settings = getSettings();
    if (!settings.collapsedSections) settings.collapsedSections = {};
    settings.collapsedSections[sectionId] = !settings.collapsedSections[sectionId];
    saveSettings();
}


// ============================================================
// API FUNCTIONS
// ============================================================

async function generateImageVoid(prompt, style, options = {}) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/chat/completions`;
    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    const body = {
        model: settings.model,
        messages: [{ role: 'user', content: fullPrompt }],
        size: settings.size || '1024x1024',
        quality: options.quality || settings.quality || 'standard',
        n: 1
    };
    const response = await robustFetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) { const text = await response.text(); throw new Error(`API Error (${response.status}): ${text}`); }
    const result = await response.json();
    if (result.data?.length > 0) {
        const img = result.data[0];
        if (img.b64_json) return `data:image/png;base64,${img.b64_json}`;
        if (img.url) return img.url;
    }
    const choice = result.choices?.[0];
    if (choice) {
        const imgList = choice.message?.images || choice.images || result.images || [];
        if (imgList.length > 0) {
            const img = imgList[0];
            const toStr = (v) => (typeof v === 'string' ? v : null);
            const candidates = [
                toStr(img?.b64_json) && `data:image/png;base64,${img.b64_json}`,
                toStr(img?.image_url?.url), toStr(img?.url),
                toStr(img?.base64) && `data:image/png;base64,${img.base64}`,
                typeof img === 'string' && img,
            ].filter(Boolean);
            if (candidates.length > 0) {
                const val = candidates[0];
                return val.startsWith('http') || val.startsWith('data:') ? val : `data:image/png;base64,${val}`;
            }
        }
    }
    const raw = JSON.stringify(result);
    const b64match = raw.match(/"b64_json":"([^"]+)"/);
    if (b64match) return `data:image/png;base64,${b64match[1]}`;
    const urlmatch = raw.match(/"url":"(https?:\/\/[^"]+)"/);
    if (urlmatch) return urlmatch[1];
    throw new Error('VoidAI: не удалось найти изображение в ответе');
}

async function generateImageOpenAI(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;
    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    let size = settings.size;
    if (options.aspectRatio) {
        if (options.aspectRatio === '16:9') size = '1536x1024';
        else if (options.aspectRatio === '9:16') size = '1024x1536';
        else if (options.aspectRatio === '1:1') size = '1024x1024';
    }
    const body = {
        model: settings.model, prompt: fullPrompt, n: 1,
        size, quality: options.quality || settings.quality, response_format: 'b64_json'
    };
    if (referenceImages.length > 0) body.image = `data:image/png;base64,${referenceImages[0]}`;
    const response = await robustFetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) { const text = await response.text(); throw new Error(`API Error (${response.status}): ${text}`); }
    const result = await response.json();
    const dataList = result.data || [];
    if (dataList.length === 0) {
        if (result.url) return result.url;
        if (result.b64_json) return `data:image/png;base64,${result.b64_json}`;
        throw new Error('No image data in response');
    }
    const imageObj = dataList[0];
    if (imageObj.b64_json) return `data:image/png;base64,${imageObj.b64_json}`;
    return imageObj.url;
}

const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

async function generateImageGemini(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const model = settings.model;
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;
    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) aspectRatio = '1:1';
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) imageSize = '1K';
    const parts = [];
    for (const imgB64 of referenceImages.slice(0, 4)) {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: imgB64 } });
    }
    let fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    if (referenceImages.length > 0) {
        fullPrompt = `[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features.]\n\n${fullPrompt}`;
    }
    parts.push({ text: fullPrompt });
    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio, imageSize } }
    };
    const response = await robustFetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) { const text = await response.text(); throw new Error(`API Error (${response.status}): ${text}`); }
    const result = await response.json();
    const candidates = result.candidates || [];
    if (candidates.length === 0) throw new Error('No candidates in response');
    for (const part of (candidates[0].content?.parts || [])) {
        if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        if (part.inline_data) return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
    }
    throw new Error('No image found in Gemini response');
}

async function generateImageNaistera(prompt, style, options = {}) {
    const settings = getSettings();
    const endpoint = settings.endpoint.replace(/\/$/, '');
    const url = endpoint.endsWith('/api/generate') ? endpoint : `${endpoint}/api/generate`;
    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    const aspectRatio = options.aspectRatio || settings.naisteraAspectRatio || '1:1';
    const preset = options.preset || settings.naisteraPreset || null;
    const referenceImages = options.referenceImages || [];
    const body = { prompt: fullPrompt, aspect_ratio: aspectRatio };
    if (preset) body.preset = preset;
    if (referenceImages.length > 0) body.reference_images = referenceImages.slice(0, 4);
    const response = await robustFetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) { const text = await response.text(); throw new Error(`API Error (${response.status}): ${text}`); }
    const result = await response.json();
    if (!result?.data_url) throw new Error('No data_url in response');
    return result.data_url;
}

function validateSettings() {
    const settings = getSettings();
    const errors = [];
    if (!settings.endpoint) errors.push('URL эндпоинта не настроен');
    if (!settings.apiKey) errors.push('API ключ не настроен');
    if (settings.apiType !== 'naistera' && !settings.model) errors.push('Модель не выбрана');
    if (errors.length > 0) throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
}

// ============================================================
// GENERATION WITH WARDROBE INTEGRATION
// ============================================================

async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();
    const settings = getSettings();
    const maxRetries = settings.maxRetries;
    const baseDelay = settings.retryDelay;

    const referenceImages = [];
    const referenceDataUrls = [];

    const isGeminiType = settings.apiType === 'gemini' || isGeminiModel(settings.model);
    const isNaisteraType = settings.apiType === 'naistera';

    const getB64 = async (ref) => {
        if (ref?.imagePath) { const b64 = await loadRefImageAsBase64(ref.imagePath); if (b64) return b64; }
        return ref?.imageBase64 || ref?.imageData || null;
    };

    const getDataUrl = async (ref) => {
        const b64 = await getB64(ref);
        return b64 ? 'data:image/jpeg;base64,' + b64 : null;
    };

    const refs = getCurrentCharacterRefs();

    // ── Character & User avatar refs ──
    if (isGeminiType) {
        const charB64 = await getB64(refs.charRef);
        if (charB64) referenceImages.push(charB64);
        const userB64 = await getB64(refs.userRef);
        if (userB64) referenceImages.push(userB64);
    } else if (isNaisteraType) {
        const charUrl = await getDataUrl(refs.charRef);
        if (charUrl) referenceDataUrls.push(charUrl);
        const userUrl = await getDataUrl(refs.userRef);
        if (userUrl) referenceDataUrls.push(userUrl);
    }

    // ── Wardrobe outfit refs (inline grid system) ──
    let wardrobeAdded = 0;
    for (const target of ['char', 'user']) {
        const wardrobeItem = getActiveOutfitItem('wardrobe', target);
        if (!wardrobeItem?.imageData) continue;
        if (isGeminiType && referenceImages.length < 4) {
            referenceImages.push(wardrobeItem.imageData); wardrobeAdded++;
        } else if (isNaisteraType && referenceDataUrls.length < 4) {
            referenceDataUrls.push('data:image/jpeg;base64,' + wardrobeItem.imageData); wardrobeAdded++;
        } else if (referenceImages.length < 4) {
            referenceImages.push(wardrobeItem.imageData); wardrobeAdded++;
        }
        iigLog('INFO', `Wardrobe ${target}: "${wardrobeItem.name}"`);
    }

    // ── Hairstyle refs ──
    for (const target of ['char', 'user']) {
        const hairstyleItem = getActiveOutfitItem('hairstyle', target);
        if (!hairstyleItem?.imageData) continue;
        if (isGeminiType && referenceImages.length < 4) {
            referenceImages.push(hairstyleItem.imageData); wardrobeAdded++;
        } else if (isNaisteraType && referenceDataUrls.length < 4) {
            referenceDataUrls.push('data:image/jpeg;base64,' + hairstyleItem.imageData); wardrobeAdded++;
        } else if (referenceImages.length < 4) {
            referenceImages.push(hairstyleItem.imageData); wardrobeAdded++;
        }
        iigLog('INFO', `Hairstyle ${target}: "${hairstyleItem.name}"`);
    }

    if (wardrobeAdded > 0) iigLog('INFO', `Wardrobe/Hairstyle: добавлено ${wardrobeAdded} референсов`);

    // ── Inject outfit descriptions into prompt text ──
    const descParts = [];
    const charWard = getActiveOutfitItem('wardrobe', 'char');
    const userWard = getActiveOutfitItem('wardrobe', 'user');
    const charHair = getActiveOutfitItem('hairstyle', 'char');
    const userHair = getActiveOutfitItem('hairstyle', 'user');
    if (charWard?.description) descParts.push(`[Character's current outfit: ${charWard.description}]`);
    if (userWard?.description) descParts.push(`[User's current outfit: ${userWard.description}]`);
    if (charHair?.description) descParts.push(`[Character's hairstyle: ${charHair.description}]`);
    if (userHair?.description) descParts.push(`[User's hairstyle: ${userHair.description}]`);
    if (descParts.length > 0) {
        prompt = `${descParts.join(' ')}\n${prompt}`;
        iigLog('INFO', `Wardrobe/hairstyle descriptions injected: ${descParts.length}`);
    }

    // ── Image context ──
    if (settings.imageContextEnabled) {
        const contextCount = normalizeImageContextCount(settings.imageContextCount);
        if (isGeminiType) {
            const contextRefs = await collectPreviousContextReferences(options.messageId, 'base64', contextCount);
            for (const ref of contextRefs) {
                if (referenceImages.length < 4) { referenceImages.push(ref); iigLog('INFO', 'Image context ref added (gemini)'); }
            }
        } else if (isNaisteraType) {
            const contextRefs = await collectPreviousContextReferences(options.messageId, 'dataUrl', contextCount);
            for (const ref of contextRefs) {
                if (referenceDataUrls.length < 4) { referenceDataUrls.push(ref); iigLog('INFO', 'Image context ref added (naistera)'); }
            }
        }
    }

    // ── NPC refs ──
    const currentCount = isNaisteraType ? referenceDataUrls.length : referenceImages.length;
    if (currentCount < 4) {
        const matchedNpcs = matchNpcReferences(prompt, refs.npcReferences || []);
        for (const npc of matchedNpcs) {
            if ((isNaisteraType ? referenceDataUrls.length : referenceImages.length) >= 4) break;
            if (isNaisteraType) {
                const url = await getDataUrl(npc);
                if (url) { referenceDataUrls.push(url); iigLog('INFO', `NPC (naistera): ${npc.name}`); }
            } else {
                const b64 = npc.imagePath ? await loadRefImageAsBase64(npc.imagePath) : npc.imageBase64;
                if (b64) { referenceImages.push(b64); iigLog('INFO', `NPC: ${npc.name}`); }
            }
        }
    }

    iigLog('INFO', `Refs: ${referenceImages.length} base64, ${referenceDataUrls.length} dataUrls, apiType=${settings.apiType}`);

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${maxRetries})` : ''}...`);
            if (settings.apiType === 'void') return await generateImageVoid(prompt, style, options);
            if (isNaisteraType) return await generateImageNaistera(prompt, style, { ...options, referenceImages: referenceDataUrls });
            if (isGeminiType) return await generateImageGemini(prompt, style, referenceImages, options);
            return await generateImageOpenAI(prompt, style, referenceImages, options);
        } catch (error) {
            lastError = error;
            const isRetryable = ['429','503','502','504','timeout','network'].some(s => error.message?.includes(s));
            if (!isRetryable || attempt === maxRetries) break;
            const delay = baseDelay * Math.pow(2, attempt);
            onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

// ============================================================
// TAG PARSING
// ============================================================

async function checkFileExists(path) {
    try { const r = await fetch(path, { method: 'HEAD' }); return r.ok; } catch (e) { return false; }
}

function getErrorImagePath() {
    const scripts = document.querySelectorAll('script[src*="index.js"]');
    for (const script of scripts) {
        const src = script.getAttribute('src') || '';
        if (src.includes('inline_image_gen') || src.includes('sillyimages') || src.includes('notsosillynotsoimages')) {
            return `${src.substring(0, src.lastIndexOf('/'))}/error.svg`;
        }
    }
    return '/scripts/extensions/third-party/notsosillynotsoimages/error.svg';
}

const ERROR_IMAGE_PATH = getErrorImagePath();

async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];
    const imgTagMarker = 'data-iig-instruction=';
    let searchPos = 0;
    while (true) {
        const markerPos = text.indexOf(imgTagMarker, searchPos);
        if (markerPos === -1) break;
        let imgStart = text.lastIndexOf('<img', markerPos);
        if (imgStart === -1 || markerPos - imgStart > 500) { searchPos = markerPos + 1; continue; }
        const afterMarker = markerPos + imgTagMarker.length;
        let jsonStart = text.indexOf('{', afterMarker);
        if (jsonStart === -1 || jsonStart > afterMarker + 10) { searchPos = markerPos + 1; continue; }
        let braceCount = 0, jsonEnd = -1, inString = false, escapeNext = false;
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (char === '\\' && inString) { escapeNext = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (!inString) {
                if (char === '{') braceCount++;
                else if (char === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
            }
        }
        if (jsonEnd === -1) { searchPos = markerPos + 1; continue; }
        let imgEnd = text.indexOf('>', jsonEnd);
        if (imgEnd === -1) { searchPos = markerPos + 1; continue; }
        imgEnd++;
        const fullImgTag = text.substring(imgStart, imgEnd);
        const instructionJson = text.substring(jsonStart, jsonEnd);
        const srcMatch = fullImgTag.match(/src\s*=\s*["']?([^"'\s>]+)/i);
        const srcValue = srcMatch ? srcMatch[1] : '';
        let needsGeneration = false;
        const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg');
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;
        if (hasErrorImage && !forceAll) { searchPos = imgEnd; continue; }
        if (forceAll) needsGeneration = true;
        else if (hasMarker || !srcValue) needsGeneration = true;
        else if (hasPath && checkExistence) {
            if (!(await checkFileExists(srcValue))) needsGeneration = true;
            else { searchPos = imgEnd; continue; }
        } else if (hasPath) { searchPos = imgEnd; continue; }
        if (!needsGeneration) { searchPos = imgEnd; continue; }
        try {
            let nj = instructionJson.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
            const data = JSON.parse(nj);
            tags.push({
                fullMatch: fullImgTag, index: imgStart,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                preset: data.preset || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null, isNewFormat: true,
                existingSrc: hasPath ? srcValue : null
            });
        } catch (e) { iigLog('WARN', 'Failed to parse instruction JSON', e.message); }
        searchPos = imgEnd;
    }
    const marker = '[IMG:GEN:';
    let searchStart = 0;
    while (true) {
        const markerIndex = text.indexOf(marker, searchStart);
        if (markerIndex === -1) break;
        const jsonStart = markerIndex + marker.length;
        let braceCount = 0, jsonEnd = -1, inString = false, escapeNext = false;
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (char === '\\' && inString) { escapeNext = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (!inString) {
                if (char === '{') braceCount++;
                else if (char === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
            }
        }
        if (jsonEnd === -1) { searchStart = jsonStart; continue; }
        const jsonStr = text.substring(jsonStart, jsonEnd);
        if (!text.substring(jsonEnd).startsWith(']')) { searchStart = jsonEnd; continue; }
        try {
            const data = JSON.parse(jsonStr.replace(/'/g, '"'));
            tags.push({
                fullMatch: text.substring(markerIndex, jsonEnd + 1), index: markerIndex,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                preset: data.preset || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null, isNewFormat: false
            });
        } catch (e) { iigLog('WARN', 'Failed to parse legacy tag JSON', e.message); }
        searchStart = jsonEnd + 1;
    }
    return tags;
}

// ============================================================
// DOM HELPERS & MESSAGE PROCESSING
// ============================================================

function createLoadingPlaceholder(tagId) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-loading-placeholder';
    placeholder.dataset.tagId = tagId;
    placeholder.innerHTML = `<div class="iig-spinner-wrap"><div class="iig-spinner"></div></div><div class="iig-status">Генерация картинки...</div><div class="iig-timer"></div>`;
    const timerEl = placeholder.querySelector('.iig-timer');
    const startTime = Date.now();
    const tSec = FETCH_TIMEOUT / 1000;
    placeholder._timerInterval = setInterval(() => {
        const el = Math.floor((Date.now() - startTime) / 1000);
        if (el >= tSec) { timerEl.textContent = 'Таймаут...'; clearInterval(placeholder._timerInterval); return; }
        const m = Math.floor(el/60), s = el%60;
        timerEl.textContent = `${m}:${String(s).padStart(2,'0')} / ${Math.floor(tSec/60)}:00${IS_IOS ? ' (iOS)' : ''}`;
    }, 1000);
    return placeholder;
}

function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = 'Ошибка генерации';
    img.title = `Ошибка: ${errorMessage}`;
    img.dataset.tagId = tagId;
    if (tagInfo.fullMatch) {
        const m = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(?:(['"])([\s\S]*?)\1)/i)
            || tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*([{][\s\S]*?[}])(?:\s|>)/i);
        if (m) img.setAttribute('data-iig-instruction', m[2] || m[1]);
    }
    return img;
}

async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.enabled) return;
    if (processingMessages.has(messageId)) return;
    const message = context.chat[messageId];
    if (!message || message.is_user) return;
    const tags = await parseImageTags(message.mes, { checkExistence: true });
    if (tags.length === 0) return;
    processingMessages.add(messageId);
    toastr.info(`Найдено тегов: ${tags.length}. Генерация...`, 'Генерация картинок', { timeOut: 3000 });
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) { processingMessages.delete(messageId); return; }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }

    const processTag = async (tag, index) => {
        const tagId = `iig-${messageId}-${index}`;
        const loadingPlaceholder = createLoadingPlaceholder(tagId);
        let targetElement = null;
        if (tag.isNewFormat) {
            const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            const searchPrompt = tag.prompt.substring(0, 30);
            for (const img of allImgs) {
                const instruction = img.getAttribute('data-iig-instruction');
                if (!instruction) continue;
                const decoded = instruction.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#39;/g,"'").replace(/&#34;/g,'"').replace(/&amp;/g,'&');
                if (decoded.includes(searchPrompt) || instruction.includes(searchPrompt)) { targetElement = img; break; }
                try { const d = JSON.parse(decoded.replace(/'/g,'"')); if (d.prompt?.substring(0, 30) === tag.prompt.substring(0, 30)) { targetElement = img; break; } } catch(e) {}
            }
            if (!targetElement) { for (const img of allImgs) { const src = img.getAttribute('src') || ''; if (src.includes('[IMG:GEN]') || src === '' || src === '#') { targetElement = img; break; } } }
            if (!targetElement) { for (const img of mesTextEl.querySelectorAll('img')) { const src = img.getAttribute('src') || ''; if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) { targetElement = img; break; } } }
        } else {
            const tagEscaped = tag.fullMatch.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/"/g,'(?:"|&quot;)');
            const before = mesTextEl.innerHTML;
            mesTextEl.innerHTML = mesTextEl.innerHTML.replace(new RegExp(tagEscaped,'g'), `<span data-iig-placeholder="${tagId}"></span>`);
            if (before !== mesTextEl.innerHTML) targetElement = mesTextEl.querySelector(`[data-iig-placeholder="${tagId}"]`);
            if (!targetElement) { for (const img of mesTextEl.querySelectorAll('img')) { if (img.src && img.src.includes('[IMG:GEN:')) { targetElement = img; break; } } }
        }
        if (targetElement) targetElement.replaceWith(loadingPlaceholder);
        else mesTextEl.appendChild(loadingPlaceholder);
        const statusEl = loadingPlaceholder.querySelector('.iig-status');
        try {
            const dataUrl = await generateImageWithRetry(tag.prompt, tag.style, (status) => { statusEl.textContent = status; }, { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset });
            statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);
            const img = document.createElement('img');
            img.className = 'iig-generated-image'; img.src = imagePath; img.alt = tag.prompt;
            img.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;
            if (tag.isNewFormat) { const m = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i); if (m) img.setAttribute('data-iig-instruction', m[2]); }
            if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
            loadingPlaceholder.replaceWith(img);
            if (tag.isNewFormat) message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`));
            else message.mes = message.mes.replace(tag.fullMatch, `[IMG:✓:${imagePath}]`);
            sessionGenCount++; updateSessionStats();
            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Failed tag ${index}:`, error.message);
            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
            if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
            loadingPlaceholder.replaceWith(errorPlaceholder);
            if (tag.isNewFormat) message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${ERROR_IMAGE_PATH}"`));
            else message.mes = message.mes.replace(tag.fullMatch, `[IMG:ERROR:${error.message.substring(0, 50)}]`);
            sessionErrorCount++; updateSessionStats();
            toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
        }
    };
    try { await Promise.all(tags.map((tag, index) => processTag(tag, index))); }
    finally { processingMessages.delete(messageId); }
    await context.saveChat();
    if (typeof context.messageFormatting === 'function') {
        mesTextEl.innerHTML = context.messageFormatting(message.mes, message.name, message.is_system, message.is_user, messageId);
    }
}

async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Сообщение не найдено'); return; }
    const tags = await parseImageTags(message.mes, { forceAll: true });
    if (tags.length === 0) { toastr.warning('Нет тегов для перегенерации'); return; }
    toastr.info(`Перегенерация ${tags.length} картинок...`);
    processingMessages.add(messageId);
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) { processingMessages.delete(messageId); return; }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }
    for (let index = 0; index < tags.length; index++) {
        const tag = tags[index];
        const tagId = `iig-regen-${messageId}-${index}`;
        try {
            const allInstructionImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            const existingImg = allInstructionImgs[index] || null;
            if (existingImg) {
                const instruction = existingImg.getAttribute('data-iig-instruction');
                const lp = createLoadingPlaceholder(tagId);
                existingImg.replaceWith(lp);
                const statusEl = lp.querySelector('.iig-status');
                const dataUrl = await generateImageWithRetry(tag.prompt, tag.style, (status) => { statusEl.textContent = status; }, { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset });
                statusEl.textContent = 'Сохранение...';
                const imagePath = await saveImageToFile(dataUrl);
                const img = document.createElement('img');
                img.className = 'iig-generated-image'; img.src = imagePath; img.alt = tag.prompt;
                if (instruction) img.setAttribute('data-iig-instruction', instruction);
                if (lp._timerInterval) clearInterval(lp._timerInterval);
                lp.replaceWith(img);
                message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`));
                toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
            }
        } catch (error) {
            iigLog('ERROR', `Regen failed tag ${index}:`, error.message);
            toastr.error(`Ошибка: ${error.message}`);
        }
    }
    processingMessages.delete(messageId);
    await context.saveChat();
}

function addRegenerateButton(messageElement, messageId) {
    if (messageElement.querySelector('.iig-regenerate-btn')) return;
    const extra = messageElement.querySelector('.extraMesButtons');
    if (!extra) return;
    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать картинки';
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => { e.stopPropagation(); await regenerateMessageImages(messageId); });
    extra.appendChild(btn);
}

function addButtonsToExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat?.length) return;
    for (const el of document.querySelectorAll('#chat .mes')) {
        const mesId = el.getAttribute('mesid');
        if (mesId === null) continue;
        const mid = parseInt(mesId, 10);
        const msg = context.chat[mid];
        if (msg && !msg.is_user) addRegenerateButton(el, mid);
    }
}

async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const el = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!el) return;
    addRegenerateButton(el, messageId);
    await processMessageTags(messageId);
}

// ============================================================
// SETTINGS UI
// ============================================================

function renderRefSlots() {
    const settings = getCurrentCharacterRefs();
    const setThumb = (thumb, ref) => {
        if (!thumb) return;
        if (ref?.imagePath) thumb.src = ref.imagePath;
        else if (ref?.imageBase64) thumb.src = 'data:image/jpeg;base64,' + ref.imageBase64;
        else thumb.src = '';
    };
    const charSlot = document.querySelector('.iig-ref-slot[data-ref-type="char"]');
    if (charSlot) { setThumb(charSlot.querySelector('.iig-ref-thumb'), settings.charRef); charSlot.querySelector('.iig-ref-name').value = settings.charRef?.name || ''; }
    const userSlot = document.querySelector('.iig-ref-slot[data-ref-type="user"]');
    if (userSlot) { setThumb(userSlot.querySelector('.iig-ref-thumb'), settings.userRef); userSlot.querySelector('.iig-ref-name').value = settings.userRef?.name || ''; }
    renderNpcList();
}

function renderNpcList() {
    const settings = getCurrentCharacterRefs();
    const container = document.getElementById('iig_npc_list');
    if (!container) return;
    container.innerHTML = '';
    if (!settings.npcReferences || settings.npcReferences.length === 0) {
        container.innerHTML = '<p style="color:#5a5252;font-size:11px;margin:4px 0;">Нет добавленных NPC</p>';
        return;
    }
    for (let i = 0; i < settings.npcReferences.length; i++) {
        const npc = settings.npcReferences[i];
        const slot = document.createElement('div');
        slot.className = 'iig-ref-slot iig-npc-slot';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.checked = npc.enabled !== false;
        checkbox.addEventListener('change', (e) => { settings.npcReferences[i].enabled = e.target.checked; saveSettings(); });
        const label = document.createElement('div');
        label.className = 'iig-ref-label'; label.textContent = `NPC ${i + 1}`;
        const preview = document.createElement('div');
        preview.className = 'iig-ref-preview';
        const thumb = document.createElement('img');
        thumb.className = 'iig-ref-thumb'; thumb.alt = npc.name || `NPC ${i + 1}`;
        if (npc.imageBase64 || npc.imageData) thumb.src = 'data:image/jpeg;base64,' + (npc.imageBase64 || npc.imageData);
        else if (npc.imagePath) thumb.src = npc.imagePath;
        else thumb.src = '';
        preview.appendChild(thumb);
        const nameInput = document.createElement('input');
        nameInput.type = 'text'; nameInput.className = 'text_pole iig-ref-name';
        nameInput.placeholder = 'Имя NPC'; nameInput.value = npc.name || '';
        nameInput.addEventListener('input', (e) => { settings.npcReferences[i].name = e.target.value; saveSettings(); });
        const uploadLabel = document.createElement('label');
        uploadLabel.className = 'menu_button iig-ref-upload-btn'; uploadLabel.title = 'Загрузить фото';
        uploadLabel.innerHTML = '<i class="fa-solid fa-upload"></i>';
        const fileInput = document.createElement('input');
        fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.style.display = 'none';
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0]; if (!file) return;
            try {
                const rawBase64 = await new Promise((res, rej) => { const r = new FileReader(); r.onloadend = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
                const compressed = await compressBase64Image(rawBase64, 768, 0.8);
                settings.npcReferences[i].imageBase64 = compressed; settings.npcReferences[i].imagePath = '';
                saveSettings(); thumb.src = 'data:image/jpeg;base64,' + compressed;
                toastr.success(`Фото для "${settings.npcReferences[i].name || `NPC ${i+1}`}" загружено`);
            } catch (err) { toastr.error('Ошибка загрузки фото'); }
            e.target.value = '';
        });
        uploadLabel.appendChild(fileInput);
        const deleteBtn = document.createElement('div');
        deleteBtn.className = 'menu_button iig-ref-delete-btn'; deleteBtn.title = 'Удалить NPC';
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>'; deleteBtn.style.color = '#cc5555';
        deleteBtn.addEventListener('click', () => {
            const name = settings.npcReferences[i]?.name || `NPC ${i + 1}`;
            settings.npcReferences.splice(i, 1); saveSettings(); renderNpcList();
            toastr.info(`NPC "${name}" удалён`);
        });
        slot.appendChild(checkbox); slot.appendChild(label); slot.appendChild(preview);
        slot.appendChild(nameInput); slot.appendChild(uploadLabel); slot.appendChild(deleteBtn);
        container.appendChild(slot);
    }
}

function createSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) return;

    const wardrobeSectionHtml = `
        <p class="hint">Загрузите картинки с одеждой. Выбранная одежда отправляется как референс + описание инжектится в чат.</p>
        <label class="checkbox_label">
            <input type="checkbox" id="iig_inject_wardrobe" ${settings.injectWardrobeToChat ? 'checked' : ''}>
            <span>Инжектить описание в промпт</span>
        </label>
        <div class="flex-row" style="margin-top:5px;">
            <label for="iig_wardrobe_injection_depth">Глубина инжекта</label>
            <input type="number" id="iig_wardrobe_injection_depth" class="text_pole flex1" value="${settings.wardrobeInjectionDepth || 1}" min="0" max="10">
        </div>
        <h5 style="margin:10px 0 4px;">Одежда персонажа</h5>
        <div id="iig_wardrobe_char" class="iig-wardrobe-grid"></div>
        <div class="iig-wardrobe-add-row">
            <input type="text" id="iig_wardrobe_char_name" class="text_pole flex1" placeholder="Название наряда">
            <input type="file" id="iig_wardrobe_char_file" accept="image/*" style="display:none;">
            <div id="iig_wardrobe_char_add" class="menu_button"><i class="fa-solid fa-plus"></i> Добавить</div>
        </div>
        <h5 style="margin:14px 0 4px;">Одежда юзера</h5>
        <div id="iig_wardrobe_user" class="iig-wardrobe-grid"></div>
        <div class="iig-wardrobe-add-row">
            <input type="text" id="iig_wardrobe_user_name" class="text_pole flex1" placeholder="Название наряда">
            <input type="file" id="iig_wardrobe_user_file" accept="image/*" style="display:none;">
            <div id="iig_wardrobe_user_add" class="menu_button"><i class="fa-solid fa-plus"></i> Добавить</div>
        </div>
    `;

    const hairstyleSectionHtml = `
        <p class="hint">Загрузите картинки с причёсками. Выбранная причёска отправляется как референс.</p>
        <label class="checkbox_label">
            <input type="checkbox" id="iig_inject_hairstyle" ${settings.injectHairstyleToChat ? 'checked' : ''}>
            <span>Инжектить описание причёски в промпт</span>
        </label>
        <h5 style="margin:10px 0 4px;">Причёска персонажа</h5>
        <div id="iig_hairstyle_char" class="iig-wardrobe-grid"></div>
        <div class="iig-wardrobe-add-row">
            <input type="text" id="iig_hairstyle_char_name" class="text_pole flex1" placeholder="Название причёски">
            <input type="file" id="iig_hairstyle_char_file" accept="image/*" style="display:none;">
            <div id="iig_hairstyle_char_add" class="menu_button"><i class="fa-solid fa-plus"></i> Добавить</div>
        </div>
        <h5 style="margin:14px 0 4px;">Причёска юзера</h5>
        <div id="iig_hairstyle_user" class="iig-wardrobe-grid"></div>
        <div class="iig-wardrobe-add-row">
            <input type="text" id="iig_hairstyle_user_name" class="text_pole flex1" placeholder="Название причёски">
            <input type="file" id="iig_hairstyle_user_file" accept="image/*" style="display:none;">
            <div id="iig_hairstyle_user_add" class="menu_button"><i class="fa-solid fa-plus"></i> Добавить</div>
        </div>
    `;

    const wardrobeDescApiHtml = `
        <p class="hint">Текстовая/vision модель для авто-описания одежды по картинке. Если не указано — основной API.</p>
        <div class="flex-row">
            <label for="iig_wardrobe_desc_endpoint">Эндпоинт</label>
            <input type="text" id="iig_wardrobe_desc_endpoint" class="text_pole flex1" value="${sanitizeForHtml(settings.wardrobeDescEndpoint || '')}" placeholder="https://api.example.com">
        </div>
        <div class="flex-row">
            <label for="iig_wardrobe_desc_api_key">API ключ</label>
            <input type="password" id="iig_wardrobe_desc_api_key" class="text_pole flex1" value="${sanitizeForHtml(settings.wardrobeDescApiKey || '')}">
        </div>
        <div class="flex-row">
            <label for="iig_wardrobe_desc_model">Модель</label>
            <select id="iig_wardrobe_desc_model" class="flex1">
                ${settings.wardrobeDescModel ? `<option value="${sanitizeForHtml(settings.wardrobeDescModel)}" selected>${sanitizeForHtml(settings.wardrobeDescModel)}</option>` : '<option value="">-- Выберите --</option>'}
            </select>
            <div id="iig_refresh_desc_models" class="menu_button iig-refresh-btn" title="Обновить"><i class="fa-solid fa-sync"></i></div>
        </div>
    `;

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><span style="font-style:normal;">🍒</span> Генерация картинок</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить генерацию картинок</span>
                    </label>
                    <hr>

                    <!-- API -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-plug"></i> Настройки API</h4>
                        <div class="flex-row">
                            <label for="iig_api_type">Тип API</label>
                            <select id="iig_api_type" class="flex1">
                                <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый</option>
                                <option value="void" ${settings.apiType === 'void' ? 'selected' : ''}>VoidAI</option>
                                <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini / Nano-Banana</option>
                                <option value="naistera" ${settings.apiType === 'naistera' ? 'selected' : ''}>Naistera / Grok</option>
                            </select>
                        </div>
                        <div class="flex-row">
                            <label for="iig_endpoint">URL эндпоинта</label>
                            <input type="text" id="iig_endpoint" class="text_pole flex1" value="${sanitizeForHtml(settings.endpoint)}" placeholder="https://api.example.com">
                        </div>
                        <div class="flex-row" style="gap:4px;flex-wrap:wrap;">
                            <span style="font-size:0.8em;opacity:0.6;">Быстрый:</span>
                            <div class="menu_button iig-preset-btn" data-preset-url="https://api.voidai.app" data-preset-type="void" style="font-size:0.8em;padding:2px 8px;">VoidAI</div>
                            <div class="menu_button iig-preset-btn" data-preset-url="https://api.routemyai.com" data-preset-type="openai" style="font-size:0.8em;padding:2px 8px;">RouteMyAI</div>
                            <div class="menu_button iig-preset-btn" data-preset-url="https://api.openai.com" data-preset-type="openai" style="font-size:0.8em;padding:2px 8px;">OpenAI</div>
                        </div>
                        <div class="flex-row">
                            <label for="iig_api_key">API ключ</label>
                            <input type="password" id="iig_api_key" class="text_pole flex1" value="${sanitizeForHtml(settings.apiKey)}">
                            <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть"><i class="fa-solid fa-eye"></i></div>
                        </div>
                        <p id="iig_naistera_hint" class="hint ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}">Naistera/Grok: вставьте токен из Telegram бота.</p>
                        <div class="flex-row ${settings.apiType === 'naistera' ? 'iig-hidden' : ''}" id="iig_model_row">
                            <label for="iig_model">Модель</label>
                            <select id="iig_model" class="flex1">
                                ${settings.model ? `<option value="${sanitizeForHtml(settings.model)}" selected>${sanitizeForHtml(settings.model)}</option>` : '<option value="">-- Выберите --</option>'}
                            </select>
                            <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить"><i class="fa-solid fa-sync"></i></div>
                        </div>
                        <div id="iig_test_connection" class="menu_button iig-test-connection"><i class="fa-solid fa-wifi"></i> Тест</div>
                    </div>
                    <hr>

                    <!-- Image Context -->
                    <div class="iig-section ${['naistera', 'gemini'].includes(settings.apiType) ? '' : 'iig-hidden'}" id="iig_image_context_section">
                        <h4><i class="fa-solid fa-clock-rotate-left"></i> Контекст картинок</h4>
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_image_context_enabled" ${settings.imageContextEnabled ? 'checked' : ''}>
                            <span>Включить контекст картинок</span>
                        </label>
                        <div class="flex-row ${settings.imageContextEnabled ? '' : 'iig-hidden'}" id="iig_image_context_count_row" style="margin-top:6px;">
                            <span>Использовать</span>
                            <input type="number" id="iig_image_context_count" class="text_pole" style="width:54px;" min="1" max="${MAX_CONTEXT_IMAGES}" value="${normalizeImageContextCount(settings.imageContextCount)}">
                            <span>предыд. картинок</span>
                        </div>
                    </div>
                    <hr>

                    <!-- Gen params -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-sliders"></i> Параметры генерации</h4>
                        <div class="flex-row" id="iig_size_row">
                            <label for="iig_size">Размер</label>
                            <select id="iig_size" class="flex1">
                                <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024×1024</option>
                                <option value="1536x1024" ${settings.size === '1536x1024' ? 'selected' : ''}>1536×1024</option>
                                <option value="1024x1536" ${settings.size === '1024x1536' ? 'selected' : ''}>1024×1536</option>
                                <option value="2048x2048" ${settings.size === '2048x2048' ? 'selected' : ''}>2048×2048</option>
                                <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>512×512</option>
                                <option value="auto" ${settings.size === 'auto' ? 'selected' : ''}>Авто</option>
                            </select>
                        </div>
                        <div class="flex-row"><label for="iig_quality">Качество</label><select id="iig_quality" class="flex1"><option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>Стандартное</option><option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>HD</option></select></div>
                        <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_aspect_row"><label>Соотношение</label><select id="iig_naistera_aspect_ratio" class="flex1"><option value="1:1" ${settings.naisteraAspectRatio==='1:1'?'selected':''}>1:1</option><option value="3:2" ${settings.naisteraAspectRatio==='3:2'?'selected':''}>3:2</option><option value="2:3" ${settings.naisteraAspectRatio==='2:3'?'selected':''}>2:3</option></select></div>
                        <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_preset_row"><label>Пресет</label><select id="iig_naistera_preset" class="flex1"><option value="" ${!settings.naisteraPreset?'selected':''}>Нет</option><option value="digital" ${settings.naisteraPreset==='digital'?'selected':''}>Digital</option><option value="realism" ${settings.naisteraPreset==='realism'?'selected':''}>Realism</option></select></div>
                        <div id="iig_gemini_params" class="${settings.apiType !== 'gemini' ? 'iig-hidden' : ''}">
                            <div class="flex-row"><label>Соотношение</label><select id="iig_aspect_ratio" class="flex1">${VALID_ASPECT_RATIOS.map(r=>`<option value="${r}" ${settings.aspectRatio===r?'selected':''}>${r}</option>`).join('')}</select></div>
                            <div class="flex-row"><label>Разрешение</label><select id="iig_image_size" class="flex1">${VALID_IMAGE_SIZES.map(s=>`<option value="${s}" ${settings.imageSize===s?'selected':''}>${s}</option>`).join('')}</select></div>
                        </div>
                    </div>
                    <hr>

                    <!-- References -->
                    <div id="iig_refs_section" class="iig-refs">
                        <h4><i class="fa-solid fa-user-group"></i> Референсы персонажей</h4>
                        <p class="hint">Фото для консистентной генерации. Макс 4 картинки за запрос: {{char}} → {{user}} → одежда → NPC.</p>
                        <div class="iig-ref-slot" data-ref-type="char">
                            <div class="iig-ref-label">{{char}}</div>
                            <div class="iig-ref-preview"><img src="" alt="Char" class="iig-ref-thumb"></div>
                            <input type="text" class="text_pole iig-ref-name" placeholder="Имя персонажа" value="">
                            <label class="menu_button iig-ref-upload-btn" title="Загрузить"><i class="fa-solid fa-upload"></i><input type="file" accept="image/*" class="iig-ref-file-input" style="display:none"></label>
                            <div class="menu_button iig-ref-delete-btn" title="Удалить"><i class="fa-solid fa-trash"></i></div>
                        </div>
                        <div class="iig-ref-slot" data-ref-type="user">
                            <div class="iig-ref-label">{{user}}</div>
                            <div class="iig-ref-preview"><img src="" alt="User" class="iig-ref-thumb"></div>
                            <input type="text" class="text_pole iig-ref-name" placeholder="Имя юзера" value="">
                            <label class="menu_button iig-ref-upload-btn" title="Загрузить"><i class="fa-solid fa-upload"></i><input type="file" accept="image/*" class="iig-ref-file-input" style="display:none"></label>
                            <div class="menu_button iig-ref-delete-btn" title="Удалить"><i class="fa-solid fa-trash"></i></div>
                        </div>
                        <hr>
                        <h5><i class="fa-solid fa-users"></i> NPC</h5>
                        <p class="hint">NPC добавляются как референсы если имя в промпте.</p>
                        <div id="iig_npc_list"></div>
                        <div class="flex-row" style="margin-top:8px;gap:4px;">
                            <input type="text" id="iig_npc_new_name" class="text_pole flex1" placeholder="Имя NPC">
                            <div id="iig_npc_add" class="menu_button"><i class="fa-solid fa-plus"></i> Добавить</div>
                        </div>
                    </div>
                    <hr>

                    <!-- Wardrobe (inline grids) -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-shirt"></i> Гардероб (одежда)</h4>
                        ${wardrobeSectionHtml}
                    </div>
                    <hr>

                    <!-- Wardrobe Description API -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-robot"></i> Vision API (описание одежды)</h4>
                        ${wardrobeDescApiHtml}
                    </div>
                    <hr>

                    <!-- Hairstyles -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-scissors"></i> Причёски</h4>
                        ${hairstyleSectionHtml}
                    </div>
                    <hr>

                    <!-- Retry -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-rotate"></i> Повторы</h4>
                        <div class="flex-row"><label>Макс. повторов</label><input type="number" id="iig_max_retries" class="text_pole flex1" value="${settings.maxRetries}" min="0" max="5"></div>
                        <div class="flex-row"><label>Задержка (мс)</label><input type="number" id="iig_retry_delay" class="text_pole flex1" value="${settings.retryDelay}" min="500" max="10000" step="500"></div>
                    </div>
                    <hr>

                    <!-- Debug -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-bug"></i> Отладка</h4>
                        <div id="iig_export_logs" class="menu_button iig-export-logs-btn"><i class="fa-solid fa-download"></i> Экспорт логов</div>
                    </div>
                    <p class="hint" style="text-align:center;opacity:0.5;margin-top:4px;">v2.2.0 · wardrobe grid</p>
                    <p id="iig_session_stats" class="hint" style="text-align:center;opacity:0.35;margin-top:2px;font-size:0.8em;"></p>
                </div>
            </div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', html);
    bindSettingsEvents();
    renderRefSlots();

    // Render wardrobe grids
    for (const sys of ['wardrobe', 'hairstyle']) {
        renderOutfitGrid(sys, 'char');
        renderOutfitGrid(sys, 'user');
    }
}

function bindSettingsEvents() {
    const settings = getSettings();
    const updateVisibility = () => {
        const apiType = settings.apiType;
        const isNaistera = apiType === 'naistera';
        const isGemini = apiType === 'gemini';
        document.getElementById('iig_model_row')?.classList.toggle('iig-hidden', isNaistera);
        document.getElementById('iig_naistera_aspect_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_preset_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_hint')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_gemini_params')?.classList.toggle('iig-hidden', !isGemini);
        document.getElementById('iig_image_context_section')?.classList.toggle('iig-hidden', !(isNaistera || isGemini));
        document.getElementById('iig_image_context_count_row')?.classList.toggle('iig-hidden', !(settings.imageContextEnabled && (isNaistera || isGemini)));
    };

    document.getElementById('iig_enabled')?.addEventListener('change', (e) => { settings.enabled = e.target.checked; saveSettings(); updateHeaderStatusDot(); });
    document.getElementById('iig_api_type')?.addEventListener('change', (e) => { settings.apiType = e.target.value; saveSettings(); updateVisibility(); });
    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => { settings.endpoint = e.target.value; saveSettings(); });
    document.querySelectorAll('.iig-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            settings.endpoint = btn.dataset.presetUrl;
            const input = document.getElementById('iig_endpoint'); if (input) input.value = btn.dataset.presetUrl;
            if (btn.dataset.presetType) { settings.apiType = btn.dataset.presetType; const sel = document.getElementById('iig_api_type'); if (sel) sel.value = btn.dataset.presetType; updateVisibility(); }
            saveSettings(); toastr.info(`Эндпоинт: ${btn.dataset.presetUrl}`);
        });
    });
    document.getElementById('iig_api_key')?.addEventListener('input', (e) => { settings.apiKey = e.target.value; saveSettings(); });
    document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_api_key');
        const icon = document.querySelector('#iig_key_toggle i');
        if (input.type === 'password') { input.type = 'text'; icon.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { input.type = 'password'; icon.classList.replace('fa-eye-slash', 'fa-eye'); }
    });
    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        settings.model = e.target.value; saveSettings();
        if (isGeminiModel(e.target.value)) { document.getElementById('iig_api_type').value = 'gemini'; settings.apiType = 'gemini'; updateVisibility(); }
    });
    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            select.innerHTML = '<option value="">-- Выберите --</option>';
            for (const m of models) { const opt = document.createElement('option'); opt.value = m; opt.textContent = m; opt.selected = m === settings.model; select.appendChild(opt); }
            toastr.success(`Найдено моделей: ${models.length}`);
        } catch (e) { toastr.error('Ошибка загрузки моделей'); }
        finally { btn.classList.remove('loading'); }
    });
    document.getElementById('iig_size')?.addEventListener('change', (e) => { settings.size = e.target.value; saveSettings(); });
    document.getElementById('iig_quality')?.addEventListener('change', (e) => { settings.quality = e.target.value; saveSettings(); });
    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => { settings.aspectRatio = e.target.value; saveSettings(); });
    document.getElementById('iig_image_size')?.addEventListener('change', (e) => { settings.imageSize = e.target.value; saveSettings(); });
    document.getElementById('iig_naistera_aspect_ratio')?.addEventListener('change', (e) => { settings.naisteraAspectRatio = e.target.value; saveSettings(); });
    document.getElementById('iig_naistera_preset')?.addEventListener('change', (e) => { settings.naisteraPreset = e.target.value; saveSettings(); });
    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => { settings.maxRetries = Math.max(0, Math.min(5, parseInt(e.target.value) || 0)); saveSettings(); });
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => { settings.retryDelay = Math.max(500, parseInt(e.target.value) || 1000); saveSettings(); });
    document.getElementById('iig_export_logs')?.addEventListener('click', exportLogs);
    document.getElementById('iig_image_context_enabled')?.addEventListener('change', (e) => { settings.imageContextEnabled = e.target.checked; saveSettings(); updateVisibility(); });
    document.getElementById('iig_image_context_count')?.addEventListener('input', (e) => { settings.imageContextCount = normalizeImageContextCount(e.target.value); e.target.value = String(settings.imageContextCount); saveSettings(); });

    // Test connection
    document.getElementById('iig_test_connection')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; if (btn.classList.contains('testing')) return;
        btn.classList.add('testing'); const icon = btn.querySelector('i'); const oc = icon.className; icon.className = 'fa-solid fa-spinner';
        try {
            if (!settings.endpoint || !settings.apiKey) throw new Error('Настройте эндпоинт и ключ');
            if (settings.apiType === 'naistera') { const resp = await fetch(settings.endpoint.replace(/\/$/, ''), { method: 'HEAD' }).catch(() => null); toastr[resp?.ok ? 'success' : 'warning']('Соединение ' + (resp?.ok ? 'OK' : 'non-OK')); }
            else { const models = await fetchModels(); toastr.success(`OK — ${models.length} моделей`); }
        } catch (error) { toastr.error(`Ошибка: ${error.message}`); }
        finally { btn.classList.remove('testing'); icon.className = oc; }
    });

    // Wardrobe events
    document.getElementById('iig_inject_wardrobe')?.addEventListener('change', (e) => { settings.injectWardrobeToChat = e.target.checked; saveSettings(); updateOutfitInjection('wardrobe'); });
    document.getElementById('iig_wardrobe_injection_depth')?.addEventListener('input', (e) => { settings.wardrobeInjectionDepth = parseInt(e.target.value) || 1; saveSettings(); updateOutfitInjection('wardrobe'); });
    document.getElementById('iig_inject_hairstyle')?.addEventListener('change', (e) => { settings.injectHairstyleToChat = e.target.checked; saveSettings(); updateOutfitInjection('hairstyle'); });

    // Wardrobe description API
    document.getElementById('iig_wardrobe_desc_endpoint')?.addEventListener('input', (e) => { settings.wardrobeDescEndpoint = e.target.value; saveSettings(); });
    document.getElementById('iig_wardrobe_desc_api_key')?.addEventListener('input', (e) => { settings.wardrobeDescApiKey = e.target.value; saveSettings(); });
    document.getElementById('iig_wardrobe_desc_model')?.addEventListener('change', (e) => { settings.wardrobeDescModel = e.target.value; saveSettings(); });
    document.getElementById('iig_refresh_desc_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const models = await fetchDescriptionModels();
            const select = document.getElementById('iig_wardrobe_desc_model');
            select.innerHTML = '<option value="">-- Выберите --</option>';
            for (const m of models) { const opt = document.createElement('option'); opt.value = m; opt.textContent = m; opt.selected = m === settings.wardrobeDescModel; select.appendChild(opt); }
            toastr.success(`Найдено моделей: ${models.length}`);
        } catch (e) { toastr.error('Ошибка загрузки моделей'); }
        finally { btn.classList.remove('loading'); }
    });

    // Outfit add buttons
    for (const sys of ['wardrobe', 'hairstyle']) {
        bindOutfitAddEvents(sys, 'char');
        bindOutfitAddEvents(sys, 'user');
    }

    // Char/User ref slots
    bindRefSlotEvents();

    // NPC
    document.getElementById('iig_npc_add')?.addEventListener('click', () => {
        const nameInput = document.getElementById('iig_npc_new_name');
        const name = nameInput?.value?.trim();
        if (!name) { toastr.warning('Введите имя NPC'); return; }
        const s = getCurrentCharacterRefs();
        if (s.npcReferences.some(n => n.name.toLowerCase() === name.toLowerCase())) { toastr.warning(`NPC "${name}" уже существует`); return; }
        s.npcReferences.push({ name, imageBase64: '', imagePath: '', enabled: true });
        saveSettings(); if (nameInput) nameInput.value = '';
        renderNpcList(); toastr.success(`NPC "${name}" добавлен`);
    });
    document.getElementById('iig_npc_new_name')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('iig_npc_add')?.click(); } });
    renderNpcList();

    updateVisibility();
}

function bindRefSlotEvents() {
    for (const slot of document.querySelectorAll('.iig-ref-slot[data-ref-type]')) {
        const refType = slot.dataset.refType;
        slot.querySelector('.iig-ref-name')?.addEventListener('input', (e) => {
            const s = getCurrentCharacterRefs();
            if (refType === 'char') s.charRef.name = e.target.value;
            else if (refType === 'user') s.userRef.name = e.target.value;
            saveSettings();
        });
        slot.querySelector('.iig-ref-file-input')?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0]; if (!file) return;
            try {
                const rawBase64 = await new Promise((res, rej) => { const r = new FileReader(); r.onloadend = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
                const compressed = await compressBase64Image(rawBase64, 768, 0.8);
                const label = refType;
                const savedPath = await saveRefImageToFile(compressed, label);
                const s = getCurrentCharacterRefs();
                if (refType === 'char') { s.charRef.imageBase64 = ''; s.charRef.imagePath = savedPath; }
                else if (refType === 'user') { s.userRef.imageBase64 = ''; s.userRef.imagePath = savedPath; }
                saveSettings();
                const thumb = slot.querySelector('.iig-ref-thumb'); if (thumb) thumb.src = savedPath;
                toastr.success('Фото сохранено');
            } catch (err) { toastr.error('Ошибка загрузки фото'); }
            e.target.value = '';
        });
        slot.querySelector('.iig-ref-delete-btn')?.addEventListener('click', () => {
            const s = getCurrentCharacterRefs();
            if (refType === 'char') s.charRef = { name: '', imageBase64: '', imagePath: '' };
            else if (refType === 'user') s.userRef = { name: '', imageBase64: '', imagePath: '' };
            saveSettingsNow();
            const thumb = slot.querySelector('.iig-ref-thumb'); if (thumb) thumb.src = '';
            const nameEl = slot.querySelector('.iig-ref-name'); if (nameEl) nameEl.value = '';
            toastr.info('Слот очищен');
        });
    }
}

// ============================================================
// LIGHTBOX
// ============================================================

function initLightbox() {
    if (document.getElementById('iig_lightbox')) return;
    const overlay = document.createElement('div');
    overlay.id = 'iig_lightbox'; overlay.className = 'iig-lightbox';
    overlay.innerHTML = `<div class="iig-lightbox-backdrop"></div><div class="iig-lightbox-content"><img class="iig-lightbox-img" src="" alt="Preview"><div class="iig-lightbox-caption"></div><button class="iig-lightbox-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button></div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.classList.remove('open');
    overlay.querySelector('.iig-lightbox-backdrop').addEventListener('click', close);
    overlay.querySelector('.iig-lightbox-close').addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('open')) close(); });
    document.getElementById('chat')?.addEventListener('click', (e) => {
        const img = e.target.closest('.iig-generated-image'); if (!img) return;
        e.preventDefault(); e.stopPropagation();
        overlay.querySelector('.iig-lightbox-img').src = img.src;
        overlay.querySelector('.iig-lightbox-caption').textContent = img.alt || '';
        overlay.classList.add('open');
    });
}

function updateHeaderStatusDot() {
    const settings = getSettings();
    const header = document.querySelector('.inline-drawer-header');
    if (!header) return;
    let dot = header.querySelector('.iig-header-dot');
    if (!dot) {
        dot = document.createElement('span'); dot.className = 'iig-header-dot';
        const chevron = header.querySelector('.inline-drawer-icon');
        if (chevron) header.insertBefore(dot, chevron); else header.appendChild(dot);
    }
    dot.classList.toggle('active', settings.enabled);
}

// ============================================================
// INIT
// ============================================================

(function init() {
    const context = SillyTavern.getContext();
    iigLog('INFO', 'Initializing IIG + Wardrobe Grid v2.2.0');
    iigLog('INFO', `Platform: ${IS_IOS ? 'iOS' : 'Desktop'}, Timeout: ${FETCH_TIMEOUT/1000}s`);
    getSettings();

    context.eventSource.on(context.event_types.APP_READY, () => {
        restoreRefsFromLocalStorage();
        createSettingsUI();
        addButtonsToExistingMessages();
        initLightbox();
        updateHeaderStatusDot();
        initMobileSaveListeners();
        updateOutfitInjection('wardrobe');
        updateOutfitInjection('hairstyle');
        iigLog('INFO', 'IIG + Wardrobe Grid loaded');
    });

    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            restoreRefsFromLocalStorage();
            addButtonsToExistingMessages();
            renderRefSlots();
            updateOutfitInjection('wardrobe');
            updateOutfitInjection('hairstyle');
            for (const sys of ['wardrobe', 'hairstyle']) {
                renderOutfitGrid(sys, 'char');
                renderOutfitGrid(sys, 'user');
            }
        }, 300);
    });

    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
        iigLog('INFO', `Event: message ${messageId}`);
        await onMessageReceived(messageId);
    });

    iigLog('INFO', 'IIG + Wardrobe Grid initialized');
})();
