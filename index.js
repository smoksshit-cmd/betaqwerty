// ═══════════════════════════════════════════════════════════════════
// Avatar Gallery — SillyTavern Extension v1.0
// Галерея аватаров для персон и персонажей с навигацией в зуме
// ═══════════════════════════════════════════════════════════════════

import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    power_user,
    eventSource,
    event_types,
} from '../../../../script.js';

const EXT = 'avatarGallery';
const log = (...a) => console.log('[AvatarGallery]', ...a);

// ── Настройки ─────────────────────────────────────────────────────────────────
if (!extension_settings[EXT]) extension_settings[EXT] = {};
const S = extension_settings[EXT];
if (!S.personas)   S.personas   = {};
if (!S.characters) S.characters = {};
// Структура: S.personas[name]   = { images: [base64, ...], current: 0 }
//            S.characters[file] = { images: [base64, ...], current: 0, _cur: base64|null }

const save = () => saveSettingsDebounced();

const getGallery = (type, key) => {
    if (!S[type][key]) S[type][key] = { images: [], current: 0 };
    return S[type][key];
};
const gLen = (type, key) => S[type]?.[key]?.images?.length ?? 0;

// ── File → base64 ─────────────────────────────────────────────────────────────
const toB64 = file => new Promise((ok, err) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = err;
    r.readAsDataURL(file);
});

// ── Normalise avatar filename ──────────────────────────────────────────────────
const normAvatar = str => (str || '').split('/').pop().split('?')[0];

// ── Apply persona avatar ───────────────────────────────────────────────────────
const applyPersona = (key, src) => {
    // Обновляем power_user.personas
    if (power_user?.personas?.[key]) {
        power_user.personas[key].avatar = src;
        save();
    }
    // Обновляем аватар в сообщениях пользователя
    document.querySelectorAll('.mes[is_user="true"] .mes_img, .mes[is_user="true"] img.avatar')
        .forEach(img => { img.src = src; });
    // Обновляем превью в панели управления персонами
    document.querySelectorAll(
        `[data-name="${CSS.escape(key)}"] img,
         .persona_item[title="${key}"] img,
         .persona_name_block:has(>[title="${key}"]) img`
    ).forEach(img => { img.src = src; });
    // Аватар пользователя в правой панели
    document.querySelectorAll('#user_avatar_block img, .user_avatar img').forEach(img => { img.src = src; });
    log('Persona avatar applied:', key);
};

// ── Apply character avatar (DOM override) ─────────────────────────────────────
const applyChar = (key, src) => {
    getGallery('characters', key)._cur = src;
    save();
    reapplyChars();
    log('Character avatar applied:', key);
};

const reapplyChars = () => {
    for (const [k, d] of Object.entries(S.characters)) {
        if (!d._cur) continue;
        document.querySelectorAll(`img[src*="${k}"]`).forEach(img => {
            // Не трогаем уже применённые base64
            if (img.src !== d._cur) img.src = d._cur;
        });
    }
};

// ── Определяем контекст зума (что за аватар кликнули) ─────────────────────────
let _zCtx = null; // { type: 'personas'|'characters', key: string }

const detectZoomCtx = img => {
    // Сообщение в чате
    const mes = img.closest('.mes');
    if (mes) {
        if (mes.getAttribute('is_user') === 'true') {
            const pName = power_user?.persona;
            if (pName) { _zCtx = { type: 'personas', key: pName }; return; }
        } else {
            const ctx = getContext();
            const char = ctx?.characters?.[ctx?.characterId];
            const av = normAvatar(char?.avatar);
            if (av) { _zCtx = { type: 'characters', key: av }; return; }
        }
    }
    // Персона в списке персон
    const pi = img.closest('[data-name], .persona_item, [data-persona]');
    if (pi) {
        const n = pi.dataset.name || pi.dataset.persona
               || pi.getAttribute('title')
               || pi.querySelector('.persona_name')?.textContent?.trim();
        if (n) { _zCtx = { type: 'personas', key: n }; return; }
    }
    // Аватар персонажа в правой панели (rm_info_avatar, character sheet)
    const charPanel = img.closest('#rm_info_block, #character_info_block, .character_edit_block');
    if (charPanel) {
        const ctx = getContext();
        const char = ctx?.characters?.[ctx?.characterId];
        const av = normAvatar(char?.avatar);
        if (av) { _zCtx = { type: 'characters', key: av }; return; }
    }
};

// Слушаем клики в capture-фазе (раньше ST)
document.addEventListener('click', e => {
    const img = e.target.closest(
        '.mes_img, .mes_img_container img, img.avatar, ' +
        '.persona_avatar img, .persona_item img, ' +
        '#rm_info_avatar img, #character_avatar_block img, .character_avatar_block img'
    );
    if (img) detectZoomCtx(img);
}, true);

// ── Скрытый input для загрузки файлов ─────────────────────────────────────────
const fileInput = document.createElement('input');
fileInput.type     = 'file';
fileInput.accept   = 'image/*';
fileInput.multiple = true;
fileInput.style.display = 'none';
document.body.append(fileInput);

// ── Модальное окно галереи ─────────────────────────────────────────────────────
const modal = document.createElement('div');
modal.className = 'avga-modal';
modal.innerHTML = `
<div class="avga-box">
    <div class="avga-header">
        <span class="avga-title">Галерея аватаров</span>
        <button class="avga-close" title="Закрыть">✕</button>
    </div>
    <p class="avga-hint">Нажми на фото, чтобы сделать его активным. В зуме появятся стрелки ‹ ›.</p>
    <div class="avga-grid"></div>
</div>`;
modal.querySelector('.avga-close').addEventListener('click', () => modal.classList.remove('avga-open'));
modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('avga-open'); });
document.body.append(modal);

let _mCtx = null;

const openModal = (type, key) => {
    _mCtx = { type, key };
    // Также обновляем _zCtx чтобы зум-навигация знала контекст
    _zCtx = { type, key };
    renderModal();
    modal.classList.add('avga-open');
};

const renderModal = () => {
    const { type, key } = _mCtx;
    const g = getGallery(type, key);
    const title = type === 'personas' ? `Персона: ${key}` : `Персонаж: ${key}`;
    modal.querySelector('.avga-title').textContent = title;
    const grid = modal.querySelector('.avga-grid');
    grid.innerHTML = '';

    g.images.forEach((src, i) => {
        const cell = document.createElement('div');
        cell.className = 'avga-cell' + (i === g.current ? ' avga-active' : '');

        const img = document.createElement('img');
        img.src = src;
        img.loading = 'lazy';
        img.alt = `Аватар ${i + 1}`;
        img.addEventListener('click', () => selectImg(type, key, i));

        const badge = document.createElement('span');
        badge.className = 'avga-badge';
        badge.textContent = i === g.current ? '✓ Активный' : `${i + 1}`;

        const del = document.createElement('button');
        del.className = 'avga-del';
        del.textContent = '×';
        del.title = 'Удалить';
        del.addEventListener('click', e => { e.stopPropagation(); deleteImg(type, key, i); });

        cell.append(img, badge, del);
        grid.append(cell);
    });

    // Ячейка «добавить»
    const addCell = document.createElement('div');
    addCell.className = 'avga-cell avga-add';
    addCell.innerHTML = '<span>+</span><small>Добавить</small>';
    addCell.title = 'Загрузить изображение';
    addCell.addEventListener('click', () => {
        fileInput.onchange = async () => {
            for (const f of fileInput.files) {
                g.images.push(await toB64(f));
            }
            save();
            renderModal();
            updateZoomNav();
            fileInput.value = '';
        };
        fileInput.click();
    });
    grid.append(addCell);
};

const selectImg = (type, key, idx) => {
    const g = getGallery(type, key);
    g.current = idx;
    save();
    const src = g.images[idx];
    if (type === 'personas') applyPersona(key, src);
    else applyChar(key, src);
    renderModal();
    updateZoomNav();
};

const deleteImg = (type, key, idx) => {
    const g = getGallery(type, key);
    g.images.splice(idx, 1);
    if (g._cur && idx === g.current) g._cur = null;
    g.current = Math.max(0, Math.min(g.current, g.images.length - 1));
    save();
    renderModal();
    updateZoomNav();
};

// ── Навигация в зуме ───────────────────────────────────────────────────────────
const zoomNav = document.createElement('div');
zoomNav.className = 'avga-zoom-nav';
zoomNav.hidden = true;
zoomNav.innerHTML = `
    <button class="avga-zb avga-prev" title="Предыдущий аватар">‹</button>
    <span class="avga-counter"></span>
    <button class="avga-zb avga-next" title="Следующий аватар">›</button>
    <button class="avga-zb avga-gal" title="Открыть галерею">🖼</button>`;

const navigate = dir => {
    if (!_zCtx) return;
    const { type, key } = _zCtx;
    const g = getGallery(type, key);
    if (!g.images.length) return;
    g.current = (g.current + dir + g.images.length) % g.images.length;
    save();
    const src = g.images[g.current];
    // Обновляем зум-изображение
    const ZOOM_IMG_SEL = [
        '.zoomed_avatar_content img',
        '.zoomed_avatar img',
        '#zoom_portrait',
        '#character_popup img',
        '.avatar_zoom img',
    ].join(', ');
    const zImg = document.querySelector(ZOOM_IMG_SEL);
    if (zImg) zImg.src = src;
    // Применяем в чате
    if (type === 'personas') applyPersona(key, src);
    else applyChar(key, src);
    updateZoomNav();
};

zoomNav.querySelector('.avga-prev').addEventListener('click', e => { e.stopPropagation(); navigate(-1); });
zoomNav.querySelector('.avga-next').addEventListener('click', e => { e.stopPropagation(); navigate(1); });
zoomNav.querySelector('.avga-gal').addEventListener('click', e => {
    e.stopPropagation();
    if (_zCtx) openModal(_zCtx.type, _zCtx.key);
});

const updateZoomNav = () => {
    if (!_zCtx) { zoomNav.hidden = true; return; }
    const { type, key } = _zCtx;
    const g = S[type]?.[key];
    const total = g?.images?.length ?? 0;
    const cur = g?.current ?? 0;
    zoomNav.hidden = total < 1;
    zoomNav.querySelector('.avga-counter').textContent =
        total > 0 ? `${cur + 1} / ${total}` : '';
};

// ── Вставляем зум-навигацию в контейнер зума ──────────────────────────────────
const ZOOM_CONTAINER_SEL = [
    '.zoomed_avatar',
    '.zoomed_avatar_content',
    '#zoom_portrait',
    '#character_popup',
    '.avatar_zoom',
    '.avatar_zoom_modal',
].join(', ');

const attachZoomNav = () => {
    const el = document.querySelector(ZOOM_CONTAINER_SEL);
    if (el && !el.contains(zoomNav)) {
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        el.append(zoomNav);
        updateZoomNav();
        log('Zoom nav attached to', el.className || el.id);
    }
};

new MutationObserver(attachZoomNav).observe(document.body, { childList: true, subtree: true });

// ── Кнопки «🖼» рядом с аватарками ────────────────────────────────────────────
const injectBtn = (container, type, key, small = false) => {
    const safeKey = key.replace(/[^a-z0-9_-]/gi, '_');
    const btnId = `avga-btn-${type}-${safeKey}`;
    if (document.getElementById(btnId)) return;
    const btn = document.createElement('button');
    btn.id = btnId;
    btn.className = 'avga-btn' + (small ? ' avga-btn-sm' : '');
    btn.textContent = '🖼';
    btn.title = `Галерея аватаров (${gLen(type, key)} фото)`;
    btn.addEventListener('click', e => {
        e.stopPropagation();
        e.preventDefault();
        openModal(type, key);
    });
    container.append(btn);
};

// ── Внедрение в список персон ──────────────────────────────────────────────────
const injectPersonaBtns = () => {
    if (!power_user?.personas) return;
    // Пробуем разные селекторы — зависит от версии ST
    const PERSONA_ITEM_SEL = '.persona_item, [data-persona], #persona_management_list > div';
    document.querySelectorAll(PERSONA_ITEM_SEL).forEach(item => {
        if (item.querySelector('.avga-btn')) return;
        const name =
            item.dataset.name    ||
            item.dataset.persona ||
            item.getAttribute('title') ||
            item.querySelector('.persona_name, .name_text')?.textContent?.trim();
        if (!name || !power_user.personas[name]) return;
        injectBtn(item, 'personas', name, true);
    });
};

// ── Внедрение в карточку персонажа ────────────────────────────────────────────
const injectCharBtn = () => {
    const ctx = getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char?.avatar) return;
    const key = normAvatar(char.avatar);
    const CHAR_AVATAR_SEL = '#avatar_div, #rm_info_avatar, .avatar_container, #character_avatar_block, .character_avatar_block';
    const container = document.querySelector(CHAR_AVATAR_SEL);
    if (!container || container.querySelector('.avga-btn')) return;
    injectBtn(container, 'characters', key);
};

// ── Наблюдаем за списком персон (он рендерится динамически) ───────────────────
const observePersonaList = () => {
    const PERSONA_LIST_SEL = '#persona_management_list, #personas_list, .personas_list, .persona_management';
    const list = document.querySelector(PERSONA_LIST_SEL);
    if (list) {
        new MutationObserver(injectPersonaBtns).observe(list, { childList: true, subtree: true });
        injectPersonaBtns();
        log('Persona list observer attached');
    }
};

// ── Наблюдаем за правой панелью персонажа ─────────────────────────────────────
const observeCharPanel = () => {
    const panel = document.querySelector('#right-nav-panel, #rm_info_block, #character_info_block');
    if (panel) {
        new MutationObserver(injectCharBtn).observe(panel, { childList: true, subtree: true });
    }
};

// ── События ST ────────────────────────────────────────────────────────────────
const tryOn = (evtName, fn) => {
    try {
        if (event_types[evtName]) eventSource.on(event_types[evtName], fn);
    } catch(e) {
        log(`Event ${evtName} not available:`, e.message);
    }
};

tryOn('CHARACTER_SELECTED',  () => { injectCharBtn(); reapplyChars(); });
tryOn('CHARACTER_EDITED',    () => { injectCharBtn(); });
tryOn('CHAT_CHANGED',        () => { injectPersonaBtns(); injectCharBtn(); reapplyChars(); });
tryOn('USER_MESSAGE_RENDERED', reapplyChars);
tryOn('LLM_MESSAGE_RENDERED',  reapplyChars);
tryOn('MESSAGE_EDITED',        reapplyChars);

// ── Инициализация ─────────────────────────────────────────────────────────────
const init = () => {
    log('Loading...');
    observePersonaList();
    observeCharPanel();
    injectPersonaBtns();
    injectCharBtn();
    reapplyChars();
    // Повторная попытка через 1.5s и 4s — ST рендерит часть UI с задержкой
    setTimeout(() => {
        observePersonaList();
        observeCharPanel();
        injectPersonaBtns();
        injectCharBtn();
    }, 1500);
    setTimeout(() => {
        injectPersonaBtns();
        injectCharBtn();
    }, 4000);
    log('Loaded ✅');
};

init();
