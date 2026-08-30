/* worker.js: background frame interpolation for Keyframe Studio, off the main
 * thread so generating inbetweens never freezes the UI. The main thread sends
 * two keyframe RGBA buffers + missing frame indices; we reply with each
 * finished frame's RGBA buffer (transferred, zero-copy) plus progress.
 * Falls back to the pure mesh morph per-frame if the model isn't ready or a
 * single inference fails, so generation never stalls. */
'use strict';

importScripts('morph.js', 'model.js');

// Cheap macrotask yield between frames so a cancel message can be processed
// (setTimeout(0) is clamped to ~1-4ms in Firefox workers; a MessageChannel
// post is ~0.2ms). Falls back to setTimeout where MessageChannel is missing.
var yieldToEventLoop = (typeof MessageChannel !== 'undefined')
  ? (function () {
      var mc = new MessageChannel();
      var queue = [];
      mc.port1.onmessage = function () {
        var fn = queue.shift();
        if (fn) fn();
      };
      return function () {
        return new Promise(function (r) { queue.push(r); mc.port2.postMessage(0); });
      };
    })()
  : function () { return new Promise(function (r) { setTimeout(r, 0); }); };

var morph = self.KHUWARI_MORPH;
var model = self.KHUWARI_MODEL;
var cancelled = false;
var upscaleCancelled = false;

self.onmessage = function (e) {
  var msg = e.data;
  if (msg.type === 'load-model') loadModel();
  else if (msg.type === 'generate-gap') generateGap(msg);
  else if (msg.type === 'cancel') cancelled = true;
  else if (msg.type === 'upscale') upscaleFrame(msg);
  else if (msg.type === 'cancel-upscale') upscaleCancelled = true;
};

function post(m, transfer) { self.postMessage(m, transfer); }

// Model loading (mirrors the main-thread overlay state machine)

function loadModel() {
  model.loadModel(function (info) {
    if (info && info.stage === 'model') post({ type: 'model-progress', stage: 'model', frac: info.frac });
    else if (info && info.stage === 'compile') post({ type: 'model-progress', stage: 'compile', frac: 1 });
  }).then(function () {
    post({ type: 'model-ready' });
  }).catch(function (err) {
    post({ type: 'model-error', message: err && err.message ? err.message : String(err) });
  });
}

// Encode a finished frame to a PNG data URL inside the worker (OffscreenCanvas),
// so the main thread never runs the (Firefox-slow) canvas.toDataURL per frame.
// Falls back to null when unsupported; the caller then ships the raw RGBA.
// Each encode SLOT owns one [canvas, ctx, imageData] triple, pooled across
// frames of the same size: the slot's previous encode has fully resolved
// before it is reused (the encode queue in generateGap guarantees it), so this
// is safe and avoids per-frame canvas/ImageData allocation (GC churn is a
// Firefox jank source).
function encodePNG(rgba, width, height, slot) {
  if (typeof OffscreenCanvas === 'undefined' || typeof FileReaderSync === 'undefined') return null;
  try {
    if (!slot.c) {
      slot.c = new OffscreenCanvas(width, height);
      slot.ctx = slot.c.getContext('2d');
      slot.img = slot.ctx.createImageData(width, height);
    }
    slot.img.data.set(rgba);
    slot.ctx.putImageData(slot.img, 0, 0);
    return slot.c.convertToBlob({ type: 'image/png' }).then(function (blob) {
      return new FileReaderSync().readAsDataURL(blob);
    });
  } catch (e) { return null; }
}

// Post a finished frame, encoding to a PNG data URL in the worker when
// possible. Any encode failure (unsupported codec, memory pressure) falls back
// to shipping the raw RGBA buffer, so generation never stalls on encoding.
function postFrame(jobId, frame, rgba, width, height, slot) {
  var enc = encodePNG(rgba, width, height, slot);
  if (!enc) {
    var buf = rgba.buffer;
    post({ type: 'frame', jobId: jobId, idx: frame.idx, t: frame.t, time: frame.time, ai: frame.ai, width: width, height: height, rgba: buf }, [buf]);
    return Promise.resolve();
  }
  return enc.then(function (dataUrl) {
    post({ type: 'frame', jobId: jobId, idx: frame.idx, t: frame.t, time: frame.time, ai: frame.ai, width: width, height: height, img: dataUrl });
  }, function () {
    var buf = rgba.buffer;
    post({ type: 'frame', jobId: jobId, idx: frame.idx, t: frame.t, time: frame.time, ai: frame.ai, width: width, height: height, rgba: buf }, [buf]);
  });
}

// Color layers are gone (flattened-composite interpolation), so the color
// pass / color frame worker messages were removed.

function generateGap(msg) {
  cancelled = false;
  var jobId = msg.jobId;
  var aData = new Uint8ClampedArray(msg.aData);   // original (real alpha)
  var bData = new Uint8ClampedArray(msg.bData);
  var width = msg.width, height = msg.height;
  var fromTime = msg.fromTime, toTime = msg.toTime;
  var mode = msg.mode || 'ai';
  var squash = msg.squash || null;
  var blur = msg.blur || null;
  var matteK = msg.matteK || null;
  var missing = msg.missing; // [{idx, t}]
  var blurOn = !!(blur && blur.on && blur.intensity > 0);
  var n = width * height;

  var meshes = null;
  var flowPromise = null;
  var isCancelled = function () { return cancelled; };
  // PNG encoding runs off the critical path: up to ENCODE_LIMIT frames encode
  // concurrently while the next inference runs (encodePNG copies the RGBA into
  // the slot's own ImageData synchronously, so the caller's buffer is safe to
  // reuse). emit() resolves when an encode SLOT frees, not when the encode
  // finishes, so the next frame's model call overlaps the previous frame's PNG
  // encode. Each slot owns its canvas (see encodePNG).
  var ENCODE_LIMIT = 3;
  var encodeSlots = [];
  var inflightPosts = [];
  for (var ei = 0; ei < ENCODE_LIMIT; ei++) {
    encodeSlots.push({ tail: Promise.resolve(), c: null, ctx: null, img: null });
  }
  function queuePost(jobId, frame, rgba, width, height) {
    var slot = encodeSlots.shift();
    var free = slot.tail; // resolves when this slot's previous encode finished
    var p = free.then(function () {
      if (cancelled) return;
      return postFrame(jobId, frame, rgba, width, height, slot);
    });
    slot.tail = p;
    encodeSlots.push(slot);
    inflightPosts.push(p);
    return free;
  }
  // Matte gaps: the model runs on the opaque matte input (aFlow/bFlow) so
  // transparent pixels never feed the model; the ORIGINAL buffers feed the alpha
  // warp. The OPTICAL FLOW runs on texture-extended originals (extendTexture):
  // thin line art on a uniform background starves block matching, and the flow
  // comes back ~0 → the morph crossfades into a double-exposed ghost. `opaque`
  // reflects the ORIGINAL keyframes: a matte gap still needs the alpha pass.
  // The main thread already computed this (its matte memo); pass it through so
  // the worker doesn't re-scan both buffers; tests that send raw messages get
  // the fallback scan.
  var opaque = msg.opaque !== undefined ? msg.opaque : (morph.isOpaque(aData) && morph.isOpaque(bData));
  var aFlow = matteK ? morph.encodeMatte(new Uint8ClampedArray(aData), n, matteK) : aData;
  var bFlow = matteK ? morph.encodeMatte(new Uint8ClampedArray(bData), n, matteK) : bData;
  // Model-driven opacity: run the model on the alpha channel as grayscale so
  // the silhouette interpolates with model-quality motion (fallback for the
  // mesh warp is still below).
  var aGray = matteK ? morph.alphaToGray(aData, width, height) : null;
  var bGray = matteK ? morph.alphaToGray(bData, width, height) : null;
  // Skip-the-model shortcuts for static gaps:
  //  - byte-identical keyframes: every inbetween IS the keyframe (0 model calls)
  //  - identical alpha masks: the interpolated alpha is the static mask, so the
  //    second (alpha) model pass is skipped and removeKey stamps it (the same
  //    math applyGrayAlphaRaw would do). Both are byte-equivalent to the model
  //    path (RIFE returns the input for identical inputs, and round() recovers
  //    the exact mask values).
  var framesIdentical = morph.buffersEqual(aData, bData);
  var staticAlpha = null;
  if (!framesIdentical && matteK && morph.sameAlpha(aData, bData, n)) {
    // removeKey takes a per-pixel alpha array (0..255), not an RGBA buffer.
    var sa = new Uint8Array(n);
    for (var p = 0, i = 3; p < n; p++, i += 4) sa[p] = aData[i];
    staticAlpha = sa;
  }
  // Textured, opaque flow inputs (extended originals) so large/thin motion is
  // tracked; the flow opts widen the coarsest search radius for big gaps.
  // Built lazily inside ensureMeshes: the ML path never needs the flow (the
  // model handles motion + alpha), and extendTexture is an expensive distance
  // transform; running it eagerly on every transparent gap is wasted work
  // when the flow never gets computed.
  var flowBg = null;
  var aFlowTex = null, bFlowTex = null;
  var flowOpts = { maxSearchR: 8 };
  var ensureMeshes = function () {
    if (meshes) return Promise.resolve();
    if (flowPromise) return flowPromise;
    if (!aFlowTex) {
      if (opaque) { aFlowTex = aData; bFlowTex = bData; }
      else {
        flowBg = morph.flowBgColor(aData, bData, n);
        aFlowTex = morph.extendTexture(aData, width, height, 10, flowBg);
        bFlowTex = morph.extendTexture(bData, width, height, 10, flowBg);
      }
    }
    post({ type: 'gap-progress', jobId: jobId, label: 'Preparing interpolation…', gapFrac: 0 });
    flowPromise = morph.computeFlowBoth(aFlowTex, bFlowTex, width, height, flowOpts, function (frac) {
      post({ type: 'gap-progress', jobId: jobId, label: 'Preparing interpolation…', gapFrac: frac * 0.05 });
    }, isCancelled).then(function (pair) {
      if (cancelled) return;
      meshes = morph.buildMeshes(pair, width, height, 16);
    });
    return flowPromise;
  };

  // Make sure the ML model is loaded before generating, so a worker that gets
  // a gap before its model finished downloading still ML-generates instead of
  // silently falling back to the mesh warp for the whole gap.
  var ensureModel = function () {
    if (model.isReady()) return Promise.resolve();
    post({ type: 'gap-progress', jobId: jobId, label: 'Loading ML model…', gapFrac: 0 });
    return model.loadModel(function (info) {
      if (info && info.stage === 'model') post({ type: 'model-progress', stage: 'model', frac: info.frac });
      else if (info && info.stage === 'compile') post({ type: 'model-progress', stage: 'compile', frac: 1 });
    }).catch(function (err) {
      // Model unavailable (offline etc.): the per-frame fallback below will use
      // the mesh warp, matching the old behaviour, so generation never stalls.
      console.error('ML model load failed in worker, using mesh warp:', err && err.message ? err.message : err);
    });
  };

  var first = function () {
    if (mode === 'ai') return ensureModel();
    return Promise.resolve();
  };

  // --- multi-pass (hierarchical) interpolation ---
  // RIFE degrades as the motion between its two inputs grows, so long gaps
  // (many inbetweens between two keyframes) are filled in two stages: first a
  // dyadic midpoint tree down to depth D (largest D with 2^D <= N+1) — every
  // model call there is a t=0.5 midpoint between frames 2^(D-j) apart, so the
  // per-call motion shrinks by half each level — then each requested frame is
  // rendered directly from its two grid neighbours. Every final model call
  // then sees at most ~2/(N+1) of the gap's motion instead of up to the whole
  // gap, at the cost of ~2^D extra renders. Speed is deliberately not the
  // priority here; emit(m) with msg.hier===false keeps the old single-pass
  // behaviour.
  var useHier = mode === 'ai' && missing.length >= 2 && msg.hier !== false && !framesIdentical;
  var hierDepth = 0;
  if (useHier) {
    var segs = missing.length + 1;
    while ((1 << (hierDepth + 1)) <= segs) hierDepth++;
  }
  var hierLevels = null;   // hierLevels[d][j] = { t: j/2^d, buf, gray }
  var hierBuilt = false;
  var hierChain = null;

  // Transparency for a rendered frame: union of the two flow-warped alpha
  // channels of the ORIGINAL keyframes (dense flow; the mesh dilutes thin
  // strokes), plus stripping the key tint from the RGB for matte gaps.
  // Takes the frame's gap position: hierarchical intermediates warp at their
  // own t, so each level sees the silhouette where it actually is.
  var applyAlphaAt = function (rgba, tG) {
    var alpha = morph.warpAlphaDense(aData, bData, meshes.flowAB, meshes.flowBA, width, height, tG);
    if (matteK) morph.removeKey(rgba, n, matteK, alpha);
    else {
      for (var p = 0, q = 0; p < n; p++, q += 4) rgba[q + 3] = alpha[p];
    }
  };

  // Pure render: the inbetween between two already-finalized buffers at the
  // LOCAL phase tLocal (model or mesh + alpha + matte, no blur, no post).
  // tGlobal is the frame's position inside the gap; the model's own inputs at
  // every level are premultiplied by alpha, so intermediates carry their real
  // alpha into the next level exactly like the keyframes do.
  var renderBetween = function (ab, bb, gA, gB, tLocal, tGlobal) {
    var meshFallback = function () {
      return ensureMeshes().then(function () {
        if (cancelled) return null;
        var frame = opaque
          ? morph.morphFrameMesh(aFlow, bFlow, meshes, width, height, tGlobal)
          // Thin line art: the coarse mesh averages strokes' motion to ~0
          // (ghosting). Render with the dense per-pixel morph instead.
          : morph.morphFrame(aFlow, bFlow, meshes.flowAB, meshes.flowBA, width, height, tGlobal);
        if (!opaque) applyAlphaAt(frame, tGlobal);
        return { rgba: frame, ai: false };
      });
    };
    // Duplicate keyframes: every inbetween IS the keyframe; ship a copy
    // (never transfer/mutate the shared original) and skip both model passes.
    if (framesIdentical) return Promise.resolve({ rgba: new Uint8ClampedArray(aData), ai: true });
    if (model.isReady()) {
      return model.interpolate(ab, bb, width, height, tLocal).then(function (aiOut) {
        if (cancelled) return null;
        if (opaque) return { rgba: aiOut, ai: true };
        // Static silhouette: the interpolated alpha is the keyframes' shared
        // mask; stamp it with removeKey (identical math to applyGrayAlphaRaw)
        // and skip the alpha model pass entirely.
        if (staticAlpha) {
          morph.removeKey(aiOut, n, matteK, staticAlpha);
          return { rgba: aiOut, ai: true };
        }
        var alphaFallback = function () {
          // Model alpha pass failed or no grays: mesh-union alpha warp of the
          // original keyframes at the frame's gap position.
          return ensureMeshes().then(function () {
            if (cancelled) return null;
            applyAlphaAt(aiOut, tGlobal);
            return { rgba: aiOut, ai: true };
          });
        };
        if (gA && gB) {
          // Model-driven alpha: interpolate the alpha channel as grayscale.
          // Output consumed raw (channel 0); no RGBA conversion needed.
          return model.interpolate(gA, gB, width, height, tLocal, true).then(function (alphaTensor) {
            if (cancelled) return null;
            morph.applyGrayAlphaRaw(aiOut, alphaTensor, n, matteK);
            return { rgba: aiOut, ai: true };
          }, alphaFallback);
        }
        return alphaFallback();
      }).catch(function (err) {
        if (cancelled) return null;
        console.error('ML inbetween failed, using mesh warp:', err);
        return meshFallback();
      });
    }
    return meshFallback();
  };

  // Build the dyadic midpoint tree (once per gap; every final frame renders
  // against it, and its own renders reuse the parent levels). Levels are built
  // strictly in order so the model never sees two overlapping jobs.
  var buildHier = function () {
    if (!useHier || hierBuilt) return Promise.resolve();
    if (hierChain) return hierChain;
    post({ type: 'gap-progress', jobId: jobId, label: 'High-pass inbetweens…', gapFrac: 0 });
    hierChain = Promise.resolve().then(function () {
      hierLevels = [[{ t: 0, buf: aFlow, gray: aGray }, { t: 1, buf: bFlow, gray: bGray }]];
      var chain = Promise.resolve();
      for (var d = 1; d <= hierDepth; d++) {
        (function (d) {
          chain = chain.then(function () {
            if (cancelled) return;
            var prevLevel = hierLevels[d - 1];
            var next = new Array((1 << d) + 1);
            var step = 1 / (1 << d);
            var j = 0;
            var build = function () {
              if (cancelled) return Promise.resolve();
              if (j > (1 << d)) {
                hierLevels[d] = next;
                return Promise.resolve();
              }
              if (j % 2 === 0) { next[j] = prevLevel[j >> 1]; j++; return build(); }
              var lo = prevLevel[(j - 1) >> 1], hi = prevLevel[(j + 1) >> 1];
              var gA = lo.gray, gB = hi.gray;
              // Grays describe the buffer's REAL alpha; precomputed once per
              // buffer so repeated renders reuse them.
              if (!gA && matteK) gA = morph.alphaToGray(lo.buf, width, height);
              if (!gB && matteK) gB = morph.alphaToGray(hi.buf, width, height);
              return renderBetween(lo.buf, hi.buf, gA, gB, 0.5, step * j).then(function (r) {
                if (cancelled || !r) return;
                next[j] = {
                  t: step * j,
                  buf: r.rgba,
                  gray: matteK ? morph.alphaToGray(r.rgba, width, height) : null
                };
                j++;
                return build();
              });
            };
            return build();
          });
        })(d);
      }
      return chain.then(function () { if (!cancelled) hierBuilt = true; });
    });
    return hierChain;
  };

  // A requested frame at t sits between its two dyadic grid neighbours; render
  // it from those directly (the grid itself guarantees the per-call motion
  // bound; the final call re-uses the exact single-pass render path).
  var hierSegment = function (t) {
    var M = 1 << hierDepth;
    var x = t * M;
    var i = x | 0;
    if (i > M - 1) i = M - 1;
    var lev = hierLevels[hierDepth];
    var lo = lev[i], hi = lev[i + 1];
    return { bufA: lo.buf, bufB: hi.buf, grayA: lo.gray, grayB: hi.gray, tLocal: x - i };
  };

  var emit = function (m) {
    if (cancelled) return Promise.resolve();
    var t = m.t;
    var time = fromTime + (toTime - fromTime) * t;
    var send = function (rgba, ai) {
      return queuePost(jobId, { idx: m.idx, t: t, time: time, ai: ai }, rgba, width, height);
    };
    // Motion blur needs the flow, so it forces the (lazily-computed) meshes
    // even for the opaque-ML path that would otherwise skip them entirely.
    var finish = function (rgba, ai) {
      if (!blurOn) return send(rgba, ai);
      return ensureMeshes().then(function () {
        if (cancelled) return;
        return send(morph.motionBlurFrame(rgba, meshes, width, height, t, blur.intensity), ai);
      });
    };
    if (mode === 'squash') {
      return ensureMeshes().then(function () {
        // Squash renders keyframe A's own pixels (deformed + translated), so
        // its alpha comes out of the transform itself — sample the ORIGINALS
        // (real alpha), not the matte-encoded buffers. Stamping the flow-warped
        // UNION alpha over it (the ML path's job) would turn keyframe B's
        // silhouette opaque over pixels that still show A's background — a
        // black/empty ghost of B on transparent gaps.
        var frame = morph.squashStretchFrame(aData, bData, meshes, width, height, t, squash);
        return finish(frame, false);
      });
    }
    var renderHere = function (ab, bb, gA, gB, tl) {
      return renderBetween(ab, bb, gA, gB, tl, t).then(function (r) {
        if (cancelled || !r) return;
        return finish(r.rgba, r.ai);
      });
    };
    if (useHier) {
      return buildHier().then(function () {
        if (cancelled) return;
        var seg = hierSegment(t);
        // On-grid frames ARE the rendered grid node (phase 0 would only
        // approximate it); pass it through with blur/motion post as usual.
        if (seg.tLocal === 0) return finish(seg.bufA, true);
        return renderHere(seg.bufA, seg.bufB, seg.grayA, seg.grayB, seg.tLocal);
      });
    }
    return renderHere(aFlow, bFlow, aGray, bGray, t);
  };

  var i = 0;
  var next = function () {
    if (cancelled || i >= missing.length) return Promise.resolve();
    var m = missing[i];
    var label = (mode === 'squash' ? 'squash frame ' : (model.isReady() ? 'ML inbetween ' : 'mesh warp ')) + (i + 1) + '/' + missing.length;
    i++;
    return emit(m).then(function () {
      if (cancelled) return;
      post({ type: 'gap-progress', jobId: jobId, label: label, gapFrac: i / missing.length });
      // Yield so a cancel message can be processed between frames.
      return yieldToEventLoop().then(next);
    });
  };

  first().then(next).then(function () {
    // Wait for every in-flight encode so gap-done always follows the last
    // frame message (cancelled chains resolve immediately via the guard).
    return Promise.all(inflightPosts.map(function (p) { return p.catch(function () {}); }));
  }).then(function () {
    if (cancelled) { post({ type: 'gap-cancelled', jobId: jobId }); return; }
    post({ type: 'gap-done', jobId: jobId });
  }).catch(function (err) {
    post({ type: 'gap-error', jobId: jobId, message: err && err.message ? err.message : String(err) });
  });
}

// Export upscaling (super-resolution, lazy-loaded on first export)

function upscaleFrame(msg) {
  upscaleCancelled = false;
  var jobId = msg.jobId;
  var rgba = new Uint8ClampedArray(msg.rgba);
  var width = msg.width, height = msg.height;
  var loadProgress = function (info) {
    if (info && info.stage === 'model') post({ type: 'sr-progress', jobId: jobId, frac: info.frac });
    else if (info && info.stage === 'compile') post({ type: 'sr-progress', jobId: jobId, frac: 1 });
  };
  model.loadSRModel(loadProgress).then(function () {
    if (upscaleCancelled) { post({ type: 'upscale-cancelled', jobId: jobId }); return; }
    // Transparent exports run a second SR pass on the alpha channel (rendered
    // as a grayscale image) and keep the real alpha; otherwise the standard
    // opaque upscale is used.
    return msg.preserveAlpha
      ? model.upscalePreservingAlpha(rgba, width, height)
      : model.upscale(rgba, width, height);
  }).then(function (out) {
    if (upscaleCancelled) { post({ type: 'upscale-cancelled', jobId: jobId }); return; }
    var buf = out.buffer;
    post({ type: 'upscaled', jobId: jobId, width: width * model.SR_SCALE, height: height * model.SR_SCALE, rgba: buf }, [buf]);
  }).catch(function (err) {
    post({ type: 'upscale-error', jobId: jobId, message: err && err.message ? err.message : String(err) });
  });
}
