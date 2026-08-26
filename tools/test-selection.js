// UI-level verification of the selection tools, driven through the REAL
// editor with synthetic pointer events on #paintCanvas (same coordinate
// mapping as real input: clientX/clientY -> canvasPoint).
// Usage: node tools/test-selection.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 8157;
const CDP_PORT = 9231;
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
  const ch = spawn('chromium', ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions', '--remote-debugging-port=' + CDP_PORT, 'about:blank'], { stdio: 'ignore' });
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
  await new Promise(r => setTimeout(r, 1500));
  const res = await cdp(ws, 5, 'Runtime.evaluate', {
    expression: `(function(){
      try {
      var out = [];
      function log(m){ out.push(m); }
      function pass(name, ok, extra){ log((ok?'PASS ':'FAIL ')+name+(extra?' | '+extra:'')); return ok; }
      var cv = document.getElementById('paintCanvas');
      function ev(type, wx, wy, opts){
        opts = opts || {};
        var r = cv.getBoundingClientRect();
        var e = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: r.left + wx * r.width / workW, clientY: r.top + wy * r.height / workH, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, shiftKey: !!opts.shift, timeStamp: performance.now() });
        cv.dispatchEvent(e);
      }
      function drag(x0,y0,x1,y1){
        ev('pointerdown', x0, y0);
        var steps = 8;
        for (var i = 1; i <= steps; i++) ev('pointermove', x0 + (x1-x0)*i/steps, y0 + (y1-y0)*i/steps);
        ev('pointerup', x1, y1);
      }
      function click(x, y){ ev('pointerdown', x, y); ev('pointerup', x, y); }
      var lc = function(){ return activeLayer.canvas.getContext('2d'); };
      function count(r,g,b,minX,minY,maxX,maxY){
        var d = lc().getImageData(minX, minY, maxX-minX, maxY-minY).data;
        var n = 0;
        for (var i = 0; i < d.length; i += 4) if (Math.abs(d[i]-r) < 60 && Math.abs(d[i+1]-g) < 60 && Math.abs(d[i+2]-b) < 60 && d[i+3] > 100) n++;
        return n;
      }
      function darkOutline(x0,y0,x1,y1){
        var oc = overlayCtx, found = 0;
        for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) {
          var d = oc.getImageData(x, y, 1, 1).data;
          if (d[3] > 0 && d[0] < 60 && d[1] < 60 && d[2] < 60) found++;
        }
        return found;
      }
      function clear(){ lc().clearRect(0, 0, workW, workH); compositeDisplay(); }
      function rectSel(x0,y0,x1,y1){ setPaintTool('select'); selMode='rect'; document.getElementById('paintSelMode').value='rect'; drag(x0,y0,x1,y1); }
      function freshSel(x0,y0,x1,y1){ selectNone(); rectSel(x0,y0,x1,y1); }

      // ---------- 1. brush is masked to the selection ----------
      clear();
      lc().fillStyle = '#ff0000'; lc().fillRect(50, 50, 40, 40);
      freshSel(40, 40, 100, 100);
      pass('select+mask built', !!sel && !!selMaskCv);
      current = makeBrush('SelTest', { radius: 8, opacity: 1, spacing: 0.2, color: '#00ff00' });
      refreshTip();
      setPaintTool('brush');
      drag(70, 70, 170, 70);
      var greenInSel = count(0,255,0,50,60,90,80), greenOutSel = count(0,255,0,101,60,170,80);
      pass('brush masked to selection', greenInSel > 100 && greenOutSel === 0, 'in=' + greenInSel + ' out=' + greenOutSel);

      // ---------- 2. eraser stays inside the selection ----------
      clear();
      lc().fillStyle = '#ffffff'; lc().fillRect(30, 30, 120, 120);
      freshSel(50, 50, 100, 100);
      current = makeBrush('EraseTest', { radius: 6, opacity: 1, spacing: 0.2, eraser: true, color: '#000000' });
      refreshTip();
      setPaintTool('brush');
      drag(50, 75, 150, 75);   // crosses the right edge of the selection
      var stripIn = count(255,255,255,60,69,80,81), stripOut = count(255,255,255,101,69,150,81);
      pass('eraser masked to selection', stripIn < 80 && stripOut > 550, 'stripIn=' + stripIn + ' stripOut=' + stripOut);

      // ---------- 3. line is masked to the selection ----------
      clear();
      lc().fillStyle = '#ff0000'; lc().fillRect(50, 50, 40, 40);
      freshSel(40, 40, 100, 100);
      current = makeBrush('LineTest', { radius: 4, opacity: 1, spacing: 0.2, color: '#0000ff' });
      refreshTip();
      setPaintTool('line');
      ev('pointerdown', 30, 70);
      ev('pointermove', 130, 70);
      ev('pointerup', 130, 70);
      var lineInside = count(0,0,255,50,60,90,80), lineOutside = count(0,0,255,101,60,130,80);
      pass('line masked to selection', lineInside > 20 && lineOutside === 0, 'in=' + lineInside + ' out=' + lineOutside);

      // ---------- 4. rect shape fill is masked to the selection ----------
      clear();
      lc().fillStyle = '#ff0000'; lc().fillRect(50, 50, 40, 40);
      freshSel(40, 40, 100, 100);
      current = makeBrush('ShapeTest', { radius: 3, opacity: 1, spacing: 0.2, color: '#ffff00' });
      refreshTip();
      setPaintTool('rect');
      document.getElementById('paintShapeFill').checked = true;
      toolDrag = null;
      shapeDown({ x: 45, y: 45 });
      shapeMove({ x: 150, y: 110 });
      shapeUp();
      var shIn = count(255,255,0,50,50,90,90), shOut = count(255,255,0,101,50,150,110);
      pass('shape masked to selection', shIn > 200 && shOut === 0, 'in=' + shIn + ' out=' + shOut);

      // ---------- 5. fill limited to selection (contiguous) ----------
      clear();
      lc().fillStyle = '#ffffff'; lc().fillRect(0, 0, workW, workH);
      sel = { type: 'rect', x: 40, y: 40, w: 60, h: 60, feather: 0 };
      buildSelMask();
      current = makeBrush('FillTest', { radius: 4, opacity: 1, spacing: 0.1, color: '#00ff00' });
      document.getElementById('paintFillContiguous').checked = true;
      document.getElementById('paintFillUseSel').checked = true;
      fillDown({ x: 64, y: 64 });
      var fillIn = count(0,255,0,45,45,95,95), fillOut = count(0,255,0,0,0,40,workH);
      pass('fill contiguous respects selection', fillIn > 500 && fillOut === 0, 'in=' + fillIn + ' out=' + fillOut);

      // ---------- 6. fill non-contiguous does NOT wipe outside the selection ----------
      clear();
      lc().fillStyle = '#aaaaaa'; lc().fillRect(0, 0, workW, workH);
      lc().fillStyle = '#ffffff'; lc().fillRect(60, 60, 20, 20);
      sel = { type: 'rect', x: 50, y: 50, w: 40, h: 40, feather: 0 };
      buildSelMask();
      document.getElementById('paintFillContiguous').checked = false;
      document.getElementById('paintFillUseSel').checked = true;
      fillDown({ x: 65, y: 65 });
      var grayKept = count(170,170,170,0,0,50,workH) + count(170,170,170,0,0,workW,50);
      var outsideWiped = count(0,0,0,0,20,20,100);
      pass('fill non-contig keeps outside', grayKept > 1000 && outsideWiped === 0, 'gray=' + grayKept + ' black=' + outsideWiped);
      pass('fill non-contig filled inside', count(0,255,0,55,55,85,85) > 300);

      // ---------- 7. move tool moves ONLY the selected content ----------
      clear();
      lc().fillStyle = '#ff0000'; lc().fillRect(50, 50, 40, 40);
      lc().fillStyle = '#0000ff'; lc().fillRect(140, 140, 20, 20);
      freshSel(40, 40, 100, 100);
      setPaintTool('move');
      drag(70, 70, 110, 110);
      var redMoved = count(255,0,0,75,75,135,135), blueAtOld = count(0,0,255,140,140,160,160);
      pass('move tool moved selection content', redMoved > 400, 'red@new=' + redMoved);
      pass('move tool left layer outside selection', blueAtOld > 200, 'blue@old=' + blueAtOld);

      // ---------- 8. wand selects a contiguous region ----------
      clear();
      lc().fillStyle = '#ff0000'; lc().fillRect(50, 50, 40, 40);
      lc().fillStyle = '#0000ff'; lc().fillRect(120, 120, 10, 10);
      compositeDisplay();
      setPaintTool('wand');
      document.getElementById('paintWandContiguous').checked = true;
      document.getElementById('paintWandTol').value = 8;
      click(60, 60);
      pass('wand created mask selection', !!sel && sel.type === 'mask');
      pass('wand mask covers blob', selPoint(60, 60) === true && selPoint(80, 80) === true);
      pass('wand mask excludes blue', selPoint(125, 125) === false);
      pass('wand outline drawn', darkOutline(45, 45, 100, 100) > 100, 'dark=' + darkOutline(45, 45, 100, 100));

      // ---------- 8b. wand selects art that is NOT on the active layer ----------
      clear();
      lc().fillStyle = '#0000ff'; lc().fillRect(120, 120, 10, 10);
      var low2 = addLayer('low2', false);
      low2.canvas.getContext('2d').fillStyle = '#ff0000';
      low2.canvas.getContext('2d').fillRect(50, 50, 40, 40);
      compositeDisplay();
      setPaintTool('wand');
      document.getElementById('paintWandContiguous').checked = true;
      click(60, 60);   // art lives on low2, NOT the active layer
      pass('wand selects from the composite', !!sel && sel.type === 'mask' && selPoint(60, 60) === true && selPoint(125, 125) === false && selPoint(140, 140) === false, 'bounds=' + (selBounds() ? selBounds().x + ',' + selBounds().y : 'none'));

      // ---------- 8c. wand click on empty transparent space selects the background ----------
      click(300, 300);
      pass('wand transparent click selects background only', !!sel && selPoint(300, 300) === true && selPoint(60, 60) === false, 'sel60=' + selPoint(60, 60));

      // ---------- 9. inverted selection survives rebuilds + draws real outline ----------
      clear();
      lc().fillStyle = '#ff0000'; lc().fillRect(50, 50, 40, 40);
      freshSel(40, 40, 100, 100);
      invertSelection();
      pass('invert -> mask type', sel.type === 'mask');
      pass('invert excludes blob', selPoint(60, 60) === false);
      pass('invert includes outside', selPoint(5, 5) === true);
      buildSelMask();      // a rebuild must not turn it back into everything
      pass('invert survives rebuild', selPoint(60, 60) === false);
      var invOutline = darkOutline(0, 0, workW, workH);
      pass('invert has outline', invOutline > 200, 'dark=' + invOutline);

      // ---------- 10. clicking empty space with the select tool deselects ----------
      clear();
      lc().fillStyle = '#ff0000'; lc().fillRect(50, 50, 40, 40);
      freshSel(40, 40, 100, 100);
      click(150, 150);   // click empty space, no drag
      pass('clicking empty space deselects', !sel, 'sel=' + (sel ? 'still-selected' : 'cleared'));

      // ---------- 10b. the mode dropdown really switches shapes, even when the
      // drag starts on top of the old selection ----------
      clear();
      lc().fillStyle = '#ff0000'; lc().fillRect(50, 50, 40, 40);
      freshSel(40, 40, 100, 100);   // a rect selection exists
      document.getElementById('paintSelMode').value = 'ellipse';
      selMode = 'ellipse';
      drag(50, 50, 110, 110);       // drag starting INSIDE the old rect
      pass('dropdown ellipse mode draws an ellipse', !!sel && sel.type === 'ellipse', 'type=' + (sel && sel.type));

      // ---------- 11. feathered selection still masks the brush ----------
      clear();
      lc().fillStyle = '#ff0000'; lc().fillRect(50, 50, 40, 40);
      freshSel(40, 40, 100, 100);
      document.getElementById('paintSelFeather').value = 8;
      sel.feather = 8; buildSelMask();
      current = makeBrush('FeatherTest', { radius: 8, opacity: 1, spacing: 0.2, color: '#00ff00' });
      refreshTip();
      setPaintTool('brush');
      drag(70, 70, 170, 70);
      var fIn = count(0,255,0,50,60,90,80), fOutHard = count(0,255,0,120,60,170,80);
      pass('feathered brush stays inside', fIn > 100 && fOutHard === 0, 'in=' + fIn + ' out=' + fOutHard);

      // ---------- 12. mask-type selection moves (wand result) ----------
      clear();
      lc().fillStyle = '#ff0000'; lc().fillRect(50, 50, 40, 40);
      setPaintTool('wand');
      click(60, 60);
      setPaintTool('move');   // move selected content with the Move tool
      drag(60, 60, 90, 90);
      pass('mask selection moved', count(255,0,0,75,75,135,135) > 300, 'red@new=' + count(255,0,0,75,75,135,135));
      pass('mask selection moved outline', darkOutline(75, 75, 135, 135) > 40, 'dark=' + darkOutline(75, 75, 135, 135));

      // ---------- 13. color history: ONLY colors actually used on the canvas ----------
      state.colorHistory = [];
      renderRecentColors();
      setPaintColor('#101010');   // picked, but never painted
      pass('picking alone does not add to recents', state.colorHistory.length === 0, 'n=' + state.colorHistory.length);
      function paintWith(hex, x0, y0, x1, y1) {
        current = makeBrush('Hist' + hex, { radius: 6, opacity: 1, spacing: 0.2, color: hex });
        refreshTip();
        setPaintTool('brush');
        drag(x0, y0, x1, y1);
      }
      paintWith('#222222', 60, 60, 100, 60);
      pass('a painted stroke adds its color', state.colorHistory[0] === '#222222' && state.colorHistory.length === 1, 'hist=' + state.colorHistory.join(','));
      paintWith('#333333', 60, 90, 100, 90);
      pass('newest painted color goes first', state.colorHistory[0] === '#333333' && state.colorHistory.length === 2, 'hist=' + state.colorHistory.join(','));
      current = makeBrush('HistFill', { radius: 6, opacity: 1, spacing: 0.2, color: '#444444' });
      setPaintTool('fill');
      fillDown({ x: 20, y: 20 });
      pass('bucket fill adds the color', state.colorHistory[0] === '#444444', 'hist=' + state.colorHistory.join(','));
      current = makeBrush('HistErase', { radius: 6, opacity: 1, spacing: 0.2, eraser: true, color: '#555555' });
      refreshTip();
      setPaintTool('brush');
      drag(80, 80, 120, 80);
      pass('eraser strokes do not add colors', state.colorHistory[0] === '#444444' && state.colorHistory.indexOf('#555555') === -1, 'hist=' + state.colorHistory.join(','));
      var hexes = ['#111111', '#000011', '#332211', '#445566', '#778899', '#a0b0c0', '#123456', '#654321', '#fedcba', '#010203'];
      for (var hp = 0; hp < hexes.length; hp++) paintWith(hexes[hp], 30, 130 + (hp % 2) * 40, 60, 130 + (hp % 2) * 40);
      pass('history capped at 8 newest-first', state.colorHistory.length === 8 && state.colorHistory[0] === '#010203', 'n=' + state.colorHistory.length + ' first=' + state.colorHistory[0]);
      state.colorHistory = ['#123456'];
      renderRecentColors();
      document.querySelector('#paintRecentColors .paint-recent-swatch').click();
      pass('swatch click applies the colour', current.color === '#123456', 'color=' + current.color);
      state.colorHistory = ['#abcdef'];
      var saved = projectData();
      pass('project file carries colorHistory', Array.isArray(saved.colorHistory) && saved.colorHistory[0] === '#abcdef', 'first=' + (saved.colorHistory && saved.colorHistory[0]));
      applyProjectData(saved);
      pass('project load restores colorHistory', Array.isArray(state.colorHistory) && state.colorHistory[0] === '#abcdef', 'first=' + state.colorHistory[0]);

      // ---------- 14. leaving the page with unsaved work asks for confirmation ----------
      var leavePrompt = function () { var e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
      captureSavedBaseline();
      pass('clean project does not prompt on leave', leavePrompt() === false);
      state.zoom = (state.zoom === 55 ? 56 : 55);
      pass('unsaved edits prompt on leave', leavePrompt() === true);
      captureSavedBaseline();
      pass('saving clears the warning', leavePrompt() === false);
      newProject();
      pass('new project clears the warning', leavePrompt() === false);

      log('RESULT: ' + (out.some(function(l){ return l.indexOf('FAIL') === 0; }) ? 'FAIL' : 'PASS'));
      return out.join('\\n');
      } catch (e) { return 'THREW ' + (e && e.stack || e); }
    })()`,
    returnByValue: true
  });
  const hits = String(res.result.value).split('\n');
  hits.forEach(h => console.log('SEL ' + h));
  const pageErrs = consoleLines.filter(l => /EXCEPTION|THREW/.test(l));
  pageErrs.slice(0, 5).forEach(e => console.log('SELERR ' + e));
  ws.close(); ch.kill(); server.close();
  const errors = consoleLines.filter(l => /EXCEPTION/.test(l));
  errors.slice(0, 5).forEach(e => console.log('ERR ' + e));
  const failed = hits.some(h => h.indexOf('FAIL') === 0) || hits.some(h => h.indexOf('THREW') === 0);
  process.exit(failed || errors.length ? 1 : 0);
})().catch(e => { console.log('RUNERR ' + e.message); process.exit(1); });