import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types
} from '../../../../script.js';
import {
    extension_settings
} from '../../../extensions.js';

const extensionName = "arc_catalyst";

let pendingNotification = null;
let messagesSinceLastArc = 0;
let arcActive = false;

// ─── Settings ───────────────────────────────────────────────────────────────
const defaultSettings = {
    isEnabled: true,
    chance: 12,
    showNotifications: true,
    selectedGenres: ["fantasy", "detective"],
    contextMessages: 8,
    cooldownMessages: 5,
    stats: {
        totalTriggered: 0,
        lastTriggered: null,
        genreCounts: {}
    },
    arcHistory: []
};

function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }
    for (const key in defaultSettings) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = structuredClone(defaultSettings[key]);
        }
    }
    if (!extension_settings[extensionName].stats) {
        extension_settings[extensionName].stats = structuredClone(defaultSettings.stats);
    }
    if (!extension_settings[extensionName].arcHistory) {
        extension_settings[extensionName].arcHistory = [];
    }
}

function getSettings() {
    return extension_settings[extensionName];
}

// ─── Genre config ────────────────────────────────────────────────────────────
const genreConfig = [
    { id: 'fantasy',   label: 'Фэнтези',     icon: '⚔️',
      hint: 'magic, ancient mysteries, prophecies, hidden bloodlines, cursed artifacts, forgotten gods' },
    { id: 'detective', label: 'Детектив',     icon: '🔍',
      hint: 'murder, deception, hidden motives, false alibis, evidence that points the wrong way' },
    { id: 'romance',   label: 'Романтика',    icon: '🌹',
      hint: 'forbidden feelings, misunderstandings, past that resurfaces, choices between duty and desire' },
    { id: 'horror',    label: 'Хоррор',       icon: '🕯️',
      hint: 'wrongness that builds slowly, things that should not exist, trust eroding, no safe place' },
    { id: 'scifi',     label: 'Фантастика',   icon: '🚀',
      hint: 'technology with hidden cost, signals from impossible sources, identity and consciousness, systems failing' },
    { id: 'political', label: 'Политика',     icon: '👁️',
      hint: 'power plays, shifting alliances, information as weapon, someone using the characters as pawns' },
    { id: 'personal',  label: 'Личное',       icon: '🪞',
      hint: 'someone from the past, a secret about one of the characters, a debt or promise coming due' },
];

// ─── Build injected prompt ───────────────────────────────────────────────────
function buildDynamicArcPrompt(recentContext, genres) {
    const selectedGenres = genres
        .map(id => genreConfig.find(g => g.id === id))
        .filter(Boolean);

    const genreBlock = selectedGenres
        .map(g => `- ${g.icon} ${g.label}: ${g.hint}`)
        .join('\n');

    const contextBlock = recentContext.trim()
        ? `Here is what has been happening in the current scene:\n---\n${recentContext}\n---\n\n`
        : '';

    return `[OOC — STORY ARC CATALYST]
${contextBlock}Introduce the quiet beginning of a multi-session story arc. Read the scene above and grow something from what is already there — a tension, a relationship, an unresolved thing. Do not invent it from nothing; find the crack that is already present and widen it slightly.

Genre tones to draw from:
${genreBlock}

Rules:
- This is NOT a sudden event, fight, or twist. It is a seed — something small that carries weight.
- It must raise at least two questions the characters cannot yet answer.
- Do NOT resolve it or explain what it means. Leave it open.
- It should feel as if it was always there, just now visible.
- Weave it into the scene naturally — do not announce that something is beginning.
- No forced action. The hook should make the player want to pull the thread, not push them into a scene.
[/OOC]`;
}

// ─── Extract recent chat context ─────────────────────────────────────────────
function getRecentContext(maxMessages) {
    try {
        const ctx = SillyTavern.getContext();
        if (!ctx || !ctx.chat || !ctx.chat.length) return '';

        const messages = ctx.chat
            .filter(m => !m.is_system)
            .slice(-maxMessages);

        return messages.map(m => {
            const speaker = m.is_user
                ? (ctx.name1 || 'Игрок')
                : (ctx.name2 || 'Персонаж');
            const text = (m.mes || '').replace(/<[^>]*>/g, '').trim();
            return `${speaker}: ${text}`;
        }).join('\n\n');
    } catch (e) {
        console.warn('[Arc Catalyst] Could not read context:', e);
        return '';
    }
}

// ─── Stats & History ─────────────────────────────────────────────────────────
function recordArcTrigger(genres) {
    const s = getSettings();

    s.stats.totalTriggered = (s.stats.totalTriggered || 0) + 1;
    s.stats.lastTriggered = new Date().toISOString();

    if (!s.stats.genreCounts) s.stats.genreCounts = {};
    genres.forEach(g => {
        s.stats.genreCounts[g] = (s.stats.genreCounts[g] || 0) + 1;
    });

    const historyEntry = {
        timestamp: new Date().toISOString(),
        genres: genres.slice()
    };
    if (!s.arcHistory) s.arcHistory = [];
    s.arcHistory.unshift(historyEntry);
    if (s.arcHistory.length > 20) s.arcHistory.length = 20;

    saveSettingsDebounced();
    syncStats();
}

function getTopGenre() {
    const s = getSettings();
    const counts = s.stats.genreCounts || {};
    let top = null, topCount = 0;
    for (const [id, count] of Object.entries(counts)) {
        if (count > topCount) { top = id; topCount = count; }
    }
    if (!top) return '—';
    const g = genreConfig.find(x => x.id === top);
    return g ? `${g.icon} ${g.label} (${topCount})` : top;
}

function formatTimeAgo(isoString) {
    if (!isoString) return 'Никогда';
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (mins < 1) return 'Только что';
    if (mins < 60) return `${mins} мин назад`;
    if (hours < 24) return `${hours} ч назад`;
    return `${days} дн назад`;
}

function syncStats() {
    const s = getSettings();

    const totalEl = document.getElementById('arc_stat_total');
    const lastEl  = document.getElementById('arc_stat_last');
    const topEl   = document.getElementById('arc_stat_top');
    const cdEl    = document.getElementById('arc_stat_cooldown');

    if (totalEl) totalEl.textContent = s.stats.totalTriggered || 0;
    if (lastEl)  lastEl.textContent  = formatTimeAgo(s.stats.lastTriggered);
    if (topEl)   topEl.textContent   = getTopGenre();
    if (cdEl) {
        const remaining = Math.max(0, (s.cooldownMessages || 0) - messagesSinceLastArc);
        cdEl.textContent = remaining > 0 ? `${remaining} сообщ.` : 'Готово';
        cdEl.style.color = remaining > 0 ? 'var(--warning)' : 'var(--green)';
    }

    const historyList = document.getElementById('arc_history_list');
    if (historyList) {
        const history = s.arcHistory || [];
        if (history.length === 0) {
            historyList.innerHTML = '<div class="arc-history-empty">Арки ещё не запускались</div>';
        } else {
            historyList.innerHTML = history.slice(0, 10).map(entry => {
                const genreLabels = entry.genres.map(id => {
                    const g = genreConfig.find(x => x.id === id);
                    return g ? `${g.icon} ${g.label}` : id;
                }).join(' · ');
                const time = formatTimeAgo(entry.timestamp);
                return `<div class="arc-history-entry">
                    <span class="arc-history-genres">${genreLabels}</span>
                    <span class="arc-history-time">${time}</span>
                </div>`;
            }).join('');
        }
    }
}

function resetStats() {
    const s = getSettings();
    s.stats = { totalTriggered: 0, lastTriggered: null, genreCounts: {} };
    s.arcHistory = [];
    messagesSinceLastArc = 0;
    saveSettingsDebounced();
    syncStats();
}

// ─── Arc active state ─────────────────────────────────────────────────────────
function setArcActive(active) {
    arcActive = active;
    const cancelBtn = document.getElementById('arc_cancel_btn');
    const forceBtn  = document.getElementById('arc_force_btn');
    if (!cancelBtn || !forceBtn) return;

    if (active) {
        cancelBtn.style.display = 'block';
        forceBtn.textContent = '◈ Арка в очереди...';
        forceBtn.disabled = true;
    } else {
        cancelBtn.style.display = 'none';
        forceBtn.textContent = '◈ Запустить арку сейчас';
        forceBtn.disabled = false;
    }
}

// ─── Notification ─────────────────────────────────────────────────────────────
function showArcNotification(genres) {
    const notification = document.createElement('div');
    notification.className = 'arc-notification';

    const genreLabel = genres
        .map(id => {
            const g = genreConfig.find(x => x.id === id);
            return g ? `${g.icon} ${g.label}` : id;
        })
        .join('  ');

    notification.innerHTML = `
        <div class="arc-notification-bar"></div>
        <div class="arc-notification-inner">
            <div class="arc-notification-icon">◈</div>
            <div class="arc-notification-body">
                <div class="arc-notification-label">Arc Catalyst</div>
                <div class="arc-notification-genres">${genreLabel}</div>
            </div>
            <div class="arc-notification-close">✕</div>
        </div>
    `;

    document.body.appendChild(notification);
    requestAnimationFrame(() => notification.classList.add('arc-notification-show'));

    const close = () => {
        notification.classList.remove('arc-notification-show');
        notification.classList.add('arc-notification-hide');
        setTimeout(() => notification.remove(), 400);
    };
    notification.querySelector('.arc-notification-close').addEventListener('click', close);
    setTimeout(close, 9000);
}

// ─── Core trigger logic ───────────────────────────────────────────────────────
function triggerArc(genres) {
    const s = getSettings();
    const recentContext = getRecentContext(s.contextMessages);
    const prompt = buildDynamicArcPrompt(recentContext, genres);

    setExtensionPrompt(extensionName, prompt, extension_prompt_types.IN_CHAT, 0);
    recordArcTrigger(genres);
    messagesSinceLastArc = 0;
    pendingNotification = genres;
    setArcActive(true);

    console.log('[Arc Catalyst] ✓ Арка добавлена в очередь');
}

function cancelArc() {
    setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);
    pendingNotification = null;
    setArcActive(false);
    console.log('[Arc Catalyst] ✗ Арка отменена');
}

// ─── Collapsible sections ─────────────────────────────────────────────────────
function setupCollapsible() {
    $(document).on('click', '.arc-collapsible-header', function () {
        const targetId = $(this).data('target');
        const body = document.getElementById(targetId);
        if (!body) return;
        const isCollapsed = body.classList.toggle('arc-collapsed');
        $(this).find('.arc-collapse-arrow').text(isCollapsed ? '▸' : '▾');
    });
}

// ─── UI Panel ─────────────────────────────────────────────────────────────────
function syncPanel() {
    const s = getSettings();
    const enabled    = document.getElementById('arc_ext_enabled');
    const notify     = document.getElementById('arc_ext_notify');
    const slider     = document.getElementById('arc_ext_slider');
    const value      = document.getElementById('arc_ext_value');
    const ctxSlider  = document.getElementById('arc_ext_ctx_slider');
    const ctxValue   = document.getElementById('arc_ext_ctx_value');
    const cdSlider   = document.getElementById('arc_ext_cd_slider');
    const cdValue    = document.getElementById('arc_ext_cd_value');

    if (enabled)   enabled.checked      = s.isEnabled;
    if (notify)    notify.checked       = s.showNotifications;
    if (slider)    slider.value         = s.chance;
    if (value)     value.textContent    = `${s.chance}%`;
    if (ctxSlider) ctxSlider.value      = s.contextMessages;
    if (ctxValue)  ctxValue.textContent = `${s.contextMessages}`;
    if (cdSlider)  cdSlider.value       = s.cooldownMessages;
    if (cdValue)   cdValue.textContent  = s.cooldownMessages === 0 ? 'Откл' : `${s.cooldownMessages}`;

    genreConfig.forEach(g => {
        const el = document.querySelector(`.arc-genre-pill[data-genre="${g.id}"]`);
        if (el) el.classList.toggle('arc-genre-active', s.selectedGenres.includes(g.id));
    });

    syncStats();
}

function setupPanel() {
    const genrePills = genreConfig.map(g =>
        `<button class="arc-genre-pill" data-genre="${g.id}" title="${g.hint}">${g.icon} ${g.label}</button>`
    ).join('');

    const html = `
        <div class="arc_catalyst_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>◈ Arc Catalyst</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">

                    <!-- Жанры -->
                    <div class="arc-section">
                        <div class="arc-section-label">Жанровые тона</div>
                        <div class="arc-genre-grid">${genrePills}</div>
                        <div class="arc-genre-hint">Бот читает сцену и создаёт зерно арки в этих тонах</div>
                    </div>

                    <!-- Настройки (сворачиваемые) -->
                    <div class="arc-section">
                        <div class="arc-section-label arc-collapsible-header" data-target="arc_settings_body">
                            Настройки
                            <span class="arc-collapse-arrow">▾</span>
                        </div>
                        <div id="arc_settings_body" class="arc-collapsible-body">

                            <div class="arc-subsection">
                                <div class="arc-subsection-label">Шанс срабатывания</div>
                                <div class="arc-slider-row">
                                    <input type="range" id="arc_ext_slider" min="0" max="100" step="1" class="neo-range-slider arc-slider">
                                    <span id="arc_ext_value" class="arc-value-badge">12%</span>
                                </div>
                            </div>

                            <div class="arc-subsection">
                                <div class="arc-subsection-label">Глубина контекста</div>
                                <div class="arc-slider-row">
                                    <input type="range" id="arc_ext_ctx_slider" min="2" max="20" step="1" class="neo-range-slider arc-slider">
                                    <span id="arc_ext_ctx_value" class="arc-value-badge">8</span>
                                    <span class="arc-ctx-label">сообщ.</span>
                                </div>
                                <div class="arc-genre-hint">Сколько последних сообщений бот читает для формирования арки</div>
                            </div>

                            <div class="arc-subsection">
                                <div class="arc-subsection-label">Перезарядка</div>
                                <div class="arc-slider-row">
                                    <input type="range" id="arc_ext_cd_slider" min="0" max="30" step="1" class="neo-range-slider arc-slider">
                                    <span id="arc_ext_cd_value" class="arc-value-badge">5</span>
                                </div>
                                <div class="arc-genre-hint">Мин. сообщений между триггерами арки (0 = без перезарядки)</div>
                            </div>

                            <div class="arc-subsection arc-toggles">
                                <label class="arc-toggle-label">
                                    <input type="checkbox" id="arc_ext_enabled">
                                    <span class="arc-toggle-text">Включить Arc Catalyst</span>
                                </label>
                                <label class="arc-toggle-label">
                                    <input type="checkbox" id="arc_ext_notify">
                                    <span class="arc-toggle-text">Показывать уведомления</span>
                                </label>
                            </div>

                        </div>
                    </div>

                    <!-- Управление -->
                    <div class="arc-section">
                        <button id="arc_force_btn" class="arc-force-btn">
                            ◈ Запустить арку сейчас
                        </button>
                        <button id="arc_cancel_btn" class="arc-cancel-btn" style="display:none">
                            ✕ Отменить арку
                        </button>
                    </div>

                    <!-- Статистика (сворачиваемая) -->
                    <div class="arc-section">
                        <div class="arc-section-label arc-collapsible-header" data-target="arc_stats_body">
                            Статистика
                            <span class="arc-section-label-actions">
                                <button id="arc_reset_stats" class="arc-reset-btn">↺ Сброс</button>
                                <span class="arc-collapse-arrow">▾</span>
                            </span>
                        </div>
                        <div id="arc_stats_body" class="arc-collapsible-body">
                            <div class="arc-stats-grid">
                                <div class="arc-stat-item">
                                    <div class="arc-stat-value" id="arc_stat_total">0</div>
                                    <div class="arc-stat-label">Всего арок</div>
                                </div>
                                <div class="arc-stat-item">
                                    <div class="arc-stat-value" id="arc_stat_last">Никогда</div>
                                    <div class="arc-stat-label">Последняя</div>
                                </div>
                                <div class="arc-stat-item">
                                    <div class="arc-stat-value" id="arc_stat_cooldown">Готово</div>
                                    <div class="arc-stat-label">Перезарядка</div>
                                </div>
                                <div class="arc-stat-item arc-stat-wide">
                                    <div class="arc-stat-value" id="arc_stat_top">—</div>
                                    <div class="arc-stat-label">Топ жанр</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- История арок (сворачиваемая) -->
                    <div class="arc-section">
                        <div class="arc-section-label arc-collapsible-header" data-target="arc_history_body">
                            История арок
                            <span class="arc-collapse-arrow">▾</span>
                        </div>
                        <div id="arc_history_body" class="arc-collapsible-body arc-collapsed">
                            <div id="arc_history_list" class="arc-history-list">
                                <div class="arc-history-empty">Арки ещё не запускались</div>
                            </div>
                        </div>
                    </div>

                    <div class="arc-footer-hint">Срабатывает после ответа бота · Читает сцену · Развивает арку из того, что уже есть</div>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings').append(html);

    // Sync collapsed arrow for history (starts collapsed)
    const historyHeader = document.querySelector('[data-target="arc_history_body"] .arc-collapse-arrow');
    if (historyHeader) historyHeader.textContent = '▸';

    syncPanel();
    setupCollapsible();

    // Genre pills
    $(document).on('click', '.arc-genre-pill', function () {
        const g = $(this).data('genre');
        const s = getSettings();
        const idx = s.selectedGenres.indexOf(g);
        if (idx === -1) {
            s.selectedGenres.push(g);
        } else if (s.selectedGenres.length > 1) {
            s.selectedGenres.splice(idx, 1);
        }
        saveSettingsDebounced();
        syncPanel();
    });

    // Toggles
    $('#arc_ext_enabled').on('change', function () {
        getSettings().isEnabled = this.checked;
        saveSettingsDebounced();
    });

    $('#arc_ext_notify').on('change', function () {
        getSettings().showNotifications = this.checked;
        saveSettingsDebounced();
    });

    // Sliders
    $('#arc_ext_slider').on('input', function () {
        const v = parseInt(this.value);
        getSettings().chance = v;
        document.getElementById('arc_ext_value').textContent = `${v}%`;
        saveSettingsDebounced();
    });

    $('#arc_ext_ctx_slider').on('input', function () {
        const v = parseInt(this.value);
        getSettings().contextMessages = v;
        document.getElementById('arc_ext_ctx_value').textContent = `${v}`;
        saveSettingsDebounced();
    });

    $('#arc_ext_cd_slider').on('input', function () {
        const v = parseInt(this.value);
        getSettings().cooldownMessages = v;
        document.getElementById('arc_ext_cd_value').textContent = v === 0 ? 'Откл' : `${v}`;
        saveSettingsDebounced();
        syncStats();
    });

    // Force arc
    $('#arc_force_btn').on('click', function () {
        const s = getSettings();
        if (!s.selectedGenres.length || arcActive) return;
        triggerArc(s.selectedGenres);
    });

    // Cancel arc
    $('#arc_cancel_btn').on('click', function () {
        cancelArc();
    });

    // Reset stats — stop click from bubbling to collapsible header
    $('#arc_reset_stats').on('click', function (e) {
        e.stopPropagation();
        if (confirm('Сбросить всю статистику и историю Arc Catalyst?')) {
            resetStats();
        }
    });
}

// ─── Event hooks ──────────────────────────────────────────────────────────────
function onUserMessageSent() {
    const s = getSettings();
    if (arcActive) {
        if (s.showNotifications && pendingNotification) {
            showArcNotification(pendingNotification);
        }
        pendingNotification = null;
        setArcActive(false);
    }
}

function onBotMessageReceived() {
    const s = getSettings();

    messagesSinceLastArc++;
    setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);
    setArcActive(false);

    if (!s.isEnabled || !s.selectedGenres.length) return;

    const cooldown = s.cooldownMessages || 0;
    if (cooldown > 0 && messagesSinceLastArc <= cooldown) {
        console.log(`[Arc Catalyst] Перезарядка: ${messagesSinceLastArc}/${cooldown}`);
        syncStats();
        return;
    }

    const roll = Math.floor(Math.random() * 100) + 1;
    console.log(`[Arc Catalyst] Бросок: ${roll}, нужно: ≤${s.chance}`);

    if (roll <= s.chance) {
        triggerArc(s.selectedGenres);
    } else {
        console.log('[Arc Catalyst] ✗ Арка не сработала');
        syncStats();
    }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
jQuery(async () => {
    console.log('[Arc Catalyst] Загрузка...');
    loadSettings();
    setupPanel();
    eventSource.on(event_types.MESSAGE_SENT, onUserMessageSent);
    eventSource.on(event_types.MESSAGE_RECEIVED, onBotMessageReceived);
    console.log('[Arc Catalyst] Готово. Контекстная генерация арок активна.');
});
