'use strict';

  // Built-in paint tool: paints onto the canvas at the project's working
  // resolution, then drops the result into the asset library and/or as a
  // keyframe, so painted art flows through the same timeline / ML path as
  // imported images. Non-pixel Krita engines fall back to the bitmap stamp.

  var paintOpen = false;
  var editKeyframeId = null;        // when repainting an existing keyframe
  var editAsset = null;             // when editing a library asset (paint-made)
  var paintCanvas = null, paintCtx = null;
  var brushList = [];
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
  var tipCanvas = null;             // 256px
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

  // extra tool state
  var paintTool = 'brush';     // brush|eraser|select|lasso|wand|move|transform|fill|eyedrop|line|rect|ellipse|crop
  var sel = null;              // {type:'rect'|'ellipse'|'lasso'|'mask', x,y,w,h, path:[], mask, feather}
  var selMaskCv = null;        // canvas whose alpha is the selection (feathered)
  var selDrag = null;          // {mode:'draw'|'move', sx,sy, dx,dy, snapshot, contentCv, dup}
  var selScratchCv = null;     // masked-stroke scratch: copy of the active layer that brush/
  var selScratchCtx = null;    // eraser/line/shape dabs draw into while a selection exists
  var selScratchLayer = null;  // the layer the scratch was taken from
  var selScratchOrig = null;   // pre-stroke layer copy (eraser strokes only): pins the erased spots
  var cropRect = null;         // {x,y,w,h} in work coords
  var xfrm = null;             // free-transform state
  var toolDrag = null;         // generic drag state for shape/move tools
  var overlayCv = null, overlayCtx = null;
  var antsTimer = 0, antsOffset = 0;
  var fillCtx = null;          // cached context for fill ops
  var paintZoom = 1, paintPanX = 0, paintPanY = 0;
  var panning = false, panStart = null;             // space/middle-drag pan

  // Persisted UI prefs: resizable panel widths + collapsible dockers.
  // (Docker collapse state now uses the shared global key in util.js.)
  var PAINT_LEFT_W_KEY = 'khuwari-paint-left-w';
  var PAINT_RIGHT_W_KEY = 'khuwari-paint-right-w';
  var PAINT_LEFT_W_DEFAULT = 190, PAINT_LEFT_W_MIN = 120, PAINT_LEFT_W_MAX = 330;
  var PAINT_RIGHT_W_DEFAULT = 250, PAINT_RIGHT_W_MIN = 170, PAINT_RIGHT_W_MAX = 420;
  // The paint tool now spans several files loaded in order before this one:
  //   src/paint-color.js    - colour math + HSV colour wheel + swatches
  //   src/paint-brushes.js  - brush model, dab/stamping engine, MyPaint dynamics
  //   src/paint-parsers.js  - .kpp / .myb / .gbr / .gih / PNG / ZIP parsing + loading
  //   src/paint-layers.js   - paint layers, compositing, onion skin
  //   src/paint-filters.js  - non-destructive layer filters (blur, color, shadow)
  //   src/paint-tools.js    - selection, masked painting, move/fill/shapes/crop/transform
  // This file holds the shared paint state, stroke loop, brush-list UI,
  // save-to-library flow, viewport zoom, open/close and the main wiring.
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

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
      // Evaluate the elliptical ratio/angle AND the pressure-mapped radius at
      // the segment midpoint (the dab engine evaluates them per-dab; a
      // segment-level value is a close approx for the short stabilizer
      // segments). Spacing by the pressure-scaled radius keeps light-pressure
      // strokes continuous.
      var segRatio = 1, segAng = NaN, segR = current.radius;
      if (current.mySettings) {
        var sm = dabInputs(from, to, 0.5);
        segR = mypaintSegRadius(sm);
        var ser = mySetting(current, 'elliptical_dab_ratio', sm);
        if (isFinite(ser) && ser > 1) {
          segRatio = clamp(ser, 1, 40);
          var sea = mySetting(current, 'elliptical_dab_angle', sm);
          if (isFinite(sea)) segAng = sea * Math.PI / 180;
        }
      }
      step = mypaintStep(dist, segDt, segRatio, segAng, dx, dy, segR);
    } else {
      // Pressure-scaled spacing: the Size curve can shrink the dab far below
      // the preset radius, and spacing must follow it or the stroke breaks
      // into dots between full-pressure dabs.
      var midPress = (from.press != null && to.press != null) ? (from.press + to.press) / 2 : (from.press != null ? from.press : 0.5);
      step = Math.max(0.5, 2 * spacingRadiusKpp(midPress) * current.spacing);
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
      var segRatio = 1, segAng = NaN, segR = current.radius;
      if (current.mySettings) {
        var sm = dabInputs({ x: dabLastPos.x, y: dabLastPos.y, press: pt.press }, pt, 0.5);
        segR = mypaintSegRadius(sm);
        var ser = mySetting(current, 'elliptical_dab_ratio', sm);
        if (isFinite(ser) && ser > 1) {
          segRatio = clamp(ser, 1, 40);
          var sea = mySetting(current, 'elliptical_dab_angle', sm);
          if (isFinite(sea)) segAng = sea * Math.PI / 180;
        }
      }
      step = mypaintStep(d, (pt.t != null && dabLastPos.t != null) ? Math.max(0, pt.t - dabLastPos.t) : 0, segRatio, segAng, dx, dy, segR);
    } else {
      step = Math.max(0.5, 2 * spacingRadiusKpp(pt.press) * current.spacing);
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

  // pointer handling

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
    rememberUsedColor();
    compositeDisplay();
    refreshLayerThumbs();
    try { paintCanvas.releasePointerCapture(ev.pointerId); } catch (e) {}
  }

  // per-stroke undo / redo

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

  // brush list UI

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
  // save / integrate

  function canvasToURL() { return paintCanvas.toDataURL('image/png'); }

  // Painted frames exported to the library default to the next frame number:
  // "frame<nr of timeline frames + 1>", so the paint-save-drag flow produces
  // frame1, frame2, frame3, ...
  function assetName() { return 'frame' + ((state.keyframes ? state.keyframes.length : 0) + 1); }

  function ensureAsset(url, layers) {
    if (!state.assets.some(function (a) { return a.img === url; })) {
      state.assets.push({ img: url, name: assetName(), w: workW, h: workH, paintLayers: layers });
    }
  }

  // library naming dialog

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
  // asks before inserting, suggesting the next frame number ("frame5", ...).
  // Cancelling just leaves the painting out of the library — it stays in the editor.
  function addNewLibraryAsset(url, layers) {
    if (state.assets.some(function (a) { return a.img === url; })) return; // unchanged paint already saved
    openNameDialog(assetName(), function (name) {
      if (!name) return;
      recordUndo();
      state.assets.push({ img: url, name: name, w: workW, h: workH, paintLayers: layers });
      renderAssets();
      paintBaselineURL = url;   // the drawing is now saved: no leave prompt
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
      // The canvas is now saved, so leaving the paint editor right after must
      // not raise the unsaved-changes prompt.
      paintBaselineURL = url;
      toast('Keyframe updated');
    } else if (editAsset) {
      commitLibraryAsset(editAsset);
    } else {
      addNewLibraryAsset(url, layers);
    }
  }

  // brush presets (persisted in the project + standalone .khuwari files)

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

  // open / close

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
    renderRecentColors(); // project + session paint colour history
    rebuildLayerUI();
    syncPaintOnionUI();
    syncPaintPlayheadUI();
    compositeDisplay();
    refreshOnion();
    // No async image is pending (blank canvas, no saved layers): the composite
    // right now is the baseline. Imaged assets set it in their own onload.
    if (!asyncLoad) { paintBaselineURL = canvasToURL(); paintReady = true; }
  }

  // leaving the paint editor
  // Closing reports unsaved changes and asks first (the Back button and Esc go
  // through this). Library-asset edits are excluded: closing those auto-commits
  // them (see closePaint), so nothing can be lost. A saved baseline (opened /
  // saved to the library / keyframe updated) means no prompt either.
  function requestClosePaint() {
    if (editAsset || !paintReady || canvasToURL() === paintBaselineURL) { closePaint(); return; }
    var d = byId('paintLeaveDialog');
    if (!d) { closePaint(); return; }
    d.classList.remove('hidden');
  }

  function confirmLeavePaint(leave) {
    var d = byId('paintLeaveDialog');
    if (d) d.classList.add('hidden');
    if (leave) closePaint();
  }

  function closePaint() {
    var ld = byId('paintLeaveDialog');
    if (ld) ld.classList.add('hidden');
    if (drawing) { drawing = false; if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
    stopAnts();
    sel = null; selMaskCv = null; selDrag = null;
    selScratchCv = null; selScratchCtx = null; selScratchLayer = null; selScratchOrig = null;
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

    byId('btnPaintClose').addEventListener('click', requestClosePaint);
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

    // color wheel (Krita-style SV square + hue slider)
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

    // layer filters (Krita-style non-destructive effects on the active layer):
    // the funnel button in the layer toolbar opens a menu of filter types.
    var fBtn = byId('btnPaintAddFilter'), fMenu = byId('paintFilterMenu');
    if (fBtn && fMenu) {
      PAINT_FILTER_ORDER.forEach(function (type) {
        var it = document.createElement('button');
        it.type = 'button';
        var sp = document.createElement('span');
        sp.textContent = filterDef(type).label;
        it.appendChild(sp);
        it.addEventListener('click', function () {
          fMenu.classList.add('hidden');
          addLayerFilter(type);
        });
        fMenu.appendChild(it);
      });
      fBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        fMenu.classList.toggle('hidden');
        if (fMenu.classList.contains('hidden')) return;
        var r = fBtn.getBoundingClientRect();
        fMenu.style.left = r.left + 'px';
        fMenu.style.top = (r.bottom + 6) + 'px';
        var mr = fMenu.getBoundingClientRect();
        if (mr.right > window.innerWidth - 6) fMenu.style.left = Math.max(6, r.right - mr.width) + 'px';
        if (mr.bottom > window.innerHeight - 6) fMenu.style.top = Math.max(6, window.innerHeight - mr.height - 6) + 'px';
      });
      document.addEventListener('click', function () { fMenu.classList.add('hidden'); });
    }
    rebuildFilterUI();

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
        // Esc first closes the open filter menu, then cancels an active
        // crop/transform/selection (handled in the extra-tools handler); if
        // none is active, it closes the tool. We let that handler run and only
        // close when nothing else consumed it.
        var fm = byId('paintFilterMenu');
        if (fm && !fm.classList.contains('hidden')) { fm.classList.add('hidden'); e.preventDefault(); return; }
        var ld2 = byId('paintLeaveDialog');
        if (ld2 && !ld2.classList.contains('hidden')) { confirmLeavePaint(false); e.preventDefault(); return; }
        if (cropRect || xfrm || sel) return; // let wireExtraTools handle it
        requestClosePaint();
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

    // collapsible dockers + resizable panels
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

    // extra tools wiring
    wireExtraTools();
  }
