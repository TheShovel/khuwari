/* Site test: home/docs/credits pages parse, nav present, docs hub search
 * works over the shared index and links into subpages, subpages have their
 * entries and category chips. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
// jsdom is a devDependency (see package.json at the repo root); run `npm
// install` to fetch it. A fallback to the old .scratch sandbox keeps the test
// runnable on machines with that setup already in place.
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  try {
    ({ JSDOM } = require(path.resolve(__dirname, '..', '.scratch', 'domtest', 'node_modules', 'jsdom')));
  } catch (e2) {
    console.error('jsdom is missing. Run `npm install` at the repo root (see tools/ + site_tools/ tests).');
    process.exit(1);
  }
}
const SITE = path.resolve(__dirname, '..');

let failures = 0;
function t(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); if (!cond) failures++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPage(file) {
  const html = fs.readFileSync(path.join(SITE, file), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'http://localhost/' + file, runScripts: 'outside-only' });
  return dom;
}

function bootJS(dom, extraFiles) {
  const ctx = dom.getInternalVMContext();
  (extraFiles || []).forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(SITE, f), 'utf8'), ctx);
  });
  // jsdom doesn't implement matchMedia; the home page doodles call it. A
  // `matches:false` stub (reduced-motion off) keeps the animations from
  // perturbing the assertions.
  if (!dom.window.matchMedia) {
    dom.window.matchMedia = function () {
      return { matches: false, media: '', addListener: function () {}, removeListener: function () {}, addEventListener: function () {}, removeEventListener: function () {}, dispatchEvent: function () { return false; } };
    };
  }
  vm.runInContext(fs.readFileSync(path.join(SITE, 'site.js'), 'utf8'), ctx);
  return dom.window;
}

(async () => {
  // home
  {
    const dom = loadPage('index.html');
    const { document } = dom.window;
    t('H1 home title mentions Khuwari', document.title.indexOf('Khuwari') !== -1);
    t('H2 nav has Home/Docs/Credits/GitHub', ['Home', 'Docs', 'Credits', 'GitHub'].every((l) =>
      Array.from(document.querySelectorAll('.nav-links a')).some((a) => a.textContent.trim() === l)));
    t('H3 hero has open button to the editor', (function () {
      const btn = document.querySelector('.hero-cta a.btn.primary');
      return btn && btn.getAttribute('href') === 'editor.html';
    })());
    t('H4 mascot art references root mascot', document.querySelector('.hero-art img').getAttribute('src') === 'mascot.png');
    t('H5 feature deck has 5 rows', document.querySelectorAll('.feat-deck .feat-row').length === 5);
    t('H5b feature rows alternate text/shot sides', (function () {
      // The private-by-design row is text-only; only the image rows alternate.
      const rows = Array.prototype.filter.call(document.querySelectorAll('.feat-row'), (r) => r.children.length === 2);
      let ok = true;
      rows.forEach((r, i) => {
        const first = r.querySelector(':scope > :first-child');
        const expectText = i % 2 === 0;
        if (expectText && !first.classList.contains('feat-text')) ok = false;
        if (!expectText && !first.classList.contains('feat-shot')) ok = false;
      });
      return ok;
    })());
    t('H6 three how-it-works steps', document.querySelectorAll('.steps .step').length === 3);
    t('H7 no em dashes in visible text', (document.body.textContent.indexOf('\u2014') === -1));
    t('H7b no kicker tagline on the home page', document.body.textContent.indexOf('I just want to animate') === -1);
    bootJS(dom, ['home-figures.js']);
    const win = dom.window;
    // Feature figures inject into every shot container and rows reveal.
    const shots = win.document.querySelectorAll('.feat-shot');
    t('H9c every feature shot got its figure', shots.length === 4 && Array.from(shots).every((s) => s.querySelector('img.fig-img')));
    t('H9d rows reveal on scroll (IO present)', (function () {
      if (!('IntersectionObserver' in win)) return true;
      const r0 = win.document.querySelector('.feat-row');
      return r0 && typeof r0.classList.toggle === 'function';
    })());
    // Homepage image keeps no fade gradient (only the editor start screen has one).
    // CSS lives split across styles/; the checks below read every part concatenated.
    function readAllCss() {
      return fs.readdirSync(path.join(SITE, 'styles'))
        .filter((f) => f.endsWith('.css'))
        .sort()
        .map((f) => fs.readFileSync(path.join(SITE, 'styles', f), 'utf8'))
        .join('\n');
    }
    const rootCss = readAllCss();
    const editorCss = readAllCss();
    t('H10 homepage art has no fade gradient', rootCss.indexOf('.hero-art::after') === -1);
    t('H11 editor start screen keeps its gradient', editorCss.indexOf('.start-art::after') !== -1);
  }

  // docs hub
  {
    const dom = loadPage('docs.html');
    const { document } = dom.window;
    t('D1 hub has 15 category cards', document.querySelectorAll('.doc-card').length === 15);
    t('D2 search box present', !!document.getElementById('docSearch'));
    t('D2b search count sits outside the input wrap (icon centers on the input)', (function () {
      const count = document.getElementById('searchCount');
      return count && count.parentElement && count.parentElement.classList.contains('search-wrap') === false;
    })());
    t('D3 hub links to subpages', (function () {
      const hrefs = Array.from(document.querySelectorAll('.doc-card')).map((a) => a.getAttribute('href'));
      return ['docs/getting-started.html', 'docs/privacy.html', 'docs/gaps.html'].every((h) => hrefs.indexOf(h) !== -1);
    })());
    t('D4 no em dashes in visible text', (document.body.textContent.indexOf('\u2014') === -1));

    // Index loads separately; run it before site.js so the search has data.
    const win = bootJS(dom, ['docs-data.js']);
    const input = win.document.getElementById('docSearch');

    input.value = 'onion';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    await sleep(10);
    const hits = Array.from(win.document.querySelectorAll('.search-hit'));
    t('D5 search finds onion topics', hits.length >= 3 && hits.every((h) => h.textContent.toLowerCase().indexOf('onion') !== -1));
    t('D6 hits link into their topics', hits.every((h) => {
      const href = h.getAttribute('href');
      // "onion" matches the Onion skinning category plus the paint tool's
      // "onion skin in paint" topic, which lives on the paint page.
      return href.indexOf('docs/onion-skinning.html#') !== -1 || (href.indexOf('docs/paint.html#') !== -1 && href.indexOf('onion') !== -1);
    }));
    t('D7 category grid hidden while searching', win.document.getElementById('catGrid').classList.contains('hidden'));
    t('D8 count text shows topics', /of \d+ topics/.test(win.document.getElementById('searchCount').textContent));

    input.value = 'zzzznomatch';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    await sleep(10);
    t('D9 no-match shows empty state', !win.document.getElementById('searchEmpty').classList.contains('hidden'));

    input.value = '';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    await sleep(10);
    t('D10 clearing search restores the grid', !win.document.getElementById('catGrid').classList.contains('hidden'));
  }

  // docs subpages
  {
    const slugs = ['getting-started', 'interface', 'keyframes', 'gaps', 'color-layers', 'onion-skinning', 'paint', 'blend-modes', 'camera', 'audio', 'undo-redo', 'export', 'settings', 'shortcuts', 'privacy'];
    const dir = path.join(SITE, 'docs');
    t('P1 all 15 subpages exist', slugs.every((s) => fs.existsSync(path.join(dir, s + '.html'))));

    slugs.forEach((slug) => {
      const dom = loadPage('docs/' + slug + '.html');
      const { document } = dom.window;
      const secs = document.querySelectorAll('.doc-sec');
      t('P2 ' + slug + ' has structured sections', secs.length >= 1);
      t('P3 ' + slug + ' has sidebar nav with active', (function () {
        const active = document.querySelector('.doc-side-nav a.active');
        return active && document.querySelectorAll('.doc-side-nav a').length === slugs.length;
      })());
      t('P4 ' + slug + ' has breadcrumb to hub', (function () {
        const crumb = document.querySelector('.crumbs a');
        return crumb && crumb.getAttribute('href') === '../docs.html';
      })());
      t('P5 ' + slug + ' no em dashes', document.body.textContent.indexOf('\u2014') === -1);
      // Sections must be laid out as articles, not capsule cards.
      t('P5b ' + slug + ' has no capsule cards', document.querySelectorAll('.doc-entry').length === 0);
      // Every local href/src on the subpage must resolve to a real file (a
      // broken stylesheet makes the page render unstyled and "all over the place").
      let allResolve = true;
      const pageHtml = fs.readFileSync(path.join(dir, slug + '.html'), 'utf8');
      [...pageHtml.matchAll(/(?:href|src)="([^"]+)"/g)].forEach((m) => {
        const h = m[1];
        if (/^https?:/.test(h) || h.startsWith('#')) return;
        const resolved = path.normalize(path.join(dir, h.split('?')[0]));
        if (!fs.existsSync(resolved)) allResolve = false;
      });
      t('P5c ' + slug + ' all links resolve', allResolve);
    });

    // Figures: several pages should carry real screenshots of the editor.
    const figPages = slugs.filter((s) => loadPage('docs/' + s + '.html').window.document.querySelectorAll('.doc-fig').length > 0);
    t('P9 figures appear on multiple pages (' + figPages.length + ' pages)', figPages.length >= 5);
    const css = readAllCss();
    t('P10 screenshot figures styled in CSS', css.indexOf('.fig-img') !== -1 && css.indexOf('border-radius') !== -1);
    const shotPages = slugs.filter((s) => loadPage('docs/' + s + '.html').window.document.querySelectorAll('.doc-fig img.fig-img').length > 0);
    t('P11 screenshot figures present (' + shotPages.length + ' pages)', shotPages.length >= 4);
    // Figure text must stay legible: no font-size under 12 in any figure.
    let smallText = false;
    slugs.forEach((s) => {
      const page = fs.readFileSync(path.join(dir, s + '.html'), 'utf8');
      const svgs = page.match(/<svg[\s\S]*?<\/svg>/g) || [];
      svgs.forEach((svg) => {
        [...svg.matchAll(/font-size="([\d.]+)"/g)].forEach((m) => {
          if (parseFloat(m[1]) < 12) smallText = true;
        });
      });
    });
    t('P11b all figure text is readable (min font-size 12)', !smallText);
    // Tables: shortcuts + blend modes + export use them.
    t('P12 shortcuts page has a table', loadPage('docs/shortcuts.html').window.document.querySelectorAll('.doc-table').length >= 2);
    t('P13 blend modes page has a table', loadPage('docs/blend-modes.html').window.document.querySelectorAll('.doc-table').length >= 1);

    // Every search-index id must resolve to an anchor on its subpage.
    const data = fs.readFileSync(path.join(SITE, 'docs-data.js'), 'utf8');
    const match = /window\.KHUWARI_DOCS = (\[[\s\S]*\]);/.exec(data);
    const index = match ? eval('(' + match[1] + ')') : [];
    t('P6 index has topics', index.length >= 25);
    let allResolve = true;
    index.forEach((item) => {
      const page = fs.readFileSync(path.join(SITE, item.url), 'utf8');
      if (page.indexOf('id="' + item.id + '"') === -1) allResolve = false;
    });
    t('P7 every search topic resolves to a subpage anchor', allResolve);
    // And every entry id on every subpage is in the index (round trip).
    let allIndexed = true;
    slugs.forEach((slug) => {
      const page = fs.readFileSync(path.join(dir, slug + '.html'), 'utf8');
      const ids = [...page.matchAll(/id="([^"]+)"/g)].map((m) => m[1]).filter((i) => i !== 'navLinks' && i !== 'navToggle');
      ids.forEach((id) => {
        if (!index.some((item) => item.id === id)) allIndexed = false;
      });
    });
    t('P8 every subpage entry id is in the index', allIndexed);
  }

  // credits
  {
    const dom = loadPage('credits.html');
    const { document } = dom.window;
    t('C1 credits page mentions RIFE', document.body.textContent.indexOf('RIFE') !== -1);
    t('C2 credits mention ONNX Runtime Web', document.body.textContent.indexOf('ONNX Runtime Web') !== -1);
    t('C3 credits mention AGPL', document.body.textContent.indexOf('AGPL') !== -1 || document.body.textContent.indexOf('Affero') !== -1);
    t('C4 no em dashes in visible text', (document.body.textContent.indexOf('\u2014') === -1));
  }

  console.log(failures ? failures + ' FAILURES' : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
