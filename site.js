/* Khuwari website helpers: docs search (the hub searches every category
 * through the shared index and links to the subpages). */
(function () {
  'use strict';

  // Home page background doodles: a pool of sketch shapes that keep drawing
  // themselves, like an animator's line test. Every cycle a doodle picks a
  // random shape, glides to a random spot with a random tilt and size, draws
  // it on, holds, un-draws, then picks the next shape somewhere else.
  var doodles = document.querySelector('.bg-doodles');
  if (doodles) {
    var SVG_NS = 'http://www.w3.org/2000/svg';
    var SHAPES = [
      // bouncing ball with its motion arc
      { c: 'd-gold', r: 140, paths: [
        'M -130 40 Q 0 -110 130 40',
        'M -130 40 m -15 0 a 15 15 0 1 0 30 0 a 15 15 0 1 0 -30 0',
        'M -152 58 h 44'
      ]},
      // little creature line test
      { c: 'd-blue', r: 95, paths: [
        'M 0 -135 m -40 0 a 40 40 0 1 0 80 0 a 40 40 0 1 0 -80 0',
        'M -18 -95 q 18 -28 36 0 l -6 38 q -12 10 -24 0 z',
        'M -18 -85 q -24 14 -22 36',
        'M 18 -85 q 24 14 22 36',
        'M -10 -57 q -8 24 -16 38',
        'M 10 -57 q 8 24 16 38',
        'M -12 -120 q 12 10 24 0'
      ]},
      // five-point star
      { c: 'd-gold', r: 100, paths: [
        'M 0 -92 L 22 -30 L 88 -30 L 36 12 L 54 78 L 0 40 L -54 78 L -36 12 L -88 -30 L -22 -30 Z'
      ]},
      // heart
      { c: 'd-sage', r: 90, paths: [
        'M 0 42 C -72 -22 -72 -82 -26 -82 C -8 -82 0 -68 0 -52 C 0 -68 8 -82 26 -82 C 72 -82 72 -22 0 42 Z'
      ]},
      // spiral
      { c: 'd-blue', r: 110, paths: [
        'M 0 0 c 30 -30 70 -20 70 10 c 0 40 -60 60 -90 30 c -40 -35 -25 -90 25 -105 c 60 -20 110 30 90 80'
      ]},
      // crescent moon
      { c: 'd-gold', r: 85, paths: [
        'M 42 -72 A 76 76 0 1 0 42 72 A 56 56 0 1 1 42 -72 Z'
      ]},
      // flower: five petals around a center
      { c: 'd-sage', r: 65, paths: [
        'M 0 -46 m -14 0 a 14 14 0 1 0 28 0 a 14 14 0 1 0 -28 0',
        'M 43 -14 m -14 0 a 14 14 0 1 0 28 0 a 14 14 0 1 0 -28 0',
        'M 27 37 m -14 0 a 14 14 0 1 0 28 0 a 14 14 0 1 0 -28 0',
        'M -27 37 m -14 0 a 14 14 0 1 0 28 0 a 14 14 0 1 0 -28 0',
        'M -43 -14 m -14 0 a 14 14 0 1 0 28 0 a 14 14 0 1 0 -28 0',
        'M 0 0 m -10 0 a 10 10 0 1 0 20 0 a 10 10 0 1 0 -20 0'
      ]},
      // warm-up squiggle
      { c: 'd-sage', r: 90, paths: [
        'M -80 0 c 26 -44 78 -44 78 -6 c 0 34 -50 44 -78 10'
      ]},
      // sine wave
      { c: 'd-blue', r: 130, paths: [
        'M -120 0 q 30 -45 60 0 q 30 45 60 0 q 30 -45 60 0'
      ]},
      // onion skin ghost: a shape and its offset twin
      { c: 'd-blue', r: 110, paths: [
        'M 0 0 m -50 0 a 50 50 0 1 0 100 0 a 50 50 0 1 0 -100 0',
        'M 54 -28 m -50 0 a 50 50 0 1 0 100 0 a 50 50 0 1 0 -100 0'
      ]},
      // curved arrow
      { c: 'd-gold', r: 95, paths: [
        'M -90 60 Q -90 -50 0 -50 Q 60 -50 60 0',
        'M 44 -14 L 62 2 L 44 8'
      ]},
      // diamond
      { c: 'd-sage', r: 90, paths: [
        'M 0 -82 L 62 0 L 0 82 L -62 0 Z'
      ]}
    ];
    function rand(min, max) { return min + Math.random() * (max - min); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    // Spots currently occupied by a drawn doodle: { x, y, r }. New doodles pick
    // a spot clear of every occupied one (with padding), so they never overlap.
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
    function pickSpot(shape, scale) {
      var r = shape.r * scale;
      var minX = r + 24, maxX = 1440 - r - 24;
      var minY = r + 24, maxY = 900 - r - 24;
      var best = null, bestClear = -1;
      for (var t = 0; t < 60; t++) {
        var x = rand(minX, maxX), y = rand(minY, maxY);
        if (clearSpot(x, y, r)) return { x: x, y: y, r: r };
        // Track the candidate with the most breathing room for the fallback.
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
    function makeUnit() {
      var g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'd-unit');
      doodles.appendChild(g);
      return g;
    }
    function buildPaths(unit, shape) {
      unit.innerHTML = '';
      unit.setAttribute('class', 'd-unit ' + shape.c);
      return shape.paths.map(function (d, i) {
        var p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('class', 'd-path');
        p.setAttribute('pathLength', '1');
        p.setAttribute('d', d);
        p.style.transitionDelay = (i * 0.09) + 's';
        p.style.strokeDashoffset = '1';
        unit.appendChild(p);
        return p;
      });
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // A few shapes, fully drawn, still, spread apart.
      for (var s = 0; s < 4; s++) {
        var g0 = makeUnit();
        var sh = SHAPES[(Math.random() * SHAPES.length) | 0];
        buildPaths(g0, sh).forEach(function (p) { p.style.transitionDelay = '0s'; p.style.strokeDashoffset = '0'; });
        var spot = pickSpot(sh, 1);
        placed.push(spot);
        g0.style.transform = 'translate(' + spot.x.toFixed(0) + 'px,' + spot.y.toFixed(0) + 'px) rotate(' + rand(-24, 24).toFixed(1) + 'deg)';
      }
    } else {
      var unitCount = 7;
      for (var u = 0; u < unitCount; u++) {
        let unit = makeUnit();
        // Reserve every starting spot now, synchronously, so the initial layout
        // is already spread out (the glides begin only after all are claimed).
        var s0shape = SHAPES[(Math.random() * SHAPES.length) | 0];
        var s0scale = rand(0.85, 1.35);
        var s0 = pickSpot(s0shape, s0scale);
        placed.push(s0);
        (async function run() {
          var shape = s0shape, scale = s0scale, spot = s0;
          for (;;) {
            var paths = buildPaths(unit, shape);
            unit.dataset.r = String(Math.round(spot.r));
            unit.style.transform =
              'translate(' + spot.x.toFixed(0) + 'px,' + spot.y.toFixed(0) + 'px) ' +
              'rotate(' + rand(-28, 28).toFixed(1) + 'deg) ' +
              'scale(' + scale.toFixed(2) + ')';
            await sleep(1150);           // glide to the spot while hidden
            paths.forEach(function (p) { p.style.strokeDashoffset = '0'; });
            await sleep(900 + (paths.length - 1) * 90 + rand(700, 1300)); // drawn + hold
            paths.forEach(function (p) { p.style.strokeDashoffset = '1'; });
            await sleep(900 + (paths.length - 1) * 90 + 500);             // un-drawn + pause
            // Free the old spot, claim the next one while still hidden, so
            // every spot is held for its whole cycle and picks never collide.
            var idx = placed.indexOf(spot);
            if (idx !== -1) placed.splice(idx, 1);
            shape = SHAPES[(Math.random() * SHAPES.length) | 0];
            scale = rand(0.85, 1.35);
            spot = pickSpot(shape, scale);
            placed.push(spot);
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
