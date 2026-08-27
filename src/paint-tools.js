// Paint: selection, masked painting, move/fill/eyedrop, shapes, crop, image ops and free transform.
'use strict';

  var TOOL_BUTTONS = {
    brush: 'btnPaintToolBrush', eraser: 'btnPaintToolEraser', select: 'btnPaintToolSelect',
    lasso: 'btnPaintToolLasso', wand: 'btnPaintToolWand', move: 'btnPaintToolMove', transform: 'btnPaintToolTransform',
    fill: 'btnPaintToolFill', eyedrop: 'btnPaintToolEyedrop', line: 'btnPaintToolLine',
    rect: 'btnPaintToolRect', ellipse: 'btnPaintToolEllipse', crop: 'btnPaintToolCrop'
  };
  var TOOL_OPTS = {
    brush: 'paintToolOptsBrush', eraser: 'paintToolOptsBrush', select: 'paintToolOptsSelect',
    lasso: 'paintToolOptsSelect', wand: 'paintToolOptsSelect', move: 'paintToolOptsMove', transform: 'paintToolOptsTransform',
    fill: 'paintToolOptsFill', eyedrop: null, line: 'paintToolOptsShape',
    rect: 'paintToolOptsShape', ellipse: 'paintToolOptsShape', crop: 'paintToolOptsCrop'
  };

  function setPaintTool(tool) {
    paintTool = tool;
    // brush/eraser drive the eraser flag (keyboard 'e'/'b' and buttons alike)
    if (tool === 'eraser') {
      eraserOn = true;
      var er = byId('paintEraser'); if (er) er.checked = true;
    } else if (tool === 'brush') {
      eraserOn = false;
      var er2 = byId('paintEraser'); if (er2) er2.checked = false;
    }
    // The lasso button means freehand lasso; the mode dropdown (shared by the
    // select + lasso tools) can switch it to rectangle/ellipse afterwards.
    if (tool === 'lasso') {
      selMode = 'lasso';
      var dm = byId('paintSelMode');
      if (dm) dm.value = 'lasso';
    }
    cancelCrop();
    cancelXfrm();
    selDrag = null;
    Object.keys(TOOL_BUTTONS).forEach(function (t) {
      var b = byId(TOOL_BUTTONS[t]);
      if (b) b.classList.toggle('active', t === tool);
    });
    // Hide every tool-options panel, then show only the active tool's. Panels
    // are shared between tools (brush/eraser, line/rect/ellipse, select/lasso),
    // so a plain per-key toggle would re-hide a shared panel after showing it.
    Object.keys(TOOL_OPTS).forEach(function (t) {
      var p = byId(TOOL_OPTS[t]);
      if (p) p.classList.add('hidden');
    });
    var curPanel = byId(TOOL_OPTS[tool]);
    if (curPanel) curPanel.classList.remove('hidden');
    var cv = byId('paintCanvas');
    if (cv) {
      cv.style.cursor = (tool === 'brush' || tool === 'eraser' || tool === 'fill' || tool === 'wand') ? 'crosshair' :
        (tool === 'eyedrop' ? 'copy' : 'default');
    }
    // free-transform shows handles immediately
    if (tool === 'transform') xfrmBegin();
    renderOverlay();
    toast('Tool: ' + tool);
  }

  var selMode = 'rect'; // rect|ellipse|lasso (select tool dropdown)

  // selection engine

  function buildSelMask() {
    selMaskCv = null;
    if (!sel) return;
    var cv;
    if (sel.type === 'mask' && sel.mask) {
      // Pixel-mask selection (wand / invert / grow / shrink): the hard mask is
      // stored on the selection and feather is a blur applied like any other
      // type. The hard mask also drives the ants outline + move bounds, exactly
      // like the rect/ellipse/lasso geometry drives theirs.
      setMaskCache(sel.mask, sel.maskHint);
      cv = sel.mask;
    } else {
      setMaskCache(null);
      cv = document.createElement('canvas');
      cv.width = workW; cv.height = workH;
      var g = cv.getContext('2d');
      g.fillStyle = '#fff';
      if (sel.type === 'rect') {
        g.fillRect(sel.x, sel.y, sel.w, sel.h);
      } else if (sel.type === 'ellipse') {
        g.beginPath();
        g.ellipse(sel.x + sel.w / 2, sel.y + sel.h / 2, sel.w / 2, sel.h / 2, 0, 0, Math.PI * 2);
        g.fill();
      } else if (sel.type === 'lasso' && sel.path && sel.path.length > 2) {
        g.beginPath();
        g.moveTo(sel.path[0].x, sel.path[0].y);
        for (var i = 1; i < sel.path.length; i++) g.lineTo(sel.path[i].x, sel.path[i].y);
        g.closePath();
        g.fill();
      }
    }
    if (sel.feather > 0) {
      // feather = blur the mask so edges fade (Krita's "feather")
      var blurred = document.createElement('canvas');
      blurred.width = workW; blurred.height = workH;
      var bg = blurred.getContext('2d');
      bg.filter = 'blur(' + sel.feather + 'px)';
      bg.drawImage(cv, 0, 0);
      cv = blurred;
    }
    selMaskCv = cv;
  }

  // Cache the hard mask's bounds + ordered contour chains so the ants outline
  // and bounds queries never rescan pixels per frame (marching squares trace,
  // segments joined end-to-end so the dashes walk the whole boundary). `hint`
  // optionally limits the scan to a bounding rect (inclusive), which makes the
  // wand's tiny selections cheap even on huge canvases.
  function setMaskCache(mask, hint) {
    if (!mask) { sel.maskChains = null; return; }
    var w = mask.width, h = mask.height;
    var d = mask.getContext('2d').getImageData(0, 0, w, h).data;
    function inside(x, y) {
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      return d[(y * w + x) * 4 + 3] > 32;
    }
    var scanX0 = 0, scanY0 = 0, scanX1 = w - 1, scanY1 = h - 1;
    if (hint) {
      scanX0 = Math.max(0, Math.floor(hint.x));
      scanY0 = Math.max(0, Math.floor(hint.y));
      scanX1 = Math.min(w - 1, Math.floor(hint.x + hint.w) - 2);
      scanY1 = Math.min(h - 1, Math.floor(hint.y + hint.h) - 2);
    }
    // Every cell contributes segments (a contour corner can sit in a cell whose
    // own top-left pixel is outside), and one extra border ring of cells is
    // scanned so the canvas top/left edges produce outline segments too.
    var minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    var segs = [];
    for (var y = scanY0 - 1; y <= scanY1; y++) {
      for (var x = scanX0 - 1; x <= scanX1; x++) {
        var A = inside(x, y), B = inside(x + 1, y), C = inside(x + 1, y + 1), D = inside(x, y + 1);
        if (A) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        var c = (A ? 1 : 0) | (B ? 2 : 0) | (C ? 4 : 0) | (D ? 8 : 0);
        if (c === 0 || c === 15) continue;
        var T = [x + 0.5, y], R = [x + 1, y + 0.5], BM = [x + 0.5, y + 1], L = [x, y + 0.5];
        if (c === 1 || c === 14) segs.push({ a: T, b: L });
        else if (c === 2 || c === 13) segs.push({ a: T, b: R });
        else if (c === 3 || c === 12) segs.push({ a: L, b: R });
        else if (c === 4 || c === 11) segs.push({ a: R, b: BM });
        else if (c === 6 || c === 9) segs.push({ a: T, b: BM });
        else if (c === 7 || c === 8) segs.push({ a: BM, b: L });
        else if (c === 5) { segs.push({ a: T, b: L }); segs.push({ a: R, b: BM }); }
        else if (c === 10) { segs.push({ a: T, b: R }); segs.push({ a: BM, b: L }); }
      }
    }
    sel.boundsCache = (minX === Infinity) ? { x: 0, y: 0, w: 0, h: 0 } : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    // join the segments into closed chains by matching shared endpoints
    function key(pt) { return pt[0] + ',' + pt[1]; }
    var heads = {};
    segs.forEach(function (s, i) {
      var ka = key(s.a), kb = key(s.b);
      (heads[ka] = heads[ka] || []).push([i, 1]);
      (heads[kb] = heads[kb] || []).push([i, 0]);
    });
    var chains = [];
    var used = new Uint8Array(segs.length);
    for (var i0 = 0; i0 < segs.length; i0++) {
      if (used[i0]) continue;
      used[i0] = 1;
      var pts = [segs[i0].a, segs[i0].b];
      var tip = key(segs[i0].b);
      var guard = 0;
      while (guard++ < segs.length) {
        var list = heads[tip], next = null;
        if (list) for (var li = 0; li < list.length; li++) {
          if (!used[list[li][0]]) { next = list[li]; break; }
        }
        if (!next) break;
        used[next[0]] = 1;
        var s2 = segs[next[0]];
        if (next[1]) { pts.push(s2.b); tip = key(s2.b); }
        else { pts.push(s2.a); tip = key(s2.a); }
        if (tip === key(pts[0])) { pts.pop(); break; }
      }
      if (pts.length >= 2) chains.push(pts);
    }
    sel.maskChains = chains;
  }

  function selPoint(x, y) {
    if (!selMaskCv) {
      if (sel) buildSelMask();
      if (!selMaskCv) return false;
    }
    var px = Math.round(x), py = Math.round(y);
    if (px < 0 || py < 0 || px >= workW || py >= workH) return false;
    var d = selMaskCv.getContext('2d').getImageData(px, py, 1, 1).data;
    return d[3] > 32;
  }

  function selBounds() {
    if (!sel) return null;
    if (sel.type === 'rect' || sel.type === 'ellipse') return { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
    if (sel.type === 'mask') {
      if (!sel.boundsCache) { if (sel.mask) setMaskCache(sel.mask); else return null; }
      return sel.boundsCache;
    }
    if (sel.type === 'lasso' && sel.path && sel.path.length) {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      sel.path.forEach(function (pt) {
        if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
      });
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    return null;
  }

  function drawSelOutline(g, offX, offY) {
    if (!sel) return;
    g.strokeStyle = '#000';
    g.lineWidth = 1.2;
    g.setLineDash([6, 5]);
    g.lineDashOffset = -antsOffset;
    g.beginPath();
    if (sel.type === 'rect') {
      g.rect(sel.x + offX + 0.5, sel.y + offY + 0.5, sel.w, sel.h);
    } else if (sel.type === 'ellipse') {
      g.ellipse(sel.x + offX + sel.w / 2, sel.y + offY + sel.h / 2, sel.w / 2, sel.h / 2, 0, 0, Math.PI * 2);
    } else if (sel.type === 'lasso' && sel.path && sel.path.length > 2) {
      g.moveTo(sel.path[0].x + offX, sel.path[0].y + offY);
      for (var i = 1; i < sel.path.length; i++) g.lineTo(sel.path[i].x + offX, sel.path[i].y + offY);
      g.closePath();
    } else if (sel.type === 'mask' && sel.maskChains && sel.maskChains.length) {
      // pixel-mask outline: the traced contour chains (chords along the mask
      // boundary), marched with the same dash phase as geometric selections
      sel.maskChains.forEach(function (ch) {
        g.moveTo(ch[0][0] + offX, ch[0][1] + offY);
        for (var k = 1; k < ch.length; k++) g.lineTo(ch[k][0] + offX, ch[k][1] + offY);
        g.closePath();
      });
    }
    g.stroke();
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.setLineDash([6, 5]);
    g.lineDashOffset = -antsOffset + 4;
    g.stroke();
    g.setLineDash([]);
  }

  function startAnts() {
    if (antsTimer) return;
    // Pace the march (~11 steps/s) instead of stepping every animation frame:
    // racing the dash offset 60x/s made the outline flicker like it was
    // disappearing.
    var last = 0;
    var step = function (ts) {
      if (ts - last > 90) { antsOffset = (antsOffset + 1) % 22; last = ts; }
      renderOverlay();
      if (paintOpen && (sel || cropRect)) antsTimer = requestAnimationFrame(step);
      else antsTimer = 0;
    };
    antsTimer = requestAnimationFrame(step);
  }

  function stopAnts() {
    if (antsTimer) { cancelAnimationFrame(antsTimer); antsTimer = 0; }
  }

  // overlay rendering

  function renderOverlay() {
    if (!overlayCtx) return;
    overlayCtx.clearRect(0, 0, workW, workH);
    // Onion ghosts first (bottom): drawn on this display-only overlay so they
    // always sit on top of the frame and are visible even on opaque frames.
    paintDrawOnion(overlayCtx);
    // selection outline only (no tint fill - just the marching ants)
    if (sel) {
      if (!selMaskCv) buildSelMask();     // never let the outline vanish on a stale mask
      if (selMaskCv) {
        var off = (selDrag && selDrag.mode === 'move') ? { x: selDrag.dx, y: selDrag.dy } : { x: 0, y: 0 };
        drawSelOutline(overlayCtx, off.x, off.y);
      }
    }
    // crop rect: dim outside + draw border
    if (cropRect) {
      overlayCtx.save();
      overlayCtx.fillStyle = 'rgba(0,0,0,0.45)';
      overlayCtx.fillRect(0, 0, workW, cropRect.y);
      overlayCtx.fillRect(0, cropRect.y + cropRect.h, workW, workH - cropRect.y - cropRect.h);
      overlayCtx.fillRect(0, cropRect.y, cropRect.x, cropRect.h);
      overlayCtx.fillRect(cropRect.x + cropRect.w, cropRect.y, workW - cropRect.x - cropRect.w, cropRect.h);
      overlayCtx.strokeStyle = '#fff';
      overlayCtx.lineWidth = 1.5;
      overlayCtx.setLineDash([8, 5]);
      overlayCtx.lineDashOffset = -antsOffset;
      overlayCtx.strokeRect(cropRect.x + 0.5, cropRect.y + 0.5, cropRect.w, cropRect.h);
      overlayCtx.setLineDash([]);
      // corner handles
      overlayCtx.fillStyle = '#fff';
      [[cropRect.x, cropRect.y], [cropRect.x + cropRect.w, cropRect.y],
       [cropRect.x, cropRect.y + cropRect.h], [cropRect.x + cropRect.w, cropRect.y + cropRect.h]]
        .forEach(function (c) { overlayCtx.fillRect(c[0] - 3, c[1] - 3, 6, 6); });
      overlayCtx.restore();
    }
    if (xfrm) renderXfrm(overlayCtx);
    // line/shape preview (drawn live during drag)
    if (toolDrag && toolDrag.preview === 'line') {
      overlayCtx.strokeStyle = 'rgba(255,255,255,0.85)';
      overlayCtx.lineWidth = 1;
      overlayCtx.beginPath();
      overlayCtx.moveTo(toolDrag.x0, toolDrag.y0);
      overlayCtx.lineTo(toolDrag.x1, toolDrag.y1);
      overlayCtx.stroke();
    } else if (toolDrag && toolDrag.preview === 'shape') {
      overlayCtx.strokeStyle = 'rgba(255,255,255,0.85)';
      overlayCtx.lineWidth = 1;
      overlayCtx.beginPath();
      if (toolDrag.shape === 'rect') overlayCtx.rect(toolDrag.x, toolDrag.y, toolDrag.w, toolDrag.h);
      else overlayCtx.ellipse(toolDrag.x + toolDrag.w / 2, toolDrag.y + toolDrag.h / 2, Math.abs(toolDrag.w) / 2, Math.abs(toolDrag.h) / 2, 0, 0, Math.PI * 2);
      overlayCtx.stroke();
    }
  }

  // selection tool handlers

  // Hit-test a pointer against the active selection: inside the mask, or (for
  // feathered selections) anywhere inside the bounding box so the soft fringe
  // can still be grabbed.
  function selHit(p) {
    if (!sel || !selMaskCv) return false;
    var b = selBounds();
    if (!b || p.x < b.x || p.y < b.y || p.x > b.x + b.w || p.y > b.y + b.h) return false;
    return selPoint(p.x, p.y) || sel.feather > 0;
  }

  function beginSelMove(p, dup) {
    pushUndo();
    var ctx = activeLayer.canvas.getContext('2d');
    selDrag = {
      mode: 'move', sx: p.x, sy: p.y, dx: 0, dy: 0, dup: !!dup,
      snapshot: ctx.getImageData(0, 0, workW, workH),
      contentCv: selContentCopy()
    };
    compositeDisplay();
  }

  function selDown(p) {
    // The selection tool ALWAYS draws: the current selection is momentarily
    // kept so the outline does not flicker, and is replaced when the drag
    // produces a shape (or cleared if the drag never becomes one). Moving the
    // selected content is the Move tool's job (V), which mounts the same
    // selDrag engine via beginSelMove. The shape comes from the mode dropdown
    // (rectangle / ellipse / freehand lasso), shared by the select + lasso tools.
    selDrag = { mode: 'draw', type: (selMode || 'rect'), sx: p.x, sy: p.y, pts: [{ x: p.x, y: p.y }] };
  }

  function selMove(p) {
    if (!selDrag) return;
    if (selDrag.mode === 'move') {
      selDrag.dx = p.x - selDrag.sx;
      selDrag.dy = p.y - selDrag.sy;
      // live preview: restore snapshot, then place the content at the offset
      // (erase the original region unless this is a duplicate drag)
      var ctx = activeLayer.canvas.getContext('2d');
      ctx.putImageData(selDrag.snapshot, 0, 0);
      if (!selDrag.dup) selEraseRegion(ctx);
      if (selDrag.dup) ctx.drawImage(selDrag.contentCv, 0, 0);
      drawSelContentAt(ctx, selDrag.dx, selDrag.dy);
      compositeDisplay();
      return;
    }
    if (selDrag.type === 'lasso') {
      var lp = selDrag.pts[selDrag.pts.length - 1];
      if (Math.hypot(p.x - lp.x, p.y - lp.y) > 2) selDrag.pts.push({ x: p.x, y: p.y });
      // only replace the current selection once the lasso is a real shape
      if (selDrag.pts.length >= 3) {
        sel = { type: 'lasso', path: selDrag.pts.slice(), feather: selFeatherVal() };
        buildSelMask();
        selDrag.made = true;
      }
      renderOverlay();
      return;
    }
    var x0 = Math.min(selDrag.sx, p.x), y0 = Math.min(selDrag.sy, p.y);
    var w = Math.abs(p.x - selDrag.sx), h = Math.abs(p.y - selDrag.sy);
    if (evShift) { // hold Shift for square/circle
      var s = Math.max(w, h);
      if (p.x < selDrag.sx) x0 = selDrag.sx - s;
      if (p.y < selDrag.sy) y0 = selDrag.sy - s;
      w = s; h = s;
    }
    // only actually replace the selection when the drag produced a shape
    if (w >= 1 || h >= 1) {
      sel = { type: selDrag.type, x: x0, y: y0, w: w, h: h, feather: selFeatherVal() };
      buildSelMask();
      selDrag.made = true;
    }
    renderOverlay();
  }

  function selUp() {
    if (!selDrag) return;
    if (selDrag.mode === 'move') {
      if (selDrag.dx || selDrag.dy) {
        // commit: keep content moved; move the selection border with it
        if (sel && (sel.type === 'rect' || sel.type === 'ellipse')) {
          sel.x += selDrag.dx; sel.y += selDrag.dy;
        } else if (sel && sel.type === 'lasso') {
          sel.path.forEach(function (pt) { pt.x += selDrag.dx; pt.y += selDrag.dy; });
        } else if (sel && sel.type === 'mask') {
          // shift the stored hard mask (and re-blur the working copy); the
          // bounds/outline caches and the fast-scan hint no longer match
          var nm = document.createElement('canvas');
          nm.width = workW; nm.height = workH;
          nm.getContext('2d').drawImage(sel.mask, selDrag.dx, selDrag.dy);
          sel.mask = nm;
          sel.maskHint = null;
        }
        buildSelMask();
      }
      selDrag = null;
      compositeDisplay();
      return;
    }
    // A plain click (or a drag that never became a shape) with the selection
    // tool clears the selection; a real drag already replaced it on the move.
    if (!selDrag.made) {
      sel = null; selMaskCv = null;
    }
    selDrag = null;
    if (sel) startAnts(); else stopAnts();
    compositeDisplay();
  }

  // Copy the active layer's pixels inside the selection into a fresh canvas.
  function selContentCopy() {
    var cv = document.createElement('canvas');
    cv.width = workW; cv.height = workH;
    var g = cv.getContext('2d');
    g.drawImage(activeLayer.canvas, 0, 0);
    if (selMaskCv) { g.globalCompositeOperation = 'destination-in'; g.drawImage(selMaskCv, 0, 0); }
    return cv;
  }

  // Erase the active selection's region from ctx (used by the move preview).
  function selEraseRegion(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(selMaskCv, 0, 0);
    ctx.restore();
  }

  // Draw the moved selection content into ctx at offset (dx,dy), clipped to the
  // selection shape translated by the same offset.
  function drawSelContentAt(ctx, dx, dy) {
    if (!selDrag || !selDrag.contentCv) return;
    var tmp = document.createElement('canvas');
    tmp.width = workW; tmp.height = workH;
    var t = tmp.getContext('2d');
    t.drawImage(selDrag.contentCv, dx, dy);
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(selMaskCv, dx, dy);
    ctx.drawImage(tmp, 0, 0);
  }

  // masked painting
  // With a live selection, brush/eraser strokes and line/shape drags are drawn
  // into a scratch canvas; the stroke is displayed (and committed) clipped to
  // the selection mask so it can never bleed outside - same as Krita painting
  // with a selection. The scratch holds ONLY the new dabs for brush/line/shape
  // strokes: the commit overlays the mask-clipped dabs on the layer, so pixels
  // the stroke never touched keep their exact alpha. (Re-blitting a scratch
  // that also contained a copy of the layer re-composited every semi-transparent
  // pixel inside the selection on every stroke, so faint brushes like the
  // sketch pencils looked like they were being copied over and over.) Eraser
  // strokes are the exception: their dabs must remove paint, so the scratch (and
  // the pinned pre-stroke copy) hold the layer content and the commit carves
  // exactly the erased spots.
  function beginSelScratch() {
    selScratchCv = null; selScratchCtx = null; selScratchLayer = null; selScratchOrig = null;
    if (!selMaskCv || !activeLayer) return;
    var cv = document.createElement('canvas');
    cv.width = workW; cv.height = workH;
    var c = cv.getContext('2d');
    if (eraserOn || (current && current.eraser)) {
      c.drawImage(activeLayer.canvas, 0, 0);
      // pin the pre-stroke pixels so the commit can carve the erased spots
      var oc = document.createElement('canvas');
      oc.width = workW; oc.height = workH;
      oc.getContext('2d').drawImage(activeLayer.canvas, 0, 0);
      selScratchOrig = oc;
    }
    selScratchCv = cv; selScratchCtx = c; selScratchLayer = activeLayer;
    paintCtx = c;
  }

  // Commit the masked scratch onto the active layer and drop it. Used for the
  // live preview of line/shape drags and to commit brush/eraser strokes.
  //
  // A BRUSH/line/shape stroke holds only the new dabs (beginSelScratch), so
  // overlaying the mask-clipped dabs adds the paint without touching anything
  // else: pixels the stroke never covered keep their exact alpha, stroke after
  // stroke. An ERASER stroke carves only the erased spots (pre-stroke minus
  // scratch, clipped to the mask) out of the layer.
  function commitSelScratch() {
    if (!selScratchCv) return;
    var sc = selScratchCv;
    var orig = selScratchOrig;
    selScratchCv = null; selScratchCtx = null; selScratchLayer = null; selScratchOrig = null;
    paintCtx = activeLayer ? activeLayer.canvas.getContext('2d') : null;
    if (!activeLayer) return;
    var ctx = activeLayer.canvas.getContext('2d');
    var eraserStroke = !!(eraserOn || (current && current.eraser));
    if (eraserStroke && orig && selMaskCv) {
      // the holes = pre-stroke pixels the eraser removed, limited to the
      // selection; carve exactly those out of the layer
      var holes = document.createElement('canvas');
      holes.width = workW; holes.height = workH;
      var hg = holes.getContext('2d');
      hg.drawImage(orig, 0, 0);
      hg.globalCompositeOperation = 'destination-out';
      hg.drawImage(sc, 0, 0);
      hg.globalCompositeOperation = 'destination-in';
      hg.drawImage(selMaskCv, 0, 0);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(holes, 0, 0);
      ctx.restore();
    } else {
      var tmp = document.createElement('canvas');
      tmp.width = workW; tmp.height = workH;
      var t = tmp.getContext('2d');
      t.drawImage(sc, 0, 0);
      if (selMaskCv) { t.globalCompositeOperation = 'destination-in'; t.drawImage(selMaskCv, 0, 0); }
      ctx.drawImage(tmp, 0, 0);
    }
  }

  function selFeatherVal() {
    var f = byId('paintSelFeather');
    return f ? +f.value : 0;
  }

  function selectAll() {
    sel = { type: 'rect', x: 0, y: 0, w: workW, h: workH, feather: 0 };
    buildSelMask();
    startAnts();
    compositeDisplay();
  }

  function selectNone() {
    commitSelScratch();   // never strand an in-flight masked stroke
    sel = null; selMaskCv = null; selDrag = null; selScratchOrig = null;
    stopAnts();
    compositeDisplay();
  }

  function invertSelection() {
    if (!sel) return;
    var cv = document.createElement('canvas');
    cv.width = workW; cv.height = workH;
    var g = cv.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, workW, workH);
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(selMaskCv, 0, 0);
    // keep the inverted region as a real pixel mask so rebuilds/moves/outlines
    // never collapse it back into a full-canvas selection (the old "inverted
    // rect" shortcut made the ants show the whole canvas and the mask get lost
    // on the next rebuild)
    sel = { type: 'mask', mask: cv, feather: 0 };
    buildSelMask();
    startAnts();
    compositeDisplay();
  }

  function growShrinkSel(dir) {
    if (!selMaskCv) return;
    var r = Math.max(1, selFeatherVal() || 8);
    var cv = document.createElement('canvas');
    cv.width = workW; cv.height = workH;
    var g = cv.getContext('2d');
    g.filter = 'blur(' + r + 'px)';
    g.drawImage(selMaskCv, 0, 0);
    var src = g.getImageData(0, 0, workW, workH);
    var d = src.data;
    var thr = dir > 0 ? 96 : 200;
    for (var i = 3; i < d.length; i += 4) d[i] = d[i] > thr ? 255 : 0;
    g.putImageData(src, 0, 0);
    sel = { type: 'mask', mask: cv, feather: 0 };
    buildSelMask();
    startAnts();
    compositeDisplay();
  }

  function deleteSelection() {
    if (!selMaskCv) return;
    pushUndo();
    var ctx = activeLayer.canvas.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(selMaskCv, 0, 0);
    ctx.restore();
    compositeDisplay();
  }

  // move tool

  // Draw an ImageData snapshot onto a fresh full-size canvas (for blitting).
  function snapshotToCanvas(snap) {
    var cv = document.createElement('canvas');
    cv.width = snap.width; cv.height = snap.height;
    cv.getContext('2d').putImageData(snap, 0, 0);
    return cv;
  }

  function moveDown(p) {
    // With a live selection the move tool moves the SELECTED content (Krita
    // behaviour): the layer itself stays put. Alt+drag duplicates.
    if (selMaskCv && selHit(p)) { beginSelMove(p, !!evShift); return; }
    pushUndo();
    toolDrag = {
      mode: 'move', sx: p.x, sy: p.y, dx: 0, dy: 0,
      snapshot: activeLayer.canvas.getContext('2d').getImageData(0, 0, workW, workH),
      dup: !!(evShift)
    };
  }

  function moveMove(p) {
    // selection-content moves driven by the move tool go through the same
    // engine as select-tool moves
    if (selDrag && selDrag.mode === 'move') { selMove(p); return; }
    if (!toolDrag) return;
    toolDrag.dx = p.x - toolDrag.sx;
    toolDrag.dy = p.y - toolDrag.sy;
    var ctx = activeLayer.canvas.getContext('2d');
    var src = snapshotToCanvas(toolDrag.snapshot);
    // Move: the original is gone, content only appears at the offset.
    // Duplicate (Alt-drag): the original stays at 0,0 and a copy is added.
    ctx.clearRect(0, 0, workW, workH);
    if (toolDrag.dup) ctx.drawImage(src, 0, 0);
    ctx.drawImage(src, toolDrag.dx, toolDrag.dy);
    compositeDisplay();
  }

  function moveUp() {
    if (selDrag && selDrag.mode === 'move') { selUp(); return; }
    toolDrag = null;
    compositeDisplay();
  }

  // fill tool

  function fillDown(p) {
    if (!activeLayer) return;
    pushUndo();
    var ctx = activeLayer.canvas.getContext('2d');
    var tol = +(byId('paintFillTol') ? byId('paintFillTol').value : 8);
    var contig = !byId('paintFillContiguous') || byId('paintFillContiguous').checked;
    // An active selection always limits the fill (Krita bucket-fill behaviour);
    // the checkbox is an explicit opt-out.
    var limitEl = byId('paintFillUseSel');
    var useSel = !!(selMaskCv && (limitEl ? limitEl.checked : true));
    floodFill(ctx, p.x, p.y, tol, contig, useSel);
    // bucket fill always lays the current colour down (even with an eraser
    // brush selected), so it always enters the history
    rememberRecentColor(current ? current.color : fgColor);
    compositeDisplay();
  }

  function floodFill(ctx, sx, sy, tol, contig, useSel) {
    var w = workW, h = workH;
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    var x0 = Math.round(sx), y0 = Math.round(sy);
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return;
    var idx0 = (y0 * w + x0) * 4;
    var r0 = d[idx0], g0 = d[idx0 + 1], b0 = d[idx0 + 2], a0 = d[idx0 + 3];
    var c = hexToRgb(current.color);
    var outA = Math.round(current.opacity * 255);
    var tolSq = tol * tol * 3;
    // cache the selection mask once instead of a getImageData per pixel
    var mData = null;
    if (useSel && selMaskCv) mData = selMaskCv.getContext('2d').getImageData(0, 0, w, h).data;
    function inMask(pi) { return mData[pi * 4 + 3] > 32; }
    function match(i) {
      var dr = d[i] - r0, dg = d[i + 1] - g0, db = d[i + 2] - b0;
      return dr * dr + dg * dg + db * db <= tolSq;
    }
    function paint(pi) {
      var i = pi * 4;
      d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b; d[i + 3] = a0 > 0 ? Math.max(a0, outA) : outA;
    }
    if (contig) {
      var stack = [x0, y0];
      var seen = new Uint8Array(w * h);
      while (stack.length) {
        var y = stack.pop(), x = stack.pop();
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        var pi = y * w + x;
        if (seen[pi]) continue;
        seen[pi] = 1;
        if (useSel && !inMask(pi)) continue;
        if (!match(pi * 4)) continue;
        paint(pi);
        stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
      }
    } else {
      for (var p = 0; p < d.length; p += 4) {
        // only pixels inside the selection are candidates; the original layer
        // content everywhere else is left completely untouched
        if (useSel && mData && mData[p + 3] <= 32) continue;
        if (match(p)) paint(p / 4);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // eyedrop tool

  function eyedropDown(p) {
    if (!paintCanvas) return;
    var px = Math.round(p.x), py = Math.round(p.y);
    if (px < 0 || py < 0 || px >= workW || py >= workH) return;
    var d = paintCanvas.getContext('2d').getImageData(px, py, 1, 1).data;
    var hex = '#' + ((1 << 24) | (d[0] << 16) | (d[1] << 8) | d[2]).toString(16).slice(1);
    setPaintColor(hex);
    refreshTip();
    syncColorWheel(); // move the SV dot / hue marker to the picked colour
    toast('Picked ' + hex);
  }

  // line / shape tools

  function lineDown(p) {
    pushUndo();
    toolDrag = { mode: 'shape', preview: 'line', x0: p.x, y0: p.y, x1: p.x, y1: p.y,
      snapshot: activeLayer.canvas.getContext('2d').getImageData(0, 0, workW, workH) };
  }

  function lineMove(p) {
    if (!toolDrag) return;
    toolDrag.x1 = p.x; toolDrag.y1 = p.y;
    var ctx = activeLayer.canvas.getContext('2d');
    ctx.putImageData(toolDrag.snapshot, 0, 0);
    if (selMaskCv) {
      // masked preview: new segment drawn into a scratch of the restored layer,
      // then blitted clipped to the selection
      beginSelScratch();
      stampSegment({ x: toolDrag.x0, y: toolDrag.y0, press: 1 }, { x: p.x, y: p.y, press: 1 });
      commitSelScratch();
    } else {
      stampSegment({ x: toolDrag.x0, y: toolDrag.y0, press: 1 }, { x: p.x, y: p.y, press: 1 });
    }
    compositeDisplay();
  }

  function lineUp() {
    rememberUsedColor();
    toolDrag = null;
    compositeDisplay();
  }

  function shapeDown(p) {
    pushUndo();
    toolDrag = {
      mode: 'shape', preview: 'shape', shape: paintTool === 'rect' ? 'rect' : 'ellipse',
      sx: p.x, sy: p.y, x: p.x, y: p.y, w: 0, h: 0,
      snapshot: activeLayer.canvas.getContext('2d').getImageData(0, 0, workW, workH)
    };
  }

  function shapeMove(p) {
    if (!toolDrag) return;
    var x0 = toolDrag.sx, y0 = toolDrag.sy;
    var w = p.x - x0, h = p.y - y0;
    if (evShift || (byId('paintShapeSquare') && byId('paintShapeSquare').checked)) {
      var s = Math.max(Math.abs(w), Math.abs(h));
      w = (w < 0 ? -1 : 1) * s; h = (h < 0 ? -1 : 1) * s;
    }
    toolDrag.x = Math.min(x0, x0 + w); toolDrag.y = Math.min(y0, y0 + h);
    toolDrag.w = Math.abs(w); toolDrag.h = Math.abs(h);
    var ctx = activeLayer.canvas.getContext('2d');
    ctx.putImageData(toolDrag.snapshot, 0, 0);
    var fill = !!(byId('paintShapeFill') && byId('paintShapeFill').checked);
    if (selMaskCv) {
      // masked preview: draw the shape into a scratch of the restored layer,
      // then blit it clipped to the selection
      beginSelScratch();
      drawShape(selScratchCtx, toolDrag.x, toolDrag.y, toolDrag.w, toolDrag.h, fill);
      commitSelScratch();
    } else {
      drawShape(ctx, toolDrag.x, toolDrag.y, toolDrag.w, toolDrag.h, fill);
    }
    compositeDisplay();
  }

  function shapeUp() {
    rememberUsedColor();
    toolDrag = null;
    compositeDisplay();
  }

  function drawShape(ctx, x, y, w, h, fill) {
    var shape = toolDrag ? toolDrag.shape : 'rect';
    var cx = x + w / 2, cy = y + h / 2;
    if (fill) {
      // brush-textured fill: stamp dabs in a grid over the shape
      var step = Math.max(1, dabStep(current.radius) * 0.7);
      var n = Math.ceil(current.radius / 2);
      var g = document.createElement('canvas');
      g.width = workW; g.height = workH;
      var gc = g.getContext('2d');
      var savedCtx = paintCtx;
      paintCtx = gc;
      for (var yy = y - n; yy <= y + h + n; yy += step) {
        for (var xx = x - n; xx <= x + w + n; xx += step) {
          if (shape === 'rect') {
            if (xx < x - n || xx > x + w + n || yy < y - n || yy > y + h + n) continue;
          } else {
            var nx = (xx - cx) / (w / 2 + n), ny = (yy - cy) / (h / 2 + n);
            if (nx * nx + ny * ny > 1) continue;
          }
          stampDab(xx, yy, current.radius, current.opacity, null);
        }
      }
      paintCtx = savedCtx;
      ctx.drawImage(g, 0, 0);
    } else {
      // outline: stamp dabs along the perimeter
      var perimeter = 2 * (w + h);
      var n2 = Math.max(4, Math.ceil(perimeter / Math.max(1, dabStep(current.radius) * 0.5)));
      var g2 = document.createElement('canvas');
      g2.width = workW; g2.height = workH;
      var gc2 = g2.getContext('2d');
      var saved2 = paintCtx;
      paintCtx = gc2;
      for (var i = 0; i <= n2; i++) {
        var t = i / n2;
        var px2, py2;
        if (shape === 'rect') {
          var perimeter2 = 2 * (w + h);
          var d2 = t * perimeter2;
          if (d2 < w) { px2 = x + d2; py2 = y; }
          else if (d2 < w + h) { px2 = x + w; py2 = y + (d2 - w); }
          else if (d2 < 2 * w + h) { px2 = x + w - (d2 - w - h); py2 = y + h; }
          else { px2 = x; py2 = y + h - (d2 - 2 * w - h); }
        } else {
          px2 = cx + Math.cos(t * Math.PI * 2) * w / 2;
          py2 = cy + Math.sin(t * Math.PI * 2) * h / 2;
        }
        stampDab(px2, py2, current.radius, current.opacity, null);
      }
      paintCtx = saved2;
      ctx.drawImage(g2, 0, 0);
    }
  }

  // crop tool

  function cropDown(p) {
    cropRect = { x: p.x, y: p.y, w: 0, h: 0 };
    startAnts();
  }

  function cropMove(p) {
    if (!cropRect) return;
    var x0 = Math.min(cropRect.x, p.x), y0 = Math.min(cropRect.y, p.y);
    cropRect = { x: x0, y: y0, w: Math.abs(p.x - cropRect.x), h: Math.abs(p.y - cropRect.y) };
    renderOverlay();
  }

  function cropUp() {
    if (cropRect && (cropRect.w < 4 || cropRect.h < 4)) { cropRect = null; }
    renderOverlay();
  }

  function cancelCrop() {
    cropRect = null;
    if (antsTimer && !sel) stopAnts();
    renderOverlay();
  }

  function applyCrop() {
    if (!cropRect) return;
    var r = cropRect;
    if (r.w < 4 || r.h < 4) { cancelCrop(); return; }
    pushUndo();
    var nw = Math.max(8, Math.round(r.w / 8) * 8);
    var nh = Math.max(8, Math.round(r.h / 8) * 8);
    function cropCanvas2(cv) {
      var out = document.createElement('canvas');
      out.width = nw; out.height = nh;
      out.getContext('2d').drawImage(cv, r.x, r.y, nw, nh, 0, 0, nw, nh);
      return out;
    }
    if (paintBaseCanvas) paintBaseCanvas = cropCanvas2(paintBaseCanvas);
    paintLayers.forEach(function (l) { l.canvas = cropCanvas2(l.canvas); });
    activeLayer = paintLayers[paintLayers.length - 1];
    paintCtx = activeLayer.canvas.getContext('2d');
    resizeWork(nw, nh);
    cropRect = null;
    sel = null; selMaskCv = null;
    stopAnts();
    toast('Cropped to ' + nw + '×' + nh);
  }

  // canvas resize / image ops

  // Change the working canvas size. nw/nh are snapped to the 8px grid by
  // applyWorkSize; existing pixels are preserved (letterboxed) unless scale is
  // given, in which case content is scaled into the new size.
  function resizeWork(nw, nh, scaleContent) {
    var ow = workW, oh = workH;
    state.aspect = 'custom';
    state.customW = nw; state.customH = nh;
    applyWorkSize();
    var w2 = workW, h2 = workH;
    // re-layout layer canvases
    var layers = paintLayers.map(function (l) {
      var cv = document.createElement('canvas');
      cv.width = w2; cv.height = h2;
      var g = cv.getContext('2d');
      if (scaleContent) g.drawImage(l.canvas, 0, 0, ow, oh, 0, 0, w2, h2);
      else g.drawImage(l.canvas, 0, 0);
      return Object.assign({}, l, { canvas: cv });
    });
    paintLayers = layers;
    if (activeLayer) activeLayer = paintLayers[paintLayers.indexOf(activeLayer)] || paintLayers[paintLayers.length - 1];
    if (!activeLayer && paintLayers.length) activeLayer = paintLayers[paintLayers.length - 1];
    paintCtx = activeLayer ? activeLayer.canvas.getContext('2d') : null;
    if (paintBaseCanvas) {
      var bc = document.createElement('canvas');
      bc.width = w2; bc.height = h2;
      var bg = bc.getContext('2d');
      if (scaleContent) bg.drawImage(paintBaseCanvas, 0, 0, ow, oh, 0, 0, w2, h2);
      else bg.drawImage(paintBaseCanvas, 0, 0);
      paintBaseCanvas = bc;
    }
    paintCanvas.width = w2; paintCanvas.height = h2;
    paintDispCtx = paintCanvas.getContext('2d');
    if (overlayCv) { overlayCv.width = w2; overlayCv.height = h2; overlayCtx = overlayCv.getContext('2d'); }
    sel = null; selMaskCv = null; cropRect = null; selDrag = null; xfrm = null;
    resetHistory(); // structural change: old snapshots reference detached canvases
    stopAnts();
    fitCanvas();
    rebuildLayerUI();
    compositeDisplay();
    refreshOnion();
  }

  function openResizeDialog() {
    var d = byId('paintResizeDialog');
    if (!d) return;
    var wI = byId('paintResizeW'), hI = byId('paintResizeH');
    if (wI) { wI.value = workW; setVal('paintResizeW', workW, workW + 'px'); }
    if (hI) { hI.value = workH; setVal('paintResizeH', workH, workH + 'px'); }
    d.classList.remove('hidden');
    if (wI) wI.focus();
  }

  function applyResizeDialog() {
    var wI = byId('paintResizeW'), hI = byId('paintResizeH');
    var nw = clamp(parseInt(wI ? wI.value : workW, 10) || workW, 8, 4096);
    var nh = clamp(parseInt(hI ? hI.value : workH, 10) || workH, 8, 4096);
    var keep = !!(byId('paintResizeKeep') && byId('paintResizeKeep').checked);
    if (keep) {
      var ratio = workW / workH;
      if (Math.abs(nw - workW) >= Math.abs(nh - workH)) nh = Math.round(nw / ratio);
      else nw = Math.round(nh * ratio);
    }
    var scaleContent = !!(byId('paintResizeScale') && byId('paintResizeScale').checked);
    resizeWork(nw, nh, scaleContent);
    var d = byId('paintResizeDialog');
    if (d) d.classList.add('hidden');
    toast('Resized to ' + workW + '×' + workH);
  }

  function flipCanvas(horizontal) {
    pushUndo();
    var layers = paintLayers.map(function (l) {
      var cv = document.createElement('canvas');
      cv.width = workW; cv.height = workH;
      var g = cv.getContext('2d');
      g.save();
      if (horizontal) g.scale(-1, 1), g.translate(-workW, 0);
      else g.scale(1, -1), g.translate(0, -workH);
      g.drawImage(l.canvas, 0, 0);
      g.restore();
      return Object.assign({}, l, { canvas: cv });
    });
    paintLayers = layers;
    activeLayer = paintLayers[paintLayers.length - 1];
    paintCtx = activeLayer.canvas.getContext('2d');
    if (paintBaseCanvas) {
      var bc = document.createElement('canvas');
      bc.width = workW; bc.height = workH;
      var bg = bc.getContext('2d');
      bg.save();
      if (horizontal) bg.scale(-1, 1), bg.translate(-workW, 0);
      else bg.scale(1, -1), bg.translate(0, -workH);
      bg.drawImage(paintBaseCanvas, 0, 0);
      bg.restore();
      paintBaseCanvas = bc;
    }
    paintUndoStack = []; // layer canvases were replaced
    paintRedoStack = [];
    compositeDisplay();
    toast(horizontal ? 'Flipped horizontally' : 'Flipped vertically');
  }

  function rotateCanvas(cw) {
    pushUndo();
    var layers = paintLayers.map(function (l) {
      var cv = document.createElement('canvas');
      cv.width = cw ? workH : workW;
      cv.height = cw ? workW : workH;
      var g = cv.getContext('2d');
      g.save();
      g.translate(cv.width / 2, cv.height / 2);
      g.rotate((cw ? 1 : -1) * Math.PI / 2);
      g.drawImage(l.canvas, -workW / 2, -workH / 2);
      g.restore();
      return Object.assign({}, l, { canvas: cv });
    });
    paintLayers = layers;
    activeLayer = paintLayers[paintLayers.length - 1];
    paintCtx = activeLayer.canvas.getContext('2d');
    if (paintBaseCanvas) {
      var bc = document.createElement('canvas');
      bc.width = cw ? workH : workW;
      bc.height = cw ? workW : workH;
      var bg = bc.getContext('2d');
      bg.save();
      bg.translate(bc.width / 2, bc.height / 2);
      bg.rotate((cw ? 1 : -1) * Math.PI / 2);
      bg.drawImage(paintBaseCanvas, -workW / 2, -workH / 2);
      bg.restore();
      paintBaseCanvas = bc;
    }
    // rotate swaps work dims
    var nw = paintLayers.length ? paintLayers[0].canvas.width : workH;
    var nh = paintLayers.length ? paintLayers[0].canvas.height : workW;
    workW = nw; workH = nh;
    state.aspect = 'custom'; state.customW = nw; state.customH = nh;
    applyWorkSize();
    paintCanvas.width = workW; paintCanvas.height = workH;
    paintDispCtx = paintCanvas.getContext('2d');
    if (overlayCv) { overlayCv.width = workW; overlayCv.height = workH; overlayCtx = overlayCv.getContext('2d'); }
    sel = null; selMaskCv = null; cropRect = null;
    resetHistory(); // layer canvases were replaced
    stopAnts();
    fitCanvas();
    rebuildLayerUI();
    compositeDisplay();
    refreshOnion();
    toast('Canvas rotated');
  }

  // free transform

  function xfrmBegin() {
    if (!activeLayer) return;
    pushUndo();
    // operate on the active layer (or selection content if a selection exists)
    var src = document.createElement('canvas');
    src.width = workW; src.height = workH;
    var sg = src.getContext('2d');
    sg.drawImage(activeLayer.canvas, 0, 0);
    if (selMaskCv) { sg.globalCompositeOperation = 'destination-in'; sg.drawImage(selMaskCv, 0, 0); }
    var bb = selBounds() || { x: 0, y: 0, w: workW, h: workH };
    xfrm = {
      src: src, mask: selMaskCv, bb: bb,
      x: bb.x, y: bb.y, w: bb.w, h: bb.h, rot: 0,
      dragging: null, dragStart: null,
      restoreData: activeLayer.canvas.getContext('2d').getImageData(0, 0, workW, workH)
    };
    renderOverlay();
  }

  function renderXfrm(g) {
    if (!xfrm) return;
    var f = xfrm;
    // bounding box
    g.save();
    g.translate(f.x + f.w / 2, f.y + f.h / 2);
    g.rotate(f.rot);
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 1;
    g.strokeRect(-f.w / 2, -f.h / 2, f.w, f.h);
    // corners + edge midpoints
    g.fillStyle = '#fff';
    [[-f.w / 2, -f.h / 2], [f.w / 2, -f.h / 2], [-f.w / 2, f.h / 2], [f.w / 2, f.h / 2]]
      .forEach(function (c) { g.fillRect(c[0] - 3, c[1] - 3, 6, 6); });
    g.fillStyle = 'rgba(255,255,255,0.7)';
    [[0, -f.h / 2], [0, f.h / 2], [-f.w / 2, 0], [f.w / 2, 0]]
      .forEach(function (c) { g.fillRect(c[0] - 2, c[1] - 2, 4, 4); });
    // rotate handle above the top-center
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(0, -f.h / 2 - 14, 3.5, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(0, -f.h / 2 - 10);
    g.lineTo(0, -f.h / 2 - 4);
    g.stroke();
    g.restore();
    // live preview of the transformed content
    if (f.dragging) {
      var tmp = document.createElement('canvas');
      tmp.width = workW; tmp.height = workH;
      var t = tmp.getContext('2d');
      t.save();
      t.translate(f.x + f.w / 2, f.y + f.h / 2);
      t.rotate(f.rot);
      t.drawImage(f.src, 0, 0, workW, workH, -f.w / 2, -f.h / 2, f.w, f.h);
      t.restore();
      overlayCtx.globalAlpha = 0.6;
      overlayCtx.drawImage(tmp, 0, 0);
      overlayCtx.globalAlpha = 1;
    }
  }

  function xfrmDown(p) {
    if (!xfrm) xfrmBegin();
    if (!xfrm) return;
    var f = xfrm;
    // Hit-test in the box's local frame (rotated back), then decide the mode:
    // corner/edge -> scale (anchored), inside -> move, outside -> rotate.
    var cx = f.x + f.w / 2, cy = f.y + f.h / 2;
    var dx = p.x - cx, dy = p.y - cy;
    var cosr = Math.cos(-f.rot), sinr = Math.sin(-f.rot);
    var lx = dx * cosr - dy * sinr, ly = dx * sinr + dy * cosr;
    var hw = f.w / 2, hh = f.h / 2;
    var onX = Math.abs(Math.abs(lx) - hw) < 10;
    var onY = Math.abs(Math.abs(ly) - hh) < 10;
    var inX = Math.abs(lx) < hw, inY = Math.abs(ly) < hh;
    var mode = 'rotate', handle = null;
    if (onX && onY) { mode = 'scale'; handle = { sx: lx >= 0 ? 1 : -1, sy: ly >= 0 ? 1 : -1 }; }
    else if (onX && inY) { mode = 'scale'; handle = { sx: lx >= 0 ? 1 : -1, sy: 0 }; }
    else if (onY && inX) { mode = 'scale'; handle = { sx: 0, sy: ly >= 0 ? 1 : -1 }; }
    else if (inX && inY) { mode = 'move'; }
    f.dragging = mode;
    f.handle = handle;
    f.dragStart = { x: p.x, y: p.y, x0: f.x, y0: f.y, cx: cx, cy: cy, w: f.w, h: f.h, rot: f.rot };
  }

  function xfrmMove(p) {
    if (!xfrm || !xfrm.dragging) return;
    var f = xfrm, ds = f.dragStart;
    var dx = p.x - ds.x, dy = p.y - ds.y;
    if (f.dragging === 'move') {
      f.x = ds.x0 + dx; f.y = ds.y0 + dy;
    } else if (f.dragging === 'rotate') {
      f.rot = Math.atan2(p.y - ds.cy, p.x - ds.cx) - Math.atan2(ds.y - ds.cy, ds.x - ds.cx);
    } else if (f.dragging === 'scale') {
      scaleXfrm(f, ds, p);
    }
    renderOverlay();
  }

  // Anchored, non-uniform scaling: the corner/edge being dragged keeps the
  // opposite corner/edge fixed, so the grabbed handle stays under the cursor
  // (Krita/Photoshop behaviour). Rotation is preserved.
  function scaleXfrm(f, ds, p) {
    var h = f.handle;
    if (!h) return;
    // pointer in the start box's local frame
    var cosr = Math.cos(-ds.rot), sinr = Math.sin(-ds.rot);
    var pdx = p.x - ds.cx, pdy = p.y - ds.cy;
    var plx = pdx * cosr - pdy * sinr;
    var ply = pdx * sinr + pdy * cosr;
    // anchor (opposite the handle) in the start box's local frame
    var ax = h.sx === 0 ? 0 : -h.sx * ds.w / 2;
    var ay = h.sy === 0 ? 0 : -h.sy * ds.h / 2;
    // new size: distance from the anchor to the pointer along the dragged axes
    var nw = ds.w, nh = ds.h;
    if (h.sx !== 0) nw = clamp((plx - ax) * h.sx, 2, workW * 8);
    if (h.sy !== 0) nh = clamp((ply - ay) * h.sy, 2, workH * 8);
    // keep the anchor fixed in world space
    var cosA = Math.cos(ds.rot), sinA = Math.sin(ds.rot);
    var awx = ds.cx + (ax * cosA - ay * sinA);
    var awy = ds.cy + (ax * sinA + ay * cosA);
    var nax = h.sx === 0 ? 0 : -h.sx * nw / 2;
    var nay = h.sy === 0 ? 0 : -h.sy * nh / 2;
    f.w = nw; f.h = nh;
    f.x = awx - (nax * cosA - nay * sinA) - nw / 2;
    f.y = awy - (nax * sinA + nay * cosA) - nh / 2;
  }

  function xfrmUp() {
    if (!xfrm) return;
    if (xfrm.dragging) commitXfrm();
    else { xfrm = null; compositeDisplay(); }
  }

  // Bake the transformed content into the layer.
  function commitXfrm() {
    var f = xfrm;
    if (!f) return;
    var ctx = activeLayer.canvas.getContext('2d');
    // clear the original selection area, then draw transformed content
    ctx.save();
    if (f.mask) { ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(f.mask, 0, 0); }
    else ctx.clearRect(0, 0, workW, workH);
    ctx.restore();
    ctx.save();
    ctx.translate(f.x + f.w / 2, f.y + f.h / 2);
    ctx.rotate(f.rot);
    ctx.drawImage(f.src, 0, 0, workW, workH, -f.w / 2, -f.h / 2, f.w, f.h);
    ctx.restore();
    xfrm = null;
    compositeDisplay();
  }

  function cancelXfrm() {
    if (xfrm) {
      if (activeLayer && xfrm.restoreData) activeLayer.canvas.getContext('2d').putImageData(xfrm.restoreData, 0, 0);
      xfrm = null;
      compositeDisplay();
    }
  }

  var evShift = false;

  // wiring for extra tools

  function wireExtraTools() {
    Object.keys(TOOL_BUTTONS).forEach(function (t) {
      var b = byId(TOOL_BUTTONS[t]);
      if (b) b.addEventListener('click', function () { setPaintTool(t); });
    });
    var m = byId('paintSelMode');
    if (m) m.addEventListener('change', function () { selMode = this.value; });
    var fe = byId('paintSelFeather');
    if (fe) fe.addEventListener('input', function () {
      setVal('paintSelFeather', this.value, this.value + 'px');
      if (sel) { sel.feather = +this.value; buildSelMask(); compositeDisplay(); }
    });
    var ft = byId('paintFillTol');
    if (ft) ft.addEventListener('input', function () { setVal('paintFillTol', this.value, this.value); });
    var wt = byId('paintWandTol');
    if (wt) wt.addEventListener('input', function () { setVal('paintWandTol', this.value, this.value); });
    var b1 = byId('btnPaintSelAll'); if (b1) b1.addEventListener('click', selectAll);
    var b2 = byId('btnPaintSelNone'); if (b2) b2.addEventListener('click', selectNone);
    var b3 = byId('btnPaintSelInvert'); if (b3) b3.addEventListener('click', invertSelection);
    var b4 = byId('btnPaintSelDelete'); if (b4) b4.addEventListener('click', deleteSelection);
    var b5 = byId('btnPaintSelGrow'); if (b5) b5.addEventListener('click', function () { growShrinkSel(1); });
    var b6 = byId('btnPaintSelShrink'); if (b6) b6.addEventListener('click', function () { growShrinkSel(-1); });
    var c1 = byId('btnPaintCropApply'); if (c1) c1.addEventListener('click', applyCrop);
    var c2 = byId('btnPaintCropCancel'); if (c2) c2.addEventListener('click', cancelCrop);
    // image menu
    var imgBtn = byId('btnPaintImageMenu'), imgMenu = byId('paintImageMenu');
    if (imgBtn && imgMenu) {
      imgBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        imgMenu.classList.toggle('hidden');
        if (!imgMenu.classList.contains('hidden')) clampMenuToViewport(imgMenu);
      });
      imgMenu.addEventListener('click', function (e) { e.stopPropagation(); });
      document.addEventListener('click', function () { imgMenu.classList.add('hidden'); });
    }
    var fh = byId('btnPaintFlipH'); if (fh) fh.addEventListener('click', function () { flipCanvas(true); });
    var fv = byId('btnPaintFlipV'); if (fv) fv.addEventListener('click', function () { flipCanvas(false); });
    var rc = byId('btnPaintRotCW'); if (rc) rc.addEventListener('click', function () { rotateCanvas(true); });
    var rcc = byId('btnPaintRotCCW'); if (rcc) rcc.addEventListener('click', function () { rotateCanvas(false); });
    var rs = byId('btnPaintResize'); if (rs) rs.addEventListener('click', openResizeDialog);
    var csz = byId('btnPaintCanvasSize'); if (csz) csz.addEventListener('click', openResizeDialog);
    var ra = byId('btnPaintResizeApply'); if (ra) ra.addEventListener('click', applyResizeDialog);
    var rcl = byId('btnPaintResizeCancel'); if (rcl) rcl.addEventListener('click', function () {
      var d = byId('paintResizeDialog'); if (d) d.classList.add('hidden');
    });
    // leaving the paint editor with unsaved changes: confirm before closing
    var ly = byId('btnPaintLeaveYes');
    if (ly) ly.addEventListener('click', function () { confirmLeavePaint(true); });
    var ln = byId('btnPaintLeaveNo');
    if (ln) ln.addEventListener('click', function () { confirmLeavePaint(false); });

    // library naming dialog (Enter commits, Esc cancels)
    var nameOk = byId('btnPaintNameOk');
    if (nameOk) nameOk.addEventListener('click', submitNameDialog);
    var nameCancel = byId('btnPaintNameCancel');
    if (nameCancel) nameCancel.addEventListener('click', cancelNameDialog);
    var nameIn = byId('paintNameInput');
    if (nameIn) nameIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitNameDialog(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelNameDialog(); }
    });

    // canvas zoom / pan: wheel zooms toward the cursor, middle-drag (or
    // shift+drag on the brush) pans anywhere in the viewport — even outside the
    // canvas — and double-clicking empty space or the Fit button re-centers.
    var wrap = byId('paintCanvasWrap');
    if (wrap) {
      wrap.addEventListener('wheel', function (e) {
        e.preventDefault();
        var r = wrap.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      }, { passive: false });
      wrap.addEventListener('dblclick', function (e) {
        // only empty-space double-clicks fit; double-clicking the canvas draws
        if (e.target === wrap) fitView();
      });
      wrap.addEventListener('pointerdown', function (e) {
        if (e.button === 1 || (e.button === 0 && e.shiftKey && (paintTool === 'brush' || paintTool === 'eraser'))) {
          e.preventDefault();
          panning = true;
          panStart = { x: e.clientX, y: e.clientY, px: paintPanX, py: paintPanY };
          try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
        }
      });
      wrap.addEventListener('pointermove', function (e) {
        if (panning && panStart) {
          paintPanX = panStart.px + (e.clientX - panStart.x);
          paintPanY = panStart.py + (e.clientY - panStart.y);
          fitCanvas();
        }
      });
      var endPan = function () { panning = false; };
      wrap.addEventListener('pointerup', endPan);
      wrap.addEventListener('pointercancel', endPan);
    }
    // status-bar zoom controls (fit re-centers)
    var zi = byId('btnPaintZoomIn'), zo = byId('btnPaintZoomOut'), zf = byId('btnPaintFit');
    if (wrap) {
      var wrapCenter = function () {
        var r = wrap.getBoundingClientRect();
        return { x: r.width / 2, y: r.height / 2 };
      };
      if (zi) zi.addEventListener('click', function () { var c = wrapCenter(); zoomAt(c.x, c.y, 1.25); });
      if (zo) zo.addEventListener('click', function () { var c = wrapCenter(); zoomAt(c.x, c.y, 1 / 1.25); });
    }
    if (zf) zf.addEventListener('click', fitView);
    // keyboard: tool shortcuts + selection/crop keys
    document.addEventListener('keydown', function (e) {
      if (!paintOpen) return;
      evShift = !!e.shiftKey;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      var mod = e.ctrlKey || e.metaKey;
      var k = e.key.toLowerCase();
      if (e.key === 'Escape') {
        // A leave-confirm dialog that is already up is dismissed with Esc.
        var ld3 = byId('paintLeaveDialog');
        if (ld3 && !ld3.classList.contains('hidden')) { confirmLeavePaint(false); e.preventDefault(); return; }
        if (cropRect) { cancelCrop(); e.preventDefault(); return; }
        if (xfrm) { cancelXfrm(); e.preventDefault(); return; }
        if (sel) { selectNone(); e.preventDefault(); return; }
        requestClosePaint();
        return;
      }
      if (mod && k === 'd') { e.preventDefault(); selectNone(); return; }
      if (mod && k === 'a') { e.preventDefault(); selectAll(); return; }
      if (mod && e.shiftKey && k === 'i') { e.preventDefault(); invertSelection(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (sel || selMaskCv)) { e.preventDefault(); deleteSelection(); return; }
      if (e.key === 'Enter') {
        if (cropRect) { applyCrop(); e.preventDefault(); return; }
        if (xfrm) { commitXfrm(); e.preventDefault(); return; }
      }
      if (mod) return;
      if (k === 'b') setPaintTool('brush');
      else if (k === 'e') setPaintTool('eraser');
      else if (k === 's') setPaintTool('select');
      else if (k === 'l') setPaintTool('lasso');
      else if (k === 'w') setPaintTool('wand');
      else if (k === 'v') setPaintTool('move');
      else if (k === 't') setPaintTool('transform');
      else if (k === 'g') setPaintTool('fill');
      else if (k === 'i') setPaintTool('eyedrop');
      else if (k === 'c') setPaintTool('crop');
      else if (k === 'u') setPaintTool('rect');
    });
    document.addEventListener('keyup', function () { evShift = false; });
  }

  // wand select tool

  // Magic-wand: select the contiguous (or every) pixel matching the clicked
  // whose RGBA matches the clicked pixel within tolerance, like Krita's Wand.
  // The result is a pixel-mask selection ({type:'mask'}), so feather, invert,
  // grow/shrink, masked painting and move all keep working on it.
  function wandDown(p) {
    // Sample the COMPOSITE (what the user sees, like Photoshop / Krita's
    // composite mode): selecting against only the active layer made the wand
    // pick the whole canvas whenever the art lived on another layer or the
    // base image.
    var src = paintDispCtx ? paintCanvas : null;
    if (!src) return;
    var tolEl = byId('paintWandTol');
    var tol = +(tolEl ? tolEl.value : 8);
    var contigEl = byId('paintWandContiguous');
    var contig = !contigEl || contigEl.checked;
    var w = workW, h = workH;
    var img = src.getContext('2d').getImageData(0, 0, w, h);
    var d = img.data;
    var x0 = Math.round(p.x), y0 = Math.round(p.y);
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return;
    var idx0 = (y0 * w + x0) * 4;
    var r0 = d[idx0], g0 = d[idx0 + 1], b0 = d[idx0 + 2], a0 = d[idx0 + 3];
    var tolSq = tol * tol * 4; // RGB + alpha all count towards the distance
    var mask = document.createElement('canvas');
    mask.width = w; mask.height = h;
    var mg = mask.getContext('2d');
    var mImg = mg.createImageData(w, h);
    var md = mImg.data;
    var minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    function mark(pi, xx, yy) {
      md[pi * 4 + 3] = 255;
      if (xx < minX) minX = xx; if (xx > maxX) maxX = xx;
      if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
    }
    function matchIdx(i) {
      var dr = d[i] - r0, dg = d[i + 1] - g0, db = d[i + 2] - b0, da = d[i + 3] - a0;
      return dr * dr + dg * dg + db * db + da * da <= tolSq;
    }
    if (contig) {
      var stack = [x0, y0];
      var seen = new Uint8Array(w * h);
      while (stack.length) {
        var yy = stack.pop(), xx = stack.pop();
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        var pi = yy * w + xx;
        if (seen[pi]) continue;
        seen[pi] = 1;
        if (!matchIdx(pi * 4)) continue;
        mark(pi, xx, yy);
        stack.push(xx + 1, yy, xx - 1, yy, xx, yy + 1, xx, yy - 1);
      }
    } else {
      for (var i = 0; i < d.length; i += 4) if (matchIdx(i)) mark(i / 4, (i / 4) % w, Math.floor(i / 4 / w));
    }
    mg.putImageData(mImg, 0, 0);
    // clicking transparent emptiness selects the (empty) region around art -
    // that is the whole transparent canvas, so a click on nothing is nothing
    if (maxX < 0) { sel = null; selMaskCv = null; compositeDisplay(); return; }
    var hint = (minX === Infinity) ? null : { x: minX - 1, y: minY - 1, w: maxX - minX + 3, h: maxY - minY + 3 };
    sel = { type: 'mask', mask: mask, feather: selFeatherVal(), maskHint: hint };
    buildSelMask();
    startAnts();
    compositeDisplay();
  }

  // Tool handlers dispatched from the shared pointer handlers above.
  var toolHandlers = {
    select:    { down: selDown,    move: selMove,    up: selUp },
    lasso:     { down: selDown,    move: selMove,    up: selUp },
    wand:      { down: wandDown },
    move:      { down: moveDown,   move: moveMove,   up: moveUp },
    transform: { down: xfrmDown,   move: xfrmMove,   up: xfrmUp },
    fill:      { down: fillDown },
    eyedrop:   { down: eyedropDown },
    line:      { down: lineDown,   move: lineMove,   up: lineUp },
    rect:      { down: shapeDown,  move: shapeMove,  up: shapeUp },
    ellipse:   { down: shapeDown,  move: shapeMove,  up: shapeUp },
    crop:      { down: cropDown,   move: cropMove,   up: cropUp }
  };
