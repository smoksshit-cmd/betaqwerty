// ═══════════════════════════════════════════════════════════════════
// Avatar Gallery v1.3 — Avatar Gallery for SillyTavern
// ═══════════════════════════════════════════════════════════════════
import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid } from '../../../../script.js';

const EXT = 'avatarGallery';
const log = (...a) => console.log('[AvatarGallery]', ...a);

// power_user недоступен как экспорт — берём из window
const pu = () => window.power_user ?? {};

// ── Хранилище (base64 в extension_settings) ──────────────────────
if (!extension_settings[EXT]) extension_settings[EXT] = {};
const S = extension_settings[EXT];
if (!S.personas)   S.personas   = {};
if (!S.characters) S.characters = {};
const save = () => saveSettingsDebounced();

const getGal = (type, key) => {
    if (!S[type][key]) S[type][key] = { images: [], current: 0 };
    return S[type][key];
};

// ── Утилиты ──────────────────────────────────────────────────────
const toB64 = file => new Promise((ok, err) => {
    const r = new FileReader();
    r.onload  = () => ok(r.result);
    r.onerror = err;
    r.readAsDataURL(file);
});

const normAv    = s => (s || '').split('/').pop().split('?')[0];
const getChars  = () => Array.isArray(characters) ? characters : [];
const curCharKey = () => normAv(getChars()[this_chid ?? -1]?.avatar);

// ── Читаем список персон ─────────────────────────────────────────
// Структура может отличаться в разных версиях ST
const getPersonaMap = () => {
    const raw = pu().personas ?? {};
    if (Array.isArray(raw)) {
        const out = {};
        raw.forEach(item => { if (item?.name) out[item.name] = item.avatar || ''; });
        return out;
    }
    return raw;
};

// ── Apply avatar to DOM ──────────────────────────────────────────
const reapplyChars = () => {
    for (const [k, d] of Object.entries(S.characters)) {
        if (!d._cur) continue;
        document.querySelectorAll(`img[src*="${k}"]`).forEach(img => {
            if (img.src !== d._cur) img.src = d._cur;
        });
    }
};

const reapplyPersonas = () => {
    const curPersona = pu().persona;
    for (const [k, d] of Object.entries(S.personas)) {
        if (!d._cur || k !== curPersona) continue;
        document.querySelectorAll('.mes[is_user="true"] .mes_img, .mes[is_user="true"] img.avatar')
            .forEach(img => { if (img.src !== d._cur) img.src = d._cur; });
    }
};

const applyPersona = (key, src) => {
    try {
        getGal('personas', key)._cur = src;
        const pm    = getPersonaMap();
        const entry = pm[key];
        if (typeof entry === 'object' && entry !== null) {
            entry.avatar = src;
        } else if (typeof entry === 'string') {
            pu().personas[key] = src;
        }
        save();
        document.querySelectorAll('.mes[is_user="true"] .mes_img, .mes[is_user="true"] img.avatar')
            .forEach(i => { i.src = src; });
        document.querySelectorAll(`[title="${CSS.escape(key)}"] img, [data-persona="${CSS.escape(key)}"] img`)
            .forEach(i => { i.src = src; });
    } catch(e) { log('applyPersona error', e); }
};

const applyChar = (key, src) => {
    getGal('characters', key)._cur = src;
    save();
    reapplyChars();
};

// ── Файловый инпут ───────────────────────────────────────────────
const mkInput = cb => {
    const fi = Object.assign(document.createElement('input'), {
        type: 'file', accept: 'image/*', multiple: true
    });
    fi.style.display = 'none';
    document.body.append(fi);
    fi.addEventListener('change', async () => {
        for (const f of fi.files) await cb(await toB64(f));
        fi.value = '';
    });
    return fi;
};

// ══════════════════════════════════════════════════════════════════
// HTML ПАНЕЛИ НАСТРОЕК
// ══════════════════════════════════════════════════════════════════
const PANEL_HTML = `
<div id="avga-panel">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Avatar Gallery</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

            <div class="avga-section">
                <div class="avga-stitle">🧑 Персоны</div>
                <div class="avga-row">
                    <label class="avga-lbl">Персона</label>
                    <select id="avga-psel" class="text_pole"></select>
                    <button id="avga-pref" class="menu_button" title="Обновить список">↺</button>
                </div>
                <div id="avga-pstrip" class="avga-strip"></div>
                <div class="avga-row">
                    <button id="avga-padd" class="menu_button menu_button_icon" title="Добавить изображения">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                    <span id="avga-pcnt" class="avga-cnt"></span>
                </div>
            </div>

            <hr class="avga-divider" />

            <div class="avga-section">
                <div class="avga-stitle">🤖 Персонажи</div>
                <div class="avga-row">
                    <label class="avga-lbl">Персонаж</label>
                    <select id="avga-csel" class="text_pole"></select>
                    <button id="avga-cref" class="menu_button" title="Обновить список">↺</button>
                </div>
                <div id="avga-cstrip" class="avga-strip"></div>
                <div class="avga-row">
                    <button id="avga-cadd" class="menu_button menu_button_icon" title="Добавить изображения">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                    <span id="avga-ccnt" class="avga-cnt"></span>
                </div>
            </div>

        </div>
    </div>
</div>`;

// ── Рендер полосы миниатюр ────────────────────────────────────────
const renderStrip = (type, key, stripId, cntId) => {
    const strip = document.getElementById(stripId);
    const cnt   = document.getElementById(cntId);
    if (!strip) return;
    strip.innerHTML = '';
    if (!key) { if (cnt) cnt.textContent = ''; return; }
    const g = getGal(type, key);
    if (cnt) cnt.textContent = g.images.length ? `${g.images.length}` : '';
    if (!g.images.length) {
        strip.innerHTML = '<div class="avga-empty">Нет изображений — нажмите +</div>';
        return;
    }
    g.images.forEach((src, i) => {
        const cell = document.createElement('div');
        cell.className = 'avga-thumb' + (i === g.current ? ' avga-active' : '');
        cell.title     = String(i + 1) + (i === g.current ? ' ✓' : '');

        const img = document.createElement('img');
        img.src     = src;
        img.loading = 'lazy';
        img.addEventListener('click', () => {
            g.current = i;
            save();
            if (type === 'personas') applyPersona(key, src);
            else                     applyChar(key, src);
            renderStrip(type, key, stripId, cntId);
            refreshZoomNav();
        });

        const del = document.createElement('button');
        del.className = 'avga-del';
        del.title     = 'Удалить';
        del.innerHTML = '&times;';
        del.addEventListener('click', ev => {
            ev.stopPropagation();
            g.images.splice(i, 1);
            if (i === g.current)    { g._cur = null; g.current = Math.max(0, i - 1); }
            else if (i < g.current) { g.current--; }
            save();
            renderStrip(type, key, stripId, cntId);
            refreshZoomNav();
        });

        cell.append(img, del);
        strip.append(cell);
    });
};

// ── Заполнение селектов ───────────────────────────────────────────
const populatePersonas = () => {
    const sel = document.getElementById('avga-psel');
    if (!sel) return;
    const saved = sel.value;
    sel.innerHTML = '';
    const personas = getPersonaMap();
    const keys     = Object.keys(personas);
    log('personas', keys.length, keys.slice(0, 5));
    if (!keys.length) {
        sel.innerHTML = '<option value="">— нет —</option>';
    } else {
        keys.forEach(n => {
            const o = document.createElement('option');
            o.value = n; o.textContent = n;
            sel.append(o);
        });
    }
    const cur = pu().persona;
    if (cur && sel.querySelector(`option[value="${CSS.escape(cur)}"]`))          sel.value = cur;
    else if (saved && sel.querySelector(`option[value="${CSS.escape(saved)}"]`)) sel.value = saved;
    renderStrip('personas', sel.value, 'avga-pstrip', 'avga-pcnt');
};

const populateChars = () => {
    const sel = document.getElementById('avga-csel');
    if (!sel) return;
    const saved = sel.value;
    sel.innerHTML = '';
    const chars = getChars();
    log('chars', chars.length, 'chid', this_chid);
    if (!chars.length) {
        sel.innerHTML = '<option value="">— нет —</option>';
    } else {
        chars.forEach(ch => {
            if (!ch) return;
            const key = normAv(ch.avatar);
            const o   = document.createElement('option');
            o.value       = key;
            o.textContent = ch.name;
            sel.append(o);
        });
    }
    const ck = curCharKey();
    if (ck && sel.querySelector(`option[value="${CSS.escape(ck)}"]`))            sel.value = ck;
    else if (saved && sel.querySelector(`option[value="${CSS.escape(saved)}"]`)) sel.value = saved;
    renderStrip('characters', sel.value, 'avga-cstrip', 'avga-ccnt');
};

// ── Привязка событий панели ───────────────────────────────────────
const wirePanel = () => {
    document.getElementById('avga-psel')?.addEventListener('change', e =>
        renderStrip('personas', e.target.value, 'avga-pstrip', 'avga-pcnt'));
    document.getElementById('avga-csel')?.addEventListener('change', e =>
        renderStrip('characters', e.target.value, 'avga-cstrip', 'avga-ccnt'));
    document.getElementById('avga-pref')?.addEventListener('click', populatePersonas);
    document.getElementById('avga-cref')?.addEventListener('click', populateChars);

    const fiP = mkInput(async b64 => {
        const key = document.getElementById('avga-psel')?.value;
        if (!key) return;
        getGal('personas', key).images.push(b64);
        save();
        renderStrip('personas', key, 'avga-pstrip', 'avga-pcnt');
        refreshZoomNav();
    });
    const fiC = mkInput(async b64 => {
        const key = document.getElementById('avga-csel')?.value;
        if (!key) return;
        getGal('characters', key).images.push(b64);
        save();
        renderStrip('characters', key, 'avga-cstrip', 'avga-ccnt');
        refreshZoomNav();
    });
    document.getElementById('avga-padd')?.addEventListener('click', () => fiP.click());
    document.getElementById('avga-cadd')?.addEventListener('click', () => fiC.click());

    populatePersonas();
    populateChars();
};

// ══════════════════════════════════════════════════════════════════
// ZOOM NAV — кнопки навигации в окне zoom-аватара
// ══════════════════════════════════════════════════════════════════
const ZOOM_IMG_SEL = [
    '.zoomed_avatar_content img',
    '.zoomed_avatar img',
    '#zoom_portrait img',
    '#character_popup img',
    '.avatar_zoom img',
    '#shadow_popup img',
    '.popup img'
].join(', ');

const ZOOM_CONTAINERS = [
    '.zoomed_avatar_content',
    '.zoomed_avatar',
    '#zoom_portrait',
    '#character_popup',
    '.avatar_zoom',
    '#shadow_popup'
].join(', ');

let zCtx = null;

const detectCtxNow = () => {
    const ck = curCharKey();
    if (ck && (S.characters[ck]?.images?.length ?? 0) > 0)
        return { type: 'characters', key: ck };
    const pName = pu().persona;
    if (pName && (S.personas[pName]?.images?.length ?? 0) > 0)
        return { type: 'personas', key: pName };
    for (const [k, d] of Object.entries(S.characters))
        if ((d.images?.length ?? 0) > 1) return { type: 'characters', key: k };
    for (const [k, d] of Object.entries(S.personas))
        if ((d.images?.length ?? 0) > 1) return { type: 'personas', key: k };
    return null;
};

// Захватываем клик по аватарке в чате
document.addEventListener('click', e => {
    const img = e.target.closest('.mes_img, .mes_img_container img, img.avatar');
    if (!img) return;
    try {
        const mes = img.closest('.mes');
        if (mes?.getAttribute('is_user') === 'true') {
            const n = pu().persona;
            if (n) zCtx = { type: 'personas', key: n };
        } else {
            const ck = curCharKey();
            if (ck) zCtx = { type: 'characters', key: ck };
        }
        log('zoom ctx set', zCtx);
        setTimeout(refreshZoomNav, 100);
    } catch {}
}, true);

// Элемент навигации
const zNav = document.createElement('div');
zNav.className   = 'avga-zoom-nav';
zNav.hidden      = true;
zNav.dataset.ctx = '';
zNav.innerHTML   = `
    <button class="avga-zb" id="avga-zprev" title="Предыдущий">&#8249;</button>
    <span id="avga-zcnt"></span>
    <button class="avga-zb" id="avga-znext" title="Следующий">&#8250;</button>`;

const navigate = dir => {
    const ctx = zCtx ?? detectCtxNow();
    if (!ctx) { log('navigate: no ctx'); return; }
    const g = getGal(ctx.type, ctx.key);
    if (!g.images.length) { log('navigate: empty gallery'); return; }
    g.current = (g.current + dir + g.images.length) % g.images.length;
    save();
    const src = g.images[g.current];
    log('navigate', ctx.key, '->', g.current, '/', g.images.length);

    // Обновляем изображение в zoom-окне
    const zImg = document.querySelector(ZOOM_IMG_SEL);
    if (zImg) { zImg.src = src; log('zoom img updated'); }
    else log('zoom img not found');

    // Применяем к сообщениям в чате
    if (ctx.type === 'personas') applyPersona(ctx.key, src);
    else                         applyChar(ctx.key, src);

    // Обновляем UI
    const stripId = ctx.type === 'personas' ? 'avga-pstrip' : 'avga-cstrip';
    const cntId   = ctx.type === 'personas' ? 'avga-pcnt'   : 'avga-ccnt';
    renderStrip(ctx.type, ctx.key, stripId, cntId);
    refreshZoomNav(ctx);
};

zNav.addEventListener('click', e => {
    const btn = e.target.closest('.avga-zb');
    if (!btn) return;
    if (btn.id === 'avga-zprev') navigate(-1);
    if (btn.id === 'avga-znext') navigate(1);
});

const refreshZoomNav = (forcedCtx) => {
    const ctx   = forcedCtx ?? zCtx ?? detectCtxNow();
    if (!ctx) { zNav.hidden = true; return; }
    const g     = S[ctx.type]?.[ctx.key];
    const total = g?.images?.length ?? 0;
    zNav.hidden = total < 2;
    const cntEl = zNav.querySelector('#avga-zcnt');
    if (cntEl) cntEl.textContent = total > 1 ? `${(g.current ?? 0) + 1}/${total}` : '';
    zNav.dataset.ctx = JSON.stringify(ctx);
};

// Прикрепляем nav к zoom-контейнеру при его появлении
const tryAttachZoomNav = () => {
    const el = document.querySelector(ZOOM_CONTAINERS);
    if (!el || el.contains(zNav)) return;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.append(zNav);
    refreshZoomNav();
};
new MutationObserver(tryAttachZoomNav).observe(document.body, { childList: true, subtree: true });

// ── ST Events ─────────────────────────────────────────────────────
const tryOn = (ev, fn) => {
    try { if (event_types[ev]) eventSource.on(event_types[ev], fn); } catch {}
};
tryOn('CHARACTER_SELECTED',    () => { zCtx = null; populateChars();   reapplyChars(); });
tryOn('CHAT_CHANGED',          () => { zCtx = null; populatePersonas(); populateChars(); reapplyChars(); reapplyPersonas(); });
tryOn('USER_MESSAGE_RENDERED', () => { reapplyChars(); reapplyPersonas(); });
tryOn('LLM_MESSAGE_RENDERED',  reapplyChars);
tryOn('PERSONA_SELECTED',      () => { zCtx = null; populatePersonas(); });

// ── Init ──────────────────────────────────────────────────────────
const injectPanel = () => {
    if (document.getElementById('avga-panel')) return true;
    const target = document.getElementById('extensions_settings');
    if (!target) return false;
    target.insertAdjacentHTML('beforeend', PANEL_HTML);
    wirePanel();
    log('Panel injected');
    return true;
};

const init = () => {
    log('Loading v1.3...');
    if (!injectPanel()) {
        const obs = new MutationObserver(() => { if (injectPanel()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
    }
    reapplyChars();
    reapplyPersonas();
    [800, 2000, 5000].forEach(ms => setTimeout(() => {
        populatePersonas();
        populateChars();
    }, ms));
    log('Init done');
};

init();
