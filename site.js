/* Khuwari website helpers: docs search (the hub searches every category
 * through the shared index and links to the subpages). */
(function () {
  'use strict';

  // Home page background doodles: the artist's white-outline drawings, tinted
  // with the site's pencil palette via CSS masks (styles/site-base.css). A
  // pool of doodles glides around the page; every placement gets a random
  // tilt, an occasional mirror and a varied size, so the background always
  // looks different. Each doodle fades in, holds with a slow tilt, then fades
  // out and drifts off to somewhere new.
  var doodles = document.querySelector('.bg-doodles');
  if (doodles) {
    var DOODLES = [
      { src: 'doodles/doodle1.png', c: 'd-gold',  w: 195, h: 175, m: 143 },
      { src: 'doodles/doodle2.png', c: 'd-blue',  w: 183, h: 177, m: -132.6 },
      { src: 'doodles/doodle3.png', c: 'd-red',   w: 169, h: 194, m: 129.8 },
      { src: 'doodles/doodle4.png', c: 'd-sage',  w: 189, h: 164, m: 22.7 },
      { src: 'doodles/doodle5.png', c: 'd-ochre', w: 200, h: 166, m: -156.7 },
      { src: 'doodles/doodle6.png', c: 'd-gold',  w: 141, h: 154, m: 66.9 },
      { src: 'doodles/doodle7.png', c: 'd-slate', w: 144, h: 154, m: 44.2 }
    ];
    // The doodle field was drawn on a 1440x900 canvas; positions become
    // percentages of the actual viewport so they spread out on any screen.
    var FIELD_W = 1440, FIELD_H = 900;
    function rand(min, max) { return min + Math.random() * (max - min); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    // Spots currently occupied by a doodle: { x, y, r }. New doodles pick a
    // spot clear of every occupied one (with padding), so they never overlap.
    var placed = [];
    function clearSpot(x, y, r) {
      for (var i = 0; i < placed.length; i++) {
        var o = placed[i];
        var dx = x - o.x, dy = y - o.y;
        var minD = r + o.r + 34;
        if (dx * dx + dy * dy < minD * minD) return false;
      }
      return true;
    }
    function pickSpot(doodle, scale) {
      var r = Math.max(doodle.w, doodle.h) / 2 * scale;
      var minX = r + 24, maxX = FIELD_W - r - 24;
      var minY = r + 24, maxY = FIELD_H - r - 24;
      var best = null, bestClear = -1;
      for (var t = 0; t < 60; t++) {
        var x = rand(minX, maxX), y = rand(minY, maxY);
        if (clearSpot(x, y, r)) return { x: x, y: y, r: r };
        var clear = 1e9;
        for (var i = 0; i < placed.length; i++) {
          var o = placed[i];
          var dx = x - o.x, dy = y - o.y;
          clear = Math.min(clear, Math.sqrt(dx * dx + dy * dy) - o.r);
        }
        if (clear > bestClear) { bestClear = clear; best = { x: x, y: y, r: r }; }
      }
      return best || { x: rand(minX, maxX), y: rand(minY, maxY), r: r };
    }
    // Doodle image URLs must resolve against the DOCUMENT (an inline custom
    // property feeds mask-image; a bare relative path would resolve against
    // the stylesheet instead). Anchoring the url keeps it page-independent.
    function doodleUrl(src) {
      var a = document.createElement('a');
      a.href = src;
      return a.href;
    }
    // The draw-in sweep runs across the unit; direction comes from the
    // drawing's main ink axis (m = screen degrees, y down): doodles whose
    // strokes flow rightwards draw left-to-right, the rest right-to-left.
    function sweepName(doodle) {
      return Math.cos(doodle.m * Math.PI / 180) >= 0 ? 'd-sweep-lr' : 'd-sweep-rl';
    }
    function makeUnit(doodle, scale) {
      var div = document.createElement('div');
      div.className = 'd-unit ' + doodle.c;
      div.style.setProperty('--doodle-src', 'url(\'' + doodleUrl(doodle.src) + '\')');
      // Size scales with the viewport width so doodles stay in proportion on
      // any screen; width and height share the vw unit to keep the aspect.
      div.style.width = (doodle.w * scale / FIELD_W * 100).toFixed(2) + 'vw';
      div.style.height = (doodle.h * scale / FIELD_W * 100).toFixed(2) + 'vw';
      doodles.appendChild(div);
      return div;
    }
    function place(div, spot, tilt, flip) {
      div.style.left = (spot.x / FIELD_W * 100).toFixed(2) + '%';
      div.style.top = (spot.y / FIELD_H * 100).toFixed(2) + '%';
      div.style.transform = 'translate(-50%, -50%) rotate(' + tilt.toFixed(1) + 'deg) scale(' + (flip ? -1 : 1) + ', 1)';
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // A few doodles, fully visible, still, spread apart.
      for (var s = 0; s < 5; s++) {
        var dd = DOODLES[(Math.random() * DOODLES.length) | 0];
        var sc = rand(0.9, 1.3);
        var spot = pickSpot(dd, sc);
        placed.push(spot);
        place(makeUnit(dd, sc), spot, rand(-24, 24), Math.random() < 0.3);
      }
    } else {
      var unitCount = 7;
      for (var u = 0; u < unitCount; u++) {
        var d0 = DOODLES[u];
        var s0scale = rand(0.9, 1.4);
        var s0 = pickSpot(d0, s0scale);
        placed.push(s0);
        var div = makeUnit(d0, s0scale);
        (async function run() {
          var unit = div, doodle = d0, scale = s0scale, spot = s0;
          for (;;) {
            var tilt = rand(-28, 28);
            var flip = Math.random() < 0.35;
            // Left/top land instantly; the transform glides the doodle into
            // place while it is hidden. The clip is reset to a zero-width
            // edge and the animation is cleared, so the reveal below always
            // starts from a blank sheet.
            unit.style.animation = 'none';
            unit.style.clipPath = 'polygon(0 0, 0% 0, 0% 100%, 0 100%)';
            place(unit, spot, tilt, flip);
            unit.style.opacity = 0;
            await sleep(1150);
            unit.style.opacity = 1;
            void unit.offsetHeight; // reflow so the sweep animation retriggers
            unit.style.animation = sweepName(doodle) + ' 1.1s cubic-bezier(0.33, 1, 0.36, 1) forwards';
            await sleep(1000);    // the drawing draws itself in
            // A slow tilt while it holds, like it is settling on the paper.
            unit.style.transform = 'translate(-50%, -50%) rotate(' + (tilt + rand(4, 10)).toFixed(1) + 'deg) scale(' + (flip ? -1 : 1) + ', 1)';
            await sleep(1300 + rand(1000, 1900));
            unit.style.opacity = 0;
            await sleep(600);
            // Free the old spot, claim the next one while still hidden.
            var idx = placed.indexOf(spot);
            if (idx !== -1) placed.splice(idx, 1);
            doodle = DOODLES[(Math.random() * DOODLES.length) | 0];
            scale = rand(0.9, 1.4);
            var next = pickSpot(doodle, scale);
            placed.push(next);
            spot = next;
            // Swap in the next doodle's tint and size while hidden.
            unit.className = 'd-unit ' + doodle.c;
            unit.style.setProperty('--doodle-src', 'url(\'' + doodleUrl(doodle.src) + '\')');
            unit.style.width = (doodle.w * scale / FIELD_W * 100).toFixed(2) + 'vw';
            unit.style.height = (doodle.h * scale / FIELD_W * 100).toFixed(2) + 'vw';
          }
        })();
      }
    }
  }

  // Home page: inject the feature figures into their containers, then reveal
  // each feature row as it scrolls into view.
  var shots = document.querySelectorAll('.feat-shot');
  if (shots.length) {
    var figs = window.HOME_FIGS || {};
    shots.forEach(function (shot) {
      var key = shot.getAttribute('data-fig');
      if (figs[key]) shot.innerHTML = figs[key];
    });
  }
  var rows = Array.prototype.slice.call(document.querySelectorAll('.feat-row'));
  if (rows.length) {
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) entry.target.classList.add('in');
        });
      }, { threshold: 0.45 });
      rows.forEach(function (r) { io.observe(r); });
    } else {
      rows.forEach(function (r) { r.classList.add('in'); });
    }
  }

  // Docs hub search: filter the shared index (docs-data.js) and render results
  // as cards that link into the category subpages.
  var input = document.getElementById('docSearch');
  if (!input) return;

  var index = window.KHUWARI_DOCS || [];
  var results = document.getElementById('searchResults');
  var grid = document.getElementById('catGrid');
  var count = document.getElementById('searchCount');
  var empty = document.getElementById('searchEmpty');

  function render(q) {
    var hits = [];
    if (q) {
      index.forEach(function (item) {
        var hay = (item.title + ' ' + item.text + ' ' + item.cat).toLowerCase();
        if (hay.indexOf(q) !== -1) hits.push(item);
      });
    }

    if (!q) {
      results.classList.add('hidden');
      if (grid) grid.classList.remove('hidden');
      if (empty) empty.classList.add('hidden');
      if (count) count.textContent = '';
      return;
    }

    if (grid) grid.classList.add('hidden');
    if (empty) empty.classList.toggle('hidden', hits.length !== 0);
    if (count) count.textContent = q ? (hits.length + ' of ' + index.length + ' topics') : '';

    results.classList.toggle('hidden', hits.length === 0);
    results.innerHTML = hits.map(function (item) {
      return '<a class="search-hit" href="' + item.url + '#' + item.id + '">' +
        '<span class="search-hit-cat">' + item.cat + '</span>' +
        '<span class="search-hit-title">' + item.title + '</span>' +
        '<span class="search-hit-text">' + item.text + '</span>' +
        '</a>';
    }).join('');
  }

  input.addEventListener('input', function () { render(input.value.trim().toLowerCase()); });

  // "/" focuses the search from anywhere, Escape clears it
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== input) {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (e.key === 'Escape' && document.activeElement === input) {
      input.value = '';
      render('');
      input.blur();
    }
  });
})();
