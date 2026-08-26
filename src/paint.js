'use strict';

  // ---------------------------------------------------------------------------
  // Built-in paint tool.
  //
  // A small bitmap brush engine that paints onto a canvas sized to the project's
  // working resolution, then drops the result into the existing asset library
  // (state.assets) and/or as a keyframe (addAssetKeyframe) - so painted art flows
  // through the exact same timeline / ML-interpolation path as imported images.
  //
  // Krita brush (.kpp) presets are supported: a .kpp is a gzip-wrapped ZIP
  // containing the preset XML (size / opacity / spacing / hardness / engine) and
  // a brush-tip image. We parse those and map them onto our bitmap stamps. Krita's
  // specialised engines (smudge, hatch, clone, ...) can't be reproduced faithfully
  // in a browser without their C++ code, so non-pixel engines fall back to the
  // same bitmap stamp using the extracted settings + tip where present.
  // ---------------------------------------------------------------------------

  var paintOpen = false;
  var editKeyframeId = null;        // when repainting an existing keyframe
  var editAsset = null;             // when editing a library asset (paint-made)
  var paintCanvas = null, paintCtx = null;
  var brushList = [];               // array of brush presets
  var current = null;               // active brush preset
  // The painting colour is Krita's active FOREGROUND colour: a global property
  // shared by every brush, never a per-preset colour. Picking a colour records
  // it here (and on the current brush); selecting another brush later re-applies
  // it so the colour never jumps to a preset's default (e.g. black).
  var fgColor = '#1a1a1a';
  var eraserOn = false;

  // Paint layers: transparent canvases composited over the keyframe base so
  // painted art is non-destructive and re-saves through the normal pipeline.
  var paintLayers = [];          // [{id,name,visible,opacity,canvas}]
  var activeLayer = null;
  var paintBaseCanvas = null;    // the keyframe/background we paint over
  var paintDispCtx = null;       // context of the on-screen #paintCanvas (composite)
  var layerSeq = 0;
  var pendingBrushes = null;     // brushes to apply once the tool is wired

  // live stroke state
  var drawing = false;
  var rafId = 0;
  var rawPoints = [];               // raw samples since last pump
  var rawLatest = null;             // most recent sample
  var smoothPt = null;              // eased (stabilised) point
  var lastPainted = null;           // last stamped point
  var smoothAlpha = 1;              // easing factor for this stroke
  var tipCanvas = null;             // pre-rendered, tinted brush tip (256px)
  // Per-stroke undo/redo. These are named uniquely (NOT `undoStack`) because
  // src/history.js already declares global `undoStack`/`redoStack` for the
  // timeline; sharing the same top-level `var` would merge the two stacks into
  // one and let the app's Ctrl+Z handler eat paint strokes (see wireEvents).
  var paintUndoStack = [];     // per-stroke undo snapshots (ImageData)
  var paintRedoStack = [];     // per-stroke redo snapshots (ImageData)
  var onionImgs = {};          // kf.img -> decoded ghost image for onion skin
  var paintBaselineURL = null; // composite data URL when the editor opened; used
                               // to detect real changes when auto-saving on close
  var paintReady = false;      // true once the opened image/layers finished loading

  // ---- extra tool state -----------------------------------------------------
  var paintTool = 'brush';     // brush|eraser|select|lasso|wand|move|transform|fill|eyedrop|line|rect|ellipse|crop
  var sel = null;              // {type:'rect'|'ellipse'|'lasso'|'mask', x,y,w,h, path:[], mask, feather}
  var selMaskCv = null;        // canvas whose alpha is the selection (feathered)
  var selDrag = null;          // {mode:'draw'|'move', sx,sy, dx,dy, snapshot, contentCv, dup}
  var selScratchCv = null;     // masked-stroke scratch: copy of the active layer that brush/
  var selScratchCtx = null;    // eraser/line/shape dabs draw into while a selection exists
  var selScratchLayer = null;  // the layer the scratch was taken from
  var cropRect = null;         // {x,y,w,h} in work coords
  var xfrm = null;             // free-transform state
  var toolDrag = null;         // generic drag state for shape/move tools
  var overlayCv = null, overlayCtx = null;
  var antsTimer = 0, antsOffset = 0;
  var fillCtx = null;          // cached context for fill ops
  var paintZoom = 1, paintPanX = 0, paintPanY = 0;  // canvas zoom / pan
  var panning = false, panStart = null;             // space/middle-drag pan

  // Persisted UI prefs: resizable panel widths + collapsible dockers.
  // (Docker collapse state now uses the shared global key in util.js.)
  var PAINT_LEFT_W_KEY = 'khuwari-paint-left-w';
  var PAINT_RIGHT_W_KEY = 'khuwari-paint-right-w';
  var PAINT_LEFT_W_DEFAULT = 190, PAINT_LEFT_W_MIN = 120, PAINT_LEFT_W_MAX = 330;
  var PAINT_RIGHT_W_DEFAULT = 250, PAINT_RIGHT_W_MIN = 170, PAINT_RIGHT_W_MAX = 420;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function hexToRgb(hex) {
    hex = String(hex || '#000000').replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  // ---- color wheel (HSV) -----------------------------------------------------
  // Krita-style picker: a hue slider on the right and an SV (brightness /
  // saturation) square to its left. `cwHsv` is the working color in HSV.
  var cwHsv = { h: 0, s: 1, v: 1 };
  var cwSvCv = null, cwHueCv = null;   // canvases, grabbed at wire time
  var cwDragging = null;               // 'sv' | 'hue'

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, v = max;
    var d = max - min;
    if (d !== 0) {
      s = d / max;
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: h * 360, s: s, v: v };
  }

  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360 / 360;
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    var r, g, b;
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      default: r = v; g = p; b = q; break;
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  }

  function rgbToHex(r, g, b) {
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  // Redraw the SV square for the current hue (white->hue horizontally,
  // transparent->black vertically), then the dot and hue marker positions.
  function renderColorWheel() {
    if (!cwSvCv || !cwHueCv) return;
    var svg = cwSvCv.getContext('2d');
    var w = cwSvCv.width, h = cwSvCv.height;
    var hc = hsvToRgb(cwHsv.h, 1, 1);
    var grad = svg.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(1, 'rgb(' + hc.r + ',' + hc.g + ',' + hc.b + ')');
    svg.fillStyle = grad;
    svg.fillRect(0, 0, w, h);
    var vgrad = svg.createLinearGradient(0, 0, 0, h);
    vgrad.addColorStop(0, 'rgba(0,0,0,0)');
    vgrad.addColorStop(1, 'rgba(0,0,0,1)');
    svg.fillStyle = vgrad;
    svg.fillRect(0, 0, w, h);

    // hue slider: the classic six-stop rainbow, top -> bottom
    var hg = cwHueCv.getContext('2d');
    var stops = [0, 60, 120, 180, 240, 300, 360];
    var hgrad = hg.createLinearGradient(0, 0, 0, cwHueCv.height);
    stops.forEach(function (deg) {
      var c = hsvToRgb(deg, 1, 1);
      hgrad.addColorStop(deg / 360, 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')');
    });
    hg.fillStyle = hgrad;
    hg.fillRect(0, 0, cwHueCv.width, cwHueCv.height);

    positionColorWheel();
  }

  // Move the SV dot and hue marker to match cwHsv.
  function positionColorWheel() {
    var dot = byId('paintCwDot');
    if (dot && cwSvCv) {
      var rect = cwSvCv.getBoundingClientRect();
      dot.style.left = (cwHsv.s * rect.width) + 'px';
      dot.style.top = ((1 - cwHsv.v) * rect.height) + 'px';
    }
    var mk = byId('paintCwHueMarker');
    if (mk && cwHueCv) {
      var hrect = cwHueCv.getBoundingClientRect();
      mk.style.top = ((cwHsv.h / 360) * hrect.height) + 'px';
    }
  }

  // Push cwHsv into current.color (and the toolbar swatch + hex inputs).
  function applyColorWheel() {
    var c = hsvToRgb(cwHsv.h, cwHsv.s, cwHsv.v);
    var hex = rgbToHex(c.r, c.g, c.b);
    setPaintColor(hex);
    var hexIn = byId('paintCwHex');
    if (hexIn && hexIn !== document.activeElement) hexIn.value = hex;
    refreshTip();
    positionColorWheel();
  }

  // Re-read current.color into cwHsv (after eyedrop / toolbar input / brush pick).
  function syncColorWheel() {
    var c = hexToRgb(current ? current.color : '#1a1a1a');
    var h = rgbToHsv(c.r, c.g, c.b);
    cwHsv.h = h.h; cwHsv.s = h.s; cwHsv.v = h.v;
    renderColorWheel();
  }

  // Update the toolbar colour indicator (display-only swatch).
  function setColorSwatch(hex) {
    var sw = byId('paintColor');
    if (sw) sw.style.background = hex;
  }

  // Record the picked foreground colour (global) and push it onto the current
  // brush, so the swatch, color wheel and every paint path stay in step.
  function setPaintColor(hex) {
    if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) hex = fgColor;
    hex = hex.toLowerCase();
    fgColor = hex;
    if (current) current.color = hex;
    setColorSwatch(hex);
    return hex;
  }

  function makeBrush(name, o) {
    return Object.assign({
      name: name, engine: 'pixel', radius: 40, opacity: 1, hardness: 0.8,
      spacing: 0.15, rotation: 0, color: '#1a1a1a', tip: null,
      preview: null, eraser: false,
      followDir: true, builtin: false,   // rotate the tip with the stroke
      mypaint: null // libmypaint settings: {dabsPerActual,dabsPerBasic,baseRadius,
                    //  grainOffset,radiusByRandom,opaqueLinearize}
    }, o || {});
  }

  // Standard-normal-ish gaussian, matching libmypaint's rand_gauss exactly:
  // the sum of four uniforms (Irwin–Hall), scaled to unit variance and bounded
  // to ±3.46 — the same bounded bell curve the real MyPaint brushes use. An
  // unbounded Box-Muller would let rare extreme values blow up radius noise
  // into giant blobs.
  function gauss() {
    return (Math.random() + Math.random() + Math.random() + Math.random()) * 1.73205080757 - 3.46410161514;
  }

  // Distance between dabs for the current brush at radius r, in pixels.
  // Krita's pixel brushes space by a fraction of the DAB DIAMETER
  // (KisPaintOpUtils::effectiveSpacing: spacing = spacingVal * dabWidth), and
  // auto-spaced brushes use coeff*sqrt(diameter). MyPaint brushes use
  // libmypaint's count_dabs_to (dabs = dist*(dpa/r + dpb/baseR)), which for
  // constant-radius brushes equals 1 dab per r/(dpa+dpb) px — i.e. a fixed
  // diameter fraction too. Both fold into current.spacing (a Krita-style % of
  // diameter) carried by the brush preset, so spacing scales with brush size
  // automatically and is not user-adjustable.
  function dabStep(r) {
    if (current.mypaint) return mypaintStep(2 * r * 0.2, 0); // tiny default; real steps come from stampSegment
    // Krita's native engine clamps spacing to MIN_DISTANCE_SPACING = 0.5px.
    return Math.max(0.5, 2 * r * current.spacing);
  }

  // libmypaint count_dabs_to: the number of dabs for a segment of `dist` px OVER
  // `dt` seconds is the SUM of three density terms (not the tighter of them):
  //   dabs = dist_eff / ACTUAL_RADIUS * dabs_per_actual_radius
  //        + dist_eff / base_radius   * dabs_per_basic_radius
  //        + dt                         * dabs_per_second
  // where, for an ELLIPTICAL dab (ratio > 1), dist_eff is the segment distance
  // transformed into ellipse space (movement along the ellipse's long axis counts
  // ratio x more, matching count_dabs_to in mypaint-brush.c). The step is then
  // dist / dabs along the PLAIN path. Take care that this calls into the same
  // ellipse convention as stampDab: long axis along `angle`, half-length r;
  // perpendicular half-length r/ratio (rasterizer calculate_rr).
  // For MyPaint brushes only.
  function mypaintStep(dist, dt, ratio, angle, dx, dy) {
    var mp = current.mypaint || {};
    var dpa = mp.dabsPerActual || 0, dpb = mp.dabsPerBasic || 0;
    var dps = mp.dabsPerSecond || 0;
    var r = Math.max(0.05, current.radius);
    var br = (mp.baseRadius > 0) ? mp.baseRadius : r;
    var effDist = dist;
    if (ratio > 1 && isFinite(dx) && isFinite(dy) && isFinite(angle)) {
      // Same transform as calculate_rr / count_dabs_to.
      var cs = Math.cos(angle), sn = Math.sin(angle);
      var yyr = (dy * cs - dx * sn) * ratio;
      var xxr = dy * sn + dx * cs;
      effDist = Math.hypot(yyr, xxr);
    }
    var dabs = effDist / r * dpa + effDist / br * dpb + Math.max(0, dt || 0) * dps;
    if (!(dabs > 0)) dabs = dist / Math.max(0.05, 2 * r * 0.25); // fallback: 25% of diameter
    return Math.max(0.05, dist / dabs);
  }

  // Krita's shipped default presets (the same set bundled in brushes/, so the
  // async loader upgrades them with real tips/previews). Listed in Krita's
  // alphabetical order; the default SELECTED brush is "b) Basic-5 Size"
  // (KisPaintopBox::findDefaultPresets), resolved via defaultBrush() below.
  function defaultBrushes() {
    return [
      makeBrush('a)_Eraser_Circle', { engine: 'paintbrush', radius: 25, opacity: 1, hardness: 0.87, spacing: 0.17, rotation: 0, eraser: true, builtin: true }),
      makeBrush('b)_Basic-5_Size', { engine: 'paintbrush', radius: 20, opacity: 1, hardness: 1, spacing: 0.126, rotation: 0, eraser: false, builtin: true }),
      makeBrush('c)_Pencil_1_Sketch_(mypaint)', { engine: 'mypaint', radius: 1.48, opacity: 0.34, hardness: 0.8, spacing: 0.07, rotation: 0, eraser: false, builtin: true, mypaint: { dabsPerActual: 3.57, dabsPerBasic: 3.54, baseRadius: 1.48, grainOffset: 2.95, radiusByRandom: 0.88, opaqueLinearize: 0.45 } }),
      makeBrush('c)_Pencil_2b_(mypaint)', { engine: 'mypaint', radius: 2.12, opacity: 0.15, hardness: 1, spacing: 0.125, rotation: 0, eraser: false, builtin: true, mypaint: { dabsPerActual: 4, dabsPerBasic: 0, baseRadius: 2.12, grainOffset: 1.06, radiusByRandom: 0, opaqueLinearize: 0 } }),
      makeBrush('d)_Ink_pen_(mypaint)', { engine: 'mypaint', radius: 2.61, opacity: 1, hardness: 0.9, spacing: 0.227, rotation: 0, eraser: false, builtin: true, mypaint: { dabsPerActual: 2.2, dabsPerBasic: 0, baseRadius: 2.61, grainOffset: 0, radiusByRandom: 0, opaqueLinearize: 0.9 } }),
      makeBrush('e)_Marker_Medium_(mypaint)', { engine: 'mypaint', radius: 10.07, opacity: 1, hardness: 1, spacing: 0.226, rotation: 0, eraser: false, builtin: true, mypaint: { dabsPerActual: 0, dabsPerBasic: 2.21, baseRadius: 10.07, grainOffset: 0, radiusByRandom: 0, opaqueLinearize: 0.9 } }),
      makeBrush('e)_Marker_Plain_(mypaint)', { engine: 'mypaint', radius: 18.17, opacity: 1, hardness: 1, spacing: 0.087, rotation: 0, eraser: false, builtin: true, mypaint: { dabsPerActual: 5.75, dabsPerBasic: 0, baseRadius: 18.17, grainOffset: 0, radiusByRandom: 0, opaqueLinearize: 0.9 } }),
      makeBrush('i)_Wet_Knife_Plus_(mypaint)', { engine: 'mypaint', radius: 20.09, opacity: 1, hardness: 0.9, spacing: 0.063, rotation: 0, eraser: false, builtin: true, mypaint: { dabsPerActual: 2, dabsPerBasic: 6, baseRadius: 20.09, grainOffset: 0, radiusByRandom: 0, opaqueLinearize: 0 } }),
      makeBrush('i)_Wet_Paint_Plus_(mypaint)', { engine: 'mypaint', radius: 18.17, opacity: 1, hardness: 0.48, spacing: 0.042, rotation: 0, eraser: false, builtin: true, mypaint: { dabsPerActual: 6, dabsPerBasic: 6, baseRadius: 18.17, grainOffset: 0, radiusByRandom: 0, opaqueLinearize: 0 } }),
      makeBrush('j)_WaterC_Basic_Lines-Dry', { engine: 'paintbrush', radius: 8, opacity: 0.25, hardness: 0.8, spacing: 0.25, rotation: 0, eraser: false, builtin: true }),
      makeBrush('j)_WaterC_Basic_Lines-Wet-Pattern', { engine: 'paintbrush', radius: 10, opacity: 1, hardness: 0.8, spacing: 0.08, rotation: 0, eraser: false, builtin: true }),
      makeBrush('j)_WaterC_Basic_Lines-Wet', { engine: 'paintbrush', radius: 8, opacity: 0.15, hardness: 0.8, spacing: 0.25, rotation: 0, eraser: false, builtin: true }),
      makeBrush('j)_WaterC_Basic_Round-Fringe_02', { engine: 'paintbrush', radius: 22.8, opacity: 1, hardness: 0.8, spacing: 0.15, rotation: 0.19, eraser: false, builtin: true }),
      makeBrush('j)_WaterC_Basic_Round-Grain', { engine: 'paintbrush', radius: 7.5, opacity: 1, hardness: 0.8, spacing: 0.05, rotation: 0.19, eraser: false, builtin: true }),
      makeBrush('j)_WaterC_Basic_Round-Grunge', { engine: 'paintbrush', radius: 4.41, opacity: 1, hardness: 0.8, spacing: 0.158, rotation: 0, eraser: false, builtin: true }),
      makeBrush('j)_WaterC_Flat_Big-Grain_Tilt', { engine: 'paintbrush', radius: 12.2, opacity: 1, hardness: 0.8, spacing: 0.15, rotation: 0, eraser: false, builtin: true }),
      makeBrush('j)_WaterC_Flat_Decay_Tilt', { engine: 'paintbrush', radius: 9.15, opacity: 1, hardness: 0.8, spacing: 0.1, rotation: 0, eraser: false, builtin: true }),
      makeBrush('j)_WaterC_Special_Blobs', { engine: 'paintbrush', radius: 87.9, opacity: 1, hardness: 0.8, spacing: 0.06, rotation: 0, eraser: false, builtin: true }),
      makeBrush('j)_WaterC_Special_Splats', { engine: 'paintbrush', radius: 93.82, opacity: 1, hardness: 0.8, spacing: 0.06, rotation: 0.31, eraser: false, builtin: true }),
      makeBrush('j)_WaterC_Spread-Pattern', { engine: 'paintbrush', radius: 49.41, opacity: 0.35, hardness: 0.8, spacing: 0.04, rotation: 0, eraser: false, builtin: true }),
      makeBrush('j)_WaterC_Spread', { engine: 'paintbrush', radius: 45, opacity: 0.33, hardness: 0.8, spacing: 0.04, rotation: 0, eraser: false, builtin: true }),
      makeBrush('j)_WaterC_Spread_WideArea', { engine: 'paintbrush', radius: 15.63, opacity: 1, hardness: 0.8, spacing: 0.06, rotation: 0, eraser: false, builtin: true }),
      makeBrush('j)_WaterC_Water-Pattern', { engine: 'colorsmudge', radius: 13.33, opacity: 1, hardness: 0.8, spacing: 2, rotation: 0, eraser: false, builtin: true })
    ];
  }

  // Krita's default brush when the tool opens: "b) Basic-5 Size".
  function defaultBrush() {
    for (var i = 0; i < brushList.length; i++) {
      if (brushList[i].name === 'b)_Basic-5_Size') return brushList[i];
    }
    return brushList[0];
  }

  // ---- tip rendering ----------------------------------------------------------

  // Krita ALPHAMASK tip conversion: draw the tip image into dstG (size x size)
  // as a tinted mask where DARK pixels are the dab. Krita's dab mask for
  // grayscale tips is `qAlpha * (255 - qRed) / 255` (KoColorSpaceTraits.h /
  // KoColorSpace.h: dstA = qAlpha(brush) * (255 - qRed(brush)) / 255), i.e. the
  // brush shape is stored as dark pixels on a white background (PNG) or as a
  // direct alpha byte (GBR, pre-inverted by parseGbrBytes). The over-white
  // composite handles grayscale-with-alpha tips: it equals qAlpha*(255-qRed)/255
  // after inversion. Colour tips are LIGHTNESSMAP: luminance stays the alpha.
  function paintTipMask(tip, dstG, size) {
    dstG.setTransform(1, 0, 0, 1, 0, 0);
    dstG.clearRect(0, 0, size, size);
    if (!tip || !tip.width) return; // no tip to mask (procedural/empty brushes)
    dstG.drawImage(tip, 0, 0, size, size);
    var img = dstG.getImageData(0, 0, size, size);
    var dd = img.data;
    // Grayscale detection with a small tolerance: scaling a gray tip with
    // bilinear interpolation can round the channels to slightly different
    // values (e.g. 149,149,150) on edge pixels. One such pixel must not flip
    // the whole mask out of ALPHAMASK mode (which would render the white
    // background opaque -> a square tip).
    var allGray = true;
    for (var i = 0; i < dd.length && allGray; i += 4) {
      if (Math.abs(dd[i] - dd[i + 1]) > 2 || Math.abs(dd[i + 1] - dd[i + 2]) > 2) allGray = false;
    }
    for (var j = 0; j < dd.length; j += 4) {
      // over-white composite (Krita draws grayscale-with-alpha tips over white
      // at load time), then luminance -> alpha, INVERTED for ALPHAMASK brushes
      // so the dark pixels (the brush shape) paint and white stays empty.
      var a = dd[j + 3] / 255;
      var r = dd[j] * a + 255 * (1 - a);
      var gr = dd[j + 1] * a + 255 * (1 - a);
      var b = dd[j + 2] * a + 255 * (1 - a);
      var lum = 0.299 * r + 0.587 * gr + 0.114 * b;
      dd[j] = dd[j + 1] = dd[j + 2] = 255;
      dd[j + 3] = allGray ? (255 - lum) : lum;
    }
    // The mask is left as WHITE with the brush shape in its alpha channel. The
    // per-dab colour is applied later (stampDab / brushPreview) by tinting this
    // mask, which lets MyPaint colour dynamics (color_h/s/v) and smudge recolour
    // each dab without rebuilding the mask.
    dstG.putImageData(img, 0, 0);
  }

  function refreshTip() {
    if (!tipCanvas) {
      tipCanvas = document.createElement('canvas');
      tipCanvas.width = 256; tipCanvas.height = 256;
    }
    var g = tipCanvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, 256, 256);
    // tipCanvas is kept as a WHITE alpha mask (shape only); the dab colour is
    // applied per-dab by stampDab(), so switching the brush colour is instant.
    if (current.tip && current.tip.width) {
      paintTipMask(current.tip, g, 256);
    } else {
      // Procedural round tip with a soft/hard falloff (Krita "hardness"). The
      // falloff uses a smooth curve like Krita's soft brushes. Rendered WHITE;
      // stampDab() tints it to the brush colour at stamp time.
      var inner = clamp(current.hardness, 0, 1);
      var grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      if (inner > 0.02) grd.addColorStop(inner, 'rgba(255,255,255,1)');
      grd.addColorStop(Math.max(inner, 0.02) + (1 - Math.max(inner, 0.02)) * 0.55, 'rgba(255,255,255,0.55)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(128, 128, 128, 0, Math.PI * 2);
      g.fill();
    }
    // Invalidate the per-colour tint cache whenever the mask shape changes.
    tintColorKey = null;
  }

  // ---- stamping ---------------------------------------------------------------
  // Krita-style dab placement: dabs are stamped every `spacing` pixels of path
  // length, and NOTHING is stamped while the pointer is stationary (Krita's
  // KisDistanceInformation accumulates distance and only emits a dab when the
  // accumulated distance crosses the spacing interval; see getNextPointPosition).
  var dabCarry = 0;        // distance accumulated since the last dab
  var dabLastPos = null;   // position of the last dab (for follow-dir angle)

  // Per-colour tint cache: tipCanvas holds the brush SHAPE as a white alpha
  // mask; tints are applied on demand so each dab can have its own colour
  // (MyPaint color_h/s/v + smudge). Cached by colour to avoid re-tinting the
  // common single-colour case.
  var tintCanvas = null, tintColorKey = null;
  function tintedTipFor(colRgb) {
    var key = colRgb.r + ',' + colRgb.g + ',' + colRgb.b;
    if (key === tintColorKey && tintCanvas) return tintCanvas;
    if (!tintCanvas) {
      tintCanvas = document.createElement('canvas');
      tintCanvas.width = 256; tintCanvas.height = 256;
    }
    var tg = tintCanvas.getContext('2d');
    tg.setTransform(1, 0, 0, 1, 0, 0);
    tg.globalCompositeOperation = 'source-over';
    tg.clearRect(0, 0, 256, 256);
    tg.drawImage(tipCanvas, 0, 0);
    tg.globalCompositeOperation = 'source-in';
    tg.fillStyle = 'rgb(' + colRgb.r + ',' + colRgb.g + ',' + colRgb.b + ')';
    tg.fillRect(0, 0, 256, 256);
    tg.globalCompositeOperation = 'source-over';
    tintColorKey = key;
    return tintCanvas;
  }

  // col: optional {r,g,b} (0..255). When omitted the dab uses current.color.
  function stampDab(x, y, r, op, rot, ratio, col) {
    if (eraserOn || (current && current.eraser)) paintCtx.globalCompositeOperation = 'destination-out';
    else paintCtx.globalCompositeOperation = 'source-over';
    paintCtx.globalAlpha = clamp(op, 0, 1);
    var rad = (rot == null) ? (current.rotation * Math.PI / 180) : rot;
    var colRgb = col || hexToRgb(current.color);
    var tip = tintedTipFor(colRgb);
    paintCtx.save();
    paintCtx.translate(x, y);
    paintCtx.rotate(rad);
    if (ratio && ratio > 1) {
      // Elliptical dab (MyPaint elliptical_dab_ratio/angle). The rasterizer
      // (mypaint-tiled-surface.c calculate_rr) keeps the half-length r ALONG
      // the dab angle and compresses the PERPENDICULAR axis to r/ratio, so the
      // aspect ratio is ratio: after rotating by `rad`, squeeze only the
      // perpendicular (y) axis. Scaling x by ratio instead made marker dabs
      // ratio x too long along the stroke.
      paintCtx.scale(1, 1 / ratio);
      paintCtx.drawImage(tip, -r, -r, 2 * r, 2 * r);
    } else {
      paintCtx.drawImage(tip, -r, -r, 2 * r, 2 * r);
    }
    paintCtx.restore();
  }

  // Radius / opacity at the given pressure. Krita pixel brushes have a FIXED
  // radius (the preset size) and opacity unless their Size/Opacity option curves
  // are enabled (applied in pixelDab). There is no built-in pressure factor - a
  // mouse (pressure 0.5) still paints at full size/opacity, exactly like Krita.
  // MyPaint brushes override both inside mypaintDab.
  function dabRadius(press) {
    return current.radius;
  }
  function dabOpacity(press) {
    return current.opacity;
  }

  // Evaluate a Krita curve-option at the current pointer/dab state, following
  // KisCurveOption::computeValueComponents: every ACTIVE sensor's curve is
  // evaluated at its own input, and the results are combined by curveMode
  // (0=multiply default, 1=add, 2=max, 3=min, 4=difference). If the option is
  // not enabled (no dynamics) the caller keeps its base value (NaN is
  // returned). `random` is the per-dab [0,1] value used by fuzzy/random sensors.
  function kppEval(curve, press, random) {
    if (!curve || !curve.enabled) return NaN;
    var vals = [];
    var sensors = curve.sensors || [];
    for (var i = 0; i < sensors.length; i++) {
      var s = sensors[i];
      var pts = s.pts || curve.common;
      if (!pts) continue;
      var x;
      var id = s.id;
      if (!id) continue;
      if (id.indexOf('pressure') === 0) x = press;
      else if (id.indexOf('fuzzy') === 0 || id === 'random') x = random;
      else if (id === 'tangentialpressure') x = 0.5;
      else if (id === 'speed' || id === 'drawingangle' || id === 'rotation' ||
               id === 'distance' || id === 'time' || id === 'fade' ||
               id === 'xtilt' || id === 'ytilt' || id === 'tiltdirection' ||
               id === 'tilt elevation' || id === 'perspective') x = 0.5;
      else continue;
      var v = curveEval(pts, x);
      if (isFinite(v)) vals.push(v);
    }
    if (!vals.length) return NaN;
    if (vals.length === 1) return clamp(vals[0], 0, 1);
    var mode = curve.mode || 0;
    var acc;
    if (mode === 1) { acc = 0; for (var j = 0; j < vals.length; j++) acc += vals[j]; }
    else if (mode === 2) { acc = Math.max.apply(null, vals); }
    else if (mode === 3) { acc = Math.min.apply(null, vals); }
    else if (mode === 4) { acc = Math.max.apply(null, vals) - Math.min.apply(null, vals); }
    else { acc = 1; for (var j2 = 0; j2 < vals.length; j2++) acc *= vals[j2]; }
    return clamp(acc, 0, 1);
  }

  // Krita pixel-brush dynamics: apply the option curves (Size/Opacity/Rotation/
  // Scatter) evaluated at the current pressure / per-dab random. Each checkable
  // option is only applied when its "Pressure<Option>" param is true
  // (kpp.used.*), matching KisKritaSensorPack::read. Returns {x, y, r, op, rot}.
  function pixelDab(x, y, r, op, press, rot) {
    var k = current.kpp;
    if (!k) return { x: x, y: y, r: r, op: op, rot: rot };
    var rand = Math.random();
    // Size: the curve value is a MULTIPLIER of the full size (KisSizeOption:
    // dab size = sizeValue * curveValue).
    if (k.used.size) {
      var sc = kppEval(k.sizeCurve, press, rand);
      if (isFinite(sc)) r = current.radius * sc;
    }
    // Opacity: curve value is a 0..1 multiplier of the preset opacity.
    var oc = kppEval(k.opacityCurve, press, rand);
    if (isFinite(oc)) op = current.opacity * oc;
    // Rotation: curve value is a fraction of 360 degrees added to the base.
    if (k.used.rotation) {
      var rc = kppEval(k.rotationCurve, press, rand);
      if (isFinite(rc)) rot = (rot || 0) + rc * 2 * Math.PI;
    }
    // Scatter: KisScatterOption amplitude = (rand*2-1) * DAB DIAMETER *
    // strengthValue * curveValue, per enabled axis. strengthValue = the stored
    // ScatterValue (0..5 scale), NOT pixels.
    if (k.used.scatter && k.scatter > 0 && (k.scatterAxisX || k.scatterAxisY)) {
      var sval = k.scatter;
      var scv = kppEval(k.scatterCurve, press, rand);
      if (!isFinite(scv)) scv = 1;
      var amp = (2 * current.radius) * Math.max(0, sval) * Math.max(0, scv);
      if (amp > 0) {
        if (k.scatterAxisX) x += (Math.random() * 2 - 1) * amp;
        if (k.scatterAxisY) y += (Math.random() * 2 - 1) * amp;
      }
    }
    return { x: x, y: y, r: r, op: op, rot: rot };
  }

  // ---- MyPaint dynamics engine ------------------------------------------------
  // Faithful libmypaint evaluation: every brush setting is `base_value + Σ
  // curve_i(input_i)` where each curve is piecewise-linear over its input
  // (mypaint_mapping_calculate) and extrapolates beyond the ends with the end
  // segments. Inputs: pressure, speed1/speed2 (smoothed stroke speed),
  // random (per-dab), stroke (stroke-length state), direction, custom.

  // Piecewise-linear curve eval matching mypaint_mapping_calculate: for x below
  // the first point it uses the first segment, above the last point the last
  // segment (linear extrapolation), in between the containing segment.
  function curveEval(pts, x) {
    if (!Array.isArray(pts) || pts.length < 2) return 0;
    var n = pts.length;
    var i = 1;
    while (i < n - 1 && x > pts[i][0]) i++;
    var p0 = pts[i - 1], p1 = pts[i];
    var dx = p1[0] - p0[0];
    if (!dx) return p1[1];
    return p0[1] + (p1[1] - p0[1]) * (x - p0[0]) / dx;
  }

  // Evaluate a mypaint setting (brush.mySettings[name]) at the given inputs.
  // Returns NaN if the setting is absent. `mySt` is the stroke state (for the
  // speed mapping constants), or null to skip speed inputs.
  function mySetting(brush, name, inputs) {
    var s = brush.mySettings && brush.mySettings[name];
    if (!s) return NaN;
    var v = isFinite(+s.base_value) ? +s.base_value : 0;
    var ins = s.inputs;
    if (ins) {
      for (var k in ins) {
        var pts = ins[k];
        var x = inputs[k];
        if (typeof x !== 'number' || !isFinite(x)) continue;
        v += curveEval(pts, x);
      }
    }
    return v;
  }

  // libmypaint speed mapping (settings_base_values_have_changed): the stored
  // gamma is exponentiated BEFORE the log-mapping constants are derived:
  //   gamma   = exp(speed_gamma)
  //   m       = 0.015 * (45 + gamma)
  //   q       = 0.5 - m * log(45 + gamma)
  //   input   = log(gamma + smoothed_speed) * m + q
  // `speed` is the low-passed physical speed in px/sec. A preset with
  // speed1_gamma=4 therefore uses gamma = e^4 ~ 54.6, not 4.
  function speedInput(gammaRaw, speed) {
    var gamma = Math.exp(gammaRaw);
    var m = 0.015 * (45 + gamma);
    var q = 0.5 - m * Math.log(45 + gamma);
    return Math.log(gamma + speed) * m + q;
  }

  // Build the inputs map for a dab: interpolated stroke inputs + per-dab random.
  // `a` and `b` are {press, sp1, sp2, dir, st} at the segment ends, `t` 0..1.
  function dabInputs(a, b, t) {
    return {
      pressure: a.press + (b.press - a.press) * t,
      speed1: a.sp1 + (b.sp1 - a.sp1) * t,
      speed2: a.sp2 + (b.sp2 - a.sp2) * t,
      random: Math.random(),
      stroke: a.st + (b.st - a.st) * t,
      direction: a.dir + (b.dir - a.dir) * t,
      custom: 0, declination: 90, ascension: 0, viewzoom: 1, barrel_rotation: 0
    };
  }

  // Per-stroke mypaint state: speed filters, direction vector, stroke length,
  // dab counter and timing. Initialised on pointer down, updated per move event.
  var mySt = null;

  function myStrokeInit(p) {
    mySt = {
      sp1: 0, sp2: 0, dirDx: 1, dirDy: 0, dirAngDx: 1, dirAngDy: 0,
      stroke: 1, lastT: null, lastX: p.x, lastY: p.y, lastPress: p.press,
      lastDur: 0, dabsPerSecond: 0, dabsPerSecAcc: 0,
      normDxSlow: 0, normDySlow: 0, actX: p.x, actY: p.y
    };
    if (current && current.mySettings) {
      var d = current.mySettings.dabs_per_second;
      if (d && isFinite(+d.base_value)) mySt.dabsPerSecond = Math.max(0, +d.base_value);
      else if (current.mypaint && isFinite(current.mypaint.dabsPerSecond)) mySt.dabsPerSecond = Math.max(0, current.mypaint.dabsPerSecond);
      // Krita overrides a MyPaint brush's color_h/s/v with the active
      // foreground colour on every stroke (MyPaintPaintOp.cpp setColor ->
      // MyPaintPaintOpPreset::setColor writes COLOR_H/S/V base values from the
      // picked colour), so the preset's "intrinsic" colour must NOT win: paint
      // with the app's selected colour, exactly like Krita.
      mySt.baseRgb = hexToRgb(current.color);
      mySt.smudgeRgb = { r: mySt.baseRgb.r, g: mySt.baseRgb.g, b: mySt.baseRgb.b };
    } else if (current) {
      mySt.baseRgb = hexToRgb(current.color);
      mySt.smudgeRgb = { r: mySt.baseRgb.r, g: mySt.baseRgb.g, b: mySt.baseRgb.b };
    }
  }

  // Advance the mypaint stroke state for a pointer event at (x, y, press, tSec):
  // speed low-pass filters, direction vector (direction_filter smoothing), and
  // the stroke-length accumulator. Returns the computed inputs for the event.
  function myStrokeUpdate(x, y, press, tSec, brush) {
    if (!mySt) return null;
    var dt = 0.0001;
    if (mySt.lastT != null) {
      dt = tSec - mySt.lastT;
      if (!isFinite(dt) || dt <= 0) dt = 0.0001;
      if (dt > 0.1) dt = 0.1;
    }
    mySt.lastT = tSec;
    var dx = x - mySt.lastX, dy = y - mySt.lastY;
    mySt.lastX = x; mySt.lastY = y;
    var dist = Math.hypot(dx, dy);
    var normSpeed = dt > 0 ? dist / dt : 0; // px / sec
    var normDX = dt > 0 ? dx / dt : 0;      // px / sec velocity vector
    var normDY = dt > 0 ? dy / dt : 0;
    var baseR = Math.max(0.05, brush.radius);
    var s = brush.mySettings || {};
    // offset_by_speed filter: slow low-pass of the velocity VECTOR (libmypaint
    // NORM_DX/DY_SLOW), time constant exp(offset_by_speed_slowness*0.01)-1
    // with a 0.002 floor to avoid placing dabs far off the stroke.
    var obss = isFinite(+(s.offset_by_speed_slowness || {}).base_value) ? +(s.offset_by_speed_slowness).base_value : 1;
    var vsTau = Math.exp(obss * 0.01) - 1;
    if (vsTau < 0.002) vsTau = 0.002;
    var fvs = 1 - Math.exp(-dt / vsTau);
    mySt.normDxSlow += (normDX - mySt.normDxSlow) * fvs;
    mySt.normDySlow += (normDY - mySt.normDySlow) * fvs;
    var g1 = isFinite(+(s.speed1_gamma || {}).base_value) ? +(s.speed1_gamma).base_value : 0;
    var g2 = isFinite(+(s.speed2_gamma || {}).base_value) ? +(s.speed2_gamma).base_value : 0;
    var sl1 = isFinite(+(s.speed1_slowness || {}).base_value) ? +(s.speed1_slowness).base_value : 1;
    var sl2 = isFinite(+(s.speed2_slowness || {}).base_value) ? +(s.speed2_slowness).base_value : 1;
    var f1 = 1 - Math.exp(-dt / Math.max(0.001, sl1));
    var f2 = 1 - Math.exp(-dt / Math.max(0.001, sl2));
    mySt.sp1 += (normSpeed - mySt.sp1) * f1;
    mySt.sp2 += (normSpeed - mySt.sp2) * f2;
    // direction (360) vector smoothed by direction_filter
    var df = isFinite(+(s.direction_filter || {}).base_value) ? +(s.direction_filter).base_value : 0;
    var dirTau = Math.exp(df * 0.5) - 1;
    var fdir = dirTau > 0 ? 1 - Math.exp(-dist / dirTau) : 1;
    var pdx = dist > 0 ? dx / dist : 0, pdy = dist > 0 ? dy / dist : 0;
    mySt.dirDx += (pdx - mySt.dirDx) * fdir;
    mySt.dirDy += (pdy - mySt.dirDy) * fdir;
    mySt.dirAngDx += (pdx - mySt.dirAngDx) * fdir;
    mySt.dirAngDy += (pdy - mySt.dirAngDy) * fdir;
    // stroke-length accumulator (stroke_duration_logarithmic / holdtime)
    var sdl = isFinite(+(s.stroke_duration_logarithmic || {}).base_value) ? +(s.stroke_duration_logarithmic).base_value : Math.log(0.5);
    var freq = Math.exp(-sdl);
    var hold = isFinite(+(s.stroke_holdtime || {}).base_value) ? +(s.stroke_holdtime).base_value : 0;
    var normDist = dist / baseR;
    var stroke = Math.max(0, mySt.stroke + normDist * freq);
    var wrap = 1 + Math.max(0, hold);
    if (stroke >= wrap && wrap > 9.9 + 1) mySt.stroke = 1;
    else if (stroke >= wrap) mySt.stroke = stroke % wrap;
    else mySt.stroke = stroke;
    // direction input: 0..180
    var dir = Math.atan2(mySt.dirDy, mySt.dirDx);
    var dirDeg = (dir * 180 / Math.PI + 180) % 180;
    // pressure_gain_log scales the reported pressure (INPUT(PRESSURE) in
    // libmypaint: pressure * exp(pressure_gain_log)).
    var pgl = isFinite(+(s.pressure_gain_log || {}).base_value) ? +(s.pressure_gain_log).base_value : 0;
    if (pgl !== 0) press = press * Math.exp(pgl);
    return {
      press: press,
      sp1: speedInput(g1, mySt.sp1),
      sp2: speedInput(g2, mySt.sp2),
      dir: dirDeg,
      st: mySt.stroke
    };
  }

  // Compatibility shim used by the headless tests (and as a pure-grain fallback
  // when no stroke input state is available): radius/opacity noise only.
  function mypaintGrain(x, y, r, op) {
    var m = current.mypaint;
    if (!m) return { x: x, y: y, r: r, op: op };
    if (m.grainOffset > 0) {
      x += gauss() * m.grainOffset * r;
      y += gauss() * m.grainOffset * r;
    }
    if (m.radiusByRandom > 0) {
      var base = Math.max(0.05, r || m.baseRadius);
      var noisy = Math.exp(Math.log(base) + gauss() * m.radiusByRandom);
      noisy = clamp(noisy, 0.2, 1000);
      var corr = Math.pow(base / noisy, 2);
      if (corr <= 1) op *= corr;
      r = noisy;
    }
    return { x: x, y: y, r: r, op: op };
  }

  // Full MyPaint dab evaluation (replaces the simpler mypaintGrain): computes
  // the dab's radius, opacity, positional scatter and elliptical shape from the
  // brush's libmypaint settings evaluated at the interpolated stroke inputs,
  // exactly like libmypaint's prepare_and_draw_dab.
  function mypaintDab(x, y, r, op, from, to, t, distToDab) {
    var brush = current;
    var inputs = dabInputs(from, to, t);
    var ms = brush.mySettings || {};
    var mp = brush.mypaint || {};
    if (!brush.mySettings) {
      // No parsed settings (e.g. a brush restored from an old save made before
      // the engine stored them): degrade to the brush's nominal size/opacity
      // instead of silently evaluating to 0 and painting nothing.
      return { x: x, y: y, r: clamp(r, 0.2, 1000), op: clamp(op, 0, 1), ang: null, ratio: 1, col: null };
    }
    // base_radius is exp(base_value of radius_logarithmic) - libmypaint uses it
    // for the scatter amplitude and the dabs-per-basic-radius spacing term. It
    // is NOT the input-mapped radius.
    var baseRadius = (mp.baseRadius > 0) ? mp.baseRadius : Math.max(0.05, current.radius);
    var rlBase = 0;
    var rls = brush.mySettings && brush.mySettings.radius_logarithmic;
    if (rls && isFinite(+rls.base_value)) rlBase = +rls.base_value;
    var centerLog = Math.log(Math.max(0.2, current.radius));
    // For the scatter amplitude libmypaint uses exp(BASEVAL(radius_logarithmic))
    // directly. After a resize that base is the new size, so when current.radius
    // differs from the parsed base (mp.baseRadius), prefer it.
    if (Math.abs(current.radius - baseRadius) > 0.01) baseRadius = current.radius;

    // ---- opaque = clamp(max(0, opaque) * opaque_multiply, 0, 1) -----------
    var opaque = mySetting(brush, 'opaque', inputs);
    if (!isFinite(opaque)) opaque = 0;
    var opm = mySetting(brush, 'opaque_multiply', inputs);
    if (!isFinite(opm)) opm = 1;
    var opacity = clamp(Math.max(0, opaque) * opm, 0, 1);

    // ---- opaque_linearize: per-dab alpha compensation for dense stamping ----
    var ol = mySetting(brush, 'opaque_linearize', inputs);
    if (isFinite(ol) && ol > 0) {
      var dpp = (mp.dabsPerActual + mp.dabsPerBasic) * 2;
      if (dpp < 1) dpp = 1;
      var lin = 1 + ol * (dpp - 1);
      opacity = 1 - Math.pow(Math.max(0, 1 - opacity), 1 / lin);
    }

    // ---- radius_logarithmic (with pressure/speed/etc curves) -> radius.
    // ACTUAL_RADIUS = exp(SETTING(radius_logarithmic)). Resizing the brush
    // (Krita setPaintOpSize -> base = ln(size/2)) shifts the whole curve, so
    // shift by the user's current.radius relative to the preset base.
    var rl = mySetting(brush, 'radius_logarithmic', inputs); // may be NaN
    var radius = Math.max(0.05, r);
    if (isFinite(rl)) radius = clamp(Math.exp(rl - rlBase + centerLog), 0.2, 1000);

    // ---- position: slow_tracking lag, then offset_by_speed, then random -----
    var stpd = mySetting(brush, 'slow_tracking_per_dab', inputs);
    if (isFinite(stpd) && stpd > 0 && mySt) {
      // libmypaint lags ACTUAL_X/Y behind the pointer by step_ddab / slowness
      // (one update per dab, hence step_ddab ~ 1.0) - a trailing, sketchy hand.
      var facSt = 1 - Math.exp(-1 / stpd);
      mySt.actX += (x - mySt.actX) * facSt;
      mySt.actY += (y - mySt.actY) * facSt;
      x = mySt.actX; y = mySt.actY;
    }
    var obs = mySetting(brush, 'offset_by_speed', inputs);
    if (isFinite(obs) && obs !== 0 && mySt) {
      // x += NORM_DX_SLOW * offset_by_speed * 0.1 (smoothed velocity vector)
      x += mySt.normDxSlow * obs * 0.1;
      y += mySt.normDySlow * obs * 0.1;
    }
    var obr = mySetting(brush, 'offset_by_random', inputs);
    if (isFinite(obr) && obr > 1e-4) {
      // x += rand_gauss * max(0, offset_by_random) * base_radius
      x += gauss() * obr * baseRadius;
      y += gauss() * obr * baseRadius;
    }
    var r = radius;

    // ---- radius_by_random: radius_log = SETTING(radius_log) + gauss*value,
    // with per-dab alpha correction SQR(ACTUAL_RADIUS / radius). (This does NOT
    // change the ACTUAL_RADIUS used by dabs_per_actual_radius - a separate
    // term - so spacing is unchanged, matching libmypaint.)
    var rbr = mySetting(brush, 'radius_by_random', inputs);
    if (isFinite(rbr) && rbr > 0) {
      var noisyLog = (isFinite(rl) ? (rl - rlBase + centerLog) : Math.log(radius)) + gauss() * rbr;
      var noisy = clamp(Math.exp(noisyLog), 0.2, 1000);
      var ac = Math.pow(radius / noisy, 2);
      if (ac <= 1) opacity = opacity * ac;
      radius = noisy;
    }
    var r = radius;

    // ---- user opacity (toolbar slider): scale the faithful dab alpha. The
    // slider drives brush.opacity; the preset's designed opacity is the
    // nominalOpacity, so opacity * (brush.opacity / nominalOpacity) paints the
    // faithful look at the default slider position and changes with the slider.
    var nomOpacity = (mp.nominalOpacity > 0) ? mp.nominalOpacity : 1;
    opacity = clamp(opacity * (brush.opacity / nomOpacity), 0, 1);

    // ---- hardness (curve-evaluated) + anti-aliasing edge --------------------
    var hd = mySetting(brush, 'hardness', inputs);
    if (!isFinite(hd)) hd = 1;
    var hardness = clamp(hd, 0, 1);
    var aa = mySetting(brush, 'anti_aliasing', inputs);
    if (!isFinite(aa) || aa < 0) aa = 0;
    var fadeout = radius * (1 - hardness);
    if (fadeout < aa) {
      var optical = radius - (1 - hardness) * radius / 2;
      var hn = (optical - aa / 2) / (optical + aa / 2);
      radius = aa / (1 - hn);
      hardness = hn;
    }
    if (!(brush._lastHardness >= 0) || Math.abs(hardness - brush._lastHardness) > 0.005) {
      brush._lastHardness = hardness;
      var h0 = brush.hardness;
      brush.hardness = clamp(hardness, 0.02, 1);
      refreshTip();
      brush.hardness = h0;
    }
    var r = radius;
    op = opacity;

    // ---- elliptical dab shape (markers / wet brushes) -----------------------
    // The ELLIPTICAL_DAB_ANGLE setting is already evaluated at the direction
    // input (0..180 clamped curve input), so it is the absolute dab angle in
    // canvas space - do NOT add the raw stroke direction on top.
    var ratio = 1, ang = null;
    var er = mySetting(brush, 'elliptical_dab_ratio', inputs);
    if (isFinite(er) && er > 1) {
      ratio = clamp(er, 1, 40);
      var ea = mySetting(brush, 'elliptical_dab_angle', inputs);
      if (isFinite(ea)) ang = ea * Math.PI / 180;
    }

    // ---- colour: brush colour dynamics (color_h/s/v) + smudge (wet brushes) ----
    var col = null;
    if (mySt && mySt.baseRgb) {
      var baseRgb = mySt.baseRgb;
      var sm = mySetting(brush, 'smudge', inputs);
      if (isFinite(sm) && sm > 0) {
        // Pick up colour from the canvas under the dab (smudge), accumulated in
        // mySt.smudgeRgb. libmypaint samples the colour over the dab radius and
        // always keeps the bucket's alpha alive; we average a 3x3 patch instead
        // of a single pixel for a closer match. Throttled for performance.
        var slen = mySetting(brush, 'smudge_length', inputs);
        if (!isFinite(slen)) {
          var sll = mySetting(brush, 'smudge_length_log', inputs);
          slen = isFinite(sll) ? clamp(Math.exp(sll), 0, 1) : 0.5;
        }
        slen = clamp(slen, 0, 1);
        mySt._smudgeClock = (mySt._smudgeClock || 0) + 1;
        if (mySt._smudgeClock % 3 === 0) {
          try {
            var rr = clamp(Math.max(1, Math.round(r)), 1, 24);
            var gx = Math.round(clamp(x, rr, workW - 1 - rr));
            var gy = Math.round(clamp(y, rr, workH - 1 - rr));
            var sdata = paintCtx.getImageData(gx - rr, gy - rr, rr * 2 + 1, rr * 2 + 1).data;
            var sr = 0, sg = 0, sb = 0, sa = 0, snpx = 0;
            for (var pi3 = 3; pi3 < sdata.length; pi3 += 4) {
              if (sdata[pi3] > 8) { sr += sdata[pi3 - 3]; sg += sdata[pi3 - 2]; sb += sdata[pi3 - 1]; sa += sdata[pi3]; snpx++; }
            }
            if (snpx > 0) {
              mySt.smudgeRgb = {
                r: Math.round(lerp(mySt.smudgeRgb.r, sr / snpx, slen)),
                g: Math.round(lerp(mySt.smudgeRgb.g, sg / snpx, slen)),
                b: Math.round(lerp(mySt.smudgeRgb.b, sb / snpx, slen))
              };
              mySt._smudgeAlpha = (mySt._smudgeAlpha || 1) * (1 - slen * 0.5) + slen * 0.5;
            }
          } catch (e) {}
        }
        var stp = mySetting(brush, 'smudge_transparency', inputs);
        var smAmt = clamp(sm, 0, 1) * (isFinite(stp) && stp > 0 ? clamp(stp, 0, 1) : 1);
        col = {
          r: Math.round(lerp(baseRgb.r, mySt.smudgeRgb.r, smAmt)),
          g: Math.round(lerp(baseRgb.g, mySt.smudgeRgb.g, smAmt)),
          b: Math.round(lerp(baseRgb.b, mySt.smudgeRgb.b, smAmt))
        };
      } else {
        col = { r: baseRgb.r, g: baseRgb.g, b: baseRgb.b };
      }
    }
    return { x: x, y: y, r: r, op: op, ang: ang, ratio: ratio, col: col };
  }

  // Walk a pointer segment placing dabs every `step` px of path length,
  // carrying the leftover distance into the next segment (Krita's
  // getNextPointPositionIsotropic). Stationary segments stamp nothing.
  // `from`/`to` may carry MyPaint input state ({press,sp1,sp2,dir,st}) for the
  // dynamics engine.
  function stampSegment(from, to) {
    var dx = to.x - from.x, dy = to.y - from.y;
    var dist = Math.hypot(dx, dy);
    if (dist <= 0.001) return; // no movement -> no dab
    var step;
    if (current.mypaint) {
      // libmypaint count_dabs_to: dabs = dist*dpa/actual_r + dist*dpb/base_r
      // + dt*dps, with dist transformed into ELLIPSE space when the brush is
      // elliptical (see mypaintStep). dt applies only across distinct timed
      // samples.
      var segDt = (from.t != null && to.t != null && to.t > from.t) ? (to.t - from.t) : 0;
      // Evaluate the elliptical ratio/angle at the segment midpoint (the dab
      // engine evaluates it per-dab; a segment-level value is a close approx).
      var segRatio = 1, segAng = NaN;
      if (current.mySettings) {
        var sm = dabInputs(from, to, 0.5);
        var ser = mySetting(current, 'elliptical_dab_ratio', sm);
        if (isFinite(ser) && ser > 1) {
          segRatio = clamp(ser, 1, 40);
          var sea = mySetting(current, 'elliptical_dab_angle', sm);
          if (isFinite(sea)) segAng = sea * Math.PI / 180;
        }
      }
      step = mypaintStep(dist, segDt, segRatio, segAng, dx, dy);
    } else {
      step = Math.max(0.5, 2 * current.radius * current.spacing);
    }
    dabCarry = dabCarry % step;
    var ang = current.followDir ? Math.atan2(dy, dx) : null;
    var traveled = 0;
    var guard = 0;
    // Distance from the last dab to the next dab along this segment.
    var next = step - dabCarry;
    while (next <= dist && guard < 10000) {
      var t = next / dist;
      var px = from.x + dx * t;
      var py = from.y + dy * t;
      var pr = from.press + (to.press - from.press) * t;
      var r = dabRadius(pr);
      var op = dabOpacity(pr);
      var dabAng = ang, dabRatio = 1, dabCol = null;
      if (current.mypaint) {
        var g = mypaintDab(px, py, r, op, from, to, t, next);
        px = g.x; py = g.y; r = g.r; op = g.op; dabAng = g.ang; dabRatio = g.ratio; dabCol = g.col;
      } else if (current.kpp) {
        var pd = pixelDab(px, py, r, op, pr, ang);
        px = pd.x; py = pd.y; r = pd.r; op = pd.op; dabAng = pd.rot;
      }
      stampDab(px, py, r, op, dabAng, dabRatio, dabCol);
      traveled = next;
      dabCarry = 0;
      next += step;
      dabLastPos = { x: px, y: py };
      guard++;
    }
    // Leftover distance toward the next dab carries into the next segment.
    dabCarry = (dabCarry + (dist - traveled)) % step;
    // Cheap guard: if we placed nothing but the segment is long, clamp carry.
    if (!isFinite(dabCarry)) dabCarry = 0;
  }

  // Place a single closing dab at the stroke end (Krita seals the stroke so
  // the tip isn't cut short), respecting the spacing accumulator.
  function sealStroke(pt) {
    if (!dabLastPos) {
      stampDab(pt.x, pt.y, dabRadius(pt.press), dabOpacity(pt.press), null);
      return;
    }
    var dx = pt.x - dabLastPos.x, dy = pt.y - dabLastPos.y;
    var d = Math.hypot(dx, dy);
    var step;
    if (current.mypaint) {
      var segRatio = 1, segAng = NaN;
      if (current.mySettings) {
        var sm = dabInputs({ x: dabLastPos.x, y: dabLastPos.y, press: pt.press }, pt, 0.5);
        var ser = mySetting(current, 'elliptical_dab_ratio', sm);
        if (isFinite(ser) && ser > 1) {
          segRatio = clamp(ser, 1, 40);
          var sea = mySetting(current, 'elliptical_dab_angle', sm);
          if (isFinite(sea)) segAng = sea * Math.PI / 180;
        }
      }
      step = mypaintStep(d, (pt.t != null && dabLastPos.t != null) ? Math.max(0, pt.t - dabLastPos.t) : 0, segRatio, segAng, dx, dy);
    } else {
      step = Math.max(0.5, 2 * current.radius * current.spacing);
    }
    // Only seal if the end is at least half a spacing away from the last dab,
    // otherwise the next dab would land almost on top of it.
    if (d < step * 0.5) return;
    var x = pt.x, y = pt.y, r = dabRadius(pt.press), op = dabOpacity(pt.press);
    var ang = current.followDir ? Math.atan2(dy, dx) : null, ratio = 1, col = null;
    if (current.mypaint) {
      // Use the last painted point's stroke state so the closing dab evaluates
      // its curves at the same inputs as the final stroke dab.
      var from = (lastPainted && lastPainted.sp1 !== undefined)
        ? lastPainted
        : { x: dabLastPos.x, y: dabLastPos.y, press: pt.press };
      var to = { x: pt.x, y: pt.y, press: pt.press, t: (pt.t != null ? pt.t : (from.t != null ? from.t : null)) };
      if (from.sp1 !== undefined) { to.sp1 = from.sp1; to.sp2 = from.sp2; to.dir = from.dir; to.st = from.st; }
      var g = mypaintDab(x, y, r, op, from, to, 1, d);
      x = g.x; y = g.y; r = g.r; op = g.op; ang = g.ang; ratio = g.ratio; col = g.col;
    } else if (current.kpp) {
      var pd = pixelDab(x, y, r, op, pt.press, ang);
      x = pd.x; y = pd.y; r = pd.r; op = pd.op; ang = pd.rot;
    }
    stampDab(x, y, r, op, ang, ratio, col);
  }

  // Krita supplies 0.5 pressure for devices that have no pressure axis (mouse,
  // trackpad) - KisPaintInformation's default. Painting at 1.0 is what pushes
  // opaque_multiply curves to their pressure=1 extreme and burns textured
  // brushes (pencil, ink) into a solid opaque band. 0.5 reproduces Krita.
  function pressureOf(ev) {
    if (ev.pointerType === 'mouse') return 0.5;
    var p = ev.pressure;
    if (!p || p <= 0) return 0.5;
    return p;
  }

  function alphaFromMode() {
    var mode = (byId('paintSmoothMode') && byId('paintSmoothMode').value) || 'stabilizer';
    var s = clamp((byId('paintSmoothStr') ? (+byId('paintSmoothStr').value) : 60) / 100, 0.01, 1);
    if (mode === 'none') return 1;
    if (mode === 'basic') return 1 - 0.6 * s;
    return 1 - 0.92 * s; // stabilizer: heavier smoothing / more lag
  }

  function pump() {
    if (!drawing) { rafId = 0; return; }
    var mode = (byId('paintSmoothMode') && byId('paintSmoothMode').value) || 'stabilizer';
    if (mode === 'stabilizer') {
      // The smoothed cursor eases toward the pointer; dabs are only placed as
      // it actually moves (stationary pointer -> converging but sub-pixel
      // movement is ignored by stampSegment). Once settled, stop the loop.
      smoothPt.x += (rawLatest.x - smoothPt.x) * smoothAlpha;
      smoothPt.y += (rawLatest.y - smoothPt.y) * smoothAlpha;
      var end = { x: smoothPt.x, y: smoothPt.y, press: rawLatest.press, t: rawLatest.t };
      if (rawLatest.sp1 !== undefined) { end.sp1 = rawLatest.sp1; end.sp2 = rawLatest.sp2; end.dir = rawLatest.dir; end.st = rawLatest.st; }
      stampSegment(lastPainted, end);
      lastPainted = end;
      var settled = Math.hypot(rawLatest.x - smoothPt.x, rawLatest.y - smoothPt.y) < 0.5;
      if (settled) { rafId = 0; compositeDisplay(); return; }
    } else {
      for (var i = 0; i < rawPoints.length; i++) {
        var pt = rawPoints[i];
        if (mode === 'basic') {
          smoothPt.x += (pt.x - smoothPt.x) * smoothAlpha;
          smoothPt.y += (pt.y - smoothPt.y) * smoothAlpha;
        } else {
          // Keep press so stampSegment can interpolate dab size/opacity.
          smoothPt = { x: pt.x, y: pt.y, press: pt.press };
        }
        if (pt.sp1 !== undefined) {
          smoothPt.sp1 = pt.sp1; smoothPt.sp2 = pt.sp2; smoothPt.dir = pt.dir; smoothPt.st = pt.st; smoothPt.t = pt.t;
        }
        stampSegment(lastPainted, smoothPt);
        lastPainted = { x: smoothPt.x, y: smoothPt.y, press: pt.press, t: pt.t };
        if (pt.sp1 !== undefined) { lastPainted.sp1 = pt.sp1; lastPainted.sp2 = pt.sp2; lastPainted.dir = pt.dir; lastPainted.st = pt.st; }
      }
    }
    compositeDisplay();
    rawPoints.length = 0;
    rafId = requestAnimationFrame(pump);
  }

  // ---- pointer handling -------------------------------------------------------

  function canvasPoint(ev) {
    var rect = paintCanvas.getBoundingClientRect();
    var sx = workW / rect.width, sy = workH / rect.height;
    return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
  }

  function onPaintDown(ev) {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    // shift+drag pans the view (wrap-level handler) — don't start a stroke
    if (ev.shiftKey && (paintTool === 'brush' || paintTool === 'eraser')) return;
    ev.preventDefault();
    try { paintCanvas.setPointerCapture(ev.pointerId); } catch (e) {}
    var p = canvasPoint(ev);
    var h = toolHandlers[paintTool];
    if (h && h.down) { h.down(p, ev); return; }
    pushUndo();
    drawing = true;
    // With a live selection the dabs land on a scratch copy of the layer, so
    // the stroke is clipped to the selection when it is committed.
    beginSelScratch();
    var press = pressureOf(ev);
    var t0 = (ev.timeStamp != null ? ev.timeStamp : performance.now()) / 1000;
    var inp = null;
    if (current.mypaint) {
      myStrokeInit({ x: p.x, y: p.y, press: press });
      mySt.lastT = null;
      inp = myStrokeUpdate(p.x, p.y, press, t0, current);
    }
    var p0 = { x: p.x, y: p.y, press: press, t: t0 };
    if (inp) { p0.sp1 = inp.sp1; p0.sp2 = inp.sp2; p0.dir = inp.dir; p0.st = inp.st; }
    rawPoints = [p0];
    rawLatest = { x: p.x, y: p.y, press: press, t: t0 };
    if (inp) { rawLatest.sp1 = inp.sp1; rawLatest.sp2 = inp.sp2; rawLatest.dir = inp.dir; rawLatest.st = inp.st; }
    smoothPt = { x: p.x, y: p.y, press: press, t: t0 };
    if (inp) { smoothPt.sp1 = inp.sp1; smoothPt.sp2 = inp.sp2; smoothPt.dir = inp.dir; smoothPt.st = inp.st; }
    lastPainted = { x: p.x, y: p.y, press: press, t: t0 };
    if (inp) { lastPainted.sp1 = inp.sp1; lastPainted.sp2 = inp.sp2; lastPainted.dir = inp.dir; lastPainted.st = inp.st; }
    smoothAlpha = alphaFromMode();
    // Fresh stroke: reset the spacing accumulator, then place the opening dab
    // so a plain click leaves a mark (Krita paints a dab on pointer down).
    dabCarry = 0;
    dabLastPos = null;
    var oR = dabRadius(press), oOp = dabOpacity(press), oAng = null, oRatio = 1;
    var oX = p.x, oY = p.y;
    if (current.mypaint) {
      var og = mypaintDab(oX, oY, oR, oOp, p0, p0, 0, 0);
      oR = og.r; oOp = og.op; oAng = og.ang; oRatio = og.ratio;
    } else if (current.kpp) {
      var opd = pixelDab(oX, oY, oR, oOp, press, null);
      oX = opd.x; oY = opd.y; oR = opd.r; oOp = opd.op; oAng = opd.rot;
    }
    stampDab(oX, oY, oR, oOp, oAng, oRatio, current.mypaint ? og.col : null);
    dabLastPos = { x: oX, y: oY };
    compositeDisplay();
    if (!rafId) rafId = requestAnimationFrame(pump);
  }

  function onPaintMove(ev) {
    var p = canvasPoint(ev);
    var h = toolHandlers[paintTool];
    if (h && h.move) { h.move(p, ev); return; }
    if (!drawing) return;
    var press = pressureOf(ev);
    var t = (ev.timeStamp != null ? ev.timeStamp : performance.now()) / 1000;
    var pt = { x: p.x, y: p.y, press: press, t: t };
    if (current.mypaint) {
      var inp = myStrokeUpdate(p.x, p.y, press, t, current);
      if (inp) { pt.sp1 = inp.sp1; pt.sp2 = inp.sp2; pt.dir = inp.dir; pt.st = inp.st; }
    }
    rawPoints.push(pt);
    rawLatest = pt;
    // If the stabilizer loop settled (stopped) while we were idle, restart it
    // so movement keeps painting.
    if (!rafId) rafId = requestAnimationFrame(pump);
  }

  function onPaintUp(ev) {
    var h = toolHandlers[paintTool];
    if (h && h.up) { h.up(canvasPoint(ev), ev); return; }
    if (!drawing) return;
    drawing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    // Stabilizer: the smoothed cursor may still lag the pointer when the stroke
    // is released. Flush the remaining samples + converge to the true end so a
    // fast stroke reaches the cursor (Krita's stabilizer paints the tail on
    // release) instead of cutting off short with a lone dot at the end.
    var mode = (byId('paintSmoothMode') && byId('paintSmoothMode').value) || 'stabilizer';
    if (mode === 'stabilizer' && smoothPt && rawLatest && (rawPoints.length || Math.hypot(rawLatest.x - smoothPt.x, rawLatest.y - smoothPt.y) > 0.5)) {
      var i;
      for (i = 0; i < rawPoints.length; i++) {
        var pt = rawPoints[i];
        smoothPt.x += (pt.x - smoothPt.x) * smoothAlpha;
        smoothPt.y += (pt.y - smoothPt.y) * smoothAlpha;
        var end = { x: smoothPt.x, y: smoothPt.y, press: pt.press };
        stampSegment(lastPainted, end);
        lastPainted = end;
      }
      var guard = 0;
      while (Math.hypot(rawLatest.x - smoothPt.x, rawLatest.y - smoothPt.y) > 0.5 && guard++ < 500) {
        smoothPt.x += (rawLatest.x - smoothPt.x) * smoothAlpha;
        smoothPt.y += (rawLatest.y - smoothPt.y) * smoothAlpha;
        var end2 = { x: smoothPt.x, y: smoothPt.y, press: rawLatest.press };
        stampSegment(lastPainted, end2);
        lastPainted = end2;
      }
    }
    if (rawLatest) {
      sealStroke({ x: rawLatest.x, y: rawLatest.y, press: rawLatest.press, t: rawLatest.t });
    }
    paintCtx.globalAlpha = 1;
    paintCtx.globalCompositeOperation = 'source-over';
    commitSelScratch();
    compositeDisplay();
    refreshLayerThumbs();
    try { paintCanvas.releasePointerCapture(ev.pointerId); } catch (e) {}
  }

  // ---- per-stroke undo / redo -----------------------------------------------

  // Push the active layer's current pixels for undo. A fresh stroke is a new
  // branching point in history, so it clears the redo stack (Krita/standard
  // behaviour: you can't redo past a new action).
  function pushUndo() {
    if (!activeLayer) return;
    paintRedoStack = [];
    try {
      // Snapshot the layer that is actually being drawn so undo restores the
      // correct canvas even if the active layer is switched before undoing.
      paintUndoStack.push({ canvas: activeLayer.canvas, data: activeLayer.canvas.getContext('2d').getImageData(0, 0, workW, workH) });
    } catch (e) { return; }
    if (paintUndoStack.length > 30) paintUndoStack.shift();
  }

  function undoStroke() {
    if (!paintUndoStack.length) { toast('Nothing to undo'); return; }
    var rec = paintUndoStack.pop();
    // Save the current pixels so redo can restore them later.
    try { paintRedoStack.push({ canvas: rec.canvas, data: rec.canvas.getContext('2d').getImageData(0, 0, workW, workH) }); } catch (e) {}
    if (paintRedoStack.length > 30) paintRedoStack.shift();
    rec.canvas.getContext('2d').putImageData(rec.data, 0, 0);
    compositeDisplay();
  }

  function redoStroke() {
    if (!paintRedoStack.length) { toast('Nothing to redo'); return; }
    var rec = paintRedoStack.pop();
    // Restore the entry onto the undo stack so you can undo the redo.
    try { paintUndoStack.push({ canvas: rec.canvas, data: rec.canvas.getContext('2d').getImageData(0, 0, workW, workH) }); } catch (e) {}
    if (paintUndoStack.length > 30) paintUndoStack.shift();
    rec.canvas.getContext('2d').putImageData(rec.data, 0, 0);
    compositeDisplay();
  }

  // Structural edits (layer ops, resize, flip, rotate, reopening) make every
  // previous snapshot point at detached canvases, so history starts fresh.
  function resetHistory() {
    paintUndoStack = [];
    paintRedoStack = [];
  }

  function clearCanvas() {
    pushUndo();
    paintCtx.clearRect(0, 0, workW, workH);
    compositeDisplay();
    refreshLayerThumbs();
  }

  // ---- brush list UI ----------------------------------------------------------

  // Render a Krita-style stroke preview for a brush: a square canvas with a
  // diagonal stroke stamped with the brush's own tip, so each preset shows
  // what it paints (shown on a white cell in the palette grid).
  function brushPreview(brush) {
    var W = 60, H = 60;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var g = cv.getContext('2d');
    var c = hexToRgb(brush.color || '#1a1a1a');
    // MyPaint brushes with intrinsic color_h/s/v paint in their preset colour
    // regardless of the colour picker, so show that colour in the preview too.
    if (brush.mySettings) {
      var ms = brush.mySettings;
      var ch = ms.color_h && isFinite(+ms.color_h.base_value) ? +ms.color_h.base_value : 0;
      var cs = ms.color_s && isFinite(+ms.color_s.base_value) ? +ms.color_s.base_value : 0;
      var cv = ms.color_v && isFinite(+ms.color_v.base_value) ? +ms.color_v.base_value : 0;
      if (cs > 0.02 || (ch > 0.02 && cv > 0.02)) c = hsvToRgb(ch * 360, cs, cv);
    }
    // Build a tinted tip (like refreshTip, but for any brush).
    var tip = document.createElement('canvas');
    tip.width = 64; tip.height = 64;
    var tg = tip.getContext('2d');
    if (brush.tip && brush.tip.width) {
      paintTipMask(brush.tip, tg, 64);
      // paintTipMask renders a WHITE alpha mask (shape only). Tint it to the
      // brush's display colour so the preview is visible on the white cell and
      // matches what the brush paints (including MyPaint intrinsic colours).
      tg.globalCompositeOperation = 'source-in';
      tg.fillStyle = 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
      tg.fillRect(0, 0, 64, 64);
      tg.globalCompositeOperation = 'source-over';
    } else {
      var inner = clamp(brush.hardness == null ? 0.8 : brush.hardness, 0, 1);
      var grd = tg.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',1)');
      grd.addColorStop(inner, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',1)');
      grd.addColorStop(1, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0)');
      tg.fillStyle = grd;
      tg.beginPath(); tg.arc(32, 32, 32, 0, Math.PI * 2); tg.fill();
    }
    // Stamp dabs along a diagonal, using the same diameter-fraction spacing
    // as the live stroke so previews match what the brush paints.
    var x0 = 5, y0 = H - 5, x1 = W - 5, y1 = 5;
    var dist = Math.hypot(x1 - x0, y1 - y0);
    var r = Math.max(2, Math.min(11, brush.radius * 0.35));
    var step = Math.max(1.5, r * 2 * Math.max(0.5, brush.spacing || 0.15));
    var n = Math.max(2, Math.floor(dist / step));
    var rot = (brush.rotation || 0) * Math.PI / 180;
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var x = x0 + (x1 - x0) * t;
      var y = y0 + (y1 - y0) * t;
      g.save();
      g.translate(x, y);
      g.rotate(rot);
      g.globalAlpha = clamp(brush.opacity == null ? 1 : brush.opacity, 0.08, 1);
      g.drawImage(tip, -r, -r, 2 * r, 2 * r);
      g.restore();
    }
    g.globalAlpha = 1;
    return cv;
  }

  function buildBrushList() {
    var list = byId('paintBrushList');
    if (!list) return;
    list.innerHTML = '';
    var cnt = byId('paintBrushCount');
    if (cnt) cnt.textContent = brushList.length;
    brushList.forEach(function (b) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'paint-brush' + (b === current ? ' active' : '');
      btn.title = b.name;
      // Square cell with a white background, Krita-preset-docker style. The
      // brush's own preview (200x200 for .kpp, _prev.png for .myb) is shown
      // contained; built-ins get a rendered stroke preview.
      var prev = document.createElement('span');
      prev.className = 'paint-brush-prev';
      if (b.preview && b.preview.width) prev.appendChild(b.preview);
      else prev.appendChild(brushPreview(b));
      btn.appendChild(prev);
      btn.addEventListener('click', function () {
        current = b;
        // Keep the last-used foreground colour on the newly selected brush
        // (Krita: the colour is global, not a preset property).
        b.color = fgColor;
        // The preset's eraser flag drives eraser mode: selecting an eraser
        // brush erases, selecting any normal brush paints again (and the
        // toolbar brush/eraser buttons stay in sync).
        eraserOn = !!b.eraser;
        var er = byId('paintEraser');
        if (er) er.checked = eraserOn;
        var bb = byId('btnPaintToolBrush'), be = byId('btnPaintToolEraser');
        if (bb) bb.classList.toggle('active', !eraserOn);
        if (be) be.classList.toggle('active', eraserOn);
        refreshTip();
        refreshBrushUI();
        buildBrushList();
      });
      list.appendChild(btn);
    });
  }

  function refreshBrushUI() {
    syncSizeUI(current.radius * 2);
    syncOpacityUI(current.opacity);
    setVal('paintHardness', current.hardness, Math.round(current.hardness * 100) + '%');
    setColorSwatch(current.color);
    var nameEl = byId('paintBrushName'); if (nameEl) nameEl.textContent = current.name;
  }

  // Krita-style size control: slider with the value drawn ON it (diameter in px).
  // The nominal range is 1..50; brushes whose preset is bigger than that raise
  // the limits so they are never silently shrunk on selection.
  function syncSizeUI(d) {
    d = clamp(+d || 1, 1, 1000);
    var s = byId('paintSize');
    if (s) {
      var max = Math.max(50, Math.ceil(d));
      s.max = max; s.min = 1;
      s.value = String(d);
      syncSlider(s);
    }
    var lab = byId('paintSizeLabel');
    if (lab) lab.textContent = fmtSize(d);
  }

  // Krita-style opacity control: slider (0..1) with the percent drawn ON it.
  function syncOpacityUI(o) {
    o = clamp(+o || 0, 0, 1);
    var s = byId('paintOpacity');
    if (s) { s.value = String(o); syncSlider(s); }
    var lab = byId('paintOpacityLabel');
    if (lab) lab.textContent = Math.round(o * 100) + '%';
  }

  // Size label: Krita's brush size is the DIAMETER in px.
  function fmtSize(d) {
    return (d < 10 ? Math.round(d * 10) / 10 : Math.round(d)) + 'px';
  }

  function setVal(id, v, label) {
    var el = byId(id);
    if (!el) return;
    el.value = String(v);
    if (el.classList.contains('slider')) syncSlider(el);
    var lab = byId(id + 'Val');
    if (lab) lab.textContent = label;
  }

  // ---- Krita (.kpp) parsing ---------------------------------------------------

  function readU16(b, o) { return b[o] | (b[o + 1] << 8); }
  // Little-endian 32-bit (ZIP sizes / field lengths).
  function readU32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  // Big-endian 32-bit (PNG chunk lengths).
  function readU32BE(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

  async function gunzip(u8) {
    var ds = new DecompressionStream('gzip');
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  async function inflateRaw(u8) {
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  // Minimal ZIP reader: walk local file headers, inflate deflated entries.
  function parseZip(u8) {
    var out = {};
    var i = 0;
    while (i + 4 <= u8.length) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x03 && u8[i + 3] === 0x04) {
        var method = readU16(u8, i + 8);
        var compSize = readU32(u8, i + 18);
        var nameLen = readU16(u8, i + 26);
        var extraLen = readU16(u8, i + 28);
        var name = '';
        for (var k = 0; k < nameLen; k++) name += String.fromCharCode(u8[i + 30 + k]);
        var dataStart = i + 30 + nameLen + extraLen;
        var comp = u8.slice(dataStart, dataStart + compSize);
        out[name] = { method: method, data: comp };
        i = dataStart + compSize;
      } else { i++; }
    }
    return out;
  }

  function decodeText(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return decodeURIComponent(escape(s));
  }

  // Binary string (e.g. from atob) -> Uint8Array.
  function stringToU8(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
    return out;
  }

  function loadImageFromBytes(bytes, type) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob([bytes], { type: type || 'image/png' }));
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  // Decode a GIMP .gbr brush into a canvas. Header (big-endian):
  //   header_size u32, version u32, width u32, height u32, bytes u32,
  //   [v2 only] magic u32 + spacing u32, then a name string up to header_size.
  // Pixels start at header_size:
  //   bytes==1 -> grayscale mask (255-v is the alpha, like Krita's ALPHAMASK)
  //   bytes==4 -> straight RGBA
  // The result is a canvas whose alpha is the brush tip (white where opaque).
  function parseGbrBytes(u8) {
    if (u8.length < 20) return null;
    var hs = readU32BE(u8, 0);
    var version = readU32BE(u8, 4);
    var w = readU32BE(u8, 8);
    var h = readU32BE(u8, 12);
    var bytes = readU32BE(u8, 16);
    if (!w || !h || w > 4096 || h > 4096 || hs < 20 || hs > u8.length) return null;
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var g = cv.getContext('2d');
    var img = g.createImageData(w, h);
    var d = img.data;
    var k = hs;
    if (bytes === 1) {
      // Grayscale mask, exactly like Krita (KisGbrBrush): the pixel value is
      // 255 - byte stored as an OPAQUE grayscale image; the red channel is the
      // dab mask (white = opaque). The luminance->alpha conversion in
      // refreshTip then turns this into the actual painted mask.
      for (var i = 0; i < d.length; i += 4, k++) {
        var v = k < u8.length ? u8[k] : 0;
        var val = 255 - v;
        d[i] = d[i + 1] = d[i + 2] = val;
        d[i + 3] = 255;
      }
    } else if (bytes >= 4) {
      for (var j = 0; j < d.length; j += 4, k += 4) {
        if (k + 3 < u8.length) {
          d[j] = u8[k]; d[j + 1] = u8[k + 1]; d[j + 2] = u8[k + 2]; d[j + 3] = u8[k + 3];
        }
      }
    } else {
      return null;
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  // Decode a GIMP .gih image hose: a text header ("name\n<count> ncells:.. dim:..
  // rank0:.. sel0:..\n") followed by that many .gbr brush blocks. We use the
  // first block's texture as the tip (the rest are alternate frames).
  function parseGihBytes(u8) {
    // find the first newline, then the second newline (end of the parasite line)
    var nl1 = -1, nl2 = -1;
    for (var i = 0; i < u8.length && i < 1024; i++) {
      if (u8[i] === 10) { if (nl1 < 0) nl1 = i; else { nl2 = i; break; } }
    }
    if (nl2 < 0) return null;
    // header line 2: "<count> ncells:..."
    var line = '';
    for (var j = nl1 + 1; j < nl2; j++) line += String.fromCharCode(u8[j]);
    var m = /^\s*(\d+)/.exec(line);
    if (!m) return null;
    // the first .gbr block starts right after the second newline
    return parseGbrBytes(u8.slice(nl2 + 1));
  }

  // Fetch a brush tip resource referenced by a .kpp brush_definition
  // (filename="chalk_sparse.png" etc.) from brushes/tips/. Returns a canvas or
  // null if unavailable.
  async function loadBrushTipFile(filename) {
    if (!filename) return null;
    var clean = String(filename).split('/').pop();
    if (!/^[\w.\- ]+$/.test(clean)) return null;
    var r;
    try { r = await fetch('brushes/tips/' + encodeURIComponent(clean)); } catch (e) { return null; }
    if (!r.ok) return null;
    var buf = new Uint8Array(await r.arrayBuffer());
    var lower = clean.toLowerCase();
    if (lower.endsWith('.gbr')) return parseGbrBytes(buf);
    if (lower.endsWith('.gih')) return parseGihBytes(buf);
    // png/svg handled via image load
    try { return await loadImageFromBytes(buf, 'image/png'); } catch (e) { return null; }
  }

  // Krita .kpp files are PNG images: the pixels are Krita's own stroke preview
  // and the preset XML lives in a zTXt chunk (keyword "preset", deflate
  // compressed). Older .kpp variants were gzipped zips; both are handled.
  function isPNG(u8) { return u8.length > 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47; }

  // Walk PNG chunks, returning { type, data } for each. Chunks are
  // length(4) + type(4) + data + crc(4), big-endian length.
  function parsePNGChunks(u8) {
    var out = [];
    var o = 8; // skip PNG signature
    while (o + 8 <= u8.length) {
      var len = readU32BE(u8, o);
      var type = '';
      for (var k = 0; k < 4; k++) type += String.fromCharCode(u8[o + 4 + k]);
      var data = u8.slice(o + 8, o + 8 + len);
      out.push({ type: type, data: data });
      o += 12 + len;
      if (type === 'IEND') break;
    }
    return out;
  }

  // zTXt chunk: keyword\0 + compression-method(1, 0=deflate) + compressed text.
  function inflateZtxt(chunkData) {
    var nul = -1;
    for (var i = 0; i < chunkData.length; i++) { if (chunkData[i] === 0) { nul = i; break; } }
    if (nul < 0) return null;
    var keyword = '';
    for (var j = 0; j < nul; j++) keyword += String.fromCharCode(chunkData[j]);
    var method = chunkData[nul + 1];
    var comp = chunkData.slice(nul + 2);
    return { keyword: keyword, method: method, text: null, compressed: comp };
  }

  // Inflate a zlib-wrapped buffer (PNG zTXt chunks use zlib, not raw deflate).
  async function inflateText(u8) {
    var ds = new DecompressionStream('deflate');
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  // Parse a Krita preset XML (root <Preset paintopid=... name=...> with
  // <param name type><![CDATA[value]]></param> children) into { engine, name, params }.
  function parsePresetXml(text) {
    var out = { engine: 'pixel', name: null, params: {}, hasXml: false };
    if (!text) return out;
    try {
      var xml = new DOMParser().parseFromString(text, 'application/xml');
      var root = xml.documentElement;
      if (!root || root.nodeName !== 'Preset') return out;
      out.hasXml = true;
      out.engine = root.getAttribute('paintopid') || 'pixel';
      out.name = root.getAttribute('name') || null;
      var ps = xml.getElementsByTagName('param');
      for (var i = 0; i < ps.length; i++) {
        var n = ps[i].getAttribute('name');
        if (n) out.params[n.toLowerCase()] = (ps[i].textContent || '').trim();
      }
    } catch (e) {}
    return out;
  }

  // Best-effort numeric parse of a Krita param (may be "true"/"false" or a float).
  function paramNum(v, dflt) {
    var f = parseFloat(v);
    return isFinite(f) ? f : dflt;
  }

  // Return the ordered list of dab-tip filenames referenced by a Krita preset
  // XML. Watercolor / grain pixel brushes keep their brush tip and (optionally)
  // a grain texture as external PNGs in brushes/tips/, referenced by <Brush
  // filename="..."> attributes. The FIRST is the brush SHAPE and any LATER one
  // is the grain/texture overlay. Because our renderer flattens a brush tip and
  // its texture into a single dab mask, the visible dab should be the GRAIN
  // (bristle/spike texture), not the plain round shape — so callers try these
  // in REVERSE order and use the first that actually loads. Returns an array of
  // bare filenames (possibly empty). The pixels are loaded lazily by the caller.
  function kppTipFilenames(xmlText) {
    if (!xmlText) return [];
    var re = /<Brush[^>]*\bfilename="([^"]+\.(?:png|gbr|gih))"/gi;
    var out = [], m;
    while ((m = re.exec(xmlText))) out.push(m[1]);
    return out;
  }

  async function parseKppBytes(name, buf) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser lacks DecompressionStream; cannot read .kpp');
    }
    var presetName = (name || 'krita brush').replace(/\.kpp$/i, '');
    var tipImg = null;
    var tipURL = null;
    var previewImg = null;
    var engine = 'pixel';
    var params = {};
    var parsedXml = false;

    if (isPNG(buf)) {
      // Modern Krita format: PNG + zTXt "preset" chunk.
      var chunks = parsePNGChunks(buf);
      var xmlText = null;
      for (var ci = 0; ci < chunks.length; ci++) {
        var ch = chunks[ci];
        if (ch.type === 'zTXt') {
          var zt = inflateZtxt(ch.data);
          if (zt && zt.keyword === 'preset' && zt.method === 0) {
            try {
              xmlText = decodeText(await inflateText(zt.compressed));
            } catch (e) {}
          }
        }
      }
      var preset = parsePresetXml(xmlText);
      parsedXml = preset.hasXml;
      if (preset.hasXml) {
        engine = preset.engine || 'pixel';
        if (preset.name) presetName = preset.name;
        params = preset.params;
      }
      // The PNG's own pixels are Krita's stroke preview (shown in the brush
      // list, exactly like Krita's presets docker).
      try { previewImg = await loadImageFromBytes(buf, 'image/png'); } catch (e) {}
      // Watercolor/grain brushes store their dab mask as an external PNG in
      // brushes/tips/ (referenced by filename in the preset XML). Load it as the
      // tip so the bristle/grain texture actually renders; without this these
      // brushes silently fell back to a round procedural tip. Missing/unsupported
      // tips degrade to the procedural fallback rather than rejecting the parse.
      if (xmlText) {
        try {
          var _cands = kppTipFilenames(xmlText);
          for (var _ci = _cands.length - 1; _ci >= 0; _ci--) {
            var _base = _cands[_ci].split('/').pop();
            try {
              tipURL = 'brushes/tips/' + encodeURIComponent(_base);
              var _tb = await (await fetch(tipURL)).arrayBuffer();
              tipImg = await loadImageFromBytes(new Uint8Array(_tb), 'image/png');
              break; // first (grain-preferred) that loads wins
            } catch (e) { tipImg = null; }
          }
        } catch (e) {}
      }
    } else {
      // Older format: gzipped zip with XML + PNG entries.
      var data = buf;
      if (buf[0] === 0x1f && buf[1] === 0x8b) data = await gunzip(buf);
      var entries;
      try { entries = parseZip(data); } catch (e) { entries = {}; }
      var xmlText2 = null;
      var pngs = [];
      for (var en in entries) {
        if (en.endsWith('/')) continue;
        var ent = entries[en];
        var lower = en.toLowerCase();
        try {
          if (lower.endsWith('.xml') && !xmlText2) {
            xmlText2 = decodeText(await inflateRaw(ent.data));
          } else if (lower.endsWith('.png') && lower.indexOf('preview') < 0) {
            var raw = ent.method === 0 ? ent.data : await inflateRaw(ent.data);
            pngs.push(raw);
          }
        } catch (e) {}
      }
      var preset2 = parsePresetXml(xmlText2);
      parsedXml = preset2.hasXml;
      if (preset2.hasXml) {
        engine = preset2.engine || 'pixel';
        if (preset2.name) presetName = preset2.name;
        params = preset2.params;
      }
      // Largest embedded PNG as the tip.
      var best = null, bestArea = 0;
      for (var j = 0; j < pngs.length; j++) {
        try {
          var im = await loadImageFromBytes(pngs[j], 'image/png');
          var area = im.width * im.height;
          if (area > bestArea && area >= 16) { bestArea = area; best = im; }
        } catch (e) {}
      }
      tipImg = best;
    }

    // Map Krita params to our brush model. Krita stores "1" as a "use
    // default" sentinel, so only take values that are meaningfully set.
    // The brush_definition's <Brush> attrs carry the real geometry: for
    // auto_brush the tip is procedural with a MaskGenerator diameter; for
    // png/gbr brushes the tip is an external resource we don't ship, so we
    // fall back to the embedded pattern or a procedural tip. Krita's brush
    // size is the DIAMETER in px (KisBrush::width()), so radius = diameter/2.
    var bd = params.brush_definition || '';
    var bdScale = parseFloat((/\bscale="([^"]+)"/.exec(bd) || [])[1] || '');
    if (!isFinite(bdScale) || bdScale <= 0) bdScale = 1;
    var diam = NaN;
    var mg = /<MaskGenerator[^>]*>/.exec(bd);
    if (mg) {
      var dm = /\bdiameter="([^"]+)"/.exec(mg[0]);
      if (dm) diam = parseFloat(dm[1]);
    }
    // SizeValue is also a diameter when a real size is stored ("1" = default).
    var sv = paramNum(params.sizevalue, NaN);
    if (isFinite(sv) && sv > 1) diam = sv;
    if (!isFinite(diam) || diam <= 0) {
      // png/gbr brushes reference an external tip resource we don't ship;
      // 40px is a typical Krita tip width, scaled by the preset's scale attr.
      diam = 40;
    }
    var radius = clamp(diam * bdScale / 2, 0.5, 320);
    var opacity = paramNum(params.opacityvalue, 1);
    if (opacity > 1) opacity = opacity / 100;
    // Flow (watercolour dilution) multiplies the effective opacity.
    var flow = paramNum(params.flowvalue, 1);
    if (flow > 1) flow = flow / 100;
    opacity = clamp(opacity * flow, 0.02, 1);
    // Spacing: fraction of the dab DIAMETER, exactly like Krita's
    // KisPaintOpUtils::effectiveSpacing (spacing = spacingVal * dabWidth).
    // A value > 1 means a deliberately sparse/dotted brush, so allow up to
    // 2 (Krita's spacing slider range).
    var spacing = NaN;
    var bdSp = /\bspacing="([^"]+)"/.exec(bd);
    if (bdSp) spacing = parseFloat(bdSp[1]);
    if (!isFinite(spacing) || spacing <= 0 || spacing > 4) spacing = paramNum(params.spacingvalue, NaN);
    if (!isFinite(spacing) || spacing <= 0.02 || spacing > 4) spacing = 0.15;
    spacing = clamp(spacing, 0.02, 2);
    // Auto-spacing (Krita's "auto" spacing): spacing_px = coeff*sqrt(dabWidth)
    // (calcAutoSpacing), folded into the diameter fraction -> coeff/sqrt(dia).
    var autoSp = (/\buseAutoSpacing="([^"]+)"/.exec(bd) || [])[1];
    if (autoSp === '1') {
      var coeff = parseFloat((/\bautoSpacingCoeff="([^"]+)"/.exec(bd) || [])[1] || '');
      if (!isFinite(coeff) || coeff <= 0) coeff = 1;
      spacing = clamp(coeff / Math.sqrt(diam * bdScale), 0.02, 2);
    }
    // Krita "softness": 0 = hard edge, 1 = very soft ("1" = default -> 0.8).
    var soft = paramNum(params.softnessvalue, NaN);
    var hard = (!isFinite(soft) || soft === 1) ? 0.8 : (1 - clamp(soft, 0, 1));
    hard = clamp(hard, 0.02, 1);
    // auto_brush masks carry their own edge falloff (hfade/vfade on the
    // MaskGenerator: 1 = hard edge, 0 = fully soft). That is the brush's real
    // hardness, so prefer it over the SoftnessValue estimate when present.
    var mg2 = /<MaskGenerator[^>]*>/.exec(bd);
    if (mg2) {
      var hf = parseFloat((/\bhfade="([^"]+)"/.exec(mg2[0]) || [])[1] || '');
      var vf = parseFloat((/\bvfade="([^"]+)"/.exec(mg2[0]) || [])[1] || '');
      if (isFinite(hf) || isFinite(vf)) {
        var fades = 0, fadeN = 0;
        if (isFinite(hf)) { fades += hf; fadeN++; }
        if (isFinite(vf)) { fades += vf; fadeN++; }
        hard = clamp(fades / fadeN, 0.02, 1);
      }
    }
    var rotation = paramNum(params.rotationvalue, NaN);
    if (!isFinite(rotation) || rotation === 1) rotation = 0;
    var eraser = /^true$/i.test(params.erasermode || '') || /^erase$/i.test(params.compositeop || '');

    // ---- Krita option curves (pressure/random dynamics) ---------------------
    // Each option (Size/Opacity/Flow/Spacing/Rotation/Scatter/Softness) has a
    // base Value, a UseCurve flag, a curveMode (0=multiply,1=add,2=max,3=min,
    // 4=difference), an optional shared commonCurve (useSameCurve), and a
    // Sensor XML listing the ACTIVE sensors as ChildSensor entries, each with
    // its own curve. parsePresetXml lower-cases param names, so look-ups must
    // be lowercase. NOTE: the old code looked up the camelCase param names and
    // therefore parsed NO curves at all - every .kpp dynamic was silently off.
    // Krita decides whether a checkable option is ACTIVE from the
    // "Pressure<Option>" param (KisKritaSensorPack::read: isChecked =
    // setting->getBool("Pressure"+id, false)). Non-checkable options (Opacity,
    // Flow) have no such param -> always active. Without this, presets that
    // store scatter/rotation values but keep the option unchecked (e.g.
    // Basic-5's ScatterValue=5 / RotationValue=1) would wrongly scatter/rotate.
    function kppOn(name) {
      var lname = name.toLowerCase();
      var p = params['pressure' + lname];
      return (p === undefined || p === null) ? true : (p === 'true');
    }
    function parseCurvePts(text) {
      if (!text) return null;
      var pts = text.split(';').map(function (p) {
        var xy = p.split(',');
        return [parseFloat(xy[0]), parseFloat(xy[1])];
      }).filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); });
      return pts.length >= 2 ? pts : null;
    }
    function kppCurve(name) {
      var lname = name.toLowerCase();
      var sensor = params[lname + 'sensor'];
      var common = parseCurvePts(params[lname + 'commoncurve']);
      var out = {
        enabled: params[lname + 'usecurve'] === 'true',
        mode: parseInt(params[lname + 'curvemode'], 10) || 0,
        useSame: params[lname + 'usesamecurve'] === 'true',
        common: common,
        sensors: []
      };
      if (!out.enabled) return out;
      // Collect active ChildSensors (Krita serialises ONLY active sensors).
      var re = /<ChildSensor\b[^>]*\bid="([^"]+)"[^>]*>\s*(?:<curve>([^<]+)<\/curve>)?/g;
      var m;
      if (sensor) {
        while ((m = re.exec(sensor))) {
          out.sensors.push({ id: m[1], pts: parseCurvePts(m[2]) });
        }
        if (!out.sensors.length) {
          var bareId = /<params\s+id="([^"]+)"/.exec(sensor);
          var bareCurve = /<curve>([^<]+)<\/curve>/.exec(sensor);
          if (bareId && bareCurve) out.sensors.push({ id: bareId[1], pts: parseCurvePts(bareCurve[1]) });
        }
      }
      // A "UseCurve" flag with no readable children still counts when a
      // Pressure<Name> companion param (older presets) enables the curve.
      if (!out.sensors.length && (params['pressure' + lname] === 'true' || common)) {
        out.sensors.push({ id: 'pressure', pts: common });
      }
      return out;
    }
    var kpp = {
      sizeCurve: kppCurve('Size'),
      opacityCurve: kppCurve('Opacity'),
      flowCurve: kppCurve('Flow'),
      spacingCurve: kppCurve('Spacing'),
      rotationCurve: kppCurve('Rotation'),
      scatterCurve: kppCurve('Scatter'),
      softnessCurve: kppCurve('Softness'),
      sharpnessCurve: kppCurve('Sharpness'),
      used: {
        size: kppOn('Size'),
        opacity: kppOn('Opacity'),
        flow: kppOn('Flow'),
        spacing: kppOn('Spacing'),
        rotation: kppOn('Rotation'),
        scatter: kppOn('Scatter'),
        softness: kppOn('Softness'),
        sharpness: kppOn('Sharpness')
      }
    };
    // Scatter base value + axis (Krita ScatterValue is a distance in px at 100%?)
    var scv = paramNum(params.scattervalue, NaN);
    if (isFinite(scv)) kpp.scatter = scv;
    kpp.scatterAxisX = params['scattering/axisx'] === 'true';
    kpp.scatterAxisY = params['scattering/axisy'] === 'true';

    var brush = makeBrush(presetName, {
      engine: parsedXml ? engine : 'pixel',
      radius: radius, opacity: opacity, spacing: spacing, hardness: hard,
      rotation: rotation, tip: tipImg, tipURL: tipURL, preview: previewImg, eraser: eraser,
      kpp: kpp, color: (current ? current.color : '#1a1a1a')
    });
    brush.builtin = false;
    return brush;
  }


  // Krita brushes bundled with the app: brushes/manifest.json lists every .kpp
  // in the folder (a static site cannot list a directory), so dropping new
  // brushes in and re-running tools/update-brush-manifest.js auto-loads them.
  // Parse a MyPaint (.myb) brush: JSON with a "settings" map, mirroring
  // libmypaint's own math:
  //   radius = e^radius_logarithmic            (base-e; tooltip: 0.7 ~= 2px)
  //   opacity = opaque * opaque_multiply
  //   spacing = count_dabs_to: dabs per px = dabsPerActual/r + dabsPerBasic/baseR
  //   grain   = gauss * offset_by_random * base_radius, radius noise from
  //             radius_by_random, alpha compensation from opaque_linearize
  async function parseMybBytes(name, buf, preview) {
    var brush = makeBrush((name || 'mybrush').replace(/\.myb$/i, ''), {
      engine: 'mypaint', radius: 8, opacity: 1, spacing: 0.2,
      hardness: 0.8, preview: preview || null, color: (current ? current.color : '#1a1a1a')
    });
    var mp = { dabsPerActual: 2, dabsPerBasic: 0, dabsPerSecond: 0, baseRadius: 8,
               grainOffset: 0, radiusByRandom: 0, opaqueLinearize: 0 };
    try {
      var j = JSON.parse(decodeText(buf));
      var s = (j && j.settings) || {};
      var rl = s.radius_logarithmic;
      if (rl && isFinite(+rl.base_value)) {
        // libmypaint: expf(radius_logarithmic), clamped to [0.2, 1000].
        brush.radius = clamp(Math.exp(+rl.base_value), 0.2, 320);
      }
      mp.baseRadius = brush.radius;
      var op = s.opaque, opm = s.opaque_multiply;
      var o = 1;
      if (op && isFinite(+op.base_value)) o = +op.base_value;
      // opaque_multiply with base_value 0 uses a pressure curve (0 at rest,
      // ramping to full on hard press); the stamp loop already applies pointer
      // pressure, so a 0 base means "full opacity under pressure" — don't zero
      // the brush out. Only fold in a positive base value.
      if (opm && isFinite(+opm.base_value) && +opm.base_value > 0.001) o *= +opm.base_value;
      brush.opacity = clamp(o, 0.02, 1);
      // Nominal (designed) opacity of the preset. The opacity SLIDER in the UI
      // drives brush.opacity; mypaintDab scales the faithful dab opacity by
      // brush.opacity / nominalOpacity so the default slider position = the
      // brush's designed look and moving the slider actually changes the paint.
      mp.nominalOpacity = brush.opacity;
      var hd = s.hardness;
      if (hd && isFinite(+hd.base_value)) brush.hardness = clamp(+hd.base_value, 0.02, 1);
      // Anti-aliasing off means a harder, scratchier edge (libmypaint keeps a
      // minimum fadeout of anti_aliasing px; 0 forces a hard edge).
      var aa = s.anti_aliasing;
      if (aa && +aa.base_value === 0) brush.hardness = 1;
      // Dab density: libmypaint count_dabs_to.
      var dpa = s.dabs_per_actual_radius, dpb = s.dabs_per_basic_radius;
      if (dpa && isFinite(+dpa.base_value)) mp.dabsPerActual = +dpa.base_value;
      if (dpb && isFinite(+dpb.base_value)) mp.dabsPerBasic = +dpb.base_value;
      mp.dabsPerActual = clamp(mp.dabsPerActual, 0, 200);
      mp.dabsPerBasic = clamp(mp.dabsPerBasic, 0, 200);
      var dps = s.dabs_per_second;
      if (dps && isFinite(+dps.base_value)) mp.dabsPerSecond = Math.max(0, +dps.base_value);
      mp.dabsPerSecond = clamp(mp.dabsPerSecond, 0, 200);
      // Convert to a Krita-style spacing (fraction of the dab DIAMETER): for a
      // constant-radius brush step = r/(dpa+dpb) px = 1/(2*(dpa+dpb)) of the
      // diameter. Fall back to 25% (libmypaint default dpa=2).
      var total = mp.dabsPerActual + mp.dabsPerBasic;
      brush.spacing = total > 0 ? clamp(1 / (2 * total), 0.02, 2) : 0.25;
      // Grain: gauss * offset_by_random * base_radius (libmypaint
      // prepare_and_draw_dab), radius noise from radius_by_random, and
      // opaque_linearize per-dab alpha compensation.
      var obr = s.offset_by_random;
      if (obr && isFinite(+obr.base_value)) mp.grainOffset = Math.abs(+obr.base_value) * mp.baseRadius;
      var rbr = s.radius_by_random;
      if (rbr && isFinite(+rbr.base_value)) mp.radiusByRandom = Math.abs(+rbr.base_value);
      var ol = s.opaque_linearize;
      if (ol && isFinite(+ol.base_value)) mp.opaqueLinearize = clamp(+ol.base_value, 0, 1);
      brush.mypaint = mp;
      if (j && j.comment) brush.name = (j.comment.match(/^([^,]*)/) || [null, brush.name])[1].trim() || brush.name;
      if (j && j.parent_brush_name) {
        var pn = String(j.parent_brush_name).split('/').pop().replace(/\.myb$/i, '');
        brush.name = pn || brush.name;
      }
    } catch (e) {}
    brush.builtin = false;
    // Keep the raw libmypaint settings (base_value + input curves) so the dab
    // engine can evaluate pressure/speed/random/direction dynamics exactly like
    // libmypaint's mypaint_mapping_calculate (base + Σ curve(input)).
    brush.mySettings = s;
    return brush;
  }

  // Console logging for brush loading, so failures are never silent.
  function brushLog(msg, kind) {
    console.log('[brushes] ' + msg);
  }

  // Fetch + parse every brush file (names from the folder index), appending to
  // the list with per-brush logging. Supports .kpp and .myb; .myb uses its
  // paired _prev.png as the preview.
  function loadBrushFiles(names) {
    var pending = names.length, ok = 0, fail = 0;
    if (!pending) { brushLog('no brush files found', 'error'); return; }
    brushLog('loading ' + pending + ' bundled brushes…');
    names.forEach(function (n) {
      if (typeof n !== 'string' || !/\.(kpp|myb)$/i.test(n)) { pending--; return; }
      fetch('brushes/' + encodeURIComponent(n)).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (ab) {
        var u8 = new Uint8Array(ab);
        if (/\.myb$/i.test(n)) {
          // MyPaint brushes pair with a _prev.png preview in the same folder.
          var prev = n.replace(/\.myb$/i, '') + '_prev.png';
          return fetch('brushes/' + encodeURIComponent(prev)).then(function (pr) {
            return pr.ok ? pr.blob() : null;
          }).catch(function () { return null; }).then(function (blob) {
            if (!blob) return parseMybBytes(n, u8, null);
            var url = URL.createObjectURL(blob);
            return new Promise(function (resolve) {
              var im = new Image();
              im.onload = function () { URL.revokeObjectURL(url); resolve(im); };
              im.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
              im.src = url;
            }).then(function (img) { return parseMybBytes(n, u8, img); });
          });
        }
        return parseKppBytes(n, u8);
      }).then(function (brush) {
        brush.bundled = true; // from the brushes/ folder, always available
        var existing = null;
        for (var i = 0; i < brushList.length; i++) {
          if (brushList[i].name === brush.name) { existing = brushList[i]; break; }
        }
        if (existing) {
          // The built-in default has the same name; upgrade it with the real
          // brush file's visuals (tip texture, preview image) so the watercolor
          // grain and .myb previews come through, and keep the parsed settings
          // in sync with the file.
          if (brush.tip) existing.tip = brush.tip;
          if (brush.preview) existing.preview = brush.preview;
          if (brush.mypaint) existing.mypaint = brush.mypaint;
          if (brush.mySettings) existing.mySettings = brush.mySettings;
          if (brush.kpp) existing.kpp = brush.kpp;
          existing.engine = brush.engine;
          existing.radius = brush.radius;
          existing.opacity = brush.opacity;
          existing.hardness = brush.hardness;
          existing.spacing = brush.spacing;
          existing.rotation = brush.rotation;
          existing.eraser = brush.eraser;
          if (existing === current) refreshTip();
          buildBrushList();
          brushLog('upgraded bundled: ' + brush.name);
        } else {
          brushList.push(brush);
          buildBrushList();
          ok++;
        }
      }).catch(function (err) {
        fail++;
        brushLog('failed ' + n + ': ' + (err && err.message || err), 'error');
      }).then(function () {
        pending--;
        if (pending === 0) {
          var cnt = byId('paintBrushCount');
          if (cnt) cnt.textContent = brushList.length;
          brushLog(ok + ' loaded, ' + fail + ' failed', fail ? 'error' : 'ok');
          bundledLoadState = 2;
        }
      });
    });
  }

  var bundledLoadState = 0; // 0 = not started, 1 = in flight, 2 = done

  // Find bundled brushes. Strategy 1: fetch the folder itself and parse the
  // directory index (python http.server and other autoindex servers list the
  // files as links) — this auto-picks up anything dropped into brushes/ with
  // no regeneration step. Strategy 2: brushes/manifest.json (static hosts).
  function loadBundledBrushes() {
    if (bundledLoadState === 1) return; // already in flight; per-brush upgrade rebuilds the list
    bundledLoadState = 1;
    fetch('brushes/').then(function (r) { return r.text(); }).then(function (html) {
      var names = [];
      var re = /href="([^"]+)"/gi;
      var m;
      while ((m = re.exec(html))) {
        var href = decodeURIComponent(m[1]);
        if (/\.(kpp|myb)$/i.test(href)) names.push(href.split('/').pop());
      }
      if (!names.length) throw new Error('no brush links in directory index');
      brushLog('directory index: ' + names.length + ' brush files');
      loadBrushFiles(names);
    }).catch(function (e) {
      brushLog('directory index failed (' + (e && e.message || e) + '); trying manifest.json', 'error');
      fetch('brushes/manifest.json').then(function (r) {
        if (!r.ok) throw new Error('no manifest');
        return r.json();
      }).then(function (files) {
        if (!Array.isArray(files) || !files.length) throw new Error('empty manifest');
        brushLog('manifest: ' + files.length + ' brush files');
        loadBrushFiles(files);
      }).catch(function (e2) {
        // fetch is blocked when the page is opened straight from disk (file://)
        // or the server hides the folder — say so instead of failing silently.
        brushLog('could not list brushes: ' + (e2 && e2.message || e2) + '. Serve the folder over HTTP (see README) to load bundled brushes.', 'error');
        bundledLoadState = 0; // allow a retry (e.g. when the paint tool reopens)
      });
    });
  }

  // ---- save / integrate -------------------------------------------------------

  function canvasToURL() { return paintCanvas.toDataURL('image/png'); }

  function assetName() { return (current ? current.name : 'Paint') + ' paint'; }

  function ensureAsset(url, layers) {
    if (!state.assets.some(function (a) { return a.img === url; })) {
      state.assets.push({ img: url, name: assetName(), w: workW, h: workH, paintLayers: layers });
    }
  }

  // ---- library naming dialog -------------------------------------------------

  var newAssetNameCb = null;   // pending resolver for the "name your drawing" box

  function openNameDialog(defaultName, cb) {
    var d = byId('paintNameDialog');
    if (!d) { cb(defaultName || assetName()); return; }
    var inp = byId('paintNameInput');
    newAssetNameCb = cb;
    if (inp) inp.value = defaultName || '';
    d.classList.remove('hidden');
    if (inp) { inp.focus(); inp.select(); }
  }

  function submitNameDialog() {
    var d = byId('paintNameDialog');
    if (!d) return;
    var cb = newAssetNameCb; newAssetNameCb = null;
    var inp = byId('paintNameInput');
    var name = inp ? (inp.value || '').trim() : '';
    d.classList.add('hidden');
    if (cb) cb(name || null);
  }

  function cancelNameDialog() {
    var d = byId('paintNameDialog');
    if (!d) return;
    var cb = newAssetNameCb; newAssetNameCb = null;
    d.classList.add('hidden');
    if (cb) cb(null);
  }

  // Brand-new library images are named the first time they are added: the tool
  // asks before inserting (the previously-ugly auto name "<brush> paint" is the
  // pre-filled suggestion). Cancelling just leaves the painting out of the
  // library — it stays in the editor.
  function addNewLibraryAsset(url, layers) {
    if (state.assets.some(function (a) { return a.img === url; })) return; // unchanged paint already saved
    openNameDialog(assetName(), function (name) {
      if (!name) return; // cancelled
      recordUndo();
      state.assets.push({ img: url, name: name, w: workW, h: workH, paintLayers: layers });
      renderAssets();
      toast('Added to library · ' + name);
    });
  }

  // Editing an asset IS saving: commit the flattened image + editable layers.
  // Also refresh the change-detection baseline so closing right after an
  // explicit save doesn't save it a second time.
  function commitLibraryAsset(a) {
    var url = canvasToURL();
    var layers = capturePaintLayers();
    recordUndo();
    a.img = url;
    a.w = workW; a.h = workH;
    a.paintLayers = layers.length ? layers : undefined;
    renderAssets();
    paintBaselineURL = url;
    toast('Library image updated');
  }

  function saveToLibrary() {
    var url = canvasToURL();
    var layers = capturePaintLayers();
    if (editKeyframeId) {
      recordUndo();
      var kf = null;
      for (var i = 0; i < state.keyframes.length; i++) if (state.keyframes[i].id === editKeyframeId) kf = state.keyframes[i];
      if (kf) {
        kf.img = url; kf.w = workW; kf.h = workH;
        savePaintLayersToKeyframe(kf);
        ensureAsset(url, layers);
        invalidateAround(kf.id);
        applyWorkSize();
        renderAll();
        scheduleGenerate();
      }
      toast('Keyframe updated');
    } else if (editAsset) {
      commitLibraryAsset(editAsset);
    } else {
      addNewLibraryAsset(url, layers);
    }
  }

  // ---- paint layers ----------------------------------------------------------

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
      // so the preview never bleeds (mirrors commitSelScratch: eraser/hard
      // strokes replace the selection region, soft brush strokes overlay it)
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
        var eraserStroke = !!(eraserOn || (current && current.eraser));
        if (eraserStroke || !(sel && sel.feather > 0)) {
          tg.save();
          tg.globalCompositeOperation = 'destination-out';
          tg.drawImage(selMaskCv, 0, 0);
          tg.restore();
        }
        tg.drawImage(masked, 0, 0);
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

  // ---- onion skin: ghosts of neighbouring keyframes while painting --------

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

  // ---- brush presets (persisted in the project + standalone .khuwari files) --

  // Convert a brush to a plain, serialisable object (tip image -> data URL).
  function serializeBrush(b) {
    var o = {
      name: b.name, engine: b.engine, radius: b.radius, opacity: b.opacity,
      hardness: b.hardness, spacing: b.spacing, rotation: b.rotation,
      color: b.color, followDir: !!b.followDir, eraser: !!b.eraser
    };
    if (b.mypaint) o.mypaint = b.mypaint;      // keep libmypaint grain/spacing data
    if (b.mySettings) o.mySettings = b.mySettings; // keep the full curve settings
    try {
      if (b.tip && b.tip.width) {
        var c = document.createElement('canvas');
        c.width = b.tip.width; c.height = b.tip.height;
        c.getContext('2d').drawImage(b.tip, 0, 0);
        o.tipURL = c.toDataURL('image/png');
      }
    } catch (e) {}
    return o;
  }

  // Rebuild a brush object (optionally with its tip image) from a preset.
  function deserializeBrush(preset) {
    return new Promise(function (resolve) {
      var b = makeBrush(preset.name || 'Preset', {
        engine: preset.engine || 'pixel',
        radius: clamp(+preset.radius || 40, 0.5, 320),
        opacity: clamp(+preset.opacity != null ? +preset.opacity : 1, 0.02, 1),
        hardness: clamp(+preset.hardness != null ? +preset.hardness : 0.8, 0, 1),
        spacing: clamp(+preset.spacing != null ? +preset.spacing : 0.15, 0.01, 2),
        rotation: +preset.rotation || 0,
        color: preset.color || '#1a1a1a',
        followDir: !!preset.followDir,
        eraser: !!preset.eraser,
        builtin: false
      });
      if (preset.mypaint && typeof preset.mypaint === 'object') b.mypaint = preset.mypaint;
      if (preset.mySettings && typeof preset.mySettings === 'object') b.mySettings = preset.mySettings;
      if (preset.tipURL) {
        var im = new Image();
        im.onload = function () { b.tip = im; if (b === current) refreshTip(); resolve(b); };
        im.onerror = function () { resolve(b); };
        im.src = preset.tipURL;
      } else resolve(b);
    });
  }

  // Restore saved custom brushes (called from project load). Defaults always
  // come first; only user-made presets are re-added.
  // Merge a project's saved custom brushes into the palette. The bundled Krita
  // brushes stay put — they are global, not per-project — so this only appends
  // (deduped) instead of resetting the list.
  function applyLoadedBrushes(arr) {
    if (!Array.isArray(arr)) return;
    if (!paintCanvas) { pendingBrushes = arr; return; }
    if (!brushList.length) brushList = defaultBrushes();
    arr.forEach(function (p) {
      deserializeBrush(p).then(function (b) {
        if (!brushList.some(function (x) { return x.name === b.name; })) {
          brushList.push(b);
          buildBrushList();
        }
      });
    });
  }

  // New-project reset: keep the always-available bundled Krita brushes, only
  // drop the previous project's custom presets and restore the defaults.
  function resetPaintBrushes() {
    var bundled = (typeof brushList !== 'undefined' && Array.isArray(brushList))
      ? brushList.filter(function (b) { return b.bundled; })
      : [];
    brushList = defaultBrushes();
    current = defaultBrush();
    if (current) current.color = fgColor;   // keep the last-used paint colour
    bundled.forEach(function (b) {
      if (!brushList.some(function (x) { return x.name === b.name; })) brushList.push(b);
    });
    if (paintCanvas) { buildBrushList(); refreshBrushUI(); }
    // The fresh built-in defaults have no preview images; reload the bundled
    // brush files so the real thumbnails (and texture tips) come back.
    bundledLoadState = 0;
    loadBundledBrushes();
  }

  // ---- open / close -----------------------------------------------------------

  function fitCanvas() {
    var wrap = byId('paintCanvasWrap');
    if (!wrap || !paintCanvas) return;
    var aw = wrap.clientWidth - 24, ah = wrap.clientHeight - 24;
    if (aw <= 0 || ah <= 0) return;
    var base = Math.min(aw / workW, ah / workH, 1.6);
    var z = (paintZoom || 1) * base;
    var stage = paintCanvas.parentElement;
    if (stage) {
      stage.style.width = (workW * z) + 'px';
      stage.style.height = (workH * z) + 'px';
      stage.style.transform = 'translate(' + paintPanX + 'px,' + paintPanY + 'px)';
    }
    paintCanvas.style.width = (workW * z) + 'px';
    paintCanvas.style.height = (workH * z) + 'px';
    if (overlayCv) {
      overlayCv.style.width = paintCanvas.style.width;
      overlayCv.style.height = paintCanvas.style.height;
    }
    var zv = byId('paintZoomVal');
    if (zv) zv.textContent = Math.round((paintZoom || 1) * 100) + '%';
  }

  // Zoom the canvas around a point in the wrap's coordinate space (mxw, myw,
  // viewport px relative to the wrap's top-left). The stage is flex-centered in
  // the wrap, so the anchor math must account for that centering offset: the
  // canvas point under the cursor stays put as the scale changes.
  function zoomAt(mxw, myw, factor) {
    var wrap = byId('paintCanvasWrap');
    if (!wrap || !paintCanvas) return;
    var aw = wrap.clientWidth, ah = wrap.clientHeight;
    var base = Math.min((aw - 24) / workW, (ah - 24) / workH, 1.6);
    var old = paintZoom || 1;
    var nz = clamp(old * factor, 0.1, 24);
    var zOld = old * base, zNew = nz * base;
    var cOldX = (aw - workW * zOld) / 2, cOldY = (ah - workH * zOld) / 2;
    var cNewX = (aw - workW * zNew) / 2, cNewY = (ah - workH * zNew) / 2;
    // canvas-space point currently under the cursor
    var u = (mxw - cOldX - paintPanX) / zOld;
    var v = (myw - cOldY - paintPanY) / zOld;
    paintPanX = mxw - cNewX - u * zNew;
    paintPanY = myw - cNewY - v * zNew;
    paintZoom = nz;
    fitCanvas();
  }

  function fitView() {
    paintZoom = 1; paintPanX = 0; paintPanY = 0;
    fitCanvas();
  }

  function openPaint(opts) {
    opts = opts || {};
    editKeyframeId = opts.keyframeId || null;
    editAsset = opts.asset || null;
    var ov = byId('paintOverlay');
    if (!ov) return;
    ov.classList.remove('hidden');
    paintOpen = true;
    // If the bundled brushes never finished loading (opened before the async
    // fetch settled, a transient network hiccup, or after a project reset),
    // kick the load again so the palette shows the real preview images.
    if (bundledLoadState !== 2 && bundledLoadState !== 1) {
      bundledLoadState = 0;
      loadBundledBrushes();
    }
    paintCanvas.width = workW;
    paintCanvas.height = workH;
    paintDispCtx = paintCanvas.getContext('2d');
    overlayCv = byId('paintOverlayCv');
    if (overlayCv) { overlayCv.width = workW; overlayCv.height = workH; overlayCtx = overlayCv.getContext('2d'); }

    // The background canvas stays transparent; a keyframe's existing image is
    // folded into the first layer (so repainted art stays editable) and any
    // previously saved layer stack is restored whole.
    if (!paintBaseCanvas) paintBaseCanvas = document.createElement('canvas');
    paintBaseCanvas.width = workW; paintBaseCanvas.height = workH;
    paintBaseCanvas.getContext('2d').clearRect(0, 0, workW, workH);

    paintUndoStack = [];
    paintRedoStack = [];
    // Reset the auto-save change-detection state; the right baseline is captured
    // once the opened image / saved layers have finished loading (below).
    paintBaselineURL = null;
    paintReady = false;
    var asyncLoad = false;
    var kf = editKeyframeId ? getKf(editKeyframeId) : null;
    var src = editAsset || kf;
    // Onion ghosts are anchored at the playhead (see paintOnionNeighbors): place
    // it on the keyframe being painted so the ghosts are its neighbouring
    // frames, and keep the main timeline's playhead in sync.
    if (kf) {
      state.playhead = kf.time;
      if (typeof renderPlayhead === 'function') renderPlayhead();
    }
    if (src && Array.isArray(src.paintLayers) && src.paintLayers.length) {
      asyncLoad = true;
      restorePaintLayers(src.paintLayers, function () {
        compositeDisplay();
        paintBaselineURL = canvasToURL();
        paintReady = true;
      });
    } else {
      restorePaintLayers(null);
      if (src && src.img) {
        asyncLoad = true;
        var img = new Image();
        img.onload = function () {
          paintLayers[0].canvas.getContext('2d').drawImage(img, 0, 0, workW, workH);
          compositeDisplay();
          paintBaselineURL = canvasToURL();
          paintReady = true;
        };
        img.src = src.img;
      }
    }
    var banner = byId('paintEditBanner');
    if (kf) { if (banner) { banner.textContent = 'Repainting keyframe at ' + fmtTime(kf.time); banner.classList.remove('hidden'); } }
    else if (editAsset) { if (banner) { banner.textContent = 'Editing library image · ' + (editAsset.name || 'asset'); banner.classList.remove('hidden'); } }
    else if (banner) { banner.classList.add('hidden'); }
    fitCanvas();
    // Always re-apply the last-used foreground colour when opening, so a stale
    // preset colour (black) never wins after a project reset / brush reload.
    if (current) current.color = fgColor;
    refreshTip();
    refreshBrushUI();
    syncColorWheel(); // keep the color wheel in step with the brush colour
    rebuildLayerUI();
    syncPaintOnionUI();
    syncPaintPlayheadUI();
    compositeDisplay();
    refreshOnion();
    // No async image is pending (blank canvas, no saved layers): the composite
    // right now is the baseline. Imaged assets set it in their own onload.
    if (!asyncLoad) { paintBaselineURL = canvasToURL(); paintReady = true; }
  }

  function closePaint() {
    if (drawing) { drawing = false; if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
    stopAnts();
    sel = null; selMaskCv = null; selDrag = null;
    selScratchCv = null; selScratchCtx = null; selScratchLayer = null;
    if (activeLayer) paintCtx = activeLayer.canvas.getContext('2d');
    cropRect = null; xfrm = null; toolDrag = null;
    // Editing a library asset IS saving: push the result back automatically so
    // the user never has to press "Save to library" again. Only when something
    // actually changed, so closing an untouched asset is a no-op.
    if (editAsset && paintReady) {
      var cur = canvasToURL();
      if (cur !== paintBaselineURL) commitLibraryAsset(editAsset);
    }
    var ov = byId('paintOverlay');
    if (ov) ov.classList.add('hidden');
    paintOpen = false;
    editKeyframeId = null;
    editAsset = null;
  }

  // Krita-style value-on-slider widget: a native range input with the current
  // value drawn in a pill centred over the groove. Double-clicking the slider
  // swaps the pill for a text field you can type into — Enter or clicking away
  // commits (clamped to the range), Esc cancels. `o` = {
  //   range, label, text (element ids), read(), toInput(v), parse(str),
  //   min(), max(), fmt(v), apply(v)
  // }. This also improves on the app's slider keyboard access: arrows nudge,
  // and the typed entry accepts any value in range.
  function wirePaintKSlider(o) {
    var range = byId(o.range), label = byId(o.label), text = byId(o.text);
    if (!range || !label || !text) return function () {};
    var wrap = range.parentElement;
    var editing = false;
    function render() { label.textContent = o.fmt(o.read()); }
    function enter() {
      editing = true;
      text.value = String(o.toInput(o.read()));
      label.classList.add('hidden');
      text.hidden = false;
      text.focus();
      text.select();
    }
    function leave(cancel) {
      if (!editing) return;
      editing = false;
      text.hidden = true;
      label.classList.remove('hidden');
      if (!cancel) {
        var v = o.parse(text.value.trim());
        if (isFinite(v)) o.apply(clamp(v, o.min(), o.max()));
      }
      render();
    }
    if (wrap) wrap.addEventListener('dblclick', function (e) { if (e.target !== text) enter(); });
    text.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); text.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); text._cancel = true; text.blur(); }
    });
    text.addEventListener('blur', function () { var c = !!text._cancel; text._cancel = false; leave(c); });
    render();
    return render;
  }

  function wirePaint() {
    paintCanvas = byId('paintCanvas');
    paintDispCtx = paintCanvas.getContext('2d');
    brushList = defaultBrushes();
    current = defaultBrush();

    byId('btnPaintClose').addEventListener('click', closePaint);
    var openBtn = byId('btnPaint');
    if (openBtn) openBtn.addEventListener('click', function () { openPaint(); });
    var kfPaint = byId('btnKfPaint');
    if (kfPaint) kfPaint.addEventListener('click', function () {
      var id = el.kfMenu && el.kfMenu._kfId;
      if (id) openPaint({ keyframeId: id });
      else if (state.selectedId) openPaint({ keyframeId: state.selectedId });
      else toast('Right-click a frame, then choose Edit in paint');
    });

    byId('paintCanvas').addEventListener('pointerdown', onPaintDown);
    byId('paintCanvas').addEventListener('pointermove', onPaintMove);
    byId('paintCanvas').addEventListener('pointerup', onPaintUp);
    byId('paintCanvas').addEventListener('pointercancel', onPaintUp);
    byId('paintCanvas').addEventListener('pointerleave', function (e) { if (drawing) onPaintUp(e); });

    // Krita-style Size: slider + numeric spinbox, diameter in px. The normal
    // range is 1..50; it widens only for presets preset at a bigger size so
    // they are never silently shrunk on selection.
    function setPaintSize(d) {
      d = clamp(+d || 1, 1, 1000);
      current.radius = d / 2;
      // Krita setPaintOpSize also rewrites the brush's base_radius to the new
      // size, which scales scatter amplitude and the dabs-per-basic-radius
      // spacing term (count_dabs_to) - mirror that here for MyPaint brushes.
      if (current.mypaint) current.mypaint.baseRadius = current.radius;
      syncSizeUI(d);
    }
    byId('paintSize').addEventListener('input', function () { setPaintSize(+this.value); });

    // Krita-style Opacity: slider (0..1).
    function setPaintOpacity(o) {
      o = clamp(+o || 0, 0, 1);
      current.opacity = o;
      syncOpacityUI(o);
    }
    byId('paintOpacity').addEventListener('input', function () { setPaintOpacity(+this.value); });

    // Krita-style size / opacity controls: the value is drawn ON the slider and
    // double-clicking the slider swaps it into a text field you can type into
    // (Enter or click-away commits, Esc cancels). See wirePaintKSlider.
    wirePaintKSlider({
      range: 'paintSize', label: 'paintSizeLabel', text: 'paintSizeText',
      read: function () { return current.radius * 2; },
      toInput: function (v) { return Math.round(v * 100) / 100; },
      parse: function (s) { return parseFloat(s); },
      min: function () { return 1; },
      max: function () { var s = byId('paintSize'); return parseFloat(s ? s.max : 50) || 50; },
      fmt: fmtSize,
      apply: function (d) { setPaintSize(d); }
    });
    wirePaintKSlider({
      range: 'paintOpacity', label: 'paintOpacityLabel', text: 'paintOpacityText',
      read: function () { return current.opacity; },
      toInput: function (v) { return Math.round(v * 100); },
      parse: function (s) { return parseFloat(s) / 100; },
      min: function () { return 0; },
      max: function () { return 1; },
      fmt: function (v) { return Math.round(v * 100) + '%'; },
      apply: function (v) { setPaintOpacity(v); }
    });

    byId('paintHardness').addEventListener('input', function () { current.hardness = +this.value; setVal('paintHardness', this.value, Math.round(+this.value * 100) + '%'); refreshTip(); });
    // Spacing is a brush preset property (Krita: pixel brushes carry it as a
    // % of diameter, MyPaint brushes derive it from dabs-per-radius), so it is
    // NOT user-adjustable — there is deliberately no spacing slider.

    // ---- color wheel (Krita-style SV square + hue slider) ----
    cwSvCv = byId('paintCwSv');
    cwHueCv = byId('paintCwHue');
    if (cwSvCv && cwHueCv) {
      var svWrap = byId('paintCwSv');
      var hueWrap = byId('paintCwHue');
      function svFromEvent(e) {
        var rect = cwSvCv.getBoundingClientRect();
        return {
          s: clamp((e.clientX - rect.left) / rect.width, 0, 1),
          v: clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1)
        };
      }
      function hueFromEvent(e) {
        var rect = cwHueCv.getBoundingClientRect();
        return clamp((e.clientY - rect.top) / rect.height, 0, 1) * 360;
      }
      svWrap.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        cwDragging = 'sv';
        try { cwSvCv.setPointerCapture(e.pointerId); } catch (err) {}
        var sv = svFromEvent(e);
        cwHsv.s = sv.s; cwHsv.v = sv.v;
        applyColorWheel();
      });
      svWrap.addEventListener('pointermove', function (e) {
        if (cwDragging !== 'sv') return;
        var sv = svFromEvent(e);
        cwHsv.s = sv.s; cwHsv.v = sv.v;
        applyColorWheel();
      });
      svWrap.addEventListener('pointerup', function () { cwDragging = null; });
      svWrap.addEventListener('pointercancel', function () { cwDragging = null; });
      hueWrap.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        cwDragging = 'hue';
        try { cwHueCv.setPointerCapture(e.pointerId); } catch (err) {}
        cwHsv.h = hueFromEvent(e);
        applyColorWheel();
        renderColorWheel(); // hue changed -> redraw SV square
      });
      hueWrap.addEventListener('pointermove', function (e) {
        if (cwDragging !== 'hue') return;
        cwHsv.h = hueFromEvent(e);
        applyColorWheel();
        renderColorWheel();
      });
      hueWrap.addEventListener('pointerup', function () { cwDragging = null; });
      hueWrap.addEventListener('pointercancel', function () { cwDragging = null; });
      var hexIn = byId('paintCwHex');
      if (hexIn) hexIn.addEventListener('change', function () {
        var v = this.value.trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(v) && !/^[0-9a-fA-F]{6}$/.test(v)) { this.value = current ? current.color : '#1a1a1a'; return; }
        if (v[0] !== '#') v = '#' + v;
        setPaintColor(v);
        refreshTip();
        syncColorWheel();
      });
      syncColorWheel();
    }
    // Brush / eraser toolbar buttons mirror the (hidden) eraser checkbox.
    function setPaintTool(eraser) {
      var er = byId('paintEraser');
      if (er) er.checked = !!eraser;
      eraserOn = !!eraser;
      var bb = byId('btnPaintToolBrush'), be = byId('btnPaintToolEraser');
      if (bb) bb.classList.toggle('active', !eraser);
      if (be) be.classList.toggle('active', eraser);
    }
    var erChk = byId('paintEraser');
    if (erChk) erChk.addEventListener('change', function () { setPaintTool(this.checked); });
    var tb = byId('btnPaintToolBrush'), te = byId('btnPaintToolEraser');
    if (tb) tb.addEventListener('click', function () { setPaintTool(false); });
    if (te) te.addEventListener('click', function () { setPaintTool(true); });
    byId('paintSmoothMode').addEventListener('change', refreshBrushUI);
    byId('paintSmoothStr').addEventListener('input', function () { setVal('paintSmoothStr', this.value, Math.round(+this.value) + '%'); });

    // paint layers (Krita-style docker toolbar acts on the active layer)
    byId('btnPaintAddLayer').addEventListener('click', function () { addLayer(); });
    byId('btnPaintDelLayer').addEventListener('click', function () { deleteActiveLayer(); });
    byId('btnPaintLayerUp').addEventListener('click', function () { moveLayer(paintLayers.indexOf(activeLayer), 1); });
    byId('btnPaintLayerDown').addEventListener('click', function () { moveLayer(paintLayers.indexOf(activeLayer), -1); });
    byId('btnPaintMergeDown').addEventListener('click', function () { mergeDown(); });
    var loEl = byId('paintLayerOpacity');
    if (loEl) loEl.addEventListener('input', function () {
      activeLayer.opacity = clamp(+this.value, 0, 1);
      var on = byId('paintLayerOpacityNum');
      if (on) on.value = String(Math.round(activeLayer.opacity * 100));
      compositeDisplay();
    });
    var loNum = byId('paintLayerOpacityNum');
    if (loNum) {
      loNum.addEventListener('change', function () {
        activeLayer.opacity = clamp((+this.value || 0) / 100, 0, 1);
        var lo2 = byId('paintLayerOpacity');
        if (lo2) { lo2.value = String(activeLayer.opacity); syncSlider(lo2); }
        compositeDisplay();
      });
      loNum.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') this.blur(); });
    }
    var lbEl = byId('paintLayerBlend');
    if (lbEl) lbEl.addEventListener('change', function () { activeLayer.blend = lbEl.value; compositeDisplay(); });

    // actions
    byId('btnPaintClear').addEventListener('click', clearCanvas);
    byId('btnPaintUndo').addEventListener('click', undoStroke);
    byId('btnPaintRedo').addEventListener('click', redoStroke);
    byId('btnPaintSaveLib').addEventListener('click', saveToLibrary);

    // keyboard: Esc closes, Ctrl+Z undoes a stroke, Ctrl+Shift+Z / Ctrl+Y
    // redoes, Ctrl+Shift+N adds a layer, Ctrl+E merges the active layer down
    // (all while the paint tool is open).
    // Tool-specific keys (selection/crop/transform) are handled in
    // wireExtraTools' handler, which runs after this one.
    document.addEventListener('keydown', function (e) {
      if (!paintOpen) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      var mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        // Esc first cancels an active crop/transform/selection (handled in the
        // extra-tools handler); if none is active, it closes the tool. We let
        // that handler run and only close when nothing else consumed it.
        if (cropRect || xfrm || sel) return; // let wireExtraTools handle it
        closePaint();
      }
      else if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undoStroke(); }
      else if (mod && e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); redoStroke(); }
      else if (mod && !e.shiftKey && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redoStroke(); }
      else if (mod && e.shiftKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); addLayer(); }
      else if (mod && !e.shiftKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); mergeDown(); }
    });

    // onion skin: mirror the global state.onion / state.onionCfg (used by the
    // main viewport) so the toggle + settings stay consistent across the app
    loadOnionPrefs();
    syncPaintOnionUI();
    var poChk = byId('paintOnion');
    if (poChk) poChk.addEventListener('change', function () { state.onion = this.checked; saveOnionPrefs(); refreshOnion(); });
    var poB = byId('paintOnionBefore');
    if (poB) poB.addEventListener('input', function () { state.onionCfg.before = +this.value; setVal('paintOnionBefore', this.value, this.value); saveOnionPrefs(); refreshOnion(); });
    var poA = byId('paintOnionAfter');
    if (poA) poA.addEventListener('input', function () { state.onionCfg.after = +this.value; setVal('paintOnionAfter', this.value, this.value); saveOnionPrefs(); refreshOnion(); });
    var poO = byId('paintOnionOpacity');
    if (poO) poO.addEventListener('input', function () { state.onionCfg.opacity = +this.value; setVal('paintOnionOpacity', this.value, Math.round(+this.value * 100) + '%'); saveOnionPrefs(); compositeDisplay(); });
    var poT = byId('paintOnionTint');
    if (poT) poT.addEventListener('change', function () { state.onionCfg.tint = this.checked; saveOnionPrefs(); compositeDisplay(); });

    // Playhead scrubber: snap to whole frames, move the timeline playhead and
    // reload the onion ghosts (their neighbours depend on the playhead).
    var ppEl = byId('paintPlayhead');
    if (ppEl) ppEl.addEventListener('input', function () {
      var fps = (state.fps && state.fps > 0) ? state.fps : 12;
      var t = clamp(Math.round(+this.value * fps) / fps, 0, +this.max || 1);
      this.value = String(t);
      syncSlider(this);
      var lab = byId('paintPlayheadVal');
      if (lab) lab.textContent = fmtTime(t);
      state.playhead = t;
      if (typeof renderPlayhead === 'function') renderPlayhead();
      refreshOnion();
    });

    buildBrushList();
    refreshBrushUI();
    if (pendingBrushes) { var pb = pendingBrushes; pendingBrushes = null; applyLoadedBrushes(pb); }
    // Krita brushes shipped with the app: appended to the preset list as soon
    // as they finish parsing (async, per-brush, so the tool opens instantly).
    loadBundledBrushes();

    // ---- collapsible dockers + resizable panels -----------------------------
    // Docker folding uses the shared global collapsible system (see util.js's
    // initCollapsibles): click a title to fold/unfold with smooth animation.
    if (typeof initCollapsibles === 'function') initCollapsibles(byId('paintOverlay'));

    // Resizable side panels: drag the divider, double-click to reset.
    var paintLeftPanel = byId('paintLeftPanel'), paintRightPanel = byId('paintRightPanel');
    function loadPaintPanelWidths() {
      var vwLimit = Math.max(300, window.innerWidth - 120); // leave room for the canvas
      try {
        var lw = parseInt(localStorage.getItem(PAINT_LEFT_W_KEY) || '', 10);
        if (paintLeftPanel && lw) paintLeftPanel.style.width = clamp(lw, PAINT_LEFT_W_MIN, Math.min(PAINT_LEFT_W_MAX, vwLimit)) + 'px';
      } catch (err) {}
      try {
        var rw = parseInt(localStorage.getItem(PAINT_RIGHT_W_KEY) || '', 10);
        if (paintRightPanel && rw) paintRightPanel.style.width = clamp(rw, PAINT_RIGHT_W_MIN, Math.min(PAINT_RIGHT_W_MAX, vwLimit)) + 'px';
      } catch (err) {}
    }
    function savePaintPanelWidths() {
      try { if (paintLeftPanel) localStorage.setItem(PAINT_LEFT_W_KEY, paintLeftPanel.style.width); } catch (err) {}
      try { if (paintRightPanel) localStorage.setItem(PAINT_RIGHT_W_KEY, paintRightPanel.style.width); } catch (err) {}
    }
    function wirePaintResizer(resizer, col, grow, minW, maxW, other) {
      if (!resizer || !col) return;
      resizer.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        resizer.classList.add('dragging');
        document.body.classList.add('resizing-side');
        try { resizer.setPointerCapture(e.pointerId); } catch (err) {}
        var startX = e.clientX, startW = col.offsetWidth;
        function onMove(ev) {
          // Keep the centre canvas usable: don't let the panels swallow it.
          var availMax = maxW;
          if (other) availMax = Math.min(availMax, window.innerWidth - other.offsetWidth - 140);
          var w = clamp(startW + (ev.clientX - startX) * grow, minW, Math.max(minW, availMax));
          col.style.width = w + 'px';
        }
        function onUp() {
          resizer.classList.remove('dragging');
          document.body.classList.remove('resizing-side');
          resizer.removeEventListener('pointermove', onMove);
          resizer.removeEventListener('pointerup', onUp);
          resizer.removeEventListener('pointercancel', onUp);
          savePaintPanelWidths();
        }
        resizer.addEventListener('pointermove', onMove);
        resizer.addEventListener('pointerup', onUp);
        resizer.addEventListener('pointercancel', onUp);
      });
      resizer.addEventListener('dblclick', function () {
        col.style.width = (col === paintLeftPanel ? PAINT_LEFT_W_DEFAULT : PAINT_RIGHT_W_DEFAULT) + 'px';
        savePaintPanelWidths();
      });
    }
    wirePaintResizer(byId('paintLeftResizer'), paintLeftPanel, 1, PAINT_LEFT_W_MIN, PAINT_LEFT_W_MAX, paintRightPanel);
    wirePaintResizer(byId('paintRightResizer'), paintRightPanel, -1, PAINT_RIGHT_W_MIN, PAINT_RIGHT_W_MAX, paintLeftPanel);
    loadPaintPanelWidths();

    // ---- extra tools wiring -------------------------------------------------
    wireExtraTools();
  }

  // ---------------------------------------------------------------------------
  // Extra tools: select, crop, move, fill, eyedrop, line, shapes, transform.
  // ---------------------------------------------------------------------------

  var TOOL_BUTTONS = {
    brush: 'btnPaintToolBrush', eraser: 'btnPaintToolEraser', select: 'btnPaintToolSelect',
    lasso: 'btnPaintToolLasso', wand: 'btnPaintToolWand', move: 'btnPaintToolMove', transform: 'btnPaintToolTransform',
    fill: 'btnPaintToolFill', eyedrop: 'btnPaintToolEyedrop', line: 'btnPaintToolLine',
    rect: 'btnPaintToolRect', ellipse: 'btnPaintToolEllipse', crop: 'btnPaintToolCrop'
  };
  var TOOL_OPTS = {
    brush: 'paintToolOptsBrush', eraser: 'paintToolOptsBrush', select: 'paintToolOptsSelect',
    lasso: 'paintToolOptsSelect', wand: 'paintToolOptsSelect', move: 'paintToolOptsMove', transform: 'paintToolOptsTransform',
    fill: 'paintToolOptsFill', eyedrop: null, line: 'paintToolOptsShape',
    rect: 'paintToolOptsShape', ellipse: 'paintToolOptsShape', crop: 'paintToolOptsCrop'
  };

  function setPaintTool(tool) {
    paintTool = tool;
    // brush/eraser drive the eraser flag (keyboard 'e'/'b' and buttons alike)
    if (tool === 'eraser') {
      eraserOn = true;
      var er = byId('paintEraser'); if (er) er.checked = true;
    } else if (tool === 'brush') {
      eraserOn = false;
      var er2 = byId('paintEraser'); if (er2) er2.checked = false;
    }
    // cancel any in-progress crop / transform / selection drag
    cancelCrop();
    cancelXfrm();
    selDrag = null;
    Object.keys(TOOL_BUTTONS).forEach(function (t) {
      var b = byId(TOOL_BUTTONS[t]);
      if (b) b.classList.toggle('active', t === tool);
    });
    // Hide every tool-options panel, then show only the active tool's. Panels
    // are shared between tools (brush/eraser, line/rect/ellipse, select/lasso),
    // so a plain per-key toggle would re-hide a shared panel after showing it.
    Object.keys(TOOL_OPTS).forEach(function (t) {
      var p = byId(TOOL_OPTS[t]);
      if (p) p.classList.add('hidden');
    });
    var curPanel = byId(TOOL_OPTS[tool]);
    if (curPanel) curPanel.classList.remove('hidden');
    var cv = byId('paintCanvas');
    if (cv) {
      cv.style.cursor = (tool === 'brush' || tool === 'eraser' || tool === 'fill' || tool === 'wand') ? 'crosshair' :
        (tool === 'eyedrop' ? 'copy' : 'default');
    }
    // free-transform shows handles immediately
    if (tool === 'transform') xfrmBegin();
    renderOverlay();
    toast('Tool: ' + tool);
  }

  var selMode = 'rect'; // rect|ellipse|lasso (select tool dropdown)

  // ---- selection engine -----------------------------------------------------

  function buildSelMask() {
    selMaskCv = null;
    if (!sel) return;
    var cv;
    if (sel.type === 'mask' && sel.mask) {
      // Pixel-mask selection (wand / invert / grow / shrink): the hard mask is
      // stored on the selection and feather is a blur applied like any other
      // type. The hard mask also drives the ants outline + move bounds, exactly
      // like the rect/ellipse/lasso geometry drives theirs.
      setMaskCache(sel.mask, sel.maskHint);
      cv = sel.mask;
    } else {
      setMaskCache(null);
      cv = document.createElement('canvas');
      cv.width = workW; cv.height = workH;
      var g = cv.getContext('2d');
      g.fillStyle = '#fff';
      if (sel.type === 'rect') {
        g.fillRect(sel.x, sel.y, sel.w, sel.h);
      } else if (sel.type === 'ellipse') {
        g.beginPath();
        g.ellipse(sel.x + sel.w / 2, sel.y + sel.h / 2, sel.w / 2, sel.h / 2, 0, 0, Math.PI * 2);
        g.fill();
      } else if (sel.type === 'lasso' && sel.path && sel.path.length > 2) {
        g.beginPath();
        g.moveTo(sel.path[0].x, sel.path[0].y);
        for (var i = 1; i < sel.path.length; i++) g.lineTo(sel.path[i].x, sel.path[i].y);
        g.closePath();
        g.fill();
      }
    }
    if (sel.feather > 0) {
      // feather = blur the mask so edges fade (Krita's "feather")
      var blurred = document.createElement('canvas');
      blurred.width = workW; blurred.height = workH;
      var bg = blurred.getContext('2d');
      bg.filter = 'blur(' + sel.feather + 'px)';
      bg.drawImage(cv, 0, 0);
      cv = blurred;
    }
    selMaskCv = cv;
  }

  // Cache the hard mask's bounds + ordered contour chains so the ants outline
  // and bounds queries never rescan pixels per frame (marching squares trace,
  // segments joined end-to-end so the dashes walk the whole boundary). `hint`
  // optionally limits the scan to a bounding rect (inclusive), which makes the
  // wand's tiny selections cheap even on huge canvases.
  function setMaskCache(mask, hint) {
    if (!mask) { sel.maskChains = null; return; }
    var w = mask.width, h = mask.height;
    var d = mask.getContext('2d').getImageData(0, 0, w, h).data;
    function inside(x, y) {
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      return d[(y * w + x) * 4 + 3] > 32;
    }
    var scanX0 = 0, scanY0 = 0, scanX1 = w - 1, scanY1 = h - 1;
    if (hint) {
      scanX0 = Math.max(0, Math.floor(hint.x));
      scanY0 = Math.max(0, Math.floor(hint.y));
      scanX1 = Math.min(w - 1, Math.floor(hint.x + hint.w) - 2);
      scanY1 = Math.min(h - 1, Math.floor(hint.y + hint.h) - 2);
    }
    // Every cell contributes segments (a contour corner can sit in a cell whose
    // own top-left pixel is outside), and one extra border ring of cells is
    // scanned so the canvas top/left edges produce outline segments too.
    var minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    var segs = [];
    for (var y = scanY0 - 1; y <= scanY1; y++) {
      for (var x = scanX0 - 1; x <= scanX1; x++) {
        var A = inside(x, y), B = inside(x + 1, y), C = inside(x + 1, y + 1), D = inside(x, y + 1);
        if (A) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        var c = (A ? 1 : 0) | (B ? 2 : 0) | (C ? 4 : 0) | (D ? 8 : 0);
        if (c === 0 || c === 15) continue;
        var T = [x + 0.5, y], R = [x + 1, y + 0.5], BM = [x + 0.5, y + 1], L = [x, y + 0.5];
        if (c === 1 || c === 14) segs.push({ a: T, b: L });
        else if (c === 2 || c === 13) segs.push({ a: T, b: R });
        else if (c === 3 || c === 12) segs.push({ a: L, b: R });
        else if (c === 4 || c === 11) segs.push({ a: R, b: BM });
        else if (c === 6 || c === 9) segs.push({ a: T, b: BM });
        else if (c === 7 || c === 8) segs.push({ a: BM, b: L });
        else if (c === 5) { segs.push({ a: T, b: L }); segs.push({ a: R, b: BM }); }
        else if (c === 10) { segs.push({ a: T, b: R }); segs.push({ a: BM, b: L }); }
      }
    }
    sel.boundsCache = (minX === Infinity) ? { x: 0, y: 0, w: 0, h: 0 } : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    // join the segments into closed chains by matching shared endpoints
    function key(pt) { return pt[0] + ',' + pt[1]; }
    var heads = {};
    segs.forEach(function (s, i) {
      var ka = key(s.a), kb = key(s.b);
      (heads[ka] = heads[ka] || []).push([i, 1]);
      (heads[kb] = heads[kb] || []).push([i, 0]);
    });
    var chains = [];
    var used = new Uint8Array(segs.length);
    for (var i0 = 0; i0 < segs.length; i0++) {
      if (used[i0]) continue;
      used[i0] = 1;
      var pts = [segs[i0].a, segs[i0].b];
      var tip = key(segs[i0].b);
      var guard = 0;
      while (guard++ < segs.length) {
        var list = heads[tip], next = null;
        if (list) for (var li = 0; li < list.length; li++) {
          if (!used[list[li][0]]) { next = list[li]; break; }
        }
        if (!next) break;
        used[next[0]] = 1;
        var s2 = segs[next[0]];
        if (next[1]) { pts.push(s2.b); tip = key(s2.b); }
        else { pts.push(s2.a); tip = key(s2.a); }
        if (tip === key(pts[0])) { pts.pop(); break; }
      }
      if (pts.length >= 2) chains.push(pts);
    }
    sel.maskChains = chains;
  }

  function selPoint(x, y) {
    if (!selMaskCv) {
      if (sel) buildSelMask();
      if (!selMaskCv) return false;
    }
    var px = Math.round(x), py = Math.round(y);
    if (px < 0 || py < 0 || px >= workW || py >= workH) return false;
    var d = selMaskCv.getContext('2d').getImageData(px, py, 1, 1).data;
    return d[3] > 32;
  }

  function selBounds() {
    if (!sel) return null;
    if (sel.type === 'rect' || sel.type === 'ellipse') return { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
    if (sel.type === 'mask') {
      if (!sel.boundsCache) { if (sel.mask) setMaskCache(sel.mask); else return null; }
      return sel.boundsCache;
    }
    if (sel.type === 'lasso' && sel.path && sel.path.length) {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      sel.path.forEach(function (pt) {
        if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
      });
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    return null;
  }

  // Trace a selection outline (rect/ellipse) or lasso path into the overlay.
  function drawSelOutline(g, offX, offY) {
    if (!sel) return;
    g.strokeStyle = '#000';
    g.lineWidth = 1.2;
    g.setLineDash([6, 5]);
    g.lineDashOffset = -antsOffset;
    g.beginPath();
    if (sel.type === 'rect') {
      g.rect(sel.x + offX + 0.5, sel.y + offY + 0.5, sel.w, sel.h);
    } else if (sel.type === 'ellipse') {
      g.ellipse(sel.x + offX + sel.w / 2, sel.y + offY + sel.h / 2, sel.w / 2, sel.h / 2, 0, 0, Math.PI * 2);
    } else if (sel.type === 'lasso' && sel.path && sel.path.length > 2) {
      g.moveTo(sel.path[0].x + offX, sel.path[0].y + offY);
      for (var i = 1; i < sel.path.length; i++) g.lineTo(sel.path[i].x + offX, sel.path[i].y + offY);
      g.closePath();
    } else if (sel.type === 'mask' && sel.maskChains && sel.maskChains.length) {
      // pixel-mask outline: the traced contour chains (chords along the mask
      // boundary), marched with the same dash phase as geometric selections
      sel.maskChains.forEach(function (ch) {
        g.moveTo(ch[0][0] + offX, ch[0][1] + offY);
        for (var k = 1; k < ch.length; k++) g.lineTo(ch[k][0] + offX, ch[k][1] + offY);
        g.closePath();
      });
    }
    g.stroke();
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.setLineDash([6, 5]);
    g.lineDashOffset = -antsOffset + 4;
    g.stroke();
    g.setLineDash([]);
  }

  function startAnts() {
    if (antsTimer) return;
    // Pace the march (~11 steps/s) instead of stepping every animation frame:
    // racing the dash offset 60x/s made the outline flicker like it was
    // disappearing.
    var last = 0;
    var step = function (ts) {
      if (ts - last > 90) { antsOffset = (antsOffset + 1) % 22; last = ts; }
      renderOverlay();
      if (paintOpen && (sel || cropRect)) antsTimer = requestAnimationFrame(step);
      else antsTimer = 0;
    };
    antsTimer = requestAnimationFrame(step);
  }

  function stopAnts() {
    if (antsTimer) { cancelAnimationFrame(antsTimer); antsTimer = 0; }
  }

  // ---- overlay rendering ----------------------------------------------------

  function renderOverlay() {
    if (!overlayCtx) return;
    overlayCtx.clearRect(0, 0, workW, workH);
    // Onion ghosts first (bottom): drawn on this display-only overlay so they
    // always sit on top of the frame and are visible even on opaque frames.
    paintDrawOnion(overlayCtx);
    // selection outline only (no tint fill - just the marching ants)
    if (sel) {
      if (!selMaskCv) buildSelMask();     // never let the outline vanish on a stale mask
      if (selMaskCv) {
        var off = (selDrag && selDrag.mode === 'move') ? { x: selDrag.dx, y: selDrag.dy } : { x: 0, y: 0 };
        drawSelOutline(overlayCtx, off.x, off.y);
      }
    }
    // crop rect: dim outside + draw border
    if (cropRect) {
      overlayCtx.save();
      overlayCtx.fillStyle = 'rgba(0,0,0,0.45)';
      overlayCtx.fillRect(0, 0, workW, cropRect.y);
      overlayCtx.fillRect(0, cropRect.y + cropRect.h, workW, workH - cropRect.y - cropRect.h);
      overlayCtx.fillRect(0, cropRect.y, cropRect.x, cropRect.h);
      overlayCtx.fillRect(cropRect.x + cropRect.w, cropRect.y, workW - cropRect.x - cropRect.w, cropRect.h);
      overlayCtx.strokeStyle = '#fff';
      overlayCtx.lineWidth = 1.5;
      overlayCtx.setLineDash([8, 5]);
      overlayCtx.lineDashOffset = -antsOffset;
      overlayCtx.strokeRect(cropRect.x + 0.5, cropRect.y + 0.5, cropRect.w, cropRect.h);
      overlayCtx.setLineDash([]);
      // corner handles
      overlayCtx.fillStyle = '#fff';
      [[cropRect.x, cropRect.y], [cropRect.x + cropRect.w, cropRect.y],
       [cropRect.x, cropRect.y + cropRect.h], [cropRect.x + cropRect.w, cropRect.y + cropRect.h]]
        .forEach(function (c) { overlayCtx.fillRect(c[0] - 3, c[1] - 3, 6, 6); });
      overlayCtx.restore();
    }
    // transform handles
    if (xfrm) renderXfrm(overlayCtx);
    // line/shape preview (drawn live during drag)
    if (toolDrag && toolDrag.preview === 'line') {
      overlayCtx.strokeStyle = 'rgba(255,255,255,0.85)';
      overlayCtx.lineWidth = 1;
      overlayCtx.beginPath();
      overlayCtx.moveTo(toolDrag.x0, toolDrag.y0);
      overlayCtx.lineTo(toolDrag.x1, toolDrag.y1);
      overlayCtx.stroke();
    } else if (toolDrag && toolDrag.preview === 'shape') {
      overlayCtx.strokeStyle = 'rgba(255,255,255,0.85)';
      overlayCtx.lineWidth = 1;
      overlayCtx.beginPath();
      if (toolDrag.shape === 'rect') overlayCtx.rect(toolDrag.x, toolDrag.y, toolDrag.w, toolDrag.h);
      else overlayCtx.ellipse(toolDrag.x + toolDrag.w / 2, toolDrag.y + toolDrag.h / 2, Math.abs(toolDrag.w) / 2, Math.abs(toolDrag.h) / 2, 0, 0, Math.PI * 2);
      overlayCtx.stroke();
    }
  }

  // ---- selection tool handlers ---------------------------------------------

  // Hit-test a pointer against the active selection: inside the mask, or (for
  // feathered selections) anywhere inside the bounding box so the soft fringe
  // can still be grabbed.
  function selHit(p) {
    if (!sel || !selMaskCv) return false;
    var b = selBounds();
    if (!b || p.x < b.x || p.y < b.y || p.x > b.x + b.w || p.y > b.y + b.h) return false;
    return selPoint(p.x, p.y) || sel.feather > 0;
  }

  function beginSelMove(p, dup) {
    pushUndo();
    var ctx = activeLayer.canvas.getContext('2d');
    selDrag = {
      mode: 'move', sx: p.x, sy: p.y, dx: 0, dy: 0, dup: !!dup,
      snapshot: ctx.getImageData(0, 0, workW, workH),
      contentCv: selContentCopy()
    };
    compositeDisplay();
  }

  function selDown(p) {
    // lasso tool always lassoes; the select tool uses the mode dropdown
    var mode = paintTool === 'lasso' ? 'lasso' : (selMode || 'rect');
    if (selHit(p)) { beginSelMove(p, false); return; }
    // start a new selection. The current selection is NOT dropped until the
    // drag actually produces one, so a stray click no longer makes the outline
    // vanish (it is replaced when the new shape appears on the first move).
    selDrag = { mode: 'draw', type: mode, sx: p.x, sy: p.y, pts: [{ x: p.x, y: p.y }] };
  }

  function selMove(p) {
    if (!selDrag) return;
    if (selDrag.mode === 'move') {
      selDrag.dx = p.x - selDrag.sx;
      selDrag.dy = p.y - selDrag.sy;
      // live preview: restore snapshot, then place the content at the offset
      // (erase the original region unless this is a duplicate drag)
      var ctx = activeLayer.canvas.getContext('2d');
      ctx.putImageData(selDrag.snapshot, 0, 0);
      if (!selDrag.dup) selEraseRegion(ctx);
      if (selDrag.dup) ctx.drawImage(selDrag.contentCv, 0, 0);
      drawSelContentAt(ctx, selDrag.dx, selDrag.dy);
      compositeDisplay();
      return;
    }
    if (selDrag.type === 'lasso') {
      var lp = selDrag.pts[selDrag.pts.length - 1];
      if (Math.hypot(p.x - lp.x, p.y - lp.y) > 2) selDrag.pts.push({ x: p.x, y: p.y });
      // only replace the current selection once the lasso is a real shape
      if (selDrag.pts.length >= 3) {
        sel = { type: 'lasso', path: selDrag.pts.slice(), feather: selFeatherVal() };
        buildSelMask();
      }
      renderOverlay();
      return;
    }
    var x0 = Math.min(selDrag.sx, p.x), y0 = Math.min(selDrag.sy, p.y);
    var w = Math.abs(p.x - selDrag.sx), h = Math.abs(p.y - selDrag.sy);
    if (evShift) { // hold Shift for square/circle
      var s = Math.max(w, h);
      if (p.x < selDrag.sx) x0 = selDrag.sx - s;
      if (p.y < selDrag.sy) y0 = selDrag.sy - s;
      w = s; h = s;
    }
    // only actually replace the selection when the drag produced a shape
    if (w >= 1 || h >= 1) {
      sel = { type: selDrag.type, x: x0, y: y0, w: w, h: h, feather: selFeatherVal() };
      buildSelMask();
    }
    renderOverlay();
  }

  function selUp() {
    if (!selDrag) return;
    if (selDrag.mode === 'move') {
      if (selDrag.dx || selDrag.dy) {
        // commit: keep content moved; move the selection border with it
        if (sel && (sel.type === 'rect' || sel.type === 'ellipse')) {
          sel.x += selDrag.dx; sel.y += selDrag.dy;
        } else if (sel && sel.type === 'lasso') {
          sel.path.forEach(function (pt) { pt.x += selDrag.dx; pt.y += selDrag.dy; });
        } else if (sel && sel.type === 'mask') {
          // shift the stored hard mask (and re-blur the working copy); the
          // bounds/outline caches and the fast-scan hint no longer match
          var nm = document.createElement('canvas');
          nm.width = workW; nm.height = workH;
          nm.getContext('2d').drawImage(sel.mask, selDrag.dx, selDrag.dy);
          sel.mask = nm;
          sel.maskHint = null;
        }
        buildSelMask();
      }
      selDrag = null;
      compositeDisplay();
      return;
    }
    // A draw drag that never produced a shape (plain click / tiny lasso) leaves
    // the current selection untouched instead of wiping its outline.
    selDrag = null;
    startAnts();
    compositeDisplay();
  }

  // Copy the active layer's pixels inside the selection into a fresh canvas.
  function selContentCopy() {
    var cv = document.createElement('canvas');
    cv.width = workW; cv.height = workH;
    var g = cv.getContext('2d');
    g.drawImage(activeLayer.canvas, 0, 0);
    if (selMaskCv) { g.globalCompositeOperation = 'destination-in'; g.drawImage(selMaskCv, 0, 0); }
    return cv;
  }

  // Erase the active selection's region from ctx (used by the move preview).
  function selEraseRegion(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(selMaskCv, 0, 0);
    ctx.restore();
  }

  // Draw the moved selection content into ctx at offset (dx,dy), clipped to the
  // selection shape translated by the same offset.
  function drawSelContentAt(ctx, dx, dy) {
    if (!selDrag || !selDrag.contentCv) return;
    var tmp = document.createElement('canvas');
    tmp.width = workW; tmp.height = workH;
    var t = tmp.getContext('2d');
    t.drawImage(selDrag.contentCv, dx, dy);
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(selMaskCv, dx, dy);
    ctx.drawImage(tmp, 0, 0);
  }

  // ---- masked painting ------------------------------------------------------
  // With a live selection, brush/eraser strokes and line/shape drags are drawn
  // into a scratch canvas that starts as a copy of the active layer; the result
  // is displayed (and committed) clipped to the selection mask, so strokes can
  // never bleed outside the selection - same as Krita painting with a selection.
  function beginSelScratch() {
    selScratchCv = null; selScratchCtx = null; selScratchLayer = null;
    if (!selMaskCv || !activeLayer) return;
    var cv = document.createElement('canvas');
    cv.width = workW; cv.height = workH;
    var c = cv.getContext('2d');
    c.drawImage(activeLayer.canvas, 0, 0);
    selScratchCv = cv; selScratchCtx = c; selScratchLayer = activeLayer;
    paintCtx = c;
  }

  // Blit the (masked) scratch onto the active layer and drop it. Used for the
  // live preview of line/shape drags and to commit brush/eraser strokes.
  function commitSelScratch() {
    if (!selScratchCv) return;
    var sc = selScratchCv;
    selScratchCv = null; selScratchCtx = null; selScratchLayer = null;
    paintCtx = activeLayer ? activeLayer.canvas.getContext('2d') : null;
    if (!activeLayer) return;
    var tmp = document.createElement('canvas');
    tmp.width = workW; tmp.height = workH;
    var t = tmp.getContext('2d');
    t.drawImage(sc, 0, 0);
    if (selMaskCv) { t.globalCompositeOperation = 'destination-in'; t.drawImage(selMaskCv, 0, 0); }
    var ctx = activeLayer.canvas.getContext('2d');
    var eraserStroke = !!(eraserOn || (current && current.eraser));
    // Erasing (or any hard-edged stroke) must REPLACE the layer inside the
    // selection - holes overlaid on top would just show the old pixels
    // beneath. Soft brush strokes overlay instead, so a feathered fringe
    // keeps the underlying art intact.
    if (eraserStroke || !(sel && sel.feather > 0)) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(selMaskCv, 0, 0);
      ctx.restore();
    }
    ctx.drawImage(tmp, 0, 0);
  }

  function selFeatherVal() {
    var f = byId('paintSelFeather');
    return f ? +f.value : 0;
  }

  function selectAll() {
    sel = { type: 'rect', x: 0, y: 0, w: workW, h: workH, feather: 0 };
    buildSelMask();
    startAnts();
    compositeDisplay();
  }

  function selectNone() {
    commitSelScratch();   // never strand an in-flight masked stroke
    sel = null; selMaskCv = null; selDrag = null;
    stopAnts();
    compositeDisplay();
  }

  function invertSelection() {
    if (!sel) return;
    var cv = document.createElement('canvas');
    cv.width = workW; cv.height = workH;
    var g = cv.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, workW, workH);
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(selMaskCv, 0, 0);
    // keep the inverted region as a real pixel mask so rebuilds/moves/outlines
    // never collapse it back into a full-canvas selection (the old "inverted
    // rect" shortcut made the ants show the whole canvas and the mask get lost
    // on the next rebuild)
    sel = { type: 'mask', mask: cv, feather: 0 };
    buildSelMask();
    startAnts();
    compositeDisplay();
  }

  function growShrinkSel(dir) {
    if (!selMaskCv) return;
    var r = Math.max(1, selFeatherVal() || 8);
    var cv = document.createElement('canvas');
    cv.width = workW; cv.height = workH;
    var g = cv.getContext('2d');
    g.filter = 'blur(' + r + 'px)';
    g.drawImage(selMaskCv, 0, 0);
    var src = g.getImageData(0, 0, workW, workH);
    var d = src.data;
    var thr = dir > 0 ? 96 : 200;
    for (var i = 3; i < d.length; i += 4) d[i] = d[i] > thr ? 255 : 0;
    g.putImageData(src, 0, 0);
    sel = { type: 'mask', mask: cv, feather: 0 };
    buildSelMask();
    startAnts();
    compositeDisplay();
  }

  function deleteSelection() {
    if (!selMaskCv) return;
    pushUndo();
    var ctx = activeLayer.canvas.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(selMaskCv, 0, 0);
    ctx.restore();
    compositeDisplay();
  }

  // ---- move tool ------------------------------------------------------------

  // Draw an ImageData snapshot onto a fresh full-size canvas (for blitting).
  function snapshotToCanvas(snap) {
    var cv = document.createElement('canvas');
    cv.width = snap.width; cv.height = snap.height;
    cv.getContext('2d').putImageData(snap, 0, 0);
    return cv;
  }

  function moveDown(p) {
    // With a live selection the move tool moves the SELECTED content (Krita
    // behaviour): the layer itself stays put. Alt+drag duplicates.
    if (selMaskCv && selHit(p)) { beginSelMove(p, !!evShift); return; }
    pushUndo();
    toolDrag = {
      mode: 'move', sx: p.x, sy: p.y, dx: 0, dy: 0,
      snapshot: activeLayer.canvas.getContext('2d').getImageData(0, 0, workW, workH),
      dup: !!(evShift)
    };
  }

  function moveMove(p) {
    // selection-content moves driven by the move tool go through the same
    // engine as select-tool moves
    if (selDrag && selDrag.mode === 'move') { selMove(p); return; }
    if (!toolDrag) return;
    toolDrag.dx = p.x - toolDrag.sx;
    toolDrag.dy = p.y - toolDrag.sy;
    var ctx = activeLayer.canvas.getContext('2d');
    var src = snapshotToCanvas(toolDrag.snapshot);
    // Move: the original is gone, content only appears at the offset.
    // Duplicate (Alt-drag): the original stays at 0,0 and a copy is added.
    ctx.clearRect(0, 0, workW, workH);
    if (toolDrag.dup) ctx.drawImage(src, 0, 0);
    ctx.drawImage(src, toolDrag.dx, toolDrag.dy);
    compositeDisplay();
  }

  function moveUp() {
    if (selDrag && selDrag.mode === 'move') { selUp(); return; }
    toolDrag = null;
    compositeDisplay();
  }

  // ---- fill tool ------------------------------------------------------------

  function fillDown(p) {
    if (!activeLayer) return;
    pushUndo();
    var ctx = activeLayer.canvas.getContext('2d');
    var tol = +(byId('paintFillTol') ? byId('paintFillTol').value : 8);
    var contig = !byId('paintFillContiguous') || byId('paintFillContiguous').checked;
    // An active selection always limits the fill (Krita bucket-fill behaviour);
    // the checkbox is an explicit opt-out.
    var limitEl = byId('paintFillUseSel');
    var useSel = !!(selMaskCv && (limitEl ? limitEl.checked : true));
    floodFill(ctx, p.x, p.y, tol, contig, useSel);
    compositeDisplay();
  }

  function floodFill(ctx, sx, sy, tol, contig, useSel) {
    var w = workW, h = workH;
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    var x0 = Math.round(sx), y0 = Math.round(sy);
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return;
    var idx0 = (y0 * w + x0) * 4;
    var r0 = d[idx0], g0 = d[idx0 + 1], b0 = d[idx0 + 2], a0 = d[idx0 + 3];
    var c = hexToRgb(current.color);
    var outA = Math.round(current.opacity * 255);
    var tolSq = tol * tol * 3;
    // cache the selection mask once instead of a getImageData per pixel
    var mData = null;
    if (useSel && selMaskCv) mData = selMaskCv.getContext('2d').getImageData(0, 0, w, h).data;
    function inMask(pi) { return mData[pi * 4 + 3] > 32; }
    function match(i) {
      var dr = d[i] - r0, dg = d[i + 1] - g0, db = d[i + 2] - b0;
      return dr * dr + dg * dg + db * db <= tolSq;
    }
    function paint(pi) {
      var i = pi * 4;
      d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b; d[i + 3] = a0 > 0 ? Math.max(a0, outA) : outA;
    }
    if (contig) {
      var stack = [x0, y0];
      var seen = new Uint8Array(w * h);
      while (stack.length) {
        var y = stack.pop(), x = stack.pop();
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        var pi = y * w + x;
        if (seen[pi]) continue;
        seen[pi] = 1;
        if (useSel && !inMask(pi)) continue;
        if (!match(pi * 4)) continue;
        paint(pi);
        stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
      }
    } else {
      for (var p = 0; p < d.length; p += 4) {
        // only pixels inside the selection are candidates; the original layer
        // content everywhere else is left completely untouched
        if (useSel && mData && mData[p + 3] <= 32) continue;
        if (match(p)) paint(p / 4);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---- eyedrop tool ---------------------------------------------------------

  function eyedropDown(p) {
    if (!paintCanvas) return;
    var px = Math.round(p.x), py = Math.round(p.y);
    if (px < 0 || py < 0 || px >= workW || py >= workH) return;
    var d = paintCanvas.getContext('2d').getImageData(px, py, 1, 1).data;
    var hex = '#' + ((1 << 24) | (d[0] << 16) | (d[1] << 8) | d[2]).toString(16).slice(1);
    setPaintColor(hex);
    refreshTip();
    syncColorWheel(); // move the SV dot / hue marker to the picked colour
    toast('Picked ' + hex);
  }

  // ---- line / shape tools ---------------------------------------------------

  function lineDown(p) {
    pushUndo();
    toolDrag = { mode: 'shape', preview: 'line', x0: p.x, y0: p.y, x1: p.x, y1: p.y,
      snapshot: activeLayer.canvas.getContext('2d').getImageData(0, 0, workW, workH) };
  }

  function lineMove(p) {
    if (!toolDrag) return;
    toolDrag.x1 = p.x; toolDrag.y1 = p.y;
    var ctx = activeLayer.canvas.getContext('2d');
    ctx.putImageData(toolDrag.snapshot, 0, 0);
    if (selMaskCv) {
      // masked preview: new segment drawn into a scratch of the restored layer,
      // then blitted clipped to the selection
      beginSelScratch();
      stampSegment({ x: toolDrag.x0, y: toolDrag.y0, press: 1 }, { x: p.x, y: p.y, press: 1 });
      commitSelScratch();
    } else {
      stampSegment({ x: toolDrag.x0, y: toolDrag.y0, press: 1 }, { x: p.x, y: p.y, press: 1 });
    }
    compositeDisplay();
  }

  function lineUp() {
    toolDrag = null;
    compositeDisplay();
  }

  function shapeDown(p) {
    pushUndo();
    toolDrag = {
      mode: 'shape', preview: 'shape', shape: paintTool === 'rect' ? 'rect' : 'ellipse',
      sx: p.x, sy: p.y, x: p.x, y: p.y, w: 0, h: 0,
      snapshot: activeLayer.canvas.getContext('2d').getImageData(0, 0, workW, workH)
    };
  }

  function shapeMove(p) {
    if (!toolDrag) return;
    var x0 = toolDrag.sx, y0 = toolDrag.sy;
    var w = p.x - x0, h = p.y - y0;
    if (evShift || (byId('paintShapeSquare') && byId('paintShapeSquare').checked)) {
      var s = Math.max(Math.abs(w), Math.abs(h));
      w = (w < 0 ? -1 : 1) * s; h = (h < 0 ? -1 : 1) * s;
    }
    toolDrag.x = Math.min(x0, x0 + w); toolDrag.y = Math.min(y0, y0 + h);
    toolDrag.w = Math.abs(w); toolDrag.h = Math.abs(h);
    var ctx = activeLayer.canvas.getContext('2d');
    ctx.putImageData(toolDrag.snapshot, 0, 0);
    var fill = !!(byId('paintShapeFill') && byId('paintShapeFill').checked);
    if (selMaskCv) {
      // masked preview: draw the shape into a scratch of the restored layer,
      // then blit it clipped to the selection
      beginSelScratch();
      drawShape(selScratchCtx, toolDrag.x, toolDrag.y, toolDrag.w, toolDrag.h, fill);
      commitSelScratch();
    } else {
      drawShape(ctx, toolDrag.x, toolDrag.y, toolDrag.w, toolDrag.h, fill);
    }
    compositeDisplay();
  }

  function shapeUp() {
    toolDrag = null;
    compositeDisplay();
  }

  function drawShape(ctx, x, y, w, h, fill) {
    var shape = toolDrag ? toolDrag.shape : 'rect';
    var cx = x + w / 2, cy = y + h / 2;
    if (fill) {
      // brush-textured fill: stamp dabs in a grid over the shape
      var step = Math.max(1, dabStep(current.radius) * 0.7);
      var n = Math.ceil(current.radius / 2);
      var g = document.createElement('canvas');
      g.width = workW; g.height = workH;
      var gc = g.getContext('2d');
      var savedCtx = paintCtx;
      paintCtx = gc;
      for (var yy = y - n; yy <= y + h + n; yy += step) {
        for (var xx = x - n; xx <= x + w + n; xx += step) {
          if (shape === 'rect') {
            if (xx < x - n || xx > x + w + n || yy < y - n || yy > y + h + n) continue;
          } else {
            var nx = (xx - cx) / (w / 2 + n), ny = (yy - cy) / (h / 2 + n);
            if (nx * nx + ny * ny > 1) continue;
          }
          stampDab(xx, yy, current.radius, current.opacity, null);
        }
      }
      paintCtx = savedCtx;
      ctx.drawImage(g, 0, 0);
    } else {
      // outline: stamp dabs along the perimeter
      var perimeter = 2 * (w + h);
      var n2 = Math.max(4, Math.ceil(perimeter / Math.max(1, dabStep(current.radius) * 0.5)));
      var g2 = document.createElement('canvas');
      g2.width = workW; g2.height = workH;
      var gc2 = g2.getContext('2d');
      var saved2 = paintCtx;
      paintCtx = gc2;
      for (var i = 0; i <= n2; i++) {
        var t = i / n2;
        var px2, py2;
        if (shape === 'rect') {
          var perimeter2 = 2 * (w + h);
          var d2 = t * perimeter2;
          if (d2 < w) { px2 = x + d2; py2 = y; }
          else if (d2 < w + h) { px2 = x + w; py2 = y + (d2 - w); }
          else if (d2 < 2 * w + h) { px2 = x + w - (d2 - w - h); py2 = y + h; }
          else { px2 = x; py2 = y + h - (d2 - 2 * w - h); }
        } else {
          px2 = cx + Math.cos(t * Math.PI * 2) * w / 2;
          py2 = cy + Math.sin(t * Math.PI * 2) * h / 2;
        }
        stampDab(px2, py2, current.radius, current.opacity, null);
      }
      paintCtx = saved2;
      ctx.drawImage(g2, 0, 0);
    }
  }

  // ---- crop tool ------------------------------------------------------------

  function cropDown(p) {
    cropRect = { x: p.x, y: p.y, w: 0, h: 0 };
    startAnts();
  }

  function cropMove(p) {
    if (!cropRect) return;
    var x0 = Math.min(cropRect.x, p.x), y0 = Math.min(cropRect.y, p.y);
    cropRect = { x: x0, y: y0, w: Math.abs(p.x - cropRect.x), h: Math.abs(p.y - cropRect.y) };
    renderOverlay();
  }

  function cropUp() {
    if (cropRect && (cropRect.w < 4 || cropRect.h < 4)) { cropRect = null; }
    renderOverlay();
  }

  function cancelCrop() {
    cropRect = null;
    if (antsTimer && !sel) stopAnts();
    renderOverlay();
  }

  function applyCrop() {
    if (!cropRect) return;
    var r = cropRect;
    if (r.w < 4 || r.h < 4) { cancelCrop(); return; }
    pushUndo();
    var nw = Math.max(8, Math.round(r.w / 8) * 8);
    var nh = Math.max(8, Math.round(r.h / 8) * 8);
    function cropCanvas2(cv) {
      var out = document.createElement('canvas');
      out.width = nw; out.height = nh;
      out.getContext('2d').drawImage(cv, r.x, r.y, nw, nh, 0, 0, nw, nh);
      return out;
    }
    if (paintBaseCanvas) paintBaseCanvas = cropCanvas2(paintBaseCanvas);
    paintLayers.forEach(function (l) { l.canvas = cropCanvas2(l.canvas); });
    activeLayer = paintLayers[paintLayers.length - 1];
    paintCtx = activeLayer.canvas.getContext('2d');
    resizeWork(nw, nh);
    cropRect = null;
    sel = null; selMaskCv = null;
    stopAnts();
    toast('Cropped to ' + nw + '×' + nh);
  }

  // ---- canvas resize / image ops -------------------------------------------

  // Change the working canvas size. nw/nh are snapped to the 8px grid by
  // applyWorkSize; existing pixels are preserved (letterboxed) unless scale is
  // given, in which case content is scaled into the new size.
  function resizeWork(nw, nh, scaleContent) {
    var ow = workW, oh = workH;
    state.aspect = 'custom';
    state.customW = nw; state.customH = nh;
    applyWorkSize();
    var w2 = workW, h2 = workH;
    // re-layout layer canvases
    var layers = paintLayers.map(function (l) {
      var cv = document.createElement('canvas');
      cv.width = w2; cv.height = h2;
      var g = cv.getContext('2d');
      if (scaleContent) g.drawImage(l.canvas, 0, 0, ow, oh, 0, 0, w2, h2);
      else g.drawImage(l.canvas, 0, 0);
      return Object.assign({}, l, { canvas: cv });
    });
    paintLayers = layers;
    if (activeLayer) activeLayer = paintLayers[paintLayers.indexOf(activeLayer)] || paintLayers[paintLayers.length - 1];
    if (!activeLayer && paintLayers.length) activeLayer = paintLayers[paintLayers.length - 1];
    paintCtx = activeLayer ? activeLayer.canvas.getContext('2d') : null;
    if (paintBaseCanvas) {
      var bc = document.createElement('canvas');
      bc.width = w2; bc.height = h2;
      var bg = bc.getContext('2d');
      if (scaleContent) bg.drawImage(paintBaseCanvas, 0, 0, ow, oh, 0, 0, w2, h2);
      else bg.drawImage(paintBaseCanvas, 0, 0);
      paintBaseCanvas = bc;
    }
    paintCanvas.width = w2; paintCanvas.height = h2;
    paintDispCtx = paintCanvas.getContext('2d');
    if (overlayCv) { overlayCv.width = w2; overlayCv.height = h2; overlayCtx = overlayCv.getContext('2d'); }
    sel = null; selMaskCv = null; cropRect = null; selDrag = null; xfrm = null;
    resetHistory(); // structural change: old snapshots reference detached canvases
    stopAnts();
    fitCanvas();
    rebuildLayerUI();
    compositeDisplay();
    refreshOnion();
  }

  function openResizeDialog() {
    var d = byId('paintResizeDialog');
    if (!d) return;
    var wI = byId('paintResizeW'), hI = byId('paintResizeH');
    if (wI) { wI.value = workW; setVal('paintResizeW', workW, workW + 'px'); }
    if (hI) { hI.value = workH; setVal('paintResizeH', workH, workH + 'px'); }
    d.classList.remove('hidden');
    if (wI) wI.focus();
  }

  function applyResizeDialog() {
    var wI = byId('paintResizeW'), hI = byId('paintResizeH');
    var nw = clamp(parseInt(wI ? wI.value : workW, 10) || workW, 8, 4096);
    var nh = clamp(parseInt(hI ? hI.value : workH, 10) || workH, 8, 4096);
    var keep = !!(byId('paintResizeKeep') && byId('paintResizeKeep').checked);
    if (keep) {
      var ratio = workW / workH;
      if (Math.abs(nw - workW) >= Math.abs(nh - workH)) nh = Math.round(nw / ratio);
      else nw = Math.round(nh * ratio);
    }
    var scaleContent = !!(byId('paintResizeScale') && byId('paintResizeScale').checked);
    resizeWork(nw, nh, scaleContent);
    var d = byId('paintResizeDialog');
    if (d) d.classList.add('hidden');
    toast('Resized to ' + workW + '×' + workH);
  }

  function flipCanvas(horizontal) {
    pushUndo();
    var layers = paintLayers.map(function (l) {
      var cv = document.createElement('canvas');
      cv.width = workW; cv.height = workH;
      var g = cv.getContext('2d');
      g.save();
      if (horizontal) g.scale(-1, 1), g.translate(-workW, 0);
      else g.scale(1, -1), g.translate(0, -workH);
      g.drawImage(l.canvas, 0, 0);
      g.restore();
      return Object.assign({}, l, { canvas: cv });
    });
    paintLayers = layers;
    activeLayer = paintLayers[paintLayers.length - 1];
    paintCtx = activeLayer.canvas.getContext('2d');
    if (paintBaseCanvas) {
      var bc = document.createElement('canvas');
      bc.width = workW; bc.height = workH;
      var bg = bc.getContext('2d');
      bg.save();
      if (horizontal) bg.scale(-1, 1), bg.translate(-workW, 0);
      else bg.scale(1, -1), bg.translate(0, -workH);
      bg.drawImage(paintBaseCanvas, 0, 0);
      bg.restore();
      paintBaseCanvas = bc;
    }
    paintUndoStack = []; // layer canvases were replaced
    paintRedoStack = [];
    compositeDisplay();
    toast(horizontal ? 'Flipped horizontally' : 'Flipped vertically');
  }

  function rotateCanvas(cw) {
    pushUndo();
    var layers = paintLayers.map(function (l) {
      var cv = document.createElement('canvas');
      cv.width = cw ? workH : workW;
      cv.height = cw ? workW : workH;
      var g = cv.getContext('2d');
      g.save();
      g.translate(cv.width / 2, cv.height / 2);
      g.rotate((cw ? 1 : -1) * Math.PI / 2);
      g.drawImage(l.canvas, -workW / 2, -workH / 2);
      g.restore();
      return Object.assign({}, l, { canvas: cv });
    });
    paintLayers = layers;
    activeLayer = paintLayers[paintLayers.length - 1];
    paintCtx = activeLayer.canvas.getContext('2d');
    if (paintBaseCanvas) {
      var bc = document.createElement('canvas');
      bc.width = cw ? workH : workW;
      bc.height = cw ? workW : workH;
      var bg = bc.getContext('2d');
      bg.save();
      bg.translate(bc.width / 2, bc.height / 2);
      bg.rotate((cw ? 1 : -1) * Math.PI / 2);
      bg.drawImage(paintBaseCanvas, -workW / 2, -workH / 2);
      bg.restore();
      paintBaseCanvas = bc;
    }
    // rotate swaps work dims
    var nw = paintLayers.length ? paintLayers[0].canvas.width : workH;
    var nh = paintLayers.length ? paintLayers[0].canvas.height : workW;
    workW = nw; workH = nh;
    state.aspect = 'custom'; state.customW = nw; state.customH = nh;
    applyWorkSize();
    paintCanvas.width = workW; paintCanvas.height = workH;
    paintDispCtx = paintCanvas.getContext('2d');
    if (overlayCv) { overlayCv.width = workW; overlayCv.height = workH; overlayCtx = overlayCv.getContext('2d'); }
    sel = null; selMaskCv = null; cropRect = null;
    resetHistory(); // layer canvases were replaced
    stopAnts();
    fitCanvas();
    rebuildLayerUI();
    compositeDisplay();
    refreshOnion();
    toast('Canvas rotated');
  }

  // ---- free transform -------------------------------------------------------

  function xfrmBegin() {
    if (!activeLayer) return;
    pushUndo();
    // operate on the active layer (or selection content if a selection exists)
    var src = document.createElement('canvas');
    src.width = workW; src.height = workH;
    var sg = src.getContext('2d');
    sg.drawImage(activeLayer.canvas, 0, 0);
    if (selMaskCv) { sg.globalCompositeOperation = 'destination-in'; sg.drawImage(selMaskCv, 0, 0); }
    var bb = selBounds() || { x: 0, y: 0, w: workW, h: workH };
    xfrm = {
      src: src, mask: selMaskCv, bb: bb,
      x: bb.x, y: bb.y, w: bb.w, h: bb.h, rot: 0,
      dragging: null, dragStart: null,
      restoreData: activeLayer.canvas.getContext('2d').getImageData(0, 0, workW, workH)
    };
    renderOverlay();
  }

  function renderXfrm(g) {
    if (!xfrm) return;
    var f = xfrm;
    // bounding box
    g.save();
    g.translate(f.x + f.w / 2, f.y + f.h / 2);
    g.rotate(f.rot);
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 1;
    g.strokeRect(-f.w / 2, -f.h / 2, f.w, f.h);
    // corners + edge midpoints
    g.fillStyle = '#fff';
    [[-f.w / 2, -f.h / 2], [f.w / 2, -f.h / 2], [-f.w / 2, f.h / 2], [f.w / 2, f.h / 2]]
      .forEach(function (c) { g.fillRect(c[0] - 3, c[1] - 3, 6, 6); });
    g.fillStyle = 'rgba(255,255,255,0.7)';
    [[0, -f.h / 2], [0, f.h / 2], [-f.w / 2, 0], [f.w / 2, 0]]
      .forEach(function (c) { g.fillRect(c[0] - 2, c[1] - 2, 4, 4); });
    // rotate handle above the top-center
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(0, -f.h / 2 - 14, 3.5, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(0, -f.h / 2 - 10);
    g.lineTo(0, -f.h / 2 - 4);
    g.stroke();
    g.restore();
    // live preview of the transformed content
    if (f.dragging) {
      var tmp = document.createElement('canvas');
      tmp.width = workW; tmp.height = workH;
      var t = tmp.getContext('2d');
      t.save();
      t.translate(f.x + f.w / 2, f.y + f.h / 2);
      t.rotate(f.rot);
      t.drawImage(f.src, 0, 0, workW, workH, -f.w / 2, -f.h / 2, f.w, f.h);
      t.restore();
      overlayCtx.globalAlpha = 0.6;
      overlayCtx.drawImage(tmp, 0, 0);
      overlayCtx.globalAlpha = 1;
    }
  }

  function xfrmDown(p) {
    if (!xfrm) xfrmBegin();
    if (!xfrm) return;
    var f = xfrm;
    // Hit-test in the box's local frame (rotated back), then decide the mode:
    // corner/edge -> scale (anchored), inside -> move, outside -> rotate.
    var cx = f.x + f.w / 2, cy = f.y + f.h / 2;
    var dx = p.x - cx, dy = p.y - cy;
    var cosr = Math.cos(-f.rot), sinr = Math.sin(-f.rot);
    var lx = dx * cosr - dy * sinr, ly = dx * sinr + dy * cosr;
    var hw = f.w / 2, hh = f.h / 2;
    var onX = Math.abs(Math.abs(lx) - hw) < 10;
    var onY = Math.abs(Math.abs(ly) - hh) < 10;
    var inX = Math.abs(lx) < hw, inY = Math.abs(ly) < hh;
    var mode = 'rotate', handle = null;
    if (onX && onY) { mode = 'scale'; handle = { sx: lx >= 0 ? 1 : -1, sy: ly >= 0 ? 1 : -1 }; }
    else if (onX && inY) { mode = 'scale'; handle = { sx: lx >= 0 ? 1 : -1, sy: 0 }; }
    else if (onY && inX) { mode = 'scale'; handle = { sx: 0, sy: ly >= 0 ? 1 : -1 }; }
    else if (inX && inY) { mode = 'move'; }
    f.dragging = mode;
    f.handle = handle;
    f.dragStart = { x: p.x, y: p.y, x0: f.x, y0: f.y, cx: cx, cy: cy, w: f.w, h: f.h, rot: f.rot };
  }

  function xfrmMove(p) {
    if (!xfrm || !xfrm.dragging) return;
    var f = xfrm, ds = f.dragStart;
    var dx = p.x - ds.x, dy = p.y - ds.y;
    if (f.dragging === 'move') {
      f.x = ds.x0 + dx; f.y = ds.y0 + dy;
    } else if (f.dragging === 'rotate') {
      f.rot = Math.atan2(p.y - ds.cy, p.x - ds.cx) - Math.atan2(ds.y - ds.cy, ds.x - ds.cx);
    } else if (f.dragging === 'scale') {
      scaleXfrm(f, ds, p);
    }
    renderOverlay();
  }

  // Anchored, non-uniform scaling: the corner/edge being dragged keeps the
  // opposite corner/edge fixed, so the grabbed handle stays under the cursor
  // (Krita/Photoshop behaviour). Rotation is preserved.
  function scaleXfrm(f, ds, p) {
    var h = f.handle;
    if (!h) return;
    // pointer in the start box's local frame
    var cosr = Math.cos(-ds.rot), sinr = Math.sin(-ds.rot);
    var pdx = p.x - ds.cx, pdy = p.y - ds.cy;
    var plx = pdx * cosr - pdy * sinr;
    var ply = pdx * sinr + pdy * cosr;
    // anchor (opposite the handle) in the start box's local frame
    var ax = h.sx === 0 ? 0 : -h.sx * ds.w / 2;
    var ay = h.sy === 0 ? 0 : -h.sy * ds.h / 2;
    // new size: distance from the anchor to the pointer along the dragged axes
    var nw = ds.w, nh = ds.h;
    if (h.sx !== 0) nw = clamp((plx - ax) * h.sx, 2, workW * 8);
    if (h.sy !== 0) nh = clamp((ply - ay) * h.sy, 2, workH * 8);
    // keep the anchor fixed in world space
    var cosA = Math.cos(ds.rot), sinA = Math.sin(ds.rot);
    var awx = ds.cx + (ax * cosA - ay * sinA);
    var awy = ds.cy + (ax * sinA + ay * cosA);
    var nax = h.sx === 0 ? 0 : -h.sx * nw / 2;
    var nay = h.sy === 0 ? 0 : -h.sy * nh / 2;
    f.w = nw; f.h = nh;
    f.x = awx - (nax * cosA - nay * sinA) - nw / 2;
    f.y = awy - (nax * sinA + nay * cosA) - nh / 2;
  }

  function xfrmUp() {
    if (!xfrm) return;
    if (xfrm.dragging) commitXfrm();
    else { xfrm = null; compositeDisplay(); }
  }

  // Bake the transformed content into the layer.
  function commitXfrm() {
    var f = xfrm;
    if (!f) return;
    var ctx = activeLayer.canvas.getContext('2d');
    // clear the original selection area, then draw transformed content
    ctx.save();
    if (f.mask) { ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(f.mask, 0, 0); }
    else ctx.clearRect(0, 0, workW, workH);
    ctx.restore();
    ctx.save();
    ctx.translate(f.x + f.w / 2, f.y + f.h / 2);
    ctx.rotate(f.rot);
    ctx.drawImage(f.src, 0, 0, workW, workH, -f.w / 2, -f.h / 2, f.w, f.h);
    ctx.restore();
    xfrm = null;
    compositeDisplay();
  }

  function cancelXfrm() {
    if (xfrm) {
      // restore the pre-transform layer content
      if (activeLayer && xfrm.restoreData) activeLayer.canvas.getContext('2d').putImageData(xfrm.restoreData, 0, 0);
      xfrm = null;
      compositeDisplay();
    }
  }

  var evShift = false;

  // ---- wiring for extra tools ----------------------------------------------

  function wireExtraTools() {
    Object.keys(TOOL_BUTTONS).forEach(function (t) {
      var b = byId(TOOL_BUTTONS[t]);
      if (b) b.addEventListener('click', function () { setPaintTool(t); });
    });
    var m = byId('paintSelMode');
    if (m) m.addEventListener('change', function () { selMode = this.value; });
    var fe = byId('paintSelFeather');
    if (fe) fe.addEventListener('input', function () {
      setVal('paintSelFeather', this.value, this.value + 'px');
      if (sel) { sel.feather = +this.value; buildSelMask(); compositeDisplay(); }
    });
    var ft = byId('paintFillTol');
    if (ft) ft.addEventListener('input', function () { setVal('paintFillTol', this.value, this.value); });
    var wt = byId('paintWandTol');
    if (wt) wt.addEventListener('input', function () { setVal('paintWandTol', this.value, this.value); });
    var b1 = byId('btnPaintSelAll'); if (b1) b1.addEventListener('click', selectAll);
    var b2 = byId('btnPaintSelNone'); if (b2) b2.addEventListener('click', selectNone);
    var b3 = byId('btnPaintSelInvert'); if (b3) b3.addEventListener('click', invertSelection);
    var b4 = byId('btnPaintSelDelete'); if (b4) b4.addEventListener('click', deleteSelection);
    var b5 = byId('btnPaintSelGrow'); if (b5) b5.addEventListener('click', function () { growShrinkSel(1); });
    var b6 = byId('btnPaintSelShrink'); if (b6) b6.addEventListener('click', function () { growShrinkSel(-1); });
    var c1 = byId('btnPaintCropApply'); if (c1) c1.addEventListener('click', applyCrop);
    var c2 = byId('btnPaintCropCancel'); if (c2) c2.addEventListener('click', cancelCrop);
    // image menu
    var imgBtn = byId('btnPaintImageMenu'), imgMenu = byId('paintImageMenu');
    if (imgBtn && imgMenu) {
      imgBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        imgMenu.classList.toggle('hidden');
        if (!imgMenu.classList.contains('hidden')) clampMenuToViewport(imgMenu);
      });
      imgMenu.addEventListener('click', function (e) { e.stopPropagation(); });
      document.addEventListener('click', function () { imgMenu.classList.add('hidden'); });
    }
    var fh = byId('btnPaintFlipH'); if (fh) fh.addEventListener('click', function () { flipCanvas(true); });
    var fv = byId('btnPaintFlipV'); if (fv) fv.addEventListener('click', function () { flipCanvas(false); });
    var rc = byId('btnPaintRotCW'); if (rc) rc.addEventListener('click', function () { rotateCanvas(true); });
    var rcc = byId('btnPaintRotCCW'); if (rcc) rcc.addEventListener('click', function () { rotateCanvas(false); });
    var rs = byId('btnPaintResize'); if (rs) rs.addEventListener('click', openResizeDialog);
    var csz = byId('btnPaintCanvasSize'); if (csz) csz.addEventListener('click', openResizeDialog);
    var ra = byId('btnPaintResizeApply'); if (ra) ra.addEventListener('click', applyResizeDialog);
    var rcl = byId('btnPaintResizeCancel'); if (rcl) rcl.addEventListener('click', function () {
      var d = byId('paintResizeDialog'); if (d) d.classList.add('hidden');
    });
    // library naming dialog (Enter commits, Esc cancels)
    var nameOk = byId('btnPaintNameOk');
    if (nameOk) nameOk.addEventListener('click', submitNameDialog);
    var nameCancel = byId('btnPaintNameCancel');
    if (nameCancel) nameCancel.addEventListener('click', cancelNameDialog);
    var nameIn = byId('paintNameInput');
    if (nameIn) nameIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitNameDialog(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelNameDialog(); }
    });

    // canvas zoom / pan: wheel zooms toward the cursor, middle-drag (or
    // shift+drag on the brush) pans anywhere in the viewport — even outside the
    // canvas — and double-clicking empty space or the Fit button re-centers.
    var wrap = byId('paintCanvasWrap');
    if (wrap) {
      wrap.addEventListener('wheel', function (e) {
        e.preventDefault();
        var r = wrap.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      }, { passive: false });
      wrap.addEventListener('dblclick', function (e) {
        // only empty-space double-clicks fit; double-clicking the canvas draws
        if (e.target === wrap) fitView();
      });
      wrap.addEventListener('pointerdown', function (e) {
        if (e.button === 1 || (e.button === 0 && e.shiftKey && (paintTool === 'brush' || paintTool === 'eraser'))) {
          e.preventDefault();
          panning = true;
          panStart = { x: e.clientX, y: e.clientY, px: paintPanX, py: paintPanY };
          try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
        }
      });
      wrap.addEventListener('pointermove', function (e) {
        if (panning && panStart) {
          paintPanX = panStart.px + (e.clientX - panStart.x);
          paintPanY = panStart.py + (e.clientY - panStart.y);
          fitCanvas();
        }
      });
      var endPan = function () { panning = false; };
      wrap.addEventListener('pointerup', endPan);
      wrap.addEventListener('pointercancel', endPan);
    }
    // status-bar zoom controls (fit re-centers)
    var zi = byId('btnPaintZoomIn'), zo = byId('btnPaintZoomOut'), zf = byId('btnPaintFit');
    if (wrap) {
      var wrapCenter = function () {
        var r = wrap.getBoundingClientRect();
        return { x: r.width / 2, y: r.height / 2 };
      };
      if (zi) zi.addEventListener('click', function () { var c = wrapCenter(); zoomAt(c.x, c.y, 1.25); });
      if (zo) zo.addEventListener('click', function () { var c = wrapCenter(); zoomAt(c.x, c.y, 1 / 1.25); });
    }
    if (zf) zf.addEventListener('click', fitView);
    // keyboard: tool shortcuts + selection/crop keys
    document.addEventListener('keydown', function (e) {
      if (!paintOpen) return;
      evShift = !!e.shiftKey;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      var mod = e.ctrlKey || e.metaKey;
      var k = e.key.toLowerCase();
      if (e.key === 'Escape') {
        if (cropRect) { cancelCrop(); e.preventDefault(); return; }
        if (xfrm) { cancelXfrm(); e.preventDefault(); return; }
        if (sel) { selectNone(); e.preventDefault(); return; }
        closePaint();
        return;
      }
      if (mod && k === 'd') { e.preventDefault(); selectNone(); return; }
      if (mod && k === 'a') { e.preventDefault(); selectAll(); return; }
      if (mod && e.shiftKey && k === 'i') { e.preventDefault(); invertSelection(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (sel || selMaskCv)) { e.preventDefault(); deleteSelection(); return; }
      if (e.key === 'Enter') {
        if (cropRect) { applyCrop(); e.preventDefault(); return; }
        if (xfrm) { commitXfrm(); e.preventDefault(); return; }
      }
      if (mod) return;
      if (k === 'b') setPaintTool('brush');
      else if (k === 'e') setPaintTool('eraser');
      else if (k === 's') setPaintTool('select');
      else if (k === 'l') setPaintTool('lasso');
      else if (k === 'w') setPaintTool('wand');
      else if (k === 'v') setPaintTool('move');
      else if (k === 't') setPaintTool('transform');
      else if (k === 'g') setPaintTool('fill');
      else if (k === 'i') setPaintTool('eyedrop');
      else if (k === 'c') setPaintTool('crop');
      else if (k === 'u') setPaintTool('rect');
    });
    document.addEventListener('keyup', function () { evShift = false; });
  }

  // ---- wand select tool -----------------------------------------------------

  // Magic-wand: select the contiguous (or every) pixel matching the clicked
  // whose RGBA matches the clicked pixel within tolerance, like Krita's Wand.
  // The result is a pixel-mask selection ({type:'mask'}), so feather, invert,
  // grow/shrink, masked painting and move all keep working on it.
  function wandDown(p) {
    // Sample the COMPOSITE (what the user sees, like Photoshop / Krita's
    // composite mode): selecting against only the active layer made the wand
    // pick the whole canvas whenever the art lived on another layer or the
    // base image.
    var src = paintDispCtx ? paintCanvas : null;
    if (!src) return;
    var tolEl = byId('paintWandTol');
    var tol = +(tolEl ? tolEl.value : 8);
    var contigEl = byId('paintWandContiguous');
    var contig = !contigEl || contigEl.checked;
    var w = workW, h = workH;
    var img = src.getContext('2d').getImageData(0, 0, w, h);
    var d = img.data;
    var x0 = Math.round(p.x), y0 = Math.round(p.y);
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return;
    var idx0 = (y0 * w + x0) * 4;
    var r0 = d[idx0], g0 = d[idx0 + 1], b0 = d[idx0 + 2], a0 = d[idx0 + 3];
    var tolSq = tol * tol * 4; // RGB + alpha all count towards the distance
    var mask = document.createElement('canvas');
    mask.width = w; mask.height = h;
    var mg = mask.getContext('2d');
    var mImg = mg.createImageData(w, h);
    var md = mImg.data;
    var minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    function mark(pi, xx, yy) {
      md[pi * 4 + 3] = 255;
      if (xx < minX) minX = xx; if (xx > maxX) maxX = xx;
      if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
    }
    function matchIdx(i) {
      var dr = d[i] - r0, dg = d[i + 1] - g0, db = d[i + 2] - b0, da = d[i + 3] - a0;
      return dr * dr + dg * dg + db * db + da * da <= tolSq;
    }
    if (contig) {
      var stack = [x0, y0];
      var seen = new Uint8Array(w * h);
      while (stack.length) {
        var yy = stack.pop(), xx = stack.pop();
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        var pi = yy * w + xx;
        if (seen[pi]) continue;
        seen[pi] = 1;
        if (!matchIdx(pi * 4)) continue;
        mark(pi, xx, yy);
        stack.push(xx + 1, yy, xx - 1, yy, xx, yy + 1, xx, yy - 1);
      }
    } else {
      for (var i = 0; i < d.length; i += 4) if (matchIdx(i)) mark(i / 4, (i / 4) % w, Math.floor(i / 4 / w));
    }
    mg.putImageData(mImg, 0, 0);
    // clicking transparent emptiness selects the (empty) region around art -
    // that is the whole transparent canvas, so a click on nothing is nothing
    if (maxX < 0) { sel = null; selMaskCv = null; compositeDisplay(); return; }
    var hint = (minX === Infinity) ? null : { x: minX - 1, y: minY - 1, w: maxX - minX + 3, h: maxY - minY + 3 };
    sel = { type: 'mask', mask: mask, feather: selFeatherVal(), maskHint: hint };
    buildSelMask();
    startAnts();
    compositeDisplay();
  }

  // Tool handlers dispatched from the shared pointer handlers above.
  var toolHandlers = {
    select:    { down: selDown,    move: selMove,    up: selUp },
    lasso:     { down: selDown,    move: selMove,    up: selUp },
    wand:      { down: wandDown },
    move:      { down: moveDown,   move: moveMove,   up: moveUp },
    transform: { down: xfrmDown,   move: xfrmMove,   up: xfrmUp },
    fill:      { down: fillDown },
    eyedrop:   { down: eyedropDown },
    line:      { down: lineDown,   move: lineMove,   up: lineUp },
    rect:      { down: shapeDown,  move: shapeMove,  up: shapeUp },
    ellipse:   { down: shapeDown,  move: shapeMove,  up: shapeUp },
    crop:      { down: cropDown,   move: cropMove,   up: cropUp }
  };
