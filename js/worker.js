/* ============================================================
   worker.js
   Runs off the main thread. Receives an ImageBitmap (transferable,
   so no copy cost) plus a tile size and a list of filter passes,
   and returns a processed ImageBitmap.

   Tiling: each tile is read with `overlap` extra pixels on every
   side (clamped at image edges) so convolution kernels don't see
   a seam at tile boundaries; the overlap is cropped off before
   the tile is written back. This keeps peak memory bounded to a
   handful of small tile buffers instead of one giant buffer for
   an 8K image.
   ============================================================ */

const cancelledJobs = new Set();

self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'cancel') {
    cancelledJobs.add(e.data.jobId);
    return;
  }
  if (type !== 'process') return;

  const { bitmap, width, height, tileSize, passes, jobId, resizeTo } = e.data;

  try {
    let canvas = new OffscreenCanvas(width, height);
    let ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    let workW = width, workH = height;

    // Optional progressive resize, done here (off the main thread) so
    // the CPU tier never touches the UI thread at all. Stepped in <=2x
    // jumps for the same reason the main-thread version is: a single
    // huge resize jump looks soft/aliased, small steps look sharp.
    if (resizeTo && (resizeTo.w !== width || resizeTo.h !== height)) {
      self.postMessage({ type: 'progress', jobId, pct: 0, stage: 'Resampling' });
      canvas = progressiveResizeOffscreen(canvas, width, height, resizeTo.w, resizeTo.h);
      ctx = canvas.getContext('2d');
      workW = resizeTo.w; workH = resizeTo.h;
    }

    if (!passes || passes.length === 0) {
      const resultBitmap = canvas.transferToImageBitmap();
      self.postMessage({ type: 'done', jobId, bitmap: resultBitmap }, [resultBitmap]);
      return;
    }

    const overlap = 3; // enough for a 3x3 / small box kernel
    const cols = Math.ceil(workW / tileSize);
    const rows = Math.ceil(workH / tileSize);
    const totalTiles = cols * rows;
    let done = 0;

    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        if (cancelledJobs.has(jobId)) {
          cancelledJobs.delete(jobId);
          self.postMessage({ type: 'cancelled', jobId });
          return;
        }
        const x0 = tx * tileSize;
        const y0 = ty * tileSize;
        const w = Math.min(tileSize, workW - x0);
        const h = Math.min(tileSize, workH - y0);

        const padX0 = Math.min(overlap, x0);
        const padY0 = Math.min(overlap, y0);
        const padX1 = Math.min(overlap, workW - (x0 + w));
        const padY1 = Math.min(overlap, workH - (y0 + h));

        const readX = x0 - padX0;
        const readY = y0 - padY0;
        const readW = w + padX0 + padX1;
        const readH = h + padY0 + padY1;

        let imgData = ctx.getImageData(readX, readY, readW, readH);

        for (const pass of passes) {
          imgData = applyPass(imgData, pass);
        }

        // crop the padding back off before writing
        const outData = cropImageData(imgData, padX0, padY0, w, h);
        ctx.putImageData(outData, x0, y0);

        done++;
        self.postMessage({ type: 'progress', jobId, pct: Math.round((done / totalTiles) * 100) });

        // yield briefly so a cancel message can be processed between tiles
        await new Promise(r => setTimeout(r, 0));
      }
    }

    const resultBitmap = canvas.transferToImageBitmap();
    self.postMessage({ type: 'done', jobId, bitmap: resultBitmap }, [resultBitmap]);
  } catch (err) {
    self.postMessage({ type: 'error', jobId, message: err.message });
  }
};

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

function cropImageData(imgData, offX, offY, w, h) {
  if (offX === 0 && offY === 0 && imgData.width === w && imgData.height === h) return imgData;
  const out = new ImageData(w, h);
  const src = imgData.data;
  const dst = out.data;
  const srcStride = imgData.width * 4;
  for (let y = 0; y < h; y++) {
    const srcRowStart = ((y + offY) * srcStride) + offX * 4;
    const dstRowStart = y * w * 4;
    dst.set(src.subarray(srcRowStart, srcRowStart + w * 4), dstRowStart);
  }
  return out;
}

function applyPass(imgData, pass) {
  switch (pass.type) {
    case 'sharpen': return convolve3x3(imgData, sharpenKernel(pass.amount));
    case 'denoise': return denoiseMedianLite(imgData, pass.amount);
    case 'edge': return convolve3x3(imgData, edgeKernel(pass.amount));
    default: return imgData;
  }
}

function sharpenKernel(amount) {
  const a = amount != null ? amount : 0.5; // 0..1
  const c = 1 + 4 * a;
  const s = -a;
  return [0, s, 0, s, c, s, 0, s, 0];
}

function edgeKernel(amount) {
  const a = amount != null ? amount : 0.3;
  return [-a, -a, -a, -a, 1 + 8 * a, -a, -a, -a, -a];
}

function convolve3x3(imgData, kernel) {
  const { width: w, height: h, data: src } = imgData;
  const out = new ImageData(w, h);
  const dst = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        dst[idx] = src[idx]; dst[idx + 1] = src[idx + 1]; dst[idx + 2] = src[idx + 2]; dst[idx + 3] = src[idx + 3];
        continue;
      }
      for (let c = 0; c < 3; c++) {
        let sum = 0, k = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            sum += src[((y + ky) * w + (x + kx)) * 4 + c] * kernel[k++];
          }
        }
        dst[idx + c] = Math.max(0, Math.min(255, sum));
      }
      dst[idx + 3] = src[idx + 3];
    }
  }
  return out;
}

// A cheap denoise: 3x3 box blur blended with the original by `amount`.
// Not a true bilateral/NLM filter (too slow for tile-by-tile JS on
// mobile), but meaningfully reduces speckle/JPEG-block noise without
// destroying edges when kept subtle.
function denoiseMedianLite(imgData, amount) {
  const a = amount != null ? amount : 0.3;
  const { width: w, height: h, data: src } = imgData;
  const out = new ImageData(w, h);
  const dst = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        dst[idx] = src[idx]; dst[idx + 1] = src[idx + 1]; dst[idx + 2] = src[idx + 2]; dst[idx + 3] = src[idx + 3];
        continue;
      }
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            sum += src[((y + ky) * w + (x + kx)) * 4 + c];
          }
        }
        const blurred = sum / 9;
        dst[idx + c] = src[idx + c] * (1 - a) + blurred * a;
      }
      dst[idx + 3] = src[idx + 3];
    }
  }
  return out;
}
