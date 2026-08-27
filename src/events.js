'use strict';


  function wireEvents() {
    // Tactile button feedback: any .btn gets a quick pop animation on press
    // (the CSS .pop keyframes), so buttons feel physical even without a real
    // ripple. Delegated so dynamically-created buttons get it too.
    document.addEventListener('pointerdown', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.btn:not(:disabled)') : null;
      if (!btn) return;
      btn.classList.remove('pop');
      void btn.offsetWidth; // restart the animation if it was still running
      btn.classList.add('pop');
    }, true);
    el.btnAddAssets.addEventListener('click', function () { el.fileInput.click(); });
    byId('btnEmptyAdd').addEventListener('click', function () { el.fileInput.click(); });
    // Loading images only fills the library; place keyframes by dragging an
    // asset from the panel onto the timeline.
    function libraryToast(r) {
      if (!r) return;
      if (r.added > 0) {
        toast(r.added + (r.added === 1 ? ' image added' : ' images added') + ' to your library' + (r.failed ? ', ' + r.failed + ' skipped' : ''));
      } else if (r.failed > 0) {
        toast(r.failed + (r.failed === 1 ? ' image could not be read' : ' images could not be read'));
      }
    }
    el.fileInput.addEventListener('change', function () {
      if (el.fileInput.files && el.fileInput.files.length) {
        addImageFiles(el.fileInput.files).then(libraryToast).catch(function (e) { toast(e.message); });
      }
      el.fileInput.value = '';
    });
    el.btnReplace.addEventListener('click', function () {
      if (state.selectedId) replaceKeyframeImage(state.selectedId);
    });
    el.btnDelete.addEventListener('click', function () {
      if (state.selectedId) deleteKeyframe(state.selectedId);
    });
    el.gapTypeInput.addEventListener('change', function () {
      if (state.selectedGapId) setGapType(state.selectedGapId, el.gapTypeInput.value);
    });
    var squashDebounce = null;
    el.gapSquashAmount.addEventListener('input', function () {
      var v = parseFloat(el.gapSquashAmount.value);
      if (!isFinite(v)) return;
      syncSlider(el.gapSquashAmount);
      el.gapSquashValue.textContent = Math.round(v * 100) + '%';
      el.gapSquashValue.classList.remove('is-auto');
      el.gapSquashAmount.title = Math.round(v * 100) + '%';
      el.gapSquashAuto.disabled = false;
      clearTimeout(squashDebounce);
      squashDebounce = setTimeout(function () { applySquashChange({ amount: v }); }, 160);
    });
    el.gapSquashAmount.addEventListener('change', function () {
      clearTimeout(squashDebounce);
      var v = parseFloat(el.gapSquashAmount.value);
      if (!isFinite(v)) return;
      applySquashChange({ amount: v });
    });
    el.gapSquashCurve.addEventListener('change', function () {
      applySquashChange({ curve: el.gapSquashCurve.value });
    });
    el.gapSquashPreserve.addEventListener('change', function () {
      applySquashChange({ preserve: el.gapSquashPreserve.value });
    });
    el.gapSquashAuto.addEventListener('click', function () {
      applySquashChange({ amount: null });
    });

    var blurDebounce = null;
    el.gapBlurOn.addEventListener('change', function () {
      if (!state.selectedGapId) return;
      var cur = gapBlurOpts(state.selectedGapId);
      applyBlurChange({ on: el.gapBlurOn.checked, intensity: cur.intensity });
    });
    el.gapBlurAmount.addEventListener('input', function () {
      var v = parseFloat(el.gapBlurAmount.value);
      if (!isFinite(v)) return;
      syncSlider(el.gapBlurAmount);
      el.gapBlurValue.textContent = Math.round(v * 100) + '%';
      clearTimeout(blurDebounce);
      blurDebounce = setTimeout(function () { applyBlurChange({ intensity: v }); }, 160);
    });
    el.gapBlurAmount.addEventListener('change', function () {
      clearTimeout(blurDebounce);
      var v = parseFloat(el.gapBlurAmount.value);
      if (!isFinite(v)) return;
      applyBlurChange({ intensity: v });
    });

    el.layerVisible.addEventListener('change', function () {
      var L = layerById(state.activeLayerId);
      if (!L) return;
      L.visible = el.layerVisible.checked;
      // Visibility changes the flattened composite, so every gap's stamp
      // changes and the timeline must regenerate.
      refreshDirty();
      renderAll();
      scheduleGenerate();
    });

    // Color-dot properties (right panel, shown when a dot is selected). Dot
    // edits change the baked composite the gaps interpolate, so the affected
    // gaps must regenerate (the gap stamp carries the fill signature).
    function patchDot(patch) {
      var d = dotById(state.selectedDotId);
      if (!d) return;
      for (var k in patch) d[k] = patch[k];
      if (patch.color) {
        lastDotColor = patch.color;
        try { localStorage.setItem(DOT_COLOR_KEY, lastDotColor); } catch (e) {}
      }
      renderSelectedPanel();
      renderLane();
      renderPreview();
      invalidateDots();
    }
    var dotDebounce = null;
    el.dotColor.addEventListener('input', function () {
      lastDotColor = el.dotColor.value;
      try { localStorage.setItem(DOT_COLOR_KEY, lastDotColor); } catch (e) {}
      patchDot({ color: el.dotColor.value });
    });
    el.dotThreshold.addEventListener('input', function () {
      var v = parseFloat(el.dotThreshold.value);
      if (!isFinite(v)) return;
      syncSlider(el.dotThreshold);
      el.dotThresholdValue.textContent = Math.round(v * 100) + '%';
      clearTimeout(dotDebounce);
      dotDebounce = setTimeout(function () { patchDot({ threshold: v }); }, 120);
    });
    el.dotThreshold.addEventListener('change', function () {
      clearTimeout(dotDebounce);
      var v = parseFloat(el.dotThreshold.value);
      if (isFinite(v)) patchDot({ threshold: v });
    });
    el.dotGrow.addEventListener('input', function () {
      var v = parseFloat(el.dotGrow.value);
      if (!isFinite(v)) return;
      syncSlider(el.dotGrow);
      el.dotGrowValue.textContent = Math.round(v) + 'px';
      clearTimeout(dotDebounce);
      dotDebounce = setTimeout(function () { patchDot({ grow: v }); }, 120);
    });
    el.dotGrow.addEventListener('change', function () {
      clearTimeout(dotDebounce);
      var v = parseFloat(el.dotGrow.value);
      if (isFinite(v)) patchDot({ grow: v });
    });
    el.dotGradOn.addEventListener('change', function () { patchDot({ gradOn: el.dotGradOn.checked }); });
    el.dotGradColor.addEventListener('input', function () { patchDot({ gradColor: el.dotGradColor.value }); });
    el.dotGradDir.addEventListener('change', function () { patchDot({ gradDir: el.dotGradDir.value }); });
    el.dotGradHeight.addEventListener('input', function () {
      var v = parseFloat(el.dotGradHeight.value);
      if (!isFinite(v)) return;
      syncSlider(el.dotGradHeight);
      el.dotGradHeightValue.textContent = Math.round(v) + 'px';
      clearTimeout(dotDebounce);
      dotDebounce = setTimeout(function () { patchDot({ gradHeight: v }); }, 120);
    });
    el.dotGradHeight.addEventListener('change', function () {
      clearTimeout(dotDebounce);
      var v = parseFloat(el.dotGradHeight.value);
      if (isFinite(v)) patchDot({ gradHeight: v });
    });
    el.dotStart.addEventListener('change', function () {
      var d = dotById(state.selectedDotId);
      if (!d) return;
      var v = Math.max(0, parseFloat(el.dotStart.value) || 0);
      d.start = Math.min(v, d.end - 1 / state.fps);
      patchDot({ start: d.start });
    });
    el.dotEnd.addEventListener('change', function () {
      var d = dotById(state.selectedDotId);
      if (!d) return;
      var v = parseFloat(el.dotEnd.value) || 0;
      d.end = Math.max(v, d.start + 1 / state.fps);
      patchDot({ end: d.end });
    });
    el.btnDotDelete.addEventListener('click', function () {
      deleteDot(state.selectedDotId);
      renderSelectedPanel();
      renderLane();
      renderPreview();
      invalidateDots();
    });
    // Copy/paste a dot's fill properties (color, threshold, grow, gradient)
    // onto other dots, so a consistent look can be spread across many dots
    // without re-entering every field. Timing is left alone: a dot's window on
    // the timeline is placement, not part of its look.
    el.btnDotCopy.addEventListener('click', function () {
      var d = dotById(state.selectedDotId);
      if (!d) return;
      copiedDotProps = {
        color: d.color || '#4f8fff',
        threshold: d.threshold != null ? d.threshold : 0.5,
        grow: d.grow != null ? d.grow : 1,
        gradOn: !!d.gradOn,
        gradColor: d.gradColor || '#ffffff',
        gradHeight: d.gradHeight != null ? d.gradHeight : 24,
        gradDir: d.gradDir || 'bottom'
      };
      el.btnDotPaste.disabled = false;
      toast('Dot properties copied');
    });
    el.btnDotPaste.addEventListener('click', function () {
      var d = dotById(state.selectedDotId);
      if (!copiedDotProps || !d) return;
      var p = copiedDotProps;
      d.color = p.color;
      d.threshold = p.threshold;
      d.grow = p.grow;
      d.gradOn = p.gradOn;
      d.gradColor = p.gradColor;
      d.gradHeight = p.gradHeight;
      d.gradDir = p.gradDir;
      // Pasting a color also becomes the last-used color for new dots.
      lastDotColor = p.color;
      try { localStorage.setItem(DOT_COLOR_KEY, lastDotColor); } catch (e) {}
      renderSelectedPanel();
      renderLane();
      renderPreview();
      invalidateDots();
      toast('Dot properties pasted');
    });
    el.btnAddLayer.addEventListener('click', addLayer);
    el.btnAddFillLayer.addEventListener('click', addFillLayer);
    el.btnRemoveLayer.addEventListener('click', function () { removeLayer(state.activeLayerId); });

    // generation (automatic; regenerate button forces a full re-run)
    el.btnRegenerate.addEventListener('click', function () { invalidateAll(); scheduleGenerate(50); });
    function stopCurrentTask() {
      if (state.genRun) cancelRun();
      else if (state.exporting) cancelExport();
      else if (state.mp4Stop) { state.mp4Stop(); state.mp4Stop = null; }
    }
    el.btnCancel.addEventListener('click', stopCurrentTask);
    // The export overlay's Stop always cancels the export itself (generation
    // finishing in the background is harmless once the export is aborted).
    el.btnExportCancelOverlay.addEventListener('click', function () {
      if (state.exporting) cancelExport();
      else stopCurrentTask();
    });

    el.btnPlay.addEventListener('click', togglePlay);
    el.btnLoop.addEventListener('click', function () { state.loop = !state.loop; el.btnLoop.style.opacity = state.loop ? 1 : 0.35; });
    el.btnKeysOnly.addEventListener('click', function () {
      state.keysOnly = !state.keysOnly;
      el.btnKeysOnly.classList.toggle('active', state.keysOnly);
      renderPreview();
    });
    el.btnOnion.addEventListener('click', function () {
      state.onion = !state.onion;
      el.btnOnion.classList.toggle('active', state.onion);
      lastPreview = null;
      renderPreview();
    });
    function onionPatch(patch) { for (var k in patch) state.onionCfg[k] = patch[k]; try { localStorage.setItem(ONION_KEY, JSON.stringify(state.onionCfg)); } catch (e) {} syncOnionUI(); lastPreview = null; renderPreview(); if (el.onionMenu && !el.onionMenu.classList.contains('hidden')) clampMenuToViewport(el.onionMenu); }
    el.onionBefore.addEventListener('input', function () { var v = parseInt(el.onionBefore.value, 10) || 0; syncSlider(el.onionBefore); el.onionBeforeVal.textContent = String(v); clearTimeout(window._onionDeb); window._onionDeb = setTimeout(function () { onionPatch({ before: v }); }, 100); });
    el.onionBefore.addEventListener('change', function () { var v = parseInt(el.onionBefore.value, 10) || 0; onionPatch({ before: v }); });
    el.onionAfter.addEventListener('input', function () { var v = parseInt(el.onionAfter.value, 10) || 0; syncSlider(el.onionAfter); el.onionAfterVal.textContent = String(v); clearTimeout(window._onionDeb2); window._onionDeb2 = setTimeout(function () { onionPatch({ after: v }); }, 100); });
    el.onionAfter.addEventListener('change', function () { var v = parseInt(el.onionAfter.value, 10) || 0; onionPatch({ after: v }); });
    el.onionOpacity.addEventListener('input', function () { var v = parseFloat(el.onionOpacity.value) || 0.28; syncSlider(el.onionOpacity); el.onionOpacityVal.textContent = Math.round(v * 100) + '%'; clearTimeout(window._onionDeb3); window._onionDeb3 = setTimeout(function () { onionPatch({ opacity: v }); }, 100); });
    el.onionOpacity.addEventListener('change', function () { var v = parseFloat(el.onionOpacity.value) || 0.28; onionPatch({ opacity: v }); });
    el.onionTint.addEventListener('change', function () { onionPatch({ tint: el.onionTint.checked }); });
    el.onionTintColor.addEventListener('input', function () { onionPatch({ tintColor: el.onionTintColor.value }); });
    el.onionTintOpacity.addEventListener('input', function () { var v = parseFloat(el.onionTintOpacity.value) || 0.35; syncSlider(el.onionTintOpacity); el.onionTintOpacityVal.textContent = Math.round(v * 100) + '%'; clearTimeout(window._onionDeb4); window._onionDeb4 = setTimeout(function () { onionPatch({ tintOpacity: v }); }, 100); });
    el.onionTintOpacity.addEventListener('change', function () { var v = parseFloat(el.onionTintOpacity.value) || 0.35; onionPatch({ tintOpacity: v }); });
    el.btnStepBack.addEventListener('click', function () { pause(); step(-1); });
    el.btnStepFwd.addEventListener('click', function () { pause(); step(1); });

    el.fpsInput.addEventListener('change', function () {
      state.fps = clamp(parseInt(el.fpsInput.value, 10) || 12, 1, 60);
      el.fpsInput.value = String(state.fps);
      invalidateAll();
      renderAll();
      scheduleGenerate();
    });
    el.snapInput.addEventListener('change', function () { state.snap = el.snapInput.checked; });
    // Aspect ratio + custom dimensions share one path: recompute the working
    // size, re-render, persist, and regenerate anything the size invalidates.
    function changeSizeSetting() {
      state.aspect = el.aspectInput.value;
      state.customW = gridSnap(clamp(parseInt(el.customWInput.value, 10) || 1920, 8, 4096));
      state.customH = gridSnap(clamp(parseInt(el.customHInput.value, 10) || 1080, 8, 4096));
      var s = applyWorkSize();
      syncInputs();
      renderAll();
      scheduleGenerate();
      if (s.w * s.h > 2 * 1024 * 1024) {
        toast('Working size ' + s.w + '×' + s.h + ' is large, generating frames may be slow', 6000);
      }
    }
    el.aspectInput.addEventListener('change', changeSizeSetting);
    el.customWInput.addEventListener('change', changeSizeSetting);
    el.customHInput.addEventListener('change', changeSizeSetting);
    // Manual ratio: type "2.35", "16:9" or "21/9" and it applies directly.
    el.aspectRatioInput.addEventListener('change', function () {
      var r = parseRatio(el.aspectRatioInput.value);
      if (!r) {
        toast('Enter a ratio like 2.35 or 16:9');
        syncInputs();
        return;
      }
      state.aspect = 'manual';
      state.aspectRatio = r;
      var s = applyWorkSize();
      syncInputs();
      renderAll();
      scheduleGenerate();
      if (s.w * s.h > 2 * 1024 * 1024) {
        toast('Working size ' + s.w + '×' + s.h + ' is large, generating frames may be slow', 6000);
      }
    });
    el.resInput.addEventListener('change', function () {
      state.res = parseInt(el.resInput.value, 10) || 512;
      applyWorkSize();
      invalidateAll();
      renderAll();
      scheduleGenerate();
    });
    // Model auto-load: the ML model downloads+compiles once on launch. The loading
    // overlay shows progress; generation falls back to mesh warp if it fails.
    el.btnLoadingRetry.addEventListener('click', function () {
      el.btnLoadingRetry.classList.add('hidden');
      loadModelWithOverlay();
    });

    el.selTimeInput.addEventListener('change', function () {
      var kf = state.keyframes.find(function (k) { return k.id === state.selectedId; });
      if (!kf) return;
      var t = Math.max(0, parseFloat(el.selTimeInput.value) || 0);
      if (state.snap) t = Math.round(t * state.fps) / state.fps;
      invalidateAround(kf.id);
      kf.time = t;
      refreshDirty();
      renderAll();
      scheduleGenerate(300);
    });
    // Keyframe blend mode: only affects the live/export composite (the inbetween
    // composites bake fills at source-over), so a change just re-renders; no
    // gap regeneration needed.
    el.kfMixInput.addEventListener('change', function () {
      var kf = state.keyframes.find(function (k) { return k.id === state.selectedId; });
      if (!kf) return;
      kf.mix = el.kfMixInput.value;
      renderAll();
      renderPreview();
    });

    // Ctrl+wheel zooms the timeline; the canvas wheel/dblclick handle the viewport

    // viewport zoom / pan (preview canvas)
    el.previewCanvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoomViewport(e.deltaY < 0 ? 1.2 : 1 / 1.2, e);
    }, { passive: false });
    el.previewCanvas.addEventListener('dblclick', resetViewport);
    var panState = null;
    // Color-dot editing on the preview: when the active layer is a fill layer,
    // a press on an existing dot drags it to a new position; a press anywhere
    // else places a new dot. Takes precedence over panning so placement works
    // at any zoom.
    var dotDragState = null; // { dot, startNX, startNY, startPX, startPY }
    function dotAt(nx, ny, L) {
      var best = null, bestD = 14; // hit radius in normalized-ish px (14 work px)
      var t = state.playhead;
      (L.dots || []).forEach(function (d) {
        // Only dots active at the current time are shown and draggable.
        if (d.start > t + 1e-9 || t > d.end + 1e-9) return;
        var dx = (d.x - nx) * workW, dy = (d.y - ny) * workH;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestD) { bestD = dist; best = d; }
      });
      return best;
    }
    el.previewCanvas.addEventListener('pointerdown', function (e) {
      var active = layerById(state.activeLayerId);
      if (active && active.type === 'fill') {
        var rect = el.previewCanvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          var nx = clamp((e.clientX - rect.left) / rect.width, 0, 1);
          var ny = clamp((e.clientY - rect.top) / rect.height, 0, 1);
          var cam = cameraActive() ? cameraAt(state.playhead) : null;
          var w = screenToWorld(nx, ny, cam);
          var hit = dotAt(w.x, w.y, active);
          if (hit) {
            state.selectedDotId = hit.id;
            dotDragState = { dot: hit, startNX: w.x, startNY: w.y, startPX: hit.x, startPY: hit.y, moved: false };
            renderLane();
            renderSelectedPanel();
            renderPreview();
          } else {
            var d = addDot(active.id, w.x, w.y);
            if (d) state.selectedDotId = d.id;
            renderPreview();
            renderLane();
            renderSelectedPanel();
            invalidateDots();
          }
          return;
        }
      }
      if (state.viewZoom <= 1) return;
      // A second touch means a pinch is starting; let the pinch handler own the
      // gesture instead of also panning (touch only — a mouse never sets pinch.b).
      if (pinch && pinch.a && pinch.b) return;
      panState = { x: e.clientX, y: e.clientY };
      el.previewCanvas.classList.add('panning');
      try { el.previewCanvas.setPointerCapture(e.pointerId); } catch (err) {}
    });
    el.previewCanvas.addEventListener('pointermove', function (e) {
      var ds = dotDragState;
      if (ds) {
        var rect = el.previewCanvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          var nx = clamp((e.clientX - rect.left) / rect.width, 0, 1);
          var ny = clamp((e.clientY - rect.top) / rect.height, 0, 1);
          var cam = cameraActive() ? cameraAt(state.playhead) : null;
          var w = screenToWorld(nx, ny, cam);
          ds.dot.x = clamp(ds.startPX + (w.x - ds.startNX), 0, 1);
          ds.dot.y = clamp(ds.startPY + (w.y - ds.startNY), 0, 1);
          ds.moved = true;
          renderPreview();
          renderLane();
        }
        return;
      }
      if (!panState || (pinch && pinch.a && pinch.b)) return;
      el.previewWrap.scrollLeft -= e.clientX - panState.x;
      el.previewWrap.scrollTop -= e.clientY - panState.y;
      panState = { x: e.clientX, y: e.clientY };
      updateViewportLabel();
    });
    function endPan() {
      panState = null;
      el.previewCanvas.classList.remove('panning');
      if (dotDragState) {
        if (dotDragState.moved) { invalidateDots(); }
        dotDragState = null;
      }
    }
    el.previewCanvas.addEventListener('pointerup', endPan);
    el.previewCanvas.addEventListener('pointercancel', endPan);

    // Two-finger pinch zoom on the preview (touch). Tracks the two pointers
    // and zooms about their midpoint, same math as the wheel zoom.
    var pinch = null; // { a: {id,x,y}, b: {id,x,y}, dist, zoom }
    function pinchDist() {
      var pa = pinch.a, pb = pinch.b;
      if (!pa || !pb) return 0;
      var dx = pa.x - pb.x, dy = pa.y - pb.y;
      return Math.sqrt(dx * dx + dy * dy);
    }
    el.previewCanvas.addEventListener('pointerdown', function (e) {
      if (!pinch) pinch = { a: null, b: null, dist: 0 };
      if (!pinch.a) pinch.a = { id: e.pointerId, x: e.clientX, y: e.clientY };
      else if (!pinch.b) pinch.b = { id: e.pointerId, x: e.clientX, y: e.clientY };
      if (pinch.a && pinch.b) pinch.dist = pinchDist();
    });
    el.previewCanvas.addEventListener('pointermove', function (e) {
      if (!pinch || !pinch.a || !pinch.b) return;
      if (e.pointerId === pinch.a.id) { pinch.a.x = e.clientX; pinch.a.y = e.clientY; }
      else if (e.pointerId === pinch.b.id) { pinch.b.x = e.clientX; pinch.b.y = e.clientY; }
      else return;
      var d = pinchDist();
      if (pinch.dist > 0 && d > 0) {
        var mid = { clientX: (pinch.a.x + pinch.b.x) / 2, clientY: (pinch.a.y + pinch.b.y) / 2 };
        zoomViewport(d / pinch.dist, mid);
      }
      pinch.dist = d;
    });
    function endPinch(e) {
      if (!pinch) return;
      if (e.pointerId === pinch.a.id) pinch.a = null;
      else if (e.pointerId === pinch.b.id) pinch.b = null;
      if (!pinch.a || !pinch.b) pinch = null;
    }
    el.previewCanvas.addEventListener('pointerup', endPinch);
    el.previewCanvas.addEventListener('pointercancel', endPinch);

    // Drag a layer's name gutter to reorder the stack (bottom → top). The
    // timeline pointerdown handler below still activates the layer on click.
    el.lane.addEventListener('pointerdown', function (e) {
      var gutter = e.target.closest('.layer-gutter');
      if (gutter && gutter.dataset.layer) startLayerDrag(e, gutter.dataset.layer);
    });

    // timeline pointer interactions. Clicking a layer row selects it: the
    // name gutter, or anywhere in the layer's band (which also scrubs).
    // A keyframe chip hidden under the playhead still deserves the click: the
    // playhead strip is only 9px wide, so when it sits on a keyframe the chip
    // would be unselectable and its Delete button would never apply. Prefer
    // the chip when the press overlaps one; the playhead stays grabbable from
    // the ruler and any empty lane space.
    function kfChipAt(clientX, clientY, sel) {
      var chips = el.lane.querySelectorAll(sel || '.kf');
      for (var i = chips.length - 1; i >= 0; i--) { // topmost (last in DOM) first
        var r = chips[i].getBoundingClientRect();
        if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return chips[i];
      }
      return null;
    }
    el.timeline.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return; // right/middle clicks belong to the context menu
      var dotEl = e.target.closest('.fill-dot');
      if (dotEl) { startDotDrag(e, dotEl); return; }
      var chip = e.target.closest('.kf');
      if (chip) {
        if (e.target.closest('.kf-resize')) { startKfResize(e, chip); return; }
        startKfDrag(e, chip);
        return;
      }
      var gapEl = e.target.closest('.gap-overlay');
      if (gapEl) { selectGap(gapEl.dataset.gap); return; }
      if (e.target.closest('.playhead')) {
        var viaDot = kfChipAt(e.clientX, e.clientY, '.fill-dot');
        if (viaDot) { startDotDrag(e, viaDot); return; }
        var via = kfChipAt(e.clientX, e.clientY, '.kf');
        if (via) {
          var vr = via.getBoundingClientRect();
          if (e.clientX >= vr.right - 8) startKfResize(e, via);
          else startKfDrag(e, via);
          return;
        }
        startScrub(e);
        return;
      }
      var camDot = e.target.closest('.cam-dot');
      if (camDot) { startCameraDrag(e, camDot); return; }
      if (e.target.closest('.ruler')) { startScrub(e); return; }
      var row = e.target.closest('.layer-row');
      if (row) {
        activateLayer(row.dataset.layer);
        if (e.target.closest('.layer-content')) startScrub(e);
        return;
      }
      if (e.target.closest('.lane')) startScrub(e);
    });

    // Right-click on the timeline: a keyframe chip gets copy / paste / delete,
    // a color-dot chip gets the same (paste drops a dot at the playhead);
    // empty lane space gets paste into that layer at the clicked time — dots
    // on a fill layer, keyframes on a normal one. The browser's default
    // context menu stays off for the lane so ours can appear.
    el.timeline.addEventListener('contextmenu', function (e) {
      var chip = e.target.closest('.kf');
      if (chip) {
        e.preventDefault();
        selectKeyframe(chip.dataset.id);
        showKfMenu(e.clientX, e.clientY, chip.dataset.id, state.playhead, null);
        return;
      }
      var dotEl = e.target.closest('.fill-dot');
      if (dotEl) {
        e.preventDefault();
        selectDot(dotEl.dataset.dot);
        showKfMenu(e.clientX, e.clientY, null, state.playhead, null, dotEl.dataset.dot, true);
        return;
      }
      var row = e.target.closest('.layer-row');
      if (row && row.dataset.layer && row.dataset.layer !== '') {
        e.preventDefault();
        var t = insertTime(timeFromClientX(e.clientX));
        var rowLayer = layerById(row.dataset.layer);
        showKfMenu(e.clientX, e.clientY, null, t, row.dataset.layer, null, !!(rowLayer && rowLayer.type === 'fill'));
      }
    });
    el.kfMenuCopy.addEventListener('click', function () {
      var id = el.kfMenu._kfId, dot = el.kfMenu._dotId;
      hideKfMenu();
      if (id) copyKeyframe(id);
      else if (dot) copyDot(dot);
    });
    el.kfMenuPaste.addEventListener('click', function () {
      var at = el.kfMenu._pasteAt, layer = el.kfMenu._pasteLayer;
      hideKfMenu();
      // Dot targets paste a dot when one is on the clipboard (keyframe paste
      // stays reachable from them via the same item).
      if (el.kfMenu._pasteDot && copiedDot) pasteDot(at, layer);
      else pasteKeyframe(at, layer);
    });
    el.kfMenuDelete.addEventListener('click', function () {
      var id = el.kfMenu._kfId, dot = el.kfMenu._dotId;
      hideKfMenu();
      if (id) deleteKeyframe(id);
      else if (dot) {
        deleteDot(dot);
        renderSelectedPanel();
        renderLane();
        renderPreview();
        invalidateDots();
      }
    });
    // Mobile-only Copy / Paste for the selected keyframe or dot. On desktop
    // the same actions live in the right-click context menu, which touch
    // devices can't open, so these buttons (hidden on desktop) cover that gap.
    el.btnCopyKf.addEventListener('click', function () {
      if (state.selectedDotId) copyDot(state.selectedDotId);
      else if (state.selectedId) copyKeyframe(state.selectedId);
    });
    el.btnPasteKf.addEventListener('click', function () {
      if (state.selectedDotId && copiedDot) pasteDot(state.playhead);
      else pasteKeyframe(state.playhead);
    });
    el.kfMenu.addEventListener('click', function (e) { e.stopPropagation(); });
    el.timeline.addEventListener('wheel', function (e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        state.zoom = clamp(state.zoom * factor, 12, 4000);
        renderTimeline();
      } else {
        el.timeline.scrollLeft += e.deltaY || e.deltaX;
      }
    }, { passive: false });

    // Instant hover tooltip for long-gap warnings. The whole red gap is
    // hoverable (see .gap-overlay.warn in styles.css); a fixed-position tip
    // follows the cursor so it isn't clipped by the lane and shows immediately.
    var gapTip = document.createElement('div');
    gapTip.className = 'gap-tip hidden';
    gapTip.setAttribute('role', 'tooltip');
    document.body.appendChild(gapTip);
    var gapTipVisible = false;
    function moveGapTip(e) {
      var pad = 14;
      gapTip.style.left = (e.clientX + pad) + 'px';
      gapTip.style.top = (e.clientY + pad) + 'px';
      var r = gapTip.getBoundingClientRect();
      if (r.right > window.innerWidth - 8) gapTip.style.left = Math.max(8, e.clientX - r.width - pad) + 'px';
      if (r.bottom > window.innerHeight - 8) gapTip.style.top = Math.max(8, e.clientY - r.height - pad) + 'px';
    }
    function hideGapTip() {
      gapTipVisible = false;
      gapTip.classList.add('hidden');
    }
    el.timeline.addEventListener('mouseover', function (e) {
      var warn = e.target && e.target.closest ? e.target.closest('.gap-overlay.warn') : null;
      if (!warn) { hideGapTip(); return; }
      gapTip.textContent = '⚠ This gap needs ' + (warn.dataset.count || '?') +
        ' inbetweens. It\u2019s recommended to put a real frame in here. Long ML stretches tend to look bad.';
      gapTip.classList.remove('hidden');
      gapTipVisible = true;
      moveGapTip(e);
    });
    el.timeline.addEventListener('mousemove', function (e) {
      if (gapTipVisible) moveGapTip(e);
    });
    el.timeline.addEventListener('mouseleave', hideGapTip);

    // Resizable timeline: drag the divider above it to change its height.
    function saveTimelineHeight() {
      try { localStorage.setItem(TL_H_KEY, el.timelineCol.style.height); } catch (e) {}
    }
    el.tlResizer.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      el.tlResizer.classList.add('dragging');
      document.body.classList.add('resizing-timeline');
      try { el.tlResizer.setPointerCapture(e.pointerId); } catch (err) {}
      var startY = e.clientY;
      var startH = el.timelineCol.offsetHeight;
      function onMove(ev) {
        var h = clamp(startH - (ev.clientY - startY), TL_H_MIN, maxTimelineHeight());
        el.timelineCol.style.height = h + 'px';
      }
      function onUp() {
        el.tlResizer.classList.remove('dragging');
        document.body.classList.remove('resizing-timeline');
        el.tlResizer.removeEventListener('pointermove', onMove);
        el.tlResizer.removeEventListener('pointerup', onUp);
        el.tlResizer.removeEventListener('pointercancel', onUp);
        saveTimelineHeight();
        renderTimeline();
        renderPreview(); // re-fit the viewport to the new panel size
      }
      el.tlResizer.addEventListener('pointermove', onMove);
      el.tlResizer.addEventListener('pointerup', onUp);
      el.tlResizer.addEventListener('pointercancel', onUp);
    });
    el.tlResizer.addEventListener('dblclick', function () {
      el.timelineCol.style.height = TL_H_DEFAULT + 'px';
      saveTimelineHeight();
      renderTimeline();
      renderPreview();
    });

    // Resizable side panels: drag the divider next to a panel to change its
    // width, double-click to restore the default. The right panel grows leftward.
    function saveSideWidth(key) {
      var col = key === SIDE_W_KEY_L ? el.leftCol : el.rightCol;
      try { localStorage.setItem(key, col.style.width); } catch (e) {}
    }
    function wireSideResizer(resizer, col, key, grow) {
      resizer.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        resizer.classList.add('dragging');
        document.body.classList.add('resizing-side');
        try { resizer.setPointerCapture(e.pointerId); } catch (err) {}
        var startX = e.clientX;
        var startW = col.offsetWidth;
        function onMove(ev) {
          var w = clamp(startW + (ev.clientX - startX) * grow, SIDE_W_MIN, maxSideWidth());
          col.style.width = w + 'px';
        }
        function onUp() {
          resizer.classList.remove('dragging');
          document.body.classList.remove('resizing-side');
          resizer.removeEventListener('pointermove', onMove);
          resizer.removeEventListener('pointerup', onUp);
          resizer.removeEventListener('pointercancel', onUp);
          saveSideWidth(key);
          renderPreview(); // re-fit the viewport to the new panel size
        }
        resizer.addEventListener('pointermove', onMove);
        resizer.addEventListener('pointerup', onUp);
        resizer.addEventListener('pointercancel', onUp);
      });
      resizer.addEventListener('dblclick', function () {
        col.style.width = SIDE_W_DEFAULT + 'px';
        saveSideWidth(key);
        renderPreview();
      });
    }
    wireSideResizer(el.leftResizer, el.leftCol, SIDE_W_KEY_L, 1);   // drag right → wider
    wireSideResizer(el.rightResizer, el.rightCol, SIDE_W_KEY_R, -1); // drag left → wider

    document.addEventListener('keydown', function (e) {
      // While the fullscreen paint editor is open it has its own Ctrl+Z/Y,
      // Delete, Esc, etc. shortcuts (src/paint.js registers its keydown handler
      // after this one), so leave every timeline shortcut to it — otherwise the
      // app's undo() would also fire on the same keystroke.
      if (window.paintOpen) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.key === 'Delete' || e.key === 'Backspace') { deleteKeyframe(state.selectedId); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); pause(); step(-1); }
    });

    // Drag & drop files: like every other way of loading images, a drop only
    // adds to the library (assets use the custom pointer drag in renderAssets).
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      var dt = e.dataTransfer;
      if (!dt) return;
      var files = dt.files;
      if (!files || !files.length) return;
      addImageFiles(files).then(libraryToast).catch(function (err) { toast(err.message); });
    });
    window.addEventListener('paste', function (e) {
      // Only real clipboard pastes (Ctrl/Cmd+V, or an explicit menu paste) add
      // images to the library. On X11/Linux a middle-click ALSO fires a paste
      // event (the primary selection) — that must not dump clipboard images
      // into the library while the user is just middle-dragging to pan.
      if (!(e.ctrlKey || e.metaKey)) return;
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image/') === 0) {
          var f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) addImageFiles(files).then(libraryToast).catch(function (err) { toast(err.message); });
    });

    // dropdown menus
    function wireMenu(btn, menu, onOpen) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = !menu.classList.contains('hidden');
        closeMenus();
        if (!open) {
          menu.classList.remove('hidden');
          if (onOpen) onOpen();
          clampMenuToViewport(menu);
        }
      });
      menu.addEventListener('click', function (e) { e.stopPropagation(); });
    }
    wireMenu(el.btnSettings, el.settingsMenu);
    wireMenu(el.btnFile, el.fileMenu);
    wireMenu(el.btnExport, el.exportMenu, populateExportRes);
    wireMenu(el.btnLayerMenu, el.layerMenu);
    wireMenu(el.btnOnionMenu, el.onionMenu, syncOnionUI);
    document.addEventListener('click', closeMenus);

    // Mobile side-panel drawers: on narrow screens the asset / frame panels
    // slide in over the preview, between the toolbar and the timeline, so the
    // timeline stays visible for scrubbing and drops. Desktop never sees these
    // (the buttons are hidden and the panels are plain flex columns).
    function isMobile() { return window.innerWidth <= 860; }
    function closeDrawers() {
      el.leftCol.classList.remove('open');
      el.rightCol.classList.remove('open');
      el.drawerBackdrop.classList.remove('show');
      // The inline top/bottom are only meaningful while a drawer is a fixed
      // overlay; clear them on resize back to desktop so the columns reflow.
      if (!isMobile()) {
        el.leftCol.style.top = el.leftCol.style.bottom = '';
        el.rightCol.style.top = el.rightCol.style.bottom = '';
      }
    }
    function openDrawer(side) {
      closeMenus();
      var drawer = side === 'left' ? el.leftCol : el.rightCol;
      var h = el.timelineCol.offsetHeight + (el.tlResizer ? el.tlResizer.offsetHeight : 0);
      drawer.style.top = (el.toolbar ? el.toolbar.offsetHeight : 0) + 'px';
      drawer.style.bottom = h + 'px';
      drawer.classList.add('open');
      el.drawerBackdrop.classList.add('show');
    }
    el.btnDrawerAssets.addEventListener('click', function (e) {
      e.stopPropagation();
      if (el.leftCol.classList.contains('open')) closeDrawers();
      else openDrawer('left');
    });
    el.btnDrawerPanel.addEventListener('click', function (e) {
      e.stopPropagation();
      if (el.rightCol.classList.contains('open')) closeDrawers();
      else openDrawer('right');
    });
    el.drawerBackdrop.addEventListener('click', closeDrawers);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawers();
    });
    // Growing past the mobile breakpoint would otherwise strand an open drawer
    // (its position is set inline for the fixed-overlay state); close on resize.
    window.addEventListener('resize', function () {
      if (!isMobile()) closeDrawers();
    });

    // File menu: save / load project .khuwari files
    el.btnSaveProject.addEventListener('click', saveProjectFile);
    el.btnLoadProject.addEventListener('click', function () { el.projectInput.click(); });
    el.projectInput.addEventListener('change', function () {
      if (el.projectInput.files && el.projectInput.files[0]) {
        loadProjectFile(el.projectInput.files[0]);
      }
      el.projectInput.value = '';
    });
    el.btnExportGo.addEventListener('click', runExport);

    el.btnHelp.addEventListener('click', function () {
      window.open('docs.html', '_blank');
    });

    // Start screen actions.
    el.btnStartNew.addEventListener('click', newProject);
    el.btnStartLoad.addEventListener('click', function () { el.projectInput.click(); });
    el.btnStartExample.addEventListener('click', openExample);
    el.btnStartDocs.addEventListener('click', function () {
      window.open('docs.html', '_blank');
    });
    el.btnStartGithub.addEventListener('click', function () {
      window.open('https://github.com/TheShovel/khuwari', '_blank');
    });
    el.btnStartCredits.addEventListener('click', function () {
      window.open('credits.html', '_blank');
    });

    // Undo / redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl+Y).
    el.btnUndo.addEventListener('click', undo);
    el.btnRedo.addEventListener('click', redo);

    // Camera track: the four transform sliders each edit the camera key at the
    // (snapped) playhead, auto-creating one.
    function cameraSlider(input, valEl, field, fmt) {
      function apply() {
        var v = parseFloat(input.value);
        if (!isFinite(v)) return;
        syncSlider(input);
        if (valEl) valEl.textContent = fmt(v);
        setCameraField(field, v);
      }
      input.addEventListener('input', apply);
      input.addEventListener('change', apply);
    }
    cameraSlider(el.cameraX, el.cameraXVal, 'x', function (v) { return Math.round(v * 100) + '%'; });
    cameraSlider(el.cameraY, el.cameraYVal, 'y', function (v) { return Math.round(v * 100) + '%'; });
    cameraSlider(el.cameraZoom, el.cameraZoomVal, 'zoom', function (v) { return Math.round(v * 100) / 100 + 'x'; });
    cameraSlider(el.cameraRot, el.cameraRotVal, 'rot', function (v) { return Math.round(v * 10) / 10 + '°'; });
    // Camera effects: the five intensity sliders write into the key's fx config
    // (0..1), also auto-creating a camera key at the playhead if needed.
    function fxPct(v) { return Math.round(v * 100) + '%'; }
    cameraSlider(el.cameraFxFisheye, el.cameraFxFisheyeVal, 'fx.fisheye', fxPct);
    cameraSlider(el.cameraFxGrain, el.cameraFxGrainVal, 'fx.grain', fxPct);
    cameraSlider(el.cameraFxChroma, el.cameraFxChromaVal, 'fx.chroma', fxPct);
    cameraSlider(el.cameraFxVig, el.cameraFxVigVal, 'fx.vignette', fxPct);
    cameraSlider(el.cameraFxShake, el.cameraFxShakeVal, 'fx.shake', fxPct);
    cameraSlider(el.cameraFxShakeSpeed, el.cameraFxShakeSpeedVal, 'fx.shakeSpeed', fxPct);
    el.btnCameraAddKey.addEventListener('click', function () { addCameraKey(); });
    el.btnCameraRemoveKey.addEventListener('click', function () { removeCameraKey(state.playhead); });
    // Right-panel categories fold / unfold via the shared collapsible system
    // (util.js initCollapsibles) so they animate like the paint editor dockers.
    if (typeof initCollapsibles === 'function') initCollapsibles(el.rightCol || document.querySelector('#rightCol'));

    // Reference audio track: load a file, remove it, or mute. The decoded
    // buffer + waveform are derived in audio.js.
    el.btnAudioLoad.addEventListener('click', function () { el.audioInput.click(); });
    el.audioInput.addEventListener('change', function () {
      if (el.audioInput.files && el.audioInput.files[0]) {
        loadAudioFile(el.audioInput.files[0]).catch(function () {});
      }
      el.audioInput.value = '';
    });
    el.btnAudioRemove.addEventListener('click', removeAudio);
    el.audioMute.addEventListener('change', function () { setAudioMuted(el.audioMute.checked); });

    // Seek by clicking the audio lane waveform (same time mapping as the lane).
    var audioLaneEl = byId('audioLane');
    if (audioLaneEl) audioLaneEl.addEventListener('pointerdown', function (e) { audioLaneSeek(e.clientX); });

    // Built-in paint tool: open from the toolbar and repaint keyframes from
    // the right-click frame menu. Lives in src/paint.js.
    wirePaint();

    updateUndoButtons();
  }
