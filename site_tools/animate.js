/* Animated home page figures: captures a short GIF of each featured action,
 * with a mouse cursor performing it, then encodes to an animated GIF using the
 * app's own gifenc (in the browser) into shots/. Used by home-figures.js.
 *
 *   node site_tools/animate.js
 *
 * Needs: chromium on PATH, Node 26+ (global WebSocket), and a local server for
 * editor.html (same requirements as shoot.js), e.g.
 *   python3 -m http.server 4000
 * Then point SHOOT_URL at it (default http://localhost:4000/editor.html).
 *
 * Each animation drives the editor's own functions per frame while a fixed
 * cursor overlay follows the action, snapshots the viewport at half scale,
 * then hands the frames to the page to quantize + encode with gifenc.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { assertChrome } = require('../tools/chrome');
const CHROME = assertChrome();
const { ART } = require('./shoot.js');

const ROOT = path.resolve(__dirname, '..');
const URL = process.env.SHOOT_URL || 'http://localhost:4000/editor.html';
const BASE = URL.replace(/\/editor\.html$/, '');
const PORT = 9335;
const OUT = path.join(ROOT, 'shots');
const SCRATCH = path.join(ROOT, '.scratch', 'anim');
const VIEW_W = 1280, VIEW_H = 800;
const SCALE = 0.5;             // -> 640x400 frames
const GIF_W = Math.round(VIEW_W * SCALE);
const GIF_H = Math.round(VIEW_H * SCALE);
const FRAME_DELAY = 100;       // ms per gif frame (~10 fps)

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCRATCH, { recursive: true });

// CDP plumbing (same as shoot.js)
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      }
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
async function connect(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (!page) throw new Error('no page target');
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      return new CDP(ws);
    } catch (e) { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('could not connect to chromium debugger');
}
let cdp;
async function ev(expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception || {};
    throw new Error('page error: ' + (d.description || r.exceptionDetails.text));
  }
  return r.result.value;
}
async function pageEval(expr) { return ev(expr, true); }
async function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function captureFrame(file) {
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: VIEW_W, height: VIEW_H, scale: SCALE }
  });
  fs.writeFileSync(path.join(SCRATCH, file), Buffer.from(r.data, 'base64'));
}

// page-side animation helpers
const PAGE = `
window.__q = function (sel) { return document.querySelector(sel); };

// Mouse cursor overlay: a fixed arrow that follows the action. The hotspot
// (tip of the pointer) sits at roughly (3,3) in the 26px sprite.
(function () {
  var d = document.getElementById('__animCursor');
  if (!d) {
    d = document.createElement('div');
    d.id = '__animCursor';
    d.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;pointer-events:none;z-index:99999;';
    d.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,0.55))">' +
      '<path d="M2 2 L2 20.5 L7.8 15.3 L12 22 L15 20.4 L10.8 13.7 L16.8 13.7 Z" fill="#fff"/>' +
      '<path d="M4 4 L4 18.4 L8.6 14.2 L11.8 19.4 L13.4 18.6 L10.2 13.4 L15 13.4 Z" fill="#2b3340"/></svg>';
    document.body.appendChild(d);
  }
  window.__cursor = function (x, y, down) {
    d.style.left = (x - 3) + 'px';
    d.style.top = (y - 3) + 'px';
    d.style.transform = down ? 'translateY(1px)' : '';
    d.style.opacity = down ? '0.8' : '1';
  };
})();

// Waypoint tween: pts = [[x, y, t, down], ...] with t in 0..1; returns the
// interpolated [x, y, down] at progress p.
window.__tween = function (pts, p) {
  if (pts.length === 1) return [pts[0][0], pts[0][1], !!pts[0][3]];
  if (p <= 0) return [pts[0][0], pts[0][1], !!pts[0][3]];
  var seg = pts[pts.length - 1];
  for (var i = 1; i < pts.length; i++) {
    if (p <= pts[i][2]) {
      var a = pts[i - 1], b = pts[i];
      var f = (b[2] === a[2]) ? 0 : (p - a[2]) / (b[2] - a[2]);
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, !!b[3]];
    }
    seg = pts[i];
  }
  return [seg[0], seg[1], !!seg[3]];
};

window.__anims = {};

// ML inbetweens: drag a pose onto the timeline, the machine fills in
window.__anims.ml = {
  setup: function () {
    cancelRun(); closeMenus();
    __base();
    state.activeLayerId = 'L1';
    state.keyframes.push({ id: 'k1', layer: 'L1', time: 0, img: state.assets[0].img, name: 'hero-left.png', w: 512, h: 512 });
    refreshDirty(); renderAll(); renderPreview();
    window.__mlDropped = false;
  },
  pose: function (i, n) {
    var p = i / (n - 1);
    var grid = __q('#assetGrid').getBoundingClientRect();
    var from = [grid.left + 70, grid.top + 70];
    var row = __q('#lane .layer-row');
    var rowR = row ? row.getBoundingClientRect() : null;
    var lane = __q('#lane').getBoundingClientRect();
    var dropY = rowR ? rowR.top + rowR.height / 2 : lane.top + 40;
    var dropX = 96 + 1.0 * state.zoom; // gutter + time(1.0) * zoom
    var pts = [
      [from[0], from[1], 0.00, false],
      [from[0], from[1], 0.26, false],
      [dropX, dropY, 0.52, true],
      [dropX, dropY, 0.62, true],
      [dropX, dropY, 0.86, false]
    ];
    var c = __tween(pts, p);
    __cursor(c[0], c[1], c[2]);
    if (p >= 0.62 && !window.__mlDropped) {
      window.__mlDropped = true;
      state.keyframes.push({ id: 'k2', layer: 'L1', time: 1.0, img: state.assets[1].img, name: 'hero-mid.png', w: 512, h: 512 });
      refreshDirty();
      __fabricate();
      renderAll();
      renderPreview();
    }
  }
};

// Paint: draw a stroke with the brush on the canvas
window.__anims.paint = {
  setup: function () {
    cancelRun(); closeMenus();
    __base();
    openPaint(); // blank generic workspace
    current.color = '#4f8fff'; current.radius = 10; current.opacity = 1;
    refreshTip(); refreshBrushUI(); syncColorWheel();
    window.__paintLast = null;
  },
  pose: function (i, n) {
    var p = i / (n - 1);
    var cv = document.getElementById('paintCanvas');
    var r = cv.getBoundingClientRect();
    var drawing = p <= 0.85;
    var s = Math.min(1, p * 1.1);
    var px = workW * (0.14 + s * 0.72);
    var py = workH * (0.32 + 0.28 * Math.sin(s * 3.1 - 1.1));
    var sx = r.left + (px / workW) * r.width;
    var sy = r.top + (py / workH) * r.height;
    __cursor(sx, sy, drawing);
    if (drawing) {
      var pt = { x: px, y: py, press: 0.5 };
      if (window.__paintLast) stampSegment(window.__paintLast, pt);
      window.__paintLast = pt;
      compositeDisplay();
    }
  }
};

// Color fill: click to drop dots that flood the line art
window.__anims.fill = {
  setup: function () {
    cancelRun(); closeMenus();
    __base({ playhead: 0 });
    state.layers = [
      { id: 'L1', name: 'Layer 1', visible: true },
      { id: 'L2', name: 'Color 1', visible: true, type: 'fill', dots: [] }
    ];
    state.activeLayerId = 'L2';
    state.keyframes.push({ id: 'k1', layer: 'L1', time: 0, img: state.assets[3].img, name: 'ring.png', w: 512, h: 512 });
    refreshDirty(); renderAll(); renderPreview();
    window.__fill1 = false; window.__fill2 = false;
  },
  pose: function (i, n) {
    var p = i / (n - 1);
    var cv = document.getElementById('previewCanvas');
    var r = cv.getBoundingClientRect();
    // doodle4's interior is one closed region: a single click inside it.
    var d1 = { nx: 0.49, ny: 0.51 };
    var c1 = [r.left + d1.nx * r.width, r.top + d1.ny * r.height];
    var pts = [
      [c1[0], c1[1], 0.00, false],
      [c1[0], c1[1], 0.24, false],
      [c1[0], c1[1], 0.30, true],
      [c1[0], c1[1], 0.34, false],
      [c1[0], c1[1] + 24, 0.9, false]
    ];
    var c = __tween(pts, p);
    __cursor(c[0], c[1], c[2]);
    if (p >= 0.30 && !window.__fill1) {
      window.__fill1 = true;
      state.layers[1].dots.push({ id: 'D1', x: 0.49, y: 0.51, color: '#4f8fff', threshold: 0.5, grow: 1, gradOn: false, gradColor: '#ffffff', gradHeight: 24, gradDir: 'bottom', start: 0, end: 1, dur: 1 });
      refreshDirty(); renderAll(); renderPreview();
    }
  }
};

// Camera: drag the fisheye slider and the frame bulges outward
window.__anims.camera = {
  setup: function () {
    cancelRun(); closeMenus();
    state.camera = { enabled: true, keys: [] };
    __hero();
    state.playhead = 0.5;
    __fabricate(); renderPlayhead();
    var p = document.getElementById('cameraPanel');
    if (p) p.classList.remove('collapsed');
    renderCameraPanel();
  },
  pose: function (i, n) {
    var p = i / (n - 1);
    var v = Math.min(0.9, (p < 0.85 ? (p / 0.85) : 1) * 0.9);
    setCameraField('fx.fisheye', Math.round(v * 100) / 100);
    renderCameraPanel();
    renderPreview();
    renderTimeline();
    var sl = document.getElementById('cameraFxFisheye');
    var r = sl.getBoundingClientRect();
    var min = parseFloat(sl.min), max = parseFloat(sl.max);
    var frac = (v - min) / (max - min);
    __cursor(r.left + frac * r.width, r.top + r.height / 2, p < 0.85);
  }
};

// Motion blur: play the motion, then flip the switch and play it again
// with the smear on, so the blur is actually seen in motion
window.__anims.blur = {
  setup: function () {
    cancelRun(); closeMenus();
    __hero();
    var g = allGaps().filter(function (x) { return x.layer === 'L1'; })[1];
    state.gapType[g.id] = 'squash'; // pure-JS generation (works offline)
    state.selectedGapId = g.id;
    // The inbetween frame times inside the gap, start keyframe to end keyframe.
    var times = [g.fromTime];
    for (var k = 1; k <= g.genCount; k++) {
      times.push(g.fromTime + (g.toTime - g.fromTime) * (k / (g.genCount + 1)));
    }
    times.push(g.toTime);
    window.__blurGap = g;
    window.__blurTimes = times;
    window.__blurOnDone = false;
    state.playhead = g.fromTime;
    // Generate the gap WITHOUT blur first so the "before" sweep can play.
    delete state.generated[g.id];
    delete state.gapMeta[g.id];
    refreshDirty();
    renderAll();
    renderSelectedPanel();
    scheduleGenerate(0);
    window.__animSetupGen = true;
  },
  pose: function (i, n) {
    var p = i / (n - 1);
    var g = window.__blurGap;
    var times = window.__blurTimes;
    var span = function (p, a, b) { return Math.max(0, Math.min(1, (p - a) / (b - a))); };

    var pb = document.getElementById('btnPlay').getBoundingClientRect();
    var playC = [pb.left + pb.width / 2, pb.top + pb.height / 2];
    var cr = document.getElementById('gapBlurOn').getBoundingClientRect();
    var cbC = [cr.left + cr.width / 2, cr.top + cr.height / 2];

    var t = 0;
    var cursor = playC;
    var down = false;

    if (p < 0.24) {
      // sweep the motion, blur off
      down = true;
      t = times[Math.min(times.length - 1, Math.floor(span(p, 0, 0.24) * times.length))];
    } else if (p < 0.44) {
      // glide to the motion-blur switch
      var mc = span(p, 0.24, 0.40);
      cursor = [playC[0] + (cbC[0] - playC[0]) * mc, playC[1] + (cbC[1] - playC[1]) * mc];
      down = p >= 0.40;
      t = g.fromTime + 0.5 * (g.toTime - g.fromTime);
      if (p >= 0.42 && !window.__blurOnDone) {
        window.__blurOnDone = true;
        setGapBlur(g.id, { on: true, intensity: 0.9 });
        delete state.generated[g.id];
        delete state.gapMeta[g.id];
        refreshDirty();
        renderAll();
        renderSelectedPanel();
        scheduleGenerate(0);
        window.__animWaitGen = true;
      }
    } else if (p < 0.8) {
      // play the same motion again, now smeared
      down = true;
      t = times[Math.min(times.length - 1, Math.floor(span(p, 0.44, 0.8) * times.length))];
    } else {
      down = false;
      t = g.toTime;
    }

    __cursor(cursor[0], cursor[1], down);
    state.playhead = t;
    renderPlayhead();
    renderPreview();
    if (typeof renderFilmstrip === 'function') renderFilmstrip();
  }
};
`;

// Page-side GIF encoding with the app's own gifenc.
const ENCODE = `(async function (urls, w, h, delay) {
  var gif = window.gifenc.GIFEncoder();
  for (var i = 0; i < urls.length; i++) {
    var blob = await (await fetch(urls[i])).blob();
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.src = url;
    await img.decode();
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    g.drawImage(img, 0, 0, w, h);
    var rgba = g.getImageData(0, 0, w, h).data;
    var palette = window.gifenc.quantize(rgba, 256);
    var index = window.gifenc.applyPalette(rgba, palette);
    gif.writeFrame(index, w, h, { delay: delay, palette: palette });
    URL.revokeObjectURL(url);
  }
  gif.finish();
  var bytes = gif.bytes();
  var s = '';
  for (var i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
})`;

const FRAMES = {
  ml: 32, paint: 36, fill: 32, camera: 30
};
// Per-animation teardown so one scene never leaks into the next (the paint
// overlay stays open until it is closed).
const TEARDOWN = { paint: 'closePaint();' };
function pad(n) { return String(n).padStart(2, '0'); }

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
    '--window-size=' + VIEW_W + ',' + VIEW_H, 'about:blank'
  ], { stdio: 'ignore' });
  process.on('exit', () => { try { chrome.kill(); } catch (e) {} });

  cdp = await connect(PORT);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: URL });

  for (let i = 0; i < 120; i++) {
    await wait(250);
    try { if (await ev(`!!(window.el && window.el.timelineCol && window.enterApp)`)) break; } catch (e) {}
  }

  await pageEval(`(function(){
    enterApp();
    el.loadingOverlay.classList.add('hidden');
    el.btnLoadingRetry.classList.add('hidden');
    cancelRun();
    if (el.toast) el.toast.classList.add('hidden');
  })()`);
  await wait(300);
  await pageEval(ART);
  await pageEval(PAGE);

  for (const name of Object.keys(FRAMES)) {
    const n = FRAMES[name];
    // setup (and clear leftover cursor state)
    await pageEval('(function(){ window.__animWaitGen = false; window.__animSetupGen = false; })()');
    await pageEval('__doodles.then(function(){ __anims.' + name + '.setup(); });');
    await wait(250); // let the scene settle before frame 0

    // The blur setup generates the unblurred gap up front; wait for it so the
    // first sweep already has frames to play.
    if (await ev('!!window.__animSetupGen')) {
      for (let t = 0; t < 200; t++) {
        await wait(200);
        const idle = await ev(`state.dirty.size === 0 && allGaps().every(function(g){ return g.genCount <= 0 || gapComplete(g); })`);
        if (idle) break;
      }
      await pageEval('(function(){ window.__animSetupGen = false; renderAll(); renderSelectedPanel(); renderPreview(); })()');
    }

    for (let i = 0; i < n; i++) {
      await pageEval(`__anims.${name}.pose(${i}, ${n});`);
      // If the pose kicked off real generation (motion blur), wait for it so
      // the after-frames show the finished (blurred) inbetween.
      const waitGen = await ev('!!window.__animWaitGen');
      if (waitGen) {
        for (let t = 0; t < 200; t++) {
          await wait(200);
          const done = await ev(`state.dirty.size === 0 && allGaps().every(function(g){ return g.genCount <= 0 || gapComplete(g); })`);
          if (done) break;
        }
        await pageEval('(function(){ window.__animWaitGen = false; renderAll(); renderSelectedPanel(); renderPreview(); })()');
      }
      await wait(30);
      await captureFrame(name + '_' + pad(i) + '.png');
    }

    if (TEARDOWN[name]) await pageEval('(function(){ ' + TEARDOWN[name] + ' })()');

    const urls = [];
    for (let i = 0; i < n; i++) urls.push(BASE + '/.scratch/anim/' + name + '_' + pad(i) + '.png');
    const gifB64 = await ev('(' + ENCODE + ')(' + JSON.stringify(urls) + ', ' + GIF_W + ', ' + GIF_H + ', ' + FRAME_DELAY + ')', true);
    fs.writeFileSync(path.join(OUT, name + '.gif'), Buffer.from(gifB64, 'base64'));
    const sz = fs.statSync(path.join(OUT, name + '.gif')).size;
    console.log('gif', name + '.gif', n + ' frames', Math.round(sz / 1024) + 'KB');
  }

  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (e) {}
  chrome.kill();
  console.log('done');
}

main().catch((e) => { console.error(e); process.exit(1); });
