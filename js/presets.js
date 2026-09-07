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
    localContrast: false,
    autoWhiteBalance: false,
    autoLevels: false,
    adaptiveContrast: 0,
    shadowRecovery: 0.15,
    highlightRecovery: 0.15,
    vibrance: 0.20
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
    localContrast: true,
    autoWhiteBalance: true,
    autoLevels: false,
    adaptiveContrast: 0.35,
    shadowRecovery: 0.25,
    highlightRecovery: 0.15,
    vibrance: 0.45
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
    localContrast: false,
    autoWhiteBalance: true,
    autoLevels: true,
    adaptiveContrast: 0.25,
    shadowRecovery: 0.20,
    highlightRecovery: 0.20,
    vibrance: 0.25
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
    localContrast: false,
    autoWhiteBalance: true,
    autoLevels: false,
    adaptiveContrast: 0,
    shadowRecovery: 0.30,
    highlightRecovery: 0.20,
    vibrance: 0.15
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
    localContrast: true,
    autoWhiteBalance: true,
    autoLevels: true,
    adaptiveContrast: 0.45,
    shadowRecovery: 0.30,
    highlightRecovery: 0.25,
    vibrance: 0.35
  }
  // 'custom' is intentionally absent — selecting it just stops the
  // preset chip row from overwriting whatever values are already set.
};
