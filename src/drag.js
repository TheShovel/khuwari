'use strict';


  function timeFromClientX(clientX) {
    var rect = el.timeline.getBoundingClientRect();
    var x = clientX - rect.left + el.timeline.scrollLeft - GUTTER_W;
    return x / state.zoom;
  }

  function startKfDrag(e, chip) {
    var id = chip.dataset.id;
    var kf = state.keyframes.find(function (k) { return k.id === id; });
    if (!kf) return;
    e.preventDefault();
    e.stopPropagation();
    selectKeyframe(id);
    var startX = e.clientX;
    var startTime = kf.time;
    var moved = false;
    var tip = document.createElement('div');
    tip.className = 'kf-drag-tip';
    chip.appendChild(tip);
    // After a live renderLane() the chip is rebuilt, so re-attach the tip to
    // the fresh element for this keyframe.
    function attachTip() {
      var fresh = el.lane.querySelector('.kf[data-id="' + id + '"]');
      if (fresh) fresh.appendChild(tip);
    }
    function updateTip(t) { tip.textContent = fmtTime(t); }
    updateTip(startTime);

    var started = false;
    function onMove(ev) {
      if (!started) { started = true; recordUndo(); }
      var dt = (ev.clientX - startX) / state.zoom;
      var t = Math.max(0, startTime + dt);
      // No clamping against neighbours: a keyframe can be dragged in front of
      // or behind other keyframes. Gaps are always derived from the time-sorted
      // order, so crossing simply reorders the sequence and everything follows.
      if (state.snap) t = Math.round(t * state.fps) / state.fps;
      kf.time = t;
      retimeAllFrames();
      renderLane();
      attachTip();
      updateTip(t);
      moved = true;
    }
    function onUp() {
      tip.remove();
      el.timeline.removeEventListener('pointermove', onMove);
      el.timeline.removeEventListener('pointerup', onUp);
      el.timeline.removeEventListener('pointercancel', onUp);
      if (moved) {
        invalidateAround(id);
        refreshDirty();
        renderAll();
        scheduleGenerate(300);
      } else {
        renderLane();
      }
    }
    el.timeline.addEventListener('pointermove', onMove);
    el.timeline.addEventListener('pointerup', onUp);
    el.timeline.addEventListener('pointercancel', onUp);
    try { el.timeline.setPointerCapture(e.pointerId); } catch (err) {}
  }

  // Resize a keyframe's hold duration by dragging its right edge.
  function startKfResize(e, chip) {
    var id = chip.dataset.id;
    var kf = state.keyframes.find(function (k) { return k.id === id; });
    if (!kf) return;
    e.preventDefault();
    e.stopPropagation();
    selectKeyframe(id);
    var startX = e.clientX;
    var startHold = keyframeHold(kf);
    var minHold = 1 / state.fps;
    var moved = false;
    var tip = document.createElement('div');
    tip.className = 'kf-drag-tip';
    chip.appendChild(tip);
    function attachTip() {
      var fresh = el.lane.querySelector('.kf[data-id="' + id + '"]');
      if (fresh) fresh.appendChild(tip);
    }
    function updateTip(h) { tip.textContent = fmtTime(h) + ' hold'; }
    updateTip(startHold);

    var started = false;
    function onMove(ev) {
      if (!started) { started = true; recordUndo(); }
      var dh = (ev.clientX - startX) / state.zoom;
      var h = Math.max(minHold, startHold + dh);
      // Don't push the hold past the next keyframe's start (on this layer).
      var sorted = sortedKeyframes(kf.layer);
      var idx = sorted.indexOf(kf);
      if (idx < sorted.length - 1) {
        h = Math.min(h, Math.max(minHold, sorted[idx + 1].time - kf.time));
      }
      if (state.snap) h = Math.round(h * state.fps) / state.fps;
      h = Math.max(minHold, h);
      kf.hold = h;
      retimeAllFrames();
      renderLane();
      attachTip();
      updateTip(h);
      moved = true;
    }
    function onUp() {
      tip.remove();
      el.timeline.removeEventListener('pointermove', onMove);
      el.timeline.removeEventListener('pointerup', onUp);
      el.timeline.removeEventListener('pointercancel', onUp);
      if (moved) {
        invalidateAround(id);
        refreshDirty();
        renderAll();
        scheduleGenerate(300);
      } else {
        renderLane();
      }
    }
    el.timeline.addEventListener('pointermove', onMove);
    el.timeline.addEventListener('pointerup', onUp);
    el.timeline.addEventListener('pointercancel', onUp);
    try { el.timeline.setPointerCapture(e.pointerId); } catch (err) {}
  }

  // Drag a color-dot chip on the timeline: the body moves the whole active
  // window, the edges resize start/end. Dots never interpolate; only their
  // window shifts.
  function startDotDrag(e, chip) {
    var id = chip.dataset.dot;
    var d = dotById(id);
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    // Read the chip's rect BEFORE selectDot: it re-renders the lane and
    // detaches this element, and a detached element reports a zero rect,
    // which would make the edge test below always pick 'end' (resize).
    var rect = chip.getBoundingClientRect();
    var edge = 'body';
    if (e.clientX - rect.left < 8) edge = 'start';
    else if (rect.right - e.clientX < 8) edge = 'end';
    selectDot(id);
    var startX = e.clientX;
    var s0 = d.start, e0 = d.end;
    var moved = false;
    var tip = document.createElement('div');
    tip.className = 'kf-drag-tip';
    chip.appendChild(tip);
    function attachTip() {
      var fresh = el.lane.querySelector('.fill-dot[data-dot="' + id + '"]');
      if (fresh) fresh.appendChild(tip);
    }
    function updateTip() { tip.textContent = fmtTime(d.start) + ' to ' + fmtTime(d.end); }
    updateTip();

    var started = false;
    function onMove(ev) {
      if (!started) { started = true; recordUndo(); }
      var dt = (ev.clientX - startX) / state.zoom;
      var snapT = function (t) { return state.snap ? Math.round(t * state.fps) / state.fps : t; };
      var minDur = 1 / state.fps;
      if (edge === 'body') {
        var ns = Math.max(0, snapT(s0 + dt));
        var ne = Math.max(ns + minDur, e0 + (ns - s0));
        d.start = ns; d.end = ne;
      } else if (edge === 'start') {
        d.start = Math.min(snapT(s0 + dt), e0 - minDur);
      } else {
        d.end = Math.max(snapT(e0 + dt), d.start + minDur);
      }
      if (d.start < 0) { d.end -= d.start; d.start = 0; }
      moved = true;
      renderLane();
      attachTip();
      updateTip();
      renderPreview();
    }
    function onUp() {
      tip.remove();
      el.timeline.removeEventListener('pointermove', onMove);
      el.timeline.removeEventListener('pointerup', onUp);
      el.timeline.removeEventListener('pointercancel', onUp);
      if (moved) {
        renderAll();
        invalidateDots();
      } else {
        renderLane();
      }
    }
    el.timeline.addEventListener('pointermove', onMove);
    el.timeline.addEventListener('pointerup', onUp);
    el.timeline.addEventListener('pointercancel', onUp);
    try { el.timeline.setPointerCapture(e.pointerId); } catch (err) {}
  }

  // Drag a camera keyframe chip along the timeline to retime it. Double-click
  // (handled in renderCameraRow) removes it.
  function startCameraDrag(e, chip) {
    var t0 = parseFloat(chip.dataset.t);
    if (isNaN(t0)) return;
    e.preventDefault();
    e.stopPropagation();
    var startX = e.clientX;
    var keyObj = null;
    for (var i = 0; i < state.camera.keys.length; i++) {
      if (Math.abs(state.camera.keys[i].t - t0) < 1e-6) { keyObj = state.camera.keys[i]; break; }
    }
    if (!keyObj) return;
    var moved = false;
    function onMove(ev) {
      var dt = (ev.clientX - startX) / state.zoom;
      var t = Math.max(0, t0 + dt);
      if (state.snap) t = Math.round(t * state.fps) / state.fps;
      keyObj.t = t;
      moved = true;
      renderLane();
      renderPreview();
    }
    function onUp() {
      el.lane.removeEventListener('pointermove', onMove);
      el.lane.removeEventListener('pointerup', onUp);
      el.lane.removeEventListener('pointercancel', onUp);
      if (moved) renderAll(); else setFrameByTime(keyObj.t);
    }
    recordUndo('camera');
    el.lane.addEventListener('pointermove', onMove);
    el.lane.addEventListener('pointerup', onUp);
    el.lane.addEventListener('pointercancel', onUp);
    try { el.lane.setPointerCapture(e.pointerId); } catch (err) {}
  }

  function startScrub(e) {
    e.preventDefault();
    if (state.playing) pause(); // scrubbing is a manual override; stop playback
    try { el.timeline.setPointerCapture(e.pointerId); } catch (err) {}
    setFrameByTime(timeFromClientX(e.clientX));
    function onMove(ev) { setFrameByTime(timeFromClientX(ev.clientX)); }
    function onUp() {
      el.timeline.removeEventListener('pointermove', onMove);
      el.timeline.removeEventListener('pointerup', onUp);
      el.timeline.removeEventListener('pointercancel', onUp);
      // With Snap on, settle the playhead onto the nearest playback frame;
      // otherwise it stays exactly where the user left it.
      if (state.snap) snapPlayheadToNearestFrame();
    }
    el.timeline.addEventListener('pointermove', onMove);
    el.timeline.addEventListener('pointerup', onUp);
    el.timeline.addEventListener('pointercancel', onUp);
  }
