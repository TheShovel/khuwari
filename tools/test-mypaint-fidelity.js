#!/usr/bin/env node
// Headless fidelity checks: pin the MyPaint/pixel engine maths to values
// computed by hand from libmypaint v1.6.1 (mypaint-brush.c prepare_and_draw_dab,
// mypaint-mapping.c mypaint_mapping_calculate, count_dabs_to).
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8144;
const CDP_PORT = 9226;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.kpp': 'application/octet-stream',
  '.myb': 'application/octet-stream', '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__harness.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(harness); return; }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/editor.html';
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, d) => {
    if (err) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(d);
  });
});

const harness = `<!doctype html><html><body>
<script src="/src/state.js"></script>
<script src="/src/paint.js"></script>
<script>
const lines = [];
function log(msg) { lines.push(msg); console.log('HARNESS ' + msg); }
async function fetchU8(p) {
  const r = await fetch(p);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + p);
  return new Uint8Array(await r.arrayBuffer());
}
function nearly(a, b, tol) { return Math.abs(a - b) <= tol; }
async function main() {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 512;
  paintCtx = cv.getContext('2d');

  // Deterministic gauss (0) so per-dab randomness can't hide math errors.
  gauss = function(){ return 0; };

  const pencilBuf = await fetchU8('/brushes/c)_Pencil_1_Sketch_(mypaint).myb');
  const pencil = await parseMybBytes('pencil', pencilBuf, null);
  current = pencil;
  refreshTip();

  // --- Pencil at Krita's mouse pressure (0.5): deterministic dab maths ---
  // opaque = clamp(max(0,1) * (0.34 + curve_opaque_multiply(0.5)),0,1)
  //   curve(0.5) on [[0,-0.666667],[0.404762,0],[1,1]] = 0.16 -> multiply 0.5
  // opaque_linearize 0.45 with dpp=(3.57+3.54)*2=14.22:
  //   lin = 1+0.45*13.22 = 6.949; op = 1-(1-0.5)^(1/6.949) = 0.0947
  // radius = e^(0.39) = 1.477; anti-aliasing min_fadeout 1 ->
  //   optical=1.329, hardness_new=0.453, radius_new=1/(1-0.453)=1.83
  // offset_by_random at pressure 0.5 = 2 + curve(0.5); curve stays -2 -> 0 -> no scatter
  const from = { x: 0, y: 0, press: 0.5 };
  const to = { x: 0, y: 0, press: 0.5 };
  const g = mypaintDab(100, 50, pencil.radius, pencil.opacity, from, to, 0.5, 0);
  log('pencil p=0.5: op=' + g.op.toFixed(4) + ' r=' + g.r.toFixed(3) + ' x=' + g.x + ' y=' + g.y + ' hardness=' + pencil._lastHardness);
  const okPencil =
    nearly(g.op, 0.0947, 0.01) &&
    nearly(g.r, 1.83, 0.08) &&
    nearly(pencil._lastHardness, 0.453, 0.03) &&
    g.x === 100 && g.y === 50;

  // --- Pencil at full stylus pressure (1.0): legitimately saturates ---
  const g1 = mypaintDab(0, 0, pencil.radius, pencil.opacity, { x: 0, y: 0, press: 1 }, { x: 0, y: 0, press: 1 }, 1, 0);
  log('pencil p=1.0: op=' + g1.op.toFixed(4) + ' r=' + g1.r.toFixed(3) + ' (expect op~1 solid)');
  const okPencilFull = nearly(g1.op, 1, 0.001);

  // --- Marker at Krita mouse pressure (0.5) with sp1=0 / dir=0 ---
  const mb = await fetchU8('/brushes/e)_Marker_Medium_(mypaint).myb');
  const marker = await parseMybBytes('marker', mb, null);
  current = marker;
  refreshTip();
  const mf = { x: 0, y: 0, press: 0.5, sp1: 0, sp2: 0, dir: 0, st: 1 };
  const mg = mypaintDab(0, 0, marker.radius, marker.opacity, mf, mf, 0.5, 0);
  // opaque = 1.83 + curve_opaque(0.5)=[0,1],[1,1]->1 = 2.83
  // opaque_multiply 0+curve(0.5) on [[0,0],[0.058642,0.259792],[1,0.43]] = 0.3398
  // opacity = clamp(2.83*0.3398)=0.962; linearize 0.9, dpp=4.42 -> 1-(1-0.962)^(1/4.078)=0.5515
  // ratio = base 10 + curve_speed1(0)=[[0,-7.5],...]->-7.5 = 2.5
  // angle = base 90 + curve_direction(0) = 90 -> PI/2 rad
  log('marker p=0.5: op=' + mg.op.toFixed(4) + ' ratio=' + mg.ratio + ' ratioIsSet=' + (mg.ang != null) + ' ang=' + (mg.ang != null ? (mg.ang * 180 / Math.PI).toFixed(1) : 'null'));
  const okMarker =
    nearly(mg.op, 0.5515, 0.03) &&
    nearly(mg.ratio, 2.5, 0.3) &&
    mg.ang != null && nearly(mg.ang * 180 / Math.PI, 90, 5);

  // --- Pixel brush (Krita Basic-5): NO fake pressure factor, paints at full
  // size/opacity at mouse pressure 0.5 ---
  const basicBuf = await fetchU8('/brushes/b)_Basic-5_Size_default.kpp');
  const basic = await parseKppBytes('basic5', basicBuf);
  current = basic;
  log('basic5 dabRadius(0.5)=' + dabRadius(0.5) + ' dabOpacity(0.5)=' + dabOpacity(0.5) + ' (expect 20 / 1)');
  const okPixel = nearly(dabRadius(0.5), 20, 0.01) && nearly(dabOpacity(0.5), 1, 0.001);

  // --- Spacing: marker uses dabs_per_second AND the ellipse transform. In
  // libmypaint count_dabs_to, a segment moving ALONG an elliptical dab counts
  // [ratio] x more distance, so a marker stroke needs a much denser ribbon of
  // overlapping dabs. At rest the marker ratio=2.5 and angle=90deg (fidelity
  // values from the mypaintDab checks above); for a 100px horizontal move over
  // 0.2s:
  //   cs=cos(90)=0 sn=1: effDist = hypot((0*0-100*1)*2.5, 0+0) = 250
  //   dabs = 250/10.07*0 + 250/10.07*2.21 + 0.2*11.08 = 54.87+2.22 = 57.1
  current = marker;
  const stepM = mypaintStep(100, 0.2, 2.5, Math.PI / 2, 100, 0);
  log('marker mypaintStep(100,0.2,ratio2.5,ang90,dx100)=' + stepM.toFixed(3) + ' dabs=' + (100 / stepM).toFixed(1) + ' (expect ~57.1 dabs, step ~1.75)');
  const okMarkerSpacing = nearly(100 / stepM, 57.1, 4);
  // Without the ellipse transform (dist, no ratio) the count matches the plain
  // count_dabs_to (dpa=0, dpb=2.21, baseR=10.07, dps=11.08):
  const stepM0 = mypaintStep(100, 0.2, 1, 0, 100, 0);
  const okMarkerSpacingPlain = nearly(100 / stepM0, 24.16, 1.5);
  log('marker plain-step dabs=' + (100 / stepM0).toFixed(1) + ' (expect ~24.2)');

  // --- fast-stroke stability: the ink pen must stay ON the line (no
  // slow-tracking drift off the path on a long fast segment) ---
  const inkBuf = await fetchU8('/brushes/d)_Ink_pen_(mypaint).myb');
  current = await parseMybBytes('ink', inkBuf, null);
  refreshTip();
  myStrokeInit({ x: 30, y: 200, press: 0.5 });
  dabCarry = 0; dabLastPos = null;
  stampSegment({ x: 30, y: 200, press: 0.5, t: 0 }, { x: 280, y: 200, press: 0.5, t: 0.02 });
  let minY = 1e9, maxY = -1, painted = 0;
  const dd = paintCtx.getImageData(0, 0, 512, 512).data;
  for (let i = 3; i < dd.length; i += 4) if (dd[i] > 8) { painted++; const y = Math.floor((i - 3) / 4 / 512); if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const okFast = painted > 500 && minY >= 194 && maxY <= 207; // within the dab radius of y=200
  log('ink fast-stroke: painted=' + painted + ' y[' + minY + ',' + maxY + '] (expect on-line)');

  // --- pressure gate floor: the sketch pencil must stay visible below its
  // ~0.40 pressure gate (previously it painted nearly nothing under ~40%) ---
  const ppbuf = await fetchU8('/brushes/c)_Pencil_1_Sketch_(mypaint).myb');
  const pencil2 = await parseMybBytes('pencil2', ppbuf, null);
  current = pencil2;
  const gate = pencil2.mypaint.pressureGate || 0;
  const pf = { x: 0, y: 0, press: 0.3, sp1: 0, sp2: 0, dir: 0, st: 1 };
  const lowOp = mypaintDab(0, 0, pencil2.radius, pencil2.opacity, pf, pf, 0.5, 0).op;
  const pf2 = { x: 0, y: 0, press: 1, sp1: 0, sp2: 0, dir: 0, st: 1 };
  const fullOp = mypaintDab(0, 0, pencil2.radius, pencil2.opacity, pf2, pf2, 0.5, 0).op;
  const okGate = gate > 0.2 && gate < 0.6 && lowOp >= 0.1 && fullOp > 0.5;
  log('pencil gate=' + gate.toFixed(3) + ' lowOp(p=0.3)=' + lowOp.toFixed(3) + ' fullOp(p=1)=' + fullOp.toFixed(3));

  const pass = okPencil && okPencilFull && okMarker && okPixel && okMarkerSpacing && okMarkerSpacingPlain && okFast && okGate;
  log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
}
main().catch(e => { log('ERROR ' + (e && e.stack || e)); });
</script></body></html>`;

function cdpFetch(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
}
function cdp(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener('message', h); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function run() {
  await new Promise(r => server.listen(PORT, r));
  const chromium = spawn('chromium', ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions', '--remote-debugging-port=' + CDP_PORT, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errOut = ''; chromium.stderr.on('data', d => errOut += d);
  let targets = null;
  for (let i = 0; i < 50; i++) { try { targets = JSON.parse(await cdpFetch('/json')); if (targets.length) break; } catch (e) {} await new Promise(r => setTimeout(r, 200)); }
  if (!targets) throw new Error('no targets ' + errOut.slice(0, 400));
  const pg = targets.find(t => t.type === 'page');
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 1, 'Runtime.enable');
  const lines = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') lines.push((m.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || '')).join(' '));
    if (m.method === 'Runtime.exceptionThrown') lines.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 400));
  });
  await cdp(ws, 2, 'Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/__harness.html' });
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) { if (lines.some(l => l.includes('RESULT:'))) break; await new Promise(r => setTimeout(r, 300)); }
  const hits = lines.filter(l => l.includes('HARNESS ') || l.includes('EXC '));
  console.log(hits.join('\n') || '(no harness output)');
  ws.close(); chromium.kill(); server.close();
  process.exit(hits.some(l => l.includes('RESULT: PASS')) ? 0 : 1);
}
run().catch(e => { console.log('RUNNER ' + (e && e.stack || e)); process.exit(1); });
