'use strict';


  // Reference audio track: an optional sound file that plays in sync with the
  // timeline (a scratch / reference track for animation timing). Decoding uses
  // the Web Audio API; live playback uses a plain <audio> element synced to the
  // timeline playhead. The file is stored (as a data URL) in the project so it
  // survives save / load, but the decoded buffer is derived on demand.
  var audioEl = null;
  var audioCtx = null;
  var audioBufferCache = null; // decoded AudioBuffer
  var audioPeaks = null;       // downsampled [-1..1] envelope for the waveform

  function ensureAudioEl() {
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.preload = 'auto';
    }
    return audioEl;
  }

  function audioDuration() {
    if (audioBufferCache) return audioBufferCache.duration;
    return state.audio && state.audio.duration ? state.audio.duration : 0;
  }

  function decodeAudioDataUrl(dataUrl) {
    return new Promise(function (resolve, reject) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { reject(new Error('Web Audio is not supported in this browser')); return; }
        if (!audioCtx) audioCtx = new AC();
        var b64 = String(dataUrl).split(',')[1];
        if (!b64) { reject(new Error('Bad audio data')); return; }
        var bin = atob(b64);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        audioCtx.decodeAudioData(arr.buffer.slice(0), function (buf) { resolve(buf); }, function (e) { reject(e || new Error('Could not decode audio')); });
      } catch (e) { reject(e); }
    });
  }

  function computePeaks(buffer, buckets) {
    var ch = buffer.getChannelData(0);
    var n = ch.length;
    var out = new Float32Array(buckets);
    var step = n / buckets;
    for (var b = 0; b < buckets; b++) {
      var s = Math.floor(b * step), e = Math.floor((b + 1) * step);
      var peak = 0;
      for (var i = s; i < e; i++) {
        var v = Math.abs(ch[i]);
        if (v > peak) peak = v;
      }
      out[b] = peak;
    }
    return out;
  }

  // (Re)derive the decoded buffer + waveform peaks from the saved audio src,
  // e.g. after loading a project file. Decoding itself doesn't need a user
  // gesture (only playback does), so this is safe on load.
  function initAudioFromProject() {
    if (!state.audio || !state.audio.src) {
      audioBufferCache = null;
      audioPeaks = null;
      renderAudioLane();
      return;
    }
    decodeAudioDataUrl(state.audio.src).then(function (buf) {
      audioBufferCache = buf;
      audioPeaks = buf ? computePeaks(buf, 2000) : null;
      syncAudioEl();
      renderAudioLane();
    }).catch(function () {
      audioBufferCache = null;
      audioPeaks = null;
      renderAudioLane();
    });
  }

  function loadAudioFile(file) {
    if (!file) return Promise.resolve(null);
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var src = reader.result;
        decodeAudioDataUrl(src).then(function (buf) {
          recordUndo('audio');
          state.audio = {
            src: src,
            name: file.name || 'audio',
            duration: buf ? buf.duration : 0,
            muted: !!state.audio.muted
          };
          audioBufferCache = buf;
          audioPeaks = buf ? computePeaks(buf, 2000) : null;
          syncAudioEl(); // point the <audio> element at the source so paused seeks work
          renderAll();
          toast('Audio loaded: ' + state.audio.name);
          resolve(state.audio);
        }).catch(function (e) {
          toast('Could not load audio: ' + (e && e.message ? e.message : e));
          reject(e);
        });
      };
      reader.onerror = function () { reject(new Error('Could not read the audio file')); };
      reader.readAsDataURL(file);
    });
  }

  function removeAudio() {
    if (!state.audio || !state.audio.src) return;
    recordUndo('audio');
    pause();
    state.audio = { src: null, name: null, duration: 0, muted: !!state.audio.muted };
    audioBufferCache = null;
    audioPeaks = null;
    if (audioEl) { audioEl.pause(); audioEl.removeAttribute('src'); }
    renderAll();
    toast('Audio removed');
  }

  function audioEnabled() { return !!(state.audio && state.audio.src); }

  function syncAudioEl() {
    if (!audioEnabled()) return;
    if (!audioEl) ensureAudioEl();
    if (audioEl.src !== state.audio.src) audioEl.src = state.audio.src;
    audioEl.muted = !!state.audio.muted;
  }

  // Live playback sync (called from playback.js).
  function audioPlay(start) {
    if (!audioEnabled()) return;
    syncAudioEl();
    var d = audioDuration();
    try { audioEl.currentTime = Math.max(0, Math.min(start || 0, d)); } catch (e) {}
    var p = audioEl.play();
    if (p && p.catch) p.catch(function () {});
  }

  function audioPause() {
    if (audioEl) audioEl.pause();
  }

  // Seek the audio to time t. Only used while paused / scrubbing; during
  // playback the element runs on its own so it stays in sync without stutter.
  function audioSeek(t) {
    if (!audioEl || !audioEnabled()) return;
    var d = audioDuration();
    try { audioEl.currentTime = Math.max(0, Math.min(t, d)); } catch (e) {}
  }

  function setAudioMuted(muted) {
    recordUndo('audio');
    state.audio.muted = !!muted;
    syncAudioEl();
    renderAudioPanel();
  }

  function renderAudioPanel() {
    var nameEl = byId('audioName');
    var muteEl = byId('audioMute');
    var loadEl = byId('btnAudioLoad');
    var removeEl = byId('btnAudioRemove');
    var wrap = byId('audioWrap');
    if (wrap) wrap.classList.toggle('has-audio', audioEnabled());
    if (nameEl) nameEl.textContent = audioEnabled() ? (state.audio.name || 'audio') : 'No audio loaded';
    if (muteEl) { muteEl.checked = !!(state.audio && state.audio.muted); muteEl.disabled = !audioEnabled(); }
    if (loadEl) loadEl.classList.toggle('hidden', audioEnabled());
    if (removeEl) removeEl.classList.toggle('hidden', !audioEnabled());
  }

  // Draw the waveform into the timeline audio lane, aligned to timeline time.
  function renderAudioLane() {
    var lane = byId('audioLane');
    var canvas = byId('audioCanvas');
    if (!lane || !canvas) return;
    if (!audioEnabled() || !audioPeaks) {
      lane.classList.add('hidden');
      return;
    }
    lane.classList.remove('hidden');
    var z = state.zoom;
    var dur = audioDuration() || 0;
    var fullW = Math.max(el.timeline.clientWidth, GUTTER_W + dur * z + 60);
    lane.style.width = fullW + 'px';
    canvas.width = fullW;
    canvas.height = lane.clientHeight || 46;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, fullW, canvas.height);
    var mid = canvas.height / 2;
    var buckets = audioPeaks.length;
    var scale = (canvas.width) / buckets;
    ctx.fillStyle = 'rgba(120, 180, 130, 0.8)';
    for (var b = 0; b < buckets; b++) {
      var t0 = (b / buckets) * dur;
      var x = GUTTER_W + t0 * z;
      if (x < GUTTER_W) continue;
      var h = Math.max(1, audioPeaks[b] * (canvas.height - 6));
      ctx.fillRect(x, mid - h / 2, Math.max(1, scale * z * (dur / buckets)), h);
    }
  }

  // Seek from a click in the audio lane (same time mapping as the timeline).
  function audioLaneSeek(clientX) {
    var rect = el.timeline.getBoundingClientRect();
    var x = clientX - rect.left + el.timeline.scrollLeft - GUTTER_W;
    var t = x / state.zoom;
    if (t < 0) t = 0;
    pause();
    setFrameByTime(t);
  }
