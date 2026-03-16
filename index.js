/**
 * ════════════════════════════════════════════════════════════════════
 * Inline Image Generation + Wardrobe
 * Based on: notsosillynotsoimages by aceeenvw
 *           + wardrobe system from sillyimages
 *
 * Module 1 — SillyWardrobe IIFE  (outfit data, modal UI, public API)
 * Module 2 — Inline Image Gen    (generation engine + wardrobe refs)
 * ════════════════════════════════════════════════════════════════════
 */

/* ╔═══════════════════════════════════════════════════════════════╗
   ║  MODULE 1 — SillyWardrobe                                    ║
   ╚═══════════════════════════════════════════════════════════════╝ */

(function initWardrobe() {
    'use strict';

    const SW_MODULE = 'silly_wardrobe';

    /* ── helpers ── */

    function uid() {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    }

    function swLog(level, ...args) {
        const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
        fn('[SW]', ...args);
    }

    function sanitize(text) {
        const d = document.createElement('div');
        d.textContent = text || '';
        return d.innerHTML;
    }

    /* ── settings ── */

    const defaultSettings = Object.freeze({
        wardrobes: {},
        activeOutfits: {},
        maxDimension: 512,
        // Vision настройки для анализа аутфитов — ОТДЕЛЬНО от image-gen модели
        // Нужна vision-capable модель (gpt-4o, gemini-2.0-flash, claude-3-5-sonnet и т.д.)
        visionEndpoint: '',
        visionApiKey: '',
        visionModel: '',
    });

    function getSettings() {
        const ctx = SillyTavern.getContext();
        if (!ctx.extensionSettings[SW_MODULE]) {
            ctx.extensionSettings[SW_MODULE] = structuredClone(defaultSettings);
        }
        const s = ctx.extensionSettings[SW_MODULE];
        for (const k of Object.keys(defaultSettings)) {
            if (!Object.hasOwn(s, k)) s[k] = defaultSettings[k];
        }
        return s;
    }

    function saveSettings() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    /* ── context ── */

    function getCharName() {
        const ctx = SillyTavern.getContext();
        if (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]) {
            return ctx.characters[ctx.characterId].name || '';
        }
        return '';
    }

    /* ── wardrobe data ── */

    function getWardrobe(charName) {
        const s = getSettings();
        if (!s.wardrobes[charName]) s.wardrobes[charName] = { bot: [], user: [] };
        return s.wardrobes[charName];
    }

    function getActiveIds() {
        const charName = getCharName();
        if (!charName) return { bot: null, user: null };
        const s = getSettings();
        if (!s.activeOutfits[charName]) s.activeOutfits[charName] = { bot: null, user: null };
        return s.activeOutfits[charName];
    }

    function setActiveId(type, outfitId) {
        const charName = getCharName();
        if (!charName) { toastr.error('Персонаж не выбран', 'Гардероб'); return false; }
        const s = getSettings();
        if (!s.activeOutfits[charName]) s.activeOutfits[charName] = { bot: null, user: null };
        s.activeOutfits[charName][type] = outfitId;
        saveSettings();
        return true;
    }

    function addOutfit(charName, type, outfit) {
        getWardrobe(charName)[type].push(outfit);
        saveSettings();
    }

    function removeOutfit(charName, type, outfitId) {
        const w = getWardrobe(charName);
        w[type] = w[type].filter(o => o.id !== outfitId);
        if (getActiveIds()[type] === outfitId) setActiveId(type, null);
        saveSettings();
        swUpdatePromptInjection();
    }

    function findOutfit(charName, type, id) {
        return getWardrobe(charName)[type].find(o => o.id === id) || null;
    }

    /* ── image processing ── */

    function resizeImage(file, maxDim) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    let { width, height } = img;
                    if (width > maxDim || height > maxDim) {
                        const r = Math.min(maxDim / width, maxDim / height);
                        width = Math.round(width * r);
                        height = Math.round(height * r);
                    }
                    const c = document.createElement('canvas');
                    c.width = width; c.height = height;
                    c.getContext('2d').drawImage(img, 0, 0, width, height);
                    resolve({ base64: c.toDataURL('image/jpeg', 0.85).split(',')[1] });
                };
                img.onerror = () => reject(new Error('Image decode failed'));
                img.src = e.target.result;
            };
            reader.onerror = () => reject(new Error('File read failed'));
            reader.readAsDataURL(file);
        });
    }

    /* ── modal ── */

    let modalOpen = false;
    let currentTab = 'bot';

    function openModal() {
        closeModal();
        modalOpen = true;
        const charName = getCharName();
        if (!charName) {
            toastr.warning('Сначала выберите персонажа', 'Гардероб');
            modalOpen = false;
            return;
        }

        const overlay = document.createElement('div');
        overlay.id = 'sw-modal-overlay';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

        const modal = document.createElement('div');
        modal.id = 'sw-modal';
        modal.innerHTML = `
            <div class="sw-modal-header">
                <div class="sw-modal-title">
                    <i class="fa-solid fa-shirt" style="margin-right:8px;opacity:0.7"></i>
                    Гардероб — <b style="margin-left:4px">${sanitize(charName)}</b>
                </div>
                <div class="sw-modal-close interactable" title="Закрыть">
                    <i class="fa-solid fa-xmark"></i>
                </div>
            </div>
            <div class="sw-tabs">
                <div class="sw-tab interactable ${currentTab === 'bot' ? 'sw-tab-active' : ''}" data-tab="bot">
                    <i class="fa-solid fa-robot"></i> Бот
                </div>
                <div class="sw-tab interactable ${currentTab === 'user' ? 'sw-tab-active' : ''}" data-tab="user">
                    <i class="fa-solid fa-user"></i> Юзер
                </div>
            </div>
            <div class="sw-active-info" id="sw-active-info"></div>
            <div class="sw-tab-content" id="sw-tab-content"></div>
        `;

        overlay.appendChild(modal);

        // ── Fix: bypass CSS transform ancestors that break position:fixed ──
        // Appending to <html> (not body) and forcing position via JS ensures
        // the overlay always covers the full viewport on mobile ST builds.
        let _overlayResizeObserver = null;
        function _fixOverlayPos() {
            overlay.style.position = 'fixed';
            overlay.style.top    = '0px';
            overlay.style.left   = '0px';
            overlay.style.width  = window.innerWidth  + 'px';
            overlay.style.height = window.innerHeight + 'px';
        }
        _fixOverlayPos();
        _overlayResizeObserver = new ResizeObserver(_fixOverlayPos);
        _overlayResizeObserver.observe(document.documentElement);

        // Store observer so closeModal can kill it
        overlay._resizeObserver = _overlayResizeObserver;

        document.documentElement.appendChild(overlay);

        modal.querySelector('.sw-modal-close').addEventListener('click', closeModal);
        for (const tab of modal.querySelectorAll('.sw-tab')) {
            tab.addEventListener('click', () => {
                currentTab = tab.dataset.tab;
                modal.querySelectorAll('.sw-tab').forEach(t =>
                    t.classList.toggle('sw-tab-active', t.dataset.tab === currentTab));
                renderTabContent();
            });
        }

        // ── Swipe-down to close (mobile bottom sheet) ──────────────
        let touchStartY = 0, touchDeltaY = 0, isSwiping = false;

        modal.addEventListener('touchstart', (e) => {
            const header = modal.querySelector('.sw-modal-header');
            if (!header?.contains(e.target) && e.target !== modal) return;
            touchStartY = e.touches[0].clientY;
            touchDeltaY = 0;
            isSwiping = true;
        }, { passive: true });

        modal.addEventListener('touchmove', (e) => {
            if (!isSwiping) return;
            touchDeltaY = e.touches[0].clientY - touchStartY;
            if (touchDeltaY > 0) {
                modal.style.transform = `translateY(${Math.sqrt(touchDeltaY) * 6}px)`;
                modal.style.transition = 'none';
            }
        }, { passive: true });

        modal.addEventListener('touchend', () => {
            if (!isSwiping) return;
            isSwiping = false;
            modal.style.transform = '';
            modal.style.transition = '';
            if (touchDeltaY > 80) {
                modal.style.transition = 'transform 0.25s ease';
                modal.style.transform = 'translateY(110%)';
                overlay.style.transition = 'opacity 0.25s ease';
                overlay.style.opacity = '0';
                setTimeout(closeModal, 240);
            }
        }, { passive: true });

        renderTabContent();
        document.addEventListener('keydown', onEsc);
    }

    function onEsc(e) { if (e.key === 'Escape') closeModal(); }

    function closeModal() {
        modalOpen = false;
        const existing = document.getElementById('sw-modal-overlay');
        existing?._resizeObserver?.disconnect();
        existing?.remove();
        document.removeEventListener('keydown', onEsc);
        // Refresh the inline wardrobe preview in settings
        refreshWardrobeSettingsDisplay();
    }

    /* ── tab rendering ── */

    function renderTabContent() {
        const container = document.getElementById('sw-tab-content');
        const infoBar = document.getElementById('sw-active-info');
        if (!container) return;

        const charName = getCharName();
        const outfits = getWardrobe(charName)[currentTab] || [];
        const activeId = getActiveIds()[currentTab];

        if (infoBar) {
            const activeOutfit = activeId ? findOutfit(charName, currentTab, activeId) : null;
            if (activeOutfit) {
                infoBar.innerHTML = `<i class="fa-solid fa-check" style="color:#6ee7b7;margin-right:6px"></i>Активно: <b style="margin-left:4px">${sanitize(activeOutfit.name)}</b>${activeOutfit.description ? ` — <i>${sanitize(activeOutfit.description)}</i>` : ''}`;
                infoBar.classList.add('sw-active-visible');
            } else {
                infoBar.innerHTML = '<i class="fa-solid fa-circle-minus" style="margin-right:6px;opacity:0.4"></i>Ничего не надето';
                infoBar.classList.remove('sw-active-visible');
            }
        }

        let html = '<div class="sw-outfit-grid">';
        html += `<div class="sw-outfit-card sw-upload-card interactable" id="sw-upload-trigger">
            <div class="sw-upload-icon"><i class="fa-solid fa-plus"></i></div><span>Загрузить</span>
        </div>`;

        for (const o of outfits) {
            const isActive = o.id === activeId;
            html += `
                <div class="sw-outfit-card ${isActive ? 'sw-outfit-active' : ''}" data-id="${o.id}">
                    <div class="sw-outfit-img-wrap">
                        <img src="data:image/jpeg;base64,${o.base64}" alt="${sanitize(o.name)}" class="sw-outfit-img" loading="lazy">
                        ${isActive ? '<div class="sw-active-badge"><i class="fa-solid fa-check"></i></div>' : ''}
                    </div>
                    <div class="sw-outfit-footer">
                        <span class="sw-outfit-name" title="${sanitize(o.description || o.name)}">${sanitize(o.name)}</span>
                        <div class="sw-outfit-btns">
                            <div class="sw-btn-activate" title="${isActive ? 'Снять' : 'Надеть'}"><i class="fa-solid ${isActive ? 'fa-toggle-on' : 'fa-toggle-off'}"></i></div>
                            <div class="sw-btn-edit" title="Редактировать"><i class="fa-solid fa-pen"></i></div>
                            <div class="sw-btn-delete" title="Удалить"><i class="fa-solid fa-trash-can"></i></div>
                        </div>
                    </div>
                </div>`;
        }

        html += '</div>';
        container.innerHTML = html;

        document.getElementById('sw-upload-trigger')?.addEventListener('click', handleUpload);

        for (const card of container.querySelectorAll('.sw-outfit-card[data-id]')) {
            const id = card.dataset.id;
            card.querySelector('.sw-outfit-img')?.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                toggleActive(id);
            });
            card.querySelector('.sw-btn-activate')?.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                toggleActive(id);
            });
            card.querySelector('.sw-btn-edit')?.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                handleEdit(charName, currentTab, id);
            });
            card.querySelector('.sw-btn-delete')?.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                if (confirm('Удалить этот аутфит?')) {
                    removeOutfit(charName, currentTab, id);
                    renderTabContent();
                    toastr.info('Аутфит удалён', 'Гардероб');
                }
            });
        }
    }

    function toggleActive(id) {
        try {
            const a = getActiveIds();
            const isDeactivating = a[currentTab] === id;
            const charName = getCharName();
            const outfit = findOutfit(charName, currentTab, id);
            const outfitName = outfit?.name || id;
            const ok = setActiveId(currentTab, isDeactivating ? null : id);
            if (ok === false) return;
            renderTabContent();
            swUpdatePromptInjection();
            if (isDeactivating) {
                toastr.info(`«${outfitName}» снят`, 'Гардероб', { timeOut: 2000 });
            } else {
                toastr.success(`«${outfitName}» надет`, 'Гардероб', { timeOut: 2000 });
            }
        } catch (err) {
            toastr.error('Ошибка: ' + err.message, 'Гардероб');
        }
    }

    /**
     * Очищает ответ ИИ от RP-мусора: <think>, OOC-маркеров, системных инжектов и т.д.
     * Возвращает чистое описание одежды или null если ничего не осталось.
     */
    function swCleanOutfitDesc(raw) {
        if (!raw) return null;
        let s = raw;
        // Убираем <think>...</think> целиком
        s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
        // Убираем HTML-теги
        s = s.replace(/<[^>]+>/g, '');
        // Убираем HTML-комментарии <!-- -->
        s = s.replace(/<!--[\s\S]*?-->/g, '');
        // Убираем системные маркеры вишни
        s = s.replace(/\[OOC:[^\]]*\]/gi, '');
        s = s.replace(/\[[^\]]*_SCORE[^\]]*\]/gi, '');
        s = s.replace(/\[CYCLE_DAY[^\]]*\]/gi, '');
        s = s.replace(/\[LOVE_SCORE[^\]]*\]/gi, '');
        // Убираем строки содержащие системный мусор
        s = s.split('\n').filter(line => {
            const l = line.toLowerCase();
            return !l.includes('scene_desc') &&
                   !l.includes('atmosphere') &&
                   !l.includes('location:') &&
                   !l.includes('characters:') &&
                   !l.includes('costume:') &&
                   !l.includes('event:') &&
                   !l.includes('bgm>') &&
                   !l.includes('horae') &&
                   !l.includes('[cycle_') &&
                   !l.match(/^\s*\*/);  // строки начинающиеся со * (RP-действия)
        }).join(' ');
        // Убираем *курсив* и _подчёркивание_ RP-форматирования
        s = s.replace(/\*[^*]+\*/g, '').replace(/_[^_]+_/g, '');
        // Схлопываем пробелы
        s = s.replace(/\s+/g, ' ').trim();
        // Берём только первые 2 предложения
        const sentences = s.match(/[^.!?]+[.!?]+/g);
        if (sentences && sentences.length > 2) s = sentences.slice(0, 2).join(' ').trim();
        return s.length >= 15 ? s : null;
    }

    /**
     * Анализирует изображение аутфита через ИЗОЛИРОВАННЫЙ vision API вызов.
     * НЕ использует generateQuietPrompt — он тянет весь RP-контекст (30к токенов).
     * Использует настройки Vision из секции Гардероб (отдельная модель от image-gen).
     */
    async function swAnalyzeOutfit(base64) {
        const ctx = SillyTavern.getContext();
        const swS = ctx.extensionSettings?.['silly_wardrobe'] || {};

        const imageDataUrl = `data:image/jpeg;base64,${base64}`;
        const analyzePrompt = 'Describe the outfit/clothing visible in the attached image in 1-2 concise sentences in English. Focus ONLY on garments, colors, fabrics, accessories, shoes. Do NOT describe the person, background, or pose.';

        // Получаем vision настройки из гардероба
        const endpoint = (swS.visionEndpoint || '').trim().replace(/\/$/, '');
        const apiKey   = (swS.visionApiKey  || '').trim();
        const model    = (swS.visionModel   || '').trim();

        if (!endpoint || !apiKey || !model) {
            toastr.warning(
                'Укажи Vision endpoint / API key / модель в настройках Гардероба для авто-описания.',
                'Гардероб',
                { timeOut: 6000 }
            );
            swLog('WARN', 'Vision не настроен — нет endpoint/apiKey/model в silly_wardrobe settings');
            return null;
        }

        // Чистый изолированный вызов — БЕЗ системного промпта и БЕЗ истории чата
        // generateQuietPrompt не используется: он всегда тянет весь контекст (~30k токенов RP)
        try {
            toastr.info('Анализ образа через Vision API...', 'Гардероб', { timeOut: 12000 });

            const response = await fetch(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model,
                    max_tokens: 200,
                    // Только одно сообщение — никакого системного промпта, никакой истории
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'image_url', image_url: { url: imageDataUrl } },
                            { type: 'text', text: analyzePrompt },
                        ],
                    }],
                }),
            });

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                swLog('WARN', `Vision API HTTP ${response.status}:`, errText.substring(0, 200));
                toastr.error(`Vision API ошибка ${response.status}`, 'Гардероб', { timeOut: 4000 });
                return null;
            }

            const data = await response.json();
            const raw = data?.choices?.[0]?.message?.content;
            const desc = swCleanOutfitDesc(raw);

            if (desc) {
                swLog('INFO', 'Vision API описание:', desc.substring(0, 100));
                return desc;
            }

            swLog('WARN', 'Vision API: пусто после очистки. raw:', String(raw).substring(0, 200));
            return null;

        } catch (e) {
            swLog('WARN', 'Vision API fetch failed:', e.message);
            toastr.error('Ошибка Vision API: ' + e.message, 'Гардероб', { timeOut: 4000 });
            return null;
        }
    }

    async function handleUpload() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            const name = prompt('Название аутфита:', file.name.replace(/\.[^.]+$/, ''));
            if (name === null || !name.trim()) return;
            try {
                const s = getSettings();
                const { base64 } = await resizeImage(file, s.maxDimension);

                // Авто-анализ через ИИ
                let autoDesc = await swAnalyzeOutfit(base64);
                // Даём пользователю отредактировать или подтвердить
                const description = prompt(
                    autoDesc
                        ? 'Описание (авто-сгенерировано ИИ, можно отредактировать):'
                        : 'Описание (опционально):',
                    autoDesc || ''
                ) || '';

                addOutfit(getCharName(), currentTab, {
                    id: uid(), name: name.trim(), description: description.trim(),
                    base64, addedAt: Date.now()
                });
                renderTabContent();
                toastr.success(`«${name.trim()}» добавлен`, 'Гардероб');
            } catch (err) {
                toastr.error('Ошибка: ' + err.message, 'Гардероб');
            }
        });
        input.click();
    }

    async function handleEdit(charName, type, id) {
        const outfit = findOutfit(charName, type, id);
        if (!outfit) return;
        const newName = prompt('Название:', outfit.name);
        if (newName === null) return;

        // Предлагаем пере-анализировать через ИИ
        let currentDesc = outfit.description || '';
        const reAnalyze = confirm(
            'Пере-анализировать образ через ИИ?\n\nОК = да (описание заменится авто)\nОтмена = редактировать вручную'
        );
        if (reAnalyze) {
            const autoDesc = await swAnalyzeOutfit(outfit.base64);
            if (autoDesc) currentDesc = autoDesc;
        }

        const newDesc = prompt('Описание:', currentDesc);
        if (newDesc === null) return;
        outfit.name = newName.trim() || outfit.name;
        outfit.description = newDesc.trim();
        saveSettings();
        renderTabContent();
        swUpdatePromptInjection();
        toastr.info('Аутфит обновлён', 'Гардероб');
    }

    /* ── inline settings display ── */

    function refreshWardrobeSettingsDisplay() {
        const charName = getCharName();
        if (!charName) return;
        const active = getActiveIds();

        for (const type of ['bot', 'user']) {
            const thumb = document.querySelector(`.iig-wardrobe-active-thumb[data-type="${type}"]`);
            const label = document.querySelector(`.iig-wardrobe-active-label[data-type="${type}"]`);
            if (!thumb || !label) continue;

            const outfit = active[type] ? findOutfit(charName, type, active[type]) : null;
            if (outfit) {
                thumb.src = `data:image/jpeg;base64,${outfit.base64}`;
                thumb.style.display = 'block';
                label.textContent = outfit.name;
                label.style.color = '#6ee7b7';
            } else {
                thumb.src = '';
                thumb.style.display = 'none';
                label.textContent = 'Не надето';
                label.style.color = '';
            }
        }
    }

    /* ── Prompt injection: outfit descriptions into main RP chat ── */
    // Скопировано 1-в-1 из sillyimages.
    // Инжектит описание одежды в чат через setExtensionPrompt, чтобы ИИ
    // знал во что одет бот/юзер при написании RP-текста.

    const SW_PROMPT_KEY = 'sillywardrobe_outfit';

    function swUpdatePromptInjection() {
        try {
            const ctx = SillyTavern.getContext();
            if (typeof ctx.setExtensionPrompt !== 'function') {
                swLog('WARN', 'setExtensionPrompt not available');
                return;
            }
            const cn = getCharName();
            if (!cn) {
                ctx.setExtensionPrompt(SW_PROMPT_KEY, '', 1, 1);
                return;
            }
            const botData = getActiveIds().bot ? findOutfit(cn, 'bot', getActiveIds().bot) : null;
            const userData = getActiveIds().user ? findOutfit(cn, 'user', getActiveIds().user) : null;
            const lines = [];
            if (botData?.description) lines.push(`[${cn} сейчас одет(а): ${botData.description}]`);
            if (userData?.description) lines.push(`[{{user}} сейчас одет(а): ${userData.description}]`);
            const injectionText = lines.length > 0 ? lines.join('\n') : '';
            // position 1 = IN_CHAT, depth 1 = before last message (like Author's Note)
            ctx.setExtensionPrompt(SW_PROMPT_KEY, injectionText, 1, 1);
            if (injectionText) {
                swLog('INFO', `Prompt injection updated: ${lines.length} outfit(s)`);
            } else {
                swLog('INFO', 'Prompt injection cleared (no active outfits)');
            }
        } catch (e) {
            swLog('ERROR', 'Failed to update prompt injection:', e.message);
        }
    }

    /* ── public API ── */

    window.sillyWardrobe = {
        getActiveOutfitBase64(type) {
            const cn = getCharName();
            if (!cn) return null;
            const a = getActiveIds();
            return a[type] ? (findOutfit(cn, type, a[type])?.base64 || null) : null;
        },
        getActiveOutfitDataUrl(type) {
            const b64 = this.getActiveOutfitBase64(type);
            return b64 ? `data:image/jpeg;base64,${b64}` : null;
        },
        getActiveOutfitData(type) {
            const cn = getCharName();
            if (!cn) return null;
            const a = getActiveIds();
            return a[type] ? findOutfit(cn, type, a[type]) : null;
        },
        openModal,
        refreshDisplay: refreshWardrobeSettingsDisplay,
        updatePromptInjection: swUpdatePromptInjection,
        isReady: () => true,
    };

    /* ── init ── */

    const ctx = SillyTavern.getContext();
    getSettings();

    ctx.eventSource.on(ctx.event_types.APP_READY, () => {
        swLog('INFO', 'SillyWardrobe loaded (settings-integrated mode)');
        setTimeout(swUpdatePromptInjection, 500);
    });

    ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
        setTimeout(refreshWardrobeSettingsDisplay, 400);
        setTimeout(swUpdatePromptInjection, 300);
    });

    swLog('INFO', 'SillyWardrobe initialized');
})();



/* ╔═══════════════════════════════════════════════════════════════╗
   ║  MODULE 2 — Inline Image Generation                          ║
   ║  Base: notsosillynotsoimages by aceeenvw                     ║
   ║  + wardrobe integration                                      ║
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
});

const MAX_CONTEXT_IMAGES = 3;

function normalizeImageContextCount(value) {
    const n = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, MAX_CONTEXT_IMAGES);
}

// Извлекает URL-ы уже сгенерированных картинок из текста сообщения
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

// Ищет URL-ы предыдущих сгенерированных картинок в истории чата
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

// Конвертирует URL-ы предыдущих картинок в base64 / dataUrl для отправки в API
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
        if (context.characterId !== undefined && context.characters?.[context.characterId]) {
            charName = context.characters[context.characterId].name || 'generated';
        }
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
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }
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

/* ── API: VoidAI ── */
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
                toStr(img?.image_url?.url),
                toStr(img?.url),
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

/* ── API: OpenAI ── */
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

/* ── API: Gemini / nano-banana ── */
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
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio, imageSize }
        }
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
    const responseParts = candidates[0].content?.parts || [];
    for (const part of responseParts) {
        if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        if (part.inline_data) return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
    }
    throw new Error('No image found in Gemini response');
}

/* ── API: Naistera ── */
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

function sanitizeForHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/* ── Main generation function (with wardrobe refs) ── */
async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();
    const settings = getSettings();
    const maxRetries = settings.maxRetries;
    const baseDelay = settings.retryDelay;

    const referenceImages = [];   // base64 — for Gemini / OpenAI
    const referenceDataUrls = []; // data URLs — for Naistera

    const isGeminiType = settings.apiType === 'gemini' || isGeminiModel(settings.model);
    const isNaisteraType = settings.apiType === 'naistera';

    const getB64 = async (ref, label) => {
        if (ref?.imagePath) { const b64 = await loadRefImageAsBase64(ref.imagePath); if (b64) return b64; }
        return ref?.imageBase64 || ref?.imageData || null;
    };

    const getDataUrl = async (ref) => {
        const b64 = await getB64(ref, '');
        return b64 ? 'data:image/jpeg;base64,' + b64 : null;
    };

    const refs = getCurrentCharacterRefs();

    if (isGeminiType) {
        const charB64 = await getB64(refs.charRef, 'charRef');
        if (charB64) referenceImages.push(charB64);
        const userB64 = await getB64(refs.userRef, 'userRef');
        if (userB64) referenceImages.push(userB64);
    } else if (isNaisteraType) {
        const charUrl = await getDataUrl(refs.charRef);
        if (charUrl) referenceDataUrls.push(charUrl);
        const userUrl = await getDataUrl(refs.userRef);
        if (userUrl) referenceDataUrls.push(userUrl);
    }

    // ── Wardrobe integration ──────────────────────────────────────
    if (window.sillyWardrobe?.isReady()) {
        const botB64 = window.sillyWardrobe.getActiveOutfitBase64('bot');
        const userB64 = window.sillyWardrobe.getActiveOutfitBase64('user');
        const botData = window.sillyWardrobe.getActiveOutfitData('bot');
        const userData = window.sillyWardrobe.getActiveOutfitData('user');

        let wardrobeAdded = 0;
        if (isGeminiType) {
            if (botB64 && referenceImages.length < 4) { referenceImages.push(botB64); wardrobeAdded++; iigLog('INFO', `Wardrobe bot: "${botData?.name}"`); }
            if (userB64 && referenceImages.length < 4) { referenceImages.push(userB64); wardrobeAdded++; iigLog('INFO', `Wardrobe user: "${userData?.name}"`); }
        } else if (isNaisteraType) {
            const botUrl = window.sillyWardrobe.getActiveOutfitDataUrl('bot');
            const userUrl = window.sillyWardrobe.getActiveOutfitDataUrl('user');
            if (botUrl && referenceDataUrls.length < 4) { referenceDataUrls.push(botUrl); wardrobeAdded++; }
            if (userUrl && referenceDataUrls.length < 4) { referenceDataUrls.push(userUrl); wardrobeAdded++; }
        } else {
            if (botB64 && referenceImages.length < 4) { referenceImages.push(botB64); wardrobeAdded++; }
            if (userB64 && referenceImages.length < 4) { referenceImages.push(userB64); wardrobeAdded++; }
        }
        if (wardrobeAdded > 0) {
            iigLog('INFO', `Wardrobe: добавлено ${wardrobeAdded} аутфита(ов)`);
        }

        // ── Inject wardrobe outfit descriptions into image prompt text ──
        // botData/userData уже объявлены выше, переиспользуем их
        const descParts = [];
        if (botData?.description) descParts.push(`[Character's current outfit: ${botData.description}]`);
        if (userData?.description) descParts.push(`[User's current outfit: ${userData.description}]`);
        if (descParts.length > 0) {
            prompt = `${descParts.join(' ')}\n${prompt}`;
            iigLog('INFO', `Wardrobe descriptions injected into prompt: ${descParts.join(', ')}`);
        }
    }

    // ── Image context: предыдущие картинки из чата как рефы ──────
    if (settings.imageContextEnabled) {
        const contextCount = normalizeImageContextCount(settings.imageContextCount);
        if (isGeminiType) {
            const contextRefs = await collectPreviousContextReferences(options.messageId, 'base64', contextCount);
            for (const ref of contextRefs) {
                if (referenceImages.length < 4) { referenceImages.push(ref); iigLog('INFO', `Image context ref added (gemini)`); }
            }
        } else if (isNaisteraType) {
            const contextRefs = await collectPreviousContextReferences(options.messageId, 'dataUrl', contextCount);
            for (const ref of contextRefs) {
                if (referenceDataUrls.length < 4) { referenceDataUrls.push(ref); iigLog('INFO', `Image context ref added (naistera)`); }
            }
        }
    }

    // ── NPC refs ──────────────────────────────────────────────────
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

async function checkFileExists(path) {
    try { const r = await fetch(path, { method: 'HEAD' }); return r.ok; } catch (e) { return false; }
}

async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];

    // === NEW FORMAT ===
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
            const exists = await checkFileExists(srcValue);
            if (!exists) needsGeneration = true;
            else { searchPos = imgEnd; continue; }
        } else if (hasPath) { searchPos = imgEnd; continue; }
        if (!needsGeneration) { searchPos = imgEnd; continue; }
        try {
            let normalizedJson = instructionJson
                .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
                .replace(/&#34;/g, '"').replace(/&amp;/g, '&');
            const data = JSON.parse(normalizedJson);
            tags.push({
                fullMatch: fullImgTag, index: imgStart,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                preset: data.preset || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null, isNewFormat: true,
                existingSrc: hasPath ? srcValue : null
            });
        } catch (e) { iigLog('WARN', `Failed to parse instruction JSON`, e.message); }
        searchPos = imgEnd;
    }

    // === LEGACY FORMAT ===
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
        } catch (e) { iigLog('WARN', `Failed to parse legacy tag JSON`, e.message); }
        searchStart = jsonEnd + 1;
    }
    return tags;
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

function createLoadingPlaceholder(tagId) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-loading-placeholder';
    placeholder.dataset.tagId = tagId;
    placeholder.innerHTML = `
        <div class="iig-spinner-wrap"><div class="iig-spinner"></div></div>
        <div class="iig-status">Генерация картинки...</div>
        <div class="iig-timer"></div>
    `;
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
                try {
                    const d = JSON.parse(decoded.replace(/'/g,'"'));
                    if (d.prompt?.substring(0, 30) === tag.prompt.substring(0, 30)) { targetElement = img; break; }
                } catch(e) {}
            }
            if (!targetElement) {
                for (const img of allImgs) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src === '' || src === '#') { targetElement = img; break; }
                }
            }
            if (!targetElement) {
                for (const img of mesTextEl.querySelectorAll('img')) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) { targetElement = img; break; }
                }
            }
        } else {
            const tagEscaped = tag.fullMatch.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/"/g,'(?:"|&quot;)');
            const before = mesTextEl.innerHTML;
            mesTextEl.innerHTML = mesTextEl.innerHTML.replace(new RegExp(tagEscaped,'g'), `<span data-iig-placeholder="${tagId}"></span>`);
            if (before !== mesTextEl.innerHTML) targetElement = mesTextEl.querySelector(`[data-iig-placeholder="${tagId}"]`);
            if (!targetElement) {
                for (const img of mesTextEl.querySelectorAll('img')) {
                    if (img.src && img.src.includes('[IMG:GEN:')) { targetElement = img; break; }
                }
            }
        }

        if (targetElement) {
            const parent = targetElement.parentElement;
            if (parent) {
                const ps = window.getComputedStyle(parent);
                if (ps.display === 'flex' || ps.display === 'grid') loadingPlaceholder.style.alignSelf = 'center';
            }
            targetElement.replaceWith(loadingPlaceholder);
        } else {
            mesTextEl.appendChild(loadingPlaceholder);
        }

        const statusEl = loadingPlaceholder.querySelector('.iig-status');
        try {
            const dataUrl = await generateImageWithRetry(
                tag.prompt, tag.style,
                (status) => { statusEl.textContent = status; },
                { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset }
            );
            statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);
            const img = document.createElement('img');
            img.className = 'iig-generated-image';
            img.src = imagePath;
            img.alt = tag.prompt;
            img.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;
            if (tag.isNewFormat) {
                const m = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                if (m) img.setAttribute('data-iig-instruction', m[2]);
            }
            if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
            loadingPlaceholder.replaceWith(img);
            if (tag.isNewFormat) {
                message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`));
            } else {
                message.mes = message.mes.replace(tag.fullMatch, `[IMG:✓:${imagePath}]`);
            }
            sessionGenCount++;
            updateSessionStats();
            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Failed tag ${index}:`, error.message);
            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
            if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
            loadingPlaceholder.replaceWith(errorPlaceholder);
            if (tag.isNewFormat) {
                message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${ERROR_IMAGE_PATH}"`));
            } else {
                message.mes = message.mes.replace(tag.fullMatch, `[IMG:ERROR:${error.message.substring(0, 50)}]`);
            }
            sessionErrorCount++;
            updateSessionStats();
            toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
        }
    };

    try {
        await Promise.all(tags.map((tag, index) => processTag(tag, index)));
    } finally {
        processingMessages.delete(messageId);
    }
    await context.saveChat();
    if (typeof context.messageFormatting === 'function') {
        const formatted = context.messageFormatting(message.mes, message.name, message.is_system, message.is_user, messageId);
        mesTextEl.innerHTML = formatted;
    }
}

async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Сообщение не найдено', 'Генерация картинок'); return; }
    const tags = await parseImageTags(message.mes, { forceAll: true });
    if (tags.length === 0) { toastr.warning('Нет тегов для перегенерации', 'Генерация картинок'); return; }
    toastr.info(`Перегенерация ${tags.length} картинок...`, 'Генерация картинок');
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
                const loadingPlaceholder = createLoadingPlaceholder(tagId);
                existingImg.replaceWith(loadingPlaceholder);
                const statusEl = loadingPlaceholder.querySelector('.iig-status');
                const dataUrl = await generateImageWithRetry(
                    tag.prompt, tag.style,
                    (status) => { statusEl.textContent = status; },
                    { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset }
                );
                statusEl.textContent = 'Сохранение...';
                const imagePath = await saveImageToFile(dataUrl);
                const img = document.createElement('img');
                img.className = 'iig-generated-image';
                img.src = imagePath;
                img.alt = tag.prompt;
                if (instruction) img.setAttribute('data-iig-instruction', instruction);
                if (loadingPlaceholder._timerInterval) clearInterval(loadingPlaceholder._timerInterval);
                loadingPlaceholder.replaceWith(img);
                message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`));
                toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
            }
        } catch (error) {
            iigLog('ERROR', `Regen failed tag ${index}:`, error.message);
            toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
        }
    }
    processingMessages.delete(messageId);
    await context.saveChat();
}

function addRegenerateButton(messageElement, messageId) {
    if (messageElement.querySelector('.iig-regenerate-btn')) return;
    const extraMesButtons = messageElement.querySelector('.extraMesButtons');
    if (!extraMesButtons) return;
    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать картинки';
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => { e.stopPropagation(); await regenerateMessageImages(messageId); });
    extraMesButtons.appendChild(btn);
}

function addButtonsToExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return;
    for (const messageElement of document.querySelectorAll('#chat .mes')) {
        const mesId = messageElement.getAttribute('mesid');
        if (mesId === null) continue;
        const messageId = parseInt(mesId, 10);
        const message = context.chat[messageId];
        if (message && !message.is_user) addRegenerateButton(messageElement, messageId);
    }
}

async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    addRegenerateButton(messageElement, messageId);
    await processMessageTags(messageId);
}

/* ══════════════════════════════════════════════════════════
   SETTINGS UI
   ══════════════════════════════════════════════════════════ */

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

// Dynamic NPC list — multiple NPCs with enable/disable checkbox
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

        // Checkbox включить/выключить
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = npc.enabled !== false;
        checkbox.title = 'Включить/выключить NPC референс';
        checkbox.addEventListener('change', (e) => {
            settings.npcReferences[i].enabled = e.target.checked;
            saveSettings();
        });

        const label = document.createElement('div');
        label.className = 'iig-ref-label';
        label.textContent = `NPC ${i + 1}`;

        const preview = document.createElement('div');
        preview.className = 'iig-ref-preview';
        const thumb = document.createElement('img');
        thumb.className = 'iig-ref-thumb';
        thumb.alt = npc.name || `NPC ${i + 1}`;
        if (npc.imageBase64 || npc.imageData) {
            thumb.src = 'data:image/jpeg;base64,' + (npc.imageBase64 || npc.imageData);
        } else if (npc.imagePath) {
            thumb.src = npc.imagePath;
        } else {
            thumb.src = '';
        }
        preview.appendChild(thumb);

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'text_pole iig-ref-name';
        nameInput.placeholder = 'Имя NPC';
        nameInput.value = npc.name || '';
        nameInput.addEventListener('input', (e) => {
            settings.npcReferences[i].name = e.target.value;
            saveSettings();
        });

        const uploadLabel = document.createElement('label');
        uploadLabel.className = 'menu_button iig-ref-upload-btn';
        uploadLabel.title = 'Загрузить фото';
        uploadLabel.innerHTML = '<i class="fa-solid fa-upload"></i>';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const rawBase64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result.split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
                const compressed = await compressBase64Image(rawBase64, 768, 0.8);
                settings.npcReferences[i].imageBase64 = compressed;
                settings.npcReferences[i].imagePath = '';
                saveSettings();
                thumb.src = 'data:image/jpeg;base64,' + compressed;
                toastr.success(`Фото для "${settings.npcReferences[i].name || `NPC ${i+1}`}" загружено`, 'Генерация картинок', { timeOut: 2000 });
            } catch (err) {
                iigLog('ERROR', `NPC ${i} upload failed:`, err.message);
                toastr.error('Ошибка загрузки фото', 'Генерация картинок');
            }
            e.target.value = '';
        });
        uploadLabel.appendChild(fileInput);

        const deleteBtn = document.createElement('div');
        deleteBtn.className = 'menu_button iig-ref-delete-btn';
        deleteBtn.title = 'Удалить NPC';
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        deleteBtn.style.color = '#cc5555';
        deleteBtn.addEventListener('click', () => {
            const name = settings.npcReferences[i]?.name || `NPC ${i + 1}`;
            settings.npcReferences.splice(i, 1);
            saveSettings();
            renderNpcList();
            toastr.info(`NPC "${name}" удалён`, 'Генерация картинок', { timeOut: 2000 });
        });

        slot.appendChild(checkbox);
        slot.appendChild(label);
        slot.appendChild(preview);
        slot.appendChild(nameInput);
        slot.appendChild(uploadLabel);
        slot.appendChild(deleteBtn);
        container.appendChild(slot);
    }
}

function bindNpcSlotEvent() {
    // Add NPC button
    document.getElementById('iig_npc_add')?.addEventListener('click', () => {
        const nameInput = document.getElementById('iig_npc_new_name');
        const name = nameInput?.value?.trim();
        if (!name) {
            toastr.warning('Введите имя NPC', 'Генерация картинок');
            return;
        }
        const s = getCurrentCharacterRefs();
        if (s.npcReferences.some(n => n.name.toLowerCase() === name.toLowerCase())) {
            toastr.warning(`NPC "${name}" уже существует`, 'Генерация картинок');
            return;
        }
        s.npcReferences.push({ name, imageBase64: '', imagePath: '', enabled: true });
        saveSettings();
        if (nameInput) nameInput.value = '';
        renderNpcList();
        toastr.success(`NPC "${name}" добавлен — загрузите фото!`, 'Генерация картинок', { timeOut: 3000 });
    });

    document.getElementById('iig_npc_new_name')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('iig_npc_add')?.click();
        }
    });

    renderNpcList();
}

function createSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) return;

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><span style="font-style:normal;">🍒</span> Генерация картинок</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <!-- Enable/Disable -->
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить генерацию картинок</span>
                    </label>

                    <hr>

                    <!-- API Configuration -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-plug"></i> Настройки API</h4>

                        <div class="flex-row">
                            <label for="iig_api_type">Тип API</label>
                            <select id="iig_api_type" class="flex1">
                                <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый (/v1/images/generations)</option>
                                <option value="void" ${settings.apiType === 'void' ? 'selected' : ''}>VoidAI (/v1/chat/completions)</option>
                                <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini / Nano-Banana</option>
                                <option value="naistera" ${settings.apiType === 'naistera' ? 'selected' : ''}>Naistera / Grok</option>
                            </select>
                        </div>

                        <div class="flex-row">
                            <label for="iig_endpoint">URL эндпоинта</label>
                            <input type="text" id="iig_endpoint" class="text_pole flex1"
                                   value="${sanitizeForHtml(settings.endpoint)}"
                                   placeholder="https://api.example.com">
                        </div>
                        <div class="flex-row" style="gap:4px;flex-wrap:wrap;">
                            <span style="font-size:0.8em;opacity:0.6;align-self:center;">Быстрый выбор:</span>
                            <div class="menu_button iig-preset-btn" data-preset-url="https://api.voidai.app" data-preset-type="void" style="font-size:0.8em;padding:2px 8px;">VoidAI</div>
                            <div class="menu_button iig-preset-btn" data-preset-url="https://api.routemyai.com" data-preset-type="openai" style="font-size:0.8em;padding:2px 8px;">RouteMyAI</div>
                            <div class="menu_button iig-preset-btn" data-preset-url="https://api.openai.com" data-preset-type="openai" style="font-size:0.8em;padding:2px 8px;">OpenAI</div>
                        </div>

                        <div class="flex-row">
                            <label for="iig_api_key">API ключ</label>
                            <input type="password" id="iig_api_key" class="text_pole flex1"
                                   value="${sanitizeForHtml(settings.apiKey)}">
                            <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть">
                                <i class="fa-solid fa-eye"></i>
                            </div>
                        </div>
                        <p id="iig_naistera_hint" class="hint ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}">Naistera/Grok: вставьте токен из Telegram бота. Модель не требуется.</p>

                        <div class="flex-row ${settings.apiType === 'naistera' ? 'iig-hidden' : ''}" id="iig_model_row">
                            <label for="iig_model">Модель</label>
                            <select id="iig_model" class="flex1">
                                ${settings.model ? `<option value="${sanitizeForHtml(settings.model)}" selected>${sanitizeForHtml(settings.model)}</option>` : '<option value="">-- Выберите модель --</option>'}
                            </select>
                            <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить список">
                                <i class="fa-solid fa-sync"></i>
                            </div>
                        </div>

                        <div id="iig_test_connection" class="menu_button iig-test-connection">
                            <i class="fa-solid fa-wifi"></i> Тест соединения
                        </div>
                    </div>

                    <hr>

                    <!-- Image Context Section -->
                    <div class="iig-section ${['naistera', 'gemini'].includes(settings.apiType) ? '' : 'iig-hidden'}" id="iig_image_context_section">
                        <h4><i class="fa-solid fa-clock-rotate-left"></i> Контекст картинок</h4>
                        <p class="hint">Добавляет предыдущие сгенерированные картинки из чата как референсы — для консистентности сцены и стиля.</p>
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_image_context_enabled" ${settings.imageContextEnabled ? 'checked' : ''}>
                            <span>Включить контекст картинок</span>
                        </label>
                        <div class="flex-row ${settings.imageContextEnabled ? '' : 'iig-hidden'}" id="iig_image_context_count_row" style="margin-top:6px;align-items:center;gap:6px;">
                            <span style="white-space:nowrap;">Использовать</span>
                            <input
                                type="number"
                                id="iig_image_context_count"
                                class="text_pole"
                                style="width:54px;"
                                min="1"
                                max="${MAX_CONTEXT_IMAGES}"
                                step="1"
                                value="${normalizeImageContextCount(settings.imageContextCount)}"
                            >
                            <span style="white-space:nowrap;">предыд. картинок (макс. ${MAX_CONTEXT_IMAGES})</span>
                        </div>
                    </div>

                    <hr>

                    <!-- Generation Settings -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-sliders"></i> Параметры генерации</h4>

                        <div class="flex-row" id="iig_size_row">
                            <label for="iig_size">Размер</label>
                            <select id="iig_size" class="flex1">
                                <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024×1024 (Квадрат)</option>
                                <option value="1536x1024" ${settings.size === '1536x1024' ? 'selected' : ''}>1536×1024 (Альбом)</option>
                                <option value="1024x1536" ${settings.size === '1024x1536' ? 'selected' : ''}>1024×1536 (Портрет)</option>
                                <option value="2048x2048" ${settings.size === '2048x2048' ? 'selected' : ''}>2048×2048 (Large)</option>
                                <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>512×512 (Маленький)</option>
                                <option value="auto" ${settings.size === 'auto' ? 'selected' : ''}>Авто</option>
                            </select>
                        </div>

                        <div class="flex-row" id="iig_quality_row">
                            <label for="iig_quality">Качество</label>
                            <select id="iig_quality" class="flex1">
                                <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>Стандартное</option>
                                <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>HD</option>
                            </select>
                        </div>

                        <!-- Naistera params -->
                        <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_aspect_row">
                            <label for="iig_naistera_aspect_ratio">Соотношение сторон</label>
                            <select id="iig_naistera_aspect_ratio" class="flex1">
                                <option value="1:1" ${settings.naisteraAspectRatio === '1:1' ? 'selected' : ''}>1:1</option>
                                <option value="3:2" ${settings.naisteraAspectRatio === '3:2' ? 'selected' : ''}>3:2</option>
                                <option value="2:3" ${settings.naisteraAspectRatio === '2:3' ? 'selected' : ''}>2:3</option>
                            </select>
                        </div>
                        <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_preset_row">
                            <label for="iig_naistera_preset">Пресет</label>
                            <select id="iig_naistera_preset" class="flex1">
                                <option value="" ${!settings.naisteraPreset ? 'selected' : ''}>Без пресета</option>
                                <option value="digital" ${settings.naisteraPreset === 'digital' ? 'selected' : ''}>Digital</option>
                                <option value="realism" ${settings.naisteraPreset === 'realism' ? 'selected' : ''}>Realism</option>
                            </select>
                        </div>

                        <!-- Gemini/nano-banana params -->
                        <div id="iig_gemini_params" class="${settings.apiType !== 'gemini' ? 'iig-hidden' : ''}">
                            <div class="flex-row">
                                <label for="iig_aspect_ratio">Соотношение сторон</label>
                                <select id="iig_aspect_ratio" class="flex1">
                                    <option value="1:1" ${settings.aspectRatio === '1:1' ? 'selected' : ''}>1:1 (Квадрат)</option>
                                    <option value="2:3" ${settings.aspectRatio === '2:3' ? 'selected' : ''}>2:3 (Портрет)</option>
                                    <option value="3:2" ${settings.aspectRatio === '3:2' ? 'selected' : ''}>3:2 (Альбом)</option>
                                    <option value="9:16" ${settings.aspectRatio === '9:16' ? 'selected' : ''}>9:16 (Вертикаль)</option>
                                    <option value="16:9" ${settings.aspectRatio === '16:9' ? 'selected' : ''}>16:9 (Широкий)</option>
                                    <option value="4:3" ${settings.aspectRatio === '4:3' ? 'selected' : ''}>4:3</option>
                                    <option value="3:4" ${settings.aspectRatio === '3:4' ? 'selected' : ''}>3:4</option>
                                    <option value="4:5" ${settings.aspectRatio === '4:5' ? 'selected' : ''}>4:5</option>
                                    <option value="5:4" ${settings.aspectRatio === '5:4' ? 'selected' : ''}>5:4</option>
                                    <option value="21:9" ${settings.aspectRatio === '21:9' ? 'selected' : ''}>21:9 (Ультраширокий)</option>
                                </select>
                            </div>
                            <div class="flex-row">
                                <label for="iig_image_size">Разрешение</label>
                                <select id="iig_image_size" class="flex1">
                                    <option value="1K" ${settings.imageSize === '1K' ? 'selected' : ''}>1K (по умолчанию)</option>
                                    <option value="2K" ${settings.imageSize === '2K' ? 'selected' : ''}>2K</option>
                                    <option value="4K" ${settings.imageSize === '4K' ? 'selected' : ''}>4K</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <hr>

                    <!-- References Section -->
                    <div id="iig_refs_section" class="iig-refs">
                        <h4><i class="fa-solid fa-user-group"></i> Референсы персонажей</h4>
                        <p class="hint">
                            Загрузите фото для консистентной генерации.<br>
                            <b>📌 Лимит: максимум 4 картинки за запрос.</b><br>
                            Порядок: {{char}} → {{user}} → аутфит (гардероб) → NPC по имени в промпте.
                        </p>

                        <!-- Char slot -->
                        <div class="iig-ref-slot" data-ref-type="char">
                            <div class="iig-ref-label">{{char}}</div>
                            <div class="iig-ref-preview"><img src="" alt="Char" class="iig-ref-thumb"></div>
                            <input type="text" class="text_pole iig-ref-name" placeholder="Имя персонажа" value="">
                            <label class="menu_button iig-ref-upload-btn" title="Загрузить фото">
                                <i class="fa-solid fa-upload"></i>
                                <input type="file" accept="image/*" class="iig-ref-file-input" style="display:none">
                            </label>
                            <div class="menu_button iig-ref-delete-btn" title="Удалить"><i class="fa-solid fa-trash"></i></div>
                        </div>

                        <!-- User slot -->
                        <div class="iig-ref-slot" data-ref-type="user">
                            <div class="iig-ref-label">{{user}}</div>
                            <div class="iig-ref-preview"><img src="" alt="User" class="iig-ref-thumb"></div>
                            <input type="text" class="text_pole iig-ref-name" placeholder="Имя юзера" value="">
                            <label class="menu_button iig-ref-upload-btn" title="Загрузить фото">
                                <i class="fa-solid fa-upload"></i>
                                <input type="file" accept="image/*" class="iig-ref-file-input" style="display:none">
                            </label>
                            <div class="menu_button iig-ref-delete-btn" title="Удалить"><i class="fa-solid fa-trash"></i></div>
                        </div>

                        <hr>

                        <!-- Dynamic NPC list -->
                        <h5 style="margin:6px 0 2px;"><i class="fa-solid fa-users"></i> NPC</h5>
                        <p class="hint" style="margin-bottom:6px;">NPC добавляются как референсы если имя встречается в промпте. Чекбокс включает/выключает каждого NPC.</p>
                        <div id="iig_npc_list"></div>
                        <div class="flex-row" style="margin-top:8px;gap:4px;">
                            <input type="text" id="iig_npc_new_name" class="text_pole flex1" placeholder="Имя NPC (напр. Люка)">
                            <div id="iig_npc_add" class="menu_button" title="Добавить NPC">
                                <i class="fa-solid fa-plus"></i> Добавить
                            </div>
                        </div>
                    </div>

                    <hr>

                    <!-- Wardrobe Section -->
                    <div class="iig-section iig-wardrobe-section">
                        <h4><i class="fa-solid fa-shirt"></i> Гардероб</h4>
                        <p class="hint">Аутфиты добавляются как дополнительные референсы при генерации. Хранятся отдельно для каждого персонажа.</p>

                        <div class="iig-wardrobe-preview-row">
                            <!-- Bot active outfit -->
                            <div class="iig-wardrobe-slot">
                                <div class="iig-wardrobe-slot-icon"><i class="fa-solid fa-robot"></i></div>
                                <div class="iig-wardrobe-slot-content">
                                    <img class="iig-wardrobe-active-thumb" data-type="bot" src="" style="display:none" alt="Bot outfit">
                                    <span class="iig-wardrobe-active-label" data-type="bot">Не надето</span>
                                </div>
                            </div>
                            <!-- User active outfit -->
                            <div class="iig-wardrobe-slot">
                                <div class="iig-wardrobe-slot-icon"><i class="fa-solid fa-user"></i></div>
                                <div class="iig-wardrobe-slot-content">
                                    <img class="iig-wardrobe-active-thumb" data-type="user" src="" style="display:none" alt="User outfit">
                                    <span class="iig-wardrobe-active-label" data-type="user">Не надето</span>
                                </div>
                            </div>
                        </div>

                        <div id="iig_open_wardrobe" class="menu_button iig-open-wardrobe-btn">
                            <i class="fa-solid fa-shirt"></i> Открыть гардероб
                        </div>

                        <div class="iig-section" style="margin-top:10px;padding:10px;">
                            <div class="flex-row">
                                <label for="sw_max_dim">Макс. размер фото (px)</label>
                                <input type="number" id="sw_max_dim" class="text_pole flex1"
                                       value="512" min="128" max="1024" step="64">
                            </div>
                            <div class="flex-row" style="margin-top:6px;">
                                <label>Очистить все аутфиты</label>
                                <div id="sw_clear_all" class="menu_button" style="color:#cc5555;">
                                    <i class="fa-solid fa-trash"></i> Очистить
                                </div>
                            </div>
                        </div>

                        <!-- Vision настройки для авто-описания аутфитов -->
                        <div class="iig-section" style="margin-top:10px;padding:10px;">
                            <h5 style="margin:0 0 4px;"><i class="fa-solid fa-eye"></i> Vision для авто-описания</h5>
                            <p class="hint" style="margin-bottom:8px;">
                                Отдельная vision-модель для анализа фото аутфитов.<br>
                                <b>Не используется для генерации картинок</b> — только для описания одежды.<br>
                                Подойдёт: <code>gpt-4o</code>, <code>gemini-2.0-flash</code>, <code>claude-3-5-sonnet</code>
                            </p>
                            <div class="flex-row">
                                <label for="sw_vision_endpoint" style="min-width:80px;">Endpoint</label>
                                <input type="text" id="sw_vision_endpoint" class="text_pole flex1"
                                       placeholder="https://api.openai.com">
                            </div>
                            <div class="flex-row" style="margin-top:4px;">
                                <label for="sw_vision_apikey" style="min-width:80px;">API Key</label>
                                <input type="password" id="sw_vision_apikey" class="text_pole flex1"
                                       placeholder="sk-...">
                                <div id="sw_vision_key_toggle" class="menu_button" style="padding:4px 8px;" title="Показать/скрыть">
                                    <i class="fa-solid fa-eye"></i>
                                </div>
                            </div>
                            <div class="flex-row" style="margin-top:4px;">
                                <label for="sw_vision_model" style="min-width:80px;">Модель</label>
                                <input type="text" id="sw_vision_model" class="text_pole flex1"
                                       placeholder="gpt-4o">
                            </div>
                            <div id="sw_vision_test" class="menu_button" style="margin-top:8px;width:100%;text-align:center;">
                                <i class="fa-solid fa-vial"></i> Тест Vision
                            </div>
                        </div>
                    </div>

                    <hr>

                    <!-- Retry Settings -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-rotate"></i> Настройки повтора</h4>
                        <div class="flex-row">
                            <label for="iig_max_retries">Макс. повторов</label>
                            <input type="number" id="iig_max_retries" class="text_pole flex1"
                                   value="${settings.maxRetries}" min="0" max="5">
                        </div>
                        <div class="flex-row">
                            <label for="iig_retry_delay">Задержка (мс)</label>
                            <input type="number" id="iig_retry_delay" class="text_pole flex1"
                                   value="${settings.retryDelay}" min="500" max="10000" step="500">
                        </div>
                        <p class="hint">Авто-повтор при ошибках 429/502/503/504. 0 = только ручной повтор.</p>
                    </div>

                    <hr>

                    <!-- Debug -->
                    <div class="iig-section">
                        <h4><i class="fa-solid fa-bug"></i> Отладка</h4>
                        <div id="iig_export_logs" class="menu_button iig-export-logs-btn">
                            <i class="fa-solid fa-download"></i> Экспорт логов
                        </div>
                    </div>

                    <p class="hint" style="text-align:center;opacity:0.5;margin-top:4px;">
                        v2.1.0 · <a href="https://github.com/aceeenvw/notsosillynotsoimages" target="_blank" style="color:inherit;text-decoration:underline;">aceeenvw</a> + wardrobe
                    </p>
                    <p id="iig_session_stats" class="hint" style="text-align:center;opacity:0.35;margin-top:2px;font-size:0.8em;"></p>
                </div>
            </div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', html);
    bindSettingsEvents();
    renderRefSlots();

    // Init wardrobe settings fields from saved settings
    const swSettings = SillyTavern.getContext().extensionSettings['silly_wardrobe'];
    if (swSettings) {
        const dimInput = document.getElementById('sw_max_dim');
        if (dimInput && swSettings.maxDimension) dimInput.value = swSettings.maxDimension;

        const epInput = document.getElementById('sw_vision_endpoint');
        if (epInput && swSettings.visionEndpoint) epInput.value = swSettings.visionEndpoint;

        const keyInput = document.getElementById('sw_vision_apikey');
        if (keyInput && swSettings.visionApiKey) keyInput.value = swSettings.visionApiKey;

        const modelInput = document.getElementById('sw_vision_model');
        if (modelInput && swSettings.visionModel) modelInput.value = swSettings.visionModel;
    }

    // Refresh wardrobe display
    if (window.sillyWardrobe?.refreshDisplay) {
        setTimeout(() => window.sillyWardrobe.refreshDisplay(), 300);
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

    document.getElementById('iig_enabled')?.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
        updateHeaderStatusDot();
    });
    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value;
        saveSettings();
        updateVisibility();
    });
    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => { settings.endpoint = e.target.value; saveSettings(); });

    document.querySelectorAll('.iig-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const url = btn.dataset.presetUrl;
            const type = btn.dataset.presetType;
            settings.endpoint = url;
            const input = document.getElementById('iig_endpoint');
            if (input) input.value = url;
            if (type) { settings.apiType = type; const sel = document.getElementById('iig_api_type'); if (sel) sel.value = type; updateVisibility(); }
            saveSettings();
            toastr.info(`Эндпоинт: ${url}`, 'Генерация картинок', { timeOut: 2000 });
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
        settings.model = e.target.value;
        saveSettings();
        if (isGeminiModel(e.target.value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
            updateVisibility();
        }
    });
    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            const cur = settings.model;
            select.innerHTML = '<option value="">-- Выберите модель --</option>';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m; opt.selected = m === cur;
                select.appendChild(opt);
            }
            toastr.success(`Найдено моделей: ${models.length}`, 'Генерация картинок');
        } catch (e) { toastr.error('Ошибка загрузки моделей', 'Генерация картинок'); }
        finally { btn.classList.remove('loading'); }
    });
    document.getElementById('iig_size')?.addEventListener('change', (e) => { settings.size = e.target.value; saveSettings(); });
    document.getElementById('iig_quality')?.addEventListener('change', (e) => { settings.quality = e.target.value; saveSettings(); });
    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => { settings.aspectRatio = e.target.value; saveSettings(); });
    document.getElementById('iig_image_size')?.addEventListener('change', (e) => { settings.imageSize = e.target.value; saveSettings(); });
    document.getElementById('iig_naistera_aspect_ratio')?.addEventListener('change', (e) => { settings.naisteraAspectRatio = e.target.value; saveSettings(); });
    document.getElementById('iig_naistera_preset')?.addEventListener('change', (e) => { settings.naisteraPreset = e.target.value; saveSettings(); });
    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        settings.maxRetries = Number.isNaN(v) ? 0 : Math.max(0, Math.min(5, v));
        saveSettings();
    });
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        settings.retryDelay = Number.isNaN(v) ? 1000 : Math.max(500, v);
        saveSettings();
    });
    document.getElementById('iig_export_logs')?.addEventListener('click', () => exportLogs());

    document.getElementById('iig_image_context_enabled')?.addEventListener('change', (e) => {
        settings.imageContextEnabled = e.target.checked;
        saveSettings();
        updateVisibility();
    });

    document.getElementById('iig_image_context_count')?.addEventListener('input', (e) => {
        const normalized = normalizeImageContextCount(e.target.value);
        settings.imageContextCount = normalized;
        e.target.value = String(normalized);
        saveSettings();
    });

    // Test connection
    document.getElementById('iig_test_connection')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (btn.classList.contains('testing')) return;
        btn.classList.add('testing');
        const icon = btn.querySelector('i');
        const origClass = icon.className;
        icon.className = 'fa-solid fa-spinner';
        try {
            if (!settings.endpoint || !settings.apiKey) throw new Error('Настройте эндпоинт и API ключ');
            if (settings.apiType === 'naistera') {
                const resp = await fetch(settings.endpoint.replace(/\/$/, ''), { method: 'HEAD' }).catch(() => null);
                toastr[resp?.ok ? 'success' : 'warning']('Соединение ' + (resp?.ok ? 'OK' : 'установлено (non-OK)'), 'Генерация картинок');
            } else {
                const models = await fetchModels();
                toastr.success(`OK — найдено ${models.length} моделей`, 'Генерация картинок');
            }
            btn.classList.add('test-success');
            setTimeout(() => btn.classList.remove('test-success'), 700);
        } catch (error) {
            toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
            btn.classList.add('test-fail');
            setTimeout(() => btn.classList.remove('test-fail'), 700);
        } finally { btn.classList.remove('testing'); icon.className = origClass; }
    });

    // Char/User ref slots
    bindRefSlotEvents();

    // NPC single slot
    bindNpcSlotEvent();

    // Wardrobe section
    document.getElementById('iig_open_wardrobe')?.addEventListener('click', () => {
        if (window.sillyWardrobe?.openModal) window.sillyWardrobe.openModal();
        else toastr.warning('Гардероб не инициализирован', 'Гардероб');
    });

    document.getElementById('sw_max_dim')?.addEventListener('change', (e) => {
        const ctx = SillyTavern.getContext();
        const s = ctx.extensionSettings['silly_wardrobe'];
        if (s) { s.maxDimension = Math.max(128, Math.min(1024, parseInt(e.target.value) || 512)); ctx.saveSettingsDebounced(); }
    });

    // ── Vision settings handlers ──
    document.getElementById('sw_vision_endpoint')?.addEventListener('input', (e) => {
        const ctx = SillyTavern.getContext();
        const s = ctx.extensionSettings['silly_wardrobe'];
        if (s) { s.visionEndpoint = e.target.value.trim(); ctx.saveSettingsDebounced(); }
    });
    document.getElementById('sw_vision_apikey')?.addEventListener('input', (e) => {
        const ctx = SillyTavern.getContext();
        const s = ctx.extensionSettings['silly_wardrobe'];
        if (s) { s.visionApiKey = e.target.value.trim(); ctx.saveSettingsDebounced(); }
    });
    document.getElementById('sw_vision_model')?.addEventListener('input', (e) => {
        const ctx = SillyTavern.getContext();
        const s = ctx.extensionSettings['silly_wardrobe'];
        if (s) { s.visionModel = e.target.value.trim(); ctx.saveSettingsDebounced(); }
    });
    document.getElementById('sw_vision_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('sw_vision_apikey');
        const icon = document.querySelector('#sw_vision_key_toggle i');
        if (!input) return;
        if (input.type === 'password') { input.type = 'text'; icon?.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { input.type = 'password'; icon?.classList.replace('fa-eye-slash', 'fa-eye'); }
    });
    document.getElementById('sw_vision_test')?.addEventListener('click', async () => {
        const btn = document.getElementById('sw_vision_test');
        const ctx = SillyTavern.getContext();
        const s = ctx.extensionSettings['silly_wardrobe'] || {};
        const endpoint = (s.visionEndpoint || '').trim().replace(/\/$/, '');
        const apiKey = (s.visionApiKey || '').trim();
        const model = (s.visionModel || '').trim();
        if (!endpoint || !apiKey || !model) {
            toastr.warning('Заполни Endpoint, API Key и Модель', 'Vision тест');
            return;
        }
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Тестирую...';
        try {
            const resp = await fetch(`${endpoint}/v1/models`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (resp.ok) {
                toastr.success(`Vision OK — endpoint доступен`, 'Vision тест', { timeOut: 3000 });
            } else {
                toastr.warning(`HTTP ${resp.status} — проверь настройки`, 'Vision тест');
            }
        } catch(e) {
            toastr.error('Ошибка: ' + e.message, 'Vision тест');
        }
        btn.innerHTML = '<i class="fa-solid fa-vial"></i> Тест Vision';
    });

    document.getElementById('sw_clear_all')?.addEventListener('click', () => {
        if (confirm('Удалить ВСЕ аутфиты для всех персонажей?')) {
            const ctx = SillyTavern.getContext();
            const s = ctx.extensionSettings['silly_wardrobe'];
            if (s) { s.wardrobes = {}; ctx.saveSettingsDebounced(); }
            toastr.info('Все аутфиты удалены', 'Гардероб');
            if (window.sillyWardrobe?.refreshDisplay) window.sillyWardrobe.refreshDisplay();
        }
    });

    updateVisibility();
}

function bindRefSlotEvents() {
    for (const slot of document.querySelectorAll('.iig-ref-slot[data-ref-type]')) {
        const refType = slot.dataset.refType;
        const npcIndex = parseInt(slot.dataset.npcIndex, 10);

        slot.querySelector('.iig-ref-name')?.addEventListener('input', (e) => {
            const s = getCurrentCharacterRefs();
            if (refType === 'char') s.charRef.name = e.target.value;
            else if (refType === 'user') s.userRef.name = e.target.value;
            else if (refType === 'npc') {
                if (!s.npcReferences[npcIndex]) s.npcReferences[npcIndex] = { name: '', imageBase64: '', imagePath: '' };
                s.npcReferences[npcIndex].name = e.target.value;
            }
            saveSettings();
        });

        slot.querySelector('.iig-ref-file-input')?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const rawBase64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result.split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
                const compressed = await compressBase64Image(rawBase64, 768, 0.8);

                // KEY FIX: save image as a real file on server, store only the path.
                // Storing base64 in extensionSettings bloats the JSON → silent save failure on mobile.
                const label = refType === 'npc' ? `npc${npcIndex}` : refType;
                const savedPath = await saveRefImageToFile(compressed, label);

                const s = getCurrentCharacterRefs();
                if (refType === 'char') {
                    s.charRef.imageBase64 = '';
                    s.charRef.imagePath = savedPath;
                } else if (refType === 'user') {
                    s.userRef.imageBase64 = '';
                    s.userRef.imagePath = savedPath;
                } else if (refType === 'npc') {
                    if (!s.npcReferences[npcIndex]) s.npcReferences[npcIndex] = { name: '', imageBase64: '', imagePath: '' };
                    s.npcReferences[npcIndex].imageBase64 = '';
                    s.npcReferences[npcIndex].imagePath = savedPath;
                }
                saveSettings();
                const thumb = slot.querySelector('.iig-ref-thumb');
                if (thumb) thumb.src = savedPath;
                iigLog('INFO', `Ref slot ${label}: saved to ${savedPath}`);
                toastr.success('Фото сохранено на сервере', 'Генерация картинок', { timeOut: 2000 });
            } catch (err) {
                const label = refType === 'npc' ? `NPC ${npcIndex}` : refType;
                iigLog('ERROR', `Ref slot ${label}: upload failed`, err.message);
                toastr.error('Ошибка загрузки фото', 'Генерация картинок');
            }
            e.target.value = '';
        });

        slot.querySelector('.iig-ref-delete-btn')?.addEventListener('click', () => {
            const s = getCurrentCharacterRefs();
            if (refType === 'char') s.charRef = { name: '', imageBase64: '', imagePath: '' };
            else if (refType === 'user') s.userRef = { name: '', imageBase64: '', imagePath: '' };
            else if (refType === 'npc') s.npcReferences[npcIndex] = { name: '', imageBase64: '', imagePath: '' };
            saveSettingsNow();
            const thumb = slot.querySelector('.iig-ref-thumb');
            if (thumb) thumb.src = '';
            const nameEl = slot.querySelector('.iig-ref-name');
            if (nameEl) nameEl.value = '';
            const label = refType === 'npc' ? `NPC ${npcIndex}` : refType;
            iigLog('INFO', `Ref slot ${label}: cleared`);
            toastr.info('Слот очищен', 'Генерация картинок', { timeOut: 2000 });
        });
    }
}

/* ── Lightbox ── */
function initLightbox() {
    if (document.getElementById('iig_lightbox')) return;
    const overlay = document.createElement('div');
    overlay.id = 'iig_lightbox';
    overlay.className = 'iig-lightbox';
    overlay.innerHTML = `
        <div class="iig-lightbox-backdrop"></div>
        <div class="iig-lightbox-content">
            <img class="iig-lightbox-img" src="" alt="Full-size preview">
            <div class="iig-lightbox-caption"></div>
            <button class="iig-lightbox-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>
        </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.classList.remove('open');
    overlay.querySelector('.iig-lightbox-backdrop').addEventListener('click', close);
    overlay.querySelector('.iig-lightbox-close').addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('open')) close(); });
    document.getElementById('chat')?.addEventListener('click', (e) => {
        const img = e.target.closest('.iig-generated-image');
        if (!img) return;
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
        dot = document.createElement('span');
        dot.className = 'iig-header-dot';
        const chevron = header.querySelector('.inline-drawer-icon');
        if (chevron) header.insertBefore(dot, chevron);
        else header.appendChild(dot);
    }
    dot.classList.toggle('active', settings.enabled);
    dot.title = settings.enabled ? 'Генерация включена' : 'Генерация выключена';
}

/* ── Init ── */
(function init() {
    const context = SillyTavern.getContext();
    iigLog('INFO', 'Initializing IIG + Wardrobe v2.1.0');
    iigLog('INFO', `Platform: ${IS_IOS ? 'iOS' : 'Desktop'}, Timeout: ${FETCH_TIMEOUT/1000}s`);
    getSettings();

    context.eventSource.on(context.event_types.APP_READY, () => {
        restoreRefsFromLocalStorage();
        createSettingsUI();
        addButtonsToExistingMessages();
        initLightbox();
        updateHeaderStatusDot();
        initMobileSaveListeners();
        setTimeout(() => { if (window.sillyWardrobe?.refreshDisplay) window.sillyWardrobe.refreshDisplay(); }, 500);
        iigLog('INFO', 'IIG + Wardrobe extension loaded');
    });

    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            restoreRefsFromLocalStorage();
            addButtonsToExistingMessages();
            renderRefSlots();
            if (window.sillyWardrobe?.refreshDisplay) window.sillyWardrobe.refreshDisplay();
        }, 300);
    });

    const handleMessage = async (messageId) => {
        iigLog('INFO', `Event: message ${messageId}`);
        await onMessageReceived(messageId);
    };

    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, handleMessage);
    iigLog('INFO', 'IIG + Wardrobe initialized');

   /**
 * ════════════════════════════════════════════════════════════════════
 * Wardrobe Description Panel — Companion Module
 *
 * Добавляет панель описания одежды в модалку гардероба:
 * - Textarea с текущим описанием
 * - Кнопка «Сгенерировать» через Vision AI
 * - Кнопка «Сохранить»
 * - Кнопка «Очистить»
 * - Бейдж на карточках у которых есть описание
 *
 * Загружается ПОСЛЕ основного index.js.
 * НЕ модифицирует оригинальный код гардероба.
 * ════════════════════════════════════════════════════════════════════
 */

(function initWardrobeDescPanel() {
    'use strict';

    const SWD_TAG = '[SW-Desc]';

    function log(...args) { console.log(SWD_TAG, ...args); }

    // ── Access wardrobe data via extension settings ──

    function getSwSettings() {
        return SillyTavern.getContext().extensionSettings?.['silly_wardrobe'] || {};
    }

    function saveSwSettings() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    function getCharName() {
        const ctx = SillyTavern.getContext();
        if (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]) {
            return ctx.characters[ctx.characterId].name || '';
        }
        return '';
    }

    function getActiveTab() {
        const activeTab = document.querySelector('#sw-modal .sw-tab.sw-tab-active');
        return activeTab?.dataset?.tab || 'bot';
    }

    function getWardrobe(charName) {
        const s = getSwSettings();
        return s.wardrobes?.[charName] || { bot: [], user: [] };
    }

    function getActiveOutfitId(charName, type) {
        const s = getSwSettings();
        return s.activeOutfits?.[charName]?.[type] || null;
    }

    function findOutfit(charName, type, id) {
        const w = getWardrobe(charName);
        return (w[type] || []).find(o => o.id === id) || null;
    }

    function sanitize(text) {
        const d = document.createElement('div');
        d.textContent = text || '';
        return d.innerHTML;
    }

    // ── Vision API analysis (reuses silly_wardrobe settings) ──

    function cleanOutfitDesc(raw) {
        if (!raw) return null;
        let s = raw;
        s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
        s = s.replace(/<[^>]+>/g, '');
        s = s.replace(/<!--[\s\S]*?-->/g, '');
        s = s.replace(/\[OOC:[^\]]*\]/gi, '');
        s = s.replace(/\[[^\]]*_SCORE[^\]]*\]/gi, '');
        s = s.replace(/\[CYCLE_DAY[^\]]*\]/gi, '');
        s = s.replace(/\[LOVE_SCORE[^\]]*\]/gi, '');
        s = s.split('\n').filter(line => {
            const l = line.toLowerCase();
            return !l.includes('scene_desc') && !l.includes('atmosphere') &&
                   !l.includes('location:') && !l.includes('characters:') &&
                   !l.includes('costume:') && !l.includes('event:') &&
                   !l.includes('bgm>') && !l.includes('horae') &&
                   !l.includes('[cycle_') && !l.match(/^\s*\*/);
        }).join(' ');
        s = s.replace(/\*[^*]+\*/g, '').replace(/_[^_]+_/g, '');
        s = s.replace(/\s+/g, ' ').trim();
        const sentences = s.match(/[^.!?]+[.!?]+/g);
        if (sentences && sentences.length > 2) s = sentences.slice(0, 2).join(' ').trim();
        return s.length >= 15 ? s : null;
    }

    async function analyzeOutfitVision(base64) {
        const swS = getSwSettings();
        const endpoint = (swS.visionEndpoint || '').trim().replace(/\/$/, '');
        const apiKey   = (swS.visionApiKey  || '').trim();
        const model    = (swS.visionModel   || '').trim();

        if (!endpoint || !apiKey || !model) {
            toastr.warning(
                'Укажи Vision endpoint / API key / модель в настройках Гардероба для авто-описания.',
                'Гардероб', { timeOut: 6000 }
            );
            return null;
        }

        const imageDataUrl = `data:image/jpeg;base64,${base64}`;
        const analyzePrompt = 'Describe the outfit/clothing visible in the attached image in 1-2 concise sentences in English. Focus ONLY on garments, colors, fabrics, accessories, shoes. Do NOT describe the person, background, or pose.';

        try {
            const response = await fetch(`${endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model,
                    max_tokens: 200,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'image_url', image_url: { url: imageDataUrl } },
                            { type: 'text', text: analyzePrompt },
                        ],
                    }],
                }),
            });

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                log('Vision API error:', response.status, errText.substring(0, 200));
                toastr.error(`Vision API ошибка ${response.status}`, 'Гардероб', { timeOut: 4000 });
                return null;
            }

            const data = await response.json();
            const raw = data?.choices?.[0]?.message?.content;
            return cleanOutfitDesc(raw);

        } catch (e) {
            log('Vision API fetch failed:', e.message);
            toastr.error('Ошибка Vision API: ' + e.message, 'Гардероб', { timeOut: 4000 });
            return null;
        }
    }

    // ── Description panel injection ──

    function injectDescPanel(container) {
        const charName = getCharName();
        if (!charName) return;

        const tab = getActiveTab();
        const activeId = getActiveOutfitId(charName, tab);
        if (!activeId) {
            // Remove existing panel if no active outfit
            container.querySelector('.sw-desc-panel')?.remove();
            return;
        }

        const outfit = findOutfit(charName, tab, activeId);
        if (!outfit) return;

        // Don't duplicate
        const existing = container.querySelector('.sw-desc-panel');
        if (existing && existing.dataset.outfitId === activeId) return;
        existing?.remove();

        const panel = document.createElement('div');
        panel.className = 'sw-desc-panel';
        panel.dataset.outfitId = activeId;
        panel.innerHTML = `
            <div class="sw-desc-header">
                <i class="fa-solid fa-file-lines"></i>
                <span>Описание: <b>${sanitize(outfit.name)}</b></span>
            </div>
            <textarea class="sw-desc-textarea" id="swd-textarea" rows="3"
                      placeholder="Введите описание одежды вручную или сгенерируйте через AI...">${sanitize(outfit.description || '')}</textarea>
            <div class="sw-desc-actions">
                <div class="menu_button sw-desc-generate" id="swd-generate" title="Сгенерировать описание через Vision AI">
                    <i class="fa-solid fa-robot"></i> Сгенерировать
                </div>
                <div class="menu_button sw-desc-save" id="swd-save">
                    <i class="fa-solid fa-floppy-disk"></i> Сохранить
                </div>
                <div class="menu_button sw-desc-clear" id="swd-clear">
                    <i class="fa-solid fa-eraser"></i>
                </div>
            </div>
            <div class="sw-desc-status" id="swd-status" style="display:none;"></div>
        `;

        // Insert after the grid
        const grid = container.querySelector('.sw-outfit-grid');
        if (grid) {
            grid.after(panel);
        } else {
            container.appendChild(panel);
        }

        // ── Event handlers ──

        const textarea = panel.querySelector('#swd-textarea');
        const statusEl = panel.querySelector('#swd-status');

        // Save on blur
        textarea.addEventListener('blur', () => {
            const newDesc = textarea.value.trim();
            if (newDesc !== (outfit.description || '').trim()) {
                outfit.description = newDesc;
                saveSwSettings();
                window.sillyWardrobe?.updatePromptInjection?.();
            }
        });

        // Save button
        panel.querySelector('#swd-save')?.addEventListener('click', () => {
            outfit.description = textarea.value.trim();
            saveSwSettings();
            window.sillyWardrobe?.updatePromptInjection?.();
            refreshInfoBar(outfit);
            injectDescBadges(container, charName, tab);
            toastr.success('Описание сохранено', 'Гардероб', { timeOut: 2000 });
        });

        // Clear button
        panel.querySelector('#swd-clear')?.addEventListener('click', () => {
            textarea.value = '';
            outfit.description = '';
            saveSwSettings();
            window.sillyWardrobe?.updatePromptInjection?.();
            refreshInfoBar(outfit);
            injectDescBadges(container, charName, tab);
            toastr.info('Описание очищено', 'Гардероб', { timeOut: 2000 });
        });

        // Generate via Vision AI
        panel.querySelector('#swd-generate')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            if (btn.classList.contains('disabled')) return;

            btn.classList.add('disabled');
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Генерация...';
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.textContent = 'Отправка изображения в Vision API...';
                statusEl.className = 'sw-desc-status sw-desc-info';
            }

            try {
                const desc = await analyzeOutfitVision(outfit.base64);
                if (desc) {
                    textarea.value = desc;
                    outfit.description = desc;
                    saveSwSettings();
                    window.sillyWardrobe?.updatePromptInjection?.();
                    if (statusEl) {
                        statusEl.textContent = 'Описание сгенерировано!';
                        statusEl.className = 'sw-desc-status sw-desc-success';
                    }
                    refreshInfoBar(outfit);
                    injectDescBadges(container, charName, tab);
                    toastr.success('Описание сгенерировано через AI', 'Гардероб', { timeOut: 2500 });
                } else {
                    if (statusEl) {
                        statusEl.textContent = 'Vision API вернул пустой ответ. Проверь настройки Vision.';
                        statusEl.className = 'sw-desc-status sw-desc-error';
                    }
                }
            } catch (error) {
                log('Desc generation failed:', error);
                if (statusEl) {
                    statusEl.textContent = `Ошибка: ${error.message}`;
                    statusEl.className = 'sw-desc-status sw-desc-error';
                }
            } finally {
                btn.classList.remove('disabled');
                btn.innerHTML = '<i class="fa-solid fa-robot"></i> Сгенерировать';
                setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 5000);
            }
        });
    }

    // ── Inject description badges on cards that have descriptions ──

    function injectDescBadges(container, charName, tab) {
        if (!container) return;
        const wardrobe = getWardrobe(charName);
        const outfits = wardrobe[tab] || [];

        for (const card of container.querySelectorAll('.sw-outfit-card[data-id]')) {
            const id = card.dataset.id;
            const outfit = outfits.find(o => o.id === id);
            const imgWrap = card.querySelector('.sw-outfit-img-wrap');
            if (!imgWrap) continue;

            // Remove existing badge
            imgWrap.querySelector('.sw-desc-badge')?.remove();

            // Add badge if has description
            if (outfit?.description) {
                const badge = document.createElement('div');
                badge.className = 'sw-desc-badge';
                badge.title = 'Есть описание';
                badge.innerHTML = '<i class="fa-solid fa-file-lines"></i>';
                imgWrap.appendChild(badge);
            }
        }
    }

    // ── Refresh info bar without full re-render ──

    function refreshInfoBar(outfit) {
        const infoBar = document.getElementById('sw-active-info');
        if (!infoBar || !outfit) return;
        infoBar.innerHTML = `<i class="fa-solid fa-check" style="color:#6ee7b7;margin-right:6px"></i>Активно: <b style="margin-left:4px">${sanitize(outfit.name)}</b>${outfit.description ? ` — <i>${sanitize(outfit.description)}</i>` : ''}`;
        infoBar.classList.add('sw-active-visible');
    }

    // ── MutationObserver to detect modal content changes ──

    let observer = null;

    function startObserving() {
        if (observer) return;

        observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                // Detect sw-tab-content being populated
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;

                    // Modal appeared
                    if (node.id === 'sw-modal-overlay' || node.querySelector?.('#sw-modal')) {
                        setTimeout(onModalOpened, 50);
                    }

                    // Tab content changed (cards rendered)
                    if (node.classList?.contains('sw-outfit-grid')) {
                        setTimeout(() => onTabContentChanged(node.parentElement), 30);
                    }
                }

                // Also check if the target itself is the tab content
                if (mutation.target.id === 'sw-tab-content') {
                    setTimeout(() => onTabContentChanged(mutation.target), 30);
                }
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });

        log('MutationObserver started');
    }

    function onModalOpened() {
        const container = document.getElementById('sw-tab-content');
        if (container) {
            onTabContentChanged(container);
        }
    }

    function onTabContentChanged(container) {
        if (!container) return;
        const charName = getCharName();
        if (!charName) return;
        const tab = getActiveTab();

        // Inject description badges
        injectDescBadges(container, charName, tab);

        // Inject description panel for active outfit
        injectDescPanel(container);
    }

    // ── Init ──

    function init() {
        startObserving();
        log('Wardrobe Description Panel companion loaded');
    }

    // Wait for APP_READY or start immediately if already loaded
    if (window.sillyWardrobe?.isReady?.()) {
        init();
    } else {
        const ctx = SillyTavern.getContext();
        ctx.eventSource.on(ctx.event_types.APP_READY, () => setTimeout(init, 600));
    }

})();
