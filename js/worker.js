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

importScripts('shared-filters.js');

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

// clamp255, luma, computeGrayAndSobel, normalizeMask, dilateMask3,
// computeSkinMask, extractChannel, boxBlur(1DH/1DV), bilateralLite,
// applyDetail, applyLocalContrast, applySharpen all live in
// shared-filters.js now (loaded via importScripts at the top of this
// file) so the image and video pipelines run the exact same math.


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
