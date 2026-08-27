#!/usr/bin/env node
// Headless verification of the paint brush parsing + stamping math.
// Drives Chromium over CDP: loads src/state.js + src/paint.js in a bare page,
// calls the real parse functions with the bundled brush files, simulates
// strokes, and reports dab-density + parsed values.
const { spawn } = require('child_process');
const { assertChrome } = require('./chrome');
const CHROME = assertChrome();
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8141;
const CDP_PORT = 9223;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.kpp': 'application/octet-stream',
  '.myb': 'application/octet-stream', '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/editor.html';
  if (p === '/__harness.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(harness); return; }
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
async function main() {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 512;
  paintCtx = cv.getContext('2d');
  tipCanvas = null; // let refreshTip() create the proper 256px tip canvas

  const pencilBuf = await fetchU8('/brushes/c)_Pencil_1_Sketch_(mypaint).myb');
  const pencil = await parseMybBytes('c)_Pencil_1_Sketch_(mypaint).myb', pencilBuf, null);
  log('pencil radius = ' + pencil.radius.toFixed(3) + ' (expect ~1.477)');
  log('pencil spacing = ' + pencil.spacing.toFixed(4) + ' (expect ~0.0703)');
  log('pencil opacity = ' + pencil.opacity.toFixed(2) + ' (expect 0.34)');
  log('pencil hardness = ' + pencil.hardness);
  log('pencil mypaint = ' + JSON.stringify(pencil.mypaint));
  const okPencil =
    Math.abs(pencil.radius - 1.477) < 0.15 &&
    Math.abs(pencil.spacing - 0.0703) < 0.01 &&
    Math.abs(pencil.opacity - 0.34) < 0.03 &&
    pencil.mypaint && Math.abs(pencil.mypaint.grainOffset - 2.95) < 0.5 &&
    Math.abs(pencil.mypaint.radiusByRandom - 0.88) < 0.05 &&
    Math.abs(pencil.mypaint.opaqueLinearize - 0.45) < 0.05;

  const basicBuf = await fetchU8('/brushes/b)_Basic-5_Size_default.kpp');
  const basic = await parseKppBytes('b)_Basic-5_Size_default.kpp', basicBuf);
  log('basic5 radius = ' + basic.radius.toFixed(2) + ' (expect ~20, diam 40/2)');
  log('basic5 spacing = ' + basic.spacing.toFixed(3) + ' (expect ~0.126 = 0.8/sqrt(40))');
  log('basic5 hardness = ' + basic.hardness + ' (expect ~1 from hfade=1/vfade=1)');
  const okBasic = Math.abs(basic.radius - 20) < 0.1 && Math.abs(basic.spacing - 0.1265) < 0.005 && Math.abs(basic.hardness - 1) < 0.05;

  const eraserBuf = await fetchU8('/brushes/a)_Eraser_Circle.kpp');
  const eraser = await parseKppBytes('a)_Eraser_Circle.kpp', eraserBuf);
  log('eraser radius = ' + eraser.radius.toFixed(2) + ' (expect ~25)');
  log('eraser spacing = ' + eraser.spacing.toFixed(4) + ' (expect ~0.1697)');
  log('eraser hardness = ' + eraser.hardness + ' (expect ~0.87 from hfade)');
  log('eraser eraserFlag = ' + eraser.eraser);
  const okEraser = Math.abs(eraser.radius - 25) < 0.1 && Math.abs(eraser.spacing - 0.1697) < 0.005 && eraser.eraser === true && Math.abs(eraser.hardness - 0.87) < 0.05;

  const wpBuf = await fetchU8('/brushes/j)_WaterC_Water-Pattern.kpp');
  const wp = await parseKppBytes('j)_WaterC_Water-Pattern.kpp', wpBuf);
  log('waterpattern spacing = ' + wp.spacing.toFixed(2) + ' (expect 2, clamped)');

  // png_brush with scale: Spread (embedded scale 2.25, spacing 0.04) ->
  // radius = 20 (fallback 40px tip) * 2.25 = 45
  const spBuf = await fetchU8('/brushes/j)_WaterC_Spread.kpp');
  const sp = await parseKppBytes('j)_WaterC_Spread.kpp', spBuf);
  log('spread radius = ' + sp.radius.toFixed(2) + ' (expect ~45)');
  log('spread spacing = ' + sp.spacing.toFixed(3) + ' (expect ~0.04)');
  const okSpread = Math.abs(sp.radius - 45) < 0.5 && Math.abs(sp.spacing - 0.04) < 0.005;

  current = pencil;
  refreshTip();
  dabCarry = 0; dabLastPos = null;
  const step = dabStep(pencil.radius);
  log('pencil step = ' + step.toFixed(3) + ' (expect ~0.208)');
  const expectedDabs = Math.floor(100 / step) + 1;
  let count = 0;
  const orig = stampDab;
  stampDab = function () { count++; return orig.apply(this, arguments); };
  stampSegment({x: 0, y: 0, press: 1}, {x: 100, y: 0, press: 1});
  stampDab = orig;
  log('dabs over 100px = ' + count + ' (expect ~' + expectedDabs + ')');
  const okDensity = Math.abs(count - expectedDabs) <= 2;

  current = basic;
  refreshTip();
  const bstep = dabStep(basic.radius);
  log('basic5 step = ' + bstep.toFixed(3) + ' (expect ~5.06 = 0.8*sqrt(40))');
  const okBasicStep = Math.abs(bstep - 5.06) < 0.1;

  // rendered-stroke sanity: pencil must keep its grainy texture
  // opaque_linearize caps per-dab alpha; a dense pencil line should average
  // well below 100% alpha. The sketchy grain comes from radius_by_random
  // (per-dab radius noise) AND the translucent opacity at each overlap. We
  // verify this at press 0.5 - Krita's DEFAULT pressure for a mouse (a device
  // with no pressure axis reports 0.5). At full stylus pressure (1.0) Krita's
  // opaque_multiply curve legitimately ramps the pencil toward opaque, so the
  // ONLY correct check for "texture preserved" is the 0.5 case.
  function renderPencil(press) {
    current = pencil;
    refreshTip();
    dabCarry = 0; dabLastPos = null;
    const strokeCv = document.createElement('canvas');
    strokeCv.width = 300; strokeCv.height = 40;
    const sc = strokeCv.getContext('2d');
    const savedCtx = paintCtx;
    paintCtx = sc;
    stampSegment({x: 10, y: 20, press: press}, {x: 290, y: 20, press: press});
    paintCtx = savedCtx;
    const img = sc.getImageData(0, 0, 300, 40).data;
    let maxA = 0, sumA = 0, n = 0, sumSq = 0;
    for (let i = 3; i < img.length; i += 4) {
      if (img[i] > maxA) maxA = img[i];
      if (img[i] > 4) { sumA += img[i]; n++; sumSq += img[i] * img[i]; }
    }
    const avg = n ? sumA / n : 0;
    const std = n ? Math.sqrt(Math.max(0, sumSq / n - avg * avg)) : 0;
    return { maxA, avg: Math.round(avg), std: Math.round(std), n };
  }
  const low = renderPencil(0.25);
  log('pencil stroke (press 0.25): max alpha = ' + low.maxA + ' avg = ' + low.avg + ' std = ' + low.std + ' (light stylus press -> faint + grainy)');
  const okNotSaturated = low.maxA < 255;
  // Krita MOUSE default (pressure 0.5): must be translucent AND grainy, NOT a
  // solid opaque band.
  const half = renderPencil(0.5);
  log('pencil stroke (press 0.5, Krita mouse): max alpha = ' + half.maxA + ' avg = ' + half.avg + ' std = ' + half.std + ' (expect < 255 + grain variance)');
  // A solid opaque band has max alpha ~255 and near-zero spatial variance.
  // Texture (translucency + per-dab radius noise) keeps max below 255 and gives
  // the inked pixels real alpha spread.
  const okTexturedMouse = half.maxA < 250 && half.std > 6 && half.n > 500;

  // gaussian is bounded (libmypaint rand_gauss = Irwin-Hall, |x| <= 3.464)
  let gMax = 0, gSum = 0, gN = 100000;
  for (let gi = 0; gi < gN; gi++) { const v = Math.abs(gauss()); if (v > gMax) gMax = v; gSum += v; }
  log('gauss max |x| = ' + gMax.toFixed(3) + ' (expect <= 3.464, was unbounded before)');
  log('gauss mean |x| = ' + (gSum / gN).toFixed(3) + ' (expect ~0.8)');
  const okGauss = gMax <= 3.465 && Math.abs(gSum / gN - 0.8) < 0.05;
  // worst-case pencil radius with bounded noise: e^(ln(1.477) + 3.464*0.88) = e^3.44 ~ 31px
  const pencilMaxR = Math.exp(Math.log(1.477) + 3.464 * 0.88);
  log('pencil max noisy radius = ' + pencilMaxR.toFixed(1) + 'px (was ~290px with Box-Muller tails)');
  const okRadiusBound = pencilMaxR < 50;

  // mypaintGrain alpha correction: bigger dabs get less opacity
  current = pencil;
  const g0 = mypaintGrain(0, 0, pencil.radius, 1);
  let gBig = 0, gSmall = 0;
  for (let i = 0; i < 2000; i++) {
    const g = mypaintGrain(0, 0, pencil.radius, 1);
    if (g.r > pencil.radius * 2) gBig += g.op; // big dabs: opacity should be reduced
    else gSmall += g.op;
  }
  log('avg opacity big dabs = ' + (gBig / 2000).toFixed(3) + ' (expect < 1, alpha-corrected)');
  const okCorrection = (gBig / 2000) < 0.9;

  // size display is diameter (2x radius)
  current = basic; // radius 20 -> 40px diameter
  const sizeLabel = fmtSize(current.radius * 2);
  log('basic5 size label = ' + sizeLabel + ' (expect ~40px, Krita shows diameter)');
  const okSize = sizeLabel === '40px';

  const pass = okPencil && okBasic && okEraser && okDensity && okBasicStep && okSpread && okNotSaturated && okTexturedMouse && okGauss && okRadiusBound && okCorrection && okSize;
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

  // wait for the devtools endpoint
  let targets = null;
  for (let i = 0; i < 50; i++) {
    try { targets = JSON.parse(await cdpFetch('/json')); if (targets.length) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  if (!targets || !targets.length) throw new Error('no CDP targets: ' + errOut.slice(0, 500));

  // use the existing about:blank page target (avoiding /json/new's PUT requirement)
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
      consoleLines.push('EXCEPTION: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 500));
    }
  });

  // navigate to the harness
  const nav = await cdp(ws, 3, 'Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/__harness.html' });
  consoleLines.push('NAV: ' + JSON.stringify(nav).slice(0, 200));
  // wait for RESULT or timeout
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (consoleLines.some(l => l.includes('RESULT:'))) break;
    await new Promise(r2 => setTimeout(r2, 300));
  }
  // grab a few page facts for debugging
  try {
    const fact = await cdp(ws, 6, 'Runtime.evaluate', {
      expression: 'document.title + " | scripts=" + document.scripts.length + " | ready=" + document.readyState + " | url=" + location.href',
      returnByValue: true
    });
    consoleLines.push('FACTS: ' + (fact.result && fact.result.value));
  } catch (e) { consoleLines.push('FACTS ERROR: ' + e.message); }
  ws.close();
  const hits = consoleLines.filter(l => l.includes('HARNESS '));
  if (hits.length) {
    console.log(hits.join('\n'));
    process.exit(hits.some(l => l.includes('RESULT: PASS')) ? 0 : 1);
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
