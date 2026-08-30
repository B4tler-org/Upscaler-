/* ============================================================
   engine.js — UPRES (non-AI)
   Capability detection, memory safety, and the two resampling
   backends:
     - GPU: WebGL2 two-pass separable Lanczos3 shader (pure math,
       no ML).
     - CPU: progressive stepped <canvas> resampling (never more
       than 2x per step, which is what keeps a big enlargement
       from looking soft/aliased compared to one giant resize).
   All enhancement (sharpening, denoise, detail, adaptive/text/
   portrait heuristics) lives in worker.js, applied after
   resampling, so it behaves identically regardless of which
   backend produced the base upscale.
   ============================================================ */

const Engine = (() => {

  // ---------- capability detection ----------
  function detectCapabilities() {
    const caps = {
      webgl2: false,
      offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
      worker: typeof Worker !== 'undefined',
      clipboardImage: !!(navigator.clipboard && window.ClipboardItem),
      deviceMemoryGB: navigator.deviceMemory || null, // Chrome-only, null elsewhere
      cores: navigator.hardwareConcurrency || 4,
      isMobile: /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    };
    try {
      const c = document.createElement('canvas');
      caps.webgl2 = !!c.getContext('webgl2');
    } catch (e) { caps.webgl2 = false; }
    return caps;
  }

  // ---------- memory estimation & safety ----------
  function estimateMemoryBytes(w, h, buffersInFlight = 4) {
    return w * h * 4 * buffersInFlight;
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function memoryBudgetBytes(caps) {
    const gb = caps.deviceMemoryGB || (caps.isMobile ? 4 : 8);
    return gb * 1024 * 1024 * 1024 * 0.25;
  }

  function checkMemorySafety(targetW, targetH, caps) {
    const need = estimateMemoryBytes(targetW, targetH);
    const budget = memoryBudgetBytes(caps);
    return {
      estimatedBytes: need,
      estimatedLabel: formatBytes(need),
      budgetBytes: budget,
      budgetLabel: formatBytes(budget),
      risk: need > budget ? (need > budget * 2 ? 'high' : 'medium') : 'low'
    };
  }

  function suggestTileSize(caps) {
    if (caps.isMobile) return caps.deviceMemoryGB && caps.deviceMemoryGB <= 3 ? 320 : 448;
    return 640;
  }

  // ---------- fit helpers ----------
  function fitContain(srcW, srcH, boxW, boxH) {
    const ratio = Math.min(boxW / srcW, boxH / srcH);
    return { w: Math.max(1, Math.round(srcW * ratio)), h: Math.max(1, Math.round(srcH * ratio)) };
  }

  function fitCoverCropRect(srcW, srcH, boxW, boxH) {
    const srcRatio = srcW / srcH;
    const boxRatio = boxW / boxH;
    let cropW, cropH;
    if (srcRatio > boxRatio) { cropH = srcH; cropW = Math.round(srcH * boxRatio); }
    else { cropW = srcW; cropH = Math.round(srcW / boxRatio); }
    const x = Math.round((srcW - cropW) / 2);
    const y = Math.round((srcH - cropH) / 2);
    return { x, y, w: cropW, h: cropH };
  }

  // ============================================================
  // GPU BACKEND — WebGL2 two-pass separable Lanczos3 resample.
  // Pure interpolation math; nothing learned, nothing generative.
  // ============================================================
  const VERT = `#version 300 es
    in vec2 aPos;
    out vec2 vUv;
    void main() {
      vUv = (aPos + 1.0) * 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  const LANCZOS_FRAG = `#version 300 es
    precision highp float;
    in vec2 vUv;
    out vec4 outColor;
    uniform sampler2D uTex;
    uniform vec2 uSrcSize;
    uniform vec2 uDstSize;
    uniform vec2 uDirection;

    const float PI = 3.14159265359;
    const float A = 3.0;

    float sinc(float x) {
      if (abs(x) < 0.0001) return 1.0;
      return sin(PI * x) / (PI * x);
    }
    float lanczosWeight(float x) {
      if (abs(x) >= A) return 0.0;
      return sinc(x) * sinc(x / A);
    }

    void main() {
      vec2 scale = uSrcSize / uDstSize;
      float axisScale = dot(scale, uDirection);
      float dstCoord = dot(vUv * uDstSize, uDirection);
      float srcCoord = (dstCoord + 0.5) * axisScale - 0.5;

      float center = srcCoord;
      int taps = int(ceil(A * max(axisScale, 1.0)));
      vec4 sum = vec4(0.0);
      float wsum = 0.0;

      for (int i = -8; i <= 8; i++) {
        if (i < -taps || i > taps) continue;
        float samplePos = floor(center) + float(i);
        float w = lanczosWeight((samplePos - center) / max(axisScale, 1.0));
        if (w == 0.0) continue;

        vec2 uv;
        if (uDirection.x > 0.5) {
          float clamped = clamp(samplePos, 0.0, uSrcSize.x - 1.0);
          uv = vec2((clamped + 0.5) / uSrcSize.x, vUv.y);
        } else {
          float clamped = clamp(samplePos, 0.0, uSrcSize.y - 1.0);
          uv = vec2(vUv.x, (clamped + 0.5) / uSrcSize.y);
        }
        sum += texture(uTex, uv) * w;
        wsum += w;
      }
      outColor = wsum > 0.0 ? sum / wsum : texture(uTex, vUv);
    }
  `;

  function compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('Shader compile error: ' + log);
    }
    return sh;
  }
  function createProgram(gl, vertSrc, fragSrc) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, vertSrc));
    gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('Program link error: ' + log);
    }
    return prog;
  }
  function makeQuad(gl) {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    return buf;
  }
  function createSourceTexture(gl, source) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Canvas/image sources are top-down; WebGL's V axis is bottom-up.
    // Flip once here so nothing downstream needs special-casing.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return tex;
  }
  function createEmptyTexture(gl, w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return tex;
  }
  function createFBO(gl, tex) {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return fbo;
  }

  /** Pure two-pass separable Lanczos3 resample. Returns a <canvas>. */
  function gpuResample(sourceCanvasOrImage, srcW, srcH, dstW, dstH) {
    const glCanvas = document.createElement('canvas');
    glCanvas.width = dstW; glCanvas.height = dstH;
    const gl = glCanvas.getContext('webgl2', { premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 unavailable');

    const quad = makeQuad(gl);
    const prog = createProgram(gl, VERT, LANCZOS_FRAG);
    function bindQuad() {
      const loc = gl.getAttribLocation(prog, 'aPos');
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    const srcTex = createSourceTexture(gl, sourceCanvasOrImage);

    // Pass 1: horizontal, srcW x srcH -> dstW x srcH
    const midW = dstW, midH = srcH;
    const midTex = createEmptyTexture(gl, midW, midH);
    const midFBO = createFBO(gl, midTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, midFBO);
    gl.viewport(0, 0, midW, midH);
    gl.useProgram(prog);
    bindQuad();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    gl.uniform2f(gl.getUniformLocation(prog, 'uSrcSize'), srcW, srcH);
    gl.uniform2f(gl.getUniformLocation(prog, 'uDstSize'), midW, midH);
    gl.uniform2f(gl.getUniformLocation(prog, 'uDirection'), 1, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Pass 2: vertical, midW x midH -> dstW x dstH, straight to canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, dstW, dstH);
    gl.useProgram(prog);
    bindQuad();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, midTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    gl.uniform2f(gl.getUniformLocation(prog, 'uSrcSize'), midW, midH);
    gl.uniform2f(gl.getUniformLocation(prog, 'uDstSize'), dstW, dstH);
    gl.uniform2f(gl.getUniformLocation(prog, 'uDirection'), 0, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.deleteTexture(srcTex);
    gl.deleteTexture(midTex);
    gl.deleteFramebuffer(midFBO);
    gl.deleteProgram(prog);
    gl.deleteBuffer(quad);

    return glCanvas;
  }

  // ============================================================
  // CPU BACKEND — progressive stepped bicubic-quality resample
  // (browser's own high-quality resampler, stepped so no single
  // jump exceeds 2x). Used when WebGL2 isn't available, and as
  // the "Fast"/"Balanced" backends.
  // ============================================================
  function progressiveResampleSync(sourceEl, srcW, srcH, dstW, dstH, maxStepFactor) {
    const stepCap = maxStepFactor || 2;
    let curW = srcW, curH = srcH;
    let cur = document.createElement('canvas');
    cur.width = curW; cur.height = curH;
    cur.getContext('2d').drawImage(sourceEl, 0, 0, curW, curH);

    while (curW !== dstW || curH !== dstH) {
      const ratio = dstW / curW;
      let nextW, nextH;
      if (Math.abs(ratio - 1) < 0.001) { nextW = dstW; nextH = dstH; }
      else if (ratio > 1) {
        const f = Math.min(stepCap, ratio);
        nextW = Math.round(curW * f); nextH = Math.round(curH * f);
        if (nextW >= dstW * 0.98) { nextW = dstW; nextH = dstH; }
      } else {
        const f = Math.max(1 / stepCap, ratio);
        nextW = Math.round(curW * f); nextH = Math.round(curH * f);
        if (nextW <= dstW * 1.02) { nextW = dstW; nextH = dstH; }
      }
      const next = document.createElement('canvas');
      next.width = nextW; next.height = nextH;
      const ctx = next.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(cur, 0, 0, curW, curH, 0, 0, nextW, nextH);
      cur = next; curW = nextW; curH = nextH;
    }
    return cur;
  }

  return {
    detectCapabilities,
    estimateMemoryBytes,
    formatBytes,
    memoryBudgetBytes,
    checkMemorySafety,
    suggestTileSize,
    fitContain,
    fitCoverCropRect,
    gpuResample,
    progressiveResampleSync
  };
})();
