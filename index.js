/**
 * Inline Image Generation Extension for SillyTavern
 *
 * Catches [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible and Gemini-compatible (nano-banana) endpoints.
 *
 * v2.5: Style enforcement overhaul — fixed style now dominates the prompt,
 *        removed positive/negative prompts to reduce noise,
 *        better avatar reference handling (larger resize), cleaner prompt structure.
 */

const MODULE_NAME = 'inline_image_gen';

const processingMessages = new Set();
// v2.4: Map of messageId -> AbortController for cancellation
const activeAbortControllers = new Map();

const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

function iigLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const entry = `[${timestamp}] [${level}] ${message}`;
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
    if (level === 'ERROR') console.error('[IIG]', ...args);
    else if (level === 'WARN') console.warn('[IIG]', ...args);
    else console.log('[IIG]', ...args);
}

function exportLogs() {
    const logsText = logBuffer.join('\n');
    const blob = new Blob([logsText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iig-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Логи экспортированы', 'Генерация картинок');
}

// Default settings
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
    sendCharAvatar: false,
    sendUserAvatar: false,
    userAvatarFile: '',
    aspectRatio: '1:1',
    imageSize: '1K',
    // v2.5: removed positivePrompt, negativePrompt
    fixedStyle: '',
    fixedStyleEnabled: false,
    extractAppearance: true,
    extractUserAppearance: true,
    detectClothing: true,
    clothingSearchDepth: 5,
    npcList: [],
    autoDetectNames: true,
    // v2.2: Wardrobe
    wardrobeItems: [],
    activeWardrobeChar: null,
    activeWardrobeUser: null,
    // v2.2: Collapsible section states
    collapsedSections: {},
    // v2.3: Wardrobe descriptions
    wardrobeDescEndpoint: '',
    wardrobeDescApiKey: '',
    wardrobeDescModel: '',
    injectWardrobeToChat: true,
    wardrobeInjectionDepth: 1,
    wardrobeDescPrompt: 'Describe this clothing outfit in detail for a character in a roleplay. Focus on: type of garment, color, material/texture, style, notable features, accessories. Be concise but thorough (2-4 sentences). Write in English.',
    // v2.4: Request timeout
    requestTimeout: 120,
    // v2.4: Hairstyles
    hairstyleItems: [],
    activeHairstyleChar: null,
    activeHairstyleUser: null,
    injectHairstyleToChat: true,
    hairstyleDescPrompt: 'Describe this hairstyle shape and form for a character in a roleplay. Focus on: hair length, texture, style (straight/curly/wavy), cut, bangs, volume, layers, accessories (ribbons, clips, pins), and overall silhouette. Do NOT mention or describe hair color — only describe the shape and styling. Be concise but thorough (2-3 sentences). Write in English.',
});

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
    context.saveSettingsDebounced();
    iigLog('INFO', 'Settings saved.');
}

// ============================================================
// MODEL & AVATAR FETCHING
// ============================================================

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

// v2.3: Fetch text/vision models for description generation
async function fetchDescriptionModels() {
    const settings = getSettings();
    const endpoint = settings.wardrobeDescEndpoint || settings.endpoint;
    const apiKey = settings.wardrobeDescApiKey || settings.apiKey;
    if (!endpoint || !apiKey) return [];
    const url = `${endpoint.replace(/\/$/, '')}/v1/models`;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        // Return non-image models (text/vision models)
        return (data.data || []).filter(m => !isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        toastr.error(`Ошибка загрузки текстовых моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

async function fetchUserAvatars() {
    try {
        const context = SillyTavern.getContext();
        const response = await fetch('/api/avatars/get', {
            method: 'POST',
            headers: context.getRequestHeaders(),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error('[IIG] Failed to fetch user avatars:', error);
        return [];
    }
}

async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[IIG] Failed to convert image to base64:', error);
        return null;
    }
}

async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL format');
    const format = match[1];
    const base64Data = match[2];
    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `iig_${timestamp}`;
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ image: base64Data, format, ch_name: charName, filename })
    });
    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || `Upload failed: ${response.status}`);
    }
    const result = await response.json();
    return result.path;
}

// ============================================================
// AVATAR RETRIEVAL
// ============================================================

async function getCharacterAvatarBase64() {
    try {
        const context = SillyTavern.getContext();
        if (context.characterId === undefined || context.characterId === null) return null;
        if (typeof context.getCharacterAvatar === 'function') {
            const avatarUrl = context.getCharacterAvatar(context.characterId);
            if (avatarUrl) return await imageUrlToBase64(avatarUrl);
        }
        const character = context.characters?.[context.characterId];
        if (character?.avatar) {
            return await imageUrlToBase64(`/characters/${encodeURIComponent(character.avatar)}`);
        }
        return null;
    } catch (error) {
        console.error('[IIG] Error getting character avatar:', error);
        return null;
    }
}

function getCharacterAvatarUrl() {
    try {
        const context = SillyTavern.getContext();
        if (context.characterId === undefined || context.characterId === null) return null;
        if (typeof context.getCharacterAvatar === 'function') {
            const url = context.getCharacterAvatar(context.characterId);
            if (url) return url;
        }
        const character = context.characters?.[context.characterId];
        if (character?.avatar) {
            return `/characters/${encodeURIComponent(character.avatar)}`;
        }
        return null;
    } catch (error) {
        return null;
    }
}

async function getUserAvatarBase64() {
    try {
        const settings = getSettings();
        if (!settings.userAvatarFile) return null;
        return await imageUrlToBase64(`/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`);
    } catch (error) {
        console.error('[IIG] Error getting user avatar:', error);
        return null;
    }
}

function getUserAvatarUrl() {
    const settings = getSettings();
    if (!settings.userAvatarFile) return null;
    return `/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`;
}

function getNpcAvatarBase64(npcId) {
    const settings = getSettings();
    const npc = settings.npcList.find(n => n.id === npcId);
    return npc?.avatarData || null;
}

// ============================================================
// RESIZE IMAGE
// v2.5: Increased default maxSize from 512 to 768 for better ref quality
// ============================================================

async function resizeImageBase64(base64, maxSize = 768) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;
            if (width <= maxSize && height <= maxSize) { resolve(base64); return; }
            const ratio = Math.min(maxSize / width, maxSize / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/png').split(',')[1]);
        };
        img.onerror = () => resolve(base64);
        img.src = `data:image/png;base64,${base64}`;
    });
}

// ============================================================
// GENERIC OUTFIT SYSTEM (wardrobe + hairstyle)
// ============================================================

const OUTFIT_SYSTEMS = {
    wardrobe: {
        itemsKey: 'wardrobeItems', activeCharKey: 'activeWardrobeChar', activeUserKey: 'activeWardrobeUser',
        idPrefix: 'ward_', defaultName: 'Outfit', injectEnabledKey: 'injectWardrobeToChat',
        descPromptKey: 'wardrobeDescPrompt', injectionKey: MODULE_NAME + '_wardrobe',
        wearingVerb: 'is currently wearing',
    },
    hairstyle: {
        itemsKey: 'hairstyleItems', activeCharKey: 'activeHairstyleChar', activeUserKey: 'activeHairstyleUser',
        idPrefix: 'hair_', defaultName: 'Hairstyle', injectEnabledKey: 'injectHairstyleToChat',
        descPromptKey: 'hairstyleDescPrompt', injectionKey: MODULE_NAME + '_hairstyle',
        wearingVerb: "'s current hairstyle:",
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

// Legacy aliases for compatibility in buildEnhancedPrompt / collectReferenceImages
function getActiveWardrobeItem(target) { return getActiveOutfitItem('wardrobe', target); }
function getActiveHairstyleItem(target) { return getActiveOutfitItem('hairstyle', target); }
function updateWardrobeInjection() { updateOutfitInjection('wardrobe'); }
function updateHairstyleInjection() { updateOutfitInjection('hairstyle'); }

// ============================================================
// NAME DETECTION IN PROMPT
// ============================================================

function detectMentionedCharacters(prompt) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const lowerPrompt = prompt.toLowerCase();
    const result = { charMentioned: false, userMentioned: false, npcIds: [] };

    const charName = context.characters?.[context.characterId]?.name;
    if (charName && lowerPrompt.includes(charName.toLowerCase())) result.charMentioned = true;

    const userName = context.name1;
    if (userName && lowerPrompt.includes(userName.toLowerCase())) result.userMentioned = true;

    for (const npc of (settings.npcList || [])) {
        if (!npc.name || npc.enabled === false) continue;
        const names = [npc.name, ...(npc.aliases || [])].filter(Boolean);
        for (const name of names) {
            if (lowerPrompt.includes(name.toLowerCase())) { result.npcIds.push(npc.id); break; }
        }
    }

    iigLog('INFO', `Name detection: char=${result.charMentioned}, user=${result.userMentioned}, npcs=[${result.npcIds.join(',')}]`);
    return result;
}

async function collectReferenceImages(prompt) {
    const settings = getSettings();
    const references = [];

    let mentions = { charMentioned: false, userMentioned: false, npcIds: [] };
    if (settings.autoDetectNames) mentions = detectMentionedCharacters(prompt);

    if (settings.sendCharAvatar || mentions.charMentioned) {
        const charAvatar = await getCharacterAvatarBase64();
        if (charAvatar) {
            // v2.5: resize to 768 for better quality
            const resized = await resizeImageBase64(charAvatar, 768);
            const context = SillyTavern.getContext();
            const charName = context.characters?.[context.characterId]?.name || 'Character';
            references.push({ base64: resized, label: `Reference photo of ${charName} — copy face, eyes, hair color, skin tone, body type EXACTLY`, name: charName });
        }
    }

    if (settings.sendUserAvatar || mentions.userMentioned) {
        const userAvatar = await getUserAvatarBase64();
        if (userAvatar) {
            const resized = await resizeImageBase64(userAvatar, 768);
            const context = SillyTavern.getContext();
            references.push({ base64: resized, label: `Reference photo of ${context.name1 || 'User'} — copy face, eyes, hair color, skin tone, body type EXACTLY`, name: context.name1 || 'User' });
        }
    }

    for (const npcId of mentions.npcIds) {
        const npc = settings.npcList.find(n => n.id === npcId);
        if (!npc?.avatarData || npc.enabled === false) continue;
        const resized = await resizeImageBase64(npc.avatarData, 768);
        references.push({ base64: resized, label: `Reference photo of ${npc.name} — copy appearance EXACTLY`, name: npc.name });
    }

    // Wardrobe clothing references
    const charWardrobeItem = getActiveWardrobeItem('char');
    if (charWardrobeItem?.imageData) {
        const context = SillyTavern.getContext();
        const charName = context.characters?.[context.characterId]?.name || 'Character';
        let label = `Clothing for ${charName}: "${charWardrobeItem.name}". Dress ${charName} in EXACTLY this outfit.`;
        if (charWardrobeItem.description) label += ` Description: ${charWardrobeItem.description}`;
        references.push({ base64: charWardrobeItem.imageData, label, name: `${charName}'s outfit` });
    }
    const userWardrobeItem = getActiveWardrobeItem('user');
    if (userWardrobeItem?.imageData) {
        const context = SillyTavern.getContext();
        const userName = context.name1 || 'User';
        let label = `Clothing for ${userName}: "${userWardrobeItem.name}". Dress ${userName} in EXACTLY this outfit.`;
        if (userWardrobeItem.description) label += ` Description: ${userWardrobeItem.description}`;
        references.push({ base64: userWardrobeItem.imageData, label, name: `${userName}'s outfit` });
    }

    // v2.4: Hairstyle references
    const charHairstyleItem = getActiveHairstyleItem('char');
    if (charHairstyleItem?.imageData) {
        const context = SillyTavern.getContext();
        const charName = context.characters?.[context.characterId]?.name || 'Character';
        let label = `Hairstyle SHAPE for ${charName}: "${charHairstyleItem.name}". Copy hair shape/length/styling ONLY, keep ${charName}'s ORIGINAL hair color.`;
        if (charHairstyleItem.description) label += ` Description: ${charHairstyleItem.description}`;
        references.push({ base64: charHairstyleItem.imageData, label, name: `${charName}'s hairstyle` });
    }
    const userHairstyleItem = getActiveHairstyleItem('user');
    if (userHairstyleItem?.imageData) {
        const context = SillyTavern.getContext();
        const userName = context.name1 || 'User';
        let label = `Hairstyle SHAPE for ${userName}: "${userHairstyleItem.name}". Copy hair shape/length/styling ONLY, keep ${userName}'s ORIGINAL hair color.`;
        if (userHairstyleItem.description) label += ` Description: ${userHairstyleItem.description}`;
        references.push({ base64: userHairstyleItem.imageData, label, name: `${userName}'s hairstyle` });
    }

    iigLog('INFO', `Total reference images: ${references.length}`);
    return references;
}

// ============================================================
// APPEARANCE EXTRACTION
// ============================================================

const APPEARANCE_PATTERNS = [
    /(?:hair|волосы)[:\s]*([^.;,\n]{3,80})/gi, /(?:has|have|with|имеет|с)\s+([a-zA-Zа-яА-Я\s]+(?:hair|волос[ыа]?))/gi,
    /([a-zA-Zа-яА-Я\-]+(?:\s+[a-zA-Zа-яА-Я\-]+)?)\s+hair/gi, /(?:eyes?|глаза?)[:\s]*([^.;,\n]{3,60})/gi,
    /([a-zA-Zа-яА-Я\-]+)\s+eyes?/gi, /(?:skin|кожа)[:\s]*([^.;,\n]{3,60})/gi, /([a-zA-Zа-яА-Я\-]+)\s+skin/gi,
    /(?:height|рост)[:\s]*([^.;,\n]{3,40})/gi, /(?:tall|short|average|высок|низк|средн)[a-zA-Zа-яА-Я]*/gi,
    /(?:build|телосложени)[:\s]*([^.;,\n]{3,40})/gi,
    /(?:muscular|slim|athletic|thin|chubby|мускулист|стройн|худ|полн)[a-zA-Zа-яА-Я]*/gi,
    /(?:looks?|appears?|выгляд)[a-zA-Zа-яА-Я]*\s+(?:like\s+)?(?:a\s+)?(\d+|young|old|teen|adult|молод|стар|подрост|взросл)/gi,
    /(\d+)\s*(?:years?\s*old|лет|года?)/gi, /(?:features?|черты)[:\s]*([^.;,\n]{3,80})/gi,
    /(?:face|лицо)[:\s]*([^.;,\n]{3,60})/gi, /(?:ears?|уши|ушки)[:\s]*([^.;,\n]{3,40})/gi,
    /(?:tail|хвост)[:\s]*([^.;,\n]{3,40})/gi, /(?:horns?|рога?)[:\s]*([^.;,\n]{3,40})/gi,
    /(?:wings?|крыль[яи])[:\s]*([^.;,\n]{3,40})/gi,
];
const APPEARANCE_BLOCK_PATTERNS = [
    /\[?(?:appearance|внешность|looks?)\]?[:\s]*([^[\]]{10,500})/gi,
    /\[?(?:physical\s*description|физическое?\s*описание)\]?[:\s]*([^[\]]{10,500})/gi,
];

function extractAppearanceFromText(text, name, fallbackShort = false) {
    try {
        if (!text) return null;
        const foundTraits = [], seen = new Set();
        for (const p of APPEARANCE_PATTERNS) {
            p.lastIndex = 0;
            for (const m of text.matchAll(p)) {
                const t = (m[1] || m[0]).trim();
                if (t.length > 2 && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); foundTraits.push(t); }
            }
        }
        for (const p of APPEARANCE_BLOCK_PATTERNS) {
            p.lastIndex = 0;
            for (const m of text.matchAll(p)) {
                const b = m[1].trim();
                if (b.length > 10 && !seen.has(b.toLowerCase())) { seen.add(b.toLowerCase()); foundTraits.push(b); }
            }
        }
        if (foundTraits.length === 0) {
            if (fallbackShort && text.length < 500) return `${name}: ${text}`;
            return null;
        }
        return `${name}: ${foundTraits.join(', ')}`;
    } catch (error) {
        iigLog('ERROR', `Error extracting appearance for ${name}:`, error);
        return null;
    }
}

function extractCharacterAppearance() {
    const context = SillyTavern.getContext();
    if (context.characterId == null) return null;
    const character = context.characters?.[context.characterId];
    return character?.description ? extractAppearanceFromText(character.description, character.name || 'Character') : null;
}

function extractUserAppearance() {
    const context = SillyTavern.getContext();
    const persona = (typeof window.power_user !== 'undefined') ? window.power_user.persona_description : null;
    return persona ? extractAppearanceFromText(persona, context.name1 || 'User', true) : null;
}

function getNpcAppearance(npcId) {
    const settings = getSettings();
    const npc = settings.npcList.find(n => n.id === npcId);
    if (!npc?.appearance || npc.enabled === false) return null;
    return `${npc.name}: ${npc.appearance}`;
}

// ============================================================
// CLOTHING DETECTION
// ============================================================

function detectClothingFromChat(depth = 5) {
    try {
        const context = SillyTavern.getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) return null;

        const charName = context.characters?.[context.characterId]?.name || 'Character';
        const userName = context.name1 || 'User';

        const clothingPatterns = [
            /(?:wearing|wears?|dressed\s+in|clothed\s+in|puts?\s+on|changed?\s+into)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:outfit|clothes|clothing|attire|garment|dress|costume)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:shirt|blouse|top|jacket|coat|sweater|hoodie|t-shirt|tank\s*top)[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:pants|jeans|shorts|skirt|trousers|leggings)[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:dress|gown|robe|uniform|suit|armor|armour)[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:a|an|the|his|her|their|my)\s+([\w\s\-]+(?:dress|shirt|jacket|coat|pants|jeans|skirt|blouse|sweater|hoodie|uniform|suit|armor|robe|gown|outfit|costume|clothes))/gi,
            /(?:одет[аоы]?|носит|оделс?я?|переодел[аи]?сь?)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:одежда|наряд|костюм|форма)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:рубашк|блузк|куртк|пальто|свитер|худи|футболк|майк)[а-яА-Я]*[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:брюк|джинс|шорт|юбк|штан|леггинс)[а-яА-Я]*[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:платье|халат|мантия|униформа|доспех)[а-яА-Я]*[:\s]*([^.;!?\n]{3,100})/gi,
        ];

        const foundClothing = [];
        const seen = new Set();
        const startIndex = Math.max(0, chat.length - depth);

        for (let i = chat.length - 1; i >= startIndex; i--) {
            const message = chat[i];
            if (!message.mes) continue;
            const speaker = message.is_user ? userName : charName;
            for (const pattern of clothingPatterns) {
                pattern.lastIndex = 0;
                for (const match of message.mes.matchAll(pattern)) {
                    const clothing = (match[1] || match[0]).trim();
                    if (clothing.length > 3 && !seen.has(clothing.toLowerCase())) {
                        seen.add(clothing.toLowerCase());
                        foundClothing.push({ text: clothing, speaker });
                    }
                }
            }
        }

        if (foundClothing.length === 0) return null;

        const charClothing = foundClothing.filter(c => c.speaker === charName).map(c => c.text);
        const userClothing = foundClothing.filter(c => c.speaker === userName).map(c => c.text);

        let clothingText = '';
        if (charClothing.length > 0) clothingText += `${charName} wears: ${charClothing.slice(0, 3).join(', ')}. `;
        if (userClothing.length > 0) clothingText += `${userName} wears: ${userClothing.slice(0, 3).join(', ')}.`;
        return clothingText.trim() || null;
    } catch (error) {
        iigLog('ERROR', 'Error detecting clothing:', error);
        return null;
    }
}

// ============================================================
// ENHANCED PROMPT BUILDER
// v2.5: Complete rewrite — style is king, prompt is clean
// ============================================================

function buildEnhancedPrompt(basePrompt, style, options = {}) {
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[MODULE_NAME] || {};
    const promptParts = [];

    // Determine active style: fixed (priority) or from tag
    const useFixedStyle = settings.fixedStyleEnabled === true && settings.fixedStyle?.trim();
    const activeStyle = useFixedStyle ? settings.fixedStyle.trim() : (style || '');

    // ===== BLOCK 1: REFERENCE IMAGES — HIGHEST PRIORITY FOR LIKENESS =====
    // v2.5: References go FIRST so the model sees them before anything else

    if (options._referenceLabels?.length > 0) {
        const labelsText = options._referenceLabels.map((ref, i) =>
            `Image ${i + 1}: ${ref.label}`
        ).join('; ');
        promptParts.push(`[REFERENCE IMAGES — HIGHEST PRIORITY: ${labelsText}. You MUST copy their EXACT appearance: face structure, eye color, hair color, skin tone, body type, and all distinctive features. Character likeness from these references is NON-NEGOTIABLE.]`);
    }

    // ===== BLOCK 2: STYLE — MANDATORY FOR RENDERING =====
    // v2.5: Style comes right after refs — "draw THESE characters in THIS style"

    if (activeStyle) {
        const ignoreNote = useFixedStyle
            ? ` The scene description below may contain OTHER style keywords (e.g. "Craig Mullins", "painterly", "photorealistic", "masterpiece", "8k") — COMPLETELY IGNORE THEM. "${activeStyle}" is the ONLY style.`
            : '';
        promptParts.push(`[MANDATORY ART STYLE — APPLIES TO THE ENTIRE IMAGE: Render everything in "${activeStyle}" style. Every element — characters, backgrounds, lighting, colors, linework, shading — MUST follow this style. Do NOT use photorealistic/realistic rendering unless the style explicitly says so. Keep character likeness from references above, but draw them in "${activeStyle}" style.${ignoreNote}]`);
    }

    // ===== BLOCK 3: APPEARANCE — brief, only key traits =====

    if (settings.extractAppearance === true) {
        const charAppearance = extractCharacterAppearance();
        if (charAppearance) promptParts.push(`[${charAppearance}]`);
    }

    if (settings.extractUserAppearance !== false) {
        const userAppearance = extractUserAppearance();
        if (userAppearance) promptParts.push(`[${userAppearance}]`);
    }

    if (settings.autoDetectNames && settings.npcList?.length > 0) {
        const mentions = detectMentionedCharacters(basePrompt);
        for (const npcId of mentions.npcIds) {
            const npcAppearance = getNpcAppearance(npcId);
            if (npcAppearance) promptParts.push(`[${npcAppearance}]`);
        }
    }

    // Wardrobe override (brief)
    const charWardrobeItem = getActiveWardrobeItem('char');
    if (charWardrobeItem) {
        const charName = context.characters?.[context.characterId]?.name || 'Character';
        let w = `[${charName} MUST wear: "${charWardrobeItem.name}"`;
        if (charWardrobeItem.description) w += ` — ${charWardrobeItem.description}`;
        w += ']';
        promptParts.push(w);
    }
    const userWardrobeItem = getActiveWardrobeItem('user');
    if (userWardrobeItem) {
        const userName = context.name1 || 'User';
        let w = `[${userName} MUST wear: "${userWardrobeItem.name}"`;
        if (userWardrobeItem.description) w += ` — ${userWardrobeItem.description}`;
        w += ']';
        promptParts.push(w);
    }

    // Clothing from chat (only if no wardrobe override)
    if (settings.detectClothing === true) {
        const clothing = detectClothingFromChat(settings.clothingSearchDepth || 5);
        if (clothing) promptParts.push(`[${clothing}]`);
    }

    // Hairstyle override (brief)
    const charHairstyleItem = getActiveHairstyleItem('char');
    if (charHairstyleItem) {
        const charName = context.characters?.[context.characterId]?.name || 'Character';
        let h = `[${charName} hairstyle shape: "${charHairstyleItem.name}" — keep original hair COLOR`;
        if (charHairstyleItem.description) h += `, shape: ${charHairstyleItem.description}`;
        h += ']';
        promptParts.push(h);
    }
    const userHairstyleItem = getActiveHairstyleItem('user');
    if (userHairstyleItem) {
        const userName = context.name1 || 'User';
        let h = `[${userName} hairstyle shape: "${userHairstyleItem.name}" — keep original hair COLOR`;
        if (userHairstyleItem.description) h += `, shape: ${userHairstyleItem.description}`;
        h += ']';
        promptParts.push(h);
    }

    // ===== BLOCK 4: SCENE PROMPT =====
    // v2.5: When fixedStyle is active, clean basePrompt from embedded style/quality/negative boilerplate

    let cleanedPrompt = basePrompt;

    if (useFixedStyle) {
        // v2.5: Strip the tag's style field content directly from prompt (LLMs often duplicate style into DESC)
        if (style && style.length > 5) {
            // Escape regex special chars and replace both spaces and underscores
            const escaped = style.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[_ ]+/g, '[_ ]+');
            try { cleanedPrompt = cleanedPrompt.replace(new RegExp(escaped + '[,_\\s]*', 'gi'), ''); } catch (_) {}
        }
        // Strip common quality boilerplate that LLMs embed (masterpiece, 8k, best quality, etc.)
        cleanedPrompt = cleanedPrompt
            .replace(/\b(masterpiece|best[_ ]quality|worst[_ ]quality|low[_ ]quality|lowres|8k|4k)\b[,_\s]*/gi, '')
            // Strip negative prompt blocks entirely
            .replace(/\b(NEGATIVE[_ ]PROMPT|AVOID)[:\s_]*[^.]*/gi, '')
            // Strip style keywords that conflict with fixed style (common patterns from system prompts)
            .replace(/\b(Craig[_ ]Mullins[_ ]style|loose[_ ]painterly[_ ]brushwork|atmospheric[_ ]perspective|cinematic[_ ]dramatic[_ ]lighting|muted[_ ]earth[_ ]tones[_ ]with[_ ]color[_ ]accents|concept[_ ]art[_ ]quality|environmental[_ ]storytelling|Perfect[_ ]perspective|perfect[_ ]proportions)\b[,_\s]*/gi, '')
            // Strip any remaining "X style" pattern that looks like art style (e.g. "anime style", "watercolor style")
            .replace(/\b[\w\-]+[_ ]style\b[,_\s]*/gi, '')
            // Clean up leftover commas, underscores, whitespace
            .replace(/[,_]{2,}/g, ', ')
            .replace(/^[\s,_]+|[\s,_]+$/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();

        if (cleanedPrompt !== basePrompt) {
            iigLog('INFO', `Cleaned embedded style from prompt (${basePrompt.length} -> ${cleanedPrompt.length} chars)`);
        }

        promptParts.push(`[SCENE DESCRIPTION — IGNORE any style, quality, or negative keywords below. Use ONLY the mandatory art style specified above:]`);
    }

    promptParts.push(cleanedPrompt);

    // ===== BLOCK 5: STYLE REMINDER AT THE END =====

    if (activeStyle) {
        if (useFixedStyle) {
            promptParts.push(`[FINAL STYLE OVERRIDE: DISREGARD any art style mentioned anywhere in the scene description. The ONLY art style for this image is "${activeStyle}". Ignore all other style keywords.]`);
        } else {
            promptParts.push(`[STYLE ENFORCEMENT: The ENTIRE image must be rendered in "${activeStyle}" style. Do NOT fall back to photorealism or any other default style.]`);
        }
    }

    const fullPrompt = promptParts.join('\n\n');
    iigLog('INFO', `Built enhanced prompt (${fullPrompt.length} chars, ${promptParts.length} parts, style=${activeStyle ? `"${activeStyle}"` : 'none'})`);
    return fullPrompt;
}

// ============================================================
// IMAGE GENERATION APIs
// ============================================================

async function generateImageOpenAI(prompt, style, references = [], options = {}) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;
    const fullPrompt = buildEnhancedPrompt(prompt, style, options);

    let size = settings.size;
    if (options.aspectRatio) {
        if (options.aspectRatio === '16:9') size = '1792x1024';
        else if (options.aspectRatio === '9:16') size = '1024x1792';
        else if (options.aspectRatio === '1:1') size = '1024x1024';
    }

    const body = {
        model: settings.model,
        prompt: fullPrompt,
        n: 1,
        size,
        quality: options.quality || settings.quality,
        response_format: 'b64_json'
    };

    // v2.4: Send ALL references
    if (references.length === 1) {
        body.image = `data:image/png;base64,${references[0].base64}`;
    } else if (references.length > 1) {
        body.image = references.map(ref => `data:image/png;base64,${ref.base64}`);
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.signal,
    });

    if (!response.ok) throw new Error(`API Error (${response.status}): ${await response.text()}`);

    const result = await response.json();
    const dataList = result.data || [];
    if (dataList.length === 0) {
        if (result.url) return result.url;
        throw new Error('No image data in response');
    }
    const imageObj = dataList[0];
    if (imageObj.b64_json) return `data:image/png;base64,${imageObj.b64_json}`;
    return imageObj.url;
}

const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

async function generateImageGemini(prompt, style, references = [], options = {}) {
    const settings = getSettings();
    const model = settings.model;
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;

    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) aspectRatio = '1:1';
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) imageSize = '1K';

    const parts = [];
    for (const ref of references.slice(0, 4)) {
        parts.push({ inlineData: { mimeType: 'image/png', data: ref.base64 } });
        parts.push({ text: `[${ref.label}]` });
    }

    const fullPrompt = buildEnhancedPrompt(prompt, style, { ...options, _referenceLabels: references });
    parts.push({ text: fullPrompt });

    // Determine active style for system instruction
    const useFixedStyle = settings.fixedStyleEnabled === true && settings.fixedStyle?.trim();
    const activeStyle = useFixedStyle ? settings.fixedStyle.trim() : (style || '');

    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio, imageSize } }
    };

    // v2.5: Much stronger system instruction for style enforcement
    if (activeStyle) {
        const ignoreEmbedded = useFixedStyle
            ? ` IMPORTANT: The user prompt may contain OTHER style keywords (e.g. "Craig Mullins", "painterly", "photorealistic", quality tags like "masterpiece", "8k") — IGNORE ALL OF THEM. Use ONLY "${activeStyle}" as the art style.`
            : '';
        body.systemInstruction = {
            parts: [{ text: `You are an image generation assistant. You have TWO non-negotiable rules:
1. CHARACTER LIKENESS (highest priority): If reference images are provided, you MUST copy the EXACT appearance of each character — face structure, eye color, hair color, skin tone, body type, distinctive features. Never deviate from the reference likeness.
2. ART STYLE (mandatory rendering): ALL images MUST be rendered in this exact art style: "${activeStyle}". Every aspect — linework, shading, coloring, backgrounds, lighting, proportions — must follow "${activeStyle}". Do NOT default to photorealism or any other style unless "${activeStyle}" explicitly requires it.${ignoreEmbedded}
In short: draw the characters from the references, but render everything in "${activeStyle}" style.` }]
        };
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.signal,
    });

    if (!response.ok) throw new Error(`API Error (${response.status}): ${await response.text()}`);

    const result = await response.json();
    const candidates = result.candidates || [];
    if (candidates.length === 0) throw new Error('No candidates in response');

    for (const part of (candidates[0].content?.parts || [])) {
        if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        if (part.inline_data) return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
    }
    throw new Error('No image found in Gemini response');
}

// ============================================================
// GENERATION WITH RETRY
// ============================================================

function validateSettings() {
    const settings = getSettings();
    const errors = [];
    if (!settings.endpoint) errors.push('URL эндпоинта не настроен');
    if (!settings.apiKey) errors.push('API ключ не настроен');
    if (!settings.model) errors.push('Модель не выбрана');
    if (errors.length > 0) throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
}

async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();
    const settings = getSettings();

    let references = options.references;
    if (!references) {
        onStatusUpdate?.('Сбор референсов...');
        references = await collectReferenceImages(prompt);
    }

    const timeoutMs = (settings.requestTimeout || 120) * 1000;
    const externalSignal = options.signal;

    let lastError;
    for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
        const onExternalAbort = () => timeoutController.abort();
        externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

        try {
            if (externalSignal?.aborted) throw new DOMException('Отменено пользователем', 'AbortError');

            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${settings.maxRetries})` : ''}...`);
            const genOptions = { ...options, signal: timeoutController.signal, references };

            let result;
            if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
                result = await generateImageGemini(prompt, style, references, genOptions);
            } else {
                result = await generateImageOpenAI(prompt, style, references, genOptions);
            }
            return result;
        } catch (error) {
            lastError = error;
            if (error.name === 'AbortError') {
                if (externalSignal?.aborted) {
                    lastError = new Error('Отменено пользователем');
                } else {
                    lastError = new Error(`Таймаут: сервер не ответил за ${settings.requestTimeout}с`);
                }
                break;
            }
            const isRetryable = /429|503|502|504|timeout|network/i.test(error.message);
            if (!isRetryable || attempt === settings.maxRetries) break;
            const delay = settings.retryDelay * Math.pow(2, attempt);
            onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        } finally {
            clearTimeout(timeoutId);
            externalSignal?.removeEventListener('abort', onExternalAbort);
        }
    }
    throw lastError;
}

// ============================================================
// TAG PARSING
// ============================================================

async function checkFileExists(path) {
    try { return (await fetch(path, { method: 'HEAD' })).ok; } catch (e) { return false; }
}

const ERROR_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/error.svg';

async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];

    // NEW FORMAT
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
            const c = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (c === '\\' && inString) { escapeNext = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (!inString) {
                if (c === '{') braceCount++;
                else if (c === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
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
        else if (hasPath && checkExistence) { if (!(await checkFileExists(srcValue))) needsGeneration = true; }
        else if (hasPath) { searchPos = imgEnd; continue; }

        if (!needsGeneration) { searchPos = imgEnd; continue; }

        try {
            let nj = instructionJson.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
            const data = JSON.parse(nj);
            tags.push({
                fullMatch: fullImgTag, index: imgStart,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: true, existingSrc: hasPath ? srcValue : null
            });
        } catch (e) { iigLog('WARN', `Failed to parse instruction JSON`, e.message); }
        searchPos = imgEnd;
    }

    // LEGACY FORMAT
    const marker = '[IMG:GEN:';
    let searchStart = 0;
    while (true) {
        const markerIndex = text.indexOf(marker, searchStart);
        if (markerIndex === -1) break;
        const jsonStart = markerIndex + marker.length;
        let braceCount = 0, jsonEnd = -1, inString = false, escapeNext = false;
        for (let i = jsonStart; i < text.length; i++) {
            const c = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (c === '\\' && inString) { escapeNext = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (!inString) {
                if (c === '{') braceCount++;
                else if (c === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
            }
        }
        if (jsonEnd === -1) { searchStart = jsonStart; continue; }
        if (!text.substring(jsonEnd).startsWith(']')) { searchStart = jsonEnd; continue; }
        const tagOnly = text.substring(markerIndex, jsonEnd + 1);
        const jsonStr = text.substring(jsonStart, jsonEnd);
        try {
            let data;
            try {
                data = JSON.parse(jsonStr);
            } catch (_) {
                const fixed = jsonStr.replace(/'/g, '"');
                try {
                    data = JSON.parse(fixed);
                } catch (__) {
                    const relaxed = jsonStr
                        .replace(/^\s*\{\s*/, '{')
                        .replace(/\s*\}\s*$/, '}')
                        .replace(/(\w+)\s*:/g, '"$1":')
                        .replace(/:\s*'([^']*)'/g, ':"$1"');
                    data = JSON.parse(relaxed);
                }
            }
            tags.push({
                fullMatch: tagOnly, index: markerIndex,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: false
            });
        } catch (e) { iigLog('WARN', `Failed to parse legacy tag`, e.message); }
        searchStart = jsonEnd + 1;
    }
    return tags;
}

// ============================================================
// DOM HELPERS
// ============================================================

function createLoadingPlaceholder(tagId, onCancel) {
    const el = document.createElement('div');
    el.className = 'iig-loading-placeholder';
    el.dataset.tagId = tagId;
    el.style.cssText = 'position: relative; min-height: 80px;';
    el.innerHTML = `<div class="iig-spinner"></div><div class="iig-status">Генерация картинки...</div>`;
    if (onCancel) {
        const x = document.createElement('div');
        x.className = 'iig-cancel-x';
        x.title = 'Отменить генерацию';
        x.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        x.style.cssText = 'position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0.5; border-radius: 50%; background: var(--SmartThemeBotMesBlurTintColor, rgba(0,0,0,0.4)); color: var(--SmartThemeBodyColor, #fff); font-size: 12px; z-index: 1;';
        x.addEventListener('mouseenter', () => { x.style.opacity = '1'; });
        x.addEventListener('mouseleave', () => { x.style.opacity = '0.5'; });
        x.addEventListener('click', (e) => {
            e.stopPropagation();
            onCancel();
            x.style.pointerEvents = 'none';
            x.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            const statusEl = el.querySelector('.iig-status');
            if (statusEl) statusEl.textContent = 'Отмена...';
        });
        el.appendChild(x);
    }
    return el;
}

function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = 'Ошибка генерации';
    img.title = `Ошибка: ${errorMessage}`;
    img.dataset.tagId = tagId;
    if (tagInfo.fullMatch) {
        const m = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (m) img.setAttribute('data-iig-instruction', m[2]);
    }
    return img;
}

// ============================================================
// MESSAGE PROCESSING
// ============================================================

function wrapImageWithRegen(img, messageId, tagIndex) {
    const wrapper = document.createElement('div');
    wrapper.className = 'iig-image-wrapper';
    wrapper.style.cssText = 'position: relative; display: inline-block;';

    const regenBtn = document.createElement('div');
    regenBtn.className = 'iig-single-regen';
    regenBtn.title = 'Перегенерировать эту картинку';
    regenBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i>';
    // v2.5: Always visible (semi-transparent), brighter on hover
    regenBtn.style.cssText = 'position: absolute; top: 6px; right: 6px; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; cursor: pointer; border-radius: 50%; background: var(--SmartThemeBotMesBlurTintColor, rgba(0,0,0,0.5)); color: var(--SmartThemeBodyColor, #fff); font-size: 13px; z-index: 1; opacity: 0.5; transition: opacity 0.15s, transform 0.15s;';
    regenBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await regenerateSingleImage(messageId, tagIndex);
    });

    wrapper.addEventListener('mouseenter', () => { regenBtn.style.opacity = '1'; regenBtn.style.transform = 'scale(1.1)'; });
    wrapper.addEventListener('mouseleave', () => { regenBtn.style.opacity = '0.5'; regenBtn.style.transform = 'scale(1)'; });

    wrapper.appendChild(regenBtn);
    wrapper.appendChild(img);
    return wrapper;
}

// v2.5: Re-wraps existing generated images after messageFormatting destroys DOM wrappers
function wrapExistingImages(mesTextEl, messageId) {
    if (!mesTextEl) return;
    // Find all generated/instruction images that are NOT already wrapped
    const images = mesTextEl.querySelectorAll('img.iig-generated-image, img[data-iig-instruction]');
    let tagIndex = 0;
    for (const img of images) {
        // Skip if already inside a wrapper
        if (img.closest('.iig-image-wrapper')) { tagIndex++; continue; }
        // Skip error images and placeholder srcs
        const src = img.getAttribute('src') || '';
        if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') { tagIndex++; continue; }
        // Only wrap images with actual file paths (already generated)
        if (src.startsWith('/') || src.startsWith('data:')) {
            const wrapped = wrapImageWithRegen(img, messageId, tagIndex);
            img.replaceWith(wrapped);
        }
        tagIndex++;
    }
}

async function regenerateSingleImage(messageId, tagIndex) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Сообщение не найдено'); return; }

    const tags = await parseImageTags(message.mes, { forceAll: true });
    if (!tags[tagIndex]) { toastr.error('Тег не найден'); return; }
    const tag = tags[tagIndex];

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) return;

    const allWrappers = Array.from(mesTextEl.querySelectorAll('.iig-image-wrapper'));
    const allImgs = Array.from(mesTextEl.querySelectorAll('img.iig-generated-image, img.iig-error-image, img[data-iig-instruction]'));
    const targetEl = allWrappers[tagIndex] || allImgs[tagIndex];
    if (!targetEl) { toastr.error('Картинка не найдена в DOM'); return; }

    const abortController = new AbortController();
    const lp = createLoadingPlaceholder(`iig-single-${messageId}-${tagIndex}`, () => abortController.abort());
    targetEl.replaceWith(lp);
    const statusEl = lp.querySelector('.iig-status');

    let references;
    try { references = await collectReferenceImages(tag.prompt); } catch (_) { references = []; }

    try {
        const dataUrl = await generateImageWithRetry(tag.prompt, tag.style, (s) => { if (statusEl) statusEl.textContent = s; }, {
            aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality,
            references, signal: abortController.signal,
        });
        if (statusEl) statusEl.textContent = 'Сохранение...';
        const imagePath = await saveImageToFile(dataUrl);

        const img = document.createElement('img');
        img.className = 'iig-generated-image'; img.src = imagePath; img.alt = tag.prompt;
        const instrMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instrMatch) img.setAttribute('data-iig-instruction', instrMatch[2]);

        const wrapped = wrapImageWithRegen(img, messageId, tagIndex);
        lp.replaceWith(wrapped);

        message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`));
        await context.saveChat();
        toastr.success('Картинка перегенерирована', 'Генерация картинок', { timeOut: 2000 });
    } catch (error) {
        iigLog('ERROR', `Single regen failed: ${error.message}`);
        lp.replaceWith(createErrorPlaceholder(`iig-single-${messageId}-${tagIndex}`, error.message, tag));
        if (abortController.signal.aborted) toastr.warning('Генерация отменена');
        else toastr.error(`Ошибка: ${error.message}`);
    }
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

    const abortController = new AbortController();
    activeAbortControllers.set(messageId, abortController);

    let sharedReferences;
    try {
        sharedReferences = await collectReferenceImages(tags[0].prompt);
    } catch (e) {
        sharedReferences = [];
        iigLog('WARN', 'Failed to collect references:', e.message);
    }

    // Prepare placeholders for legacy tags via DOM-safe method
    for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        if (!tag.isNewFormat) {
            const walker = document.createTreeWalker(mesTextEl, NodeFilter.SHOW_TEXT, null);
            let textNode;
            while ((textNode = walker.nextNode())) {
                const pos = textNode.textContent.indexOf(tag.fullMatch);
                if (pos !== -1) {
                    const beforeText = textNode.textContent.substring(0, pos);
                    const afterText = textNode.textContent.substring(pos + tag.fullMatch.length);
                    const placeholder = document.createElement('span');
                    placeholder.dataset.iigPlaceholder = `iig-${messageId}-${i}`;
                    const parent = textNode.parentNode;
                    if (beforeText) parent.insertBefore(document.createTextNode(beforeText), textNode);
                    parent.insertBefore(placeholder, textNode);
                    if (afterText) parent.insertBefore(document.createTextNode(afterText), textNode);
                    parent.removeChild(textNode);
                    tag._placeholderEl = placeholder;
                    break;
                }
            }
        }
    }

    // Sequential generation
    for (let index = 0; index < tags.length; index++) {
        if (abortController.signal.aborted) break;

        const tag = tags[index];
        const tagId = `iig-${messageId}-${index}`;

        const loadingPlaceholder = createLoadingPlaceholder(tagId, () => {
            abortController.abort();
        });

        let targetElement = null;

        if (tag.isNewFormat) {
            const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            const searchPrompt = tag.prompt.substring(0, 30);
            for (const img of allImgs) {
                const instr = img.getAttribute('data-iig-instruction');
                if (instr) {
                    const decoded = instr.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
                    if (decoded.includes(searchPrompt)) { targetElement = img; break; }
                    try { const d = JSON.parse(decoded); if (d.prompt?.substring(0, 30) === tag.prompt.substring(0, 30)) { targetElement = img; break; } } catch (_) {
                        try { const d = JSON.parse(decoded.replace(/'/g, '"')); if (d.prompt?.substring(0, 30) === tag.prompt.substring(0, 30)) { targetElement = img; break; } } catch (e) {}
                    }
                    if (instr.includes(searchPrompt)) { targetElement = img; break; }
                }
            }
            if (!targetElement) {
                for (const img of allImgs) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') { targetElement = img; break; }
                }
            }
            if (!targetElement) {
                for (const img of mesTextEl.querySelectorAll('img')) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) { targetElement = img; break; }
                }
            }
        } else {
            targetElement = tag._placeholderEl || null;
        }

        if (targetElement) targetElement.replaceWith(loadingPlaceholder);
        else mesTextEl.appendChild(loadingPlaceholder);

        const statusEl = loadingPlaceholder.querySelector('.iig-status');
        try {
            const dataUrl = await generateImageWithRetry(tag.prompt, tag.style, (s) => { if (statusEl) statusEl.textContent = s; }, {
                aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality,
                references: sharedReferences,
                signal: abortController.signal,
            });
            if (statusEl) statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);
            const img = document.createElement('img');
            img.className = 'iig-generated-image'; img.src = imagePath; img.alt = tag.prompt;
            if (tag.isNewFormat) { const m = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i); if (m) img.setAttribute('data-iig-instruction', m[2]); }
            const wrapped = wrapImageWithRegen(img, messageId, index);
            loadingPlaceholder.replaceWith(wrapped);
            if (tag.isNewFormat) { message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`)); }
            else { message.mes = message.mes.replace(tag.fullMatch, `[IMG:✓:${imagePath}]`); }
            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Failed: ${error.message}`);
            loadingPlaceholder.replaceWith(createErrorPlaceholder(tagId, error.message, tag));
            if (tag.isNewFormat) { message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${ERROR_IMAGE_PATH}"`)); }
            else { message.mes = message.mes.replace(tag.fullMatch, `[IMG:ERROR:${error.message.substring(0, 50)}]`); }
            if (abortController.signal.aborted) {
                toastr.warning('Генерация отменена', 'Генерация картинок');
                break;
            }
            toastr.error(`Ошибка генерации: ${error.message}`, 'Генерация картинок');
        }
    }

    processingMessages.delete(messageId);
    activeAbortControllers.delete(messageId);
    await context.saveChat();
    if (typeof context.messageFormatting === 'function') {
        mesTextEl.innerHTML = context.messageFormatting(message.mes, message.name, message.is_system, message.is_user, messageId);
    }
    // v2.5: Re-wrap images with regen buttons after messageFormatting destroys DOM
    wrapExistingImages(mesTextEl, messageId);
}

async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Сообщение не найдено'); return; }
    const tags = await parseImageTags(message.mes, { forceAll: true });
    if (tags.length === 0) { toastr.warning('Нет тегов для перегенерации'); return; }

    processingMessages.add(messageId);
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) { processingMessages.delete(messageId); return; }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }

    const abortController = new AbortController();
    activeAbortControllers.set(messageId, abortController);

    let sharedReferences;
    try {
        sharedReferences = await collectReferenceImages(tags[0].prompt);
    } catch (e) {
        sharedReferences = [];
    }

    const allWrappers = Array.from(mesTextEl.querySelectorAll('.iig-image-wrapper'));
    const allBareImgs = Array.from(mesTextEl.querySelectorAll('img[data-iig-instruction], img.iig-generated-image, img.iig-error-image'));
    const targetPool = allWrappers.length >= tags.length ? allWrappers :
        allWrappers.length > 0 ? allWrappers : allBareImgs;

    for (let index = 0; index < tags.length; index++) {
        if (abortController.signal.aborted) break;

        const tag = tags[index];
        const targetEl = targetPool[index] || null;

        if (!targetEl) {
            iigLog('WARN', `No matching element for tag ${index}, skipping regen`);
            continue;
        }

        const innerImg = targetEl.querySelector?.('img[data-iig-instruction]') || targetEl;

        try {
            const instruction = innerImg.getAttribute?.('data-iig-instruction');
            const lp = createLoadingPlaceholder(`iig-regen-${messageId}-${index}`, () => {
                abortController.abort();
            });
            targetEl.replaceWith(lp);
            const statusEl = lp.querySelector('.iig-status');
            const dataUrl = await generateImageWithRetry(tag.prompt, tag.style, (s) => { if (statusEl) statusEl.textContent = s; }, {
                aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality,
                references: sharedReferences,
                signal: abortController.signal,
            });
            if (statusEl) statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);
            const img = document.createElement('img');
            img.className = 'iig-generated-image'; img.src = imagePath; img.alt = tag.prompt;
            if (instruction) img.setAttribute('data-iig-instruction', instruction);
            const wrapped = wrapImageWithRegen(img, messageId, index);
            lp.replaceWith(wrapped);
            message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`));
            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Regen failed for tag ${index}: ${error.message}`);
            if (abortController.signal.aborted) {
                toastr.warning('Перегенерация отменена', 'Генерация картинок');
                break;
            }
            toastr.error(`Ошибка: ${error.message}`);
        }
    }
    processingMessages.delete(messageId);
    activeAbortControllers.delete(messageId);
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
        if (msg && !msg.is_user) {
            addRegenerateButton(el, mid);
            // v2.5: Wrap existing generated images with per-image regen buttons
            const mesTextEl = el.querySelector('.mes_text');
            if (mesTextEl) wrapExistingImages(mesTextEl, mid);
        }
    }
}

async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const el = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!el) return;
    addRegenerateButton(el, messageId);
    await processMessageTags(messageId);
    // v2.5: Wrap any generated images that survived formatting (or loaded from history)
    const mesTextEl = el.querySelector('.mes_text');
    if (mesTextEl) wrapExistingImages(mesTextEl, messageId);
}

// ============================================================
// NPC MANAGEMENT
// ============================================================

function generateNpcId() {
    return 'npc_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

function addNpc() {
    const settings = getSettings();
    const npc = { id: generateNpcId(), name: '', aliases: [], avatarData: null, appearance: '', enabled: true };
    settings.npcList.push(npc);
    saveSettings();
    return npc;
}

function removeNpc(npcId) {
    const settings = getSettings();
    settings.npcList = settings.npcList.filter(n => n.id !== npcId);
    saveSettings();
}

function updateNpc(npcId, updates) {
    const settings = getSettings();
    const npc = settings.npcList.find(n => n.id === npcId);
    if (npc) { Object.assign(npc, updates); saveSettings(); }
}

function toggleNpc(npcId) {
    const settings = getSettings();
    const npc = settings.npcList.find(n => n.id === npcId);
    if (npc) {
        npc.enabled = npc.enabled === false ? true : false;
        saveSettings();
    }
    return npc;
}

// ============================================================
// COLLAPSIBLE SECTION HELPER
// ============================================================

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

function createCollapsibleSection(id, icon, title, contentHtml) {
    const collapsed = isSectionCollapsed(id);
    return `
        <div class="iig-section" data-section-id="${id}">
            <div class="iig-section-header" data-section-toggle="${id}">
                <span class="iig-section-icon">${icon}</span>
                <span class="iig-section-title">${title}</span>
                <i class="fa-solid fa-chevron-down iig-section-chevron ${collapsed ? 'iig-collapsed' : ''}"></i>
            </div>
            <div class="iig-section-body ${collapsed ? 'iig-section-hidden' : ''}">
                ${contentHtml}
            </div>
        </div>
    `;
}

// ============================================================
// AVATAR PREVIEW UPDATES
// ============================================================

function updateCharAvatarPreview() {
    const previewEl = document.getElementById('iig_char_avatar_preview');
    if (!previewEl) return;
    const avatarUrl = getCharacterAvatarUrl();
    if (avatarUrl) {
        previewEl.innerHTML = `<img src="${avatarUrl}" class="iig-avatar-preview-img" alt="Аватар персонажа">`;
    } else {
        previewEl.innerHTML = `<div class="iig-avatar-preview-empty"><i class="fa-solid fa-user"></i><span>Нет аватара</span></div>`;
    }
}

function updateUserAvatarPreview() {
    const previewEl = document.getElementById('iig_user_avatar_preview');
    if (!previewEl) return;
    const avatarUrl = getUserAvatarUrl();
    if (avatarUrl) {
        previewEl.innerHTML = `<img src="${avatarUrl}" class="iig-avatar-preview-img" alt="Аватар юзера">`;
    } else {
        previewEl.innerHTML = `<div class="iig-avatar-preview-empty"><i class="fa-solid fa-user"></i><span>Не выбран</span></div>`;
    }
}

// ============================================================
// GENERIC OUTFIT UI (wardrobe + hairstyle grids & panels)
// ============================================================

const OUTFIT_UI = {
    wardrobe: { prefix: 'iig_wardrobe', icon: 'fa-shirt', emptyText: 'Нет одежды. Нажмите + чтобы добавить.', deleteMsg: 'Одежда удалена',
        placeholder: 'Введите описание одежды вручную или сгенерируйте через AI...', saveMsg: 'Описание сохранено', clearMsg: 'Описание очищено', genMsg: 'Описание сгенерировано через AI' },
    hairstyle: { prefix: 'iig_hairstyle', icon: 'fa-scissors', emptyText: 'Нет причёсок. Нажмите + чтобы добавить.', deleteMsg: 'Причёска удалена',
        placeholder: 'Введите описание причёски вручную или сгенерируйте через AI...', saveMsg: 'Описание причёски сохранено', clearMsg: 'Описание причёски очищено', genMsg: 'Описание причёски сгенерировано через AI' },
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
            <img src="data:image/png;base64,${item.imageData}" class="iig-wardrobe-img" alt="${item.name}">
            <div class="iig-wardrobe-card-overlay">
                <span class="iig-wardrobe-card-name" title="${item.name}">${item.name}</span>
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
        <div class="iig-wardrobe-desc-header"><i class="fa-solid ${ui.icon}"></i><span>Описание: <b>${activeItem.name}</b></span></div>
        <textarea class="text_pole iig-wardrobe-desc-textarea" rows="3" placeholder="${ui.placeholder}" data-outfit-id="${activeItem.id}">${activeItem.description || ''}</textarea>
        <div class="iig-wardrobe-desc-actions">
            <div class="menu_button iig-outfit-desc-generate" data-outfit-id="${activeItem.id}" title="Сгенерировать через Vision AI"><i class="fa-solid fa-robot"></i> Сгенерировать</div>
            <div class="menu_button iig-outfit-desc-save" data-outfit-id="${activeItem.id}"><i class="fa-solid fa-floppy-disk"></i> Сохранить</div>
            <div class="menu_button iig-outfit-desc-clear" data-outfit-id="${activeItem.id}"><i class="fa-solid fa-eraser"></i></div>
        </div>
        <div class="iig-wardrobe-desc-status" id="${ui.prefix}_desc_status_${target}" style="display:none;"></div>
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
        const statusEl = document.getElementById(`${ui.prefix}_desc_status_${target}`);
        btn.classList.add('disabled'); btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Генерация...';
        if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Отправка картинки vision-модели...'; }
        try {
            const desc = await generateOutfitDescription(sys, itemId);
            textarea.value = desc; updateOutfitItemDescription(sys, itemId, desc);
            if (statusEl) { statusEl.textContent = 'Описание сгенерировано!'; statusEl.className = 'iig-wardrobe-desc-status iig-desc-success'; }
            toastr.success(ui.genMsg); renderOutfitGrid(sys, target);
        } catch (error) {
            iigLog('ERROR', `Failed to generate ${sys} description:`, error);
            if (statusEl) { statusEl.textContent = `Ошибка: ${error.message}`; statusEl.className = 'iig-wardrobe-desc-status iig-desc-error'; }
            toastr.error(`Ошибка: ${error.message}`);
        } finally {
            btn.classList.remove('disabled'); btn.innerHTML = '<i class="fa-solid fa-robot"></i> Сгенерировать';
            setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 5000);
        }
    });
}

// Legacy aliases
function renderWardrobeGrid(target) { renderOutfitGrid('wardrobe', target); }
function renderHairstyleGrid(target) { renderOutfitGrid('hairstyle', target); }

// ============================================================
// SETTINGS UI
// v2.5: Removed positive/negative prompts section
// ============================================================

function renderNpcList() {
    const settings = getSettings();
    const container = document.getElementById('iig_npc_list');
    if (!container) return;
    container.innerHTML = '';

    for (const npc of settings.npcList) {
        const isEnabled = npc.enabled !== false;
        const npcEl = document.createElement('div');
        npcEl.className = `iig-npc-item ${!isEnabled ? 'iig-npc-disabled' : ''}`;
        npcEl.dataset.npcId = npc.id;

        const avatarPreview = npc.avatarData
            ? `<img src="data:image/png;base64,${npc.avatarData}" class="iig-npc-avatar-preview" alt="NPC avatar">`
            : `<div class="iig-npc-avatar-preview iig-npc-no-avatar"><i class="fa-solid fa-user-plus"></i></div>`;

        npcEl.innerHTML = `
            <div class="iig-npc-header">
                <div class="iig-npc-avatar-container">
                    ${avatarPreview}
                    <input type="file" class="iig-npc-avatar-input" accept="image/*" style="display:none;">
                    <div class="iig-npc-avatar-upload-btn menu_button" title="Загрузить аватар"><i class="fa-solid fa-upload"></i></div>
                </div>
                <div class="iig-npc-fields">
                    <input type="text" class="text_pole iig-npc-name" placeholder="Имя NPC" value="${npc.name || ''}">
                    <input type="text" class="text_pole iig-npc-aliases" placeholder="Алиасы (через запятую)" value="${(npc.aliases || []).join(', ')}">
                </div>
                <div class="iig-npc-btn-group">
                    <div class="iig-npc-toggle menu_button ${isEnabled ? 'iig-npc-on' : 'iig-npc-off'}" title="${isEnabled ? 'Выключить NPC' : 'Включить NPC'}">
                        <i class="fa-solid ${isEnabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                    </div>
                    <div class="iig-npc-remove menu_button" title="Удалить NPC"><i class="fa-solid fa-trash"></i></div>
                </div>
            </div>
            <textarea class="text_pole iig-npc-appearance" rows="2" placeholder="Описание внешности (опционально)">${npc.appearance || ''}</textarea>
        `;

        npcEl.querySelector('.iig-npc-name').addEventListener('input', (e) => updateNpc(npc.id, { name: e.target.value }));
        npcEl.querySelector('.iig-npc-aliases').addEventListener('input', (e) => {
            updateNpc(npc.id, { aliases: e.target.value.split(',').map(a => a.trim()).filter(Boolean) });
        });
        npcEl.querySelector('.iig-npc-appearance').addEventListener('input', (e) => updateNpc(npc.id, { appearance: e.target.value }));

        npcEl.querySelector('.iig-npc-toggle').addEventListener('click', () => {
            toggleNpc(npc.id);
            renderNpcList();
        });

        const uploadBtn = npcEl.querySelector('.iig-npc-avatar-upload-btn');
        const fileInput = npcEl.querySelector('.iig-npc-avatar-input');
        uploadBtn.addEventListener('click', () => fileInput.click());
        npcEl.querySelector('.iig-npc-avatar-container').addEventListener('click', (e) => {
            if (!e.target.closest('.iig-npc-avatar-upload-btn')) fileInput.click();
        });
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onloadend = async () => {
                const resized = await resizeImageBase64(reader.result.split(',')[1], 768);
                updateNpc(npc.id, { avatarData: resized });
                renderNpcList();
                toastr.success(`Аватар загружен для ${npc.name || 'NPC'}`, 'Генерация картинок');
            };
            reader.readAsDataURL(file);
        });

        npcEl.querySelector('.iig-npc-remove').addEventListener('click', () => {
            removeNpc(npc.id);
            renderNpcList();
            toastr.info('NPC удалён');
        });

        container.appendChild(npcEl);
    }
}

function createSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) return;

    // Build section contents
    const apiSectionContent = `
        <div class="flex-row">
            <label for="iig_api_type">Тип API</label>
            <select id="iig_api_type" class="flex1">
                <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый</option>
                <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini-совместимый (nano-banana)</option>
            </select>
        </div>
        <div class="flex-row">
            <label for="iig_endpoint">URL эндпоинта</label>
            <input type="text" id="iig_endpoint" class="text_pole flex1" value="${settings.endpoint}" placeholder="https://api.example.com">
        </div>
        <div class="flex-row">
            <label for="iig_api_key">API ключ</label>
            <input type="password" id="iig_api_key" class="text_pole flex1" value="${settings.apiKey}">
            <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть"><i class="fa-solid fa-eye"></i></div>
        </div>
        <div class="flex-row">
            <label for="iig_model">Модель</label>
            <select id="iig_model" class="flex1">
                ${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">-- Выберите --</option>'}
            </select>
            <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить"><i class="fa-solid fa-sync"></i></div>
        </div>
    `;

    const genParamsSectionContent = `
        <div class="flex-row">
            <label for="iig_size">Размер (OpenAI)</label>
            <select id="iig_size" class="flex1">
                <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024x1024</option>
                <option value="1792x1024" ${settings.size === '1792x1024' ? 'selected' : ''}>1792x1024</option>
                <option value="1024x1792" ${settings.size === '1024x1792' ? 'selected' : ''}>1024x1792</option>
                <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>512x512</option>
            </select>
        </div>
        <div class="flex-row">
            <label for="iig_quality">Качество</label>
            <select id="iig_quality" class="flex1">
                <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>Стандартное</option>
                <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>HD</option>
            </select>
        </div>
        <div class="flex-row">
            <label for="iig_aspect_ratio">Соотношение сторон</label>
            <select id="iig_aspect_ratio" class="flex1">
                ${VALID_ASPECT_RATIOS.map(r => `<option value="${r}" ${settings.aspectRatio === r ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
        </div>
        <div class="flex-row">
            <label for="iig_image_size">Разрешение</label>
            <select id="iig_image_size" class="flex1">
                ${VALID_IMAGE_SIZES.map(s => `<option value="${s}" ${settings.imageSize === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
        </div>
    `;

    const referencesSectionContent = `
        <label class="checkbox_label">
            <input type="checkbox" id="iig_auto_detect_names" ${settings.autoDetectNames ? 'checked' : ''}>
            <span>Автоопределение имён в промпте</span>
        </label>
        <p class="hint">Если имя персонажа/юзера/NPC упомянуто — аватарка автоматически добавится как референс.</p>

        <label class="checkbox_label">
            <input type="checkbox" id="iig_send_char_avatar" ${settings.sendCharAvatar ? 'checked' : ''}>
            <span>Всегда отправлять аватар персонажа</span>
        </label>
        <div id="iig_char_avatar_preview" class="iig-avatar-preview-container">
            <div class="iig-avatar-preview-empty"><i class="fa-solid fa-user"></i><span>Нет аватара</span></div>
        </div>

        <label class="checkbox_label">
            <input type="checkbox" id="iig_send_user_avatar" ${settings.sendUserAvatar ? 'checked' : ''}>
            <span>Всегда отправлять аватар юзера</span>
        </label>
        <div id="iig_user_avatar_row" class="flex-row ${!settings.sendUserAvatar ? 'hidden' : ''}" style="margin-top: 5px; align-items: center;">
            <label for="iig_user_avatar_file">Аватар юзера</label>
            <select id="iig_user_avatar_file" class="flex1">
                <option value="">-- Не выбран --</option>
                ${settings.userAvatarFile ? `<option value="${settings.userAvatarFile}" selected>${settings.userAvatarFile}</option>` : ''}
            </select>
            <div id="iig_refresh_avatars" class="menu_button iig-refresh-btn" title="Обновить"><i class="fa-solid fa-sync"></i></div>
        </div>
        <div id="iig_user_avatar_preview" class="iig-avatar-preview-container ${!settings.sendUserAvatar ? 'hidden' : ''}">
            <div class="iig-avatar-preview-empty"><i class="fa-solid fa-user"></i><span>Не выбран</span></div>
        </div>
    `;

    const wardrobeSectionContent = `
        <p class="hint">Загрузите картинки с одеждой. Выбранная одежда будет отправлена как референс — модель оденет персонажа в неё. Добавьте текстовое описание (вручную или через AI), чтобы текстовая модель тоже знала об одежде.</p>

        <label class="checkbox_label">
            <input type="checkbox" id="iig_inject_wardrobe" ${settings.injectWardrobeToChat ? 'checked' : ''}>
            <span>Инжектить описание одежды в промпт текстовой модели</span>
        </label>
        <div class="flex-row" style="margin-top: 5px;">
            <label for="iig_wardrobe_injection_depth">Глубина инжекта</label>
            <input type="number" id="iig_wardrobe_injection_depth" class="text_pole flex1" value="${settings.wardrobeInjectionDepth || 1}" min="0" max="10">
        </div>

        <h5 style="margin: 10px 0 4px;">Одежда персонажа</h5>
        <div id="iig_wardrobe_char" class="iig-wardrobe-grid"></div>
        <div class="iig-wardrobe-add-row">
            <input type="text" id="iig_wardrobe_char_name" class="text_pole flex1" placeholder="Название наряда">
            <input type="file" id="iig_wardrobe_char_file" accept="image/*" style="display:none;">
            <div id="iig_wardrobe_char_add" class="menu_button" title="Добавить одежду"><i class="fa-solid fa-plus"></i> Добавить</div>
        </div>

        <h5 style="margin: 14px 0 4px;">Одежда юзера</h5>
        <div id="iig_wardrobe_user" class="iig-wardrobe-grid"></div>
        <div class="iig-wardrobe-add-row">
            <input type="text" id="iig_wardrobe_user_name" class="text_pole flex1" placeholder="Название наряда">
            <input type="file" id="iig_wardrobe_user_file" accept="image/*" style="display:none;">
            <div id="iig_wardrobe_user_add" class="menu_button" title="Добавить одежду"><i class="fa-solid fa-plus"></i> Добавить</div>
        </div>
    `;

    const wardrobeDescApiSectionContent = `
        <p class="hint">Настройте текстовую/vision модель для автоматической генерации описаний одежды по картинке. Если эндпоинт и ключ не указаны, будут использованы основные настройки API (из секции "Настройки API").</p>

        <div class="flex-row">
            <label for="iig_wardrobe_desc_endpoint">Эндпоинт (Vision API)</label>
            <input type="text" id="iig_wardrobe_desc_endpoint" class="text_pole flex1" value="${settings.wardrobeDescEndpoint || ''}" placeholder="https://api.example.com (пусто = основной)">
        </div>
        <div class="flex-row">
            <label for="iig_wardrobe_desc_api_key">API ключ</label>
            <input type="password" id="iig_wardrobe_desc_api_key" class="text_pole flex1" value="${settings.wardrobeDescApiKey || ''}">
            <div id="iig_desc_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть"><i class="fa-solid fa-eye"></i></div>
        </div>
        <div class="flex-row">
            <label for="iig_wardrobe_desc_model">Модель</label>
            <select id="iig_wardrobe_desc_model" class="flex1">
                ${settings.wardrobeDescModel ? `<option value="${settings.wardrobeDescModel}" selected>${settings.wardrobeDescModel}</option>` : '<option value="">-- Выберите --</option>'}
            </select>
            <div id="iig_refresh_desc_models" class="menu_button iig-refresh-btn" title="Обновить список моделей"><i class="fa-solid fa-sync"></i></div>
        </div>
        <div class="flex-col" style="margin-top: 8px;">
            <label for="iig_wardrobe_desc_prompt">Промпт для генерации описания</label>
            <textarea id="iig_wardrobe_desc_prompt" class="text_pole" rows="3" placeholder="Describe this clothing outfit...">${settings.wardrobeDescPrompt || defaultSettings.wardrobeDescPrompt}</textarea>
        </div>
    `;

    const hairstyleSectionContent = `
        <p class="hint">Загрузите картинки с причёсками. Выбранная причёска будет отправлена как референс — модель нарисует персонажа с ней. Описание (вручную или через AI) инжектится в текстовую модель.</p>

        <label class="checkbox_label">
            <input type="checkbox" id="iig_inject_hairstyle" ${settings.injectHairstyleToChat ? 'checked' : ''}>
            <span>Инжектить описание причёски в промпт текстовой модели</span>
        </label>

        <div class="flex-col" style="margin-top: 8px;">
            <label for="iig_hairstyle_desc_prompt">Промпт для генерации описания причёски</label>
            <textarea id="iig_hairstyle_desc_prompt" class="text_pole" rows="2" placeholder="Describe this hairstyle...">${settings.hairstyleDescPrompt || defaultSettings.hairstyleDescPrompt}</textarea>
        </div>

        <h5 style="margin: 10px 0 4px;">Причёска персонажа</h5>
        <div id="iig_hairstyle_char" class="iig-wardrobe-grid"></div>
        <div class="iig-wardrobe-add-row">
            <input type="text" id="iig_hairstyle_char_name" class="text_pole flex1" placeholder="Название причёски">
            <input type="file" id="iig_hairstyle_char_file" accept="image/*" style="display:none;">
            <div id="iig_hairstyle_char_add" class="menu_button" title="Добавить причёску"><i class="fa-solid fa-plus"></i> Добавить</div>
        </div>
        <h5 style="margin: 14px 0 4px;">Причёска юзера</h5>
        <div id="iig_hairstyle_user" class="iig-wardrobe-grid"></div>
        <div class="iig-wardrobe-add-row">
            <input type="text" id="iig_hairstyle_user_name" class="text_pole flex1" placeholder="Название причёски">
            <input type="file" id="iig_hairstyle_user_file" accept="image/*" style="display:none;">
            <div id="iig_hairstyle_user_add" class="menu_button" title="Добавить причёску"><i class="fa-solid fa-plus"></i> Добавить</div>
        </div>
    `;

    const npcSectionContent = `
        <p class="hint">Добавьте NPC с аватарками. При упоминании имени в промпте аватарка будет использована как референс.</p>
        <div id="iig_npc_list"></div>
        <div id="iig_add_npc" class="menu_button" style="width: 100%; margin-top: 8px;">
            <i class="fa-solid fa-plus"></i> Добавить NPC
        </div>
    `;

    // v2.5: Style section is now more prominent with better description
    const styleSectionContent = `
        <p class="hint">Фиксированный стиль имеет НАИВЫСШИЙ приоритет и применяется ко всем генерациям. Перезаписывает стиль из тега. Примеры: "manhwa style", "anime cel shading", "watercolor illustration", "oil painting".</p>
        <label class="checkbox_label">
            <input type="checkbox" id="iig_fixed_style_enabled" ${settings.fixedStyleEnabled ? 'checked' : ''}>
            <span>Включить фиксированный стиль</span>
        </label>
        <div class="flex-col" style="margin-top: 5px;">
            <label for="iig_fixed_style">Стиль</label>
            <textarea id="iig_fixed_style" class="text_pole" rows="2" placeholder="manhwa style, clean lineart, vibrant colors, dynamic shading...">${settings.fixedStyle || ''}</textarea>
        </div>
    `;

    const extractionSectionContent = `
        <label class="checkbox_label">
            <input type="checkbox" id="iig_extract_appearance" ${settings.extractAppearance ? 'checked' : ''}>
            <span>Из карточки персонажа</span>
        </label>
        <label class="checkbox_label">
            <input type="checkbox" id="iig_extract_user_appearance" ${settings.extractUserAppearance !== false ? 'checked' : ''}>
            <span>Из персоны юзера</span>
        </label>
        <label class="checkbox_label">
            <input type="checkbox" id="iig_detect_clothing" ${settings.detectClothing ? 'checked' : ''}>
            <span>Определять одежду из чата</span>
        </label>
        <div class="flex-row" style="margin-top: 5px;">
            <label for="iig_clothing_depth">Глубина поиска</label>
            <input type="number" id="iig_clothing_depth" class="text_pole flex1" value="${settings.clothingSearchDepth || 5}" min="1" max="20">
        </div>
    `;

    const errorSectionContent = `
        <div class="flex-row">
            <label for="iig_max_retries">Макс. повторов</label>
            <input type="number" id="iig_max_retries" class="text_pole flex1" value="${settings.maxRetries}" min="0" max="5">
        </div>
        <div class="flex-row">
            <label for="iig_retry_delay">Задержка (мс)</label>
            <input type="number" id="iig_retry_delay" class="text_pole flex1" value="${settings.retryDelay}" min="500" max="10000" step="500">
        </div>
        <div class="flex-row">
            <label for="iig_request_timeout">Таймаут запроса (сек)</label>
            <input type="number" id="iig_request_timeout" class="text_pole flex1" value="${settings.requestTimeout || 120}" min="10" max="600" step="10">
        </div>
        <p class="hint">Если сервер не ответил за указанное время — запрос отменяется. Кнопка отмены доступна на каждой генерируемой картинке.</p>
    `;

    const debugSectionContent = `
        <div class="flex-row">
            <div id="iig_export_logs" class="menu_button" style="width: 100%;"><i class="fa-solid fa-download"></i> Экспорт логов</div>
        </div>
    `;

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Генерация картинок</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить генерацию картинок</span>
                    </label>

                    ${createCollapsibleSection('api', '🔌', 'Настройки API', apiSectionContent)}
                    ${createCollapsibleSection('gen_params', '⚙️', 'Параметры генерации', genParamsSectionContent)}
                    ${createCollapsibleSection('fixed_style', '🎨', 'Фиксированный стиль (приоритет №1)', styleSectionContent)}
                    ${createCollapsibleSection('references', '🖼️', 'Референсы аватарок', referencesSectionContent)}
                    ${createCollapsibleSection('wardrobe', '👗', 'Гардероб (одежда)', wardrobeSectionContent)}
                    ${createCollapsibleSection('wardrobe_desc_api', '🤖', 'Описание одежды (Vision API)', wardrobeDescApiSectionContent)}
                    ${createCollapsibleSection('hairstyles', '💇', 'Причёски', hairstyleSectionContent)}
                    ${createCollapsibleSection('npcs', '🎭', 'NPC / Доп. персонажи', npcSectionContent)}
                    ${createCollapsibleSection('extraction', '👤', 'Извлечение внешности и одежды', extractionSectionContent)}
                    ${createCollapsibleSection('errors', '🔄', 'Обработка ошибок', errorSectionContent)}
                    ${createCollapsibleSection('debug', '🐛', 'Отладка', debugSectionContent)}
                </div>
            </div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', html);

    // Bind collapsible toggles
    document.querySelectorAll('[data-section-toggle]').forEach(header => {
        header.addEventListener('click', () => {
            const sectionId = header.dataset.sectionToggle;
            toggleSectionCollapsed(sectionId);
            const section = header.closest('.iig-section');
            const body = section.querySelector('.iig-section-body');
            const chevron = section.querySelector('.iig-section-chevron');
            body.classList.toggle('iig-section-hidden');
            chevron.classList.toggle('iig-collapsed');
        });
    });

    bindSettingsEvents();
    renderNpcList();
    renderWardrobeGrid('char');
    renderWardrobeGrid('user');
    renderHairstyleGrid('char');
    renderHairstyleGrid('user');
    updateCharAvatarPreview();
    updateUserAvatarPreview();
}

function bindSettingsEvents() {
    const settings = getSettings();

    document.getElementById('iig_enabled')?.addEventListener('change', (e) => { settings.enabled = e.target.checked; saveSettings(); });

    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value; saveSettings();
    });

    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => { settings.endpoint = e.target.value; saveSettings(); });
    document.getElementById('iig_api_key')?.addEventListener('input', (e) => { settings.apiKey = e.target.value; saveSettings(); });

    document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_api_key');
        const icon = document.querySelector('#iig_key_toggle i');
        if (input.type === 'password') { input.type = 'text'; icon.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { input.type = 'password'; icon.classList.replace('fa-eye-slash', 'fa-eye'); }
    });

    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        settings.model = e.target.value; saveSettings();
        if (isGeminiModel(e.target.value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
        }
    });

    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            select.innerHTML = '<option value="">-- Выберите --</option>';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m; opt.selected = m === settings.model;
                select.appendChild(opt);
            }
            toastr.success(`Найдено моделей: ${models.length}`);
        } catch (err) { toastr.error('Ошибка загрузки моделей'); }
        finally { btn.classList.remove('loading'); }
    });

    document.getElementById('iig_size')?.addEventListener('change', (e) => { settings.size = e.target.value; saveSettings(); });
    document.getElementById('iig_quality')?.addEventListener('change', (e) => { settings.quality = e.target.value; saveSettings(); });
    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => { settings.aspectRatio = e.target.value; saveSettings(); });
    document.getElementById('iig_image_size')?.addEventListener('change', (e) => { settings.imageSize = e.target.value; saveSettings(); });
    document.getElementById('iig_auto_detect_names')?.addEventListener('change', (e) => { settings.autoDetectNames = e.target.checked; saveSettings(); });

    document.getElementById('iig_send_char_avatar')?.addEventListener('change', (e) => {
        settings.sendCharAvatar = e.target.checked; saveSettings();
    });

    document.getElementById('iig_send_user_avatar')?.addEventListener('change', (e) => {
        settings.sendUserAvatar = e.target.checked; saveSettings();
        document.getElementById('iig_user_avatar_row')?.classList.toggle('hidden', !e.target.checked);
        document.getElementById('iig_user_avatar_preview')?.classList.toggle('hidden', !e.target.checked);
        if (e.target.checked) updateUserAvatarPreview();
    });

    document.getElementById('iig_user_avatar_file')?.addEventListener('change', (e) => {
        settings.userAvatarFile = e.target.value;
        saveSettings();
        updateUserAvatarPreview();
    });

    document.getElementById('iig_refresh_avatars')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const avatars = await fetchUserAvatars();
            const select = document.getElementById('iig_user_avatar_file');
            select.innerHTML = '<option value="">-- Не выбран --</option>';
            for (const a of avatars) {
                const opt = document.createElement('option');
                opt.value = a; opt.textContent = a; opt.selected = a === settings.userAvatarFile;
                select.appendChild(opt);
            }
            toastr.success(`Найдено аватаров: ${avatars.length}`);
            updateUserAvatarPreview();
        } catch (err) { toastr.error('Ошибка загрузки аватаров'); }
        finally { btn.classList.remove('loading'); }
    });

    document.getElementById('iig_add_npc')?.addEventListener('click', () => { addNpc(); renderNpcList(); toastr.info('NPC добавлен'); });

    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => { settings.maxRetries = parseInt(e.target.value) || 0; saveSettings(); });
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => { settings.retryDelay = parseInt(e.target.value) || 1000; saveSettings(); });
    document.getElementById('iig_request_timeout')?.addEventListener('input', (e) => { settings.requestTimeout = parseInt(e.target.value) || 120; saveSettings(); });
    document.getElementById('iig_export_logs')?.addEventListener('click', exportLogs);

    // v2.5: Style settings (moved up, textarea instead of input)
    document.getElementById('iig_fixed_style_enabled')?.addEventListener('change', (e) => { settings.fixedStyleEnabled = e.target.checked; saveSettings(); });
    document.getElementById('iig_fixed_style')?.addEventListener('input', (e) => { settings.fixedStyle = e.target.value; saveSettings(); });

    document.getElementById('iig_extract_appearance')?.addEventListener('change', (e) => { settings.extractAppearance = e.target.checked; saveSettings(); });
    document.getElementById('iig_extract_user_appearance')?.addEventListener('change', (e) => { settings.extractUserAppearance = e.target.checked; saveSettings(); });
    document.getElementById('iig_detect_clothing')?.addEventListener('change', (e) => { settings.detectClothing = e.target.checked; saveSettings(); });
    document.getElementById('iig_clothing_depth')?.addEventListener('input', (e) => { settings.clothingSearchDepth = parseInt(e.target.value) || 5; saveSettings(); });

    // Wardrobe injection settings
    document.getElementById('iig_inject_wardrobe')?.addEventListener('change', (e) => {
        settings.injectWardrobeToChat = e.target.checked;
        saveSettings();
        updateWardrobeInjection();
    });

    document.getElementById('iig_wardrobe_injection_depth')?.addEventListener('input', (e) => {
        settings.wardrobeInjectionDepth = parseInt(e.target.value) || 1;
        saveSettings();
        updateWardrobeInjection();
    });

    // Wardrobe description API settings
    document.getElementById('iig_wardrobe_desc_endpoint')?.addEventListener('input', (e) => {
        settings.wardrobeDescEndpoint = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_wardrobe_desc_api_key')?.addEventListener('input', (e) => {
        settings.wardrobeDescApiKey = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_desc_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_wardrobe_desc_api_key');
        const icon = document.querySelector('#iig_desc_key_toggle i');
        if (input.type === 'password') { input.type = 'text'; icon.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { input.type = 'password'; icon.classList.replace('fa-eye-slash', 'fa-eye'); }
    });

    document.getElementById('iig_wardrobe_desc_model')?.addEventListener('change', (e) => {
        settings.wardrobeDescModel = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_refresh_desc_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const models = await fetchDescriptionModels();
            const select = document.getElementById('iig_wardrobe_desc_model');
            select.innerHTML = '<option value="">-- Выберите --</option>';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m; opt.selected = m === settings.wardrobeDescModel;
                select.appendChild(opt);
            }
            toastr.success(`Найдено текстовых моделей: ${models.length}`);
        } catch (err) { toastr.error('Ошибка загрузки моделей'); }
        finally { btn.classList.remove('loading'); }
    });

    document.getElementById('iig_wardrobe_desc_prompt')?.addEventListener('input', (e) => {
        settings.wardrobeDescPrompt = e.target.value;
        saveSettings();
    });

    // Generic outfit add buttons (wardrobe + hairstyle)
    const bindOutfitAdd = (sys, target) => {
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
                const resized = await resizeImageBase64(reader.result.split(',')[1], 768);
                const name = nameInput?.value?.trim() || file.name.replace(/\.[^.]+$/, '') || cfg.defaultName;
                addOutfitItem(sys, name, resized, target);
                if (nameInput) nameInput.value = '';
                fileInput.value = '';
                renderOutfitGrid(sys, target);
                toastr.success(`${cfg.defaultName} "${name}" добавлен(а)`);
            };
            reader.readAsDataURL(file);
        });
    };
    for (const sys of ['wardrobe', 'hairstyle']) { bindOutfitAdd(sys, 'char'); bindOutfitAdd(sys, 'user'); }

    // Hairstyle events
    document.getElementById('iig_inject_hairstyle')?.addEventListener('change', (e) => {
        settings.injectHairstyleToChat = e.target.checked;
        saveSettings();
        updateHairstyleInjection();
    });

    document.getElementById('iig_hairstyle_desc_prompt')?.addEventListener('input', (e) => {
        settings.hairstyleDescPrompt = e.target.value;
        saveSettings();
    });
}

// ============================================================
// STANDALONE IMAGE GENERATION (single art button)
// v2.5: Generate a single image via modal dialog
// ============================================================

let standaloneAbortController = null;

function createStandaloneModal() {
    // Remove existing modal if any
    document.getElementById('iig_standalone_modal')?.remove();

    const settings = getSettings();
    const useFixedStyle = settings.fixedStyleEnabled && settings.fixedStyle?.trim();

    const modal = document.createElement('div');
    modal.id = 'iig_standalone_modal';
    modal.className = 'iig-modal-overlay';
    modal.innerHTML = `
        <div class="iig-modal">
            <div class="iig-modal-header">
                <span><i class="fa-solid fa-palette"></i> Генерация арта</span>
                <div class="iig-modal-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="iig-modal-body">
                <div class="iig-modal-field">
                    <label for="iig_standalone_prompt">Промпт</label>
                    <textarea id="iig_standalone_prompt" class="text_pole" rows="4" placeholder="Опишите что нарисовать..."></textarea>
                </div>
                <div class="iig-modal-field">
                    <label for="iig_standalone_style">Стиль ${useFixedStyle ? '<span class="iig-modal-hint">(перезаписан фикс стилем)</span>' : ''}</label>
                    <input type="text" id="iig_standalone_style" class="text_pole" value="${useFixedStyle ? settings.fixedStyle : ''}" placeholder="manhwa style, anime, watercolor..." ${useFixedStyle ? 'disabled' : ''}>
                </div>
                <div class="iig-modal-row">
                    <div class="iig-modal-field iig-modal-half">
                        <label for="iig_standalone_ratio">Соотношение</label>
                        <select id="iig_standalone_ratio" class="text_pole">
                            ${VALID_ASPECT_RATIOS.map(r => `<option value="${r}" ${r === (settings.aspectRatio || '1:1') ? 'selected' : ''}>${r}</option>`).join('')}
                        </select>
                    </div>
                    <div class="iig-modal-field iig-modal-half">
                        <label for="iig_standalone_size">Разрешение</label>
                        <select id="iig_standalone_size" class="text_pole">
                            ${VALID_IMAGE_SIZES.map(s => `<option value="${s}" ${s === (settings.imageSize || '1K') ? 'selected' : ''}>${s}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <label class="checkbox_label" style="margin-top:4px;">
                    <input type="checkbox" id="iig_standalone_refs" checked>
                    <span>Отправить референсы (аватарки)</span>
                </label>
                <div id="iig_standalone_result" class="iig-modal-result" style="display:none;"></div>
                <div id="iig_standalone_status" class="iig-modal-status" style="display:none;"></div>
            </div>
            <div class="iig-modal-footer">
                <div id="iig_standalone_generate" class="menu_button"><i class="fa-solid fa-wand-magic-sparkles"></i> Сгенерировать</div>
                <div id="iig_standalone_cancel" class="menu_button" style="display:none;"><i class="fa-solid fa-stop"></i> Отмена</div>
                <div id="iig_standalone_insert" class="menu_button" style="display:none;"><i class="fa-solid fa-paper-plane"></i> Вставить в чат</div>
                <div id="iig_standalone_save" class="menu_button" style="display:none;"><i class="fa-solid fa-floppy-disk"></i> Сохранить</div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Close modal
    const closeModal = () => {
        if (standaloneAbortController) { standaloneAbortController.abort(); standaloneAbortController = null; }
        modal.remove();
    };
    modal.querySelector('.iig-modal-close').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    // Generate
    modal.querySelector('#iig_standalone_generate').addEventListener('click', () => standaloneGenerate(modal));

    // Cancel
    modal.querySelector('#iig_standalone_cancel').addEventListener('click', () => {
        if (standaloneAbortController) { standaloneAbortController.abort(); standaloneAbortController = null; }
    });

    // Ctrl+Enter to generate
    modal.querySelector('#iig_standalone_prompt').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            standaloneGenerate(modal);
        }
    });

    // Focus prompt
    setTimeout(() => modal.querySelector('#iig_standalone_prompt')?.focus(), 100);
}

async function standaloneGenerate(modal) {
    const prompt = modal.querySelector('#iig_standalone_prompt')?.value?.trim();
    if (!prompt) { toastr.warning('Введите промпт'); return; }

    const style = modal.querySelector('#iig_standalone_style')?.value?.trim() || '';
    const aspectRatio = modal.querySelector('#iig_standalone_ratio')?.value || '1:1';
    const imageSize = modal.querySelector('#iig_standalone_size')?.value || '1K';
    const sendRefs = modal.querySelector('#iig_standalone_refs')?.checked !== false;

    const genBtn = modal.querySelector('#iig_standalone_generate');
    const cancelBtn = modal.querySelector('#iig_standalone_cancel');
    const insertBtn = modal.querySelector('#iig_standalone_insert');
    const saveBtn = modal.querySelector('#iig_standalone_save');
    const resultEl = modal.querySelector('#iig_standalone_result');
    const statusEl = modal.querySelector('#iig_standalone_status');

    genBtn.style.display = 'none';
    cancelBtn.style.display = '';
    insertBtn.style.display = 'none';
    saveBtn.style.display = 'none';
    resultEl.style.display = 'none';
    statusEl.style.display = 'block';
    statusEl.textContent = 'Подготовка...';
    statusEl.className = 'iig-modal-status';

    standaloneAbortController = new AbortController();

    let references = [];
    if (sendRefs) {
        try {
            statusEl.textContent = 'Сбор референсов...';
            references = await collectReferenceImages(prompt);
        } catch (_) { references = []; }
    }

    try {
        validateSettings();
        const dataUrl = await generateImageWithRetry(prompt, style, (s) => { statusEl.textContent = s; }, {
            aspectRatio, imageSize, references, signal: standaloneAbortController.signal,
        });

        statusEl.textContent = 'Сохранение...';
        const imagePath = await saveImageToFile(dataUrl);

        // Show result
        resultEl.style.display = 'block';
        resultEl.innerHTML = `<img src="${imagePath}" class="iig-modal-result-img" alt="${prompt}">`;
        statusEl.style.display = 'none';
        cancelBtn.style.display = 'none';
        genBtn.style.display = '';
        genBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Ещё раз';
        insertBtn.style.display = '';
        saveBtn.style.display = '';

        // Store path for insert
        resultEl.dataset.imagePath = imagePath;
        resultEl.dataset.prompt = prompt;

        // Insert into chat
        insertBtn.onclick = async () => {
            try {
                const context = SillyTavern.getContext();
                const chat = context.chat;
                if (!chat || chat.length === 0) { toastr.warning('Нет активного чата'); return; }
                // Find last bot message
                let targetMsgId = -1;
                for (let i = chat.length - 1; i >= 0; i--) {
                    if (!chat[i].is_user) { targetMsgId = i; break; }
                }
                if (targetMsgId === -1) { toastr.warning('Нет сообщений бота для вставки'); return; }
                const msg = chat[targetMsgId];
                const imgTag = `\n\n![${prompt.substring(0, 50)}](${imagePath})`;
                msg.mes += imgTag;
                await context.saveChat();
                // Re-render message
                const mesEl = document.querySelector(`#chat .mes[mesid="${targetMsgId}"] .mes_text`);
                if (mesEl && typeof context.messageFormatting === 'function') {
                    mesEl.innerHTML = context.messageFormatting(msg.mes, msg.name, msg.is_system, msg.is_user, targetMsgId);
                }
                toastr.success('Картинка вставлена в чат');
                modal.remove();
            } catch (error) {
                toastr.error(`Ошибка вставки: ${error.message}`);
            }
        };

        // Save (download) button
        saveBtn.onclick = () => {
            const a = document.createElement('a');
            a.href = imagePath;
            a.download = `iig_standalone_${Date.now()}.png`;
            a.click();
            toastr.success('Картинка скачана');
        };

        toastr.success('Арт готов!', 'Генерация картинок', { timeOut: 2000 });
    } catch (error) {
        iigLog('ERROR', `Standalone generation failed: ${error.message}`);
        statusEl.textContent = `Ошибка: ${error.message}`;
        statusEl.className = 'iig-modal-status iig-modal-status-error';
        cancelBtn.style.display = 'none';
        genBtn.style.display = '';
        genBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Сгенерировать';
        if (standaloneAbortController?.signal?.aborted) {
            statusEl.textContent = 'Генерация отменена';
        } else {
            toastr.error(`Ошибка: ${error.message}`);
        }
    } finally {
        standaloneAbortController = null;
    }
}

function addStandaloneButton() {
    if (document.getElementById('iig_standalone_btn')) return;
    const sendForm = document.getElementById('leftSendForm') || document.getElementById('send_form');
    if (!sendForm) return;

    const btn = document.createElement('div');
    btn.id = 'iig_standalone_btn';
    btn.className = 'iig-standalone-btn interactable';
    btn.title = 'Сгенерировать арт';
    btn.tabIndex = 0;
    btn.innerHTML = '<i class="fa-solid fa-palette"></i>';
    btn.addEventListener('click', () => createStandaloneModal());

    // Insert into send form area
    const sendBut = document.getElementById('send_but') || sendForm.querySelector('.fa-paper-plane')?.closest('div');
    if (sendBut) {
        sendBut.parentNode.insertBefore(btn, sendBut);
    } else {
        sendForm.appendChild(btn);
    }
}

// ============================================================
// INIT
// ============================================================

(function init() {
    const context = SillyTavern.getContext();
    getSettings();

    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        addButtonsToExistingMessages();
        addStandaloneButton();
        updateWardrobeInjection();
        updateHairstyleInjection();
        console.log('[IIG] Inline Image Generation v2.5 loaded');
    });

    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            addButtonsToExistingMessages();
            updateCharAvatarPreview();
            updateWardrobeInjection();
            updateHairstyleInjection();
        }, 100);
    });

    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
        await onMessageReceived(messageId);
    });

    console.log('[IIG] Inline Image Generation v2.5 initialized');
})();
