// Verify the home page renders the new "Our stance on AI" section + image.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 8165;
const CDP_PORT = 9239;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(d); });
});
function cdpFetch(p) { return new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej); }); }
function cdp(ws, id, method, params) { return new Promise((res, rej) => { const h = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', h); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }; ws.addEventListener('message', h); ws.send(JSON.stringify({ id, method, params: params || {} })); }); }
(async () => {
  await new Promise(r => server.listen(PORT, r));
  const ch = spawn('chromium', ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions', '--remote-debugging-port=' + CDP_PORT, '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
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
  await cdp(ws, 3, 'Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
  await new Promise(r => setTimeout(r, 2500));
  const res = await cdp(ws, 4, 'Runtime.evaluate', {
    expression: `(function(){
      var sec = document.querySelector('.values-wrap');
      if (!sec) return 'NO SECTION';
      var card = sec.querySelector('.values-card');
      var img = card ? card.querySelector('img') : null;
      var cardStyle = card ? getComputedStyle(card) : null;
      return JSON.stringify({
        h2: sec.querySelector('h2') ? sec.querySelector('h2').textContent : '',
        text: card ? card.querySelector('p').textContent.slice(0, 40) : '',
        imgSrc: img ? img.src : '',
        imgLoaded: img ? img.complete && img.naturalWidth > 0 : false,
        imgW: img ? img.naturalWidth : 0,
        imgFilter: img ? getComputedStyle(img).filter : '',
        flexDir: cardStyle ? cardStyle.flexDirection : '',
        cardBg: cardStyle ? cardStyle.backgroundColor : ''
      });
    })()`,
    returnByValue: true
  });
  console.log('SITE ' + JSON.stringify(res.result.value));
  console.log('ERRS ' + consoleLines.filter(l => /EXCEPTION/.test(l)).length);
  consoleLines.filter(l => /EXCEPTION/.test(l)).slice(0, 3).forEach(e => console.log(e));
  ws.close(); ch.kill(); server.close();
  process.exit(0);
})().catch(e => { console.log('RUNERR ' + e.message); process.exit(1); });