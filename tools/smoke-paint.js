#!/usr/bin/env node
// Quick smoke test: load the full editor, open the paint tool, and report any
// console errors (especially in the paint code). Skips waiting for the ML model.
const { spawn } = require('child_process');
const { assertChrome } = require('./chrome');
const CHROME = assertChrome();
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8142;
const CDP_PORT = 9224;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.kpp': 'application/octet-stream',
  '.myb': 'application/octet-stream', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream'
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
      consoleLines.push('EXCEPTION: ' + (d.exception ? d.exception.description : d.text) + ' @' + (d.lineNumber + 1));
    }
  });

  await cdp(ws, 3, 'Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/editor.html' });
  // wait for the app to boot (paint button wired)
  let opened = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await cdp(ws, 4, 'Runtime.evaluate', {
        expression: 'document.getElementById("btnPaint") ? "yes" : "no"', returnByValue: true
      });
      if (r.result && r.result.value === 'yes') {
        await cdp(ws, 5, 'Runtime.evaluate', { expression: 'document.getElementById("btnPaint").click()' });
        // give the paint tool + brush loading a moment
        await new Promise(r2 => setTimeout(r2, 4000));
        const st = await cdp(ws, 6, 'Runtime.evaluate', {
          expression: 'var o = document.getElementById("paintOverlay"); (o ? (o.classList.contains("hidden") ? "overlay-hidden" : "overlay-visible") : "no-overlay") + " | paintOpen=" + (typeof paintOpen !== "undefined" ? paintOpen : "undef") + " | workW=" + (typeof workW !== "undefined" ? workW : "undef")',
          returnByValue: true
        });
        consoleLines.push('PAINT OVERLAY: ' + (st.result && st.result.value));
        // check listeners actually attached
        const lst = await cdp(ws, 7, 'Runtime.evaluate', {
          expression: 'var b = document.getElementById("btnPaint"); "listeners? " + (b && typeof b._listeners !== "undefined" ? "yes" : "n/a")',
          returnByValue: true
        });
        consoleLines.push('LISTENERS: ' + (lst.result && lst.result.value));
        // simulate a real mouse click event instead
        await cdp(ws, 8, 'Runtime.evaluate', {
          expression: 'var b = document.getElementById("btnPaint"); b.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true})); "dispatched"',
          returnByValue: true
        });
        await new Promise(r2 => setTimeout(r2, 1500));
        const st2 = await cdp(ws, 9, 'Runtime.evaluate', {
          expression: 'var o = document.getElementById("paintOverlay"); (o ? (o.classList.contains("hidden") ? "overlay-hidden" : "overlay-visible") : "no-overlay") + " | paintOpen=" + paintOpen',
          returnByValue: true
        });
        consoleLines.push('PAINT OVERLAY (dispatch): ' + (st2.result && st2.result.value));
        // click through every extra tool button and check paintTool + no errors
        const toolRes = await cdp(ws, 10, 'Runtime.evaluate', {
          expression: 'var ids = ["btnPaintToolSelect","btnPaintToolLasso","btnPaintToolMove","btnPaintToolTransform","btnPaintToolFill","btnPaintToolEyedrop","btnPaintToolLine","btnPaintToolRect","btnPaintToolEllipse","btnPaintToolCrop","btnPaintToolBrush"];' +
            'var out = []; ids.forEach(function (id) { var b = document.getElementById(id); if (!b) { out.push(id + ":MISSING"); return; }' +
            'b.dispatchEvent(new MouseEvent("click", {bubbles: true})); out.push(id + ":" + paintTool); });' +
            'out.join(" | ")',
          returnByValue: true
        });
        consoleLines.push('TOOLS: ' + (toolRes.result && toolRes.result.value));
        // verify overlay canvas exists and is sized
        const ov = await cdp(ws, 11, 'Runtime.evaluate', {
          expression: 'var o = document.getElementById("paintOverlayCv"); o ? (o.width + "x" + o.height + " style=" + o.style.width) : "missing"',
          returnByValue: true
        });
        consoleLines.push('OVERLAY: ' + (ov.result && ov.result.value));
        // check the default brush + list
        const br = await cdp(ws, 12, 'Runtime.evaluate', {
          expression: 'JSON.stringify({ current: current.name, size: current.radius, hardness: current.hardness, spacing: current.spacing, opacity: current.opacity, count: brushList.length, first: brushList[0].name, second: brushList[1] ? brushList[1].name : "none" })',
          returnByValue: true
        });
        consoleLines.push('BRUSHES: ' + (br.result && br.result.value));
        const cnt = await cdp(ws, 7, 'Runtime.evaluate', {
          expression: 'document.getElementById("paintBrushCount") ? document.getElementById("paintBrushCount").textContent : "n/a"',
          returnByValue: true
        });
        consoleLines.push('BRUSH COUNT: ' + (cnt.result && cnt.result.value));
        opened = true;
        break;
      }
    } catch (e) { consoleLines.push('poll err: ' + e.message); }
    await new Promise(r2 => setTimeout(r2, 500));
  }

  ws.close();
  chromium.kill();
  server.close();

  const errors = consoleLines.filter(l => /EXCEPTION|error|Error/i.test(l) && !/paintBrushStatus|brushes\]/.test(l));
  console.log(consoleLines.join('\n'));
  console.log('SMOKE: ' + (opened ? 'OPENED' : 'NOT-OPENED') + ' errors=' + errors.length);
  process.exit((opened && errors.length === 0) ? 0 : 1);
}

run().catch(e => { console.log('RUNNER ERROR: ' + (e && e.message || e)); process.exit(1); });
