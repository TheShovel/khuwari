#!/usr/bin/env node
// Headless comparison of smoothing modes (none / basic / stabilizer).
// Draws the same pointer path through each mode's pump loop and reports
// how the rendered strokes differ (dab counts, painted length, pixel diffs).
const { spawn } = require('child_process');
const { assertChrome } = require('./chrome');
const CHROME = assertChrome();
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8153;
const CDP_PORT = 9233;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.kpp': 'application/octet-stream',
  '.myb': 'application/octet-stream', '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/editor.html';
  if (p === '/__stabilizer_harness.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(harness); return; }
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

// manual rAF queue so pump() runs deterministically
let rafQueue = [];
let rafRunning = false;
const realRaf = window.requestAnimationFrame;
window.requestAnimationFrame = function (cb) {
  rafQueue.push(cb);
  if (!rafRunning) { rafRunning = true; flushRaf(); }
  return 1;
};
window.cancelAnimationFrame = function () { rafRunning = false; };
function flushRaf() {
  // run exactly one queued frame per flush
  const cb = rafQueue.shift();
  if (cb) { cb(); }
}

// DOM stubs for paint.js module references
const stubEls = {};
function makeStub(id) {
  return {
    id, value: '', textContent: '', style: {},
    classList: { add(){}, remove(){}, toggle(){} },
    addEventListener(){}, getContext(){ return ctx2d(); }
  };
}
function ctx2d() {
  return {
    setTransform(){}, clearRect(){}, drawImage(){}, getImageData(){ return { data: new Uint8ClampedArray(4) }; },
    putImageData(){}, beginPath(){}, arc(){}, fill(){}, fillRect(){}, createLinearGradient(){ return { addColorStop(){} }; },
    createRadialGradient(){ return { addColorStop(){} }; }, save(){}, restore(){}, translate(){}, rotate(){},
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', strokeStyle: '', lineWidth: 1,
    setLineDash(){}, lineDashOffset: 0, ellipse(){}, moveTo(){}, lineTo(){}, closePath(){}, stroke(){}, filter: ''
  };
}
document.getElementById = function (id) {
  if (!stubEls[id]) {
    // sliders need .value defaults for alphaFromMode()
    const el = makeStub(id);
    if (id === 'paintSmoothStr') el.value = '60';
    if (id === 'paintSmoothMode') el.value = 'none';
    stubEls[id] = el;
  }
  return stubEls[id];
};
// canvases created via createElement need a real 2d context for stamping
const realCreateElement = document.createElement.bind(document);
document.createElement = function (tag) {
  if (tag === 'canvas') {
    const cv = realCreateElement('canvas');
    cv.width = 512; cv.height = 512;
    const realCtx = cv.getContext.bind(cv);
    cv.getContext = function (type) {
      const ctx = realCtx(type);
      if (!ctx.__real) { ctx.__real = true; }
      return ctx;
    };
    return cv;
  }
  return realCreateElement(tag);
};

function resetStrokeState() {
  rawPoints = []; rawLatest = null; smoothPt = null; lastPainted = null;
  drawing = false; rafId = 0; rafQueue = []; rafRunning = false;
  dabCarry = 0; dabLastPos = null;
}

// Simulate a stroke through the real pointer handlers + pump loop.
// path: array of {x,y} samples; dtBetween: not used (frames are per sample chunk)
function drawStroke(samples, mode, strength) {
  resetStrokeState();
  document.getElementById('paintSmoothMode').value = mode;
  document.getElementById('paintSmoothStr').value = String(strength);
  drawing = true;
  const press = 1;
  const p0 = samples[0];
  rawPoints = [{ x: p0.x, y: p0.y, press }];
  rawLatest = { x: p0.x, y: p0.y, press };
  smoothPt = { x: p0.x, y: p0.y, press };
  lastPainted = { x: p0.x, y: p0.y, press };
  smoothAlpha = alphaFromMode();
  dabCarry = 0; dabLastPos = null;
  stampDab(p0.x, p0.y, dabRadius(press), dabOpacity(press), null);
  dabLastPos = { x: p0.x, y: p0.y };
  // feed samples one at a time, flushing the rAF queue between them
  for (let i = 1; i < samples.length; i++) {
    const pt = samples[i];
    rawPoints.push({ x: pt.x, y: pt.y, press });
    rawLatest = { x: pt.x, y: pt.y, press };
    if (!rafId) rafId = requestAnimationFrame(pump);
    // run the queued frames until the queue drains (pump re-schedules itself)
    let guard = 0;
    while (rafQueue.length && guard++ < 200) {
      const cb = rafQueue.shift();
      cb();
    }
  }
  // allow catch-up after the last sample
  let guard = 0;
  while (rafQueue.length && guard++ < 200) { const cb = rafQueue.shift(); cb(); }
  // release
  drawing = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  sealStroke({ x: rawLatest.x, y: rawLatest.y, press });
}

function canvasStats(cv) {
  const ctx = cv.getContext('2d');
  const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let painted = 0, sumA = 0, minX = cv.width, minY = cv.height, maxX = 0, maxY = 0;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      const a = img[(y * cv.width + x) * 4 + 3];
      if (a > 8) {
        painted++;
        sumA += a;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { painted, avgA: painted ? Math.round(sumA / painted) : 0, minX, minY, maxX, maxY };
}

async function main() {
  // a curved, variable-speed stroke
  const samples = [];
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    const x = 30 + t * 200 + Math.sin(t * Math.PI * 2) * 30;
    const y = 250 + Math.sin(t * Math.PI) * 80;
    // variable speed: slow near start, fast middle, slow end
    const sp = 0.5 + 2.5 * Math.sin(t * Math.PI);
    samples.push({ x, y });
    if (i < 100) {
      // duplicate samples to simulate slow regions
      const reps = Math.max(1, Math.round(sp));
      for (let r = 1; r < reps; r++) samples.push({ x, y });
    }
  }

  // Use the bundled Basic-5 brush for a clean textured tip
  const basicBuf = await (await fetch('/brushes/b)_Basic-5_Size_default.kpp')).arrayBuffer();
  const basic = await parseKppBytes('b)_Basic-5_Size_default.kpp', new Uint8Array(basicBuf));
  current = basic;
  eraserOn = false;
  refreshTip();

  const results = {};
  for (const mode of ['none', 'basic', 'stabilizer']) {
    let dabCount = 0;
    let dabMinY = 999, dabMaxY = -999, dabMinX = 999, dabMaxX = -999;
    let badR = 0, badOp = 0, badSamples = [];
    const origStamp = stampDab;
    stampDab = function (x, y, r, op, rot) {
      dabCount++;
      if (y < dabMinY) dabMinY = y; if (y > dabMaxY) dabMaxY = y;
      if (x < dabMinX) dabMinX = x; if (x > dabMaxX) dabMaxX = x;
      if (!isFinite(r)) { badR++; if (badSamples.length < 3) badSamples.push('r=' + r + ' op=' + op + ' at (' + x.toFixed(1) + ',' + y.toFixed(1) + ')'); }
      if (!isFinite(op)) badOp++;
      return origStamp.apply(this, arguments);
    };
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 512;
    const saved = paintCtx;
    paintCtx = cv.getContext('2d');
    paintCtx.globalAlpha = 1;
    paintCtx.globalCompositeOperation = 'source-over';
    drawStroke(samples, mode, 60);
    paintCtx = saved;
    stampDab = origStamp;
    results[mode] = cv;
    const st = canvasStats(cv);
    log(mode + ': painted=' + st.painted + ' avgA=' + st.avgA + ' bbox=(' + st.minX + ',' + st.minY + ')-(' + st.maxX + ',' + st.maxY + ') dabs=' + dabCount + ' dabBBox=(' + dabMinX.toFixed(1) + ',' + dabMinY.toFixed(1) + ')-(' + dabMaxX.toFixed(1) + ',' + dabMaxY.toFixed(1) + ') badR=' + badR + ' badOp=' + badOp + ' badSamples=[' + badSamples.join(' | ') + '] lastPainted=(' + (lastPainted ? lastPainted.x.toFixed(1) + ',' + lastPainted.y.toFixed(1) : 'null') + ')');
  }

  // pixel-diff none vs stabilizer, none vs basic
  const diff = (a, b) => {
    const ca = a.getContext('2d').getImageData(0, 0, a.width, a.height).data;
    const cb = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
    let diffCount = 0, maxDiff = 0, sumDiff = 0;
    for (let i = 0; i < ca.length; i += 4) {
      const d = Math.abs(ca[i + 3] - cb[i + 3]);
      if (d > 8) diffCount++;
      if (d > maxDiff) maxDiff = d;
      sumDiff += d;
    }
    return { diffCount, maxDiff, avgDiff: Math.round(sumDiff / (ca.length / 4)) };
  };
  const dNS = diff(results.none, results.stabilizer);
  const dNB = diff(results.none, results.basic);
  log('diff none-vs-stabilizer: ' + JSON.stringify(dNS));
  log('diff none-vs-basic: ' + JSON.stringify(dNB));

  // release-flush: fast stroke + release while the stabilizer lags
  // Feed a fast stroke (10px per sample), stop, then run the onPaintUp flush
  // logic. The stroke must reach the cursor instead of cutting off short.
  {
    const flushCv = document.createElement('canvas');
    flushCv.width = 512; flushCv.height = 512;
    const savedCtx = paintCtx;
    paintCtx = flushCv.getContext('2d');
    paintCtx.globalAlpha = 1;
    paintCtx.globalCompositeOperation = 'source-over';
    const fastSamples = [];
    for (let i = 0; i <= 20; i++) fastSamples.push({ x: 30 + i * 10, y: 250 });
    resetStrokeState();
    document.getElementById('paintSmoothMode').value = 'stabilizer';
    document.getElementById('paintSmoothStr').value = '60';
    drawing = true;
    const press = 1;
    const p0 = fastSamples[0];
    rawPoints = [{ x: p0.x, y: p0.y, press }];
    rawLatest = { x: p0.x, y: p0.y, press };
    smoothPt = { x: p0.x, y: p0.y, press };
    lastPainted = { x: p0.x, y: p0.y, press };
    smoothAlpha = alphaFromMode();
    dabCarry = 0; dabLastPos = null;
    stampDab(p0.x, p0.y, dabRadius(press), dabOpacity(press), null);
    dabLastPos = { x: p0.x, y: p0.y };
    // feed samples WITHOUT flushing (simulating release during fast movement)
    for (let i = 1; i < fastSamples.length; i++) {
      const pt = fastSamples[i];
      rawPoints.push({ x: pt.x, y: pt.y, press });
      rawLatest = { x: pt.x, y: pt.y, press };
    }
    const lagBefore = Math.hypot(rawLatest.x - smoothPt.x, rawLatest.y - smoothPt.y);
    // replicate the new onPaintUp flush
    drawing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (rawLatest && (rawPoints.length || Math.hypot(rawLatest.x - smoothPt.x, rawLatest.y - smoothPt.y) > 0.5)) {
      for (let i = 0; i < rawPoints.length; i++) {
        const pt = rawPoints[i];
        smoothPt.x += (pt.x - smoothPt.x) * smoothAlpha;
        smoothPt.y += (pt.y - smoothPt.y) * smoothAlpha;
        const end = { x: smoothPt.x, y: smoothPt.y, press: pt.press };
        stampSegment(lastPainted, end);
        lastPainted = end;
      }
      let guard = 0;
      while (Math.hypot(rawLatest.x - smoothPt.x, rawLatest.y - smoothPt.y) > 0.5 && guard++ < 500) {
        smoothPt.x += (rawLatest.x - smoothPt.x) * smoothAlpha;
        smoothPt.y += (rawLatest.y - smoothPt.y) * smoothAlpha;
        const end2 = { x: smoothPt.x, y: smoothPt.y, press: rawLatest.press };
        stampSegment(lastPainted, end2);
        lastPainted = end2;
      }
    }
    sealStroke({ x: rawLatest.x, y: rawLatest.y, press: rawLatest.press });
    const lagAfter = Math.hypot(rawLatest.x - smoothPt.x, rawLatest.y - smoothPt.y);
    const distToEnd = Math.hypot(lastPainted.x - rawLatest.x, lastPainted.y - rawLatest.y);
    log('release-flush: lagBefore=' + lagBefore.toFixed(1) + ' lagAfter=' + lagAfter.toFixed(2) + ' lastPainted-to-cursor=' + distToEnd.toFixed(2));
    const okFlush = lagAfter < 0.6 && distToEnd < 0.6;
    log('release-flush check: ' + (okFlush ? 'PASS' : 'FAIL'));
    paintCtx = savedCtx;

    const stats = {};
    for (const mode of ['none', 'basic', 'stabilizer']) {
      const st = canvasStats(results[mode]);
      stats[mode] = st;
      if (!st.painted) log('MODE-BROKEN ' + mode + ': nothing painted');
    }
    // none/basic must paint a full stroke (regression: NaN press made them
    // paint only the opening dab). Areas should be within 15% of each other
    // (differences are only the path smoothing offset).
    const maxP = Math.max(stats.none.painted, stats.basic.painted, stats.stabilizer.painted);
    const minP = Math.min(stats.none.painted, stats.basic.painted, stats.stabilizer.painted);
    const okModes = minP > 5000 && (maxP - minP) / maxP < 0.15;
    log('mode-consistency check: ' + (okModes ? 'PASS' : 'FAIL') + ' (painted none=' + stats.none.painted + ' basic=' + stats.basic.painted + ' stabilizer=' + stats.stabilizer.painted + ')');
    log('RESULT: ' + ((okFlush && okModes) ? 'PASS' : 'FAIL'));
  }
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
  if (!pg) throw new Error('no page target: ' + JSON.stringify(targets));
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
      consoleLines.push('EXCEPTION: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 800));
    }
  });

  await cdp(ws, 3, 'Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/__stabilizer_harness.html' });
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
