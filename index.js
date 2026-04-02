// ═══════════════════════════════════════════════════════════════════
// Avatar Gallery — SillyTavern Extension v1.1
// Панель в Extensions + галерея аватаров + навигация в зуме
// ═══════════════════════════════════════════════════════════════════

import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    power_user,
    eventSource,
    event_types,
} from '../../../../script.js';

const EXT   = 'avatarGallery';
const LOG   = (...a) => console.log('[AvatarGallery]', ...a);
const FOLDER = 'third-party/avatar-gallery';

// ── Настройки ─────────────────────────────────────────────────────
if (!extension_settings[EXT])   extension_settings[EXT]   = {};
const S = extension_settings[EXT];
if (!S.personas)   S.personas   = {};
if (!S.characters) S.characters = {};
const save = () => saveSettingsDebounced();

// gallery(type, key) → { images: [base64,...], current: 0 }
const getGal = (type, key) => {
    if (!S[type][key]) S[type][key] = { images: [], current: 0 };
    return S[type][key];
};
const galLen = (type, key) => S[type]?.[key]?.images?.length ?? 0;

// ── Helpers ────────────────────────────────────────────────────────
const toB64 = file => new Promise((ok, err) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = err;
    r.readAsDataURL(file);
});
const normAv = str => (str || '').split('/').pop().split('?')[0];

// ── Apply avatar to DOM ────────────────────────────────────────────
const applyPersona = (key, src) => {
    if (power_user?.personas?.[key]) {
        power_user.personas[key].avatar = src;
        save();
    }
    document.querySelectorAll('.mes[is_user="true"] .mes_img, .mes[is_user="true"] img.avatar')
        .forEach(i => { i.src = src; });
    document.querySelectorAll(`[data-name="${CSS.escape(key)}"] img, .persona_item[title="${CSS.escape(key)}"] img`)
        .forEach(i => { i.src = src; });
};
const applyChar = (key, src) => {
    getGal('characters', key)._cur = src;
    save();
    reapplyChars();
};
const reapplyChars = () => {
    for (const [k, d] of Object.entries(S.characters)) {
        if (!d._cur) continue;
        document.querySelectorAll(`img[src*="${k}"]`).forEach(img => {
            if (img.src !== d._cur) img.src = d._cur;
        });
    }
};

// ── Zoom context ───────────────────────────────────────────────────
let _zCtx = null;
const detectZoomCtx = img => {
    const mes = img.closest('.mes');
    if (mes) {
        if (mes.getAttribute('is_user') === 'true') {
            const n = power_user?.persona;
            if (n) { _zCtx = { type: 'personas', key: n }; return; }
        } else {
            const ctx = getContext();
            const av = normAv(ctx?.characters?.[ctx?.characterId]?.avatar);
            if (av) { _zCtx = { type: 'characters', key: av }; return; }
        }
    }
};
document.addEventListener('click', e => {
    const img = e.target.closest('.mes_img, .mes_img_container img, img.avatar');
    if (img) detectZoomCtx(img);
}, true);

// ── File input ─────────────────────────────────────────────────────
const mkFileInput = (onFiles) => {
    const fi = Object.assign(document.createElement('input'), {
        type: 'file', accept: 'image/*', multiple: true
    });
    fi.style.display = 'none';
    document.body.append(fi);
    fi.addEventListener('change', async () => {
        for (const f of fi.files) await onFiles(await toB64(f));
        fi.value = '';
    });
    return fi;
};

// ══════════════════════════════════════════════════════════════════
// SETTINGS PANEL (вставляется в #extensions_settings)
// ══════════════════════════════════════════════════════════════════
const buildSettingsPanel = () => {
    const wrap = document.createElement('div');
    wrap.id = 'avga-settings';
    wrap.innerHTML = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>🖼 Avatar Gallery</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content">

            <!-- ── Персоны ── -->
            <div class="avga-section">
                <div class="avga-section-title">👤 Персоны</div>
                <div class="avga-row">
                    <label class="avga-label">Персона:</label>
                    <select id="avga-persona-sel" class="avga-select text_pole"></select>
                </div>
                <div class="avga-strip" id="avga-strip-persona"></div>
                <div class="avga-row avga-row-actions">
                    <button id="avga-persona-add" class="menu_button">+ Добавить фото</button>
                    <span class="avga-count" id="avga-persona-count">0 фото</span>
                </div>
            </div>

            <hr class="avga-hr"/>

            <!-- ── Персонажи ── -->
            <div class="avga-section">
                <div class="avga-section-title">🤖 Персонаж</div>
                <div class="avga-row">
                    <label class="avga-label">Персонаж:</label>
                    <select id="avga-char-sel" class="avga-select text_pole"></select>
                </div>
                <div class="avga-strip" id="avga-strip-char"></div>
                <div class="avga-row avga-row-actions">
                    <button id="avga-char-add" class="menu_button">+ Добавить фото</button>
                    <span class="avga-count" id="avga-char-count">0 фото</span>
                </div>
            </div>

        </div>
    </div>`;

    // ── Populate persona selector ──────────────────────────────────
    const personaSel = wrap.querySelector('#avga-persona-sel');
    const populatePersonas = () => {
        const current = personaSel.value;
        personaSel.innerHTML = '';
        const personas = power_user?.personas ?? {};
        if (!Object.keys(personas).length) {
            personaSel.innerHTML = '<option value="">— нет персон —</option>';
        } else {
            for (const name of Object.keys(personas)) {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                personaSel.append(opt);
            }
            if (current && [...personaSel.options].find(o => o.value === current))
                personaSel.value = current;
        }
        renderPersonaStrip();
    };
    personaSel.addEventListener('change', renderPersonaStrip);

    // ── Populate character selector ────────────────────────────────
    const charSel = wrap.querySelector('#avga-char-sel');
    const populateChars = () => {
        const current = charSel.value;
        charSel.innerHTML = '';
        const ctx = getContext();
        const chars = ctx?.characters ?? [];
        if (!chars.length) {
            charSel.innerHTML = '<option value="">— нет персонажей —</option>';
        } else {
            chars.forEach(ch => {
                const key = normAv(ch.avatar);
                const opt = document.createElement('option');
                opt.value = key;
                opt.textContent = ch.name || key;
                charSel.append(opt);
            });
            // Default: current character
            const curChar = ctx?.characters?.[ctx?.characterId];
            const curKey  = normAv(curChar?.avatar);
            if (curKey) charSel.value = curKey;
            else if (current && [...charSel.options].find(o => o.value === current))
                charSel.value = current;
        }
        renderCharStrip();
    };
    charSel.addEventListener('change', renderCharStrip);

    // ── Strip renderer ────────────────────────────────────────────
    const renderStrip = (type, key, stripEl, countEl) => {
        stripEl.innerHTML = '';
        if (!key) return;
        const g = getGal(type, key);
        countEl.textContent = `${g.images.length} фото`;

        g.images.forEach((src, i) => {
            const thumb = document.createElement('div');
            thumb.className = 'avga-thumb' + (i === g.current ? ' avga-thumb-active' : '');
            thumb.title = i === g.current ? 'Активный' : `Фото ${i + 1}`;

            const img = document.createElement('img');
            img.src = src;
            img.loading = 'lazy';
            img.addEventListener('click', () => {
                g.current = i;
                save();
                if (type === 'personas') applyPersona(key, src);
                else applyChar(key, src);
                renderStrip(type, key, stripEl, countEl);
                updateZoomNav();
            });

            const del = document.createElement('button');
            del.className = 'avga-del';
            del.textContent = '×';
            del.title = 'Удалить';
            del.addEventListener('click', e => {
                e.stopPropagation();
                g.images.splice(i, 1);
                if (g._cur && i === g.current) g._cur = null;
                g.current = Math.max(0, Math.min(g.current, g.images.length - 1));
                save();
                renderStrip(type, key, stripEl, countEl);
                updateZoomNav();
            });
            thumb.append(img, del);
            stripEl.append(thumb);
        });

        if (!g.images.length) {
            const empty = document.createElement('div');
            empty.className = 'avga-empty';
            empty.textContent = 'Нет фото. Нажми «+ Добавить фото»';
            stripEl.append(empty);
        }
    };

    const stripPersona = wrap.querySelector('#avga-strip-persona');
    const stripChar    = wrap.querySelector('#avga-strip-char');
    const countPersona = wrap.querySelector('#avga-persona-count');
    const countChar    = wrap.querySelector('#avga-char-count');

    const renderPersonaStrip = () => renderStrip('personas',   personaSel.value, stripPersona, countPersona);
    const renderCharStrip    = () => renderStrip('characters', charSel.value,    stripChar,    countChar);

    // ── Upload buttons ─────────────────────────────────────────────
    const fiPersona = mkFileInput(async b64 => {
        const key = personaSel.value;
        if (!key) return;
        getGal('personas', key).images.push(b64);
        save(); renderPersonaStrip(); updateZoomNav();
    });
    const fiChar = mkFileInput(async b64 => {
        const key = charSel.value;
        if (!key) return;
        getGal('characters', key).images.push(b64);
        save(); renderCharStrip(); updateZoomNav();
    });

    wrap.querySelector('#avga-persona-add').addEventListener('click', () => fiPersona.click());
    wrap.querySelector('#avga-char-add').addEventListener('click',    () => fiChar.click());

    // ── Refresh on ST events ──────────────────────────────────────
    const refresh = () => { populatePersonas(); populateChars(); };
    const tryOn = (ev, fn) => { try { if (event_types[ev]) eventSource.on(event_types[ev], fn); } catch(_){} };
    tryOn('CHARACTER_SELECTED', () => { populateChars(); reapplyChars(); });
    tryOn('CHAT_CHANGED',       () => { populatePersonas(); populateChars(); reapplyChars(); });
    tryOn('USER_MESSAGE_RENDERED', reapplyChars);
    tryOn('LLM_MESSAGE_RENDERED',  reapplyChars);

    // Expose refresh for external calls
    wrap._refresh = refresh;

    // Initial populate (deferred so ST has time to load characters)
    setTimeout(refresh, 500);

    return wrap;
};

// ══════════════════════════════════════════════════════════════════
// ZOOM NAVIGATION OVERLAY
// ══════════════════════════════════════════════════════════════════
const zoomNav = document.createElement('div');
zoomNav.className = 'avga-zoom-nav';
zoomNav.hidden = true;
zoomNav.innerHTML = `
    <button class="avga-zb avga-prev" title="Предыдущий">‹</button>
    <span class="avga-counter"></span>
    <button class="avga-zb avga-next" title="Следующий">›</button>`;

const navigate = dir => {
    if (!_zCtx) return;
    const { type, key } = _zCtx;
    const g = getGal(type, key);
    if (!g.images.length) return;
    g.current = (g.current + dir + g.images.length) % g.images.length;
    save();
    const src = g.images[g.current];
    const zImg = document.querySelector([
        '.zoomed_avatar_content img', '.zoomed_avatar img',
        '#zoom_portrait', '#character_popup img', '.avatar_zoom img',
    ].join(', '));
    if (zImg) zImg.src = src;
    if (type === 'personas') applyPersona(key, src);
    else applyChar(key, src);
    updateZoomNav();
    // Refresh settings strip if open
    document.querySelector('#avga-settings')?._refresh?.();
};

zoomNav.querySelector('.avga-prev').addEventListener('click', e => { e.stopPropagation(); navigate(-1); });
zoomNav.querySelector('.avga-next').addEventListener('click', e => { e.stopPropagation(); navigate(1); });

const updateZoomNav = () => {
    if (!_zCtx) { zoomNav.hidden = true; return; }
    const g = S[_zCtx.type]?.[_zCtx.key];
    const total = g?.images?.length ?? 0;
    zoomNav.hidden = total < 2;
    zoomNav.querySelector('.avga-counter').textContent =
        total > 1 ? `${(g.current ?? 0) + 1} / ${total}` : '';
};

// Attach zoom nav when zoom container appears
const ZOOM_SEL = '.zoomed_avatar, .zoomed_avatar_content, #zoom_portrait, #character_popup, .avatar_zoom';
const attachZoomNav = () => {
    const el = document.querySelector(ZOOM_SEL);
    if (el && !el.contains(zoomNav)) {
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        el.append(zoomNav);
        updateZoomNav();
    }
};
new MutationObserver(attachZoomNav).observe(document.body, { childList: true, subtree: true });

// ══════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════
const init = () => {
    LOG('Loading v1.1...');

    // Inject settings panel into extensions settings
    const target = document.querySelector('#extensions_settings');
    if (target) {
        const panel = buildSettingsPanel();
        target.append(panel);
        LOG('Settings panel injected ✅');
    } else {
        // Wait for ST to render the extensions page
        const obs = new MutationObserver(() => {
            const t = document.querySelector('#extensions_settings');
            if (t) {
                obs.disconnect();
                const panel = buildSettingsPanel();
                t.append(panel);
                LOG('Settings panel injected (delayed) ✅');
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    reapplyChars();
    LOG('Loaded ✅');
};

init();
