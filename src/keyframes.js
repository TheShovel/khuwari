'use strict';


  // Insert time for new keyframes: the playhead (button/paste) or the exact
  // drop position. Snap rounds it to a frame boundary. Falls back to the
  // playhead when no time is given, so frames never silently land at the end
  // of the timeline.
  function insertTime(t) {
    if (t === undefined) t = state.playhead;
    t = Math.max(0, t);
    if (state.snap) t = Math.round(t * state.fps) / state.fps;
    return t;
  }

  // Add files to the image library only; nothing is placed on the timeline.
  // Keyframes are created by dragging an asset from the panel onto the
  // timeline (see addAssetKeyframe).
  function addImageFiles(files) {
    recordUndo('assets');
    if (!files || !files.length) return Promise.resolve({ added: 0, failed: 0 });
    var list = Array.prototype.slice.call(files);
    var added = 0;
    var failed = 0;
    var idx = 0;
    function next() {
      if (idx >= list.length) return;
      var file = list[idx++];
      return readImageFile(file).then(function (data) {
        if (state.assets.some(function (a) { return a.img === data.img; })) return;
        state.assets.push({ img: data.img, name: data.name, w: data.w, h: data.h });
        added++;
      }).catch(function () {
        // One bad file must not drop the rest of the batch.
        failed++;
      }).then(next);
    }
    var workers = [];
    var concurrency = Math.min(3, list.length);
    for (var i = 0; i < concurrency; i++) workers.push(next());
    return Promise.all(workers).then(function () {
      renderAssets();
      return { added: added, failed: failed };
    });
  }
  // Place a keyframe reusing an image already in the library (asset drag & drop).
  // The image is already decoded, so unlike addImageFiles there is no file read.
  // The layer new keyframes land on: the active layer when it's a normal
  // layer, otherwise the topmost normal layer (fill layers hold dots, not
  // keyframes).
  function keyframeLayerId() {
    var L = layerById(state.activeLayerId);
    if (L && L.type !== 'fill') return L.id;
    for (var i = 0; i < state.layers.length; i++) {
      if (state.layers[i].type !== 'fill') return state.layers[i].id;
    }
    return state.layers[0].id;
  }

  function addAssetKeyframe(imgSrc, atTime) {
    recordUndo();
    var meta = null;
    for (var i = 0; i < assetCache.length; i++) {
      if (assetCache[i].img === imgSrc) { meta = assetCache[i]; break; }
    }
    state.keyframes.push({
      id: 'k' + (idSeq++),
      layer: keyframeLayerId(),
      time: insertTime(atTime),
      img: imgSrc,
      name: meta ? meta.name : 'asset',
      w: meta ? meta.w : workW,
      h: meta ? meta.h : workH
    });
    applyWorkSize();
    invalidateAll();
    renderAll();
    scheduleGenerate();
  }

  function selectKeyframe(id) {
    state.selectedId = id;
    state.selectedGapId = null;
    state.selectedDotId = null;
    var kf = state.keyframes.find(function (k) { return k.id === id; });
    if (kf && kf.layer) state.activeLayerId = kf.layer;
    renderSelectedPanel();
    renderLayerPanel();
    renderLane();
    // The active layer may have changed: drop/restore the camera (see
    // cameraActive) and refresh the locked panel state.
    renderPreview();
    if (typeof renderCameraPanel === 'function') renderCameraPanel();
  }

  function replaceKeyframeImage(id) {
    var kf = state.keyframes.find(function (k) { return k.id === id; });
    if (!kf) return;
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) return;
      readImageFile(file).then(function (data) {
        recordUndo();
        kf.img = data.img;
        kf.name = data.name;
        kf.w = data.w;
        kf.h = data.h;
        // The replacement image is a newly loaded image: add it to the library.
        if (!state.assets.some(function (a) { return a.img === data.img; })) {
          state.assets.push({ img: data.img, name: data.name, w: data.w, h: data.h });
        }
        invalidateAround(id);
        applyWorkSize();
        renderAll();
        scheduleGenerate();
      }).catch(function (e) { toast(e.message); });
    };
    input.click();
  }

  function deleteKeyframe(id) {
    var idx = state.keyframes.findIndex(function (k) { return k.id === id; });
    if (idx === -1) return;
    recordUndo();
    invalidateAround(id);
    state.keyframes.splice(idx, 1);
    if (state.selectedId === id) state.selectedId = null;
    applyWorkSize();
    refreshDirty();
    renderAll();
    scheduleGenerate();
  }

  // Right-click menu for keyframes: copy / paste / delete. Copy remembers the
  // frame's image and options (hold, blend, size); paste drops a fresh keyframe
  // at the playhead on the copied frame's layer, so you can reuse one drawing
  // across the timeline. The clipboard survives pastes (paste repeatedly).
  function copyKeyframe(id) {
    var kf = state.keyframes.find(function (k) { return k.id === id; });
    if (!kf) return;
    copiedKeyframe = {
      img: kf.img,
      name: kf.name,
      w: kf.w,
      h: kf.h,
      hold: kf.hold,
      mix: kf.mix,
      layer: kf.layer
    };
    toast('Frame copied');
  }

  function pasteKeyframe(atTime, layerId) {
    recordUndo();
    if (!copiedKeyframe) return null;
    var layer = layerById(layerId || copiedKeyframe.layer);
    if (!layer || layer.type === 'fill') layer = layerById(keyframeLayerId());
    var kf = {
      id: 'k' + (idSeq++),
      layer: layer.id,
      time: insertTime(atTime),
      img: copiedKeyframe.img,
      name: copiedKeyframe.name,
      w: copiedKeyframe.w,
      h: copiedKeyframe.h
    };
    if (copiedKeyframe.hold != null) kf.hold = copiedKeyframe.hold;
    if (copiedKeyframe.mix) kf.mix = copiedKeyframe.mix;
    state.keyframes.push(kf);
    state.selectedId = kf.id;
    applyWorkSize();
    invalidateAll();
    renderAll();
    scheduleGenerate();
    return kf;
  }

  // The context menu is a single fixed-position element shared by keyframes
  // and color dots; showKfMenu positions it at the cursor and enables the
  // items that apply. Right-clicking a chip selects it first, so the menu
  // always acts on what you clicked. Dot mode swaps the labels to Copy/Paste
  // dot and hides the paint entry (dots have no paint editor).
  function showKfMenu(clientX, clientY, kfId, pasteAt, pasteLayer, dotId, dotTarget) {
    hideKfMenu();
    var dotMode = !!(dotId || dotTarget);
    var menu = el.kfMenu;
    menu.style.left = clientX + 'px';
    menu.style.top = clientY + 'px';
    menu.classList.remove('hidden');
    var r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 6) menu.style.left = Math.max(6, clientX - r.width) + 'px';
    if (r.bottom > window.innerHeight - 6) menu.style.top = Math.max(6, clientY - r.height) + 'px';
    menu._kfId = kfId || null;
    menu._dotId = dotId || null;
    menu._pasteAt = pasteAt;
    menu._pasteLayer = pasteLayer;
    menu._pasteDot = dotMode;
    el.kfMenuDelete.classList.toggle('disabled', !kfId && !dotId);
    el.kfMenuCopy.classList.toggle('disabled', !kfId && !dotId);
    // Paste needs the clipboard for the target type: a dot for dot targets,
    // a keyframe for frame targets. This keeps the item from being a no-op
    // when the other clipboard holds something.
    el.kfMenuPaste.classList.toggle('disabled', !(dotMode ? copiedDot : copiedKeyframe));
    var paintBtn = byId('btnKfPaint');
    if (paintBtn) paintBtn.classList.toggle('hidden', dotMode);
    var sep = menu.querySelector('.menu-sep');
    if (sep) sep.classList.toggle('hidden', dotMode);
    var word = dotMode ? 'dot' : 'frame';
    el.kfMenuCopy.querySelector('span').textContent = 'Copy ' + word;
    el.kfMenuPaste.querySelector('span').textContent = 'Paste ' + word;
    el.kfMenuDelete.querySelector('span').textContent = 'Delete ' + word;
  }

  function hideKfMenu() {
    el.kfMenu.classList.add('hidden');
  }

  // Turn a composite playback frame into a keyframe on the active layer. The
  // composite image becomes a new keyframe; the layer's gaps split there and
  // regenerate.
  function promoteToKeyframe(f) {
    var layerId = keyframeLayerId();
    recordUndo();
    return compositeDataURL(f.time).then(function (url) {
      state.keyframes.push({
        id: 'k' + (idSeq++),
        layer: layerId,
        time: f.time,
        img: url,
        name: 'promoted',
        w: workW,
        h: workH
      });
      state.selectedId = state.keyframes[state.keyframes.length - 1].id;
      applyWorkSize();
      refreshDirty();
      renderAll();
      scheduleGenerate();
      toast('Promoted to keyframe at ' + fmtTime(f.time));
    });
  }
