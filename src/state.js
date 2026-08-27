'use strict';


  var state = {
    keyframes: [],        // { id, layer, time, img, name, w, h }
    assets: [],           // { img, name, w, h }: the image library (assets panel)
    layers: [{ id: 'L1', name: 'Layer 1', visible: true }], // top → bottom draw order (first = topmost)
    activeLayerId: 'L1',  // layer new keyframes go into
    generated: {},        // gapId -> [{ idx, t, time, img, ai }]
    gapMeta: {},          // gapId -> { h, count }: what the frames were made from
    gapType: {},          // gapId -> 'ai' | 'squash' | 'none' (per-gap interpolation)
    gapSquash: {},        // gapId -> { amount, curve, preserve }
    gapBlur: {},          // gapId -> { on, intensity } (per-gap motion blur)
    dirty: new Set(),     // gapIds that need (re)generation
    fps: 12,
    zoom: 90,             // px per second
    snap: true,
    res: 512,             // long edge for preset aspects
    aspect: 'auto',       // 'auto' | '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | 'custom' | 'manual'
    aspectRatio: null,    // width/height number when aspect is 'manual'
    customW: 1920,        // exact working width in custom aspect mode
    customH: 1080,        // exact working height in custom aspect mode
    modelReady: false,
    playhead: 0,
    curIndex: 0,
    playing: false,
    loop: true,
    keysOnly: false,   // viewport shows keyframes only (no interpolated frames)
    onion: false,      // onion skin: ghosts of neighboring keyframes
    onionCfg: { before: 1, after: 1, opacity: 0.28, tint: false, tintColor: '#ff3b30', tintOpacity: 0.35 },
    // Camera: non-destructive pan / zoom / rotation applied to the final
    // composite (and exports). Always on; keys are { t, x, y, zoom, rot }.
    camera: { enabled: true, keys: [] },
    // Reference audio track (a scratch/reference sound synced to the timeline).
    // Only the source data URL + meta are saved; the decoded buffer is derived.
    audio: { src: null, name: null, duration: 0, muted: false },
    // Recent paint colours (newest first, max 8) from the paint editor; saved
    // with the project so the history follows the file.
    colorHistory: [],
    selectedId: null,
    selectedGapId: null,   // gap selected in the timeline (right panel shows it)
    selectedDotId: null,   // color-dot selected (right panel shows its properties)
    genRun: null,
    pendingRegen: false,
    exporting: false,       // true while an export is running (Stop button)
    exportCancel: false,    // set to stop a PNG/GIF/frame export mid-run
    mp4Stop: null,          // stops the MP4 recorder if one is running
    previewToken: 0,
    viewZoom: 1         // preview viewport zoom (1 = fit the panel; pan lives in the scroll position)
  };

  var workW = 512, workH = 512;
  var restoringProject = false; // true while loading a project (skip size invalidation)
  var imgCache = new Map();
  var assetCache = [];    // [{ img, name, w, h }]: assets panel contents
  var assetImgs = new Set(); // img srcs already in the panel (change detection)
  var idSeq = 1;
  var layerSeq = 2;
  var GUTTER_W = 96; // px at the left of the timeline reserved for layer names
  var TL_H_DEFAULT = 188; // px, initial timeline height (see .timeline-col)
  var TL_H_MIN = 96;      // px, smallest the timeline can be dragged to
  var TL_H_KEY = 'khuwari-timeline-h'; // UI preference, not part of the project file
  var SIDE_W_DEFAULT = 212; // px, initial side panel width (see .side-col)
  var SIDE_W_MIN = 140;     // px, smallest a side panel can be dragged to
  var SIDE_W_KEY_L = 'khuwari-side-w-l'; // UI preferences, not part of the project file
  var SIDE_W_KEY_R = 'khuwari-side-w-r';
  var ONION_KEY = 'khuwari-onion'; // onion-skin prefs (persisted separately from the project file)
  var DOT_COLOR_KEY = 'khuwari-dot-color'; // last fill color used, so new dots pick it up
  var lastDotColor = '#4f8fff';
  var copiedDotProps = null; // fill properties copied from a dot, ready to paste onto another
  var copiedKeyframe = null; // { img, name, w, h, hold, mix, layer }: a copied keyframe, ready to paste
  var copiedDot = null;      // { x, y, fill settings, dur, layer }: a copied color dot, ready to paste
  var toastTimer = null;
  var WARN_GEN_COUNT = 5; // gaps needing more inbetweens than this get a red warning
  var REGEN_ABSORB_MS = 400; // while a run is active, edits wait at least this long so a quick burst coalesces into ONE restart instead of one cancel+restart per edit
  var EDIT_DEBOUNCE_MS = 250; // floor for edit-driven regeneration: a burst of quick edits shares one run that starts after they settle

  // Inline SVG icons for the buttons that are (re)built at runtime. Stroke-based
  // 24×24 paths, currentColor, matching the static icons in editor.html.
  var ICONS = {
    play: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    arrowUp: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>',
    download: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>'
  };

  function byId(id) { return document.getElementById(id); }

  // Draw the filled portion of a .slider (normalized 0..1 across its min/max).
  function syncSlider(input) {
    var min = parseFloat(input.min);
    var max = parseFloat(input.max);
    var v = parseFloat(input.value);
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 1;
    if (!isFinite(v)) v = min;
    var pct = (max > min) ? (v - min) / (max - min) : 0;
    input.style.setProperty('--val', pct.toFixed(4));
  }
