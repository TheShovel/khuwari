// Captures real screenshots of the Khuwari editor for the home page and docs
// figures. Drives the app through CDP (headless Chromium) by calling the
// editor's global functions directly, then saves PNGs into shots/.
//
//   node site_tools/shoot.js
//
// Needs: chromium on PATH, Node 26+ (global WebSocket). Requires a local
// server for editor.html (the editor loads src/ scripts by URL), e.g.:
//   python3 -m http.server 4000
// Then point SHOOT_URL at it. Default: http://localhost:4000/editor.html

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { assertChrome } = require('../tools/chrome');
const CHROME = assertChrome();

const ROOT = path.resolve(__dirname, '..');
const URL = process.env.SHOOT_URL || 'http://localhost:4000/editor.html';
const PORT = 9333;
const OUT = path.join(ROOT, 'shots');
const VIEW_W = 1280, VIEW_H = 800;
function R0full() { return { x: 0, y: 0, w: VIEW_W, h: VIEW_H }; }

fs.mkdirSync(OUT, { recursive: true });

// CDP plumbing
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(m.error.message));
          else p.resolve(m.result);
        }
      } else {
        this.events.push(m);
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
      await new Promise((res2, rej2) => { ws.onopen = res2; ws.onerror = rej2; });
      return new CDP(ws);
    } catch (e) {
      await new Promise((r) => setTimeout(r, 250));
    }
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

async function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function rectOf(selectorExpr) {
  return ev(`(function(){var el=${selectorExpr};if(!el)return null;var r=el.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})()`);
}

async function capture(file, clip) {
  const params = { format: 'png' };
  if (clip) {
    const x = Math.max(0, clip.x), y = Math.max(0, clip.y);
    const w = Math.min(VIEW_W - x, clip.w), h = Math.min(VIEW_H - y, clip.h);
    if (w <= 1 || h <= 1) throw new Error('clip out of viewport for ' + file);
    params.clip = { x, y, width: w, height: h, scale: 1 };
  }
  const r = await cdp.send('Page.captureScreenshot', params);
  fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  console.log('shot', file, clip ? `${Math.round(clip.w)}x${Math.round(clip.h)}` : 'full');
}

async function pageEval(expr) {
  return ev(expr, true);
}

// page-side art + helpers
const ART = `
window.__art = {
  char: function (x, color) {
    var c = document.createElement('canvas'); c.width = 512; c.height = 512;
    var g = c.getContext('2d');
    g.lineJoin = 'round'; g.lineCap = 'round';
    var body = color || '#c3ab7d', line = '#171a1f';
    g.strokeStyle = line; g.lineWidth = 26;
    g.beginPath(); g.moveTo(x - 20, 330); g.lineTo(x - 26, 412); g.moveTo(x + 20, 330); g.lineTo(x + 26, 412); g.stroke();
    g.fillStyle = body; g.strokeStyle = line; g.lineWidth = 20;
    g.beginPath();
    g.moveTo(x - 56, 292); g.quadraticCurveTo(x - 56, 236, x - 34, 236); g.lineTo(x + 34, 236);
    g.quadraticCurveTo(x + 56, 236, x + 56, 292); g.lineTo(x + 46, 340); g.quadraticCurveTo(x + 46, 352, x + 32, 352);
    g.lineTo(x - 32, 352); g.quadraticCurveTo(x - 46, 352, x - 46, 340); g.closePath();
    g.fill(); g.stroke();
    g.lineWidth = 24;
    g.beginPath(); g.moveTo(x - 50, 268); g.lineTo(x - 86, 322); g.moveTo(x + 50, 268); g.lineTo(x + 86, 322); g.stroke();
    g.fillStyle = body; g.beginPath(); g.arc(x, 184, 52, 0, Math.PI * 2); g.fill();
    g.lineWidth = 20; g.stroke();
    g.fillStyle = line;
    g.beginPath(); g.arc(x - 18, 180, 7, 0, Math.PI * 2); g.arc(x + 18, 180, 7, 0, Math.PI * 2); g.fill();
    g.strokeStyle = line; g.lineWidth = 5;
    g.beginPath(); g.arc(x, 200, 14, 0.25, Math.PI - 0.25); g.stroke();
    return c.toDataURL('image/png');
  },
  ring: function () {
    var c = document.createElement('canvas'); c.width = 512; c.height = 512;
    var g = c.getContext('2d');
    g.lineJoin = 'round';
    // Two separate closed line-art shapes: a rounded square on the left and a
    // circle on the right. Each is its own enclosed region, so a dot placed
    // inside one fills only that one (flood fills never cross the strokes).
    // Left: rounded square outline
    g.strokeStyle = '#ece7db'; g.lineWidth = 22;
    g.beginPath();
    g.moveTo(118, 152); g.lineTo(222, 152); g.quadraticCurveTo(242, 152, 242, 172);
    g.lineTo(242, 348); g.quadraticCurveTo(242, 368, 222, 368); g.lineTo(118, 368);
    g.quadraticCurveTo(98, 368, 98, 348); g.lineTo(98, 172); g.quadraticCurveTo(98, 152, 118, 152);
    g.closePath(); g.stroke();
    // face details inside the square (islands the fill flows around)
    g.strokeStyle = '#171a1f'; g.lineWidth = 7;
    g.beginPath(); g.arc(148, 232, 15, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(192, 232, 15, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(158, 288); g.quadraticCurveTo(170, 298, 182, 288); g.stroke();
    // Right: circle outline
    g.strokeStyle = '#ece7db'; g.lineWidth = 22;
    g.beginPath(); g.arc(362, 260, 106, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#171a1f'; g.lineWidth = 7;
    g.beginPath(); g.arc(336, 248, 15, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(388, 248, 15, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(346, 300); g.quadraticCurveTo(362, 314, 378, 300); g.stroke();
    return c.toDataURL('image/png');
  }
};
window.__fabricate = function () {
  state.layers.forEach(function (L) {
    if (L.type === 'fill') return;
    computeGaps(L.id).forEach(function (g) {
      if (g.genCount <= 0) return;
      var frames = [];
      for (var i = 1; i <= g.genCount; i++) {
        var t = g.fromTime + (g.toTime - g.fromTime) * (i / (g.genCount + 1));
        frames.push({ idx: i, t: i / (g.genCount + 1), time: t, img: g.from.img, ai: false });
      }
      state.generated[g.id] = frames;
      state.gapMeta[g.id] = gapStamp(g);
    });
  });
  refreshDirty();
  renderAll();
};
window.__base = function (opts) {
  opts = opts || {};
  cancelRun();
  closeMenus();
  state.keyframes = [];
  state.layers = [{ id: 'L1', name: 'Layer 1', visible: true }];
  state.activeLayerId = 'L1';
  state.generated = {}; state.gapMeta = {}; state.gapType = {}; state.gapSquash = {}; state.gapBlur = {};
  state.selectedId = null; state.selectedGapId = null; state.selectedDotId = null;
  state.onion = false;
  state.playhead = opts.playhead || 0;
  state.zoom = opts.zoom || 220;
  state.fps = 12;
  state.assets = [
    { img: __art.char(140, '#c3ab7d'), name: 'hero-left.png', w: 512, h: 512 },
    { img: __art.char(256, '#c3ab7d'), name: 'hero-mid.png', w: 512, h: 512 },
    { img: __art.char(372, '#c3ab7d'), name: 'hero-right.png', w: 512, h: 512 },
    { img: __art.ring(), name: 'ring.png', w: 512, h: 512 }
  ];
  assetCache = state.assets.slice();
  renderAssets();
  renderLayerPanel();
};
window.__hero = function () {
  __base();
  state.keyframes.push({ id: 'k1', layer: 'L1', time: 0, img: state.assets[0].img, name: 'hero-left.png', w: 512, h: 512 });
  state.keyframes.push({ id: 'k2', layer: 'L1', time: 0.5, img: state.assets[1].img, name: 'hero-mid.png', w: 512, h: 512 });
  state.keyframes.push({ id: 'k3', layer: 'L1', time: 1, img: state.assets[2].img, name: 'hero-right.png', w: 512, h: 512 });
  __fabricate();
};
window.__colorTimeline = function () {
  __base({ playhead: 0 });
  // line art layer + a color layer under it with three stacked dots
  state.layers = [
    { id: 'L1', name: 'Layer 1', visible: true },
    { id: 'L2', name: 'Color 1', visible: true, type: 'fill', dots: [] }
  ];
  state.activeLayerId = 'L2';
  state.keyframes.push({ id: 'k1', layer: 'L1', time: 0, img: state.assets[3].img, name: 'ring.png', w: 512, h: 512 });
  var D = function (x, y, color, start) {
    var d = { id: 'D' + (++idSeq), x: x, y: y, color: color, threshold: 0.5, grow: 1, gradOn: false, gradColor: '#ffffff', gradHeight: 24, gradDir: 'bottom' };
    d.start = start; d.end = start + 1; d.dur = 1;
    return d;
  };
  state.layers[1].dots = [
    D(0.5, 0.5, '#4f8fff', 0),
    D(0.5, 0.5, '#c3ab7d', 0),
    D(0.5, 0.5, '#8fb0a2', 0)
  ];
  refreshDirty();
  renderAll();
};
window.__colorFill = function () {
  __base({ playhead: 0 });
  state.layers = [
    { id: 'L1', name: 'Layer 1', visible: true },
    { id: 'L2', name: 'Color 1', visible: true, type: 'fill', dots: [] }
  ];
  state.activeLayerId = 'L2';
  state.keyframes.push({ id: 'k1', layer: 'L1', time: 0, img: state.assets[3].img, name: 'ring.png', w: 512, h: 512 });
  // Two dots, one per enclosed line-art shape: the left square fills blue,
  // the right circle fills gold. Each region is closed, so the fills stay
  // separate (a later dot only overpaints the same region).
  var d1 = { id: 'D1', x: 0.29, y: 0.5, color: '#4f8fff', threshold: 0.5, grow: 1, gradOn: false, gradColor: '#ffffff', gradHeight: 24, gradDir: 'bottom', start: 0, end: 1, dur: 1 };
  var d2 = { id: 'D2', x: 0.71, y: 0.5, color: '#c3ab7d', threshold: 0.5, grow: 1, gradOn: false, gradColor: '#ffffff', gradHeight: 24, gradDir: 'bottom', start: 0, end: 1, dur: 1 };
  state.layers[1].dots = [d1, d2];
  refreshDirty();
  renderAll();
  renderPreview();
};
`;

module.exports = { ART };

// shots
async function setupAndWait(fn) {
  await pageEval('(function(){' + ART + fn + '})()');
  // warm the image cache so the preview renders synchronously
  await pageEval(`(function(){
    var srcs = [];
    state.keyframes.forEach(function (k) { if (srcs.indexOf(k.img) === -1) srcs.push(k.img); });
    state.assets.forEach(function (a) { if (srcs.indexOf(a.img) === -1) srcs.push(a.img); });
    return Promise.all(srcs.map(function (s) { return loadImage(s).catch(function () {}); }));
  })()`, true);
  await wait(400);
}

async function genSquash(blurOn) {
  // Real squash generation for the second gap, so the preview shows the
  // deformation (and blur) instead of a static keyframe.
  await pageEval(`(function(){
    cancelRun();
    var g = allGaps().filter(function (x) { return x.layer === 'L1'; })[1];
    state.gapType[g.id] = 'squash';
    if (${blurOn}) setGapBlur(g.id, { on: true, intensity: 0.6 });
    delete state.generated[g.id];
    delete state.gapMeta[g.id];
    state.selectedGapId = g.id;
    state.playhead = 0.62;
    refreshDirty();
    renderAll();
    scheduleGenerate(0);
  })()`);
  for (let i = 0; i < 120; i++) {
    await wait(300);
    const done = await ev(`state.dirty.size === 0 && allGaps().every(function(g){ return g.genCount <= 0 || gapComplete(g); })`);
    if (done) break;
  }
  await wait(400);
  await pageEval(`(function(){ renderAll(); renderPreview(); })()`);
  await wait(300);
}

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + PORT,
    '--remote-allow-origins=*',
    '--window-size=' + VIEW_W + ',' + VIEW_H,
    'about:blank'
  ], { stdio: 'ignore' });
  process.on('exit', () => { try { chrome.kill(); } catch (e) {} });

  cdp = await connect(PORT);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false
  });
  await cdp.send('Page.navigate', { url: URL });

  // Wait for the editor to boot (globals exist, timeline wired).
  for (let i = 0; i < 120; i++) {
    await wait(250);
    try {
      const ok = await ev(`!!(window.el && window.el.timelineCol && window.enterApp)`);
      if (ok) break;
    } catch (e) {}
  }

  // 0. the start screen, before entering the app
  await capture('start.png', R0full());
  await pageEval(`(function(){
    enterApp();
    el.loadingOverlay.classList.add('hidden');
    el.btnLoadingRetry.classList.add('hidden');
    cancelRun();
    if (el.toast) el.toast.classList.add('hidden');
  })()`);
  await wait(400);

  // Warm the art + helper functions once.
  await pageEval(ART);

  // shots
  await setupAndWait('__hero();');
  const R = {};
  for (const sel of ['leftCol', 'previewCol', 'rightCol', 'timelineCol']) {
    const expr = { leftCol: 'document.getElementById("leftCol")', previewCol: 'document.querySelector(".preview-col")', rightCol: 'document.getElementById("rightCol")', timelineCol: 'document.getElementById("timelineCol")' }[sel];
    R[sel] = await rectOf(expr);
  }
  R.full = { x: 0, y: 0, w: VIEW_W, h: VIEW_H };
  const rightRegion = { x: R.leftCol.x + R.leftCol.w + 6, y: 52, w: VIEW_W - (R.leftCol.x + R.leftCol.w + 6), h: R.timelineCol.y - 52 };
  const tlRegion = { x: 0, y: R.timelineCol.y, w: VIEW_W, h: VIEW_H - R.timelineCol.y };
  const centerRegion = { x: R.leftCol.x + R.leftCol.w + 6, y: 52, w: R.rightCol.x - (R.leftCol.x + R.leftCol.w + 6), h: R.timelineCol.y - 52 };

  // 1. full window, hero project
  await setupAndWait('__hero(); state.playhead = 0.5; __fabricate(); renderPlayhead();');
  await capture('win.png', R.full);

  // 2. assets panel
  await setupAndWait('__hero();');
  await capture('assets.png', { x: 0, y: 52, w: R.leftCol.w + 4, h: R.timelineCol.y - 52 });

  // 3. preview + filmstrip
  await setupAndWait('__hero(); state.playhead = 0.25; __fabricate(); renderPreview(); renderPlayhead();');
  await capture('preview.png', { x: centerRegion.x, y: 52, w: centerRegion.w, h: R.timelineCol.y - 52 });

  // 4. timeline, ML gap (home ml + docs gapInbetween)
  await setupAndWait('__hero(); state.playhead = 0.5; __fabricate(); renderPlayhead();');
  await capture('timeline_ml.png', tlRegion);

  // 5. timeline with color layer + stacked dots (home layers + docs dotStack/timelineLayers)
  await setupAndWait('__colorTimeline(); state.playhead = 0.5; renderPlayhead();');
  await capture('timeline_layers.png', tlRegion);
  await capture('dotstack.png', tlRegion);

  // 6. keyframe selected (docs selectionPanel)
  await setupAndWait('__hero(); selectKeyframe("k1"); renderAll();');
  await capture('selection.png', { x: R.rightCol.x, y: 52, w: VIEW_W - R.rightCol.x, h: R.timelineCol.y - 52 });

  // 7. timeline with selected keyframe chip (docs kfChip)
  await setupAndWait('__hero(); selectKeyframe("k1"); state.playhead = 0; renderPlayhead();');
  await capture('kfchip.png', tlRegion);

  // 8. gap selected (docs gapInbetween)
  await setupAndWait('__hero(); state.selectedGapId = allGaps().filter(function(g){return g.layer==="L1";})[0].id; state.playhead = 0.3; renderAll(); renderPlayhead();');
  await capture('gap.png', tlRegion);

  // 9. squash (docs squash) + real generation
  await setupAndWait('__hero();');
  await genSquash(false);
  await pageEval('(function(){ renderSelectedPanel(); renderLane(); })()');
  await wait(200);
  await capture('squash.png', rightRegion);

  // 10. motion blur (home blur + docs motionBlur)
  await setupAndWait('__hero();');
  await genSquash(true);
  await pageEval('(function(){ renderSelectedPanel(); renderLane(); })()');
  await wait(200);
  await capture('blur.png', rightRegion);

  // 11. color fill (home fill + docs colorFill)
  await setupAndWait('__colorFill(); state.activeLayerId = "L2"; renderPreview();');
  await capture('colorfill.png', R.full);

  // 12. onion skinning (home onion + docs onion)
  await setupAndWait('__hero(); state.onion = true; state.onionCfg = { before: 2, after: 2, opacity: 0.3, tint: false, tintColor: "#ff3b30", tintOpacity: 0.35 }; state.playhead = 0.5; renderAll(); renderPreview();');
  // open the onion settings popup like the user does
  await pageEval('(function(){ el.onionMenu.classList.remove("hidden"); syncOnionUI(); })()');
  await wait(300);
  const onionRect = await rectOf('document.getElementById("onionMenu")');
  const onionUnion = {
    x: Math.min(centerRegion.x, onionRect ? onionRect.x : centerRegion.x),
    y: Math.min(52, onionRect ? onionRect.y : 52),
    w: Math.max(centerRegion.x + centerRegion.w, onionRect ? onionRect.x + onionRect.w : 0) - Math.min(centerRegion.x, onionRect ? onionRect.x : centerRegion.x),
    h: Math.max(52 + (R.timelineCol.y - 52), onionRect ? onionRect.y + onionRect.h : 0) - Math.min(52, onionRect ? onionRect.y : 52)
  };
  await capture('onion.png', onionUnion);

  // 13. blend mode select (docs blend)
  await setupAndWait('__hero(); selectKeyframe("k1"); state.selectedId = "k1"; renderAll();');
  await capture('blend.png', { x: R.rightCol.x, y: 52, w: VIEW_W - R.rightCol.x, h: R.timelineCol.y - 52 });

  // 14. export menu (home export + docs exportMenu)
  await setupAndWait('__hero();');
  await pageEval(`(function(){
    el.exportMenu.classList.remove('hidden');
    populateExportRes();
  })()`);
  await wait(300);
  await capture('export.png', R.full);

  // 15. settings menu (docs settingsMenu)
  await setupAndWait('__hero();');
  await pageEval('(function(){ el.settingsMenu.classList.remove("hidden"); })()');
  await wait(300);
  const settingsRect = await rectOf('document.getElementById("settingsMenu")');
  await capture('settings.png', {
    x: Math.max(0, (settingsRect ? settingsRect.x : VIEW_W - 300) - 20),
    y: Math.max(0, (settingsRect ? settingsRect.y : 52) - 20),
    w: Math.min(VIEW_W, (settingsRect ? settingsRect.x + settingsRect.w : VIEW_W) + 20) - Math.max(0, (settingsRect ? settingsRect.x : VIEW_W - 300) - 20),
    h: Math.min(VIEW_H, (settingsRect ? settingsRect.y + settingsRect.h : 400) + 20) - Math.max(0, (settingsRect ? settingsRect.y : 52) - 20)
  });

  // 16. paint workspace (docs paint)
  await setupAndWait('__hero();');
  await pageEval('(function(){ openPaint({ keyframeId: "k1" }); })()');
  for (let i = 0; i < 40; i++) {
    await wait(200);
    const ready = await ev(`!!(window.paintOpen && window.paintReady)`);
    if (ready) break;
  }
  await pageEval(`(function(){
    // an extra layer + a few strokes so the Layers docker shows real depth
    var l2 = addLayer('Sketch', true);
    var g = l2.canvas.getContext('2d');
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = '#4f8fff'; g.lineWidth = 12;
    g.beginPath(); g.moveTo(130, 430); g.quadraticCurveTo(190, 300, 270, 330);
    g.quadraticCurveTo(330, 350, 400, 250); g.stroke();
    g.strokeStyle = '#e6c07b'; g.lineWidth = 8;
    g.beginPath(); g.moveTo(90, 190); g.quadraticCurveTo(200, 140, 300, 205); g.stroke();
    g.fillStyle = '#e06c75'; g.beginPath(); g.arc(355, 385, 24, 0, Math.PI * 2); g.fill();
    rebuildLayerUI();
    refreshLayerThumbs();
    compositeDisplay();
  })()`);
  await wait(400);
  await capture('paint.png', R0full());
  await pageEval('(function(){ closePaint(); })()');
  await wait(200);

  // 17. camera (docs camera): full window with the camera panel open, a
  // camera transform and a couple of effects applied to the preview, and a
  // tall timeline so the camera key dots stay visible above the fold.
  await setupAndWait('__hero(); state.playhead = 0.5; __fabricate(); renderPlayhead();');
  await pageEval(`(function(){
    state.camera = { enabled: true, keys: [] }; state.audio = { src: null, name: null, duration: 0, muted: false };
    setCameraField('x', -0.3);
    setCameraField('zoom', 1.5);
    setCameraField('rot', -5);
    setCameraField('fx.fisheye', 0.4);
    setCameraField('fx.chroma', 0.5);
    setCameraField('fx.vignette', 0.35);
    setCameraField('fx.grain', 0.2);
    var p = byId('cameraPanel');
    if (p) p.classList.remove('collapsed');
    var t = byId('timelineCol'); if (t) t.style.height = '340px';
    renderCameraPanel();
    renderPreview();
    renderTimeline();
  })()`);
  await wait(400);
  await capture('camera.png', R0full());

  // 18. audio (docs audio): full window with the audio panel open and the
  // waveform lane visible under the timeline (tall timeline, no extra rows).
  await setupAndWait('__hero(); state.playhead = 0.5; __fabricate(); renderPlayhead();');
  await pageEval(`(function(){
    state.camera = { enabled: true, keys: [] }; state.audio = { src: null, name: null, duration: 0, muted: false };
    // A real audio element would need decoding; for the shot we fabricate the
    // waveform envelope the same way the asset library art is fabricated.
    state.audio = { src: 'data:audio/wav;base64,', name: 'scratch-beat.wav', duration: 4, muted: false };
    audioPeaks = new Float32Array(2000);
    for (var i = 0; i < 2000; i++) audioPeaks[i] = 0.12 + 0.5 * Math.abs(Math.sin(i * 0.05) * Math.sin(i * 0.011));
    var aw = byId('audioWrap'); if (aw) aw.classList.remove('collapsed');
    var t = byId('timelineCol'); if (t) t.style.height = '340px';
    renderAudioLane();
    renderAudioPanel();
    renderPreview();
    renderTimeline();
    byId('timeline').scrollTop = byId('timeline').scrollHeight;
  })()`);
  await wait(300);
  await capture('audio.png', R0full());

  chrome.kill();
  console.log('done');
}

// Run only when invoked directly; requiring this module just exposes ART and
// the helpers above (used by the animation-capture tool).
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
