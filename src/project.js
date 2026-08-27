'use strict';


  function projectData() {
    return {
      v: 11,
      settings: {
        fps: state.fps, snap: state.snap, zoom: state.zoom,
        res: state.res, keysOnly: state.keysOnly, onion: state.onion, onionCfg: state.onionCfg,
        aspect: state.aspect, aspectRatio: state.aspectRatio,
        customW: state.customW, customH: state.customH
      },
      layers: state.layers.map(function (l) {
        return l.type === 'fill'
          ? { id: l.id, name: l.name, visible: l.visible, type: 'fill', dots: l.dots }
          : { id: l.id, name: l.name, visible: l.visible };
      }),
      activeLayerId: state.activeLayerId,
      assets: state.assets.map(function (a) {
        var o = { img: a.img, name: a.name, w: a.w, h: a.h };
        // Paint-made assets keep their editable layer stack so they can be
        // reopened in the paint tool with layers, blend modes + opacity intact.
        if (Array.isArray(a.paintLayers) && a.paintLayers.length) {
          o.paintLayers = a.paintLayers.map(function (pl) {
            return { name: pl.name, visible: !!pl.visible, opacity: pl.opacity, blend: pl.blend || 'source-over', img: pl.img };
          });
        }
        return o;
      }),
      keyframes: state.keyframes.map(function (k) {
        var o = { id: k.id, layer: k.layer, time: k.time, hold: keyframeHold(k), img: k.img, name: k.name, w: k.w, h: k.h, mix: k.mix || 'source-over' };
        // Editable paint layers are stored alongside the flattened image so the
        // Edit in paint command can restore the full stack (order, opacity, content).
        if (Array.isArray(k.paintLayers) && k.paintLayers.length) {
          o.paintLayers = k.paintLayers.map(function (pl) {
            return { name: pl.name, visible: !!pl.visible, opacity: pl.opacity, blend: pl.blend || 'source-over', img: pl.img };
          });
        }
        return o;
      }),
      generated: state.generated,
      gapMeta: state.gapMeta,
      gapType: state.gapType,
      gapSquash: state.gapSquash,
      gapBlur: state.gapBlur,
      // Camera: a non-destructive pan / zoom / rotation track applied to the
      // final composite and to exports.
      camera: { enabled: true, keys: state.camera.keys },
      // Reference audio track (a scratch sound synced to the timeline). Only
      // the source data URL + meta are saved; the decoded buffer is derived.
      audio: { src: state.audio.src, name: state.audio.name, duration: state.audio.duration, muted: state.audio.muted },
      // Recent paint colours (newest first, max 8), so the paint editor's color
      // history rides along with the project file.
      colorHistory: (state.colorHistory || []).slice(0, 8),
      // Custom brush presets (settings + tip image as a data URL). Only
      // user-made brushes are stored; defaults are recreated on load.
      brushes: (typeof brushList !== 'undefined' && Array.isArray(brushList))
        ? brushList.filter(function (b) { return !b.builtin && !b.bundled; }).map(function (b) {
            return (typeof serializeBrush === 'function') ? serializeBrush(b) : null;
          }).filter(Boolean)
        : []
    };
  }

  function applyProjectData(data) {
    var s = data.settings || {};
    state.fps = clamp(parseFloat(s.fps) || 12, 1, 60);
    state.snap = s.snap !== false;
    state.zoom = clamp(parseFloat(s.zoom) || 90, 12, 4000);
    state.res = [512, 448, 384, 320].indexOf(parseInt(s.res, 10)) >= 0 ? parseInt(s.res, 10) : 512;
    state.keysOnly = !!s.keysOnly;
    // Onion prefs: the toggle and its settings are UI prefs (persisted to
    // localStorage on every change). A project file only overrides them when it
    // explicitly carries onion settings; otherwise the user's current prefs
    // (already restored at boot) stay, so loading a project never wipes them.
    if (s.hasOwnProperty('onion')) state.onion = !!s.onion;
    if (s.onionCfg && typeof s.onionCfg === 'object') {
      var c = s.onionCfg;
      state.onionCfg = {
        before: clamp(parseInt(c.before, 10) || 1, 0, 4),
        after: clamp(parseInt(c.after, 10) || 1, 0, 4),
        opacity: clamp(parseFloat(c.opacity) || 0.28, 0.05, 0.9),
        tint: !!c.tint,
        tintColor: (typeof c.tintColor === 'string' && /^#?[0-9a-f]{6}$/i.test(c.tintColor)) ? (c.tintColor[0] === '#' ? c.tintColor : '#' + c.tintColor) : '#ff3b30',
        tintOpacity: clamp(parseFloat(c.tintOpacity) || 0.35, 0.05, 1)
      };
    }
    state.aspect = ['auto', '16:9', '9:16', '4:3', '3:4', '1:1', 'custom', 'manual'].indexOf(s.aspect) >= 0 ? s.aspect : 'auto';
    var ar = parseRatio(s.aspectRatio);
    state.aspectRatio = ar;
    state.customW = clamp(parseInt(s.customW, 10) || 1920, 8, 4096);
    state.customH = clamp(parseInt(s.customH, 10) || 1080, 8, 4096);
    // Layers: projects saved before layers existed are wrapped in one layer.
    var savedLayers = Array.isArray(data.layers) && data.layers.length ? data.layers : null;
    if (savedLayers) {
      state.layers = savedLayers.map(function (l) {
        var base = {
          id: l.id,
          name: l.name || 'Layer',
          visible: l.visible !== false
        };
        if (l.type === 'fill') {
          // Fill layers hold color dots; sanitize every field so a hand-edited
          // project can't crash the renderer.
          base.type = 'fill';
          base.dots = (Array.isArray(l.dots) ? l.dots : []).map(function (d) {
            return {
              id: d && d.id ? String(d.id) : 'D' + (++idSeq),
              x: clamp(parseFloat(d && d.x) || 0, 0, 1),
              y: clamp(parseFloat(d && d.y) || 0, 0, 1),
              color: (typeof (d && d.color) === 'string' && /^#?[0-9a-f]{6}$/i.test(d.color)) ? d.color : '#4f8fff',
              threshold: clamp(parseFloat(d && d.threshold) || 0.5, 0, 1),
              grow: clamp(Math.round(parseFloat(d && d.grow) || 0), 0, 200),
              gradOn: !!(d && d.gradOn),
              gradColor: (typeof (d && d.gradColor) === 'string' && /^#?[0-9a-f]{6}$/i.test(d.gradColor)) ? d.gradColor : '#ffffff',
              gradHeight: clamp(Math.round(parseFloat(d && d.gradHeight) || 24), 4, 400),
              gradDir: ['top', 'bottom', 'left', 'right'].indexOf(d && d.gradDir) >= 0 ? d.gradDir : 'bottom',
              start: Math.max(0, parseFloat(d && d.start) || 0),
              end: Math.max(0, parseFloat(d && d.end) || 0)
            };
          });
          // Normalize: end must be after start (swap/raise as needed).
          base.dots.forEach(function (d) {
            if (d.end <= d.start) d.end = d.start + 1 / state.fps;
          });
        }
        return base;
      });
      state.activeLayerId = state.layers.some(function (l) { return l.id === data.activeLayerId; })
        ? data.activeLayerId : state.layers[0].id;
    } else {
      state.layers = [{ id: 'L1', name: 'Layer 1', visible: true }];
      state.activeLayerId = 'L1';
    }
    layerSeq = state.layers.reduce(function (m, l) {
      var n = parseInt(String(l.id).replace(/\D/g, ''), 10);
      return Math.max(m, isFinite(n) ? n + 1 : 1);
    }, 1);
    state.keyframes = (data.keyframes || []).filter(function (k) { return k && k.img; }).map(function (k) {
      if (!k.layer || !state.layers.some(function (l) { return l.id === k.layer; })) k.layer = state.layers[0].id;
      if (typeof k.mix !== 'string' || ['source-over','multiply','screen','overlay','darken','lighten','color-dodge','color-burn','hard-light','soft-light','difference','exclusion','hue','saturation','color','luminosity'].indexOf(k.mix) < 0) {
        k.mix = 'source-over';
      }
      return k;
    });
    state.generated = (data.generated && typeof data.generated === 'object') ? data.generated : {};
    state.gapMeta = (data.gapMeta && typeof data.gapMeta === 'object') ? data.gapMeta : {};
    state.gapType = (data.gapType && typeof data.gapType === 'object') ? data.gapType : {};
    state.gapSquash = (data.gapSquash && typeof data.gapSquash === 'object') ? data.gapSquash : {};
    state.gapBlur = (data.gapBlur && typeof data.gapBlur === 'object') ? data.gapBlur : {};
    // Camera track: tolerant parse so a hand-edited or partly-saved project
    // can't crash the renderer; keys are validated into plain numbers.
    var cam = data.camera;
    state.camera = (cam && Array.isArray(cam.keys))
      ? { enabled: true, keys: cam.keys.map(function (k) {
          var nk = { t: +k.t || 0, x: +k.x || 0, y: +k.y || 0, zoom: +k.zoom || 1, rot: +k.rot || 0 };
          // Effects config is optional; normalize any present fields to 0..1.
          if (k.fx && typeof k.fx === 'object') {
            nk.fx = {};
            ['fisheye', 'grain', 'chroma', 'vignette', 'shake'].forEach(function (f) {
              var v = parseFloat(k.fx[f]);
              nk.fx[f] = isFinite(v) ? clamp(v, 0, 1) : 0;
            });
            // Shake speed is stored per key when set; absent keys fall back to
            // the 0.5 default in fxOf, so old projects keep a natural wobble.
            if (k.fx.hasOwnProperty('shakeSpeed')) {
              var sp = parseFloat(k.fx.shakeSpeed);
              nk.fx.shakeSpeed = isFinite(sp) ? clamp(sp, 0, 1) : 0.5;
            }
          }
          return nk;
        }) }
      : { enabled: true, keys: [] };
    // Reference audio track: only the source + meta persist; the decoded
    // buffer (and waveform peaks) are re-derived on load / play.
    var au = data.audio;
    state.audio = (au && au.src)
      ? { src: au.src, name: au.name || null, duration: +au.duration || 0, muted: !!au.muted }
      : { src: null, name: null, duration: 0, muted: false };
    // Recent paint colours: sanitized into unique lowercase #rrggbb (newest
    // first, max 8); a hand-edited project can't crash the renderer.
    state.colorHistory = (Array.isArray(data.colorHistory) ? data.colorHistory : [])
      .filter(function (c) { return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c); })
      .map(function (c) { return c.toLowerCase(); })
      .filter(function (c, ix, arr) { return arr.indexOf(c) === ix; })
      .slice(0, 8);
    // Custom brush presets are owned by the paint tool (it holds brushList),
    // so hand them off to be restored there.
    if (Array.isArray(data.brushes) && typeof applyLoadedBrushes === 'function') {
      applyLoadedBrushes(data.brushes);
    }
    // The image library: saved with the project (v5+), otherwise derived from
    // the keyframe images so older projects still show their images. Any
    // keyframe image missing from the library (e.g. promoted composites) is
    // added in keyframe order.
    state.assets = Array.isArray(data.assets)
      ? data.assets.filter(function (a) { return a && a.img; }).map(function (a) {
        var o = { img: a.img, name: a.name, w: a.w, h: a.h };
        if (Array.isArray(a.paintLayers) && a.paintLayers.length) {
          o.paintLayers = a.paintLayers.map(function (pl) {
            return { name: pl.name, visible: pl.visible !== false, opacity: (pl.opacity == null ? 1 : pl.opacity), blend: pl.blend || 'source-over', img: pl.img };
          });
        }
        return o;
      })
      : [];
    state.keyframes.forEach(function (k) {
      if (!k.img || state.assets.some(function (a) { return a.img === k.img; })) return;
      state.assets.push({ img: k.img, name: k.name, w: k.w, h: k.h });
    });
    idSeq = state.keyframes.reduce(function (m, k) {
      var n = parseInt(String(k.id).replace(/\D/g, ''), 10);
      return Math.max(m, isFinite(n) ? n + 1 : 1);
    }, 1);
    // Dots share the id sequence; count them too so new dots never collide
    // with loaded ones (a project could hold only dots).
    state.layers.forEach(function (l) {
      if (l.type === 'fill' && l.dots) {
        l.dots.forEach(function (d) {
          var n = parseInt(String(d.id).replace(/\D/g, ''), 10);
          if (isFinite(n) && n + 1 > idSeq) idSeq = n + 1;
        });
      }
    });
  }

  function saveProjectFile() {
    var blob = new Blob([JSON.stringify(projectData(), null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'khuwari-project.khuwari', 'application/json');
    captureSavedBaseline();
    toast('Project saved (.khuwari)');
  }

  function loadProjectFile(file) {
    enterApp();
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.keyframes)) throw new Error('not a project file');
        cancelRun();
        restoringProject = true;
        try {
          applyProjectData(data);
          state.selectedId = null;
          state.playhead = 0;
          state.curIndex = 0;
          pause();
          applyWorkSize();
        } finally {
          restoringProject = false;
        }
        if (typeof initAudioFromProject === 'function') initAudioFromProject();
        refreshDirty();
        renderAll();
        syncInputs();
        // Frames saved in the file are reused when valid (same stamps);
        // anything invalidated by the load (different endpoint images, a
        // different frame count) is regenerated automatically.
        scheduleGenerate(100);
        toast('Project loaded');
        captureSavedBaseline();
      } catch (e) {
        toast('Could not load project file. Choose a .khuwari file saved from this app.');
      }
    };
    reader.readAsText(file);
  }

  // start screen

  function enterApp() {
    el.startScreen.classList.add('hidden');
  }

  function newProject() {
    cancelRun();
    pause();
    state.keyframes = [];
    state.assets = [];
    state.layers = [{ id: 'L1', name: 'Layer 1', visible: true }];
    state.activeLayerId = 'L1';
    state.generated = {};
    state.gapMeta = {};
    state.gapType = {};
    state.gapSquash = {};
    state.gapBlur = {};
    state.camera = { enabled: true, keys: [] };
    state.audio = { src: null, name: null, duration: 0, muted: false };
    state.colorHistory = [];
    if (typeof resetPaintBrushes === 'function') resetPaintBrushes();
    if (typeof initAudioFromProject === 'function') initAudioFromProject();
    state.dirty = new Set();
    state.selectedId = null;
    state.selectedGapId = null;
    state.selectedDotId = null;
    state.playhead = 0;
    state.curIndex = 0;
    applyWorkSize();
    refreshDirty();
    renderAll();
    syncInputs();
    enterApp();
    captureSavedBaseline();
  }

  // Load the bundled example project (example.khuwari) from the start screen's
  // example button (served locally, so no cross-origin fetch restrictions), via
  // the same load path as a user-picked .khuwari.
  function openExample() {
    fetch('example.khuwari').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (blob) {
      loadProjectFile(new File([blob], 'example.khuwari', { type: 'application/json' }));
    }).catch(function (e) {
      toast('Could not load the example project: ' + (e && e.message ? e.message : e));
    });
  }

  // unsaved-changes guard
  // Baseline snapshot of the fully serialized project, captured whenever the
  // project is saved, loaded or reset. Every edit - keyframes, layers, dots,
  // paint, camera, audio - shows up automatically in the next comparison, so no
  // individual action has to be flagged. Leaving or reloading the tab with
  // unsaved work asks for confirmation.
  var savedBaseline = JSON.stringify(projectData());

  function captureSavedBaseline() {
    savedBaseline = JSON.stringify(projectData());
  }

  function projectHasUnsavedChanges() {
    try {
      return JSON.stringify(projectData()) !== savedBaseline;
    } catch (e) {
      return true;
    }
  }

  window.addEventListener('beforeunload', function (e) {
    if (!projectHasUnsavedChanges()) return;
    // Modern browsers ignore the message text and show their own "leave site?"
    // wording - preventDefault (plus returnValue for older engines) is what
    // actually turns the prompt on.
    e.preventDefault();
    e.returnValue = '';
  });
