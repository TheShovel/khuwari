'use strict';


  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  // Keep an opened dropdown fully inside the viewport. Menus are absolutely
  // positioned relative to their trigger with `top:100%; right:0` (CSS), so
  // ones near the
  // bottom edge (footer layer/onion menus, a long settings/export menu on a
  // short window) open off-screen. This re-anchors the menu: it still prefers
  // opening below its trigger but shifts up ("clips up") just enough to stay
  // visible, clamps horizontally, and falls back to an internal scroll if it
  // still can't fit vertically.
  function clampMenuToViewport(menu) {
    if (!menu || !menu.parentElement) return;
    var wrap = menu.offsetParent || menu.parentElement; // positioned ancestor
    var wr = wrap.getBoundingClientRect();
    // offsetLeft/offsetTop are the layout position (transforms, like the open
    // animation, don't affect them) and already reflect the menu's CSS anchor
    // (right:0 for the header menus, left:0 for the layer/onion menus), so we
    // keep that anchor and only nudge the menu when it would fall off-screen.
    var vx = wr.left + menu.offsetLeft;
    var vy = wr.top + menu.offsetTop;
    var w = menu.offsetWidth, h = menu.offsetHeight;
    var pad = 8;
    var vw = window.innerWidth, vh = window.innerHeight;
    // Clamp horizontally.
    if (vx < pad) vx = pad;
    if (vx + w > vw - pad) vx = Math.max(pad, vw - pad - w);
    // Clamp vertically: keep the menu where CSS put it when it fits, otherwise
    // pull it up ("clips up") so its bottom edge stays visible.
    if (vy + h > vh - pad) vy = Math.max(pad, vh - pad - h);
    if (vy < pad) vy = pad;
    // If it still can't fit vertically, cap the height and scroll inside.
    if (h > vh - 2 * pad) { menu.style.maxHeight = (vh - 2 * pad) + 'px'; menu.style.overflowY = 'auto'; }
    else { menu.style.maxHeight = ''; menu.style.overflowY = ''; }
    // Convert back to wrap-relative coordinates for the absolute menu.
    menu.style.left = (vx - wr.left) + 'px';
    menu.style.top = (vy - wr.top) + 'px';
    menu.style.right = 'auto';
  }

  // Universal collapsible panels: any element with class `collapsible` whose
  // first child has class `collapsible-title` becomes a smooth folding panel
  // (grid-template-rows animation in CSS). The body must be wrapped in
  // `.collapsible-body > .collapsible-inner`. Only sections the user actually
  // toggles persist their state (via `data-collapse-key` in localStorage);
  // untouched sections keep their HTML `collapsed` class as the default.
  var COLLAPSIBLE_KEY = 'khuwari-collapsed';

  function collapsibleSaved() {
    try { var v = JSON.parse(localStorage.getItem(COLLAPSIBLE_KEY) || 'null'); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
  }

  // Wire every collapsible inside `root` (default: the whole document). Calling
  // it again for a subtree is safe (sections are marked once).
  function initCollapsibles(root) {
    root = root || document;
    var saved = collapsibleSaved();
    var titles = root.querySelectorAll('.collapsible > .collapsible-title');
    Array.prototype.forEach.call(titles, function (title) {
      if (title.getAttribute('data-collapsible-wired')) return;
      title.setAttribute('data-collapsible-wired', '1');
      var sec = title.parentElement;
      var key = sec.getAttribute('data-collapse-key') || '';
      // Apply the persisted state for sections the user has toggled; keep the
      // HTML default (e.g. Camera/Audio start collapsed) for everything else.
      if (key && saved !== null && saved[key] !== undefined) sec.classList.toggle('collapsed', !!saved[key]);
      title.addEventListener('click', function (e) {
        e.preventDefault();
        toggleCollapsible(sec);
      });
    });
  }

  function toggleCollapsible(sec) {
    sec.classList.toggle('collapsed');
    var key = sec.getAttribute('data-collapse-key') || '';
    if (!key) return;
    var saved = collapsibleSaved() || {};
    saved[key] = sec.classList.contains('collapsed');
    try { localStorage.setItem(COLLAPSIBLE_KEY, JSON.stringify(saved)); } catch (e) {}
  }
  // Largest the timeline can be dragged to: leave room for the toolbar plus a
  // usable preview above it.
  function maxTimelineHeight() {
    var toolbarH = 48;
    var bar = document.querySelector('.toolbar');
    if (bar && bar.offsetHeight) toolbarH = bar.offsetHeight;
    return Math.max(TL_H_MIN + 10, window.innerHeight - toolbarH - 140);
  }
  // Largest a side panel can be dragged to: keep at least half the stage width
  // for the preview and the other panel.
  function maxSideWidth() {
    return Math.max(SIDE_W_MIN + 10, Math.floor(window.innerWidth * 0.4));
  }
  function fmtTime(t) { return (Math.round(t * 100) / 100).toFixed(2) + 's'; }
  // Format a manual aspect ratio back into the text field (e.g. 1.77777 → 1.78).
  function fmtRatio(r) { return String(Math.round(r * 100) / 100); }
  // Ruler/other labels: strip float noise like 0.35000000000000003.
  function fmtNum(n) {
    var r = Math.round(n * 100) / 100;
    return String(r);
  }

  function hashStr(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.add('hidden'); }, ms || 3200);
  }

  function loadImage(src) {
    if (imgCache.has(src)) return Promise.resolve(imgCache.get(src));
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { imgCache.set(src, img); resolve(img); };
      img.onerror = function () { reject(new Error('Could not decode image')); };
      img.src = src;
    });
  }

  // Decode every layer's playback images into the cache ahead of the playhead,
  // so the first appearance of a composite is instant instead of a black flash.
  // Concurrency is capped so we don't hammer the decoder with one giant burst.
  var playbackPreload = null;
  function preloadPlaybackFrames() {
    var srcs = [];
    var seen = {};
    state.keyframes.forEach(function (k) {
      if (k.img && !seen[k.img]) { seen[k.img] = true; srcs.push(k.img); }
    });
    state.layers.forEach(function (L) {
      computeGaps(L.id).forEach(function (g) {
        (state.generated[g.id] || []).forEach(function (f) {
          if (f.img && !seen[f.img]) { seen[f.img] = true; srcs.push(f.img); }
        });
      });
    });
    var idx = 0;
    function worker() {
      if (idx >= srcs.length) return Promise.resolve();
      var src = srcs[idx++];
      return loadImage(src).catch(function () {}).then(worker);
    }
    var workers = [];
    var n = Math.min(8, srcs.length);
    for (var i = 0; i < n; i++) workers.push(worker());
    playbackPreload = Promise.all(workers);
    return playbackPreload;
  }

  function drawContain(ctx, img, w, h) {
    var scale = Math.min(w / img.width, h / img.height);
    var dw = img.width * scale, dh = img.height * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  function downloadBlob(data, filename, type) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error(message)); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  // Native number-input spinners look different in Chromium vs Firefox (and
  // clash with the theme). This wraps every <input type="number"> in a custom
  // stepper (two chevron buttons) that reuses the input's own min/max/step and
  // reports through its native input/change events, so existing listeners keep
  // working. Called once at boot; safe to call again on new subtrees.
  function wireNumberSteppers(root) {
    root = root || document;
    var inputs = root.querySelectorAll('input[type="number"]');
    Array.prototype.forEach.call(inputs, function (inp) {
      if (inp.parentElement && inp.parentElement.classList.contains('num-stepper')) return;
      var wrap = document.createElement('span');
      wrap.className = 'num-stepper';
      var up = document.createElement('button');
      up.type = 'button';
      up.className = 'num-stepper-btn num-stepper-up';
      up.title = 'Increase value';
      up.setAttribute('aria-label', up.title);
      var dn = document.createElement('button');
      dn.type = 'button';
      dn.className = 'num-stepper-btn num-stepper-down';
      dn.title = 'Decrease value';
      dn.setAttribute('aria-label', dn.title);
      function step(dir) {
        try { if (dir > 0) inp.stepUp(); else inp.stepDown(); } catch (e) {}
        // Replicate the native spinner's event sequence: listeners redraw off
        // these (dot timing, layer opacity, fps, resize fields).
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); }
      }
      // Clicking steps once; holding the pointer down for a beat starts
      // auto-repeating (ramping up a little so long runs feel smooth).
      // Releasing before the delay still counts as a single click.
      function wireStepperHold(btn, dir) {
        var HOLD_MS = 550, FIRST_MS = 100, FAST_MS = 55;
        var holdTimer = null, rep = null, ticks = 0;
        function stop() {
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
          if (rep) { clearInterval(rep); rep = null; }
          btn.removeEventListener('pointerup', stop);
          btn.removeEventListener('pointercancel', stop);
          btn.removeEventListener('lostpointercapture', stop);
        }
        function tick() {
          step(dir);
          if (++ticks === 12) { clearInterval(rep); rep = setInterval(tick, FAST_MS); }
        }
        btn.addEventListener('pointerdown', function (e) {
          if (e.button !== 0) return;
          e.preventDefault();
          stop();
          step(dir);
          holdTimer = setTimeout(function () {
            holdTimer = null;
            ticks = 0;
            rep = setInterval(tick, FIRST_MS);
          }, HOLD_MS);
          // Keep receiving pointerup/cancel even when the cursor leaves the
          // button mid-hold.
          try { btn.setPointerCapture(e.pointerId); } catch (err) {}
          btn.addEventListener('pointerup', stop);
          btn.addEventListener('pointercancel', stop);
          btn.addEventListener('lostpointercapture', stop);
        });
        // Keyboard activation (Enter/Space) fires a click with detail 0.
        btn.addEventListener('click', function (e) {
          if (e.detail === 0) step(dir);
        });
      }
      wireStepperHold(up, 1);
      wireStepperHold(dn, -1);
      inp.parentElement.insertBefore(wrap, inp);
      wrap.appendChild(inp);
      wrap.appendChild(up);
      wrap.appendChild(dn);
    });
  }
