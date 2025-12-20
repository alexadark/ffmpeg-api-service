/**
 * Subtitle Parser - SRT parsing and validation utilities
 * Used by /api/add-subtitles endpoint
 */

/**
 * Parse SRT format subtitles and validate structure
 * @param {string} srtContent - Raw SRT content string
 * @returns {Object} Parsed subtitles with count and validation info
 */
function parseSRT(srtContent) {
  if (!srtContent || typeof srtContent !== 'string') {
    throw new Error('Invalid subtitle content: must be a non-empty string');
  }

  const lines = srtContent.trim().split(/\r?\n/);
  const subtitles = [];
  let currentSub = null;
  let lineNum = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines between subtitles
    if (line === '') {
      if (currentSub && currentSub.text) {
        subtitles.push(currentSub);
        currentSub = null;
      }
      continue;
    }

    // Check if this is a sequence number
    if (/^\d+$/.test(line) && !currentSub) {
      currentSub = {
        index: parseInt(line, 10),
        start: null,
        end: null,
        text: ''
      };
      lineNum = 1;
      continue;
    }

    // Check if this is a timestamp line
    if (line.includes('-->') && currentSub && lineNum === 1) {
      const match = line.match(/(\d{2}:\d{2}:\d{2}[,.:]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.:]\d{3})/);
      if (match) {
        currentSub.start = normalizeTimestamp(match[1]);
        currentSub.end = normalizeTimestamp(match[2]);
        lineNum = 2;
      }
      continue;
    }

    // Text content
    if (currentSub && lineNum >= 2) {
      if (currentSub.text) {
        currentSub.text += '\n' + line;
      } else {
        currentSub.text = line;
      }
    }
  }

  // Push last subtitle if exists
  if (currentSub && currentSub.text) {
    subtitles.push(currentSub);
  }

  // Validate we have at least one subtitle
  if (subtitles.length === 0) {
    throw new Error('No valid subtitles found in content');
  }

  return {
    subtitles: subtitles,
    count: subtitles.length,
    duration: calculateTotalDuration(subtitles),
    valid: true
  };
}

/**
 * Normalize timestamp to consistent format (HH:MM:SS,mmm)
 * Handles both comma and period as millisecond separator
 * @param {string} timestamp - Raw timestamp string
 * @returns {string} Normalized timestamp
 */
function normalizeTimestamp(timestamp) {
  // Replace period with comma for SRT standard
  return timestamp.replace('.', ',');
}

/**
 * Calculate total duration covered by subtitles
 * @param {Array} subtitles - Parsed subtitle array
 * @returns {number} Duration in seconds
 */
function calculateTotalDuration(subtitles) {
  if (!subtitles || subtitles.length === 0) return 0;

  const lastSub = subtitles[subtitles.length - 1];
  if (!lastSub.end) return 0;

  return timestampToSeconds(lastSub.end);
}

/**
 * Convert SRT timestamp to seconds
 * @param {string} timestamp - Timestamp in format HH:MM:SS,mmm
 * @returns {number} Time in seconds
 */
function timestampToSeconds(timestamp) {
  const match = timestamp.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) return 0;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const ms = parseInt(match[4], 10);

  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

/**
 * Validate SRT content structure without full parsing
 * Quick check for basic format compliance
 * @param {string} srtContent - Raw SRT content
 * @returns {boolean} True if appears to be valid SRT
 */
function isValidSRT(srtContent) {
  if (!srtContent || typeof srtContent !== 'string') {
    return false;
  }

  // Must have at least one timestamp line
  const hasTimestamp = /\d{2}:\d{2}:\d{2}[,.:]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.:]\d{3}/.test(srtContent);

  // Must have at least one sequence number followed by timestamp
  const hasSequence = /^\d+\s*\n\d{2}:\d{2}:\d{2}/m.test(srtContent);

  return hasTimestamp && hasSequence;
}

/**
 * Clean and normalize SRT content
 * Removes BOM, normalizes line endings, trims whitespace
 * @param {string} srtContent - Raw SRT content
 * @returns {string} Cleaned SRT content
 */
function cleanSRT(srtContent) {
  if (!srtContent) return '';

  // Remove BOM if present
  let cleaned = srtContent.replace(/^\uFEFF/, '');

  // Normalize line endings to \n
  cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Remove excessive blank lines (keep max 1 between subtitles)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // Trim
  cleaned = cleaned.trim();

  return cleaned;
}

module.exports = {
  parseSRT,
  isValidSRT,
  cleanSRT,
  timestampToSeconds,
  normalizeTimestamp
};
