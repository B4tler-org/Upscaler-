/* ============================================================
   presets.js
   Each named "Processing Mode" is just a starting bundle of
   pipeline parameters — picking one fills in the sliders/toggles
   below it, and switching to Custom leaves whatever is currently
   set untouched so the user can fine-tune from any starting point.
   ============================================================ */

const PRESETS = {
  photo: {
    label: 'Photo',
    resampleQuality: 'balanced',
    detailAmount: 0.30,
    sharpAmount: 0.45,
    noiseReduction: 'off',
    jpegArtifact: 'off',
    textProtection: false,
    portraitProtection: false,
    localContrast: false
  },
  social: {
    label: 'Social Media',
    resampleQuality: 'balanced',
    detailAmount: 0.40,
    sharpAmount: 0.55,
    noiseReduction: 'low',
    jpegArtifact: 'low',
    textProtection: true,
    portraitProtection: false,
    localContrast: true
  },
  news: {
    label: 'News GFX',
    resampleQuality: 'maximum',
    detailAmount: 0.35,
    sharpAmount: 0.50,
    noiseReduction: 'low',
    jpegArtifact: 'medium',
    textProtection: true,
    portraitProtection: false,
    localContrast: false
  },
  portrait: {
    label: 'Portrait',
    resampleQuality: 'balanced',
    detailAmount: 0.20,
    sharpAmount: 0.30,
    noiseReduction: 'medium',
    jpegArtifact: 'off',
    textProtection: false,
    portraitProtection: true,
    localContrast: false
  },
  max: {
    label: 'Max Quality',
    resampleQuality: 'maximum',
    detailAmount: 0.50,
    sharpAmount: 0.55,
    noiseReduction: 'medium',
    jpegArtifact: 'medium',
    textProtection: true,
    portraitProtection: true,
    localContrast: true
  }
  // 'custom' is intentionally absent — selecting it just stops the
  // preset chip row from overwriting whatever values are already set.
};
