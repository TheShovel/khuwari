// Paint: brush presets, the dab/stamping engine and MyPaint dynamics.
'use strict';
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
  function mypaintStep(dist, dt, ratio, angle, dx, dy, actualR) {
    var mp = current.mypaint || {};
    var dpa = mp.dabsPerActual || 0, dpb = mp.dabsPerBasic || 0;
    var dps = mp.dabsPerSecond || 0;
    // count_dabs_to spaces by the pressure-mapped ACTUAL radius (libmypaint
    // reads state->actual_radius here), so light-pressure dabs get placed
    // denser instead of breaking into dots at the preset's base spacing.
    var r = Math.max(0.05, actualR || current.radius);
    var br = (mp.baseRadius > 0) ? mp.baseRadius : current.radius;
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

  // Radius a MyPaint brush actually paints at for the inputs at the midpoint
  // of a segment - used to space dabs by the pressure-scaled size.
  function mypaintSegRadius(sm) {
    var brush = current;
    if (!brush.mySettings) return current.radius;
    var rl = mySetting(brush, 'radius_logarithmic', sm);
    if (!isFinite(rl)) return current.radius;
    var rlBase = 0;
    var rls = brush.mySettings.radius_logarithmic;
    if (rls && isFinite(+rls.base_value)) rlBase = +rls.base_value;
    var centerLog = Math.log(Math.max(0.2, current.radius));
    return clamp(Math.exp(rl - rlBase + centerLog), 0.2, 1000);
  }

  // Radius a Krita pixel brush paints at for the given pressure (its Size
  // option curve), used to space dabs so light-pressure strokes stay
  // continuous. With no size dynamics the preset radius spacing is unchanged.
  function spacingRadiusKpp(press) {
    var k = current.kpp;
    if (!k || !k.used || !k.used.size) return current.radius;
    var sc = kppEval(k.sizeCurve, press, 0.5);
    if (!isFinite(sc)) return current.radius;
    return Math.max(0.2, current.radius * sc);
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

  function defaultBrush() {
    for (var i = 0; i < brushList.length; i++) {
      if (brushList[i].name === 'b)_Basic-5_Size') return brushList[i];
    }
    return brushList[0];
  }

  // tip rendering

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

  // stamping
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
    if (isFinite(oc)) {
      op = current.opacity * oc;
      // Light-pressure floor: below the pressure where the Opacity curve
      // becomes visible, keep a faint mark instead of painting nothing (the
      // textured WaterC set is blank under ~15% pressure without it).
      if (k.opacityGate > 0 && press < k.opacityGate) {
        op = Math.max(op, k.opacityFloor || 0.15);
      }
    }
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

  // MyPaint dynamics engine
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

    // opaque = clamp(max(0, opaque) * opaque_multiply, 0, 1)
    var opaque = mySetting(brush, 'opaque', inputs);
    if (!isFinite(opaque)) opaque = 0;
    var opm = mySetting(brush, 'opaque_multiply', inputs);
    if (!isFinite(opm)) opm = 1;
    var opacity = clamp(Math.max(0, opaque) * opm, 0, 1);
    // opaque_linearize: per-dab alpha compensation for dense stamping
    var ol = mySetting(brush, 'opaque_linearize', inputs);
    if (isFinite(ol) && ol > 0) {
      var dpp = (mp.dabsPerActual + mp.dabsPerBasic) * 2;
      if (dpp < 1) dpp = 1;
      var lin = 1 + ol * (dpp - 1);
      opacity = 1 - Math.pow(Math.max(0, 1 - opacity), 1 / lin);
    }
    // Some presets' opaque_multiply pressure curve zeroes the opacity below a
    // pressure threshold (the sketch pencils are invisible under ~40% pressure) -
    // a tablet's natural light press would paint nothing at all. Below the gate
    // give them a faint, still-visible floor; above it (full-pressure strokes)
    // the behaviour is exactly the preset's.
    if (mp.pressureGate > 0 && inputs.pressure < mp.pressureGate) {
      opacity = Math.max(opacity, mp.opacityFloor || 0.12);
    }

    // radius_logarithmic (with pressure/speed/etc curves) -> radius.
    // ACTUAL_RADIUS = exp(SETTING(radius_logarithmic)). Resizing the brush
    // (Krita setPaintOpSize -> base = ln(size/2)) shifts the whole curve, so
    // shift by the user's current.radius relative to the preset base.
    var rl = mySetting(brush, 'radius_logarithmic', inputs); // may be NaN
    var radius = Math.max(0.05, r);
    if (isFinite(rl)) radius = clamp(Math.exp(rl - rlBase + centerLog), 0.2, 1000);

    // position: offset_by_speed, then random
    // (libmypaint's slow_tracking_per_dab position lag is intentionally NOT
    // applied: the app's own stabilizer + per-frame segment stream already
    // smooths pointer positions, and stacking the per-dab chase on top made
    // fast strokes trail dozens of pixels off the line.)
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

    // radius_by_random: radius_log = SETTING(radius_log) + gauss*value,
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

    // user opacity (toolbar slider): scale the faithful dab alpha. The
    // slider drives brush.opacity; the preset's designed opacity is the
    // nominalOpacity, so opacity * (brush.opacity / nominalOpacity) paints the
    // faithful look at the default slider position and changes with the slider.
    var nomOpacity = (mp.nominalOpacity > 0) ? mp.nominalOpacity : 1;
    opacity = clamp(opacity * (brush.opacity / nomOpacity), 0, 1);

    // hardness (curve-evaluated) + anti-aliasing edge
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

    // elliptical dab shape (markers / wet brushes)
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

    // colour: brush colour dynamics (color_h/s/v) + smudge (wet brushes)
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
            // During a masked stroke the scratch holds only the new dabs, so
            // sample the real layer instead - smudge must pick up the paint
            // that is already on the canvas inside the selection.
            var sctx = (selScratchCv && selScratchLayer) ? selScratchLayer.canvas.getContext('2d') : paintCtx;
            var sdata = sctx.getImageData(gx - rr, gy - rr, rr * 2 + 1, rr * 2 + 1).data;
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
