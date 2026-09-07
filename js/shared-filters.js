/* ============================================================
   shared-filters.js
   The actual non-AI pixel-processing math — Sobel edge detection,
   box-blur (Gaussian approximation), bilateral-lite edge-aware
   smoothing, high-pass detail/local-contrast boosting, and
   adaptive halo-suppressed unsharp sharpening — factored out of
   the image pipeline so the video pipeline calls the *identical*
   functions instead of a re-implemented copy. Both js/worker.js
   (image tiles) and workers/video-worker.js (video frames) load
   this file via importScripts() and call these functions directly;
   neither defines its own version of any function below.

   Every function here is pure: it takes a {width,height,data}
   buffer (and plain numbers/typed arrays) and returns a new one,
   with no dependency on tiling, OffscreenCanvas, or any other
   caller-specific machinery — that's what makes it safe to share
   between a tiled-image caller and a per-frame-video caller with
   very different surrounding orchestration.
   ============================================================ */

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

function luma(data, i) { return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; }

/** Grayscale + Sobel gradient magnitude (edge strength), used to
 *  drive adaptive sharpening and the text/logo protection mask. */
function computeGrayAndSobel(buf) {
  const { width: w, height: h, data } = buf;
  const gray = new Float32Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) gray[p] = luma(data, i);

  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const gx = -gray[p - w - 1] + gray[p - w + 1] - 2 * gray[p - 1] + 2 * gray[p + 1] - gray[p + w - 1] + gray[p + w + 1];
      const gy = -gray[p - w - 1] - 2 * gray[p - w] - gray[p - w + 1] + gray[p + w - 1] + 2 * gray[p + w] + gray[p + w + 1];
      mag[p] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return { gray, mag };
}

function normalizeMask(mag, w, h, threshold) {
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.min(1, mag[i] / threshold);
  return out;
}

/** 3x3 max-dilation — widens a thin edge mask enough to cover
 *  glyph interiors, not just their outlines. */
function dilateMask3(mask, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const v = mask[yy * w + xx];
          if (v > m) m = v;
        }
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

/** Classic RGB skin-tone heuristic (Kovac et al.) combined with a
 *  low local-edge-magnitude requirement, so it flags smooth,
 *  skin-colored regions (cheeks, forehead) and NOT eyes/hair/
 *  eyebrows/lips, which stay normally sharpened. This is a color
 *  heuristic, not face detection — it will mis-flag e.g. wood,
 *  some skies at sunset, or terracotta surfaces, which is exactly
 *  why it's an opt-in toggle rather than always-on. */
function computeSkinMask(buf, mag) {
  const { width: w, height: h, data } = buf;
  const out = new Float32Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const isSkinColor = r > 95 && g > 40 && b > 20 && (max - min) > 15 && Math.abs(r - g) > 15 && r > g && r > b;
    out[p] = (isSkinColor && mag[p] < 25) ? 1 : 0;
  }
  return out;
}

function extractChannel(data, w, h, ch) {
  const out = new Float32Array(w * h);
  for (let p = 0, i = ch; p < w * h; p++, i += 4) out[p] = data[i];
  return out;
}

function boxBlur1DH(chan, w, h, radius) {
  const out = new Float32Array(w * h);
  const norm = 1 / (2 * radius + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k < 0 ? 0 : x + k >= w ? w - 1 : x + k;
        sum += chan[row + xx];
      }
      out[row + x] = sum * norm;
    }
  }
  return out;
}
function boxBlur1DV(chan, w, h, radius) {
  const out = new Float32Array(w * h);
  const norm = 1 / (2 * radius + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k < 0 ? 0 : y + k >= h ? h - 1 : y + k;
        sum += chan[yy * w + x];
      }
      out[y * w + x] = sum * norm;
    }
  }
  return out;
}
/** Separable box blur — a fast, well-understood approximation of
 *  a Gaussian blur, used as the low-pass base for unsharp
 *  masking, high-pass detail extraction, and local contrast. */
function boxBlur(chan, w, h, radius) {
  return boxBlur1DV(boxBlur1DH(chan, w, h, radius), w, h, radius);
}

/** Edge-aware smoothing ("bilateral-lite"): averages each pixel
 *  with its spatial neighborhood, but weights each neighbor by
 *  how close its color is to the center pixel's — so it smooths
 *  flat/noisy regions while leaving real edges largely alone.
 *  This single function backs both Noise Reduction and JPEG
 *  Artifact Removal (different radius/threshold presets); when
 *  Text/Logo Protection is on, `textMask` blends the filtered
 *  result back toward the original in high-edge-density regions. */
function bilateralLite(buf, radius, rangeThreshold, textMask, protectStrength) {
  const { width: w, height: h, data } = buf;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4;
      const cr = data[i], cg = data[i + 1], cb = data[i + 2];
      let sr = 0, sg = 0, sb = 0, wsum = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
          const j = (yy * w + xx) * 4;
          const nr = data[j], ng = data[j + 1], nb = data[j + 2];
          const diff = Math.abs(nr - cr) + Math.abs(ng - cg) + Math.abs(nb - cb);
          const wgt = Math.max(0, 1 - diff / rangeThreshold);
          sr += nr * wgt; sg += ng * wgt; sb += nb * wgt; wsum += wgt;
        }
      }
      let fr = cr, fg = cg, fb = cb;
      if (wsum > 0) { fr = sr / wsum; fg = sg / wsum; fb = sb / wsum; }
      const strength = protectStrength > 0 ? (1 - protectStrength * textMask[p]) : 1;
      out[i] = clamp255(cr + (fr - cr) * strength);
      out[i + 1] = clamp255(cg + (fg - cg) * strength);
      out[i + 2] = clamp255(cb + (fb - cb) * strength);
      out[i + 3] = data[i + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/** High-pass detail boost: original + amount * (original - blur).
 *  A small-radius high-pass recovers fine texture that resampling
 *  softens, distinct from edge sharpening (which targets larger,
 *  higher-contrast transitions). */
function applyDetail(buf, amount) {
  const { width: w, height: h, data } = buf;
  const R = extractChannel(data, w, h, 0), G = extractChannel(data, w, h, 1), B = extractChannel(data, w, h, 2);
  const br = boxBlur(R, w, h, 3), bg = boxBlur(G, w, h, 3), bb = boxBlur(B, w, h, 3);
  const out = new Uint8ClampedArray(data.length);
  const k = amount * 1.5;
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    out[i] = clamp255(R[p] + (R[p] - br[p]) * k);
    out[i + 1] = clamp255(G[p] + (G[p] - bg[p]) * k);
    out[i + 2] = clamp255(B[p] + (B[p] - bb[p]) * k);
    out[i + 3] = data[i + 3];
  }
  return { width: w, height: h, data: out };
}

/** Local contrast ("clarity"): same high-pass-add technique as
 *  detail enhancement, but with a much larger blur radius, so it
 *  boosts mid-scale tonal contrast rather than fine texture. Fixed,
 *  modest weight — this is a toggle, not a slider, by design. */
function applyLocalContrast(buf) {
  const { width: w, height: h, data } = buf;
  const R = extractChannel(data, w, h, 0), G = extractChannel(data, w, h, 1), B = extractChannel(data, w, h, 2);
  const br = boxBlur(R, w, h, 7), bg = boxBlur(G, w, h, 7), bb = boxBlur(B, w, h, 7);
  const amount = 0.22;
  const out = new Uint8ClampedArray(data.length);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    out[i] = clamp255(R[p] + (R[p] - br[p]) * amount);
    out[i + 1] = clamp255(G[p] + (G[p] - bg[p]) * amount);
    out[i + 2] = clamp255(B[p] + (B[p] - bb[p]) * amount);
    out[i + 3] = data[i + 3];
  }
  return { width: w, height: h, data: out };
}

/** Adaptive unsharp-mask sharpening. The correction amount is
 *  scaled per-pixel by local edge strength (smooth regions get a
 *  gentle 0.4x touch, high-frequency/text regions up to 1.6x), and
 *  reduced in skin-colored smooth regions when Portrait Protection
 *  is on. A local min/max clamp (with a small tolerance) on the
 *  result prevents the white/black ringing halos that plain
 *  unsharp masking produces around strong edges. */
function applySharpen(buf, sharpAmount, edgeMask, skinMask, portraitProtect) {
  const { width: w, height: h, data } = buf;
  const R = extractChannel(data, w, h, 0), G = extractChannel(data, w, h, 1), B = extractChannel(data, w, h, 2);
  const br = boxBlur(R, w, h, 1), bg = boxBlur(G, w, h, 1), bb = boxBlur(B, w, h, 1);
  const out = new Uint8ClampedArray(data.length);
  const base = sharpAmount * 2.2;
  const tol = 12;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4;
      let factor = 0.4 + 1.2 * edgeMask[p];
      if (portraitProtect && skinMask) factor *= (1 - 0.6 * skinMask[p]);
      const amt = base * factor;

      let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
          const q = yy * w + xx;
          if (R[q] < minR) minR = R[q]; if (R[q] > maxR) maxR = R[q];
          if (G[q] < minG) minG = G[q]; if (G[q] > maxG) maxG = G[q];
          if (B[q] < minB) minB = B[q]; if (B[q] > maxB) maxB = B[q];
        }
      }

      let sr = R[p] + (R[p] - br[p]) * amt;
      let sg = G[p] + (G[p] - bg[p]) * amt;
      let sb = B[p] + (B[p] - bb[p]) * amt;
      sr = Math.min(maxR + tol, Math.max(minR - tol, sr));
      sg = Math.min(maxG + tol, Math.max(minG - tol, sg));
      sb = Math.min(maxB + tol, Math.max(minB - tol, sb));

      out[i] = clamp255(sr); out[i + 1] = clamp255(sg); out[i + 2] = clamp255(sb); out[i + 3] = data[i + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/* ============================================================
   Color & tone stages — beyond sharpness. Auto white balance,
   auto levels, vibrance, shadow/highlight recovery, and CLAHE
   (Contrast-Limited Adaptive Histogram Equalization). Every one
   of these is a real, published, decades-old technique used in
   professional photo tools — none of it is AI, and none of it
   invents color or detail that isn't derivable from the source
   pixels.
   ============================================================ */

function computeChannelMeans(buf) {
  const { width: w, height: h, data } = buf;
  const n = w * h;
  let sr = 0, sg = 0, sb = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) { sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; }
  return { r: sr / n, g: sg / n, b: sb / n };
}

/** Gray-World auto white balance (von Kries / diagonal model): assumes
 *  the average color of a sufficiently varied scene is neutral gray,
 *  and scales each channel so its mean moves toward that gray target.
 *  `strength` (0..1) blends between the original and the fully
 *  corrected result, and per-channel gain is clamped to a moderate
 *  range so a scene that's genuinely dominated by one color (e.g. a
 *  sunset, a green field) doesn't get over-corrected toward gray. */
function applyAutoWhiteBalance(buf, strength) {
  const { width: w, height: h, data } = buf;
  const { r: mr, g: mg, b: mb } = computeChannelMeans(buf);
  if (mr < 1 || mg < 1 || mb < 1) return buf; // degenerate (near-black) buffer — skip
  const gray = (mr + mg + mb) / 3;
  const clampGain = (v) => Math.max(0.7, Math.min(1.5, v));
  const kr = 1 + (clampGain(gray / mr) - 1) * strength;
  const kg = 1 + (clampGain(gray / mg) - 1) * strength;
  const kb = 1 + (clampGain(gray / mb) - 1) * strength;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = clamp255(data[i] * kr);
    out[i + 1] = clamp255(data[i + 1] * kg);
    out[i + 2] = clamp255(data[i + 2] * kb);
    out[i + 3] = data[i + 3];
  }
  return { width: w, height: h, data: out };
}

/** Auto levels: per-channel percentile-clipped histogram stretch —
 *  finds the black/white point at `clipPercent`/`100-clipPercent` of
 *  each channel's histogram (so a few outlier pixels don't anchor the
 *  whole stretch) and remaps that range to the full 0-255 span. */
function applyAutoLevels(buf, clipPercent) {
  const { width: w, height: h, data } = buf;
  const n = w * h;
  const histR = new Uint32Array(256), histG = new Uint32Array(256), histB = new Uint32Array(256);
  for (let p = 0, i = 0; p < n; p++, i += 4) { histR[data[i]]++; histG[data[i + 1]]++; histB[data[i + 2]]++; }

  function findBounds(hist) {
    const clipCount = Math.max(1, Math.round(n * clipPercent / 100));
    let lo = 0, acc = 0;
    while (lo < 255) { acc += hist[lo]; if (acc >= clipCount) break; lo++; }
    let hi = 255; acc = 0;
    while (hi > 0) { acc += hist[hi]; if (acc >= clipCount) break; hi--; }
    if (hi <= lo) { lo = 0; hi = 255; }
    return { lo, hi };
  }
  const br = findBounds(histR), bg = findBounds(histG), bb = findBounds(histB);
  const scaleR = 255 / Math.max(1, br.hi - br.lo);
  const scaleG = 255 / Math.max(1, bg.hi - bg.lo);
  const scaleB = 255 / Math.max(1, bb.hi - bb.lo);

  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = clamp255((data[i] - br.lo) * scaleR);
    out[i + 1] = clamp255((data[i + 1] - bg.lo) * scaleG);
    out[i + 2] = clamp255((data[i + 2] - bb.lo) * scaleB);
    out[i + 3] = data[i + 3];
  }
  return { width: w, height: h, data: out };
}

/** Vibrance: boosts muted colors more than already-saturated ones
 *  (unlike a flat saturation multiply, which oversaturates skies and
 *  clips already-vivid colors equally), and specifically damps the
 *  boost in skin-tone hues (~5-45°) so portraits don't turn plastic-
 *  orange the way an aggressive flat saturation boost does. */
function applyVibrance(buf, amount) {
  if (amount <= 0) return buf;
  const { width: w, height: h, data } = buf;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const chroma = (max - min) / 255;

    let hue = 0;
    if (max !== min) {
      const d = max - min;
      if (max === r) hue = 60 * (((g - b) / d) % 6);
      else if (max === g) hue = 60 * ((b - r) / d + 2);
      else hue = 60 * ((r - g) / d + 4);
      if (hue < 0) hue += 360;
    }
    const skinDamp = (hue >= 5 && hue <= 45) ? 0.45 : 1;
    const boost = 1 + amount * (1 - chroma) * skinDamp * 1.8;
    const gray = (r + g + b) / 3;

    out[i] = clamp255(gray + (r - gray) * boost);
    out[i + 1] = clamp255(gray + (g - gray) * boost);
    out[i + 2] = clamp255(gray + (b - gray) * boost);
    out[i + 3] = data[i + 3];
  }
  return { width: w, height: h, data: out };
}

/** Shadow/highlight recovery: a luminance-masked tone lift/pull —
 *  shadows get lifted in proportion to how dark they already are
 *  (a quadratic falloff so midtones are barely touched), highlights
 *  get pulled down the same way from the bright end. The same delta
 *  is applied to all three channels so hue/saturation ratios are
 *  preserved rather than just brightening/darkening toward gray. */
function applyShadowHighlightRecovery(buf, shadowAmt, highlightAmt) {
  if (shadowAmt <= 0 && highlightAmt <= 0) return buf;
  const { width: w, height: h, data } = buf;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const l = luma(data, i) / 255;
    const shadowMask = Math.pow(1 - l, 2.2);
    const highlightMask = Math.pow(l, 2.2);
    const delta = shadowAmt * shadowMask * 70 - highlightAmt * highlightMask * 70;
    out[i] = clamp255(data[i] + delta);
    out[i + 1] = clamp255(data[i + 1] + delta);
    out[i + 2] = clamp255(data[i + 2] + delta);
    out[i + 3] = data[i + 3];
  }
  return { width: w, height: h, data: out };
}

/** CLAHE — Contrast-Limited Adaptive Histogram Equalization
 *  (Zuiderveld, Graphics Gems IV, 1994). Divides the buffer into a
 *  gridSize×gridSize grid of tiles, builds a per-tile luminance
 *  histogram, clips any bin above `clipLimit` (redistributing the
 *  clipped-off excess uniformly across all bins first — this is
 *  what keeps CLAHE from amplifying noise in flat regions the way
 *  plain histogram equalization does), turns each tile's histogram
 *  into a CDF-based lookup table, then bilinearly interpolates
 *  between the 4 nearest tile LUTs per pixel so tile boundaries
 *  don't show as seams. The result is applied as a luminance ratio
 *  to the original RGB (rather than replacing luminance outright),
 *  which keeps hue and saturation intact. */
function applyCLAHE(buf, clipLimit, gridSize) {
  const { width: w, height: h, data } = buf;
  const n = w * h;
  const lumaArr = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) lumaArr[p] = luma(data, i);

  const tilesX = gridSize, tilesY = gridSize;
  const tileW = Math.max(1, Math.ceil(w / tilesX));
  const tileH = Math.max(1, Math.ceil(h / tilesY));

  const luts = [];
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * tileW, y0 = ty * tileH;
      const x1 = Math.min(w, x0 + tileW), y1 = Math.min(h, y0 + tileH);
      const hist = new Float64Array(256);
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          hist[Math.max(0, Math.min(255, Math.round(lumaArr[y * w + x])))]++;
          count++;
        }
      }
      const clipCount = Math.max(1, Math.round(clipLimit * count / 256));
      let excess = 0;
      for (let b = 0; b < 256; b++) {
        if (hist[b] > clipCount) { excess += hist[b] - clipCount; hist[b] = clipCount; }
      }
      const redistribute = excess / 256;
      for (let b = 0; b < 256; b++) hist[b] += redistribute;

      const lut = new Float32Array(256);
      let cdf = 0;
      for (let b = 0; b < 256; b++) { cdf += hist[b]; lut[b] = cdf; }
      const total = cdf || 1;
      for (let b = 0; b < 256; b++) lut[b] = (lut[b] / total) * 255;
      luts.push(lut);
    }
  }

  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    const fy = (y - tileH / 2) / tileH;
    const ty0 = Math.floor(fy);
    const wy = fy - ty0;
    const ty0c = Math.max(0, Math.min(tilesY - 1, ty0));
    const ty1c = Math.max(0, Math.min(tilesY - 1, ty0 + 1));

    for (let x = 0; x < w; x++) {
      const fx = (x - tileW / 2) / tileW;
      const tx0 = Math.floor(fx);
      const wx = fx - tx0;
      const tx0c = Math.max(0, Math.min(tilesX - 1, tx0));
      const tx1c = Math.max(0, Math.min(tilesX - 1, tx0 + 1));

      const p = y * w + x;
      const v = Math.max(0, Math.min(255, Math.round(lumaArr[p])));

      const l00 = luts[ty0c * tilesX + tx0c][v];
      const l01 = luts[ty0c * tilesX + tx1c][v];
      const l10 = luts[ty1c * tilesX + tx0c][v];
      const l11 = luts[ty1c * tilesX + tx1c][v];
      const top = l00 * (1 - wx) + l01 * wx;
      const bot = l10 * (1 - wx) + l11 * wx;
      const newLuma = top * (1 - wy) + bot * wy;

      const ratio = lumaArr[p] > 1 ? newLuma / lumaArr[p] : 1;
      const i = p * 4;
      out[i] = clamp255(data[i] * ratio);
      out[i + 1] = clamp255(data[i + 1] * ratio);
      out[i + 2] = clamp255(data[i + 2] * ratio);
      out[i + 3] = data[i + 3];
    }
  }
  return { width: w, height: h, data: out };
}
