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
