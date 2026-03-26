/**
 * Avatar Gallery (AG) — SillyTavern Extension
 * v1.0.0
 *
 * Adds a gallery of alternative avatars for characters and personas.
 * - Upload multiple avatar images per entity
 * - Click avatar in chat → zoom lightbox with ◀ ▶ arrows
 * - Set any gallery image as the active avatar
 * - Settings panel with thumbnail grid management
 * - Storage: base64 in extensionSettings (no server API needed)
 */

(() => {
  'use strict';

  const MODULE_KEY = 'avatar_gallery';
  const MAX_IMG_SIZE = 512;    // resize to this px max dimension
  const JPEG_QUALITY = 0.82;

  // ─── ST context helpers ─────────────────────────────────────────

  function ctx() { return SillyTavern.getContext(); }

  function getStore() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_KEY])
      extensionSettings[MODULE_KEY] = { galleries: {}, collapsed: false };
    if (!extensionSettings[MODULE_KEY].galleries)
      extensionSettings[MODULE_KEY].galleries = {};
    return extensionSettings[MODULE_KEY];
  }

  function saveStore() { ctx().saveSettingsDebounced(); }

  // ─── Gallery data helpers ───────────────────────────────────────

  /**
   * Gallery key format:
   *   char:<characterId>   — for characters/bots
   *   persona:<personaName> — for user personas
   */

  function getCharId() {
    const c = ctx();
    return c.characterId !== undefined ? c.characterId : null;
  }

  function getCharName() {
    const c = ctx();
    try {
      if (c.characterId !== undefined && c.characters?.[c.characterId]?.name)
        return c.characters[c.characterId].name;
    } catch {}
    return null;
  }

  function getCharAvatar() {
    const c = ctx();
    try {
      const ch = c.characters?.[c.characterId];
      return ch?.avatar || null;
    } catch {}
    return null;
  }

  function getPersonaName() {
    const c = ctx();
    try {
      if (typeof c.name1 === 'string' && c.name1.trim()) return c.name1.trim();
    } catch {}
    return null;
  }

  function getGallery(key) {
    const store = getStore();
    if (!store.galleries[key]) store.galleries[key] = { images: [] };
    return store.galleries[key];
  }

  function getAllCharKeys() {
    const store = getStore();
    return Object.keys(store.galleries).filter(k => k.startsWith('char:'));
  }

  function getAllPersonaKeys() {
    const store = getStore();
    return Object.keys(store.galleries).filter(k => k.startsWith('persona:'));
  }

  // ─── Image processing ──────────────────────────────────────────

  function resizeAndCompress(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = () => reject(new Error('Failed to load image'));
        img.onload = () => {
          let w = img.width, h = img.height;
          if (w > MAX_IMG_SIZE || h > MAX_IMG_SIZE) {
            const ratio = Math.min(MAX_IMG_SIZE / w, MAX_IMG_SIZE / h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const cx = canvas.getContext('2d');
          cx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function pickImages() {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/*';
      inp.multiple = true;
      inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.addEventListener('change', () => {
        const files = Array.from(inp.files || []);
        inp.remove();
        resolve(files);
      });
      inp.addEventListener('cancel', () => { inp.remove(); resolve([]); });
      inp.click();
    });
  }

  // ─── Zoom lightbox ─────────────────────────────────────────────

  let zoomState = { key: null, index: 0, type: null }; // type: 'char' | 'persona'

  function ensureZoomDom() {
    if (document.getElementById('ag_zoom_overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'ag_zoom_overlay';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', closeZoom);

    const box = document.createElement('div');
    box.id = 'ag_zoom_box';
    box.innerHTML = `
      <button class="ag-zoom-close" id="ag_zoom_close" title="Закрыть">✕</button>
      <img id="ag_zoom_img" src="" alt="Avatar">
      <div class="ag-zoom-nav">
        <button class="ag-zoom-arrow" id="ag_zoom_prev" title="Предыдущая">◀</button>
        <span class="ag-zoom-counter" id="ag_zoom_counter">1 / 1</span>
        <button class="ag-zoom-arrow" id="ag_zoom_next" title="Следующая">▶</button>
      </div>
      <button class="ag-zoom-set-btn" id="ag_zoom_set">Установить аватар</button>
    `;
    document.body.appendChild(box);

    // Prevent click on box from closing overlay
    box.addEventListener('click', (e) => e.stopPropagation());

    document.getElementById('ag_zoom_close').addEventListener('click', closeZoom);
    document.getElementById('ag_zoom_prev').addEventListener('click', () => navigateZoom(-1));
    document.getElementById('ag_zoom_next').addEventListener('click', () => navigateZoom(1));
    document.getElementById('ag_zoom_set').addEventListener('click', setAvatarFromZoom);

    document.addEventListener('keydown', (e) => {
      if (document.getElementById('ag_zoom_overlay')?.style.display !== 'block') return;
      if (e.key === 'Escape') closeZoom();
      if (e.key === 'ArrowLeft') navigateZoom(-1);
      if (e.key === 'ArrowRight') navigateZoom(1);
    });
  }

  function openZoom(galleryKey, startIndex = 0) {
    ensureZoomDom();
    zoomState.key = galleryKey;
    zoomState.index = startIndex;
    zoomState.type = galleryKey.startsWith('char:') ? 'char' : 'persona';

    document.getElementById('ag_zoom_overlay').style.display = 'block';
    document.getElementById('ag_zoom_box').style.display = 'flex';
    updateZoomView();
  }

  function closeZoom() {
    document.getElementById('ag_zoom_overlay').style.display = 'none';
    document.getElementById('ag_zoom_box').style.display = 'none';
  }

  function navigateZoom(dir) {
    const gallery = getGallery(zoomState.key);
    const total = gallery.images.length;
    if (total < 2) return;
    zoomState.index = ((zoomState.index + dir) % total + total) % total;
    updateZoomView();
  }

  function updateZoomView() {
    const gallery = getGallery(zoomState.key);
    const total = gallery.images.length;
    if (!total) { closeZoom(); return; }

    const idx = Math.min(zoomState.index, total - 1);
    zoomState.index = idx;

    const imgEl = document.getElementById('ag_zoom_img');
    imgEl.src = gallery.images[idx];

    document.getElementById('ag_zoom_counter').textContent = `${idx + 1} / ${total}`;

    // Check if current image is the active avatar
    const setBtn = document.getElementById('ag_zoom_set');
    const isActive = gallery.activeIndex === idx;
    setBtn.classList.toggle('ag-active', isActive);
    setBtn.textContent = isActive ? '✓ Текущий аватар' : 'Установить аватар';
  }

  async function setAvatarFromZoom() {
    const gallery = getGallery(zoomState.key);
    if (!gallery.images.length) return;

    gallery.activeIndex = zoomState.index;
    const dataUrl = gallery.images[zoomState.index];
    saveStore();

    // Apply the avatar
    await applyAvatar(zoomState.key, dataUrl);

    updateZoomView();
    renderSettingsGallery();
    toastr.success('Аватар обновлён', 'Avatar Gallery');
  }

  // ─── Apply avatar to ST ────────────────────────────────────────

  async function applyAvatar(galleryKey, dataUrl) {
    const c = ctx();

    if (galleryKey.startsWith('char:')) {
      // Character avatar — use ST API to upload
      try {
        const charId = galleryKey.replace('char:', '');
        const char = c.characters?.[charId];
        if (!char) return;

        // Convert dataURL to blob
        const resp = await fetch(dataUrl);
        const blob = await resp.blob();
        const file = new File([blob], `avatar_${Date.now()}.jpg`, { type: 'image/jpeg' });

        // Use ST's cropAndSaveAvatar if available, or update directly
        if (typeof c.saveCharacterAvatar === 'function') {
          await c.saveCharacterAvatar(file, charId);
        } else {
          // Fallback: upload via FormData to ST API
          const fd = new FormData();
          fd.append('avatar', file);
          fd.append('overwrite_name', char.avatar || '');
          try {
            const uploadResp = await fetch('/api/characters/upload-avatar', {
              method: 'POST',
              body: fd,
            });
            if (uploadResp.ok) {
              // Force refresh
              const avatarImg = document.querySelector(`#chat .mes[is_user="false"] .avatar img`);
              if (avatarImg) avatarImg.src = dataUrl;
            }
          } catch (e) {
            console.warn('[AG] Upload fallback failed:', e);
          }
        }

        // Update visible avatars in chat
        updateVisibleAvatars('char', dataUrl);

      } catch (e) {
        console.error('[AG] Failed to set character avatar:', e);
        toastr.error('Не удалось обновить аватар персонажа');
      }
    } else if (galleryKey.startsWith('persona:')) {
      // Persona avatar — use ST API
      try {
        const resp = await fetch(dataUrl);
        const blob = await resp.blob();
        const file = new File([blob], `persona_${Date.now()}.jpg`, { type: 'image/jpeg' });

        if (typeof c.savePersonaAvatar === 'function') {
          await c.savePersonaAvatar(file);
        } else {
          // Fallback: upload via FormData
          const fd = new FormData();
          fd.append('avatar', file);
          try {
            await fetch('/api/personas/upload-avatar', { method: 'POST', body: fd });
          } catch (e) {
            console.warn('[AG] Persona upload fallback failed:', e);
          }
        }

        updateVisibleAvatars('persona', dataUrl);

      } catch (e) {
        console.error('[AG] Failed to set persona avatar:', e);
        toastr.error('Не удалось обновить аватар персоны');
      }
    }
  }

  function updateVisibleAvatars(type, dataUrl) {
    // Update avatar images visible in chat
    const selector = type === 'char'
      ? '#chat .mes:not([is_user="true"]) .avatar img, #chat .mes[is_user="false"] .avatar img'
      : '#chat .mes[is_user="true"] .avatar img';

    document.querySelectorAll(selector).forEach(img => {
      img.src = dataUrl;
    });
  }

  // ─── Avatar click interception ─────────────────────────────────

  function interceptAvatarClicks() {
    // Use event delegation on #chat
    $(document).off('click.ag_avatar').on('click.ag_avatar', '#chat .mes .avatar', function (e) {
      // Determine if this is a user or char message
      const mes = $(this).closest('.mes');
      const isUser = mes.attr('is_user') === 'true';

      let galleryKey = null;
      if (isUser) {
        const personaName = getPersonaName();
        if (personaName) galleryKey = `persona:${personaName}`;
      } else {
        const charId = getCharId();
        if (charId !== null) galleryKey = `char:${charId}`;
      }

      if (!galleryKey) return; // no gallery target

      const gallery = getGallery(galleryKey);
      if (gallery.images.length === 0) return; // no gallery images, let ST handle normally

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      openZoom(galleryKey, gallery.activeIndex || 0);
    });
  }

  // ─── Settings UI ───────────────────────────────────────────────

  async function mountSettingsUi() {
    if ($('#ag_settings_block').length) return;
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) { console.warn('[AG] Settings container not found'); return; }

    const store = getStore();

    $(target).append(`
      <div class="ag-settings-block" id="ag_settings_block">
        <div class="ag-settings-title">
          <span>🖼 Avatar Gallery</span>
          <button type="button" id="ag_collapse_btn">${store.collapsed ? '▸' : '▾'}</button>
        </div>
        <div class="ag-settings-body" id="ag_settings_body"${store.collapsed ? ' style="display:none"' : ''}>
          <div class="ag-section" id="ag_char_section">
            <div class="ag-section-hdr" id="ag_char_hdr">
              <span class="ag-section-chev">▾</span>
              🤖 Персонаж
            </div>
            <div id="ag_char_gallery"></div>
          </div>
          <div class="ag-section" id="ag_persona_section">
            <div class="ag-section-hdr" id="ag_persona_hdr">
              <span class="ag-section-chev">▾</span>
              👤 Персона
            </div>
            <div id="ag_persona_gallery"></div>
          </div>
        </div>
      </div>
    `);

    $('#ag_collapse_btn').on('click', () => {
      store.collapsed = !store.collapsed;
      $('#ag_settings_body').toggle(!store.collapsed);
      $('#ag_collapse_btn').text(store.collapsed ? '▸' : '▾');
      saveStore();
    });

    renderSettingsGallery();
  }

  function renderSettingsGallery() {
    renderEntityGallery('char');
    renderEntityGallery('persona');
  }

  function renderEntityGallery(type) {
    const containerId = type === 'char' ? '#ag_char_gallery' : '#ag_persona_gallery';
    const $container = $(containerId);
    if (!$container.length) return;

    let galleryKey = null;
    let entityLabel = '';

    if (type === 'char') {
      const charId = getCharId();
      const charName = getCharName();
      if (charId !== null) {
        galleryKey = `char:${charId}`;
        entityLabel = charName || `Character #${charId}`;
      }
    } else {
      const personaName = getPersonaName();
      if (personaName) {
        galleryKey = `persona:${personaName}`;
        entityLabel = personaName;
      }
    }

    if (!galleryKey) {
      $container.html(`<div class="ag-empty">${type === 'char' ? 'Выберите чат с персонажем' : 'Персона не активна'}</div>`);
      return;
    }

    const gallery = getGallery(galleryKey);
    const images = gallery.images || [];

    let html = `<div style="font-size:11px;color:var(--ag-text-dim);margin-bottom:8px">${entityLabel} · ${images.length} изобр.</div>`;
    html += `<div class="ag-thumbs">`;

    images.forEach((src, i) => {
      const isActive = gallery.activeIndex === i;
      html += `
        <div class="ag-thumb-wrap${isActive ? ' ag-thumb-active' : ''}" data-key="${galleryKey}" data-idx="${i}">
          <img class="ag-thumb-img" src="${src}" alt="Avatar ${i+1}" loading="lazy">
          <button class="ag-thumb-remove" data-key="${galleryKey}" data-idx="${i}" title="Удалить">✕</button>
        </div>`;
    });

    html += `<button class="ag-add-btn" data-key="${galleryKey}" title="Добавить аватарки">+</button>`;
    html += `</div>`;

    $container.html(html);

    // Bind events
    $container.find('.ag-thumb-wrap').off('click').on('click', function (e) {
      if ($(e.target).hasClass('ag-thumb-remove')) return;
      const key = this.getAttribute('data-key');
      const idx = parseInt(this.getAttribute('data-idx'));
      openZoom(key, idx);
    });

    $container.find('.ag-thumb-remove').off('click').on('click', async function (e) {
      e.stopPropagation();
      const key = this.getAttribute('data-key');
      const idx = parseInt(this.getAttribute('data-idx'));
      await removeImage(key, idx);
    });

    $container.find('.ag-add-btn').off('click').on('click', async function () {
      const key = this.getAttribute('data-key');
      await addImages(key);
    });
  }

  async function addImages(galleryKey) {
    const files = await pickImages();
    if (!files.length) return;

    const gallery = getGallery(galleryKey);

    for (const file of files) {
      try {
        const dataUrl = await resizeAndCompress(file);
        gallery.images.push(dataUrl);
      } catch (e) {
        console.warn('[AG] Failed to process image:', e);
      }
    }

    saveStore();
    renderSettingsGallery();
    toastr.success(`Добавлено ${files.length} изобр.`, 'Avatar Gallery');
  }

  async function removeImage(galleryKey, index) {
    const gallery = getGallery(galleryKey);
    if (index < 0 || index >= gallery.images.length) return;

    gallery.images.splice(index, 1);

    // Adjust activeIndex
    if (gallery.activeIndex !== undefined) {
      if (gallery.activeIndex === index) {
        gallery.activeIndex = gallery.images.length > 0 ? 0 : undefined;
      } else if (gallery.activeIndex > index) {
        gallery.activeIndex--;
      }
    }

    saveStore();
    renderSettingsGallery();

    // If zoom is open on this gallery, update it
    if (zoomState.key === galleryKey) {
      if (gallery.images.length === 0) closeZoom();
      else updateZoomView();
    }
  }

  // ─── Events ────────────────────────────────────────────────────

  function wireEvents() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.APP_READY, async () => {
      ensureZoomDom();
      await mountSettingsUi();
      interceptAvatarClicks();
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
      await new Promise(r => setTimeout(r, 300));
      renderSettingsGallery();
      interceptAvatarClicks();
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────

  jQuery(() => {
    try {
      wireEvents();
      console.log('[AG] Avatar Gallery v1.0.0 loaded');
    } catch (e) {
      console.error('[AG] init failed', e);
    }
  });

})();
