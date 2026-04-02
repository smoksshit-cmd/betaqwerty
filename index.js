// ═══════════════════════════════════════════════════════════════════
// Avatar Gallery v1.2 — минимальные зависимости, максимальная совместимость
// ═══════════════════════════════════════════════════════════════════

// Используем только те импорты, которые точно есть в любой ST >= 1.10
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced, power_user, eventSource, event_types } from '../../../../script.js';

const EXT = 'avatarGallery';
const FOLDER = 'third-party/avatar-gallery';
const log = (...a) => console.log('[AvatarGallery]', ...a);

// ── Хранилище ─────────────────────────────────────────────────────
if (!extension_settings[EXT]) extension_settings[EXT] = {};
const S = extension_settings[EXT];
if (!S.personas)   S.personas   = {};
if (!S.characters) S.characters = {};
const save = () => saveSettingsDebounced();

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
const normAv = s => (s || '').split('/').pop().split('?')[0];

// Получить персонажей через getContext (если есть) или через глобальный characters
const getChars = () => {
    try {
        // Пробуем импортированный getContext
        const ctx = typeof getContext === 'function' ? getContext() : null;
        if (ctx?.characters?.length) return ctx.characters;
    } catch(_) {}
    // Fallback: глобальный массив ST
    return window.characters || [];
};
const getCurCharIdx = () => {
    try {
        const ctx = typeof getContext === 'function' ? getContext() : null;
        if (ctx?.characterId != null) return ctx.characterId;
    } catch(_) {}
    return window.this_chid ?? -1;
};

// ── Apply to DOM ───────────────────────────────────────────────────
const applyPersona = (key, src) => {
    try {
        if (power_user?.personas?.[key]) { power_user.personas[key].avatar = src; save(); }
        document.querySelectorAll('.mes[is_user="true"] .mes_img, .mes[is_user="true"] img.avatar')
            .forEach(i => { i.src = src; });
        document.querySelectorAll(`[data-name="${CSS.escape(key)}"] img`)
            .forEach(i => { i.src = src; });
    } catch(e) { log('applyPersona error', e); }
};
const applyChar = (key, src) => {
    try {
        getGal('characters', key)._cur = src;
        save();
        reapplyChars();
    } catch(e) { log('applyChar error', e); }
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
document.addEventListener('click', e => {
    try {
        const img = e.target.closest('.mes_img, .mes_img_container img');
        if (!img) return;
        const mes = img.closest('.mes');
        if (!mes) return;
        if (mes.getAttribute('is_user') === 'true') {
            const n = power_user?.persona;
            if (n) _zCtx = { type: 'personas', key: n };
        } else {
            const chars = getChars();
            const idx   = getCurCharIdx();
            const av    = normAv(chars[idx]?.avatar);
            if (av) _zCtx = { type: 'characters', key: av };
        }
    } catch(_) {}
}, true);

// ── File input factory ────────────────────────────────────────────
const mkInput = cb => {
    const fi = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', multiple: true });
    fi.style.display = 'none';
    document.body.append(fi);
    fi.addEventListener('change', async () => {
        for (const f of fi.files) await cb(await toB64(f));
        fi.value = '';
    });
    return fi;
};

// ══════════════════════════════════════════════════════════════════
//  SETTINGS PANEL
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
        </div>
        <div id="avga-cstrip" class="avga-strip"></div>
        <div class="avga-row">
          <button id="avga-cadd" class="menu_button menu_button_icon">
            <i class="fa-solid fa-plus"></i> Добавить фото
          </button>
          <span id="avga-ccnt" class="avga-cnt"></span>
        </div>
      </div>

    </div>
  </div>
</div>`;

// ── Render strip ───────────────────────────────────────────────────
const renderStrip = (type, key, stripId, cntId) => {
    const strip = document.getElementById(stripId);
    const cnt   = document.getElementById(cntId);
    if (!strip) return;
    strip.innerHTML = '';
    if (!key) { if (cnt) cnt.textContent = ''; return; }

    const g = getGal(type, key);
    if (cnt) cnt.textContent = `${g.images.length} фото`;

    if (!g.images.length) {
        strip.innerHTML = '<div class="avga-empty">Нет фото — нажми «Добавить фото»</div>';
        return;
    }

    g.images.forEach((src, i) => {
        const cell = document.createElement('div');
        cell.className = 'avga-thumb' + (i === g.current ? ' avga-active' : '');
        cell.title = i === g.current ? '✓ Активный' : `Фото ${i + 1} — нажми, чтобы выбрать`;

        const img = document.createElement('img');
        img.src = src;
        img.loading = 'lazy';

        img.addEventListener('click', () => {
            g.current = i;
            save();
            if (type === 'personas') applyPersona(key, src);
            else applyChar(key, src);
            renderStrip(type, key, stripId, cntId);
            updateZoomNav();
        });

        const del = document.createElement('button');
        del.className = 'avga-del';
        del.title = 'Удалить';
        del.innerHTML = '&times;';
        del.addEventListener('click', ev => {
            ev.stopPropagation();
            g.images.splice(i, 1);
            if (i === g.current) { g._cur = null; g.current = Math.max(0, i - 1); }
            save();
            renderStrip(type, key, stripId, cntId);
            updateZoomNav();
        });

        cell.append(img, del);
        strip.append(cell);
    });
};

// ── Wire up selectors ─────────────────────────────────────────────
const populatePersonas = () => {
    const sel = document.getElementById('avga-psel');
    if (!sel) return;
    const saved = sel.value;
    sel.innerHTML = '';
    const personas = power_user?.personas ?? {};
    const keys = Object.keys(personas);
    if (!keys.length) {
        sel.innerHTML = '<option value="">— нет персон —</option>';
    } else {
        keys.forEach(n => { const o = document.createElement('option'); o.value = o.textContent = n; sel.append(o); });
        if (saved && sel.querySelector(`option[value="${CSS.escape(saved)}"]`)) sel.value = saved;
        // Preselect current
        else if (power_user?.persona) sel.value = power_user.persona;
    }
    renderStrip('personas', sel.value, 'avga-pstrip', 'avga-pcnt');
};

const populateChars = () => {
    const sel = document.getElementById('avga-csel');
    if (!sel) return;
    const saved = sel.value;
    sel.innerHTML = '';
    const chars = getChars();
    if (!chars.length) {
        sel.innerHTML = '<option value="">— нет персонажей —</option>';
    } else {
        chars.forEach(ch => {
            const key = normAv(ch.avatar);
            const o = document.createElement('option');
            o.value = key;
            o.textContent = ch.name || key;
            sel.append(o);
        });
        const curKey = normAv(getChars()[getCurCharIdx()]?.avatar);
        if (curKey) sel.value = curKey;
        else if (saved && sel.querySelector(`option[value="${CSS.escape(saved)}"]`)) sel.value = saved;
    }
    renderStrip('characters', sel.value, 'avga-cstrip', 'avga-ccnt');
};

const wirePanel = () => {
    const psel = document.getElementById('avga-psel');
    const csel = document.getElementById('avga-csel');
    if (psel) psel.addEventListener('change', () => renderStrip('personas',   psel.value, 'avga-pstrip', 'avga-pcnt'));
    if (csel) csel.addEventListener('change', () => renderStrip('characters', csel.value, 'avga-cstrip', 'avga-ccnt'));

    const fiP = mkInput(async b64 => {
        const key = document.getElementById('avga-psel')?.value;
        if (!key) return;
        getGal('personas', key).images.push(b64);
        save();
        renderStrip('personas', key, 'avga-pstrip', 'avga-pcnt');
        updateZoomNav();
    });
    const fiC = mkInput(async b64 => {
        const key = document.getElementById('avga-csel')?.value;
        if (!key) return;
        getGal('characters', key).images.push(b64);
        save();
        renderStrip('characters', key, 'avga-cstrip', 'avga-ccnt');
        updateZoomNav();
    });

    document.getElementById('avga-padd')?.addEventListener('click', () => fiP.click());
    document.getElementById('avga-cadd')?.addEventListener('click', () => fiC.click());

    populatePersonas();
    populateChars();
};

// ══════════════════════════════════════════════════════════════════
//  ZOOM NAV
// ══════════════════════════════════════════════════════════════════
const zoomNav = document.createElement('div');
zoomNav.className = 'avga-zoom-nav';
zoomNav.hidden = true;
zoomNav.innerHTML = `
    <button class="avga-zb" id="avga-zprev" title="Предыдущий">&#8249;</button>
    <span id="avga-zcnt"></span>
    <button class="avga-zb" id="avga-znext" title="Следующий">&#8250;</button>`;

const navigate = dir => {
    if (!_zCtx) return;
    const { type, key } = _zCtx;
    const g = getGal(type, key);
    if (!g.images.length) return;
    g.current = (g.current + dir + g.images.length) % g.images.length;
    save();
    const src = g.images[g.current];
    const zImg = document.querySelector(
        '.zoomed_avatar_content img, .zoomed_avatar img, #zoom_portrait, #character_popup img'
    );
    if (zImg) zImg.src = src;
    if (type === 'personas') applyPersona(key, src);
    else applyChar(key, src);
    updateZoomNav();
    renderStrip(type, key, type === 'personas' ? 'avga-pstrip' : 'avga-cstrip', type === 'personas' ? 'avga-pcnt' : 'avga-ccnt');
};

zoomNav.addEventListener('click', e => {
    if (e.target.id === 'avga-zprev') navigate(-1);
    if (e.target.id === 'avga-znext') navigate(1);
});

const updateZoomNav = () => {
    if (!_zCtx) { zoomNav.hidden = true; return; }
    const g = S[_zCtx.type]?.[_zCtx.key];
    const total = g?.images?.length ?? 0;
    zoomNav.hidden = total < 2;
    const cntEl = document.getElementById('avga-zcnt');
    if (cntEl) cntEl.textContent = total > 1 ? `${(g.current ?? 0) + 1} / ${total}` : '';
};

const ZOOM_SEL = '.zoomed_avatar, .zoomed_avatar_content, #zoom_portrait, #character_popup';
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
//  EVENTS
// ══════════════════════════════════════════════════════════════════
const tryOn = (ev, fn) => {
    try { if (event_types[ev]) eventSource.on(event_types[ev], fn); } catch(_) {}
};
tryOn('CHARACTER_SELECTED', () => { populateChars(); reapplyChars(); });
tryOn('CHAT_CHANGED',       () => { populatePersonas(); populateChars(); reapplyChars(); });
tryOn('USER_MESSAGE_RENDERED', reapplyChars);
tryOn('LLM_MESSAGE_RENDERED',  reapplyChars);

// ══════════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════════
const injectPanel = () => {
    if (document.getElementById('avga-panel')) return; // уже есть
    const target = document.getElementById('extensions_settings');
    if (!target) return false;
    target.insertAdjacentHTML('beforeend', PANEL_HTML);
    wirePanel();
    log('Panel injected ✅');
    return true;
};

const init = async () => {
    log('Loading v1.2...');

    // Пробуем вставить сейчас
    if (!injectPanel()) {
        // DOM ещё не готов — ждём
        const obs = new MutationObserver(() => {
            if (injectPanel()) obs.disconnect();
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    reapplyChars();

    // Повторная синхронизация через 2s (ST медленно грузит список персонажей)
    setTimeout(() => { populatePersonas(); populateChars(); }, 2000);

    log('Loaded ✅');
};

init();
