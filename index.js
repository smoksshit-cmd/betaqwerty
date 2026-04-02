import { chat, chat_metadata, characters, this_chid, event_types, eventSource, main_api, saveSettingsDebounced } from '../../../../script.js';
import { metadata_keys } from '../../../authors-note.js';
import { extension_settings } from '../../../extensions.js';
import { promptManager } from '../../../openai.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { delay } from '../../../utils.js';
import { world_info_position } from '../../../world-info.js';

console.log('🟢 [STWII] World Info Info v3.0 — загрузка...');

// ─── Стратегии ────────────────────────────────────────────────────────────────
const STRATEGIES = {
    constant:   { icon: '🔵', label: 'Константа',  key: 'constant'   },
    normal:     { icon: '🟢', label: 'Ключ-матч',  key: 'normal'     },
    vectorized: { icon: '🔗', label: 'Векторный',  key: 'vectorized' },
};
const getStrategy = (entry) => {
    if (entry.constant === true)   return 'constant';
    if (entry.vectorized === true) return 'vectorized';
    return 'normal';
};

// ─── Цвета книг (авто-генерация по имени) ─────────────────────────────────────
const _bookColors = new Map();
const getBookColor = (bookName) => {
    if (!_bookColors.has(bookName)) {
        let hash = 0;
        for (const c of bookName) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
        const hue = Math.abs(hash) % 360;
        _bookColors.set(bookName, `hsl(${hue}, 60%, 55%)`);
    }
    return _bookColors.get(bookName);
};

// ─── Токены (оценка) ──────────────────────────────────────────────────────────
const estimateTokens = (text) => !text ? 0 : Math.ceil((text.match(/\S+/g) || []).length * 1.3);

// ─── Поиск тригерного ключа ───────────────────────────────────────────────────
const findMatchedKey = (entry, text) => {
    if (!text || !entry.key?.length) return null;
    const lower = text.toLowerCase();
    for (const k of entry.key) {
        if (k?.trim() && lower.includes(k.toLowerCase())) return k;
    }
    return null;
};
const getRecentChatText = (depth = 15) =>
    chat.slice(-depth).map(m => m.mes || '').join('\n');

// ─── Статистика сессии ────────────────────────────────────────────────────────
const sessionHits = new Map(); // 'world§§§uid' → count
let _genFirstTimers = new Set(); // entries appearing for FIRST time this generation
const bumpHit = (entry) => {
    const key = `${entry.world}§§§${entry.uid}`;
    sessionHits.set(key, (sessionHits.get(key) || 0) + 1);
};
const getHits     = (entry) => sessionHits.get(`${entry.world}§§§${entry.uid}`) || 0;
const isSessionNew = (entry) => _genFirstTimers.has(`${entry.world}§§§${entry.uid}`);

// ─── История активаций ────────────────────────────────────────────────────────
const activationHistory = []; // [{ts, entries: [{world,uid,comment,key}], added:[], removed:[]}]
const MAX_HISTORY = 15;

// ─── Инлайн-тултип ────────────────────────────────────────────────────────────
let _tooltip = null;
const getTooltip = () => {
    if (!_tooltip) {
        _tooltip = document.createElement('div');
        _tooltip.classList.add('stwii--inline-tooltip');
        document.body.append(_tooltip);
        document.addEventListener('click', (e) => {
            if (!_tooltip.contains(e.target) && !e.target.classList.contains('stwii--highlight'))
                _tooltip.classList.remove('stwii--isActive');
        }, true);
    }
    return _tooltip;
};
const showTooltip = (entry, anchor) => {
    const tt = getTooltip();
    const strat = getStrategy(entry);
    const tokens = estimateTokens(entry.content);
    const title = entry.comment?.length ? entry.comment : entry.key.join(', ');
    const preview = (entry.content || '').slice(0, 350) + ((entry.content?.length || 0) > 350 ? '…' : '');
    tt.innerHTML = `
        <div class="stwii--tt-header">
            <span class="stwii--tt-icon">${STRATEGIES[strat].icon}</span>
            <span class="stwii--tt-title">${title}</span>
            <span class="stwii--tt-tokens">~${tokens} tok</span>
        </div>
        <div class="stwii--tt-meta">
            <span class="stwii--tt-world" style="color:${getBookColor(entry.world)}">[${entry.world}]</span>
            ${entry.matchedKey ? `<span class="stwii--tt-key">🔑 <em>${entry.matchedKey}</em></span>` : ''}
            <span class="stwii--tt-hits">×${getHits(entry)} за сессию</span>
        </div>
        <div class="stwii--tt-content">${preview}</div>
    `;
    tt.classList.add('stwii--isActive');
    const rect = anchor.getBoundingClientRect();
    const tw = tt.offsetWidth || 300, th = tt.offsetHeight || 120;
    let left = rect.left, top = rect.bottom + 6;
    if (left + tw > window.innerWidth - 10) left = window.innerWidth - tw - 10;
    if (left < 10) left = 10;
    if (top + th > window.innerHeight - 10) top = rect.top - th - 6;
    tt.style.left = left + 'px';
    tt.style.top = top + 'px';
};

// ─── Инлайн-подсветка ─────────────────────────────────────────────────────────
let _hoveredEntry = null;
const clearInlineHighlights = () => {
    document.querySelectorAll('.stwii--highlight').forEach(el => {
        el.parentNode.replaceChild(document.createTextNode(el.textContent), el);
    });
    document.querySelectorAll('#chat .mes_text').forEach(el => el.normalize());
};
const setHighlightHover = (entryId, active) => {
    document.querySelectorAll(`.stwii--highlight[data-stwii-id="${CSS.escape(entryId)}"]`)
        .forEach(el => el.classList.toggle('stwii--highlight-active', active));
};

const highlightKeysInElement = (rootEl, entries) => {
    const keyMap = new Map();
    for (const entry of entries) {
        for (const k of (entry.key || [])) {
            if (k?.trim()) keyMap.set(k.toLowerCase(), entry);
        }
    }
    if (!keyMap.size) return;
    const sorted = [...keyMap.keys()].sort((a, b) => b.length - a.length);
    const escaped = sorted.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
            const p = node.parentElement;
            if (p.classList.contains('stwii--highlight')) return NodeFilter.FILTER_REJECT;
            if (['SCRIPT','STYLE','CODE'].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    const nodes = []; let n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (const textNode of nodes) {
        const text = textNode.textContent;
        if (!regex.test(text)) continue;
        regex.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0, m;
        while ((m = regex.exec(text)) !== null) {
            if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            const entry = keyMap.get(m[0].toLowerCase());
            const span = document.createElement('span');
            span.classList.add('stwii--highlight');
            span.dataset.stwiiStrategy = getStrategy(entry);
            span.dataset.stwiiId = `${entry.world}§§§${entry.uid}`;
            span.textContent = m[0];
            span.addEventListener('click', (e) => { e.stopPropagation(); showTooltip(entry, span); });
            frag.appendChild(span);
            last = m.index + m[0].length;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        textNode.parentNode.replaceChild(frag, textNode);
    }
};
const applyInlineHighlights = (entries) => {
    if (!(extension_settings.worldInfoInfo?.inlineHighlight ?? true)) return;
    clearInlineHighlights();
    const wiEntries = entries.filter(e => e.type === 'wi' && e.key?.length);
    document.querySelectorAll('#chat .mes_text').forEach(el => highlightKeysInElement(el, wiEntries));
};

// ─── Diff ─────────────────────────────────────────────────────────────────────
let _prevEntryIds = new Set();
const getDiffStatus = (entry) =>
    _prevEntryIds.has(`${entry.world}§§§${entry.uid}`) ? 'same' : 'new';

// ─── Свёрнутые группы ──────────────────────────────────────────────────────────
const _collapsedGroups = new Set();

// ─── Jump to WI entry ────────────────────────────────────────────────────────────
const jumpToEntry = async (entry) => {
    const btn = document.querySelector('#WIEntriesButEdit, .drawer-toggle[data-target="world_info_drawer"], [data-drawer="world_info"]');
    if (btn) btn.click();
    await delay(350);
    const sel = document.querySelector('#world_editor_select');
    if (sel) {
        const opt = [...sel.options].find(o => o.value === entry.world || o.textContent.trim() === entry.world);
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change')); await delay(250); }
    }
    const searchEl = document.querySelector('#world_info_search');
    if (searchEl) {
        searchEl.value = entry.comment?.length ? entry.comment : (entry.key?.[0] || '');
        searchEl.dispatchEvent(new Event('input'));
    }
};

// ─── Быстрый тогл записи ──────────────────────────────────────────────────────
const toggleEntry = async (entry) => {
    try {
        await SlashCommandParser.commands['wi-enabled']?.callback(
            { file: entry.world, _scope: null, _abortController: null },
            String(entry.uid),
        );
    } catch(e) {
        console.warn('[STWII] toggleEntry error:', e);
    }
};

// ─── Копировать контент ───────────────────────────────────────────────────────
const copyContent = (text) => {
    navigator.clipboard?.writeText(text).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.append(ta);
        ta.select(); document.execCommand('copy'); ta.remove();
    });
};

// ─── Отключить лорбук (убрать из чата) ───────────────────────────────────────
const detachBook = async (bookName) => {
    try {
        // Try via slash command first
        const cmd = SlashCommandParser.commands['world'];
        if (cmd) {
            await cmd.callback({ _scope: null, _abortController: null }, `off ${bookName}`);
            return true;
        }
    } catch(e) {}
    try {
        // Try REST API approach
        const resp = await fetch('/api/worlds/toggle-entry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: bookName, enable: false }),
        });
        if (resp.ok) return true;
    } catch(e) {}
    return false;
};

// ─── Генерация времени ────────────────────────────────────────────────────────
const formatTime = (ts) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

// ─── Стейт ────────────────────────────────────────────────────────────────────
let generationType;
eventSource.on(event_types.GENERATION_STARTED, (genType) => generationType = genType);

// ─── INIT ─────────────────────────────────────────────────────────────────────
const init = () => {
    console.log('🟢 [STWII] init()...');

    // ── Кнопка (иконка) ──────────────────────────────────────────────────────
    const trigger = document.createElement('div');
    trigger.classList.add('stwii--trigger', 'fa-solid', 'fa-fw', 'fa-book-atlas');
    trigger.title = 'Активный WI\n---\nПКМ — настройки';

    let isDragging = false, hasMoved = false, offsetX = 0, offsetY = 0;
    let touchStartTime = 0, touchStartX = 0, touchStartY = 0, justOpened = false;

    const savedPos = localStorage.getItem('stwii--trigger-position');
    if (savedPos) {
        try {
            const pos = JSON.parse(savedPos);
            const lv = parseFloat(pos.x), tv = parseFloat(pos.y);
            if (!isNaN(lv) && !isNaN(tv) && lv >= 0 && lv < window.innerWidth - 50 && tv >= 0 && tv < window.innerHeight - 50) {
                trigger.style.left = pos.x; trigger.style.top = pos.y;
            } else localStorage.removeItem('stwii--trigger-position');
        } catch(e) { localStorage.removeItem('stwii--trigger-position'); }
    }
    const savePosition = () => localStorage.setItem('stwii--trigger-position', JSON.stringify({ x: trigger.style.left, y: trigger.style.top }));
    const moveTrigger = (cx, cy) => {
        trigger.style.left = Math.max(0, Math.min(cx - offsetX, window.innerWidth  - trigger.offsetWidth))  + 'px';
        trigger.style.top  = Math.max(0, Math.min(cy - offsetY, window.innerHeight - trigger.offsetHeight)) + 'px';
    };
    trigger.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isDragging = true; hasMoved = false;
        const r = trigger.getBoundingClientRect();
        offsetX = e.clientX - r.left; offsetY = e.clientY - r.top;
        trigger.style.opacity = '0.7'; e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => { if (isDragging) { hasMoved = true; moveTrigger(e.clientX, e.clientY); e.preventDefault(); } });
    document.addEventListener('mouseup',   () => { if (isDragging) { isDragging = false; trigger.style.opacity = ''; if (hasMoved) savePosition(); } });
    trigger.addEventListener('touchstart', (e) => {
        touchStartTime = Date.now(); hasMoved = false; isDragging = true;
        const r = trigger.getBoundingClientRect(), t = e.touches[0];
        touchStartX = t.clientX; touchStartY = t.clientY;
        offsetX = t.clientX - r.left; offsetY = t.clientY - r.top;
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const t = e.touches[0];
        if (Math.abs(t.clientX - touchStartX) > 10 || Math.abs(t.clientY - touchStartY) > 10) {
            hasMoved = true; trigger.style.opacity = '0.7'; moveTrigger(t.clientX, t.clientY); e.preventDefault();
        }
    }, { passive: false });
    trigger.addEventListener('touchend', (e) => {
        const dur = Date.now() - touchStartTime;
        isDragging = false; trigger.style.opacity = '';
        if (hasMoved) { savePosition(); e.preventDefault(); e.stopPropagation(); }
        else if (dur < 300) { toggleMainPanel(); e.preventDefault(); e.stopPropagation(); }
        hasMoved = false;
    }, { capture: true });
    document.body.append(trigger);

    // ── Панели ───────────────────────────────────────────────────────────────
    const mainPanel   = document.createElement('div');
    mainPanel.classList.add('stwii--panel', 'stwii--mainPanel');
    const configPanel = document.createElement('div');
    configPanel.classList.add('stwii--panel');

    const positionPanel = (panelEl) => {
        const rect = trigger.getBoundingClientRect();
        const pw = Math.min(380, window.innerWidth - 20);
        const wasHidden = !panelEl.classList.contains('stwii--isActive');
        if (wasHidden) { panelEl.style.visibility = 'hidden'; panelEl.style.display = 'flex'; }
        const ph = panelEl.offsetHeight;
        if (wasHidden) { panelEl.style.display = ''; panelEl.style.visibility = ''; }
        let left = rect.right + 10 + pw <= window.innerWidth ? rect.right + 10
                 : rect.left - 10 - pw >= 0                  ? rect.left - pw - 10
                 : Math.max(10, (window.innerWidth - pw) / 2);
        let top = Math.max(10, Math.min(rect.top, window.innerHeight - ph - 10));
        panelEl.style.left = left + 'px'; panelEl.style.top = top + 'px';
    };

    const toggleMainPanel = () => {
        configPanel.classList.remove('stwii--isActive');
        const opening = !mainPanel.classList.contains('stwii--isActive');
        mainPanel.classList.toggle('stwii--isActive');
        if (opening) { justOpened = true; positionPanel(mainPanel); setTimeout(() => justOpened = false, 300); }
    };
    const toggleConfigPanel = () => {
        mainPanel.classList.remove('stwii--isActive');
        const opening = !configPanel.classList.contains('stwii--isActive');
        configPanel.classList.toggle('stwii--isActive');
        if (opening) { justOpened = true; positionPanel(configPanel); setTimeout(() => justOpened = false, 300); }
    };
    const closePanels = () => { mainPanel.classList.remove('stwii--isActive'); configPanel.classList.remove('stwii--isActive'); };
    trigger.addEventListener('click', (e) => { if (hasMoved) { hasMoved = false; return; } e.stopPropagation(); toggleMainPanel(); });
    trigger.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); toggleConfigPanel(); });
    document.addEventListener('click', (e) => { if (justOpened) return; if (!mainPanel.contains(e.target) && !configPanel.contains(e.target) && !trigger.contains(e.target)) closePanels(); });
    document.addEventListener('touchstart', (e) => { if (justOpened) return; if (!mainPanel.contains(e.target) && !configPanel.contains(e.target) && !trigger.contains(e.target)) closePanels(); }, { passive: true });
    window.addEventListener('resize', () => {
        if (mainPanel.classList.contains('stwii--isActive'))   positionPanel(mainPanel);
        if (configPanel.classList.contains('stwii--isActive')) positionPanel(configPanel);
    });

    // ── Главная панель: вкладки ───────────────────────────────────────────────
    const tabBar = document.createElement('div');
    tabBar.classList.add('stwii--tabBar');

    const tabContents = {};
    const tabs = [
        { id: 'entries',  label: '📚 Записи'  },
        { id: 'books',    label: '📖 Лорбуки' },
        { id: 'history',  label: '📜 История' },
    ];
    let activeTab = 'entries';

    const switchTab = (id) => {
        activeTab = id;
        tabBar.querySelectorAll('.stwii--tab').forEach(t => t.classList.toggle('stwii--tab-active', t.dataset.tab === id));
        Object.entries(tabContents).forEach(([k, el]) => el.style.display = k === id ? '' : 'none');
    };

    tabs.forEach(({ id, label }) => {
        const btn = document.createElement('button');
        btn.classList.add('stwii--tab');
        btn.dataset.tab = id;
        btn.textContent = label;
        btn.addEventListener('click', () => switchTab(id));
        tabBar.append(btn);
        const content = document.createElement('div');
        content.classList.add('stwii--tabContent');
        content.style.display = 'none';
        tabContents[id] = content;
    });
    mainPanel.append(tabBar);
    Object.values(tabContents).forEach(el => mainPanel.append(el));
    switchTab('entries');

    // ── Поиск ─────────────────────────────────────────────────────────────────
    const searchBar = document.createElement('input');
    searchBar.classList.add('stwii--search');
    searchBar.type = 'text';
    searchBar.placeholder = '🔍 Поиск записей...';
    searchBar.addEventListener('input', () => renderEntries());
    tabContents.entries.append(searchBar);

    // ── Token budget bar ──────────────────────────────────────────────────────
    const budgetWrap = document.createElement('div');
    budgetWrap.classList.add('stwii--budgetWrap');
    const budgetBar  = document.createElement('div');
    budgetBar.classList.add('stwii--budgetBar');
    const budgetFill = document.createElement('div');
    budgetFill.classList.add('stwii--budgetFill');
    const budgetLabel = document.createElement('div');
    budgetLabel.classList.add('stwii--budgetLabel');
    budgetLabel.textContent = '—';
    budgetBar.append(budgetFill);
    budgetWrap.append(budgetBar, budgetLabel);
    tabContents.entries.append(budgetWrap);

    const entriesContainer = document.createElement('div');
    entriesContainer.classList.add('stwii--entriesContainer');
    tabContents.entries.append(entriesContainer);

    // ── Бейдж ─────────────────────────────────────────────────────────────────
    let entries = [], count = -1;
    const updateBadge = async (newEntries) => {
        if (count !== newEntries.length) {
            if (newEntries.length === 0) {
                trigger.classList.add('stwii--badge-out'); await delay(510);
                trigger.setAttribute('data-stwii--badge-count', '0'); trigger.classList.remove('stwii--badge-out');
            } else if (count === 0) {
                trigger.classList.add('stwii--badge-in');
                trigger.setAttribute('data-stwii--badge-count', newEntries.length.toString());
                await delay(510); trigger.classList.remove('stwii--badge-in');
            } else {
                trigger.setAttribute('data-stwii--badge-count', newEntries.length.toString());
                trigger.classList.add('stwii--badge-bounce'); await delay(1010); trigger.classList.remove('stwii--badge-bounce');
            }
            count = newEntries.length;
        } else if (new Set(newEntries).difference(new Set(entries)).size > 0) {
            trigger.classList.add('stwii--badge-bounce'); await delay(1010); trigger.classList.remove('stwii--badge-bounce');
        }
        entries = newEntries;
    };

    let currentEntryList = [];
    let currentChat = [];

    // ── Отрисовка вкладки "Записи" ────────────────────────────────────────────
    const renderEntries = () => {
        const cfg = extension_settings.worldInfoInfo || {};
        const isGrouped   = cfg.group          ?? true;
        const isOrdered   = cfg.order          ?? true;
        const isMes       = cfg.mes            ?? true;
        const showTokens  = cfg.showTokens     ?? true;
        const showKey     = cfg.showMatchedKey ?? true;
        const doDiff      = cfg.diffHighlight  ?? true;
        const compact      = cfg.compact        ?? false;
        const sortByTokens = cfg.sortByTokens   ?? false;
        const query        = searchBar.value.toLowerCase().trim();

        const wiList = currentEntryList.filter(e => e.type === 'wi');

        // Update budget bar
        const totalTokens = wiList.reduce((s, e) => s + (e.estimatedTokens || 0), 0);
        const contextLimit = cfg.contextLimit || 4096;
        const pct = Math.min(100, Math.round(totalTokens / contextLimit * 100));
        budgetFill.style.width = pct + '%';
        budgetFill.classList.toggle('stwii--budget-warn', pct > 75);
        budgetFill.classList.toggle('stwii--budget-crit', pct > 95);
        budgetLabel.textContent = `${totalTokens} tok / ${contextLimit} (${pct}%)`;

        entriesContainer.innerHTML = '';
        if (!currentEntryList.length) { entriesContainer.innerHTML = '<div class="stwii--empty">Нет активных записей</div>'; return; }

        let list = [...currentEntryList];
        if (query) {
            list = list.filter(e => {
                if (e.type !== 'wi') return false;
                const name = (e.comment?.length ? e.comment : e.key?.join(', ') || '').toLowerCase();
                const keys = (e.key || []).join(' ').toLowerCase();
                return name.includes(query) || keys.includes(query);
            });
        }

        let grouped = isGrouped ? Object.groupBy(list, it => it.world || '—') : { 'Записи WI': [...list] };
        const depthPos = [world_info_position.ANBottom, world_info_position.ANTop, world_info_position.atDepth];

        for (const [world, ents] of Object.entries(grouped)) {
            if (!ents?.length) continue;
            for (const e of ents) {
                if (e.type !== 'wi') continue;
                e.depth = e.position === world_info_position.atDepth
                    ? e.depth
                    : (chat_metadata[metadata_keys.depth] + (e.position === world_info_position.ANTop ? 0.1 : 0));
            }

            let groupContainer = entriesContainer;
            if (isGrouped) {
                const isCollapsed = _collapsedGroups.has(world);
                const worldEl = document.createElement('div');
                worldEl.classList.add('stwii--world');
                worldEl.style.cursor = 'pointer';
                worldEl.title = isCollapsed ? 'Развернуть группу' : 'Свернуть группу';
                const chevron = document.createElement('span');
                chevron.classList.add('stwii--chevron');
                chevron.textContent = isCollapsed ? ' ▸' : ' ▾';
                const dot = document.createElement('span');
                dot.classList.add('stwii--worldDot');
                dot.style.background = getBookColor(world);
                const lbl = document.createElement('span');
                lbl.textContent = world;
                const groupTokens = ents.filter(e=>e.type==='wi').reduce((s,e)=>s+(e.estimatedTokens||0),0);
                if (showTokens) {
                    const gt = document.createElement('span');
                    gt.classList.add('stwii--groupTokens');
                    gt.textContent = `~${groupTokens}t`;
                    worldEl.append(dot, lbl, gt, chevron);
                } else { worldEl.append(dot, lbl, chevron); }
                worldEl.addEventListener('click', () => {
                    if (_collapsedGroups.has(world)) _collapsedGroups.delete(world);
                    else _collapsedGroups.add(world);
                    renderEntries();
                });
                groupContainer = document.createElement('div');
                groupContainer.classList.add('stwii--groupContainer');
                if (isCollapsed) groupContainer.classList.add('stwii--collapsed');
                entriesContainer.append(worldEl, groupContainer);
            }

            ents.sort((a, b) => {
                if (sortByTokens) return (b.estimatedTokens || 0) - (a.estimatedTokens || 0);
                if (isOrdered) {
                    if (!depthPos.includes(a.position) && !depthPos.includes(b.position)) return a.position - b.position;
                    if ( depthPos.includes(a.position) && !depthPos.includes(b.position)) return 1;
                    if (!depthPos.includes(a.position) &&  depthPos.includes(b.position)) return -1;
                    if ((a.depth ?? Number.MAX_SAFE_INTEGER) < (b.depth ?? Number.MAX_SAFE_INTEGER)) return 1;
                    if ((a.depth ?? Number.MAX_SAFE_INTEGER) > (b.depth ?? Number.MAX_SAFE_INTEGER)) return -1;
                    if ((a.order ?? Number.MAX_SAFE_INTEGER) > (b.order ?? Number.MAX_SAFE_INTEGER)) return 1;
                    if ((a.order ?? Number.MAX_SAFE_INTEGER) < (b.order ?? Number.MAX_SAFE_INTEGER)) return -1;
                }
                return (a.comment?.length ? a.comment : a.key.join(', ')).toLowerCase()
                    .localeCompare((b.comment?.length ? b.comment : b.key.join(', ')).toLowerCase());
            });

            for (const entry of ents) {
                if (entry.type !== 'wi') continue;
                const el = document.createElement('div');
                el.classList.add('stwii--entry');
                if (compact) el.classList.add('stwii--compact');

                // Broken check
                const wipChar = [world_info_position.before, world_info_position.after];
                const wipEx   = [world_info_position.EMTop, world_info_position.EMBottom];
                if ([...wipChar, ...wipEx].includes(entry.position) && main_api === 'openai') {
                    const pm = promptManager.getPromptCollection().collection;
                    if (wipChar.includes(entry.position) && !pm.find(it => it.identifier === 'charDescription')) {
                        el.classList.add('stwii--isBroken');
                    } else if (wipEx.includes(entry.position) && !pm.find(it => it.identifier === 'dialogueExamples')) {
                        el.classList.add('stwii--isBroken');
                    }
                }

                // Diff highlight
                if (doDiff && getDiffStatus(entry) === 'new') el.classList.add('stwii--isNew');

                // Book color strip
                const colorStrip = document.createElement('div');
                colorStrip.classList.add('stwii--colorStrip');
                colorStrip.style.background = getBookColor(entry.world || '');
                el.append(colorStrip);

                // Strategy icon
                const strat = document.createElement('div');
                strat.classList.add('stwii--strategy');
                const s = getStrategy(entry);
                strat.textContent = STRATEGIES[s].icon;
                strat.title = STRATEGIES[s].label;
                strat.dataset.stwiiStrategy = s;
                el.append(strat);

                // Title + key
                const titleWrap = document.createElement('div');
                titleWrap.classList.add('stwii--titleWrap');
                const title = document.createElement('div');
                title.classList.add('stwii--title');
                title.textContent = entry.comment?.length ? entry.comment : entry.key.join(', ');
                titleWrap.append(title);
                if (showKey && entry.matchedKey && !compact) {
                    const keyLbl = document.createElement('div');
                    keyLbl.classList.add('stwii--matchedKey');
                    keyLbl.textContent = `🔑 ${entry.matchedKey}`;
                    titleWrap.append(keyLbl);
                }
                el.append(titleWrap);

                // NEW badge — first time in session
                if (isSessionNew(entry)) {
                    const newBadge = document.createElement('span');
                    newBadge.classList.add('stwii--newBadge');
                    newBadge.textContent = 'NEW';
                    newBadge.title = 'Эта запись активировалась впервые за сессию';
                    el.insertBefore(newBadge, el.querySelector('.stwii--tokens') || el.querySelector('.stwii--actions') || null);
                }

                // Token count
                if (showTokens && !compact) {
                    const tok = document.createElement('div');
                    tok.classList.add('stwii--tokens');
                    tok.textContent = `~${entry.estimatedTokens || 0}t`;
                    el.append(tok);
                }

                // Session hits
                const hits = getHits(entry);
                if (hits > 0 && !compact) {
                    const hitsEl = document.createElement('div');
                    hitsEl.classList.add('stwii--hits');
                    hitsEl.textContent = `×${hits}`;
                    hitsEl.title = `Сработало ${hits} раз за сессию`;
                    el.append(hitsEl);
                }

                // Sticky
                if (entry.sticky) {
                    const stEl = document.createElement('div');
                    stEl.classList.add('stwii--sticky');
                    stEl.textContent = `📌${entry.sticky}`;
                    stEl.title = `Sticky: ещё ${entry.sticky} раундов`;
                    el.append(stEl);
                }

                // Action buttons
                const actions = document.createElement('div');
                actions.classList.add('stwii--actions');

                // 📋 Copy
                const copyBtn = document.createElement('button');
                copyBtn.classList.add('stwii--actionBtn');
                copyBtn.title = 'Скопировать контент';
                copyBtn.textContent = '📋';
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    copyContent(entry.content || '');
                    copyBtn.textContent = '✅';
                    setTimeout(() => copyBtn.textContent = '📋', 1200);
                });

                // ⏸ Quick toggle (enable/disable entry without opening lorebook)
                const toggleBtn = document.createElement('button');
                toggleBtn.classList.add('stwii--actionBtn');
                toggleBtn.textContent = '⏸';
                toggleBtn.title = 'Включить / выключить запись';
                toggleBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    toggleBtn.textContent = '⏳';
                    await toggleEntry(entry);
                    toggleBtn.textContent = '⏸';
                });

                // 🔗 Jump to entry in lorebook editor
                const jumpBtn = document.createElement('button');
                jumpBtn.classList.add('stwii--actionBtn');
                jumpBtn.textContent = '🔗';
                jumpBtn.title = 'Открыть запись в редакторе лорбука';
                jumpBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await jumpToEntry(entry);
                });

                actions.append(copyBtn, toggleBtn, jumpBtn);
                el.append(actions);

                // Tooltip on click
                el.style.cursor = 'help';
                el.addEventListener('click', () => showTooltip(entry, el));

                // Reverse highlight on hover
                const entryId = `${entry.world}§§§${entry.uid}`;
                el.addEventListener('mouseenter', () => { _hoveredEntry = entryId; setHighlightHover(entryId, true); });
                el.addEventListener('mouseleave', () => { _hoveredEntry = null;    setHighlightHover(entryId, false); });

                groupContainer.append(el);
            }
        }

        if (mainPanel.classList.contains('stwii--isActive')) positionPanel(mainPanel);
    };

    // ── Отрисовка вкладки "Лорбуки" ──────────────────────────────────────────
    const renderBooks = () => {
        tabContents.books.innerHTML = '';

        const bookMap = new Map(); // bookName → {entries:[], totalTokens}
        for (const e of currentEntryList) {
            if (e.type !== 'wi') continue;
            if (!bookMap.has(e.world)) bookMap.set(e.world, { entries: [], totalTokens: 0 });
            const b = bookMap.get(e.world);
            b.entries.push(e);
            b.totalTokens += e.estimatedTokens || 0;
        }

        if (!bookMap.size) {
            tabContents.books.innerHTML = '<div class="stwii--empty">Нет активных лорбуков</div>';
            return;
        }

        const selectedBooks = new Set();
        const updateDetachBtn = () => {
            detachBtn.disabled = selectedBooks.size === 0;
            detachBtn.textContent = selectedBooks.size
                ? `🗑 Отключить выбранные (${selectedBooks.size})`
                : '🗑 Отключить выбранные';
        };

        for (const [name, data] of bookMap.entries()) {
            const row = document.createElement('label');
            row.classList.add('stwii--bookRow');

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.classList.add('stwii--bookCheck');
            cb.addEventListener('change', () => {
                if (cb.checked) selectedBooks.add(name); else selectedBooks.delete(name);
                updateDetachBtn();
            });

            const dot = document.createElement('span');
            dot.classList.add('stwii--worldDot');
            dot.style.background = getBookColor(name);

            const lbl = document.createElement('span');
            lbl.classList.add('stwii--bookName');
            lbl.textContent = name;

            const meta = document.createElement('span');
            meta.classList.add('stwii--bookMeta');
            meta.textContent = `${data.entries.length} зап. · ~${data.totalTokens}t`;

            row.append(cb, dot, lbl, meta);
            tabContents.books.append(row);
        }

        const detachBtn = document.createElement('button');
        detachBtn.classList.add('stwii--detachBtn');
        detachBtn.textContent = '🗑 Отключить выбранные';
        detachBtn.disabled = true;
        detachBtn.addEventListener('click', async () => {
            if (!selectedBooks.size) return;
            detachBtn.textContent = '⏳ Отключаем...';
            detachBtn.disabled = true;
            for (const name of selectedBooks) {
                const ok = await detachBook(name);
                console.log(`[STWII] Detach "${name}":`, ok ? 'OK' : 'FAIL');
            }
            selectedBooks.clear();
            setTimeout(() => renderBooks(), 500);
        });
        tabContents.books.append(detachBtn);
    };

    // ── Отрисовка вкладки "История" ───────────────────────────────────────────
    const renderHistory = () => {
        tabContents.history.innerHTML = '';
        if (!activationHistory.length) {
            tabContents.history.innerHTML = '<div class="stwii--empty">История пуста</div>';
            return;
        }
        for (let i = activationHistory.length - 1; i >= 0; i--) {
            const snap = activationHistory[i];
            const block = document.createElement('div');
            block.classList.add('stwii--histBlock');

            const header = document.createElement('div');
            header.classList.add('stwii--histHeader');
            header.textContent = `🕐 ${formatTime(snap.ts)} · ${snap.entries.length} записей`;

            const diffs = document.createElement('div');
            diffs.classList.add('stwii--histDiffs');

            snap.added.forEach(e => {
                const d = document.createElement('div');
                d.classList.add('stwii--histAdded');
                d.textContent = `+ ${e.comment || e.key?.join(', ') || e.uid}`;
                diffs.append(d);
            });
            snap.removed.forEach(e => {
                const d = document.createElement('div');
                d.classList.add('stwii--histRemoved');
                d.textContent = `− ${e.comment || e.key?.join(', ') || e.uid}`;
                diffs.append(d);
            });

            if (!snap.added.length && !snap.removed.length) {
                diffs.innerHTML = '<span class="stwii--histSame">Без изменений</span>';
            }

            block.append(header, diffs);
            tabContents.history.append(block);
        }
    };

    // ── Конфиг-панель (ПКМ) ───────────────────────────────────────────────────
    const addConfigRow = (key, def, label, title, onChange) => {
        const row = document.createElement('label');
        row.classList.add('stwii--configRow');
        row.title = title;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = extension_settings.worldInfoInfo?.[key] ?? def;
        cb.addEventListener('click', () => {
            if (!extension_settings.worldInfoInfo) extension_settings.worldInfoInfo = {};
            extension_settings.worldInfoInfo[key] = cb.checked;
            if (onChange) onChange(cb.checked);
            saveSettingsDebounced();
        });
        const lbl = document.createElement('div');
        lbl.textContent = label;
        row.append(cb, lbl);
        configPanel.append(row);
        return cb;
    };

    const cfgTitle = document.createElement('div');
    cfgTitle.classList.add('stwii--cfgTitle');
    cfgTitle.textContent = '⚙️ Настройки WI Info';
    configPanel.append(cfgTitle);

    addConfigRow('group',           true,  '📚 Группировать по книгам',          'Группировать записи по файлам лорбуков',            () => renderEntries());
    addConfigRow('order',           true,  '📐 Сортировка по глубине',            'Сортировать по порядку вставки в промпт',            () => renderEntries());
    addConfigRow('mes',             true,  '💬 Показывать сообщения',             'Показывать историю сообщений (без группировки)',      () => renderEntries());
    addConfigRow('showTokens',      true,  '🪙 Счётчик токенов',                  'Показывать ~кол-во токенов на запись/книгу',          () => renderEntries());
    addConfigRow('showMatchedKey',  true,  '🔑 Показывать тригер-ключ',           'Показывать какое слово активировало запись',          () => renderEntries());
    addConfigRow('inlineHighlight', true,  '✨ Подсвечивать слова в чате',         'Подчёркивать тригер-слова в сообщениях чата',         (v) => { if (!v) clearInlineHighlights(); else applyInlineHighlights(currentEntryList); });
    addConfigRow('diffHighlight',   true,  '🆕 Подсвечивать новые записи',        'Анимировать записи, которые появились с прошлой ген', () => renderEntries());
    addConfigRow('compact',         false, '📦 Компактный режим',                 'Компактный список без подробностей',                  () => renderEntries());
    addConfigRow('sortByTokens',    false, '🪙 Сортировка по токенам',            'Самые тяжёлые записи показываются сверху',            () => renderEntries());

    // Лимит токенов контекста
    const ctxRow = document.createElement('div');
    ctxRow.classList.add('stwii--configRow', 'stwii--cfgCtxRow');
    const ctxLabel = document.createElement('label');
    ctxLabel.textContent = '📏 Лимит контекста (tok):';
    const ctxInput = document.createElement('input');
    ctxInput.type = 'number';
    ctxInput.classList.add('stwii--ctxInput');
    ctxInput.value = extension_settings.worldInfoInfo?.contextLimit || 4096;
    ctxInput.min = 512; ctxInput.max = 200000; ctxInput.step = 512;
    ctxInput.addEventListener('change', () => {
        if (!extension_settings.worldInfoInfo) extension_settings.worldInfoInfo = {};
        extension_settings.worldInfoInfo.contextLimit = parseInt(ctxInput.value) || 4096;
        saveSettingsDebounced();
        renderEntries();
    });
    ctxRow.append(ctxLabel, ctxInput);
    configPanel.append(ctxRow);

    document.body.append(mainPanel, configPanel);

    // ── Событие: WI активирован ───────────────────────────────────────────────
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, async (entryList) => {
        // Snapshot for history
        const prevIds  = new Set(currentEntryList.filter(e=>e.type==='wi').map(e=>`${e.world}§§§${e.uid}`));
        const newIds   = new Set(entryList.map(e=>`${e.world}§§§${e.uid}`));
        const addedE   = entryList.filter(e => !prevIds.has(`${e.world}§§§${e.uid}`));
        const removedE = currentEntryList.filter(e => e.type==='wi' && !newIds.has(`${e.world}§§§${e.uid}`));

        _prevEntryIds = prevIds;
        updateBadge(entryList.map(it => `${it.world}§§§${it.uid}`));

        // Mark first-timers BEFORE bumping hits
        _genFirstTimers = new Set(
            entryList
                .filter(e => !sessionHits.has(`${e.world}§§§${e.uid}`))
                .map(e => `${e.world}§§§${e.uid}`)
        );

        const recentText = getRecentChatText();
        for (const entry of entryList) {
            entry.type = 'wi';
            entry.matchedKey      = entry.constant ? null : findMatchedKey(entry, recentText);
            entry.estimatedTokens = estimateTokens(entry.content);
            bumpHit(entry);
            entry.sticky = parseInt(/**@type {string}*/(await SlashCommandParser.commands['wi-get-timed-effect'].callback(
                { effect: 'sticky', format: 'number', file: `${entry.world}`, _scope: null, _abortController: null },
                entry.uid,
            )));
        }

        // Save to history
        activationHistory.push({ ts: Date.now(), entries: [...entryList], added: addedE, removed: removedE });
        if (activationHistory.length > MAX_HISTORY) activationHistory.shift();

        currentEntryList = [...entryList];

        renderEntries();
        renderBooks();
        if (activeTab === 'history') renderHistory();

        setTimeout(() => applyInlineHighlights(currentEntryList), 300);
    });

    // Обновить историю при переключении на неё
    tabBar.querySelectorAll('.stwii--tab').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.tab === 'history') renderHistory();
            if (btn.dataset.tab === 'books')   renderBooks();
        });
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        if (currentEntryList.length) setTimeout(() => applyInlineHighlights(currentEntryList), 100);
    });
    eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
        if (currentEntryList.length) setTimeout(() => applyInlineHighlights(currentEntryList), 100);
    });

    // ── Console intercept (0 записей) ─────────────────────────────────────────
    const _origDebug = console.debug;
    console.debug = function(...args) {
        if (['[WI] Found 0 world lore entries. Sorted by strategy', '[WI] Adding 0 entries to prompt'].includes(args[0])) {
            entriesContainer.innerHTML = '<div class="stwii--empty">Нет активных записей</div>';
            updateBadge([]); clearInlineHighlights();
            currentEntryList = [];
            renderBooks();
        }
        return _origDebug.bind(console)(...args);
    };
    const _origLog = console.log;
    console.log = function(...args) {
        if (['[WI] Found 0 world lore entries. Sorted by strategy', '[WI] Adding 0 entries to prompt'].includes(args[0])) {
            entriesContainer.innerHTML = '<div class="stwii--empty">Нет активных записей</div>';
            updateBadge([]); clearInlineHighlights();
            currentEntryList = [];
            renderBooks();
        }
        return _origLog.bind(console)(...args);
    };

    // ── Slash commands ────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-triggered',
        callback: () => JSON.stringify(currentEntryList),
        returns: 'список активных WI записей',
        helpString: 'Получить список WI записей, активированных на последней генерации.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-tokens',
        callback: () => {
            const total = currentEntryList.filter(e=>e.type==='wi').reduce((s,e)=>s+(e.estimatedTokens||0),0);
            return String(total);
        },
        returns: 'суммарные токены активных WI записей',
        helpString: 'Вернуть суммарную оценку токенов активных WI записей.',
    }));

    console.log('🟢 [STWII] v3.0 загружено!');
};

init();
