/* model.js: local ML frame interpolation (RIFE, ONNX) for Keyframe Studio.
 * No server, no API: the runtime + model are downloaded in-browser once, then
 * everything runs locally; nothing is sent anywhere. If the fetch fails, callers
 * fall back to the pure mesh morph. Swap ORT_VERSION / ORT_CDN / MODEL_URL to
 * change sources. */
(typeof self !== 'undefined' ? self : window).KHUWARI_MODEL = (function () {
  'use strict';

  var root = (typeof self !== 'undefined' ? self : window);

  var ORT_VERSION = '1.20.1';
  var ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/';
  var ORT_JS = ORT_CDN + 'ort.min.js';
  var ORT_WASM = ORT_CDN; // ort fetches ort-wasm*.wasm from this path

  // RIFE fp32 ONNX (frame interpolation). Accepted input layouts (auto-detected
  // by detectFeedPlan, so this stays a URL swap):
  //   one 6-channel input [1,6,H,W] (frame A RGB ++ frame B RGB, 0..1), with or
  //   without a scalar 'timestep' input, or two 3-channel inputs (+ timestep).
  // All emit [1,3,H,W] float32 (0..1).
  //
  // Current: timestep-exposed fp32 export. An export WITHOUT a live timestep
  // input renders every inbetween at the folded t=0.5, so multi-frame gaps
  // need this. Weights are a v4.x export (MIT); the exporter benchmarked it
  // ahead of the 4.9 and 4.26 releases at every non-midpoint phase (0.4-0.9 dB
  // on Xiph clips), which is exactly where multi-frame gaps live.
  //   https://huggingface.co/walterlow/RIFE_fp32_timestep
  // Earlier rife49 export (kept for rollback):
  //   https://huggingface.co/ChimairrA/rife49_ensemble_False_scale_1_sim/resolve/main/rife49_ensemble_False_scale_1_sim.onnx
  // The ensemble_True rife49 variant unrolls 4 averaged passes in the graph;
  // the non-ensemble is ~1.4x faster with a measured mean output difference of
  // ~0.04/255 (visually identical) on the same rife49 weights.
  var MODEL_URL = 'https://huggingface.co/walterlow/RIFE_fp32_timestep/resolve/main/RIFE_fp32_timestep.onnx';

  // Super-resolution ONNX model for export upscaling (Real-ESRGAN-style).
  // Accepts [1,3,H,W] float32 (0..1) and emits [1,3,H*4,W*4] float32.
  // 4x-ClearRealityV1 is a small (1.9 MB) ESRGAN-family upscaler that runs
  // comfortably in single-threaded WASM (~1.4 s per 512×288 frame) and keeps
  // visibly more detail than bilinear upscaling. Swap SR_MODEL_URL / SR_SCALE
  // to change the upscaler.
  var SR_MODEL_URL = 'https://huggingface.co/yuvraj108c/ComfyUI-Upscaler-Onnx/resolve/main/4x-ClearRealityV1.onnx';
  var SR_SCALE = 4;

  var state = {
    runtimeLoaded: false,
    session: null,
    loading: false,
    loadPromise: null,
    feedPlan: null   // input layout of the loaded model (see detectFeedPlan)
  };

  var srState = {
    session: null,
    loading: false,
    loadPromise: null
  };

  // Multi-threaded WASM needs cross-origin isolation (SharedArrayBuffer). When
  // the page is served with COOP/COEP headers we let ORT use the CPU's cores;
  // otherwise ORT would try to load the threaded build and fail, so stay on a
  // single thread. Quality is identical either way; this is pure speed.
  function workerThreads() {
    try {
      if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated &&
          typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
        return Math.min(4, Math.max(1, navigator.hardwareConcurrency));
      }
    } catch (e) { /* fall through to single-threaded */ }
    return 1;
  }

  function loadRuntime() {
    if (state.runtimeLoaded) return Promise.resolve();
    if (root.ort && root.ort.InferenceSession) {
      state.runtimeLoaded = true;
      return Promise.resolve();
    }
    return new Promise(function (resolve, reject) {
      if (typeof importScripts === 'function') {
        // Inside a Web Worker: importScripts is synchronous and CORS-permitted.
        try {
          importScripts(ORT_JS);
        } catch (e) {
          reject(new Error('Could not load ONNX Runtime from ' + ORT_JS));
          return;
        }
        if (!root.ort || !root.ort.InferenceSession) {
          reject(new Error('ONNX Runtime loaded but `ort` is missing'));
          return;
        }
        try {
          root.ort.env.wasm.wasmPaths = ORT_WASM;
          root.ort.env.wasm.numThreads = workerThreads();
        } catch (e) { /* non-fatal */ }
        state.runtimeLoaded = true;
        resolve();
        return;
      }
      var script = document.createElement('script');
      script.src = ORT_JS;
      script.onload = function () {
        if (!root.ort || !root.ort.InferenceSession) {
          reject(new Error('ONNX Runtime loaded but `ort` is missing'));
          return;
        }
        try {
          root.ort.env.wasm.wasmPaths = ORT_WASM;
          root.ort.env.wasm.numThreads = workerThreads();
        } catch (e) { /* non-fatal */ }
        state.runtimeLoaded = true;
        resolve();
      };
      script.onerror = function () { reject(new Error('Could not load ONNX Runtime from ' + ORT_JS)); };
      document.head.appendChild(script);
    });
  }

  // Streaming download with progress (0..1)

  function downloadWithProgress(url, onProgress) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('Download failed (HTTP ' + res.status + ')');
      var total = Number(res.headers.get('Content-Length')) || 0;
      if (!res.body || typeof res.body.getReader !== 'function') {
        // No streaming (older browsers): fall back to a single read.
        onProgress(0.1);
        return res.arrayBuffer().then(function (buf) {
          onProgress(1);
          return buf;
        });
      }
      var reader = res.body.getReader();
      var received = 0;
      var chunks = [];
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            var all = new Uint8Array(received);
            var off = 0;
            for (var i = 0; i < chunks.length; i++) {
              all.set(chunks[i], off);
              off += chunks[i].length;
            }
            onProgress(1);
            return all.buffer;
          }
          chunks.push(r.value);
          received += r.value.length;
          if (total) onProgress(received / total);
          return pump();
        });
      }
      return pump();
    });
  }

  function loadModel(onProgress) {
    if (state.session) return Promise.resolve();
    if (state.loadPromise) return state.loadPromise;
    state.loading = true;
    state.loadPromise = loadRuntime()
      .then(function () {
        if (onProgress) onProgress({ stage: 'model', frac: 0 });
        return downloadWithProgress(MODEL_URL, function (frac) {
          if (onProgress) onProgress({ stage: 'model', frac: frac });
        });
      })
      .then(function (buf) {
        if (onProgress) onProgress({ stage: 'compile', frac: 1 });
        return root.ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
      })
      .then(function (session) {
        state.session = session;
        try {
          var meta = [];
          var outputMeta = [];
          (session.inputNames || []).forEach(function (n) {
            var m = session.inputMetadata ? session.inputMetadata[n] : null;
            meta.push(n + (m && m.dims ? ' ' + JSON.stringify(m.dims) : ''));
          });
          (session.outputNames || []).forEach(function (n) {
            var m = session.outputMetadata ? session.outputMetadata[n] : null;
            outputMeta.push(n + (m && m.dims ? ' ' + JSON.stringify(m.dims) : ''));
          });
          console.log('[ML] model inputs:', meta.join(', ') || '(unknown)', '| outputs:', outputMeta.join(', ') || '(unknown)');
        } catch (e) { /* optional */ }
        return session;
      })
      .finally(function () {
        state.loading = false;
        state.loadPromise = null;
      });
    return state.loadPromise;
  }

  // A gap's frames all interpolate the SAME two keyframes; only t changes.
  // The prepared feed tensors (concat of the two frames) are identical for
  // every frame of a job, so build them once per (buffers, size) pair and
  // reuse: saves the 6n-float concat write per frame. Two slots cover the
  // worker's RGB pass + alpha-as-gray pass (they alternate per frame, so a
  // single entry would thrash). Each entry owns its input buffer; a cached
  // tensor must not alias a buffer another entry later overwrites.
  var feedCache = [null, null]; // [{ a, b, n, plan, feeds, w, h }, ...]
  function feedsFor(aData, bData, n, plan, w, h) {
    for (var i = 0; i < feedCache.length; i++) {
      var e = feedCache[i];
      if (e && e.a === aData && e.b === bData && e.n === n && e.plan === plan && e.w === w && e.h === h) {
        return e.feeds;
      }
    }
    var feeds = {};
    if (plan.kind === 'six' || plan.kind === 'sixPlusTs') {
      var six = new Float32Array(6 * n);
      concatFramesInto(six, aData, bData, n);
      feeds[plan.aName] = new root.ort.Tensor('float32', six, [1, 6, h, w]);
    } else {
      var fa = new Float32Array(3 * n);
      var fb = new Float32Array(3 * n);
      rgbaToRifefloatInto(fa, aData, n);
      rgbaToRifefloatInto(fb, bData, n);
      feeds[plan.aName] = new root.ort.Tensor('float32', fa, [1, 3, h, w]);
      feeds[plan.bName] = new root.ort.Tensor('float32', fb, [1, 3, h, w]);
    }
    feedCache[1] = feedCache[0];
    feedCache[0] = { a: aData, b: bData, n: n, plan: plan, feeds: feeds, w: w, h: h };
    return feeds;
  }

  // Single frame -> [1,3,H,W] float32 in 0..1 (channel-first R,G,B planes),
  // written into a preallocated buffer so no per-call allocation happens.
  // RGB is premultiplied by alpha: transparent pixels (RGB is undefined/garbage
  // in PNGs) contribute 0 so RIFE interpolates only the visible painted pixels.
  // For fully opaque images this is exactly rgb/255 (byte-identical behaviour).
  function rgbaToRifefloatInto(out, rgba, n) {
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      var a = rgba[i + 3] / 255;
      out[p] = rgba[i] * a / 255;
      out[n + p] = rgba[i + 1] * a / 255;
      out[2 * n + p] = rgba[i + 2] * a / 255;
    }
  }

  function concatFramesInto(out, aData, bData, n) {
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      var aa = aData[i + 3] / 255;
      var ba = bData[i + 3] / 255;
      out[p] = aData[i] * aa / 255;
      out[n + p] = aData[i + 1] * aa / 255;
      out[2 * n + p] = aData[i + 2] * aa / 255;
      out[3 * n + p] = bData[i] * ba / 255;
      out[4 * n + p] = bData[i + 1] * ba / 255;
      out[5 * n + p] = bData[i + 2] * ba / 255;
    }
  }

  function rgbaToRifefloat(rgba, w, h) {
    var n = w * h;
    var out = new Float32Array(3 * n);
    rgbaToRifefloatInto(out, rgba, n);
    return out;
  }

  function concatFrames(aData, bData, w, h) {
    var n = w * h;
    var out = new Float32Array(6 * n);
    concatFramesInto(out, aData, bData, n);
    return out;
  }

  function rifeOutputToRGBA(tensorData, w, h) {
    var n = w * h;
    var out = new Uint8ClampedArray(n * 4);
    var r = tensorData, g = tensorData.subarray ? tensorData.subarray(n, 2 * n) : tensorData.slice(n, 2 * n);
    var b = tensorData.subarray ? tensorData.subarray(2 * n, 3 * n) : tensorData.slice(2 * n, 3 * n);
    // (x*255 + 0.5)|0 rounds exactly like Math.round for 0..1 and out-of-range
    // values are clamped by the Uint8ClampedArray assignment itself, so this
    // drops two branches + two Math calls per pixel.
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      out[i] = (r[p] * 255 + 0.5) | 0;
      out[i + 1] = (g[p] * 255 + 0.5) | 0;
      out[i + 2] = (b[p] * 255 + 0.5) | 0;
      out[i + 3] = 255;
    }
    return out;
  }

  // RIFE exports come in a few flavours and we handle all of them:
  //   A) one 6-channel input [1,6,H,W]  (frameA RGB ++ frameB RGB)
  //   B) two 3-channel inputs          (frameA, frameB), e.g. named
  //      'frame0'/'frame1', 'img0'/'img1', or 'x'/'y'
  //   C) two 3-channel inputs + a scalar 'timestep' input (t in [0,1])
  // The interpolated frame is the first 3-channel output.
  function isTimestepName(s) {
    var l = String(s).toLowerCase();
    return l.indexOf('timestep') !== -1 || l.indexOf('time') !== -1 || l.indexOf('t_') === 0;
  }
  function isFrameAName(s) {
    var l = String(s).toLowerCase();
    return l.indexOf('img0') !== -1 || l.indexOf('frame0') !== -1 || l === 'x' || l.indexOf('a') === l.length - 1;
  }

  // Figure out the model's input layout ONCE, after loading. interpolate() then
  // builds only the tensors that layout needs (the previous code built all
  // three candidates, a wasted 6n float fill on every frame for layout C).
  // onnxruntime-web 1.20.x (what Khuwari loads) exposes NO inputMetadata / dims
  // on sessions, so layouts must be classified by input NAME COUNT:
  //   1 input (~'input')                  -> 6-channel concat [1,6,H,W]
  //   1 input + 'timestep'                -> 6-channel + timestep (t must be fed!)
  //   2 inputs (img0/img1, x/y, ...)      -> two 3-channel inputs
  //   2 inputs + 'timestep'               -> two 3-channel + timestep
  // The timestep's exact shape (scalar vs [1] vs [1,1,1,1]) varies per export;
  // interpolate() probes it with a retry ladder and remembers the winner.
  function detectFeedPlan(session) {
    var names = [];
    try { names = session.inputNames || []; } catch (e) {}
    var plan = { kind: 'six', aName: 'input', bName: null, tsName: null, tsDims: [1] };
    if (!names.length) return plan;
    var tsName = null, others = [];
    for (var k = 0; k < names.length; k++) {
      if (isTimestepName(names[k])) tsName = names[k];
      else others.push(names[k]);
    }
    if (others.length === 1) {
      // Single image input = the 6-channel concat layout.
      plan.kind = tsName ? 'sixPlusTs' : 'six';
      plan.aName = others[0];
    } else if (others.length >= 2) {
      plan.kind = tsName ? 'twoPlusTs' : 'two';
      plan.aName = others.filter(isFrameAName)[0] || others[0];
      plan.bName = others[0] === plan.aName ? others[1] : others[0];
    } else {
      // Only a timestep-named input: nonsense; assume the 6-channel default.
      plan.kind = 'six';
      plan.aName = names[0];
    }
    plan.tsName = tsName;
    return plan;
  }

  // Exports disagree on the timestep input's shape (0-d scalar vs [1] vs
  // [1,1,1,1]); ORT web rejects a mismatched feed, which would silently drop
  // every frame to the caller's mesh-warp fallback. Probe: try the previous
  // winner, then the shape ladder; memoize the first that runs.
  var TS_CANDIDATES = [[], [1], [1, 1], [1, 1, 1, 1]];
  function tryRun(plan, feeds, tsName, ts) {
    var tsData = new Float32Array([ts]);
    if (plan.tsDimsResolved) {
      feeds[tsName] = new root.ort.Tensor('float32', tsData, plan.tsDimsResolved);
      return state.session.run(feeds).then(function (results) { return results; });
    }
    var i = 0;
    var attempt = function () {
      if (i >= TS_CANDIDATES.length) return Promise.reject(new Error('timestep feed rejected in every shape'));
      try {
        feeds[tsName] = new root.ort.Tensor('float32', tsData, TS_CANDIDATES[i]);
      } catch (e) {
        // Some runtimes reject exotic dims in the constructor itself.
        i++;
        return attempt();
      }
      i++;
      return state.session.run(feeds).then(function (results) {
        plan.tsDimsResolved = feeds[tsName].dims;
        return results;
      }, function () { return attempt(); });
    };
    return attempt();
  }

  // Interpolate an inbetween from two keyframe RGBA buffers (size w×h) at time t.
  // Returns Promise<Uint8ClampedArray> (RGBA) or, when rawOut is set, the raw
  // [1,3,H,W] float32 output data (caller is responsible for channel 0).
  // Rejects so callers can fall back.
  function interpolate(aData, bData, w, h, t, rawOut) {
    if (!state.session) return Promise.reject(new Error('Model not loaded'));
    if (!state.feedPlan) state.feedPlan = detectFeedPlan(state.session);
    var plan = state.feedPlan;
    var n = w * h;
    var feeds = feedsFor(aData, bData, n, plan, w, h);
    // Pre-flight check: ONNX Runtime errors are cryptic when feed data length
    // doesn't match the input's expected size, so catch it here with a clear message.
    var feedNames = Object.keys(feeds);
    for (var fn = 0; fn < feedNames.length; fn++) {
      var feed = feeds[feedNames[fn]];
      var expected = 1;
      var dims = feed.dims || [];
      for (var d = 0; d < dims.length; d++) expected *= dims[d];
      if (feed.data && feed.data.length !== expected) {
        return Promise.reject(new Error(
          'Feed "' + feedNames[fn] + '" size ' + expected + ' != data length ' + feed.data.length +
          ' (dims ' + JSON.stringify(dims) + ')'
        ));
      }
    }
    var run;
    if (plan.kind === 'twoPlusTs' || plan.kind === 'sixPlusTs') {
      // The timestep changes per frame, so it can't live in the feed cache.
      var ts = (typeof t === 'number' && isFinite(t)) ? t : 0.5;
      run = tryRun(plan, feeds, plan.tsName, ts);
    } else {
      run = state.session.run(feeds);
    }
    return run.then(function (results) {
      var outNames = Object.keys(results);
      if (!outNames.length) throw new Error('Model returned no outputs');
      var out = results[outNames[0]];
      var data = out.data;
      var len = w * h * 3;
      if (!data || data.length < len) throw new Error('Model output too small (' + (data ? data.length : 0) + ' < ' + len + ')');
      if (rawOut) return data;
      return rifeOutputToRGBA(data, w, h);
    });
  }

  function isReady() { return !!state.session; }
  function isLoading() { return state.loading; }

  // Super-resolution (export upscaling)

  // Lazily downloads + compiles the upscaler on first use (exports only).
  // Same shape-agnostic loader as the interpolation model; onProgress is
  // optional and receives {stage:'model', frac} / {stage:'compile'}.
  function loadSRModel(onProgress) {
    if (srState.session) return Promise.resolve();
    if (srState.loadPromise) return srState.loadPromise;
    srState.loading = true;
    srState.loadPromise = loadRuntime()
      .then(function () {
        if (onProgress) onProgress({ stage: 'model', frac: 0 });
        return downloadWithProgress(SR_MODEL_URL, function (frac) {
          if (onProgress) onProgress({ stage: 'model', frac: frac });
        });
      })
      .then(function (buf) {
        if (onProgress) onProgress({ stage: 'compile', frac: 1 });
        return root.ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
      })
      .then(function (session) {
        srState.session = session;
        console.log('[ML] upscaler ready (scale ' + SR_SCALE + 'x)');
        return session;
      })
      .finally(function () {
        srState.loading = false;
        srState.loadPromise = null;
      });
    return srState.loadPromise;
  }

  function isSRReady() { return !!srState.session; }
  function isLoadingSR() { return srState.loading; }

  // Upscale one RGBA buffer (size w×h) by SR_SCALE using the super-resolution
  // model. Resolves with a Uint8ClampedArray of size (w*SR_SCALE)×(h*SR_SCALE).
  function upscale(rgba, w, h) {
    if (!srState.session) return Promise.reject(new Error('Upscaler model not loaded'));
    var inNames = [];
    try { inNames = srState.session.inputNames || []; } catch (e) {}
    var name = inNames[0] || 'input';
    var n = w * h;
    var scratch = scratchFor(n);
    rgbaToRifefloatInto(scratch.a, rgba, n);
    var tensor = new root.ort.Tensor('float32', scratch.a, [1, 3, h, w]);
    var feeds = {};
    feeds[name] = tensor;
    return srState.session.run(feeds).then(function (results) {
      var outNames = Object.keys(results);
      if (!outNames.length) throw new Error('Upscaler returned no outputs');
      var out = results[outNames[0]];
      var ow = w * SR_SCALE, oh = h * SR_SCALE;
      var data = out.data;
      var len = ow * oh * 3;
      if (!data || data.length < len) throw new Error('Upscaler output too small (' + (data ? data.length : 0) + ' < ' + len + ')');
      return rifeOutputToRGBA(data, ow, oh);
    });
  }

  // Upscale one RGBA buffer while preserving its alpha channel, mirroring the
  // alpha-interpolation trick: the color pass runs through the SR model as
  // usual (premultiplied, so transparent pixels don't bleed color), and a
  // second SR pass runs on the alpha channel rendered as a grayscale image
  // (white = opaque, black = transparent). The two are combined by
  // un-premultiplying the color with the upscaled alpha, giving a faithful
  // transparent upscale instead of the opaque alpha=255 the model emits.
  function upscalePreservingAlpha(rgba, w, h) {
    if (!srState.session) return Promise.reject(new Error('Upscaler model not loaded'));
    var n = w * h;
    // Alpha as a grayscale RGBA: opaque (alpha 255) so the SR premultiply is a
    // no-op and the grayscale values pass straight through the model.
    var alphaGray = new Uint8ClampedArray(n * 4);
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      var a = rgba[i + 3];
      alphaGray[i] = a; alphaGray[i + 1] = a; alphaGray[i + 2] = a; alphaGray[i + 3] = 255;
    }
    return upscale(rgba, w, h).then(function (colorOut) {
      return upscale(alphaGray, w, h).then(function (alphaOut) {
        var ow = w * SR_SCALE, oh = h * SR_SCALE;
        var out = new Uint8ClampedArray(ow * oh * 4);
        for (var q = 0, qi = 0; q < ow * oh; q++, qi += 4) {
          // alphaOut is grayscale: r == g == b == upscaled alpha (0..255).
          var a = alphaOut[qi] / 255;
          if (a <= 1 / 255) {
            // Fully transparent: skip the multiply/divide to avoid 0/0 noise.
            out[qi] = 0; out[qi + 1] = 0; out[qi + 2] = 0; out[qi + 3] = 0;
          } else {
            // The color pass was premultiplied by alpha (rgbaToRifefloatInto),
            // so divide back out to recover straight color; the assignment to a
            // Uint8ClampedArray clamps + rounds.
            out[qi] = colorOut[qi] / a;
            out[qi + 1] = colorOut[qi + 1] / a;
            out[qi + 2] = colorOut[qi + 2] / a;
            out[qi + 3] = a * 255;
          }
        }
        return out;
      });
    });
  }

  return {
    loadRuntime: loadRuntime,
    loadModel: loadModel,
    interpolate: interpolate,
    rgbaToRifefloat: rgbaToRifefloat,
    isReady: isReady,
    isLoading: isLoading,
    loadSRModel: loadSRModel,
    isSRReady: isSRReady,
    isLoadingSR: isLoadingSR,
    upscale: upscale,
    upscalePreservingAlpha: upscalePreservingAlpha,
    SR_SCALE: SR_SCALE,
    MODEL_URL: MODEL_URL,
    SR_MODEL_URL: SR_MODEL_URL,
    ORT_JS: ORT_JS
  };
})();
