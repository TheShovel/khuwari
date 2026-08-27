// Verify the paint tool UI renders: check new tool buttons, tool option panels,
// overlay canvas, dialogs, and computed styles.
const { spawn } = require('child_process');
const { assertChrome } = require('./chrome');
const CHROME = assertChrome();
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 8151;
const CDP_PORT = 9227;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.kpp': 'application/octet-stream', '.myb': 'application/octet-stream', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/editor.html';
  const f = path.join(ROOT, p);
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(d); });
});
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
  const consoleLines = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') consoleLines.push((m.params.args || []).map(a => a.value !== undefined ? a.value : a.description || '').join(' '));
    if (m.method === 'Runtime.exceptionThrown') consoleLines.push('EXCEPTION: ' + (m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text));
  });
  await cdp(ws, 3, 'Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/editor.html' });
  await new Promise(r => setTimeout(r, 6000));
  await cdp(ws, 4, 'Runtime.evaluate', { expression: 'document.getElementById("btnPaint").click()' });
  await new Promise(r => setTimeout(r, 3000));
  const res = await cdp(ws, 5, 'Runtime.evaluate', {
    expression: `(function(){
      var ids = ['btnPaintToolSelect','btnPaintToolLasso','btnPaintToolMove','btnPaintToolTransform','btnPaintToolFill','btnPaintToolEyedrop','btnPaintToolLine','btnPaintToolRect','btnPaintToolEllipse','btnPaintToolCrop','paintToolOptsSelect','paintToolOptsCrop','paintToolOptsFill','paintToolOptsShape','paintToolOptsMove','paintToolOptsTransform','paintOverlayCv','paintResizeDialog','paintImageMenu'];
      var missing = ids.filter(function(id){ return !document.getElementById(id); });
      // click each tool and verify opts panel visibility
      var clicks = [];
      ['select','crop','fill','rect','transform','brush'].forEach(function(t){
        document.getElementById('btnPaintTool' + t.charAt(0).toUpperCase() + t.slice(1)).dispatchEvent(new MouseEvent('click',{bubbles:true}));
        var optsId = {select:'paintToolOptsSelect',crop:'paintToolOptsCrop',fill:'paintToolOptsFill',rect:'paintToolOptsShape',transform:'paintToolOptsTransform',brush:'paintToolOptsBrush'}[t];
        clicks.push(t + '=' + (document.getElementById(optsId).classList.contains('hidden') ? 'hidden' : 'shown') + '/' + paintTool);
      });
      return JSON.stringify({ missing: missing, clicks: clicks });
    })()`,
    returnByValue: true
  });
  console.log('UI: ' + JSON.stringify(res.result.value));
  ws.close(); ch.kill(); server.close();
  const errors = consoleLines.filter(l => /EXCEPTION/.test(l));
  console.log('ERRORS: ' + errors.length);
  errors.slice(0, 5).forEach(e => console.log(e));
  process.exit(errors.length === 0 ? 0 : 1);
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });
