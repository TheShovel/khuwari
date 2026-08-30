// Paint: non-destructive layer filters (Krita-style). Each filter is a small
// {type, ...params} object on the layer; the stack composites through the
// canvas 2D ctx.filter (blur/brightness/saturate/... are GPU-accelerated in
// Chromium and Firefox, and Safari 18+ ships them too). Filters re-render on
// every composite, so they stay live while painting underneath, and they
// persist with the layer through project/library saves.
'use strict';

  // Filter registry: UI specs + the CSS fragment each filter emits. `v` is the
  // primary slider value; the drop shadow carries its own params instead.
  var PAINT_FILTERS = {
    blur: {
      label: 'Gaussian blur', def: 4, min: 0, max: 64, step: 1, unit: 'px',
      css: function (f) { return 'blur(' + f.v + 'px)'; }
    },
    brightness: {
      label: 'Brightness', def: 1.2, min: 0, max: 3, step: 0.01, unit: '%',
      css: function (f) { return 'brightness(' + f.v + ')'; }
    },
    contrast: {
      label: 'Contrast', def: 1.2, min: 0, max: 3, step: 0.01, unit: '%',
      css: function (f) { return 'contrast(' + f.v + ')'; }
    },
    saturate: {
      label: 'Saturation', def: 1.5, min: 0, max: 3, step: 0.01, unit: '%',
      css: function (f) { return 'saturate(' + f.v + ')'; }
    },
    hue: {
      label: 'Hue', def: 30, min: -180, max: 180, step: 1, unit: 'deg',
      css: function (f) { return 'hue-rotate(' + f.v + 'deg)'; }
    },
    grayscale: {
      label: 'Grayscale', def: 1, min: 0, max: 1, step: 0.01, unit: '%',
      css: function (f) { return 'grayscale(' + f.v + ')'; }
    },
    invert: {
      label: 'Invert', def: 1, min: 0, max: 1, step: 0.01, unit: '%',
      css: function (f) { return 'invert(' + f.v + ')'; }
    },
    sepia: {
      label: 'Sepia', def: 1, min: 0, max: 1, step: 0.01, unit: '%',
      css: function (f) { return 'sepia(' + f.v + ')'; }
    },
    shadow: {
      label: 'Drop shadow',
      def: { x: 4, y: 4, blur: 6, color: 'rgba(0,0,0,0.6)' },
      xMin: -64, xMax: 64, min: 0, max: 64, step: 1, unit: 'px',
      css: function (f) {
        return 'drop-shadow(' + (+f.x || 0) + 'px ' + (+f.y || 0) + 'px ' +
          (+f.blur || 0) + 'px ' + (f.color || 'rgba(0,0,0,0.6)') + ')';
      }
    }
  };
  // Order shown in the docker and used for the CSS chain (filters apply in
  // the order they were added to the layer).
  var PAINT_FILTER_ORDER = ['blur', 'brightness', 'contrast', 'saturate', 'hue', 'grayscale', 'invert', 'sepia', 'shadow'];

  function filterDef(type) { return PAINT_FILTERS[type] || null; }

  // The canvas 2D filter string for a whole layer stack ('none' when empty).
  function layerFilterCSS(l) {
    if (!l || !l.filters || !l.filters.length) return 'none';
    var parts = [];
    l.filters.forEach(function (f) {
      var d = filterDef(f && f.type);
      if (!d) return;
      var css = d.css(f);
      if (css) parts.push(css);
    });
    return parts.length ? parts.join(' ') : 'none';
  }

  // Canvas 2D filters need the ctx.filter property (Chromium 52+, Firefox 49+,
  // Safari 18+). Older engines silently ignore it, so we warn once.
  function canvasFiltersSupported() {
    try {
      var ctx = document.createElement('canvas').getContext('2d');
      return !!(ctx && typeof ctx.filter === 'string');
    } catch (e) { return false; }
  }
  var filtersSupported = canvasFiltersSupported();
  var filterWarned = false;

  function makeLayerFilter(type) {
    var d = filterDef(type);
    if (!d) return null;
    if (type === 'shadow') {
      return { type: 'shadow', x: d.def.x, y: d.def.y, blur: d.def.blur, color: d.def.color };
    }
    return { type: type, v: d.def };
  }

  // Sanitize a (possibly project-file supplied) filter object in place.
  function clampLayerFilter(f) {
    var d = filterDef(f && f.type);
    if (!d) return null;
    if (f.type === 'shadow') {
      f.x = clamp(+f.x || 0, d.xMin, d.xMax);
      f.y = clamp(+f.y || 0, d.xMin, d.xMax);
      f.blur = clamp(+f.blur || 0, d.min, d.max);
      if (typeof f.color !== 'string' || !f.color) f.color = d.def.color;
    } else {
      f.v = clamp(+f.v != null ? +f.v : d.def, d.min, d.max);
    }
    return f;
  }

  function fmtFilterVal(f) {
    var d = filterDef(f.type);
    var v = f.type === 'shadow' ? f.blur : f.v;
    if (d.unit === '%') return Math.round(v * 100) + '%';
    if (d.unit === 'deg') return Math.round(v) + '\u00b0';
    return (d.step >= 1 ? Math.round(v) : Math.round(v * 100) / 100) + ' ' + d.unit;
  }

  // Convert the stored colour to a hex value for <input type=color> (alpha is
  // kept only in the stored rgba default; picking a colour makes it opaque).
  function filterColorHex(color) {
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) return color;
    return '#000000';
  }

  // Rebuild the Filters docker for the active layer: one row per filter on it.
  // Dragging a slider previews live (composite + thumbnails), like Krita.
  function rebuildFilterUI() {
    var list = byId('paintFilterList');
    if (!list) return;
    list.innerHTML = '';
    if (!activeLayer) return;
    function refresh() { compositeDisplay(); refreshLayerThumbs(); }
    (activeLayer.filters || []).forEach(function (f, fi) {
      var d = filterDef(f && f.type);
      if (!d) return;
      var row = document.createElement('div');
      row.className = 'paint-filter-row';
      var head = document.createElement('div');
      head.className = 'paint-filter-head';
      var lab = document.createElement('span');
      lab.className = 'paint-filter-name';
      lab.textContent = d.label;
      head.appendChild(lab);
      if (f.type !== 'shadow') {
        var val = document.createElement('span');
        val.className = 'paint-filter-val mono';
        head.appendChild(val);
      }
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'paint-icon-btn danger paint-filter-del';
      del.title = 'Remove filter';
      del.textContent = '\u00d7';
      del.addEventListener('click', function () { removeLayerFilter(fi); });
      head.appendChild(del);
      row.appendChild(head);
      // Drop shadow: offset X/Y + blur sliders and a colour swatch.
      if (f.type === 'shadow') {
        [['x', 'X'], ['y', 'Y'], ['blur', 'Blur']].forEach(function (pair) {
          var key = pair[0], label = pair[1];
          var sub = document.createElement('div');
          sub.className = 'paint-filter-subrow';
          var n = document.createElement('span');
          n.className = 'paint-filter-n';
          n.textContent = label;
          sub.appendChild(n);
          var s = document.createElement('input');
          s.type = 'range';
          s.className = 'slider';
          s.min = key === 'blur' ? String(d.min) : String(d.xMin);
          s.max = key === 'blur' ? String(d.max) : String(d.xMax);
          s.step = String(d.step);
          s.value = String(f[key]);
          syncSlider(s);
          s.addEventListener('input', function () {
            f[key] = +this.value;
            compositeDisplay();
            refreshLayerThumbs();
          });
          sub.appendChild(s);
          row.appendChild(sub);
        });
        var colorRow = document.createElement('div');
        colorRow.className = 'paint-filter-subrow';
        var cLab = document.createElement('span');
        cLab.className = 'paint-filter-n';
        cLab.textContent = 'Color';
        colorRow.appendChild(cLab);
        var color = document.createElement('input');
        color.type = 'color';
        color.className = 'paint-filter-color';
        color.value = filterColorHex(f.color);
        color.title = 'Shadow colour';
        color.addEventListener('input', function () { f.color = this.value; compositeDisplay(); refreshLayerThumbs(); });
        colorRow.appendChild(color);
        row.appendChild(colorRow);
      } else {
        val.textContent = fmtFilterVal(f);
        var s = document.createElement('input');
        s.type = 'range';
        s.className = 'slider';
        s.min = String(d.min); s.max = String(d.max); s.step = String(d.step);
        s.value = String(f.v);
        syncSlider(s);
        s.addEventListener('input', function () {
          f.v = clamp(+this.value, d.min, d.max);
          val.textContent = fmtFilterVal(f);
          refresh();
        });
        row.appendChild(s);
      }
      list.appendChild(row);
    });
  }

  // Add a filter to the active layer (used by the docker "Add" button).
  function addLayerFilter(type) {
    if (!activeLayer) return;
    if (!filtersSupported) {
      if (!filterWarned) {
        filterWarned = true;
        toast('Layer filters need canvas filter support (Chromium, Firefox or Safari 18+)', 3500);
      }
      return;
    }
    var f = makeLayerFilter(type);
    if (!f) return;
    if (!activeLayer.filters) activeLayer.filters = [];
    activeLayer.filters.push(f);
    rebuildFilterUI();
    compositeDisplay();
    refreshLayerThumbs();
  }

  function removeLayerFilter(idx) {
    if (!activeLayer || !activeLayer.filters) return;
    activeLayer.filters.splice(idx, 1);
    rebuildFilterUI();
    compositeDisplay();
    refreshLayerThumbs();
  }