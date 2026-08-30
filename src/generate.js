'use strict';


  function setGenStatus(kind, text) {
    el.genStatus.className = 'status ' + kind;
    el.genStatus.textContent = text || '';
  }

  // Progress bar updates are throttled: they write three DOM properties per
  // frame and generation can complete hundreds of frames, so pushing every
  // frame would thrash layout on the main thread during a run.
  var genProgTimer = null;
  var genProgLabel = null;
  var genProgPct = 0;
  function setGenProgress(label, pct) {
    genProgLabel = label;
    genProgPct = pct;
    if (genProgTimer) return;
    genProgTimer = setTimeout(flushGenProgress, 80);
  }
  function flushGenProgress() {
    if (genProgTimer) { clearTimeout(genProgTimer); genProgTimer = null; }
    if (genProgLabel == null) return;
    var label = genProgLabel, pct = genProgPct;
    genProgLabel = null;
    el.genProgress.classList.remove('hidden');
    el.genFill.style.width = clamp(pct, 0, 100) + '%';
    el.genLabel.textContent = label;
    el.genMeta.textContent = Math.round(pct) + '%';
  }

  // Generation runs in the background worker; only missing frames are
  // generated, and it auto-runs (debounced) after every change.

  // Reused rasterization canvas; allocating one per frame is GC churn during
  // generation (dataToDataURL runs once per generated frame).
  var encodeCanvas = null;
  var encodeCtx = null;
  function dataToDataURL(data, w, h) {
    if (!encodeCanvas) {
      encodeCanvas = document.createElement('canvas');
      encodeCtx = encodeCanvas.getContext('2d');
    }
    if (encodeCanvas.width !== w || encodeCanvas.height !== h) {
      encodeCanvas.width = w;
      encodeCanvas.height = h;
    }
    var imageData = encodeCtx.createImageData(w, h);
    imageData.data.set(data);
    encodeCtx.putImageData(imageData, 0, 0);
    return encodeCanvas.toDataURL('image/png');
  }

  // Rasterize one keyframe image to a raw RGBA buffer at working size (clear
  // transparent so cut-out characters keep their alpha through interpolation).
  // Buffers are cached by (image src, size): with gap chunking the same
  // keyframe pair is rasterized once per chunk, so without this a 4-chunk gap
  // redraws both canvases 4×. Capped small: each entry is a full frame's RGBA.
  var drawCache = new Map();
  function drawImageToData(img, w, h) {
    var key = (img.src || img) + '|' + w + 'x' + h;
    if (drawCache.has(key)) return drawCache.get(key);
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    drawContain(ctx, img, w, h);
    var data = ctx.getImageData(0, 0, w, h).data;
    if (drawCache.size > 16) drawCache.clear();
    drawCache.set(key, data);
    return data;
  }

  // matteK / opacity decision is a property of the keyframe PAIR, not the
  // chunk: memoize it per (endpoint images, size) so chunked jobs don't each
  // re-run isOpaque + pickKeyColor over the full frame.
  var matteMemo = new Map();
  function matteFor(gap, aData, bData) {
    var key = gap.from.img + '>' + gap.to.img + '|' + workW + 'x' + workH +
      '|' + layerFillSig(gap.layer, gap.from.time) + '|' + layerFillSig(gap.layer, gap.to.time);
    if (matteMemo.has(key)) return matteMemo.get(key);
    var n = workW * workH;
    var m = { opaque: morph.isOpaque(aData) && morph.isOpaque(bData), K: null };
    if (!m.opaque) m.K = morph.pickKeyColor(aData, bData, n);
    if (matteMemo.size > 64) matteMemo.clear();
    matteMemo.set(key, m);
    return m;
  }

  // Generate one gap's missing frames. The endpoints are the layer's own two
  // keyframe images. Fully opaque gaps interpolate directly (best quality).
  // Gaps with transparency get the chroma-key matte treatment: the transparent
  // background is painted a key color absent from the frame (encodeMatte), the
  // model interpolates a clean opaque image, and afterwards the frame's alpha is
  // taken from the mesh-union alpha warp of the ORIGINAL keyframes (crisp
  // silhouette) while the key tint is removed from the RGB (removeKey), so
  // cut-out characters get model-quality colors without the transparent-pixel
  // garbage. Dispatches to the worker when available; otherwise runs inline
  // (mesh warp fallback path).
  function generateGap(gap, missing, cbs) {
    var missingList = missing.map(function (idx) {
      return { idx: idx, t: idx / (gap.genCount + 1) };
    });
    return Promise.all([loadImage(gap.from.img), loadImage(gap.to.img)]).then(function (imgs) {
      if (cbs.cancelled()) return;
      // Bake the color fills into each endpoint: the gap interpolates the
      // composite of line art + colors, so the colors warp with the line art
      // instead of being flood-filled per frame (which leaks on moving art).
      var bakedA = endpointBake(imgs[0], gap.layer, gap.from.time, workW, workH);
      var bakedB = endpointBake(imgs[1], gap.layer, gap.to.time, workW, workH);
      var aData = bakedA || drawImageToData(imgs[0], workW, workH);
      var bData = bakedB || drawImageToData(imgs[1], workW, workH);
      var m = matteFor(gap, aData, bData);
      var matteK = m.K;
      if (workers.length) {
        var jobId = 'job' + (++jobSeq);
        var wi = pickWorker();
        return new Promise(function (resolve, reject) {
          workerJobs[jobId] = {
            resolve: resolve,
            reject: reject,
            onFrame: cbs.onFrame,
            onProgress: cbs.onProgress,
            worker: workers[wi]
          };
          workerBusy[wi]++;
          // Cached buffers must be copied before transfer (transfer detaches).
          var aBuf = aData.slice().buffer, bBuf = bData.slice().buffer;
          var extra = {};
          var transfer = [aBuf, bBuf];
          // The matte memo already computed opacity; pass it so the worker
          // skips its own isOpaque scan of both buffers.
          extra.opaque = !!m.opaque;
          if (matteK) {
            // Only the key color is sent: the worker re-encodes the matte from
            // the originals itself (it needs them anyway for the alpha warp),
            // so no duplicated matte buffers are transferred per job.
            extra.matteK = matteK;
          }
          workers[wi].postMessage(Object.assign({
            type: 'generate-gap',
            jobId: jobId,
            aData: aBuf, bData: bBuf,
            width: workW, height: workH,
            fromTime: gap.fromTime, toTime: gap.toTime,
            mode: gap.mode,
            squash: gapSquashOpts(gap.id),
            blur: gapBlurOpts(gap.id),
            missing: missingList
          }, extra), transfer);
        }).catch(function (err) {
          // Worker died mid-job: run the same gap inline instead of failing.
          if (cbs.cancelled()) throw err;
          console.error('Worker job failed, running inline:', err);
          return generateGapInline(aData, bData, gap, missingList, cbs, matteK);
        });
      }
      return generateGapInline(aData, bData, gap, missingList, cbs, matteK);
    });
  }

  function generateGapInline(aData, bData, gap, missingList, cbs, matteK) {
    var meshes = null;
    var flowPromise = null;
    // Flow is needed for the mesh fallback and the alpha warp. Matte-encoded
    // inputs are opaque, so the ML path skips its own alpha handling; the frame
    // alpha then comes from warpAlpha of the ORIGINAL keyframes. `opaque`
    // reflects the ORIGINAL keyframes: a matte gap still needs the alpha pass.
    var opaque = morph.isOpaque(aData) && morph.isOpaque(bData);
    var n = workW * workH;
    // The matte (opaque) input is used for the model so it never sees
    // transparent pixels; the original buffers feed the alpha warp. The OPTICAL
    // FLOW runs on texture-extended originals (extendTexture), because thin line art
    // on a uniform background starves block matching and would otherwise give
    // ~0 flow → a double-exposed crossfade.
    var aFlow = matteK ? morph.encodeMatte(new Uint8ClampedArray(aData), n, matteK) : aData;
    var bFlow = matteK ? morph.encodeMatte(new Uint8ClampedArray(bData), n, matteK) : bData;
    // Model-driven opacity: alpha channel as grayscale for a second model pass.
    var aGray = matteK ? morph.alphaToGray(aData, workW, workH) : null;
    var bGray = matteK ? morph.alphaToGray(bData, workW, workH) : null;
    // Same static-gap shortcuts as the worker: duplicate keyframes skip both
    // model passes; identical alpha masks skip the alpha pass (removeKey stamps
    // the static mask with the same math the model would produce).
    var framesIdentical = morph.buffersEqual(aData, bData);
    var staticAlpha = null;
    if (!framesIdentical && matteK && morph.sameAlpha(aData, bData, n)) {
      // removeKey takes a per-pixel alpha array (0..255), not an RGBA buffer.
      var sa = new Uint8Array(n);
      for (var p = 0, i = 3; p < n; p++, i += 4) sa[p] = aData[i];
      staticAlpha = sa;
    }
    // Textured flow inputs are built lazily inside ensureMeshes; the ML path never
    // needs the flow and extendTexture is an expensive distance transform.
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
          aFlowTex = morph.extendTexture(aData, workW, workH, 10, flowBg);
          bFlowTex = morph.extendTexture(bData, workW, workH, 10, flowBg);
        }
      }
      if (cbs.onProgress) cbs.onProgress('Preparing inbetweens…', 0);
      flowPromise = morph.computeFlowBoth(aFlowTex, bFlowTex, workW, workH, flowOpts, function (frac) {
        if (cbs.onProgress) cbs.onProgress('Preparing inbetweens…', frac * 0.05);
      }, cbs.cancelled).then(function (pair) {
        if (cbs.cancelled()) return;
        meshes = morph.buildMeshes(pair, workW, workH, 16);
      });
      return flowPromise;
    };
    // --- multi-pass (hierarchical) interpolation ---
    // Same two-stage fill as the worker: a dyadic midpoint tree (each render
    // interpolates half the motion of the level above it), then each missing
    // frame is rendered directly from its two grid neighbours. Keeps the
    // single-pass behaviour for one-frame gaps, squash, and identical
    // keyframes.
    var useHier = gap.mode === 'ai' && missingList.length >= 2 && !framesIdentical;
    var hierDepth = 0;
    if (useHier) {
      var segs = missingList.length + 1;
      while ((1 << (hierDepth + 1)) <= segs) hierDepth++;
    }
    var hierLevels = null;
    var hierBuilt = false;
    var hierChain = null;

    // Alpha for a rendered frame: union of the two flow-warped alpha channels
    // of the ORIGINAL keyframes (dense flow), plus key-tint removal for matte
    // gaps. tG = the frame's gap position (hierarchical intermediates warp at
    // their own t).
    var applyAlphaAt = function (rgba, tG) {
      var alpha = morph.warpAlphaDense(aData, bData, meshes.flowAB, meshes.flowBA, workW, workH, tG);
      if (matteK) morph.removeKey(rgba, n, matteK, alpha);
      else {
        for (var p = 0, q = 0; p < n; p++, q += 4) rgba[q + 3] = alpha[p];
      }
    };

    // Pure render of the inbetween between two finalized buffers at local
    // phase tLocal (model or mesh + alpha + matte, no blur, no callback).
    var renderBetween = function (ab, bb, gA, gB, tLocal, tGlobal) {
      var meshFallback = function () {
        return ensureMeshes().then(function () {
          if (cbs.cancelled()) return null;
          var frame = opaque
            ? morph.morphFrameMesh(aFlow, bFlow, meshes, workW, workH, tGlobal)
            : morph.morphFrame(aFlow, bFlow, meshes.flowAB, meshes.flowBA, workW, workH, tGlobal);
          if (!opaque) applyAlphaAt(frame, tGlobal);
          return { rgba: frame, ai: false };
        });
      };
      if (framesIdentical) return Promise.resolve({ rgba: new Uint8ClampedArray(aData), ai: true });
      if (cbs.aiReady()) {
        return model.interpolate(ab, bb, workW, workH, tLocal).then(function (aiOut) {
          if (cbs.cancelled()) return null;
          if (opaque) return { rgba: aiOut, ai: true };
          if (staticAlpha) {
            morph.removeKey(aiOut, n, matteK, staticAlpha);
            return { rgba: aiOut, ai: true };
          }
          var alphaFallback = function () {
            return ensureMeshes().then(function () {
              if (cbs.cancelled()) return null;
              applyAlphaAt(aiOut, tGlobal);
              return { rgba: aiOut, ai: true };
            });
          };
          if (gA && gB) {
            return model.interpolate(gA, gB, workW, workH, tLocal, true).then(function (alphaTensor) {
              if (cbs.cancelled()) return null;
              morph.applyGrayAlphaRaw(aiOut, alphaTensor, n, matteK);
              return { rgba: aiOut, ai: true };
            }, alphaFallback);
          }
          return alphaFallback();
        }).catch(function (err) {
          if (cbs.cancelled()) return null;
          console.error('ML inbetween failed, using mesh warp:', err);
          return meshFallback();
        });
      }
      return meshFallback();
    };

    // Dyadic midpoint tree, built once per gap (levels in order so the model
    // never gets overlapping jobs).
    var buildHier = function () {
      if (!useHier || hierBuilt) return Promise.resolve();
      if (hierChain) return hierChain;
      if (cbs.onProgress) cbs.onProgress('Preparing inbetweens…', 0);
      hierChain = Promise.resolve().then(function () {
        hierLevels = [[{ t: 0, buf: aFlow, gray: aGray }, { t: 1, buf: bFlow, gray: bGray }]];
        var chain = Promise.resolve();
        for (var d = 1; d <= hierDepth; d++) {
          (function (d) {
            chain = chain.then(function () {
              if (cbs.cancelled()) return;
              var prevLevel = hierLevels[d - 1];
              var next = new Array((1 << d) + 1);
              var step = 1 / (1 << d);
              var j = 0;
              var build = function () {
                if (cbs.cancelled()) return Promise.resolve();
                if (j > (1 << d)) {
                  hierLevels[d] = next;
                  return Promise.resolve();
                }
                if (j % 2 === 0) { next[j] = prevLevel[j >> 1]; j++; return build(); }
                var lo = prevLevel[(j - 1) >> 1], hi = prevLevel[(j + 1) >> 1];
                var gA = lo.gray, gB = hi.gray;
                if (!gA && matteK) gA = morph.alphaToGray(lo.buf, workW, workH);
                if (!gB && matteK) gB = morph.alphaToGray(hi.buf, workW, workH);
                return renderBetween(lo.buf, hi.buf, gA, gB, 0.5, step * j).then(function (r) {
                  if (cbs.cancelled() || !r) return;
                  next[j] = {
                    t: step * j,
                    buf: r.rgba,
                    gray: matteK ? morph.alphaToGray(r.rgba, workW, workH) : null
                  };
                  j++;
                  return build();
                });
              };
              return build();
            });
          })(d);
        }
        return chain.then(function () { if (!cbs.cancelled()) hierBuilt = true; });
      });
      return hierChain;
    };

    // The requested frame's two grid neighbours at the deepest level.
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
      if (cbs.cancelled()) return Promise.resolve();
      var t = m.t;
      var time = gap.fromTime + (gap.toTime - gap.fromTime) * t;
      var done = function (rgba, ai) {
        cbs.onFrame({ idx: m.idx, t: t, time: time, img: dataToDataURL(rgba, workW, workH), ai: ai });
      };
      // Motion blur post-process: smears the frame along its motion, easing
      // in/out over the gap. Needs the meshes, so it forces the lazy flow even
      // on the opaque-ML path that would otherwise skip it.
      var blur = gapBlurOpts(gap.id);
      var blurOn = !!(blur.on && blur.intensity > 0);
      var finish = function (rgba, ai) {
        if (!blurOn) { done(rgba, ai); return Promise.resolve(); }
        return ensureMeshes().then(function () {
          if (cbs.cancelled()) return;
          done(morph.motionBlurFrame(rgba, meshes, workW, workH, t, blur.intensity), ai);
        });
      };
      // Squash: affine squash-and-stretch along the detected motion
      // direction, pivoted on the moving mass (no mesh warp, no crossfade).
      // Samples the ORIGINAL keyframes — the transform carries A's own alpha,
      // so no union-alpha stamp (the ML path's job); the union would turn B's
      // silhouette opaque over A's background (a black/empty ghost of B).
      if (gap.mode === 'squash') {
        return ensureMeshes().then(function () {
          var frame = morph.squashStretchFrame(aData, bData, meshes, workW, workH, t, gapSquashOpts(gap.id));
          return finish(frame, false);
        });
      }
      var renderHere = function (ab, bb, gA, gB, tl) {
        return renderBetween(ab, bb, gA, gB, tl, t).then(function (r) {
          if (cbs.cancelled() || !r) return;
          return finish(r.rgba, r.ai);
        });
      };
      if (useHier) {
        return buildHier().then(function () {
          if (cbs.cancelled()) return;
          var seg = hierSegment(t);
          // On-grid frames ARE the rendered grid node (phase 0 would only
          // approximate it); pass it through with blur as usual.
          if (seg.tLocal === 0) return finish(seg.bufA, true);
          return renderHere(seg.bufA, seg.bufB, seg.grayA, seg.grayB, seg.tLocal);
        });
      }
      return renderHere(aFlow, bFlow, aGray, bGray, t);
    };
    var i = 0;
    var next = function () {
      if (cbs.cancelled() || i >= missingList.length) return Promise.resolve();
      var m = missingList[i];
      var label = (gap.mode === 'squash' ? 'squash frame ' : (cbs.aiReady() ? 'ML inbetween ' : 'mesh warp ')) + m.idx + '/' + gap.genCount;
      i++;
      return emit(m).then(function () {
        if (cbs.onProgress) cbs.onProgress(label, i / missingList.length);
        return new Promise(function (r) { setTimeout(r, 0); }).then(next);
      });
    };
    return next();
  }

  var genTimer = null;
  var genSeq = 0;                // incremented per schedule: stale callbacks no-op
  var modelGate = null;          // promise resolving when model load settles
  var modelGateResolve = null;   // resolve() for the gate above
  // Coalesced view refresh during generation: rebuilding the lane + filmstrip on
  // every completed frame is O(frames²) with async thumb composites; heavy edits
  // (many cancels/restarts) make it crawl. Updates are throttled to ~150ms and a
  // final flush happens when the run finishes.
  var genViewTimer = null;
  var genViewDirty = false;
  function scheduleGenView() {
    genViewDirty = true;
    if (genViewTimer) return;
    genViewTimer = setTimeout(function () {
      genViewTimer = null;
      if (!genViewDirty) return;
      genViewDirty = false;
      renderLane();
      renderFilmstrip();
    }, 150);
  }
  function flushGenView() {
    genViewDirty = false;
    if (genViewTimer) { clearTimeout(genViewTimer); genViewTimer = null; }
    renderLane();
    renderFilmstrip();
  }
  function scheduleGenerate(delay) {
    clearTimeout(genTimer);
    var token = ++genSeq;
    // Edit-driven schedules (50-60ms) are too twitchy for quick successive
    // edits: each one fired its own generation run, and during a run each one
    // cancelled and restarted it, so a burst of edits stacked one restart per
    // edit and generation lagged further and further behind. Floor the delay
    // so a burst shares a single run that starts once the edits settle, and
    // absorb edits that land mid-run into one restart.
    var d = delay == null ? 500 : Math.max(delay, EDIT_DEBOUNCE_MS);
    if (state.genRun && d < REGEN_ABSORB_MS) d = REGEN_ABSORB_MS;
    genTimer = setTimeout(function () {
      // Wait for the model download/compile to settle so gaps are generated
      // with ML when possible (the launch overlay blocks interaction anyway).
      (modelGate || Promise.resolve()).then(function () {
        if (token !== genSeq) return; // superseded by a newer schedule
        if (state.genRun) { state.pendingRegen = true; cancelRun(); }
        else runGeneration();
      });
    }, d);
  }

  function cancelRun() {
    if (!state.genRun) return;
    state.genRun.cancelled = true;
    workers.forEach(function (w) {
      try { w.postMessage({ type: 'cancel' }); } catch (e) {}
    });
    // The pump waits on outstanding worker jobs; a busy or crashed worker may
    // never answer a cancel, which would wedge the run and block all future
    // auto-generation (heavy editing churns cancel/restart constantly). Settle
    // every outstanding job now so the run drains immediately; late replies are
    // ignored because their jobIds are already gone.
    Object.keys(workerJobs).forEach(function (id) {
      var j = workerJobs[id];
      if (!j) return;
      delete workerJobs[id];
      decBusy(j.worker);
      j.resolve();
    });
  }

  function runGeneration() {
    if (state.genRun) return;
    // Per-layer gaps: each layer interpolates its own timeline, so gaps are
    // independent and can all run concurrently.
    var gaps = [];
    state.layers.forEach(function (L) {
      computeGaps(L.id).forEach(function (g) {
        if (g.genCount > 0 && !gapComplete(g)) gaps.push(g);
      });
    });
    // A gap's missing frames are split across the worker pool: each chunk runs
    // as its own job on a different worker, so a timeline with one big gap (the
    // common case) renders on every core instead of a single worker. Chunks of
    // the same gap recompute the same deterministic optical flow; flow is a
    // small share of a gap's cost and the rendered frames are byte-identical.
    var tasks = [];
    var total = 0;
    gaps.forEach(function (gap, gi) {
      var missing = computeMissing(gap);
      if (!missing.length) return;
      var parts = Math.max(1, Math.min(workers.length || 1, missing.length));
      var per = Math.ceil(missing.length / parts);
      for (var ci = 0; ci < parts; ci++) {
        var chunk = missing.slice(ci * per, (ci + 1) * per);
        if (!chunk.length) break;
        tasks.push({ gap: gap, missing: chunk, gi: gi, ci: ci, parts: parts });
        total += chunk.length;
      }
    });
    if (!total) {
      setGenStatus('ready', 'All gaps generated ✓');
      updateEstimate();
      return;
    }
    var run = { cancelled: false };
    state.genRun = run;
    el.btnCancel.classList.remove('hidden');
    setGenStatus('downloading', 'Preparing…');
    setGenProgress('Preparing…', 2);

    var done = 0;
    var concurrency = Math.min(6, Math.max(1, workers.length || 1));
    var idx = 0, active = 0, firstErr = null;
    var generateOne = function (task) {
      if (run.cancelled) return Promise.resolve();
      var gap = task.gap;
      var missing = task.missing;
      if (!missing.length) return Promise.resolve();
      var gen = state.generated[gap.id] || (state.generated[gap.id] = []);
      // Index by frame idx so concurrent chunks of one gap merge in O(1)
      // instead of a linear find per frame.
      var genIndex = {};
      gen.forEach(function (f) { if (f) genIndex[f.idx] = f; });
      // Stamp now, so a later refresh keeps the frames we produce here even
      // if the run is cancelled (only the tail stays dirty).
      state.gapMeta[gap.id] = gapStamp(gap);
      var label = 'Gap ' + (task.gi + 1) + '/' + gaps.length + (task.parts > 1 ? ' · part ' + (task.ci + 1) + '/' + task.parts : '');
      setGenStatus('downloading', label + ' (' + missing.length + ' frames)');
      return generateGap(gap, missing, {
        aiReady: function () { return model.isReady(); },
        cancelled: function () { return run.cancelled; },
        onProgress: function (l, gapFrac) {
          setGenProgress(label + ' · ' + l, ((done + gapFrac) / total) * 100);
        },
        onFrame: function (frame) {
          // Merge by index so a partially-generated gap is only topped up.
          var found = genIndex[frame.idx];
          if (found) { for (var k in found) found[k] = frame[k]; }
          else { gen.push(frame); genIndex[frame.idx] = frame; }
          done++;
          setGenProgress(
            label + ' · ' + (frame.ai ? 'ML frame ' : 'warp ') + frame.idx + '/' + gap.genCount,
            (done / total) * 100
          );
        }
      }).then(function () {
        if (!run.cancelled) {
          gen.sort(function (a, b) { return a.idx - b.idx; });
          refreshDirty();
        }
        scheduleGenView();
      });
    };
    // Run up to `concurrency` chunk jobs at once (one per worker) instead of
    // one big chain, so idle cores stay busy while a slow gap is generating.
    var completion = new Promise(function (resolve, reject) {
      function pump() {
        if (run.cancelled || firstErr) idx = tasks.length; // stop after cancel/error
        while (!run.cancelled && !firstErr && active < concurrency && idx < tasks.length) {
          var task = tasks[idx];
          idx++;
          active++;
          generateOne(task).then(function () {
            active--;
            pump();
          }, function (err) {
            active--;
            if (!firstErr) firstErr = err;
            pump();
          });
        }
        if (idx >= tasks.length && active === 0) {
          if (firstErr) reject(firstErr);
          else resolve();
        }
      }
      pump();
    });
    completion.then(function () {
      if (run.cancelled) {
        setGenStatus('idle', 'Stopped. Completed frames kept; remaining gaps will auto-regenerate.');
        updateEstimate();
      } else {
        setGenStatus('ready', total + ' frames generated ✓');
      }
    }).catch(function (err) {
      if (err && err.message === 'Cancelled') {
        setGenStatus('idle', 'Stopped.');
      } else {
        setGenStatus('error', 'Generation failed: ' + (err && err.message ? err.message : String(err)));
        toast('Generation failed: ' + (err && err.message ? err.message : String(err)), 6000);
      }
      console.error(err);
    }).finally(function () {
      state.genRun = null;
      el.btnCancel.classList.add('hidden');
      flushGenProgress();
      el.genProgress.classList.add('hidden');
      flushGenView();
      if (state.pendingRegen) {
        state.pendingRegen = false;
        runGeneration();
      }
    });
  }

  function downloadFrame(dataURL, name) {
    var a = document.createElement('a');
    a.href = dataURL;
    a.download = name || 'frame.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
