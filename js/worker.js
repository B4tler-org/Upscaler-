/* ============================================================
   worker.js — UPRES traditional (non-AI) processing pipeline
   Runs entirely off the main thread. All stages are ordinary,
   published image-processing math: box-blur approximations of
   Gaussian blur, bilateral-style edge-aware smoothing, unsharp
   masking, high-pass detail boosting, Sobel edge detection, and
   a couple of honestly-labeled RGB heuristics (not real face
   detection) for text/logo and portrait protection.

   Pipeline order (matches the "clean before resample, enhance
   after" structure requested):
     resizeTo given:
       1. tiled cleanup pass at ORIGINAL resolution — noise
          reduction + JPEG artifact smoothing only
       2. progressive stepped resize (never more than 2x per
          step) to the target resolution
       3. tiled finishing pass at TARGET resolution — detail
          enhancement, local contrast, adaptive sharpening
     no resize (enhance-only):
       1. tiled full pass at native resolution running every
          enabled stage in one pipeline

   Tiling: every tile is read with `OVERLAP` extra px on each
   side (clamped at image edges) so every filter — including the
   two-pass box blurs used for detail/local-contrast — sees real
   neighbor data at the crop boundary, not tile-edge padding.
   ============================================================ */

const OVERLAP = 12;
const cancelledJobs = new Set();

const NOISE_PRESETS = {
  low: { radius: 1, threshold: 40 },
  medium: { radius: 2, threshold: 60 },
  high: { radius: 3, threshold: 90 }
};
const JPEG_PRESETS = {
  low: { radius: 1, threshold: 50 },
  medium: { radius: 2, threshold: 75 },
  high: { radius: 2, threshold: 110 }
};

self.onmessage = async (e) => {
  const { type, jobId } = e.data;

  if (type === 'cancel') { cancelledJobs.add(jobId); return; }

  if (type === 'analyze') {
    try {
      const metrics = analyzeBitmap(e.data.bitmap, jobId);
      self.postMessage({ type: 'analyzed', jobId, metrics });
    } catch (err) {
      self.postMessage({ type: 'error', jobId, message: err.message });
    }
    return;
  }

  if (type === 'cleanup' || type === 'finish' || type === 'full') {
    const { bitmap, width, height, tileSize, enhance } = e.data;
    try {
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      bitmap.close();
      const cfg = normalizeConfig(enhance);
      const tileFn =
        type === 'cleanup' ? (buf) => processTileCleanup(buf, cfg) :
        type === 'finish' ? (buf) => processTileFinish(buf, cfg) :
        (buf) => processTileFull(buf, cfg);

      const out = await runTiledPhase(canvas, width, height, tileSize, jobId, tileFn, 0, 100);
      if (cancelledJobs.has(jobId)) return postCancelled(jobId);

      const resultBitmap = out.transferToImageBitmap();
      self.postMessage({ type: 'done', jobId, bitmap: resultBitmap }, [resultBitmap]);
    } catch (err) {
      self.postMessage({ type: 'error', jobId, message: err.message });
    }
    return;
  }

  if (type === 'resize') {
    const { bitmap, width, height, dstW, dstH } = e.data;
    try {
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      bitmap.close();
      self.postMessage({ type: 'progress', jobId, pct: 10, stage: 'Multi-pass resampling' });
      const resized = progressiveResizeOffscreen(canvas, width, height, dstW, dstH);
      self.postMessage({ type: 'progress', jobId, pct: 95, stage: 'Resampled' });
      const resultBitmap = resized.transferToImageBitmap();
      self.postMessage({ type: 'done', jobId, bitmap: resultBitmap }, [resultBitmap]);
    } catch (err) {
      self.postMessage({ type: 'error', jobId, message: err.message });
    }
    return;
  }
};

function postCancelled(jobId) {
  cancelledJobs.delete(jobId);
  self.postMessage({ type: 'cancelled', jobId });
}

function normalizeConfig(enhance) {
  enhance = enhance || {};
  return {
    noiseReduction: enhance.noiseReduction || 'off',
    jpegArtifact: enhance.jpegArtifact || 'off',
    detailAmount: enhance.detailAmount || 0,
    sharpAmount: enhance.sharpAmount || 0,
    localContrast: !!enhance.localContrast,
    textProtection: !!enhance.textProtection,
    portraitProtection: !!enhance.portraitProtection
  };
}

// ============================================================
// Tiled phase runner — shared by all three pipeline phases.
// ============================================================
async function runTiledPhase(srcCanvas, width, height, tileSize, jobId, tileFn, pctFrom, pctTo) {
  const outCanvas = new OffscreenCanvas(width, height);
  const outCtx = outCanvas.getContext('2d');
  const srcCtx = srcCanvas.getContext('2d');

  const cols = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const total = cols * rows;
  let done = 0;

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      if (cancelledJobs.has(jobId)) return outCanvas;

      const x0 = tx * tileSize, y0 = ty * tileSize;
      const w = Math.min(tileSize, width - x0);
      const h = Math.min(tileSize, height - y0);

      const padX0 = Math.min(OVERLAP, x0);
      const padY0 = Math.min(OVERLAP, y0);
      const padX1 = Math.min(OVERLAP, width - (x0 + w));
      const padY1 = Math.min(OVERLAP, height - (y0 + h));

      const readX = x0 - padX0, readY = y0 - padY0;
      const readW = w + padX0 + padX1, readH = h + padY0 + padY1;

      const imgData = srcCtx.getImageData(readX, readY, readW, readH);
      const buf = { width: readW, height: readH, data: imgData.data };

      const processed = tileFn(buf);
      const outImgData = new ImageData(
        cropData(processed.data, readW, readH, padX0, padY0, w, h), w, h
      );
      outCtx.putImageData(outImgData, x0, y0);

      done++;
      const pct = pctFrom + ((done / total) * (pctTo - pctFrom));
      self.postMessage({ type: 'progress', jobId, pct: Math.round(pct) });
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return outCanvas;
}

function cropData(src, srcW, srcH, offX, offY, w, h) {
  if (offX === 0 && offY === 0 && srcW === w && srcH === h) return src;
  const out = new Uint8ClampedArray(w * h * 4);
  const srcStride = srcW * 4;
  for (let y = 0; y < h; y++) {
    const srcStart = (y + offY) * srcStride + offX * 4;
    out.set(src.subarray(srcStart, srcStart + w * 4), y * w * 4);
  }
  return out;
}

// ============================================================
// Progressive stepped resize (never more than 2x per step) —
// this IS the "multi-pass resizing for very large enlargement"
// requirement: a single 8x canvas.drawImage jump looks soft and
// aliased next to several <=2x steps.
// ============================================================
function progressiveResizeOffscreen(srcCanvas, srcW, srcH, dstW, dstH) {
  let curW = srcW, curH = srcH, cur = srcCanvas;
  while (curW !== dstW || curH !== dstH) {
    const ratio = dstW / curW;
    let nextW, nextH;
    if (Math.abs(ratio - 1) < 0.001) { nextW = dstW; nextH = dstH; }
    else if (ratio > 1) {
      const f = Math.min(2, ratio);
      nextW = Math.round(curW * f); nextH = Math.round(curH * f);
      if (nextW >= dstW * 0.98) { nextW = dstW; nextH = dstH; }
    } else {
      const f = Math.max(0.5, ratio);
      nextW = Math.round(curW * f); nextH = Math.round(curH * f);
      if (nextW <= dstW * 1.02) { nextW = dstW; nextH = dstH; }
    }
    const next = new OffscreenCanvas(nextW, nextH);
    const ctx = next.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, curW, curH, 0, 0, nextW, nextH);
    cur = next; curW = nextW; curH = nextH;
  }
  return cur;
}

// ============================================================
// Per-tile stage pipelines
// ============================================================
function processTileCleanup(buf, cfg) {
  const { mag } = computeGrayAndSobel(buf);
  const textMask = cfg.textProtection
    ? dilateMask3(normalizeMask(mag, buf.width, buf.height, 80), buf.width, buf.height)
    : new Float32Array(buf.width * buf.height);
  const protectStrength = cfg.textProtection ? 0.85 : 0;

  let cur = buf;
  if (cfg.noiseReduction !== 'off') {
    const p = NOISE_PRESETS[cfg.noiseReduction];
    cur = bilateralLite(cur, p.radius, p.threshold, textMask, protectStrength);
  }
  if (cfg.jpegArtifact !== 'off') {
    const p = JPEG_PRESETS[cfg.jpegArtifact];
    cur = bilateralLite(cur, p.radius, p.threshold, textMask, protectStrength);
  }
  return cur;
}

function processTileFinish(buf, cfg) {
  const { mag } = computeGrayAndSobel(buf);
  const skinMask = cfg.portraitProtection ? computeSkinMask(buf, mag) : null;

  let cur = buf;
  if (cfg.detailAmount > 0) cur = applyDetail(cur, cfg.detailAmount);
  if (cfg.localContrast) cur = applyLocalContrast(cur);
  if (cfg.sharpAmount > 0) {
    const edgeMask = normalizeMask(mag, buf.width, buf.height, 60);
    cur = applySharpen(cur, cfg.sharpAmount, edgeMask, skinMask, cfg.portraitProtection);
  }
  return cur;
}

function processTileFull(buf, cfg) {
  const { mag } = computeGrayAndSobel(buf);
  const textMask = cfg.textProtection
    ? dilateMask3(normalizeMask(mag, buf.width, buf.height, 80), buf.width, buf.height)
    : new Float32Array(buf.width * buf.height);
  const protectStrength = cfg.textProtection ? 0.85 : 0;
  const skinMask = cfg.portraitProtection ? computeSkinMask(buf, mag) : null;

  let cur = buf;
  if (cfg.noiseReduction !== 'off') {
    const p = NOISE_PRESETS[cfg.noiseReduction];
    cur = bilateralLite(cur, p.radius, p.threshold, textMask, protectStrength);
  }
  if (cfg.jpegArtifact !== 'off') {
    const p = JPEG_PRESETS[cfg.jpegArtifact];
    cur = bilateralLite(cur, p.radius, p.threshold, textMask, protectStrength);
  }
  if (cfg.detailAmount > 0) cur = applyDetail(cur, cfg.detailAmount);
  if (cfg.localContrast) cur = applyLocalContrast(cur);
  if (cfg.sharpAmount > 0) {
    const edgeMask = normalizeMask(mag, buf.width, buf.height, 60);
    cur = applySharpen(cur, cfg.sharpAmount, edgeMask, skinMask, cfg.portraitProtection);
  }
  return cur;
}

// ============================================================
// Building blocks
// ============================================================
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

// ============================================================
// Quality analysis — measurable, published metrics only.
//   sharpness   = variance of the Laplacian (no-reference focus
//                 metric; higher = crisper)
//   edgeDensity = % of pixels with Sobel magnitude above a fixed
//                 threshold
//   noiseSigma  = Immerkær's fast noise estimator (real published
//                 formula, not a guess)
// Computed on a downsampled grayscale sample (max 512px on the
// long edge) so this is fast regardless of source size.
// ============================================================
function analyzeBitmap(bitmap, jobId) {
  const maxDim = 512;
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const sw = Math.max(2, Math.round(bitmap.width * scale));
  const sh = Math.max(2, Math.round(bitmap.height * scale));
  const c = new OffscreenCanvas(sw, sh);
  const ctx = c.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, sw, sh);
  bitmap.close();
  const data = ctx.getImageData(0, 0, sw, sh).data;

  const gray = new Float32Array(sw * sh);
  for (let p = 0, i = 0; p < sw * sh; p++, i += 4) gray[p] = luma(data, i);

  let lapSum = 0, lapSumSq = 0, n = 0, edgeCount = 0, noiseAbsSum = 0;
  const SOBEL_THRESHOLD = 60;

  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const p = y * sw + x;
      const lap = -4 * gray[p] + gray[p - 1] + gray[p + 1] + gray[p - sw] + gray[p + sw];
      lapSum += lap; lapSumSq += lap * lap; n++;

      const gx = -gray[p - sw - 1] + gray[p - sw + 1] - 2 * gray[p - 1] + 2 * gray[p + 1] - gray[p + sw - 1] + gray[p + sw + 1];
      const gy = -gray[p - sw - 1] - 2 * gray[p - sw] - gray[p - sw + 1] + gray[p + sw - 1] + 2 * gray[p + sw] + gray[p + sw + 1];
      if (Math.sqrt(gx * gx + gy * gy) > SOBEL_THRESHOLD) edgeCount++;

      const nz = gray[p - sw - 1] - 2 * gray[p - sw] + gray[p - sw + 1]
        - 2 * gray[p - 1] + 4 * gray[p] - 2 * gray[p + 1]
        + gray[p + sw - 1] - 2 * gray[p + sw] + gray[p + sw + 1];
      noiseAbsSum += Math.abs(nz);
    }
  }
  const lapMean = lapSum / n;
  const sharpness = (lapSumSq / n) - (lapMean * lapMean);
  const edgeDensity = (edgeCount / n) * 100;
  const noiseSigma = Math.sqrt(Math.PI / 2) / (6 * (sw - 2) * (sh - 2)) * noiseAbsSum;

  return {
    sharpness: Math.round(sharpness),
    edgeDensity: +edgeDensity.toFixed(1),
    noiseSigma: +noiseSigma.toFixed(2)
  };
}
