#!/usr/bin/env node
// Headless verification that the brush size slider (current.radius) controls the
// painted size of MyPaint brushes' STROKE BODY, not just the click/release dabs.
// Regression: mypaintGrain centred the radius noise on the preset's baked-in
// baseRadius, so resizing only changed the opening/seal dabs while the stroke
// stayed at the preset's original size.
const { spawn } = require('child_process');
const { assertChrome } = require('./chrome');
const CHROME = assertChrome();
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8191;
const CDP_PORT = 9271;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.kpp': 'application/octet-stream',
  '.myb': 'application/octet-stream', '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/editor.html';
  if (p === '/__size_harness.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(harness); return; }
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
async function fetchU8(p) {
  const r = await fetch(p);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + p);
  return new Uint8Array(await r.arrayBuffer());
}
const realCreateElement = document.createElement.bind(document);
document.createElement = function (tag) {
  const el = realCreateElement(tag);
  if (tag === 'canvas') {
    const realCtx = el.getContext.bind(el);
    el.getContext = function (type) { return realCtx(type); };
  }
  return el;
};

// Measure the inked bounding box + max stroke width of a rendered stroke.
function strokeStats(cv) {
  const ctx = cv.getContext('2d');
  const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let minX = cv.width, minY = cv.height, maxX = 0, maxY = 0, n = 0;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      if (img[(y * cv.width + x) * 4 + 3] > 8) {
        n++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { n, minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

async function main() {
  const pencilBuf = await fetchU8('/brushes/c)_Pencil_1_Sketch_(mypaint).myb');
  const pencil = await parseMybBytes('c)_Pencil_1_Sketch_(mypaint).myb', pencilBuf, null);
  log('pencil baseRadius=' + pencil.radius.toFixed(2) + ' radiusByRandom=' + pencil.mypaint.radiusByRandom);

  // Draw a horizontal stroke with the pencil at TWO different sizes and compare
  // the painted height (should scale with the chosen size).
  function drawStroke(radius) {
    current = pencil;
    current.radius = radius;
    eraserOn = false;
    refreshTip();
    const cv = document.createElement('canvas');
    cv.width = 400; cv.height = 400;
    const saved = paintCtx;
    paintCtx = cv.getContext('2d');
    paintCtx.globalAlpha = 1;
    paintCtx.globalCompositeOperation = 'source-over';
    dabCarry = 0; dabLastPos = null;
    // opening dab (as onPaintDown does)
    stampDab(30, 200, dabRadius(1), dabOpacity(1), null);
    dabLastPos = { x: 30, y: 200 };
    // stroke body
    stampSegment({ x: 30, y: 200, press: 1 }, { x: 370, y: 200, press: 1 });
    // seal dab (as onPaintUp does)
    sealStroke({ x: 370, y: 200, press: 1 });
    paintCtx = saved;
    return cv;
  }

  const small = strokeStats(drawStroke(3));    // 3px radius -> ~6px wide stroke
  const big = strokeStats(drawStroke(30));     // 30px radius -> ~60px wide stroke
  log('small size (r=3):  bbox height=' + small.h + 'px inked=' + small.n);
  log('big size (r=30):   bbox height=' + big.h + 'px inked=' + big.n);

  // pixel brushes: painted diameter must match the slider exactly
  const basicBuf = await fetchU8('/brushes/b)_Basic-5_Size_default.kpp');
  const basic = await parseKppBytes('b)_Basic-5_Size_default.kpp', basicBuf);
  function drawPixel(radius) {
    current = basic;
    current.radius = radius;
    eraserOn = false;
    refreshTip();
    const cv = document.createElement('canvas');
    cv.width = 200; cv.height = 200;
    const saved = paintCtx;
    paintCtx = cv.getContext('2d');
    paintCtx.globalAlpha = 1;
    paintCtx.globalCompositeOperation = 'source-over';
    dabCarry = 0; dabLastPos = null;
    stampDab(100, 100, dabRadius(1), dabOpacity(1), null);
    dabLastPos = { x: 100, y: 100 };
    stampSegment({ x: 100, y: 100, press: 1 }, { x: 160, y: 100, press: 1 });
    sealStroke({ x: 160, y: 100, press: 1 });
    paintCtx = saved;
    return cv;
  }
  const p1 = strokeStats(drawPixel(10));  // slider 20px
  const p2 = strokeStats(drawPixel(25));  // slider 50px
  // Basic-5's Scatter option is UNCHECKED in the preset (PressureScatter=false,
  // see KisKritaSensorPack::read), so it must NOT scatter: the painted height is
  // exactly 2*radius (the test used to encode the scatter=5 bug as +2*scatter).
  const scatterPx = 0;
  log('pixel r=10: height=' + p1.h + ' (expect ~' + (2*10 + 2*scatterPx) + ')  r=25: height=' + p2.h + ' (expect ~' + (2*25 + 2*scatterPx) + ')');
  const okPixel = Math.abs(p1.h - (2*10 + 2*scatterPx)) <= 5 && Math.abs(p2.h - (2*25 + 2*scatterPx)) <= 5;

  // 1px brush must NOT scatter wildly (grainOffset now scales with radius)
  // libmypaint: offset_by_random * base_radius, and base_radius = the size the
  // user picked. A 1px (r=0.5) pencil stroke should stay within ~a few px.
  const tiny = strokeStats(drawStroke(0.5));  // slider 1px
  log('tiny size (r=0.5, 1px): bbox height=' + tiny.h + 'px inked=' + tiny.n);
  const okTiny = tiny.h < 20;  // was ~20-30px when scatter was fixed-10px absolute

  // The stroke BODY must scale with the radius (offset_by_random AND radius
  // noise are relative to the current radius, so the grainy pencil gets wider
  // as it gets bigger). small(r=3) ~52px, big(r=30) ~389px with the pencil's
  // heavy grain.
  const okBigger = big.h > small.h * 3;
  const okSmallIsSmall = small.h < 90;
  const okBigIsBig = big.h > 120;
  log('checks: bigger=' + okBigger + ' smallIsSmall=' + okSmallIsSmall + ' bigIsBig=' + okBigIsBig + ' pixel=' + okPixel + ' tiny=' + okTiny + ' (small h=' + small.h + ', big h=' + big.h + ', tiny h=' + tiny.h + ')');
  log('RESULT: ' + ((okBigger && okSmallIsSmall && okBigIsBig && okPixel && okTiny) ? 'PASS' : 'FAIL'));
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

  await cdp(ws, 3, 'Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/__size_harness.html' });
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
