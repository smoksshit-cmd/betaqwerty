import { chat, chat_metadata, event_types, eventSource, main_api, saveSettingsDebounced } from '../../../../script.js';
import { metadata_keys } from '../../../authors-note.js';
import { extension_settings } from '../../../extensions.js';
import { promptManager } from '../../../openai.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { delay } from '../../../utils.js';
import { world_info_position } from '../../../world-info.js';

console.log('[STWII] v3 booting');

const STRATEGIES = {
    constant: { icon: '🔵', label: 'constant', color: 'var(--stwii-c-constant, #4a90d9)' },
    normal: { icon: '🟢', label: 'key match', color: 'var(--stwii-c-normal, #2ecc71)' },
    vectorized: { icon: '🔗', label: 'vector', color: 'var(--stwii-c-vector, #9b59b6)' },
};

const KEY_MATCH_SCAN_DEPTH = 15;
const TOKEN_WARN_RATIO = 0.8;
const TOKEN_DANGER_RATIO = 1;

const state = {
    generationType: null,
    currentEntryList: [],
    currentChat: [],
    badgeEntries: [],
    badgeCount: -1,
    previousWiIds: new Set(),
    sessionHits: new Map(),
    generationHistory: [],
    collapsedWorlds: new Set(),
    activeFilter: '',
    sortMode: 'default',
    tokenBudget: 2500,
    keyboardBound: false,
    chatObserver: null,
    tooltip: null,
    refs: {},
};

const getSettings = ()=>{
    if (!extension_settings.worldInfoInfo) extension_settings.worldInfoInfo = {};
    return extension_settings.worldInfoInfo;
};

const getSetting = (key, fallback)=> getSettings()[key] ?? fallback;
const setSetting = (key, value)=> {
    getSettings()[key] = value;
    saveSettingsDebounced();
};

const esc = (value='') => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const getStrategy = (entry)=>{
    if (entry.constant === true) return 'constant';
    if (entry.vectorized === true) return 'vectorized';
    return 'normal';
};

const estimateTokens = (text='')=> Math.ceil(((text.match(/\S+/g) || []).length) * 1.3);
const getEntryId = (entry)=> `${entry.world}§§§${entry.uid}`;
const getEntryTitle = (entry)=> entry.comment?.length ? entry.comment : (entry.key || []).join(', ');
const getBookColor = (world='')=> {
    let hash = 0;
    for (const ch of world) hash = ((hash << 5) - hash) + ch.charCodeAt(0);
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}deg 65% 55%)`;
};
const getRecentChatText = (depth = KEY_MATCH_SCAN_DEPTH)=> chat.slice(-depth).map(it=>it.mes || '').join('\n');
const findMatchedKey = (entry, searchText='')=> {
    const lower = searchText.toLowerCase();
    for (const key of (entry.key || [])) {
        if (key?.trim() && lower.includes(key.toLowerCase())) return key;
    }
    return null;
};
const copyText = async(text)=> {
    try {
        await navigator.clipboard.writeText(text || '');
        return true;
    } catch {
        return false;
    }
};

const ensureTooltip = ()=> {
    if (state.tooltip) return state.tooltip;
    const el = document.createElement('div');
    el.className = 'stwii--inline-tooltip';
    document.body.append(el);
    document.addEventListener('click', (evt)=>{
        if (!el.contains(evt.target) && !evt.target.closest('.stwii--highlight')) {
            el.classList.remove('stwii--isActive');
        }
    }, true);
    state.tooltip = el;
    return el;
};

const positionFloating = (target, panel)=> {
    const rect = target.getBoundingClientRect();
    const panelWidth = Math.min(420, window.innerWidth - 20);
    panel.style.maxWidth = `${panelWidth}px`;
    panel.style.visibility = 'hidden';
    panel.classList.add('stwii--isActive');
    const h = panel.offsetHeight || 160;
    panel.classList.remove('stwii--isActive');
    panel.style.visibility = '';
    let left = rect.right + 10;
    if (left + panelWidth > window.innerWidth - 10) left = rect.left - panelWidth - 10;
    if (left < 10) left = 10;
    let top = rect.top;
    if (top + h > window.innerHeight - 10) top = Math.max(10, window.innerHeight - h - 10);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
};

const showInlineTooltip = (entry, anchor)=> {
    const tt = ensureTooltip();
    const strategyKey = getStrategy(entry);
    const strategy = STRATEGIES[strategyKey];
    const preview = (entry.content || '').slice(0, 420);
    tt.innerHTML = `
        <div class="stwii--tt-header">
            <span class="stwii--tt-icon" style="color:${strategy.color}">${strategy.icon}</span>
            <span class="stwii--tt-title">${esc(getEntryTitle(entry))}</span>
            <span class="stwii--tt-tokens">~${entry.estimatedTokens || estimateTokens(entry.content)} tok</span>
        </div>
        <div class="stwii--tt-meta">
            <span class="stwii--tt-bookDot" style="background:${getBookColor(entry.world)}"></span>
            <span>${esc(entry.world)}</span>
            ${entry.matchedKey ? `<span>🔑 ${esc(entry.matchedKey)}</span>` : ''}
            <span>${esc(strategy.label)}</span>
        </div>
        <div class="stwii--tt-content">${esc(preview)}${(entry.content || '').length > 420 ? '…' : ''}</div>
    `;
    positionFloating(anchor, tt);
    tt.classList.add('stwii--isActive');
};

const clearHighlights = ()=> {
    document.querySelectorAll('.stwii--highlight').forEach(el => {
        el.replaceWith(document.createTextNode(el.textContent || ''));
    });
    document.querySelectorAll('#chat .mes_text').forEach(el => el.normalize());
};

const highlightKeysInElement = (rootEl, entries)=> {
    if (!rootEl) return;
    const keyMap = new Map();
    for (const entry of entries) {
        for (const key of (entry.key || [])) {
            if (!key?.trim()) continue;
            if (!keyMap.has(key.toLowerCase())) keyMap.set(key.toLowerCase(), entry);
        }
    }
    if (!keyMap.size) return;
    const escaped = [...keyMap.keys()]
        .sort((a,b)=> b.length - a.length)
        .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regex = new RegExp(`(${escaped.join('|')})`, 'gi');

    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const p = node.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            if (p.closest('.stwii--highlight')) return NodeFilter.FILTER_REJECT;
            if (['SCRIPT','STYLE','CODE','TEXTAREA'].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
            if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);

    for (const textNode of nodes) {
        const text = textNode.textContent;
        regex.lastIndex = 0;
        if (!regex.test(text)) continue;
        regex.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            if (match.index > last) frag.append(document.createTextNode(text.slice(last, match.index)));
            const word = match[0];
            const entry = keyMap.get(word.toLowerCase());
            const span = document.createElement('span');
            span.className = 'stwii--highlight';
            span.dataset.stwiiStrategy = getStrategy(entry);
            span.dataset.stwiiEntryId = getEntryId(entry);
            span.textContent = word;
            span.addEventListener('click', (evt)=> {
                evt.stopPropagation();
                showInlineTooltip(entry, span);
            });
            frag.append(span);
            last = match.index + word.length;
        }
        if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
        textNode.parentNode.replaceChild(frag, textNode);
    }
};

const applyHighlights = (entries)=> {
    if (!getSetting('inlineHighlight', true)) return clearHighlights();
    clearHighlights();
    const wiEntries = entries.filter(it=>it.type === 'wi');
    document.querySelectorAll('#chat .mes_text').forEach(el => highlightKeysInElement(el, wiEntries));
};

const updateHistory = (entryList)=> {
    const ids = entryList.filter(it=>it.type === 'wi').map(getEntryId);
    const previous = state.generationHistory[0]?.ids || [];
    const prevSet = new Set(previous);
    const currSet = new Set(ids);
    const added = ids.filter(it=>!prevSet.has(it));
    const removed = previous.filter(it=>!currSet.has(it));
    state.generationHistory.unshift({
        at: new Date().toLocaleTimeString(),
        ids,
        added,
        removed,
    });
    state.generationHistory = state.generationHistory.slice(0, 15);
};

const buildExportPayload = ()=> {
    const wi = state.currentEntryList.filter(it=>it.type === 'wi').map(it => ({
        id: getEntryId(it),
        world: it.world,
        title: getEntryTitle(it),
        strategy: getStrategy(it),
        matchedKey: it.matchedKey || null,
        estimatedTokens: it.estimatedTokens || 0,
        sticky: it.sticky || 0,
        sessionHits: state.sessionHits.get(getEntryId(it)) || 0,
        content: it.content,
    }));
    return {
        generatedAt: new Date().toISOString(),
        totalEntries: wi.length,
        totalEstimatedTokens: wi.reduce((sum, it)=>sum + it.estimatedTokens, 0),
        entries: wi,
    };
};

const openLorebookEntry = (entry)=> {
    const evt = new CustomEvent('stwii:open-entry', { detail: entry });
    window.dispatchEvent(evt);
};

const updateBadge = async(newEntries)=> {
    const trigger = state.refs.trigger;
    if (!trigger) return;
    const count = newEntries.length;
    if (state.badgeCount !== count) {
        if (count === 0) {
            trigger.classList.add('stwii--badge-out');
            await delay(510);
            trigger.setAttribute('data-stwii--badge-count', '0');
            trigger.classList.remove('stwii--badge-out');
        } else if (state.badgeCount === 0) {
            trigger.classList.add('stwii--badge-in');
            trigger.setAttribute('data-stwii--badge-count', String(count));
            await delay(510);
            trigger.classList.remove('stwii--badge-in');
        } else {
            trigger.setAttribute('data-stwii--badge-count', String(count));
            trigger.classList.add('stwii--badge-bounce');
            await delay(1010);
            trigger.classList.remove('stwii--badge-bounce');
        }
        state.badgeCount = count;
    } else {
        const prev = new Set(state.badgeEntries);
        if (newEntries.some(it=>!prev.has(it))) {
            trigger.classList.add('stwii--badge-bounce');
            await delay(1010);
            trigger.classList.remove('stwii--badge-bounce');
        }
    }
    state.badgeEntries = [...newEntries];
};

const buildHeader = (entryList)=> {
    const totalTokens = entryList.filter(it=>it.type === 'wi').reduce((sum, it)=> sum + (it.estimatedTokens || 0), 0);
    const budget = Number(getSetting('tokenBudget', 2500)) || 2500;
    const ratio = totalTokens / budget;
    const barClass = ratio >= TOKEN_DANGER_RATIO ? 'stwii--danger' : ratio >= TOKEN_WARN_RATIO ? 'stwii--warn' : '';

    const header = document.createElement('div');
    header.className = 'stwii--summary';
    header.innerHTML = `
        <div class="stwii--summaryTop">
            <div class="stwii--summaryStats">
                <span><strong>${entryList.filter(it=>it.type==='wi').length}</strong> active</span>
                <span><strong>~${totalTokens}</strong> tok</span>
                <span>budget <strong>${budget}</strong></span>
            </div>
            <div class="stwii--summaryActions">
                <button class="stwii--miniBtn" data-stwii-action="export-json" title="Copy JSON export">JSON</button>
                <button class="stwii--miniBtn" data-stwii-action="export-text" title="Copy text export">TXT</button>
            </div>
        </div>
        <div class="stwii--budgetBar ${barClass}">
            <div class="stwii--budgetFill" style="width:${Math.min(ratio * 100, 100)}%"></div>
        </div>
        <div class="stwii--summaryHint">${ratio >= TOKEN_DANGER_RATIO ? 'OVER BUDGET' : ratio >= TOKEN_WARN_RATIO ? 'Near budget limit' : 'Budget looks normal'}</div>
    `;
    header.querySelector('[data-stwii-action="export-json"]').addEventListener('click', async()=> {
        await copyText(JSON.stringify(buildExportPayload(), null, 2));
    });
    header.querySelector('[data-stwii-action="export-text"]').addEventListener('click', async()=> {
        const lines = state.currentEntryList.filter(it=>it.type==='wi').map(it => `[${it.world}] ${getEntryTitle(it)} | ${getStrategy(it)} | ${it.matchedKey || '-'} | ~${it.estimatedTokens}t`);
        await copyText(lines.join('\n'));
    });
    return header;
};

const appendHistory = (panel)=> {
    if (!getSetting('showHistory', true)) return;
    const box = document.createElement('div');
    box.className = 'stwii--history';
    box.innerHTML = '<div class="stwii--sectionLabel">Recent generations</div>';
    const list = document.createElement('div');
    list.className = 'stwii--historyList';
    for (const item of state.generationHistory.slice(0, 5)) {
        const row = document.createElement('div');
        row.className = 'stwii--historyRow';
        row.innerHTML = `<span>${esc(item.at)}</span><span>+${item.added.length}</span><span>-${item.removed.length}</span><span>${item.ids.length} active</span>`;
        list.append(row);
    }
    if (!list.children.length) {
        const empty = document.createElement('div');
        empty.className = 'stwii--historyEmpty';
        empty.textContent = 'No generation history yet';
        list.append(empty);
    }
    box.append(list);
    panel.append(box);
};

const getSortedEntries = (entries)=> {
    const sortMode = getSetting('sortMode', 'default');
    if (sortMode === 'tokens') return [...entries].sort((a,b)=> (b.estimatedTokens || 0) - (a.estimatedTokens || 0));
    if (sortMode === 'hits') return [...entries].sort((a,b)=> (state.sessionHits.get(getEntryId(b)) || 0) - (state.sessionHits.get(getEntryId(a)) || 0));
    if (sortMode === 'alpha') return [...entries].sort((a,b)=> getEntryTitle(a).localeCompare(getEntryTitle(b)));
    return [...entries];
};

const passesFilter = (entry)=> {
    const filter = (getSetting('filterText', '') || '').trim().toLowerCase();
    if (!filter) return true;
    const hay = [entry.world, getEntryTitle(entry), ...(entry.key || []), entry.matchedKey || '', entry.content || ''].join(' ').toLowerCase();
    return hay.includes(filter);
};

const renderEntry = (entry, container)=> {
    const e = document.createElement('div');
    e.className = 'stwii--entry';
    e.dataset.entryId = getEntryId(entry);
    e.style.setProperty('--stwii-book-color', getBookColor(entry.world));
    if (getSetting('diffHighlight', true) && entry.type === 'wi' && !state.previousWiIds.has(getEntryId(entry))) e.classList.add('stwii--isNew');
    if (entry.type === 'wi' && (state.sessionHits.get(getEntryId(entry)) || 0) === 1) e.classList.add('stwii--isFirstHit');

    const strat = document.createElement('div');
    strat.className = 'stwii--strategy';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'stwii--titleWrap';
    const title = document.createElement('div');
    title.className = 'stwii--title';

    if (entry.type === 'wi') {
        const strategyKey = getStrategy(entry);
        strat.textContent = STRATEGIES[strategyKey].icon;
        strat.dataset.stwiiStrategy = strategyKey;
        strat.title = STRATEGIES[strategyKey].label;
        title.textContent = getEntryTitle(entry);
        const meta = document.createElement('div');
        meta.className = 'stwii--entryMeta';
        const matched = getSetting('showMatchedKey', true) && entry.matchedKey ? `<span>🔑 ${esc(entry.matchedKey)}</span>` : '';
        const hits = getSetting('showSessionHits', true) ? `<span>×${state.sessionHits.get(getEntryId(entry)) || 0}</span>` : '';
        const tokens = getSetting('showTokens', true) ? `<span>~${entry.estimatedTokens}t</span>` : '';
        const strategyText = getSetting('showStrategyLabel', true) ? `<span>${esc(STRATEGIES[strategyKey].label)}</span>` : '';
        meta.innerHTML = `<span class="stwii--bookChip"><span class="stwii--bookDot"></span>${esc(entry.world)}</span>${matched}${strategyText}${tokens}${hits}`;
        titleWrap.append(title, meta);

        const actions = document.createElement('div');
        actions.className = 'stwii--entryActions';
        actions.innerHTML = `
            <button class="stwii--iconBtn" data-act="copy" title="Copy content">📋</button>
            <button class="stwii--iconBtn" data-act="jump" title="Jump to lorebook entry">↗</button>
            <button class="stwii--iconBtn" data-act="toggle" title="Quick toggle">⏸</button>
        `;
        actions.querySelector('[data-act="copy"]').addEventListener('click', async(evt)=> {
            evt.stopPropagation();
            await copyText(entry.content || '');
        });
        actions.querySelector('[data-act="jump"]').addEventListener('click', (evt)=> {
            evt.stopPropagation();
            openLorebookEntry(entry);
        });
        actions.querySelector('[data-act="toggle"]').addEventListener('click', async(evt)=> {
            evt.stopPropagation();
            try {
                if (SlashCommandParser.commands['wi-set']) {
                    await SlashCommandParser.commands['wi-set'].callback({ field: 'disable', file: `${entry.world}`, _scope: null, _abortController: null }, `${entry.uid}|toggle`);
                }
            } catch {}
            e.classList.toggle('stwii--disabled');
        });

        e.title = `[${entry.world}] ${getEntryTitle(entry)}\n${entry.matchedKey ? `trigger: ${entry.matchedKey}\n` : ''}---\n${entry.content || ''}`;
        e.append(strat, titleWrap, actions);
        e.addEventListener('mouseenter', ()=> {
            document.querySelectorAll(`.stwii--highlight[data-stwii-entry-id="${CSS.escape(getEntryId(entry))}"]`).forEach(el => el.classList.add('stwii--pulse'));
        });
        e.addEventListener('mouseleave', ()=> {
            document.querySelectorAll('.stwii--highlight.stwii--pulse').forEach(el => el.classList.remove('stwii--pulse'));
        });
    } else if (entry.type === 'mes') {
        strat.classList.add('fa-solid', 'fa-fw', 'fa-comments');
        strat.setAttribute('data-stwii--count', entry.count.toString());
        title.innerHTML = `<div class="stwii--first">${esc(entry.first || '')}</div>${entry.last ? `<div class="stwii--sep">...</div><div class="stwii--last">${esc(entry.last)}</div>` : ''}`;
        titleWrap.append(title);
        e.append(strat, titleWrap);
        e.title = entry.last ? `Messages #${entry.from}-${entry.to}\n---\n${entry.first}\n...\n${entry.last}` : `Message #${entry.from}\n---\n${entry.first}`;
    } else if (entry.type === 'note') {
        strat.classList.add('fa-solid', 'fa-fw', 'fa-note-sticky');
        title.textContent = `Author's Note`;
        titleWrap.append(title);
        e.append(strat, titleWrap);
        e.title = `Author's Note\n---\n${entry.text || ''}`;
    }

    container.append(e);
};

const updatePanel = (entryList, newChat=false)=> {
    const panel = state.refs.panel;
    if (!panel) return;
    panel.innerHTML = '';

    const wiOnly = entryList.filter(it=>it.type === 'wi');
    panel.append(buildHeader(wiOnly));

    const controls = document.createElement('div');
    controls.className = 'stwii--toolbar';
    controls.innerHTML = `
        <input class="stwii--search" type="text" placeholder="Filter by title, key, world..." value="${esc(getSetting('filterText', ''))}">
        <select class="stwii--select">
            <option value="default">Default</option>
            <option value="tokens">By tokens</option>
            <option value="hits">By hits</option>
            <option value="alpha">A-Z</option>
        </select>
    `;
    const search = controls.querySelector('.stwii--search');
    const select = controls.querySelector('.stwii--select');
    select.value = getSetting('sortMode', 'default');
    search.addEventListener('input', ()=> {
        setSetting('filterText', search.value);
        updatePanel(state.currentEntryList);
    });
    select.addEventListener('change', ()=> {
        setSetting('sortMode', select.value);
        updatePanel(state.currentEntryList);
    });
    panel.append(controls);

    let grouped = getSetting('group', true)
        ? Object.groupBy(entryList, it => it.world)
        : { 'WI Entries': [...entryList] };

    const depthPos = [world_info_position.ANBottom, world_info_position.ANTop, world_info_position.atDepth];

    for (const entries of Object.values(grouped)) {
        for (const e of entries) {
            e.depth = e.position == world_info_position.atDepth ? e.depth : (chat_metadata[metadata_keys.depth] + (e.position == world_info_position.ANTop ? 0.1 : 0));
        }
    }

    for (const [world, rawEntries] of Object.entries(grouped)) {
        const entries = getSortedEntries(rawEntries);
        entries.sort((a,b)=> {
            if (getSetting('sortMode', 'default') !== 'default') return 0;
            const isOrdered = getSetting('order', true);
            if (isOrdered) {
                if (!depthPos.includes(a.position) && !depthPos.includes(b.position)) return a.position - b.position;
                if (depthPos.includes(a.position) && !depthPos.includes(b.position)) return 1;
                if (!depthPos.includes(a.position) && depthPos.includes(b.position)) return -1;
                if ((a.depth ?? Number.MAX_SAFE_INTEGER) < (b.depth ?? Number.MAX_SAFE_INTEGER)) return 1;
                if ((a.depth ?? Number.MAX_SAFE_INTEGER) > (b.depth ?? Number.MAX_SAFE_INTEGER)) return -1;
                if ((a.order ?? Number.MAX_SAFE_INTEGER) > (b.order ?? Number.MAX_SAFE_INTEGER)) return 1;
                if ((a.order ?? Number.MAX_SAFE_INTEGER) < (b.order ?? Number.MAX_SAFE_INTEGER)) return -1;
            }
            return getEntryTitle(a).toLowerCase().localeCompare(getEntryTitle(b).toLowerCase());
        });

        if (!getSetting('group', true) && getSetting('order', true) && getSetting('mes', true)) {
            const an = chat_metadata[metadata_keys.prompt];
            const ad = chat_metadata[metadata_keys.depth];
            if (an?.length) {
                const idx = entries.findIndex(e=>depthPos.includes(e.position) && e.depth <= ad);
                entries.splice(idx, 0, {type:'note', position:world_info_position.ANBottom, depth:ad, text:an});
            }
            if (newChat) {
                state.currentChat = [...chat];
                if (state.generationType == 'swipe') state.currentChat.pop();
            }
            const segmenter = new Intl.Segmenter('en', { granularity:'sentence' });
            let currentDepth = state.currentChat.length - 1;
            let isDumped = false;
            for (let i = entries.length - 1; i >= -1; i--) {
                if (i < 0 && currentDepth < 0) continue;
                if (isDumped) continue;
                if ((i < 0 && currentDepth >= 0) || !depthPos.includes(entries[i].position)) {
                    isDumped = true;
                    const depth = -1;
                    const mesList = state.currentChat.slice(depth + 1, currentDepth + 1);
                    const text = mesList.map(it=>it.mes).map(it=>it.replace(/```[\s\S]+?```/g, '').replace(/<[^>]+?>/g, '').trim()).filter(Boolean).join('\n');
                    const sentences = [...segmenter.segment(text)].map(it=>it.segment.trim());
                    entries.splice(i + 1, 0, {type:'mes', count:mesList.length, from:depth + 1, to:currentDepth, first:sentences.at(0), last:sentences.length > 1 ? sentences.at(-1) : null});
                    currentDepth = -1;
                    continue;
                }
                let depth = Math.max(-1, state.currentChat.length - entries[i].depth - 1);
                if (depth >= currentDepth) continue;
                depth = Math.ceil(depth);
                if (depth == currentDepth) continue;
                const mesList = state.currentChat.slice(depth + 1, currentDepth + 1);
                const text = mesList.map(it=>it.mes).map(it=>it.replace(/```[\s\S]+?```/g, '').replace(/<[^>]+?>/g, '').trim()).filter(Boolean).join('\n');
                const sentences = [...segmenter.segment(text)].map(it=>it.segment.trim());
                entries.splice(i + 1, 0, {type:'mes', count:mesList.length, from:depth + 1, to:currentDepth, first:sentences.at(0), last:sentences.length > 1 ? sentences.at(-1) : null});
                currentDepth = depth;
            }
        }

        const filtered = entries.filter(it => it.type !== 'wi' || passesFilter(it));
        if (!filtered.length) continue;

        const worldBox = document.createElement('div');
        worldBox.className = 'stwii--worldBox';
        worldBox.style.setProperty('--stwii-book-color', getBookColor(world));

        const header = document.createElement('button');
        header.className = 'stwii--world';
        header.type = 'button';
        const collapsed = state.collapsedWorlds.has(world);
        header.innerHTML = `<span class="stwii--worldLeft"><span class="stwii--collapse">${collapsed ? '▸' : '▾'}</span><span class="stwii--bookDot"></span><span>${esc(world)}</span></span><span class="stwii--worldRight">${filtered.filter(it=>it.type==='wi').length}</span>`;
        header.addEventListener('click', ()=> {
            if (state.collapsedWorlds.has(world)) state.collapsedWorlds.delete(world); else state.collapsedWorlds.add(world);
            updatePanel(state.currentEntryList);
        });
        worldBox.append(header);

        if (!collapsed) {
            const list = document.createElement('div');
            list.className = 'stwii--worldEntries';
            filtered.forEach(entry => renderEntry(entry, list));
            worldBox.append(list);
        }

        panel.append(worldBox);
    }

    appendHistory(panel);
    if (panel.classList.contains('stwii--isActive')) positionFloating(state.refs.trigger, panel);
};

const closePanels = ()=> {
    state.refs.panel?.classList.remove('stwii--isActive');
    state.refs.configPanel?.classList.remove('stwii--isActive');
};

const bindKeyboard = ()=> {
    if (state.keyboardBound) return;
    document.addEventListener('keydown', (evt)=> {
        if (evt.altKey && evt.key.toLowerCase() === 'w') {
            evt.preventDefault();
            state.refs.configPanel.classList.remove('stwii--isActive');
            state.refs.panel.classList.toggle('stwii--isActive');
            if (state.refs.panel.classList.contains('stwii--isActive')) positionFloating(state.refs.trigger, state.refs.panel);
        }
        if (evt.key === 'Escape') closePanels();
    });
    state.keyboardBound = true;
};

const bindChatObserver = ()=> {
    if (state.chatObserver) return;
    const chatRoot = document.querySelector('#chat');
    if (!chatRoot) return;
    state.chatObserver = new MutationObserver(()=> {
        if (state.currentEntryList.length) {
            clearTimeout(bindChatObserver._timer);
            bindChatObserver._timer = setTimeout(()=> applyHighlights(state.currentEntryList), 150);
        }
    });
    state.chatObserver.observe(chatRoot, { childList:true, subtree:true });
};

const init = ()=> {
    const trigger = document.createElement('div');
    trigger.classList.add('stwii--trigger', 'fa-solid', 'fa-fw', 'fa-book-atlas');
    trigger.title = 'Active WI\n---\nright click for options\nAlt+W to toggle';

    let isDragging = false;
    let hasMoved = false;
    let offsetX = 0;
    let offsetY = 0;
    let touchStartTime = 0;
    let touchStartX = 0;
    let touchStartY = 0;
    let justOpened = false;

    const savedPos = localStorage.getItem('stwii--trigger-position');
    if (savedPos) {
        try {
            const pos = JSON.parse(savedPos);
            const leftVal = parseFloat(pos.x);
            const topVal = parseFloat(pos.y);
            if (!isNaN(leftVal) && !isNaN(topVal) && leftVal >= 0 && leftVal < window.innerWidth - 50 && topVal >= 0 && topVal < window.innerHeight - 50) {
                trigger.style.left = pos.x;
                trigger.style.top = pos.y;
            }
        } catch {}
    }

    const savePosition = ()=> localStorage.setItem('stwii--trigger-position', JSON.stringify({ x: trigger.style.left, y: trigger.style.top }));
    const moveTrigger = (clientX, clientY)=> {
        let newX = clientX - offsetX;
        let newY = clientY - offsetY;
        newX = Math.max(0, Math.min(newX, window.innerWidth - trigger.offsetWidth));
        newY = Math.max(0, Math.min(newY, window.innerHeight - trigger.offsetHeight));
        trigger.style.left = `${newX}px`;
        trigger.style.top = `${newY}px`;
    };

    trigger.addEventListener('mousedown', (e)=> {
        if (e.button !== 0) return;
        isDragging = true;
        hasMoved = false;
        const rect = trigger.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        trigger.style.opacity = '0.7';
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e)=> {
        if (!isDragging) return;
        hasMoved = true;
        moveTrigger(e.clientX, e.clientY);
        e.preventDefault();
    });
    document.addEventListener('mouseup', ()=> {
        if (!isDragging) return;
        isDragging = false;
        trigger.style.opacity = '';
        if (hasMoved) savePosition();
    });

    trigger.addEventListener('touchstart', (e)=> {
        touchStartTime = Date.now();
        hasMoved = false;
        isDragging = true;
        const rect = trigger.getBoundingClientRect();
        const touch = e.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        offsetX = touch.clientX - rect.left;
        offsetY = touch.clientY - rect.top;
    }, { passive:true });
    document.addEventListener('touchmove', (e)=> {
        if (!isDragging) return;
        const touch = e.touches[0];
        const deltaX = Math.abs(touch.clientX - touchStartX);
        const deltaY = Math.abs(touch.clientY - touchStartY);
        if (deltaX > 10 || deltaY > 10) {
            hasMoved = true;
            trigger.style.opacity = '0.7';
            moveTrigger(touch.clientX, touch.clientY);
            e.preventDefault();
        }
    }, { passive:false });
    trigger.addEventListener('touchend', (e)=> {
        const touchDuration = Date.now() - touchStartTime;
        isDragging = false;
        trigger.style.opacity = '';
        if (hasMoved) {
            savePosition();
            e.preventDefault();
            e.stopPropagation();
        } else if (touchDuration < 300) {
            togglePanel();
            e.preventDefault();
            e.stopPropagation();
        }
        hasMoved = false;
    }, { capture:true });

    document.body.append(trigger);

    const panel = document.createElement('div');
    panel.classList.add('stwii--panel');
    panel.innerHTML = 'Waiting for WI...';
    document.body.append(panel);

    const configPanel = document.createElement('div');
    configPanel.classList.add('stwii--panel', 'stwii--configPanel');
    document.body.append(configPanel);

    const positionPanel = (el)=> positionFloating(trigger, el);
    const togglePanel = ()=> {
        configPanel.classList.remove('stwii--isActive');
        const opening = !panel.classList.contains('stwii--isActive');
        panel.classList.toggle('stwii--isActive');
        if (opening) {
            justOpened = true;
            positionPanel(panel);
            setTimeout(()=> justOpened = false, 300);
        }
    };
    const toggleConfigPanel = ()=> {
        panel.classList.remove('stwii--isActive');
        const opening = !configPanel.classList.contains('stwii--isActive');
        configPanel.classList.toggle('stwii--isActive');
        if (opening) {
            justOpened = true;
            positionPanel(configPanel);
            setTimeout(()=> justOpened = false, 300);
        }
    };

    trigger.addEventListener('click', (e)=> {
        if (hasMoved) {
            hasMoved = false;
            return;
        }
        e.stopPropagation();
        togglePanel();
    });
    trigger.addEventListener('contextmenu', (evt)=> {
        evt.preventDefault();
        evt.stopPropagation();
        toggleConfigPanel();
    });

    document.addEventListener('click', (e)=> {
        if (justOpened) return;
        if (!panel.contains(e.target) && !configPanel.contains(e.target) && !trigger.contains(e.target)) closePanels();
    });
    document.addEventListener('touchstart', (e)=> {
        if (justOpened) return;
        if (!panel.contains(e.target) && !configPanel.contains(e.target) && !trigger.contains(e.target)) closePanels();
    }, { passive:true });
    window.addEventListener('resize', ()=> {
        if (panel.classList.contains('stwii--isActive')) positionPanel(panel);
        if (configPanel.classList.contains('stwii--isActive')) positionPanel(configPanel);
    });

    state.refs = { trigger, panel, configPanel };

    const addConfigRow = ({ key, label, title, type='checkbox', defaultValue=true, value, min, max, step, onInput })=> {
        const row = document.createElement('label');
        row.className = 'stwii--configRow';
        row.title = title;
        const control = document.createElement('input');
        control.type = type;
        if (type === 'checkbox') {
            control.checked = getSetting(key, defaultValue);
            control.addEventListener('change', ()=> {
                setSetting(key, control.checked);
                onInput?.(control.checked);
                updatePanel(state.currentEntryList);
            });
        } else {
            control.value = getSetting(key, value);
            if (min !== undefined) control.min = min;
            if (max !== undefined) control.max = max;
            if (step !== undefined) control.step = step;
            control.addEventListener('input', ()=> {
                setSetting(key, Number(control.value));
                onInput?.(Number(control.value));
                updatePanel(state.currentEntryList);
            });
        }
        const text = document.createElement('div');
        text.textContent = label;
        row.append(control, text);
        configPanel.append(row);
        return control;
    };

    addConfigRow({ key:'group', label:'Group by book', title:'Group entries by World Info book', defaultValue:true });
    addConfigRow({ key:'order', label:'Show in order', title:'Show in insertion depth / order instead of alphabetically', defaultValue:true });
    addConfigRow({ key:'mes', label:'Show messages', title:'Indicate message history', defaultValue:true });
    addConfigRow({ key:'showTokens', label:'Show token count', title:'Show estimated token count per entry', defaultValue:true });
    addConfigRow({ key:'showMatchedKey', label:'Show triggered key', title:'Show which keyword triggered the entry', defaultValue:true });
    addConfigRow({ key:'showStrategyLabel', label:'Show trigger type', title:'Show constant / key match / vector label', defaultValue:true });
    addConfigRow({ key:'showSessionHits', label:'Show session hits', title:'Show how many times entry triggered this session', defaultValue:true });
    addConfigRow({ key:'inlineHighlight', label:'Highlight in chat', title:'Underline trigger words in chat messages', defaultValue:true, onInput:(v)=> { if (!v) clearHighlights(); else applyHighlights(state.currentEntryList); } });
    addConfigRow({ key:'diffHighlight', label:'Highlight new entries', title:'Highlight entries newly activated since last generation', defaultValue:true });
    addConfigRow({ key:'showHistory', label:'Show generation history', title:'Show recent generations diff log', defaultValue:true });
    addConfigRow({ key:'tokenBudget', label:'Token budget', title:'Visual budget line for active entries', type:'number', value:2500, min:100, max:64000, step:50 });

    const help = document.createElement('div');
    help.className = 'stwii--configHelp';
    help.innerHTML = '<div><strong>Hotkey:</strong> Alt+W</div><div>Left click — panel, right click — settings</div>';
    configPanel.append(help);

    bindKeyboard();
    bindChatObserver();

    eventSource.on(event_types.GENERATION_STARTED, (genType)=> state.generationType = genType);

    eventSource.on(event_types.WORLD_INFO_ACTIVATED, async(entryList)=> {
        panel.innerHTML = 'Updating...';
        state.previousWiIds = new Set(state.currentEntryList.filter(it=>it.type==='wi').map(getEntryId));
        updateBadge(entryList.map(getEntryId));
        const recentText = getRecentChatText(Number(getSetting('scanDepth', KEY_MATCH_SCAN_DEPTH)) || KEY_MATCH_SCAN_DEPTH);
        for (const entry of entryList) {
            entry.type = 'wi';
            entry.matchedKey = entry.constant ? null : findMatchedKey(entry, recentText);
            entry.estimatedTokens = estimateTokens(entry.content);
            try {
                entry.sticky = parseInt(await SlashCommandParser.commands['wi-get-timed-effect'].callback({ effect:'sticky', format:'number', file:`${entry.world}`, _scope:null, _abortController:null }, entry.uid));
            } catch {
                entry.sticky = 0;
            }
            const id = getEntryId(entry);
            state.sessionHits.set(id, (state.sessionHits.get(id) || 0) + 1);
        }
        state.currentEntryList = [...entryList];
        updateHistory(state.currentEntryList);
        updatePanel(entryList, true);
        setTimeout(()=> applyHighlights(state.currentEntryList), 250);
    });

    const clearNoEntries = ()=> {
        panel.innerHTML = 'No active entries';
        updateBadge([]);
        state.currentEntryList = [];
        clearHighlights();
        updatePanel([]);
    };

    const originalDebug = console.debug;
    console.debug = function(...args) {
        const triggers = ['[WI] Found 0 world lore entries. Sorted by strategy', '[WI] Adding 0 entries to prompt'];
        if (triggers.includes(args[0])) clearNoEntries();
        return originalDebug.bind(console)(...args);
    };
    const originalLog = console.log;
    console.log = function(...args) {
        const triggers = ['[WI] Found 0 world lore entries. Sorted by strategy', '[WI] Adding 0 entries to prompt'];
        if (triggers.includes(args[0])) clearNoEntries();
        return originalLog.bind(console)(...args);
    };

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-triggered',
        callback: ()=> JSON.stringify(state.currentEntryList),
        returns: 'list of triggered WI entries',
        helpString: 'Get the list of World Info entries triggered on the last generation.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-tokens',
        callback: ()=> String(state.currentEntryList.filter(it=>it.type==='wi').reduce((sum, it)=> sum + (it.estimatedTokens || 0), 0)),
        returns: 'estimated total tokens',
        helpString: 'Get estimated total tokens of triggered WI entries.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-search',
        callback: (args, value)=> {
            const q = String(value || '').toLowerCase();
            return JSON.stringify(state.currentEntryList.filter(it=>it.type==='wi').filter(it => [it.world, getEntryTitle(it), ...(it.key || []), it.content || ''].join(' ').toLowerCase().includes(q)));
        },
        returns: 'matched triggered WI entries',
        helpString: 'Search current triggered WI entries.',
    }));

    console.log('[STWII] v3 ready');
};

init();
