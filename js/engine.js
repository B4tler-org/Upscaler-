/* ============================================================
   engine.js
   Capability detection + the two "real" processing tiers that
   ship by default:
     - GPU tier: WebGL2 fragment-shader Lanczos3 upscale + a
       GPU unsharp-mask / denoise pass.
     - CPU tier: progressive <canvas> resampling (stepped so no
       single resize jump exceeds 2x) + a tiled CPU convolution
       pass for sharpen/denoise, run in a Web Worker so the UI
       thread doesn't lock.
   The AI tier lives in ai-engine.js and is loaded lazily only
   if the user selects it.
   ============================================================ */

const Engine = (() => {

  // ---------- capability detection ----------
  function detectCapabilities() {
    const caps = {
      webgpu: false,
      webgl2: false,
      offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
      worker: typeof Worker !== 'undefined',
      deviceMemoryGB: navigator.deviceMemory || null, // Chrome-only, null elsewhere
      cores: navigator.hardwareConcurrency || 4,
      isMobile: /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    };
    try {
      caps.webgpu = !!navigator.gpu;
    } catch (e) { caps.webgpu = false; }
    try {
      const c = document.createElement('canvas');
      caps.webgl2 = !!c.getContext('webgl2');
    } catch (e) { caps.webgl2 = false; }
    return caps;
  }

  // ---------- memory estimation & safety ----------
  // Rule of thumb: an RGBA canvas costs w*h*4 bytes, and a resample
  // pipeline typically holds 2-3 full buffers live at once (source,
  // intermediate, destination), plus the browser's own compositor
  // copy. We budget for ~4x the raw pixel buffer size.
  function estimateMemoryBytes(w, h, buffersInFlight = 4) {
    return w * h * 4 * buffersInFlight;
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  // Devices report deviceMemory in GB (and it's a low-confidence,
  // rounded-down number by design). We treat "unknown" as mid-tier
  // mobile rather than assuming desktop headroom.
  function memoryBudgetBytes(caps) {
    const gb = caps.deviceMemoryGB || (caps.isMobile ? 4 : 8);
    // Never assume the browser can use the whole device budget;
    // a single tab realistically gets a fraction of it.
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
      risk: need > budget ? (need > budget * 2 ? 'high' : 'medium') : 'low',
      recommendTiling: targetW * targetH > 3840 * 2160 // above 4K, always tile
    };
  }

  // Suggest a tile size (square) so that a handful of tiles in
  // flight stays comfortably under budget, and so AI inference
  // (which is quadratic-ish in tile area) stays tractable.
  function suggestTileSize(caps) {
    if (caps.isMobile) return caps.deviceMemoryGB && caps.deviceMemoryGB <= 3 ? 384 : 512;
    return 768;
  }

  // ---------- fit-to-target helper ----------
  function fitContain(srcW, srcH, boxW, boxH) {
    const ratio = Math.min(boxW / srcW, boxH / srcH);
    return { w: Math.max(1, Math.round(srcW * ratio)), h: Math.max(1, Math.round(srcH * ratio)) };
  }

  // For fixed-aspect export presets (Instagram, Stories) where the
  // target aspect ratio usually differs from the source: scale to
  // cover the box, then the caller center-crops to it exactly.
  function fitCoverCropRect(srcW, srcH, boxW, boxH) {
    const srcRatio = srcW / srcH;
    const boxRatio = boxW / boxH;
    let cropW, cropH;
    if (srcRatio > boxRatio) {
      cropH = srcH;
      cropW = Math.round(srcH * boxRatio);
    } else {
      cropW = srcW;
      cropH = Math.round(srcW / boxRatio);
    }
    const x = Math.round((srcW - cropW) / 2);
    const y = Math.round((srcH - cropH) / 2);
    return { x, y, w: cropW, h: cropH };
  }

  // ============================================================
  // GPU TIER — WebGL2 Lanczos3 upscale shader
  // ============================================================
  const LANCZOS_VERT = `#version 300 es
    in vec2 aPos;
    out vec2 vUv;
    void main() {
      vUv = (aPos + 1.0) * 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  // Real 3-lobe Lanczos resampling, separable pass (horizontal then
  // vertical) so cost stays linear in taps rather than quadratic.
  const LANCZOS_FRAG = `#version 300 es
    precision highp float;
    in vec2 vUv;
    out vec4 outColor;
    uniform sampler2D uTex;
    uniform vec2 uSrcSize;
    uniform vec2 uDstSize;
    uniform vec2 uDirection; // (1,0) horizontal pass, (0,1) vertical pass

    const float PI = 3.14159265359;
    const float A = 3.0; // lanczos window (3 lobes)

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
      // Sample position in source-pixel space along the active axis
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

  // Mild GPU unsharp mask, applied after the two lanczos passes to
  // recover edge contrast that any resampler softens.
  const SHARPEN_FRAG = `#version 300 es
    precision highp float;
    in vec2 vUv;
    out vec4 outColor;
    uniform sampler2D uTex;
    uniform vec2 uSize;
    uniform float uAmount; // 0..1

    void main() {
      vec2 texel = 1.0 / uSize;
      vec4 center = texture(uTex, vUv);
      vec4 blur =
        texture(uTex, vUv + texel * vec2(-1.0, 0.0)) +
        texture(uTex, vUv + texel * vec2( 1.0, 0.0)) +
        texture(uTex, vUv + texel * vec2( 0.0,-1.0)) +
        texture(uTex, vUv + texel * vec2( 0.0, 1.0));
      blur *= 0.25;
      vec4 sharpened = center + (center - blur) * uAmount * 2.0;
      outColor = clamp(sharpened, 0.0, 1.0);
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
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1
    ]), gl.STATIC_DRAW);
    return buf;
  }

  // Two distinct WebGL2 texImage2D call shapes are needed: uploading
  // a real image/canvas source uses the (format, type, source) overload,
  // while allocating an empty render-target texture uses the
  // (width, height, border, format, type, null) overload. Mixing them
  // (e.g. passing a canvas alongside explicit width/height) throws a
  // TypeError in real browsers, so these are kept as separate functions.
  function createSourceTexture(gl, source) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // WebGL's texture V axis runs bottom-to-top while a normal <canvas>
    // image source's rows run top-to-bottom; left uncorrected, that
    // mismatch renders the final image upside down. Flipping on upload
    // (rather than in the shader) keeps every pass's UV math simple and
    // only needs to happen once, at the one place a real image enters
    // the pipeline.
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

  /**
   * GPU upscale using a real two-pass separable Lanczos3 shader,
   * followed by a mild unsharp-mask pass. Runs on an offscreen
   * WebGL2 canvas and returns a canvas the caller can read pixels
   * from or draw elsewhere.
   */
  function gpuUpscale(sourceCanvasOrBitmap, srcW, srcH, dstW, dstH, opts) {
    opts = opts || {};
    const sharpenAmount = opts.sharpen != null ? opts.sharpen : 0.35;

    const glCanvas = document.createElement('canvas');
    glCanvas.width = dstW;
    glCanvas.height = dstH;
    const gl = glCanvas.getContext('webgl2', { premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 unavailable');

    const quad = makeQuad(gl);
    const lanczosProg = createProgram(gl, LANCZOS_VERT, LANCZOS_FRAG);
    const sharpenProg = createProgram(gl, LANCZOS_VERT, SHARPEN_FRAG);

    function bindQuad(prog) {
      const loc = gl.getAttribLocation(prog, 'aPos');
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    // Source texture
    const srcTex = createSourceTexture(gl, sourceCanvasOrBitmap);

    // Pass 1: horizontal lanczos, srcW x srcH -> dstW x srcH
    const midW = dstW, midH = srcH;
    const midTex = createEmptyTexture(gl, midW, midH);
    const midFBO = createFBO(gl, midTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, midFBO);
    gl.viewport(0, 0, midW, midH);
    gl.useProgram(lanczosProg);
    bindQuad(lanczosProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(lanczosProg, 'uTex'), 0);
    gl.uniform2f(gl.getUniformLocation(lanczosProg, 'uSrcSize'), srcW, srcH);
    gl.uniform2f(gl.getUniformLocation(lanczosProg, 'uDstSize'), midW, midH);
    gl.uniform2f(gl.getUniformLocation(lanczosProg, 'uDirection'), 1, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Pass 2: vertical lanczos, midW x midH -> dstW x dstH
    const dstTex = createEmptyTexture(gl, dstW, dstH);
    const dstFBO = createFBO(gl, dstTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFBO);
    gl.viewport(0, 0, dstW, dstH);
    gl.useProgram(lanczosProg);
    bindQuad(lanczosProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, midTex);
    gl.uniform1i(gl.getUniformLocation(lanczosProg, 'uTex'), 0);
    gl.uniform2f(gl.getUniformLocation(lanczosProg, 'uSrcSize'), midW, midH);
    gl.uniform2f(gl.getUniformLocation(lanczosProg, 'uDstSize'), dstW, dstH);
    gl.uniform2f(gl.getUniformLocation(lanczosProg, 'uDirection'), 0, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Pass 3: sharpen, dstTex -> default framebuffer (glCanvas)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, dstW, dstH);
    gl.useProgram(sharpenProg);
    bindQuad(sharpenProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dstTex);
    gl.uniform1i(gl.getUniformLocation(sharpenProg, 'uTex'), 0);
    gl.uniform2f(gl.getUniformLocation(sharpenProg, 'uSize'), dstW, dstH);
    gl.uniform1f(gl.getUniformLocation(sharpenProg, 'uAmount'), sharpenAmount);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // cleanup GPU objects (keep the drawn canvas)
    gl.deleteTexture(srcTex);
    gl.deleteTexture(midTex);
    gl.deleteTexture(dstTex);
    gl.deleteFramebuffer(midFBO);
    gl.deleteFramebuffer(dstFBO);
    gl.deleteProgram(lanczosProg);
    gl.deleteProgram(sharpenProg);
    gl.deleteBuffer(quad);

    return glCanvas;
  }

  // ============================================================
  // CPU TIER — progressive resample (used as final fallback, and
  // as the finishing step after AI tile inference to hit an exact
  // target size).
  // ============================================================
  function progressiveResampleSync(sourceEl, srcW, srcH, dstW, dstH) {
    let curW = srcW, curH = srcH;
    let cur = document.createElement('canvas');
    cur.width = curW; cur.height = curH;
    cur.getContext('2d').drawImage(sourceEl, 0, 0, curW, curH);

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
    gpuUpscale,
    progressiveResampleSync
  };
})();
