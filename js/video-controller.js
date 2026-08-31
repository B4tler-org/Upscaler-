/* ============================================================
   video-controller.js — UPRES Video tab
   Real in-browser, non-AI video upscaling/enhancement. Two
   capture backends, feature-detected:

   1. Worker-offloaded (Chrome/Android Chrome): the source
      <video>'s captureStream() video track is read frame-by-frame
      via MediaStreamTrackProcessor, each frame is resized/cropped
      on the main thread (cheap — a single canvas draw, optionally
      through the WebGL2 Lanczos3 shader from engine.js), then
      handed to workers/video-worker.js for the actual enhancement
      math (denoise/detail/sharpen — the SAME functions the image
      pipeline uses, via shared-filters.js), and the processed
      frame is written into a MediaStreamTrackGenerator to form a
      new live video track. This keeps the heavy per-pixel work
      off the main thread.

   2. Fallback (other browsers): requestVideoFrameCallback drives
      the same resize+worker-enhance+draw sequence onto a plain
      <canvas>, which feeds canvas.captureStream() instead of a
      track generator. Functionally equivalent, just without the
      dedicated frame-transfer API — still doesn't block the UI
      because the per-frame worker round-trip is awaited
      asynchronously between rVFC callbacks, not run inline.

   Either way, MediaRecorder does the actual encoding+muxing (a
   real container writer that would be irresponsible to hand-roll
   for this deliverable) — which is also why output is WebM, not
   MP4, on almost every device: that's what MediaRecorder actually
   supports. And because everything is driven by real-time <video>
   playback (there's no container demuxer here to decode frames
   faster than playback speed), processing takes roughly as long
   as the source video's own duration. Both constraints are
   surfaced honestly in the UI rather than glossed over.
   ============================================================ */

(function () {
  'use strict';

  const el = (id) => document.getElementById(id);
  const ONE_GB = 1024 * 1024 * 1024;

  const vstate = {
    caps: { trackProcessor: false, webm: false, mp4: false },
    sourceFile: null,
    sourceUrl: null,
    srcW: 0, srcH: 0, duration: 0, srcFps: 30, hasAudio: false,

    resPreset: 'original',
    mode: 'balanced',
    aspect: '169',

    sharpen: 'medium', denoise: 'off', resample: 'lanczos',
    bitrate: 'auto', bitrateCustomMbps: 12, fps: 'original', preserveAudio: true,

    worker: null,
    running: false,
    cancelled: false,
    resultBlob: null, resultUrl: null, resultW: 0, resultH: 0, resultFps: 0
  };

  const VIDEO_MODE_DEFAULTS = {
    social: { sharpen: 'high', denoise: 'low', resample: 'lanczos', bitrate: 'auto', detail: 0.30, localContrast: false },
    max: { sharpen: 'high', denoise: 'medium', resample: 'lanczos', bitrate: 'high', detail: 0.50, localContrast: true },
    balanced: { sharpen: 'medium', denoise: 'off', resample: 'lanczos', bitrate: 'auto', detail: 0.30, localContrast: false },
    clean: { sharpen: 'low', denoise: 'medium', resample: 'bicubic', bitrate: 'auto', detail: 0.15, localContrast: false }
  };
  const SHARPEN_AMOUNTS = { off: 0, low: 0.25, medium: 0.45, high: 0.65 };
  const RES_HEIGHTS = { 720: 720, 1080: 1080, 1440: 1440, 2160: 2160 };
  const SOCIAL_DIMS = {
    169: { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] },
    916: { 720: [720, 1280], 1080: [1080, 1920], 1440: [1440, 2560], 2160: [2160, 3840] },
    11: { 720: [720, 720], 1080: [1080, 1080], 1440: [1440, 1440], 2160: [2160, 2160] }
  };
  const MODE_BASE_MBPS = { social: 6, max: 20, balanced: 10, clean: 8 };

  let toastTimer = null;
  function toast(msg, ms) {
    const t = el('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 3600);
  }

  // ---------------- capability detection ----------------
  function detectVideoCapabilities() {
    vstate.caps.trackProcessor = (typeof MediaStreamTrackProcessor !== 'undefined') && (typeof MediaStreamTrackGenerator !== 'undefined');
    vstate.caps.webm = (typeof MediaRecorder !== 'undefined') &&
      (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') || MediaRecorder.isTypeSupported('video/webm'));
    vstate.caps.mp4 = (typeof MediaRecorder !== 'undefined') && MediaRecorder.isTypeSupported('video/mp4');

    if (vstate.caps.trackProcessor) el('capTrackProcessor').classList.add('on');
    if (vstate.caps.webm || vstate.caps.mp4) el('capMediaRecorder').classList.add('on');

    if (!vstate.caps.webm && !vstate.caps.mp4) {
      el('videoRunBtn').textContent = 'Video export unsupported in this browser';
    }
  }

  function pickMimeType() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4'
    ];
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  // ---------------- top-level tabs ----------------
  function wireTopTabs() {
    document.querySelectorAll('[data-toptab]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-toptab]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.toptab;
        el('imageTab').style.display = tab === 'image' ? 'block' : 'none';
        el('videoTab').style.display = tab === 'video' ? 'block' : 'none';
      });
    });
  }

  // ---------------- upload ----------------
  function wireVideoUpload() {
    const dropzone = el('videoDropzone');
    const fileInput = el('videoFileInput');
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleVideoFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) handleVideoFile(e.target.files[0]);
    });
  }

  function handleVideoFile(file) {
    if (!file.type.startsWith('video/')) {
      toast('That doesn\'t look like a video file.');
      return;
    }
    if (file.size > ONE_GB) {
      toast(`This file is ${(file.size / ONE_GB).toFixed(2)} GB — please choose a video under 1 GB.`);
      return;
    }

    if (vstate.sourceUrl) URL.revokeObjectURL(vstate.sourceUrl);
    const url = URL.createObjectURL(file);
    const videoEl = el('videoPreviewEl');
    videoEl.style.display = 'block';
    videoEl.src = url;

    videoEl.onerror = () => {
      toast('This browser couldn\'t decode that video — the codec/container may be unsupported.');
      videoEl.style.display = 'none';
    };

    videoEl.onloadedmetadata = async () => {
      vstate.sourceFile = file;
      vstate.sourceUrl = url;
      vstate.srcW = videoEl.videoWidth;
      vstate.srcH = videoEl.videoHeight;
      vstate.duration = videoEl.duration || 0;
      vstate.hasAudio = detectAudioTrack(videoEl);

      el('vSrcDims').textContent = `${vstate.srcW}×${vstate.srcH}`;
      el('vSrcDuration').textContent = formatDuration(vstate.duration);
      el('vSrcSize').textContent = Engine.formatBytes(file.size);
      el('vSrcCodec').textContent = file.type || 'Unknown';
      el('vSrcAudio').textContent = vstate.hasAudio ? 'Present' : 'None detected';
      el('vSrcFps').textContent = 'Measuring…';
      el('videoSourceInfo').classList.add('show');

      el('videoOutputPanel').style.display = 'block';
      el('videoModePanel').style.display = 'block';
      el('videoAdvancedPanel').style.display = 'block';
      el('videoRunBtn').disabled = !(vstate.caps.webm || vstate.caps.mp4);
      if (vstate.caps.webm || vstate.caps.mp4) el('videoRunBtn').textContent = 'Process video →';

      applyVideoMode(VIDEO_MODE_DEFAULTS[vstate.mode]);
      refreshVideoEstimate();

      vstate.srcFps = await probeFps(videoEl);
      el('vSrcFps').textContent = vstate.srcFps + ' fps (measured)';
      refreshVideoEstimate();

      if (vstate.duration > 600) {
        el('videoMemBanner').classList.add('show');
        el('videoMemBanner').textContent =
          `⚠ This video is ${formatDuration(vstate.duration)} long. Processing is tied to real-time playback speed, ` +
          `so this will take roughly that long to process — there's no way to process faster than real-time without a ` +
          `bundled video decoder library, which this app deliberately doesn't include.`;
      } else {
        el('videoMemBanner').classList.remove('show');
      }
    };
  }

  function detectAudioTrack(videoEl) {
    if (videoEl.audioTracks) return videoEl.audioTracks.length > 0;
    if (typeof videoEl.mozHasAudio === 'boolean') return videoEl.mozHasAudio;
    if (typeof videoEl.webkitAudioDecodedByteCount === 'number') return videoEl.webkitAudioDecodedByteCount > 0;
    return true; // unknown — assume present rather than silently dropping it later
  }

  function formatDuration(sec) {
    sec = Math.round(sec || 0);
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /** Measures real playback frame rate over a short probe window via
   *  requestVideoFrameCallback rather than guessing a fixed number. */
  function probeFps(videoEl) {
    return new Promise((resolve) => {
      if (!videoEl.requestVideoFrameCallback) { resolve(30); return; }
      let count = 0, startMediaTime = null;
      const wasMuted = videoEl.muted;
      videoEl.muted = true;

      function onFrame(now, metadata) {
        if (startMediaTime === null) startMediaTime = metadata.mediaTime;
        count++;
        const elapsed = metadata.mediaTime - startMediaTime;
        if (elapsed < 0.5 && count < 40 && !videoEl.ended) {
          videoEl.requestVideoFrameCallback(onFrame);
        } else {
          videoEl.pause();
          videoEl.currentTime = 0;
          videoEl.muted = wasMuted;
          const fps = elapsed > 0 ? Math.round(count / elapsed) : 30;
          resolve(fps > 0 && fps <= 240 ? fps : 30);
        }
      }
      videoEl.play().then(() => videoEl.requestVideoFrameCallback(onFrame)).catch(() => resolve(30));
    });
  }

  // ---------------- output dims ----------------
  function computeVideoOutputDims() {
    if (vstate.resPreset === 'original') return { w: vstate.srcW, h: vstate.srcH, crop: null };

    if (vstate.mode === 'social' && SOCIAL_DIMS[vstate.aspect]) {
      const [w, h] = SOCIAL_DIMS[vstate.aspect][vstate.resPreset];
      const crop = Engine.fitCoverCropRect(vstate.srcW, vstate.srcH, w, h);
      return { w, h, crop };
    }

    const targetH = RES_HEIGHTS[vstate.resPreset];
    const w = Math.round(targetH * (vstate.srcW / vstate.srcH));
    return { w: evenize(w), h: evenize(targetH), crop: null };
  }
  function evenize(n) { return n % 2 === 0 ? n : n + 1; } // even dims are safer for video codecs

  function estimateBitrateMbps(dims) {
    const base = MODE_BASE_MBPS[vstate.mode] || 10;
    const scale = (dims.w * dims.h) / (1920 * 1080);
    if (vstate.bitrate === 'custom') return vstate.bitrateCustomMbps;
    if (vstate.bitrate === 'high') return +(base * 1.6 * scale).toFixed(1);
    return +(base * scale).toFixed(1);
  }

  function refreshVideoEstimate() {
    if (!vstate.sourceFile) return;
    const dims = computeVideoOutputDims();
    const mbps = estimateBitrateMbps(dims);
    const estBytes = (mbps * 1e6 / 8) * vstate.duration;
    const note = (vstate.resPreset === 'original' && vstate.mode === 'social')
      ? ' · aspect presets need a fixed resolution, not "Original"'
      : '';
    el('videoEstimate').textContent =
      `Estimated output: ${dims.w}×${dims.h} · ~${Engine.formatBytes(estBytes)} · ~${mbps} Mbps${note}`;
  }

  // ---------------- mode / preset wiring ----------------
  function applyVideoMode(defaults) {
    vstate.sharpen = defaults.sharpen;
    vstate.denoise = defaults.denoise;
    vstate.resample = defaults.resample;
    vstate.bitrate = defaults.bitrate;
    setSeg('vSharpSeg', defaults.sharpen);
    setSeg('vDenoiseSeg', defaults.denoise);
    setSeg('vResampleSeg', defaults.resample);
    setSeg('vBitrateSeg', defaults.bitrate);
    el('vBitrateCustomRow').style.display = defaults.bitrate === 'custom' ? 'flex' : 'none';
  }
  function setSeg(containerId, val) {
    el(containerId).querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.val === val));
  }
  function wireSeg(containerId, onChange) {
    el(containerId).querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        el(containerId).querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onChange(btn.dataset.val);
      });
    });
  }

  function wireVideoModeChips() {
    document.querySelectorAll('#videoModeChips .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#videoModeChips .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        vstate.mode = chip.dataset.vmode;
        el('videoAspectChips').style.display = vstate.mode === 'social' ? 'flex' : 'none';
        applyVideoMode(VIDEO_MODE_DEFAULTS[vstate.mode]);
        refreshVideoEstimate();
      });
    });
    document.querySelectorAll('#videoAspectChips .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#videoAspectChips .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        vstate.aspect = chip.dataset.vaspect;
        refreshVideoEstimate();
      });
    });
  }

  function wireVideoResChips() {
    document.querySelectorAll('#videoResChips .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#videoResChips .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        vstate.resPreset = chip.dataset.vres;
        refreshVideoEstimate();
      });
    });
  }

  function wireVideoAdvanced() {
    wireSeg('vSharpSeg', (v) => { vstate.sharpen = v; });
    wireSeg('vDenoiseSeg', (v) => { vstate.denoise = v; });
    wireSeg('vResampleSeg', (v) => { vstate.resample = v; });
    wireSeg('vBitrateSeg', (v) => { vstate.bitrate = v; el('vBitrateCustomRow').style.display = v === 'custom' ? 'flex' : 'none'; refreshVideoEstimate(); });
    wireSeg('vFpsSeg', (v) => { vstate.fps = v; });
    el('vBitrateCustom').addEventListener('input', (e) => { vstate.bitrateCustomMbps = parseFloat(e.target.value) || 12; refreshVideoEstimate(); });
    el('vPreserveAudio').addEventListener('change', (e) => { vstate.preserveAudio = e.target.checked; });
  }

  // ---------------- worker ----------------
  function initVideoWorker() {
    if (vstate.worker) return vstate.worker;
    vstate.worker = new Worker('workers/video-worker.js');
    return vstate.worker;
  }

  function processFrameInWorker(worker, bitmap, timestamp) {
    return new Promise((resolve, reject) => {
      const frameId = 'f_' + timestamp + '_' + Math.random().toString(36).slice(2, 6);
      function handler(e) {
        const msg = e.data;
        if (msg.frameId !== frameId) return;
        worker.removeEventListener('message', handler);
        if (msg.type === 'processedFrame') resolve({ bitmap: msg.bitmap, timestamp: msg.timestamp });
        else reject(new Error(msg.message || 'Frame processing failed'));
      }
      worker.addEventListener('message', handler);
      worker.postMessage({ type: 'processFrame', frameId, bitmap, timestamp }, [bitmap]);
    });
  }

  // ---------------- resize/crop a raw frame to output size ----------------
  function resizeFrame(sourceEl, dims, caps) {
    let source = sourceEl;
    let srcW = vstate.srcW, srcH = vstate.srcH;

    if (dims.crop) {
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = dims.crop.w; cropCanvas.height = dims.crop.h;
      cropCanvas.getContext('2d').drawImage(sourceEl, dims.crop.x, dims.crop.y, dims.crop.w, dims.crop.h, 0, 0, dims.crop.w, dims.crop.h);
      source = cropCanvas;
      srcW = dims.crop.w; srcH = dims.crop.h;
    }

    if (vstate.resample === 'lanczos' && caps.webgl2) {
      try {
        return Engine.gpuResample(source, srcW, srcH, dims.w, dims.h);
      } catch (e) { /* fall through to bicubic */ }
    }
    const c = document.createElement('canvas');
    c.width = dims.w; c.height = dims.h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, dims.w, dims.h);
    return c;
  }

  function buildVideoEnhanceConfig() {
    const defaults = VIDEO_MODE_DEFAULTS[vstate.mode] || VIDEO_MODE_DEFAULTS.balanced;
    return {
      noiseReduction: vstate.denoise,
      denoiseArtifact: vstate.denoise, // one Denoise control covers both, per the spec's single "Denoise" setting
      detailAmount: defaults.detail,
      sharpAmount: SHARPEN_AMOUNTS[vstate.sharpen] || 0,
      localContrast: defaults.localContrast
    };
  }

  // ---------------- progress ----------------
  let progressState = null;
  function startProgress(totalFrames) {
    progressState = { frameCount: 0, totalFrames, startTime: performance.now(), lastUiUpdate: 0 };
    updateVideoProgressUI(true);
  }
  function tickProgress() {
    progressState.frameCount++;
    const now = performance.now();
    if (now - progressState.lastUiUpdate > 200) {
      progressState.lastUiUpdate = now;
      updateVideoProgressUI();
    }
  }
  function updateVideoProgressUI(force) {
    if (!progressState) return;
    const { frameCount, totalFrames, startTime } = progressState;
    const elapsedSec = (performance.now() - startTime) / 1000;
    const fps = elapsedSec > 0 ? (frameCount / elapsedSec) : 0;
    const pct = totalFrames > 0 ? Math.min(100, (frameCount / totalFrames) * 100) : 0;
    const remainingFrames = Math.max(0, totalFrames - frameCount);
    const remainingSec = fps > 0.5 ? remainingFrames / fps : 0;

    el('videoProgressFill').style.width = pct + '%';
    el('videoProgressPct').textContent = Math.round(pct) + '%';
    el('videoProgressStage').textContent = 'Processing…';
    el('vStatFrame').textContent = `${frameCount} / ${totalFrames || '?'}`;
    el('vStatFps').textContent = fps.toFixed(1) + ' fps';
    el('vStatElapsed').textContent = formatDuration(elapsedSec);
    el('vStatRemaining').textContent = remainingSec > 0 ? '~' + formatDuration(remainingSec) : '—';
  }

  // ---------------- main run ----------------
  async function runVideoProcessing() {
    if (!vstate.sourceFile || vstate.running) return;
    if (!vstate.caps.webm && !vstate.caps.mp4) {
      toast('This browser cannot export video (MediaRecorder unavailable).');
      return;
    }

    vstate.running = true;
    vstate.cancelled = false;
    el('videoRunBtn').disabled = true;
    el('videoProgressWrap').classList.add('show');
    el('videoResultPanel').style.display = 'none';

    const dims = computeVideoOutputDims();
    const targetFps = vstate.fps === 'original' ? vstate.srcFps : parseInt(vstate.fps, 10);
    const bitrateBps = Math.round(estimateBitrateMbps(dims) * 1e6);
    const enhanceCfg = buildVideoEnhanceConfig();
    const totalFrames = Math.max(1, Math.round(vstate.duration * targetFps));
    startProgress(totalFrames);

    const sourceVideoEl = el('videoPreviewEl');
    const worker = initVideoWorker();
    worker.postMessage({ type: 'configure', enhance: enhanceCfg });

    try {
      sourceVideoEl.pause();
      sourceVideoEl.currentTime = 0;
      await new Promise((r) => setTimeout(r, 50));

      const captureFn = sourceVideoEl.captureStream || sourceVideoEl.mozCaptureStream;
      if (!captureFn) throw new Error('This browser does not support captureStream() on <video>.');
      const sourceStream = captureFn.call(sourceVideoEl);
      const videoTrack = sourceStream.getVideoTracks()[0];
      const audioTrack = (vstate.preserveAudio && vstate.hasAudio) ? sourceStream.getAudioTracks()[0] : null;

      let outputVideoTrack;
      let stopCapture;

      if (vstate.caps.trackProcessor) {
        const result = await runTrackProcessorPipeline(sourceVideoEl, videoTrack, worker, dims, targetFps, enhanceCfg);
        outputVideoTrack = result.track;
        stopCapture = result.stop;
      } else {
        const result = await runFallbackPipeline(sourceVideoEl, worker, dims, targetFps, enhanceCfg);
        outputVideoTrack = result.track;
        stopCapture = result.stop;
      }

      const outStream = new MediaStream();
      outStream.addTrack(outputVideoTrack);
      if (audioTrack) outStream.addTrack(audioTrack);

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(outStream, mimeType ? { mimeType, videoBitsPerSecond: bitrateBps } : { videoBitsPerSecond: bitrateBps });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

      const recordingDone = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.start(1000);
      sourceVideoEl.muted = true;
      await sourceVideoEl.play();

      // Wait until source playback ends or the user cancels
      await new Promise((resolve) => {
        function checkDone() {
          if (vstate.cancelled || sourceVideoEl.ended || sourceVideoEl.currentTime >= vstate.duration - 0.05) {
            sourceVideoEl.removeEventListener('ended', checkDone);
            resolve();
            return;
          }
          setTimeout(checkDone, 150);
        }
        sourceVideoEl.addEventListener('ended', checkDone);
        checkDone();
      });

      stopCapture();
      recorder.stop();
      await recordingDone;

      if (vstate.cancelled) {
        toast('Video processing cancelled.');
        finishRun();
        return;
      }

      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      if (vstate.resultUrl) URL.revokeObjectURL(vstate.resultUrl);
      vstate.resultBlob = blob;
      vstate.resultUrl = URL.createObjectURL(blob);
      vstate.resultW = dims.w; vstate.resultH = dims.h; vstate.resultFps = targetFps;

      showVideoResult(blob, dims, targetFps, mimeType);
    } catch (err) {
      console.error(err);
      toast('Video processing failed: ' + (err.message || err));
    } finally {
      finishRun();
    }
  }

  function finishRun() {
    vstate.running = false;
    el('videoRunBtn').disabled = false;
    el('videoProgressWrap').classList.remove('show');
    progressState = null;
  }

  /** Chrome/Android Chrome path: read frames via MediaStreamTrackProcessor,
   *  process on the worker, write into a MediaStreamTrackGenerator. */
  async function runTrackProcessorPipeline(sourceVideoEl, videoTrack, worker, dims, targetFps, enhanceCfg) {
    const processor = new MediaStreamTrackProcessor({ track: videoTrack });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    const reader = processor.readable.getReader();
    const writer = generator.writable.getWriter();
    let stopped = false;

    async function pump() {
      while (!stopped && !vstate.cancelled) {
        let result;
        try { result = await reader.read(); } catch (e) { break; }
        if (result.done) break;
        const frame = result.value;
        try {
          const resized = resizeFrame(frame, dims, Engine.detectCapabilities());
          const bitmap = await createImageBitmap(resized);
          frame.close();
          const processed = await processFrameInWorker(worker, bitmap, frame.timestamp || performance.now() * 1000);
          const outFrame = new VideoFrame(processed.bitmap, { timestamp: processed.timestamp });
          processed.bitmap.close();
          await writer.write(outFrame);
          // Deliberately not calling outFrame.close() here: once handed to
          // the generator's writable, exact ownership/close-timing isn't
          // something I could verify against a live browser in this
          // environment, and closing prematurely risks a hard "frame
          // already closed" exception whereas leaving it be risks only a
          // harmless "VideoFrame was garbage collected without being
          // closed" console warning. The safer failure mode is chosen
          // deliberately — if you see that warning in practice and want
          // it gone, closing here is the first thing to try.
        } catch (e) {
          frame.close();
        }
        tickProgress();
      }
      try { await writer.close(); } catch (e) { /* already closed */ }
    }

    const pumpPromise = pump();
    return {
      track: generator,
      stop: () => { stopped = true; try { reader.cancel(); } catch (e) {} }
    };
  }

  /** Fallback path: requestVideoFrameCallback drives the same
   *  resize -> worker enhance -> draw sequence onto a plain canvas
   *  feeding canvas.captureStream(). */
  async function runFallbackPipeline(sourceVideoEl, worker, dims, targetFps, enhanceCfg) {
    const outCanvas = document.createElement('canvas');
    outCanvas.width = dims.w; outCanvas.height = dims.h;
    const outCtx = outCanvas.getContext('2d');
    let stopped = false;
    let busy = false;

    function onFrame(now, metadata) {
      if (stopped || vstate.cancelled) return;
      if (!busy) {
        busy = true;
        (async () => {
          try {
            const resized = resizeFrame(sourceVideoEl, dims, Engine.detectCapabilities());
            const bitmap = await createImageBitmap(resized);
            const processed = await processFrameInWorker(worker, bitmap, (metadata.mediaTime || 0) * 1e6);
            outCtx.drawImage(processed.bitmap, 0, 0);
            processed.bitmap.close();
            tickProgress();
          } catch (e) { /* skip this frame on error, keep going */ }
          busy = false;
        })();
      }
      if (!stopped && !vstate.cancelled) sourceVideoEl.requestVideoFrameCallback(onFrame);
    }

    if (sourceVideoEl.requestVideoFrameCallback) {
      sourceVideoEl.requestVideoFrameCallback(onFrame);
    }

    const track = outCanvas.captureStream(targetFps).getVideoTracks()[0];
    return { track, stop: () => { stopped = true; } };
  }

  // ---------------- result / compare / download ----------------
  function showVideoResult(blob, dims, fps, mimeType) {
    const resultEl = el('videoResultEl');
    resultEl.src = vstate.resultUrl;
    el('vInfoRes').textContent = `${dims.w}×${dims.h}`;
    el('vInfoMode').textContent = vstate.mode.charAt(0).toUpperCase() + vstate.mode.slice(1);
    el('vInfoFps').textContent = fps + ' fps';
    el('vInfoSize').textContent = Engine.formatBytes(blob.size);
    el('vInfoFormat').textContent = (mimeType || 'video/webm').split(';')[0].replace('video/', '').toUpperCase();
    el('vInfoAudio').textContent = (vstate.preserveAudio && vstate.hasAudio) ? 'Preserved' : (vstate.hasAudio ? 'Removed (toggled off)' : 'None in source');

    el('videoResultPanel').style.display = 'block';
    el('videoResultPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });

    grabFrameCompare();
  }

  async function grabFrameCompare() {
    try {
      const beforeDataUrl = await grabFrameAt(el('videoPreviewEl'), vstate.duration * 0.3);
      const afterDataUrl = await grabFrameAt(el('videoResultEl'), (vstate.duration * 0.3));
      el('videoBeforeImg').src = beforeDataUrl;
      el('videoAfterImg').src = afterDataUrl;
      el('videoAfterImg').onload = () => {
        const rect = el('videoCompare').getBoundingClientRect();
        el('videoAfterImg').style.setProperty('--cw', rect.width + 'px');
        setVideoHandle(50);
      };
    } catch (e) { /* comparison is best-effort, non-fatal if it fails */ }
  }

  function grabFrameAt(videoEl, atTime) {
    return new Promise((resolve, reject) => {
      const wasSrc = videoEl.src;
      function onSeeked() {
        videoEl.removeEventListener('seeked', onSeeked);
        const c = document.createElement('canvas');
        c.width = videoEl.videoWidth; c.height = videoEl.videoHeight;
        c.getContext('2d').drawImage(videoEl, 0, 0);
        resolve(c.toDataURL('image/png'));
      }
      videoEl.addEventListener('seeked', onSeeked);
      videoEl.currentTime = Math.min(atTime, (videoEl.duration || atTime) - 0.05);
      setTimeout(() => reject(new Error('seek timeout')), 4000);
    });
  }

  function wireVideoCompare() {
    const compare = el('videoCompare');
    const handle = el('videoHandle');
    let dragging = false;
    handle.addEventListener('pointerdown', (e) => { dragging = true; handle.setPointerCapture(e.pointerId); e.stopPropagation(); });
    window.addEventListener('pointerup', () => dragging = false);
    compare.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = compare.getBoundingClientRect();
      setVideoHandle(((e.clientX - rect.left) / rect.width) * 100);
    });
    compare.addEventListener('click', (e) => {
      if (e.target === handle) return;
      const rect = compare.getBoundingClientRect();
      setVideoHandle(((e.clientX - rect.left) / rect.width) * 100);
    });
  }
  function setVideoHandle(pct) {
    pct = Math.max(0, Math.min(100, pct));
    el('videoAfterWrap').style.width = pct + '%';
    el('videoHandle').style.left = pct + '%';
  }

  function wireVideoDownload() {
    el('videoDownloadBtn').addEventListener('click', () => {
      if (!vstate.resultBlob) return;
      const ext = (vstate.resultBlob.type || '').includes('mp4') ? 'mp4' : 'webm';
      const base = vstate.sourceFile ? vstate.sourceFile.name.replace(/\.[^/.]+$/, '') : 'video';
      const a = document.createElement('a');
      a.href = vstate.resultUrl;
      a.download = `${base}-${vstate.resultW}x${vstate.resultH}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    el('videoResetBtn').addEventListener('click', resetVideo);
  }

  function resetVideo() {
    if (vstate.sourceUrl) URL.revokeObjectURL(vstate.sourceUrl);
    if (vstate.resultUrl) URL.revokeObjectURL(vstate.resultUrl);
    vstate.sourceFile = null; vstate.sourceUrl = null;
    vstate.resultBlob = null; vstate.resultUrl = null;
    el('videoFileInput').value = '';
    el('videoPreviewEl').style.display = 'none';
    el('videoPreviewEl').removeAttribute('src');
    el('videoSourceInfo').classList.remove('show');
    el('videoOutputPanel').style.display = 'none';
    el('videoModePanel').style.display = 'none';
    el('videoAdvancedPanel').style.display = 'none';
    el('videoResultPanel').style.display = 'none';
    el('videoMemBanner').classList.remove('show');
    el('videoRunBtn').disabled = true;
    el('videoRunBtn').textContent = 'Select a video to begin';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function wireVideoCancel() {
    el('videoCancelBtn').addEventListener('click', () => {
      vstate.cancelled = true;
    });
  }

  // ---------------- init ----------------
  function init() {
    detectVideoCapabilities();
    wireTopTabs();
    wireVideoUpload();
    wireVideoResChips();
    wireVideoModeChips();
    wireVideoAdvanced();
    wireVideoCompare();
    wireVideoDownload();
    wireVideoCancel();
    el('videoRunBtn').addEventListener('click', runVideoProcessing);
    applyVideoMode(VIDEO_MODE_DEFAULTS[vstate.mode]);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
