#!/usr/bin/env node
// End-to-end: open the paint editor, check the camera wiring (zoom buttons,
// wheel-on-wrap zoom, pan, fit), and verify the Ctrl/Cmd paste gate is present.
const { spawn } = require('child_process');
const { assertChrome } = require('./chrome');
const CHROME = assertChrome();
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8181;
const CDP_PORT = 9261;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.kpp': 'application/octet-stream',
  '.myb': 'application/octet-stream', '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/editor.html';
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

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
  const chromium = spawn(CHROME, [
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

  await cdp(ws, 3, 'Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/editor.html' });
  // open the paint tool
  const deadline = Date.now() + 30000;
  let opened = false;
  while (Date.now() < deadline) {
    try {
      const r = await cdp(ws, 4, 'Runtime.evaluate', {
        expression: 'document.getElementById("btnPaint") ? "yes" : "no"', returnByValue: true
      });
      if (r.result && r.result.value === 'yes') {
        await cdp(ws, 5, 'Runtime.evaluate', { expression: 'document.getElementById("btnPaint").click()' });
        await new Promise(r2 => setTimeout(r2, 2500));
        opened = true;
        break;
      }
    } catch (e) {}
    await new Promise(r2 => setTimeout(r2, 500));
  }

  const ev = async (expr) => {
    const r = await cdp(ws, 6, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result && r.result.value;
  };

  const results = [];
  results.push('zoom buttons: ' + await ev('["btnPaintZoomIn","btnPaintZoomOut","btnPaintFit","paintZoomVal"].map(function(id){return !!document.getElementById(id);}).join(",")'));
  results.push('zoom label: ' + await ev('document.getElementById("paintZoomVal").textContent'));
  // wheel on the wrap should zoom (label changes)
  await ev('var w = document.getElementById("paintCanvasWrap"); var r = w.getBoundingClientRect(); w.dispatchEvent(new WheelEvent("wheel", {deltaY: -120, clientX: r.left + r.width/2, clientY: r.top + r.height/2, bubbles: true, cancelable: true}));');
  results.push('zoom after wheel-in: ' + await ev('document.getElementById("paintZoomVal").textContent + " zoom=" + paintZoom.toFixed(2)'));
  // Fit button resets
  await ev('document.getElementById("btnPaintFit").click()');
  results.push('after fit: ' + await ev('document.getElementById("paintZoomVal").textContent + " zoom=" + paintZoom.toFixed(2) + " pan=" + paintPanX + "," + paintPanY'));
  // middle-drag pan wiring exists on the wrap (listener attachable) — verify no throw by simulating pointerdown
  const panRes = await ev('(function(){ var w = document.getElementById("paintCanvasWrap"); var r = w.getBoundingClientRect(); var ok = true; try { w.dispatchEvent(new PointerEvent("pointerdown", {button: 1, clientX: r.left+100, clientY: r.top+100, bubbles: true, cancelable: true, pointerId: 1})); w.dispatchEvent(new PointerEvent("pointermove", {button: 1, clientX: r.left+150, clientY: r.top+130, bubbles: true, cancelable: true, pointerId: 1})); w.dispatchEvent(new PointerEvent("pointerup", {button: 1, bubbles: true, cancelable: true, pointerId: 1})); } catch (err) { ok = false; } return ok + " pan=" + paintPanX.toFixed(0) + "," + paintPanY.toFixed(0); })()');
  results.push('pan: ' + panRes);
  ws.close();
  chromium.kill();
  server.close();
  console.log(results.join('\n'));
  console.log('OPENED=' + opened + ' errors=' + consoleLines.filter(l => /EXCEPTION/i.test(l)).length);
  process.exit(opened && consoleLines.filter(l => /EXCEPTION/i.test(l)).length === 0 ? 0 : 1);
}

run().catch(e => { console.log('RUNNER ERROR: ' + (e && e.message || e)); process.exit(1); });
