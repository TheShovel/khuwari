// Verify tools moved from the top toolbar into the left panel above Tool options.
const { spawn } = require('child_process');
const { assertChrome } = require('./chrome');
const CHROME = assertChrome();
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 8171;
const CDP_PORT = 9247;
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
  await cdp(ws, 3, 'Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/editor.html' });
  await new Promise(r => setTimeout(r, 6000));
  await cdp(ws, 4, 'Runtime.evaluate', { expression: 'document.getElementById("btnPaint").click()' });
  await new Promise(r => setTimeout(r, 2500));
  const res = await cdp(ws, 5, 'Runtime.evaluate', {
    expression: `(function(){
      var toolbarTools = document.querySelectorAll('.paint-toolbar .paint-tools').length;
      var leftTools = document.querySelectorAll('.paint-left .paint-tools').length;
      var toolCount = document.querySelectorAll('.paint-left .paint-tool').length;
      // tools section must come before the Tool options title
      var left = document.querySelector('.paint-left');
      var titles = Array.prototype.map.call(left.querySelectorAll('.docker-title'), function(t){ return t.textContent.trim(); });
      var toolsEl = left.querySelector('.paint-tools');
      var optsTitle = null;
      titles.forEach(function (t) { if (t === 'Tool options') optsTitle = t; });
      // find the second .docker-title (Tool options) and check it follows the tools
      var allTitles = left.querySelectorAll('.docker-title');
      var optionsTitleEl = allTitles[1];
      var toolsBeforeOptions = toolsEl && optionsTitleEl && (toolsEl.compareDocumentPosition(optionsTitleEl) & Node.DOCUMENT_POSITION_FOLLOWING);
      var cs = getComputedStyle(toolsEl);
      return JSON.stringify({ toolbarTools: toolbarTools, leftTools: leftTools, toolCount: toolCount, titles: titles, toolsBeforeOptions: !!toolsBeforeOptions, display: cs.display, cols: cs.gridTemplateColumns });
    })()`,
    returnByValue: true
  });
  console.log('LAYOUT: ' + res.result.value);
  ws.close(); ch.kill(); server.close();
  const v = JSON.parse(res.result.value);
  const ok = v.toolbarTools === 0 && v.leftTools === 1 && v.toolCount === 13 && v.toolsBeforeOptions && v.titles[0] === 'Tools';
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });
