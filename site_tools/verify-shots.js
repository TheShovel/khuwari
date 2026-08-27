// Pixel-level sanity check for the screenshots in shots/: loads each PNG over
// HTTP into a canvas and reports how many pixels fall into color buckets the
// shot is expected to contain. Usage: node site_tools/verify-shots.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { assertChrome } = require('../tools/chrome');
const CHROME = assertChrome();

const ROOT = path.resolve(__dirname, '..');
const PORT = 9334;
const BASE = process.env.SHOOT_URL || 'http://localhost:4000';

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      }
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
async function connect(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/json/list`);
      const page = (await res.json()).find((t) => t.type === 'page');
      if (!page) throw new Error('no page');
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      return new CDP(ws);
    } catch (e) { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('connect failed');
}

const BUCKETS = {
  gold:   [[180, 220], [140, 190], [90, 145]],     // character body
  blue:   [[40, 120], [110, 170], [220, 255]],     // fill dots
  sage:   [[120, 170], [160, 210], [150, 200]],    // generated band / ghosts
  red:    [[170, 210], [100, 145], [110, 150]],    // playhead
  darkbg: [[0, 60], [0, 60], [0, 60]]              // near-black canvas/timeline
};

async function main() {
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', 'about:blank'], { stdio: 'ignore' });
  process.on('exit', () => { try { chrome.kill(); } catch (e) {} });
  const cdp = await connect(PORT);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: BASE + '/editor.html' });
  await new Promise((r) => setTimeout(r, 3000));

  const files = fs.readdirSync(path.join(ROOT, 'shots')).filter((f) => f.endsWith('.png'));
  for (const f of files) {
    const expr = `(async function(){
      const img = new Image();
      img.src = ${JSON.stringify(BASE + '/shots/' + f)};
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const n = c.width * c.height;
      const buckets = { gold: 0, blue: 0, sage: 0, red: 0, darkbg: 0, other: 0 };
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gg = d[i + 1], b = d[i + 2];
        let hit = 'other';
        if (r < 60 && gg < 60 && b < 60) hit = 'darkbg';
        else if (r >= 40 && r <= 120 && gg >= 110 && gg <= 170 && b >= 220 && b <= 255) hit = 'blue';
        else if (r >= 120 && r <= 170 && gg >= 160 && gg <= 210 && b >= 150 && b <= 200) hit = 'sage';
        else if (r >= 180 && r <= 220 && gg >= 140 && gg <= 190 && b >= 90 && b <= 145) hit = 'gold';
        else if (r >= 170 && r <= 210 && gg >= 100 && gg <= 145 && b >= 110 && b <= 150) hit = 'red';
        buckets[hit]++;
      }
      const pct = {};
      for (const k in buckets) pct[k] = Math.round(buckets[k] / n * 1000) / 10;
      return { w: c.width, h: c.height, pct };
    })()`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) { console.log(f, 'ERROR', (r.exceptionDetails.exception || {}).description || r.exceptionDetails.text); continue; }
    const v = r.result.value;
    console.log(f.padEnd(18), v.w + 'x' + v.h, JSON.stringify(v.pct));
  }
  chrome.kill();
}
main().catch((e) => { console.error(e); process.exit(1); });
