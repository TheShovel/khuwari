// Paint: the layer stack, compositing, onion skin and playhead sync.
'use strict';

  function getKf(id) {
    for (var i = 0; i < state.keyframes.length; i++) if (state.keyframes[i].id === id) return state.keyframes[i];
    return null;
  }

  // Render base + all visible layers onto the on-screen canvas, then draw the
  // tool overlay (selection ants, crop rect, transform handles) on top.
  function compositeDisplay() {
    if (!paintDispCtx) return;
    paintDispCtx.setTransform(1, 0, 0, 1, 0, 0);
    paintDispCtx.clearRect(0, 0, workW, workH);
    // NOTE: onion ghosts are NOT drawn into this composite pixel buffer. They
    // are rendered on the display-only overlay canvas (see renderOverlay), so
    // they are always visible on top of the frame being painted AND never leak
    // into saves (canvasToURL) or the eyedropper.
    if (paintBaseCanvas) paintDispCtx.drawImage(paintBaseCanvas, 0, 0, workW, workH);
    paintLayers.forEach(function (l) {
      if (!l.visible) return;
      var src = l.canvas;
      // during a masked stroke, show the scratch in place of the active layer
      // so the preview never bleeds (mirrors commitSelScratch: brushes overlay
      // the mask-clipped dabs - untouched pixels composite as an identity - and
      // erasers carve only the erased spots)
      if (l === selScratchLayer && selScratchCv) {
        var tmp = document.createElement('canvas');
        tmp.width = workW; tmp.height = workH;
        var tg = tmp.getContext('2d');
        tg.drawImage(l.canvas, 0, 0);
        var masked = document.createElement('canvas');
        masked.width = workW; masked.height = workH;
        var tm = masked.getContext('2d');
        tm.drawImage(selScratchCv, 0, 0);
        if (selMaskCv) { tm.globalCompositeOperation = 'destination-in'; tm.drawImage(selMaskCv, 0, 0); }
        if ((eraserOn || (current && current.eraser)) && selScratchOrig && selMaskCv) {
          var holes = document.createElement('canvas');
          holes.width = workW; holes.height = workH;
          var hg = holes.getContext('2d');
          hg.drawImage(selScratchOrig, 0, 0);
          hg.globalCompositeOperation = 'destination-out';
          hg.drawImage(selScratchCv, 0, 0);
          hg.globalCompositeOperation = 'destination-in';
          hg.drawImage(selMaskCv, 0, 0);
          tg.save();
          tg.globalCompositeOperation = 'destination-out';
          tg.drawImage(holes, 0, 0);
          tg.restore();
        } else {
          // brush/line/shape: preview = layer + the mask-clipped new dabs
          // (the masked scratch holds only the dabs, never the layer itself)
          tg.drawImage(masked, 0, 0);
        }
        src = tmp;
      }
      paintDispCtx.globalAlpha = l.opacity;
      paintDispCtx.globalCompositeOperation = l.blend || 'source-over';
      paintDispCtx.drawImage(src, 0, 0, workW, workH);
      paintDispCtx.globalAlpha = 1;
      paintDispCtx.globalCompositeOperation = 'source-over';
    });
    renderOverlay();
  }

  // onion skin: ghosts of neighbouring keyframes while painting

  // Fit an image into the work canvas, preserving aspect ratio (letterboxed),
  // so ghost frames drawn at other resolutions are not distorted.
  function onionDrawContain(ctx, img, dw, dh) {
    var iw = img.naturalWidth || img.width || dw;
    var ih = img.naturalHeight || img.height || dh;
    if (!iw || !ih) { ctx.drawImage(img, 0, 0, dw, dh); return; }
    var s = Math.min(dw / iw, dh / ih);
    var w = Math.round(iw * s), h = Math.round(ih * s);
    ctx.drawImage(img, (dw - w) / 2, (dh - h) / 2, w, h);
  }

  // Ghost frames follow the PLAYHEAD (like the main viewport's onion skin):
  // "before" = the last `before` keyframes on the relevant layer at or before
  // the playhead, "after" = the first `after` keyframes strictly after it. The
  // layer is the edited keyframe's own when repainting one, otherwise the
  // active timeline layer (generic paint mode).
  // Repainting an existing keyframe skips the frame under the playhead (it is
  // the one being drawn, already shown at full opacity), so its ghosts are the
  // neighbours. Generic paint mode draws a NEW frame that is not in the timeline
  // yet, so the frame under the playhead is a real neighbour — the reference the
  // new drawing matches against. That is why a project with a SINGLE keyframe
  // still onion-skins there.
  function paintOnionNeighbors() {
    var layerId = null;
    if (editKeyframeId) {
      var kf = getKf(editKeyframeId);
      if (kf) layerId = kf.layer;
    } else if (state.activeLayerId) {
      layerId = state.activeLayerId;
    }
    if (!layerId) return { before: [], after: [] };
    var ks = sortedKeyframes(layerId);
    if (!ks.length) return { before: [], after: [] };
    var t = state.playhead;
    var idx = -1;
    for (var i = 0; i < ks.length; i++) if (ks[i].time <= t + 1e-9) idx = i;
    var b = (state.onionCfg && state.onionCfg.before) | 0;
    var a = (state.onionCfg && state.onionCfg.after) | 0;
    // First before ghost: in edit mode the frame under the playhead is skipped
    // (idx - 1), in generic mode it is included (idx).
    var firstBefore = editKeyframeId ? idx : idx + 1;
    var before = [], after = [];
    for (var j = 1; j <= b; j++) { var k = firstBefore - j; if (k >= 0) before.push(ks[k]); }
    for (var m = 1; m <= a; m++) { var n = idx + m; if (n < ks.length && ks[n].time > t + 1e-9) after.push(ks[n]); }
    if (idx === -1 && !after.length && ks.length) after.push(ks[0]);
    return { before: before, after: after };
  }

  function onionImgFor(kf) {
    if (kf && kf.img != null && onionImgs[kf.img]) return onionImgs[kf.img];
    if (kf && kf.img != null && typeof imgCache !== 'undefined' && imgCache.get) {
      var c = imgCache.get(kf.img);
      if (c) return c;
    }
    return null;
  }

  function loadOnionImages(nb, done) {
    var list = nb.before.concat(nb.after);
    var pending = list.length;
    if (!pending) { done(); return; }
    var seen = {};
    list.forEach(function (kf) {
      var src = kf && kf.img;
      if (!src || seen[src]) { if (--pending === 0) done(); return; }
      seen[src] = true;
      if (onionImgs[src] != null || (typeof imgCache !== 'undefined' && imgCache.get && imgCache.get(src))) {
        if (--pending === 0) done();
        return;
      }
      var im = new Image();
      im.onload = function () { onionImgs[src] = im; if (--pending === 0) done(); };
      im.onerror = function () { onionImgs[src] = null; if (--pending === 0) done(); };
      im.src = src;
    });
  }

  function paintDrawOnion(ctx) {
    if (!state.onion) return;
    var nb = paintOnionNeighbors();
    if (!nb.before.length && !nb.after.length) return;
    var op = state.onionCfg ? state.onionCfg.opacity : 0.28;
    var tint = state.onionCfg && state.onionCfg.tint;
    var tintColor = state.onionCfg && state.onionCfg.tintColor;
    var tintOp = state.onionCfg ? state.onionCfg.tintOpacity : 0.35;
    function drawGhost(kf, alpha) {
      var img = onionImgFor(kf);
      if (!img) return;
      if (!tint || !tintColor) {
        ctx.globalAlpha = alpha;
        onionDrawContain(ctx, img, workW, workH);
        return;
      }
      var c = document.createElement('canvas');
      c.width = workW; c.height = workH;
      var g = c.getContext('2d');
      g.globalAlpha = alpha;
      onionDrawContain(g, img, workW, workH);
      g.globalCompositeOperation = 'source-atop';
      g.globalAlpha = tintOp;
      g.fillStyle = tintColor;
      g.fillRect(0, 0, workW, workH);
      ctx.globalAlpha = 1;
      ctx.drawImage(c, 0, 0);
    }
    ctx.save();
    for (var i = 0; i < nb.before.length; i++) {
      var fade = 1 - i * 0.22; if (fade < 0.22) fade = 0.22;
      drawGhost(nb.before[i], op * fade);
    }
    for (var x = 0; x < nb.after.length; x++) {
      var fade2 = 1 - x * 0.22; if (fade2 < 0.22) fade2 = 0.22;
      drawGhost(nb.after[x], op * 0.8 * fade2);
    }
    ctx.restore();
  }

  function refreshOnion() {
    if (!state.onion) { compositeDisplay(); return; }
    onionImgs = {};
    loadOnionImages(paintOnionNeighbors(), compositeDisplay);
  }

  function loadOnionPrefs() {
    try {
      var s = localStorage.getItem(ONION_KEY);
      if (s) {
        var o = JSON.parse(s);
        if (typeof o.onion === 'boolean') state.onion = o.onion;
        if (o.cfg) Object.assign(state.onionCfg, o.cfg);
      }
    } catch (e) {}
  }

  function saveOnionPrefs() {
    try { localStorage.setItem(ONION_KEY, JSON.stringify({ onion: state.onion, cfg: state.onionCfg })); } catch (e) {}
  }

  function syncPaintOnionUI() {
    var o = state.onionCfg || {};
    var c = byId('paintOnion'); if (c) c.checked = !!state.onion;
    setVal('paintOnionBefore', o.before | 0, String(o.before | 0));
    setVal('paintOnionAfter', o.after | 0, String(o.after | 0));
    setVal('paintOnionOpacity', o.opacity, Math.round((o.opacity == null ? 0.28 : o.opacity) * 100) + '%');
    var t = byId('paintOnionTint'); if (t) t.checked = !!o.tint;
  }

  // Playhead scrubber: moves the timeline playhead so the onion ghosts follow
  // it (like the main viewport) and the timeline stays in sync when the editor
  // closes. The slider ranges over the whole timeline and snaps to whole frames.
  function syncPaintPlayheadUI() {
    var s = byId('paintPlayhead');
    if (!s) return;
    var max = (typeof playbackEnd === 'function') ? playbackEnd() : 1;
    if (!isFinite(max) || max <= 0) max = 1;
    s.min = 0;
    s.max = String(max);
    s.step = String((state.fps && state.fps > 0) ? (1 / state.fps) : 0.01);
    s.value = String(clamp(state.playhead || 0, 0, max));
    syncSlider(s);
    var lab = byId('paintPlayheadVal');
    if (lab) lab.textContent = fmtTime(state.playhead || 0);
  }

  function addLayer(name, makeActive) {
    if (makeActive === undefined) makeActive = true;
    layerSeq++;
    var cv = document.createElement('canvas');
    cv.width = workW; cv.height = workH;
    var layer = { id: 'PL' + layerSeq, name: name || ('Layer ' + layerSeq), visible: true, opacity: 1, blend: 'source-over', canvas: cv };
    paintLayers.push(layer);
    if (makeActive || !activeLayer) activeLayer = layer;
    paintCtx = activeLayer.canvas.getContext('2d');
    rebuildLayerUI();
    return layer;
  }

  // Delete a specific layer (defaults to the active one). Keeps at least one.
  function deleteActiveLayer(target) {
    var idx = target ? paintLayers.indexOf(target) : paintLayers.indexOf(activeLayer);
    if (idx < 0) return;
    if (paintLayers.length <= 1) { toast('Keep at least one layer'); return; }
    paintLayers.splice(idx, 1);
    if (target === activeLayer || !activeLayer || paintLayers.indexOf(activeLayer) < 0) {
      activeLayer = paintLayers[Math.min(idx, paintLayers.length - 1)];
    }
    paintCtx = activeLayer.canvas.getContext('2d');
    resetHistory();
    rebuildLayerUI();
    compositeDisplay();
  }

  function moveLayer(idx, delta) {
    var ni = idx + delta;
    if (ni < 0 || ni >= paintLayers.length) return;
    var tmp = paintLayers[idx];
    paintLayers[idx] = paintLayers[ni];
    paintLayers[ni] = tmp;
    rebuildLayerUI();
    compositeDisplay();
  }

  // Collapse a layer into the one directly beneath it (defaults to the active
  // layer). Respects each layer's visibility + opacity, so the on-screen
  // result is unchanged.
  function mergeDown(target) {
    var idx = target ? paintLayers.indexOf(target) : paintLayers.indexOf(activeLayer);
    if (idx <= 0) { toast('Already at the bottom'); return; }
    var below = paintLayers[idx - 1];
    var src = paintLayers[idx];
    var mc = document.createElement('canvas');
    mc.width = workW; mc.height = workH;
    var mctx = mc.getContext('2d');
    if (below.visible) { mctx.globalAlpha = below.opacity; mctx.drawImage(below.canvas, 0, 0, workW, workH); }
    if (src.visible) { mctx.globalAlpha = src.opacity; mctx.drawImage(src.canvas, 0, 0, workW, workH); }
    mctx.globalAlpha = 1;
    below.canvas = mc;
    below.opacity = 1;
    below.visible = !!(below.visible || src.visible);
    paintLayers.splice(idx, 1);
    if (src === activeLayer || paintLayers.indexOf(activeLayer) < 0) activeLayer = below;
    paintCtx = below.canvas.getContext('2d');
    resetHistory();
    rebuildLayerUI();
    compositeDisplay();
  }

  // Small inline SVG icons used by the layer docker, in the same stroke style
  // as the rest of the UI (currentColor, 2px round joins).
  function layerEyeIcon(on) {
    return on
      ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  }

  var LAYER_THUMBS = 32;

  function getLayerById(id) {
    for (var i = 0; i < paintLayers.length; i++) if (paintLayers[i].id === id) return paintLayers[i];
    return null;
  }

  // Redraw every layer row's thumbnail (called after a stroke/tool updates the
  // active layer, so the docker previews stay in sync without a full rebuild).
  function refreshLayerThumbs() {
    var list = byId('paintLayerList');
    if (!list) return;
    var nodes = list.querySelectorAll('canvas.paint-layer-thumb');
    for (var i = 0; i < nodes.length; i++) {
      var cv = nodes[i];
      var l = cv.dataset.lid ? getLayerById(cv.dataset.lid) : null;
      if (!l || !l.canvas) continue;
      var tg = cv.getContext('2d');
      tg.clearRect(0, 0, LAYER_THUMBS, LAYER_THUMBS);
      try { tg.drawImage(l.canvas, 0, 0, workW, workH, 0, 0, LAYER_THUMBS, LAYER_THUMBS); } catch (e) {}
    }
  }

  // Clean Krita-style layer rows: thumbnail + visibility eye + name. Split
  // actions (move/merge/delete) live in the docker toolbar and act on the
  // ACTIVE layer; the opacity/blend controls below edit that layer too.
  function rebuildLayerUI() {
    var list = byId('paintLayerList');
    if (!list) return;
    list.innerHTML = '';
    for (var i = paintLayers.length - 1; i >= 0; i--) {
      var l = paintLayers[i];
      (function (l) {
        var row = document.createElement('div');
        row.className = 'paint-layer' + (l === activeLayer ? ' active' : '');
        var thumb = document.createElement('canvas');
        thumb.className = 'paint-layer-thumb';
        thumb.width = LAYER_THUMBS; thumb.height = LAYER_THUMBS;
        thumb.dataset.lid = l.id;
        row.appendChild(thumb);
        var name = document.createElement('span');
        name.className = 'paint-layer-name';
        name.textContent = l.name;
        name.title = 'Select layer (double-click to rename)';
        row.appendChild(name);
        var eye = document.createElement('button');
        eye.type = 'button';
        eye.className = 'paint-layer-eye' + (l.visible ? '' : ' off');
        eye.title = l.visible ? 'Hide layer' : 'Show layer';
        eye.innerHTML = layerEyeIcon(l.visible);
        row.appendChild(eye);
        // initial thumbnail
        var tg = thumb.getContext('2d');
        try { tg.drawImage(l.canvas, 0, 0, workW, workH, 0, 0, LAYER_THUMBS, LAYER_THUMBS); } catch (e) {}
        eye.addEventListener('click', function (e) {
          e.stopPropagation();
          l.visible = !l.visible;
          eye.className = 'paint-layer-eye' + (l.visible ? '' : ' off');
          eye.innerHTML = layerEyeIcon(l.visible);
          eye.title = l.visible ? 'Hide layer' : 'Show layer';
          compositeDisplay();
        });
        name.addEventListener('click', function () {
          activeLayer = l; paintCtx = l.canvas.getContext('2d'); resetHistory();
          rebuildLayerUI();
          syncLayerProps();
        });
        // Double-click the layer name to rename it inline.
        name.addEventListener('dblclick', function (e) {
          e.stopPropagation();
          var input = document.createElement('input');
          input.type = 'text';
          input.className = 'paint-layer-name-input';
          input.value = l.name;
          input.maxLength = 64;
          name.replaceWith(input);
          input.focus();
          input.select();
          var done = function (commit) {
            var v = commit ? input.value.trim() : l.name;
            if (v && v !== l.name) l.name = v;
            rebuildLayerUI();
            syncLayerProps();
          };
          input.addEventListener('keydown', function (ev) {
            ev.stopPropagation();
            if (ev.key === 'Enter') done(true);
            else if (ev.key === 'Escape') done(false);
          });
          input.addEventListener('blur', function () { done(true); });
          input.addEventListener('click', function (ev) { ev.stopPropagation(); });
        });
        list.appendChild(row);
      })(l);
    }
    syncLayerProps();
  }

  // Refresh the docker toolbar enabled-states and the active layer's
  // opacity/blend controls.
  function syncLayerProps() {
    var idx = paintLayers.indexOf(activeLayer);
    var o = byId('paintLayerOpacity');
    if (o && activeLayer) {
      o.value = String(activeLayer.opacity);
      syncSlider(o);
      var on = byId('paintLayerOpacityNum');
      if (on) on.value = String(Math.round(activeLayer.opacity * 100));
    }
    var b = byId('paintLayerBlend');
    if (b && activeLayer) b.value = activeLayer.blend || 'source-over';
    var up = byId('btnPaintLayerUp'); if (up) up.disabled = idx >= paintLayers.length - 1;
    var down = byId('btnPaintLayerDown'); if (down) down.disabled = idx <= 0;
    var mer = byId('btnPaintMergeDown'); if (mer) mer.disabled = idx <= 0;
    var del = byId('btnPaintDelLayer'); if (del) del.disabled = paintLayers.length <= 1;
  }

  // A layer contributes nothing if it has no painted (non-transparent) pixels.
  function layerHasInk(l) {
    try {
      var d = l.canvas.getContext('2d').getImageData(0, 0, workW, workH).data;
      for (var i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
    } catch (e) {}
    return false;
  }

  // Snapshot the current stack (layer pixels -> data URLs) for project save.
  // Empty layers are dropped since they add nothing to the composite.
  function capturePaintLayers() {
    return paintLayers.filter(layerHasInk).map(function (l) {
      return { name: l.name, visible: !!l.visible, opacity: l.opacity, blend: l.blend || 'source-over', img: l.canvas.toDataURL('image/png') };
    });
  }

  // Rebuild the layer stack (optionally from saved data URLs). When no saved
  // stack is given we just start with one empty layer. `onReady` fires once any
  // saved layer images have finished decoding (or immediately when there are
  // none), which is when the composite is stable enough to capture a baseline.
  function restorePaintLayers(arr, onReady) {
    paintLayers = [];
    activeLayer = null;
    layerSeq = 0;
    var pending = 0;
    function tick() { if (--pending === 0 && onReady) onReady(); }
    (arr || []).forEach(function (d) {
      var cv = document.createElement('canvas');
      cv.width = workW; cv.height = workH;
      var layer = {
        id: 'PL' + (++layerSeq),
        name: d.name || ('Layer ' + layerSeq),
        visible: d.visible !== false,
        opacity: (d.opacity == null ? 1 : d.opacity),
        blend: d.blend || 'source-over',
        canvas: cv
      };
      if (d.img) {
        pending++;
        var im = new Image();
        im.onload = function () { cv.getContext('2d').drawImage(im, 0, 0, workW, workH); compositeDisplay(); tick(); };
        im.onerror = function () { tick(); };
        im.src = d.img;
      }
      paintLayers.push(layer);
    });
    if (!paintLayers.length) addLayer('Layer 1', true);
    activeLayer = paintLayers[paintLayers.length - 1];
    paintCtx = activeLayer.canvas.getContext('2d');
    rebuildLayerUI();
    if (pending === 0 && onReady) onReady();
  }

  function savePaintLayersToKeyframe(kf) {
    if (!kf) return;
    var real = capturePaintLayers();
    if (!real.length) { kf.paintLayers = undefined; return; }
    // A single fully-opaque, visible layer whose pixels already equal the flattened
    // image is perfectly reconstructed on reopen by seeding kf.img into layer 1, so
    // storing it again would only bloat the project file. Skip it.
    if (real.length === 1 && real[0].visible !== false && real[0].opacity === 1 && real[0].img === kf.img) {
      kf.paintLayers = undefined;
      return;
    }
    kf.paintLayers = real;
  }
