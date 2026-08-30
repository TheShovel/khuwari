'use strict';


  // Model auto-load (used by boot + retry button; works via the worker or
  // inline when no worker is available)

  function closeMenus() {
    [el.settingsMenu, el.fileMenu, el.exportMenu, el.layerMenu, el.onionMenu, el.kfMenu].forEach(function (m) { if (m) m.classList.add('hidden'); });
  }

  var loadingMaxPct = 0;

  function setLoadingProgress(label, pct) {
    loadingMaxPct = Math.max(loadingMaxPct, clamp(pct, 0, 100));
    el.loadingFill.style.width = loadingMaxPct + '%';
    el.loadingLabel.textContent = label;
    el.loadingMeta.textContent = Math.round(loadingMaxPct) + '%';
  }

  function onModelProgress(info) {
    if (info && info.stage === 'model') {
      el.loadingSub.textContent = 'Downloading the ML model…';
      setLoadingProgress('Downloading model…', info.frac * 100);
    } else if (info && info.stage === 'compile') {
      el.loadingSub.textContent = 'Compiling the model for your browser…';
      setLoadingProgress('Compiling model…', 99);
    }
  }

  function onModelReady() {
    state.modelReady = true;
    if (modelGateResolve) { modelGateResolve(); modelGateResolve = null; }
    setLoadingProgress('Ready', 100);
    el.loadingOverlay.classList.add('hidden');
    toast('ML model ready ✓. All inbetweens are ML-generated');
  }

  function onModelError(err) {
    console.error('ML model load failed:', err);
    state.modelReady = false;
    if (modelGateResolve) { modelGateResolve(); modelGateResolve = null; }
    el.loadingSub.textContent = 'Could not load the ML model (' + (err && err.message ? err.message : err) + '). Frames will use the built-in fallback instead.';
    el.loadingMeta.textContent = 'failed';
    el.btnLoadingRetry.classList.remove('hidden');
    toast('ML model failed to load. Using the built-in fallback', 6000);
  }

  function loadModelWithOverlay() {
    el.loadingOverlay.classList.remove('hidden');
    el.btnLoadingRetry.classList.add('hidden');
    loadingMaxPct = 0;
    setLoadingProgress('Preparing…', 0);
    el.loadingSub.textContent = 'Fetching the local ML engine + model (one-time, ~21 MB)…';
    modelGate = new Promise(function (resolve) { modelGateResolve = resolve; });
    if (workers.length) {
      // Every pool worker downloads + compiles its own copy of the model (the
      // browser HTTP cache makes the repeated download cheap); the launch
      // overlay hides once all of them report ready, so generation starts with
      // the full pool available.
      workersReady = 0;
      workersFailed = 0;
      workers.forEach(function (w, i) { workerModelBroken[i] = false; w.postMessage({ type: 'load-model' }); });
      return;
    }
    model.loadModel(onModelProgress).then(onModelReady).catch(onModelError);
  }

  function boot() {
    loadTheme();
    syncInputs();
    applyWorkSize();
    refreshDirty();
    // On phones, default to a lower timeline zoom so a whole short timeline
    // fits the width; projects that carry their own zoom override this anyway.
    if (window.innerWidth <= 860 && state.zoom === 90) state.zoom = 40;
    // Restore the timeline height the user last dragged it to.
    var savedH = 0;
    try { savedH = parseInt(localStorage.getItem(TL_H_KEY) || '', 10) || 0; } catch (e) {}
    if (savedH) el.timelineCol.style.height = clamp(savedH, TL_H_MIN, maxTimelineHeight()) + 'px';
    // Restore the side panel widths the user last dragged them to.
    [[SIDE_W_KEY_L, el.leftCol], [SIDE_W_KEY_R, el.rightCol]].forEach(function (pair) {
      var savedW = 0;
      try { savedW = parseInt(localStorage.getItem(pair[0]) || '', 10) || 0; } catch (e) {}
      if (savedW) pair[1].style.width = clamp(savedW, SIDE_W_MIN, maxSideWidth()) + 'px';
    });
    // Restore onion-skin prefs (overrides the project-file defaults only when
    // nothing is loaded from a file; project settings win once a project is
    // opened, see applyProjectData).
    try {
      var onionSaved = JSON.parse(localStorage.getItem(ONION_KEY) || 'null');
      if (onionSaved && typeof onionSaved === 'object') {
        state.onionCfg = {
          before: clamp(parseInt(onionSaved.before, 10) || 1, 0, 4),
          after: clamp(parseInt(onionSaved.after, 10) || 1, 0, 4),
          opacity: clamp(parseFloat(onionSaved.opacity) || 0.28, 0.05, 0.9),
          tint: !!onionSaved.tint,
          tintColor: (typeof onionSaved.tintColor === 'string' && /^#?[0-9a-f]{6}$/i.test(onionSaved.tintColor)) ? (onionSaved.tintColor[0] === '#' ? onionSaved.tintColor : '#' + onionSaved.tintColor) : '#ff3b30',
          tintOpacity: clamp(parseFloat(onionSaved.tintOpacity) || 0.35, 0.05, 1)
        };
      }
    } catch (e) {}
    // Restore the last fill color used, so newly placed dots keep it.
    try {
      var savedDotColor = localStorage.getItem(DOT_COLOR_KEY);
      if (savedDotColor && /^#?[0-9a-f]{6}$/i.test(savedDotColor)) {
        lastDotColor = savedDotColor[0] === '#' ? savedDotColor : '#' + savedDotColor;
      }
    } catch (e) {}
    renderAll();
    wireEvents();
    syncSlider(el.gapSquashAmount);
    syncSlider(el.gapBlurAmount);
    syncOnionUI();
    el.btnOnion.classList.toggle('active', state.onion);
    initWorker();
    loadModelWithOverlay(); // download + compile the ML model on launch
    scheduleGenerate(400);
    window.addEventListener('resize', function () {
      // If the window shrinks, keep the timeline inside the clamped range so
      // the preview never gets crushed to nothing.
      var h = parseInt(el.timelineCol.style.height || TL_H_DEFAULT, 10) || TL_H_DEFAULT;
      el.timelineCol.style.height = clamp(h, TL_H_MIN, maxTimelineHeight()) + 'px';
      // Same clamp for the side panels so the preview keeps usable width.
      [el.leftCol, el.rightCol].forEach(function (col) {
        var w = parseInt(col.style.width || SIDE_W_DEFAULT, 10) || SIDE_W_DEFAULT;
        col.style.width = clamp(w, SIDE_W_MIN, maxSideWidth()) + 'px';
      });
      renderTimeline();
      renderPreview(); // re-fit the viewport to the new panel size
    });
  }

  function syncInputs() {
    el.fpsInput.value = String(state.fps);
    el.snapInput.checked = state.snap;
    el.themeInput.value = themeName();
    el.resInput.value = String(state.res);
    el.aspectInput.value = state.aspect;
    el.customWInput.value = String(state.customW);
    el.customHInput.value = String(state.customH);
    el.aspectRatioInput.value = state.aspectRatio ? fmtRatio(state.aspectRatio) : '';
    var custom = state.aspect === 'custom';
    var manual = state.aspect === 'manual';
    el.customSizeRow.classList.toggle('hidden', !custom);
    el.manualAspectRow.classList.toggle('hidden', !manual);
    el.resInput.disabled = custom || manual;
    el.btnLoop.style.opacity = state.loop ? 1 : 0.35;
    el.btnKeysOnly.classList.toggle('active', state.keysOnly);
    updateViewportLabel();
  }
