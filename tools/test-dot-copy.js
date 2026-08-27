#!/usr/bin/env node
// UI-level verification of color-dot copy/paste through the REAL editor:
// right-click a dot chip -> Copy, right-click the fill lane -> Paste, and the
// pasted dot must carry the position, fill settings and window length of the
// original; Delete via the menu must remove it. Also checks that the shared
// context menu still behaves in frame mode for keyframes (paste disabled
// unless a keyframe is on the clipboard).
const { spawn } = require('child_process');
const { assertChrome } = require('./chrome');
const CHROME = assertChrome();
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 8195;
const CDP_PORT = 9281;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
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
  await new Promise(r => setTimeout(r, 5000));
  const res = await cdp(ws, 4, 'Runtime.evaluate', {
    expression: `(function(){
      try {
      var out = [];
      function log(m){ out.push(m); console.log('DOTCC ' + m); }
      function pass(name, ok, extra){ log((ok?'PASS ':'FAIL ')+name+(extra?' | '+extra:'')); }
      var passed = 0, failed = 0;
      function t(name, ok, extra){ if (ok) passed++; else failed++; pass(name, ok, extra); }

      addFillLayer();
      var fillId = state.layers.find(function(l){ return l.type === 'fill'; }).id;
      var dot = addDot(fillId, 0.3, 0.4);
      t('boot: dot created', !!dot);
      dot.color = '#123456'; dot.threshold = 0.7; dot.grow = 3;
      dot.gradOn = true; dot.gradColor = '#ff00ff'; dot.gradHeight = 12; dot.gradDir = 'left';
      renderLane();

      function chipRect(id) {
        var el2 = el.lane.querySelector('.fill-dot[data-dot="' + id + '"]');
        if (!el2) return null;
        var r = el2.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      function ctxAt(cx, cy, target) {
        // button: 2 is required for synthetic contextmenu events to be treated
        // as right-clicks by the target's ancestors.
        var e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: cx, clientY: cy });
        (target || document).dispatchEvent(e);
      }

      // 1) right-click the dot chip -> dot menu
      var c = chipRect(dot.id);
      ctxAt(c.x, c.y, el.lane.querySelector('.fill-dot[data-dot="' + dot.id + '"]'));
      t('menu opens on dot', !el.kfMenu.classList.contains('hidden'));
      t('menu copy label is Copy dot', el.kfMenuCopy.querySelector('span').textContent === 'Copy dot');
      t('paint entry hidden for dots', byId('btnKfPaint').classList.contains('hidden'));
      t('copy enabled', !el.kfMenuCopy.classList.contains('disabled'));

      // 2) Copy
      el.kfMenuCopy.click();
      t('menu hides after action', el.kfMenu.classList.contains('hidden'));
      t('copiedDot remembers settings', !!copiedDot && copiedDot.color === '#123456' && copiedDot.threshold === 0.7 &&
        copiedDot.grow === 3 && copiedDot.gradOn && copiedDot.gradColor === '#ff00ff' &&
        copiedDot.gradHeight === 12 && copiedDot.gradDir === 'left' &&
        copiedDot.x === 0.3 && copiedDot.y === 0.4 && +copiedDot.dur.toFixed(3) === 1 &&
        copiedDot.layer === fillId);

      // 3) right-click the fill lane (empty space) -> paste dot at clicked time
      var row = el.lane.querySelector('.layer-row[data-layer="' + fillId + '"]');
      var rr = row.getBoundingClientRect();
      var px = rr.left + 400, py = rr.top + rr.height / 2;
      state.playhead = 0;
      ctxAt(px, py, row.querySelector('.layer-content') || row);
      t('lane menu opens in dot mode', !el.kfMenu.classList.contains('hidden') && el.kfMenu._pasteDot);
      t('paste label is Paste dot', el.kfMenuPaste.querySelector('span').textContent === 'Paste dot');
      t('paste enabled with clipboard', !el.kfMenuPaste.classList.contains('disabled'));
      el.kfMenuPaste.click();
      var dots = state.layers.find(function(l){ return l.id === fillId; }).dots;
      t('paste created a second dot', dots.length === 2);
      if (dots.length === 2) {
        var d2 = dots.find(function(d){ return d.id !== dot.id; });
        t('pasted dot keeps settings', d2.color === '#123456' && d2.threshold === 0.7 && d2.grow === 3 &&
          d2.gradOn && d2.gradColor === '#ff00ff' && d2.gradHeight === 12 && d2.gradDir === 'left' &&
          d2.x === 0.3 && d2.y === 0.4);
        t('pasted dot selected', state.selectedDotId === d2.id);
        // window length preserved; pasted at the clicked (snapped) time
        var expectStart = insertTime(timeFromClientX(px));
        t('pasted window matches', Math.abs(d2.start - expectStart) < 0.001 && Math.abs((d2.end - d2.start) - (dot.end - dot.start)) < 0.001,
          JSON.stringify({ start: d2.start, expect: expectStart, dur: d2.end - d2.start }));

        // 4) right-click the pasted chip -> Delete
        renderLane();
        var c2 = chipRect(d2.id);
        ctxAt(c2.x, c2.y, el.lane.querySelector('.fill-dot[data-dot="' + d2.id + '"]'));
        t('dot chip menu opens again', !el.kfMenu.classList.contains('hidden'));
        t('delete label is Delete dot', el.kfMenuDelete.querySelector('span').textContent === 'Delete dot');
        el.kfMenuDelete.click();
        dots = state.layers.find(function(l){ return l.id === fillId; }).dots;
        t('delete removed the pasted dot', dots.length === 1 && dots[0].id === dot.id);
      }
      // 5) keyframe clipboard untouched by dot ops
      t('no copiedKeyframe side effects', copiedKeyframe === null);

      // 6) keyframe chip menu still frame-mode: paste needs a copied keyframe,
      // and pasting on a normal lane still lands a keyframe
      var nLayer = state.layers.find(function (l) { return l.type !== 'fill'; }).id;
      state.keyframes.push({ id: 'k9', layer: nLayer, time: 0.25, img: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', name: 'k', w: 8, h: 8 });
      renderLane();
      var kc = (function () {
        var e2 = el.lane.querySelector('.kf[data-id="k9"]');
        var r = e2.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })();
      ctxAt(kc.x, kc.y, el.lane.querySelector('.kf[data-id="k9"]'));
      t('kf chip menu opens in frame mode', !el.kfMenu.classList.contains('hidden') && el.kfMenu._pasteDot === false && el.kfMenu._kfId === 'k9');
      t('kf label is Copy frame', el.kfMenuCopy.querySelector('span').textContent === 'Copy frame');
      t('kf paste disabled while only a dot is copied', el.kfMenuPaste.classList.contains('disabled'));
      copyKeyframe('k9');
      // the menu closes on Copy; reopening it re-evaluates the disabled state
      ctxAt(kc.x, kc.y, el.lane.querySelector('.kf[data-id="k9"]'));
      t('kf paste enabled after frame copy', !el.kfMenuPaste.classList.contains('disabled'));
      el.kfMenuPaste.click();
      var kfs = state.keyframes;
      t('kf paste still lands a keyframe', kfs.length === 2 && kfs.some(function (k) { return k.id !== 'k9'; }));

      log('PASSED ' + passed + ' FAILED ' + failed);
      return out.join('\\n');
      } catch (err) { return 'THREW: ' + (err && err.stack || err); }
    })()`
  });
  console.log(res.result.value);
  const errs = consoleLines.filter(l => /EXCEPTION|THREW/.test(l));
  if (errs.length) console.log('CONSOLE EXCEPTIONS:\\n' + errs.join('\\n'));
  ch.kill();
  server.close();
  process.exit(0);
})().catch(e => { console.error('DRIVER ERROR: ' + e); process.exit(1); });