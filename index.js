import { chat, chat_metadata, event_types, eventSource, main_api, saveSettingsDebounced } from '../../../../script.js';
import { metadata_keys } from '../../../authors-note.js';
import { extension_settings } from '../../../extensions.js';
import { promptManager } from '../../../openai.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { delay } from '../../../utils.js';
import { world_info_position } from '../../../world-info.js';

console.log('🟢 [STWII] World Info Info v2.0 loading...');

// ─── Strategy config ──────────────────────────────────────────────────────────
const STRATEGIES = {
    constant:   { icon: '🔵', label: 'Constant',    cssVar: '--stwii-c-constant',   fallback: '#4a90d9' },
    normal:     { icon: '🟢', label: 'Key Match',   cssVar: '--stwii-c-normal',     fallback: '#27ae60' },
    vectorized: { icon: '🔗', label: 'Vectorized',  cssVar: '--stwii-c-vector',     fallback: '#8e44ad' },
};

const getStrategy = (entry) => {
    if (entry.constant === true)   return 'constant';
    if (entry.vectorized === true) return 'vectorized';
    return 'normal';
};

// ─── Token estimation ─────────────────────────────────────────────────────────
const estimateTokens = (text) => {
    if (!text) return 0;
    // ~1.3 tokens per word — rough but fast
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
            <span class="stwii--tt-world">[${entry.world}]</span>
            ${entry.matchedKey ? `<span class="stwii--tt-key">🔑 <em>${entry.matchedKey}</em></span>` : ''}
        </div>
        <div class="stwii--tt-content">${preview}</div>
    `;

    tt.classList.add('stwii--isActive');

    const rect = anchor.getBoundingClientRect();
    const tw = tt.offsetWidth  || 300;
    const th = tt.offsetHeight || 120;
    let left = rect.left;
    let top  = rect.bottom + 6;
    if (left + tw > window.innerWidth  - 10) left = window.innerWidth  - tw - 10;
    if (left < 10) left = 10;
    if (top  + th > window.innerHeight - 10) top  = rect.top - th - 6;
    tt.style.left = left + 'px';
    tt.style.top  = top  + 'px';
};

// ─── Inline key highlighting in chat messages ─────────────────────────────────
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
            if (['SCRIPT', 'STYLE', 'CODE'].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
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
            const span = document.createElement('span');
            span.classList.add('stwii--highlight');
            span.dataset.stwiiStrategy = getStrategy(entry);
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

// ─── Diff tracking ────────────────────────────────────────────────────────────
let _prevEntryIds = new Set();

const getDiffStatus = (entry) => {
    const id = `${entry.world}§§§${entry.uid}`;
    return _prevEntryIds.has(id) ? 'same' : 'new';
};

// ─── Init ─────────────────────────────────────────────────────────────────────
let generationType;
eventSource.on(event_types.GENERATION_STARTED, (genType) => generationType = genType);

const init = () => {
    console.log('🟢 [STWII] init() starting...');

    const trigger = document.createElement('div');
    trigger.classList.add('stwii--trigger', 'fa-solid', 'fa-fw', 'fa-book-atlas');
    trigger.title = 'Active WI\n---\nright click for options';

    // ── Drag & drop ──────────────────────────────────────────────────────────
    let isDragging = false, hasMoved = false;
    let offsetX = 0, offsetY = 0;
    let touchStartTime = 0, touchStartX = 0, touchStartY = 0;
    let justOpened = false;

    const savedPos = localStorage.getItem('stwii--trigger-position');
    if (savedPos) {
        try {
            const pos = JSON.parse(savedPos);
            const lv = parseFloat(pos.x), tv = parseFloat(pos.y);
            if (!isNaN(lv) && !isNaN(tv) &&
                lv >= 0 && lv < window.innerWidth - 50 &&
                tv >= 0 && tv < window.innerHeight - 50) {
                trigger.style.left = pos.x;
                trigger.style.top  = pos.y;
            } else { localStorage.removeItem('stwii--trigger-position'); }
        } catch(e) { localStorage.removeItem('stwii--trigger-position'); }
    }

    const savePosition = () => localStorage.setItem('stwii--trigger-position',
        JSON.stringify({ x: trigger.style.left, y: trigger.style.top }));

    const moveTrigger = (cx, cy) => {
        const x = Math.max(0, Math.min(cx - offsetX, window.innerWidth  - trigger.offsetWidth));
        const y = Math.max(0, Math.min(cy - offsetY, window.innerHeight - trigger.offsetHeight));
        trigger.style.left = x + 'px';
        trigger.style.top  = y + 'px';
    };

    trigger.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isDragging = true; hasMoved = false;
        const r = trigger.getBoundingClientRect();
        offsetX = e.clientX - r.left; offsetY = e.clientY - r.top;
        trigger.style.opacity = '0.7'; e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return; hasMoved = true; moveTrigger(e.clientX, e.clientY); e.preventDefault();
    });
    document.addEventListener('mouseup', () => {
        if (isDragging) { isDragging = false; trigger.style.opacity = ''; if (hasMoved) savePosition(); }
    });
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
            hasMoved = true; trigger.style.opacity = '0.7';
            moveTrigger(t.clientX, t.clientY); e.preventDefault();
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
    configPanel.classList.add('stwii--panel');

    const positionPanel = (panelEl) => {
        const rect = trigger.getBoundingClientRect();
        const pw = Math.min(350, window.innerWidth - 20);
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

    const togglePanel = () => {
        configPanel.classList.remove('stwii--isActive');
        const opening = !panel.classList.contains('stwii--isActive');
        panel.classList.toggle('stwii--isActive');
        if (opening) { justOpened = true; positionPanel(panel); setTimeout(() => justOpened = false, 300); }
    };
    const toggleConfigPanel = () => {
        panel.classList.remove('stwii--isActive');
        const opening = !configPanel.classList.contains('stwii--isActive');
        configPanel.classList.toggle('stwii--isActive');
        if (opening) { justOpened = true; positionPanel(configPanel); setTimeout(() => justOpened = false, 300); }
    };

    trigger.addEventListener('click', (e) => { if (hasMoved) { hasMoved = false; return; } e.stopPropagation(); togglePanel(); });
    trigger.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); toggleConfigPanel(); });

    const closePanels = () => {
        panel.classList.remove('stwii--isActive');
        configPanel.classList.remove('stwii--isActive');
    };
    document.addEventListener('click', (e) => {
        if (justOpened) return;
        if (!panel.contains(e.target) && !configPanel.contains(e.target) && !trigger.contains(e.target))
            closePanels();
    });
    document.addEventListener('touchstart', (e) => {
        if (justOpened) return;
        if (!panel.contains(e.target) && !configPanel.contains(e.target) && !trigger.contains(e.target))
            closePanels();
    }, { passive: true });
    window.addEventListener('resize', () => {
        if (panel.classList.contains('stwii--isActive'))       positionPanel(panel);
        if (configPanel.classList.contains('stwii--isActive')) positionPanel(configPanel);
    });

    // ── Config rows ───────────────────────────────────────────────────────────
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

    addConfigRow('group',           true,  'Group by book',          'Group entries by World Info book',                           () => updatePanel(currentEntryList));
    addConfigRow('order',           true,  'Show in order',          'Show in insertion depth / order instead of alphabetically',  () => updatePanel(currentEntryList));
    addConfigRow('mes',             true,  'Show messages',          'Indicate message history (ungrouped + ordered only)',         () => updatePanel(currentEntryList));
    addConfigRow('showTokens',      true,  'Show token count',       'Show estimated token count per entry',                       () => updatePanel(currentEntryList));
    addConfigRow('showMatchedKey',  true,  'Show triggered key',     'Show which keyword triggered the entry',                     () => updatePanel(currentEntryList));
    addConfigRow('inlineHighlight', true,  'Highlight in chat',      'Underline trigger words in chat messages (click for info)',  (v) => { if (!v) clearInlineHighlights(); else applyInlineHighlights(currentEntryList); });
    addConfigRow('diffHighlight',   true,  'Highlight new entries',  'Briefly highlight entries that are new since last gen',      () => {});

    document.body.append(configPanel);

    // ── Badge ─────────────────────────────────────────────────────────────────
    let entries = [];
    let count = -1;

    const updateBadge = async (newEntries) => {
        if (count !== newEntries.length) {
            if (newEntries.length === 0) {
                trigger.classList.add('stwii--badge-out');
                await delay(510);
                trigger.setAttribute('data-stwii--badge-count', '0');
                trigger.classList.remove('stwii--badge-out');
            } else if (count === 0) {
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
            count = newEntries.length;
        } else if (new Set(newEntries).difference(new Set(entries)).size > 0) {
            trigger.classList.add('stwii--badge-bounce');
            await delay(1010);
            trigger.classList.remove('stwii--badge-bounce');
        }
        entries = newEntries;
    };

    // ── State ─────────────────────────────────────────────────────────────────
    let currentEntryList = [];
    let currentChat = [];

    // ── WI Activated ──────────────────────────────────────────────────────────
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, async (entryList) => {
        panel.innerHTML = 'Updating...';

        // Save previous IDs for diff
        _prevEntryIds = new Set(currentEntryList
            .filter(e => e.type === 'wi')
            .map(e => `${e.world}§§§${e.uid}`));

        updateBadge(entryList.map(it => `${it.world}§§§${it.uid}`));

        // Enrich entries with matchedKey + tokens
        const recentText = getRecentChatText();
        for (const entry of entryList) {
            entry.type = 'wi';
            entry.matchedKey = entry.constant ? null : findMatchedKey(entry, recentText);
            entry.estimatedTokens = estimateTokens(entry.content);
            entry.sticky = parseInt(/**@type {string}*/(await SlashCommandParser.commands['wi-get-timed-effect'].callback(
                { effect: 'sticky', format: 'number', file: `${entry.world}`, _scope: null, _abortController: null },
                entry.uid,
            )));
        }

        currentEntryList = [...entryList];
        updatePanel(entryList, true);

        // Apply inline highlights after a short delay (let chat render first)
        setTimeout(() => applyInlineHighlights(currentEntryList), 300);
    });

    // Also re-apply highlights when a new message renders
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        if (currentEntryList.length) setTimeout(() => applyInlineHighlights(currentEntryList), 100);
    });
    eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
        if (currentEntryList.length) setTimeout(() => applyInlineHighlights(currentEntryList), 100);
    });

    // ── updatePanel ───────────────────────────────────────────────────────────
    const updatePanel = (entryList, newChat = false) => {
        const isGrouped      = extension_settings.worldInfoInfo?.group           ?? true;
        const isOrdered      = extension_settings.worldInfoInfo?.order           ?? true;
        const isMes          = extension_settings.worldInfoInfo?.mes             ?? true;
        const showTokens     = extension_settings.worldInfoInfo?.showTokens      ?? true;
        const showMatchedKey = extension_settings.worldInfoInfo?.showMatchedKey  ?? true;
        const doDiff         = extension_settings.worldInfoInfo?.diffHighlight   ?? true;

        panel.innerHTML = '';
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

            const w = document.createElement('div');
            w.classList.add('stwii--world');
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

                // Broken position check
                const wipChar = [world_info_position.before, world_info_position.after];
                const wipEx   = [world_info_position.EMTop, world_info_position.EMBottom];
                if ([...wipChar, ...wipEx].includes(entry.position) && main_api === 'openai') {
                    const pm = promptManager.getPromptCollection().collection;
                    if (wipChar.includes(entry.position) && !pm.find(it => it.identifier === 'charDescription')) {
                        el.classList.add('stwii--isBroken');
                        el.title = '⚠️ Not sent — Char Description anchor missing!\n';
                    } else if (wipEx.includes(entry.position) && !pm.find(it => it.identifier === 'dialogueExamples')) {
                        el.classList.add('stwii--isBroken');
                        el.title = '⚠️ Not sent — Example Messages anchor missing!\n';
                    }
                } else { el.title = ''; }

                if (entry.type === 'mes')  el.classList.add('stwii--messages');
                if (entry.type === 'note') el.classList.add('stwii--note');

                // Diff highlight
                if (doDiff && entry.type === 'wi') {
                    const id = `${entry.world}§§§${entry.uid}`;
                    if (!_prevEntryIds.has(id)) el.classList.add('stwii--isNew');
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

                // Title + matched key
                const titleWrap = document.createElement('div');
                titleWrap.classList.add('stwii--titleWrap');

                const title = document.createElement('div');
                title.classList.add('stwii--title');

                if (entry.type === 'wi') {
                    title.textContent = entry.comment?.length ? entry.comment : entry.key.join(', ');
                    el.title += `[${entry.world}] ${entry.comment?.length ? entry.comment : entry.key.join(', ')}\n`;
                    if (showMatchedKey && entry.matchedKey) {
                        el.title += `🔑 triggered by: "${entry.matchedKey}"\n`;
                    }
                    el.title += `---\n${entry.content}`;
                } else if (entry.type === 'mes') {
                    const first = document.createElement('div'); first.classList.add('stwii--first'); first.textContent = entry.first;
                    title.append(first);
                    if (entry.last) {
                        el.title = `Messages #${entry.from}–${entry.to}\n---\n${entry.first}\n...\n${entry.last}`;
                        const sep = document.createElement('div'); sep.classList.add('stwii--sep'); sep.textContent = '...';
                        const last = document.createElement('div'); last.classList.add('stwii--last'); last.textContent = entry.last;
                        title.append(sep, last);
                    } else {
                        el.title = `Message #${entry.from}\n---\n${entry.first}`;
                    }
                } else if (entry.type === 'note') {
                    title.textContent = 'Author\'s Note';
                    el.title = `Author's Note\n---\n${entry.text}`;
                }

                titleWrap.append(title);

                // Matched key sub-label
                if (entry.type === 'wi' && showMatchedKey && entry.matchedKey) {
                    const keyLabel = document.createElement('div');
                    keyLabel.classList.add('stwii--matchedKey');
                    keyLabel.textContent = `🔑 ${entry.matchedKey}`;
                    titleWrap.append(keyLabel);
                }

                el.append(titleWrap);

                // Token count badge
                if (entry.type === 'wi' && showTokens) {
                    const tokBadge = document.createElement('div');
                    tokBadge.classList.add('stwii--tokens');
                    tokBadge.textContent = `~${entry.estimatedTokens}t`;
                    tokBadge.title = `Estimated tokens: ~${entry.estimatedTokens}`;
                    el.append(tokBadge);
                }

                // Sticky indicator
                const sticky = document.createElement('div');
                sticky.classList.add('stwii--sticky');
                sticky.textContent = entry.sticky ? `📌 ${entry.sticky}` : '';
                sticky.title = `Sticky for ${entry.sticky} more rounds`;
                el.append(sticky);

                panel.append(el);
            }
        }

        if (panel.classList.contains('stwii--isActive')) positionPanel(panel);
    };

    // ── Console intercept (0 entries case) ────────────────────────────────────
    const _origDebug = console.debug;
    console.debug = function(...args) {
        if (['[WI] Found 0 world lore entries. Sorted by strategy', '[WI] Adding 0 entries to prompt'].includes(args[0])) {
            panel.innerHTML = 'No active entries';
            updateBadge([]); clearInlineHighlights();
            currentEntryList = [];
        }
        return _origDebug.bind(console)(...args);
    };
    const _origLog = console.log;
    console.log = function(...args) {
        if (['[WI] Found 0 world lore entries. Sorted by strategy', '[WI] Adding 0 entries to prompt'].includes(args[0])) {
            panel.innerHTML = 'No active entries';
            updateBadge([]); clearInlineHighlights();
            currentEntryList = [];
        }
        return _origLog.bind(console)(...args);
    };

    // ── Slash command ─────────────────────────────────────────────────────────
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-triggered',
        callback: () => JSON.stringify(currentEntryList),
        returns: 'list of triggered WI entries',
        helpString: 'Get the list of World Info entries triggered on the last generation.',
    }));

    console.log('🟢 [STWII] v2.0 fully loaded!');
};

init();
