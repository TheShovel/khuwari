// Paint: parses .kpp / .myb / .gbr / .gih brush files (and their ZIP/PNG wrappers) and loads the bundled brushes.
'use strict';
  // Krita (.kpp) parsing

  function readU16(b, o) { return b[o] | (b[o + 1] << 8); }
  // Little-endian 32-bit (ZIP sizes / field lengths).
  function readU32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  // Big-endian 32-bit (PNG chunk lengths).
  function readU32BE(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

  async function gunzip(u8) {
    var ds = new DecompressionStream('gzip');
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  async function inflateRaw(u8) {
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  // Minimal ZIP reader: walk local file headers, inflate deflated entries.
  function parseZip(u8) {
    var out = {};
    var i = 0;
    while (i + 4 <= u8.length) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x03 && u8[i + 3] === 0x04) {
        var method = readU16(u8, i + 8);
        var compSize = readU32(u8, i + 18);
        var nameLen = readU16(u8, i + 26);
        var extraLen = readU16(u8, i + 28);
        var name = '';
        for (var k = 0; k < nameLen; k++) name += String.fromCharCode(u8[i + 30 + k]);
        var dataStart = i + 30 + nameLen + extraLen;
        var comp = u8.slice(dataStart, dataStart + compSize);
        out[name] = { method: method, data: comp };
        i = dataStart + compSize;
      } else { i++; }
    }
    return out;
  }

  function decodeText(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return decodeURIComponent(escape(s));
  }

  // Binary string (e.g. from atob) -> Uint8Array.
  function stringToU8(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
    return out;
  }

  function loadImageFromBytes(bytes, type) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob([bytes], { type: type || 'image/png' }));
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  // Decode a GIMP .gbr brush into a canvas. Header (big-endian):
  //   header_size u32, version u32, width u32, height u32, bytes u32,
  //   [v2 only] magic u32 + spacing u32, then a name string up to header_size.
  // Pixels start at header_size:
  //   bytes==1 -> grayscale mask (255-v is the alpha, like Krita's ALPHAMASK)
  //   bytes==4 -> straight RGBA
  // The result is a canvas whose alpha is the brush tip (white where opaque).
  function parseGbrBytes(u8) {
    if (u8.length < 20) return null;
    var hs = readU32BE(u8, 0);
    var version = readU32BE(u8, 4);
    var w = readU32BE(u8, 8);
    var h = readU32BE(u8, 12);
    var bytes = readU32BE(u8, 16);
    if (!w || !h || w > 4096 || h > 4096 || hs < 20 || hs > u8.length) return null;
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var g = cv.getContext('2d');
    var img = g.createImageData(w, h);
    var d = img.data;
    var k = hs;
    if (bytes === 1) {
      // Grayscale mask, exactly like Krita (KisGbrBrush): the pixel value is
      // 255 - byte stored as an OPAQUE grayscale image; the red channel is the
      // dab mask (white = opaque). The luminance->alpha conversion in
      // refreshTip then turns this into the actual painted mask.
      for (var i = 0; i < d.length; i += 4, k++) {
        var v = k < u8.length ? u8[k] : 0;
        var val = 255 - v;
        d[i] = d[i + 1] = d[i + 2] = val;
        d[i + 3] = 255;
      }
    } else if (bytes >= 4) {
      for (var j = 0; j < d.length; j += 4, k += 4) {
        if (k + 3 < u8.length) {
          d[j] = u8[k]; d[j + 1] = u8[k + 1]; d[j + 2] = u8[k + 2]; d[j + 3] = u8[k + 3];
        }
      }
    } else {
      return null;
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  // Decode a GIMP .gih image hose: a text header ("name\n<count> ncells:.. dim:..
  // rank0:.. sel0:..\n") followed by that many .gbr brush blocks. We use the
  // first block's texture as the tip (the rest are alternate frames).
  function parseGihBytes(u8) {
    // find the first newline, then the second newline (end of the parasite line)
    var nl1 = -1, nl2 = -1;
    for (var i = 0; i < u8.length && i < 1024; i++) {
      if (u8[i] === 10) { if (nl1 < 0) nl1 = i; else { nl2 = i; break; } }
    }
    if (nl2 < 0) return null;
    // header line 2: "<count> ncells:..."
    var line = '';
    for (var j = nl1 + 1; j < nl2; j++) line += String.fromCharCode(u8[j]);
    var m = /^\s*(\d+)/.exec(line);
    if (!m) return null;
    // the first .gbr block starts right after the second newline
    return parseGbrBytes(u8.slice(nl2 + 1));
  }

  // Fetch a brush tip resource referenced by a .kpp brush_definition
  // (filename="chalk_sparse.png" etc.) from brushes/tips/. Returns a canvas or
  // null if unavailable.
  async function loadBrushTipFile(filename) {
    if (!filename) return null;
    var clean = String(filename).split('/').pop();
    if (!/^[\w.\- ]+$/.test(clean)) return null;
    var r;
    try { r = await fetch('brushes/tips/' + encodeURIComponent(clean)); } catch (e) { return null; }
    if (!r.ok) return null;
    var buf = new Uint8Array(await r.arrayBuffer());
    var lower = clean.toLowerCase();
    if (lower.endsWith('.gbr')) return parseGbrBytes(buf);
    if (lower.endsWith('.gih')) return parseGihBytes(buf);
    // png/svg handled via image load
    try { return await loadImageFromBytes(buf, 'image/png'); } catch (e) { return null; }
  }

  // Krita .kpp files are PNG images: the pixels are Krita's own stroke preview
  // and the preset XML lives in a zTXt chunk (keyword "preset", deflate
  // compressed). Older .kpp variants were gzipped zips; both are handled.
  function isPNG(u8) { return u8.length > 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47; }

  // Walk PNG chunks, returning { type, data } for each. Chunks are
  // length(4) + type(4) + data + crc(4), big-endian length.
  function parsePNGChunks(u8) {
    var out = [];
    var o = 8; // skip PNG signature
    while (o + 8 <= u8.length) {
      var len = readU32BE(u8, o);
      var type = '';
      for (var k = 0; k < 4; k++) type += String.fromCharCode(u8[o + 4 + k]);
      var data = u8.slice(o + 8, o + 8 + len);
      out.push({ type: type, data: data });
      o += 12 + len;
      if (type === 'IEND') break;
    }
    return out;
  }

  // zTXt chunk: keyword\0 + compression-method(1, 0=deflate) + compressed text.
  function inflateZtxt(chunkData) {
    var nul = -1;
    for (var i = 0; i < chunkData.length; i++) { if (chunkData[i] === 0) { nul = i; break; } }
    if (nul < 0) return null;
    var keyword = '';
    for (var j = 0; j < nul; j++) keyword += String.fromCharCode(chunkData[j]);
    var method = chunkData[nul + 1];
    var comp = chunkData.slice(nul + 2);
    return { keyword: keyword, method: method, text: null, compressed: comp };
  }

  // Inflate a zlib-wrapped buffer (PNG zTXt chunks use zlib, not raw deflate).
  async function inflateText(u8) {
    var ds = new DecompressionStream('deflate');
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  // Parse a Krita preset XML (root <Preset paintopid=... name=...> with
  // <param name type><![CDATA[value]]></param> children) into { engine, name, params }.
  function parsePresetXml(text) {
    var out = { engine: 'pixel', name: null, params: {}, hasXml: false };
    if (!text) return out;
    try {
      var xml = new DOMParser().parseFromString(text, 'application/xml');
      var root = xml.documentElement;
      if (!root || root.nodeName !== 'Preset') return out;
      out.hasXml = true;
      out.engine = root.getAttribute('paintopid') || 'pixel';
      out.name = root.getAttribute('name') || null;
      var ps = xml.getElementsByTagName('param');
      for (var i = 0; i < ps.length; i++) {
        var n = ps[i].getAttribute('name');
        if (n) out.params[n.toLowerCase()] = (ps[i].textContent || '').trim();
      }
    } catch (e) {}
    return out;
  }

  // Best-effort numeric parse of a Krita param (may be "true"/"false" or a float).
  function paramNum(v, dflt) {
    var f = parseFloat(v);
    return isFinite(f) ? f : dflt;
  }

  // Return the ordered list of dab-tip filenames referenced by a Krita preset
  // XML. Watercolor / grain pixel brushes keep their brush tip and (optionally)
  // a grain texture as external PNGs in brushes/tips/, referenced by <Brush
  // filename="..."> attributes. The FIRST is the brush SHAPE and any LATER one
  // is the grain/texture overlay. Because our renderer flattens a brush tip and
  // its texture into a single dab mask, the visible dab should be the GRAIN
  // (bristle/spike texture), not the plain round shape — so callers try these
  // in REVERSE order and use the first that actually loads. Returns an array of
  // bare filenames (possibly empty). The pixels are loaded lazily by the caller.
  function kppTipFilenames(xmlText) {
    if (!xmlText) return [];
    var re = /<Brush[^>]*\bfilename="([^"]+\.(?:png|gbr|gih))"/gi;
    var out = [], m;
    while ((m = re.exec(xmlText))) out.push(m[1]);
    return out;
  }

  async function parseKppBytes(name, buf) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser lacks DecompressionStream; cannot read .kpp');
    }
    var presetName = (name || 'krita brush').replace(/\.kpp$/i, '');
    var tipImg = null;
    var tipURL = null;
    var previewImg = null;
    var engine = 'pixel';
    var params = {};
    var parsedXml = false;

    if (isPNG(buf)) {
      // Modern Krita format: PNG + zTXt "preset" chunk.
      var chunks = parsePNGChunks(buf);
      var xmlText = null;
      for (var ci = 0; ci < chunks.length; ci++) {
        var ch = chunks[ci];
        if (ch.type === 'zTXt') {
          var zt = inflateZtxt(ch.data);
          if (zt && zt.keyword === 'preset' && zt.method === 0) {
            try {
              xmlText = decodeText(await inflateText(zt.compressed));
            } catch (e) {}
          }
        }
      }
      var preset = parsePresetXml(xmlText);
      parsedXml = preset.hasXml;
      if (preset.hasXml) {
        engine = preset.engine || 'pixel';
        if (preset.name) presetName = preset.name;
        params = preset.params;
      }
      // The PNG's own pixels are Krita's stroke preview (shown in the brush
      // list, exactly like Krita's presets docker).
      try { previewImg = await loadImageFromBytes(buf, 'image/png'); } catch (e) {}
      // Watercolor/grain brushes store their dab mask as an external PNG in
      // brushes/tips/ (referenced by filename in the preset XML). Load it as the
      // tip so the bristle/grain texture actually renders; without this these
      // brushes silently fell back to a round procedural tip. Missing/unsupported
      // tips degrade to the procedural fallback rather than rejecting the parse.
      if (xmlText) {
        try {
          var _cands = kppTipFilenames(xmlText);
          for (var _ci = _cands.length - 1; _ci >= 0; _ci--) {
            var _base = _cands[_ci].split('/').pop();
            try {
              tipURL = 'brushes/tips/' + encodeURIComponent(_base);
              var _tb = await (await fetch(tipURL)).arrayBuffer();
              tipImg = await loadImageFromBytes(new Uint8Array(_tb), 'image/png');
              break; // first (grain-preferred) that loads wins
            } catch (e) { tipImg = null; }
          }
        } catch (e) {}
      }
    } else {
      // Older format: gzipped zip with XML + PNG entries.
      var data = buf;
      if (buf[0] === 0x1f && buf[1] === 0x8b) data = await gunzip(buf);
      var entries;
      try { entries = parseZip(data); } catch (e) { entries = {}; }
      var xmlText2 = null;
      var pngs = [];
      for (var en in entries) {
        if (en.endsWith('/')) continue;
        var ent = entries[en];
        var lower = en.toLowerCase();
        try {
          if (lower.endsWith('.xml') && !xmlText2) {
            xmlText2 = decodeText(await inflateRaw(ent.data));
          } else if (lower.endsWith('.png') && lower.indexOf('preview') < 0) {
            var raw = ent.method === 0 ? ent.data : await inflateRaw(ent.data);
            pngs.push(raw);
          }
        } catch (e) {}
      }
      var preset2 = parsePresetXml(xmlText2);
      parsedXml = preset2.hasXml;
      if (preset2.hasXml) {
        engine = preset2.engine || 'pixel';
        if (preset2.name) presetName = preset2.name;
        params = preset2.params;
      }
      // Largest embedded PNG as the tip.
      var best = null, bestArea = 0;
      for (var j = 0; j < pngs.length; j++) {
        try {
          var im = await loadImageFromBytes(pngs[j], 'image/png');
          var area = im.width * im.height;
          if (area > bestArea && area >= 16) { bestArea = area; best = im; }
        } catch (e) {}
      }
      tipImg = best;
    }

    // Map Krita params to our brush model. Krita stores "1" as a "use
    // default" sentinel, so only take values that are meaningfully set.
    // The brush_definition's <Brush> attrs carry the real geometry: for
    // auto_brush the tip is procedural with a MaskGenerator diameter; for
    // png/gbr brushes the tip is an external resource we don't ship, so we
    // fall back to the embedded pattern or a procedural tip. Krita's brush
    // size is the DIAMETER in px (KisBrush::width()), so radius = diameter/2.
    var bd = params.brush_definition || '';
    var bdScale = parseFloat((/\bscale="([^"]+)"/.exec(bd) || [])[1] || '');
    if (!isFinite(bdScale) || bdScale <= 0) bdScale = 1;
    var diam = NaN;
    var mg = /<MaskGenerator[^>]*>/.exec(bd);
    if (mg) {
      var dm = /\bdiameter="([^"]+)"/.exec(mg[0]);
      if (dm) diam = parseFloat(dm[1]);
    }
    // SizeValue is also a diameter when a real size is stored ("1" = default).
    var sv = paramNum(params.sizevalue, NaN);
    if (isFinite(sv) && sv > 1) diam = sv;
    if (!isFinite(diam) || diam <= 0) {
      // png/gbr brushes reference an external tip resource we don't ship;
      // 40px is a typical Krita tip width, scaled by the preset's scale attr.
      diam = 40;
    }
    var radius = clamp(diam * bdScale / 2, 0.5, 320);
    var opacity = paramNum(params.opacityvalue, 1);
    if (opacity > 1) opacity = opacity / 100;
    // Flow (watercolour dilution) multiplies the effective opacity.
    var flow = paramNum(params.flowvalue, 1);
    if (flow > 1) flow = flow / 100;
    opacity = clamp(opacity * flow, 0.02, 1);
    // Spacing: fraction of the dab DIAMETER, exactly like Krita's
    // KisPaintOpUtils::effectiveSpacing (spacing = spacingVal * dabWidth).
    // A value > 1 means a deliberately sparse/dotted brush, so allow up to
    // 2 (Krita's spacing slider range).
    var spacing = NaN;
    var bdSp = /\bspacing="([^"]+)"/.exec(bd);
    if (bdSp) spacing = parseFloat(bdSp[1]);
    if (!isFinite(spacing) || spacing <= 0 || spacing > 4) spacing = paramNum(params.spacingvalue, NaN);
    if (!isFinite(spacing) || spacing <= 0.02 || spacing > 4) spacing = 0.15;
    spacing = clamp(spacing, 0.02, 2);
    // Auto-spacing (Krita's "auto" spacing): spacing_px = coeff*sqrt(dabWidth)
    // (calcAutoSpacing), folded into the diameter fraction -> coeff/sqrt(dia).
    var autoSp = (/\buseAutoSpacing="([^"]+)"/.exec(bd) || [])[1];
    if (autoSp === '1') {
      var coeff = parseFloat((/\bautoSpacingCoeff="([^"]+)"/.exec(bd) || [])[1] || '');
      if (!isFinite(coeff) || coeff <= 0) coeff = 1;
      spacing = clamp(coeff / Math.sqrt(diam * bdScale), 0.02, 2);
    }
    // Krita "softness": 0 = hard edge, 1 = very soft ("1" = default -> 0.8).
    var soft = paramNum(params.softnessvalue, NaN);
    var hard = (!isFinite(soft) || soft === 1) ? 0.8 : (1 - clamp(soft, 0, 1));
    hard = clamp(hard, 0.02, 1);
    // auto_brush masks carry their own edge falloff (hfade/vfade on the
    // MaskGenerator: 1 = hard edge, 0 = fully soft). That is the brush's real
    // hardness, so prefer it over the SoftnessValue estimate when present.
    var mg2 = /<MaskGenerator[^>]*>/.exec(bd);
    if (mg2) {
      var hf = parseFloat((/\bhfade="([^"]+)"/.exec(mg2[0]) || [])[1] || '');
      var vf = parseFloat((/\bvfade="([^"]+)"/.exec(mg2[0]) || [])[1] || '');
      if (isFinite(hf) || isFinite(vf)) {
        var fades = 0, fadeN = 0;
        if (isFinite(hf)) { fades += hf; fadeN++; }
        if (isFinite(vf)) { fades += vf; fadeN++; }
        hard = clamp(fades / fadeN, 0.02, 1);
      }
    }
    var rotation = paramNum(params.rotationvalue, NaN);
    if (!isFinite(rotation) || rotation === 1) rotation = 0;
    var eraser = /^true$/i.test(params.erasermode || '') || /^erase$/i.test(params.compositeop || '');

    // Krita option curves (pressure/random dynamics)
    // Each option (Size/Opacity/Flow/Spacing/Rotation/Scatter/Softness) has a
    // base Value, a UseCurve flag, a curveMode (0=multiply,1=add,2=max,3=min,
    // 4=difference), an optional shared commonCurve (useSameCurve), and a
    // Sensor XML listing the ACTIVE sensors as ChildSensor entries, each with
    // its own curve. parsePresetXml lower-cases param names, so look-ups must
    // be lowercase. NOTE: the old code looked up the camelCase param names and
    // therefore parsed NO curves at all - every .kpp dynamic was silently off.
    // Krita decides whether a checkable option is ACTIVE from the
    // "Pressure<Option>" param (KisKritaSensorPack::read: isChecked =
    // setting->getBool("Pressure"+id, false)). Non-checkable options (Opacity,
    // Flow) have no such param -> always active. Without this, presets that
    // store scatter/rotation values but keep the option unchecked (e.g.
    // Basic-5's ScatterValue=5 / RotationValue=1) would wrongly scatter/rotate.
    function kppOn(name) {
      var lname = name.toLowerCase();
      var p = params['pressure' + lname];
      return (p === undefined || p === null) ? true : (p === 'true');
    }
    function parseCurvePts(text) {
      if (!text) return null;
      var pts = text.split(';').map(function (p) {
        var xy = p.split(',');
        return [parseFloat(xy[0]), parseFloat(xy[1])];
      }).filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); });
      return pts.length >= 2 ? pts : null;
    }
    function kppCurve(name) {
      var lname = name.toLowerCase();
      var sensor = params[lname + 'sensor'];
      var common = parseCurvePts(params[lname + 'commoncurve']);
      var out = {
        enabled: params[lname + 'usecurve'] === 'true',
        mode: parseInt(params[lname + 'curvemode'], 10) || 0,
        useSame: params[lname + 'usesamecurve'] === 'true',
        common: common,
        sensors: []
      };
      if (!out.enabled) return out;
      // Collect active ChildSensors (Krita serialises ONLY active sensors).
      var re = /<ChildSensor\b[^>]*\bid="([^"]+)"[^>]*>\s*(?:<curve>([^<]+)<\/curve>)?/g;
      var m;
      if (sensor) {
        while ((m = re.exec(sensor))) {
          out.sensors.push({ id: m[1], pts: parseCurvePts(m[2]) });
        }
        if (!out.sensors.length) {
          var bareId = /<params\s+id="([^"]+)"/.exec(sensor);
          var bareCurve = /<curve>([^<]+)<\/curve>/.exec(sensor);
          if (bareId && bareCurve) out.sensors.push({ id: bareId[1], pts: parseCurvePts(bareCurve[1]) });
        }
      }
      // A "UseCurve" flag with no readable children still counts when a
      // Pressure<Name> companion param (older presets) enables the curve.
      if (!out.sensors.length && (params['pressure' + lname] === 'true' || common)) {
        out.sensors.push({ id: 'pressure', pts: common });
      }
      return out;
    }
    var kpp = {
      sizeCurve: kppCurve('Size'),
      opacityCurve: kppCurve('Opacity'),
      flowCurve: kppCurve('Flow'),
      spacingCurve: kppCurve('Spacing'),
      rotationCurve: kppCurve('Rotation'),
      scatterCurve: kppCurve('Scatter'),
      softnessCurve: kppCurve('Softness'),
      sharpnessCurve: kppCurve('Sharpness'),
      used: {
        size: kppOn('Size'),
        opacity: kppOn('Opacity'),
        flow: kppOn('Flow'),
        spacing: kppOn('Spacing'),
        rotation: kppOn('Rotation'),
        scatter: kppOn('Scatter'),
        softness: kppOn('Softness'),
        sharpness: kppOn('Sharpness')
      }
    };
    // Light-pressure "gate" for textured/hard presets (the WaterC set): a
    // multiply-mode Opacity curve that starts from (near) zero scales the dab
    // opacity toward nothing on light tablet presses, so a normal light stroke
    // paints no visible mark at all. Give such curves a faint, still-visible
    // floor below the gate pressure - the same treatment the MyPaint sketch
    // pencils already get in mypaintDab.
    if (kpp.used.opacity && kpp.opacityCurve && kpp.opacityCurve.enabled && kpp.opacityCurve.mode === 0) {
      var opSens = (kpp.opacityCurve.sensors || []).filter(function (s) { return typeof s.id === 'string' && s.id.indexOf('pressure') === 0; })[0];
      var opPts = opSens && Array.isArray(opSens.pts) ? opSens.pts : null;
      if (opPts && opPts.length >= 2) {
        var opMin = Infinity;
        for (var oi3 = 0; oi3 < opPts.length; oi3++) if (opPts[oi3][1] < opMin) opMin = opPts[oi3][1];
        if (opMin < 0.05) {   // the curve ramps up from (near) zero: pressure-gated
          // gate = the pressure where the curve first becomes visible (crosses
          // 0.15), interpolated along the segment that contains the crossing.
          var oGate = 0;
          for (var oi4 = 1; oi4 < opPts.length; oi4++) {
            var yA = opPts[oi4 - 1][1], yB = opPts[oi4][1];
            if (yB >= 0.15) {
              var xA = opPts[oi4 - 1][0], xB = opPts[oi4][0];
              if (yA >= 0.15) oGate = xA;
              else if (yB - yA > 0) oGate = xA + (xB - xA) * (0.15 - yA) / (yB - yA);
              else oGate = xB;
              break;
            }
          }
          if (isFinite(oGate) && oGate > 0.03 && oGate < 0.95) {
            kpp.opacityGate = oGate;
            kpp.opacityFloor = 0.15;   // faint but clearly visible light-pressure mark
          }
        }
      }
    }
    // Scatter base value + axis (Krita ScatterValue is a distance in px at 100%?)
    var scv = paramNum(params.scattervalue, NaN);
    if (isFinite(scv)) kpp.scatter = scv;
    kpp.scatterAxisX = params['scattering/axisx'] === 'true';
    kpp.scatterAxisY = params['scattering/axisy'] === 'true';

    var brush = makeBrush(presetName, {
      engine: parsedXml ? engine : 'pixel',
      radius: radius, opacity: opacity, spacing: spacing, hardness: hard,
      rotation: rotation, tip: tipImg, tipURL: tipURL, preview: previewImg, eraser: eraser,
      kpp: kpp, color: (current ? current.color : '#1a1a1a')
    });
    brush.builtin = false;
    return brush;
  }

  // Krita brushes bundled with the app: brushes/manifest.json lists every .kpp
  // in the folder (a static site cannot list a directory), so dropping new
  // brushes in and re-running tools/update-brush-manifest.js auto-loads them.
  // Parse a MyPaint (.myb) brush: JSON with a "settings" map, mirroring
  // libmypaint's own math:
  //   radius = e^radius_logarithmic            (base-e; tooltip: 0.7 ~= 2px)
  //   opacity = opaque * opaque_multiply
  //   spacing = count_dabs_to: dabs per px = dabsPerActual/r + dabsPerBasic/baseR
  //   grain   = gauss * offset_by_random * base_radius, radius noise from
  //             radius_by_random, alpha compensation from opaque_linearize
  async function parseMybBytes(name, buf, preview) {
    var brush = makeBrush((name || 'mybrush').replace(/\.myb$/i, ''), {
      engine: 'mypaint', radius: 8, opacity: 1, spacing: 0.2,
      hardness: 0.8, preview: preview || null, color: (current ? current.color : '#1a1a1a')
    });
    var mp = { dabsPerActual: 2, dabsPerBasic: 0, dabsPerSecond: 0, baseRadius: 8,
               grainOffset: 0, radiusByRandom: 0, opaqueLinearize: 0 };
    try {
      var j = JSON.parse(decodeText(buf));
      var s = (j && j.settings) || {};
      var rl = s.radius_logarithmic;
      if (rl && isFinite(+rl.base_value)) {
        // libmypaint: expf(radius_logarithmic), clamped to [0.2, 1000].
        brush.radius = clamp(Math.exp(+rl.base_value), 0.2, 320);
      }
      mp.baseRadius = brush.radius;
      var op = s.opaque, opm = s.opaque_multiply;
      var o = 1;
      if (op && isFinite(+op.base_value)) o = +op.base_value;
      // opaque_multiply with base_value 0 uses a pressure curve (0 at rest,
      // ramping to full on hard press); the stamp loop already applies pointer
      // pressure, so a 0 base means "full opacity under pressure" — don't zero
      // the brush out. Only fold in a positive base value.
      if (opm && isFinite(+opm.base_value) && +opm.base_value > 0.001) o *= +opm.base_value;
      brush.opacity = clamp(o, 0.02, 1);
      // Nominal (designed) opacity of the preset. The opacity SLIDER in the UI
      // drives brush.opacity; mypaintDab scales the faithful dab opacity by
      // brush.opacity / nominalOpacity so the default slider position = the
      // brush's designed look and moving the slider actually changes the paint.
      mp.nominalOpacity = brush.opacity;
      var hd = s.hardness;
      if (hd && isFinite(+hd.base_value)) brush.hardness = clamp(+hd.base_value, 0.02, 1);
      // Anti-aliasing off means a harder, scratchier edge (libmypaint keeps a
      // minimum fadeout of anti_aliasing px; 0 forces a hard edge).
      var aa = s.anti_aliasing;
      if (aa && +aa.base_value === 0) brush.hardness = 1;
      // Dab density: libmypaint count_dabs_to.
      var dpa = s.dabs_per_actual_radius, dpb = s.dabs_per_basic_radius;
      if (dpa && isFinite(+dpa.base_value)) mp.dabsPerActual = +dpa.base_value;
      if (dpb && isFinite(+dpb.base_value)) mp.dabsPerBasic = +dpb.base_value;
      mp.dabsPerActual = clamp(mp.dabsPerActual, 0, 200);
      mp.dabsPerBasic = clamp(mp.dabsPerBasic, 0, 200);
      var dps = s.dabs_per_second;
      if (dps && isFinite(+dps.base_value)) mp.dabsPerSecond = Math.max(0, +dps.base_value);
      mp.dabsPerSecond = clamp(mp.dabsPerSecond, 0, 200);
      // Convert to a Krita-style spacing (fraction of the dab DIAMETER): for a
      // constant-radius brush step = r/(dpa+dpb) px = 1/(2*(dpa+dpb)) of the
      // diameter. Fall back to 25% (libmypaint default dpa=2).
      var total = mp.dabsPerActual + mp.dabsPerBasic;
      brush.spacing = total > 0 ? clamp(1 / (2 * total), 0.02, 2) : 0.25;
      // Grain: gauss * offset_by_random * base_radius (libmypaint
      // prepare_and_draw_dab), radius noise from radius_by_random, and
      // opaque_linearize per-dab alpha compensation.
      var obr = s.offset_by_random;
      if (obr && isFinite(+obr.base_value)) mp.grainOffset = Math.abs(+obr.base_value) * mp.baseRadius;
      var rbr = s.radius_by_random;
      if (rbr && isFinite(+rbr.base_value)) mp.radiusByRandom = Math.abs(+rbr.base_value);
      var ol = s.opaque_linearize;
      if (ol && isFinite(+ol.base_value)) mp.opaqueLinearize = clamp(+ol.base_value, 0, 1);
      // Pressure "gate" detection: presets whose opaque_multiply pressure curve
      // drives base+curve below zero over some pressure range (the sketch
      // pencils are invisible under ~40% pressure) get a faint floor below the
      // gate pressure in mypaintDab, so a light tablet press still leaves a
      // visible mark instead of painting nothing at all.
      var oms = s.opaque, opm = s.opaque_multiply;
      if (oms && opm && opm.inputs && opm.inputs.pressure && Array.isArray(opm.inputs.pressure) && opm.inputs.pressure.length >= 2) {
        var opBase = isFinite(+oms.base_value) ? +oms.base_value : 0;
        var omBase = isFinite(+opm.base_value) ? +opm.base_value : 0;
        var pt0 = opm.inputs.pressure;
        var minY = Infinity;
        for (var pi0 = 0; pi0 < pt0.length; pi0++) if (isFinite(pt0[pi0][1]) && pt0[pi0][1] < minY) minY = pt0[pi0][1];
        if (opBase > 0 && omBase + minY < 0) {
          // the gate is the LOW end of the ramp: everything below the first
          // pressure where base+curve is non-negative paints nothing/faint
          for (var pi1 = 1; pi1 < pt0.length; pi1++) {
            var yPrev = omBase + pt0[pi1 - 1][1], yCur = omBase + pt0[pi1][1];
            if (yCur >= 0) {
              var gateX = pt0[pi1][0];
              if (isFinite(gateX) && gateX > 0.05 && gateX < 0.95) {
                mp.pressureGate = gateX;
                mp.opacityFloor = 0.12; // faint, still-visible light-pressure line
              }
              break;
            }
          }
        }
      }
      brush.mypaint = mp;
      if (j && j.comment) brush.name = (j.comment.match(/^([^,]*)/) || [null, brush.name])[1].trim() || brush.name;
      if (j && j.parent_brush_name) {
        var pn = String(j.parent_brush_name).split('/').pop().replace(/\.myb$/i, '');
        brush.name = pn || brush.name;
      }
    } catch (e) {}
    brush.builtin = false;
    // Keep the raw libmypaint settings (base_value + input curves) so the dab
    // engine can evaluate pressure/speed/random/direction dynamics exactly like
    // libmypaint's mypaint_mapping_calculate (base + Σ curve(input)).
    brush.mySettings = s;
    return brush;
  }

  // Console logging for brush loading, so failures are never silent.
  function brushLog(msg, kind) {
    console.log('[brushes] ' + msg);
  }

  // Fetch + parse every brush file (names from the folder index), appending to
  // the list with per-brush logging. Supports .kpp and .myb; .myb uses its
  // paired _prev.png as the preview.
  function loadBrushFiles(names) {
    var pending = names.length, ok = 0, fail = 0;
    if (!pending) { brushLog('no brush files found', 'error'); return; }
    brushLog('loading ' + pending + ' bundled brushes…');
    names.forEach(function (n) {
      if (typeof n !== 'string' || !/\.(kpp|myb)$/i.test(n)) { pending--; return; }
      fetch('brushes/' + encodeURIComponent(n)).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (ab) {
        var u8 = new Uint8Array(ab);
        if (/\.myb$/i.test(n)) {
          // MyPaint brushes pair with a _prev.png preview in the same folder.
          var prev = n.replace(/\.myb$/i, '') + '_prev.png';
          return fetch('brushes/' + encodeURIComponent(prev)).then(function (pr) {
            return pr.ok ? pr.blob() : null;
          }).catch(function () { return null; }).then(function (blob) {
            if (!blob) return parseMybBytes(n, u8, null);
            var url = URL.createObjectURL(blob);
            return new Promise(function (resolve) {
              var im = new Image();
              im.onload = function () { URL.revokeObjectURL(url); resolve(im); };
              im.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
              im.src = url;
            }).then(function (img) { return parseMybBytes(n, u8, img); });
          });
        }
        return parseKppBytes(n, u8);
      }).then(function (brush) {
        brush.bundled = true; // from the brushes/ folder, always available
        var existing = null;
        for (var i = 0; i < brushList.length; i++) {
          if (brushList[i].name === brush.name) { existing = brushList[i]; break; }
        }
        if (existing) {
          // The built-in default has the same name; upgrade it with the real
          // brush file's visuals (tip texture, preview image) so the watercolor
          // grain and .myb previews come through, and keep the parsed settings
          // in sync with the file.
          if (brush.tip) existing.tip = brush.tip;
          if (brush.preview) existing.preview = brush.preview;
          if (brush.mypaint) existing.mypaint = brush.mypaint;
          if (brush.mySettings) existing.mySettings = brush.mySettings;
          if (brush.kpp) existing.kpp = brush.kpp;
          existing.engine = brush.engine;
          existing.radius = brush.radius;
          existing.opacity = brush.opacity;
          existing.hardness = brush.hardness;
          existing.spacing = brush.spacing;
          existing.rotation = brush.rotation;
          existing.eraser = brush.eraser;
          if (existing === current) refreshTip();
          buildBrushList();
          brushLog('upgraded bundled: ' + brush.name);
        } else {
          brushList.push(brush);
          buildBrushList();
          ok++;
        }
      }).catch(function (err) {
        fail++;
        brushLog('failed ' + n + ': ' + (err && err.message || err), 'error');
      }).then(function () {
        pending--;
        if (pending === 0) {
          var cnt = byId('paintBrushCount');
          if (cnt) cnt.textContent = brushList.length;
          brushLog(ok + ' loaded, ' + fail + ' failed', fail ? 'error' : 'ok');
          bundledLoadState = 2;
        }
      });
    });
  }

  var bundledLoadState = 0; // 0 = not started, 1 = in flight, 2 = done

  // Find bundled brushes. Strategy 1: fetch the folder itself and parse the
  // directory index (python http.server and other autoindex servers list the
  // files as links) — this auto-picks up anything dropped into brushes/ with
  // no regeneration step. Strategy 2: brushes/manifest.json (static hosts).
  function loadBundledBrushes() {
    if (bundledLoadState === 1) return; // already in flight; per-brush upgrade rebuilds the list
    bundledLoadState = 1;
    fetch('brushes/').then(function (r) { return r.text(); }).then(function (html) {
      var names = [];
      var re = /href="([^"]+)"/gi;
      var m;
      while ((m = re.exec(html))) {
        var href = decodeURIComponent(m[1]);
        if (/\.(kpp|myb)$/i.test(href)) names.push(href.split('/').pop());
      }
      if (!names.length) throw new Error('no brush links in directory index');
      brushLog('directory index: ' + names.length + ' brush files');
      loadBrushFiles(names);
    }).catch(function (e) {
      brushLog('directory index failed (' + (e && e.message || e) + '); trying manifest.json', 'error');
      fetch('brushes/manifest.json').then(function (r) {
        if (!r.ok) throw new Error('no manifest');
        return r.json();
      }).then(function (files) {
        if (!Array.isArray(files) || !files.length) throw new Error('empty manifest');
        brushLog('manifest: ' + files.length + ' brush files');
        loadBrushFiles(files);
      }).catch(function (e2) {
        // fetch is blocked when the page is opened straight from disk (file://)
        // or the server hides the folder — say so instead of failing silently.
        brushLog('could not list brushes: ' + (e2 && e2.message || e2) + '. Serve the folder over HTTP (see README) to load bundled brushes.', 'error');
        bundledLoadState = 0; // allow a retry (e.g. when the paint tool reopens)
      });
    });
  }
