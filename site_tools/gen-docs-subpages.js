/* Generator for the Khuwari docs subpages.
 *
 * The docs text lives in Markdown files under docs-src/<slug>.md (one per
 * category): front matter holds the slug, title and blurb, and the body is a
 * list of sections. The pages are assembled from that content plus the FIG
 * figure library below and written to docs/ (which is committed).
 *
 *   node site_tools/gen-docs-subpages.js            regenerate docs/
 *   node site_tools/gen-docs-subpages.js --out DIR  write pages to DIR
 *     (handy for previewing a change without touching docs/)
 *
 * Markdown is a small subset, enough for these pages (see docs-src/README.md
 * for the full write-up):
 *   ## Title {#id}    section heading; the id is optional and slugified
 *                     from the title when omitted
 *   ### Title         sub-heading inside a section
 *   - item / 1. item  bullet and numbered lists
 *   | a | b | ...     table (first row header, second row --- separator)
 *   **bold**          <strong>
 *   `code`            <code>
 *   [[kbd:Key]]       <kbd>Key</kbd>
 *   [[na]]            <span class="muted">-</span>
 *   [[note]]          the next paragraph becomes <p class="doc-note">
 *   [[fig:name]]      insert a figure from the FIG library below
 *   Raw HTML (e.g. <kbd>Ctrl</kbd>, <a href="...">links</a>) passes through.
 *
 * When you add or rename a section, keep the search index in docs-data.js in
 * sync: it maps search topics to these section anchors.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SITE = path.resolve(__dirname, '..');
const OUT = path.join(SITE, 'docs');

const NAV = `<nav class="nav">
  <a class="nav-brand" href="../index.html">
    <img src="../logo.svg" alt="" class="brand-logo">
    Khuwari
  </a>
  <div class="nav-links" id="navLinks">
    <a href="../index.html">Home</a>
    <a href="../docs.html" class="active">Docs</a>
    <a href="../credits.html">Credits</a>
    <a href="https://github.com/TheShovel/khuwari">GitHub</a>
  </div>
  <div class="nav-cta">
    <a class="btn primary" href="../editor.html">Open Khuwari</a>
  </div>
</nav>`;

const FOOTER = `<footer class="footer">
  <div class="footer-inner">
    <div class="footer-brand">
      <img src="../logo.svg" alt="" class="brand-logo">
      Khuwari
    </div>
    <div class="footer-links">
      <a href="../index.html">Home</a>
      <a href="../docs.html">Docs</a>
      <a href="../credits.html">Credits</a>
      <a href="https://github.com/TheShovel/khuwari">GitHub</a>
    </div>
  </div>
</footer>`;

// Shared SVG figure library. Every figure mirrors the real app UI (same
// palette and layout) so it reads like a screenshot; animated ones use the
// .fig-* CSS animations in styles/site.css and pause under prefers-reduced-motion.
// Figures are authored at a 720-unit viewBox with fonts sized to match their
// boxes (no post-scaling), so text never overflows or clips.
// Figure library. UI figures are real screenshots of the editor (shots/);
// the remaining illustrations (project file, keyboard, privacy) are SVGs.
const FIG = {
  appWindow:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/win.png" alt="The Khuwari window with a project loaded: assets on the left, the canvas in the middle, the selection panel on the right, and the timeline along the bottom" width="720">
  <figcaption>The whole Khuwari window: library on the left, canvas in the middle, selection panel on the right, timeline along the bottom.</figcaption>
</figure>`,
  browserBar:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/start.png" alt="The Khuwari start screen with the mascot banner and the launch buttons" width="720">
  <figcaption>The start screen offers a new project, load, docs, an example project, credits and GitHub.</figcaption>
</figure>`,
  projectFile: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 200" role="img" aria-label="A .khuwari project file with its contents listed" class="fig-border">
    <rect x="40" y="30" width="200" height="150" rx="10" fill="#22272e" stroke="#39414d"/>
    <path d="M70 30 h60 l20 20 h50 v120 h-130 z" fill="#1b1f25" stroke="#8aa3b9" stroke-width="1.5"/>
    <text x="80" y="120" font-size="14.5" fill="#e6e9ee" font-weight="600">my-anim</text>
    <text x="80" y="138" font-size="12.5" fill="#c3ab7d">.khuwari</text>
    <text x="300" y="64" font-size="15" fill="#98a1ad">One file holds everything:</text>
    <circle cx="316" cy="92" r="3.5" fill="#8aa3b9"/><text x="328" y="96" font-size="15" fill="#e6e9ee">layers</text>
    <circle cx="316" cy="118" r="3.5" fill="#8aa3b9"/><text x="328" y="122" font-size="15" fill="#e6e9ee">keyframes and gaps</text>
    <circle cx="316" cy="144" r="3.5" fill="#8aa3b9"/><text x="328" y="148" font-size="15" fill="#e6e9ee">settings</text>
  </svg>
  <figcaption>One project, one file: easy to save, share and version.</figcaption>
</figure>`,
  assetsPanel:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/assets.png" alt="The assets panel with images in a grid" width="720">
  <figcaption>The assets panel. Drag any tile onto the timeline and it becomes a keyframe.</figcaption>
</figure>`,
  previewFilmstrip:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/preview.png" alt="The preview canvas with the filmstrip below it" width="720">
  <figcaption>The preview canvas with the filmstrip below. Click any thumb to jump to that frame.</figcaption>
</figure>`,
  timelineLayers:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/timeline_layers.png" alt="The timeline with a normal layer and a thin color layer holding stacked dot chips" width="720">
  <figcaption>The timeline. Keyframes are chips on their layer track; color layers stay thin and hold dots.</figcaption>
</figure>`,
  selectionPanel:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/selection.png" alt="The selection panel showing a selected keyframe" width="720">
  <figcaption>Select a keyframe and its details appear in the right panel.</figcaption>
</figure>`,
  kfChip:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/kfchip.png" alt="A keyframe chip selected on the timeline" width="720">
  <figcaption>Drag the chip to retime it; drag its edges to change how long it holds.</figcaption>
</figure>`,
  gapInbetween:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/gap.png" alt="A gap between two keyframes with the generated inbetween frames marked" width="720">
  <figcaption>Between two keyframes there is a gap, and Khuwari draws the inbetween frames for you.</figcaption>
</figure>`,
  squash:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/squash.png" alt="A gap in squash mode with its options in the right panel" width="720">
  <figcaption>Squash mode deforms the inbetweens, cartoon style.</figcaption>
</figure>`,
  motionBlur:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/blur.png" alt="A gap with motion blur on and its intensity slider in the right panel" width="720">
  <figcaption>Motion blur smears the inbetweens along their movement, easing in and out.</figcaption>
</figure>`,
  colorFill:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/colorfill.png" alt="Color dots flooding the line art shapes on the canvas" width="720">
  <figcaption>Each dot flood-fills the enclosed area inside the nearest lines.</figcaption>
</figure>`,
  onion:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/onion.png" alt="Onion skinning with ghost frames around the current one and the settings popup" width="720">
  <figcaption>Onion skinning keeps the neighboring frames faintly visible while you work. Ghosts, basically.</figcaption>
</figure>`,
  blend:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/blend.png" alt="The selection panel with the blend mode dropdown for a keyframe" width="720">
  <figcaption>Each keyframe can mix with the layers below it in 16 different ways.</figcaption>
</figure>`,
  exportMenu:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/export.png" alt="The export menu with the format and resolution dropdowns" width="720">
  <figcaption>The export menu. Pick a format and a resolution, then hit Export.</figcaption>
</figure>`,
  settingsMenu:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/settings.png" alt="The settings menu with FPS, snapping, aspect ratio and working size" width="720">
  <figcaption>The settings menu controls the pace and shape of your project.</figcaption>
</figure>`,
  keys: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 190" role="img" aria-label="Keyboard keys: space, left arrow, right arrow, delete" class="fig-border">
    <g class="fig-anim fig-tap">
      <rect x="60" y="50" width="220" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
      <text class="fig-key" x="170" y="88" font-size="17" fill="#e6e9ee" text-anchor="middle">Space</text>
    </g>
    <rect x="320" y="50" width="60" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
    <g transform="translate(332 62) scale(1.5)" fill="none" stroke="#e6e9ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 12H5"/>
      <path d="m12 19-7-7 7-7"/>
    </g>
    <rect x="400" y="50" width="60" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
    <g transform="translate(412 62) scale(1.5)" fill="none" stroke="#e6e9ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 12h14"/>
      <path d="m12 5 7 7-7 7"/>
    </g>
    <rect x="500" y="50" width="150" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
    <text class="fig-key" x="575" y="88" font-size="17" fill="#e6e9ee" text-anchor="middle">Del</text>
    <text x="360" y="150" font-size="15" fill="#98a1ad" text-anchor="middle">space plays, arrows step, delete removes</text>
  </svg>
  <figcaption>The shortcuts are easy to reach while you work.</figcaption>
</figure>`,
  paintWorkspace: `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/paint.png" alt="The paint workspace: toolbar on top, tools on the left, the canvas in the center, and color, brushes and layers dockers on the right" width="720">
  <figcaption>The paint workspace: a Krita-style window with tools, color, brushes and layers docked around the canvas.</figcaption>
</figure>`,
  cameraFig: `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/camera.png" alt="The camera panel open in the right panel with pan, zoom, rotation and the effects sliders, a lens-warped preview, and the Camera track with its key dots along the bottom" width="720">
  <figcaption>The camera panel. Drag any slider to add a camera key at the playhead, and the keys appear as dots on the Camera track. The Effects sliders add lens and film looks on top of the pan, zoom and rotation.</figcaption>
</figure>`,
  audioFig: `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/audio.png" alt="The audio panel with a loaded scratch track and the green waveform lane under the timeline" width="720">
  <figcaption>Load a scratch track in the Audio panel and a green waveform appears under the timeline, aligned with your keyframes.</figcaption>
</figure>`,
  historyFig: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 200" role="img" aria-label="The undo and redo buttons and the Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y shortcuts" class="fig-border">
    <rect x="40" y="24" width="150" height="44" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
    <g transform="translate(60.6 32.2) scale(1.2)" fill="none" stroke="#e6e9ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 14L4 9l5-5"/>
      <path d="M4 9h11a5 5 0 0 1 0 10h-1"/>
    </g>
    <text x="118" y="51" font-size="15" fill="#e6e9ee">Undo</text>
    <rect x="210" y="24" width="150" height="44" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
    <g transform="translate(222.6 32.2) scale(1.2)" fill="none" stroke="#e6e9ee" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M15 14l5-5-5-5"/>
      <path d="M20 9H9a5 5 0 0 0 0 10h1"/>
    </g>
    <text x="288" y="51" font-size="15" fill="#e6e9ee">Redo</text>
    <g class="fig-key">
      <rect x="46" y="98" width="62" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/><text x="77" y="133" font-size="17" fill="#e6e9ee" text-anchor="middle">Ctrl</text>
      <text x="116" y="133" font-size="17" fill="#c3ab7d" text-anchor="middle">+</text>
      <rect x="128" y="98" width="42" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/><text x="149" y="133" font-size="17" fill="#e6e9ee" text-anchor="middle">Z</text>
      <rect x="190" y="98" width="62" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/><text x="221" y="133" font-size="17" fill="#e6e9ee" text-anchor="middle">Ctrl</text>
      <text x="260" y="133" font-size="17" fill="#c3ab7d" text-anchor="middle">+</text>
      <rect x="272" y="98" width="72" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/><text x="308" y="133" font-size="17" fill="#e6e9ee" text-anchor="middle">Shift</text>
      <text x="352" y="133" font-size="17" fill="#c3ab7d" text-anchor="middle">+</text>
      <rect x="364" y="98" width="42" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/><text x="385" y="133" font-size="17" fill="#e6e9ee" text-anchor="middle">Z</text>
      <rect x="426" y="98" width="62" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/><text x="457" y="133" font-size="17" fill="#e6e9ee" text-anchor="middle">Ctrl</text>
      <text x="496" y="133" font-size="17" fill="#c3ab7d" text-anchor="middle">+</text>
      <rect x="508" y="98" width="42" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/><text x="529" y="133" font-size="17" fill="#e6e9ee" text-anchor="middle">Y</text>
    </g>
    <text x="46" y="184" font-size="14" fill="#98a1ad">Undo and redo work in the timeline and in the paint tool.</text>
  </svg>
  <figcaption>Undo and redo are one keystroke away, in the timeline and in the paint tool.</figcaption>
</figure>`,
  privacy: ``
};


// Markdown source loader.
//
// Reads docs-src/<slug>.md and renders each section into the same markup the
// page shell expects, so the generated pages only change when the markdown
// does. See docs-src/README.md for the supported syntax.

const MD_DIR = path.join(SITE, 'docs-src');

// Sidebar / prev-next order. Add a new category here AND as docs-src/<slug>.md.
const PAGE_ORDER = [
  'getting-started', 'interface', 'keyframes', 'gaps', 'color-layers',
  'onion-skinning', 'paint', 'blend-modes', 'camera', 'audio', 'undo-redo',
  'export', 'settings', 'shortcuts', 'privacy'
];

// Optional --out DIR writes the pages somewhere else (previews, tests).
const OUT_DIR = (process.argv[2] === '--out' && process.argv[3])
  ? path.resolve(process.argv[3])
  : OUT;

function mdErr(file, msg) { throw new Error(file + ': ' + msg); }

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inline tokens; split() keeps the captured matches.
const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\[\[[^\]\s]+\]\]|<\/?[a-zA-Z][^>]*>)/;

function inline(src, file) {
  return src.split(INLINE_RE).map(function (part) {
    if (!part) return '';
    if (part.charAt(0) === '`') return '<code>' + esc(part.slice(1, -1)) + '</code>';
    if (part.slice(0, 2) === '**') return '<strong>' + esc(part.slice(2, -2)) + '</strong>';
    if (part.slice(0, 2) === '[[') {
      const d = part.slice(2, -2);
      if (d.slice(0, 4) === 'kbd:') return '<kbd>' + esc(d.slice(4)) + '</kbd>';
      if (d === 'na') return '<span class="muted">-</span>';
      return mdErr(file, 'unknown inline directive [[' + d + ']]');
    }
    if (part.charAt(0) === '<') return part; // raw HTML passes through
    return esc(part);
  }).join('');
}

function parseFrontMatter(md, file) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) mdErr(file, 'must start with a front matter block: --- slug / title / blurb ---');
  const fm = {};
  m[1].split(/\r?\n/).forEach(function (line) {
    const kv = line.match(/^([a-z0-9_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2];
  });
  ['slug', 'title', 'blurb'].forEach(function (k) {
    if (!fm[k]) mdErr(file, 'front matter is missing "' + k + '"');
  });
  return { fm: fm, body: md.slice(m[0].length) };
}

function parseHeading(raw) {
  const m = raw.match(/^(.*?)\s*\{#([a-zA-Z0-9_-]+)\}\s*$/);
  if (m) return { title: m[1], id: m[2] };
  return { title: raw, id: raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') };
}

function parseSections(body, file) {
  const sections = [];
  const pre = [];
  let cur = null;
  body.split(/\r?\n/).forEach(function (line) {
    const hm = line.match(/^##\s+(.+)$/);
    if (hm) {
      const h = parseHeading(hm[1]);
      cur = { id: h.id, title: h.title, lines: [] };
      sections.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    } else {
      pre.push(line);
    }
  });
  if (!sections.length) mdErr(file, 'no ## sections found');
  if (pre.some(function (l) { return l.trim(); })) mdErr(file, 'text appears before the first ## section');
  const seen = {};
  sections.forEach(function (s) {
    if (seen[s.id]) mdErr(file, 'duplicate section id #' + s.id);
    seen[s.id] = true;
  });
  return sections;
}

const LIST_RE = /^([-*]|\d+\.)\s+/;

function blocksFromLines(lines, file) {
  const blocks = [];
  let note = false;
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; continue; }
    if (t === '[[note]]') { note = true; i++; continue; }
    const fig = t.match(/^\[\[fig:([a-zA-Z0-9_-]+)\]\]$/);
    if (fig) { blocks.push({ kind: 'fig', name: fig[1] }); i++; continue; }
    if (/^###\s+/.test(t)) { blocks.push({ kind: 'h3', text: t.slice(4) }); i++; continue; }
    if (/^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t)) {
      const kind = /^[-*]\s+/.test(t) ? 'ul' : 'ol';
      const items = [];
      while (i < lines.length) {
        const it = lines[i].trim().match(/^([-*]|\d+\.)\s+(.*)$/);
        if (!it) break;
        items.push(it[2]);
        i++;
      }
      blocks.push({ kind: kind, items: items });
      continue;
    }
    if (t.charAt(0) === '|') {
      const rows = [];
      while (i < lines.length && lines[i].trim().charAt(0) === '|') {
        rows.push(lines[i].trim());
        i++;
      }
      blocks.push({ kind: 'table', rows: rows });
      continue;
    }
    // Paragraph: lines until a blank line or the start of another block.
    const para = [];
    while (i < lines.length) {
      const l = lines[i].trim();
      if (!l) break;
      if (/^###\s+/.test(l) || LIST_RE.test(l) || l.charAt(0) === '|' ||
          l === '[[note]]' || /^\[\[fig:/.test(l)) break;
      para.push(l);
      i++;
    }
    if (!para.length) mdErr(file, 'cannot parse line: ' + t);
    blocks.push({ kind: note ? 'note' : 'p', text: para.join(' ') });
    note = false;
  }
  return blocks;
}

function renderTable(rows, file) {
  const sep = rows[1];
  if (!sep || !/^\|[\s:|-]+\|$/.test(sep)) mdErr(file, 'tables need a --- separator row after the header');
  const cells = function (row) {
    return row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
  };
  const header = cells(rows[0]).map(function (c) { return inline(c, file); });
  const body = rows.slice(2).map(function (r) {
    return '            <tr><td>' + cells(r).map(function (c) { return inline(c, file); }).join('</td><td>') + '</td></tr>';
  });
  return '<table class="doc-table">\n          <thead><tr><th>' + header.join('</th><th>') + '</th></tr></thead>\n' +
    '          <tbody>\n' + body.join('\n') + '\n          </tbody>\n        </table>';
}

function renderBlock(b, file) {
  switch (b.kind) {
    case 'p': return '<p>' + inline(b.text, file) + '</p>';
    case 'note': return '<p class="doc-note">' + inline(b.text, file) + '</p>';
    case 'h3': return '<h3>' + inline(b.text, file) + '</h3>';
    case 'ul':
    case 'ol':
      return '<' + b.kind + '>\n          <li>' +
        b.items.map(function (it) { return inline(it, file); }).join('</li>\n          <li>') +
        '</li>\n        </' + b.kind + '>';
    case 'table': return renderTable(b.rows, file);
    default: return mdErr(file, 'internal: unknown block kind ' + b.kind);
  }
}

function sectionHtml(s, file) {
  let html = '';
  blocksFromLines(s.lines, file).forEach(function (b) {
    if (b.kind === 'fig') {
      const fig = FIG[b.name];
      if (!fig) mdErr(file, 'unknown figure [[fig:' + b.name + ']] (available: ' + Object.keys(FIG).join(', ') + ')');
      html += '\n        ' + fig;
    } else {
      html += '\n        ' + renderBlock(b, file);
    }
  });
  return html + '\n      ';
}

function loadCategory(slug) {
  const file = path.join(MD_DIR, slug + '.md');
  let md;
  try {
    md = fs.readFileSync(file, 'utf8');
  } catch (e) {
    mdErr(file, 'cannot read markdown source');
  }
  const parsed = parseFrontMatter(md, file);
  if (parsed.fm.slug !== slug) mdErr(file, 'front matter slug must match the file name');
  return {
    slug: parsed.fm.slug,
    title: parsed.fm.title,
    blurb: parsed.fm.blurb,
    sections: parseSections(parsed.body, file).map(function (s) {
      return { id: s.id, title: s.title, html: sectionHtml(s, file) };
    })
  };
}

const CATEGORIES = PAGE_ORDER.map(loadCategory);
const ALL_TITLES = CATEGORIES.map((c) => ({ slug: c.slug, title: c.title }));

function sidebar(activeSlug) {
  return `
  <nav class="doc-side-nav">
    ${ALL_TITLES.map((c) =>
      `<a href="${c.slug}.html"${c.slug === activeSlug ? ' class="active"' : ''}>${c.title}</a>`).join('\n    ')}
  </nav>`;
}

function page(cat, prev, next) {
  const prevNext = [];
  if (prev) prevNext.push(`<a class="pn-link" href="${prev.slug}.html"><span class="pn-dir">Previous</span>${prev.title}</a>`);
  else prevNext.push('<span class="pn-link pn-empty"></span>');
  if (next) prevNext.push(`<a class="pn-link next" href="${next.slug}.html"><span class="pn-dir">Next</span>${next.title}</a>`);
  else prevNext.push('<span class="pn-link pn-empty"></span>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${cat.title} · Khuwari</title>
<meta name="description" content="${cat.blurb}">
<link rel="stylesheet" href="../styles/site.css">
</head>
<body>

${NAV}

<div class="wrap doc-layout">

  <aside class="doc-side">
    <a class="doc-side-back" href="../docs.html">All docs</a>
    <div class="doc-side-title">Categories</div>
    ${sidebar(cat.slug)}
  </aside>

  <main class="doc-main">
    <nav class="crumbs rise" aria-label="Breadcrumb">
      <a href="../docs.html">Docs</a>
      <span class="crumb-sep">/</span>
      <span>${cat.title}</span>
    </nav>

    <header class="doc-head rise-1">
      <h1>${cat.title}</h1>
      <p>${cat.blurb}</p>
    </header>

    ${cat.sections.map((s, i) => `
    <section class="doc-sec" id="${s.id}">
      <h2>${s.title}</h2>
      ${s.html}
    </section>`).join('\n')}

    <nav class="pn-nav">
      ${prevNext.join('\n    ')}
    </nav>
  </main>

</div>

${FOOTER}

<script src="../site.js"></script>
</body>
</html>
`;
}

const idx = {};
CATEGORIES.forEach((c, i) => { idx[c.slug] = { cat: c, prev: CATEGORIES[i - 1] || null, next: CATEGORIES[i + 1] || null }; });

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
CATEGORIES.forEach((c) => {
  const { prev, next } = idx[c.slug];
  fs.writeFileSync(path.join(OUT_DIR, c.slug + '.html'), page(c, prev, next));
  console.log('wrote', c.slug + '.html');
});
