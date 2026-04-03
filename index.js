import {
  eventSource, event_types, saveSettingsDebounced,
  setExtensionPrompt, extension_prompt_types
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const extensionName = "arc_catalyst";
let pendingNotification = null;
let pendingArcMark = null;

// ─── Settings ──────────────────────────────────────────────────────────────
const defaultSettings = {
  isEnabled: true,
  chance: 12,
  useGrowingChance: true,
  growingChanceStep: 3,
  showNotifications: true,
  selectedGenres: ["fantasy", "detective"],
  contextMessages: 8,
  arcLevels: true,
  antiDuplicate: true,
  autoGenre: true,
  previewBeforeSend: false,
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

// ─── Runtime state per-chat ────────────────────────────────────────────────
const chatStates = {};

function getChatKey() {
  try {
    const ctx = SillyTavern.getContext();
    return ctx?.name2 || ctx?.characters?.[ctx?.characterId]?.name || '__default__';
  } catch (e) { return '__default__'; }
}

function getChatState(key) {
  if (!chatStates[key]) {
    chatStates[key] = {
      messagesSinceLastArc: 0,
      messageCount: 0,
      arcCount: 0,
      arcHistory: [],
      openArc: null,
      messagesSinceOpenArcStart: 0,
    };
  }
  return chatStates[key];
}

// ─── Genre config ──────────────────────────────────────────────────────────
const genreConfig = [
  {
    id: 'fantasy', label: 'Fantasy', icon: '⚔️', color: '#7c6fcd',
    hint: 'magic, ancient mysteries, prophecies, hidden bloodlines, cursed artifacts, forgotten gods',
    keywords: ['magic','spell','curse','artifact','prophecy','ancient','dragon','rune','enchant','wizard','sorcerer','ritual','blood','god','relic','fate']
  },
  {
    id: 'detective', label: 'Detective', icon: '🔍', color: '#4a90d9',
    hint: 'murder, deception, hidden motives, false alibis, evidence that points the wrong way',
    keywords: ['clue','evidence','suspect','murder','lie','alibi','secret','motive','witness','investigate','crime','truth','guilty','hidden','mystery','discover']
  },
  {
    id: 'romance', label: 'Romance', icon: '🌹', color: '#e06c8c',
    hint: 'forbidden feelings, misunderstandings, past that resurfaces, choices between duty and desire',
    keywords: ['heart','love','feel','touch','close','kiss','desire','longing','forbidden','together','promise','trust','jealous','tender','hold','eyes']
  },
  {
    id: 'horror', label: 'Horror', icon: '🕯️', color: '#d04040',
    hint: 'wrongness that builds slowly, things that should not exist, trust eroding, no safe place',
    keywords: ['fear','dark','shadow','wrong','scream','blood','dead','nightmare','horror','strange','monster','terror','flee','danger','pale','cold']
  },
  {
    id: 'scifi', label: 'Sci-Fi', icon: '🚀', color: '#3ab8b8',
    hint: 'technology with hidden cost, signals from impossible sources, identity and consciousness, systems failing',
    keywords: ['system','signal','code','data','machine','artificial','network','scan','anomaly','program','fail','robot','upload','consciousness','clone','protocol']
  },
  {
    id: 'political', label: 'Political', icon: '👁️', color: '#b8860b',
    hint: 'power plays, shifting alliances, information as weapon, someone using the characters as pawns',
    keywords: ['power','alliance','betray','pawn','influence','control','faction','war','rule','crown','order','spy','agent','coup','throne','scheme']
  },
  {
    id: 'personal', label: 'Personal', icon: '🪞', color: '#a0785a',
    hint: 'someone from the past, a secret about one of the characters, a debt or promise coming due',
    keywords: ['past','memory','secret','debt','promise','truth','family','mistake','regret','real','name','before','once','knew','owe','reveal']
  },
];

// ─── Arc level configs ─────────────────────────────────────────────────────
const arcLevelConfig = [
  {
    level: 0, name: 'Seed', icon: '🌱', label: 'Зерно',
    nextAfterMessages: 8,
    buildPrompt: (ctx, gb) => `[OOC — STORY ARC CATALYST: SEED]
${ctx}Introduce the quiet beginning of a multi-session story arc. Read the scene above and grow something from what is already there — a tension, a relationship, an unresolved thing. Do not invent it from nothing; find the crack that is already present and widen it slightly.

Genre tones to draw from:
${gb}

Rules:
- This is NOT a sudden event, fight, or twist. It is a seed — something small that carries weight.
- It must raise at least two questions the characters cannot yet answer.
- Do NOT resolve it or explain what it means. Leave it open.
- It should feel as if it was always there, just now visible.
- Weave it into the scene naturally — do not announce that something is beginning.
- No forced action. The hook should make the player want to pull the thread, not push them into a scene.
[/OOC]`
  },
  {
    level: 1, name: 'Escalation', icon: '🔥', label: 'Эскалация',
    nextAfterMessages: 12,
    buildPrompt: (ctx, gb) => `[OOC — STORY ARC CATALYST: ESCALATION]
${ctx}The story arc seeded earlier is now unfolding. Push it forward. The tension should become undeniable. A choice is forming, a conflict sharpens, a relationship reaches a breaking point.

Genre tones to draw from:
${gb}

Rules:
- The arc is already running — escalate it, don't restart it.
- Force a moment that cannot be ignored or walked away from.
- At least one character must feel the pressure of what is developing.
- Raise the stakes without resolving them. The climax is not yet here.
- Do not narrate "arc is escalating" — show it through action, dialogue, or environment.
[/OOC]`
  },
  {
    level: 2, name: 'Climax', icon: '💥', label: 'Кульминация',
    nextAfterMessages: null,
    buildPrompt: (ctx, gb) => `[OOC — STORY ARC CATALYST: CLIMAX]
${ctx}This is the moment. The arc that has been building reaches its peak. Everything seeded and escalated comes together in a single moment that demands resolution.

Genre tones to draw from:
${gb}

Rules:
- This is the emotional and narrative peak of this arc — make it land.
- Something must change permanently: a truth revealed, a bond broken or formed, an impossible choice made.
- The moment should feel inevitable — as if it was always going to end this way.
- Do not hold back. This is the explosion.
- After this moment, the arc is complete. Leave the characters changed.
[/OOC]`
  },
];

// ─── Build prompt ──────────────────────────────────────────────────────────
function buildPrompt(level, recentContext, genres) {
  const selectedGenres = genres.map(id => genreConfig.find(g => g.id === id)).filter(Boolean);
  const genreBlock = selectedGenres.map(g => `- ${g.icon} ${g.label}: ${g.hint}`).join('\n');
  const contextBlock = recentContext.trim()
    ? `Here is what has been happening in the current scene:\n---\n${recentContext}\n---\n\n`
    : '';
  const cfg = arcLevelConfig[level] || arcLevelConfig[0];
  return cfg.buildPrompt(contextBlock, genreBlock);
}

// ─── Recent context ────────────────────────────────────────────────────────
function getRecentContext(maxMessages) {
  try {
    const ctx = SillyTavern.getContext();
    if (!ctx?.chat?.length) return '';
    const messages = ctx.chat.filter(m => !m.is_system).slice(-maxMessages);
    return messages.map(m => {
      const speaker = m.is_user ? (ctx.name1 || 'Player') : (ctx.name2 || 'Character');
      const text = (m.mes || '').replace(/<[^>]*>/g, '').trim();
      return `${speaker}: ${text}`;
    }).join('\n\n');
  } catch (e) {
    console.warn('[Arc Catalyst] Could not read context:', e);
    return '';
  }
}

// ─── Anti-duplicate check ──────────────────────────────────────────────────
function isArcActiveInChat() {
  try {
    const ctx = SillyTavern.getContext();
    if (!ctx?.chat?.length) return false;
    const recent = ctx.chat.filter(m => !m.is_system).slice(-12);
    return recent.some(m => m._arc_injected === true);
  } catch (e) { return false; }
}

// ─── Auto-genre detection ──────────────────────────────────────────────────
function detectGenresFromContext(maxMessages = 10) {
  try {
    const ctx = SillyTavern.getContext();
    if (!ctx?.chat?.length) return [];
    const fullText = ctx.chat
      .filter(m => !m.is_system)
      .slice(-maxMessages)
      .map(m => (m.mes || '').toLowerCase().replace(/<[^>]*>/g, ''))
      .join(' ');
    const scores = {};
    for (const g of genreConfig) {
      scores[g.id] = (g.keywords || []).reduce((acc, kw) => {
        const matches = fullText.match(new RegExp(`\\b${kw}\\b`, 'gi'));
        return acc + (matches ? matches.length : 0);
      }, 0);
    }
    return genreConfig.filter(g => scores[g.id] >= 2)
      .sort((a, b) => scores[b.id] - scores[a.id])
      .slice(0, 3).map(g => g.id);
  } catch (e) { return []; }
}

// ─── Growing chance ────────────────────────────────────────────────────────
function getCurrentChance() {
  const s = getSettings();
  if (!s.useGrowingChance) return s.chance;
  const state = getChatState(getChatKey());
  const bonus = Math.floor(state.messagesSinceLastArc / (s.growingChanceStep || 3));
  return Math.min(s.chance + bonus, 95);
}

// ─── Inject arc ────────────────────────────────────────────────────────────
function injectArc(prompt, level, genres) {
  const key = getChatKey();
  const state = getChatState(key);
  const s = getSettings();
  const cfg = arcLevelConfig[level];

  setExtensionPrompt(extensionName, prompt, extension_prompt_types.IN_CHAT, 0);

  state.messagesSinceLastArc = 0;
  state.messagesSinceOpenArcStart = 0;
  state.arcCount++;
  state.openArc = { level, triggeredAt: state.messageCount, genres: [...genres], prompt };
  state.arcHistory.push({
    timestamp: new Date().toISOString(),
    charName: key,
    level,
    levelName: cfg.name,
    genres: [...genres],
    promptExcerpt: prompt.substring(0, 150) + '...',
  });

  pendingArcMark = { level, genres: [...genres] };

  if (s.showNotifications) showArcNotification(genres, level);
  updatePanelUI();
}

// ─── Trigger arc ───────────────────────────────────────────────────────────
function triggerArc(forceLevel = null, skipPreview = false) {
  const s = getSettings();
  const key = getChatKey();
  const state = getChatState(key);
  const genres = s.selectedGenres?.length ? s.selectedGenres : ['fantasy'];

  let level = 0;
  if (forceLevel !== null) {
    level = forceLevel;
  } else if (s.arcLevels && state.openArc !== null) {
    level = Math.min(state.openArc.level + 1, 2);
  }

  const context = getRecentContext(s.contextMessages);
  const prompt = buildPrompt(level, context, genres);

  if (!skipPreview && s.previewBeforeSend) {
    showPromptPreview(prompt, level, genres);
    return;
  }
  injectArc(prompt, level, genres);
}

// ─── Close open arc ────────────────────────────────────────────────────────
function closeOpenArc() {
  const state = getChatState(getChatKey());
  state.openArc = null;
  state.messagesSinceOpenArcStart = 0;
  updatePanelUI();
}

// ─── Mark bot message in DOM ───────────────────────────────────────────────
function markLastBotMessage(level, genres) {
  try {
    const allMessages = document.querySelectorAll('.mes[is_user="false"]');
    if (!allMessages.length) return;
    const lastMsg = allMessages[allMessages.length - 1];
    if (lastMsg.querySelector('.arc-msg-indicator')) return;
    const nameEl = lastMsg.querySelector('.name_text');
    if (!nameEl) return;
    const genre = genreConfig.find(g => g.id === genres[0]);
    const color = genre?.color || 'rgba(255,255,255,0.4)';
    const cfg = arcLevelConfig[level];
    const indicator = document.createElement('span');
    indicator.className = 'arc-msg-indicator';
    indicator.title = `Arc Catalyst: ${cfg?.label || cfg?.name} injected here`;
    indicator.textContent = '◈';
    indicator.style.color = color;
    nameEl.after(indicator);
  } catch (e) {
    console.warn('[Arc Catalyst] Could not mark message:', e);
  }
}

// ─── Notification ──────────────────────────────────────────────────────────
function showArcNotification(genres, level = 0) {
  if (pendingNotification) { pendingNotification.remove(); pendingNotification = null; }
  const cfg = arcLevelConfig[level];
  const genre = genreConfig.find(g => g.id === genres[0]);
  const accentColor = genre?.color || 'rgba(255,255,255,0.4)';
  const genreLabel = genres.map(id => {
    const g = genreConfig.find(x => x.id === id);
    return g ? `${g.icon} ${g.label}` : id;
  }).join('  ');

  const el = document.createElement('div');
  el.className = 'arc-notification';
  el.style.setProperty('--arc-accent', accentColor);
  el.innerHTML = `
    <div class="arc-notification-bar"></div>
    <div class="arc-notification-inner">
      <span class="arc-notification-icon">${cfg.icon}</span>
      <div class="arc-notification-body">
        <div class="arc-notification-level">${cfg.label}</div>
        <div class="arc-notification-label">Arc Catalyst</div>
        <div class="arc-notification-genres">${genreLabel}</div>
      </div>
      <button class="arc-notification-close" aria-label="Close">✕</button>
    </div>`;

  document.body.appendChild(el);
  pendingNotification = el;
  el.querySelector('.arc-notification-close').addEventListener('click', () => dismissNotification(el));
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('arc-notification-show')));
  setTimeout(() => dismissNotification(el), 7000);
}

function dismissNotification(el) {
  if (!el?.isConnected) return;
  el.classList.remove('arc-notification-show');
  el.classList.add('arc-notification-hide');
  setTimeout(() => el.remove(), 400);
  if (pendingNotification === el) pendingNotification = null;
}

// ─── Prompt preview ────────────────────────────────────────────────────────
function showPromptPreview(prompt, level, genres) {
  document.getElementById('arc-preview-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'arc-preview-modal';
  modal.className = 'arc-preview-modal';
  const cfg = arcLevelConfig[level];
  modal.innerHTML = `
    <div class="arc-preview-inner">
      <div class="arc-preview-header">
        <span class="arc-preview-title">Превью промпта · ${cfg.label}</span>
        <button class="arc-preview-close" aria-label="Close">✕</button>
      </div>
      <textarea class="arc-preview-textarea" spellcheck="false">${prompt}</textarea>
      <div class="arc-preview-actions">
        <button class="arc-preview-send">Отправить ▶</button>
        <button class="arc-preview-cancel">Отмена</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('.arc-preview-close').addEventListener('click', () => modal.remove());
  modal.querySelector('.arc-preview-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  modal.querySelector('.arc-preview-send').addEventListener('click', () => {
    const edited = modal.querySelector('.arc-preview-textarea').value;
    modal.remove();
    injectArc(edited, level, genres);
  });
  requestAnimationFrame(() => modal.classList.add('arc-preview-show'));
}

// ─── Export history ────────────────────────────────────────────────────────
function exportArcHistory() {
  const key = getChatKey();
  const state = getChatState(key);
  if (!state.arcHistory.length) {
    alert('Нет истории арок для этого персонажа.');
    return;
  }
  let text = `═══ ARC CATALYST — Дневник кампании ═══\n`;
  text += `Персонаж: ${key}\n`;
  text += `Всего арок: ${state.arcHistory.length}\nЭкспортировано: ${new Date().toLocaleString()}\n\n`;
  state.arcHistory.forEach((arc, i) => {
    text += `──────────────────────────────\n`;
    text += `Арка #${i + 1} · ${arc.levelName} (Уровень ${arc.level})\n`;
    text += `Время: ${new Date(arc.timestamp).toLocaleString()}\n`;
    text += `Жанры: ${arc.genres.join(', ')}\n`;
    text += `Промпт (превью): ${arc.promptExcerpt}\n\n`;
  });
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `arc-catalyst-${key}-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Auto-genre UI update ──────────────────────────────────────────────────
function runAutoGenreDetection() {
  const suggested = detectGenresFromContext();
  const hint = document.getElementById('arc-auto-genre-hint');
  document.querySelectorAll('.arc-genre-pill').forEach(pill => {
    const id = pill.dataset.genre;
    pill.classList.toggle('arc-genre-suggested', suggested.includes(id));
  });
  if (hint) {
    hint.textContent = suggested.length
      ? `✦ Авто-жанр: ${suggested.map(id => genreConfig.find(g => g.id === id)?.icon || id).join(' ')} подходят под тон чата`
      : '';
  }
}

// ─── Update panel UI ───────────────────────────────────────────────────────
function updatePanelUI() {
  const key = getChatKey();
  const state = getChatState(key);
  const s = getSettings();

  const chanceEl = document.getElementById('arc-current-chance');
  if (chanceEl) chanceEl.textContent = getCurrentChance() + '%';

  const trackerEl = document.getElementById('arc-session-tracker');
  if (trackerEl) trackerEl.textContent = `${key} · Сообщений: ${state.messageCount} · Арок: ${state.arcCount}`;

  const arcStatusEl = document.getElementById('arc-open-status');
  if (arcStatusEl) {
    if (state.openArc !== null) {
      const cfg = arcLevelConfig[state.openArc.level];
      arcStatusEl.innerHTML = `<span class="arc-open-badge">${cfg.icon} ${cfg.label} активна</span>
        <button class="arc-close-btn" id="arc-close-arc-btn">Закрыть арку ✓</button>`;
      document.getElementById('arc-close-arc-btn')?.addEventListener('click', closeOpenArc);
    } else {
      arcStatusEl.innerHTML = `<span class="arc-no-arc">Нет активной арки</span>`;
    }
  }

  const sliderLabel = document.getElementById('arc-chance-label');
  if (sliderLabel) {
    sliderLabel.textContent = s.useGrowingChance
      ? `Базовый шанс: ${s.chance}% (+1% каждые ${s.growingChanceStep} сообщений)`
      : `Фиксированный шанс: ${s.chance}%`;
  }

  if (s.autoGenre) runAutoGenreDetection();
}

// ─── Main event handler ────────────────────────────────────────────────────
function onMessageReceived() {
  const s = getSettings();
  if (!s.isEnabled) return;

  const key = getChatKey();
  const state = getChatState(key);
  state.messageCount++;
  state.messagesSinceLastArc++;
  if (state.openArc !== null) state.messagesSinceOpenArcStart++;

  // Clear previous arc prompt
  setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);

  // Mark last bot message if arc was pending
  if (pendingArcMark) {
    const mark = pendingArcMark;
    pendingArcMark = null;
    setTimeout(() => markLastBotMessage(mark.level, mark.genres), 600);
  }

  // Check arc escalation if arc is open
  if (s.arcLevels && state.openArc !== null) {
    const cfg = arcLevelConfig[state.openArc.level];
    if (cfg.nextAfterMessages && state.messagesSinceOpenArcStart >= cfg.nextAfterMessages) {
      if (Math.random() * 100 < 40) {
        triggerArc(null, false);
        updatePanelUI();
        return;
      }
    }
    // If at climax, wait for manual close
    if (state.openArc.level >= 2) {
      updatePanelUI();
      return;
    }
    // Anti-duplicate: arc already open, don't start new one
    if (s.antiDuplicate) {
      updatePanelUI();
      return;
    }
  }

  // Roll for new arc
  const currentChance = getCurrentChance();
  if (Math.random() * 100 < currentChance) {
    triggerArc(0, false);
  }

  updatePanelUI();
}

// ─── Hotkey Ctrl+Shift+A ───────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'A') {
    e.preventDefault();
    if (!getSettings().isEnabled) return;
    triggerArc(null, true);
    const flash = document.createElement('div');
    flash.className = 'arc-hotkey-flash';
    flash.textContent = '⌨️ Arc triggered · Ctrl+Shift+A';
    document.body.appendChild(flash);
    requestAnimationFrame(() => flash.classList.add('arc-hotkey-flash-show'));
    setTimeout(() => {
      flash.classList.remove('arc-hotkey-flash-show');
      setTimeout(() => flash.remove(), 300);
    }, 2000);
  }
});

// ─── Settings HTML ─────────────────────────────────────────────────────────
function buildSettingsHTML() {
  return `
<div class="arc-section">
  <span class="arc-section-label">Жанры</span>
  <div class="arc-genre-grid" id="arc-genre-grid">
    ${genreConfig.map(g => `
      <button class="arc-genre-pill" data-genre="${g.id}" style="--genre-color:${g.color}">
        <span>${g.icon}</span><span>${g.label}</span>
      </button>`).join('')}
  </div>
  <div class="arc-genre-hint" id="arc-auto-genre-hint"></div>
</div>

<div class="arc-section">
  <span class="arc-section-label">Шанс арки</span>
  <div class="arc-slider-row">
    <input type="range" class="arc-slider" id="arc-chance-slider" min="1" max="50" step="1">
    <span class="arc-value-badge" id="arc-chance-badge">12%</span>
  </div>
  <div class="arc-ctx-label" id="arc-chance-label">Базовый шанс</div>
  <div class="arc-slider-row" style="margin-top:6px">
    <label class="arc-toggle-label" style="flex:1">
      <input type="checkbox" id="arc-growing-chance-toggle">
      <span class="arc-toggle-text">Нарастающий шанс</span>
    </label>
    <span class="arc-value-badge" id="arc-current-chance" title="Текущий шанс с учётом нарастания">—</span>
  </div>
  <div class="arc-slider-row" id="arc-growing-step-row" style="display:none">
    <span class="arc-ctx-label">+1% каждые</span>
    <input type="range" class="arc-slider" id="arc-step-slider" min="1" max="10" step="1">
    <span class="arc-value-badge" id="arc-step-badge">3</span>
    <span class="arc-ctx-label">сообщений</span>
  </div>
</div>

<div class="arc-section">
  <span class="arc-section-label">Контекст</span>
  <div class="arc-slider-row">
    <input type="range" class="arc-slider" id="arc-ctx-slider" min="4" max="30" step="2">
    <span class="arc-value-badge" id="arc-ctx-badge">8</span>
  </div>
  <div class="arc-ctx-label">последних сообщений читает Arc Catalyst</div>
</div>

<div class="arc-section arc-toggles">
  <span class="arc-section-label">Опции</span>
  <label class="arc-toggle-label">
    <input type="checkbox" id="arc-notifications-toggle">
    <span class="arc-toggle-text">Показывать уведомления</span>
  </label>
  <label class="arc-toggle-label">
    <input type="checkbox" id="arc-levels-toggle">
    <span class="arc-toggle-text">Три уровня арки (Зерно → Эскалация → Кульминация)</span>
  </label>
  <label class="arc-toggle-label">
    <input type="checkbox" id="arc-antidupe-toggle">
    <span class="arc-toggle-text">Анти-дубль — пропустить если арка уже идёт</span>
  </label>
  <label class="arc-toggle-label">
    <input type="checkbox" id="arc-autogenre-toggle">
    <span class="arc-toggle-text">Авто-жанр — подсвечивать жанры по тексту чата</span>
  </label>
  <label class="arc-toggle-label">
    <input type="checkbox" id="arc-preview-toggle">
    <span class="arc-toggle-text">Превью промпта перед отправкой</span>
  </label>
</div>

<div class="arc-section">
  <span class="arc-section-label">Статус арки</span>
  <div id="arc-open-status" class="arc-open-status">
    <span class="arc-no-arc">Нет активной арки</span>
  </div>
  <div id="arc-session-tracker" class="arc-session-tracker">Сообщений: 0 · Арок: 0</div>
</div>

<div class="arc-section">
  <span class="arc-section-label">Действия</span>
  <div class="arc-actions-row">
    <button class="arc-action-btn" id="arc-manual-trigger-btn">▶ Запустить арку</button>
    <button class="arc-action-btn arc-secondary" id="arc-preview-btn">👁 Превью промпта</button>
    <button class="arc-action-btn arc-secondary" id="arc-export-btn">📄 Экспорт дневника</button>
  </div>
</div>

<div class="arc-footer-hint">Ctrl+Shift+A — быстрый запуск · ◈ отмечает сообщения с инжектом</div>`;
}

// ─── Init UI ───────────────────────────────────────────────────────────────
function initUI() {
  const s = getSettings();

  // Genre pills
  const genreGrid = document.getElementById('arc-genre-grid');
  if (genreGrid) {
    genreGrid.querySelectorAll('.arc-genre-pill').forEach(pill => {
      if (s.selectedGenres.includes(pill.dataset.genre)) pill.classList.add('arc-genre-active');
      pill.addEventListener('click', () => {
        pill.classList.toggle('arc-genre-active');
        s.selectedGenres = [...genreGrid.querySelectorAll('.arc-genre-pill.arc-genre-active')].map(p => p.dataset.genre);
        saveSettingsDebounced();
      });
    });
  }

  // Chance slider
  const chanceSlider = document.getElementById('arc-chance-slider');
  const chanceBadge = document.getElementById('arc-chance-badge');
  if (chanceSlider) {
    chanceSlider.value = s.chance;
    chanceBadge.textContent = s.chance + '%';
    chanceSlider.addEventListener('input', () => {
      s.chance = parseInt(chanceSlider.value);
      chanceBadge.textContent = s.chance + '%';
      updatePanelUI();
      saveSettingsDebounced();
    });
  }

  // Growing chance toggle
  const growingToggle = document.getElementById('arc-growing-chance-toggle');
  const growingStepRow = document.getElementById('arc-growing-step-row');
  if (growingToggle) {
    growingToggle.checked = s.useGrowingChance;
    growingStepRow.style.display = s.useGrowingChance ? 'flex' : 'none';
    growingToggle.addEventListener('change', () => {
      s.useGrowingChance = growingToggle.checked;
      growingStepRow.style.display = s.useGrowingChance ? 'flex' : 'none';
      updatePanelUI();
      saveSettingsDebounced();
    });
  }

  // Step slider
  const stepSlider = document.getElementById('arc-step-slider');
  const stepBadge = document.getElementById('arc-step-badge');
  if (stepSlider) {
    stepSlider.value = s.growingChanceStep;
    stepBadge.textContent = s.growingChanceStep;
    stepSlider.addEventListener('input', () => {
      s.growingChanceStep = parseInt(stepSlider.value);
      stepBadge.textContent = s.growingChanceStep;
      updatePanelUI();
      saveSettingsDebounced();
    });
  }

  // Context slider
  const ctxSlider = document.getElementById('arc-ctx-slider');
  const ctxBadge = document.getElementById('arc-ctx-badge');
  if (ctxSlider) {
    ctxSlider.value = s.contextMessages;
    ctxBadge.textContent = s.contextMessages;
    ctxSlider.addEventListener('input', () => {
      s.contextMessages = parseInt(ctxSlider.value);
      ctxBadge.textContent = s.contextMessages;
      saveSettingsDebounced();
    });
  }

  // Checkboxes
  const toggleMap = {
    'arc-notifications-toggle': 'showNotifications',
    'arc-levels-toggle': 'arcLevels',
    'arc-antidupe-toggle': 'antiDuplicate',
    'arc-autogenre-toggle': 'autoGenre',
    'arc-preview-toggle': 'previewBeforeSend',
  };
  for (const [id, key] of Object.entries(toggleMap)) {
    const el = document.getElementById(id);
    if (el) {
      el.checked = s[key];
      el.addEventListener('change', () => { s[key] = el.checked; saveSettingsDebounced(); updatePanelUI(); });
    }
  }

  // Action buttons
  document.getElementById('arc-manual-trigger-btn')?.addEventListener('click', () => triggerArc(null, false));

  document.getElementById('arc-preview-btn')?.addEventListener('click', () => {
    const genres = s.selectedGenres?.length ? s.selectedGenres : ['fantasy'];
    const state = getChatState(getChatKey());
    let level = 0;
    if (s.arcLevels && state.openArc !== null) level = Math.min(state.openArc.level + 1, 2);
    const prompt = buildPrompt(level, getRecentContext(s.contextMessages), genres);
    showPromptPreview(prompt, level, genres);
  });

  document.getElementById('arc-export-btn')?.addEventListener('click', exportArcHistory);

  updatePanelUI();
}

// ─── jQuery bootstrap ──────────────────────────────────────────────────────
jQuery(async () => {
  loadSettings();

  const html = `
    <div class="arc_catalyst_settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>◈ Arc Catalyst</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          ${buildSettingsHTML()}
        </div>
      </div>
    </div>`;

  $('#extensions_settings').append(html);
  initUI();

  eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
  eventSource.on(event_types.CHAT_CHANGED, () => {
    updatePanelUI();
    if (getSettings().autoGenre) setTimeout(runAutoGenreDetection, 500);
  });
});
