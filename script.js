/* ============================================================
   script.js — UPRES PRO main controller
   ============================================================ */

(function () {
  'use strict';

  // GPU tier is skipped above this many output pixels (whole-image
  // WebGL textures at 8K can exceed mobile GPU memory limits) — the
  // pipeline transparently routes to the tiled CPU worker instead,
  // and says so in the Processing Information panel.
  const GPU_SAFE_PIXELS = 9.5e6; // comfortably covers 4K UHD + DCI 4K

  const el = (id) => document.getElementById(id);

  const state = {
    caps: null,
    sourceImage: null,
    sourceObjectUrl: null,
    sourceFile: null,
    sourceW: 0, sourceH: 0,
    mode: 'upscale',
    upscalePreset: '4k',
    customW: null, customH: null,
    graphicsPreset: 'original',
    gCustomW: null, gCustomH: null,
    engineChoice: 'auto',
    aiModelPresent: false,
    sharpen: 0.5, denoise: 0.25, edge: 0.2,
    preserveAlpha: true, jpegCleanup: false, deblur: false,
    resultFormat: 'png',
    finalCanvas: null,
    resultBlobUrl: null,
    zoom: 1,
    worker: null,
    currentJobId: null,
    cancelled: false
  };

  // ---------------- toast ----------------
  let toastTimer = null;
  function toast(msg, ms) {
    const t = el('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 3200);
  }

  // ---------------- capability badges ----------------
  function initCapabilities() {
    state.caps = Engine.detectCapabilities();
    setCapsule('capWebGPU', state.caps.webgpu);
    setCapsule('capWebGL', state.caps.webgl2);
    setCapsule('capWorker', state.caps.worker);
    setCapsule('capOffscreen', state.caps.offscreenCanvas);
  }
  function setCapsule(id, on) {
    const c = el(id);
    if (on) c.classList.add('on');
  }

  // ---------------- AI availability ----------------
  async function checkAiAvailability() {
    const note = el('aiStatusNote');
    note.textContent = 'Checking for a local model file…';
    const present = await AIEngine.checkModelPresence();
    state.aiModelPresent = present;
    note.textContent = present
      ? 'Model found — ready to use.'
      : 'No model file found. Add one at ./models/ — see README.';
    const modelStatusText = el('modelStatusText');
    if (modelStatusText) {
      modelStatusText.textContent = present
        ? `Model found at ${AIEngine.MODEL_CONFIG.url}`
        : `No file at ${AIEngine.MODEL_CONFIG.url}. See README → "How to add a real AI super-resolution model".`;
    }
  }

  // ---------------- worker ----------------
  function initWorker() {
    if (state.worker) return state.worker;
    state.worker = new Worker('js/worker.js');
    return state.worker;
  }

  function runWorkerJob(bitmap, width, height, opts) {
    return new Promise((resolve, reject) => {
      const worker = initWorker();
      const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      state.currentJobId = jobId;

      function handler(e) {
        const msg = e.data;
        if (msg.jobId !== jobId) return;
        if (msg.type === 'progress') {
          updateProgress(msg.pct, msg.stage);
        } else if (msg.type === 'done') {
          worker.removeEventListener('message', handler);
          const canvas = document.createElement('canvas');
          canvas.width = msg.bitmap.width;
          canvas.height = msg.bitmap.height;
          canvas.getContext('2d').drawImage(msg.bitmap, 0, 0);
          msg.bitmap.close();
          resolve(canvas);
        } else if (msg.type === 'error') {
          worker.removeEventListener('message', handler);
          reject(new Error(msg.message));
        } else if (msg.type === 'cancelled') {
          worker.removeEventListener('message', handler);
          const err = new Error('Cancelled');
          err.cancelled = true;
          reject(err);
        }
      }
      worker.addEventListener('message', handler);

      worker.postMessage({
        type: 'process',
        jobId,
        bitmap,
        width,
        height,
        tileSize: Engine.suggestTileSize(state.caps),
        passes: opts.passes || [],
        resizeTo: opts.resizeTo || null
      }, [bitmap]);
    });
  }

  function cancelCurrentJob() {
    state.cancelled = true;
    if (state.worker && state.currentJobId) {
      state.worker.postMessage({ type: 'cancel', jobId: state.currentJobId });
    }
  }

  // ---------------- mode tabs ----------------
  function wireModeTabs() {
    document.querySelectorAll('.mode-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.mode-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.mode = btn.dataset.mode;
        el('targetPanel').style.display = state.mode === 'upscale' ? 'block' : 'none';
        el('graphicsPanel').style.display = state.mode === 'graphics' ? 'block' : 'none';
        if (state.sourceImage) refreshTargetAndMemory();
      });
    });
  }

  // ---------------- upload ----------------
  function wireUpload() {
    const dropzone = el('dropzone');
    const fileInput = el('fileInput');
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
    });
  }

  function handleFile(file) {
    if (!file.type.startsWith('image/')) { toast('Please choose an image file.'); return; }

    if (state.sourceObjectUrl) URL.revokeObjectURL(state.sourceObjectUrl);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      state.sourceImage = img;
      state.sourceObjectUrl = url;
      state.sourceFile = file;
      state.sourceW = img.naturalWidth;
      state.sourceH = img.naturalHeight;

      el('srcDims').textContent = `${state.sourceW}×${state.sourceH}`;
      el('srcSize').textContent = Engine.formatBytes(file.size);
      el('srcType').textContent = file.type.replace('image/', '').toUpperCase();
      el('srcRatio').textContent = ratioLabel(state.sourceW, state.sourceH);
      el('sourceInfo').classList.add('show');

      el('targetPanel').style.display = state.mode === 'upscale' ? 'block' : 'none';
      el('graphicsPanel').style.display = state.mode === 'graphics' ? 'block' : 'none';

      el('runBtn').disabled = false;
      refreshTargetAndMemory();
    };
    img.onerror = () => toast('Could not load that image.');
    img.src = url;
  }

  function ratioLabel(w, h) {
    const g = gcd(w, h);
    return `${w / g}:${h / g}`;
  }
  function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

  // ---------------- target dimension computation ----------------
  function computeTargetDims() {
    const sw = state.sourceW, sh = state.sourceH;

    if (state.mode === 'upscale') {
      switch (state.upscalePreset) {
        case '2x': return { w: sw * 2, h: sh * 2, crop: null };
        case '4x': return { w: sw * 4, h: sh * 4, crop: null };
        case '4k': { const d = Engine.fitContain(sw, sh, 3840, 2160); return { ...d, crop: null }; }
        case 'dci4k': { const d = Engine.fitContain(sw, sh, 4096, 2160); return { ...d, crop: null }; }
        case '8k': { const d = Engine.fitContain(sw, sh, 7680, 4320); return { ...d, crop: null }; }
        case 'custom': {
          const w = parseInt(el('customW').value, 10) || sw;
          const h = parseInt(el('customH').value, 10) || sh;
          const d = Engine.fitContain(sw, sh, w, h);
          return { ...d, crop: null };
        }
        default: return { w: sw, h: sh, crop: null };
      }
    }

    // graphics mode
    switch (state.graphicsPreset) {
      case 'original': return { w: sw, h: sh, crop: null };
      case 'ig-portrait': return withCover(sw, sh, 1080, 1350);
      case 'ig-square': return withCover(sw, sh, 1080, 1080);
      case 'story': return withCover(sw, sh, 1080, 1920);
      case '4k-poster': { const d = Engine.fitContain(sw, sh, 3840, 2160); return { ...d, crop: null }; }
      case '8k-poster': { const d = Engine.fitContain(sw, sh, 7680, 4320); return { ...d, crop: null }; }
      case 'gcustom': {
        const w = parseInt(el('gCustomW').value, 10) || sw;
        const h = parseInt(el('gCustomH').value, 10) || sh;
        const d = Engine.fitContain(sw, sh, w, h);
        return { ...d, crop: null };
      }
      default: return { w: sw, h: sh, crop: null };
    }
  }

  function withCover(sw, sh, boxW, boxH) {
    const crop = Engine.fitCoverCropRect(sw, sh, boxW, boxH);
    return { w: boxW, h: boxH, crop };
  }

  function refreshTargetAndMemory() {
    if (!state.sourceImage) return;
    const dims = computeTargetDims();
    const mem = Engine.checkMemorySafety(dims.w, dims.h, state.caps);
    const banner = el('memBanner');
    if (mem.risk === 'low') {
      banner.classList.remove('show', 'high');
    } else {
      banner.classList.add('show');
      banner.classList.toggle('high', mem.risk === 'high');
      banner.textContent = mem.risk === 'high'
        ? `⚠ ${dims.w}×${dims.h} needs an estimated ${mem.estimatedLabel} of memory, above what this device usually has available for a browser tab (${mem.budgetLabel}). Processing will use tiled, memory-safe passes, but very large exports can still be slow or, on low-RAM phones, fail. Consider a smaller preset if that happens.`
        : `${dims.w}×${dims.h} is a large export (~${mem.estimatedLabel} estimated). Tiled processing will be used automatically to keep memory in check.`;
    }
    el('runBtn').textContent = `Upscale to ${dims.w}×${dims.h} →`;
  }

  // ---------------- presets ----------------
  function wirePresets() {
    document.querySelectorAll('#upscalePresets .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#upscalePresets .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.upscalePreset = chip.dataset.preset;
        el('customDims').classList.toggle('show', state.upscalePreset === 'custom');
        refreshTargetAndMemory();
      });
    });
    el('customW').addEventListener('input', refreshTargetAndMemory);
    el('customH').addEventListener('input', refreshTargetAndMemory);

    document.querySelectorAll('#graphicsPresets .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#graphicsPresets .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.graphicsPreset = chip.dataset.gpreset;
        el('gCustomDims').classList.toggle('show', state.graphicsPreset === 'gcustom');
        refreshTargetAndMemory();
      });
    });
    el('gCustomW').addEventListener('input', refreshTargetAndMemory);
    el('gCustomH').addEventListener('input', refreshTargetAndMemory);
  }

  // ---------------- engine selector ----------------
  function wireEngineCards() {
    document.querySelectorAll('.engine-card').forEach(card => {
      card.addEventListener('click', () => {
        document.querySelectorAll('.engine-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        state.engineChoice = card.dataset.engine;
        if (state.engineChoice === 'ai' && !state.aiModelPresent) {
          toast('No AI model found yet — this will fall back to GPU/CPU automatically. See Settings.');
        }
      });
    });
  }

  function resolveEngine(choice, dims) {
    const gpuFits = state.caps.webgl2 && (dims.w * dims.h) <= GPU_SAFE_PIXELS;
    if (choice === 'ai') return state.aiModelPresent ? 'ai' : (gpuFits ? 'gpu' : 'cpu');
    if (choice === 'gpu') return gpuFits ? 'gpu' : 'cpu';
    if (choice === 'cpu') return 'cpu';
    // auto
    if (state.aiModelPresent) return 'ai';
    if (gpuFits) return 'gpu';
    return 'cpu';
  }

  // ---------------- enhancement controls ----------------
  function wireEnhancements() {
    bindSlider('sharpenSlider', 'sharpenVal', (v) => state.sharpen = v);
    bindSlider('denoiseSlider', 'denoiseVal', (v) => state.denoise = v);
    bindSlider('edgeSlider', 'edgeVal', (v) => state.edge = v);
    el('preserveAlpha').addEventListener('change', (e) => state.preserveAlpha = e.target.checked);
    el('jpegCleanup').addEventListener('change', (e) => state.jpegCleanup = e.target.checked);
    el('deblurToggle').addEventListener('change', (e) => state.deblur = e.target.checked);
  }
  function bindSlider(inputId, labelId, onChange) {
    const input = el(inputId);
    input.addEventListener('input', () => {
      const pct = parseInt(input.value, 10);
      el(labelId).textContent = pct + '%';
      onChange(pct / 100);
    });
  }

  function buildPasses(opts) {
    opts = opts || {};
    const passes = [];
    if (!opts.skipSharpen && state.sharpen > 0) passes.push({ type: 'sharpen', amount: state.sharpen });
    if (state.denoise > 0) passes.push({ type: 'denoise', amount: state.denoise });
    if (state.jpegCleanup) passes.push({ type: 'denoise', amount: Math.max(state.denoise, 0.35) });
    if (state.edge > 0) passes.push({ type: 'edge', amount: state.edge });
    if (state.deblur) passes.push({ type: 'sharpen', amount: Math.min(1, (opts.skipSharpen ? 0.2 : state.sharpen) + 0.3) });
    return passes;
  }

  // ---------------- progress UI ----------------
  function updateProgress(pct, stage) {
    el('progressFill').style.width = Math.max(0, Math.min(100, pct)) + '%';
    el('progressPct').textContent = Math.round(pct) + '%';
    if (stage) el('progressStage').textContent = stage;
  }
  function setStage(stage) { el('progressStage').textContent = stage; }

  // ---------------- main run pipeline ----------------
  async function run() {
    if (!state.sourceImage) return;

    const dims = computeTargetDims();
    const mem = Engine.checkMemorySafety(dims.w, dims.h, state.caps);

    if (mem.risk === 'high') {
      const proceed = confirm(
        `This export (${dims.w}×${dims.h}) is estimated to need ~${mem.estimatedLabel} of memory, ` +
        `above the ~${mem.budgetLabel} typically available to a browser tab on this device. ` +
        `It may be slow or could fail on low-RAM phones. Continue anyway?`
      );
      if (!proceed) return;
    }

    state.cancelled = false;
    el('runBtn').disabled = true;
    el('progressWrap').classList.add('show');
    updateProgress(1, 'Preparing');
    el('resultPanel').style.display = 'none';
    el('infoPanel').style.display = 'none';
    el('downloadPanel').style.display = 'none';

    const startTime = performance.now();
    let tier = resolveEngine(state.engineChoice, dims);
    let methodLabel = '', modelLabel = '—', gpuAccel = '—', fallbackNote = '';

    try {
      // Build the pipeline source: either the whole image, or (for
      // fixed-aspect graphics presets) a pre-cropped canvas.
      let pipelineSource = state.sourceImage;
      let srcW = state.sourceW, srcH = state.sourceH;
      if (dims.crop) {
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = dims.crop.w; cropCanvas.height = dims.crop.h;
        cropCanvas.getContext('2d').drawImage(
          state.sourceImage, dims.crop.x, dims.crop.y, dims.crop.w, dims.crop.h, 0, 0, dims.crop.w, dims.crop.h
        );
        pipelineSource = cropCanvas;
        srcW = dims.crop.w; srcH = dims.crop.h;
      }

      let finalCanvas = null;

      if (tier === 'ai') {
        setStage('Loading AI model…');
        const ok = await AIEngine.init((s) => setStage(s));
        if (!ok) {
          fallbackNote = 'AI model unavailable — using high-quality GPU/browser resampling. (' + (AIEngine.getLastError() || 'unknown reason') + ')';
          toast('AI model unavailable — falling back automatically.');
          tier = (state.caps.webgl2 && dims.w * dims.h <= GPU_SAFE_PIXELS) ? 'gpu' : 'cpu';
        } else {
          setStage('Running AI super-resolution…');
          const aiCanvas = await AIEngine.upscaleTiled(
            pipelineSource, srcW, srcH,
            (pct) => updateProgress(pct * 0.65, 'Running AI super-resolution…'),
            () => state.cancelled
          );
          setStage('Finishing (resize + enhancements)…');
          const bitmap = await createImageBitmap(aiCanvas);
          finalCanvas = await runWorkerJob(bitmap, aiCanvas.width, aiCanvas.height, {
            resizeTo: { w: dims.w, h: dims.h },
            passes: buildPasses()
          });
          methodLabel = 'AI Super Resolution (ONNX Runtime Web)';
          modelLabel = AIEngine.MODEL_CONFIG.url.split('/').pop();
          gpuAccel = state.caps.webgpu ? 'WebGPU (via ONNX Runtime)' : 'WASM (CPU inference)';
        }
      }

      if (tier === 'gpu' && !finalCanvas) {
        setStage('GPU upscaling (WebGL2 Lanczos3)…');
        updateProgress(15);
        const gpuCanvas = Engine.gpuUpscale(pipelineSource, srcW, srcH, dims.w, dims.h, { sharpen: state.sharpen });
        updateProgress(60);
        const extraPasses = buildPasses({ skipSharpen: true });
        if (extraPasses.length > 0) {
          setStage('Refining (denoise / edge)…');
          const bitmap = await createImageBitmap(gpuCanvas);
          finalCanvas = await runWorkerJob(bitmap, dims.w, dims.h, { passes: extraPasses });
        } else {
          finalCanvas = gpuCanvas;
          updateProgress(95);
        }
        methodLabel = 'GPU Enhanced Upscaling (WebGL2 Lanczos3 + shader sharpen)';
        gpuAccel = 'WebGL2';
      }

      if (tier === 'cpu' && !finalCanvas) {
        setStage('High-quality resampling (tiled, CPU)…');
        const bitmap = await createImageBitmap(pipelineSource);
        finalCanvas = await runWorkerJob(bitmap, srcW, srcH, {
          resizeTo: { w: dims.w, h: dims.h },
          passes: buildPasses()
        });
        methodLabel = 'High Quality Resampling (progressive, tiled)';
        gpuAccel = 'None (CPU)';
      }

      // above-4K GPU note
      if (state.engineChoice !== 'cpu' && tier === 'cpu' && dims.w * dims.h > GPU_SAFE_PIXELS && !fallbackNote) {
        fallbackNote = `GPU tier auto-skipped for ${dims.w}×${dims.h} to avoid exceeding mobile GPU memory limits — used tiled CPU resampling instead.`;
      }

      updateProgress(100, 'Done');
      state.finalCanvas = finalCanvas;

      finalCanvas.toBlob((blob) => {
        if (state.resultBlobUrl) URL.revokeObjectURL(state.resultBlobUrl);
        state.resultBlobUrl = URL.createObjectURL(blob);

        el('beforeImg').src = state.sourceObjectUrl;
        el('afterImg').src = state.resultBlobUrl;
        el('afterImg').onload = () => {
          const rect = el('compare').getBoundingClientRect();
          el('afterImg').style.setProperty('--cw', rect.width + 'px');
          setHandle(50);
        };

        el('infoSrcRes').textContent = `${state.sourceW}×${state.sourceH}`;
        el('infoOutRes').textContent = `${dims.w}×${dims.h}`;
        el('infoMethod').textContent = methodLabel + (fallbackNote ? ' *' : '');
        el('infoModel').textContent = modelLabel;
        el('infoGpu').textContent = gpuAccel;
        el('infoTime').textContent = ((performance.now() - startTime) / 1000).toFixed(1) + 's';
        el('infoMem').textContent = mem.estimatedLabel;
        el('infoFileSize').textContent = Engine.formatBytes(blob.size);

        if (fallbackNote) {
          const noteEl = document.createElement('p');
          noteEl.className = 'modal-sub';
          noteEl.style.marginTop = '12px';
          noteEl.textContent = '* ' + fallbackNote;
          el('infoPanel').appendChild(noteEl);
        }

        el('resultPanel').style.display = 'block';
        el('infoPanel').style.display = 'block';
        el('downloadPanel').style.display = 'block';
        el('progressWrap').classList.remove('show');
        el('runBtn').disabled = false;
        el('resultPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 'image/png');

    } catch (err) {
      el('progressWrap').classList.remove('show');
      el('runBtn').disabled = false;
      if (err && err.cancelled) {
        toast('Processing cancelled.');
      } else {
        console.error(err);
        toast('Something went wrong: ' + (err.message || err));
      }
    }
  }

  // ---------------- compare slider ----------------
  function wireCompare() {
    const compare = el('compare');
    const handle = el('handle');
    const afterWrap = el('afterWrap');
    let dragging = false;

    handle.addEventListener('pointerdown', (e) => { dragging = true; handle.setPointerCapture(e.pointerId); });
    window.addEventListener('pointerup', () => dragging = false);
    compare.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = compare.getBoundingClientRect();
      setHandle(((e.clientX - rect.left) / rect.width) * 100);
    });
    compare.addEventListener('click', (e) => {
      if (e.target === handle) return;
      const rect = compare.getBoundingClientRect();
      setHandle(((e.clientX - rect.left) / rect.width) * 100);
    });

    el('zoomIn').addEventListener('click', () => setZoom(state.zoom + 0.25));
    el('zoomOut').addEventListener('click', () => setZoom(state.zoom - 0.25));
    el('zoomReset').addEventListener('click', () => setZoom(1));
  }

  function setHandle(pct) {
    pct = Math.max(0, Math.min(100, pct));
    el('afterWrap').style.width = pct + '%';
    el('handle').style.left = pct + '%';
  }

  function setZoom(z) {
    state.zoom = Math.max(0.5, Math.min(4, z));
    const compare = el('compare');
    compare.style.transform = `scale(${state.zoom})`;
    compare.style.transformOrigin = 'center top';
    el('zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
  }

  // ---------------- download ----------------
  function wireDownload() {
    document.querySelectorAll('#downloadPanel .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#downloadPanel .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.resultFormat = chip.dataset.format;
      });
    });

    el('downloadBtn').addEventListener('click', () => {
      if (!state.finalCanvas) return;
      const fmt = state.resultFormat;
      const mime = fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
      const quality = fmt === 'png' ? undefined : 0.92;

      state.finalCanvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const base = (state.sourceFile ? state.sourceFile.name.replace(/\.[^/.]+$/, '') : 'image');
        const a = document.createElement('a');
        a.href = url;
        a.download = `${base}-${state.finalCanvas.width}x${state.finalCanvas.height}.${fmt === 'jpeg' ? 'jpg' : fmt}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        el('infoFileSize').textContent = Engine.formatBytes(blob.size);
      }, mime, quality);
    });

    el('resetBtn').addEventListener('click', resetAll);
  }

  function resetAll() {
    if (state.sourceObjectUrl) URL.revokeObjectURL(state.sourceObjectUrl);
    if (state.resultBlobUrl) URL.revokeObjectURL(state.resultBlobUrl);
    state.sourceImage = null;
    state.sourceObjectUrl = null;
    state.sourceFile = null;
    state.finalCanvas = null;
    state.resultBlobUrl = null;
    el('fileInput').value = '';
    el('sourceInfo').classList.remove('show');
    el('runBtn').disabled = true;
    el('runBtn').textContent = 'Select an image to begin';
    el('resultPanel').style.display = 'none';
    el('infoPanel').style.display = 'none';
    el('downloadPanel').style.display = 'none';
    el('memBanner').classList.remove('show');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------------- cancel ----------------
  function wireCancel() {
    el('cancelBtn').addEventListener('click', cancelCurrentJob);
  }

  // ---------------- settings modal ----------------
  function wireSettings() {
    el('settingsBtn').addEventListener('click', async () => {
      const cfg = ApiEngine.getConfig();
      if (cfg) {
        el('apiEndpointInput').value = cfg.endpoint || '';
        el('apiKeyInput').value = cfg.apiKey || '';
        el('apiAuthHeaderInput').value = cfg.authHeader || 'Authorization';
        el('apiAuthPrefixInput').value = cfg.authPrefix || '';
      }
      el('modelUrlInput').value = AIEngine.MODEL_CONFIG.url;
      el('settingsModal').classList.add('show');
      el('modelStatusText').textContent = 'Checking for a local model file…';
      const present = await AIEngine.checkModelPresence();
      el('modelStatusText').textContent = present
        ? `✓ Model found at ${AIEngine.MODEL_CONFIG.url}`
        : `No file at ${AIEngine.MODEL_CONFIG.url} yet. See README → "How to add a real AI super-resolution model".`;
    });
    el('closeSettingsBtn').addEventListener('click', () => el('settingsModal').classList.remove('show'));

    el('saveSettingsBtn').addEventListener('click', async () => {
      AIEngine.MODEL_CONFIG.url = el('modelUrlInput').value.trim() || AIEngine.MODEL_CONFIG.url;

      const endpoint = el('apiEndpointInput').value.trim();
      const apiKey = el('apiKeyInput').value.trim();
      if (endpoint && apiKey) {
        ApiEngine.saveConfig({
          endpoint,
          apiKey,
          authHeader: el('apiAuthHeaderInput').value.trim() || 'Authorization',
          authPrefix: el('apiAuthPrefixInput').value
        });
        toast('Settings saved.');
      } else {
        toast('Model path saved.');
      }
      el('settingsModal').classList.remove('show');
      await checkAiAvailability();
    });

    el('clearApiBtn').addEventListener('click', () => {
      ApiEngine.clearConfig();
      el('apiEndpointInput').value = '';
      el('apiKeyInput').value = '';
      toast('API key cleared.');
    });
  }

  // ---------------- init ----------------
  function init() {
    initCapabilities();
    wireModeTabs();
    wireUpload();
    wirePresets();
    wireEngineCards();
    wireEnhancements();
    wireCompare();
    wireDownload();
    wireCancel();
    wireSettings();
    el('runBtn').addEventListener('click', run);
    checkAiAvailability();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
