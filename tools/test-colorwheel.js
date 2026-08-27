// Verify the Krita-style color wheel: HSV math, SV square rendering, and the
// drag interactions update current.color correctly.
const { spawn } = require('child_process');
const { assertChrome } = require('./chrome');
const CHROME = assertChrome();
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 8161;
const CDP_PORT = 9237;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.kpp': 'application/octet-stream', '.myb': 'application/octet-stream', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/editor.html';
  if (p === '/__cw.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); return; }
  const f = path.join(ROOT, p);
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(d); });
});
const PAGE = `<!doctype html><html><body>
<script src="/src/state.js"></script>
<script src="/src/paint-color.js"></script>
<script src="/src/paint-brushes.js"></script>
<script src="/src/paint-parsers.js"></script>
<script src="/src/paint-layers.js"></script>
<script src="/src/paint-tools.js"></script>
<script src="/src/paint.js"></script>
<script>
window.toast = function () {};
function pass(name, ok, extra) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : '')); }
async function main() {
  current = makeBrush('Test', { color: '#ff0000' });
  // HSV round-trip
  const h = rgbToHsv(255, 0, 0);
  pass('rgbToHsv red', Math.abs(h.h - 0) < 1 && h.s === 1 && h.v === 1, JSON.stringify(h));
  const c = hsvToRgb(120, 1, 1); // pure green
  pass('hsvToRgb green', c.g === 255 && c.r === 0 && c.b === 0, JSON.stringify(c));
  const c2 = hsvToRgb(0, 0.5, 0.5); // mid gray-pink
  const c3 = hsvToRgb(0, 0, 0.5);
  pass('hsvToRgb gray', c3.r === c3.g && c3.g === c3.b && c3.r === 128, JSON.stringify(c3));
  // sync reads current.color
  cwSvCv = document.createElement('canvas'); cwSvCv.width = 180; cwSvCv.height = 180;
  cwHueCv = document.createElement('canvas'); cwHueCv.width = 18; cwHueCv.height = 180;
  // stub DOM for positionColorWheel (uses byId)
  const dot = { style: {} };
  const mk = { style: {} };
  const hexIn = { value: '' };
  const paintCol = { style: {} }; // toolbar swatch now sets background
  const origById = byId;
  window.byId = function (id) {
    if (id === 'paintCwDot') return dot;
    if (id === 'paintCwHueMarker') return mk;
    if (id === 'paintCwHex') return hexIn;
    if (id === 'paintColor') return paintCol;
    return origById(id);
  };
  // getBoundingClientRect stub for the SV canvas
  cwSvCv.getBoundingClientRect = function () { return { left: 0, top: 0, width: 180, height: 180 }; };
  cwHueCv.getBoundingClientRect = function () { return { left: 0, top: 0, width: 18, height: 180 }; };
  syncColorWheel();
  pass('sync red', Math.abs(cwHsv.h - 0) < 1 && cwHsv.s === 1 && cwHsv.v === 1, JSON.stringify(cwHsv));
  // SV square rendered: top-left white, top-right red, bottom black
  const svg = cwSvCv.getContext('2d');
  const tl = svg.getImageData(2, 2, 1, 1).data;
  const tr = svg.getImageData(177, 2, 1, 1).data;
  const bl = svg.getImageData(2, 177, 1, 1).data;
  pass('sv square top-left white', tl[0] > 240 && tl[1] > 240 && tl[2] > 240, tl.slice(0,3).join(','));
  pass('sv square top-right red', tr[0] > 200 && tr[1] < 80 && tr[2] < 80, tr.slice(0,3).join(','));
  pass('sv square bottom black', bl[0] < 40 && bl[1] < 40 && bl[2] < 40, bl.slice(0,3).join(','));
  // hue slider rendered: top red, middle green, magenta at 300deg (y=150)
  const hg = cwHueCv.getContext('2d');
  const hTop = hg.getImageData(9, 1, 1, 1).data;
  const hMid = hg.getImageData(9, 89, 1, 1).data;
  const hMag = hg.getImageData(9, 149, 1, 1).data;
  pass('hue top red', hTop[0] > 200 && hTop[1] < 80, hTop.slice(0,3).join(','));
  pass('hue mid green', hMid[1] > 180 && hMid[0] < 100, hMid.slice(0,3).join(','));
  pass('hue 300deg magenta', hMag[0] > 180 && hMag[2] > 180 && hMag[1] < 100, hMag.slice(0,3).join(','));
  // apply: set hsv and push to current.color
  cwHsv = { h: 210, s: 0.5, v: 0.75 };
  applyColorWheel();
  const expect = hsvToRgb(210, 0.5, 0.75);
  pass('apply sets color', current.color === rgbToHex(expect.r, expect.g, expect.b), current.color);
  pass('apply updates hex input', hexIn.value === current.color);
  pass('apply updates toolbar swatch', paintCol.style.background === current.color);
  // dot + marker positioned
  pass('dot positioned', dot.style.left === '90px' && dot.style.top === '45px', dot.style.left + ',' + dot.style.top);
  pass('hue marker positioned', mk.style.top === Math.round(210 / 360 * 180) + 'px', mk.style.top);
  console.log('RESULT: ' + (true ? 'PASS' : 'FAIL'));
}
main().catch(e => { console.log('FAIL EXCEPTION ' + (e && e.stack || e)); });
</script></body></html>`;
function cdpFetch(p) { return new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej); }); }
function cdp(ws, id, method, params) { return new Promise((res, rej) => { const h = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', h); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }; ws.addEventListener('message', h); ws.send(JSON.stringify({ id, method, params: params || {} })); }); }
(async () => {
  await new Promise(r => server.listen(PORT, r));
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions', '--remote-debugging-port=' + CDP_PORT, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 50; i++) { try { targets = JSON.parse(await cdpFetch('/json')); if (targets.length) break; } catch (e) {} await new Promise(r => setTimeout(r, 200)); }
  const pg = targets.find(t => t.type === 'page');
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await cdp(ws, 1, 'Page.enable');
  await cdp(ws, 2, 'Runtime.enable');
  const lines = [];
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.consoleAPICalled') lines.push((m.params.args || []).map(a => a.value !== undefined ? a.value : a.description || '').join(' ')); });
  await cdp(ws, 3, 'Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/__cw.html' });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (lines.some(l => l.includes('RESULT:'))) break; await new Promise(r => setTimeout(r, 300)); }
  ws.close(); ch.kill(); server.close();
  const hits = lines.filter(l => /^(PASS|FAIL|RESULT)/.test(l));
  hits.forEach(l => console.log(l));
  const fails = hits.filter(l => l.startsWith('FAIL ')).length;
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });
