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

// ─── Settings ───────────────────────────────────────────────────────────────
const defaultSettings = {
    isEnabled: true,
    chance: 12,
    showNotifications: true,
    selectedGenres: ["fantasy", "detective"],
    contextMessages: 8
};

function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }
    for (const key in defaultSettings) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = defaultSettings[key];
        }
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
        // FIX: use SillyTavern.getContext() instead of the removed getContext export
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

// ─── UI Panel ─────────────────────────────────────────────────────────────────
function syncPanel() {
    const s = getSettings();
    const enabled    = document.getElementById('arc_ext_enabled');
    const notify     = document.getElementById('arc_ext_notify');
    const slider     = document.getElementById('arc_ext_slider');
    const value      = document.getElementById('arc_ext_value');
    const ctxSlider  = document.getElementById('arc_ext_ctx_slider');
    const ctxValue   = document.getElementById('arc_ext_ctx_value');

    if (enabled)   enabled.checked       = s.isEnabled;
    if (notify)    notify.checked        = s.showNotifications;
    if (slider)    slider.value          = s.chance;
    if (value)     value.textContent     = `${s.chance}%`;
    if (ctxSlider) ctxSlider.value       = s.contextMessages;
    if (ctxValue)  ctxValue.textContent  = `${s.contextMessages}`;

    genreConfig.forEach(g => {
        const el = document.querySelector(`.arc-genre-pill[data-genre="${g.id}"]`);
        if (el) el.classList.toggle('arc-genre-active', s.selectedGenres.includes(g.id));
    });
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

                    <div class="arc-footer-hint">Triggers after bot responds · Reads your scene · Grows an arc from what is already there</div>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings').append(html);
    syncPanel();

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

    $('#arc_ext_enabled').on('change', function () {
        getSettings().isEnabled = this.checked;
        saveSettingsDebounced();
    });

    $('#arc_ext_notify').on('change', function () {
        getSettings().showNotifications = this.checked;
        saveSettingsDebounced();
    });

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

    setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);

    if (!s.isEnabled || !s.selectedGenres.length) return;

    const roll = Math.floor(Math.random() * 100) + 1;
    console.log(`[Arc Catalyst] Roll: ${roll}, Need: ≤${s.chance}`);

    if (roll <= s.chance) {
        const recentContext = getRecentContext(s.contextMessages);
        const prompt = buildDynamicArcPrompt(recentContext, s.selectedGenres);

        setExtensionPrompt(
            extensionName,
            prompt,
            extension_prompt_types.IN_CHAT,
            0
        );

        pendingNotification = s.selectedGenres;
        console.log('[Arc Catalyst] ✓ Arc prompt injected with context:', s.contextMessages, 'messages');
    } else {
        console.log('[Arc Catalyst] ✗ No arc this time');
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
