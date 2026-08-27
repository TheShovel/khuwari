'use strict';


  // Assets panel (left column): the image library (state.assets). Loading a
  // file only adds it to the library; keyframes are placed by dragging an
  // asset onto the timeline. Tiles use a custom pointer drag (native HTML5
  // DnD cursors are browser-controlled and often show a no-drop X, so the
  // drag uses its own ghost with a grabbing cursor). An asset lands only
  // when released over the timeline.

  var assetDrag = { active: false, ghost: null, spring: null, anim: 0 };
  var dropGuide = null;

  function showDropGuideAt(clientX) {
    if (!dropGuide) {
      dropGuide = document.createElement('div');
      dropGuide.className = 'drop-guide';
      el.track.appendChild(dropGuide);
      var label = document.createElement('span');
      label.className = 'drop-guide-label';
      dropGuide.appendChild(label);
    }
    var t = Math.max(0, timeFromClientX(clientX));
    dropGuide.style.left = (GUTTER_W + t * state.zoom) + 'px';
    // The line follows the cursor; the label shows the snapped placement.
    dropGuide.querySelector('.drop-guide-label').textContent = fmtTime(insertTime(t));
    dropGuide.classList.add('visible');
  }

  function hideDropGuide() {
    if (dropGuide) dropGuide.classList.remove('visible');
  }

  function isOverTimeline(clientX, clientY) {
    var r = el.timeline.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  // Swing physics for the drag ghost: the card follows the cursor on a soft
  // position spring and tilts toward its own velocity. Rotation and the
  // drop-in scale are damped springs, so the card swings while moving, settles
  // with a small wobble when it stops, and bounces slightly on pickup.
  var GHOST_W2 = 28; // half of .asset-ghost width/height (56px)
  function ghostFrame() {
    var g = assetDrag.ghost, s = assetDrag.spring;
    if (!g || !s) { assetDrag.anim = 0; return; }
    s.x += (s.tx - s.x) * 0.32;
    s.y += (s.ty - s.y) * 0.32;
    // Smoothed velocity from the cursor's movement.
    var vx = s.tx - s.px, vy = s.ty - s.py;
    s.px = s.tx; s.py = s.ty;
    s.vx = s.vx * 0.78 + vx * 0.22;
    s.vy = s.vy * 0.78 + vy * 0.22;
    // Damped rotation spring toward the velocity tilt (radians).
    var target = clamp(s.vx * 0.052 + s.vy * 0.018, -0.42, 0.42);
    s.rotV += (target - s.rot) * 0.045 - s.rotV * 0.13;
    s.rot += s.rotV;
    // Damped scale spring: 0.6 to 1 on pickup, with a slight overshoot bounce.
    s.scaleV += (1 - s.scale) * 0.05 - s.scaleV * 0.16;
    s.scale += s.scaleV;
    g.style.transform = 'translate(' + (s.x - GHOST_W2) + 'px,' + (s.y - GHOST_W2) + 'px)' +
      ' rotate(' + (s.rot * 57.2958) + 'deg) scale(' + s.scale + ')';
    assetDrag.anim = requestAnimationFrame(ghostFrame);
  }

  function beginAssetDrag(a, startX, startY) {
    assetDrag.active = true;
    document.body.classList.add('dragging-asset');
    var ghost = document.createElement('div');
    ghost.className = 'asset-ghost';
    var img = document.createElement('img');
    img.src = a.img;
    img.alt = a.name || 'asset';
    ghost.appendChild(img);
    document.body.appendChild(ghost);
    assetDrag.ghost = ghost;
    assetDrag.spring = {
      x: startX, y: startY, tx: startX, ty: startY, px: startX, py: startY,
      vx: 0, vy: 0, rot: 0, rotV: 0, scale: 0.6, scaleV: 0
    };
    if (assetDrag.anim) cancelAnimationFrame(assetDrag.anim);
    assetDrag.anim = requestAnimationFrame(ghostFrame);
  }

  function moveAssetDrag(clientX, clientY) {
    var s = assetDrag.spring;
    if (s) { s.tx = clientX; s.ty = clientY; }
    if (isOverTimeline(clientX, clientY)) showDropGuideAt(clientX);
    else hideDropGuide();
  }

  function endAssetDrag(a, clientX, clientY) {
    if (assetDrag.anim) { cancelAnimationFrame(assetDrag.anim); assetDrag.anim = 0; }
    if (assetDrag.ghost) { assetDrag.ghost.remove(); assetDrag.ghost = null; }
    assetDrag.spring = null;
    assetDrag.active = false;
    document.body.classList.remove('dragging-asset');
    hideDropGuide();
    if (isOverTimeline(clientX, clientY)) {
      addAssetKeyframe(a.img, insertTime(timeFromClientX(clientX)));
    }
  }

  function startAssetPointerDrag(e, a) {
    if (e.button !== 0) return;
    var startX = e.clientX, startY = e.clientY;
    var dragging = false;
    function onMove(ev) {
      if (!dragging) {
        // Small movement threshold so a plain click never starts a drag.
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 4) return;
        dragging = true;
        beginAssetDrag(a, startX, startY);
      }
      moveAssetDrag(ev.clientX, ev.clientY);
    }
    function onUp(ev) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      if (dragging) endAssetDrag(a, ev.clientX, ev.clientY);
      // On narrow screens the assets live in a drawer that covers the preview,
      // so dragging onto the timeline is awkward; a plain tap places the image
      // at the playhead instead. Desktop keeps drag-only behavior.
      else if (window.innerWidth <= 860) addAssetKeyframe(a.img, insertTime(state.playhead));
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  // layer reordering
  // Drag a layer's name gutter up/down to move it in the stack. The row under
  // the cursor determines the target index; the lane re-renders live so the
  // dragged layer visibly jumps to its new position. Composite order (top →
  // bottom = first → last in state.layers) only changes on drop.
  var layerDragId = null; // layer being dragged (also highlights its row)
  // Layer rows have mixed heights now (fill layers are thin), so pick the row
  // whose midpoint is nearest below the cursor instead of assuming a uniform
  // height.
  function layerIndexAtY(clientY) {
    var rows = el.lane.querySelectorAll('.layer-row');
    if (!rows.length) return 0;
    var laneRect = el.lane.getBoundingClientRect();
    var y = clientY - laneRect.top;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i].getBoundingClientRect();
      var mid = (r.top - laneRect.top) + r.height / 2;
      if (y < mid) return i;
    }
    return rows.length - 1;
  }
  function startLayerDrag(e, layerId) {
    if (e.button !== 0 || state.layers.length < 2) return;
    var startY = e.clientY;
    var dragging = false;
    document.body.classList.add('dragging-layer');
    function onMove(ev) {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) < 4) return;
        dragging = true;
      }
      var from = state.layers.findIndex(function (l) { return l.id === layerId; });
      if (from === -1) return;
      var to = layerIndexAtY(ev.clientY);
      if (to === from) return;
      recordUndo('layerreorder');
      var layer = state.layers[from];
      state.layers.splice(from, 1);
      state.layers.splice(to, 0, layer);
      layerDragId = layerId;
      renderLane();
    }

    function onUp(ev) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('dragging-layer');
      layerDragId = null;
      renderLane();
      renderPreview();
      renderFilmstrip();
      // Reordering changes which fills color each layer, so the baked gap
      // composites (and their stamps) change: regenerate.
      refreshDirty();
      scheduleGenerate(60);
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  function renderAssets() {
    var imgs = state.assets;
    // Rebuild only when the actual image set changed (compare srcs, not the
    // tile count: remove one and add another of the same size otherwise keeps
    // a stale panel).
    var srcs = imgs.map(function (a) { return a.img; });
    var changed = srcs.length !== assetImgs.size;
    if (!changed) {
      for (var i = 0; i < srcs.length; i++) {
        if (!assetImgs.has(srcs[i])) { changed = true; break; }
      }
    }
    assetImgs = new Set(srcs);
    if (!changed) return;
    assetCache = imgs.slice();
    el.assetGrid.innerHTML = '';
    if (!imgs.length) {
      var empty = document.createElement('div');
      empty.className = 'asset-empty';
      empty.textContent = 'No images yet. Add images with the button above, then drag them onto the timeline.';
      el.assetGrid.appendChild(empty);
      return;
    }
    imgs.forEach(function (a) {
      var tile = document.createElement('div');
      tile.className = 'asset';
      tile.title = 'Drag onto the timeline to place a keyframe';
      var img = document.createElement('img');
      img.src = a.img;
      img.alt = a.name || 'asset';
      tile.appendChild(img);
      var name = document.createElement('span');
      name.className = 'asset-name';
      name.textContent = a.name || 'image';
      name.title = a.name || 'image';
      tile.appendChild(name);
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'asset-del';
      del.title = 'Remove from library';
      del.textContent = '×';
      del.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        removeAsset(a.img);
      });
      tile.appendChild(del);
      // Paint-made assets keep their editable layer stack: offer a way back in.
      if (a.paintLayers || a.paint) {
        var edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'asset-edit';
        edit.title = 'Edit image in the paint tool (keeps layers, blend modes, opacity)';
        edit.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>';
        edit.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        edit.addEventListener('click', function (e) {
          e.stopPropagation();
          if (typeof openPaint === 'function') openPaint({ asset: a });
        });
        tile.appendChild(edit);
      }
      tile.addEventListener('pointerdown', function (e) { startAssetPointerDrag(e, a); });
      el.assetGrid.appendChild(tile);
    });
  }

  function removeAsset(imgSrc) {
    var i = state.assets.findIndex(function (a) { return a.img === imgSrc; });
    if (i === -1) return;
    recordUndo();
    state.assets.splice(i, 1);
    renderAssets();
  }
