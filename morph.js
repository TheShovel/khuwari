/* morph.js: pure-JS image morphing engine (no ML model, no GPU, no network).
 *
 * Interpolates between two keyframe images by:
 *   1. estimating dense optical flow A->B and B->A (coarse-to-fine block matching
 *      on a Gaussian pyramid, with median smoothing to clean flat regions), plus
 *      an occlusion completion pass (repairFlow),
 *   2. sampling that flow onto a coarse vertex mesh (bilinear per vertex), so the
 *      warp behaves like deforming a mesh: nearby pixels always move coherently
 *      and per-pixel strays/tearing are impossible,
 *   3. for each intermediate time t, deforming A forward and B backward along the
 *      mesh flow and cross-dissolving the two deformations (a classic morph: both
 *      sides render the same intermediate shape, so the dissolve is invisible),
 *      with holes (content revealed between the keyframes) filled from B.
 *
 * Everything runs on the CPU with typed arrays; a gap's flow is computed once,
 * then every frame is a cheap warp+blend. Some frames can additionally use the
 * built-in recognition/synthesis pass: it segments coherent foreground regions,
 * cleans mask islands/holes, then regenerates that inbetween from the warped
 * endpoints. Deterministic and fully offline.
 */
(typeof self !== 'undefined' ? self : window).KHUWARI_MORPH = (function () {
  'use strict';

  // Image helpers (single-channel Float32Array luma)

  // Premultiply luma by alpha so transparent pixels (e.g. a cut-out character)
  // don't drag the optical flow around with invisible content; for fully opaque
  // frames this is identical to the plain luma.
  function grayscale(rgba, w, h) {
    var n = w * h;
    var out = new Float32Array(n);
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      var lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      out[p] = lum * (rgba[i + 3] / 255);
    }
    return out;
  }

  // ---- model-driven alpha (opacity interpolation) ----
  // There is no dedicated ONNX model for interpolating alpha; the practical
  // equivalent is to run the SAME interpolation model on the alpha channel
  // rendered as a grayscale image (white = opaque, black = transparent). The
  // model's dense flow handles a moving silhouette the same way it handles a
  // moving object, giving motion-aware, smooth opacity instead of the mesh warp.
  // The RGB pass runs on the matte; the alpha pass runs on these grays.
  function alphaToGray(rgba, w, h) {
    var n = w * h;
    var out = new Uint8ClampedArray(n * 4);
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      var a = rgba[i + 3];
      out[i] = a; out[i + 1] = a; out[i + 2] = a; out[i + 3] = 255;
    }
    return out;
  }

  // Stamp the model's interpolated alpha (from alphaToGray output) onto a matte
  // frame: alpha = model output gray, and the key tint is removed from the RGB
  // using that alpha (E = C·a + K·(1−a) → C·a = E − K·(1−a)).
  function applyGrayAlpha(frame, alphaOut, n, K) {
    var k0 = K[0], k1 = K[1], k2 = K[2];
    for (var p = 0, q = 0; p < n; p++, q += 4) {
      var a = alphaOut[q] / 255;
      var inv = 1 - a;
      frame[q] = frame[q] - k0 * inv;
      frame[q + 1] = frame[q + 1] - k1 * inv;
      frame[q + 2] = frame[q + 2] - k2 * inv;
      frame[q + 3] = Math.round(a * 255);
    }
    return frame;
  }

  // Same as applyGrayAlpha but reads the model's RAW [1,3,H,W] float output
  // (r=g=b planes for a gray input) instead of a converted RGBA buffer; this skips
  // the intermediate per-channel conversion of the alpha pass entirely. The
  // current RGBA path also only ever reads the R channel, so this is
  // byte-identical. `tensor` is the raw Float32Array output data.
  function applyGrayAlphaRaw(frame, tensor, n, K) {
    var k0 = K[0], k1 = K[1], k2 = K[2];
    var t = tensor.subarray ? tensor.subarray(0, n) : tensor.slice(0, n);
    for (var p = 0, q = 0; p < n; p++, q += 4) {
      var a = t[p];
      if (a < 0) a = 0; else if (a > 1) a = 1;
      // Round to 8-bit FIRST and derive the strip factor from the rounded
      // value: identical to the RGBA path (which rounds in the tensor→RGBA
      // conversion, then divides by 255) so output is byte-for-byte the same.
      var a8 = Math.round(a * 255);
      var inv = 1 - a8 / 255;
      frame[q] = frame[q] - k0 * inv;
      frame[q + 1] = frame[q + 1] - k1 * inv;
      frame[q + 2] = frame[q + 2] - k2 * inv;
      frame[q + 3] = a8;
    }
    return frame;
  }

  // Separable box blur (edges clamped). radius 1 -> 3x3, radius 2 -> 5x5.
  function boxBlur(src, dst, w, h, radius) {
    var n = w * h;
    var tmp = new Float32Array(n);
    var r = radius | 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var sum = 0, count = 0;
        for (var k = -r; k <= r; k++) {
          var xx = x + k;
          if (xx < 0) xx = 0;
          if (xx >= w) xx = w - 1;
          sum += src[y * w + xx];
          count++;
        }
        tmp[y * w + x] = sum / count;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var sum2 = 0, count2 = 0;
        for (k = -r; k <= r; k++) {
          var yy = y + k;
          if (yy < 0) yy = 0;
          if (yy >= h) yy = h - 1;
          sum2 += tmp[yy * w + x];
          count2++;
        }
        dst[y * w + x] = sum2 / count2;
      }
    }
  }

  function buildPyramid(gray, w, h, maxLevels) {
    var levels = [{ data: gray, w: w, h: h }];
    var cw = w, ch = h;
    while (levels.length < maxLevels && cw > 16 && ch > 16) {
      var src = levels[levels.length - 1];
      var blurred = new Float32Array(src.data.length);
      boxBlur(src.data, blurred, cw, ch, 1);
      var nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1);
      var down = new Float32Array(nw * nh);
      for (var y = 0; y < nh; y++) {
        for (var x = 0; x < nw; x++) {
          down[y * nw + x] = blurred[(2 * y) * cw + 2 * x];
        }
      }
      levels.push({ data: down, w: nw, h: nh });
      cw = nw;
      ch = nh;
    }
    return levels;
  }

  // Background color for the flow input: opposite of the content's mean luma,
  // so thin dark line art stands out on white (or bright art on black). This is
  // only for optical-flow estimation, never for rendering.
  function flowBgColor(a, b, n) {
    var sum = 0, cnt = 0;
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      if (a[i + 3] > 0 || b[i + 3] > 0) {
        sum += (a[i] + a[i + 1] + a[i + 2] + b[i] + b[i + 1] + b[i + 2]) / 6;
        cnt++;
      }
    }
    return cnt && sum / cnt > 128 ? [0, 0, 0] : [255, 255, 255];
  }

  // Extend a cut-out's pixels outward so the optical flow has texture to track.
  // Thin line art (or a character on a uniform/transparent background) gives
  // block matching nothing to lock onto at coarse pyramid levels, so the flow
  // comes back ~0 and the morph degenerates into a double-exposed crossfade.
  // Transparent pixels within `r` of the character copy the nearest opaque
  // pixel's color (Manhattan distance transform, O(n)); everything farther away
  // is painted the key color K, which is chosen to be rare in the content, so
  // the character keeps high contrast against its surroundings. The result is a
  // solid, textured, opaque blob the flow can track. Only the flow input is
  // extended; rendering still uses the real (thin) frames.
  function extendTexture(rgba, w, h, r, K) {
    var n = w * h;
    var out = new Uint8ClampedArray(rgba);
    var src = new Int32Array(n);      // packed y*w+x of the best opaque source
    var dist = new Int32Array(n);
    var INF = 1 << 28;
    var y, x, p;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        p = y * w + x;
        if (rgba[p * 4 + 3] > 0) { src[p] = p; dist[p] = 0; }
        else { src[p] = -1; dist[p] = INF; }
      }
    }
    // Forward sweep (top-left).
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        p = y * w + x;
        if (y > 0) {
          var up = p - w;
          if (dist[up] + 1 < dist[p]) { dist[p] = dist[up] + 1; src[p] = src[up]; }
        }
        if (x > 0) {
          var lf = p - 1;
          if (dist[lf] + 1 < dist[p]) { dist[p] = dist[lf] + 1; src[p] = src[lf]; }
        }
      }
    }
    // Backward sweep (bottom-right).
    for (y = h - 1; y >= 0; y--) {
      for (x = w - 1; x >= 0; x--) {
        p = y * w + x;
        if (y < h - 1) {
          var dn = p + w;
          if (dist[dn] + 1 < dist[p]) { dist[p] = dist[dn] + 1; src[p] = src[dn]; }
        }
        if (x < w - 1) {
          var rt = p + 1;
          if (dist[rt] + 1 < dist[p]) { dist[p] = dist[rt] + 1; src[p] = src[rt]; }
        }
      }
    }
    var k0 = K ? K[0] : 0, k1 = K ? K[1] : 0, k2 = K ? K[2] : 0;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        p = y * w + x;
        var q = (src[p] >= 0 && dist[p] <= r) ? src[p] * 4 : -1;
        if (q >= 0) {
          out[p * 4] = rgba[q];
          out[p * 4 + 1] = rgba[q + 1];
          out[p * 4 + 2] = rgba[q + 2];
        } else {
          out[p * 4] = k0;
          out[p * 4 + 1] = k1;
          out[p * 4 + 2] = k2;
        }
        out[p * 4 + 3] = 255;
      }
    }
    return out;
  }

  function bilinearField(field, pw, ph, fx, fy) {
    if (fx < 0) fx = 0; else if (fx > pw - 1) fx = pw - 1;
    if (fy < 0) fy = 0; else if (fy > ph - 1) fy = ph - 1;
    var x0 = fx | 0, y0 = fy | 0;
    var x1 = x0 < pw - 1 ? x0 + 1 : x0;
    var y1 = y0 < ph - 1 ? y0 + 1 : y0;
    var ax = fx - x0, ay = fy - y0;
    var i00 = y0 * pw + x0, i01 = y0 * pw + x1, i10 = y1 * pw + x0, i11 = y1 * pw + x1;
    return field[i00] * (1 - ax) * (1 - ay) + field[i01] * ax * (1 - ay) +
           field[i10] * (1 - ax) * ay + field[i11] * ax * ay;
  }

  // Bilinear flow upsampling between pyramid levels (smoother than nearest).
  function upsampleFlow(u, v, pw, ph, nw, nh) {
    var scaleX = nw / pw, scaleY = nh / ph;
    var outU = new Float32Array(nw * nh);
    var outV = new Float32Array(nw * nh);
    for (var y = 0; y < nh; y++) {
      for (var x = 0; x < nw; x++) {
        var q = y * nw + x;
        outU[q] = bilinearField(u, pw, ph, x / scaleX, y / scaleY) * scaleX;
        outV[q] = bilinearField(v, pw, ph, x / scaleX, y / scaleY) * scaleY;
      }
    }
    return { u: outU, v: outV };
  }

  // Edge-aware flow smoothing: median of the flow among neighbours whose image
  // intensity is close to the centre pixel's. Cleans flat regions (noise) while
  // keeping object boundaries sharp in the flow field.
  function edgeAwareMedian(u, v, gray, w, h, r, colorThresh) {
    var n = w * h;
    var ou = new Float32Array(n);
    var ov = new Float32Array(n);
    var win = (2 * r + 1) * (2 * r + 1);
    var us = new Float64Array(win);
    var vs = new Float64Array(win);
    var i, j, len, dy, dx;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var p = y * w + x;
        var gc = gray[p];
        len = 0;
        var fU = 0, fV = 0, allSame = true;
        // Same window as the original: every dy/dx in [-r, r] with each step
        // clamped, so border rows/cols contribute duplicates exactly like the
        // old median window.
        for (dy = -r; dy <= r; dy++) {
          var yy = y + dy;
          if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
          var row = yy * w;
          for (dx = -r; dx <= r; dx++) {
            var xx = x + dx;
            if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
            var q = row + xx;
            if (Math.abs(gray[q] - gc) <= colorThresh) {
              var uv = u[q];
              var vv = v[q];
              if (!len) { fU = uv; fV = vv; }
              else if (uv !== fU || vv !== fV) allSame = false;
              us[len] = uv;
              vs[len] = vv;
              len++;
            }
          }
        }
        if (!len) { ou[p] = u[p]; ov[p] = v[p]; continue; }
        // Uniform window (static background, flat interiors): the median is the
        // value itself, so skip the sort entirely. Otherwise insertion sort: the
        // window overlaps almost fully between adjacent pixels, so the values
        // are nearly sorted and insertion sort beats Array#sort (no comparator
        // callbacks, no garbage) with the same median.
        if (allSame) { ou[p] = fU; ov[p] = fV; continue; }
        for (i = 1; i < len; i++) {
          var uu = us[i]; j = i - 1;
          while (j >= 0 && us[j] > uu) { us[j + 1] = us[j]; j--; }
          us[j + 1] = uu;
          var vv2 = vs[i]; j = i - 1;
          while (j >= 0 && vs[j] > vv2) { vs[j + 1] = vs[j]; j--; }
          vs[j + 1] = vv2;
        }
        ou[p] = us[len >> 1];
        ov[p] = vs[len >> 1];
      }
    }
    return { u: ou, v: ov };
  }

  // Bidirectional flow completion: where the two flows disagree (occlusions),
  // re-point the flow using the opposite side's estimate.
  function repairFlow(flowAB, flowBA, width, height, thresh) {
    var uAB = flowAB.u, vAB = flowAB.v;
    var uBA = flowBA.u, vBA = flowBA.v;
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var p = y * width + x;
        var ux = uAB[p], vy = vAB[p];
        var lx = Math.round(x + ux), ly = Math.round(y + vy);
        if (lx < 0) lx = 0; else if (lx >= width) lx = width - 1;
        if (ly < 0) ly = 0; else if (ly >= height) ly = height - 1;
        var q = ly * width + lx;
        var err = Math.abs(ux + uBA[q]) + Math.abs(vy + vBA[q]);
        if (err > thresh) {
          uAB[p] = -uBA[q];
          vAB[p] = -vBA[q];
        }
      }
    }
  }

  // Dense flow via coarse-to-fine block matching

  // Dense flow via coarse-to-fine block matching. The source patch around
  // (x,y) is gathered once per pixel (row-major, matching the old per-offset
  // loops exactly), then each candidate offset walks it skipping out-of-bounds
  // targets. Same arithmetic order as before, so results are identical, but
  // no per-offset function calls and no patch re-gathering.
  function blockMatch(a, b, wa, ha, uIn, vIn, searchR, patchR, isCancelled) {
    var n = wa * ha;
    var u = new Float32Array(n);
    var v = new Float32Array(n);
    var checkEvery = Math.max(1, Math.floor(n / 50000));
    var pr = patchR;
    var win = (2 * pr + 1) * (2 * pr + 1);
    var srcX = new Int32Array(win);
    var srcY = new Int32Array(win);
    var sr = new Float32Array(win);
    for (var y = 0; y < ha; y++) {
      var sy0 = y - pr; if (sy0 < 0) sy0 = 0;
      var sy1 = y + pr; if (sy1 >= ha) sy1 = ha - 1;
      for (var x = 0; x < wa; x++) {
        var p = y * wa + x;
        if (isCancelled && p % checkEvery === 0 && isCancelled()) throw new Error('Cancelled');
        var sx0 = x - pr; if (sx0 < 0) sx0 = 0;
        var sx1 = x + pr; if (sx1 >= wa) sx1 = wa - 1;
        var centre = a[p];
        var len = 0, tsum = 0;
        for (var dy = sy0; dy <= sy1; dy++) {
          for (var dx = sx0; dx <= sx1; dx++) {
            var q = dy * wa + dx;
            sr[len] = a[q];
            srcX[len] = dx;
            srcY[len] = dy;
            tsum += Math.abs(a[q] - centre);
            len++;
          }
        }
        var cu = uIn ? uIn[p] : 0;
        var cv = vIn ? vIn[p] : 0;
        // Flat patches carry no motion information: keep the propagated estimate
        // instead of letting noise push the flow around (this is what keeps
        // flat backgrounds clean and stops flow bleeding from moving objects).
        if (tsum < 6 * len) {
          u[p] = cu;
          v[p] = cv;
          continue;
        }
        // Start from the current estimate so ties in flat regions keep it
        // (otherwise every refinement pass drifts toward the first candidate).
        // Candidate order matches the original: the (0,0) estimate is evaluated
        // first, then every offset in scan order; strict < keeps the first
        // (earliest) minimum on ties, so results are identical.
        var k, offx, offy, sum, cnt, d, s, ty, tx;
        offx = cu; offy = cv;
        sum = 0; cnt = 0;
        for (k = 0; k < len; k++) {
          ty = srcY[k] + offy; tx = srcX[k] + offx;
          if (ty < 0 || ty >= ha || tx < 0 || tx >= wa) continue;
          d = sr[k] - b[ty * wa + tx];
          sum += d * d;
          cnt++;
        }
        var best = cnt ? sum / cnt : Infinity;
        var bu = cu, bv = cv;
        for (var oy = -searchR; oy <= searchR; oy++) {
          for (var ox = -searchR; ox <= searchR; ox++) {
            if (ox === 0 && oy === 0) continue;
            offx = cu + ox; offy = cv + oy;
            sum = 0; cnt = 0;
            for (k = 0; k < len; k++) {
              ty = srcY[k] + offy; tx = srcX[k] + offx;
              if (ty < 0 || ty >= ha || tx < 0 || tx >= wa) continue;
              d = sr[k] - b[ty * wa + tx];
              sum += d * d;
              cnt++;
            }
            s = cnt ? sum / cnt : Infinity;
            if (s < best) { best = s; bu = cu + ox; bv = cv + oy; }
          }
        }
        u[p] = bu;
        v[p] = bv;
      }
    }
    return { u: u, v: v };
  }

  function medianFilter(field, w, h, r) {
    var out = new Float32Array(field.length);
    var vals = [];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        vals.length = 0;
        for (var dy = -r; dy <= r; dy++) {
          var yy = y + dy;
          if (yy < 0) yy = 0;
          if (yy >= h) yy = h - 1;
          for (var dx = -r; dx <= r; dx++) {
            var xx = x + dx;
            if (xx < 0) xx = 0;
            if (xx >= w) xx = w - 1;
            vals.push(field[yy * w + xx]);
          }
        }
        vals.sort(function (a, b) { return a - b; });
        out[y * w + x] = vals[vals.length >> 1];
      }
    }
    return out;
  }

  // Flow A->B: u,v such that A(x,y) ≈ B(x+u, y+v).
  function computeFlow(rgbaA, rgbaB, width, height, opts, onStep, isCancelled) {
    return computeFlowGray(grayscale(rgbaA, width, height), grayscale(rgbaB, width, height), width, height, opts, onStep, isCancelled);
  }

  // Same as computeFlow, but takes precomputed grayscale luma so callers that
  // need both directions (computeFlowBoth) only convert each image once.
  function computeFlowGray(grayA0, grayB0, width, height, opts, onStep, isCancelled) {
    opts = opts || {};
    var maxLevels = opts.maxLevels || 5;
    return computeFlowGrayLevels(
      buildPyramid(grayA0, width, height, maxLevels),
      buildPyramid(grayB0, width, height, maxLevels),
      opts, onStep, isCancelled
    );
  }

  // Level-walking core of computeFlowGray, given prebuilt pyramids. Both
  // directions of a flow pair build the SAME two pyramids (swapped), so
  // computeFlowBoth builds them once and reuses them here: identical output,
  // two fewer pyramid builds per pair.
  function computeFlowGrayLevels(levelsA, levelsB, opts, onStep, isCancelled) {
    opts = opts || {};
    var maxSearchR = opts.maxSearchR || 4;
    var levels = levelsA.length;
    var u = null, v = null;

    var chain = Promise.resolve();
    for (var L = levels - 1; L >= 0; L--) {
      (function (level) {
        chain = chain.then(function () {
          if (isCancelled && isCancelled()) throw new Error('Cancelled');
          var wa = levelsA[level].w, ha = levelsA[level].h;
          if (u) {
            var up = upsampleFlow(u, v, levelsA[level + 1].w, levelsA[level + 1].h, wa, ha);
            u = up.u;
            v = up.v;
          }
          // Small patches at every level: coarse levels are small enough that
          // object interiors get median-filled there, while small patches keep
          // the flow from dilating into flat backgrounds. The coarsest level
          // searches a wider radius so large keyframe-to-keyframe motion is
          // caught; finer levels refine within ±1.
          var patchR = 1;
          var searchR = level === levels - 1 ? maxSearchR : 2;
          var matched = blockMatch(levelsA[level].data, levelsB[level].data, wa, ha, u, v, searchR, patchR, isCancelled);
          // Edge-aware smoothing (radius 2) fills flat object interiors from
          // their edges while keeping flat backgrounds still, then refine.
          var smoothed = edgeAwareMedian(matched.u, matched.v, levelsA[level].data, wa, ha, 2, 24);
          var refined = blockMatch(levelsA[level].data, levelsB[level].data, wa, ha, smoothed.u, smoothed.v, 1, patchR, isCancelled);
          var final = edgeAwareMedian(refined.u, refined.v, levelsA[level].data, wa, ha, 2, 24);
          u = final.u;
          v = final.v;
          if (onStep) onStep((levels - level) / levels, 'flow level ' + (level + 1) + '/' + levels);
        });
      })(L);
    }
    return chain.then(function () {
      return { u: u, v: v };
    });
  }

  // Both directions + mutual repair. Returns { flowAB, flowBA, flowBARaw }.
  function computeFlowBoth(rgbaA, rgbaB, width, height, opts, onStep, isCancelled) {
    opts = opts || {};
    var maxLevels = opts.maxLevels || 5;
    var grayA = grayscale(rgbaA, width, height);
    var grayB = grayscale(rgbaB, width, height);
    // Pyramids are identical for both directions (just swapped), so build once.
    var levelsA = buildPyramid(grayA, width, height, maxLevels);
    var levelsB = buildPyramid(grayB, width, height, maxLevels);
    return computeFlowGrayLevels(levelsA, levelsB, opts, function (frac, label) {
      if (onStep) onStep(frac * 0.45, label);
    }, isCancelled).then(function (ab) {
      return computeFlowGrayLevels(levelsB, levelsA, opts, function (frac, label) {
        if (onStep) onStep(0.45 + frac * 0.45, label);
      }, isCancelled).then(function (ba) {
        if (isCancelled && isCancelled()) throw new Error('Cancelled');
        // Smooth the raw flows first, THEN repair. (Running the median after the
        // repair wiped the occlusion completion: at an object's top/bottom edge
        // the median window mixes in background rows where the completion hasn't
        // reached yet, outvoting it and punching holes in the completed band.)
        // Several passes propagate boundary motion into flat interiors (block
        // matching can't measure motion inside uniform regions; the intensity
        // gate keeps stroke/object edges sharp between passes).
        var abS = ab, baS = ba;
        for (var pass = 0; pass < 3; pass++) {
          abS = edgeAwareMedian(abS.u, abS.v, grayA, width, height, 3, 24);
          baS = edgeAwareMedian(baS.u, baS.v, grayB, width, height, 3, 24);
        }
        // Keep an un-repaired copy of B->A (smoothed like the final flows). The
        // render's hole-fill wants B's content at rest where A's warp doesn't
        // cover (revealed background), and the repair's fictional motion would
        // shift it.
        var baRaw = { u: new Float32Array(baS.u), v: new Float32Array(baS.v) };
        repairFlow(abS, baS, width, height, opts.repairThreshold || 3);
        repairFlow(baS, abS, width, height, opts.repairThreshold || 3);
        if (onStep) onStep(1, 'refining');
        return { flowAB: abS, flowBA: baS, flowBARaw: baRaw };
      });
    });
  }

  function bilinearSampleRGBA(src, w, h, fx, fy) {
    if (fx < 0) fx = 0; else if (fx > w - 1) fx = w - 1;
    if (fy < 0) fy = 0; else if (fy > h - 1) fy = h - 1;
    var x0 = fx | 0, y0 = fy | 0;
    var x1 = x0 < w - 1 ? x0 + 1 : x0;
    var y1 = y0 < h - 1 ? y0 + 1 : y0;
    var ax = fx - x0, ay = fy - y0;
    var i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4;
    var i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
    var out = [0, 0, 0, 0];
    for (var c = 0; c < 4; c++) {
      var v0 = src[i00 + c] * (1 - ax) * (1 - ay) + src[i01 + c] * ax * (1 - ay);
      var v1 = src[i10 + c] * (1 - ax) * ay + src[i11 + c] * ax * ay;
      out[c] = v0 + v1;
    }
    return out;
  }

  // Separable box blur on all four channels (including alpha). Softens the
  // warped color pass: hard silhouette edges feather out instead of aliasing
  // against the sharp line art beneath, and noisy flow at object edges stops
  // producing single-pixel color speckles.
  // Sliding-window sums make this O(n) instead of O(n·r); channel values are
  // integers so the running sum is exact: byte-identical to the old loop.
  function smoothRGBA(rgba, w, h, r) {
    var n = w * h;
    var tmp = new Uint8ClampedArray(rgba.length);
    var out = new Uint8ClampedArray(rgba.length);
    var x, y, q, i, cnt, lo, hi, newLo, newHi;
    var sum0, sum1, sum2, sum3;
    // horizontal pass
    for (y = 0; y < h; y++) {
      var rb = y * w * 4;
      sum0 = 0; sum1 = 0; sum2 = 0; sum3 = 0; cnt = 0;
      lo = 0; hi = r; if (hi >= w) hi = w - 1;
      for (i = 0; i <= hi; i++) {
        q = rb + i * 4;
        sum0 += rgba[q]; sum1 += rgba[q + 1]; sum2 += rgba[q + 2]; sum3 += rgba[q + 3];
        cnt++;
      }
      for (x = 0; x < w; x++) {
        q = rb + x * 4;
        tmp[q] = sum0 / cnt; tmp[q + 1] = sum1 / cnt; tmp[q + 2] = sum2 / cnt; tmp[q + 3] = sum3 / cnt;
        // slide the window one pixel right
        newLo = x + 1 - r; if (newLo < 0) newLo = 0;
        if (newLo > lo) {
          q = rb + lo * 4;
          sum0 -= rgba[q]; sum1 -= rgba[q + 1]; sum2 -= rgba[q + 2]; sum3 -= rgba[q + 3];
          cnt--;
          lo = newLo;
        }
        newHi = x + 1 + r; if (newHi >= w) newHi = w - 1;
        if (newHi > hi) {
          q = rb + newHi * 4;
          sum0 += rgba[q]; sum1 += rgba[q + 1]; sum2 += rgba[q + 2]; sum3 += rgba[q + 3];
          cnt++;
          hi = newHi;
        }
      }
    }
    // vertical pass
    for (x = 0; x < w; x++) {
      sum0 = 0; sum1 = 0; sum2 = 0; sum3 = 0; cnt = 0;
      lo = 0; hi = r; if (hi >= h) hi = h - 1;
      for (i = 0; i <= hi; i++) {
        q = (i * w + x) * 4;
        sum0 += tmp[q]; sum1 += tmp[q + 1]; sum2 += tmp[q + 2]; sum3 += tmp[q + 3];
        cnt++;
      }
      for (y = 0; y < h; y++) {
        q = (y * w + x) * 4;
        out[q] = sum0 / cnt; out[q + 1] = sum1 / cnt; out[q + 2] = sum2 / cnt; out[q + 3] = sum3 / cnt;
        newLo = y + 1 - r; if (newLo < 0) newLo = 0;
        if (newLo > lo) {
          q = (lo * w + x) * 4;
          sum0 -= tmp[q]; sum1 -= tmp[q + 1]; sum2 -= tmp[q + 2]; sum3 -= tmp[q + 3];
          cnt--;
          lo = newLo;
        }
        newHi = y + 1 + r; if (newHi >= h) newHi = h - 1;
        if (newHi > hi) {
          q = (newHi * w + x) * 4;
          sum0 += tmp[q]; sum1 += tmp[q + 1]; sum2 += tmp[q + 2]; sum3 += tmp[q + 3];
          cnt++;
          hi = newHi;
        }
      }
    }
    return out;
  }

  // Limit a warped color pass's alpha to the source frame's silhouette: the
  // fill only shows where the source layer is opaque, so colors never bleed
  // outside the drawing, no matter the line art's style or color. What is
  // "line" vs "paper" inside the silhouette is left to the multiply blend
  // (dark stays dark, light gets tinted), so fluffy soft edges and any-color
  // line art both work.
  function gateFill(warped, line, w, h) {
    var n = w * h;
    for (var p = 0, q = 0; p < n; p++, q += 4) {
      warped[q + 3] = warped[q + 3] * (line[q + 3] / 255);
    }
    return warped;
  }

  // Warp one image fully along a flow field (the A→B flow from computeFlowBoth).
  // Used by color layers: the colored pass of one frame is warped to follow
  // the line-art frame it colors, so colors track the animation. A positive
  // radius smooths the result (feathered edges) to avoid jagged color edges.
  // Bilinear sampling is inlined: no per-pixel function calls or allocation.
  function warpFrame(src, flowAB, width, height, radius) {
    var u = flowAB.u, v = flowAB.v;
    var out = new Uint8ClampedArray(src.length);
    var w1 = width - 1, h1 = height - 1;
    var y, x, p, q;
    for (y = 0; y < height; y++) {
      for (x = 0; x < width; x++) {
        p = y * width + x;
        q = p * 4;
        var fx = x - u[p], fy = y - v[p];
        if (fx < 0) fx = 0; else if (fx > w1) fx = w1;
        if (fy < 0) fy = 0; else if (fy > h1) fy = h1;
        var x0 = fx | 0, y0 = fy | 0;
        var x1 = x0 < w1 ? x0 + 1 : x0;
        var y1 = y0 < h1 ? y0 + 1 : y0;
        var ax = fx - x0, ay = fy - y0;
        var w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay);
        var w10 = (1 - ax) * ay, w11 = ax * ay;
        var i00 = (y0 * width + x0) * 4, i01 = (y0 * width + x1) * 4;
        var i10 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4;
        out[q] = (src[i00] * w00 + src[i01] * w01) + (src[i10] * w10 + src[i11] * w11);
        out[q + 1] = (src[i00 + 1] * w00 + src[i01 + 1] * w01) + (src[i10 + 1] * w10 + src[i11 + 1] * w11);
        out[q + 2] = (src[i00 + 2] * w00 + src[i01 + 2] * w01) + (src[i10 + 2] * w10 + src[i11 + 2] * w11);
        out[q + 3] = (src[i00 + 3] * w00 + src[i01 + 3] * w01) + (src[i10 + 3] * w10 + src[i11 + 3] * w11);
      }
    }
    if (radius > 0) return smoothRGBA(out, width, height, radius);
    return out;
  }

  function morphFrame(aData, bData, flowAB, flowBA, width, height, t) {
    var n = width * height;
    var out = new Uint8ClampedArray(n * 4);
    var uAB = flowAB.u, vAB = flowAB.v;
    var uBA = flowBA.u, vBA = flowBA.v;
    var thresh = 4.0;
    var inv = 1 - t;
    var w1 = width - 1, h1 = height - 1;
    var a = aData, b = bData;
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var p = y * width + x;
        var q = p * 4;

        // forward/backward consistency: the two flows should point at each other
        var ux = uAB[p], vy = vAB[p];
        var lx = Math.round(x + ux), ly = Math.round(y + vy);
        if (lx < 0) lx = 0; else if (lx > w1) lx = w1;
        if (ly < 0) ly = 0; else if (ly > h1) ly = h1;
        var lp = ly * width + lx;
        var cA = Math.abs(ux + uBA[lp]) + Math.abs(vy + vBA[lp]);

        var ux2 = uBA[p], vy2 = vBA[p];
        var mx = Math.round(x + ux2), my = Math.round(y + vy2);
        if (mx < 0) mx = 0; else if (mx > w1) mx = w1;
        if (my < 0) my = 0; else if (my > h1) my = h1;
        var mp = my * width + mx;
        var cB = Math.abs(ux2 + uAB[mp]) + Math.abs(vy2 + vAB[mp]);

        var wA = cA < thresh ? 1 - cA / thresh : 0;
        var wB = cB < thresh ? 1 - cB / thresh : 0;
        var wa = wA * inv;
        var wb = wB * t;
        // Softly mix in the plain cross-fade where confidence is low, so
        // unreliable pixels dissolve instead of snapping between sources.
        var eps = 0.1;
        var denom = wa + wb + eps;

        var sax = x - t * ux, say = y - t * vy;
        var sbx = x - inv * ux2, sby = y - inv * vy2;
        var fx = sax; if (fx < 0) fx = 0; else if (fx > w1) fx = w1;
        var fy = say; if (fy < 0) fy = 0; else if (fy > h1) fy = h1;
        var x0 = fx | 0, y0 = fy | 0;
        var x1 = x0 < w1 ? x0 + 1 : x0;
        var y1 = y0 < h1 ? y0 + 1 : y0;
        var ax = fx - x0, ay = fy - y0;
        var w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay);
        var w10 = (1 - ax) * ay, w11 = ax * ay;
        var ia00 = (y0 * width + x0) * 4, ia01 = (y0 * width + x1) * 4;
        var ia10 = (y1 * width + x0) * 4, ia11 = (y1 * width + x1) * 4;
        fx = sbx; if (fx < 0) fx = 0; else if (fx > w1) fx = w1;
        fy = sby; if (fy < 0) fy = 0; else if (fy > h1) fy = h1;
        x0 = fx | 0; y0 = fy | 0;
        x1 = x0 < w1 ? x0 + 1 : x0;
        y1 = y0 < h1 ? y0 + 1 : y0;
        ax = fx - x0; ay = fy - y0;
        var u00 = (1 - ax) * (1 - ay), u01 = ax * (1 - ay);
        var u10 = (1 - ax) * ay, u11 = ax * ay;
        var ib00 = (y0 * width + x0) * 4, ib01 = (y0 * width + x1) * 4;
        var ib10 = (y1 * width + x0) * 4, ib11 = (y1 * width + x1) * 4;
        var sa0 = (a[ia00] * w00 + a[ia01] * w01) + (a[ia10] * w10 + a[ia11] * w11);
        var sa1 = (a[ia00 + 1] * w00 + a[ia01 + 1] * w01) + (a[ia10 + 1] * w10 + a[ia11 + 1] * w11);
        var sa2 = (a[ia00 + 2] * w00 + a[ia01 + 2] * w01) + (a[ia10 + 2] * w10 + a[ia11 + 2] * w11);
        var sa3 = (a[ia00 + 3] * w00 + a[ia01 + 3] * w01) + (a[ia10 + 3] * w10 + a[ia11 + 3] * w11);
        var sb0 = (b[ib00] * u00 + b[ib01] * u01) + (b[ib10] * u10 + b[ib11] * u11);
        var sb1 = (b[ib00 + 1] * u00 + b[ib01 + 1] * u01) + (b[ib10 + 1] * u10 + b[ib11 + 1] * u11);
        var sb2v = (b[ib00 + 2] * u00 + b[ib01 + 2] * u01) + (b[ib10 + 2] * u10 + b[ib11 + 2] * u11);
        var sb3 = (b[ib00 + 3] * u00 + b[ib01 + 3] * u01) + (b[ib10 + 3] * u10 + b[ib11 + 3] * u11);
        out[q] = Math.round((wa * sa0 + wb * sb0 + eps * (inv * a[q] + t * b[q])) / denom);
        out[q + 1] = Math.round((wa * sa1 + wb * sb1 + eps * (inv * a[q + 1] + t * b[q + 1])) / denom);
        out[q + 2] = Math.round((wa * sa2 + wb * sb2v + eps * (inv * a[q + 2] + t * b[q + 2])) / denom);
        out[q + 3] = Math.round((wa * sa3 + wb * sb3 + eps * (inv * a[q + 3] + t * b[q + 3])) / denom);
      }
    }
    return out;
  }

  // Plain cross-fade (fallback / "blend" mode).
  function blendFrame(aData, bData, width, height, t) {
    var n = width * height;
    var out = new Uint8ClampedArray(n * 4);
    var inv = 1 - t;
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      out[i] = Math.round(aData[i] * inv + bData[i] * t);
      out[i + 1] = Math.round(aData[i + 1] * inv + bData[i + 1] * t);
      out[i + 2] = Math.round(aData[i + 2] * inv + bData[i + 2] * t);
      out[i + 3] = 255;
    }
    return out;
  }

  // Mesh-based warping

  // Each vertex of a coarse grid samples the (already edge-aware-median-smoothed)
  // dense flow bilinearly; bilinear interpolation between vertices makes the warp
  // behave like deforming a mesh: nearby pixels always move coherently and
  // per-pixel strays/tearing are impossible. Crucially the vertex values are NOT
  // smoothed afterwards: the dense flow's occlusion completion (repairFlow)
  // extends the object's motion across the occluded band, and averaging that away
  // at vertices made the warp mis-read the object's trailing half (cut/slice
  // look). The completion taper is left intact; the render's dissolve + hole-fill
  // keeps the completed band invisible.
  function buildMesh(u, v, w, h, cell) {
    cell = Math.max(4, Math.round(cell));
    var cols = Math.max(2, Math.ceil(w / cell) + 1);
    var rows = Math.max(2, Math.ceil(h / cell) + 1);
    var mu = new Float32Array(cols * rows);
    var mv = new Float32Array(cols * rows);
    for (var j = 0; j < rows; j++) {
      for (var i = 0; i < cols; i++) {
        var idx = j * cols + i;
        mu[idx] = bilinearField(u, w, h, i * cell, j * cell);
        mv[idx] = bilinearField(v, w, h, i * cell, j * cell);
      }
    }
    return { u: mu, v: mv, cols: cols, rows: rows, cell: cell };
  }

  // Bilinear sample of the mesh flow at pixel (x, y).
  function sampleMesh(mesh, x, y) {
    var cols = mesh.cols, rows = mesh.rows, cell = mesh.cell;
    var fx = x / cell, fy = y / cell;
    if (fx < 0) fx = 0; else if (fx > cols - 2) fx = cols - 2;
    if (fy < 0) fy = 0; else if (fy > rows - 2) fy = rows - 2;
    var i0 = fx | 0, j0 = fy | 0;
    var i1 = i0 + 1, j1 = j0 + 1;
    var ax = fx - i0, ay = fy - j0;
    var u00 = mesh.u[j0 * cols + i0], u01 = mesh.u[j0 * cols + i1];
    var u10 = mesh.u[j1 * cols + i0], u11 = mesh.u[j1 * cols + i1];
    var v00 = mesh.v[j0 * cols + i0], v01 = mesh.v[j0 * cols + i1];
    var v10 = mesh.v[j1 * cols + i0], v11 = mesh.v[j1 * cols + i1];
    var u = u00 * (1 - ax) * (1 - ay) + u01 * ax * (1 - ay) + u10 * (1 - ax) * ay + u11 * ax * ay;
    var v = v00 * (1 - ax) * (1 - ay) + v01 * ax * (1 - ay) + v10 * (1 - ax) * ay + v11 * ax * ay;
    return [u, v];
  }

  function buildMeshes(pair, width, height, cell) {
    return {
      meshAB: buildMesh(pair.flowAB.u, pair.flowAB.v, width, height, cell),
      meshBA: buildMesh(pair.flowBA.u, pair.flowBA.v, width, height, cell),
      flowBARaw: pair.flowBARaw,
      // Dense flows retained so per-pixel morphFrame can be used for thin
      // line-art layers (the mesh averages thin strokes' motion to ~0 and the
      // morph degenerates into a double-exposed crossfade).
      flowAB: pair.flowAB,
      flowBA: pair.flowBA
    };
  }

  // Classic morph render: each side is deformed toward the other along the mesh
  // flow, and the two deformations are cross-dissolved by t. When the flows are
  // right (translation, rotation, deformation) both warps produce the SAME
  // intermediate shape, so the dissolve is invisible: no seams, no cuts, and
  // no per-pixel occlusion weights to ghost rotations. Where A's deformation
  // doesn't cover (content revealed between the keyframes, plus rounding
  // cracks), the pixel is filled from B using the un-repaired flow, so revealed
  // background sits at rest instead of being dragged.
  function morphFrameMesh(aData, bData, meshes, width, height, t) {
    var rendered = renderMeshWarps(aData, bData, meshes, width, height, t);
    return rendered.out;
  }

  // Interpolate ONLY the alpha channel for an AI frame (RGB model, alpha 255)
  // so it can borrow the layer's transparency. Each endpoint's alpha is warped
  // to time t along the mesh flow and the two are UNIONED (max): a moving
  // silhouette stays fully opaque through its whole path; the leading edge is
  // covered by A's warp, the trailing edge by B's, instead of cross-dissolving
  // into a semi-transparent ghost. Revealed background stays clear.
  function warpAlpha(aData, bData, meshes, width, height, t) {
    var meshAB = meshes.meshAB, meshBA = meshes.meshBA;
    var inv = 1 - t;
    var n = width * height;
    var w1 = width - 1, h1 = height - 1;
    var a = aData, b = bData;
    var cols = meshAB.cols, rows = meshAB.rows, cell = meshAB.cell;
    var alpha = new Uint8Array(n);
    // Hoisted per-row and per-column mesh-sample factors (same scheme as
    // renderMeshWarps) so the per-pixel loop only combines them.
    var fxArr = new Float32Array(width), axArr = new Float32Array(width);
    var i0c = new Int32Array(width), i1c = new Int32Array(width);
    var fyArr = new Float32Array(height), ayArr = new Float32Array(height);
    var j0r = new Int32Array(height), j1r = new Int32Array(height);
    var x, y, p;
    for (x = 0; x < width; x++) {
      var ffx = x / cell;
      if (ffx < 0) ffx = 0; else if (ffx > cols - 2) ffx = cols - 2;
      fxArr[x] = ffx;
      i0c[x] = ffx | 0;
      i1c[x] = (ffx | 0) + 1;
      axArr[x] = ffx - (ffx | 0);
    }
    for (y = 0; y < height; y++) {
      var ffy = y / cell;
      if (ffy < 0) ffy = 0; else if (ffy > rows - 2) ffy = rows - 2;
      fyArr[y] = ffy;
      j0r[y] = ffy | 0;
      j1r[y] = (ffy | 0) + 1;
      ayArr[y] = ffy - (ffy | 0);
    }
    for (y = 0; y < height; y++) {
      var fy0 = fyArr[y], ay0 = ayArr[y], j0 = j0r[y], j1 = j1r[y];
      var j0c = j0 * cols, j1c = j1 * cols;
      for (x = 0; x < width; x++) {
        p = y * width + x;
        var i0 = i0c[x], i1 = i1c[x], ax0 = axArr[x];
        var omax = 1 - ax0, omay = 1 - ay0;
        var uA = meshAB.u[j0c + i0] * omax * omay + meshAB.u[j0c + i1] * ax0 * omay
               + meshAB.u[j1c + i0] * omax * ay0 + meshAB.u[j1c + i1] * ax0 * ay0;
        var vA = meshAB.v[j0c + i0] * omax * omay + meshAB.v[j0c + i1] * ax0 * omay
               + meshAB.v[j1c + i0] * omax * ay0 + meshAB.v[j1c + i1] * ax0 * ay0;
        var uB = meshBA.u[j0c + i0] * omax * omay + meshBA.u[j0c + i1] * ax0 * omay
               + meshBA.u[j1c + i0] * omax * ay0 + meshBA.u[j1c + i1] * ax0 * ay0;
        var vB = meshBA.v[j0c + i0] * omax * omay + meshBA.v[j0c + i1] * ax0 * omay
               + meshBA.v[j1c + i0] * omax * ay0 + meshBA.v[j1c + i1] * ax0 * ay0;
        var fx = x - t * uA, fy = y - t * vA;
        var aA = sampleAlpha(a, width, height, fx, fy, w1, h1);
        var gx = x - inv * uB, gy = y - inv * vB;
        var aB = sampleAlpha(b, width, height, gx, gy, w1, h1);
        alpha[p] = aA > aB ? aA : aB;
      }
    }
    return alpha;
  }

  // Bilinear sample of a buffer's alpha channel at (fx, fy) with clamping.
  function sampleAlpha(data, w, h, fx, fy, w1, h1) {
    if (fx < 0) fx = 0; else if (fx > w1) fx = w1;
    if (fy < 0) fy = 0; else if (fy > h1) fy = h1;
    var x0 = fx | 0, y0 = fy | 0;
    var x1 = x0 < w1 ? x0 + 1 : x0;
    var y1 = y0 < h1 ? y0 + 1 : y0;
    var ax = fx - x0, ay = fy - y0;
    var q00 = (y0 * w + x0) * 4, q01 = (y0 * w + x1) * 4;
    var q10 = (y1 * w + x0) * 4, q11 = (y1 * w + x1) * 4;
    var top = data[q00 + 3] * (1 - ax) + data[q01 + 3] * ax;
    var bot = data[q10 + 3] * (1 - ax) + data[q11 + 3] * ax;
    return top * (1 - ay) + bot * ay;
  }

  // Union of the two DENSE-flow-warped alpha channels (used for thin line art,
  // where the coarse mesh dilutes strokes' motion to ~0 and the silhouette
  // double-exposes). Same crisp silhouette idea as warpAlpha, but sampled
  // directly from the dense flow fields.
  function warpAlphaDense(aData, bData, flowAB, flowBA, width, height, t) {
    var n = width * height;
    var w1 = width - 1, h1 = height - 1;
    var uA = flowAB.u, vA = flowAB.v;
    var uB = flowBA.u, vB = flowBA.v;
    var inv = 1 - t;
    var alpha = new Uint8Array(n);
    for (var p = 0; p < n; p++) {
      var aA = sampleAlpha(aData, width, height, p % width - t * uA[p], (p / width) | 0 - t * vA[p], w1, h1);
      var aB = sampleAlpha(bData, width, height, p % width - inv * uB[p], (p / width) | 0 - inv * vB[p], w1, h1);
      alpha[p] = aA > aB ? aA : aB;
    }
    return alpha;
  }

  function renderMeshWarps(aData, bData, meshes, width, height, t) {
    var meshAB = meshes.meshAB, meshBA = meshes.meshBA;
    var n = width * height;
    var out = new Uint8ClampedArray(n * 4);
    var covered = new Uint8Array(n);
    var inv = 1 - t;
    var w1 = width - 1, h1 = height - 1;
    var a = aData, b = bData;
    var uAB = meshAB.u, vAB = meshAB.v, uBA = meshBA.u, vBA = meshBA.v;
    var cols = meshAB.cols, rows = meshAB.rows, cell = meshAB.cell;
    // Hoisted per-row and per-column mesh-sample factors (fx/fy, cell coords,
    // interpolation weights) so the per-pixel hot loop only combines them.
    var fxArr = new Float32Array(width), axArr = new Float32Array(width);
    var i0c = new Int32Array(width), i1c = new Int32Array(width);
    var fyArr = new Float32Array(height), ayArr = new Float32Array(height);
    var j0r = new Int32Array(height), j1r = new Int32Array(height);
    var y, x, p, q;
    for (x = 0; x < width; x++) {
      var ffx = x / cell;
      if (ffx < 0) ffx = 0; else if (ffx > cols - 2) ffx = cols - 2;
      fxArr[x] = ffx;
      i0c[x] = ffx | 0;
      i1c[x] = (ffx | 0) + 1;
      axArr[x] = ffx - (ffx | 0);
    }
    for (y = 0; y < height; y++) {
      var ffy = y / cell;
      if (ffy < 0) ffy = 0; else if (ffy > rows - 2) ffy = rows - 2;
      fyArr[y] = ffy;
      j0r[y] = ffy | 0;
      j1r[y] = (ffy | 0) + 1;
      ayArr[y] = ffy - (ffy | 0);
    }
    // Forward-splat coverage: which output pixels does A's deformation land on?
    for (y = 0; y < height; y++) {
      var fy0 = fyArr[y], ay0 = ayArr[y], j0 = j0r[y], j1 = j1r[y];
      var j0c = j0 * cols, j1c = j1 * cols;
      for (x = 0; x < width; x++) {
        p = y * width + x;
        var i0 = i0c[x], i1 = i1c[x], ax0 = axArr[x];
        var u0 = uAB[j0c + i0] * (1 - ax0) * (1 - ay0) + uAB[j0c + i1] * ax0 * (1 - ay0)
              + uAB[j1c + i0] * (1 - ax0) * ay0 + uAB[j1c + i1] * ax0 * ay0;
        var v0 = vAB[j0c + i0] * (1 - ax0) * (1 - ay0) + vAB[j0c + i1] * ax0 * (1 - ay0)
              + vAB[j1c + i0] * (1 - ax0) * ay0 + vAB[j1c + i1] * ax0 * ay0;
        var qx = Math.round(x + t * u0);
        var qy = Math.round(y + t * v0);
        if (qx < 0) qx = 0; else if (qx > w1) qx = w1;
        if (qy < 0) qy = 0; else if (qy > h1) qy = h1;
        covered[qy * width + qx] = 1;
      }
    }
    var uRaw = null, vRaw = null;
    if (meshes.flowBARaw) { uRaw = meshes.flowBARaw.u; vRaw = meshes.flowBARaw.v; }
    // Close 1px holes in the coverage mask: the forward-splat target rounding of a
    // smoothly-varying flow leaves a checkerboard of uncovered pixels around every
    // moving edge, and filling those from B speckles the frame. One dilation pass
    // marks them covered, so only the genuinely wide revealed bands reach the fill.
    for (y = 0; y < height; y++) {
      for (x = 0; x < width; x++) {
        if (covered[y * width + x]) continue;
        var found = false;
        for (var dy2 = -1; dy2 <= 1 && !found; dy2++) {
          var ny = y + dy2;
          if (ny < 0 || ny >= height) continue;
          for (var dx2 = -1; dx2 <= 1; dx2++) {
            if (dx2 === 0 && dy2 === 0) continue;
            var nx = x + dx2;
            if (nx < 0 || nx >= width) continue;
            if (covered[ny * width + nx]) { found = true; break; }
          }
        }
        if (found) covered[y * width + x] = 1;
      }
    }
    for (y = 0; y < height; y++) {
      var fy1 = fyArr[y], ay1 = ayArr[y], j0b = j0r[y], j1b = j1r[y];
      var j0bc = j0b * cols, j1bc = j1b * cols;
      for (x = 0; x < width; x++) {
        p = y * width + x;
        q = p * 4;
        var i0b = i0c[x], i1b = i1c[x], ax1 = axArr[x];
        var omax = 1 - ax1, omay = 1 - ay1;
        if (covered[p]) {
          var uA = uAB[j0bc + i0b] * omax * omay + uAB[j0bc + i1b] * ax1 * omay
                 + uAB[j1bc + i0b] * omax * ay1 + uAB[j1bc + i1b] * ax1 * ay1;
          var vA = vAB[j0bc + i0b] * omax * omay + vAB[j0bc + i1b] * ax1 * omay
                 + vAB[j1bc + i0b] * omax * ay1 + vAB[j1bc + i1b] * ax1 * ay1;
          var uB = uBA[j0bc + i0b] * omax * omay + uBA[j0bc + i1b] * ax1 * omay
                 + uBA[j1bc + i0b] * omax * ay1 + uBA[j1bc + i1b] * ax1 * ay1;
          var vB = vBA[j0bc + i0b] * omax * omay + vBA[j0bc + i1b] * ax1 * omay
                 + vBA[j1bc + i0b] * omax * ay1 + vBA[j1bc + i1b] * ax1 * ay1;
          var sax = x - t * uA, say = y - t * vA;
          var sbx = x - inv * uB, sby = y - inv * vB;
          var fx = sax; if (fx < 0) fx = 0; else if (fx > w1) fx = w1;
          var fy = say; if (fy < 0) fy = 0; else if (fy > h1) fy = h1;
          var x0 = fx | 0, y0 = fy | 0;
          var x1 = x0 < w1 ? x0 + 1 : x0;
          var y1 = y0 < h1 ? y0 + 1 : y0;
          var ax = fx - x0, ay = fy - y0;
          var w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay);
          var w10 = (1 - ax) * ay, w11 = ax * ay;
          var ia00 = (y0 * width + x0) * 4, ia01 = (y0 * width + x1) * 4;
          var ia10 = (y1 * width + x0) * 4, ia11 = (y1 * width + x1) * 4;
          fx = sbx; if (fx < 0) fx = 0; else if (fx > w1) fx = w1;
          fy = sby; if (fy < 0) fy = 0; else if (fy > h1) fy = h1;
          x0 = fx | 0; y0 = fy | 0;
          x1 = x0 < w1 ? x0 + 1 : x0;
          y1 = y0 < h1 ? y0 + 1 : y0;
          ax = fx - x0; ay = fy - y0;
          var u00 = (1 - ax) * (1 - ay), u01 = ax * (1 - ay);
          var u10 = (1 - ax) * ay, u11 = ax * ay;
          var ib00 = (y0 * width + x0) * 4, ib01 = (y0 * width + x1) * 4;
          var ib10 = (y1 * width + x0) * 4, ib11 = (y1 * width + x1) * 4;
          var sa0 = (a[ia00] * w00 + a[ia01] * w01) + (a[ia10] * w10 + a[ia11] * w11);
          var sa1 = (a[ia00 + 1] * w00 + a[ia01 + 1] * w01) + (a[ia10 + 1] * w10 + a[ia11 + 1] * w11);
          var sa2 = (a[ia00 + 2] * w00 + a[ia01 + 2] * w01) + (a[ia10 + 2] * w10 + a[ia11 + 2] * w11);
          var sa3 = (a[ia00 + 3] * w00 + a[ia01 + 3] * w01) + (a[ia10 + 3] * w10 + a[ia11 + 3] * w11);
          var sb0 = (b[ib00] * u00 + b[ib01] * u01) + (b[ib10] * u10 + b[ib11] * u11);
          var sb1 = (b[ib00 + 1] * u00 + b[ib01 + 1] * u01) + (b[ib10 + 1] * u10 + b[ib11 + 1] * u11);
          var sb2 = (b[ib00 + 2] * u00 + b[ib01 + 2] * u01) + (b[ib10 + 2] * u10 + b[ib11 + 2] * u11);
          var sb3 = (b[ib00 + 3] * u00 + b[ib01 + 3] * u01) + (b[ib10 + 3] * u10 + b[ib11 + 3] * u11);
          out[q] = Math.round(inv * sa0 + t * sb0);
          out[q + 1] = Math.round(inv * sa1 + t * sb1);
          out[q + 2] = Math.round(inv * sa2 + t * sb2);
          out[q + 3] = Math.round(inv * sa3 + t * sb3);
        } else if (uRaw) {
          var fu = bilinearField(uRaw, width, height, x, y);
          var fv = bilinearField(vRaw, width, height, x, y);
          var sb2x = x - inv * fu, sb2y = y - inv * fv;
          var fx2 = sb2x; if (fx2 < 0) fx2 = 0; else if (fx2 > w1) fx2 = w1;
          var fy2 = sb2y; if (fy2 < 0) fy2 = 0; else if (fy2 > h1) fy2 = h1;
          var x0 = fx2 | 0, y0 = fy2 | 0;
          var x1 = x0 < w1 ? x0 + 1 : x0;
          var y1 = y0 < h1 ? y0 + 1 : y0;
          var ax = fx2 - x0, ay = fy2 - y0;
          var w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay);
          var w10 = (1 - ax) * ay, w11 = ax * ay;
          var ib2 = (y0 * width + x0) * 4, ib3 = (y0 * width + x1) * 4;
          var ib4 = (y1 * width + x0) * 4, ib5 = (y1 * width + x1) * 4;
          out[q] = Math.round((b[ib2] * w00 + b[ib3] * w01) + (b[ib4] * w10 + b[ib5] * w11));
          out[q + 1] = Math.round((b[ib2 + 1] * w00 + b[ib3 + 1] * w01) + (b[ib4 + 1] * w10 + b[ib5 + 1] * w11));
          out[q + 2] = Math.round((b[ib2 + 2] * w00 + b[ib3 + 2] * w01) + (b[ib4 + 2] * w10 + b[ib5 + 2] * w11));
          out[q + 3] = (b[ib2 + 3] * w00 + b[ib3 + 3] * w01) + (b[ib4 + 3] * w10 + b[ib5 + 3] * w11);
        } else {
          // No raw flow available: fall back to B at rest.
          var x0 = x < w1 ? x : w1, y0 = y < h1 ? y : h1;
          var ib6 = (y0 * width + x0) * 4;
          out[q] = b[ib6]; out[q + 1] = b[ib6 + 1]; out[q + 2] = b[ib6 + 2]; out[q + 3] = b[ib6 + 3];
        }
      }
    }
    return { out: out, covered: covered };
  }

  // Local recognition + generation pass

  // This is intentionally not a downloaded ML model: a static/offline site cannot
  // ship meaningful pretrained image generation without a large bundled model. This
  // pass is a tiny deterministic "image model" for drawings: recognize foreground
  // regions against the corner background, warp their masks through the same mesh,
  // clean islands/holes as connected regions, then regenerate a coherent frame from
  // the warped endpoints instead of trusting individual stray pixels.
  function averageCornerColor(data, w, h) {
    var pts = [0, w - 1, (h - 1) * w, (h - 1) * w + (w - 1)];
    var r = 0, g = 0, b = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i] * 4;
      r += data[p]; g += data[p + 1]; b += data[p + 2];
    }
    return [r / 4, g / 4, b / 4];
  }

  function colorDistToBg(data, i, bg) {
    var dr = data[i] - bg[0], dg = data[i + 1] - bg[1], db = data[i + 2] - bg[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  function makeForegroundMask(data, w, h) {
    var n = w * h;
    var bg = averageCornerColor(data, w, h);
    var mask = new Uint8Array(n);
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      if (data[i + 3] > 16 && colorDistToBg(data, i, bg) > 28) mask[p] = 1;
    }
    return { mask: mask, bg: bg };
  }

  function sampleMask(mask, w, h, fx, fy) {
    var x = Math.round(fx), y = Math.round(fy);
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    return mask[y * w + x];
  }

  function dilateMask(mask, w, h, r) {
    var out = new Uint8Array(mask.length);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var on = 0;
        for (var dy = -r; dy <= r && !on; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (var dx = -r; dx <= r; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (mask[yy * w + xx]) { on = 1; break; }
          }
        }
        out[y * w + x] = on;
      }
    }
    return out;
  }

  function erodeMask(mask, w, h, r) {
    var out = new Uint8Array(mask.length);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var on = 1;
        for (var dy = -r; dy <= r && on; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= h) { on = 0; break; }
          for (var dx = -r; dx <= r; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w || !mask[yy * w + xx]) { on = 0; break; }
          }
        }
        out[y * w + x] = on;
      }
    }
    return out;
  }

  function removeSmallComponents(mask, w, h, keepOn, minSize) {
    var n = w * h;
    var seen = new Uint8Array(n);
    var out = new Uint8Array(mask);
    var stack = [];
    var comp = [];
    for (var p = 0; p < n; p++) {
      if (seen[p] || Boolean(mask[p]) !== keepOn) continue;
      seen[p] = 1;
      stack.length = 0; comp.length = 0;
      stack.push(p);
      while (stack.length) {
        var q = stack.pop();
        comp.push(q);
        var x = q % w, y = (q / w) | 0;
        var ns = [q - 1, q + 1, q - w, q + w];
        for (var k = 0; k < ns.length; k++) {
          var r = ns[k];
          if (r < 0 || r >= n || seen[r] || Boolean(mask[r]) !== keepOn) continue;
          if ((k === 0 && x === 0) || (k === 1 && x === w - 1)) continue;
          seen[r] = 1;
          stack.push(r);
        }
      }
      if (comp.length < minSize) {
        for (var i = 0; i < comp.length; i++) out[comp[i]] = keepOn ? 0 : 1;
      }
    }
    return out;
  }

  function cleanGeneratedMask(mask, w, h) {
    // Close pinholes first, remove specks second, then fill tiny enclosed gaps.
    var closed = erodeMask(dilateMask(mask, w, h, 1), w, h, 1);
    var minObject = Math.max(3, Math.round(w * h * 0.00006));
    var noSpecks = removeSmallComponents(closed, w, h, true, minObject);
    return removeSmallComponents(noSpecks, w, h, false, Math.max(3, minObject * 2));
  }

  function localCoherentColor(src, mask, w, h, x, y, fallback) {
    var rs = [], gs = [], bs = [];
    for (var r = 1; r <= 3; r++) {
      rs.length = 0; gs.length = 0; bs.length = 0;
      for (var dy = -r; dy <= r; dy++) {
        var yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (var dx = -r; dx <= r; dx++) {
          var xx = x + dx;
          if (xx < 0 || xx >= w || !mask[yy * w + xx]) continue;
          var q = (yy * w + xx) * 4;
          rs.push(src[q]); gs.push(src[q + 1]); bs.push(src[q + 2]);
        }
      }
      if (rs.length >= 3) {
        rs.sort(function (a, b) { return a - b; });
        gs.sort(function (a, b) { return a - b; });
        bs.sort(function (a, b) { return a - b; });
        var m = rs.length >> 1;
        return [rs[m], gs[m], bs[m]];
      }
    }
    return fallback;
  }

  function synthesizeInbetweenFrame(aData, bData, meshes, width, height, t, baseFrame) {
    var n = width * height;
    var rendered = baseFrame ? { out: baseFrame } : renderMeshWarps(aData, bData, meshes, width, height, t);
    var base = rendered.out;
    var inv = 1 - t;
    var aRec = makeForegroundMask(aData, width, height);
    var bRec = makeForegroundMask(bData, width, height);
    var outMask = new Uint8Array(n);
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var p = y * width + x;
        var fA = sampleMesh(meshes.meshAB, x, y);
        var fB = sampleMesh(meshes.meshBA, x, y);
        var ma = sampleMask(aRec.mask, width, height, x - t * fA[0], y - t * fA[1]);
        var mb = sampleMask(bRec.mask, width, height, x - inv * fB[0], y - inv * fB[1]);
        outMask[p] = ma || mb ? 1 : 0;
      }
    }
    outMask = cleanGeneratedMask(outMask, width, height);

    var out = new Uint8ClampedArray(n * 4);
    var bg = [aRec.bg[0] * inv + bRec.bg[0] * t, aRec.bg[1] * inv + bRec.bg[1] * t, aRec.bg[2] * inv + bRec.bg[2] * t];
    for (y = 0; y < height; y++) {
      for (x = 0; x < width; x++) {
        p = y * width + x;
        var i = p * 4;
        if (outMask[p]) {
          var fallback = [base[i], base[i + 1], base[i + 2]];
          // If the warped pixel accidentally sampled background inside a recognized
          // object, regenerate it from nearby object pixels rather than leaving a gap.
          if (Math.abs(fallback[0] - bg[0]) + Math.abs(fallback[1] - bg[1]) + Math.abs(fallback[2] - bg[2]) < 36) {
            fallback = localCoherentColor(base, outMask, width, height, x, y, fallback);
          }
          var col = localCoherentColor(base, outMask, width, height, x, y, fallback);
          out[i] = Math.round(col[0]);
          out[i + 1] = Math.round(col[1]);
          out[i + 2] = Math.round(col[2]);
        } else {
          out[i] = Math.round(bg[0]);
          out[i + 1] = Math.round(bg[1]);
          out[i + 2] = Math.round(bg[2]);
        }
        out[i + 3] = 255;
      }
    }
    return out;
  }

  // Motion summary of the moving content, from the DENSE flow: pixels with a
  // real displacement (edges of moving objects; flat interiors and backgrounds
  // have ~zero flow), weighted by magnitude. The mesh version was too coarse
  // here — a centroid off by one cell visibly anchors the deformation wrong
  // (the stretch/squash pivot drifts and the object lands off its path).
  // avgU/avgV is the magnitude-weighted MEAN flow = the object's translation;
  // cx/cy is the mass centroid of the moved pixels.
  function motionStats(meshes, width, height) {
    var fu = meshes.flowAB.u, fv = meshes.flowAB.v;
    var sumU = 0, sumV = 0, sumMag = 0, sumX = 0, sumY = 0, count = 0;
    for (var p = 0; p < fu.length; p++) {
      var u = fu[p], v = fv[p];
      var mag = Math.sqrt(u * u + v * v);
      if (mag < 1.5) continue;
      sumU += u * mag; sumV += v * mag; sumMag += mag; count++;
      sumX += (p % width) * mag; sumY += ((p / width) | 0) * mag;
    }
    if (!count || sumMag < 1e-6) return null;
    var ux = sumU / sumMag, uy = sumV / sumMag;
    var len = Math.sqrt(ux * ux + uy * uy);
    if (len < 1e-6) return null;
    var cx = sumX / sumMag, cy = sumY / sumMag;
    if (cx < 0) cx = 0; else if (cx > width - 1) cx = width - 1;
    if (cy < 0) cy = 0; else if (cy > height - 1) cy = height - 1;
    return {
      ux: ux / len, uy: uy / len,
      avgU: ux, avgV: uy,
      cx: cx, cy: cy,
      mag: len
    };
  }

  // Pixel-space centroid of each keyframe's foreground (what the deformation
  // should anchor on and what travels). Transparent art uses the alpha
  // silhouette; opaque art uses background-colour differencing (same distance
  // convention as localCoherentColor). Returns null when no foreground is
  // found, so callers fall back to the flow-based estimate.
  function foregroundCentres(aData, bData, width, height) {
    var n = width * height;
    var useAlpha = false;
    for (var p = 3; p < n * 4; p += 4) {
      if (aData[p] < 250 || bData[p] < 250) { useAlpha = true; break; }
    }
    var bg = useAlpha ? null : flowBgColor(aData, bData, n);
    var centre = function (rgba) {
      var sx = 0, sy = 0, cnt = 0;
      for (var i = 0; i < n; i++) {
        var q = i * 4;
        var fg;
        if (useAlpha) {
          fg = rgba[q + 3] > 9;
        } else {
          var dr = rgba[q] - bg[0], dg = rgba[q + 1] - bg[1], db = rgba[q + 2] - bg[2];
          fg = Math.abs(dr) + Math.abs(dg) + Math.abs(db) > 36;
        }
        if (fg) { sx += i % width; sy += (i / width) | 0; cnt++; }
      }
      if (!cnt) return null;
      return [sx / cnt, sy / cnt];
    };
    var a = centre(aData), b = centre(bData);
    if (!a || !b) return null;
    return { ax: a[0], ay: a[1], bx: b[0], by: b[1] };
  }

  function squashStretchFrame(aData, bData, meshes, width, height, t, opts) {
    opts = opts || {};
    // Anchor on the keyframes' own foreground centroids: the start centre is
    // the source pivot and the start→end vector is the travel, so the object
    // walks its path while deforming around its current centre. The FLOW mask
    // is not a reliable anchor — its centroid lands in the middle of the swept
    // region (flow noise fills the covered/trailing area), which drags the
    // deformation off the object. Flow is only the fallback.
    var centre = foregroundCentres(aData, bData, width, height);
    var useCentre = centre && (Math.abs(centre.bx - centre.ax) + Math.abs(centre.by - centre.ay) > 0.01);
    var stats = useCentre ? null : motionStats(meshes, width, height);
    var px, py, tx, ty, ux, uy, dist;
    if (useCentre) {
      px = centre.ax; py = centre.ay;
      tx = centre.bx - centre.ax; ty = centre.by - centre.ay;
      dist = Math.sqrt(tx * tx + ty * ty);
      if (dist < 1e-3) return aData.slice();
      ux = tx / dist; uy = ty / dist;
    } else if (stats) {
      px = stats.cx; py = stats.cy;
      tx = stats.avgU; ty = stats.avgV;
      dist = Math.sqrt(tx * tx + ty * ty);
      if (dist < 1e-6) return aData.slice();
      ux = stats.ux; uy = stats.uy;
    } else {
      return aData.slice();
    }
    var autoK = Math.min(0.35, Math.max(0.06, dist / 100));
    var amount = opts.amount != null && isFinite(opts.amount) ? opts.amount : autoK;
    amount = Math.max(-0.8, Math.min(0.8, amount));
    var curve = opts.curve || 'peak';
    var p;
    if (curve === 'peak') p = Math.sin(Math.PI * t);
    else if (curve === 'ease') p = 0.5 * (1 - Math.cos(Math.PI * t));
    else p = t; // 'impact' and 'linear' both build toward the end
    var kEff = amount * p;
    var s = 1 - kEff;
    if (s < 0.4) s = 0.4; else if (s > 1.8) s = 1.8;
    var perp = opts.preserve === 'volume' ? 1 / Math.sqrt(s) : 1 / s;
    var ox = opts.px != null && isFinite(opts.px) ? opts.px : px;
    var oy = opts.py != null && isFinite(opts.py) ? opts.py : py;
    if (ox < 0) ox = 0; else if (ox > width - 1) ox = width - 1;
    if (oy < 0) oy = 0; else if (oy > height - 1) oy = height - 1;
    // The mass travels along (tx,ty) WHILE it deforms: at time t its centre is
    // (ox,oy) + t·(tx,ty). Sampling each pixel from offsets around that MOVING
    // centre anchors the stretch to the object as it travels, and the
    // translation walks the object between the keyframes. Without it the whole
    // gap renders the START keyframe deformed in place — the object never
    // travels, then jumps to keyframe B — and on transparent gaps the RGB
    // visibly detaches from the alpha (whose warp already follows t).
    return affineScale(aData, width, height, ux, uy, s, perp,
      ox + t * tx, oy + t * ty, ox, oy);
  }

  // Dest offsets are measured from the moving centre (px,py); source offsets
  // come from the START centre (ox,oy), so the deformation pivot travels with
  // the object instead of dragging the whole frame around a fixed anchor.
  // With px==ox, py==oy this is the classic single-pivot affine scale.
  function affineScale(src, width, height, ux, uy, s, inv, px, py, ox, oy) {
    var n = width * height;
    var out = new Uint8ClampedArray(n * 4);
    var cx = px, cy = py;
    if (ox == null || !isFinite(ox)) ox = px;
    if (oy == null || !isFinite(oy)) oy = py;
    var w1 = width - 1, h1 = height - 1;
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var dx = x - cx, dy = y - cy;
        var along = dx * ux + dy * uy;
        var perp = dx * -uy + dy * ux;
        var fx = ox + (along / s) * ux - (perp / inv) * uy;
        var fy = oy + (along / s) * uy + (perp / inv) * ux;
        if (fx < 0) fx = 0; else if (fx > w1) fx = w1;
        if (fy < 0) fy = 0; else if (fy > h1) fy = h1;
        var x0 = fx | 0, y0 = fy | 0;
        var x1 = x0 < w1 ? x0 + 1 : x0;
        var y1 = y0 < h1 ? y0 + 1 : y0;
        var ax = fx - x0, ay = fy - y0;
        var w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay);
        var w10 = (1 - ax) * ay, w11 = ax * ay;
        var q = (y * width + x) * 4;
        var i00 = (y0 * width + x0) * 4, i01 = (y0 * width + x1) * 4;
        var i10 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4;
        out[q] = Math.round((src[i00] * w00 + src[i01] * w01) + (src[i10] * w10 + src[i11] * w11));
        out[q + 1] = Math.round((src[i00 + 1] * w00 + src[i01 + 1] * w01) + (src[i10 + 1] * w10 + src[i11 + 1] * w11));
        out[q + 2] = Math.round((src[i00 + 2] * w00 + src[i01 + 2] * w01) + (src[i10 + 2] * w10 + src[i11 + 2] * w11));
        out[q + 3] = Math.round((src[i00 + 3] * w00 + src[i01 + 3] * w01) + (src[i10 + 3] * w10 + src[i11 + 3] * w11));
      }
    }
    return out;
  }

  // Motion blur for inbetween frames: smears the rendered frame along the local
  // motion direction (the mesh flow), with the amount scaling with the pixel's
  // motion magnitude and easing in and out across the gap (sin(pi·t): no blur at
  // the keyframes, peak mid-gap). Static regions are copied untouched, so only
  // content that actually moved gets a streak; that is what makes it accurate
  // motion blur (and what masks warp/AI imperfections along the motion path).
  function motionBlurFrame(rgba, meshes, width, height, t, intensity) {
    var n = width * height;
    var out = new Uint8ClampedArray(rgba.length);
    if (!(intensity > 0) || !meshes || !meshes.meshAB) { out.set(rgba); return out; }
    var mesh = meshes.meshAB;
    var cols = mesh.cols, rows = mesh.rows, cell = mesh.cell;
    var mu = mesh.u, mv = mesh.v;
    var w1 = width - 1, h1 = height - 1;
    var ease = Math.sin(Math.PI * t);
    if (!(ease > 0)) { out.set(rgba); return out; }
    var fxArr = new Float32Array(width), axArr = new Float32Array(width);
    var i0c = new Int32Array(width), i1c = new Int32Array(width);
    var fyArr = new Float32Array(height), ayArr = new Float32Array(height);
    var j0r = new Int32Array(height), j1r = new Int32Array(height);
    for (var x = 0; x < width; x++) {
      var ffx = x / cell;
      if (ffx < 0) ffx = 0; else if (ffx > cols - 2) ffx = cols - 2;
      fxArr[x] = ffx;
      i0c[x] = ffx | 0;
      i1c[x] = (ffx | 0) + 1;
      axArr[x] = ffx - (ffx | 0);
    }
    for (var y = 0; y < height; y++) {
      var ffy = y / cell;
      if (ffy < 0) ffy = 0; else if (ffy > rows - 2) ffy = rows - 2;
      fyArr[y] = ffy;
      j0r[y] = ffy | 0;
      j1r[y] = (ffy | 0) + 1;
      ayArr[y] = ffy - (ffy | 0);
    }
    var MAX_TRAIL = 24;   // longest streak in px (cap keeps tap count sane)
    var MAX_TAPS = 12;    // cap on samples per pixel
    var src = rgba;
    for (y = 0; y < height; y++) {
      var j0 = j0r[y], j1 = j1r[y], ay = ayArr[y];
      var omay = 1 - ay;
      var j0c = j0 * cols, j1c = j1 * cols;
      for (x = 0; x < width; x++) {
        var p = y * width + x;
        var q = p * 4;
        var i0 = i0c[x], i1 = i1c[x], ax = axArr[x];
        var omax = 1 - ax;
        var ux = mu[j0c + i0] * omax * omay + mu[j0c + i1] * ax * omay
               + mu[j1c + i0] * omax * ay + mu[j1c + i1] * ax * ay;
        var vy = mv[j0c + i0] * omax * omay + mv[j0c + i1] * ax * omay
               + mv[j1c + i0] * omax * ay + mv[j1c + i1] * ax * ay;
        var mag = Math.sqrt(ux * ux + vy * vy);
        var trail = ease * intensity * mag;
        if (trail < 0.6) {
          out[q] = src[q]; out[q + 1] = src[q + 1]; out[q + 2] = src[q + 2]; out[q + 3] = src[q + 3];
          continue;
        }
        if (trail > MAX_TRAIL) trail = MAX_TRAIL;
        var taps = Math.min(MAX_TAPS, 1 + 2 * Math.round(trail / 2));
        if (taps < 3) taps = 3;
        var dx = ux / mag, dy = vy / mag;
        var half = taps >> 1;
        var step = trail / (taps - 1);
        var r0 = 0, g0 = 0, b0 = 0, a0 = 0;
        for (var k = 0; k < taps; k++) {
          var off = (k - half) * step;
          var fx = x + dx * off, fy = y + dy * off;
          if (fx < 0) fx = 0; else if (fx > w1) fx = w1;
          if (fy < 0) fy = 0; else if (fy > h1) fy = h1;
          var x0 = fx | 0, y0 = fy | 0;
          var x1 = x0 < w1 ? x0 + 1 : x0;
          var y1 = y0 < h1 ? y0 + 1 : y0;
          var ax2 = fx - x0, ay2 = fy - y0;
          var w00 = (1 - ax2) * (1 - ay2), w01 = ax2 * (1 - ay2);
          var w10 = (1 - ax2) * ay2, w11 = ax2 * ay2;
          var i00 = (y0 * width + x0) * 4, i01 = (y0 * width + x1) * 4;
          var i10 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4;
          r0 += (src[i00] * w00 + src[i01] * w01) + (src[i10] * w10 + src[i11] * w11);
          g0 += (src[i00 + 1] * w00 + src[i01 + 1] * w01) + (src[i10 + 1] * w10 + src[i11 + 1] * w11);
          b0 += (src[i00 + 2] * w00 + src[i01 + 2] * w01) + (src[i10 + 2] * w10 + src[i11 + 2] * w11);
          a0 += (src[i00 + 3] * w00 + src[i01 + 3] * w01) + (src[i10 + 3] * w10 + src[i11 + 3] * w11);
        }
        out[q] = r0 / taps;
        out[q + 1] = g0 / taps;
        out[q + 2] = b0 / taps;
        out[q + 3] = a0 / taps;
      }
    }
    return out;
  }

  // True when every pixel's alpha channel is 255 (no transparency). Lets the AI
  // path skip the mesh-warped alpha pass entirely; RIFE already renders alpha
  // 255, so the result is byte-identical while saving a full mesh warp per frame.
  function isOpaque(rgba) {
    for (var i = 3; i < rgba.length; i += 4) {
      if (rgba[i] !== 255) return false;
    }
    return true;
  }

  // Byte equality of two RGBA buffers (fast-fail on length). Used to detect
  // duplicate keyframes; every inbetween of such a gap is the keyframe itself.
  function buffersEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Whether two keyframes share the same alpha mask (silhouette didn't move or
  // reshape); then the interpolated alpha is that static mask and the second
  // (alpha) model pass can be skipped. Only every 4th byte is compared.
  function sameAlpha(a, b, n) {
    if (!a || !b) return false;
    for (var p = 0, i = 3; p < n; p++, i += 4) if (a[i] !== b[i]) return false;
    return true;
  }

  // ---- chroma-key matte (transparent-image interpolation) ----
  // Transparent keyframes are encoded as OPAQUE images: transparent pixels are
  // painted a key color K that does not occur in the frame, and semi-transparent
  // pixels are composited over K (premultiplied). The interpolation model then
  // sees a clean opaque image (no garbage alpha), and afterwards decodeMatte
  // strips K back out: alpha = how far the pixel is from K, RGB = the original
  // premultiplied color. Only gaps with transparency pay the (cheap) encode +
  // decode pass; fully opaque gaps skip all of it.

  // Pick a key color for the matte: a general (not just pure) color that is
  // rare in both frames' OPAQUE content. Histogram the opaque pixels at 4 bits
  // per channel and take the least-used bucket's center; realistic frames have
  // small palettes, so that bucket is far from almost all content and the
  // decoder's keyness stays near zero for content (opaque) and near one for the
  // painted background. Transparent pixels are excluded: their RGB is garbage.
  function pickKeyColor(a, b, n) {
    var hist = new Uint32Array(4096);
    var p, i;
    for (i = 0, p = 0; i < n; i++, p += 4) {
      if (a[p + 3] > 0) hist[((a[p] >> 4) << 8) | ((a[p + 1] >> 4) << 4) | (a[p + 2] >> 4)]++;
      if (b[p + 3] > 0) hist[((b[p] >> 4) << 8) | ((b[p + 1] >> 4) << 4) | (b[p + 2] >> 4)]++;
    }
    var best = 0, bestN = Infinity;
    for (i = 0; i < 4096; i++) if (hist[i] < bestN) { bestN = hist[i]; best = i; }
    return [(best >> 8) * 16 + 8, ((best >> 4) & 15) * 16 + 8, (best & 15) * 16 + 8];
  }

  // Encode in place: E = C·a + K·(1-a), alpha forced to 255. Fully opaque
  // pixels are untouched (a = 1 → E = C), so an already-opaque buffer passes
  // through byte-identically.
  function encodeMatte(rgba, n, K) {
    var k0 = K[0], k1 = K[1], k2 = K[2];
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      var a = rgba[i + 3] / 255;
      var inv = 1 - a;
      rgba[i] = rgba[i] * a + k0 * inv;
      rgba[i + 1] = rgba[i + 1] * a + k1 * inv;
      rgba[i + 2] = rgba[i + 2] * a + k2 * inv;
      rgba[i + 3] = 255;
    }
    return rgba;
  }

  // Decode a matte frame's RGB: remove the key's contribution so edges don't
  // carry a key-colored fringe. `alpha` (0..255) comes from the mesh-union alpha
  // warp, which is reliable; keyness-based alpha decode is not (content in the
  // positive RGB octant always projects onto any key). In place.
  function removeKey(rgba, n, K, alpha) {
    var k0 = K[0], k1 = K[1], k2 = K[2];
    for (var p = 0, q = 0, i = 0; p < n; p++, q += 4, i += 4) {
      var inv = 1 - alpha[p] / 255;
      rgba[q] = rgba[q] - k0 * inv;
      rgba[q + 1] = rgba[q + 1] - k1 * inv;
      rgba[q + 2] = rgba[q + 2] - k2 * inv;
      rgba[q + 3] = alpha[p];
    }
    return rgba;
  }

  // ---- generative color fill (color-dot layers) ----
  // A color dot sits on a "fill" layer below the line art it colors. The dot
  // flood-fills the connected region of the layer ABOVE (the source) that is
  // transparent enough, bounded by its ink: pixels whose alpha is above the
  // dot's threshold are barriers (line art strokes), everything else is
  // fillable. The returned mask can be grown (fillDilate) to tuck the color
  // under anti-aliased edges, then painted with fillPaint.
  //
  // The fill functions carry a `.bounds` property on the mask ({ x0, y0, x1,
  // y1 }, inclusive) so the grow and paint steps can stay inside the region
  // instead of re-scanning the whole canvas; byte-identical output, but the
  // cost scales with the filled area instead of the canvas.

  // Flood-fill mask from a seed pixel. Returns a Uint8Array(n) mask (1 = fill)
  // or null when the seed sits on ink (alpha above the threshold) or outside
  // the canvas. Iterative 4-connected scanline fill; each pixel is visited a
  // constant number of times regardless of the region size.
  function fillFlood(src, w, h, sx, sy, threshold) {
    sx = Math.round(sx); sy = Math.round(sy);
    if (sx < 0 || sx >= w || sy < 0 || sy >= h) return null;
    var bar = Math.round(Math.min(1, Math.max(0, threshold)) * 255);
    var seed = (sy * w + sx) * 4;
    if (src[seed + 3] > bar) return null; // seed on ink: nothing to fill
    var n = w * h;
    var mask = new Uint8Array(n);
    var bx0 = w, by0 = h, bx1 = -1, by1 = -1;
    var stack = [sx, sy]; // x,y pairs; JS array grows safely for any region
    while (stack.length) {
      var y = stack.pop();
      var x = stack.pop();
      var i = y * w + x;
      if (mask[i]) continue;
      // Expand the fillable run through (x, y) to its full width.
      var l = x;
      while (l > 0) {
        var li = y * w + l - 1;
        if (mask[li] || src[li * 4 + 3] > bar) break;
        l--;
      }
      var r = x;
      while (r < w - 1) {
        var ri = y * w + r + 1;
        if (mask[ri] || src[ri * 4 + 3] > bar) break;
        r++;
      }
      for (var xx = l; xx <= r; xx++) mask[y * w + xx] = 1;
      if (l < bx0) bx0 = l;
      if (r > bx1) bx1 = r;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
      // Seed new runs on the scanlines above and below, inside this run.
      for (var yy = y - 1; yy <= y + 1; yy += 2) {
        if (yy < 0 || yy >= h) continue;
        var row = yy * w;
        var inRun = false;
        for (var xx2 = l; xx2 <= r; xx2++) {
          var idx = row + xx2;
          if (!mask[idx] && src[idx * 4 + 3] <= bar) {
            if (!inRun) { stack.push(xx2, yy); inRun = true; }
          } else {
            inRun = false;
          }
        }
      }
    }
    mask.bounds = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    return mask;
  }

  // Bounding box of a mask's filled pixels (inclusive), or null when empty.
  function maskBounds(mask, w, h) {
    var x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        if (mask[row + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  // Grow a fill mask outward by `grow` pixels (4-connected). Uses a two-pass
  // 3-4 chamfer distance transform on the background, so the cost is O(n)
  // regardless of how large grow is (iterative dilation would be O(n·grow)).
  // Chamfer distance units are 3 per orthogonal step, so a pixel is included
  // when its distance is at most grow*3. When `bounds` is given the transform
  // runs only inside the bbox padded by `grow`; byte-identical to running on
  // the whole canvas (pixels further than grow from the mask are untouched),
  // but the cost scales with the region, not the canvas.
  function fillDilate(mask, w, h, grow, bounds) {
    if (!(grow > 0)) return mask;
    var bx0 = 0, by0 = 0, bx1 = w - 1, by1 = h - 1;
    if (bounds) {
      bx0 = Math.max(0, bounds.x0 - grow);
      by0 = Math.max(0, bounds.y0 - grow);
      bx1 = Math.min(w - 1, bounds.x1 + grow);
      by1 = Math.min(h - 1, bounds.y1 + grow);
    }
    var bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    var BIG = 1 << 20;
    var dist = new Int32Array(bw * bh);
    var p, d;
    // Forward pass: distances propagate from the top/left.
    for (var y = 0; y < bh; y++) {
      var row = y * bw;
      var gy = y + by0;
      for (var x = 0; x < bw; x++) {
        p = row + x;
        if (mask[gy * w + (x + bx0)]) { dist[p] = 0; continue; }
        d = BIG;
        if (x > 0) { var dl = dist[p - 1] + 3; if (dl < d) d = dl; }
        if (y > 0) { var du = dist[p - bw] + 3; if (du < d) d = du; }
        if (x > 0 && y > 0) { var dul = dist[p - bw - 1] + 4; if (dul < d) d = dul; }
        if (x < bw - 1 && y > 0) { var dur = dist[p - bw + 1] + 4; if (dur < d) d = dur; }
        dist[p] = d;
      }
    }
    // Backward pass: finish distances from the bottom/right, emit the mask.
    var out = new Uint8Array(mask.length);
    var limit = grow * 3;
    for (var y2 = bh - 1; y2 >= 0; y2--) {
      var row2 = y2 * bw;
      var gy2 = y2 + by0;
      for (var x2 = bw - 1; x2 >= 0; x2--) {
        p = row2 + x2;
        d = dist[p];
        if (x2 < bw - 1) { var dr = dist[p + 1] + 3; if (dr < d) d = dr; }
        if (y2 < bh - 1) { var dd = dist[p + bw] + 3; if (dd < d) d = dd; }
        if (x2 > 0 && y2 < bh - 1) { var ddl = dist[p + bw - 1] + 4; if (ddl < d) d = ddl; }
        if (x2 < bw - 1 && y2 < bh - 1) { var ddr = dist[p + bw + 1] + 4; if (ddr < d) d = ddr; }
        dist[p] = d;
        if (d <= limit) out[gy2 * w + (x2 + bx0)] = 1;
      }
    }
    out.bounds = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    return out;
  }

  // Paint a fill mask into an RGBA buffer with a solid color (opaque). When
  // `bounds` is given, only the region inside it is scanned (the mask is empty
  // elsewhere). `w` is required for the bounded path.
  function fillPaint(rgba, mask, n, color, w, bounds) {
    var r = color[0], g = color[1], b = color[2];
    if (bounds && w) {
      for (var y = bounds.y0; y <= bounds.y1; y++) {
        var row = y * w;
        for (var x = bounds.x0; x <= bounds.x1; x++) {
          var p = row + x;
          if (mask[p]) {
            var q = p * 4;
            rgba[q] = r; rgba[q + 1] = g; rgba[q + 2] = b; rgba[q + 3] = 255;
          }
        }
      }
    } else {
      for (var p2 = 0, q2 = 0; p2 < n; p2++, q2 += 4) {
        if (mask[p2]) {
          rgba[q2] = r; rgba[q2 + 1] = g; rgba[q2 + 2] = b; rgba[q2 + 3] = 255;
        }
      }
    }
    return rgba;
  }

  function fillPaintGradient(rgba, mask, n, colorA, colorB, dir, gradH, w, bounds) {
    if (!gradH || gradH <= 0 || !colorB) return fillPaint(rgba, mask, n, colorA, w, bounds);
    var rTop = colorA[0], gTop = colorA[1], bTop = colorA[2];
    var rBot = colorB[0], gBot = colorB[1], bBot = colorB[2];
    var h = gradH | 0;
    if (h < 1) h = 1;
    var x0 = bounds ? bounds.x0 : 0;
    var y0 = bounds ? bounds.y0 : 0;
    var x1 = bounds ? bounds.x1 : w - 1;
    var y1 = bounds ? bounds.y1 : 0;
    if (!bounds) {
      var bb = maskBounds(mask, w, Math.floor(n / w));
      if (bb) { x0 = bb.x0; y0 = bb.y0; x1 = bb.x1; y1 = bb.y1; }
    }
    if (dir === 'top' || dir === 'bottom' || dir === 'left' || dir === 'right') {
      if (bounds && w) {
        for (var y = y0; y <= y1; y++) {
          var row = y * w;
          for (var x = x0; x <= x1; x++) {
            var p = row + x;
            if (!mask[p]) continue;
            var t;
            if (dir === 'top') t = (y - y0) / h;
            else if (dir === 'bottom') t = (y1 - y) / h;
            else if (dir === 'left') t = (x - x0) / h;
            else t = (x1 - x) / h;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            var u = 1 - t;
            var q = p * 4;
            rgba[q] = (rTop * u + rBot * t) | 0;
            rgba[q + 1] = (gTop * u + gBot * t) | 0;
            rgba[q + 2] = (bTop * u + bBot * t) | 0;
            rgba[q + 3] = 255;
          }
        }
      } else {
        for (var p2 = 0, q2 = 0; p2 < n; p2++, q2 += 4) {
          if (!mask[p2]) continue;
          var yy = (p2 / w) | 0, xx = p2 % w;
          var tt;
          if (dir === 'top') tt = (yy - y0) / h;
          else if (dir === 'bottom') tt = (y1 - yy) / h;
          else if (dir === 'left') tt = (xx - x0) / h;
          else tt = (x1 - xx) / h;
          if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
          var uu = 1 - tt;
          rgba[q2] = (rTop * uu + rBot * tt) | 0;
          rgba[q2 + 1] = (gTop * uu + gBot * tt) | 0;
          rgba[q2 + 2] = (bTop * uu + bBot * tt) | 0;
          rgba[q2 + 3] = 255;
        }
      }
      return rgba;
    }
    return fillPaint(rgba, mask, n, colorA, w, bounds);
  }

  // Parse "#rrggbb" into [r, g, b]; returns null for anything else.
  function parseHexColor(hex) {
    if (typeof hex !== 'string') return null;
    var m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    var v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  return {
    computeFlow: computeFlow,
    computeFlowBoth: computeFlowBoth,
    warpFrame: warpFrame,
    smoothRGBA: smoothRGBA,
    gateFill: gateFill,
    morphFrame: morphFrame,
    morphFrameMesh: morphFrameMesh,
    motionBlurFrame: motionBlurFrame,
    squashStretchFrame: squashStretchFrame,
    warpAlpha: warpAlpha,
    synthesizeInbetweenFrame: synthesizeInbetweenFrame,
    buildMeshes: buildMeshes,
    blendFrame: blendFrame,
    isOpaque: isOpaque,
    buffersEqual: buffersEqual,
    sameAlpha: sameAlpha,
    pickKeyColor: pickKeyColor,
    encodeMatte: encodeMatte,
    removeKey: removeKey,
    extendTexture: extendTexture,
    flowBgColor: flowBgColor,
    warpAlphaDense: warpAlphaDense,
    alphaToGray: alphaToGray,
    applyGrayAlpha: applyGrayAlpha,
    applyGrayAlphaRaw: applyGrayAlphaRaw,
    floodFillMask: fillFlood,
    dilateMask: fillDilate,
    paintMask: fillPaint,
    paintGradient: fillPaintGradient,
    maskBounds: maskBounds,
    parseHexColor: parseHexColor
  };
})();
