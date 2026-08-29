/* ============================================================
   ai-engine.js
   Optional "AI Super Resolution" tier.

   This does NOT ship with a bundled model — model weights for a
   real super-resolution network are tens of megabytes and it
   would be dishonest to silently point at a third-party URL that
   might move, break, or that you haven't reviewed the license of.

   Instead: this file defines exactly where the app looks for a
   model (./models/realesr-general-x4v3.onnx by default) and how
   it runs it. If the file isn't there, or onnxruntime-web / the
   model fails to load for any reason, `isAvailable()` returns
   false and the app honestly falls back to the GPU/CPU tier and
   labels the output accordingly — per the app's own "Processing
   Information" panel.

   See README.md -> "How to add a real AI super-resolution model"
   for exactly how to source and drop in a working .onnx file.
   ============================================================ */

const AIEngine = (() => {
  const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.min.js';

  const MODEL_CONFIG = {
    url: './models/realesr-general-x4v3.onnx',
    scale: 4,             // output is `scale`x the input tile in each dimension
    tileSize: 128,         // input tile edge length in px (before scale)
    overlap: 8,            // input-space overlap between tiles, in px
    inputName: 'input',    // adjust to match your model's actual input tensor name
    outputName: 'output',  // adjust to match your model's actual output tensor name
    channels: 3
  };

  let ortLoaded = false;
  let session = null;
  let loadAttempted = false;
  let lastError = null;

  // Lightweight check: does a model file exist at the configured path?
  // Uses HEAD only — does not download the model or the ~1MB ort runtime.
  // Safe to call on page load to populate the UI status badge.
  async function checkModelPresence() {
    try {
      const res = await fetch(MODEL_CONFIG.url, { method: 'HEAD' });
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load onnxruntime-web from CDN'));
      document.head.appendChild(s);
    });
  }

  // Attempts to lazily load onnxruntime-web + the model. Safe to
  // call multiple times; only does the work once. Never throws —
  // check isAvailable()/getLastError() instead, so the caller can
  // always fall back cleanly.
  async function init(onStatus) {
    if (loadAttempted) return isAvailable();
    loadAttempted = true;
    const status = onStatus || (() => {});

    try {
      status('Loading AI runtime…');
      if (typeof ort === 'undefined') {
        await loadScript(ORT_CDN);
      }
      ortLoaded = typeof ort !== 'undefined';
      if (!ortLoaded) throw new Error('onnxruntime-web did not initialize');

      // Prefer WebGPU, then WASM. Never assume WebGPU works even if
      // navigator.gpu exists — actually try, and fall back per-provider.
      status('Checking model file…');
      const headCheck = await fetch(MODEL_CONFIG.url, { method: 'HEAD' }).catch(() => null);
      if (!headCheck || !headCheck.ok) {
        throw new Error(
          `No model found at ${MODEL_CONFIG.url}. AI mode requires you to add a model file — see README.`
        );
      }

      status('Loading AI model…');
      const providers = [];
      if (navigator.gpu) providers.push('webgpu');
      providers.push('wasm');

      session = await ort.InferenceSession.create(MODEL_CONFIG.url, {
        executionProviders: providers,
        graphOptimizationLevel: 'all'
      });

      return true;
    } catch (err) {
      lastError = err.message || String(err);
      session = null;
      return false;
    }
  }

  function isAvailable() {
    return !!session;
  }

  function getLastError() {
    return lastError;
  }

  // ---- tensor <-> canvas helpers ----
  function imageDataToTensorCHW(imgData) {
    const { data, width, height } = imgData;
    const floatData = new Float32Array(3 * width * height);
    const plane = width * height;
    for (let i = 0; i < plane; i++) {
      floatData[i] = data[i * 4] / 255;               // R
      floatData[plane + i] = data[i * 4 + 1] / 255;     // G
      floatData[2 * plane + i] = data[i * 4 + 2] / 255; // B
    }
    return new ort.Tensor('float32', floatData, [1, 3, height, width]);
  }

  function tensorCHWToImageData(tensor) {
    const [, , h, w] = tensor.dims;
    const src = tensor.data;
    const plane = w * h;
    const out = new ImageData(w, h);
    const dst = out.data;
    for (let i = 0; i < plane; i++) {
      dst[i * 4] = clamp255(src[i] * 255);
      dst[i * 4 + 1] = clamp255(src[plane + i] * 255);
      dst[i * 4 + 2] = clamp255(src[2 * plane + i] * 255);
      dst[i * 4 + 3] = 255;
    }
    return out;
  }

  function clamp255(v) { return Math.max(0, Math.min(255, v)); }

  /**
   * Tiled AI upscale. Runs the model tile-by-tile (with input-space
   * overlap that's cropped after inference) so memory stays bounded
   * regardless of source image size, then hands back a canvas at
   * source*scale resolution — the caller runs a normal resize as a
   * finishing step to hit the exact requested output dimensions.
   */
  async function upscaleTiled(sourceEl, srcW, srcH, onProgress, isCancelled) {
    if (!isAvailable()) throw new Error('AI engine not available: ' + (lastError || 'model not loaded'));

    const { tileSize, overlap, scale } = MODEL_CONFIG;
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = srcW; srcCanvas.height = srcH;
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(sourceEl, 0, 0);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = srcW * scale;
    outCanvas.height = srcH * scale;
    const outCtx = outCanvas.getContext('2d');

    const cols = Math.ceil(srcW / tileSize);
    const rows = Math.ceil(srcH / tileSize);
    const total = cols * rows;
    let done = 0;

    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        if (isCancelled && isCancelled()) {
          const err = new Error('Cancelled');
          err.cancelled = true;
          throw err;
        }
        const x0 = tx * tileSize;
        const y0 = ty * tileSize;
        const w = Math.min(tileSize, srcW - x0);
        const h = Math.min(tileSize, srcH - y0);

        const padX0 = Math.min(overlap, x0);
        const padY0 = Math.min(overlap, y0);
        const padX1 = Math.min(overlap, srcW - (x0 + w));
        const padY1 = Math.min(overlap, srcH - (y0 + h));

        const readX = x0 - padX0, readY = y0 - padY0;
        const readW = w + padX0 + padX1, readH = h + padY0 + padY1;

        const tileData = srcCtx.getImageData(readX, readY, readW, readH);
        const inputTensor = imageDataToTensorCHW(tileData);

        const feeds = {};
        feeds[MODEL_CONFIG.inputName] = inputTensor;
        const results = await session.run(feeds);
        const outputTensor = results[MODEL_CONFIG.outputName];
        const outImgData = tensorCHWToImageData(outputTensor);

        // crop off the (now scale*overlap-sized) padding in output space
        const cropX = padX0 * scale, cropY = padY0 * scale;
        const cropW = w * scale, cropH = h * scale;
        const cropped = cropImageDataMain(outImgData, cropX, cropY, cropW, cropH);

        const tileCanvas = document.createElement('canvas');
        tileCanvas.width = cropW; tileCanvas.height = cropH;
        tileCanvas.getContext('2d').putImageData(cropped, 0, 0);
        outCtx.drawImage(tileCanvas, x0 * scale, y0 * scale);

        done++;
        if (onProgress) onProgress(Math.round((done / total) * 100));
        await new Promise(r => setTimeout(r, 0)); // keep UI responsive between tiles
      }
    }

    return outCanvas;
  }

  function cropImageDataMain(imgData, offX, offY, w, h) {
    if (offX === 0 && offY === 0 && imgData.width === w && imgData.height === h) return imgData;
    const out = new ImageData(w, h);
    const src = imgData.data, dst = out.data;
    const srcStride = imgData.width * 4;
    for (let y = 0; y < h; y++) {
      const srcStart = (y + offY) * srcStride + offX * 4;
      dst.set(src.subarray(srcStart, srcStart + w * 4), y * w * 4);
    }
    return out;
  }

  return { init, isAvailable, getLastError, upscaleTiled, checkModelPresence, MODEL_CONFIG };
})();
