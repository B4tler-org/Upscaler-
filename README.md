# UPRES — Non-AI Image Upscaler & Graphics Enhancer

A static, client-side, mobile-first web app for upscaling images to 4K/DCI-4K/8K and enhancing social/poster graphics — pure HTML/CSS/vanilla JS, **no AI, no machine learning, no neural networks**, no build step, no backend, GitHub Pages ready.

```
upres/
├── index.html
├── style.css
├── script.js
├── js/
│   ├── engine.js     — capability detection, memory safety, WebGL2 Lanczos3 resample
│   ├── presets.js     — named parameter bundles (Photo / Social / News GFX / Portrait / Max Quality)
│   └── worker.js       — the actual multi-stage processing pipeline, tiled, off the main thread
├── assets/               — (unused by default)
└── README.md
```

Everything runs in the browser. No image ever leaves the device.

## 1. Deploy to GitHub Pages — from an Android phone

You don't need a laptop for this. Two realistic paths on Android:

**Path A — GitHub's own mobile web editor (simplest, no app install):**
1. Open github.com in Chrome, sign in, create a new repository (e.g. `upres`).
2. Tap **Add file → Create new file**. Type `index.html` as the filename, paste its contents (request the file contents from wherever you're reading this, or copy from your own working copy), then **Commit**.
3. Repeat **Add file → Create new file** for `style.css`, `script.js`, `js/engine.js`, `js/presets.js`, `js/worker.js`, and `README.md`. Typing `js/engine.js` as the filename automatically creates the `js/` folder — you don't need a separate step for that.
4. Once all files are committed: **Settings → Pages → Source → Deploy from a branch**, branch `main`, folder `/ (root)`, **Save**.
5. Your app is live at `https://<username>.github.io/<repo-name>/` within a minute or two.

**Path B — a Git-capable app (better if you're iterating a lot):**
1. Install **Working Copy** (iOS) or, on Android, an app like **Termux** (`pkg install git`) or **GitJournal**/**MGit**. Termux + git gives you a real `git clone` / `git commit` / `git push` workflow from your phone's storage.
2. Clone your empty repo, copy these files into it (e.g. via a file manager or `termux-setup-storage` to access Downloads), `git add -A && git commit -m "upres" && git push`.
3. Enable Pages as in step 4 above.

Either way: no `npm install`, no bundler, nothing to compile. The files as given are the deployed files.

## 2. What "non-AI" actually means here, concretely

Every stage below is ordinary, decades-old, published image-processing math — the kind you'd find in a signal-processing textbook, not a research paper about neural networks. Nothing is learned from data; nothing can hallucinate detail that wasn't in the source.

| Stage | What it is |
|---|---|
| **Resampling — Fast** | One `canvas.drawImage()` call at high smoothing quality. Quick, lower quality on big jumps. |
| **Resampling — Balanced** | Progressive stepped resize: every jump is capped at 2×, run as a sequence (e.g. 1×→2×→4×→final) instead of one giant resize. A single huge resize jump looks soft/aliased; stepping it doesn't. |
| **Resampling — Maximum** | A genuine two-pass separable **Lanczos3** convolution running as a WebGL2 fragment shader (real sinc-based interpolation, not just `imageSmoothingQuality`), falling back to the stepped CPU resize if WebGL2 isn't available. |
| **Noise reduction** | Edge-aware smoothing ("bilateral-lite"): each pixel is averaged with its neighborhood, but neighbors are weighted down the more their color differs from the center pixel — so flat/noisy regions get smoothed while real edges are mostly left alone. Off/Low/Medium/High map to increasing radius + tolerance. |
| **JPEG artifact removal** | The same edge-aware smoothing function, with a separate radius/tolerance preset tuned to be gentler and broader — this is a heuristic smoothing pass, not true DCT block-boundary detection (that would need access to the original JPEG coefficients, which the browser doesn't expose once an image is decoded to pixels). |
| **Detail enhancement** | Classic high-pass-add: `output = original + amount × (original − blur(original))` with a small blur radius — recovers fine texture that resampling softens. |
| **Local contrast** | The same high-pass-add technique with a much larger blur radius, at a fixed modest weight — boosts mid-scale tonal "pop" separately from fine detail. |
| **Adaptive sharpening** | Unsharp masking (`original + amount × (original − blur)`) where `amount` is scaled per-pixel by local Sobel edge strength (gentle in smooth areas, stronger on edges/text) and by the protection masks below. A local min/max clamp on the result suppresses the white/black ringing halos that plain unsharp masking produces around strong edges. |
| **Text/logo protection** | A Sobel-edge-density mask, dilated slightly to cover glyph interiors, not just outlines. Where it's high, noise reduction is held back (so crisp edges aren't smoothed away) and sharpening is boosted. Heuristic, not OCR or connected-component text detection — it responds to "lots of local contrast/edges," which text and logos reliably have. |
| **Portrait protection** | A classic RGB skin-tone heuristic (specific R/G/B relationships), combined with a low-local-edge-magnitude requirement so it only flags smooth skin (cheeks, forehead) — not eyes, hair, or eyebrows, which stay normally sharpened. **This is a color heuristic, not face detection.** It will occasionally mis-flag skin-colored non-skin surfaces (wood, terracotta, some sunset skies), which is exactly why it's an opt-in toggle. |

### Pipeline order

```
Original
  ↓  (only if Noise Reduction / JPEG Artifact Removal is on)
Tiled cleanup at ORIGINAL resolution — denoise, deblock
  ↓
Multi-pass / Lanczos3 resample to target resolution
  ↓
Color & tone: auto white balance → auto levels → CLAHE → shadow/highlight recovery
  ↓
Detail enhancement → local contrast → vibrance
  ↓
Adaptive sharpening (always last)
  ↓
Final output
```

Cleaning noise **before** the resample (not after) is deliberate: denoising a small source image is both cheaper and more correct than denoising after upscaling has already spread and amplified that noise across more pixels. Color/tone correction runs before detail/sharpening for the same reason a photo editor's workflow does: there's no point sharpening or boosting the "clarity" of a color cast or a flat, muddy tonal range — fix the color and contrast foundation first, then refine detail on top of it. When a stage's toggle/slider is off, it's skipped entirely rather than run as a no-op.

## 3. Color & tone — beyond sharpness

Sharpening isn't the whole story, and the brief specifically asked for more. These are the newer stages, and — same rule as everything else in this app — every one is a real, published, decades-old technique with a name you can look up, not something invented for this project:

| Stage | What it is |
|---|---|
| **Auto white balance** | Gray-World color correction: assumes a scene with reasonably varied colors averages out to neutral gray, measures how far each channel's mean actually is from that, and scales channels back toward it (gain clamped to a moderate range so a genuinely warm sunset doesn't get corrected into gray mush). |
| **Auto levels** | Per-channel percentile-clipped histogram stretch — finds the black/white point at roughly the 0.4th/99.6th percentile of each channel (so a handful of outlier pixels can't anchor the whole stretch) and remaps that range to the full 0–255 span. The standard "fix flat, washed-out contrast" move in every photo editor. |
| **Adaptive contrast (CLAHE)** | *Contrast-Limited Adaptive Histogram Equalization* (Zuiderveld, Graphics Gems IV, 1994) — the same algorithm used in medical/scientific imaging to bring out detail in both dark and bright regions of a frame at once. Splits the image into an 8×8 tile grid, equalizes each tile's local histogram with a clip limit (preventing the noise amplification that plain histogram equalization is notorious for), and bilinearly blends between neighboring tiles' mappings so no tile boundaries show. Applied as a luminance ratio, not a flat replacement, so color is preserved. |
| **Shadow / highlight recovery** | A luminance-masked tone lift/pull: shadows are lifted in proportion to how dark they already are (quadratic falloff, so midtones are barely touched), highlights pulled down the same way from the bright end. |
| **Vibrance** | Boosts muted colors more than already-saturated ones — unlike a flat saturation multiply, which oversaturates skies and clips vivid colors equally — and specifically damps the boost across skin-tone hues so portraits don't turn plastic-orange the way aggressive flat saturation does. |

All five are genuinely new pipeline stages (implemented in `js/shared-filters.js`, called from both the image and video workers where it's safe to — see the video flicker note below), not new sliders bolted onto the existing sharpening math.

**Why CLAHE, auto white balance, and auto levels are image-only.** All three compute their correction from that specific frame's own pixel statistics — channel means, histograms, tile histograms. In a still image that's exactly right. In video, scene content shifts slightly frame to frame even in a static shot (sensor noise, micro camera-shake, compression), which shifts those statistics too, and the result is visible brightness/color/contrast "breathing" between frames — precisely the flicker the brief said to avoid. Vibrance and shadow/highlight recovery made the cut for video because both are fixed, deterministic per-pixel functions with zero dependency on frame-wide statistics: the same input pixel always produces the same output pixel, so there's nothing for them to drift.

## 4. Quality metrics — measurable, not invented

The Source Quality Analysis and Processing Information panels only show numbers that are actually computed, never a made-up "quality score":

- **Sharpness** — variance of the Laplacian, a standard no-reference focus/sharpness metric. Higher = crisper. Shown before → after so you can see whether a run actually increased measured sharpness.
- **Edge density** — percentage of sampled pixels with Sobel gradient magnitude above a fixed threshold.
- **Noise estimate (σ)** — [Immerkær's fast noise estimation](https://scholar.google.com/scholar?q=immerkaer+fast+noise+variance+estimation) formula: convolve with a Laplacian-of-Gaussian-style kernel, take the mean absolute response, normalize. A real published estimator.

All three are computed on a downsampled (max 512px) grayscale sample so analysis stays fast regardless of source/output size, and run in the Web Worker so they never block the UI.

## 5. Memory safety on 8K exports

An 8K RGBA canvas is `7680 × 4320 × 4 bytes ≈ 132 MB` on its own, and a naive multi-stage pipeline can multiply that several times over — that's how mobile tabs crash. This app avoids that by:

- **Tiling every per-pixel filter.** Noise reduction, JPEG artifact removal, detail enhancement, local contrast, and sharpening all run tile-by-tile (default 320–640px depending on device memory, see `Engine.suggestTileSize`) with a 12px overlap so filters see real neighboring pixels at tile boundaries instead of an artificial edge. Peak memory during these stages stays bounded to a handful of small tile buffers, never one buffer the size of the whole image.
- **A single full-resolution buffer only exists at the resample step and the final output**, both of which are unavoidable — the final image has to exist in memory once to be exported. Everything in between is tiled.
- **An upfront estimate + confirmation.** Before starting a high-memory export, the app estimates required memory against a conservative per-device budget (using `navigator.deviceMemory` where available) and asks for confirmation rather than silently attempting it.
- **Cancel** actually stops an in-flight Worker job between tiles, not just the UI.

If a phone genuinely can't handle an 8K export, the honest outcome is that it's slow or the browser tab restarts it — there's no way to fully prevent that from a static web page with no server-side processing, but tiling keeps the odds firmly in your favor compared to a naive single-buffer approach.

## 6. Mobile performance tips

- **Balanced** resampling quality is the sensible default; **Maximum** (Lanczos3) looks best but costs more, **Fast** is for quick previews.
- Noise Reduction and JPEG Artifact Removal are each a full tiled edge-aware smoothing pass — stacking both at High roughly doubles that portion of processing time. Most clean photos don't need either.
- Local Contrast uses a large blur radius and is the single most expensive enhancement toggle; leave it off unless you specifically want the effect.
- 8K is supported but is inherently the slowest, most memory-hungry option on any device, phone or otherwise — that's the nature of 33 million pixels, not a limitation specific to this app.

## 7. Processing Mode presets

Photo / Social Media / News GFX / Portrait / Max Quality are just starting bundles of the same parameters you can see and adjust yourself (defined plainly in `js/presets.js` — nothing hidden). Changing any individual control after picking a preset automatically switches the mode to **Custom** so your adjustment isn't silently overwritten.

## 8. Video (new)

The Video tab adds real, non-AI, in-browser video upscaling/enhancement — same "no AI, no upload" philosophy as the image side, extended to a second medium with its own real technical constraints, stated plainly rather than glossed over:

- **Output is WebM, not MP4, on almost every device.** Producing a playable video file needs a container muxer; the only one available without bundling a library is the browser's own `MediaRecorder`, which reliably supports WebM (VP8/VP9 + Opus) and only inconsistently supports MP4 (feature-detected — used automatically if your browser happens to support it, otherwise WebM).
- **Processing takes roughly as long as the video's own duration.** There's no container demuxer here to decode frames faster than real-time playback — building one reliably from scratch is a genuinely large undertaking, not something to fake. A 5-minute source video takes around 5+ minutes to process. The one advantage this buys you: the browser's native media pipeline decodes progressively rather than loading the whole file into memory, which is exactly why a 1GB source file is safe to process at all.
- **Two capture backends, feature-detected:**
  - **Chrome / Android Chrome:** `MediaStreamTrackProcessor` reads decoded frames one at a time; each is resized on the main thread (one cheap canvas draw, or through the same WebGL2 Lanczos3 shader the image pipeline uses), handed to `workers/video-worker.js` for the actual enhancement math, and written into a `MediaStreamTrackGenerator` to form a new processed video track — keeping the per-pixel work off the main thread.
  - **Other browsers:** `requestVideoFrameCallback` drives the same resize → worker-enhance → draw sequence onto a plain `<canvas>`, which feeds `canvas.captureStream()` instead. Functionally equivalent; the UI still doesn't block because the worker round-trip per frame is awaited asynchronously between callbacks, not run inline.
- **`js/shared-filters.js`** holds the actual enhancement math (denoise, detail, local contrast, adaptive sharpen) used by *both* `js/worker.js` (image tiles) and `workers/video-worker.js` (video frames) via `importScripts()` — one implementation, not two copies that could drift apart.
- **Text/logo and portrait protection are image-only**, on purpose: those heuristics are inherently a little noisy frame-to-frame, and applying them per-frame without temporal smoothing is exactly the kind of thing that would flicker — the one thing explicitly asked to avoid. Rather than ship a flickery version of a feature, video enhancement sticks to the temporally-stable stages (denoise, detail, sharpen), which are already deterministic per-frame and don't have this problem in practice.
- **Video resampling is single-pass** (Lanczos3 via the WebGL2 shader, or bicubic via canvas), not the multi-pass stepped treatment used for large image upscales — a real-time per-frame budget doesn't leave room for multiple resize passes per frame.

## 9. Full file list for GitHub Pages

```
upres/
├── index.html
├── style.css
├── script.js                  — image pipeline controller
├── js/
│   ├── engine.js                — capability detection, memory safety, WebGL2 Lanczos3
│   ├── presets.js                — image processing-mode presets
│   ├── shared-filters.js          — the actual enhancement math (used by both workers)
│   ├── worker.js                   — image tiled pipeline (imports shared-filters.js)
│   └── video-controller.js          — video tab controller
├── workers/
│   └── video-worker.js               — video per-frame pipeline (imports ../js/shared-filters.js)
├── assets/
└── README.md
```

Upload all of these preserving the folder structure exactly — `js/` and `workers/` must stay as separate top-level folders since `video-worker.js` references `../js/shared-filters.js` by relative path.

## 10. Privacy

No image or video ever leaves the browser. No analytics, no tracking, no login, no database, no external API calls of any kind.
