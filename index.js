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
function getSettings() { return extension_settings[extensionName]; }

// ─── Runtime state ─────────────────────────────────────────────────────────
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
  { id: 'fantasy',   label: 'Fantasy',   icon: '⚔️',  color: '#7c6fcd',
    hint: 'magic, ancient mysteries, prophecies, hidden bloodlines, cursed artifacts, forgotten gods',
    keywords: ['magic','spell','curse','artifact','prophecy','ancient','dragon','rune','enchant','wizard','sorcerer','ritual','blood','god','relic','fate'] },
  { id: 'detective', label: 'Detective', icon: '🔍',  color: '#4a90d9',
    hint: 'murder, deception, hidden motives, false alibis, evidence that points the wrong way',
    keywords: ['clue','evidence','suspect','murder','lie','alibi','secret','motive','witness','investigate','crime','truth','guilty','hidden','mystery','discover'] },
  { id: 'romance',   label: 'Romance',   icon: '🌹',  color: '#e06c8c',
    hint: 'forbidden feelings, misunderstandings, past that resurfaces, choices between duty and desire',
    keywords: ['heart','love','feel','touch','close','kiss','desire','longing','forbidden','together','promise','trust','jealous','tender','hold','eyes'] },
  { id: 'horror',    label: 'Horror',    icon: '🕯️', color: '#d04040',
    hint: 'wrongness that builds slowly, things that should not exist, trust eroding, no safe place',
    keywords: ['fear','dark','shadow','wrong','scream','blood','dead','nightmare','horror','strange','monster','terror','flee','danger','pale','cold'] },
  { id: 'scifi',     label: 'Sci-Fi',    icon: '🚀',  color: '#3ab8b8',
    hint: 'technology with hidden cost, signals from impossible sources, identity and consciousness, systems failing',
    keywords: ['system','signal','code','data','machine','artificial','network','scan','anomaly','program','fail','robot','upload','consciousness','clone','protocol'] },
  { id: 'political', label: 'Political', icon: '👁️', color: '#c49a2a',
    hint: 'power plays, shifting alliances, information as weapon, someone using the characters as pawns',
    keywords: ['power','alliance','betray','pawn','influence','control','faction','war','rule','crown','order','spy','agent','coup','throne','scheme'] },
  { id: 'personal',  label: 'Personal',  icon: '🪞',  color: '#a0785a',
    hint: 'someone from the past, a secret about one of the characters, a debt or promise coming due',
    keywords: ['past','memory','secret','debt','promise','truth','family','mistake','regret','real','name','before','once','knew','owe','reveal'] },
];

// ─── Arc levels ────────────────────────────────────────────────────────────
const arcLevelConfig = [
  {
    level: 0, name: 'Seed', icon: '🌱', label: 'Зерно', nextAfterMessages: 8,
    buildPrompt: (ctx, gb) => `[OOC — STORY ARC CATALYST: SEED]\n${ctx}Introduce the quiet beginning of a multi-session story arc. Read the scene above and grow something from what is already there — a tension, a relationship, an unresolved thing. Do not invent it from nothing; find the crack that is already present and widen it slightly.\n\nGenre tones to draw from:\n${gb}\n\nRules:\n- This is NOT a sudden event, fight, or twist. It is a seed — something small that carries weight.\n- It must raise at least two questions the characters cannot yet answer.\n- Do NOT resolve it or explain what it means. Leave it open.\n- It should feel as if it was always there, just now visible.\n- Weave it into the scene naturally — do not announce that something is beginning.\n- No forced action. The hook should make the player want to pull the thread, not push them into a scene.\n[/OOC]`
  },
  {
    level: 1, name: 'Escalation', icon: '🔥', label: 'Эскалация', nextAfterMessages: 12,
    buildPrompt: (ctx, gb) => `[OOC — STORY ARC CATALYST: ESCALATION]\n${ctx}The story arc seeded earlier is now unfolding. Push it forward. The tension should become undeniable. A choice is forming, a conflict sharpens, a relationship reaches a breaking point.\n\nGenre tones to draw from:\n${gb}\n\nRules:\n- The arc is already running — escalate it, don't restart it.\n- Force a moment that cannot be ignored or walked away from.\n- At least one character must feel the pressure of what is developing.\n- Raise the stakes without resolving them. The climax is not yet here.\n- Do not narrate "arc is escalating" — show it through action, dialogue, or environment.\n[/OOC]`
  },
  {
    level: 2, name: 'Climax', icon: '💥', label: 'Кульминация', nextAfterMessages: null,
    buildPrompt: (ctx, gb) => `[OOC — STORY ARC CATALYST: CLIMAX]\n${ctx}This is the moment. The arc that has been building reaches its peak. Everything seeded and escalated comes together in a single moment that demands resolution.\n\nGenre tones to draw from:\n${gb}\n\nRules:\n- This is the emotional and narrative peak of this arc — make it land.\n- Something must change permanently: a truth revealed, a bond broken or formed, an impossible choice made.\n- The moment should feel inevitable — as if it was always going to end this way.\n- Do not hold back. This is the explosion.\n- After this moment, the arc is complete. Leave the characters changed.\n[/OOC]`
  },
];

// ─── Core functions ────────────────────────────────────────────────────────
function buildPrompt(level, recentContext, genres) {
  const sel = genres.map(id => genreConfig.find(g => g.id === id)).filter(Boolean);
  const gb = sel.map(g => `- ${g.icon} ${g.label}: ${g.hint}`).join('\n');
  const cb = recentContext.trim() ? `Here is what has been happening in the current scene:\n---\n${recentContext}\n---\n\n` : '';
  return (arcLevelConfig[level] || arcLevelConfig[0]).buildPrompt(cb, gb);
}

function getRecentContext(maxMessages) {
  try {
    const ctx = SillyTavern.getContext();
    if (!ctx?.chat?.length) return '';
    return ctx.chat.filter(m => !m.is_system).slice(-maxMessages).map(m => {
      const spk = m.is_user ? (ctx.name1 || 'Player') : (ctx.name2 || 'Character');
      return `${spk}: ${(m.mes || '').replace(/<[^>]*>/g, '').trim()}`;
    }).join('\n\n');
  } catch (e) { return ''; }
}

function getCurrentChance() {
  const s = getSettings();
  if (!s.useGrowingChance) return s.chance;
  const state = getChatState(getChatKey());
  return Math.min(s.chance + Math.floor(state.messagesSinceLastArc / (s.growingChanceStep || 3)), 95);
}

function detectGenresFromContext(maxMessages = 10) {
  try {
    const ctx = SillyTavern.getContext();
    if (!ctx?.chat?.length) return [];
    const txt = ctx.chat.filter(m => !m.is_system).slice(-maxMessages)
      .map(m => (m.mes || '').toLowerCase().replace(/<[^>]*>/g, '')).join(' ');
    const scores = {};
    for (const g of genreConfig) {
      scores[g.id] = (g.keywords || []).reduce((acc, kw) => {
        const m = txt.match(new RegExp(`\\b${kw}\\b`, 'gi'));
        return acc + (m ? m.length : 0);
      }, 0);
    }
    return genreConfig.filter(g => scores[g.id] >= 2)
      .sort((a, b) => scores[b.id] - scores[a.id]).slice(0, 3).map(g => g.id);
  } catch (e) { return []; }
}

// ─── Arc actions ───────────────────────────────────────────────────────────
function injectArc(prompt, level, genres) {
  const key = getChatKey();
  const state = getChatState(key);
  const cfg = arcLevelConfig[level];
  setExtensionPrompt(extensionName, prompt, extension_prompt_types.IN_CHAT, 0);
  state.messagesSinceLastArc = 0;
  state.messagesSinceOpenArcStart = 0;
  state.arcCount++;
  state.openArc = { level, triggeredAt: state.messageCount, genres: [...genres], prompt };
  state.arcHistory.push({
    timestamp: new Date().toISOString(), charName: key,
    level, levelName: cfg.name, genres: [...genres],
    promptExcerpt: prompt.substring(0, 150) + '...',
  });
  pendingArcMark = { level, genres: [...genres] };
  if (getSettings().showNotifications) showArcNotification(genres, level);
  updatePanelUI();
}

function triggerArc(forceLevel = null, skipPreview = false) {
  const s = getSettings();
  const state = getChatState(getChatKey());
  const genres = s.selectedGenres?.length ? s.selectedGenres : ['fantasy'];
  let level = 0;
  if (forceLevel !== null) level = forceLevel;
  else if (s.arcLevels && state.openArc !== null) level = Math.min(state.openArc.level + 1, 2);
  const prompt = buildPrompt(level, getRecentContext(s.contextMessages), genres);
  if (!skipPreview && s.previewBeforeSend) { showPromptPreview(prompt, level, genres); return; }
  injectArc(prompt, level, genres);
}

function closeOpenArc() {
  const state = getChatState(getChatKey());
  state.openArc = null;
  state.messagesSinceOpenArcStart = 0;
  updatePanelUI();
}

// ─── DOM helpers ───────────────────────────────────────────────────────────
function markLastBotMessage(level, genres) {
  try {
    const all = document.querySelectorAll('.mes[is_user="false"]');
    if (!all.length) return;
    const last = all[all.length - 1];
    if (last.querySelector('.arc-msg-indicator')) return;
    const nameEl = last.querySelector('.name_text');
    if (!nameEl) return;
    const genre = genreConfig.find(g => g.id === genres[0]);
    const ind = document.createElement('span');
    ind.className = 'arc-msg-indicator';
    ind.title = `Arc Catalyst · ${arcLevelConfig[level]?.label} injected`;
    ind.textContent = '◈';
    ind.style.color = genre?.color || 'rgba(255,255,255,0.4)';
    nameEl.after(ind);
  } catch (e) { console.warn('[Arc Catalyst]', e); }
}

// ─── Notification ──────────────────────────────────────────────────────────
function showArcNotification(genres, level = 0) {
  if (pendingNotification) { pendingNotification.remove(); pendingNotification = null; }
  const cfg = arcLevelConfig[level];
  const genre = genreConfig.find(g => g.id === genres[0]);
  const accent = genre?.color || 'rgba(255,255,255,0.5)';
  const genreLabel = genres.map(id => {
    const g = genreConfig.find(x => x.id === id);
    return g ? `${g.icon} ${g.label}` : id;
  }).join('  ');

  const el = document.createElement('div');
  el.className = 'arc-notification';
  el.style.setProperty('--arc-accent', accent);
  el.innerHTML = `
    <div class="arc-notif-glow"></div>
    <div class="arc-notif-bar"></div>
    <div class="arc-notif-inner">
      <div class="arc-notif-left">
        <span class="arc-notif-lvl-icon">${cfg.icon}</span>
      </div>
      <div class="arc-notif-body">
        <div class="arc-notif-level-name">${cfg.label}</div>
        <div class="arc-notif-genres">${genreLabel}</div>
      </div>
      <button class="arc-notif-close" aria-label="Close">✕</button>
    </div>`;
  document.body.appendChild(el);
  pendingNotification = el;
  el.querySelector('.arc-notif-close').addEventListener('click', () => dismissNotification(el));
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('arc-notif-show')));
  setTimeout(() => dismissNotification(el), 7000);
}

function dismissNotification(el) {
  if (!el?.isConnected) return;
  el.classList.remove('arc-notif-show');
  el.classList.add('arc-notif-hide');
  setTimeout(() => el.remove(), 400);
  if (pendingNotification === el) pendingNotification = null;
}

// ─── Prompt preview ────────────────────────────────────────────────────────
function showPromptPreview(prompt, level, genres) {
  document.getElementById('arc-preview-modal')?.remove();
  const cfg = arcLevelConfig[level];
  const modal = document.createElement('div');
  modal.id = 'arc-preview-modal';
  modal.className = 'arc-preview-modal';
  modal.innerHTML = `
    <div class="arc-preview-inner">
      <div class="arc-preview-header">
        <div class="arc-preview-header-left">
          <span class="arc-preview-icon">${cfg.icon}</span>
          <span class="arc-preview-title">Промпт · ${cfg.label}</span>
        </div>
        <button class="arc-preview-close">✕</button>
      </div>
      <div class="arc-preview-hint">Можно отредактировать перед отправкой</div>
      <textarea class="arc-preview-textarea" spellcheck="false">${prompt}</textarea>
      <div class="arc-preview-actions">
        <button class="arc-preview-cancel">Отмена</button>
        <button class="arc-preview-send">${cfg.icon} Отправить</button>
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
  if (!state.arcHistory.length) { alert('Нет истории арок для этого персонажа.'); return; }
  let text = `═══════════════════════════════════════\n   ARC CATALYST — Дневник кампании\n═══════════════════════════════════════\n\n`;
  text += `Персонаж : ${key}\nВсего арок: ${state.arcHistory.length}\nЭкспорт  : ${new Date().toLocaleString()}\n\n`;
  state.arcHistory.forEach((arc, i) => {
    text += `───────────────────────────────────────\nАрка #${i + 1}  ${arc.levelName} (ур. ${arc.level})  ${arc.icon || ''}\n`;
    text += `Время  : ${new Date(arc.timestamp).toLocaleString()}\nЖанры  : ${arc.genres.join(', ')}\nПревью : ${arc.promptExcerpt}\n\n`;
  });
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `arc-${key}-${Date.now()}.txt`; a.click();
  URL.revokeObjectURL(url);
}

// ─── Panel UI update ───────────────────────────────────────────────────────
function updatePanelUI() {
  const key = getChatKey();
  const state = getChatState(key);
  const s = getSettings();
  const chance = getCurrentChance();

  // ── Chance ring ──
  const ring = document.getElementById('arc-chance-ring-val');
  if (ring) {
    const r = 20, circ = 2 * Math.PI * r;
    const pct = Math.min(chance, 100) / 100;
    ring.style.strokeDashoffset = circ * (1 - pct);
    ring.style.stroke = chance >= 50 ? '#e06c8c' : chance >= 25 ? '#c49a2a' : '#4a90d9';
  }
  const chanceNum = document.getElementById('arc-chance-num');
  if (chanceNum) chanceNum.textContent = chance + '%';

  // ── Chance label ──
  const chanceLabel = document.getElementById('arc-chance-subtext');
  if (chanceLabel) {
    chanceLabel.textContent = s.useGrowingChance
      ? `+1% каждые ${s.growingChanceStep} сообщений`
      : 'фиксированный';
  }

  // ── Session tracker ──
  const tracker = document.getElementById('arc-session-tracker');
  if (tracker) tracker.textContent = `${state.messageCount} сообщ · ${state.arcCount} арок`;

  // ── Arc level progress ──
  const prog = document.getElementById('arc-level-progress');
  if (prog) {
    const lvl = state.openArc?.level ?? -1;
    prog.querySelectorAll('.arc-lvl-node').forEach(node => {
      const nl = parseInt(node.dataset.level);
      node.classList.toggle('arc-lvl-done', nl < lvl);
      node.classList.toggle('arc-lvl-active', nl === lvl);
      node.classList.toggle('arc-lvl-pending', nl > lvl);
    });
    prog.querySelectorAll('.arc-lvl-line').forEach(line => {
      const ll = parseInt(line.dataset.after);
      line.classList.toggle('arc-lvl-line-done', ll < lvl);
    });
  }

  // ── Status card ──
  const card = document.getElementById('arc-status-card');
  if (card) {
    if (state.openArc !== null) {
      const cfg = arcLevelConfig[state.openArc.level];
      const g = genreConfig.find(x => x.id === state.openArc.genres[0]);
      card.style.setProperty('--arc-card-accent', g?.color || 'rgba(255,255,255,0.3)');
      card.classList.add('arc-status-card-active');
      const inner = card.querySelector('.arc-status-card-inner');
      if (inner) inner.innerHTML = `
        <span class="arc-status-card-icon">${cfg.icon}</span>
        <div class="arc-status-card-info">
          <span class="arc-status-card-name">${cfg.label}</span>
          <span class="arc-status-card-genres">${state.openArc.genres.map(id => {
            const gx = genreConfig.find(x => x.id === id); return gx ? `${gx.icon}${gx.label}` : id;
          }).join(' · ')}</span>
        </div>
        <button class="arc-status-close-btn" id="arc-close-arc-btn" title="Закрыть арку">✓ Закрыть</button>`;
      document.getElementById('arc-close-arc-btn')?.addEventListener('click', closeOpenArc);
    } else {
      card.classList.remove('arc-status-card-active');
      const inner = card.querySelector('.arc-status-card-inner');
      if (inner) inner.innerHTML = `<span class="arc-status-idle">◌ нет активной арки</span>`;
    }
  }

  // ── Header status dot ──
  const dot = document.getElementById('arc-header-dot');
  if (dot) {
    dot.className = 'arc-header-dot ' + (state.openArc !== null ? 'arc-dot-active' : 'arc-dot-idle');
    const g = state.openArc ? genreConfig.find(x => x.id === state.openArc.genres[0]) : null;
    dot.style.background = g?.color || '';
  }

  // ── Auto-genre hints ──
  if (s.autoGenre) {
    const suggested = detectGenresFromContext();
    document.querySelectorAll('.arc-genre-pill').forEach(pill => {
      pill.classList.toggle('arc-genre-suggested', suggested.includes(pill.dataset.genre));
    });
    const hint = document.getElementById('arc-auto-genre-hint');
    if (hint) hint.textContent = suggested.length
      ? `✦ подходят: ${suggested.map(id => genreConfig.find(g => g.id === id)?.icon || '').join(' ')}`
      : '';
  }
}

// ─── Main event ────────────────────────────────────────────────────────────
function onMessageReceived() {
  const s = getSettings();
  if (!s.isEnabled) return;
  const key = getChatKey();
  const state = getChatState(key);
  state.messageCount++;
  state.messagesSinceLastArc++;
  if (state.openArc !== null) state.messagesSinceOpenArcStart++;

  setExtensionPrompt(extensionName, '', extension_prompt_types.IN_CHAT, 0);

  if (pendingArcMark) {
    const m = pendingArcMark; pendingArcMark = null;
    setTimeout(() => markLastBotMessage(m.level, m.genres), 600);
  }

  if (s.arcLevels && state.openArc !== null) {
    const cfg = arcLevelConfig[state.openArc.level];
    if (cfg.nextAfterMessages && state.messagesSinceOpenArcStart >= cfg.nextAfterMessages) {
      if (Math.random() * 100 < 40) { triggerArc(null, false); updatePanelUI(); return; }
    }
    if (state.openArc.level >= 2) { updatePanelUI(); return; }
    if (s.antiDuplicate) { updatePanelUI(); return; }
  }

  if (Math.random() * 100 < getCurrentChance()) triggerArc(0, false);
  updatePanelUI();
}

// ─── Hotkey ────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key === 'A') {
    e.preventDefault();
    if (!getSettings().isEnabled) return;
    triggerArc(null, true);
    const f = document.createElement('div');
    f.className = 'arc-hotkey-flash';
    f.textContent = '⌨️ Arc Catalyst · Ctrl+Shift+A';
    document.body.appendChild(f);
    requestAnimationFrame(() => f.classList.add('arc-hotkey-show'));
    setTimeout(() => { f.classList.remove('arc-hotkey-show'); setTimeout(() => f.remove(), 300); }, 2200);
  }
});

// ─── Settings HTML ─────────────────────────────────────────────────────────
function buildSettingsHTML() {
  const levelNodes = arcLevelConfig.map((cfg, i) => `
    <div class="arc-lvl-node arc-lvl-pending" data-level="${i}" title="${cfg.label}">
      <span class="arc-lvl-node-icon">${cfg.icon}</span>
    </div>
    ${i < arcLevelConfig.length - 1 ? `<div class="arc-lvl-line" data-after="${i}"></div>` : ''}
  `).join('');

  const genrePills = genreConfig.map(g => `
    <button class="arc-genre-pill" data-genre="${g.id}" style="--genre-color:${g.color}" title="${g.hint}">
      <span class="arc-pill-icon">${g.icon}</span>
      <span class="arc-pill-label">${g.label}</span>
    </button>`).join('');

  return `
<div class="arc-panel">

  <!-- ── Header ── -->
  <div class="arc-panel-header">
    <div class="arc-panel-header-left">
      <span class="arc-header-dot arc-dot-idle" id="arc-header-dot"></span>
      <span class="arc-panel-title">Arc Catalyst</span>
    </div>
    <div class="arc-panel-header-right">
      <span class="arc-stats-chip" id="arc-session-tracker">0 сообщ · 0 арок</span>
    </div>
  </div>

  <!-- ── Arc level progress bar ── -->
  <div class="arc-level-progress" id="arc-level-progress">
    ${levelNodes}
  </div>

  <!-- ── Status card ── -->
  <div class="arc-status-card" id="arc-status-card">
    <div class="arc-status-card-inner">
      <span class="arc-status-idle">◌ нет активной арки</span>
    </div>
  </div>

  <!-- ── Quick actions ── -->
  <div class="arc-quick-bar">
    <button class="arc-btn-primary" id="arc-manual-trigger-btn">
      <span>▶</span> Запустить арку
    </button>
    <button class="arc-btn-icon" id="arc-preview-btn" title="Превью промпта">👁</button>
    <button class="arc-btn-icon" id="arc-export-btn" title="Экспорт дневника">📄</button>
  </div>

  <!-- ══ ЖАНРЫ ══ -->
  <div class="arc-sub open" id="arc-sub-genres">
    <button class="arc-sub-header" data-target="arc-sub-genres">
      <span class="arc-sub-icon">🎭</span>
      <span class="arc-sub-title">Жанры</span>
      <span class="arc-sub-hint" id="arc-auto-genre-hint"></span>
      <span class="arc-sub-chevron">›</span>
    </button>
    <div class="arc-sub-body"><div>
      <div class="arc-genre-grid" id="arc-genre-grid">
        ${genrePills}
      </div>
    </div></div>
  </div>

  <!-- ══ ВЕРОЯТНОСТЬ ══ -->
  <div class="arc-sub" id="arc-sub-chance">
    <button class="arc-sub-header" data-target="arc-sub-chance">
      <span class="arc-sub-icon">🎲</span>
      <span class="arc-sub-title">Вероятность</span>
      <span class="arc-sub-chevron">›</span>
    </button>
    <div class="arc-sub-body"><div>
      <div class="arc-chance-display">
        <svg class="arc-ring" viewBox="0 0 50 50">
          <circle class="arc-ring-bg" cx="25" cy="25" r="20"/>
          <circle class="arc-ring-val" id="arc-chance-ring-val" cx="25" cy="25" r="20"
            style="stroke-dasharray:${2 * Math.PI * 20};stroke-dashoffset:${2 * Math.PI * 20}"/>
        </svg>
        <div class="arc-chance-info">
          <span class="arc-chance-num" id="arc-chance-num">12%</span>
          <span class="arc-chance-sub" id="arc-chance-subtext">текущий шанс</span>
        </div>
      </div>
      <div class="arc-field">
        <label class="arc-field-label">Базовый шанс</label>
        <div class="arc-slider-row">
          <input type="range" class="arc-slider" id="arc-chance-slider" min="1" max="50" step="1">
          <span class="arc-badge" id="arc-chance-badge">12%</span>
        </div>
      </div>
      <div class="arc-field">
        <label class="arc-toggle-label">
          <input type="checkbox" id="arc-growing-chance-toggle">
          <span class="arc-toggle-text">Нарастающий шанс</span>
        </label>
      </div>
      <div class="arc-field arc-growing-step" id="arc-growing-step-row" style="display:none">
        <label class="arc-field-label">+1% каждые N сообщений</label>
        <div class="arc-slider-row">
          <input type="range" class="arc-slider" id="arc-step-slider" min="1" max="10" step="1">
          <span class="arc-badge" id="arc-step-badge">3</span>
        </div>
      </div>
    </div></div>
  </div>

  <!-- ══ МЕХАНИКА АРОК ══ -->
  <div class="arc-sub" id="arc-sub-mechanics">
    <button class="arc-sub-header" data-target="arc-sub-mechanics">
      <span class="arc-sub-icon">⚙️</span>
      <span class="arc-sub-title">Механика арок</span>
      <span class="arc-sub-chevron">›</span>
    </button>
    <div class="arc-sub-body"><div>
      <div class="arc-levels-cards">
        ${arcLevelConfig.map(cfg => `
          <div class="arc-level-card">
            <span class="arc-level-card-icon">${cfg.icon}</span>
            <div class="arc-level-card-info">
              <span class="arc-level-card-name">${cfg.label}</span>
              ${cfg.nextAfterMessages ? `<span class="arc-level-card-hint">~${cfg.nextAfterMessages} сообщений до следующего</span>` : '<span class="arc-level-card-hint">финал арки</span>'}
            </div>
          </div>`).join('')}
      </div>
      <div class="arc-field" style="margin-top:8px">
        <label class="arc-toggle-label">
          <input type="checkbox" id="arc-levels-toggle">
          <span class="arc-toggle-text">Три уровня арки</span>
        </label>
      </div>
      <div class="arc-field">
        <label class="arc-toggle-label">
          <input type="checkbox" id="arc-antidupe-toggle">
          <span class="arc-toggle-text">Анти-дубль</span>
        </label>
      </div>
    </div></div>
  </div>

  <!-- ══ УМНЫЕ ФИЧИ ══ -->
  <div class="arc-sub" id="arc-sub-smart">
    <button class="arc-sub-header" data-target="arc-sub-smart">
      <span class="arc-sub-icon">🧠</span>
      <span class="arc-sub-title">Умные фичи</span>
      <span class="arc-sub-chevron">›</span>
    </button>
    <div class="arc-sub-body"><div>
      <div class="arc-field">
        <label class="arc-field-label">Контекст для анализа</label>
        <div class="arc-slider-row">
          <input type="range" class="arc-slider" id="arc-ctx-slider" min="4" max="30" step="2">
          <span class="arc-badge" id="arc-ctx-badge">8</span>
        </div>
        <span class="arc-field-hint">последних сообщений</span>
      </div>
      <div class="arc-field">
        <label class="arc-toggle-label">
          <input type="checkbox" id="arc-autogenre-toggle">
          <span class="arc-toggle-text">Авто-жанр</span>
        </label>
        <span class="arc-field-hint">подсвечивает жанры по тону чата</span>
      </div>
      <div class="arc-field">
        <label class="arc-toggle-label">
          <input type="checkbox" id="arc-notifications-toggle">
          <span class="arc-toggle-text">Уведомления</span>
        </label>
      </div>
      <div class="arc-field">
        <label class="arc-toggle-label">
          <input type="checkbox" id="arc-preview-toggle">
          <span class="arc-toggle-text">Превью промпта перед отправкой</span>
        </label>
      </div>
    </div></div>
  </div>

  <div class="arc-panel-footer">Ctrl+Shift+A — быстрый запуск · ◈ метка в чате</div>
</div>`;
}

// ─── Init UI ───────────────────────────────────────────────────────────────
function initUI() {
  const s = getSettings();

  // Collapsible sections
  document.querySelectorAll('.arc-sub-header').forEach(btn => {
    btn.addEventListener('click', () => {
      const sub = btn.closest('.arc-sub');
      sub.classList.toggle('open');
    });
  });

  // Genre pills
  const grid = document.getElementById('arc-genre-grid');
  if (grid) {
    grid.querySelectorAll('.arc-genre-pill').forEach(pill => {
      if (s.selectedGenres.includes(pill.dataset.genre)) pill.classList.add('arc-genre-active');
      pill.addEventListener('click', () => {
        pill.classList.toggle('arc-genre-active');
        s.selectedGenres = [...grid.querySelectorAll('.arc-genre-pill.arc-genre-active')].map(p => p.dataset.genre);
        saveSettingsDebounced();
      });
    });
  }

  // Chance slider
  const cs = document.getElementById('arc-chance-slider');
  const cb = document.getElementById('arc-chance-badge');
  if (cs) {
    cs.value = s.chance; cb.textContent = s.chance + '%';
    cs.addEventListener('input', () => { s.chance = parseInt(cs.value); cb.textContent = s.chance + '%'; updatePanelUI(); saveSettingsDebounced(); });
  }

  // Growing chance
  const gt = document.getElementById('arc-growing-chance-toggle');
  const gr = document.getElementById('arc-growing-step-row');
  if (gt) {
    gt.checked = s.useGrowingChance;
    gr.style.display = s.useGrowingChance ? 'flex' : 'none';
    gt.addEventListener('change', () => { s.useGrowingChance = gt.checked; gr.style.display = gt.checked ? 'flex' : 'none'; updatePanelUI(); saveSettingsDebounced(); });
  }

  // Step slider
  const ss = document.getElementById('arc-step-slider');
  const sb = document.getElementById('arc-step-badge');
  if (ss) {
    ss.value = s.growingChanceStep; sb.textContent = s.growingChanceStep;
    ss.addEventListener('input', () => { s.growingChanceStep = parseInt(ss.value); sb.textContent = s.growingChanceStep; updatePanelUI(); saveSettingsDebounced(); });
  }

  // Ctx slider
  const xs = document.getElementById('arc-ctx-slider');
  const xb = document.getElementById('arc-ctx-badge');
  if (xs) {
    xs.value = s.contextMessages; xb.textContent = s.contextMessages;
    xs.addEventListener('input', () => { s.contextMessages = parseInt(xs.value); xb.textContent = s.contextMessages; saveSettingsDebounced(); });
  }

  // Checkboxes
  [
    ['arc-notifications-toggle', 'showNotifications'],
    ['arc-levels-toggle', 'arcLevels'],
    ['arc-antidupe-toggle', 'antiDuplicate'],
    ['arc-autogenre-toggle', 'autoGenre'],
    ['arc-preview-toggle', 'previewBeforeSend'],
  ].forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.checked = s[key];
    el.addEventListener('change', () => { s[key] = el.checked; saveSettingsDebounced(); updatePanelUI(); });
  });

  // Buttons
  document.getElementById('arc-manual-trigger-btn')?.addEventListener('click', () => triggerArc(null, false));
  document.getElementById('arc-preview-btn')?.addEventListener('click', () => {
    const genres = s.selectedGenres?.length ? s.selectedGenres : ['fantasy'];
    const state = getChatState(getChatKey());
    let level = 0;
    if (s.arcLevels && state.openArc) level = Math.min(state.openArc.level + 1, 2);
    showPromptPreview(buildPrompt(level, getRecentContext(s.contextMessages), genres), level, genres);
  });
  document.getElementById('arc-export-btn')?.addEventListener('click', exportArcHistory);

  updatePanelUI();
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────
jQuery(async () => {
  loadSettings();
  $('#extensions_settings').append(`
    <div class="arc_catalyst_settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>◈ Arc Catalyst</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">${buildSettingsHTML()}</div>
      </div>
    </div>`);
  initUI();
  eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
  eventSource.on(event_types.CHAT_CHANGED, () => { updatePanelUI(); });
});
