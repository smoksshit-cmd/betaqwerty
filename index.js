/**
 * Avatar Gallery — SillyTavern Extension
 * v1.0.0
 *
 * Allows uploading multiple avatar variants for characters and personas.
 * Quick-switch from chat via arrow overlays on avatar zoom.
 * Storage: base64 in extensionSettings (simple, no server API needed).
 */

(() => {
  'use strict';

  const MODULE_KEY = 'avatar_gallery';
  const MAX_IMG_SIZE = 512; // resize to max 512px
  const MAX_GALLERY  = 30;  // max images per entity
  const JPEG_QUALITY = 0.85;

  // ─── ST context ───────────────────────────────────────────────────────────────

  function ctx() { return SillyTavern.getContext(); }

  function getStore() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_KEY])
      extensionSettings[MODULE_KEY] = { galleries: {}, collapsed: false };
    return extensionSettings[MODULE_KEY];
  }

  function save() { ctx().saveSettingsDebounced(); }

  // ─── Entity helpers ───────────────────────────────────────────────────────────

  let currentMode = 'character'; // 'character' | 'persona'

  function getCharacterInfo() {
    const c = ctx();
    const charId = c.characterId;
    if (charId === undefined || charId === null) return null;
    const char = c.characters?.[charId];
    if (!char) return null;
    const avatar = char.avatar;
    const avatarUrl = avatar
      ? `/characters/${encodeURIComponent(avatar)}`
      : '/img/ai4.png';
    return {
      id: `char_${char.avatar || charId}`,
      name: char.name || 'Character',
      avatarUrl,
      avatar,
      type: 'character',
    };
  }

  function getPersonaInfo() {
    const c = ctx();
    // Try multiple ST API patterns for persona
    const personaName = c.name1 || c.user?.name || 'User';
    const personaAvatar = c.user_avatar;
    const avatarUrl = personaAvatar
      ? `/User Avatars/${encodeURIComponent(personaAvatar)}`
      : '/img/user-default.png';
    return {
      id: `persona_${personaAvatar || personaName}`,
      name: personaName,
      avatarUrl,
      avatar: personaAvatar,
      type: 'persona',
    };
  }

  function getCurrentEntity() {
    return currentMode === 'character' ? getCharacterInfo() : getPersonaInfo();
  }

  function getGallery(entityId) {
    const store = getStore();
    if (!store.galleries[entityId]) store.galleries[entityId] = [];
    return store.galleries[entityId];
  }

  // ─── Image processing ────────────────────────────────────────────────────────

  function resizeImageToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let w = img.width, h = img.height;
          if (w > MAX_IMG_SIZE || h > MAX_IMG_SIZE) {
            const ratio = Math.min(MAX_IMG_SIZE / w, MAX_IMG_SIZE / h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const cctx = canvas.getContext('2d');
          cctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
          resolve(dataUrl);
        };
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  // ─── Avatar setting via ST API ────────────────────────────────────────────────

  async function setCharacterAvatar(base64DataUrl) {
    const c = ctx();
    const entity = getCharacterInfo();
    if (!entity) return false;

    try {
      // Convert base64 to blob
      const resp = await fetch(base64DataUrl);
      const blob = await resp.blob();

      const formData = new FormData();
      formData.append('avatar', blob, 'avatar.jpg');
      formData.append('overwrite_name', entity.name);

      const result = await fetch('/api/characters/edit-attribute', {
        method: 'POST',
        body: formData,
      });

      if (!result.ok) {
        // Fallback: try the older editcharacterattribute endpoint
        const formData2 = new FormData();
        formData2.append('avatar', blob, 'avatar.jpg');
        formData2.append('avatar_url', entity.avatar);

        const result2 = await fetch('/editcharacterattribute', {
          method: 'POST',
          body: formData2,
        });

        if (!result2.ok) {
          console.warn('[AG] Both avatar update methods failed');
          return false;
        }
      }

      // Force reload
      if (typeof c.reloadCurrentChat === 'function') {
        await c.reloadCurrentChat();
      }

      return true;
    } catch (e) {
      console.error('[AG] setCharacterAvatar failed', e);
      return false;
    }
  }

  async function setPersonaAvatar(base64DataUrl) {
    const c = ctx();
    try {
      const resp = await fetch(base64DataUrl);
      const blob = await resp.blob();

      const formData = new FormData();
      formData.append('avatar', blob, 'avatar.jpg');

      // ST API for user avatar upload
      const result = await fetch('/api/avatars/upload', {
        method: 'POST',
        body: formData,
      });

      if (!result.ok) {
        // Older endpoint
        const result2 = await fetch('/uploaduseravatar', {
          method: 'POST',
          body: formData,
        });
        if (!result2.ok) return false;
      }

      if (typeof c.reloadCurrentChat === 'function') {
        await c.reloadCurrentChat();
      }

      return true;
    } catch (e) {
      console.error('[AG] setPersonaAvatar failed', e);
      return false;
    }
  }

  async function setActiveAvatar(base64DataUrl, type) {
    if (type === 'character') {
      return await setCharacterAvatar(base64DataUrl);
    } else {
      return await setPersonaAvatar(base64DataUrl);
    }
  }

  // ─── Upload handler ───────────────────────────────────────────────────────────

  async function handleUpload(files) {
    const entity = getCurrentEntity();
    if (!entity) {
      toastr.warning('[AG] Нет активного персонажа/персоны');
      return;
    }

    const gallery = getGallery(entity.id);

    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      if (gallery.length >= MAX_GALLERY) {
        toastr.warning(`[AG] Максимум ${MAX_GALLERY} аватарок`);
        break;
      }

      try {
        const base64 = await resizeImageToBase64(file);
        gallery.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          data: base64,
          ts: Date.now(),
        });
      } catch (e) {
        console.error('[AG] upload error', e);
        toastr.error(`[AG] Ошибка: ${file.name}`);
      }
    }

    save();
    renderGallery();
    toastr.success(`[AG] Загружено аватарок: ${files.length}`);
  }

  function deleteImage(entityId, imgId) {
    const gallery = getGallery(entityId);
    const idx = gallery.findIndex(g => g.id === imgId);
    if (idx >= 0) gallery.splice(idx, 1);
    save();
    renderGallery();
  }

  // ─── Zoom overlay ────────────────────────────────────────────────────────────

  let zoomState = { entityId: null, type: null, images: [], currentIdx: 0 };

  function ensureZoomOverlay() {
    if (document.getElementById('ag_zoom_overlay')) return;
    const el = document.createElement('div');
    el.id = 'ag_zoom_overlay';
    el.innerHTML = `
      <div class="ag-zoom-container">
        <button class="ag-zoom-close" title="Закрыть">✕</button>
        <button class="ag-zoom-nav ag-zoom-prev" title="Предыдущая">◀</button>
        <img class="ag-zoom-img" src="" alt="avatar">
        <button class="ag-zoom-nav ag-zoom-next" title="Следующая">▶</button>
        <span class="ag-zoom-counter"></span>
        <button class="ag-zoom-set-btn">✓ Установить</button>
      </div>`;
    document.body.appendChild(el);

    el.querySelector('.ag-zoom-close').addEventListener('click', closeZoom);
    el.querySelector('.ag-zoom-prev').addEventListener('click', () => navigateZoom(-1));
    el.querySelector('.ag-zoom-next').addEventListener('click', () => navigateZoom(1));
    el.querySelector('.ag-zoom-set-btn').addEventListener('click', () => applyZoomAvatar());

    el.addEventListener('click', (e) => {
      if (e.target === el) closeZoom();
    });

    document.addEventListener('keydown', (e) => {
      if (!document.getElementById('ag_zoom_overlay')?.classList.contains('ag-visible')) return;
      if (e.key === 'Escape') closeZoom();
      if (e.key === 'ArrowLeft') navigateZoom(-1);
      if (e.key === 'ArrowRight') navigateZoom(1);
      if (e.key === 'Enter') applyZoomAvatar();
    });
  }

  function openZoom(entityId, type, images, startIdx = 0) {
    ensureZoomOverlay();
    zoomState = { entityId, type, images: [...images], currentIdx: startIdx };
    updateZoomDisplay();
    document.getElementById('ag_zoom_overlay').classList.add('ag-visible');
  }

  function closeZoom() {
    document.getElementById('ag_zoom_overlay')?.classList.remove('ag-visible');
  }

  function navigateZoom(dir) {
    if (!zoomState.images.length) return;
    zoomState.currentIdx = (zoomState.currentIdx + dir + zoomState.images.length) % zoomState.images.length;
    updateZoomDisplay();
  }

  function updateZoomDisplay() {
    const overlay = document.getElementById('ag_zoom_overlay');
    if (!overlay || !zoomState.images.length) return;
    const img = zoomState.images[zoomState.currentIdx];
    overlay.querySelector('.ag-zoom-img').src = img.data || img.url || '';
    overlay.querySelector('.ag-zoom-counter').textContent =
      `${zoomState.currentIdx + 1} / ${zoomState.images.length}`;

    // Hide nav if only 1 image
    const showNav = zoomState.images.length > 1;
    overlay.querySelector('.ag-zoom-prev').style.display = showNav ? '' : 'none';
    overlay.querySelector('.ag-zoom-next').style.display = showNav ? '' : 'none';
  }

  async function applyZoomAvatar() {
    if (!zoomState.images.length) return;
    const img = zoomState.images[zoomState.currentIdx];
    const data = img.data || img.url;
    if (!data) return;

    toastr.info('[AG] Устанавливаю аватар…');

    const ok = await setActiveAvatar(data, zoomState.type);
    if (ok) {
      toastr.success('[AG] Аватар обновлён!');
      closeZoom();
    } else {
      toastr.warning(
        '[AG] Автоматическая смена не удалась. Скачайте картинку и установите вручную.',
        '', { timeOut: 5000 }
      );
    }
  }

  // ─── Chat avatar arrows ──────────────────────────────────────────────────────

  function injectChatArrows() {
    // Find message avatars in chat and add navigation arrows
    document.querySelectorAll('.mes .avatar img, .mes .mes_img_container img').forEach(img => {
      const mes = img.closest('.mes');
      if (!mes || mes.querySelector('.ag-chat-zoom-arrows')) return;

      const isUser = mes.getAttribute('is_user') === 'true' || mes.classList.contains('mes_user');
      const entity = isUser ? getPersonaInfo() : getCharacterInfo();
      if (!entity) return;

      const gallery = getGallery(entity.id);
      if (!gallery.length) return;

      const container = img.closest('.avatar') || img.closest('.mes_img_container') || img.parentElement;
      if (!container) return;
      container.style.position = 'relative';

      const arrows = document.createElement('div');
      arrows.className = 'ag-chat-zoom-arrows';
      arrows.innerHTML = `
        <button class="ag-chat-arrow ag-chat-prev" title="Предыдущая">◀</button>
        <button class="ag-chat-arrow ag-chat-next" title="Следующая">▶</button>`;
      container.appendChild(arrows);

      // Build image list: current avatar + gallery
      const buildImageList = () => {
        const ent = isUser ? getPersonaInfo() : getCharacterInfo();
        if (!ent) return [];
        const gal = getGallery(ent.id);
        const list = [{ url: ent.avatarUrl, data: null, id: '__current__' }];
        gal.forEach(g => list.push(g));
        return list;
      };

      arrows.querySelector('.ag-chat-prev').addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const images = buildImageList();
        if (images.length <= 1) return;
        openZoom(entity.id, entity.type, images, images.length - 1);
      });

      arrows.querySelector('.ag-chat-next').addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const images = buildImageList();
        if (images.length <= 1) return;
        openZoom(entity.id, entity.type, images, 1);
      });
    });
  }

  // ─── Settings UI ──────────────────────────────────────────────────────────────

  function renderGallery() {
    const $gallery = $('#ag_gallery_grid');
    const $info    = $('#ag_current_info');
    if (!$gallery.length) return;

    const entity = getCurrentEntity();
    if (!entity) {
      $info.html('<div class="ag-current-name" style="opacity:.5">Откройте чат с персонажем</div>');
      $gallery.html('<div class="ag-empty">Нет активного чата</div>');
      return;
    }

    const gallery = getGallery(entity.id);

    $info.html(`
      <img class="ag-current-avatar" src="${entity.avatarUrl}" alt="" onerror="this.src='/img/ai4.png'">
      <span class="ag-current-name">${escHtml(entity.name)}</span>
      <span class="ag-current-count">${gallery.length} шт.</span>
    `);

    if (!gallery.length) {
      $gallery.html('<div class="ag-empty">Нет загруженных аватарок.<br>Нажмите «+ Загрузить» чтобы добавить.</div>');
      return;
    }

    let html = '';
    gallery.forEach((img, idx) => {
      html += `
        <div class="ag-thumb-wrap" data-entity="${entity.id}" data-img-id="${img.id}" data-idx="${idx}">
          <img class="ag-thumb-img" src="${img.data}" alt="" loading="lazy">
          <button class="ag-thumb-del" data-entity="${entity.id}" data-img-id="${img.id}" title="Удалить">✕</button>
        </div>`;
    });
    $gallery.html(html);
  }

  function escHtml(s) {
    return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  }

  async function mountSettingsUi() {
    if ($('#ag_settings_block').length) return;
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) return;

    const store = getStore();

    $(target).append(`
      <div class="ag-settings-block" id="ag_settings_block">
        <div class="ag-settings-title">
          <span>🖼️ Avatar Gallery</span>
          <button type="button" id="ag_collapse_btn">${store.collapsed ? '▸' : '▾'}</button>
        </div>
        <div class="ag-settings-body" id="ag_settings_body" ${store.collapsed ? 'style="display:none"' : ''}>
          <div class="ag-target-bar">
            <button class="ag-target-btn ${currentMode === 'character' ? 'active' : ''}" data-mode="character">🤖 Персонаж</button>
            <button class="ag-target-btn ${currentMode === 'persona' ? 'active' : ''}" data-mode="persona">👤 Персона</button>
          </div>
          <div class="ag-current-info" id="ag_current_info"></div>
          <div class="ag-gallery" id="ag_gallery_grid"></div>
          <div class="ag-upload-area">
            <button class="ag-upload-btn" id="ag_upload_btn">+ Загрузить</button>
            <input type="file" id="ag_file_input" accept="image/*" multiple style="display:none">
            <span class="ag-hint">JPG, PNG, WebP · до ${MAX_GALLERY} шт.</span>
          </div>
        </div>
      </div>
    `);

    // Collapse toggle
    $('#ag_collapse_btn').on('click', () => {
      store.collapsed = !store.collapsed;
      $('#ag_settings_body').toggle(!store.collapsed);
      $('#ag_collapse_btn').text(store.collapsed ? '▸' : '▾');
      save();
    });

    // Mode switch
    $(document).off('click.ag_mode').on('click.ag_mode', '.ag-target-btn', function () {
      currentMode = this.getAttribute('data-mode');
      document.querySelectorAll('.ag-target-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      renderGallery();
    });

    // Upload
    $('#ag_upload_btn').on('click', () => document.getElementById('ag_file_input')?.click());
    $('#ag_file_input').on('change', async (e) => {
      const files = e.target.files;
      if (files?.length) await handleUpload(Array.from(files));
      e.target.value = '';
    });

    // Thumbnail click → open zoom
    $(document).off('click.ag_thumb').on('click.ag_thumb', '.ag-thumb-wrap', function (e) {
      if (e.target.classList.contains('ag-thumb-del')) return;
      const entityId = this.getAttribute('data-entity');
      const idx = parseInt(this.getAttribute('data-idx')) || 0;
      const entity = getCurrentEntity();
      if (!entity) return;

      const gallery = getGallery(entityId);
      // Current avatar + gallery items
      const images = [{ url: entity.avatarUrl, data: null, id: '__current__' }];
      gallery.forEach(g => images.push(g));

      openZoom(entityId, entity.type, images, idx + 1); // +1 because current is at 0
    });

    // Delete thumbnail
    $(document).off('click.ag_del').on('click.ag_del', '.ag-thumb-del', function (e) {
      e.stopPropagation();
      const entityId = this.getAttribute('data-entity');
      const imgId = this.getAttribute('data-img-id');
      deleteImage(entityId, imgId);
    });

    renderGallery();
  }

  // ─── Events ───────────────────────────────────────────────────────────────────

  function wireEvents() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.APP_READY, async () => {
      await mountSettingsUi();
      ensureZoomOverlay();
      setTimeout(injectChatArrows, 500);
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
      await new Promise(r => setTimeout(r, 300));
      renderGallery();
      setTimeout(injectChatArrows, 500);
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
      setTimeout(injectChatArrows, 300);
    });

    eventSource.on(event_types.MESSAGE_SENT, () => {
      setTimeout(injectChatArrows, 300);
    });

    // Also observe DOM for dynamically added messages
    const chatObserver = new MutationObserver(() => {
      setTimeout(injectChatArrows, 200);
    });

    const startObserving = () => {
      const chatContainer = document.getElementById('chat');
      if (chatContainer) {
        chatObserver.observe(chatContainer, { childList: true, subtree: false });
      }
    };

    // Try to start observing after a delay
    setTimeout(startObserving, 1000);
    eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(startObserving, 500));
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────────

  jQuery(() => {
    try {
      wireEvents();
      console.log('[AG] Avatar Gallery v1.0.0 loaded');
    } catch (e) {
      console.error('[AG] init failed', e);
    }
  });

})();
