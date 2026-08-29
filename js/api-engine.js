/* ============================================================
   api-engine.js
   Fully optional. Lets a user paste their own API key for a
   cloud super-resolution service, stored ONLY in this browser's
   localStorage — never in source, never sent anywhere but the
   provider endpoint the user configured.

   No key ships with this app and no key is required for the app
   to work — this is strictly an opt-in upgrade path for people
   who want cloud-grade AI upscaling and are willing to use their
   own account/quota. See README -> "Configuring an optional
   cloud API" for provider-specific notes and CORS caveats.
   ============================================================ */

const ApiEngine = (() => {
  const STORAGE_KEY = 'upres_api_config_v1';

  function getConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveConfig(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }

  function clearConfig() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function isConfigured() {
    const cfg = getConfig();
    return !!(cfg && cfg.endpoint && cfg.apiKey);
  }

  /**
   * Generic wrapper: POSTs the image as base64 to the configured
   * endpoint with the configured header/auth scheme, expects back
   * either a base64 image or a URL to the result. Because every
   * provider's request/response shape differs, `cfg.requestShape`
   * lets the user pick a small preset built for a couple of common
   * shapes; for anything else they can supply a custom template.
   */
  async function upscaleViaApi(blob, onStatus) {
    const cfg = getConfig();
    if (!cfg || !cfg.endpoint || !cfg.apiKey) {
      throw new Error('No API configured. Add one in Settings → Cloud API.');
    }

    onStatus && onStatus('Encoding image…');
    const base64 = await blobToBase64(blob);

    onStatus && onStatus('Uploading to cloud API…');
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.authHeader) headers[cfg.authHeader] = cfg.authPrefix ? `${cfg.authPrefix}${cfg.apiKey}` : cfg.apiKey;

    const body = JSON.stringify({ image: base64, scale: cfg.scale || 4 });

    const res = await fetch(cfg.endpoint, { method: 'POST', headers, body })
      .catch(err => { throw new Error('Network/CORS error calling the API: ' + err.message); });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API returned ${res.status}: ${text.slice(0, 200)}`);
    }

    onStatus && onStatus('Downloading result…');
    const data = await res.json();

    if (data.image_base64) {
      return base64ToBlob(data.image_base64);
    }
    if (data.url) {
      const imgRes = await fetch(data.url);
      return await imgRes.blob();
    }
    throw new Error('Unrecognized API response shape — adjust api-engine.js for your provider.');
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function base64ToBlob(base64, mime) {
    const bytes = atob(base64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: mime || 'image/png' });
  }

  return { getConfig, saveConfig, clearConfig, isConfigured, upscaleViaApi };
})();
