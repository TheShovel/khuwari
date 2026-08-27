'use strict';


  function setFrameByIndex(idx) {
    var frames = buildPlaybackFrames();
    if (!frames.length) { state.curIndex = 0; state.playhead = 0; }
    else {
      state.curIndex = clamp(Math.round(idx), 0, frames.length - 1);
      state.playhead = frames[state.curIndex].time;
    }
    renderPreview();
    renderPlayhead();
    updateTransport();
    highlightCurrentThumb();
    if (typeof renderCameraPanel === 'function') renderCameraPanel();
  }

  function setFrameByTime(t) {
    var frames = buildPlaybackFrames();
    if (!frames.length) { state.curIndex = 0; state.playhead = 0; }
    else {
      var idx = 0;
      for (var i = 0; i < frames.length; i++) {
        if (frames[i].time <= t + 1e-9) idx = i; else break;
      }
      state.curIndex = idx;
      // Keep the playhead exactly where the user scrubbed instead of snapping
      // it to a frame boundary, so it can sit anywhere between frames.
      state.playhead = Math.max(0, t);
    }
    renderPreview();
    renderPlayhead();
    updateTransport();
    highlightCurrentThumb();
    if (typeof renderCameraPanel === 'function') renderCameraPanel();
    if (state.audio && state.audio.src && !state.playing) audioSeek(t);
  }

  // Used at the end of a scrub when Snap is on: settle the playhead on the
  // nearest playback frame (either a keyframe or a generated inbetween).
  function snapPlayheadToNearestFrame() {
    var frames = buildPlaybackFrames();
    if (!frames.length) return;
    var t = state.playhead;
    var best = 0, bestD = Infinity;
    for (var i = 0; i < frames.length; i++) {
      var d = Math.abs(frames[i].time - t);
      if (d < bestD) { bestD = d; best = i; }
    }
    setFrameByTime(frames[best].time);
  }

  function highlightCurrentThumb() {
    var thumbs = el.filmstrip.children;
    for (var i = 0; i < thumbs.length; i++) {
      thumbs[i].classList.toggle('current', i === state.curIndex);
    }
  }

  // Time-based playback: the playhead advances in real time (1 second of
  // timeline per 1 second of wall clock) and the frame under the playhead is
  // displayed. Keyframe holds and gap lengths are therefore respected: a
  // keyframe that holds for 0.5s really stays on screen 0.5s, instead of
  // every frame being force-fit to exactly 1/fps.
  var playStart = 0, playStartTime = 0;
  function playbackEnd() {
    var keys = sortedKeyframes();
    if (!keys.length) return 0;
    return keys[keys.length - 1].time + keyframeHold(keys[keys.length - 1]);
  }
  function play() {
    if (state.playing || !buildPlaybackFrames().length) return;
    if (state.playhead >= playbackEnd()) state.playhead = 0;
    state.playing = true;
    lastPreview = null; // force a clean redraw, clearing editor-only ghosts/markers
    playStart = state.playhead;
    playStartTime = performance.now();
    updateTransport();
    // Decode all playback frames into memory now so the first appearance of
    // each frame is instant instead of a black flash.
    preloadPlaybackFrames();
    audioPlay(playStart);
    requestAnimationFrame(tick);
  }

  function pause() {
    state.playing = false;
    audioPause();
    updateTransport();
  }

  function togglePlay() { state.playing ? pause() : play(); }

  function tick(now) {
    if (!state.playing) return;
    var end = playbackEnd();
    state.playhead = Math.max(0, playStart + (now - playStartTime) / 1000);
    if (state.playhead >= end) {
      if (state.loop) {
        state.playhead = 0;
        playStart = 0;
        playStartTime = now;
        audioPlay(0);
      } else {
        setFrameByTime(end); // settle on the last frame and stop
        pause();
        return;
      }
    }
    setFrameByTime(state.playhead);
    if (state.playing) requestAnimationFrame(tick);
  }

  function step(delta) {
    setFrameByIndex(state.curIndex + delta);
  }

  function readImageFile(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var MAX = 2048;
        var scale = Math.min(1, MAX / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve({ img: c.toDataURL('image/png'), w: img.width, h: img.height, name: file.name || 'frame' });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read ' + (file.name || 'image'))); };
      img.src = url;
    });
  }
