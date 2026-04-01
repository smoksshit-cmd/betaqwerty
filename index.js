import { chat, chat_metadata, event_types, eventSource, main_api, saveSettingsDebounced } from '../../../../script.js';
import { metadata_keys } from '../../../authors-note.js';
import { extension_settings } from '../../../extensions.js';
import { promptManager } from '../../../openai.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { delay } from '../../../utils.js';
import { world_info_position } from '../../../world-info.js';

console.log('🟢 [STWII] v3.0 loading...');

// ─── Strategy config ──────────────────────────────────────────────────────────
const STRATEGIES = {
    constant:   { icon: '🔵', label: 'Constant',   cssKey: 'constant'   },
    normal:     { icon: '🟢', label: 'Key Match',  cssKey: 'normal'     },
    vectorized: { icon: '🔗', label: 'Vectorized', cssKey: 'vectorized' },
};

const getStrategy = (entry) => {
    if (entry.constant === true)   return 'constant';
    if (entry.vectorized === true) return 'vectorized';
    return 'normal';
};

// ─── Token estimation (~1.3 per word) ────────────────────────────────────────
const estimateTokens = (text) => {
    if (!text) return 0;
    return Math.ceil((text.match(/\S+/g) || []).length * 1.3);
};

// ─── Find which key triggered an entry ───────────────────────────────────────
const findMatchedKey = (entry, searchText) => {
    if (!searchText || !entry.key?.length) return null;
    const lower = searchText.toLowerCase();
    for (const key of entry.key) {
        if (key?.trim() && lower.includes(key.toLowerCase())) return key;
    }
    return null;
};

const getRecentChatText = (depth = 15) =>
    chat.slice(-depth).map(m => m.mes || '').join('\n');

// ─── Session hit counter (per-session, in memory) ─────────────────────────────
const sessionHits = new Map(); // key: `${world}§§§${uid}` → count

const incrementHit = (world, uid) => {
    const key = `${world}§§§${uid}`;
    sessionHits.set(key, (sessionHits.get(key) || 0) + 1);
};

// ─── Activation history (last 20 generations) ────────────────────────────────
const MAX_HISTORY = 20;
const activationHistory = []; // [{timestamp, added:[], removed:[], entries:[]}]

const recordHistory = (newEntries, prevEntries) => {
    const newIds  = new Set(newEntries.map(e => `${e.world}§§§${e.uid}`));
    const prevIds = new Set(prevEntries.filter(e => e.type === 'wi').map(e => `${e.world}§§§${e.uid}`));
    const added   = newEntries.filter(e => !prevIds.has(`${e.world}§§§${e.uid}`)).map(e => e.comment || e.key?.join(', '));
    const removed = prevEntries.filter(e => e.type === 'wi' && !newIds.has(`${e.world}§§§${e.uid}`)).map(e => e.comment || e.key?.join(', '));
    activationHistory.unshift({ timestamp: Date.now(), added, removed, count: newEntries.length });
    if (activationHistory.length > MAX_HISTORY) activationHistory.pop();
};

// ─── Book color assignment ────────────────────────────────────────────────────
const BOOK_COLORS = [
    '#4f98a3','#9b59b6','#e67e22','#27ae60','#e74c3c',
    '#2980b9','#f39c12','#1abc9c','#d35400','#8e44ad',
];
const bookColorMap = new Map();
let bookColorIdx = 0;
const getBookColor = (world) => {
    if (!bookColorMap.has(world)) {
        bookColorMap.set(world, BOOK_COLORS[bookColorIdx % BOOK_COLORS.length]);
        bookColorIdx++;
    }
    return bookColorMap.get(world);
};

// ─── Diff tracking ────────────────────────────────────────────────────────────
let _prevEntryIds = new Set();

// ─── Inline tooltip ───────────────────────────────────────────────────────────
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

const showInlineTooltip = (entry, anchor) => {
    const tt = getTooltip();
    const strat   = getStrategy(entry);
    const tokens  = estimateTokens(entry.content);
    const hits    = sessionHits.get(`${entry.world}§§§${entry.uid}`) || 0;
    const title   = entry.comment?.length ? entry.comment : entry.key.join(', ');
    const preview = (entry.content || '').slice(0, 400) + ((entry.content?.length || 0) > 400 ? '…' : '');
    const color   = getBookColor(entry.world);

    tt.innerHTML = `
        <div class="stwii--tt-header" style="border-left:3px solid ${color}; padding-left:0.5em;">
            <span class="stwii--tt-icon">${STRATEGIES[strat].icon}</span>
            <span class="stwii--tt-title">${title}</span>
            <span class="stwii--tt-tokens">~${tokens} tok</span>
        </div>
        <div class="stwii--tt-meta">
            <span class="stwii--tt-world" style="color:${color}">[${entry.world}]</span>
            ${entry.matchedKey ? `<span class="stwii--tt-key">🔑 <em>${entry.matchedKey}</em></span>` : ''}
            ${hits > 0 ? `<span class="stwii--tt-hits">×${hits} this session</span>` : ''}
        </div>
        <div class="stwii--tt-content">${preview}</div>
        <div class="stwii--tt-actions">
            <button class="stwii--tt-btn stwii--tt-copy" title="Copy content">📋 Copy</button>
        </div>
    `;
    tt.querySelector('.stwii--tt-copy').addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(entry.content || '').then(() => {
            tt.querySelector('.stwii--tt-copy').textContent = '✅ Copied!';
            setTimeout(() => { if (tt.querySelector('.stwii--tt-copy')) tt.querySelector('.stwii--tt-copy').textContent = '📋 Copy'; }, 1500);
        });
    });

    tt.classList.add('stwii--isActive');
    const rect = anchor.getBoundingClientRect();
    const tw = tt.offsetWidth  || 320;
    const th = tt.offsetHeight || 140;
    let left = rect.left;
    let top  = rect.bottom + 6;
    if (left + tw > window.innerWidth  - 10) left = window.innerWidth  - tw - 10;
    if (left < 10) left = 10;
    if (top  + th > window.innerHeight - 10) top = rect.top - th - 6;
    tt.style.left = left + 'px';
    tt.style.top  = top  + 'px';
};

// ─── Inline key highlighting ──────────────────────────────────────────────────
const clearInlineHighlights = () => {
    document.querySelectorAll('.stwii--highlight').forEach(el => {
        el.parentNode.replaceChild(document.createTextNode(el.textContent), el);
    });
    document.querySelectorAll('#chat .mes_text').forEach(el => el.normalize());
};

const highlightKeysInElement = (rootEl, entries) => {
    const keyMap = new Map();
    for (const entry of entries) {
        for (const key of (entry.key || [])) {
            if (key?.trim()) keyMap.set(key.toLowerCase(), entry);
        }
    }
    if (!keyMap.size) return;
    const sortedKeys = [...keyMap.keys()].sort((a, b) => b.length - a.length);
    const escaped = sortedKeys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regex = new RegExp(`(${escaped.join('|')})`, 'gi');

    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
            const p = node.parentElement;
            if (p.classList.contains('stwii--highlight')) return NodeFilter.FILTER_REJECT;
            if (['SCRIPT','STYLE','CODE'].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    const nodes = [];
    let n;
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
            const color = getBookColor(entry.world);
            const span  = document.createElement('span');
            span.classList.add('stwii--highlight');
            span.dataset.stwiiStrategy = getStrategy(entry);
            span.style.setProperty('--stwii-hl-color', color);
            span.textContent = m[0];
            span.addEventListener('click', (e) => { e.stopPropagation(); showInlineTooltip(entry, span); });
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

// ─── Reverse highlight (hover entry in panel → flash in chat) ────────────────
const reverseHighlight = (entry, active) => {
    document.querySelectorAll('.stwii--highlight').forEach(span => {
        const key = span.textContent.toLowerCase();
        const isMatch = (entry.key || []).some(k => k.toLowerCase() === key);
        if (isMatch) {
            if (active) span.classList.add('stwii--hl-reverse');
            else        span.classList.remove('stwii--hl-reverse');
        }
    });
};

// ─── Keyboard shortcut Alt+W ──────────────────────────────────────────────────
// (bound after panel/trigger created)

// ─── Token budget bar ─────────────────────────────────────────────────────────
const getContextLimit = () => {
    try {
        const ctx = extension_settings?.openai?.openai_max_context
            || extension_settings?.claude?.claude_max_context
            || extension_settings?.textgenerationwebui?.max_length
            || 4096;
        return parseInt(ctx) || 4096;
    } catch { return 4096; }
};

// ─── Init ─────────────────────────────────────────────────────────────────────
let generationType;
eventSource.on(event_types.GENERATION_STARTED, (genType) => generationType = genType);

const init = () => {
    console.log('🟢 [STWII] init() v3.0');

    const trigger = document.createElement('div');
    trigger.classList.add('stwii--trigger', 'fa-solid', 'fa-fw', 'fa-book-atlas');
    trigger.title = 'Active WI\n---\nright click for options\nAlt+W to toggle';

    // ── Drag ─────────────────────────────────────────────────────────────────
    let isDragging = false, hasMoved = false;
    let offsetX = 0, offsetY = 0;
    let touchStartTime = 0, touchStartX = 0, touchStartY = 0;
    let justOpened = false;

    const savedPos = localStorage.getItem('stwii--trigger-position');
    if (savedPos) {
        try {
            const pos = JSON.parse(savedPos);
            const lv = parseFloat(pos.x), tv = parseFloat(pos.y);
            if (!isNaN(lv) && !isNaN(tv) && lv >= 0 && lv < window.innerWidth - 50 && tv >= 0 && tv < window.innerHeight - 50) {
                trigger.style.left = pos.x; trigger.style.top = pos.y;
            } else localStorage.removeItem('stwii--trigger-position');
        } catch { localStorage.removeItem('stwii--trigger-position'); }
    }

    const savePosition = () => localStorage.setItem('stwii--trigger-position', JSON.stringify({ x: trigger.style.left, y: trigger.style.top }));
    const moveTrigger  = (cx, cy) => {
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
    document.addEventListener('mousemove', (e) => { if (!isDragging) return; hasMoved = true; moveTrigger(e.clientX, e.clientY); e.preventDefault(); });
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
        else if (dur < 300) { togglePanel(); e.preventDefault(); e.stopPropagation(); }
        hasMoved = false;
    }, { capture: true });

    document.body.append(trigger);

    // ── Panels ───────────────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.classList.add('stwii--panel');
    panel.innerHTML = '?';
    document.body.append(panel);

    const configPanel = document.createElement('div');
    configPanel.classList.add('stwii--panel', 'stwii--configPanel');
    document.body.append(configPanel);

    const historyPanel = document.createElement('div');
    historyPanel.classList.add('stwii--panel', 'stwii--historyPanel');
    document.body.append(historyPanel);

    const positionPanel = (panelEl) => {
        const rect = trigger.getBoundingClientRect();
        const pw = Math.min(360, window.innerWidth - 20);
        const wasHidden = !panelEl.classList.contains('stwii--isActive');
        if (wasHidden) { panelEl.style.visibility = 'hidden'; panelEl.style.display = 'flex'; }
        const ph = panelEl.offsetHeight;
        if (wasHidden) { panelEl.style.display = ''; panelEl.style.visibility = ''; }
        let left = rect.right + 10 + pw <= window.innerWidth ? rect.right + 10
                 : rect.left - 10 - pw >= 0                  ? rect.left - pw - 10
                 : Math.max(10, (window.innerWidth - pw) / 2);
        let top = Math.max(10, Math.min(rect.top, window.innerHeight - ph - 10));
        panelEl.style.left = left + 'px';
        panelEl.style.top  = top  + 'px';
    };

    const closeAllPanels = () => {
        panel.classList.remove('stwii--isActive');
        configPanel.classList.remove('stwii--isActive');
        historyPanel.classList.remove('stwii--isActive');
    };

    const togglePanel = () => {
        const opening = !panel.classList.contains('stwii--isActive');
        closeAllPanels();
        if (opening) { panel.classList.add('stwii--isActive'); justOpened = true; positionPanel(panel); setTimeout(() => justOpened = false, 300); }
    };
    const toggleConfigPanel = () => {
        const opening = !configPanel.classList.contains('stwii--isActive');
        closeAllPanels();
        if (opening) { configPanel.classList.add('stwii--isActive'); justOpened = true; positionPanel(configPanel); setTimeout(() => justOpened = false, 300); }
    };
    const toggleHistoryPanel = () => {
        const opening = !historyPanel.classList.contains('stwii--isActive');
        closeAllPanels();
        if (opening) { renderHistoryPanel(); historyPanel.classList.add('stwii--isActive'); justOpened = true; positionPanel(historyPanel); setTimeout(() => justOpened = false, 300); }
    };

    trigger.addEventListener('click', (e) => { if (hasMoved) { hasMoved = false; return; } e.stopPropagation(); togglePanel(); });
    trigger.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); toggleConfigPanel(); });

    document.addEventListener('click', (e) => {
        if (justOpened) return;
        if (!panel.contains(e.target) && !configPanel.contains(e.target) && !historyPanel.contains(e.target) && !trigger.contains(e.target)) closeAllPanels();
    });
    document.addEventListener('touchstart', (e) => {
        if (justOpened) return;
        if (!panel.contains(e.target) && !configPanel.contains(e.target) && !historyPanel.contains(e.target) && !trigger.contains(e.target)) closeAllPanels();
    }, { passive: true });
    window.addEventListener('resize', () => {
        if (panel.classList.contains('stwii--isActive'))       positionPanel(panel);
        if (configPanel.classList.contains('stwii--isActive')) positionPanel(configPanel);
        if (historyPanel.classList.contains('stwii--isActive'))positionPanel(historyPanel);
    });

    // Alt+W shortcut
    document.addEventListener('keydown', (e) => {
        if (e.altKey && e.key === 'w') { e.preventDefault(); togglePanel(); }
    });

    // ── Config panel ─────────────────────────────────────────────────────────
    const addConfigRow = (key, defaultVal, label, title, onChange) => {
        const row = document.createElement('label');
        row.classList.add('stwii--configRow');
        row.title = title;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = extension_settings.worldInfoInfo?.[key] ?? defaultVal;
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

    const cfgSep = (text) => {
        const s = document.createElement('div');
        s.classList.add('stwii--cfgSep');
        s.textContent = text;
        configPanel.append(s);
    };

    cfgSep('Display');
    addConfigRow('group',           true,  'Group by book',         'Group entries by World Info book',                        () => updatePanel(currentEntryList));
    addConfigRow('order',           true,  'Show in order',         'Show in insertion depth / order instead of alphabetically',() => updatePanel(currentEntryList));
    addConfigRow('mes',             true,  'Show messages',         'Indicate message history (ungrouped + ordered only)',      () => updatePanel(currentEntryList));
    addConfigRow('showTokens',      true,  'Show token count',      'Show estimated token count per entry',                    () => updatePanel(currentEntryList));
    addConfigRow('showMatchedKey',  true,  'Show triggered key',    'Show which keyword triggered the entry',                  () => updatePanel(currentEntryList));
    addConfigRow('showHits',        true,  'Show session hits',     'Show ×N counter for entries triggered this session',      () => updatePanel(currentEntryList));
    addConfigRow('bookColors',      true,  'Book color coding',     'Color-code entries and highlights by source book',        () => updatePanel(currentEntryList));
    cfgSep('Chat');
    addConfigRow('inlineHighlight', true,  'Highlight in chat',     'Underline trigger words in chat messages (click for info)',
        (v) => { if (!v) clearInlineHighlights(); else applyInlineHighlights(currentEntryList); });
    addConfigRow('reverseHL',       true,  'Reverse hover highlight','Hovering an entry flashes its keywords in chat',          () => {});
    cfgSep('Tracking');
    addConfigRow('diffHighlight',   true,  'Highlight new entries', 'Briefly highlight entries new since last generation',     () => {});

    // Token budget slider
    const budgetRow = document.createElement('div');
    budgetRow.classList.add('stwii--configRow', 'stwii--budgetRow');
    budgetRow.title = 'Max context tokens for budget bar calculation';
    const budgetLabel = document.createElement('div');
    budgetLabel.textContent = 'Context limit';
    const budgetInput = document.createElement('input');
    budgetInput.type  = 'number';
    budgetInput.min   = '512';
    budgetInput.max   = '200000';
    budgetInput.step  = '512';
    budgetInput.value = extension_settings.worldInfoInfo?.contextLimit ?? 4096;
    budgetInput.classList.add('stwii--budgetInput');
    budgetInput.addEventListener('change', () => {
        if (!extension_settings.worldInfoInfo) extension_settings.worldInfoInfo = {};
        extension_settings.worldInfoInfo.contextLimit = parseInt(budgetInput.value) || 4096;
        updatePanel(currentEntryList);
        saveSettingsDebounced();
    });
    budgetRow.append(budgetLabel, budgetInput);
    configPanel.append(budgetRow);

    // Scan depth slider
    const scanRow = document.createElement('div');
    scanRow.classList.add('stwii--configRow', 'stwii--budgetRow');
    scanRow.title = 'How many recent messages to scan for trigger key detection';
    const scanLabel = document.createElement('div');
    scanLabel.textContent = 'Scan depth (msgs)';
    const scanInput = document.createElement('input');
    scanInput.type  = 'number';
    scanInput.min   = '1';
    scanInput.max   = '100';
    scanInput.step  = '1';
    scanInput.value = extension_settings.worldInfoInfo?.scanDepth ?? 15;
    scanInput.classList.add('stwii--budgetInput');
    scanInput.addEventListener('change', () => {
        if (!extension_settings.worldInfoInfo) extension_settings.worldInfoInfo = {};
        extension_settings.worldInfoInfo.scanDepth = parseInt(scanInput.value) || 15;
        saveSettingsDebounced();
    });
    scanRow.append(scanLabel, scanInput);
    configPanel.append(scanRow);

    // History button
    const histBtn = document.createElement('button');
    histBtn.classList.add('stwii--configRow', 'stwii--histBtn');
    histBtn.textContent = '🕒 Activation history';
    histBtn.addEventListener('click', () => { closeAllPanels(); toggleHistoryPanel(); });
    configPanel.append(histBtn);

    // Export button
    const exportBtn = document.createElement('button');
    exportBtn.classList.add('stwii--configRow', 'stwii--histBtn');
    exportBtn.textContent = '📤 Export active entries';
    exportBtn.addEventListener('click', () => {
        const data = currentEntryList.filter(e => e.type === 'wi').map(e => ({
            world: e.world,
            title: e.comment || e.key?.join(', '),
            keys: e.key,
            tokens: e.estimatedTokens,
            matchedKey: e.matchedKey || null,
            content: e.content,
        }));
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `wi-active-${Date.now()}.json`;
        a.click();
    });
    configPanel.append(exportBtn);

    // ── History panel renderer ────────────────────────────────────────────────
    const renderHistoryPanel = () => {
        historyPanel.innerHTML = '';
        const title = document.createElement('div');
        title.classList.add('stwii--world');
        title.textContent = '🕒 Activation History';
        historyPanel.append(title);

        if (!activationHistory.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:0.5em 1em;opacity:0.5;font-size:0.85em;';
            empty.textContent = 'No generations yet this session.';
            historyPanel.append(empty);
            return;
        }

        for (const rec of activationHistory) {
            const row = document.createElement('div');
            row.classList.add('stwii--histRow');
            const time = new Date(rec.timestamp).toLocaleTimeString();
            row.innerHTML = `
                <span class="stwii--histTime">${time}</span>
                <span class="stwii--histCount">${rec.count} active</span>
                ${rec.added.length   ? `<span class="stwii--histAdded">+${rec.added.slice(0,3).join(', ')}${rec.added.length>3?'…':''}</span>` : ''}
                ${rec.removed.length ? `<span class="stwii--histRemoved">−${rec.removed.slice(0,3).join(', ')}${rec.removed.length>3?'…':''}</span>` : ''}
            `;
            historyPanel.append(row);
        }
    };

    // ── Badge ─────────────────────────────────────────────────────────────────
    let badgeEntries = [];
    let badgeCount   = -1;

    const updateBadge = async (newEntries) => {
        if (badgeCount !== newEntries.length) {
            if (newEntries.length === 0) {
                trigger.classList.add('stwii--badge-out');
                await delay(510);
                trigger.setAttribute('data-stwii--badge-count', '0');
                trigger.classList.remove('stwii--badge-out');
            } else if (badgeCount === 0) {
                trigger.classList.add('stwii--badge-in');
                trigger.setAttribute('data-stwii--badge-count', newEntries.length.toString());
                await delay(510);
                trigger.classList.remove('stwii--badge-in');
            } else {
                trigger.setAttribute('data-stwii--badge-count', newEntries.length.toString());
                trigger.classList.add('stwii--badge-bounce');
                await delay(1010);
                trigger.classList.remove('stwii--badge-bounce');
            }
            badgeCount = newEntries.length;
        } else if (new Set(newEntries).difference(new Set(badgeEntries)).size > 0) {
            trigger.classList.add('stwii--badge-bounce');
            await delay(1010);
            trigger.classList.remove('stwii--badge-bounce');
        }
        badgeEntries = newEntries;
    };

    // ── State ─────────────────────────────────────────────────────────────────
    let currentEntryList = [];
    let currentChat      = [];

    // ── WI Activated ──────────────────────────────────────────────────────────
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, async (entryList) => {
        panel.innerHTML = 'Updating...';

        recordHistory(entryList, currentEntryList);

        _prevEntryIds = new Set(currentEntryList.filter(e => e.type === 'wi').map(e => `${e.world}§§§${e.uid}`));

        updateBadge(entryList.map(it => `${it.world}§§§${it.uid}`));

        const scanDepth  = extension_settings.worldInfoInfo?.scanDepth ?? 15;
        const recentText = getRecentChatText(scanDepth);

        for (const entry of entryList) {
            entry.type          = 'wi';
            entry.matchedKey    = entry.constant ? null : findMatchedKey(entry, recentText);
            entry.estimatedTokens = estimateTokens(entry.content);
            incrementHit(entry.world, entry.uid);
            entry.sessionHits   = sessionHits.get(`${entry.world}§§§${entry.uid}`) || 0;
            entry.isNew         = !_prevEntryIds.has(`${entry.world}§§§${entry.uid}`);
            entry.sticky = parseInt(/**@type {string}*/(await SlashCommandParser.commands['wi-get-timed-effect'].callback(
                { effect: 'sticky', format: 'number', file: `${entry.world}`, _scope: null, _abortController: null },
                entry.uid,
            )));
        }

        currentEntryList = [...entryList];
        updatePanel(entryList, true);

        setTimeout(() => applyInlineHighlights(currentEntryList), 300);
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => { if (currentEntryList.length) setTimeout(() => applyInlineHighlights(currentEntryList), 100); });
    eventSource.on(event_types.USER_MESSAGE_RENDERED,      () => { if (currentEntryList.length) setTimeout(() => applyInlineHighlights(currentEntryList), 100); });

    // ── updatePanel ───────────────────────────────────────────────────────────
    const updatePanel = (entryList, newChat = false) => {
        const isGrouped      = extension_settings.worldInfoInfo?.group           ?? true;
        const isOrdered      = extension_settings.worldInfoInfo?.order           ?? true;
        const isMes          = extension_settings.worldInfoInfo?.mes             ?? true;
        const showTokens     = extension_settings.worldInfoInfo?.showTokens      ?? true;
        const showMatchedKey = extension_settings.worldInfoInfo?.showMatchedKey  ?? true;
        const showHits       = extension_settings.worldInfoInfo?.showHits        ?? true;
        const doDiff         = extension_settings.worldInfoInfo?.diffHighlight   ?? true;
        const doBookColors   = extension_settings.worldInfoInfo?.bookColors      ?? true;
        const doReverseHL    = extension_settings.worldInfoInfo?.reverseHL       ?? true;
        const contextLimit   = extension_settings.worldInfoInfo?.contextLimit    ?? 4096;

        panel.innerHTML = '';

        // ── Search bar ────────────────────────────────────────────────────────
        const searchWrap = document.createElement('div');
        searchWrap.classList.add('stwii--searchWrap');
        const searchInput = document.createElement('input');
        searchInput.type        = 'text';
        searchInput.placeholder = '🔍 filter entries…';
        searchInput.classList.add('stwii--search');
        searchInput.addEventListener('input', () => filterEntries(searchInput.value.toLowerCase()));
        searchInput.addEventListener('keydown', (e) => e.stopPropagation());
        searchWrap.append(searchInput);
        panel.append(searchWrap);

        // ── Token budget bar ──────────────────────────────────────────────────
        const wiEntries   = entryList.filter(e => e.type === 'wi');
        const totalTokens = wiEntries.reduce((s, e) => s + (e.estimatedTokens || 0), 0);
        const pct         = Math.min(100, Math.round(totalTokens / contextLimit * 100));
        const isOver      = pct >= 90;

        const budgetWrap = document.createElement('div');
        budgetWrap.classList.add('stwii--budgetWrap');
        budgetWrap.innerHTML = `
            <div class="stwii--budgetLabel">
                <span>~${totalTokens} tok total</span>
                <span class="stwii--budgetPct ${isOver ? 'stwii--budgetOver' : ''}">${pct}% of ${contextLimit}</span>
            </div>
            <div class="stwii--budgetBar">
                <div class="stwii--budgetFill ${isOver ? 'stwii--budgetOver' : ''}" style="width:${pct}%"></div>
            </div>
        `;
        panel.append(budgetWrap);

        // ── History shortcut ──────────────────────────────────────────────────
        const panelFooterBtns = document.createElement('div');
        panelFooterBtns.classList.add('stwii--panelBtns');
        const hBtn = document.createElement('button');
        hBtn.classList.add('stwii--panelBtn');
        hBtn.textContent = '🕒';
        hBtn.title = 'Activation history';
        hBtn.addEventListener('click', () => toggleHistoryPanel());
        const eBtn = document.createElement('button');
        eBtn.classList.add('stwii--panelBtn');
        eBtn.textContent = '📤';
        eBtn.title = 'Export active entries';
        eBtn.addEventListener('click', () => configPanel.querySelector('.stwii--histBtn:last-of-type')?.click());
        panelFooterBtns.append(hBtn, eBtn);
        panel.append(panelFooterBtns);

        // ── Group & sort ──────────────────────────────────────────────────────
        let grouped = isGrouped
            ? Object.groupBy(entryList, it => it.world)
            : { 'WI Entries': [...entryList] };

        const depthPos = [world_info_position.ANBottom, world_info_position.ANTop, world_info_position.atDepth];

        for (const [world, ents] of Object.entries(grouped)) {
            for (const e of ents) {
                e.depth = e.position === world_info_position.atDepth
                    ? e.depth
                    : (chat_metadata[metadata_keys.depth] + (e.position === world_info_position.ANTop ? 0.1 : 0));
            }

            const bookColor = doBookColors ? getBookColor(world) : null;
            const w = document.createElement('div');
            w.classList.add('stwii--world');
            if (bookColor) w.style.color = bookColor;
            w.textContent = world;
            panel.append(w);

            ents.sort((a, b) => {
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

            if (!isGrouped && isOrdered && isMes) {
                const an = chat_metadata[metadata_keys.prompt];
                const ad = chat_metadata[metadata_keys.depth];
                if (an?.length) {
                    const idx = ents.findIndex(e => depthPos.includes(e.position) && e.depth <= ad);
                    ents.splice(idx, 0, { type: 'note', position: world_info_position.ANBottom, depth: ad, text: an });
                }
                if (newChat) {
                    currentChat = [...chat];
                    if (generationType === 'swipe') currentChat.pop();
                }
                const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
                let curDepth = currentChat.length - 1;
                let isDumped = false;
                for (let i = ents.length - 1; i >= -1; i--) {
                    if (i < 0 && curDepth < 0) continue;
                    if (isDumped) continue;
                    if ((i < 0 && curDepth >= 0) || !depthPos.includes(ents[i].position)) {
                        isDumped = true;
                        const depth = -1;
                        const mesList = currentChat.slice(depth + 1, curDepth + 1);
                        const text = mesList.map(it => it.mes).map(it => it.replace(/```[\s\S]+?```/g, '').replace(/<[^>]+?>/g, '').trim()).filter(Boolean).join('\n');
                        const sentences = [...segmenter.segment(text)].map(it => it.segment.trim());
                        ents.splice(i + 1, 0, { type: 'mes', count: mesList.length, from: depth + 1, to: curDepth, first: sentences.at(0), last: sentences.length > 1 ? sentences.at(-1) : null });
                        curDepth = -1;
                        continue;
                    }
                    let depth = Math.max(-1, currentChat.length - ents[i].depth - 1);
                    if (depth >= curDepth) continue;
                    depth = Math.ceil(depth);
                    if (depth === curDepth) continue;
                    const mesList = currentChat.slice(depth + 1, curDepth + 1);
                    const text = mesList.map(it => it.mes).map(it => it.replace(/```[\s\S]+?```/g, '').replace(/<[^>]+?>/g, '').trim()).filter(Boolean).join('\n');
                    const sentences = [...segmenter.segment(text)].map(it => it.segment.trim());
                    ents.splice(i + 1, 0, { type: 'mes', count: mesList.length, from: depth + 1, to: curDepth, first: sentences.at(0), last: sentences.length > 1 ? sentences.at(-1) : null });
                    curDepth = depth;
                }
            }

            for (const entry of ents) {
                const el = document.createElement('div');
                el.classList.add('stwii--entry');
                el.dataset.stwiiSearch = (entry.comment || entry.key?.join(', ') || '').toLowerCase();

                const wipChar = [world_info_position.before, world_info_position.after];
                const wipEx   = [world_info_position.EMTop, world_info_position.EMBottom];
                if ([...wipChar, ...wipEx].includes(entry.position) && main_api === 'openai') {
                    const pm = promptManager.getPromptCollection().collection;
                    if (wipChar.includes(entry.position) && !pm.find(it => it.identifier === 'charDescription')) {
                        el.classList.add('stwii--isBroken'); el.title = '⚠️ Not sent — Char Description anchor missing!\n';
                    } else if (wipEx.includes(entry.position) && !pm.find(it => it.identifier === 'dialogueExamples')) {
                        el.classList.add('stwii--isBroken'); el.title = '⚠️ Not sent — Example Messages anchor missing!\n';
                    }
                } else { el.title = ''; }

                if (entry.type === 'mes')  el.classList.add('stwii--messages');
                if (entry.type === 'note') el.classList.add('stwii--note');

                if (doDiff && entry.type === 'wi' && entry.isNew) el.classList.add('stwii--isNew');

                // Book color stripe
                if (doBookColors && entry.type === 'wi' && bookColor) {
                    el.style.setProperty('--stwii-book-color', bookColor);
                    el.classList.add('stwii--hasBookColor');
                }

                // Strategy icon
                const strat = document.createElement('div');
                strat.classList.add('stwii--strategy');
                if (entry.type === 'wi') {
                    const s = getStrategy(entry);
                    strat.textContent = STRATEGIES[s].icon;
                    strat.title = STRATEGIES[s].label;
                    strat.dataset.stwiiStrategy = s;
                } else if (entry.type === 'mes') {
                    strat.classList.add('fa-solid', 'fa-fw', 'fa-comments');
                    strat.setAttribute('data-stwii--count', entry.count.toString());
                } else if (entry.type === 'note') {
                    strat.classList.add('fa-solid', 'fa-fw', 'fa-note-sticky');
                }
                el.append(strat);

                // Title wrap
                const titleWrap = document.createElement('div');
                titleWrap.classList.add('stwii--titleWrap');
                const title = document.createElement('div');
                title.classList.add('stwii--title');

                if (entry.type === 'wi') {
                    title.textContent = entry.comment?.length ? entry.comment : entry.key.join(', ');
                    el.title += `[${entry.world}] ${entry.comment?.length ? entry.comment : entry.key.join(', ')}\n`;
                    if (showMatchedKey && entry.matchedKey) el.title += `🔑 triggered by: "${entry.matchedKey}"\n`;
                    el.title += `---\n${entry.content}`;
                } else if (entry.type === 'mes') {
                    const first = document.createElement('div'); first.classList.add('stwii--first'); first.textContent = entry.first;
                    title.append(first);
                    if (entry.last) {
                        el.title = `Messages #${entry.from}–${entry.to}\n---\n${entry.first}\n...\n${entry.last}`;
                        const sep  = document.createElement('div'); sep.classList.add('stwii--sep');  sep.textContent  = '...';
                        const last = document.createElement('div'); last.classList.add('stwii--last'); last.textContent = entry.last;
                        title.append(sep, last);
                    } else { el.title = `Message #${entry.from}\n---\n${entry.first}`; }
                } else if (entry.type === 'note') {
                    title.textContent = 'Author\'s Note';
                    el.title = `Author's Note\n---\n${entry.text}`;
                }

                titleWrap.append(title);

                if (entry.type === 'wi' && showMatchedKey && entry.matchedKey) {
                    const keyLabel = document.createElement('div');
                    keyLabel.classList.add('stwii--matchedKey');
                    keyLabel.textContent = `🔑 ${entry.matchedKey}`;
                    titleWrap.append(keyLabel);
                }
                el.append(titleWrap);

                // Right-side badges
                const badges = document.createElement('div');
                badges.classList.add('stwii--badges');

                if (entry.type === 'wi' && showHits && entry.sessionHits > 1) {
                    const hitBadge = document.createElement('div');
                    hitBadge.classList.add('stwii--hitBadge');
                    hitBadge.textContent = `×${entry.sessionHits}`;
                    hitBadge.title = `Triggered ${entry.sessionHits} times this session`;
                    badges.append(hitBadge);
                }
                if (entry.type === 'wi' && showTokens) {
                    const tokBadge = document.createElement('div');
                    tokBadge.classList.add('stwii--tokens');
                    tokBadge.textContent = `~${entry.estimatedTokens}t`;
                    tokBadge.title = `Estimated tokens: ~${entry.estimatedTokens}`;
                    badges.append(tokBadge);
                }
                el.append(badges);

                // Sticky
                const sticky = document.createElement('div');
                sticky.classList.add('stwii--sticky');
                sticky.textContent = entry.sticky ? `📌 ${entry.sticky}` : '';
                sticky.title = `Sticky for ${entry.sticky} more rounds`;
                el.append(sticky);

                // Quick actions (toggle + copy)
                if (entry.type === 'wi') {
                    const actions = document.createElement('div');
                    actions.classList.add('stwii--quickActions');

                    const copyBtn = document.createElement('button');
                    copyBtn.classList.add('stwii--qaBtn');
                    copyBtn.textContent = '📋';
                    copyBtn.title = 'Copy content';
                    copyBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(entry.content || '').then(() => {
                            copyBtn.textContent = '✅';
                            setTimeout(() => copyBtn.textContent = '📋', 1200);
                        });
                    });
                    actions.append(copyBtn);
                    el.append(actions);

                    // Reverse highlight on hover
                    if (doReverseHL) {
                        el.addEventListener('mouseenter', () => reverseHighlight(entry, true));
                        el.addEventListener('mouseleave', () => reverseHighlight(entry, false));
                    }
                }

                panel.append(el);
            }
        }

        if (panel.classList.contains('stwii--isActive')) positionPanel(panel);

        // Filter fn (closure over panel)
        const filterEntries = (q) => {
            panel.querySelectorAll('.stwii--entry').forEach(el => {
                el.style.display = (!q || el.dataset.stwiiSearch?.includes(q)) ? '' : 'none';
            });
        };
        // Expose filter to searchInput
        searchInput.addEventListener('input', () => filterEntries(searchInput.value.toLowerCase()));
    };

    // ── Console intercept ─────────────────────────────────────────────────────
    const ZeroTriggers = ['[WI] Found 0 world lore entries. Sorted by strategy', '[WI] Adding 0 entries to prompt'];
    const origDebug = console.debug;
    console.debug = function(...args) {
        if (ZeroTriggers.includes(args[0])) { panel.innerHTML = 'No active entries'; updateBadge([]); clearInlineHighlights(); currentEntryList = []; }
        return origDebug.bind(console)(...args);
    };
    const origLog = console.log;
    console.log = function(...args) {
        if (ZeroTriggers.includes(args[0])) { panel.innerHTML = 'No active entries'; updateBadge([]); clearInlineHighlights(); currentEntryList = []; }
        return origLog.bind(console)(...args);
    };

    // ── Slash commands ────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-triggered',
        callback: () => JSON.stringify(currentEntryList),
        returns: 'list of triggered WI entries',
        helpString: 'Get the list of World Info entries triggered on the last generation.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-tokens',
        callback: () => {
            const total = currentEntryList.filter(e => e.type === 'wi').reduce((s, e) => s + (e.estimatedTokens || 0), 0);
            return total.toString();
        },
        returns: 'estimated total tokens of active WI entries',
        helpString: 'Get estimated total token count of currently active World Info entries.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-search',
        callback: (args, value) => {
            const q = value?.toLowerCase() || '';
            const results = currentEntryList.filter(e => e.type === 'wi' &&
                ((e.comment || '').toLowerCase().includes(q) || (e.key || []).some(k => k.toLowerCase().includes(q))));
            return JSON.stringify(results.map(e => ({ world: e.world, title: e.comment || e.key?.join(', '), keys: e.key })));
        },
        returns: 'matching WI entries',
        helpString: 'Search active World Info entries by name or key. Usage: /wi-search query',
    }));

    console.log('🟢 [STWII] v3.0 fully loaded!');
};

init();
