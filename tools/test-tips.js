#!/usr/bin/env node
// Headless verification of Krita ALPHAMASK tip rendering.
// The dab mask must follow Krita: dstA = qAlpha * (255 - qRed) / 255, so DARK
// tip pixels paint and WHITE stays transparent (a square + transparent splash
// inside is the old, inverted bug).
const { spawn } = require('child_process');
const { assertChrome } = require('./chrome');
const CHROME = assertChrome();
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8161;
const CDP_PORT = 9241;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.kpp': 'application/octet-stream',
  '.myb': 'application/octet-stream', '.svg': 'image/svg+xml', '.gbr': 'application/octet-stream',
  '.gih': 'application/octet-stream'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/editor.html';
  if (p === '/__tip_harness.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(harness); return; }
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
// real canvas contexts
const realCreateElement = document.createElement.bind(document);
document.createElement = function (tag) {
  const el = realCreateElement(tag);
  if (tag === 'canvas') {
    const realCtx = el.getContext.bind(el);
    el.getContext = function (type) { return realCtx(type); };
  }
  return el;
};

// Render a tip image through the ALPHAMASK conversion (mirrors paintTipMask)
// and report the mask alpha at given sample points.
function maskStats(tipCv, samplePoints) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 256;
  const g = cv.getContext('2d');
  paintTipMask(tipCv, g, 256, { r: 30, g: 100, b: 200 });
  const img = g.getImageData(0, 0, 256, 256).data;
  const out = {};
  for (const key in samplePoints) {
    const [px, py] = samplePoints[key];
    const a = img[(py * 256 + px) * 4 + 3];
    out[key] = a;
  }
  return out;
}

async function main() {
  // WaterC_Spread: tip = bristles_circle_dense.png (dark splash on white)
  const spread = await parseKppBytes('j)_WaterC_Spread.kpp', await fetchU8('/brushes/j)_WaterC_Spread.kpp'));
  log('spread tip loaded: ' + (spread.tip ? spread.tip.width + 'x' + spread.tip.height : 'null'));
  const okSpreadTip = spread.tip && spread.tip.width > 0;
  // Sample: corner (white bg) should be ~0 alpha; center (dark splash) ~opaque.
  const s = maskStats(spread.tip, { corner: [10, 10], center: [128, 128], mid: [64, 64] });
  log('spread mask: corner=' + s.corner + ' center=' + s.center + ' mid=' + s.mid);
  // bristles_circle_dense: corners white (alpha->0), center dark (alpha->high)
  const okSpreadMask = s.corner < 40 && s.center > 150;

  // Square-rough-tip brush (WaterC_Basic_Round-Grain)
  const grain = await parseKppBytes('j)_WaterC_Basic_Round-Grain.kpp', await fetchU8('/brushes/j)_WaterC_Basic_Round-Grain.kpp'));
  log('grain tip loaded: ' + (grain.tip ? grain.tip.width + 'x' + grain.tip.height : 'null'));
  const gs = maskStats(grain.tip, { corner: [10, 10], center: [128, 128] });
  log('grain mask: corner=' + gs.corner + ' center=' + gs.center);
  const okGrainMask = gs.corner < 40 && gs.center > 40;

  // GBR tip (bokey_circle.gbr) via a brush that references it
  // Directly parse the gbr and check stored-byte => mask orientation.
  const bokey = parseGbrBytes(await fetchU8('/brushes/tips/bokey_circle.gbr'));
  log('bokey gbr: ' + bokey.width + 'x' + bokey.height);
  // bokey stores circles as HIGH bytes (up to 205) on black(0) bg; after
  // parseGbrBytes (255-v) + inverted mask the dab = stored byte, so the circle
  // pixels must be OPAQUE and the black corners TRANSPARENT.
  const bk = maskStats(bokey, { corner: [3, 3], center: [128, 128] });
  log('bokey mask: corner=' + bk.corner + ' center=' + bk.center);
  const okGbr = bk.corner < 40 && bk.center > 40;

  // shape-tip beats embedded pattern (Basic_Lines-Dry has a chalk_round_hard
  // SHAPE tip AND an embedded 512x512 grain pattern; the shape must win so the
  // dab is round chalk, not a square of pattern grain)
  const linesDry = await parseKppBytes('j)_WaterC_Basic_Lines-Dry.kpp', await fetchU8('/brushes/j)_WaterC_Basic_Lines-Dry.kpp'));
  log('basic-lines-dry tip: ' + (linesDry.tip ? linesDry.tip.width + 'x' + linesDry.tip.height : 'null'));
  // chalk_round_hard.png is 300x300; the embedded pattern would be 512x512
  const okShapeTip = linesDry.tip && linesDry.tip.width === 300;

  // allGray tolerance: spike_blob.png is dark-on-white and must render
  // INVERTED (white corner -> transparent, dark center -> opaque) even though
  // bilinear scaling can round channels to slightly different values
  const flat = await parseKppBytes('j)_WaterC_Flat_Big-Grain_Tilt.kpp', await fetchU8('/brushes/j)_WaterC_Flat_Big-Grain_Tilt.kpp'));
  log('flat-big-grain tip: ' + (flat.tip ? flat.tip.width + 'x' + flat.tip.height : 'null'));
  const fs2 = maskStats(flat.tip, { corner: [10, 10], center: [128, 128] });
  log('spike mask: corner=' + fs2.corner + ' center=' + fs2.center);
  const okSpike = flat.tip && fs2.corner < 40 && fs2.center > 150;

  const pass = okSpreadTip && okSpreadMask && okGrainMask && okGbr && okShapeTip && okSpike;
  log('checks: spreadTip=' + okSpreadTip + ' spreadMask=' + okSpreadMask + ' grainMask=' + okGrainMask + ' gbr=' + okGbr + ' shapeTip=' + okShapeTip + ' spike=' + okSpike);
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

  await cdp(ws, 3, 'Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/__tip_harness.html' });
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
