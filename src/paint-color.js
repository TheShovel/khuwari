// Paint: colour math (HSV/hex), the colour wheel and swatches.
'use strict';
  function hexToRgb(hex) {
    hex = String(hex || '#000000').replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  // color wheel (HSV)
  // Krita-style picker: a hue slider on the right and an SV (brightness /
  // saturation) square to its left. `cwHsv` is the working color in HSV.
  var cwHsv = { h: 0, s: 1, v: 1 };
  var cwSvCv = null, cwHueCv = null;   // canvases, grabbed at wire time
  var cwDragging = null;               // 'sv' | 'hue'

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, v = max;
    var d = max - min;
    if (d !== 0) {
      s = d / max;
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: h * 360, s: s, v: v };
  }

  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360 / 360;
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    var r, g, b;
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      default: r = v; g = p; b = q; break;
    }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
  }

  function rgbToHex(r, g, b) {
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  // Redraw the SV square for the current hue (white->hue horizontally,
  // transparent->black vertically), then the dot and hue marker positions.
  function renderColorWheel() {
    if (!cwSvCv || !cwHueCv) return;
    var svg = cwSvCv.getContext('2d');
    var w = cwSvCv.width, h = cwSvCv.height;
    var hc = hsvToRgb(cwHsv.h, 1, 1);
    var grad = svg.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(1, 'rgb(' + hc.r + ',' + hc.g + ',' + hc.b + ')');
    svg.fillStyle = grad;
    svg.fillRect(0, 0, w, h);
    var vgrad = svg.createLinearGradient(0, 0, 0, h);
    vgrad.addColorStop(0, 'rgba(0,0,0,0)');
    vgrad.addColorStop(1, 'rgba(0,0,0,1)');
    svg.fillStyle = vgrad;
    svg.fillRect(0, 0, w, h);

    // hue slider: the classic six-stop rainbow, top -> bottom
    var hg = cwHueCv.getContext('2d');
    var stops = [0, 60, 120, 180, 240, 300, 360];
    var hgrad = hg.createLinearGradient(0, 0, 0, cwHueCv.height);
    stops.forEach(function (deg) {
      var c = hsvToRgb(deg, 1, 1);
      hgrad.addColorStop(deg / 360, 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')');
    });
    hg.fillStyle = hgrad;
    hg.fillRect(0, 0, cwHueCv.width, cwHueCv.height);

    positionColorWheel();
  }

  function positionColorWheel() {
    var dot = byId('paintCwDot');
    if (dot && cwSvCv) {
      var rect = cwSvCv.getBoundingClientRect();
      dot.style.left = (cwHsv.s * rect.width) + 'px';
      dot.style.top = ((1 - cwHsv.v) * rect.height) + 'px';
    }
    var mk = byId('paintCwHueMarker');
    if (mk && cwHueCv) {
      var hrect = cwHueCv.getBoundingClientRect();
      mk.style.top = ((cwHsv.h / 360) * hrect.height) + 'px';
    }
  }

  // Push cwHsv into current.color (and the toolbar swatch + hex inputs).
  function applyColorWheel() {
    var c = hsvToRgb(cwHsv.h, cwHsv.s, cwHsv.v);
    var hex = rgbToHex(c.r, c.g, c.b);
    setPaintColor(hex);
    var hexIn = byId('paintCwHex');
    if (hexIn && hexIn !== document.activeElement) hexIn.value = hex;
    refreshTip();
    positionColorWheel();
  }

  // Re-read current.color into cwHsv (after eyedrop / toolbar input / brush pick).
  function syncColorWheel() {
    var c = hexToRgb(current ? current.color : '#1a1a1a');
    var h = rgbToHsv(c.r, c.g, c.b);
    cwHsv.h = h.h; cwHsv.s = h.s; cwHsv.v = h.v;
    renderColorWheel();
  }

  // Update the toolbar colour indicator (display-only swatch).
  function setColorSwatch(hex) {
    var sw = byId('paintColor');
    if (sw) sw.style.background = hex;
  }

  // Record the picked foreground colour (global) and push it onto the current
  // brush, so the swatch, color wheel and every paint path stay in step.
  function setPaintColor(hex) {
    if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) hex = fgColor;
    hex = hex.toLowerCase();
    fgColor = hex;
    if (current) current.color = hex;
    setColorSwatch(hex);
    return hex;
  }

  // Record a colour only when it was actually painted onto the canvas: a real
  // brush stroke, line, shape or bucket fill. Picking a colour (wheel / hex /
  // eyedropper) alone does not touch the history, and eraser strokes never add
  // anything (no colour was laid down).
  function rememberUsedColor() {
    if (eraserOn || (current && current.eraser)) return;
    rememberRecentColor(current ? current.color : fgColor);
  }

  // Remember a colour the user actually settled on (newest first, 8 max,
  // deduped) in the project state, and refresh the Recent swatches.
  function rememberRecentColor(hex) {
    if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    hex = hex.toLowerCase();
    if (!Array.isArray(state.colorHistory)) state.colorHistory = [];
    var i = state.colorHistory.indexOf(hex);
    if (i === 0) return;                       // already the newest
    if (i > 0) state.colorHistory.splice(i, 1); // re-promote earlier entries
    state.colorHistory.unshift(hex);
    if (state.colorHistory.length > 8) state.colorHistory.length = 8;
    renderRecentColors();
  }

  function renderRecentColors() {
    var box = byId('paintRecentColors');
    if (!box) return;
    box.innerHTML = '';
    if (!Array.isArray(state.colorHistory)) state.colorHistory = [];
    state.colorHistory.forEach(function (hex) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'paint-recent-swatch';
      b.style.background = hex;
      b.title = hex;
      b.addEventListener('click', function () {
        setPaintColor(hex);
        refreshTip();
        syncColorWheel();
      });
      box.appendChild(b);
    });
  }
