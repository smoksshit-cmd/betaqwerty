/**
 * Avatar Gallery — SillyTavern Extension
 * v1.0.0
 *
 * Adds a gallery of avatars for personas & characters.
 * - Upload multiple avatars per entity
 * - Click avatar in chat → zoom overlay with ◀ ▶ arrows
 * - Switch active avatar from the overlay
 * - Gallery management in extension settings
 *
 * Storage: extensionSettings (base64 thumbnails + full images)
 */

(() => {
  'use strict';

  const MODULE_KEY = 'avatar_gallery';
  const MAX_IMG_SIZE = 512;       // max dimension for stored images
  const THUMB_SIZE   = 80;        // thumbnail dimension
  const MAX_FILE_MB  = 10;

  // ─── ST context ──────────────────────────────────────────────────

  function ctx() { return SillyTavern.getContext(); }

  function getGalleryData() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_KEY])
      extensionSettings[MODULE_KEY] = { galleries: {}, enabled: true };
    return extensionSettings[MODULE_KEY];
  }

  function save() { ctx().saveSettingsDebounced(); }

  // ─── Entity helpers ──────────────────────────────────────────────

  /**
   * Returns an array of { id, name, avatar, type } for the current
   * character + user persona visible in the chat.
   */
  function getActiveEntities() {
    const c = ctx();
    const entities = [];

    // Character / bot
    try {
      if (c.characterId !== undefined && c.characters?.[c.characterId]) {
        const char = c.characters[c.characterId];
        entities.push({
          id:     `char_${c.characterId}`,
          name:   char.name || 'Character',
          avatar: char.avatar,
          type:   'character',
        });
      }
    } catch {}

    // Group members
    try {
      if (c.groupId !== undefined) {
        const group = c.groups?.find?.(g => g.id === c.groupId);
        if (group?.members) {
          for (const memberId of group.members) {
            const char = c.characters?.find?.(ch => ch.avatar?.includes?.(memberId) || ch.name === memberId);
            if (char) {
              entities.push({
                id:     `char_${memberId}`,
                name:   char.name || memberId,
                avatar: char.avatar,
                type:   'character',
              });
            }
          }
        }
      }
    } catch {}

    // User persona
    try {
      const personaName = c.name1 || 'User';
      const personaAvatar = c.user_avatar;
      entities.push({
        id:     `persona_${personaName.replace(/\W+/g, '_')}`,
        name:   personaName,
        avatar: personaAvatar,
        type:   'persona',
      });
    } catch {}

    return entities;
  }

  function getEntityGallery(entityId) {
    const data = getGalleryData();
    if (!data.galleries[entityId])
      data.galleries[entityId] = { images: [], activeIndex: 0 };
    return data.galleries[entityId];
  }

  // ─── Image processing ────────────────────────────────────────────

  function resizeImage(file, maxDim) {
    return new Promise((resolve, reject) => {
      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        reject(new Error(`Файл слишком большой (макс. ${MAX_FILE_MB}МБ)`));
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let w = img.width, h = img.height;
          if (w > maxDim || h > maxDim) {
            const ratio = Math.min(maxDim / w, maxDim / h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctxC = canvas.getContext('2d');
          ctxC.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/webp', 0.85));
        };
        img.onerror = () => reject(new Error('Не удалось загрузить изображение'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Ошибка чтения файла'));
      reader.readAsDataURL(file);
    });
  }

  function makeThumb(base64, size) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctxC = canvas.getContext('2d');
        // Crop to square from center
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctxC.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        resolve(canvas.toDataURL('image/webp', 0.7));
      };
      img.src = base64;
    });
  }

  // ─── Avatar application ──────────────────────────────────────────

  /**
   * Attempts to set the avatar for an entity using ST's internal
   * methods. This is best-effort since ST doesn't expose a clean
   * public API for programmatic avatar changes.
   */
  function applyAvatarToChat(entity, imageData) {
    // Update avatars shown in the chat visually
    // For characters: find their messages and update the img src
    // For personas: update user avatar images
    try {
      if (entity.type === 'character') {
        // Update character avatar in chat messages
        document.querySelectorAll(`.mes[ch_name="${CSS.escape(entity.name)}"] .avatar img`).forEach(img => {
          img.src = imageData;
        });
        // Update the main avatar display if visible
        const mainAvatar = document.querySelector('#avatar_img_gen');
        if (mainAvatar) mainAvatar.src = imageData;
      } else if (entity.type === 'persona') {
        document.querySelectorAll('.mes[is_user="true"] .avatar img').forEach(img => {
          img.src = imageData;
        });
        const userAvatar = document.querySelector('#user_avatar_block .avatar img');
        if (userAvatar) userAvatar.src = imageData;
      }
    } catch (e) {
      console.warn('[AvatarGallery] Could not apply avatar visually:', e);
    }
  }

  // ─── Zoom overlay ────────────────────────────────────────────────

  let currentOverlayEntity = null;
  let currentOverlayIndex  = 0;

  function showZoomOverlay(entityId) {
    const data = getGalleryData();
    if (!data.enabled) return;

    const gallery = getEntityGallery(entityId);
    const entities = getActiveEntities();
    const entity = entities.find(e => e.id === entityId);
    if (!entity) return;

    // Build image list: original avatar + gallery images
    const images = [];

    // Add original ST avatar as first item
    if (entity.avatar) {
      // Try to get the actual avatar URL
      const avatarUrl = entity.type === 'character'
        ? `/characters/${encodeURIComponent(entity.avatar)}`
        : `/User Avatars/${encodeURIComponent(entity.avatar)}`;
      images.push({ src: avatarUrl, isOriginal: true, label: 'Основная' });
    }

    // Add gallery images
    gallery.images.forEach((img, i) => {
      images.push({ src: img.full, isOriginal: false, index: i, label: img.label || `#${i + 1}` });
    });

    if (!images.length) return;

    currentOverlayEntity = entityId;
    currentOverlayIndex  = Math.min(gallery.activeIndex || 0, images.length - 1);

    removeZoomOverlay();

    const overlay = document.createElement('div');
    overlay.id = 'avg_zoom_overlay';
    overlay.innerHTML = `
      <div class="avg-zoom-backdrop"></div>
      <div class="avg-zoom-container">
        <div class="avg-zoom-header">
          <span class="avg-zoom-name">${escHtml(entity.name)}</span>
          <span class="avg-zoom-counter" id="avg_zoom_counter"></span>
          <button class="avg-zoom-close" title="Закрыть">✕</button>
        </div>
        <div class="avg-zoom-body">
          <button class="avg-zoom-arrow avg-zoom-prev" title="Назад">‹</button>
          <div class="avg-zoom-img-wrap">
            <img id="avg_zoom_img" class="avg-zoom-img" src="" alt="Avatar">
            <div class="avg-zoom-label" id="avg_zoom_label"></div>
          </div>
          <button class="avg-zoom-arrow avg-zoom-next" title="Вперёд">›</button>
        </div>
        <div class="avg-zoom-thumbs" id="avg_zoom_thumbs"></div>
        <div class="avg-zoom-actions">
          <button class="avg-zoom-btn avg-zoom-set" id="avg_zoom_set" title="Установить как активный аватар">★ Установить</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const updateDisplay = () => {
      const img = images[currentOverlayIndex];
      document.getElementById('avg_zoom_img').src = img.src;
      document.getElementById('avg_zoom_counter').textContent = `${currentOverlayIndex + 1} / ${images.length}`;
      document.getElementById('avg_zoom_label').textContent = img.label;

      // Update thumbs active state
      document.querySelectorAll('.avg-zoom-thumb').forEach((el, i) => {
        el.classList.toggle('active', i === currentOverlayIndex);
      });

      // Hide set button for original avatar
      const setBtn = document.getElementById('avg_zoom_set');
      if (img.isOriginal) {
        setBtn.style.display = 'none';
      } else {
        setBtn.style.display = '';
      }

      // Hide arrows if only 1 image
      overlay.querySelectorAll('.avg-zoom-arrow').forEach(a => {
        a.style.visibility = images.length <= 1 ? 'hidden' : 'visible';
      });
    };

    // Build thumbnails strip
    const thumbsContainer = document.getElementById('avg_zoom_thumbs');
    images.forEach((img, i) => {
      const thumb = document.createElement('div');
      thumb.className = `avg-zoom-thumb${i === currentOverlayIndex ? ' active' : ''}`;
      thumb.style.backgroundImage = `url(${img.src})`;
      thumb.title = img.label;
      thumb.addEventListener('click', () => {
        currentOverlayIndex = i;
        updateDisplay();
      });
      thumbsContainer.appendChild(thumb);
    });

    updateDisplay();

    // Event handlers
    overlay.querySelector('.avg-zoom-backdrop').addEventListener('click', removeZoomOverlay);
    overlay.querySelector('.avg-zoom-close').addEventListener('click', removeZoomOverlay);

    overlay.querySelector('.avg-zoom-prev').addEventListener('click', () => {
      currentOverlayIndex = (currentOverlayIndex - 1 + images.length) % images.length;
      updateDisplay();
    });

    overlay.querySelector('.avg-zoom-next').addEventListener('click', () => {
      currentOverlayIndex = (currentOverlayIndex + 1) % images.length;
      updateDisplay();
    });

    document.getElementById('avg_zoom_set').addEventListener('click', () => {
      const img = images[currentOverlayIndex];
      if (!img.isOriginal) {
        gallery.activeIndex = currentOverlayIndex;
        applyAvatarToChat(entity, img.src);
        save();
        toastr.success(`Аватар "${img.label}" установлен для ${entity.name}`);
      }
    });

    // Keyboard navigation
    const onKey = (e) => {
      if (e.key === 'Escape') { removeZoomOverlay(); return; }
      if (e.key === 'ArrowLeft') {
        currentOverlayIndex = (currentOverlayIndex - 1 + images.length) % images.length;
        updateDisplay();
      }
      if (e.key === 'ArrowRight') {
        currentOverlayIndex = (currentOverlayIndex + 1) % images.length;
        updateDisplay();
      }
    };
    document.addEventListener('keydown', onKey);
    overlay._keyHandler = onKey;
  }

  function removeZoomOverlay() {
    const overlay = document.getElementById('avg_zoom_overlay');
    if (!overlay) return;
    if (overlay._keyHandler) document.removeEventListener('keydown', overlay._keyHandler);
    overlay.remove();
    currentOverlayEntity = null;
  }

  // ─── Chat avatar click interception ──────────────────────────────

  function setupAvatarClickHandlers() {
    // Intercept clicks on avatar images in chat
    $(document).off('click.avg_avatar').on('click.avg_avatar', '.mes .avatar img', function (e) {
      const data = getGalleryData();
      if (!data.enabled) return;

      const mesEl = $(this).closest('.mes');
      if (!mesEl.length) return;

      const entities = getActiveEntities();
      let entity = null;

      const isUser = mesEl.attr('is_user') === 'true';
      if (isUser) {
        entity = entities.find(e => e.type === 'persona');
      } else {
        const charName = mesEl.attr('ch_name');
        entity = entities.find(e => e.type === 'character' && e.name === charName);
      }

      if (!entity) return;

      const gallery = getEntityGallery(entity.id);
      // Only show overlay if there are gallery images
      if (gallery.images.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        showZoomOverlay(entity.id);
      }
    });
  }

  // ─── Settings panel ──────────────────────────────────────────────

  async function mountSettingsUi() {
    if ($('#avg_settings_block').length) return;
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) return;

    const data = getGalleryData();

    $(target).append(`
      <div class="avg-settings-block" id="avg_settings_block">
        <div class="avg-settings-title">
          <span>🖼️ Avatar Gallery</span>
          <button type="button" id="avg_collapse_btn">▾</button>
        </div>
        <div class="avg-settings-body" id="avg_settings_body">
          <div class="avg-setting-row">
            <label class="avg-ck">
              <input type="checkbox" id="avg_enabled" ${data.enabled !== false ? 'checked' : ''}>
              <span>Включено</span>
            </label>
          </div>
          <div class="avg-hint">Нажмите на аватар в чате чтобы открыть галерею. Стрелки ◀ ▶ для переключения.</div>
          <div class="avg-divider"></div>
          <div class="avg-entity-list" id="avg_entity_list">
            <div class="avg-hint">Откройте чат чтобы увидеть персонажей</div>
          </div>
        </div>
      </div>
    `);

    $('#avg_collapse_btn').on('click', function () {
      const body = $('#avg_settings_body');
      const open = body.is(':visible');
      body.toggle(!open);
      $(this).text(open ? '▸' : '▾');
    });

    $('#avg_enabled').on('change', function () {
      getGalleryData().enabled = $(this).prop('checked');
      save();
    });

    refreshEntityList();
  }

  function refreshEntityList() {
    const $list = $('#avg_entity_list');
    if (!$list.length) return;

    const entities = getActiveEntities();
    if (!entities.length) {
      $list.html('<div class="avg-hint">Откройте чат чтобы увидеть персонажей</div>');
      return;
    }

    let html = '';
    for (const entity of entities) {
      const gallery = getEntityGallery(entity.id);
      const count = gallery.images.length;
      const typeLabel = entity.type === 'persona' ? '👤' : '🤖';

      html += `
        <div class="avg-entity-card" data-entity-id="${escHtml(entity.id)}">
          <div class="avg-entity-header">
            <span class="avg-entity-icon">${typeLabel}</span>
            <span class="avg-entity-name">${escHtml(entity.name)}</span>
            <span class="avg-entity-count">${count} аватар${count === 1 ? '' : count > 1 && count < 5 ? 'а' : 'ов'}</span>
          </div>
          <div class="avg-entity-thumbs" id="avg_thumbs_${escHtml(entity.id)}">
            ${gallery.images.map((img, i) => `
              <div class="avg-thumb" data-index="${i}" title="${escHtml(img.label || `#${i+1}`)}">
                <img src="${img.thumb}" alt="">
                <button class="avg-thumb-del" data-entity="${escHtml(entity.id)}" data-index="${i}" title="Удалить">✕</button>
              </div>
            `).join('')}
            <label class="avg-thumb avg-thumb-add" title="Добавить аватар">
              <span>+</span>
              <input type="file" accept="image/*" multiple class="avg-file-input" data-entity="${escHtml(entity.id)}" style="display:none">
            </label>
          </div>
        </div>
      `;
    }

    $list.html(html);

    // File upload handlers
    $list.find('.avg-file-input').off('change').on('change', async function () {
      const entityId = $(this).data('entity');
      const files = this.files;
      if (!files?.length) return;

      for (const file of files) {
        try {
          const full  = await resizeImage(file, MAX_IMG_SIZE);
          const thumb = await makeThumb(full, THUMB_SIZE);
          const gallery = getEntityGallery(entityId);
          gallery.images.push({
            full,
            thumb,
            label: file.name.replace(/\.[^.]+$/, '').slice(0, 30),
            ts: Date.now(),
          });
          save();
          toastr.success(`Аватар добавлен: ${file.name}`);
        } catch (e) {
          toastr.error(`Ошибка: ${e.message}`);
        }
      }

      refreshEntityList();
    });

    // Delete handlers
    $list.find('.avg-thumb-del').off('click').on('click', function (e) {
      e.stopPropagation();
      const entityId = $(this).data('entity');
      const index    = $(this).data('index');
      const gallery  = getEntityGallery(entityId);
      gallery.images.splice(index, 1);
      if (gallery.activeIndex >= gallery.images.length) {
        gallery.activeIndex = Math.max(0, gallery.images.length - 1);
      }
      save();
      refreshEntityList();
      toastr.info('Аватар удалён');
    });

    // Click thumb → open zoom
    $list.find('.avg-thumb:not(.avg-thumb-add)').off('click').on('click', function () {
      const entityId = $(this).closest('.avg-entity-card').data('entity-id');
      const index = $(this).data('index');
      const gallery = getEntityGallery(entityId);
      if (gallery.images.length > 0) {
        currentOverlayIndex = index + 1; // +1 because index 0 is original avatar
        showZoomOverlay(entityId);
      }
    });
  }

  // ─── Utils ───────────────────────────────────────────────────────

  function escHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  // ─── Events ──────────────────────────────────────────────────────

  function wireEvents() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.APP_READY, async () => {
      await mountSettingsUi();
      setupAvatarClickHandlers();
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
      refreshEntityList();
      // Re-apply gallery avatar if one was set
      setTimeout(() => {
        const entities = getActiveEntities();
        for (const entity of entities) {
          const gallery = getEntityGallery(entity.id);
          if (gallery.images.length > 0 && gallery.activeIndex > 0) {
            const imgIdx = gallery.activeIndex - 1; // -1 because 0 is original
            if (gallery.images[imgIdx]) {
              applyAvatarToChat(entity, gallery.images[imgIdx].full);
            }
          }
        }
      }, 500);
    });
  }

  // ─── Boot ────────────────────────────────────────────────────────

  jQuery(() => {
    try {
      wireEvents();
      console.log('[AvatarGallery] v1.0.0 loaded');
    } catch (e) {
      console.error('[AvatarGallery] init failed', e);
    }
  });

})();
