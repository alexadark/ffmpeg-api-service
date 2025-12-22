# FFmpeg API Service - Implementation Plan

## Summary

4 features to implement:

| # | Feature | Complexity | Files |
|---|---------|------------|-------|
| 1 | YouTube Download | Medium | `lib/youtube.js` (new), `server.js`, `package.json` |
| 2 | Enhanced Subtitle Styles | Medium | `lib/subtitle-parser.js`, `server.js` |
| 3 | Additional Styling + Bottom Adjust | Low | `lib/subtitle-parser.js`, `lib/ffmpeg.js`, `server.js` |
| 4 | Smart Trim | Medium | `lib/ffmpeg.js`, `server.js` |

---

## Feature 1: YouTube Download Endpoint

### Goal
Endpoint `/api/youtube-download` using yt-dlp to download YouTube videos.

### Files

**New: `lib/youtube.js`**
```javascript
const youtubedl = require('youtube-dl-exec');

async function downloadYouTube(url, outputDir, options = {})
// - format: 'best', '1080p', '720p', '480p', '360p', 'audio-only'
// - audioOnly: boolean
// - cookiesFile: string (optional, for age-restricted content)

async function getVideoInfo(url)
// - Returns metadata without downloading
```

**Modify: `server.js`**
- Add endpoint `POST /api/youtube-download`
- Parameters: `url`, `format`, `audioOnly`, `cookiesFile`, `callbackUrl`
- Validation: YouTube URL regex
- Async support with jobs Map

**Modify: `package.json`**
```json
"dependencies": {
  "youtube-dl-exec": "^3.0.0"
}
```

### Response
```json
{
  "success": true,
  "downloadUrl": "https://api.../api/download/youtube-123.mp4",
  "filename": "youtube-123.mp4",
  "metadata": {
    "title": "Video Title",
    "duration": 180,
    "thumbnail": "https://...",
    "channel": "Channel Name"
  }
}
```

---

## Feature 2: Enhanced Subtitle Styles

### Goal
3 new styles requiring word-level timestamps (Whisper with `timestamp_granularities[]=word`):
- **highlight**: All words visible, current word colored
- **underline**: All words visible, current word underlined
- **word_by_word**: One word at a time

### Files

**Modify: `lib/subtitle-parser.js`**

Add function `generateEnhancedASS(words, options)`:
```javascript
function generateEnhancedASS(words, options = {}) {
  // options.style: 'highlight' | 'underline' | 'word_by_word'
  // Uses inline ASS tags:
  // - Highlight: {\c&H00FF00&}word{\c&HFFFFFF&}
  // - Underline: {\u1}word{\u0}
  // - Word by word: one Dialogue line per word
}

function buildHighlightDialogue(words, baseColor, highlightColor)
function buildUnderlineDialogue(words, baseColor, highlightColor)
function buildWordByWordDialogue(words, highlightColor)
```

**Modify: `server.js`**
- Detect style in `/api/add-subtitles`
- Call `generateEnhancedASS()` for new styles

---

## Feature 3: Additional Styling Options + Bottom Position Adjust

### Goal
1. **Adjust "bottom" position** - Place subtitles lower (marginV: 15 -> 5)
2. **New style parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `shadow` | number (0-5) | 0 | Shadow offset |
| `backgroundColor` | hex | null | Background box color |
| `italic` | boolean | false | Italic text |
| `bold` | boolean | true | Bold text |
| `allCaps` | boolean | false | Uppercase transform |
| `outlineWidth` | number (0-10) | 3 | Outline thickness |

### Files

**Modify: `lib/subtitle-parser.js`**
- Integrate into ASS header generation
- ASS Style format: `Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow`
- BorderStyle: 1=outline, 3=opaque box

**Modify: `lib/ffmpeg.js`**
- Adjust marginV for bottom position (15 -> 5)

**Modify: `server.js`**
- Extract new parameters
- Value validation

---

## Feature 4: Smart Trim Endpoint

### Goal
Endpoint `/api/trim-smart` that uses silence detection to cut at optimal boundaries.

### Logic
1. Detect all silences in the video
2. For `start`: find the nearest silence end after requested start
3. For `end`: find the nearest silence start before requested end
4. Trim at adjusted boundaries

### Files

**Modify: `lib/ffmpeg.js`**
```javascript
async function findSmartTrimBoundaries(inputPath, requestedStart, requestedEnd, options = {}) {
  // options.searchWindow: seconds around boundaries (default: 2)
  // options.silenceThreshold: default '-35dB'
  // options.minSilenceDuration: default 0.3
  // Returns: { smartStart, smartEnd, adjusted: boolean }
}

async function trimVideoSmart(inputPath, outputPath, options = {}) {
  const boundaries = await findSmartTrimBoundaries(...);
  return await trimVideo(inputPath, outputPath, {
    start: boundaries.smartStart,
    end: boundaries.smartEnd
  });
}
```

**Modify: `server.js`**
- Add `POST /api/trim-smart`
- Parameters: `url`, `start`, `end`, `searchWindow`, `silenceThreshold`, `callbackUrl`

### Response
```json
{
  "success": true,
  "videoUrl": "...",
  "duration": 45.2,
  "boundaries": {
    "originalStart": 10.0,
    "originalEnd": 55.0,
    "smartStart": 10.5,
    "smartEnd": 54.2,
    "adjusted": true
  }
}
```

---

## Implementation Order

1. **YouTube Download** - Standalone new feature
2. **Additional Styling + Bottom adjust** - Low risk
3. **Enhanced Subtitle Styles** - Requires #2
4. **Smart Trim** - Standalone, uses existing detectSilence

---

## Critical Files

| File | To modify |
|------|-----------|
| `lib/youtube.js` | New file |
| `lib/subtitle-parser.js` | Features 2, 3 |
| `lib/ffmpeg.js` | Features 3, 4 |
| `server.js` | All features |
| `package.json` | Feature 1 |

---

## Version

- Current: `2.1.6`
- After implementation: `2.2.0`
