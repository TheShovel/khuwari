#!/usr/bin/env node
// Runtime verification that the previously-unsupported MyPaint settings now work:
//   1. color_h/s/v intrinsic brush colour (paints in preset colour, not the picker)
//   2. elliptical_dab_ratio/angle (markers draw elongated dabs at speed)
//   3. smudge (wet/marker brushes pick up the canvas colour under the dab)
const { spawn } = require('child_process');
const { assertChrome } = require('./chrome');
const CHROME = assertChrome();
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8192;
const CDP_PORT = 9272;

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.myb':'application/octet-stream', '.kpp':'application/octet-stream', '.svg':'image/svg+xml' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/editor.html';
  if (p === '/__gap_harness.html') { res.writeHead(200, {'Content-Type':'text/html'}); res.end(harness); return; }
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'application/octet-stream'});
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
function log(msg){ lines.push(msg); console.log('VERIFY ' + msg); }
async function fetchU8(p){ const r = await fetch(p); if(!r.ok) throw new Error('HTTP '+r.status+' '+p); return new Uint8Array(await r.arrayBuffer()); }
async function main(){
  // 1 + 3: Wet_Paint_Plus uses the CURRENT colour (Krita overrides
  // color_h/s/v with the foreground colour via setColor); Marker smudge +
  // elliptical
  const wp = await parseMybBytes('wp', await fetchU8('/brushes/i)_Wet_Paint_Plus_(mypaint).myb'), null);
  current = wp; current.color = '#123456'; eraserOn = false; refreshTip();
  myStrokeInit({x:100,y:100,press:1}); // real strokes always init stroke state
  var ins0 = {x:100,y:100,press:1,t:0,sp1:0,sp2:0,dir:0,st:1};
  var gw = mypaintDab(100,100,current.radius,current.opacity,ins0,ins0,0,0);
  log('Wet_Paint_Plus col=' + JSON.stringify(gw.col));
  var wetUsesCurrentColor = gw.col && Math.abs(gw.col.r - 0x12) < 24 && Math.abs(gw.col.g - 0x34) < 24 && Math.abs(gw.col.b - 0x56) < 24;

  const mk = await parseMybBytes('mk', await fetchU8('/brushes/e)_Marker_Medium_(mypaint).myb'), null);
  current = mk; current.color = '#888888'; refreshTip();
  myStrokeInit({x:100,y:100,press:1});
  // fast stroke: high smoothed speed (sp1 ~ 3) makes the marker elongate
  var insFast = {x:100,y:100,press:1,t:0,sp1:3.5,sp2:0,dir:0,st:1};
  var gE = mypaintDab(100,100,current.radius,current.opacity,insFast,insFast,0,0);
  log('Marker (fast) ratio=' + gE.ratio.toFixed(2) + ' col=' + JSON.stringify(gE.col));
  var markerElliptical = gE.ratio > 2;

  // smudge: paint a green field, then stamp the marker dab twice (smudge samples
  // on the 2nd call) and check the dab colour gains green.
  var cv = document.createElement('canvas'); cv.width=200; cv.height=200;
  var saved = paintCtx; paintCtx = cv.getContext('2d');
  paintCtx.fillStyle = '#00ff00'; paintCtx.fillRect(0,0,200,200);
  var gS1 = mypaintDab(100,100,current.radius,current.opacity,insFast,insFast,0,0); // sample
  var gS2 = mypaintDab(100,100,current.radius,current.opacity,insFast,insFast,0,0); // second -> samples
  paintCtx = saved;
  log('Marker smudge col=' + JSON.stringify(gS2.col));
  var markerSmudge = gS2.col && (gS2.col.g > 30);

  log('checks: wetUsesCurrentColor=' + wetUsesCurrentColor + ' markerElliptical=' + markerElliptical + ' markerSmudge=' + markerSmudge);
  log('RESULT: ' + ((wetUsesCurrentColor && markerElliptical && markerSmudge) ? 'PASS' : 'FAIL'));
}
main().catch(e => { log('ERROR ' + (e && e.stack || e)); });
</script></body></html>`;

let chromium = null;
function cdpFetch(pathname){ return new Promise((resolve,reject)=>{ http.get({host:'127.0.0.1',port:CDP_PORT,path:pathname},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>resolve(b));}).on('error',reject); }); }
function cdp(ws,id,method,params){ return new Promise((resolve,reject)=>{ const h=ev=>{const m=JSON.parse(ev.data); if(m.id===id){ws.removeEventListener('message',h); m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}}; ws.addEventListener('message',h); ws.send(JSON.stringify({id,method,params:params||{}})); }); }
async function run(){
  await new Promise(r=>server.listen(PORT,r));
  chromium = spawn(CHROME, ['--headless=new','--disable-gpu','--no-sandbox','--disable-extensions','--remote-debugging-port='+CDP_PORT,'about:blank'], {stdio:['ignore','ignore','pipe']});
  let errOut=''; chromium.stderr.on('data',d=>errOut+=d);
  let targets=null;
  for(let i=0;i<50;i++){ try{ targets=JSON.parse(await cdpFetch('/json')); if(targets.length) break; }catch(e){} await new Promise(r=>setTimeout(r,200)); }
  if(!targets||!targets.length) throw new Error('no CDP targets: '+errOut.slice(0,500));
  const pg = targets.find(t=>t.type==='page');
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',rej);});
  await cdp(ws,1,'Page.enable'); await cdp(ws,2,'Runtime.enable');
  const consoleLines=[];
  ws.addEventListener('message',ev=>{ const m=JSON.parse(ev.data); if(m.method==='Runtime.consoleAPICalled'){ const a=(m.params.args||[]).map(x=>x.value!==undefined?x.value:x.description||''); consoleLines.push(a.join(' ')); } if(m.method==='Runtime.exceptionThrown'){ consoleLines.push('EXCEPTION: '+JSON.stringify(m.params.exceptionDetails).slice(0,500)); } });
  await cdp(ws,3,'Page.navigate',{url:'http://127.0.0.1:'+PORT+'/__gap_harness.html'});
  const deadline=Date.now()+40000;
  while(Date.now()<deadline){ if(consoleLines.some(l=>l.includes('RESULT:'))) break; await new Promise(r2=>setTimeout(r2,300)); }
  ws.close();
  const hits=consoleLines.filter(l=>l.includes('VERIFY '));
  if(hits.length){ console.log(hits.join('\n')); process.exit(hits.some(l=>l.includes('RESULT: PASS'))?0:1); }
  console.log('No harness output. Console:\n'+consoleLines.join('\n').slice(0,3000)); process.exit(1);
}
run().catch(e=>{ console.log('RUNNER ERROR: '+(e&&e.stack||e)); if(chromium)chromium.kill(); server.close(); process.exit(1); });
