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

/**
 * Convert seconds to ASS timestamp format (H:MM:SS.cc)
 * @param {number} seconds - Time in seconds
 * @returns {string} ASS formatted timestamp
 */
function secondsToASSTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100); // centiseconds
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Convert hex color to ASS BGR format
 * ASS uses &HBBGGRR& format (BGR, not RGB)
 * @param {string} hex - Hex color like "FFFFFF" or "00FF00"
 * @returns {string} ASS color format
 */
function hexToASSColor(hex) {
  // Remove # if present
  hex = hex.replace('#', '');
  // Ensure 6 characters
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  // Convert RGB to BGR for ASS
  const r = hex.substring(0, 2);
  const g = hex.substring(2, 4);
  const b = hex.substring(4, 6);
  return `&H${b}${g}${r}&`;
}

/**
 * Validate word-level subtitle input
 * @param {Array} words - Array of {word, start, end} objects
 * @returns {Object} Validation result
 */
function validateWords(words) {
  if (!Array.isArray(words) || words.length === 0) {
    return { valid: false, error: 'words must be a non-empty array' };
  }

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.word || typeof w.word !== 'string') {
      return { valid: false, error: `Word at index ${i} missing 'word' string` };
    }
    if (typeof w.start !== 'number' || typeof w.end !== 'number') {
      return { valid: false, error: `Word at index ${i} missing 'start' or 'end' number` };
    }
    if (w.start < 0 || w.end < w.start) {
      return { valid: false, error: `Word at index ${i} has invalid timestamps` };
    }
  }

  return { valid: true, count: words.length };
}

/**
 * Generate ASS subtitle file for karaoke-style word highlighting
 * Shows multiple words at once with current word highlighted
 *
 * @param {Array} words - Array of {word, start, end} objects
 * @param {Object} options - Styling options
 * @param {string} options.textColor - Base text color: "white" or "black" (default: "white")
 * @param {string} options.highlightColor - Highlight color in hex (default: "00FF00" green)
 * @param {number} options.fontSize - Font size (default: 48)
 * @param {string} options.position - "bottom", "center", "top" (default: "center")
 * @param {number} options.wordsPerGroup - Words visible at once (default: 3)
 * @returns {string} ASS subtitle content
 */
function generateKaraokeASS(words, options = {}) {
  const textColor = options.textColor === 'black' ? '000000' : 'FFFFFF';
  const highlightColor = options.highlightColor || '00FF00';
  const fontSize = options.fontSize || 48;
  const position = options.position || 'center';
  const wordsPerGroup = options.wordsPerGroup || 3;

  // Calculate alignment based on position
  // ASS alignment: 1-3 bottom, 4-6 middle, 7-9 top (2,5,8 are centered)
  let alignment;
  let marginV;
  switch (position) {
    case 'top':
      alignment = 8;
      marginV = 30;
      break;
    case 'bottom':
      alignment = 2;
      marginV = 50;
      break;
    case 'center':
    default:
      alignment = 5;
      marginV = 0;
      break;
  }

  // Convert colors to ASS format
  const baseColor = hexToASSColor(textColor);
  const highlightASSColor = hexToASSColor(highlightColor);
  const outlineColor = '&H000000&'; // Black outline always

  // Build ASS header
  let ass = `[Script Info]
Title: Karaoke Subtitles
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},${baseColor},${baseColor},${outlineColor},&H80000000&,1,0,0,0,100,100,0,0,1,3,1,${alignment},10,10,${marginV},1
Style: Highlight,Arial,${fontSize},${highlightASSColor},${highlightASSColor},${outlineColor},&H80000000&,1,0,0,0,100,100,0,0,1,3,1,${alignment},10,10,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Group words for display
  // Each word timing creates a dialogue line showing nearby words
  for (let i = 0; i < words.length; i++) {
    const currentWord = words[i];

    // Determine which words to show (window around current word)
    const halfWindow = Math.floor(wordsPerGroup / 2);
    let startIdx = Math.max(0, i - halfWindow);
    let endIdx = Math.min(words.length - 1, i + halfWindow);

    // Adjust window to always show wordsPerGroup words if possible
    while (endIdx - startIdx + 1 < wordsPerGroup && startIdx > 0) startIdx--;
    while (endIdx - startIdx + 1 < wordsPerGroup && endIdx < words.length - 1) endIdx++;

    // Build the text with inline color override for highlighted word
    let text = '';
    for (let j = startIdx; j <= endIdx; j++) {
      const w = words[j];
      if (j === i) {
        // Highlighted word - use highlight color
        text += `{\\c${highlightASSColor}}${w.word}{\\c${baseColor}} `;
      } else {
        // Normal word
        text += `${w.word} `;
      }
    }
    text = text.trim();

    // Add dialogue line
    const startTime = secondsToASSTime(currentWord.start);
    const endTime = secondsToASSTime(currentWord.end);
    ass += `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${text}\n`;
  }

  return ass;
}

module.exports = {
  parseSRT,
  isValidSRT,
  cleanSRT,
  timestampToSeconds,
  normalizeTimestamp,
  validateWords,
  generateKaraokeASS,
  secondsToASSTime,
  hexToASSColor
};
