/**
 * Color grading presets for video processing
 * Each preset contains FFmpeg filter chain configuration
 */

/**
 * Build FFmpeg filter chain for cinematic look
 * Cinematic: Contraste riche, teintes chaudes (look film)
 */
function buildCinematicFilter(intensity = 1.0, adjustments = {}) {
  const saturation = adjustments.saturation || 1.2;
  const contrast = adjustments.contrast || 1.3;
  const brightness = adjustments.brightness || 0.0;
  const gamma = adjustments.gamma || 1.0;
  const temperature = adjustments.temperature || 0;

  // Temperature adjustment: -50 to +50 maps to -30 to +30 for colortemperature
  const tempAdjust = (temperature / 50) * 30;

  const filters = [
    'colorspace=iall=bt709',
    `eq=contrast=${1 + (contrast - 1) * intensity}:saturation=${saturation * intensity}:brightness=${brightness * intensity}:gamma=${gamma}`,
    `colortemperature=${1000 + tempAdjust}`,
  ];

  return filters.join(',');
}

/**
 * Build FFmpeg filter chain for vintage look
 * Vintage: Faded, couleurs muted, vignette
 */
function buildVintageFilter(intensity = 1.0, adjustments = {}) {
  const saturation = adjustments.saturation || 0.7;
  const contrast = adjustments.contrast || 0.9;
  const brightness = adjustments.brightness || 0.1;

  const filters = [
    'colorspace=iall=bt709',
    `eq=contrast=${contrast}:saturation=${saturation * intensity}:brightness=${brightness}`,
    `vignette=angle=PI/4:mode=polynomial:ratio=${1.5 - intensity * 0.3}`,
  ];

  return filters.join(',');
}

/**
 * Build FFmpeg filter chain for cool look
 * Cool: Blues froids, desaturated
 */
function buildCoolFilter(intensity = 1.0, adjustments = {}) {
  const saturation = adjustments.saturation || 0.8;
  const contrast = adjustments.contrast || 1.1;
  const temperature = adjustments.temperature || -30;

  const filters = [
    'colorspace=iall=bt709',
    `eq=contrast=${contrast}:saturation=${saturation * intensity}`,
    `colortemperature=${1000 + (temperature / 50) * 30}`,
  ];

  return filters.join(',');
}

/**
 * Build FFmpeg filter chain for warm look
 * Warm: Oranges/dorés chauds
 */
function buildWarmFilter(intensity = 1.0, adjustments = {}) {
  const saturation = adjustments.saturation || 1.15;
  const contrast = adjustments.contrast || 1.1;
  const temperature = adjustments.temperature || 30;

  const filters = [
    'colorspace=iall=bt709',
    `eq=contrast=${contrast}:saturation=${saturation * intensity}`,
    `colortemperature=${1000 + (temperature / 50) * 30}`,
  ];

  return filters.join(',');
}

/**
 * Build FFmpeg filter chain for vibrant look
 * Vibrant: Saturation max, contraste high
 */
function buildVibrantFilter(intensity = 1.0, adjustments = {}) {
  const saturation = adjustments.saturation || 1.4;
  const contrast = adjustments.contrast || 1.25;
  const brightness = adjustments.brightness || 0.05;

  const filters = [
    'colorspace=iall=bt709',
    `eq=contrast=${contrast}:saturation=${saturation * intensity}:brightness=${brightness}`,
  ];

  return filters.join(',');
}

/**
 * Build custom color grade filter chain
 */
function buildCustomFilter(intensity = 1.0, adjustments = {}) {
  const saturation = adjustments.saturation || 1.0;
  const contrast = adjustments.contrast || 1.0;
  const brightness = adjustments.brightness || 0.0;
  const gamma = adjustments.gamma || 1.0;
  const highlights = adjustments.highlights || 1.0;
  const shadows = adjustments.shadows || 1.0;
  const temperature = adjustments.temperature || 0;

  // Build eq filter with all adjustments
  const eqFilter = `eq=contrast=${contrast}:saturation=${saturation * intensity}:brightness=${brightness}:gamma=${gamma}`;

  // Temperature adjustment
  const tempValue = 1000 + (temperature / 50) * 30;

  const filters = [
    'colorspace=iall=bt709',
    eqFilter,
    `colortemperature=${tempValue}`,
  ];

  // Add highlight/shadow adjustments if different from default
  if (highlights !== 1.0 || shadows !== 1.0) {
    // Use curves to adjust highlights and shadows
    // shadows adjustment: shift shadows up/down
    // highlights adjustment: shift highlights up/down
    const shadowShift = (shadows - 1.0) * 50;
    const highlightShift = (highlights - 1.0) * 50;
    filters.push(`curves=r='0/${Math.max(0, 0 + shadowShift)}:255/${Math.min(255, 255 + highlightShift)}'`);
  }

  return filters.join(',');
}

/**
 * Get filter chain for a given preset
 * @param {string} preset - Preset name
 * @param {number} intensity - Strength of the effect (0.0-1.0)
 * @param {Object} adjustments - Fine-tuning adjustments
 * @returns {string} FFmpeg filter chain
 */
function getFilterChain(preset, intensity = 1.0, adjustments = {}) {
  // Clamp intensity between 0.0 and 1.0
  intensity = Math.max(0.0, Math.min(1.0, intensity));

  switch (preset) {
    case 'cinematic':
      return buildCinematicFilter(intensity, adjustments);
    case 'vintage':
      return buildVintageFilter(intensity, adjustments);
    case 'cool':
      return buildCoolFilter(intensity, adjustments);
    case 'warm':
      return buildWarmFilter(intensity, adjustments);
    case 'vibrant':
      return buildVibrantFilter(intensity, adjustments);
    case 'custom':
    default:
      return buildCustomFilter(intensity, adjustments);
  }
}

/**
 * Get available presets
 */
function getAvailablePresets() {
  return [
    {
      name: 'cinematic',
      label: 'Cinematic',
      description: 'Contraste riche, teintes chaudes (look film)',
    },
    {
      name: 'vintage',
      label: 'Vintage',
      description: 'Faded, couleurs muted, vignette',
    },
    {
      name: 'cool',
      label: 'Cool',
      description: 'Blues froids, desaturated',
    },
    {
      name: 'warm',
      label: 'Warm',
      description: 'Oranges/dorés chauds',
    },
    {
      name: 'vibrant',
      label: 'Vibrant',
      description: 'Saturation max, contraste high',
    },
    {
      name: 'custom',
      label: 'Custom',
      description: 'User-defined adjustments',
    },
  ];
}

module.exports = {
  getFilterChain,
  getAvailablePresets,
  buildCinematicFilter,
  buildVintageFilter,
  buildCoolFilter,
  buildWarmFilter,
  buildVibrantFilter,
  buildCustomFilter,
};
