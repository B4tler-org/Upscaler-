/* ============================================================
   workers/video-worker.js
   Processes one video frame at a time. Resizing happens on the
   main thread as a single high-quality canvas draw (per-frame
   multi-pass Lanczos, as used for large image upscales, isn't
   realistic within a real-time per-frame budget — see README for
   why video resampling is intentionally single-pass bicubic-
   quality rather than the heavier image-pipeline treatment).
   This worker only runs the enhancement stages — denoise, JPEG-
   artifact-style cleanup, detail, local contrast, adaptive
   sharpen — on an already-correctly-sized frame, using the exact
   same functions from shared-filters.js as the image pipeline.

   No tiling here: a single video frame (even at 4K, ~8.3MP) is a
   perfectly reasonable one-shot buffer, and it's discarded the
   moment the next frame arrives, so there's no accumulation risk
   the way a full multi-megapixel image export has.
   ============================================================ */

importScripts('../js/shared-filters.js');

let currentConfig = normalizeVideoConfig({});

self.onmessage = (e) => {
  const { type } = e.data;

  if (type === 'configure') {
    currentConfig = normalizeVideoConfig(e.data.enhance);
    return;
  }

  if (type === 'processFrame') {
    const { frameId, bitmap, timestamp } = e.data;
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const buf = { width: canvas.width, height: canvas.height, data: imgData.data };
      const processed = processVideoFrame(buf, currentConfig);

      ctx.putImageData(new ImageData(processed.data, processed.width, processed.height), 0, 0);
      const outBitmap = canvas.transferToImageBitmap();
      self.postMessage({ type: 'processedFrame', frameId, bitmap: outBitmap, timestamp }, [outBitmap]);
    } catch (err) {
      self.postMessage({ type: 'frameError', frameId, message: err.message });
    }
    return;
  }
};

function normalizeVideoConfig(enhance) {
  enhance = enhance || {};
  return {
    noiseReduction: enhance.noiseReduction || 'off',
    denoiseArtifact: enhance.denoiseArtifact || 'off', // JPEG/compression-artifact-style cleanup
    detailAmount: enhance.detailAmount || 0,
    sharpAmount: enhance.sharpAmount || 0,
    localContrast: !!enhance.localContrast,
    vibrance: enhance.vibrance || 0,
    shadowRecovery: enhance.shadowRecovery || 0,
    highlightRecovery: enhance.highlightRecovery || 0
  };
}

// Video-tuned presets — smaller radii than the image pipeline's
// "High" settings, since this runs once per frame at real-time
// cadence rather than once per still image.
const VIDEO_NOISE_PRESETS = {
  low: { radius: 1, threshold: 35 },
  medium: { radius: 2, threshold: 55 }
};
const VIDEO_ARTIFACT_PRESETS = {
  low: { radius: 1, threshold: 45 },
  medium: { radius: 1, threshold: 65 }
};

/** One combined pass: denoise -> artifact cleanup -> detail ->
 *  local contrast -> shadow/highlight -> vibrance -> adaptive
 *  sharpen.
 *
 *  Deliberately NOT offered for video, and why: text/portrait
 *  protection (per-frame Sobel/skin heuristics), auto white
 *  balance, auto levels, and CLAHE all either use an un-smoothed
 *  per-frame heuristic mask or — worse — compute their correction
 *  from that individual frame's own global/regional pixel
 *  statistics (channel means, histograms, tile histograms). Scene
 *  content shifts slightly frame to frame even in a static shot
 *  (noise, micro camera-shake, compression), which would make
 *  those statistics drift and show up as visible brightness/color/
 *  contrast "breathing" — exactly the flicker the brief explicitly
 *  asked to avoid. Vibrance and shadow/highlight recovery are safe
 *  to include here because both are fixed, deterministic per-pixel
 *  functions with no dependency on frame-wide statistics: the same
 *  input pixel always produces the same output pixel, frame after
 *  frame, so there's nothing for them to drift. */
function processVideoFrame(buf, cfg) {
  let cur = buf;

  if (cfg.noiseReduction !== 'off' && VIDEO_NOISE_PRESETS[cfg.noiseReduction]) {
    const p = VIDEO_NOISE_PRESETS[cfg.noiseReduction];
    const zeroMask = new Float32Array(cur.width * cur.height);
    cur = bilateralLite(cur, p.radius, p.threshold, zeroMask, 0);
  }
  if (cfg.denoiseArtifact !== 'off' && VIDEO_ARTIFACT_PRESETS[cfg.denoiseArtifact]) {
    const p = VIDEO_ARTIFACT_PRESETS[cfg.denoiseArtifact];
    const zeroMask = new Float32Array(cur.width * cur.height);
    cur = bilateralLite(cur, p.radius, p.threshold, zeroMask, 0);
  }
  if (cfg.shadowRecovery > 0 || cfg.highlightRecovery > 0) {
    cur = applyShadowHighlightRecovery(cur, cfg.shadowRecovery, cfg.highlightRecovery);
  }
  if (cfg.detailAmount > 0) cur = applyDetail(cur, cfg.detailAmount);
  if (cfg.localContrast) cur = applyLocalContrast(cur);
  if (cfg.vibrance > 0) cur = applyVibrance(cur, cfg.vibrance);
  if (cfg.sharpAmount > 0) {
    const { mag } = computeGrayAndSobel(cur);
    const edgeMask = normalizeMask(mag, cur.width, cur.height, 60);
    cur = applySharpen(cur, cfg.sharpAmount, edgeMask, null, false);
  }
  return cur;
}
