// ═══════════════════════════════════════════════════════════════════
// Avatar Gallery v1.3 — Avatar Gallery for SillyTavern
// ═══════════════════════════════════════════════════════════════════

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid } from '../../../../script.js';

const EXT = 'avatarGallery';
const log = (...a) => console.log('[AvatarGallery]', ...a);

// power_user недоступен как экспорт — берём из window
const pu = () => window.power_user ?? {};

// ── Хранилище (base64 в extension_settings) ───────────────────────
if (!extension_settings[EXT]) extension_settings[EXT] = {};
const S = extension_settings[EXT];
if (!S.personas)   S.personas   = {};
if (!S.characters) S.characters = {};
const save = () => saveSettingsDebounced();

const getGal = (type, key) => {
    if (!S[type][key]) S[type][key] = { images: [], current: 0 };
    return S[type][key];
};

// ── Утилиты ────────────────────────────────────────────────────────
const toB64 = file => new Promise((ok, err) => {
    const r = new FileReader();
    r.onload  = () => ok(r.result);
    r.onerror = err;
    r.readAsDataURL(file);
});
const normAv  = s => (s || '').split('/').pop().split('?')[0];
const getChars = () => Array.isArray(characters) ? characters : [];
const curCharKey = () => normAv(getChars()[this_chid ?? -1]?.avatar);

// ── Читаем список персон ───────────────────────────────────────────
// В разных версиях ST структура может отличаться
const getPersonaMap = () => {
    const p = pu();
    // Вариант 1: power_user.personas = { name: "avatar.png", ... }
    // Вариант 2: power_user.personas = { name: { avatar: "...", ... }, ... }
    // Вариант 3: массив объектов
    const raw = p.personas ?? {};
    if (Array.isArray(raw)) {
        // массив [{name, avatar}]
        const out = {};
        raw.forEach(item => { if (item?.name) out[item.name] = item.avatar || ''; });
        return out;
    }
    return raw; // объект
};

// ── Apply avatar to DOM ────────────────────────────────────────────
const applyPersona = (key, src) => {
    try {
        const pm = getPersonaMap();
        const entry = pm[key];
        if (typeof entry === 'object' && entry !== null) {
            entry.avatar = src;
        } else if (typeof entry === 'string') {
            // нельзя мутировать строку — записываем заново
            pu().personas[key] = src;
        }
        save();
        document.querySelectorAll(
            '.mes[is_user="true"] .mes_img, .mes[is_user="true"] img.avatar'
        ).forEach(i => { i.src = src; });
        // Обновляем иконку в списке персон
        document.querySelectorAll(`[title="${CSS.escape(key)}"] img, [data-persona="${CSS.escape(key)}"] img`)
            .forEach(i => { i.src = src; });
    } catch(e) { log('applyPersona error', e); }
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
            if (!img.src.startsWith('data:') || img.src !== d._cur) img.src = d._cur;
        });
    }
};

// ── Файловый инпут ─────────────────────────────────────────────────
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
//  ПАНЕЛЬ НАСТРОЕК
// ══════════════════════════════════════════════════════════════════
const PANEL_HTML = `
<div id="avga-panel">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>🖼 Avatar Gallery</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
    </div>
    <div class="inline-drawer-content">

      <div class="avga-section">
        <div class="avga-stitle">👤 Персоны</div>
        <div class="avga-row">
          <label class="avga-lbl">Персона:</label>
          <select id="avga-psel" class="text_pole"></select>
          <button id="avga-pref" class="menu_button" title="Обновить список">↻</button>
        </div>
        <div id="avga-pstrip" class="avga-strip"></div>
        <div class="avga-row">
          <button id="avga-padd" class="menu_button menu_button_icon">
            <i class="fa-solid fa-plus"></i> Добавить фото
          </button>
          <span id="avga-pcnt" class="avga-cnt"></span>
        </div>
      </div>

      <div class="avga-divider"></div>

      <div class="avga-section">
        <div class="avga-stitle">🤖 Персонажи</div>
        <div class="avga-row">
          <label class="avga-lbl">Персонаж:</label>
          <select id="avga-csel" class="text_pole"></select>
          <button id="avga-cref" class="menu_button" title="Обновить список">↻</button>
        </div>
        <div id="avga-cstrip" class="avga-strip"></div>
        <div class="avga-row">
          <button id="avga-cadd" class="menu_button menu_button_icon">
            <i class="fa-solid fa-plus"></i> Добавить фото
          </button>
          <span id="avga-ccnt" class="avga-cnt"></span>
        </div>
      </div>

      <div id="avga-debug" class="avga-debug" style="display:none;"></div>

    </div>
  </div>
</div>`;

// ── Рендер полосы превью ───────────────────────────────────────────
const renderStrip = (type, key, stripId, cntId) => {
    const strip = document.getElementById(stripId);
    const cnt   = document.getElementById(cntId);
    if (!strip) return;
    strip.innerHTML = '';
    if (!key) { if (cnt) cnt.textContent = ''; return; }
    const g = getGal(type, key);
    if (cnt) cnt.textContent = `${g.images.length} фото`;
    if (!g.images.length) {
        strip.innerHTML = '<div class="avga-empty">Нажми «Добавить фото»</div>';
        return;
    }
    g.images.forEach((src, i) => {
        const cell = document.createElement('div');
        cell.className = 'avga-thumb' + (i === g.current ? ' avga-active' : '');
        cell.title = i === g.current ? '✓ Активный' : `Фото ${i+1}`;

        const img = document.createElement('img');
        img.src = src; img.loading = 'lazy';
        img.addEventListener('click', () => {
            g.current = i; save();
            if (type === 'personas') applyPersona(key, src);
            else applyChar(key, src);
            renderStrip(type, key, stripId, cntId);
            refreshZoomNav();
        });

        const del = document.createElement('button');
        del.className = 'avga-del'; del.title = 'Удалить'; del.innerHTML = '&times;';
        del.addEventListener('click', ev => {
            ev.stopPropagation();
            g.images.splice(i, 1);
            if (i === g.current) { g._cur = null; g.current = Math.max(0, i - 1); }
            else if (i < g.current) g.current--;
            save();
            renderStrip(type, key, stripId, cntId);
            refreshZoomNav();
        });
        cell.append(img, del);
        strip.append(cell);
    });
};

// ── Список персон ──────────────────────────────────────────────────
const populatePersonas = () => {
    const sel = document.getElementById('avga-psel');
    if (!sel) return;
    const saved = sel.value;
    sel.innerHTML = '';
    const personas = getPersonaMap();
    const keys = Object.keys(personas);
    log('personas keys:', keys.length, keys.slice(0, 5));
    if (!keys.length) {
        sel.innerHTML = '<option value="">— нет персон —</option>';
    } else {
        keys.forEach(n => {
            const o = document.createElement('option');
            o.value = o.textContent = n;
            sel.append(o);
        });
        const cur = pu().persona;
        if (cur && sel.querySelector(`option[value="${CSS.escape(cur)}"]`)) sel.value = cur;
        else if (saved && sel.querySelector(`option[value="${CSS.escape(saved)}"]`)) sel.value = saved;
    }
    renderStrip('personas', sel.value, 'avga-pstrip', 'avga-pcnt');
};

// ── Список персонажей ─────────────────────────────────────────────
const populateChars = () => {
    const sel = document.getElementById('avga-csel');
    if (!sel) return;
    const saved = sel.value;
    sel.innerHTML = '';
    const chars = getChars();
    log('chars:', chars.length, '| this_chid:', this_chid);
    if (!chars.length) {
        sel.innerHTML = '<option value="">— нет персонажей —</option>';
    } else {
        chars.forEach(ch => {
            if (!ch) return;
            const key = normAv(ch.avatar);
            const o = document.createElement('option');
            o.value = key; o.textContent = ch.name || key;
            sel.append(o);
        });
        const ck = curCharKey();
        if (ck && sel.querySelector(`option[value="${CSS.escape(ck)}"]`)) sel.value = ck;
        else if (saved && sel.querySelector(`option[value="${CSS.escape(saved)}"]`)) sel.value = saved;
    }
    renderStrip('characters', sel.value, 'avga-cstrip', 'avga-ccnt');
};

// ── Подключение панели ─────────────────────────────────────────────
const wirePanel = () => {
    document.getElementById('avga-psel')?.addEventListener('change', e =>
        renderStrip('personas',   e.target.value, 'avga-pstrip', 'avga-pcnt'));
    document.getElementById('avga-csel')?.addEventListener('change', e =>
        renderStrip('characters', e.target.value, 'avga-cstrip', 'avga-ccnt'));
    document.getElementById('avga-pref')?.addEventListener('click', populatePersonas);
    document.getElementById('avga-cref')?.addEventListener('click', populateChars);

    // Загрузка фото
    const fiP = mkInput(async b64 => {
        const key = document.getElementById('avga-psel')?.value; if (!key) return;
        getGal('personas', key).images.push(b64); save();
        renderStrip('personas', key, 'avga-pstrip', 'avga-pcnt');
        refreshZoomNav();
    });
    const fiC = mkInput(async b64 => {
        const key = document.getElementById('avga-csel')?.value; if (!key) return;
        getGal('characters', key).images.push(b64); save();
        renderStrip('characters', key, 'avga-cstrip', 'avga-ccnt');
        refreshZoomNav();
    });
    document.getElementById('avga-padd')?.addEventListener('click', () => fiP.click());
    document.getElementById('avga-cadd')?.addEventListener('click', () => fiC.click());

    populatePersonas();
    populateChars();
};

// ══════════════════════════════════════════════════════════════════
//  ZOOM NAV
// ══════════════════════════════════════════════════════════════════

// Контекст зума — определяем при клике на аватарку ИЛИ при открытии зума
let _zCtx = null;

// Попытка определить контекст по текущему персонажу / персоне
const detectCtxNow = () => {
    // Если зум показывает персонажа
    const ck = curCharKey();
    if (ck && (S.characters[ck]?.images?.length ?? 0) > 0) {
        return { type: 'characters', key: ck };
    }
    // Если зум показывает персону
    const pName = pu().persona;
    if (pName && (S.personas[pName]?.images?.length ?? 0) > 0) {
        return { type: 'personas', key: pName };
    }
    // Перебираем все галереи с >1 фото
    for (const [k, d] of Object.entries(S.characters)) {
        if ((d.images?.length ?? 0) > 1) return { type: 'characters', key: k };
    }
    for (const [k, d] of Object.entries(S.personas)) {
        if ((d.images?.length ?? 0) > 1) return { type: 'personas', key: k };
    }
    return null;
};

// При клике на аватарку в чате запоминаем контекст
document.addEventListener('click', e => {
    const img = e.target.closest('.mes_img, .mes_img_container img, img.avatar');
    if (!img) return;
    try {
        const mes = img.closest('.mes');
        if (mes?.getAttribute('is_user') === 'true') {
            const n = pu().persona;
            if (n) _zCtx = { type: 'personas', key: n };
        } else {
            const ck = curCharKey();
            if (ck) _zCtx = { type: 'characters', key: ck };
        }
        log('zoom ctx set:', _zCtx);
        setTimeout(refreshZoomNav, 100);
    } catch(_) {}
}, true);

// Зум-навигация
const zNav = document.createElement('div');
zNav.className = 'avga-zoom-nav';
zNav.hidden = true;
zNav.dataset.ctx = '';
zNav.innerHTML = `
    <button class="avga-zb" id="avga-zprev" title="Предыдущий">&#8249;</button>
    <span id="avga-zcnt"></span>
    <button class="avga-zb" id="avga-znext" title="Следующий">&#8250;</button>`;

const navigate = dir => {
    // Берём контекст: сначала сохранённый по клику, потом автодетект
    const ctx = _zCtx ?? detectCtxNow();
    if (!ctx) { log('navigate: no ctx'); return; }
    const g = getGal(ctx.type, ctx.key);
    if (!g.images.length) { log('navigate: empty gallery'); return; }
    g.current = (g.current + dir + g.images.length) % g.images.length;
    save();
    const src = g.images[g.current];
    log('navigate:', ctx.key, '->', g.current, '/', g.images.length);

    // Обновляем изображение в зуме
    const ZOOM_IMG_SEL = [
        '.zoomed_avatar_content img',
        '.zoomed_avatar img',
        '#zoom_portrait img',
        '#character_popup img',
        '.avatar_zoom img',
        // Некоторые версии ST используют просто большой img внутри оверлея
        '#shadow_popup img',
        '.popup img',
    ].join(', ');
    const zImg = document.querySelector(ZOOM_IMG_SEL);
    if (zImg) { zImg.src = src; log('zoom img updated'); }
    else log('zoom img NOT found');

    if (ctx.type === 'personas') applyPersona(ctx.key, src);
    else applyChar(ctx.key, src);

    // Обновляем стрипы в панели
    renderStrip(ctx.type, ctx.key,
        ctx.type === 'personas' ? 'avga-pstrip' : 'avga-cstrip',
        ctx.type === 'personas' ? 'avga-pcnt'   : 'avga-ccnt');
    refreshZoomNav(ctx);
};

document.getElementById?.('avga-zprev');
zNav.addEventListener('click', e => {
    const btn = e.target.closest('.avga-zb');
    if (!btn) return;
    if (btn.id === 'avga-zprev' || btn.classList.contains('avga-prev')) navigate(-1);
    if (btn.id === 'avga-znext' || btn.classList.contains('avga-next')) navigate(1);
});

const refreshZoomNav = (forcedCtx) => {
    const ctx = forcedCtx ?? _zCtx ?? detectCtxNow();
    if (!ctx) { zNav.hidden = true; return; }
    const g = S[ctx.type]?.[ctx.key];
    const total = g?.images?.length ?? 0;
    zNav.hidden = total < 2;
    const cntEl = zNav.querySelector('#avga-zcnt');
    if (cntEl) cntEl.textContent = total > 1 ? `${(g.current ?? 0) + 1} / ${total}` : '';
    zNav.dataset.ctx = JSON.stringify(ctx);
};

// Вставляем зум-навигацию когда открывается зум-оверлей
const ZOOM_CONTAINERS = [
    '.zoomed_avatar_content', '.zoomed_avatar',
    '#zoom_portrait', '#character_popup', '.avatar_zoom', '#shadow_popup',
].join(', ');

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
    try { if (event_types[ev]) eventSource.on(event_types[ev], fn); } catch(_) {}
};
tryOn('CHARACTER_SELECTED', () => { _zCtx = null; populateChars(); reapplyChars(); });
tryOn('CHAT_CHANGED',       () => { _zCtx = null; populatePersonas(); populateChars(); reapplyChars(); });
tryOn('USER_MESSAGE_RENDERED', reapplyChars);
tryOn('LLM_MESSAGE_RENDERED',  reapplyChars);
tryOn('PERSONA_SELECTED',   () => { _zCtx = null; populatePersonas(); });

// ── Init ───────────────────────────────────────────────────────────
const injectPanel = () => {
    if (document.getElementById('avga-panel')) return true;
    const target = document.getElementById('extensions_settings');
    if (!target) return false;
    target.insertAdjacentHTML('beforeend', PANEL_HTML);
    wirePanel();
    log('Panel injected ✅');
    return true;
};

const init = () => {
    log('Loading v1.3...');
    if (!injectPanel()) {
        const obs = new MutationObserver(() => { if (injectPanel()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
    }
    reapplyChars();
    // Повторные попытки заполнить списки
    [800, 2000, 5000].forEach(ms => setTimeout(() => {
        populatePersonas();
        populateChars();
    }, ms));
    log('Init done ✅');
};

init();
