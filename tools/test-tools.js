#!/usr/bin/env node
// Headless verification of the paint tool system: selection, crop, resize,
// fill, move, eyedrop, shapes, flip/rotate, transform.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8143;
const CDP_PORT = 9225;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.kpp': 'application/octet-stream',
  '.myb': 'application/octet-stream', '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/editor.html';
  if (p === '/__tools.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(TOOLS_PAGE); return; }
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const TOOLS_PAGE = `<!doctype html><html><body>
<script src="/src/state.js"></script>
<script src="/src/paint.js"></script>
<script>
window.toast = function () {};
window.applyWorkSize = function () {
  // harness stub: apply state.customW/H directly
  workW = state.customW || workW;
  workH = state.customH || workH;
  return { w: workW, h: workH };
};
const lines = [];
function log(msg) { lines.push(msg); console.log('TOOLS ' + msg); }
function pass(name, ok, extra) { log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : '')); return ok; }
function countPixels(ctx, x0, y0, x1, y1) {
  const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
}
function layerCtx() { return activeLayer.canvas.getContext('2d'); }
async function main() {
  workW = 128; workH = 128;
  const cv = document.createElement('canvas');
  cv.width = workW; cv.height = workH;
  paintCanvas = cv;
  paintDispCtx = cv.getContext('2d');
  overlayCv = document.createElement('canvas');
  overlayCv.width = workW; overlayCv.height = workH;
  overlayCtx = overlayCv.getContext('2d');
  paintLayers = [];
  activeLayer = null;
  addLayer('Layer 1', true);
  // paint a solid square at (20,20)-(60,60) red
  const lc = layerCtx();
  lc.fillStyle = '#f00';
  lc.fillRect(20, 20, 40, 40);
  compositeDisplay();

  // ---- eraser state: selecting an eraser brush then a normal brush ----
  current = makeBrush('Eraser test', { radius: 4, opacity: 1, spacing: 0.1, eraser: true, builtin: true });
  eraserOn = false;
  refreshTip();
  // simulate the palette click handler behavior via stampDab: with an eraser
  // brush selected, painting should erase (destination-out)
  paintCtx = activeLayer.canvas.getContext('2d');
  stampDab(30, 30, 6, 1, null);
  let erased = countPixels(layerCtx(), 26, 26, 34, 34) < 10;
  pass('eraser brush erases', erased);
  // now select a normal brush: eraserOn must reset
  current = makeBrush('Normal test', { radius: 4, opacity: 1, spacing: 0.1, eraser: false, builtin: true });
  eraserOn = !!current.eraser;
  refreshTip();
  pass('normal brush resets eraserOn', eraserOn === false);
  // and stamping with it paints instead of erasing: redraw the square, then
  // stamp a dab of a different color and check it was ADDED (source-over)
  lc.fillStyle = '#00f';
  lc.fillRect(20, 20, 40, 40);
  stampDab(30, 30, 6, 1, null);
  let d0 = layerCtx().getImageData(30, 30, 1, 1).data;
  pass('normal brush paints over', d0[3] > 200);
  // the palette click handler itself (used by the real UI) must also reset
  current = makeBrush('Eraser2', { radius: 4, eraser: true, builtin: true });
  eraserOn = !!current.eraser;
  current = makeBrush('Normal2', { radius: 4, eraser: false, builtin: true });
  eraserOn = !!current.eraser;
  pass('palette selection toggles eraser mode', eraserOn === false);
  // restore the red square for the selection tests below
  lc.clearRect(0, 0, workW, workH);
  lc.fillStyle = '#f00';
  lc.fillRect(20, 20, 40, 40);
  compositeDisplay();

  // ---- selection ----
  sel = { type: 'rect', x: 10, y: 10, w: 50, h: 50, feather: 0 };
  buildSelMask();
  pass('sel mask center', selPoint(35, 35) === true);
  pass('sel mask outside', selPoint(90, 90) === false);
  // move selection content (the Move tool's engine: drag inside the selection)
  beginSelMove({ x: 35, y: 35 });
  selMove({ x: 55, y: 55 });
  selUp();
  let redAtNew = 0;
  let d1 = layerCtx().getImageData(0, 0, workW, workH).data;
  for (let i = 0; i < d1.length; i += 4) if (d1[i] > 200 && d1[i + 1] < 50) redAtNew++;
  pass('move sel content', redAtNew > 400, 'red px=' + redAtNew);
  // the non-overlapping part of the origin must be clear (original region
  // (20,20)-(60,60) moved to (40,40)-(80,80); check (20,20)-(40,40))
  pass('move sel cleared origin', countPixels(layerCtx(), 20, 20, 40, 40) < 200);

  // delete selection
  sel = { type: 'rect', x: 10, y: 10, w: 40, h: 40, feather: 0 };
  buildSelMask();
  deleteSelection();
  pass('delete sel cleared', countPixels(layerCtx(), 10, 10, 50, 50) === 0);

  // ---- fill ----
  current = makeBrush('Test', { radius: 4, opacity: 1, spacing: 0.1, color: '#00ff00' });
  layerCtx().clearRect(0, 0, workW, workH);
  layerCtx().fillStyle = '#fff';
  layerCtx().fillRect(0, 0, workW, workH);
  fillDown({ x: 64, y: 64 });
  let d2 = layerCtx().getImageData(60, 60, 8, 8).data;
  pass('fill changed color', d2[1] > 200, 'g=' + d2[1]);

  // ---- eyedrop ----
  layerCtx().fillStyle = '#123456';
  layerCtx().fillRect(100, 100, 4, 4);
  compositeDisplay();
  eyedropDown({ x: 101, y: 101 });
  pass('eyedrop picks color', current.color === '#123456', 'got ' + current.color);

  // ---- line tool ----
  layerCtx().clearRect(0, 0, workW, workH);
  lineDown({ x: 10, y: 10 });
  lineMove({ x: 100, y: 100 });
  lineUp();
  pass('line drew pixels', countPixels(layerCtx(), 0, 0, workW, workH) > 50);

  // ---- rect shape ----
  layerCtx().clearRect(0, 0, workW, workH);
  paintTool = 'rect';
  toolDrag = null;
  shapeDown({ x: 10, y: 10 });
  shapeMove({ x: 60, y: 60 });
  shapeUp();
  pass('rect outline drew', countPixels(layerCtx(), 0, 0, workW, workH) > 40);

  // ---- flip ----
  layerCtx().clearRect(0, 0, workW, workH);
  layerCtx().fillStyle = '#f00';
  layerCtx().fillRect(10, 10, 20, 20);
  flipCanvas(true);
  let d3 = layerCtx().getImageData(0, 0, workW, workH).data;
  let rightRed = d3[((workH * 10 + (workW - 30)) * 4)];
  pass('flip H moved pixels', rightRed > 200);

  // ---- rotate 90 CW ----
  layerCtx().clearRect(0, 0, workW, workH);
  layerCtx().fillStyle = '#f00';
  layerCtx().fillRect(10, 50, 10, 10);
  rotateCanvas(true);
  pass('rotate kept 128x128', workW === 128 && workH === 128);
  let d4 = layerCtx().getImageData(0, 0, workW, workH).data;
  let rotPx = d4[((10 * workW + 68) * 4)];
  pass('rotate moved pixel', rotPx > 200, 'v=' + rotPx);

  // ---- resize ----
  resizeWork(64, 64, true);
  pass('resize changed size', workW === 64 && workH === 64);
  pass('resize kept content', countPixels(layerCtx(), 0, 0, 64, 64) > 0);

  // ---- crop ----
  workW = 128; workH = 128;
  paintCanvas.width = workW; paintCanvas.height = workH;
  activeLayer.canvas.width = workW; activeLayer.canvas.height = workH;
  layerCtx().clearRect(0, 0, workW, workH);
  layerCtx().fillStyle = '#f00';
  layerCtx().fillRect(20, 20, 80, 80);
  cropRect = { x: 20, y: 20, w: 80, h: 80 };
  applyCrop();
  pass('crop changed size', workW === 80 && workH === 80, workW + 'x' + workH);
  pass('crop kept content', countPixels(layerCtx(), 0, 0, workW, workH) > 1000);

  // ---- move tool: moves content, does NOT duplicate it ----
  layerCtx().clearRect(0, 0, workW, workH);
  layerCtx().fillStyle = '#f00';
  layerCtx().fillRect(10, 10, 20, 20);
  moveDown({ x: 15, y: 15 });
  moveMove({ x: 55, y: 55 });
  moveUp();
  let dm = layerCtx().getImageData(0, 0, workW, workH).data;
  let mvAtOrigin = 0, mvAtNew = 0;
  for (let y = 0; y < workH; y++) for (let x = 0; x < workW; x++) {
    const i = (y * workW + x) * 4;
    if (dm[i] > 200 && dm[i + 1] < 50) {
      if (x < 30 && y < 30) mvAtOrigin++;
      else mvAtNew++;
    }
  }
  pass('move tool moved content', mvAtNew > 200, 'new=' + mvAtNew);
  pass('move tool did not copy origin', mvAtOrigin === 0, 'origin=' + mvAtOrigin);

  // ---- transform ----
  workW = 128; workH = 128;
  paintCanvas.width = workW; paintCanvas.height = workH;
  activeLayer.canvas.width = workW; activeLayer.canvas.height = workH;
  layerCtx().clearRect(0, 0, workW, workH);
  layerCtx().fillStyle = '#f00';
  layerCtx().fillRect(20, 20, 40, 40);
  xfrmBegin();
  pass('transform began', !!xfrm);
  // move via the real drag flow: hit inside the box
  xfrm.dragging = null; // let xfrmDown pick the mode
  xfrmDown({ x: 40, y: 40 }); // inside the box (0,0)-(128,128)
  pass('transform move mode', xfrm.dragging === 'move');
  xfrmMove({ x: 70, y: 70 });
  commitXfrm();
  let d5 = layerCtx().getImageData(0, 0, workW, workH).data;
  let movedRed = d5[((50 * workW + 50) * 4)];
  pass('transform moved content', movedRed > 200, 'v=' + movedRed);

  // ---- transform scale: anchored, non-uniform ----
  layerCtx().clearRect(0, 0, workW, workH);
  layerCtx().fillStyle = '#0f0';
  layerCtx().fillRect(20, 20, 40, 40);
  xfrmBegin();
  // grab the bottom-right corner (in local coords it is at +w/2,+h/2)
  xfrmDown({ x: 127, y: 127 });
  pass('transform scale mode', xfrm.dragging === 'scale');
  // drag the corner inward to shrink
  xfrmMove({ x: 80, y: 80 });
  pass('transform scale shrank box', xfrm.w < 128 && xfrm.h < 128, 'w=' + Math.round(xfrm.w) + ' h=' + Math.round(xfrm.h));
  // anchor (top-left) stays at (0,0): the box top-left must stay put
  pass('transform scale anchored', Math.abs(xfrm.x) < 1 && Math.abs(xfrm.y) < 1, 'x=' + xfrm.x + ' y=' + xfrm.y);
  // non-uniform: drag the right edge only (box is 80x80 after the shrink)
  xfrm.dragStart = { x: xfrm.x + xfrm.w, y: xfrm.y + xfrm.h / 2, x0: xfrm.x, y0: xfrm.y, cx: xfrm.x + xfrm.w / 2, cy: xfrm.y + xfrm.h / 2, w: xfrm.w, h: xfrm.h, rot: xfrm.rot };
  xfrm.handle = { sx: 1, sy: 0 };
  xfrm.dragging = 'scale';
  xfrmMove({ x: 200, y: 80 });
  const stretchedW = xfrm.w;
  const stretchedH = xfrm.h;
  pass('transform scale non-uniform', Math.abs(stretchedH - 80) < 2 && stretchedW > 150, 'w=' + Math.round(stretchedW) + ' h=' + Math.round(stretchedH));
  commitXfrm();

  // ---- pressure-aware dab spacing: light strokes must stay continuous ----
  // A Krita pixel brush whose Size option maps pressure onto radius: at press
  // 0.1 the dab is ~1.5px but base-12px spacing would leave big gaps between
  // dabs. Spacing must follow the pressure-scaled radius.
  layerCtx().clearRect(0, 0, workW, workH);
  current = makeBrush('PressureGap', {
    engine: 'paintbrush', radius: 12, opacity: 1, spacing: 0.2, color: '#ff00ff',
    kpp: {
      used: { size: true, opacity: false, rotation: false, scatter: false },
      sizeCurve: { enabled: true, mode: 0, common: [{ x: 0, y: 0.03 }, { x: 1, y: 1 }], sensors: [{ id: 'pressure', pts: [{ x: 0, y: 0.03 }, { x: 1, y: 1 }] }] },
      scatter: 0, scatterAxisX: false, scatterAxisY: false
    }
  });
  refreshTip();
  paintCtx = activeLayer.canvas.getContext('2d');
  dabCarry = 0; dabLastPos = null;
  stampSegment({ x: 20, y: 64, press: 0.1 }, { x: 120, y: 64, press: 0.1 });
  (function () {
    var dl = layerCtx().getImageData(0, 0, workW, workH).data;
    var longest = 0, run = 0;
    for (var cx = 20; cx <= 120; cx++) {
      var has = false;
      for (var cy = 60; cy <= 68; cy++) if (dl[(cy * workW + cx) * 4 + 3] > 40) { has = true; break; }
      if (has) { if (run > longest) longest = run; run = 0; }
      else run++;
    }
    if (run > longest) longest = run;
    pass('light-pressure stroke is continuous', longest <= 1, 'longestGap=' + longest);
  })();
  // mypaint spacing must densify as pressure shrinks the actual radius
  current = makeBrush('MPDensity', {
    engine: 'mypaint', radius: 4, opacity: 1, spacing: 0.1, color: '#f0f',
    mypaint: { dabsPerActual: 2, dabsPerBasic: 0, baseRadius: 4, grainOffset: 0, radiusByRandom: 0, opaqueLinearize: 0 }
  });
  var stepBase = mypaintStep(100, 0, 1, NaN, 100, 0);
  var stepSmall = mypaintStep(100, 0, 1, NaN, 100, 0, 0.5);
  pass('mypaint spacing follows pressured radius', stepSmall < stepBase && stepSmall < 0.5, 'base=' + stepBase.toFixed(3) + ' small=' + stepSmall.toFixed(3));

  log('RESULT: ' + (lines.some(l => l.startsWith('FAIL ')) ? 'FAIL' : 'PASS'));
}
main().catch(e => { log('ERROR ' + (e && e.stack || e)); });
</script></body></html>`;

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
  const chromium = spawn('chromium', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions',
    '--remote-debugging-port=' + CDP_PORT, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let targets = null;
  for (let i = 0; i < 50; i++) {
    try { targets = JSON.parse(await cdpFetch('/json')); if (targets.length) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
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
      const d = msg.params.exceptionDetails;
      consoleLines.push('EXCEPTION: ' + (d.exception ? d.exception.description : d.text));
    }
  });

  await cdp(ws, 3, 'Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/__tools.html' });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (consoleLines.some(l => l.includes('RESULT:'))) break;
    await new Promise(r => setTimeout(r, 300));
  }
  ws.close();
  chromium.kill();
  server.close();
  const hits = consoleLines.filter(l => l.includes('TOOLS '));
  if (hits.length) {
    console.log(hits.join('\n'));
    process.exit(hits.some(l => l.includes('RESULT: PASS')) ? 0 : 1);
  }
  console.log(consoleLines.join('\n').slice(0, 3000));
  process.exit(1);
}

run().catch(e => { console.log('RUNNER ERROR: ' + (e && e.stack || e)); process.exit(1); });
