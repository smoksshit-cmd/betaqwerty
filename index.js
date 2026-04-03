import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const extensionName = "npc_manager";
const PROMPT_KEY = extensionName;

// ─── Defaults ────────────────────────────────────────────────
const defaultSettings = {
    groups: [],
    contextWindowSize: 5,
    contextBaseChance: 30
};

function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── Settings ────────────────────────────────────────────────
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

// ─── Prompt ──────────────────────────────────────────────────
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

// ─── Scene management ────────────────────────────────────────
function addToScene(npcId) {
    const npc = getNPC(npcId);
    if (!npc || npc.isPresent) return;
    npc.isPresent = true;
    npc.messagesPresent = 0;
    saveSettingsDebounced();
    updatePrompt();
    renderPanel();
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

// ─── Direct address detection ─────────────────────────────────
function escR(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function isDirectAddress(npc, text) {
    const names = [npc.name, ...(npc.aliases || [])].filter(Boolean);
    for (const name of names) {
        const r = escR(name);
        // Косвенные паттерны — если любой из них совпадает, пропускаем
        const indirect = [
            new RegExp(`${r}\\s+(написал|сказал|пошёл|ушёл|пришёл|видел|был|была|сделал|told|said|went|came|wrote|was)`, 'i'),
            new RegExp(`(об?|про|о\\s+том|about|of|from)\\s+${r}`, 'i'),
            new RegExp(`${r}(а\\s|у\\s|'s)`, 'i'),
        ];
        if (indirect.some(re => re.test(text))) continue;

        // Прямые паттерны
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

// ─── Context window ───────────────────────────────────────────
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

// ─── Chat indicator ───────────────────────────────────────────
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

// ─── Event handlers ───────────────────────────────────────────
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

function onBotMessageReceived() {
    const s = getSettings();
    const recent = getRecentMessages(s.contextWindowSize || 5);
    let changed = false;

    for (const g of s.groups) {
        if (!g.enabled) continue;
        for (const npc of (g.npcs || [])) {
            if (!npc.enabled) continue;

            // Auto-remove
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

            // Context appearance
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

// ─── Export / Import ──────────────────────────────────────────
function exportNPCs() {
    const data = JSON.stringify({ groups: getSettings().groups }, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = 'npc_manager_export.json';
    a.click();
}

function importNPCs(json) {
    try {
        const data = JSON.parse(json);
        if (!Array.isArray(data.groups)) throw new Error('Неверный формат');
        getSettings().groups = data.groups;
        saveSettingsDebounced();
        updatePrompt();
        renderPanel();
    } catch (e) { alert('Ошибка импорта: ' + e.message); }
}

// ─── Helpers ─────────────────────────────────────────────────
function escHtml(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Render ───────────────────────────────────────────────────
function renderPanel() {
    const panel = document.getElementById('npc_manager_panel');
    if (!panel) return;

    const s = getSettings();
    const presentTotal = getPresentNPCs().length;

    panel.innerHTML = `
        <div class="npc-topbar">
            <button class="npc-btn npc-btn-add-group" id="npc_add_group">+ Новая группа</button>
            <div class="npc-topbar-right">
                ${presentTotal > 0 ? `<span class="npc-scene-badge">${presentTotal} в сцене</span>` : ''}
                <button class="npc-icon-btn" id="npc_export" title="Экспорт в JSON">⬆</button>
                <label class="npc-icon-btn" title="Импорт из JSON">⬇<input type="file" accept=".json" id="npc_import_file" style="display:none"></label>
            </div>
        </div>

        ${s.groups.length === 0
            ? `<div class="npc-empty">Групп нет. Создайте первую группу и добавьте NPC.</div>`
            : s.groups.map(renderGroup).join('')
        }

        <div class="npc-global-section">
            <div class="npc-global-label">Настройки контекста</div>
            <div class="npc-global-row">
                <span class="npc-global-hint">Окно сообщений</span>
                <input type="range" class="npc-range" id="npc_ctx_window" min="2" max="20" value="${s.contextWindowSize || 5}">
                <span class="npc-range-val" id="npc_ctx_window_val">${s.contextWindowSize || 5}</span>
            </div>
            <div class="npc-global-row">
                <span class="npc-global-hint">Базовый шанс (контекст)</span>
                <input type="range" class="npc-range" id="npc_ctx_chance" min="5" max="80" value="${s.contextBaseChance || 30}">
                <span class="npc-range-val" id="npc_ctx_chance_val">${s.contextBaseChance || 30}%</span>
            </div>
        </div>
    `;

    bindEvents(panel);
}

function renderGroup(group) {
    const npcs = group.npcs || [];
    const presentCount = npcs.filter(n => n.enabled && n.isPresent).length;
    return `
        <div class="npc-group ${!group.enabled ? 'npc-group-off' : ''}" data-group-id="${group.id}">
            <div class="npc-group-head">
                <button class="npc-collapse-btn" data-collapse="${group.id}">${group.collapsed ? '▸' : '▾'}</button>
                <input class="npc-group-name" value="${escHtml(group.name)}" data-rename="${group.id}" placeholder="Название группы">
                ${presentCount > 0 ? `<span class="npc-badge">${presentCount}◈</span>` : ''}
                <div class="npc-group-controls">
                    <label class="npc-switch" title="${group.enabled ? 'Выключить' : 'Включить'}">
                        <input type="checkbox" class="npc-group-toggle" data-gid="${group.id}" ${group.enabled ? 'checked' : ''}>
                        <span class="npc-switch-track"></span>
                    </label>
                    <button class="npc-del-btn" data-del-group="${group.id}" title="Удалить группу">✕</button>
                </div>
            </div>
            <div class="npc-group-body ${group.collapsed ? 'npc-body-collapsed' : ''}">
                ${npcs.length === 0
                    ? `<div class="npc-group-empty">Нет NPC в группе</div>`
                    : npcs.map(npc => renderNPCRow(npc)).join('')
                }
                <button class="npc-add-npc-btn" data-add-npc="${group.id}">+ Добавить NPC</button>
            </div>
        </div>
    `;
}

const MODE_ICON  = { manual: '🖱', direct: '💬', context: '🌐' };
const MODE_LABEL = { manual: 'Вручную', direct: 'Прямое', context: 'Контекст' };

function renderNPCRow(npc) {
    return `
        <div class="npc-row ${npc.isPresent ? 'npc-row-present' : ''} ${!npc.enabled ? 'npc-row-off' : ''}">
            <span class="npc-row-dot ${npc.isPresent ? 'dot-on' : 'dot-off'}" title="${npc.isPresent ? 'В сцене' : 'Не в сцене'}">◈</span>
            <span class="npc-row-name">${escHtml(npc.name)}</span>
            <span class="npc-row-mode" title="${MODE_LABEL[npc.triggerMode] || ''}">${MODE_ICON[npc.triggerMode] || '🖱'}</span>
            <div class="npc-row-actions">
                ${npc.isPresent
                    ? `<button class="npc-sm-btn npc-sm-remove" data-remove="${npc.id}">Убрать</button>`
                    : `<button class="npc-sm-btn npc-sm-add" data-add-scene="${npc.id}">В сцену</button>`
                }
                <button class="npc-icon-btn" data-edit-npc="${npc.id}" title="Редактировать">✏</button>
                <label class="npc-switch npc-switch-sm">
                    <input type="checkbox" class="npc-npc-toggle" data-nid="${npc.id}" ${npc.enabled ? 'checked' : ''}>
                    <span class="npc-switch-track"></span>
                </label>
            </div>
        </div>
    `;
}

// ─── Edit modal ───────────────────────────────────────────────
function openEditModal(npcId, groupId) {
    document.getElementById('npc_edit_overlay')?.remove();

    const isNew = !npcId;
    const npc = npcId ? getNPC(npcId) : null;
    const data = npc || {
        id: genId(), groupId,
        name: '', aliases: [], description: '',
        triggerMode: 'manual', keywords: [],
        autoRemoveAfter: 0, enabled: true,
        isPresent: false, messagesPresent: 0
    };
    const gid = groupId || data.groupId;

    const overlay = document.createElement('div');
    overlay.id = 'npc_edit_overlay';
    overlay.className = 'npc-overlay';
    overlay.innerHTML = `
        <div class="npc-modal">
            <div class="npc-modal-head">
                <span class="npc-modal-title">${isNew ? 'Новый NPC' : 'Редактировать NPC'}</span>
                <button class="npc-icon-btn" id="npc_modal_close">✕</button>
            </div>

            <div class="npc-field">
                <label class="npc-label">Имя</label>
                <input class="npc-input" id="nm_name" value="${escHtml(data.name)}" placeholder="Эйра">
            </div>
            <div class="npc-field">
                <label class="npc-label">Псевдонимы <span class="npc-sub">(через запятую)</span></label>
                <input class="npc-input" id="nm_aliases" value="${escHtml((data.aliases || []).join(', '))}" placeholder="эй ты, рыжая, чародейка">
            </div>
            <div class="npc-field">
                <label class="npc-label">Описание</label>
                <textarea class="npc-textarea" id="nm_desc" placeholder="Внешность, характер, роль в мире, текущее состояние...">${escHtml(data.description || '')}</textarea>
            </div>

            <div class="npc-field">
                <label class="npc-label">Режим появления</label>
                <div class="npc-mode-row">
                    <label class="npc-mode-card ${data.triggerMode === 'manual' ? 'mode-active' : ''}">
                        <input type="radio" name="nm_mode" value="manual" ${data.triggerMode === 'manual' ? 'checked' : ''}>
                        <span class="npc-mode-icon">🖱</span>
                        <span class="npc-mode-name">Вручную</span>
                        <span class="npc-mode-desc">Только через кнопку</span>
                    </label>
                    <label class="npc-mode-card ${data.triggerMode === 'direct' ? 'mode-active' : ''}">
                        <input type="radio" name="nm_mode" value="direct" ${data.triggerMode === 'direct' ? 'checked' : ''}>
                        <span class="npc-mode-icon">💬</span>
                        <span class="npc-mode-name">Прямое</span>
                        <span class="npc-mode-desc">При обращении по имени</span>
                    </label>
                    <label class="npc-mode-card ${data.triggerMode === 'context' ? 'mode-active' : ''}">
                        <input type="radio" name="nm_mode" value="context" ${data.triggerMode === 'context' ? 'checked' : ''}>
                        <span class="npc-mode-icon">🌐</span>
                        <span class="npc-mode-name">Контекст</span>
                        <span class="npc-mode-desc">По ключевым словам</span>
                    </label>
                </div>
            </div>

            <div class="npc-field ${data.triggerMode !== 'context' ? 'npc-hidden' : ''}" id="nm_kw_field">
                <label class="npc-label">Ключевые слова <span class="npc-sub">(через запятую)</span></label>
                <input class="npc-input" id="nm_keywords" value="${escHtml((data.keywords || []).join(', '))}" placeholder="таверна, рынок, центр города">
            </div>

            <div class="npc-field">
                <label class="npc-label">
                    Авто-удаление через <strong id="nm_auto_val">${data.autoRemoveAfter || 0}</strong> сообщ.
                    <span class="npc-sub">(0 = не удалять)</span>
                </label>
                <input type="range" class="npc-range" id="nm_auto_remove" min="0" max="30" value="${data.autoRemoveAfter || 0}">
            </div>

            <div class="npc-modal-foot">
                <button class="npc-btn npc-btn-danger-sm" id="nm_delete" ${isNew ? 'style="visibility:hidden"' : ''}>Удалить NPC</button>
                <div class="npc-foot-right">
                    <button class="npc-btn npc-btn-ghost" id="nm_cancel">Отмена</button>
                    <button class="npc-btn npc-btn-primary" id="nm_save">${isNew ? 'Создать' : 'Сохранить'}</button>
                </div>
            </div>
        </div>
    `;

    document.getElementById('npc_manager_panel').appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#npc_modal_close').addEventListener('click', close);
    overlay.querySelector('#nm_cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    // Mode cards
    overlay.querySelectorAll('input[name="nm_mode"]').forEach(r => {
        r.addEventListener('change', () => {
            overlay.querySelectorAll('.npc-mode-card').forEach(c => c.classList.remove('mode-active'));
            r.closest('.npc-mode-card').classList.add('mode-active');
            overlay.querySelector('#nm_kw_field').classList.toggle('npc-hidden', r.value !== 'context');
        });
    });

    overlay.querySelector('#nm_auto_remove').addEventListener('input', function () {
        overlay.querySelector('#nm_auto_val').textContent = this.value;
    });

    overlay.querySelector('#nm_save').addEventListener('click', () => {
        const name = overlay.querySelector('#nm_name').value.trim();
        if (!name) { overlay.querySelector('#nm_name').focus(); return; }

        const aliases  = overlay.querySelector('#nm_aliases').value.split(',').map(s => s.trim()).filter(Boolean);
        const keywords = overlay.querySelector('#nm_keywords').value.split(',').map(s => s.trim()).filter(Boolean);
        const mode     = overlay.querySelector('input[name="nm_mode"]:checked')?.value || 'manual';
        const autoRemove = parseInt(overlay.querySelector('#nm_auto_remove').value) || 0;
        const desc     = overlay.querySelector('#nm_desc').value.trim();

        const s = getSettings();
        const group = s.groups.find(g => g.id === gid);
        if (!group) return;
        if (!group.npcs) group.npcs = [];

        if (isNew) {
            group.npcs.push({ id: data.id, groupId: gid, name, aliases, description: desc, triggerMode: mode, keywords, autoRemoveAfter: autoRemove, enabled: true, isPresent: false, messagesPresent: 0 });
        } else {
            const idx = group.npcs.findIndex(n => n.id === data.id);
            if (idx >= 0) Object.assign(group.npcs[idx], { name, aliases, description: desc, triggerMode: mode, keywords, autoRemoveAfter: autoRemove });
        }

        saveSettingsDebounced(); updatePrompt(); close(); renderPanel();
    });

    overlay.querySelector('#nm_delete').addEventListener('click', () => {
        if (!confirm(`Удалить NPC "${data.name}"?`)) return;
        const s = getSettings();
        for (const g of s.groups) g.npcs = (g.npcs || []).filter(n => n.id !== data.id);
        saveSettingsDebounced(); updatePrompt(); close(); renderPanel();
    });

    setTimeout(() => overlay.querySelector('#nm_name').focus(), 50);
}

// ─── Event binding ────────────────────────────────────────────
function bindEvents(panel) {
    panel.querySelector('#npc_add_group')?.addEventListener('click', () => {
        const s = getSettings();
        s.groups.push({ id: genId(), name: 'Новая группа', enabled: true, collapsed: false, npcs: [] });
        saveSettingsDebounced(); renderPanel();
    });

    panel.querySelector('#npc_export')?.addEventListener('click', exportNPCs);

    panel.querySelector('#npc_import_file')?.addEventListener('change', function () {
        const f = this.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = e => importNPCs(e.target.result);
        r.readAsText(f); this.value = '';
    });

    panel.querySelectorAll('.npc-collapse-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const g = getGroup(btn.dataset.collapse);
            if (g) { g.collapsed = !g.collapsed; saveSettingsDebounced(); renderPanel(); }
        });
    });

    panel.querySelectorAll('.npc-group-name').forEach(inp => {
        inp.addEventListener('change', function () {
            const g = getGroup(this.dataset.rename);
            if (g) { g.name = this.value; saveSettingsDebounced(); }
        });
    });

    panel.querySelectorAll('.npc-group-toggle').forEach(cb => {
        cb.addEventListener('change', function () {
            const g = getGroup(this.dataset.gid);
            if (g) { g.enabled = this.checked; saveSettingsDebounced(); updatePrompt(); renderPanel(); }
        });
    });

    panel.querySelectorAll('[data-del-group]').forEach(btn => {
        btn.addEventListener('click', () => {
            const s = getSettings();
            const g = getGroup(btn.dataset.delGroup);
            if (!g || !confirm(`Удалить группу «${g.name}» и всех её NPC?`)) return;
            s.groups = s.groups.filter(x => x.id !== btn.dataset.delGroup);
            saveSettingsDebounced(); updatePrompt(); renderPanel();
        });
    });

    panel.querySelectorAll('[data-add-npc]').forEach(btn => {
        btn.addEventListener('click', () => openEditModal(null, btn.dataset.addNpc));
    });

    panel.querySelectorAll('[data-edit-npc]').forEach(btn => {
        btn.addEventListener('click', () => openEditModal(btn.dataset.editNpc, null));
    });

    panel.querySelectorAll('[data-add-scene]').forEach(btn => {
        btn.addEventListener('click', () => addToScene(btn.dataset.addScene));
    });

    panel.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', () => removeFromScene(btn.dataset.remove));
    });

    panel.querySelectorAll('.npc-npc-toggle').forEach(cb => {
        cb.addEventListener('change', function () {
            const npc = getNPC(this.dataset.nid);
            if (!npc) return;
            npc.enabled = this.checked;
            if (!this.checked) npc.isPresent = false;
            saveSettingsDebounced(); updatePrompt(); renderPanel();
        });
    });

    // Global settings
    panel.querySelector('#npc_ctx_window')?.addEventListener('input', function () {
        getSettings().contextWindowSize = parseInt(this.value);
        panel.querySelector('#npc_ctx_window_val').textContent = this.value;
        saveSettingsDebounced();
    });
    panel.querySelector('#npc_ctx_chance')?.addEventListener('input', function () {
        getSettings().contextBaseChance = parseInt(this.value);
        panel.querySelector('#npc_ctx_chance_val').textContent = this.value + '%';
        saveSettingsDebounced();
    });
}

// ─── Panel setup ──────────────────────────────────────────────
function setupPanel() {
    $('#extensions_settings').append(`
        <div class="npc_manager_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>◈ NPC Manager</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div id="npc_manager_panel" class="npc-panel"></div>
                </div>
            </div>
        </div>
    `);
    renderPanel();
}

// ─── Init ─────────────────────────────────────────────────────
jQuery(async () => {
    console.log('[NPC Manager] Загрузка...');
    loadSettings();
    setupPanel();
    updatePrompt();
    eventSource.on(event_types.MESSAGE_SENT, onUserMessageSent);
    eventSource.on(event_types.MESSAGE_RECEIVED, onBotMessageReceived);
    console.log('[NPC Manager] Готово.');
});
