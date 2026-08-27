'use strict';


  // minimal ZIP writer (store method, no compression)
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZip(files) {
    var enc = new TextEncoder();
    var chunks = [];
    var central = [];
    var offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name);
      var crc = crc32(f.data);
      var local = new Uint8Array(30 + name.length);
      var dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0x21, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, f.data.length, true);
      dv.setUint32(22, f.data.length, true);
      dv.setUint16(26, name.length, true);
      dv.setUint16(28, 0, true);
      local.set(name, 30);
      chunks.push(local, f.data);
      central.push({ name: name, crc: crc, size: f.data.length, offset: offset });
      offset += local.length + f.data.length;
    });
    var cdStart = offset;
    var cdChunks = [];
    central.forEach(function (c) {
      var rec = new Uint8Array(46 + c.name.length);
      var dv = new DataView(rec.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);      // version made by
      dv.setUint16(6, 20, true);      // version needed to extract
      dv.setUint16(8, 0x0800, true);  // flags: UTF-8 names
      dv.setUint16(10, 0, true);      // method: store
      dv.setUint16(12, 0, true);      // mod time
      dv.setUint16(14, 0x21, true);   // mod date
      dv.setUint32(16, c.crc, true);
      dv.setUint32(20, c.size, true); // compressed size
      dv.setUint32(24, c.size, true); // uncompressed size
      dv.setUint16(28, c.name.length, true);
      dv.setUint16(30, 0, true);      // extra field length
      dv.setUint16(32, 0, true);      // comment length
      dv.setUint16(34, 0, true);      // disk number start
      dv.setUint16(36, 0, true);      // internal attributes
      dv.setUint32(38, 0, true);      // external attributes
      dv.setUint32(42, c.offset, true);
      rec.set(c.name, 46);
      cdChunks.push(rec);
    });
    var cdSize = cdChunks.reduce(function (s, c) { return s + c.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    var total = eocd.length + cdSize;
    chunks.forEach(function (c) { total += c.length; });
    var out = new Uint8Array(total);
    var p = 0;
    chunks.forEach(function (c) { out.set(c, p); p += c.length; });
    cdChunks.forEach(function (c) { out.set(c, p); p += c.length; });
    out.set(eocd, p);
    return out;
  }

  function pad(n, len) {
    var s = String(n);
    while (s.length < len) s = '0' + s;
    return s;
  }

  // Export resolution + ML upscaling

  // The available export resolutions: the working size itself, integer
  // multiples of it (ML upscale when > 1x), and common fixed short-edge
  // targets (720p/1080p/1440p/2160p/4K, matching the project's aspect).
  // The long edge is capped at 8K so exports stay within browser memory.
  function exportResolutionOptions() {
    var s = workingSize();
    var opts = [];
    opts.push({ w: s.w, h: s.h, label: 'Working size (' + s.w + '\u00d7' + s.h + ')', ai: false });
    [2, 4, 8].forEach(function (f) {
      var w = s.w * f, h = s.h * f;
      if (Math.max(w, h) > 8192) return;
      opts.push({ w: w, h: h, label: f + '\u00d7 (' + w + '\u00d7' + h + ')', ai: f > 1 });
    });
    var aspect = s.w / s.h;
    var shortEdge = Math.min(s.w, s.h);
    [720, 1080, 1440, 2160, 3840].forEach(function (t) {
      if (t <= shortEdge) return; // only offer sizes above the working size
      var w, h;
      if (aspect >= 1) { h = t; w = Math.round(t * aspect); }
      else { w = t; h = Math.round(t / aspect); }
      w = gridSnap(w); h = gridSnap(h);
      if (Math.max(w, h) > 8192) return;
      opts.push({ w: w, h: h, label: t + 'p (' + w + '\u00d7' + h + ')', ai: true });
    });
    return opts;
  }

  // Rebuild the resolution dropdown with the current working size. Keeps the
  // user's previous choice when it still exists (matched by dimensions, so a
  // working-size change that keeps the same option available keeps it picked).
  function populateExportRes() {
    var opts = exportResolutionOptions();
    var prevOpt = opts[parseInt(el.exportRes.value, 10) || 0] || null;
    el.exportRes.innerHTML = '';
    opts.forEach(function (o, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = o.label + (o.ai ? ' \u00b7 ML upscale' : '');
      el.exportRes.appendChild(opt);
    });
    var keep = -1;
    if (prevOpt) {
      opts.forEach(function (o, i) {
        if (o.w === prevOpt.w && o.h === prevOpt.h) keep = i;
      });
    }
    el.exportRes.selectedIndex = keep >= 0 ? keep : 0;
  }

  // Upscale one composite canvas to the target size. When the target is larger
  // than the working size the ML upscaler (worker) runs first, using a 4x
  // ESRGAN-style model, and the result is resized to the exact target with high-
  // quality smoothing. Falls back to a plain high-quality resize if the model
  // can't be loaded (offline / blocked), so exports never stall.
  //
  // When `transparent` is set the backdrop is left clear (no black fill) so the
  // alpha channel survives. For the ML upscaler path we keep transparency by
  // running a second SR pass on the alpha channel (mirroring how layer alpha is
  // interpolated), so transparent exports get the same ML sharpness.
  var upscaleModelWarned = false;
  function upscaleCanvasTo(canvas, tw, th, transparent) {
    if (canvas.width === tw && canvas.height === th) return Promise.resolve(canvas);
    var bigger = tw > canvas.width || th > canvas.height;
    function drawScaled(src) {
      var c = document.createElement('canvas');
      c.width = tw; c.height = th;
      var ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      if (!transparent) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, tw, th);
      }
      drawContain(ctx, src, tw, th);
      return c;
    }
    if (!bigger) return Promise.resolve(drawScaled(canvas));
    if (workers.length) {
      return upscaleViaWorker(canvas, transparent).then(function (hi) {
        return drawScaled(hi);
      }).catch(function (err) {
        if (err && err.message === 'Cancelled') throw err;
        if (!upscaleModelWarned) {
          upscaleModelWarned = true;
          toast('ML upscaler unavailable (' + err.message + '), using high-quality resize');
        }
        return drawScaled(canvas);
      });
    }
    return Promise.resolve(drawScaled(canvas));
  }

  // Send one frame to the worker for ML 4x upscaling. Resolves with a canvas
  // at 4x the input size; the upscaler model downloads+compiles on first use
  // (progress reported through the export progress bar). When `transparent` is
  // set the worker keeps the real alpha (second SR pass on the alpha channel).
  function upscaleViaWorker(canvas, transparent) {
    return new Promise(function (resolve, reject) {
      var ctx = canvas.getContext('2d');
      var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var jobId = 'up' + (++jobSeq);
      upscaleJobs[jobId] = {
        resolve: function (r) { resolve(r); },
        reject: function (e) { reject(e); },
        onProgress: function (frac) {
          // The first job downloads the model; later jobs resolve instantly
          // and never report progress, so this only shows during download.
          if (frac >= 1) setExportProgress('Upscaler ready, rendering…', 95);
          else setExportProgress('Downloading ML upscaler ' + Math.round(frac * 100) + '%…', frac * 100);
        }
      };
      try {
        var wi = pickWorker();
        var target = workers[wi >= 0 ? wi : 0];
        target.postMessage({
          type: 'upscale',
          jobId: jobId,
          width: canvas.width,
          height: canvas.height,
          rgba: img.data.buffer,
          preserveAlpha: !!transparent
        }, [img.data.buffer]);
      } catch (err) {
        delete upscaleJobs[jobId];
        reject(err);
      }
    }).then(function (r) {
      // r = { data: ArrayBuffer, width, height }: build a canvas from it.
      // putImageData writes the full RGBA (including alpha), so a
      // transparency-preserving upscale carries its alpha into the canvas.
      var c = document.createElement('canvas');
      c.width = r.width; c.height = r.height;
      var cctx = c.getContext('2d');
      var id = cctx.createImageData(r.width, r.height);
      id.data.set(new Uint8ClampedArray(r.data));
      cctx.putImageData(id, 0, 0);
      return c;
    });
  }

  // Composite one playback frame and size it to the export target.
  // `transparent` keeps the alpha channel intact (used by PNG exports so the
  // background stays clear instead of being filled white/black).
  function exportCanvas(f, target, transparent) {
    return compositeCanvas(f.time, transparent).then(function (c) {
      return upscaleCanvasTo(c, target.w, target.h, transparent);
    });
  }

  // Shared cancel state for export runs (PNG/GIF/frame chains). MP4 uses its
  // own recorder stop; both are routed from the same Stop button.
  function beginExport() {
    state.exporting = true;
    state.exportCancel = false;
  }
  function endExport() {
    state.exporting = false;
    state.exportCancel = false;
  }
  function cancelExport() {
    if (!state.exporting) return;
    state.exportCancel = true;
    workers.forEach(function (w) {
      try { w.postMessage({ type: 'cancel-upscale' }); } catch (e) {}
    });
  }

  // Export progress overlay (mirrors the launch model-loading overlay)
  function showExportOverlay(title, sub) {
    el.exportTitle.textContent = title;
    el.exportSub.textContent = sub || '';
    el.exportFill.style.width = '0%';
    el.exportLabel.textContent = '';
    el.exportMeta.textContent = '';
    el.exportOverlay.classList.remove('hidden');
  }
  function setExportProgress(label, pct) {
    el.exportFill.style.width = clamp(pct, 0, 100) + '%';
    el.exportLabel.textContent = label;
    el.exportMeta.textContent = Math.round(pct) + '%';
  }
  function hideExportOverlay() {
    el.exportOverlay.classList.add('hidden');
  }

  // Resolves once every generated frame is done: no active generation run, no
  // queued regeneration, and no incomplete gaps. If frames are still missing it
  // kicks off generation and waits, so an export never captures half-finished
  // inbetweens. Rejects with 'Export cancelled' if the user stops the wait.
  function waitForGeneration() {
    return new Promise(function (resolve, reject) {
      var tries = 0;
      (function check() {
        if (state.exportCancel) { reject(new Error('Export cancelled')); return; }
        var busy = state.genRun || state.pendingRegen;
        var incomplete = allGaps().filter(function (g) {
          return g.genCount > 0 && !gapComplete(g);
        }).length;
        if (!busy && incomplete === 0) { resolve(); return; }
        if (!busy && incomplete > 0) {
          // Nothing running but frames missing (e.g. after a cancel): start a
          // run so the export waits for a complete timeline.
          scheduleGenerate(50);
        }
        // Safety cap (~2 min) so a stuck state can't block exports forever.
        if (tries++ > 600) { resolve(); return; }
        setTimeout(check, 200);
      })();
    });
  }

  function exportPNGZip(target) {
    var frames = buildPlaybackFrames();
    if (!frames.length) { toast('Nothing to export.'); return; }
    setExportProgress('Building PNG sequence…', 1);
    var chain = Promise.resolve();
    var files = [];
    frames.forEach(function (f, i) {
      chain = chain.then(function () {
        if (state.exportCancel) throw new Error('Export cancelled');
        // PNG sequence keeps transparency (no white backdrop).
        return exportCanvas(f, target, true).then(function (canvas) {
          return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
        }).then(function (blob) {
          return blob.arrayBuffer();
        }).then(function (buf) {
          files.push({ name: 'frame_' + pad(i + 1, 4) + '.png', data: new Uint8Array(buf) });
          setExportProgress('Rendering ' + (i + 1) + '/' + frames.length, ((i + 1) / frames.length) * 100);
        });
      });
    });
    chain.then(function () {
      if (state.exportCancel) throw new Error('Export cancelled');
      var zip = makeZip(files);
      downloadBlob(zip, 'animation-frames.zip', 'application/zip');
      hideExportOverlay();
      endExport();
      setGenStatus('ready', 'PNG sequence exported \u2713');
    }).catch(function (err) {
      endExport();
      hideExportOverlay();
      setGenStatus('error', 'Export failed: ' + err.message);
    });
  }

  function exportGIF(target) {
    var frames = buildPlaybackFrames();
    if (!frames.length) { toast('Nothing to export.'); return; }
    if (!gifenc) { toast('GIF encoder not available.'); return; }
    setExportProgress('Encoding GIF…', 1);
    var gif = gifenc.GIFEncoder();
    // Each frame holds for its real timeline duration (holds + gap spacing),
    // exactly like playback. gifenc takes delay in ms and quantizes to 10ms.
    var durs = playbackDurations(frames);
    var chain = Promise.resolve();
    frames.forEach(function (f, i) {
      chain = chain.then(function () {
        if (state.exportCancel) throw new Error('Export cancelled');
        return exportCanvas(f, target).then(function (canvas) {
          return canvas.getContext('2d').getImageData(0, 0, target.w, target.h).data;
        }).then(function (rgba) {
          var palette = gifenc.quantize(rgba, 256);
          var index = gifenc.applyPalette(rgba, palette);
          gif.writeFrame(index, target.w, target.h, { delay: Math.round(durs[i] * 1000), palette: palette });
          setExportProgress('Quantizing ' + (i + 1) + '/' + frames.length, ((i + 1) / frames.length) * 100);
        });
      });
    });
    chain.then(function () {
      if (state.exportCancel) throw new Error('Export cancelled');
      gif.finish();
      downloadBlob(new Blob([gif.bytes()], { type: 'image/gif' }), 'animation.gif');
      hideExportOverlay();
      endExport();
      setGenStatus('ready', 'GIF exported \u2713');
    }).catch(function (err) {
      endExport();
      hideExportOverlay();
      setGenStatus('error', 'GIF export failed: ' + err.message);
    });
  }

  // MP4 export (WebCodecs primary, MediaRecorder fallback)
  // MediaRecorder H.264 is known to silently produce empty recordings for very
  // large (4K-class) canvases, so for big targets prefer WebM/VP9, which
  // handles large frames reliably.
  // Video container formats for export. Each maps to a Mediabunny output
  // format class, the codec families that container accepts (tried in order,
  // probed for real encoder support per browser), and download metadata.
  var EXPORT_FORMATS = {
    mp4:  { label: 'MP4',     fmt: 'Mp4OutputFormat',    ext: 'mp4',  mime: 'video/mp4',        codecs: ['avc', 'vp9', 'av1'], opts: { fastStart: 'in-memory' }, recordable: true  },
    webm: { label: 'WebM',    fmt: 'WebMOutputFormat',   ext: 'webm', mime: 'video/webm',       codecs: ['vp9', 'av1', 'vp8'], opts: {}, recordable: true, preferWebm: true },
    mkv:  { label: 'MKV',     fmt: 'MkvOutputFormat',    ext: 'mkv',  mime: 'video/x-matroska', codecs: ['avc', 'vp9', 'av1'], opts: {} },
    mov:  { label: 'MOV',     fmt: 'MovOutputFormat',    ext: 'mov',  mime: 'video/quicktime',  codecs: ['avc', 'vp9', 'av1'], opts: { fastStart: 'in-memory' } },
    ts:   { label: 'MPEG-TS', fmt: 'MpegTsOutputFormat', ext: 'ts',   mime: 'video/MP2T',       codecs: ['avc', 'hevc'], opts: {} }
  };

  // Build the codec candidate list for a container from its allowed codec
  // family names. Each candidate is { codec, muxerCodec } where codec is the
  // WebCodecs string and muxerCodec the short name Mediabunny wants.
  function codecCandidates(names) {
    var avcLevels = ['640033', '64002a', '640028', '64001f', '42001f', '42E01E'];
    var list = [];
    names.forEach(function (n) {
      if (n === 'avc') avcLevels.forEach(function (l) { list.push({ codec: 'avc1.' + l, muxerCodec: 'avc' }); });
      else if (n === 'hevc') {
        list.push({ codec: 'hev1.1.6.L123.B0', muxerCodec: 'hevc' });
        list.push({ codec: 'hvc1.1.6.L123.B0', muxerCodec: 'hevc' });
      }
      else if (n === 'vp9') {
        list.push({ codec: 'vp09.00.10.08', muxerCodec: 'vp9' });
        list.push({ codec: 'vp09.00.41.08', muxerCodec: 'vp9' });
      }
      else if (n === 'av1') list.push({ codec: 'av01.0.04M.08', muxerCodec: 'av1' });
      else if (n === 'vp8') list.push({ codec: 'vp8', muxerCodec: 'vp8' });
    });
    return list;
  }

  function pickVideoMime(large, webm) {
    if (typeof window.MediaRecorder === 'undefined') return null;
    var candidates = webm
      ? ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      : large
        ? ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        : ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1.64001f', 'video/mp4',
           'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (var i = 0; i < candidates.length; i++) {
      try {
        if (window.MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
      } catch (e) { /* keep trying */ }
    }
    return null;
  }

  // How long each playback frame stays on screen during playback/export:
  // from its own time until the next frame's time (the last frame runs until
  // the end of the timeline, i.e. its keyframe hold). This keeps playback and
  // exported video in sync with the actual positions on the timeline.
  function playbackDurations(frames) {
    var end = playbackEnd();
    var durs = [];
    for (var i = 0; i < frames.length; i++) {
      var next = frames[i + 1];
      durs.push(Math.max(1 / Math.max(1, state.fps), next ? next.time - frames[i].time : end - frames[i].time));
    }
    return durs;
  }

  function exportVideo(target, fmtName) {
    var frames = buildPlaybackFrames();
    if (!frames.length) { toast('Nothing to export.'); return; }
    var fmt = EXPORT_FORMATS[fmtName] || EXPORT_FORMATS.mp4;
    // WebCodecs encodes each frame as it's produced (composite → ML-upscale →
    // encode → discard), so only one frame is in memory at a time, no matter
    // how large the export resolution is. It also handles 4K+ frames that
    // Chrome's MediaRecorder H.264 silently fails on. MediaRecorder is kept as
    // a fallback for browsers without WebCodecs (MP4/WebM only; the other
    // containers need WebCodecs muxing).
    if (window.VideoEncoder && window.Mediabunny) {
      exportVideoWebCodecs(frames, target, fmt);
      return;
    }
    if (!fmt.recordable) {
      hideExportOverlay();
      endExport();
      setGenStatus('error', fmt.label + ' export needs WebCodecs in this browser.');
      toast(fmt.label + ' export needs a browser with WebCodecs (Chrome, Edge or Safari).');
      return;
    }
    exportVideoRecorder(frames, target, fmt);
  }

  // Pick the first codec the browser's VideoEncoder really accepts for this
  // container, from the format's allowed codec families. Some browsers lie at
  // isConfigSupported/configure (notably H.264 on Firefox/Linux), so probing
  // encodes one real frame at the target size with a throwaway encoder and
  // only accepts a codec whose encoded output actually arrives.
  // Resolves with { codec, muxerCodec } or null if none are supported.
  function probeCodec(codec, w, h) {
    return new Promise(function (resolve) {
      var enc = null;
      var finished = false;
      var sawOutput = false;
      var timer = setTimeout(function () { finish(false); }, 8000);
      function finish(ok) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { if (enc) enc.close(); } catch (e) {}
        resolve(ok);
      }
      try {
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#f00';
        ctx.fillRect(0, 0, w, h);
        enc = new VideoEncoder({
          output: function () { sawOutput = true; },
          error: function () { finish(false); }
        });
        enc.configure({ codec: codec, width: w, height: h, bitrate: 10 * 1000 * 1000 });
        var frame = new VideoFrame(canvas, { timestamp: 0 });
        enc.encode(frame, { keyFrame: true });
        frame.close();
        enc.flush().then(function () { finish(sawOutput); }).catch(function () { finish(false); });
      } catch (e) {
        finish(false);
      }
    });
  }

  function pickVideoCodec(w, h, codecNames) {
    var candidates = codecCandidates(codecNames);
    var i = 0;
    function next() {
      if (i >= candidates.length) return Promise.resolve(null);
      var c = candidates[i++];
      return probeCodec(c.codec, w, h).then(function (ok) { return ok ? c : next(); });
    }
    return next();
  }

  // Encode the animation with WebCodecs + Mediabunny into the requested
  // container: each frame is composited, ML-upscaled to the target size,
  // encoded, and immediately discarded, so even 8x exports never hold more
  // than one frame in memory. Timestamps come from each frame's real duration
  // (holds + gap spacing), matching playback.
  function exportVideoWebCodecs(frames, target, fmt) {
    var durs = playbackDurations(frames);
    var memMB = Math.round(target.w * target.h * 4 / (1024 * 1024)); // one frame at a time
    if (memMB > 256) toast('One 4K-class frame is large; encoding may use ~' + memMB + ' MB.', 6000);
    setExportProgress('Encoding ' + fmt.label + '…', 1);
    pickVideoCodec(target.w, target.h, fmt.codecs).then(function (pick) {
      if (!pick) {
        if (fmt.recordable) { exportVideoRecorder(frames, target, fmt); return; }
        hideExportOverlay();
        endExport();
        setGenStatus('error', 'This browser has no encoder for ' + fmt.label + '.');
        toast('No ' + fmt.label + ' encoder in this browser. Try MP4 or WebM instead.');
        return;
      }
      var MB = window.Mediabunny;
      var muxer = new MB.Output({
        format: new MB[fmt.fmt](fmt.opts),
        target: new MB.BufferTarget()
      });
      var videoSource = new MB.EncodedVideoPacketSource(pick.muxerCodec);
      muxer.addVideoTrack(videoSource);
      var encodeError = null;
      var addChain = Promise.resolve(); // drains Mediabunny's backpressure in order
      var encoder = new VideoEncoder({
        output: function (chunk, meta) {
          // Mediabunny needs a colorSpace in the decoder config (VP9/AV1 in
          // particular); some encoders omit it, so supply a sane default.
          if (meta && meta.decoderConfig && !meta.decoderConfig.colorSpace) {
            meta.decoderConfig.colorSpace = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
          }
          var packet = MB.EncodedPacket.fromEncodedChunk(chunk);
          addChain = addChain
            .then(function () { return videoSource.add(packet, meta); })
            .catch(function (e) { if (!encodeError) encodeError = e; });
        },
        error: function (e) { encodeError = e; }
      });
      encoder.configure({ codec: pick.codec, width: target.w, height: target.h, bitrate: 10 * 1000 * 1000 });

      var ts = 0; // microseconds
      var chain = muxer.start().then(function () {
        var seq = Promise.resolve();
        frames.forEach(function (f, i) {
          seq = seq.then(function () {
            if (state.exportCancel) throw new Error('Export cancelled');
            if (encodeError) throw encodeError;
            return exportCanvas(f, target).then(function (canvas) {
              var frame = new VideoFrame(canvas, { timestamp: ts });
              encoder.encode(frame, { keyFrame: i % (Math.max(1, state.fps) * 2) === 0 });
              frame.close();
              ts += Math.round(durs[i] * 1e6);
              setExportProgress('Encoding frame ' + (i + 1) + '/' + frames.length, ((i + 1) / frames.length) * 100);
            });
          });
        });
        return seq;
      }).then(function () {
        if (state.exportCancel) throw new Error('Export cancelled');
        return encoder.flush();
      }).then(function () {
        // Wait for every encoded chunk to be muxed before finalizing.
        return addChain;
      }).then(function () {
        if (encodeError) throw encodeError;
        return muxer.finalize();
      }).then(function () {
        var buf = muxer.target.buffer;
        if (!buf || !buf.byteLength) throw new Error('Encoding produced no data');
        downloadBlob(new Blob([buf], { type: fmt.mime }), 'animation.' + fmt.ext);
        hideExportOverlay();
        endExport();
        setGenStatus('ready', fmt.label + ' exported \u2713');
      }).catch(function (err) {
        try { encoder.close(); } catch (e2) {}
        try { muxer.cancel().catch(function () {}); } catch (e3) {}
        endExport();
        hideExportOverlay();
        if (err && err.message === 'Export cancelled') setGenStatus('error', 'Export cancelled');
        else setGenStatus('error', fmt.label + ' export failed: ' + err.message);
      });
    }).catch(function (err) {
      endExport();
      hideExportOverlay();
      setGenStatus('error', fmt.label + ' export failed: ' + err.message);
    });
  }

  // Fallback: MediaRecorder canvas capture (browsers without WebCodecs).
  // Only MP4 and WebM can be produced this way.
  function exportVideoRecorder(frames, target, fmt) {
    var large = target.w * target.h > 1920 * 1080; // H.264 MediaRecorder is fragile at 4K+
    var mime = pickVideoMime(large, fmt.preferWebm);
    if (!mime) {
      setGenStatus('error', 'Video recording is not supported in this browser.');
      hideExportOverlay();
      endExport();
      toast('This browser cannot record video. Use Chrome, Edge or Safari for ' + fmt.label + ' export.');
      return;
    }
    var isMp4 = mime.indexOf('mp4') !== -1;
    var canvas = document.createElement('canvas');
    canvas.width = target.w;
    canvas.height = target.h;
    var ctx = canvas.getContext('2d');
    if (typeof canvas.captureStream !== 'function') {
      hideExportOverlay();
      endExport();
      setGenStatus('error', 'This browser cannot capture canvas video.');
      toast('Canvas video capture is not supported here.');
      return;
    }
    // High-res exports hold every frame in memory while recording; warn when
    // that gets heavy so the user can pick a lower resolution if they want.
    var memMB = Math.round(target.w * target.h * 4 * frames.length / (1024 * 1024));
    if (memMB > 512) toast('This export may use ~' + memMB + ' MB of memory. A lower resolution is faster.', 7000);

    setExportProgress((isMp4 ? 'Recording MP4…' : 'Recording WebM…'), 1);

    // Frames are rendered one at a time (the worker runs one upscale job at a
    // time), so a long high-res export streams through the progress bar.
    var rendered = null;
    var chain = Promise.resolve();
    var canvases = [];
    frames.forEach(function (f, i) {
      chain = chain.then(function () {
        if (state.exportCancel) throw new Error('Export cancelled');
        return exportCanvas(f, target).then(function (c) {
          canvases.push(c);
          setExportProgress('Upscaling frame ' + (i + 1) + '/' + frames.length, ((i + 1) / frames.length) * 90);
        });
      });
    });
    chain.then(function () {
      if (state.exportCancel) throw new Error('Export cancelled');
      rendered = canvases;
      // captureStream(0) + requestFrame() delivers each drawn frame to the
      // recorder explicitly. The old rAF-driven approach let captureStream
      // sample the canvas passively, which produced empty recordings when the
      // frame loop was throttled (long upscale pre-render, background tab) or
      // the canvas was large. With requestFrame the recording is deterministic.
      var stream = canvas.captureStream(0);
      var track = stream.getVideoTracks && stream.getVideoTracks()[0];
      var useRequestFrame = !!(track && typeof track.requestFrame === 'function');
      var recorder;
      try {
        recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10 * 1000 * 1000 });
      } catch (e) {
        endExport();
        hideExportOverlay();
        setGenStatus('error', 'Could not start recorder: ' + e.message);
        toast('Recorder failed: ' + e.message);
        return;
      }
      var chunks = [];
      var stopped = false;
      var aborted = false;
      recorder.ondataavailable = function (e) {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      recorder.onstop = function () {
        if (stopped) return;
        stopped = true;
        endExport();
        hideExportOverlay();
        if (aborted) {
          setGenStatus('error', 'Export cancelled');
          return;
        }
        var blob = new Blob(chunks, { type: isMp4 ? 'video/mp4' : 'video/webm' });
        if (!blob.size) {
          setGenStatus('error', 'Recording produced no data. Try again.');
          return;
        }
        downloadBlob(blob, isMp4 ? 'animation.mp4' : 'animation.webm', blob.type);
        setGenStatus('ready', fmt.label + ' exported \u2713');
      };
      recorder.onerror = function () {
        endExport();
        hideExportOverlay();
        setGenStatus('error', 'Recording failed.');
      };
      state.mp4Stop = function () {
        try { recorder.stop(); } catch (e) {}
      };

      var durs = playbackDurations(frames);
      var finished = false;
      recorder.start();
      if (useRequestFrame) {
        // Draw each frame once, push it to the recorder with requestFrame,
        // hold for its real duration, then free its bitmap. setTimeout keeps
        // running even if the tab is backgrounded, so the recording always
        // produces data instead of silently capturing nothing.
        var cur = 0;
        function recordNext() {
          if (finished) return;
          if (state.exportCancel) {
            finished = true;
            aborted = true;
            state.mp4Stop();
            state.mp4Stop = null;
            return;
          }
          if (cur >= frames.length) {
            finished = true;
            setTimeout(function () { state.mp4Stop(); state.mp4Stop = null; }, 200);
            return;
          }
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, target.w, target.h);
          ctx.drawImage(rendered[cur], 0, 0, target.w, target.h);
          track.requestFrame();
          setExportProgress('Recording frame ' + (cur + 1) + '/' + frames.length, 90 + ((cur + 1) / frames.length) * 10);
          rendered[cur] = null; // free the frame bitmap now that it's captured
          var hold = Math.max(10, Math.round(durs[cur] * 1000));
          cur++;
          setTimeout(recordNext, hold);
        }
        setTimeout(recordNext, 300); // small delay so the recorder is ready
      } else {
        // Fallback (browsers without requestFrame): paint the canvas every
        // animation frame and let captureStream sample it at the project FPS.
        var totalDur = 0;
        durs.forEach(function (d) { totalDur += d; });
        var t0 = performance.now() + 300;
        var idx = -1;
        function draw(now) {
          if (finished) return;
          if (now < t0) { requestAnimationFrame(draw); return; }
          // Advance through frames using each frame's real duration on the
          // timeline (holds + gap spacing), matching what playback shows.
          var elapsed = (now - t0) / 1000;
          var next = frames.length - 1;
          var acc = 0;
          for (var i = 0; i < frames.length - 1; i++) {
            if (elapsed < acc + durs[i]) { next = i; break; }
            acc += durs[i];
          }
          if (next !== idx) {
            idx = next;
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, target.w, target.h);
            // Canvases are already at target size; draw full-bleed (aspect is
            // preserved by the upscale pipeline, so no letterboxing needed).
            ctx.drawImage(rendered[idx], 0, 0, target.w, target.h);
            setExportProgress('Recording frame ' + (idx + 1) + '/' + frames.length, 90 + ((idx + 1) / frames.length) * 10);
          }
          // Keep the final frame on screen for its own hold, then stop.
          if (elapsed >= totalDur) {
            finished = true;
            setTimeout(function () { state.mp4Stop(); state.mp4Stop = null; }, 200);
            return;
          }
          requestAnimationFrame(draw);
        }
        requestAnimationFrame(draw);
      }
      }).catch(function (err) {
        endExport();
        hideExportOverlay();
        if (err && err.message === 'Export cancelled') {
          if (state.mp4Stop) { state.mp4Stop(); state.mp4Stop = null; }
          setGenStatus('error', 'Export cancelled');
        } else {
          setGenStatus('error', 'Export failed: ' + err.message);
        }
      });
  }

  function exportCurrentFrame(target) {
    if (!buildPlaybackFrames().length) { toast('Nothing to export.'); return; }
    setExportProgress('Exporting frame…', 5);
    exportCanvas({ time: state.playhead }, target, true).then(function (canvas) {
      return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      downloadFrame(url, 'frame_' + pad(state.curIndex + 1, 4) + '.png');
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      hideExportOverlay();
      endExport();
      setGenStatus('ready', 'Frame exported \u2713');
    }).catch(function (err) {
      endExport();
      hideExportOverlay();
      setGenStatus('error', 'Export failed: ' + err.message);
    });
  }

  // Shared entry point: run the selected format at the selected resolution.
  // Shows the export overlay, waits for generation to finish (so the export
  // never captures half-finished inbetweens), then dispatches.
  function runExport() {
    var fmt = el.exportFormat.value;
    var opts = exportResolutionOptions();
    var idx = parseInt(el.exportRes.value, 10) || 0;
    var opt = opts[idx] || opts[0];
    var target = { w: opt.w, h: opt.h };
    // Fail fast before the overlay goes up so it can't get stuck.
    if (!buildPlaybackFrames().length) { toast('Nothing to export.'); return; }
    if (fmt === 'gif' && !gifenc) { toast('GIF encoder not available.'); return; }
    closeMenus();
    beginExport();
    var fmtLabel = EXPORT_FORMATS[fmt] ? EXPORT_FORMATS[fmt].label : fmt.toUpperCase();
    showExportOverlay(
      fmt === 'frame' ? 'Exporting current frame' : 'Exporting ' + fmtLabel,
      opt.label + (opt.ai ? ' · ML upscale' : '')
    );
    setExportProgress('Waiting for frames to finish generating…', 0);
    waitForGeneration().then(function () {
      if (state.exportCancel) throw new Error('Export cancelled');
      if (fmt === 'png') exportPNGZip(target);
      else if (fmt === 'gif') exportGIF(target);
      else if (fmt === 'frame') exportCurrentFrame(target);
      else exportVideo(target, fmt);
    }).catch(function (err) {
      endExport();
      hideExportOverlay();
      var cancelled = err && err.message === 'Export cancelled';
      setGenStatus('error', cancelled ? 'Export cancelled' : 'Export failed: ' + err.message);
    });
  }
