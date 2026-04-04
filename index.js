import { eventSource, event_types, saveSettingsDebounced, setExtensionPrompt, extension_prompt_types } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const extensionName = "npc_manager";
const PROMPT_KEY = extensionName;

// ─── Defaults ──────────────────────────────────────────────────
const defaultSettings = { groups: [], contextWindowSize: 5, contextBaseChance: 30 };

// БАГ #6 ИСПРАВЛЕН: genId использует crypto.randomUUID если доступно
function genId() {
    return typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        : Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── Settings ──────────────────────────────────────────────────
function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }
    for (const key in defaultSettings) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = structuredClone(defaultSettings[key]);
        }
    }
}

function getSettings() { return extension_settings[extensionName]; }

function getGroup(id) { return getSettings().groups.find(g => g.id === id) || null; }

function getNPC(id) {
    for (const g of getSettings().groups) {
        const n = (g.npcs || []).find(n => n.id === id);
        if (n) return n;
    }
    return null;
}

function getPresentNPCs() {
    return getSettings().groups
        .filter(g => g.enabled)
        .flatMap(g => (g.npcs || []).filter(n => n.enabled && n.isPresent));
}

// ─── Prompt ────────────────────────────────────────────────────
function updatePrompt() {
    const present = getPresentNPCs();
    if (!present.length) {
        setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }
    const blocks = present.map(npc => {
        const g = getGroup(npc.groupId);
        const groupTag = g?.name ? ` (${g.name})` : '';
        const lines = [`◆ ${npc.name}${groupTag}`];
        if (npc.description) lines.push(npc.description);
        return lines.join('\n');
    }).join('\n\n');
    const prompt = `[ПРИСУТСТВУЮЩИЕ ПЕРСОНАЖИ]\n\n${blocks}\n\n[/ПРИСУТСТВУЮЩИЕ ПЕРСОНАЖИ]`;
    setExtensionPrompt(PROMPT_KEY, prompt, extension_prompt_types.IN_CHAT, 0);
    console.log(`[NPC Manager] Промпт: ${present.map(n => n.name).join(', ')}`);
}

// ─── Scene management ──────────────────────────────────────────
// БАГ #9 ИСПРАВЛЕН: флаг _adding предотвращает двойной клик
let _addingToScene = false;
function addToScene(npcId) {
    if (_addingToScene) return;
    const npc = getNPC(npcId);
    if (!npc || npc.isPresent) return;
    _addingToScene = true;
    npc.isPresent = true;
    npc.messagesPresent = 0;
    saveSettingsDebounced();
    updatePrompt();
    renderPanel();
    setTimeout(() => { _addingToScene = false; }, 300);
}

function removeFromScene(npcId) {
    const npc = getNPC(npcId);
    if (!npc || !npc.isPresent) return;
    npc.isPresent = false;
    npc.messagesPresent = 0;
    saveSettingsDebounced();
    updatePrompt();
    renderPanel();
}

// ФИЧА #10: Очистить всех из сцены
function clearScene() {
    let changed = false;
    for (const g of getSettings().groups) {
        for (const npc of (g.npcs || [])) {
            if (npc.isPresent) {
                npc.isPresent = false;
                npc.messagesPresent = 0;
                changed = true;
            }
        }
    }
    if (changed) { saveSettingsDebounced(); updatePrompt(); renderPanel(); }
}

// ФИЧА #11: Добавить всех NPC группы в сцену
function addGroupToScene(groupId) {
    const g = getGroup(groupId);
    if (!g || !g.enabled) return;
    let changed = false;
    for (const npc of (g.npcs || [])) {
        if (npc.enabled && !npc.isPresent) {
            npc.isPresent = true;
            npc.messagesPresent = 0;
            changed = true;
        }
    }
    if (changed) { saveSettingsDebounced(); updatePrompt(); renderPanel(); }
}

// ФИЧА #12: Сортировка NPC стрелками
function moveNPC(npcId, direction) {
    for (const g of getSettings().groups) {
        const idx = (g.npcs || []).findIndex(n => n.id === npcId);
        if (idx === -1) continue;
        const newIdx = idx + direction;
        if (newIdx < 0 || newIdx >= g.npcs.length) return;
        [g.npcs[idx], g.npcs[newIdx]] = [g.npcs[newIdx], g.npcs[idx]];
        saveSettingsDebounced();
        updatePrompt();
        renderPanel();
        return;
    }
}

// ─── Direct address detection ───────────────────────────────────
function escR(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function isDirectAddress(npc, text) {
    const names = [npc.name, ...(npc.aliases || [])].filter(Boolean);
    for (const name of names) {
        const r = escR(name);
        const indirect = [
            new RegExp(`${r}\\s+(написал|сказал|пошёл|ушёл|пришёл|видел|был|была|сделал|told|said|went|came|wrote|was)`, 'i'),
            new RegExp(`(об?|про|о\\s+том|about|of|from)\\s+${r}`, 'i'),
            new RegExp(`${r}(а\\s|у\\s|'s)`, 'i'),
        ];
        if (indirect.some(re => re.test(text))) continue;
        const direct = [
            new RegExp(`^[-—]?\\s*${r}\\s*[,!]`, 'i'),
            new RegExp(`(привет|эй|слушай|погоди|стой|подожди|скажи|послушай|hey|hi|excuse)\\s+${r}`, 'i'),
            new RegExp(`${r}\\s*[!?]`, 'i'),
            new RegExp(`[—–-]\\s*${r}[^а-яa-z]`, 'i'),
            new RegExp(`«[^»]*${r}`, 'i'),
            new RegExp(`^${r}\\s*,`, 'i'),
        ];
        if (direct.some(re => re.test(text))) return true;
    }
    return false;
}

// ─── Context window ─────────────────────────────────────────────
function getRecentMessages(n) {
    try {
        const ctx = SillyTavern.getContext();
        if (!ctx?.chat?.length) return [];
        return ctx.chat
            .filter(m => !m.is_system)
            .slice(-n)
            .map(m => (m.mes || '').replace(/<[^>]*>/g, '').toLowerCase());
    } catch { return []; }
}

function countKeywords(npc, messages) {
    const kws = (npc.keywords || []).map(k => k.toLowerCase());
    if (!kws.length) return 0;
    return messages.reduce((acc, msg) => acc + kws.filter(kw => msg.includes(kw)).length, 0);
}

// ─── Chat indicator ─────────────────────────────────────────────
function addChatIndicator() {
    const present = getPresentNPCs();
    if (!present.length) return;
    const msgs = document.querySelectorAll('.mes[is_user="false"]');
    if (!msgs.length) return;
    const last = msgs[msgs.length - 1];
    if (last && !last.querySelector('.npc-chat-indicator')) {
        const el = document.createElement('span');
        el.className = 'npc-chat-indicator';
        el.title = 'NPC в сцене: ' + present.map(n => n.name).join(', ');
        el.textContent = '◈';
        last.querySelector('.mes_text')?.prepend(el);
    }
}

// ─── Event handlers ─────────────────────────────────────────────
function onUserMessageSent() {
    try {
        const ctx = SillyTavern.getContext();
        if (!ctx?.chat?.length) return;
        const lastUser = [...ctx.chat].reverse().find(m => m.is_user && !m.is_system);
        if (!lastUser) return;
        const text = (lastUser.mes || '').replace(/<[^>]*>/g, '');
        let changed = false;
        for (const g of getSettings().groups) {
            if (!g.enabled) continue;
            for (const npc of (g.npcs || [])) {
                if (!npc.enabled || npc.isPresent || npc.triggerMode !== 'direct') continue;
                if (isDirectAddress(npc, text)) {
                    console.log(`[NPC Manager] Прямое обращение → ${npc.name}`);
                    npc.isPresent = true;
                    npc.messagesPresent = 0;
                    changed = true;
                }
            }
        }
        if (changed) { saveSettingsDebounced(); updatePrompt(); renderPanel(); }
    } catch (e) { console.warn('[NPC Manager]', e); }
}

// БАГ #4 ИСПРАВЛЕН: слушаем CHARACTER_MESSAGE_RENDERED вместо MESSAGE_RECEIVED
function onBotMessageReceived() {
    const s = getSettings();
    const recent = getRecentMessages(s.contextWindowSize || 5);
    let changed = false;
    for (const g of s.groups) {
        if (!g.enabled) continue;
        for (const npc of (g.npcs || [])) {
            if (!npc.enabled) continue;
            if (npc.isPresent) {
                npc.messagesPresent = (npc.messagesPresent || 0) + 1;
                if (npc.autoRemoveAfter > 0 && npc.messagesPresent >= npc.autoRemoveAfter) {
                    const allNames = [npc.name, ...(npc.aliases || [])];
                    const blob = recent.join(' ');
                    const stillHere = allNames.some(n => blob.includes(n.toLowerCase()));
                    if (!stillHere) {
                        npc.isPresent = false;
                        npc.messagesPresent = 0;
                        changed = true;
                        console.log(`[NPC Manager] Авто-удаление: ${npc.name}`);
                    }
                }
            }
            if (!npc.isPresent && npc.triggerMode === 'context') {
                const matches = countKeywords(npc, recent);
                if (matches > 0) {
                    const chance = Math.min(90, (s.contextBaseChance || 30) * matches);
                    if (Math.random() * 100 < chance) {
                        npc.isPresent = true;
                        npc.messagesPresent = 0;
                        changed = true;
                        console.log(`[NPC Manager] Контекстное появление: ${npc.name} (совпад: ${matches}, шанс: ${chance}%)`);
                    }
                }
            }
        }
    }
    if (changed) { saveSettingsDebounced(); updatePrompt(); renderPanel(); }
    addChatIndicator();
}

// БАГ #14 ИСПРАВЛЕН: сброс isPresent при смене чата
function onChatChanged() {
    let changed = false;
    for (const g of getSettings().groups) {
        for (const npc of (g.npcs || [])) {
            if (npc.isPresent) {
                npc.isPresent = false;
                npc.messagesPresent = 0;
                changed = true;
            }
        }
    }
    if (changed) { saveSettingsDebounced(); updatePrompt(); }
    renderPanel();
}

// ─── Export / Import ────────────────────────────────────────────
// БАГ #2 ИСПРАВЛЕН: revokeObjectURL вызывается после клика
function exportNPCs() {
    const data = JSON.stringify({ groups: getSettings().groups }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'npc_manager_export.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// БАГ #3 ИСПРАВЛЕН: санитизация данных при импорте
function sanitizeNPC(npc, groupId) {
    return {
        id:             typeof npc.id === 'string' && npc.id ? npc.id : genId(),
        groupId:        typeof npc.groupId === 'string' && npc.groupId ? npc.groupId : groupId,
        name:           typeof npc.name === 'string' ? npc.name.trim() : 'NPC',
        aliases:        Array.isArray(npc.aliases) ? npc.aliases.filter(a => typeof a === 'string') : [],
        description:    typeof npc.description === 'string' ? npc.description : '',
        triggerMode:    ['manual', 'context', 'direct'].includes(npc.triggerMode) ? npc.triggerMode : 'manual',
        keywords:       Array.isArray(npc.keywords) ? npc.keywords.filter(k => typeof k === 'string') : [],
        autoRemoveAfter: typeof npc.autoRemoveAfter === 'number' ? npc.autoRemoveAfter : 0,
        enabled:        typeof npc.enabled === 'boolean' ? npc.enabled : true,
        isPresent:      false,
        messagesPresent: 0,
    };
}

function sanitizeGroup(g) {
    const id = typeof g.id === 'string' && g.id ? g.id : genId();
    return {
        id,
        name:    typeof g.name === 'string' ? g.name.trim() : 'Группа',
        enabled: typeof g.enabled === 'boolean' ? g.enabled : true,
        collapsed: typeof g.collapsed === 'boolean' ? g.collapsed : false,
        npcs:    Array.isArray(g.npcs) ? g.npcs.map(n => sanitizeNPC(n, id)) : [],
    };
}

function importNPCs(json) {
    try {
        const data = JSON.parse(json);
        if (!Array.isArray(data.groups)) throw new Error('Неверный формат');
        getSettings().groups = data.groups.map(sanitizeGroup);
        saveSettingsDebounced();
        updatePrompt();
        renderPanel();
    } catch (e) { alert('Ошибка импорта: ' + e.message); }
}

// ─── Helpers ────────────────────────────────────────────────────
// БАГ #1 ИСПРАВЛЕН: экранируем одинарные кавычки
function escHtml(s) {
    return (s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ФИЧА #13: Предпросмотр промпта
function buildPromptPreview() {
    const present = getPresentNPCs();
    if (!present.length) return '(нет NPC в сцене)';
    const blocks = present.map(npc => {
        const g = getGroup(npc.groupId);
        const groupTag = g?.name ? ` (${g.name})` : '';
        const lines = [`◆ ${npc.name}${groupTag}`];
        if (npc.description) lines.push(npc.description);
        return lines.join('\n');
    }).join('\n\n');
    return `[ПРИСУТСТВУЮЩИЕ ПЕРСОНАЖИ]\n\n${blocks}\n\n[/ПРИСУТСТВУЮЩИЕ ПЕРСОНАЖИ]`;
}

// ─── Render ──────────────────────────────────────────────────────
function renderPanel() {
    const panel = document.getElementById('npc_manager_panel');
    if (!panel) return;
    const s = getSettings();
    const presentTotal = getPresentNPCs().length;

    // ФИЧА #15: счётчик messagesPresent отображается в строке NPC
    const renderNpcRow = (npc, groupId, idx, total) => {
        const dotClass = npc.isPresent ? 'dot-on' : 'dot-off';
        const rowClass = npc.isPresent ? 'npc-row-present' : (npc.enabled ? '' : 'npc-row-off');
        const modeIcon = npc.triggerMode === 'context' ? '🔍' : npc.triggerMode === 'direct' ? '💬' : '🖱️';
        const sceneBtn = npc.isPresent
            ? `<button class="npc-sm-btn npc-sm-remove" data-action="remove" data-id="${escHtml(npc.id)}">−Убрать</button>`
            : `<button class="npc-sm-btn npc-sm-add" data-action="add" data-id="${escHtml(npc.id)}">+Сцена</button>`;
        // ФИЧА #15: прогресс счётчика
        let counterHtml = '';
        if (npc.isPresent && npc.autoRemoveAfter > 0) {
            const left = npc.autoRemoveAfter - (npc.messagesPresent || 0);
            counterHtml = `<span class="npc-msg-counter" title="Авто-удаление через ${left} сообщ.">${left}💬</span>`;
        }
        // ФИЧА #12: стрелки сортировки
        const upBtn   = idx > 0
            ? `<button class="npc-icon-btn" data-action="move-up" data-id="${escHtml(npc.id)}" title="Вверх">▲</button>` : '';
        const downBtn = idx < total - 1
            ? `<button class="npc-icon-btn" data-action="move-down" data-id="${escHtml(npc.id)}" title="Вниз">▼</button>` : '';
        return `<div class="npc-row ${rowClass}" data-npc-id="${escHtml(npc.id)}">
            <span class="npc-row-dot ${dotClass}">●</span>
            <span class="npc-row-name" title="${escHtml(npc.name)}">${escHtml(npc.name)}</span>
            ${counterHtml}
            <span class="npc-row-mode" title="Режим: ${escHtml(npc.triggerMode)}">${modeIcon}</span>
            <div class="npc-row-actions">
                ${sceneBtn}
                ${upBtn}${downBtn}
                <button class="npc-icon-btn" data-action="edit" data-id="${escHtml(npc.id)}" title="Редактировать">✏️</button>
                <button class="npc-del-btn" data-action="delete-npc" data-id="${escHtml(npc.id)}" title="Удалить NPC">✕</button>
            </div>
        </div>`;
    };

    const renderGroup = (g) => {
        const npcs = g.npcs || [];
        const presentCount = npcs.filter(n => n.enabled && n.isPresent).length;
        const collapsed = g.collapsed ? 'npc-body-collapsed' : '';
        const collapseIcon = g.collapsed ? '▶' : '▼';
        const groupOffClass = g.enabled ? '' : 'npc-group-off';
        const badgeHtml = presentCount > 0
            ? `<span class="npc-badge">${presentCount} в сцене</span>` : '';
        const npcsHtml = npcs.length === 0
            ? `<div class="npc-group-empty">Нет персонажей</div>`
            : npcs.map((n, i) => renderNpcRow(n, g.id, i, npcs.length)).join('');
        return `<div class="npc-group ${groupOffClass}" data-group-id="${escHtml(g.id)}">
            <div class="npc-group-head">
                <button class="npc-collapse-btn" data-action="collapse" data-group="${escHtml(g.id)}">${collapseIcon}</button>
                <input class="npc-group-name" type="text" value="${escHtml(g.name)}" data-group-name="${escHtml(g.id)}" placeholder="Название группы" />
                ${badgeHtml}
                <div class="npc-group-controls">
                    <label class="npc-switch npc-switch-sm" title="Вкл/выкл группу">
                        <input type="checkbox" ${g.enabled ? 'checked' : ''} data-toggle-group="${escHtml(g.id)}" />
                        <span class="npc-switch-track"></span>
                    </label>
                    <button class="npc-icon-btn" data-action="add-all-group" data-group="${escHtml(g.id)}" title="Добавить всех в сцену">⊕</button>
                    <button class="npc-icon-btn npc-del-btn" data-action="delete-group" data-group="${escHtml(g.id)}" title="Удалить группу">🗑️</button>
                </div>
            </div>
            <div class="npc-group-body ${collapsed}">
                ${npcsHtml}
                <button class="npc-add-npc-btn" data-action="add-npc" data-group="${escHtml(g.id)}">+ Добавить персонажа</button>
            </div>
        </div>`;
    };

    const groupsHtml = s.groups.length === 0
        ? `<div class="npc-empty">Нет групп. Создайте первую!</div>`
        : s.groups.map(renderGroup).join('');

    // ФИЧА #13: предпросмотр промпта
    const previewText = escHtml(buildPromptPreview());

    panel.innerHTML = `<div class="npc-panel">
        <div class="npc-topbar">
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                <button class="npc-btn npc-btn-add-group" data-action="add-group">+ Группа</button>
                <button class="npc-btn npc-btn-ghost" data-action="export">⬆ Экспорт</button>
                <label class="npc-btn npc-btn-ghost" style="cursor:pointer;" title="Импортировать JSON">
                    ⬇ Импорт<input type="file" accept=".json" style="display:none" id="npc_import_file"/>
                </label>
                ${presentTotal > 0 ? `<button class="npc-btn npc-btn-danger-sm" data-action="clear-scene">✕ Очистить сцену</button>` : ''}
            </div>
            <div class="npc-topbar-right">
                ${presentTotal > 0 ? `<span class="npc-scene-badge">${presentTotal} в сцене</span>` : ''}
                <button class="npc-icon-btn" data-action="toggle-preview" title="Предпросмотр промпта">👁</button>
            </div>
        </div>
        <div class="npc-prompt-preview" id="npc_prompt_preview" style="display:none;">
            <div class="npc-global-label" style="margin-bottom:4px;">Промпт (предпросмотр)</div>
            <pre class="npc-preview-text">${previewText}</pre>
        </div>
        ${groupsHtml}
        <div class="npc-global-section">
            <div class="npc-global-label">Глобальные настройки</div>
            <div class="npc-global-row">
                <span class="npc-global-hint">Окно контекста (сообщ.)</span>
                <input type="range" class="npc-range" min="1" max="20" value="${s.contextWindowSize || 5}" id="npc_ctx_window" />
                <span class="npc-range-val" id="npc_ctx_window_val">${s.contextWindowSize || 5}</span>
            </div>
            <div class="npc-global-row">
                <span class="npc-global-hint">Базовый шанс появления %</span>
                <input type="range" class="npc-range" min="5" max="100" step="5" value="${s.contextBaseChance || 30}" id="npc_base_chance" />
                <span class="npc-range-val" id="npc_base_chance_val">${s.contextBaseChance || 30}</span>
            </div>
            <div style="font-size:11px;opacity:0.4;color:var(--SmartThemeBodyColor,#fff);margin-top:2px;">
                ⚠ Ключевые слова вводить в той форме, в которой они встречаются в тексте (морфология не учитывается)
            </div>
        </div>
    </div>`;

    // ── Bind events (делегирование) ──────────────────────────────
    const p = panel;

    p.querySelector('#npc_ctx_window')?.addEventListener('input', e => {
        getSettings().contextWindowSize = +e.target.value;
        p.querySelector('#npc_ctx_window_val').textContent = e.target.value;
        saveSettingsDebounced();
    });
    p.querySelector('#npc_base_chance')?.addEventListener('input', e => {
        getSettings().contextBaseChance = +e.target.value;
        p.querySelector('#npc_base_chance_val').textContent = e.target.value;
        saveSettingsDebounced();
    });

    // Import file input
    p.querySelector('#npc_import_file')?.addEventListener('change', e => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => importNPCs(ev.target.result);
        reader.readAsText(file);
        e.target.value = '';
    });

    // Group name rename
    p.querySelectorAll('[data-group-name]').forEach(input => {
        input.addEventListener('change', e => {
            const g = getGroup(e.target.dataset.groupName);
            if (g) { g.name = e.target.value; saveSettingsDebounced(); }
        });
    });

    // Group enabled toggles
    p.querySelectorAll('[data-toggle-group]').forEach(cb => {
        cb.addEventListener('change', e => {
            const g = getGroup(e.target.dataset.toggleGroup);
            if (g) { g.enabled = e.target.checked; saveSettingsDebounced(); updatePrompt(); renderPanel(); }
        });
    });

    // Click delegation
    if (!panel.dataset.panelBound) {
        panel.dataset.panelBound = '1';
        panel.addEventListener('click', panelClickHandler);
        panel.addEventListener('change', panelChangeHandler);
    }
}

function panelClickHandler(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action  = btn.dataset.action;
    const npcId   = btn.dataset.id;
    const groupId = btn.dataset.group;
    const panel   = document.getElementById('npc_manager_panel');

    if (action === 'add-group')    { addGroup(); return; }
    if (action === 'export')       { exportNPCs(); return; }
    if (action === 'clear-scene')  { if (confirm('Убрать всех NPC из сцены?')) clearScene(); return; }
    if (action === 'toggle-preview') {
        const prev = panel?.querySelector('#npc_prompt_preview');
        if (prev) prev.style.display = prev.style.display === 'none' ? 'block' : 'none';
        return;
    }
    if (action === 'collapse') {
        const g = getGroup(groupId);
        if (g) { g.collapsed = !g.collapsed; saveSettingsDebounced(); renderPanel(); }
        return;
    }
    if (action === 'add-all-group') { addGroupToScene(groupId); return; }
    if (action === 'delete-group') {
        if (confirm('Удалить группу и всех персонажей?')) {
            getSettings().groups = getSettings().groups.filter(g => g.id !== groupId);
            saveSettingsDebounced(); updatePrompt(); renderPanel();
        }
        return;
    }
    if (action === 'add-npc')  { openEditModal(null, groupId); return; }
    if (action === 'add')      { addToScene(npcId); return; }
    if (action === 'remove')   { removeFromScene(npcId); return; }
    if (action === 'edit')     { openEditModal(getNPC(npcId), null); return; }
    if (action === 'move-up')  { moveNPC(npcId, -1); return; }
    if (action === 'move-down'){ moveNPC(npcId, +1); return; }
    if (action === 'delete-npc') {
        if (confirm('Удалить персонажа?')) {
            for (const g of getSettings().groups) {
                g.npcs = (g.npcs || []).filter(n => n.id !== npcId);
            }
            saveSettingsDebounced(); updatePrompt(); renderPanel();
        }
        return;
    }
    // Modal actions
    if (action === 'modal-save')   { saveNPC(); return; }
    if (action === 'modal-cancel') { closeModal(); return; }
    if (action === 'modal-delete') {
        const id = btn.dataset.id;
        if (id && confirm('Удалить персонажа?')) {
            for (const g of getSettings().groups) {
                g.npcs = (g.npcs || []).filter(n => n.id !== id);
            }
            saveSettingsDebounced(); updatePrompt(); closeModal(); renderPanel();
        }
        return;
    }
}

function panelChangeHandler(e) {
    const t = e.target;
    if (t.dataset.groupName) {
        const g = getGroup(t.dataset.groupName);
        if (g) { g.name = t.value; saveSettingsDebounced(); }
    }
    if (t.dataset.toggleGroup) {
        const g = getGroup(t.dataset.toggleGroup);
        if (g) { g.enabled = t.checked; saveSettingsDebounced(); updatePrompt(); renderPanel(); }
    }
    if (t.id === 'npc_ctx_window') {
        getSettings().contextWindowSize = +t.value;
        const val = document.getElementById('npc_ctx_window_val');
        if (val) val.textContent = t.value;
        saveSettingsDebounced();
    }
    if (t.id === 'npc_base_chance') {
        getSettings().contextBaseChance = +t.value;
        const val = document.getElementById('npc_base_chance_val');
        if (val) val.textContent = t.value;
        saveSettingsDebounced();
    }
    if (t.id === 'npc_import_file') {
        const file = t.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => importNPCs(ev.target.result);
        reader.readAsText(file);
        t.value = '';
    }
    // Modal: toggle keyword field visibility
    if (t.name === 'npc_trigger_mode') {
        const kw = document.getElementById('npc_keywords_field');
        if (kw) kw.style.display = t.value === 'context' ? 'flex' : 'none';
        const ar = document.getElementById('npc_autoremove_field');
        if (ar) ar.style.display = (t.value === 'context' || t.value === 'direct') ? 'flex' : 'none';
    }
}

// ─── Group management ────────────────────────────────────────────
function addGroup() {
    const g = { id: genId(), name: 'Новая группа', enabled: true, collapsed: false, npcs: [] };
    getSettings().groups.push(g);
    saveSettingsDebounced();
    renderPanel();
}

// ─── Modal ────────────────────────────────────────────────────────
let _editingNpcId   = null;
let _editingGroupId = null;

// БАГ #5 ИСПРАВЛЕН: id генерируется только при сохранении, не при открытии формы
function openEditModal(npc, groupId) {
    _editingNpcId   = npc ? npc.id : null;
    _editingGroupId = groupId || (npc ? npc.groupId : null);

    const isNew   = !npc;
    const name    = npc?.name        || '';
    const aliases = (npc?.aliases    || []).join(', ');
    const desc    = npc?.description || '';
    const mode    = npc?.triggerMode || 'manual';
    const kws     = (npc?.keywords   || []).join(', ');
    const auto    = npc?.autoRemoveAfter ?? 0;
    const enabled = npc?.enabled !== false;

    const kwStyle   = mode === 'context'                          ? '' : 'display:none;';
    const arStyle   = (mode === 'context' || mode === 'direct')   ? '' : 'display:none;';
    const deleteBtn = !isNew
        ? `<button class="npc-btn npc-btn-danger-sm" data-action="modal-delete" data-id="${escHtml(npc.id)}">Удалить</button>`
        : '';

    const modeCard = (val, icon, label, desc_) =>
        `<label class="npc-mode-card ${mode === val ? 'mode-active' : ''}">
            <input type="radio" name="npc_trigger_mode" value="${val}" ${mode === val ? 'checked' : ''} />
            <span class="npc-mode-icon">${icon}</span>
            <span class="npc-mode-name">${label}</span>
            <span class="npc-mode-desc">${desc_}</span>
        </label>`;

    const panel = document.getElementById('npc_manager_panel');
    if (!panel) return;

    const overlay = document.createElement('div');
    overlay.className = 'npc-overlay';
    overlay.id = 'npc_edit_overlay';
    overlay.innerHTML = `<div class="npc-modal">
        <div class="npc-modal-head">
            <span class="npc-modal-title">${isNew ? 'Новый персонаж' : 'Редактировать: ' + escHtml(npc.name)}</span>
            <button class="npc-icon-btn" data-action="modal-cancel" title="Закрыть">✕</button>
        </div>
        <div class="npc-field">
            <label class="npc-label">Имя <span class="npc-sub">*обязательно</span></label>
            <input class="npc-input" id="npc_edit_name" type="text" value="${escHtml(name)}" placeholder="Имя персонажа" autocomplete="off" />
        </div>
        <div class="npc-field">
            <label class="npc-label">Псевдонимы <span class="npc-sub">через запятую</span></label>
            <input class="npc-input" id="npc_edit_aliases" type="text" value="${escHtml(aliases)}" placeholder="Барон, Старик, Хозяин" />
        </div>
        <div class="npc-field">
            <label class="npc-label">Описание <span class="npc-sub">для промпта</span></label>
            <textarea class="npc-textarea" id="npc_edit_desc" placeholder="Краткое описание персонажа...">${escHtml(desc)}</textarea>
        </div>
        <div class="npc-field">
            <label class="npc-label">Триггер появления</label>
            <div class="npc-mode-row">
                ${modeCard('manual',  '🖱️', 'Вручную',   'Только кнопкой')}
                ${modeCard('context', '🔍', 'Контекст',  'По ключевым словам')}
                ${modeCard('direct',  '💬', 'Обращение', 'Прямой разговор')}
            </div>
        </div>
        <div class="npc-field" id="npc_keywords_field" style="${kwStyle}">
            <label class="npc-label">Ключевые слова <span class="npc-sub">через запятую</span></label>
            <input class="npc-input" id="npc_edit_keywords" type="text" value="${escHtml(kws)}" placeholder="таверна, трактир, хозяин" />
            <span style="font-size:10px;opacity:0.4;color:var(--SmartThemeBodyColor,#fff);">Вводить в той форме, как встречаются в тексте</span>
        </div>
        <div class="npc-field" id="npc_autoremove_field" style="${arStyle}">
            <label class="npc-label">Авто-удаление через <span class="npc-sub" id="npc_auto_val">${auto}</span> сообщ. (0 = выкл)</label>
            <input type="range" class="npc-range" id="npc_edit_auto" min="0" max="20" value="${auto}" />
        </div>
        <div class="npc-field" style="flex-direction:row;align-items:center;gap:8px;">
            <label class="npc-switch">
                <input type="checkbox" id="npc_edit_enabled" ${enabled ? 'checked' : ''} />
                <span class="npc-switch-track"></span>
            </label>
            <span class="npc-label" style="margin:0;">Персонаж активен</span>
        </div>
        <div class="npc-modal-foot">
            <div>${deleteBtn}</div>
            <div class="npc-foot-right">
                <button class="npc-btn npc-btn-ghost" data-action="modal-cancel">Отмена</button>
                <button class="npc-btn npc-btn-primary" data-action="modal-save">Сохранить</button>
            </div>
        </div>
    </div>`;

    panel.appendChild(overlay);

    // Auto-remove range live label
    overlay.querySelector('#npc_edit_auto')?.addEventListener('input', e => {
        const v = overlay.querySelector('#npc_auto_val');
        if (v) v.textContent = e.target.value;
    });

    // Mode card active highlight
    overlay.querySelectorAll('[name="npc_trigger_mode"]').forEach(radio => {
        radio.addEventListener('change', () => {
            overlay.querySelectorAll('.npc-mode-card').forEach(c => c.classList.remove('mode-active'));
            radio.closest('.npc-mode-card')?.classList.add('mode-active');
            const kwf = overlay.querySelector('#npc_keywords_field');
            const arf = overlay.querySelector('#npc_autoremove_field');
            if (kwf) kwf.style.display  = radio.value === 'context' ? 'flex' : 'none';
            if (arf) arf.style.display  = (radio.value === 'context' || radio.value === 'direct') ? 'flex' : 'none';
        });
    });
}

function closeModal() {
    const ov = document.getElementById('npc_edit_overlay');
    if (ov) ov.remove();
    _editingNpcId   = null;
    _editingGroupId = null;
}

// БАГ #5 ИСПРАВЛЕН: id генерируется здесь, а не при открытии формы
function saveNPC() {
    const overlay = document.getElementById('npc_edit_overlay');
    if (!overlay) return;

    const name = overlay.querySelector('#npc_edit_name')?.value.trim();
    if (!name) { overlay.querySelector('#npc_edit_name')?.focus(); return; }

    const aliases = overlay.querySelector('#npc_edit_aliases')?.value
        .split(',').map(s => s.trim()).filter(Boolean) || [];
    const desc    = overlay.querySelector('#npc_edit_desc')?.value.trim()  || '';
    const mode    = overlay.querySelector('[name="npc_trigger_mode"]:checked')?.value || 'manual';
    const kws     = overlay.querySelector('#npc_edit_keywords')?.value
        .split(',').map(s => s.trim()).filter(Boolean) || [];
    const auto    = +(overlay.querySelector('#npc_edit_auto')?.value || 0);
    const enabled = overlay.querySelector('#npc_edit_enabled')?.checked !== false;

    if (_editingNpcId) {
        // Редактирование существующего
        const npc = getNPC(_editingNpcId);
        if (npc) {
            Object.assign(npc, { name, aliases, description: desc, triggerMode: mode, keywords: kws, autoRemoveAfter: auto, enabled });
        }
    } else {
        // Создание нового — id генерируется только сейчас
        const newId = genId();
        const g = getGroup(_editingGroupId);
        if (g) {
            g.npcs = g.npcs || [];
            g.npcs.push({ id: newId, groupId: _editingGroupId, name, aliases, description: desc, triggerMode: mode, keywords: kws, autoRemoveAfter: auto, enabled, isPresent: false, messagesPresent: 0 });
        }
    }

    saveSettingsDebounced();
    updatePrompt();
    closeModal();
    renderPanel();
}

// ─── Init ──────────────────────────────────────────────────────
jQuery(async () => {
    const settingsHtml = `
    <div class="npc_manager_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>NPC Manager</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
            </div>
            <div class="inline-drawer-content">
                <div id="npc_manager_panel"></div>
            </div>
        </div>
    </div>`;

    // Вставляем панель в настройки расширений SillyTavern
    $('#extensions_settings2').append(settingsHtml);

    loadSettings();

    // БАГ #4 ИСПРАВЛЕН: CHARACTER_MESSAGE_RENDERED вместо MESSAGE_RECEIVED
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onBotMessageReceived);
    // Слушаем отправку сообщения пользователя
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onUserMessageSent);
    // БАГ #14 ИСПРАВЛЕН: сброс isPresent при смене чата
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    renderPanel();
});
