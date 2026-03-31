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

// === TOKEN ESTIMATION ===
// ~4 chars/token for Latin, ~1.5 chars/token for Cyrillic/CJK
function estimateTokens(text) {
    if (!text) return 0;
    let tokens = 0;
    for (const char of text) {
        const code = char.codePointAt(0);
        if (
            (code >= 0x0400 && code <= 0x04FF) || // Cyrillic
            (code >= 0x4E00 && code <= 0x9FFF) || // CJK
            (code >= 0x3000 && code <= 0x303F) || // CJK punctuation
            (code >= 0x0600 && code <= 0x06FF)    // Arabic
        ) {
            tokens += 0.65;
        } else {
            tokens += 0.25;
        }
    }
    return Math.ceil(tokens);
}

function entryTokens(entry) {
    return estimateTokens(entry.content ?? '');
}

// === DISABLED ENTRIES ===
function getDisabledKey() {
    return `stwii--disabled--${chat_metadata?.chat_id ?? 'global'}`;
}

function getDisabledSet() {
    try {
        const raw = localStorage.getItem(getDisabledKey());
        return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
}

function saveDisabledSet(set) {
    localStorage.setItem(getDisabledKey(), JSON.stringify([...set]));
}

function entryKey(entry) {
    return `${entry.world}§§§${entry.uid}`;
}

async function toggleEntryDisabled(entry) {
    const key = entryKey(entry);
    const disabled = getDisabledSet();
    const nowDisabled = !disabled.has(key);
    if (nowDisabled) {
        disabled.add(key);
    } else {
        disabled.delete(key);
    }
    saveDisabledSet(disabled);

    // Try to toggle in ST via slash command
    try {
        await SlashCommandParser.commands['wi-set-entry-field']?.callback(
            {
                file: entry.world,
                field: 'disable',
                _scope: null,
                _abortController: null,
            },
            `${entry.uid}|||${nowDisabled ? 'true' : 'false'}`,
        );
    } catch(e) {
        console.warn('[STWII] Could not toggle entry via slash cmd:', e);
    }

    return nowDisabled;
}

let generationType;
eventSource.on(event_types.GENERATION_STARTED, (genType)=>generationType = genType);

const init = ()=>{
    console.log('🟢 [STWII] Функция init() запущена');
    
    const trigger = document.createElement('div');
    trigger.classList.add('stwii--trigger');
    trigger.classList.add('fa-solid', 'fa-fw', 'fa-book-atlas');
    trigger.title = 'Active WI\n---\nright click for options';
    
    // === DRAG AND DROP LOGIC ===
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
            if (!isNaN(leftVal) && !isNaN(topVal) && 
                leftVal >= 0 && leftVal < window.innerWidth - 50 &&
                topVal >= 0 && topVal < window.innerHeight - 50) {
                trigger.style.left = pos.x;
                trigger.style.top = pos.y;
            } else {
                localStorage.removeItem('stwii--trigger-position');
            }
        } catch(e) {
            localStorage.removeItem('stwii--trigger-position');
        }
    }

    function savePosition() {
        localStorage.setItem('stwii--trigger-position', JSON.stringify({ x: trigger.style.left, y: trigger.style.top }));
    }

    function moveTrigger(clientX, clientY) {
        let newX = Math.max(0, Math.min(clientX - offsetX, window.innerWidth - trigger.offsetWidth));
        let newY = Math.max(0, Math.min(clientY - offsetY, window.innerHeight - trigger.offsetHeight));
        trigger.style.left = newX + 'px';
        trigger.style.top = newY + 'px';
    }

    trigger.addEventListener('mousedown', function(e) {
        if (e.button !== 0) return;
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
            if (hasMoved) savePosition();
        }
    });

    trigger.addEventListener('touchstart', function(e) {
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
    }, {capture: true});

    document.body.append(trigger);

    const panel = document.createElement('div');
    panel.classList.add('stwii--panel');
    panel.innerHTML = '?';
    document.body.append(panel);

    const configPanel = document.createElement('div');
    configPanel.classList.add('stwii--panel');
    
    function positionPanel(panelElement) {
        const rect = trigger.getBoundingClientRect();
        const panelWidth = Math.min(350, window.innerWidth - 20);
        
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
        
        let left;
        if (rect.right + 10 + panelWidth <= window.innerWidth) {
            left = rect.right + 10;
        } else if (rect.left - 10 - panelWidth >= 0) {
            left = rect.left - panelWidth - 10;
        } else {
            left = Math.max(10, (window.innerWidth - panelWidth) / 2);
        }
        
        let top = rect.top;
        if (top + panelHeight > window.innerHeight - 10) top = Math.max(10, window.innerHeight - panelHeight - 10);
        if (top < 10) top = 10;
        
        panelElement.style.left = left + 'px';
        panelElement.style.top = top + 'px';
    }

    function togglePanel() {
        configPanel.classList.remove('stwii--isActive');
        const isOpening = !panel.classList.contains('stwii--isActive');
        panel.classList.toggle('stwii--isActive');
        if (isOpening) {
            justOpened = true;
            positionPanel(panel);
            setTimeout(() => { justOpened = false; }, 300);
        }
    }

    function toggleConfigPanel() {
        panel.classList.remove('stwii--isActive');
        const isOpening = !configPanel.classList.contains('stwii--isActive');
        configPanel.classList.toggle('stwii--isActive');
        if (isOpening) {
            justOpened = true;
            positionPanel(configPanel);
            setTimeout(() => { justOpened = false; }, 300);
        }
    }

    trigger.addEventListener('click', (e)=>{
        if (hasMoved) { hasMoved = false; return; }
        e.stopPropagation();
        togglePanel();
    });
    
    trigger.addEventListener('contextmenu', (evt)=>{
        evt.preventDefault();
        evt.stopPropagation();
        toggleConfigPanel();
    });

    function closePanels() {
        panel.classList.remove('stwii--isActive');
        configPanel.classList.remove('stwii--isActive');
    }

    document.addEventListener('click', (e)=>{
        if (justOpened) return;
        if (!panel.contains(e.target) && !configPanel.contains(e.target) && !trigger.contains(e.target)) closePanels();
    });

    document.addEventListener('touchstart', (e)=>{
        if (justOpened) return;
        if (!panel.contains(e.target) && !configPanel.contains(e.target) && !trigger.contains(e.target)) closePanels();
    }, {passive: true});

    window.addEventListener('resize', () => {
        if (panel.classList.contains('stwii--isActive')) positionPanel(panel);
        if (configPanel.classList.contains('stwii--isActive')) positionPanel(configPanel);
    });

    // === CONFIG PANEL ===
    function makeConfigRow(labelText, title, checked, onChange) {
        const row = document.createElement('label');
        row.classList.add('stwii--configRow');
        row.title = title;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.addEventListener('click', ()=>onChange(cb.checked));
        row.append(cb);
        const lbl = document.createElement('div');
        lbl.textContent = labelText;
        row.append(lbl);
        configPanel.append(row);
        return cb;
    }

    makeConfigRow('Group by book', 'Group entries by World Info book',
        extension_settings.worldInfoInfo?.group ?? true,
        (v)=>{ if (!extension_settings.worldInfoInfo) extension_settings.worldInfoInfo = {}; extension_settings.worldInfoInfo.group = v; updatePanel(currentEntryList); saveSettingsDebounced(); });

    makeConfigRow('Show in order', 'Show in insertion depth / order instead of alphabetically',
        extension_settings.worldInfoInfo?.order ?? true,
        (v)=>{ if (!extension_settings.worldInfoInfo) extension_settings.worldInfoInfo = {}; extension_settings.worldInfoInfo.order = v; updatePanel(currentEntryList); saveSettingsDebounced(); });

    makeConfigRow('Show messages', 'Indicate message history (only when ungrouped and shown in order)',
        extension_settings.worldInfoInfo?.mes ?? true,
        (v)=>{ if (!extension_settings.worldInfoInfo) extension_settings.worldInfoInfo = {}; extension_settings.worldInfoInfo.mes = v; updatePanel(currentEntryList); saveSettingsDebounced(); });

    makeConfigRow('Show token counts', 'Show estimated token count per entry and total budget',
        extension_settings.worldInfoInfo?.showTokens ?? true,
        (v)=>{ if (!extension_settings.worldInfoInfo) extension_settings.worldInfoInfo = {}; extension_settings.worldInfoInfo.showTokens = v; updatePanel(currentEntryList); saveSettingsDebounced(); });

    // Token limit row
    const tokenRow = document.createElement('label');
    tokenRow.classList.add('stwii--configRow');
    tokenRow.title = 'Token budget limit (0 = unlimited)';
    const tokenInput = document.createElement('input');
    tokenInput.type = 'number';
    tokenInput.min = '0';
    tokenInput.max = '99999';
    tokenInput.step = '100';
    tokenInput.style.cssText = 'width:70px;background:transparent;border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:inherit;padding:2px 4px;font-size:inherit;flex-shrink:0';
    tokenInput.value = extension_settings.worldInfoInfo?.tokenLimit ?? 2000;
    tokenInput.addEventListener('change', ()=>{
        if (!extension_settings.worldInfoInfo) extension_settings.worldInfoInfo = {};
        extension_settings.worldInfoInfo.tokenLimit = parseInt(tokenInput.value) || 0;
        updatePanel(currentEntryList);
        saveSettingsDebounced();
    });
    tokenRow.append(tokenInput);
    const lblToken = document.createElement('div');
    lblToken.textContent = 'Token budget limit';
    tokenRow.append(lblToken);
    configPanel.append(tokenRow);

    document.body.append(configPanel);

    // === BADGE ===
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
                { effect: 'sticky', format: 'number', file: `${entry.world}`, _scope: null, _abortController: null },
                entry.uid,
            )));
        }
        currentEntryList = [...entryList];
        updatePanel(entryList, true);
    });

    const updatePanel = (entryList, newChat = false)=>{
        const isGrouped = extension_settings.worldInfoInfo?.group ?? true;
        const isOrdered = extension_settings.worldInfoInfo?.order ?? true;
        const isMes = extension_settings.worldInfoInfo?.mes ?? true;
        const showTokens = extension_settings.worldInfoInfo?.showTokens ?? true;
        const tokenLimit = extension_settings.worldInfoInfo?.tokenLimit ?? 2000;
        const disabled = getDisabledSet();

        panel.innerHTML = '';
        
        let grouped;
        if (isGrouped) {
            grouped = Object.groupBy(entryList, (it)=>it.world);
        } else {
            grouped = {'WI Entries': [...entryList]};
        }
        const depthPos = [world_info_position.ANBottom, world_info_position.ANTop, world_info_position.atDepth];
        
        let totalTokens = 0;
        
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

                // Disabled state visual
                const isDisabled = entry.type === 'wi' && disabled.has(entryKey(entry));
                if (isDisabled) {
                    e.classList.add('stwii--isDisabled');
                }

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

                // Token count badge per entry
                if (entry.type === 'wi' && showTokens) {
                    const tk = entryTokens(entry);
                    if (!isDisabled) totalTokens += tk;
                    const tkEl = document.createElement('div');
                    tkEl.classList.add('stwii--tokens');
                    tkEl.textContent = `~${tk}`;
                    tkEl.title = `~${tk} estimated tokens`;
                    e.append(tkEl);
                }

                const sticky = document.createElement('div');
                sticky.classList.add('stwii--sticky');
                sticky.textContent = entry.sticky ? `📌 ${entry.sticky}` : '';
                sticky.title = `Sticky for ${entry.sticky} more rounds`;
                e.append(sticky);

                // Click = toggle disable for WI entries
                if (entry.type === 'wi') {
                    e.style.cursor = 'pointer';
                    e.title = (isDisabled ? '[ОТКЛЮЧЕНА] Клик чтобы включить\n' : '[Клик чтобы отключить]\n') + e.title;
                    e.addEventListener('click', async (evt)=>{
                        evt.stopPropagation();
                        await toggleEntryDisabled(entry);
                        updatePanel(currentEntryList);
                    });
                } else {
                    e.style.cursor = 'help';
                }

                panel.append(e);
            }
        }

        // Token budget bar at the bottom of panel
        if (showTokens && entryList.some(e=>e.type === 'wi')) {
            const budgetWrapper = document.createElement('div');
            budgetWrapper.classList.add('stwii--budget-wrapper');

            const budgetLabel = document.createElement('div');
            budgetLabel.classList.add('stwii--budget-label');
            const overBudget = tokenLimit > 0 && totalTokens > tokenLimit;
            budgetLabel.textContent = tokenLimit > 0
                ? `~${totalTokens} / ${tokenLimit} tk${overBudget ? ' ⚠️ OVER BUDGET' : ''}`
                : `~${totalTokens} tk`;
            if (overBudget) budgetLabel.classList.add('stwii--over-budget');
            budgetWrapper.append(budgetLabel);

            if (tokenLimit > 0) {
                const barTrack = document.createElement('div');
                barTrack.classList.add('stwii--budget-track');
                const barFill = document.createElement('div');
                barFill.classList.add('stwii--budget-fill');
                barFill.style.width = Math.min(100, (totalTokens / tokenLimit) * 100) + '%';
                if (overBudget) barFill.classList.add('stwii--over-budget');
                barTrack.append(barFill);
                budgetWrapper.append(barTrack);
            }

            panel.append(budgetWrapper);
        }
        
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
    
    console.log('🟢 [STWII] Расширение полностью загружено!');
};

init();
