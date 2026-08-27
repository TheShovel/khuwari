'use strict';


  // Camera: a non-destructive pan / zoom / rotation transform, plus lens and
  // film effects (fisheye, chromatic aberration, film grain, vignette, handheld
  // shake), applied to the final composite and to exported frames. Stored as
  // keyframes on the timeline and interpolated per frame. x/y are normalized
  // offsets (-1..1 of half the frame), zoom is a scale multiplier (1 = none),
  // rot is degrees, and each effect's intensity lives on the key's fx object.

  // The effect intensities animatable per camera key (each 0..1, 0 = off).
  var FX_FIELDS = ['fisheye', 'grain', 'chroma', 'vignette', 'shake'];

  function emptyFx() {
    return { fisheye: 0, grain: 0, chroma: 0, vignette: 0, shake: 0 };
  }

  // Read a key's fx config with defaults and a 0..1 clamp, so old projects and
  // hand-edited files that lack fx fields still render cleanly.
  function fxOf(k) {
    var fx = (k && k.fx && typeof k.fx === 'object') ? k.fx : {};
    var out = emptyFx();
    for (var i = 0; i < FX_FIELDS.length; i++) {
      var f = FX_FIELDS[i];
      var v = parseFloat(fx[f]);
      out[f] = isFinite(v) ? clamp(v, 0, 1) : 0;
    }
    // Shake speed is a modifier rather than a toggle: it only matters once the
    // shake intensity is above zero, and keys that never set it default to a
    // natural mid wobble instead of the slowest drift.
    var sp = parseFloat(fx.shakeSpeed);
    out.shakeSpeed = isFinite(sp) ? clamp(sp, 0, 1) : 0.5;
    return out;
  }

  function fxActive(fx) {
    if (!fx) return false;
    for (var i = 0; i < FX_FIELDS.length; i++) {
      if (fx[FX_FIELDS[i]] > 0) return true;
    }
    return false;
  }

  // Whether the camera (transform + effects) is in effect right now. It is
  // ignored while a color (fill) layer is selected: dots are placed and dragged
  // in world space, so a live camera would warp where they land. The keys stay
  // intact and the camera returns as soon as a normal layer is active again.
  function cameraActive() {
    var L = layerById(state.activeLayerId);
    return state.camera.enabled && (!L || L.type !== 'fill');
  }

  // True when a color layer is selected (drives the locked camera panel UI).
  function cameraLocked() {
    var L = layerById(state.activeLayerId);
    return !!L && L.type === 'fill';
  }

  function cameraAt(t) {
    var keys = state.camera.keys;
    if (!keys.length) return { x: 0, y: 0, zoom: 1, rot: 0, fx: emptyFx() };
    function hold(k) {
      return { x: k.x || 0, y: k.y || 0, zoom: (k.zoom == null ? 1 : k.zoom), rot: k.rot || 0, fx: fxOf(k) };
    }
    if (t <= keys[0].t) return hold(keys[0]);
    var last = keys[keys.length - 1];
    if (t >= last.t) return hold(last);
    for (var i = 0; i < keys.length - 1; i++) {
      var a = keys[i], b = keys[i + 1];
      if (t >= a.t && t <= b.t) {
        var f = (b.t - a.t) ? (t - a.t) / (b.t - a.t) : 0;
        var fa = fxOf(a), fb = fxOf(b);
        var fx = emptyFx();
        for (var j = 0; j < FX_FIELDS.length; j++) {
          var nm = FX_FIELDS[j];
          fx[nm] = fa[nm] + (fb[nm] - fa[nm]) * f;
        }
        fx.shakeSpeed = fa.shakeSpeed + (fb.shakeSpeed - fa.shakeSpeed) * f;
        return {
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f,
          zoom: a.zoom + (b.zoom - a.zoom) * f,
          rot: a.rot + (b.rot - a.rot) * f,
          fx: fx
        };
      }
    }
    return hold(last);
  }

  // Index of the exact (snapped) camera key at time t, or -1.
  function cameraKeyAt(t) {
    var st = state.snap ? Math.round(t * state.fps) / state.fps : t;
    for (var i = 0; i < state.camera.keys.length; i++) {
      if (Math.abs(state.camera.keys[i].t - st) < 1e-6) return i;
    }
    return -1;
  }

  function cameraSnappedTime() {
    var t = state.playhead;
    return state.snap ? Math.round(t * state.fps) / state.fps : t;
  }

  // Snapshot the camera transform onto the undo stack for one gesture.
  function cameraRecord() { recordUndo('camera'); }

  // Set one field of the camera key at the current (snapped) playhead, creating
  // a key there if none exists yet. `fx.<name>` writes an effect intensity onto
  // the key's fx object (clamped 0..1). Coalesced so dragging a slider makes a
  // single undo entry.
  function setCameraField(field, value) {
    cameraRecord();
    var t = Math.max(0, cameraSnappedTime());
    var idx = cameraKeyAt(t);
    var k;
    var created = false;
    if (idx >= 0) {
      k = state.camera.keys[idx];
    } else {
      k = { t: t, x: 0, y: 0, zoom: 1, rot: 0, fx: emptyFx() };
      state.camera.keys.push(k);
      state.camera.keys.sort(function (a, b) { return a.t - b.t; });
      created = true;
    }
    var fxp = field.indexOf('.');
    if (fxp >= 0) {
      var fxName = field.slice(fxp + 1);
      if (!k.fx || typeof k.fx !== 'object') k.fx = emptyFx();
      k.fx[fxName] = clamp(parseFloat(value) || 0, 0, 1);
    } else {
      k[field] = value;
    }
    if (state.camera.keys.length === 1) {
      // A single key marks the whole timeline; duplicate it at 0 if the playhead
      // isn't there so the static transform holds from the start.
      if (k.t > 0) {
        var k0 = { t: 0, x: k.x, y: k.y, zoom: k.zoom, rot: k.rot, fx: fxOf(k) };
        state.camera.keys.push(k0);
        state.camera.keys.sort(function (a, b) { return a.t - b.t; });
        created = true;
      }
    }
    renderPreview();
    renderCameraPanel();
    // A newly created key must show up on the timeline lane (camera row), which
    // is otherwise only rebuilt on full renders. Skip this on plain value edits
    // of an existing key, where the dot's position never changes.
    if (created && typeof renderTimeline === 'function') renderTimeline();
  }

  function addCameraKey() {
    cameraRecord();
    var t = Math.max(0, cameraSnappedTime());
    if (cameraKeyAt(t) >= 0) { toast('A camera key already exists here'); return; }
    var cam = cameraAt(t);
    state.camera.keys.push({ t: t, x: cam.x, y: cam.y, zoom: cam.zoom, rot: cam.rot, fx: cam.fx });
    state.camera.keys.sort(function (a, b) { return a.t - b.t; });
    renderAll();
    toast('Camera key added at ' + fmtTime(t));
  }

  function removeCameraKey(t) {
    var st = state.snap ? Math.round(t * state.fps) / state.fps : t;
    var idx = -1;
    for (var i = 0; i < state.camera.keys.length; i++) {
      if (Math.abs(state.camera.keys[i].t - st) < 1e-6) { idx = i; break; }
    }
    if (idx < 0) return;
    cameraRecord();
    state.camera.keys.splice(idx, 1);
    renderAll();
  }

  function renderCameraPanel() {
    var p = byId('cameraPanel');
    if (!p) return;
    var cam = cameraAt(state.playhead);
    if (el.cameraX) { el.cameraX.value = String(Math.round(cam.x * 1000) / 1000); syncSlider(el.cameraX); el.cameraXVal.textContent = Math.round(cam.x * 100) + '%'; }
    if (el.cameraY) { el.cameraY.value = String(Math.round(cam.y * 1000) / 1000); syncSlider(el.cameraY); el.cameraYVal.textContent = Math.round(cam.y * 100) + '%'; }
    if (el.cameraZoom) { el.cameraZoom.value = String(Math.round(cam.zoom * 1000) / 1000); syncSlider(el.cameraZoom); el.cameraZoomVal.textContent = Math.round(cam.zoom * 100) / 100 + 'x'; }
    if (el.cameraRot) { el.cameraRot.value = String(Math.round(cam.rot * 10) / 10); syncSlider(el.cameraRot); el.cameraRotVal.textContent = Math.round(cam.rot * 10) / 10 + '°'; }
    // Effects: the five intensity sliders mirror the interpolated fx at the
    // playhead, like the transform sliders above.
    var FX_META = {
      fisheye: ['cameraFxFisheye', 'cameraFxFisheyeVal'],
      grain: ['cameraFxGrain', 'cameraFxGrainVal'],
      chroma: ['cameraFxChroma', 'cameraFxChromaVal'],
      vignette: ['cameraFxVig', 'cameraFxVigVal'],
      shake: ['cameraFxShake', 'cameraFxShakeVal'],
      shakeSpeed: ['cameraFxShakeSpeed', 'cameraFxShakeSpeedVal']
    };
    for (var fn in FX_META) {
      var input = el[FX_META[fn][0]];
      if (input) {
        input.value = String(Math.round(cam.fx[fn] * 1000) / 1000);
        syncSlider(input);
        var vl = el[FX_META[fn][1]];
        if (vl) vl.textContent = Math.round(cam.fx[fn] * 100) + '%';
      }
    }
    // Add / Remove are mutually exclusive: Add shows when there is no camera key
    // at the playhead, Remove shows when one exists there.
    var hasKey = cameraKeyAt(state.playhead) >= 0;
    if (el.btnCameraAddKey) el.btnCameraAddKey.classList.toggle('hidden', hasKey);
    if (el.btnCameraRemoveKey) el.btnCameraRemoveKey.classList.toggle('hidden', !hasKey);
    // While a color layer is selected the camera is inactive (see cameraActive):
    // lock the controls so nothing edits invisibly, and say why.
    var locked = cameraLocked();
    if (p) p.classList.toggle('camera-off', locked);
    if (el.cameraFillNote) el.cameraFillNote.classList.toggle('hidden', !locked);
    if (p) {
      p.querySelectorAll('input').forEach(function (i) { i.disabled = locked; });
    }
    if (el.btnCameraAddKey) el.btnCameraAddKey.disabled = locked;
    if (el.btnCameraRemoveKey) el.btnCameraRemoveKey.disabled = locked;
  }

  // A read-only-ish timeline row showing camera keyframes (rendered by
  // renderLane). Click seeks, drag moves the key time, double-click removes.
  function renderCameraRow() {
    var z = state.zoom;
    var row = document.createElement('div');
    row.className = 'camera-row';
    var gutter = document.createElement('div');
    gutter.className = 'layer-gutter';
    gutter.textContent = 'Camera';
    gutter.title = 'Camera track: pan / zoom / rotation and effect keyframes';
    var content = document.createElement('div');
    content.className = 'layer-content';
    if (state.camera.keys.length) {
      state.camera.keys.forEach(function (k) {
        var chip = document.createElement('div');
        chip.className = 'cam-dot';
        chip.dataset.t = String(k.t);
        chip.style.left = (k.t * z) + 'px';
        chip.style.width = '10px';
        chip.title = 'Camera key at ' + fmtTime(k.t) + ' · drag to move · double-click to remove';
        chip.addEventListener('dblclick', function (e) { e.stopPropagation(); removeCameraKey(k.t); });
        content.appendChild(chip);
      });
    } else {
      var hint = document.createElement('div');
      hint.className = 'fill-hint';
      hint.textContent = 'No camera keys yet. Edit a value below or drag a slider to add one.';
      content.appendChild(hint);
    }
    row.appendChild(gutter);
    row.appendChild(content);
    el.lane.appendChild(row);
  }

  // Deterministic per-frame shake offsets (screen pixels). Seeded by the frame
  // index so the preview, filmstrip thumbs and exports all show the same jitter
  // for a given frame. The offset is a sum of slow, detuned sines - a handheld
  // wobble, not a random jump every frame - so a low intensity reads as a gentle
  // sway rather than a fast vibration. Amplitude is in screen space (like the
  // pan), independent of zoom; speed (0..1) picks the wobble frequency.
  function cameraShake(t, fx) {
    var amp = fx && fx.shake ? fx.shake * 6 : 0;
    if (!amp) return { x: 0, y: 0 };
    var speed = (fx && fx.shakeSpeed != null) ? clamp(fx.shakeSpeed, 0, 1) : 0.5;
    var fps = state.fps || 12;
    var n = Math.max(0, Math.round((t || 0) * fps));
    // Cycles per second: a slow drift at the low end up to an energetic wobble.
    // At 12 fps the fastest harmonic stays around 0.35 cycles/frame, so even the
    // top speed reads as smooth motion rather than a strobing jitter.
    var cps = 0.45 + speed * 1.35;
    var w = (cps / fps) * Math.PI * 2;
    var x = Math.sin(n * w) * 0.7 + Math.sin(n * w * 1.4 + 1.7) * 0.3;
    var y = Math.sin(n * w * 1.22 + 0.6) * 0.7 + Math.sin(n * w * 1.6 + 4.2) * 0.3;
    return { x: x * amp, y: y * amp * 0.8 };
  }

  // Bilinear sample of one channel (0-2) from a canvas ImageData, with edge
  // clamping. Used by the warped effects so fisheye and chromatic aberration
  // stay smooth instead of blocky.
  function bilinear(data, W, H, x, y, ch) {
    if (x < 0) x = 0; else if (x > W - 1) x = W - 1;
    if (y < 0) y = 0; else if (y > H - 1) y = H - 1;
    var x0 = x | 0, y0 = y | 0;
    var fx = x - x0, fy = y - y0;
    var x1 = x0 + 1, y1 = y0 + 1;
    if (x1 > W - 1) x1 = W - 1;
    if (y1 > H - 1) y1 = H - 1;
    var i00 = (y0 * W + x0) * 4 + ch, i10 = (y0 * W + x1) * 4 + ch;
    var i01 = (y1 * W + x0) * 4 + ch, i11 = (y1 * W + x1) * 4 + ch;
    var top = data[i00] + (data[i10] - data[i00]) * fx;
    var bot = data[i01] + (data[i11] - data[i01]) * fx;
    return top + (bot - top) * fy;
  }

  // Post-composite camera effects applied to the pixels already in `ctx` (the
  // just-drawn composite): fisheye (barrel warp), chromatic aberration, film
  // grain and vignette. One pass, in place. When only grain or vignette are
  // active it copies without warping (fast); the warped path only runs when
  // fisheye or chromatic aberration are on. Grain is seeded by the frame so a
  // frame always carries the same noise across previews and exports.
  function applyCameraFx(ctx, W, H, fx, t) {
    var fisheye = fx.fisheye, grain = fx.grain, chroma = fx.chroma, vig = fx.vignette;
    if (!fisheye && !grain && !chroma && !vig) return;
    var img = ctx.getImageData(0, 0, W, H);
    var src = img.data;
    var out = ctx.createImageData(W, H);
    var od = out.data;
    var cx = (W - 1) / 2, cy = (H - 1) / 2;
    var maxR = Math.sqrt(cx * cx + cy * cy) || 1;
    var warp = fisheye > 0 || chroma > 0;
    // Chromatic aberration is squared so the bottom of the slider stays subtle:
    // 10% barely shows, 50% is a noticeable rim, 100% is a strong split.
    var ca = chroma * chroma * 0.014 * maxR;   // max per-channel radial offset (px)
    var gAmt = grain * 42;            // max per-channel grain swing
    var vAmt = vig;                   // max vignette darkening (0 = none)
    // Seeded xorshift so the grain is deterministic per frame.
    var rnd = (((Math.max(0, Math.round((t || 0) * (state.fps || 12))) + 1) * 2654435761) >>> 0) || 1;

    for (var y = 0; y < H; y++) {
      var dy = (y - cy) / maxR;
      for (var x = 0; x < W; x++) {
        var dx = (x - cx) / maxR;
        var rn2 = dx * dx + dy * dy;
        var rn = warp || vig ? Math.sqrt(rn2) : 0;
        var idx = (y * W + x) * 4;
        if (warp) {
          // Fisheye barrel: pull the sampling radius outward (1 - k*r^2), so the
          // centre is magnified and edges bulge. Chromatic aberration samples red
          // slightly outward and blue slightly inward along the same radius.
          var inv = rn > 1e-4 ? 1 / rn : 0;
          var ux = dx * inv, uy = dy * inv;
          var rs = rn * (1 - fisheye * rn2);
          // ca is in pixels, so it must be converted back to the normalized
          // radius before being added, or the split saturates at the frame
          // edge once ca exceeds one whole radius (~50% on the slider).
          var cn = ca / maxR;
          var rR = Math.min(1, rs + cn), rB = Math.max(0, rs - cn), rG = rs;
          od[idx]     = bilinear(src, W, H, cx + ux * rR * maxR, cy + uy * rR * maxR, 0);
          od[idx + 1] = bilinear(src, W, H, cx + ux * rG * maxR, cy + uy * rG * maxR, 1);
          od[idx + 2] = bilinear(src, W, H, cx + ux * rB * maxR, cy + uy * rB * maxR, 2);
        } else {
          od[idx]     = src[idx];
          od[idx + 1] = src[idx + 1];
          od[idx + 2] = src[idx + 2];
        }
        if (vig > 0) {
          var v = 1 - vAmt * rn2;
          od[idx]     *= v;
          od[idx + 1] *= v;
          od[idx + 2] *= v;
        }
        if (grain > 0) {
          rnd ^= rnd << 13; rnd >>>= 0;
          rnd ^= rnd >>> 17; rnd >>>= 0;
          rnd ^= rnd << 5; rnd >>>= 0;
          var n = ((rnd & 255) / 127.5 - 1) * gAmt;
          od[idx]     = clamp(od[idx] + n, 0, 255);
          od[idx + 1] = clamp(od[idx + 1] + n, 0, 255);
          od[idx + 2] = clamp(od[idx + 2] + n, 0, 255);
        }
        od[idx + 3] = src[idx + 3];
      }
    }
    ctx.putImageData(out, 0, 0);
  }
