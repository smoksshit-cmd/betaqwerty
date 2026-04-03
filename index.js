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
    { id: 'fantasy',   label: 'Fantasy',   icon: '⚔️',
      hint: 'magic, ancient mysteries, prophecies, hidden bloodlines, cursed artifacts, forgotten gods' },
    { id: 'detective', label: 'Detective',  icon: '🔍',
      hint: 'murder, deception, hidden motives, false alibis, evidence that points the wrong way' },
    { id: 'romance',   label: 'Romance',    icon: '🌹',
      hint: 'forbidden feelings, misunderstandings, past that resurfaces, choices between duty and desire' },
    { id: 'horror',    label: 'Horror',     icon: '🕯️',
      hint: 'wrongness that builds slowly, things that should not exist, trust eroding, no safe place' },
    { id: 'scifi',     label: 'Sci-Fi',     icon: '🚀',
      hint: 'technology with hidden cost, signals from impossible sources, identity and consciousness, systems failing' },
    { id: 'political', label: 'Political',  icon: '👁️',
      hint: 'power plays, shifting alliances, information as weapon, someone using the characters as pawns' },
    { id: 'personal',  label: 'Personal',   icon: '🪞',
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
                ? (ctx.name1 || 'Player')
                : (ctx.name2 || 'Character');
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
    if (!isoString) return 'Never';
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
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
        cdEl.textContent = remaining > 0 ? `${remaining} msgs` : 'Ready';
        cdEl.style.color = remaining > 0 ? 'var(--warning)' : 'var(--green)';
    }

    const historyList = document.getElementById('arc_history_list');
    if (historyList) {
        const history = s.arcHistory || [];
        if (history.length === 0) {
            historyList.innerHTML = '<div class="arc-history-empty">No arcs triggered yet</div>';
        } else {
            historyList.innerHTML = history.slice(0, 10).map(entry => {
                const genreLabels = entry.genres.map(id => {
                    const g = genreConfig.find(x => x.id === id);
                    return g ? `${g.icon}${g.label}` : id;
                }).join(' ');
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

// ─── Core trigger logic (shared) ─────────────────────────────────────────────
function triggerArc(genres, silent = false) {
    const s = getSettings();
    const recentContext = getRecentContext(s.contextMessages);
    const prompt = buildDynamicArcPrompt(recentContext, genres);

    setExtensionPrompt(extensionName, prompt, extension_prompt_types.IN_CHAT, 0);

    recordArcTrigger(genres);
    messagesSinceLastArc = 0;

    if (!silent) {
        pendingNotification = genres;
    }

    console.log('[Arc Catalyst] ✓ Arc prompt injected');
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
    if (cdValue)   cdValue.textContent  = s.cooldownMessages === 0 ? 'Off' : `${s.cooldownMessages}`;

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

                    <div class="arc-section">
                        <div class="arc-section-label">Genre Tones</div>
                        <div class="arc-genre-grid">${genrePills}</div>
                        <div class="arc-genre-hint">Bot reads your scene and invents an arc seed in these tones</div>
                    </div>

                    <div class="arc-section">
                        <div class="arc-section-label">Trigger Chance</div>
                        <div class="arc-slider-row">
                            <input type="range" id="arc_ext_slider" min="0" max="100" step="1" class="neo-range-slider arc-slider">
                            <span id="arc_ext_value" class="arc-value-badge">12%</span>
                        </div>
                    </div>

                    <div class="arc-section">
                        <div class="arc-section-label">Context Depth</div>
                        <div class="arc-slider-row">
                            <input type="range" id="arc_ext_ctx_slider" min="2" max="20" step="1" class="neo-range-slider arc-slider">
                            <span id="arc_ext_ctx_value" class="arc-value-badge">8</span>
                            <span class="arc-ctx-label">messages</span>
                        </div>
                        <div class="arc-genre-hint">How many recent messages the bot reads to shape the arc</div>
                    </div>

                    <div class="arc-section">
                        <div class="arc-section-label">Cooldown</div>
                        <div class="arc-slider-row">
                            <input type="range" id="arc_ext_cd_slider" min="0" max="30" step="1" class="neo-range-slider arc-slider">
                            <span id="arc_ext_cd_value" class="arc-value-badge">5</span>
                        </div>
                        <div class="arc-genre-hint">Min messages between arc triggers (0 = no cooldown)</div>
                    </div>

                    <div class="arc-section arc-toggles">
                        <label class="arc-toggle-label">
                            <input type="checkbox" id="arc_ext_enabled">
                            <span class="arc-toggle-text">Enable Arc Catalyst</span>
                        </label>
                        <label class="arc-toggle-label">
                            <input type="checkbox" id="arc_ext_notify">
                            <span class="arc-toggle-text">Show Notifications</span>
                        </label>
                    </div>

                    <div class="arc-section">
                        <button id="arc_force_btn" class="arc-force-btn" title="Inject arc prompt into the next bot reply">
                            ◈ Force Arc Now
                        </button>
                    </div>

                    <div class="arc-section">
                        <div class="arc-section-label">Statistics
                            <button id="arc_reset_stats" class="arc-reset-btn" title="Reset all stats">↺ Reset</button>
                        </div>
                        <div class="arc-stats-grid">
                            <div class="arc-stat-item">
                                <div class="arc-stat-value" id="arc_stat_total">0</div>
                                <div class="arc-stat-label">Total Arcs</div>
                            </div>
                            <div class="arc-stat-item">
                                <div class="arc-stat-value" id="arc_stat_last">Never</div>
                                <div class="arc-stat-label">Last Arc</div>
                            </div>
                            <div class="arc-stat-item">
                                <div class="arc-stat-value" id="arc_stat_cooldown">Ready</div>
                                <div class="arc-stat-label">Cooldown</div>
                            </div>
                            <div class="arc-stat-item arc-stat-wide">
                                <div class="arc-stat-value" id="arc_stat_top">—</div>
                                <div class="arc-stat-label">Top Genre</div>
                            </div>
                        </div>
                    </div>

                    <div class="arc-section">
                        <div class="arc-section-label">Arc History</div>
                        <div id="arc_history_list" class="arc-history-list">
                            <div class="arc-history-empty">No arcs triggered yet</div>
                        </div>
                    </div>

                    <div class="arc-footer-hint">Triggers after bot responds · Reads your scene · Grows an arc from what is already there</div>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings').append(html);
    syncPanel();

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
        document.getElementById('arc_ext_cd_value').textContent = v === 0 ? 'Off' : `${v}`;
        saveSettingsDebounced();
        syncStats();
    });

    // Force arc button
    $('#arc_force_btn').on('click', function () {
        const s = getSettings();
        if (!s.selectedGenres.length) return;
        triggerArc(s.selectedGenres, false);
        $(this).text('✓ Arc Queued!').prop('disabled', true);
        setTimeout(() => {
            $(this).text('◈ Force Arc Now').prop('disabled', false);
        }, 2000);
    });

    // Reset stats
    $('#arc_reset_stats').on('click', function () {
        if (confirm('Reset all Arc Catalyst statistics and history?')) {
            resetStats();
        }
    });
}

// ─── Event hooks ──────────────────────────────────────────────────────────────
function onUserMessageSent() {
    const s = getSettings();
    if (pendingNotification && s.showNotifications) {
        showArcNotification(pendingNotification);
    }
    pendingNotification = null;
}

function onBotMessageReceived() {
    const s = getSettings();

    messagesSinceLastArc++;
    setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);

    if (!s.isEnabled || !s.selectedGenres.length) return;

    const cooldown = s.cooldownMessages || 0;
    if (cooldown > 0 && messagesSinceLastArc <= cooldown) {
        console.log(`[Arc Catalyst] Cooldown: ${messagesSinceLastArc}/${cooldown} messages`);
        syncStats();
        return;
    }

    const roll = Math.floor(Math.random() * 100) + 1;
    console.log(`[Arc Catalyst] Roll: ${roll}, Need: ≤${s.chance}`);

    if (roll <= s.chance) {
        triggerArc(s.selectedGenres, false);
    } else {
        console.log('[Arc Catalyst] ✗ No arc this time');
        syncStats();
    }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
jQuery(async () => {
    console.log('[Arc Catalyst] Loading...');
    loadSettings();
    setupPanel();
    eventSource.on(event_types.MESSAGE_SENT, onUserMessageSent);
    eventSource.on(event_types.MESSAGE_RECEIVED, onBotMessageReceived);
    console.log('[Arc Catalyst] Ready. Context-aware arc generation active.');
});
