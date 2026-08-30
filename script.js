/* ============================================================
   script.js — UPRES (non-AI) main controller
   ============================================================ */

(function () {
  'use strict';

  const el = (id) => document.getElementById(id);

  const state = {
    caps: null,
    sourceImage: null,
    sourceObjectUrl: null,
    sourceFile: null,
    sourceW: 0, sourceH: 0,
    mode: 'upscale',
    preset: 'photo',
    applyingPreset: false,

    upscalePreset: '4k',
    graphicsPreset: 'original',

    resampleQuality: 'balanced',
    detailAmount: 0.30,
    sharpAmount: 0.45,
    noiseReduction: 'off',
    jpegArtifact: 'off',
    textProtection: false,
    portraitProtection: false,
    localContrast: false,

    resultFormat: 'png',
    jpegQuality: 0.92,
    finalCanvas: null,
    resultBlobUrl: null,
    beforeMetrics: null,
    afterMetrics: null,

    zoomPct: 100,
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

  // ---------------- capabilities ----------------
  function initCapabilities() {
    state.caps = Engine.detectCapabilities();
    setCapsule('capWebGL', state.caps.webgl2);
    setCapsule('capWorker', state.caps.worker);
    setCapsule('capOffscreen', state.caps.offscreenCanvas);
    setCapsule('capClipboard', state.caps.clipboardImage);
    el('copyBtn').style.display = state.caps.clipboardImage ? 'block' : 'none';
  }
  function setCapsule(id, on) { if (on) el(id).classList.add('on'); }

  // ---------------- worker ----------------
  function initWorker() {
    if (state.worker) return state.worker;
    state.worker = new Worker('js/worker.js');
    return state.worker;
  }

  function runWorkerJob(msgType, bitmap, width, height, extraFields) {
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

      worker.postMessage(Object.assign({
        type: msgType, jobId, bitmap, width, height,
        tileSize: Engine.suggestTileSize(state.caps)
      }, extraFields), [bitmap]);
    });
  }

  function analyzeImage(sourceEl) {
    return new Promise((resolve, reject) => {
      createImageBitmap(sourceEl).then((bitmap) => {
        const worker = initWorker();
        const jobId = 'analyze_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        function handler(e) {
          const msg = e.data;
          if (msg.jobId !== jobId) return;
          if (msg.type === 'analyzed') {
            worker.removeEventListener('message', handler);
            resolve(msg.metrics);
          } else if (msg.type === 'error') {
            worker.removeEventListener('message', handler);
            reject(new Error(msg.message));
          }
        }
        worker.addEventListener('message', handler);
        worker.postMessage({ type: 'analyze', jobId, bitmap }, [bitmap]);
      }).catch(reject);
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

      el('beforeAnalysisPanel').style.display = 'block';
      el('beforeSharpness').textContent = 'Analyzing…';
      el('beforeEdge').textContent = '—';
      el('beforeNoise').textContent = '—';
      analyzeImage(img).then((metrics) => {
        state.beforeMetrics = metrics;
        el('beforeSharpness').textContent = metrics.sharpness;
        el('beforeEdge').textContent = metrics.edgeDensity + '%';
        el('beforeNoise').textContent = 'σ ' + metrics.noiseSigma;
      }).catch(() => { el('beforeSharpness').textContent = 'Unavailable'; });
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
        case '3x': return { w: sw * 3, h: sh * 3, crop: null };
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
        ? `⚠ ${dims.w}×${dims.h} needs an estimated ${mem.estimatedLabel} of memory, above what this device usually has available for a browser tab (${mem.budgetLabel}). Tiled processing keeps per-step memory bounded, but the final full-resolution image still has to exist in memory once — very large exports can be slow or, on low-RAM phones, fail. Consider a smaller preset if that happens.`
        : `${dims.w}×${dims.h} is a large export (~${mem.estimatedLabel} estimated). Tiled processing will be used automatically to keep memory in check.`;
    }
    el('runBtn').textContent = `Upscale to ${dims.w}×${dims.h} →`;
  }

  // ---------------- processing-mode presets ----------------
  function wirePresetChips() {
    document.querySelectorAll('#presetChips .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#presetChips .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.preset = chip.dataset.preset;
        if (state.preset !== 'custom' && PRESETS[state.preset]) applyPreset(PRESETS[state.preset]);
      });
    });
  }

  function applyPreset(p) {
    state.applyingPreset = true;

    setQualityChip(p.resampleQuality);
    setSliderValue('detailSlider', 'detailVal', Math.round(p.detailAmount * 100));
    state.detailAmount = p.detailAmount;
    setSliderValue('sharpSlider', 'sharpVal', Math.round(p.sharpAmount * 100));
    state.sharpAmount = p.sharpAmount;
    setSeg('noiseSeg', p.noiseReduction);
    state.noiseReduction = p.noiseReduction;
    setSeg('jpegSeg', p.jpegArtifact);
    state.jpegArtifact = p.jpegArtifact;
    el('textProtection').checked = p.textProtection;
    state.textProtection = p.textProtection;
    el('portraitProtection').checked = p.portraitProtection;
    state.portraitProtection = p.portraitProtection;
    el('localContrast').checked = p.localContrast;
    state.localContrast = p.localContrast;

    state.applyingPreset = false;
  }

  function setSliderValue(inputId, labelId, pct) {
    el(inputId).value = pct;
    el(labelId).textContent = pct + '%';
  }
  function setSeg(containerId, val) {
    const container = el(containerId);
    container.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.val === val));
  }
  function setQualityChip(val) {
    state.resampleQuality = val;
    document.querySelectorAll('#qualityChips .chip').forEach(c => c.classList.toggle('active', c.dataset.quality === val));
  }

  function markCustomIfManual() {
    if (state.applyingPreset) return;
    if (state.preset !== 'custom') {
      state.preset = 'custom';
      document.querySelectorAll('#presetChips .chip').forEach(c => c.classList.toggle('active', c.dataset.preset === 'custom'));
    }
  }

  // ---------------- output presets ----------------
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

  // ---------------- resampling quality ----------------
  function wireQualityChips() {
    document.querySelectorAll('#qualityChips .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        setQualityChip(chip.dataset.quality);
        markCustomIfManual();
      });
    });
  }

  // ---------------- enhancement controls ----------------
  function wireEnhancements() {
    el('detailSlider').addEventListener('input', (e) => {
      const pct = parseInt(e.target.value, 10);
      el('detailVal').textContent = pct + '%';
      state.detailAmount = pct / 100;
      markCustomIfManual();
    });
    el('sharpSlider').addEventListener('input', (e) => {
      const pct = parseInt(e.target.value, 10);
      el('sharpVal').textContent = pct + '%';
      state.sharpAmount = pct / 100;
      markCustomIfManual();
    });

    wireSeg('noiseSeg', (val) => { state.noiseReduction = val; markCustomIfManual(); });
    wireSeg('jpegSeg', (val) => { state.jpegArtifact = val; markCustomIfManual(); });

    el('textProtection').addEventListener('change', (e) => { state.textProtection = e.target.checked; markCustomIfManual(); });
    el('portraitProtection').addEventListener('change', (e) => { state.portraitProtection = e.target.checked; markCustomIfManual(); });
    el('localContrast').addEventListener('change', (e) => { state.localContrast = e.target.checked; markCustomIfManual(); });
  }

  function wireSeg(containerId, onChange) {
    const container = el(containerId);
    container.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onChange(btn.dataset.val);
      });
    });
  }

  function buildEnhanceConfig() {
    return {
      noiseReduction: state.noiseReduction,
      jpegArtifact: state.jpegArtifact,
      detailAmount: state.detailAmount,
      sharpAmount: state.sharpAmount,
      localContrast: state.localContrast,
      textProtection: state.textProtection,
      portraitProtection: state.portraitProtection
    };
  }

  function stagesSummary(cfg) {
    const s = [];
    if (cfg.noiseReduction !== 'off') s.push('Noise reduction (' + cfg.noiseReduction + ')');
    if (cfg.jpegArtifact !== 'off') s.push('JPEG artifact removal (' + cfg.jpegArtifact + ')');
    if (cfg.detailAmount > 0) s.push('Detail enhancement');
    if (cfg.localContrast) s.push('Local contrast');
    if (cfg.sharpAmount > 0) s.push('Adaptive sharpening');
    if (cfg.textProtection) s.push('Text/logo protection');
    if (cfg.portraitProtection) s.push('Portrait protection');
    return s.length ? s.join(', ') : 'None (resampling only)';
  }

  // ---------------- progress UI ----------------
  function updateProgress(pct, stage) {
    el('progressFill').style.width = Math.max(0, Math.min(100, pct)) + '%';
    el('progressPct').textContent = Math.round(pct) + '%';
    if (stage) el('progressStage').textContent = stage;
  }
  function setStage(stage) { el('progressStage').textContent = stage; }

  // ---------------- main run pipeline ----------------
  function toCanvas(source, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(source, 0, 0, w, h);
    return c;
  }
  function singlePassResize(source, dstW, dstH) {
    const c = document.createElement('canvas');
    c.width = dstW; c.height = dstH;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, dstW, dstH);
    return c;
  }

  function estimateProcessingSeconds(dims, cfg, caps) {
    const basePixels = dims.w * dims.h;
    let complexity = 1;
    if (cfg.noiseReduction !== 'off') complexity += 0.4;
    if (cfg.jpegArtifact !== 'off') complexity += 0.3;
    if (cfg.detailAmount > 0) complexity += 0.2;
    if (cfg.localContrast) complexity += 0.3;
    if (cfg.sharpAmount > 0) complexity += 0.2;
    const throughput = (caps.isMobile ? 3.5e6 : 10e6) * Math.min(2, (caps.cores || 4) / 4);
    return Math.max(1, Math.round((basePixels * complexity) / throughput));
  }

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
    const cfgForEta = buildEnhanceConfig();
    el('progressEta').textContent = `Rough estimate: ~${estimateProcessingSeconds(dims, cfgForEta, state.caps)}s (varies a lot by device)`;
    el('resultPanel').style.display = 'none';
    el('infoPanel').style.display = 'none';
    el('downloadPanel').style.display = 'none';

    const startTime = performance.now();
    const cfg = buildEnhanceConfig();
    let backendLabel = '';

    try {
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

      const needsResize = (dims.w !== srcW || dims.h !== srcH);
      let workCanvas;

      if (needsResize) {
        // Phase 1: cleanup at original resolution (denoising a small
        // source is cheaper and more correct than denoising after
        // upscaling has already amplified the noise).
        if (cfg.noiseReduction !== 'off' || cfg.jpegArtifact !== 'off') {
          setStage('Cleaning noise / artifacts…');
          const bitmap = await createImageBitmap(pipelineSource);
          workCanvas = await runWorkerJob('cleanup', bitmap, srcW, srcH, { enhance: cfg });
        } else {
          workCanvas = toCanvas(pipelineSource, srcW, srcH);
        }

        // Phase 2: resample to target resolution
        setStage('Resampling…');
        if (state.resampleQuality === 'fast') {
          workCanvas = singlePassResize(workCanvas, dims.w, dims.h);
          backendLabel = 'Single-pass high-quality resample (Fast)';
          updateProgress(60);
        } else if (state.resampleQuality === 'maximum' && state.caps.webgl2) {
          try {
            workCanvas = Engine.gpuResample(workCanvas, srcW, srcH, dims.w, dims.h);
            backendLabel = 'WebGL2 two-pass Lanczos3 (Maximum Quality)';
            updateProgress(60);
          } catch (err) {
            const bitmap = await createImageBitmap(workCanvas);
            workCanvas = await runWorkerJob('resize', bitmap, srcW, srcH, { dstW: dims.w, dstH: dims.h });
            backendLabel = 'Multi-pass stepped resample (Maximum Quality — WebGL2 unavailable, used CPU fallback)';
          }
        } else {
          const bitmap = await createImageBitmap(workCanvas);
          workCanvas = await runWorkerJob('resize', bitmap, srcW, srcH, { dstW: dims.w, dstH: dims.h });
          backendLabel = 'Multi-pass stepped resample (Balanced)';
        }

        // Phase 3: finishing enhancement at target resolution
        if (cfg.detailAmount > 0 || cfg.localContrast || cfg.sharpAmount > 0) {
          setStage('Adaptive sharpening / detail enhancement…');
          const bitmap = await createImageBitmap(workCanvas);
          workCanvas = await runWorkerJob('finish', bitmap, dims.w, dims.h, { enhance: cfg });
        } else {
          updateProgress(100, 'Done');
        }
      } else {
        // Enhance-only, no resampling needed
        const anyStage = cfg.noiseReduction !== 'off' || cfg.jpegArtifact !== 'off' ||
          cfg.detailAmount > 0 || cfg.localContrast || cfg.sharpAmount > 0;
        if (anyStage) {
          setStage('Enhancing…');
          const bitmap = await createImageBitmap(pipelineSource);
          workCanvas = await runWorkerJob('full', bitmap, srcW, srcH, { enhance: cfg });
        } else {
          workCanvas = toCanvas(pipelineSource, srcW, srcH);
          updateProgress(100, 'Done');
        }
        backendLabel = 'No resampling needed (enhance-only)';
      }

      state.finalCanvas = workCanvas;

      setStage('Analyzing result…');
      let afterMetrics = null;
      try { afterMetrics = await analyzeImage(workCanvas); } catch (e) { /* non-fatal */ }
      state.afterMetrics = afterMetrics;

      workCanvas.toBlob((blob) => {
        if (state.resultBlobUrl) URL.revokeObjectURL(state.resultBlobUrl);
        state.resultBlobUrl = URL.createObjectURL(blob);

        el('beforeImg').src = state.sourceObjectUrl;
        el('afterImg').src = state.resultBlobUrl;
        el('afterImg').onload = () => {
          const rect = el('compare').getBoundingClientRect();
          el('afterImg').style.setProperty('--cw', rect.width + 'px');
          setHandle(50);
          setZoomPercent(100);
        };

        el('infoSrcRes').textContent = `${state.sourceW}×${state.sourceH}`;
        el('infoOutRes').textContent = `${dims.w}×${dims.h}`;
        el('infoMethod').textContent = backendLabel;
        el('infoStages').textContent = stagesSummary(cfg);
        el('infoTime').textContent = ((performance.now() - startTime) / 1000).toFixed(1) + 's';
        el('infoMem').textContent = mem.estimatedLabel;
        el('infoFileSize').textContent = Engine.formatBytes(blob.size);
        el('infoSharpness').textContent = state.beforeMetrics && afterMetrics
          ? `${state.beforeMetrics.sharpness} → ${afterMetrics.sharpness}`
          : '—';

        el('resultPanel').style.display = 'block';
        el('infoPanel').style.display = 'block';
        el('downloadPanel').style.display = 'block';
        el('progressWrap').classList.remove('show');
        el('progressEta').textContent = '';
        el('runBtn').disabled = false;
        el('resultPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 'image/png');

    } catch (err) {
      el('progressWrap').classList.remove('show');
      el('progressEta').textContent = '';
      el('runBtn').disabled = false;
      if (err && err.cancelled) {
        toast('Processing cancelled.');
      } else {
        console.error(err);
        toast('Something went wrong: ' + (err.message || err));
      }
    }
  }

  // ---------------- compare slider + pan/zoom ----------------
  function wireCompare() {
    const compare = el('compare');
    const handle = el('handle');
    let dragging = false;

    handle.addEventListener('pointerdown', (e) => { dragging = true; handle.setPointerCapture(e.pointerId); e.stopPropagation(); });
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

    el('fitBtn').addEventListener('click', () => { setZoomPercent(100); el('compareViewport').scrollLeft = 0; el('compareViewport').scrollTop = 0; });
    el('oneToOneBtn').addEventListener('click', () => {
      if (!state.finalCanvas) return;
      const viewportWidth = el('compareViewport').clientWidth;
      const pct = (state.finalCanvas.width / viewportWidth) * 100;
      setZoomPercent(pct);
    });
    el('zoomInBtn').addEventListener('click', () => setZoomPercent(state.zoomPct * 1.25));
    el('zoomOutBtn').addEventListener('click', () => setZoomPercent(state.zoomPct / 1.25));
  }

  function setHandle(pct) {
    pct = Math.max(0, Math.min(100, pct));
    el('afterWrap').style.width = pct + '%';
    el('handle').style.left = pct + '%';
  }

  function setZoomPercent(pct) {
    state.zoomPct = Math.max(50, Math.min(600, pct));
    el('compare').style.width = state.zoomPct + '%';
    el('zoomLabel').textContent = Math.round(state.zoomPct) === 100 ? 'Fit' : Math.round(state.zoomPct) + '%';
  }

  // ---------------- download / copy ----------------
  function wireDownload() {
    document.querySelectorAll('#downloadPanel .chip[data-format]').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#downloadPanel .chip[data-format]').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.resultFormat = chip.dataset.format;
        el('jpegQualityRow').style.display = state.resultFormat === 'jpeg' ? 'block' : 'none';
      });
    });

    el('jpegQualitySlider').addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      el('jpegQualityVal').textContent = v + '%';
      state.jpegQuality = v / 100;
    });

    el('downloadBtn').addEventListener('click', () => {
      if (!state.finalCanvas) return;
      exportBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const base = (state.sourceFile ? state.sourceFile.name.replace(/\.[^/.]+$/, '') : 'image');
        const ext = state.resultFormat === 'jpeg' ? 'jpg' : state.resultFormat;
        const a = document.createElement('a');
        a.href = url;
        a.download = `${base}-${state.finalCanvas.width}x${state.finalCanvas.height}.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        el('infoFileSize').textContent = Engine.formatBytes(blob.size);
      });
    });

    el('copyBtn').addEventListener('click', async () => {
      if (!state.finalCanvas || !state.caps.clipboardImage) return;
      try {
        const blob = await new Promise((resolve) => state.finalCanvas.toBlob(resolve, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast('Copied to clipboard.');
      } catch (err) {
        toast('Copy failed: ' + err.message);
      }
    });

    el('resetBtn').addEventListener('click', resetAll);
  }

  function exportBlob(cb) {
    const fmt = state.resultFormat;
    const mime = fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
    const quality = fmt === 'png' ? undefined : (fmt === 'jpeg' ? state.jpegQuality : 0.92);
    state.finalCanvas.toBlob(cb, mime, quality);
  }

  function resetAll() {
    if (state.sourceObjectUrl) URL.revokeObjectURL(state.sourceObjectUrl);
    if (state.resultBlobUrl) URL.revokeObjectURL(state.resultBlobUrl);
    state.sourceImage = null;
    state.sourceObjectUrl = null;
    state.sourceFile = null;
    state.finalCanvas = null;
    state.resultBlobUrl = null;
    state.beforeMetrics = null;
    state.afterMetrics = null;
    el('fileInput').value = '';
    el('sourceInfo').classList.remove('show');
    el('beforeAnalysisPanel').style.display = 'none';
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

  // ---------------- init ----------------
  function init() {
    initCapabilities();
    wireModeTabs();
    wireUpload();
    wirePresetChips();
    wirePresets();
    wireQualityChips();
    wireEnhancements();
    wireCompare();
    wireDownload();
    wireCancel();
    el('runBtn').addEventListener('click', run);
    applyPreset(PRESETS.photo);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
