import { chat, chat_metadata, event_types, eventSource, main_api, saveSettingsDebounced } from '../../../../script.js';
import { metadata_keys } from '../../../authors-note.js';
import { extension_settings } from '../../../extensions.js';
import { promptManager } from '../../../openai.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { delay } from '../../../utils.js';
import { world_info_position } from '../../../world-info.js';

console.log('🟢 [STWII] Начало загрузки расширения World Info Info');

const strategy = {
    constant: '🔵',
    normal: '🟢',
    vectorized: '🔗',
};

const getStrategy = (entry)=>{
    if (entry.constant === true) {
        return 'constant';
    } else if (entry.vectorized === true) {
        return 'vectorized';
    } else {
        return 'normal';
    }
};

let generationType;
eventSource.on(event_types.GENERATION_STARTED, (genType)=>generationType = genType);

// === KEYWORD HIGHLIGHT TOOLTIP ===
let activeTooltip = null;

function createTooltip(entry, anchorEl) {
    removeTooltip();

    const tip = document.createElement('div');
    tip.classList.add('stwii--keyword-tooltip');

    const header = document.createElement('div');
    header.classList.add('stwii--kt-header');
    const icon = document.createElement('span');
    icon.textContent = strategy[getStrategy(entry)] ?? '📖';
    header.append(icon);
    const name = document.createElement('span');
    name.classList.add('stwii--kt-name');
    name.textContent = entry.comment?.length ? entry.comment : entry.key.join(', ');
    header.append(name);
    const world = document.createElement('span');
    world.classList.add('stwii--kt-world');
    world.textContent = `[${entry.world}]`;
    header.append(world);
    tip.append(header);

    if (entry.content?.length) {
        const body = document.createElement('div');
        body.classList.add('stwii--kt-body');
        body.textContent = entry.content;
        tip.append(body);
    }

    document.body.append(tip);
    activeTooltip = tip;

    // Position tooltip
    const rect = anchorEl.getBoundingClientRect();
    const tipWidth = Math.min(320, window.innerWidth - 20);
    tip.style.maxWidth = tipWidth + 'px';

    // Measure
    tip.style.visibility = 'hidden';
    tip.style.display = 'block';
    const tipHeight = tip.offsetHeight;
    tip.style.visibility = '';
    tip.style.display = '';

    let left = rect.left;
    let top = rect.bottom + 6;

    if (left + tipWidth > window.innerWidth - 10) {
        left = window.innerWidth - tipWidth - 10;
    }
    if (left < 10) left = 10;

    if (top + tipHeight > window.innerHeight - 10) {
        top = rect.top - tipHeight - 6;
    }
    if (top < 10) top = 10;

    tip.style.left = left + 'px';
    tip.style.top = top + 'px';

    // Animate in
    requestAnimationFrame(()=>tip.classList.add('stwii--kt-visible'));

    return tip;
}

function removeTooltip() {
    if (activeTooltip) {
        activeTooltip.remove();
        activeTooltip = null;
    }
}

document.addEventListener('click', (e)=>{
    if (!e.target.closest('.stwii--keyword') && !e.target.closest('.stwii--keyword-tooltip')) {
        removeTooltip();
    }
}, true);

// === KEYWORD HIGHLIGHTING IN CHAT ===

/**
 * Build a map: lowercased keyword string -> WI entry
 * (multiple keys per entry)
 */
function buildKeywordMap(entryList) {
    /** @type {Map<string, object>} */
    const map = new Map();
    for (const entry of entryList) {
        if (!entry.key?.length) continue;
        for (const k of entry.key) {
            const kl = k.trim().toLowerCase();
            if (kl.length >= 2) {
                map.set(kl, entry);
            }
        }
    }
    return map;
}

/**
 * Walk text nodes in an element and wrap keyword matches with <span class="stwii--keyword">
 */
function highlightKeywordsInElement(el, keywordMap) {
    if (!keywordMap.size) return;

    // Build a regex from all keywords, longest first to avoid partial matches
    const keywords = [...keywordMap.keys()].sort((a, b) => b.length - a.length);
    // Escape special regex chars
    const escaped = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            // Skip nodes inside already-highlighted spans or stwii elements
            let p = node.parentElement;
            while (p && p !== el) {
                if (p.classList?.contains('stwii--keyword')) return NodeFilter.FILTER_REJECT;
                if (p.classList?.contains('stwii--keyword-tooltip')) return NodeFilter.FILTER_REJECT;
                p = p.parentElement;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });

    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
        textNodes.push(node);
    }

    for (const textNode of textNodes) {
        const text = textNode.textContent;
        if (!pattern.test(text)) continue;
        pattern.lastIndex = 0;

        const frag = document.createDocumentFragment();
        let last = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            if (match.index > last) {
                frag.appendChild(document.createTextNode(text.slice(last, match.index)));
            }
            const matchedKey = match[0].toLowerCase();
            const entry = keywordMap.get(matchedKey);

            const span = document.createElement('span');
            span.classList.add('stwii--keyword');
            if (entry) {
                span.dataset.stwiiStrat = getStrategy(entry);
                span.addEventListener('click', (e)=>{
                    e.stopPropagation();
                    if (activeTooltip && activeTooltip._anchorEl === span) {
                        removeTooltip();
                        return;
                    }
                    const tip = createTooltip(entry, span);
                    tip._anchorEl = span;
                });
            }
            span.textContent = match[0];
            frag.appendChild(span);
            last = match.index + match[0].length;
        }
        if (last < text.length) {
            frag.appendChild(document.createTextNode(text.slice(last)));
        }
        textNode.parentNode.replaceChild(frag, textNode);
    }
}

/**
 * Remove existing keyword highlights from an element (restore plain text)
 */
function removeKeywordHighlights(el) {
    const spans = el.querySelectorAll('.stwii--keyword');
    for (const span of spans) {
        span.replaceWith(document.createTextNode(span.textContent));
    }
    // Normalize adjacent text nodes
    el.normalize();
}

/**
 * Apply highlights to all current chat message elements
 */
function highlightAllMessages(keywordMap) {
    const msgEls = document.querySelectorAll('#chat .mes_text');
    for (const el of msgEls) {
        removeKeywordHighlights(el);
        if (keywordMap.size) {
            highlightKeywordsInElement(el, keywordMap);
        }
    }
}

// Watch for new chat messages being added to DOM
let highlightObserver = null;
let currentKeywordMap = new Map();

function setupHighlightObserver() {
    if (highlightObserver) highlightObserver.disconnect();

    const chatEl = document.getElementById('chat');
    if (!chatEl) return;

    highlightObserver = new MutationObserver((mutations) => {
        if (!currentKeywordMap.size) return;
        for (const mut of mutations) {
            for (const node of mut.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                // A new message was added
                const msgText = node.querySelector?.('.mes_text');
                if (msgText) {
                    // Small delay so ST finishes rendering markdown
                    setTimeout(()=>{
                        removeKeywordHighlights(msgText);
                        highlightKeywordsInElement(msgText, currentKeywordMap);
                    }, 150);
                }
            }
            // Also handle in-place text updates (ST sometimes mutates existing mes_text)
            if (mut.type === 'childList' || mut.type === 'characterData') {
                const msgText = mut.target.closest?.('.mes_text');
                if (msgText && !msgText.querySelector('.stwii--keyword')) {
                    setTimeout(()=>{
                        highlightKeywordsInElement(msgText, currentKeywordMap);
                    }, 150);
                }
            }
        }
    });

    highlightObserver.observe(chatEl, { childList: true, subtree: true });
}

const init = ()=>{
    console.log('🟢 [STWII] Функция init() запущена');
    
    const trigger = document.createElement('div');
    trigger.classList.add('stwii--trigger');
    trigger.classList.add('fa-solid', 'fa-fw', 'fa-book-atlas');
    trigger.title = 'Active WI\n---\nright click for options';
    
    console.log('🟢 [STWII] Элемент trigger создан');
    
    // === DRAG AND DROP LOGIC ===
    let isDragging = false;
    let hasMoved = false;
    let offsetX = 0;
    let offsetY = 0;
    let touchStartTime = 0;
    let touchStartX = 0;
    let touchStartY = 0;
    let justOpened = false;

    // Load position with validation
    const savedPos = localStorage.getItem('stwii--trigger-position');
    if (savedPos) {
        try {
            const pos = JSON.parse(savedPos);
            console.log('🟢 [STWII] Загруженная позиция:', pos);
            
            const leftVal = parseFloat(pos.x);
            const topVal = parseFloat(pos.y);
            
            if (!isNaN(leftVal) && !isNaN(topVal) && 
                leftVal >= 0 && leftVal < window.innerWidth - 50 &&
                topVal >= 0 && topVal < window.innerHeight - 50) {
                trigger.style.left = pos.x;
                trigger.style.top = pos.y;
                console.log('✅ [STWII] Позиция восстановлена');
            } else {
                console.log('⚠️ [STWII] Позиция невалидна, используем дефолт');
                localStorage.removeItem('stwii--trigger-position');
            }
        } catch(e) {
            console.error('🔴 [STWII] Ошибка загрузки позиции:', e);
            localStorage.removeItem('stwii--trigger-position');
        }
    }

    function savePosition() {
        const pos = {
            x: trigger.style.left,
            y: trigger.style.top
        };
        localStorage.setItem('stwii--trigger-position', JSON.stringify(pos));
        console.log('💾 [STWII] Позиция сохранена:', pos);
    }

    function moveTrigger(clientX, clientY) {
        let newX = clientX - offsetX;
        let newY = clientY - offsetY;
        
        newX = Math.max(0, Math.min(newX, window.innerWidth - trigger.offsetWidth));
        newY = Math.max(0, Math.min(newY, window.innerHeight - trigger.offsetHeight));
        
        trigger.style.left = newX + 'px';
        trigger.style.top = newY + 'px';
    }

    // Mouse events
    trigger.addEventListener('mousedown', function(e) {
        if (e.button !== 0) return; // Only left click
        console.log('🖱️ [STWII] MouseDown');
        isDragging = true;
        hasMoved = false;
        const rect = trigger.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        trigger.style.opacity = '0.7';
        e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
        if (!isDragging) return;
        hasMoved = true;
        moveTrigger(e.clientX, e.clientY);
        e.preventDefault();
    });

    document.addEventListener('mouseup', function(e) {
        if (isDragging) {
            isDragging = false;
            trigger.style.opacity = '';
            if (hasMoved) {
                savePosition();
            }
        }
    });

    // Touch support
    trigger.addEventListener('touchstart', function(e) {
        console.log('📱 [STWII] TouchStart');
        touchStartTime = Date.now();
        hasMoved = false;
        isDragging = true;
        
        const rect = trigger.getBoundingClientRect();
        const touch = e.touches[0];
        
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        
        offsetX = touch.clientX - rect.left;
        offsetY = touch.clientY - rect.top;
    }, {passive: true});

    document.addEventListener('touchmove', function(e) {
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
    }, { passive: false });

    trigger.addEventListener('touchend', function(e) {
        const touchDuration = Date.now() - touchStartTime;
        
        console.log('📱 [STWII] TouchEnd - moved:', hasMoved, 'duration:', touchDuration);
        
        isDragging = false;
        trigger.style.opacity = '';
        
        if (hasMoved) {
            savePosition();
            e.preventDefault();
            e.stopPropagation();
        } else if (touchDuration < 300) {
            // Short tap - toggle panel
            console.log('👆 [STWII] Короткий тап - переключаем панель');
            togglePanel();
            e.preventDefault();
            e.stopPropagation();
        }
        
        hasMoved = false;
    }, {capture: true});

    document.body.append(trigger);
    console.log('🟢 [STWII] Trigger добавлен в body');

    const panel = document.createElement('div');
    panel.classList.add('stwii--panel');
    panel.innerHTML = '?';
    document.body.append(panel);

    const configPanel = document.createElement('div');
    configPanel.classList.add('stwii--panel');
    
    function positionPanel(panelElement) {
        const rect = trigger.getBoundingClientRect();
        const panelWidth = Math.min(350, window.innerWidth - 20);
        
        // Temporarily show to measure height
        const wasHidden = !panelElement.classList.contains('stwii--isActive');
        if (wasHidden) {
            panelElement.style.visibility = 'hidden';
            panelElement.style.display = 'flex';
        }
        
        const panelHeight = panelElement.offsetHeight;
        
        if (wasHidden) {
            panelElement.style.display = '';
            panelElement.style.visibility = '';
        }
        
        let left, top;
        
        // Try to position to the right of trigger
        if (rect.right + 10 + panelWidth <= window.innerWidth) {
            left = rect.right + 10;
        } 
        // Try to position to the left
        else if (rect.left - 10 - panelWidth >= 0) {
            left = rect.left - panelWidth - 10;
        }
        // Center horizontally if no space on sides
        else {
            left = Math.max(10, (window.innerWidth - panelWidth) / 2);
        }
        
        // Vertical positioning
        top = rect.top;
        
        // Adjust if goes below screen
        if (top + panelHeight > window.innerHeight - 10) {
            top = Math.max(10, window.innerHeight - panelHeight - 10);
        }
        
        // Ensure not above screen
        if (top < 10) {
            top = 10;
        }
        
        panelElement.style.left = left + 'px';
        panelElement.style.top = top + 'px';
        
        console.log('📍 [STWII] Панель позиционирована:', {left, top, panelWidth, panelHeight});
    }

    function togglePanel() {
        configPanel.classList.remove('stwii--isActive');
        const isOpening = !panel.classList.contains('stwii--isActive');
        panel.classList.toggle('stwii--isActive');
        
        if (isOpening) {
            justOpened = true;
            positionPanel(panel);
            setTimeout(() => {
                justOpened = false;
            }, 300);
        }
        
        console.log('📊 [STWII] Панель:', panel.classList.contains('stwii--isActive') ? 'открыта' : 'закрыта');
    }

    function toggleConfigPanel() {
        panel.classList.remove('stwii--isActive');
        const isOpening = !configPanel.classList.contains('stwii--isActive');
        configPanel.classList.toggle('stwii--isActive');
        
        if (isOpening) {
            justOpened = true;
            positionPanel(configPanel);
            setTimeout(() => {
                justOpened = false;
            }, 300);
        }
    }

    trigger.addEventListener('click', (e)=>{
        console.log('🖱️ [STWII] Click');
        if (hasMoved) {
            hasMoved = false;
            return;
        }
        e.stopPropagation();
        togglePanel();
    });
    
    trigger.addEventListener('contextmenu', (evt)=>{
        evt.preventDefault();
        evt.stopPropagation();
        toggleConfigPanel();
    });

    function closePanels() {
        if (panel.classList.contains('stwii--isActive') || 
            configPanel.classList.contains('stwii--isActive')) {
            console.log('❌ [STWII] Закрываем панели');
            panel.classList.remove('stwii--isActive');
            configPanel.classList.remove('stwii--isActive');
        }
    }

    document.addEventListener('click', (e)=>{
        if (justOpened) return;
        
        if (!panel.contains(e.target) && 
            !configPanel.contains(e.target) && 
            !trigger.contains(e.target)) {
            closePanels();
        }
    });

    document.addEventListener('touchstart', (e)=>{
        if (justOpened) return;
        
        if (!panel.contains(e.target) && 
            !configPanel.contains(e.target) && 
            !trigger.contains(e.target)) {
            closePanels();
        }
    }, {passive: true});

    window.addEventListener('resize', () => {
        if (panel.classList.contains('stwii--isActive')) {
            positionPanel(panel);
        }
        if (configPanel.classList.contains('stwii--isActive')) {
            positionPanel(configPanel);
        }
    });

    const rowGroup = document.createElement('label');
    rowGroup.classList.add('stwii--configRow');
    rowGroup.title = 'Group entries by World Info book';
    const cbGroup = document.createElement('input');
    cbGroup.type = 'checkbox';
    cbGroup.checked = extension_settings.worldInfoInfo?.group ?? true;
    cbGroup.addEventListener('click', ()=>{
        if (!extension_settings.worldInfoInfo) {
            extension_settings.worldInfoInfo = {};
        }
        extension_settings.worldInfoInfo.group = cbGroup.checked;
        updatePanel(currentEntryList);
        saveSettingsDebounced();
    });
    rowGroup.append(cbGroup);
    const lblGroup = document.createElement('div');
    lblGroup.textContent = 'Group by book';
    rowGroup.append(lblGroup);
    configPanel.append(rowGroup);

    const orderRow = document.createElement('label');
    orderRow.classList.add('stwii--configRow');
    orderRow.title = 'Show in insertion depth / order instead of alphabetically';
    const cbOrder = document.createElement('input');
    cbOrder.type = 'checkbox';
    cbOrder.checked = extension_settings.worldInfoInfo?.order ?? true;
    cbOrder.addEventListener('click', ()=>{
        if (!extension_settings.worldInfoInfo) {
            extension_settings.worldInfoInfo = {};
        }
        extension_settings.worldInfoInfo.order = cbOrder.checked;
        updatePanel(currentEntryList);
        saveSettingsDebounced();
    });
    orderRow.append(cbOrder);
    const lblOrder = document.createElement('div');
    lblOrder.textContent = 'Show in order';
    orderRow.append(lblOrder);
    configPanel.append(orderRow);

    const mesRow = document.createElement('label');
    mesRow.classList.add('stwii--configRow');
    mesRow.title = 'Indicate message history (only when ungrouped and shown in order)';
    const cbMes = document.createElement('input');
    cbMes.type = 'checkbox';
    cbMes.checked = extension_settings.worldInfoInfo?.mes ?? true;
    cbMes.addEventListener('click', ()=>{
        if (!extension_settings.worldInfoInfo) {
            extension_settings.worldInfoInfo = {};
        }
        extension_settings.worldInfoInfo.mes = cbMes.checked;
        updatePanel(currentEntryList);
        saveSettingsDebounced();
    });
    mesRow.append(cbMes);
    const lblMes = document.createElement('div');
    lblMes.textContent = 'Show messages';
    mesRow.append(lblMes);
    configPanel.append(mesRow);

    // Config: toggle keyword highlight
    const highlightRow = document.createElement('label');
    highlightRow.classList.add('stwii--configRow');
    highlightRow.title = 'Highlight triggered WI keywords in chat messages';
    const cbHighlight = document.createElement('input');
    cbHighlight.type = 'checkbox';
    cbHighlight.checked = extension_settings.worldInfoInfo?.highlight ?? true;
    cbHighlight.addEventListener('click', ()=>{
        if (!extension_settings.worldInfoInfo) {
            extension_settings.worldInfoInfo = {};
        }
        extension_settings.worldInfoInfo.highlight = cbHighlight.checked;
        saveSettingsDebounced();
        if (cbHighlight.checked) {
            highlightAllMessages(currentKeywordMap);
        } else {
            // Remove all highlights
            const msgEls = document.querySelectorAll('#chat .mes_text');
            for (const el of msgEls) removeKeywordHighlights(el);
            removeTooltip();
        }
    });
    highlightRow.append(cbHighlight);
    const lblHighlight = document.createElement('div');
    lblHighlight.textContent = 'Highlight keywords in chat';
    highlightRow.append(lblHighlight);
    configPanel.append(highlightRow);

    document.body.append(configPanel);

    let entries = [];
    let count = -1;
    
    const updateBadge = async(newEntries)=>{
        if (count != newEntries.length) {
            if (newEntries.length == 0) {
                trigger.classList.add('stwii--badge-out');
                await delay(510);
                trigger.setAttribute('data-stwii--badge-count', newEntries.length.toString());
                trigger.classList.remove('stwii--badge-out');
            } else if (count == 0) {
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
    
    let currentEntryList = [];
    let currentChat = [];
    
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, async(entryList)=>{
        panel.innerHTML = 'Updating...';
        updateBadge(entryList.map(it=>`${it.world}§§§${it.uid}`));
        for (const entry of entryList) {
            entry.type = 'wi';
            entry.sticky = parseInt(/**@type {string}*/(await SlashCommandParser.commands['wi-get-timed-effect'].callback(
                {
                    effect: 'sticky',
                    format: 'number',
                    file: `${entry.world}`,
                    _scope: null,
                    _abortController: null,
                },
                entry.uid,
            )));
        }
        currentEntryList = [...entryList];

        // Update keyword map and re-highlight
        const isHighlightEnabled = extension_settings.worldInfoInfo?.highlight ?? true;
        currentKeywordMap = buildKeywordMap(entryList);
        if (isHighlightEnabled) {
            highlightAllMessages(currentKeywordMap);
        }

        updatePanel(entryList, true);
    });

    const updatePanel = (entryList, newChat = false)=>{
        const isGrouped = extension_settings.worldInfoInfo?.group ?? true;
        const isOrdered = extension_settings.worldInfoInfo?.order ?? true;
        const isMes = extension_settings.worldInfoInfo?.mes ?? true;
        panel.innerHTML = '';
        let grouped;
        if (isGrouped) {
            grouped = Object.groupBy(entryList, (it,idx)=>it.world);
        } else {
            grouped = {'WI Entries': [...entryList]};
        }
        const depthPos = [world_info_position.ANBottom, world_info_position.ANTop, world_info_position.atDepth];
        for (const [world, entries] of Object.entries(grouped)) {
            for (const e of entries) {
                e.depth = e.position == world_info_position.atDepth ? e.depth : (chat_metadata[metadata_keys.depth] + (e.position == world_info_position.ANTop ? 0.1 : 0));
            }
            const w = document.createElement('div');
            w.classList.add('stwii--world');
            w.textContent = world;
            panel.append(w);
            entries.sort((a,b)=>{
                if (isOrdered) {
                    if (!depthPos.includes(a.position) && !depthPos.includes(b.position)) return a.position - b.position;
                    if (depthPos.includes(a.position) && !depthPos.includes(b.position)) return 1;
                    if (!depthPos.includes(a.position) && depthPos.includes(b.position)) return -1;
                    if ((a.depth ?? Number.MAX_SAFE_INTEGER) < (b.depth ?? Number.MAX_SAFE_INTEGER)) return 1;
                    if ((a.depth ?? Number.MAX_SAFE_INTEGER) > (b.depth ?? Number.MAX_SAFE_INTEGER)) return -1;
                    if ((a.order ?? Number.MAX_SAFE_INTEGER) > (b.order ?? Number.MAX_SAFE_INTEGER)) return 1;
                    if ((a.order ?? Number.MAX_SAFE_INTEGER) < (b.order ?? Number.MAX_SAFE_INTEGER)) return -1;
                    return (a.comment ?? a.key.join(', ')).toLowerCase().localeCompare((b.comment ?? b.key.join(', ')).toLowerCase());
                } else {
                    return (a.comment?.length ? a.comment : a.key.join(', ')).toLowerCase().localeCompare(b.comment?.length ? b.comment : b.key.join(', '));
                }
            });
            if (!isGrouped && isOrdered && isMes) {
                const an = chat_metadata[metadata_keys.prompt];
                const ad = chat_metadata[metadata_keys.depth];
                if (an?.length) {
                    const idx = entries.findIndex(e=>depthPos.includes(e.position) && e.depth <= ad);
                    entries.splice(idx, 0, {type: 'note', position: world_info_position.ANBottom, depth: ad, text: an});
                }
                if (newChat) {
                    currentChat = [...chat];
                    if (generationType == 'swipe') currentChat.pop();
                }
                const segmenter = new Intl.Segmenter('en', { granularity:'sentence' });
                let currentDepth = currentChat.length - 1;
                let isDumped = false;
                for (let i = entries.length - 1; i >= -1; i--) {
                    if (i < 0 && currentDepth < 0) continue;
                    if (isDumped) continue;
                    if ((i < 0 && currentDepth >= 0) || !depthPos.includes(entries[i].position)) {
                        isDumped = true;
                        const depth = -1;
                        const mesList = currentChat.slice(depth + 1, currentDepth + 1);
                        const text = mesList.map(it=>it.mes).map(it=>it.replace(/```.+```/gs, '').replace(/<[^>]+?>/g, '').trim()).filter(it=>it.length).join('\n');
                        const sentences = [...segmenter.segment(text)].map(it=>it.segment.trim());
                        entries.splice(i + 1, 0, {type: 'mes', count: mesList.length, from: depth + 1, to: currentDepth, first: sentences.at(0), last: sentences.length > 1 ? sentences.at(-1) : null});
                        currentDepth = -1;
                        continue;
                    }
                    let depth = Math.max(-1, currentChat.length - entries[i].depth - 1);
                    if (depth >= currentDepth) continue;
                    depth = Math.ceil(depth);
                    if (depth == currentDepth) continue;
                    const mesList = currentChat.slice(depth + 1, currentDepth + 1);
                    const text = mesList.map(it=>it.mes).map(it=>it.replace(/```.+```/gs, '').replace(/<[^>]+?>/g, '').trim()).filter(it=>it.length).join('\n');
                    const sentences = [...segmenter.segment(text)].map(it=>it.segment.trim());
                    entries.splice(i + 1, 0, {type: 'mes', count: mesList.length, from: depth + 1, to: currentDepth, first: sentences.at(0), last: sentences.length > 1 ? sentences.at(-1) : null});
                    currentDepth = depth;
                }
            }
            for (const entry of entries) {
                const e = document.createElement('div');
                e.classList.add('stwii--entry');
                const wipChar = [world_info_position.before, world_info_position.after];
                const wipEx = [world_info_position.EMTop, world_info_position.EMBottom];
                if (false && [...wipChar, ...wipEx].includes(entry.position)) {
                    if (main_api == 'openai') {
                        const pm = promptManager.getPromptCollection().collection;
                        if (wipChar.includes(entry.position) && !pm.find(it=>it.identifier == 'charDescription')) {
                            e.classList.add('stwii--isBroken');
                            e.title = '⚠️ Not sent because position anchor is missing (Char Description)!\n';
                        } else if (wipEx.includes(entry.position) && !pm.find(it=>it.identifier == 'dialogueExamples')) {
                            e.classList.add('stwii--isBroken');
                            e.title = '⚠️ Not sent because position anchor is missing (Example Messages)!\n';
                        }
                    }
                } else {
                    e.title = '';
                }
                if (entry.type == 'mes') e.classList.add('stwii--messages');
                if (entry.type == 'note') e.classList.add('stwii--note');
                const strat = document.createElement('div');
                strat.classList.add('stwii--strategy');
                if (entry.type == 'wi') {
                    strat.textContent = strategy[getStrategy(entry)];
                } else if (entry.type == 'mes') {
                    strat.classList.add('fa-solid', 'fa-fw', 'fa-comments');
                    strat.setAttribute('data-stwii--count', entry.count.toString());
                } else if (entry.type == 'note') {
                    strat.classList.add('fa-solid', 'fa-fw', 'fa-note-sticky');
                }
                e.append(strat);
                const title = document.createElement('div');
                title.classList.add('stwii--title');
                if (entry.type == 'wi') {
                    title.textContent = entry.comment?.length ? entry.comment : entry.key.join(', ');
                    e.title += `[${entry.world}] ${entry.comment?.length ? entry.comment : entry.key.join(', ')}\n---\n${entry.content}`;
                } else if (entry.type == 'mes') {
                    const first = document.createElement('div');
                    first.classList.add('stwii--first');
                    first.textContent = entry.first;
                    title.append(first);
                    if (entry.last) {
                        e.title = `Messages #${entry.from}-${entry.to}\n---\n${entry.first}\n...\n${entry.last}`;
                        const sep = document.createElement('div');
                        sep.classList.add('stwii--sep');
                        sep.textContent = '...';
                        title.append(sep);
                        const last = document.createElement('div');
                        last.classList.add('stwii--last');
                        last.textContent = entry.last;
                        title.append(last);
                    } else {
                        e.title = `Message #${entry.from}\n---\n${entry.first}`;
                    }
                } else if (entry.type == 'note') {
                    title.textContent = 'Author\'s Note';
                    e.title = `Author's Note\n---\n${entry.text}`;
                }
                e.append(title);
                const sticky = document.createElement('div');
                sticky.classList.add('stwii--sticky');
                sticky.textContent = entry.sticky ? `📌 ${entry.sticky}` : '';
                sticky.title = `Sticky for ${entry.sticky} more rounds`;
                e.append(sticky);
                panel.append(e);
            }
        }
        
        // Reposition panel after content update
        if (panel.classList.contains('stwii--isActive')) {
            positionPanel(panel);
        }
    };

    const original_debug = console.debug;
    console.debug = function(...args) {
        const triggers = ['[WI] Found 0 world lore entries. Sorted by strategy', '[WI] Adding 0 entries to prompt'];
        if (triggers.includes(args[0])) {
            panel.innerHTML = 'No active entries';
            updateBadge([]);
            currentEntryList = [];
            // Clear keyword map and highlights
            currentKeywordMap = new Map();
            const msgEls = document.querySelectorAll('#chat .mes_text');
            for (const el of msgEls) removeKeywordHighlights(el);
            removeTooltip();
        }
        return original_debug.bind(console)(...args);
    };
    
    const original_log = console.log;
    console.log = function(...args) {
        const triggers = ['[WI] Found 0 world lore entries. Sorted by strategy', '[WI] Adding 0 entries to prompt'];
        if (triggers.includes(args[0])) {
            panel.innerHTML = 'No active entries';
            updateBadge([]);
            currentEntryList = [];
            // Clear keyword map and highlights
            currentKeywordMap = new Map();
            const msgEls = document.querySelectorAll('#chat .mes_text');
            for (const el of msgEls) removeKeywordHighlights(el);
            removeTooltip();
        }
        return original_log.bind(console)(...args);
    };

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({ 
        name: 'wi-triggered',
        callback: (args, value)=>{
            return JSON.stringify(currentEntryList);
        },
        returns: 'list of triggered WI entries',
        helpString: 'Get the list of World Info entries triggered on the last generation.',
    }));

    // Start observing chat for new messages
    setupHighlightObserver();
    
    console.log('🟢 [STWII] Расширение полностью загружено!');
};

init();
