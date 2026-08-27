'use strict';


  // Filmstrip thumbs are displayed at ~66×74 px, but were composited at FULL
  // work resolution: a full-res canvas render + toDataURL per thumb, per
  // refresh, on the MAIN thread during generation (canvas.toDataURL is the
  // exact Firefox-slow op the worker encode path avoids). Composite at thumb
  // scale instead (2× for retina, capped): visually identical on a 66×74 img,
  // ~20× less canvas work and a far cheaper PNG encode.
  var THUMB_MAX_W = 160;
  function compositeThumb(t) {
    var frames = framesAt(t, false);
    var tw = workW, th = workH;
    if (tw > THUMB_MAX_W) {
      var s = THUMB_MAX_W / tw;
      tw = Math.round(tw * s);
      th = Math.round(th * s);
    }
    var canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    var ctx = canvas.getContext('2d');
    return Promise.all(frames.map(function (f) {
      return loadImage(f.img).catch(function () { return null; });
    })).then(function () {
      drawComposite(ctx, layerBitmaps(t, false, tw, th), tw, th, false, cameraActive() ? cameraAt(t) : null, t);
      return canvas.toDataURL('image/png');
    });
  }

  function compositeDataURL(t) {
    return compositeCanvas(t).then(function (c) { return c.toDataURL('image/png'); });
  }

  function renderTimeline() {
    var keys = sortedKeyframes();
    var maxTime = keys.length ? keys[keys.length - 1].time : 0;
    // Fill-layer dots can extend past the last keyframe (they run on their own
    // window); make sure their window is visible on the timeline.
    state.layers.forEach(function (L) {
      if (L.type === 'fill' && L.dots) {
        L.dots.forEach(function (d) { if (d.end > maxTime) maxTime = d.end; });
      }
    });
    var contentW = Math.max(el.timeline.clientWidth, GUTTER_W + 40 + (maxTime + 2) * state.zoom);
    el.track.style.width = contentW + 'px';
    renderRuler(maxTime);
    renderLane();
    renderPlayhead();
    renderAudioLane();
    el.zoomLabel.textContent = Math.round(state.zoom) + ' px/s';
  }

  function renderRuler(maxTime) {
    el.ruler.innerHTML = '';
    // A sticky gutter matching the layer rows, so the time scale starts after
    // the layer names and stays visible when the timeline scrolls.
    var rg = document.createElement('div');
    rg.className = 'ruler-gutter';
    el.ruler.appendChild(rg);
    var steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60];
    var step = steps[0];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] * state.zoom >= 34) { step = steps[i]; break; }
    }
    var end = maxTime + 2;
    // Never flood the DOM with ticks, no matter how long/zoomed the timeline is.
    while (end / step > 3000) step *= 5;
    var minor = step >= 1 ? step / 5 : 0;
    for (var t = 0; t <= end + 1e-9; t += minor || step) {
      var isMajor = minor === 0 || Math.abs((t / step) - Math.round(t / step)) < 1e-9;
      var tick = document.createElement('div');
      tick.className = 'tick ' + (isMajor ? 'major' : 'minor');
      tick.style.left = (GUTTER_W + t * state.zoom) + 'px';
      var line = document.createElement('div');
      line.className = 'line';
      tick.appendChild(line);
      if (isMajor) {
        var label = document.createElement('span');
        label.className = 'label';
        label.textContent = fmtNum(t) + 's';
        tick.appendChild(label);
      }
      el.ruler.appendChild(tick);
    }
  }

  // Gap labels are absolutely positioned above their gap. When several narrow
  // gaps sit side by side, their labels overlap horizontally and become
  // unreadable. Assign each label to the first "row" that fits (measured
  // against the labels already placed), then lower it to that row so the text
  // stacks into a readable column instead of colliding.
  function stackGapLabels(items) {
    var ROW_H = 14;    // px between stacked rows
    var MAX_ROWS = 4;  // rows to try before giving up (rarely more are needed)
    var MARGIN = 4;    // px of horizontal clearance between labels on a row
    var BADGE = 10;    // extra width the .stacked badge adds (border + padding)
    var rows = [];
    items.forEach(function (item) {
      var w = item.el.offsetWidth || 0;
      var left = item.left;
      var right = left + w + (w > 0 ? BADGE : 0);
      var row = 0;
      if (w > 0) {
        while (row < MAX_ROWS && rows[row] && rows[row].some(function (o) {
          return right + MARGIN > o[0] && left < o[1] + MARGIN;
        })) row++;
      }
      if (!rows[row]) rows[row] = [];
      rows[row].push([left, right]);
      if (row > 0) {
        item.el.style.top = (-16 + row * ROW_H) + 'px';
        item.el.classList.add('stacked');
      }
    });
  }

  // Color-dot chips that overlap in time are stacked onto separate rows so
  // dots added at the same moment don't sit on top of each other. Same greedy
  // first-fit as stackGapLabels: each chip lands on the first row it doesn't
  // collide with, then drops to that row's vertical offset. Rows are spaced a
  // full chip height apart (no vertical overlap), and the fill layer's row
  // grows to fit however many rows are used, so stacked chips never clip
  // against each other or the layers above/below.
  function stackFillDots(items, rowEl) {
    var BASE_TOP = 7;   // px: top of the first chip row (matches .fill-dot)
    var CHIP_H = 20;    // px: .fill-dot height
    var ROW_GAP = 4;    // px: vertical spacing between stacked rows
    var PAD_BOTTOM = 7; // px: clearance below the last row
    var ROW_STEP = CHIP_H + ROW_GAP;  // stacked rows: a chip height plus a gap
    var MARGIN = 2;     // px of horizontal clearance between chips
    var rows = [];
    items.forEach(function (it) {
      var row = 0;
      while (rows[row] && rows[row].some(function (o) {
        return it.right + MARGIN > o.left && it.left < o.right + MARGIN;
      })) row++;
      if (!rows[row]) rows[row] = [];
      rows[row].push({ left: it.left, right: it.right });
      if (row > 0) it.el.style.top = (BASE_TOP + row * ROW_STEP) + 'px';
    });
    // Grow the fill layer's row to fit the deepest stack (the CSS default of
    // 34px covers the single-row case). There is no row limit: the layer keeps
    // growing however many dots overlap in time.
    if (rowEl) {
      var used = 0;
      for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].length) used = i;
      if (used > 0) rowEl.style.height = (BASE_TOP + used * ROW_STEP + CHIP_H + PAD_BOTTOM) + 'px';
    }
  }

  function renderLane() {
    el.lane.innerHTML = '';
    renderCameraRow();
    var z = state.zoom;
    state.layers.forEach(function (L) {
      var row = document.createElement('div');
      row.className = 'layer-row' + (L.id === state.activeLayerId ? ' active' : '') + (L.id === layerDragId ? ' dragging' : '') +
        (L.type === 'fill' ? ' thin' : '');
      row.dataset.layer = L.id;
      var gutter = document.createElement('div');
      gutter.className = 'layer-gutter' + (L.id === state.activeLayerId ? ' active' : '');
      gutter.dataset.layer = L.id;
      gutter.title = 'Click to make ' + L.name + ' the active layer. Drag to reorder the stack. Double-click the name to rename';
      var nameSpan = document.createElement('span');
      nameSpan.className = 'layer-name';
      nameSpan.textContent = L.name;
      nameSpan.title = 'Double-click to rename';
      nameSpan.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        var input = document.createElement('input');
        input.className = 'layer-name-input';
        input.type = 'text';
        input.value = L.name;
        input.maxLength = 64;
        nameSpan.replaceWith(input);
        input.focus();
        input.select();
        var done = function (commit) {
          var v = commit ? input.value.trim() : L.name;
          if (v && v !== L.name) {
            L.name = v;
            if (typeof renderTimeline === 'function') renderTimeline();
            if (typeof renderLayerPanel === 'function') renderLayerPanel();
          } else if (!commit) {
            if (typeof renderTimeline === 'function') renderTimeline();
          }
        };
        input.addEventListener('keydown', function (ev) {
          ev.stopPropagation();
          if (ev.key === 'Enter') { done(true); }
          else if (ev.key === 'Escape') { done(false); }
        });
        input.addEventListener('blur', function () { done(true); });
        input.addEventListener('click', function (ev) { ev.stopPropagation(); });
      });
      gutter.appendChild(nameSpan);
      var grip = document.createElement('span');
      grip.className = 'layer-grip';
      grip.setAttribute('aria-hidden', 'true');
      gutter.appendChild(grip);
      var content = document.createElement('div');
      content.className = 'layer-content';

      var keys = sortedKeyframes(L.id);
      var gaps = computeGaps(L.id);
      var labelItems = [];

      if (L.type === 'fill') {
        // Fill layers hold color dots (seed points) instead of keyframes.
        var dots = L.dots || [];
        var fillItems = [];
        if (!dots.length) {
          var hint = document.createElement('div');
          hint.className = 'fill-hint';
          hint.textContent = 'Click the preview to add a color dot. It fills the layer above';
          content.appendChild(hint);
        }
        dots.forEach(function (d) {
          var chip = document.createElement('div');
          chip.className = 'fill-dot' + (d.id === state.selectedDotId ? ' selected' : '');
          chip.dataset.dot = d.id;
          var x1 = d.start * z, x2 = d.end * z;
          var w = Math.max(10, x2 - x1);
          chip.style.left = x1 + 'px';
          chip.style.width = w + 'px';
          chip.style.zIndex = d.id === state.selectedDotId ? 10 : 'auto';
          chip.title = fmtTime(d.start) + ' → ' + fmtTime(d.end) + '. Drag to move, drag the edges to change its window';
          var swatch = document.createElement('span');
          swatch.className = 'fill-dot-swatch';
          swatch.style.background = d.color || '#888';
          var label = document.createElement('span');
          label.className = 'fill-dot-label';
          label.textContent = fmtTime(d.start) + '-' + fmtTime(d.end);
          var g1 = document.createElement('div');
          g1.className = 'fill-dot-edge left';
          var g2 = document.createElement('div');
          g2.className = 'fill-dot-edge right';
          chip.appendChild(swatch);
          chip.appendChild(label);
          chip.appendChild(g1);
          chip.appendChild(g2);
          chip.addEventListener('dblclick', function (e) {
            e.stopPropagation();
            deleteDot(d.id);
            renderLane();
            renderSelectedPanel();
            renderPreview();
            invalidateDots();
          });
          content.appendChild(chip);
          fillItems.push({ el: chip, left: x1, right: x1 + w });
        });
        stackFillDots(fillItems, row);
        row.appendChild(gutter);
        row.appendChild(content);
        el.lane.appendChild(row);
        return;
      }

      gaps.forEach(function (g) {
        var x1 = g.fromTime * z, x2 = g.toTime * z;
        var gen = state.generated[g.id] || [];
        var ok = gapComplete(g);
        var overlay = document.createElement('div');
        overlay.className = 'gap-overlay ' + (ok ? 'ok' : 'dirty') + (g.genCount > WARN_GEN_COUNT ? ' warn' : '') +
          ' mode-' + g.mode + (g.id === state.selectedGapId ? ' selected' : '');
        overlay.style.left = x1 + 'px';
        overlay.style.width = Math.max(2, x2 - x1) + 'px';
        overlay.dataset.gap = g.id;
        if (g.mode === 'none') {
          if (g.sec > 0) {
            var noneLabel = document.createElement('div');
            noneLabel.className = 'glabel';
            noneLabel.textContent = 'no inbetweens';
            overlay.appendChild(noneLabel);
            labelItems.push({ el: noneLabel, left: x1 + 4 });
          }
        } else if (g.genCount > 0) {
          var label = document.createElement('div');
          label.className = 'glabel';
          var suffix = g.mode === 'squash' ? ' · squash' : '';
          label.textContent = ok
            ? g.genCount + ' frames' + suffix
            : (gen.length > 0 ? gen.length + '/' + g.genCount + ' frames · regenerate' + suffix : g.genCount + ' frames needed' + suffix);
          overlay.appendChild(label);
          labelItems.push({ el: label, left: x1 + 4 });
          if (g.genCount > WARN_GEN_COUNT) {
            var warn = document.createElement('div');
            warn.className = 'gap-warn';
            warn.textContent = '⚠ ' + g.genCount + ' inbetweens. Add a real frame here or the output will look bad.';
            overlay.dataset.count = String(g.genCount);
            overlay.appendChild(warn);
          }
        }
        content.appendChild(overlay);

        gen.forEach(function (f) {
          var dot = document.createElement('div');
          dot.className = 'frame-dot';
          dot.style.left = (f.time * z) + 'px';
          content.appendChild(dot);
        });
      });
      stackGapLabels(labelItems);

      keys.forEach(function (k) {
        var chip = document.createElement('div');
        chip.className = 'kf' + (k.id === state.selectedId ? ' selected' : '');
        chip.dataset.id = k.id;
        chip.style.left = (k.time * z) + 'px';
        chip.style.width = Math.max(10, keyframeHold(k) * z) + 'px';
        // Chips are appended in time order, so overlapping chips would paint in
        // that order too. Keep the selected (dragged) chip above the rest so you
        // can grab and pull a chip across its neighbours instead of grabbing the
        // chip on top of it.
        chip.style.zIndex = k.id === state.selectedId ? 10 : 'auto';
        chip.title = 'Frame at ' + fmtTime(k.time) + '. Drag to move, drag the right edge to resize its duration';
        var thumb = document.createElement('div');
        thumb.className = 'kf-thumb';
        var img = document.createElement('img');
        img.src = k.img;
        thumb.appendChild(img);
        var tlabel = document.createElement('div');
        tlabel.className = 'kf-time';
        tlabel.textContent = fmtTime(k.time);
        var resize = document.createElement('div');
        resize.className = 'kf-resize';
        resize.title = 'Drag to set how long this frame holds';
        chip.appendChild(thumb);
        chip.appendChild(tlabel);
        chip.appendChild(resize);
        chip.addEventListener('dblclick', function (e) {
          e.stopPropagation();
          replaceKeyframeImage(k.id);
        });
        content.appendChild(chip);
      });

      row.appendChild(gutter);
      row.appendChild(content);
      el.lane.appendChild(row);
    });
  }

  function renderPlayhead() {
    var left = GUTTER_W + state.playhead * state.zoom;
    el.playhead.style.left = left + 'px';
    var scroll = el.timeline;
    if (left > scroll.scrollLeft + scroll.clientWidth - 60) {
      scroll.scrollLeft = left - scroll.clientWidth + 60;
    } else if (left < scroll.scrollLeft + 10) {
      scroll.scrollLeft = Math.max(0, left - 10);
    }
  }

  function renderFilmstrip() {
    el.filmstrip.innerHTML = '';
    buildPlaybackFrames().forEach(function (f, i) {
      el.filmstrip.appendChild(makeThumb(f, i));
    });
  }

  // Composite thumbnails are expensive (full canvas render + toDataURL per
  // frame); cache by the composite's identity so re-rendering the filmstrip
  // during generation doesn't recompute frames that haven't changed. The
  // composite itself renders at THUMB scale, not work resolution (see
  // compositeThumb); the filmstrip only ever shows ~66×74 thumbs.
  var thumbCache = {};
  var thumbCacheOrder = [];
  function thumbURL(t) {
    var key = compositeKey(t, false);
    if (thumbCache[key]) return Promise.resolve(thumbCache[key]);
    return compositeThumb(t).then(function (url) {
      thumbCache[key] = url;
      thumbCacheOrder.push(key);
      // Bound the cache so long editing sessions don't leak every composite.
      if (thumbCacheOrder.length > 400) {
        var old = thumbCacheOrder.shift();
        delete thumbCache[old];
      }
      return url;
    });
  }

  function makeThumb(f, i) {
    var div = document.createElement('div');
    div.className = 'thumb' + (f.key ? ' key' : '') + (i === state.curIndex ? ' current' : '');
    var img = document.createElement('img');
    div.appendChild(img);
    thumbURL(f.time).then(function (url) {
      if (div.parentNode) img.src = url;
    }).catch(function () {});
    if (f.key) {
      var badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = '◆ key';
      div.appendChild(badge);
    }
    var tlabel = document.createElement('div');
    tlabel.className = 'tlabel';
    tlabel.textContent = fmtTime(f.time);
    div.appendChild(tlabel);
    var actions = document.createElement('div');
    actions.className = 'actions';
    if (!f.key) {
      var promote = document.createElement('button');
      promote.innerHTML = ICONS.arrowUp + '<span>use as keyframe</span>';
      promote.title = 'Turn this composite frame into a keyframe on the active layer';
      promote.addEventListener('click', function (e) {
        e.stopPropagation();
        promoteToKeyframe(f).catch(function (err) { toast(err.message); });
      });
      actions.appendChild(promote);
    }
    var dl = document.createElement('button');
    dl.innerHTML = ICONS.download + '<span>download</span>';
    dl.addEventListener('click', function (e) {
      e.stopPropagation();
      compositeDataURL(f.time).then(function (url) {
        downloadFrame(url, 'frame_' + fmtTime(f.time).replace('.', '_').replace('s', '') + '.png');
      }).catch(function () {});
    });
    actions.appendChild(dl);
    div.appendChild(actions);
    div.addEventListener('click', function () {
      setFrameByTime(f.time);
      if (!state.playing) renderFilmstrip();
    });
    return div;
  }
