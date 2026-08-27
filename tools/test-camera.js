#!/usr/bin/env node
// Headless verification of the paint camera: cursor-anchored zoom, pan, fit.
// Drives the real zoomAt/fitCanvas math from src/paint.js and checks that the
// canvas point under the cursor stays fixed while zooming.
const { spawn } = require('child_process');
const { assertChrome } = require('./chrome');
const CHROME = assertChrome();
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8171;
const CDP_PORT = 9251;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.kpp': 'application/octet-stream',
  '.myb': 'application/octet-stream', '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/editor.html';
  if (p === '/__cam_harness.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(harness); return; }
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const harness = `<!doctype html><html><body>
<script src="/src/state.js"></script>
<script src="/src/paint-color.js"></script>
<script src="/src/paint-brushes.js"></script>
<script src="/src/paint-parsers.js"></script>
<script src="/src/paint-layers.js"></script>
<script src="/src/paint-tools.js"></script>
<script src="/src/paint.js"></script>
<script>
const lines = [];
function log(msg) { lines.push(msg); console.log('HARNESS ' + msg); }

// stub a wrap + canvas so fitCanvas/zoomAt work
const realCreateElement = document.createElement.bind(document);
function makeEl(tag) {
  const el = realCreateElement(tag);
  el.style = {};
  el.addEventListener = function () {};
  return el;
}
const wrap = makeEl('div');
wrap.clientWidth = 800; wrap.clientHeight = 600;
const stage = makeEl('div');
const canvas = makeEl('canvas');
canvas.width = 512; canvas.height = 512;
stage.appendChild(canvas);
wrap.appendChild(stage);
document.getElementById = function (id) {
  if (id === 'paintCanvasWrap') return wrap;
  if (id === 'paintCanvas') return canvas;
  if (id === 'paintZoomVal') return makeEl('span');
  return makeEl('div');
};

workW = 512; workH = 512;
paintCanvas = canvas;
overlayCv = null;

// The canvas-space point under a wrap position, given current zoom/pan.
function canvasUnder(mxw, myw) {
  const aw = wrap.clientWidth, ah = wrap.clientHeight;
  const base = Math.min((aw - 24) / workW, (ah - 24) / workH, 1.6);
  const z = paintZoom * base;
  const cx = (aw - workW * z) / 2, cy = (ah - workH * z) / 2;
  return { u: (mxw - cx - paintPanX) / z, v: (myw - cy - paintPanY) / z };
}

async function main() {
  fitView();
  log('initial zoom=' + paintZoom.toFixed(2) + ' pan=' + paintPanX.toFixed(1) + ',' + paintPanY.toFixed(1));

  // 1. zoom about the cursor keeps the canvas point under the cursor fixed
  const anchor = { x: 600, y: 250 }; // a point in the wrap (near the canvas edge)
  const before = canvasUnder(anchor.x, anchor.y);
  zoomAt(anchor.x, anchor.y, 1.25);   // zoom in
  const after = canvasUnder(anchor.x, anchor.y);
  const drift = Math.hypot(after.u - before.u, after.v - before.v);
  log('zoom drift at anchor: ' + drift.toFixed(3) + 'px of canvas space (expect ~0)');
  const okAnchor = drift < 0.05;
  const zoomed = paintZoom;
  log('zoom after 1.25x: ' + zoomed.toFixed(2));

  // zoom out again — the point should still be anchored
  zoomAt(anchor.x, anchor.y, 1 / 1.25);
  const back = canvasUnder(anchor.x, anchor.y);
  const driftBack = Math.hypot(back.u - before.u, back.v - before.v);
  log('zoom drift back: ' + driftBack.toFixed(3) + 'px (expect ~0)');
  const okBack = driftBack < 0.05 && Math.abs(paintZoom - 1) < 0.01;

  // 2. pan moves the canvas by the pointer delta
  const panBefore = { x: paintPanX, y: paintPanY };
  // The canvas point shown at (460,275) before panning must appear at
  // (500,300) after panning by (+40,+25) viewport px.
  const beforePanAt = canvasUnder(460, 275);
  paintPanX = panBefore.x + 40; paintPanY = panBefore.y + 25;
  fitCanvas();
  const afterPan = canvasUnder(500, 300);
  const panDrift = Math.hypot(afterPan.u - beforePanAt.u, afterPan.v - beforePanAt.v);
  log('pan consistency drift: ' + panDrift.toFixed(3) + ' (expect ~0)');
  const okPan = panDrift < 0.05;

  // 3. fit re-centers: zoom back to 1 and pan to 0
  fitView();
  const fitOk = Math.abs(paintZoom - 1) < 0.001 && paintPanX === 0 && paintPanY === 0;
  log('fit resets: ' + (fitOk ? 'yes' : 'no'));
  const zv = document.getElementById('paintZoomVal');
  log('zoom label after fit: ' + zv.textContent);

  // 4. zoom clamp range
  for (let i = 0; i < 60; i++) zoomAt(400, 300, 1.15);
  log('zoom clamped max: ' + paintZoom.toFixed(2) + ' (expect <= 24)');
  const okClamp = paintZoom <= 24.01;

  const pass = okAnchor && okBack && okPan && fitOk && okClamp;
  log('checks: anchor=' + okAnchor + ' back=' + okBack + ' pan=' + okPan + ' fit=' + fitOk + ' clamp=' + okClamp);
  log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
}
main().catch(e => { log('ERROR ' + (e && e.stack || e)); });
</script></body></html>`;

let chromium = null;

function cdpFetch(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: pathname }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function cdp(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const handler = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) { ws.removeEventListener('message', handler); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function run() {
  await new Promise(resolve => server.listen(PORT, resolve));
  chromium = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errOut = '';
  chromium.stderr.on('data', d => errOut += d);

  let targets = null;
  for (let i = 0; i < 50; i++) {
    try { targets = JSON.parse(await cdpFetch('/json')); if (targets.length) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  if (!targets || !targets.length) throw new Error('no CDP targets: ' + errOut.slice(0, 500));

  const pg = targets.find(t => t.type === 'page');
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  await cdp(ws, 1, 'Page.enable');
  await cdp(ws, 2, 'Runtime.enable');

  const consoleLines = [];
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map(a => a.value !== undefined ? a.value : a.description || '');
      consoleLines.push(args.join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleLines.push('EXCEPTION: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 500));
    }
  });

  await cdp(ws, 3, 'Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/__cam_harness.html' });
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (consoleLines.some(l => l.includes('RESULT:'))) break;
    await new Promise(r2 => setTimeout(r2, 300));
  }
  ws.close();
  const hits = consoleLines.filter(l => l.includes('HARNESS '));
  if (hits.length) {
    console.log(hits.join('\n'));
    const result = hits.find(l => l.includes('RESULT: '));
    if (result) process.exit(result.includes('RESULT: PASS') ? 0 : 1);
    process.exit(1);
  }
  console.log('No harness output. Console:');
  console.log(consoleLines.join('\n').slice(0, 3000));
  process.exit(1);
}

run().catch(e => {
  console.log('RUNNER ERROR: ' + (e && e.stack || e));
  if (chromium) chromium.kill();
  server.close();
  process.exit(1);
});
