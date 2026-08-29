# UPRES PRO — Image Upscaler & Graphics Enhancer

A static, client-side, mobile-first web app for upscaling images to 4K/DCI-4K/8K and enhancing social/poster graphics — pure HTML/CSS/vanilla JS, no build step, no backend, GitHub Pages ready.

```
upres/
├── index.html
├── style.css
├── script.js
├── js/
│   ├── engine.js       — capability detection, memory safety, WebGL2 Lanczos3 GPU tier, CPU resample
│   ├── worker.js        — Web Worker: tiled resize + sharpen/denoise/edge filters
│   ├── ai-engine.js     — optional AI Super Resolution (ONNX Runtime Web), lazy-loaded
│   └── api-engine.js    — optional bring-your-own-key cloud API integration
├── models/               — put an .onnx super-resolution model here to enable AI mode (empty by default)
├── assets/               — (unused by default, room for icons/screenshots)
└── README.md
```

## 1. Deploy to GitHub Pages

1. Create/use a repo and add all files above at the **repo root** (keep the `js/` and `models/` folder structure — paths in the code are relative).
2. Push to GitHub.
3. **Settings → Pages → Source → Deploy from a branch**, branch `main`, folder `/ (root)`.
4. Live at `https://<username>.github.io/<repo-name>/`.

No `npm install`, no bundler, no server config. Everything runs from static files.

## 2. What actually happens when you click "Upscale"

The app picks one of three processing tiers, and always tells you honestly which one it used in the **Processing Information** panel after a run:

| Tier | What it is | When it's used |
|---|---|---|
| **AI Super Resolution** | A real neural super-resolution model (e.g. Real-ESRGAN), run in-browser via [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/), tiled so it doesn't blow up memory. | Only if you've added a model file (see §3) — otherwise the app **does not pretend**; it says so and falls back automatically. |
| **GPU Enhanced** | A genuine two-pass separable **Lanczos3** upscale shader running on WebGL2, plus a GPU unsharp-mask pass. This is real GPU-accelerated resampling, not AI. | When WebGL2 is available and the target is at or below ~4K/DCI-4K sized (see §5 on why 8K skips this tier). |
| **High Quality Resampling** | Progressive `<canvas>` resizing (never more than 2× per step, which avoids the softening/aliasing of one giant resize), run tile-by-tile inside a Web Worker via `OffscreenCanvas` so the UI thread never blocks. | Always available; the fallback of last resort, and the tier used for 8K exports regardless of what's selected, for memory safety. |

None of these tiers "hallucinate" detail the way a full diffusion-based upscaler can — the AI tier is the only one that can add plausible texture/detail beyond what's in the source, and only if you've supplied a real model.

## 3. How to add a real AI super-resolution model

The app looks for a model at `./models/realesr-general-x4v3.onnx` (configurable in **Settings** or by editing `MODEL_CONFIG.url` in `js/ai-engine.js`). It is not bundled, on purpose — a real model is tens of megabytes, and shipping a silent third-party download would be exactly the kind of thing this app is trying to avoid.

**Steps:**

1. Get a Real-ESRGAN (or similar RRDBNet-family) model already exported to ONNX. A few public sources as of writing (verify licenses and that the file still exists before using):
   - `huggingface.co/qualcomm/Real-ESRGAN-x4plus` — `Real-ESRGAN-x4plus.onnx`
   - `huggingface.co/SceneWorks/real-esrgan-onnx` — `real_esrgan_x4.onnx` / `real_esrgan_x2.onnx`
   - Or export your own from the original [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) PyTorch weights using `torch.onnx.export`.
2. Rename it (or update the path) and place it at `models/realesr-general-x4v3.onnx` in your repo.
3. Open **Settings** in the app (or edit `js/ai-engine.js` directly) and confirm/adjust:
   - `inputName` / `outputName` — the exact tensor names your export uses. Inspect with [Netron](https://netron.app) if unsure.
   - `scale` — 2 or 4, matching the model variant.
   - `tileSize` / `overlap` — lower `tileSize` (e.g. 96) if you see out-of-memory errors on mobile; raise `overlap` if you see visible seams between tiles.
4. Reload the app. The engine card and Settings modal will report "Model found" once the file is reachable, and the AI tier becomes selectable — no code changes needed beyond step 3 if your model's IO matches the RRDBNet default.

GitHub Pages serves the model as a normal static file — no server-side code needed, and it's lazy-loaded (the ~1MB ONNX Runtime Web library and the model itself only download the first time someone actually runs AI mode, not on page load).

## 4. Configuring an optional cloud API (bring your own key)

Entirely optional, and the app is fully functional without it. In **Settings → Cloud API**, you can point the app at any HTTP endpoint that accepts a base64 image and returns either a base64 image or a URL to one (see `js/api-engine.js` for the exact request/response shape, and adjust it to match your provider — every provider's API looks slightly different).

Your key is stored **only** in this browser's `localStorage`, under the key `upres_api_config_v1`. It is never written into any file in this repo, never sent anywhere except the endpoint you configure, and clearing it (button in Settings) removes it immediately.

**Important CORS caveat:** many cloud AI APIs (Replicate, various upscaler SaaS products) don't allow direct browser-to-API calls from an arbitrary origin — you may need a small serverless proxy (a Cloudflare Worker, Vercel function, etc.) that forwards the request and attaches your key server-side instead of exposing it client-side. That's outside the scope of a static GitHub Pages app; this integration point is designed for providers that do support direct browser calls with a user-supplied key, or for your own proxy's URL.

## 5. Memory safety, tiling, and 8K exports

An 8K RGBA canvas alone is `7680 × 4320 × 4 bytes ≈ 132 MB`, and a naive pipeline can hold several such buffers at once — that's how mobile tabs crash. This app avoids that in three ways:

- **Tiling.** The CPU tier and the AI tier both process the image in small tiles (default 512px on desktop, 384–512px on mobile, configurable in `Engine.suggestTileSize`), with a few pixels of overlap so filters don't show seams at tile boundaries. Peak memory stays bounded to a handful of small tile buffers, not one giant one.
- **GPU tier auto-limit.** Whole-image WebGL2 textures at 8K can exceed a mobile GPU's texture memory. Above ~9.5 megapixels of output (comfortably covers 4K UHD and DCI 4K), the app automatically routes to the tiled CPU pipeline instead — even if you explicitly picked "GPU Enhanced" — and says so honestly in the Processing Information panel.
- **Upfront warning.** Before starting a high-memory export, the app estimates required memory against a conservative budget for the device (using `navigator.deviceMemory` where available) and asks for confirmation if the estimate is high-risk, rather than silently attempting it and possibly crashing the tab.
- **Cancel.** The "Cancel processing" button stops an in-flight Worker job (and, for the AI tier, stops between tiles) rather than requiring a page reload.

## 6. Mobile performance tips

- Prefer the **4K UHD** or **2×/4×** presets over 8K on mid-range phones; 8K is supported but slow and memory-hungry by nature, not a limitation specific to this app.
- The **GPU Enhanced** tier is usually both faster and lower-memory than the CPU tier for anything it supports (see the 4K/DCI-4K limit above) — leave the engine on **Auto** unless you have a specific reason not to.
- If you add an AI model, keep `tileSize` modest (96–192px) for low-RAM Android devices; larger tiles are faster per-pixel but risk out-of-memory failures on inference.
- Noise reduction and edge enhancement passes each add a full tiled convolution pass — stacking all three enhancement sliders high will roughly triple CPU-tier processing time. For most photos, moderate sharpening alone goes a long way.

## 7. Which processing method actually ran?

Every run ends with a **Processing Information** panel showing: source resolution, output resolution, the processing method actually used (with an honest note if it silently fell back from what you selected), the AI model filename if applicable, GPU acceleration status, processing time, estimated memory, and output file size. If AI mode was selected but no model was available, it explicitly says:

> "AI model unavailable — using high-quality GPU/browser resampling."

rather than mislabeling ordinary resampling as AI enhancement.

## 8. Privacy

No image ever leaves the browser unless you explicitly configure and use the optional cloud API in §4. No analytics, no tracking, no login, no database.
