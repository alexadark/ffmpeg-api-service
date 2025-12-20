# Bug Fixes - FFmpeg API Service

## Date: 2025-12-20

### Summary
Fixed three critical bugs in the FFmpeg API Service affecting the Enhance Audio, Color Grade, and Add Subtitles endpoints.

---

## 🐛 Bug 1: Enhance Audio - Treble Filter Syntax Error

### Issue
The `/api/enhance-audio` endpoint was failing with FFmpeg error:
```
Unable to parse option value "f" [fc#-1 @ 0x7aad85caf5c0]
Error applying option 'w' to filter 'treble': Invalid argument
```

### Root Cause
In `lib/ffmpeg.js:308`, the treble filter had incorrect syntax:
```javascript
audioFilters.push('treble=g=2:f=5000:w=f'); // ❌ WRONG
```

The `w` parameter was being set to `f`, which is invalid. The `w` parameter should specify the width type, not a literal `f`.

### Fix
Changed to correct FFmpeg treble filter syntax:
```javascript
audioFilters.push('treble=g=2:f=5000:t=h'); // ✅ CORRECT
```

Where:
- `g=2` = gain in dB
- `f=5000` = frequency in Hz
- `t=h` = width type (h = Hz)

**File**: `lib/ffmpeg.js` line 308

---

## 🐛 Bug 2: Color Grade - ColorTemperature Filter Syntax Error

### Issue
The `/api/color-grade` endpoint was failing with FFmpeg filter parsing errors.

### Root Cause
In `lib/lut-presets.js`, all color grading functions had incorrect `colortemperature` filter syntax:
```javascript
`colortemperature=${1000 + tempAdjust}` // ❌ WRONG
```

The FFmpeg `colortemperature` filter requires the `temperature=` parameter explicitly.

### Fix
Updated all color grading functions (cinematic, cool, warm, custom) to use correct syntax:
```javascript
`colortemperature=temperature=${tempKelvin}` // ✅ CORRECT
```

Also adjusted temperature range to valid Kelvin values (4000K - 10000K):
```javascript
const tempKelvin = 6500 + (temperature / 50) * 3500;
```

**Files Modified**:
- `lib/lut-presets.js` lines 23, 62, 83, 127

---

## 🐛 Bug 3: Add Subtitles - Subtitles Not Appearing

### Issue
The `/api/add-subtitles` endpoint was not adding subtitles to videos, even though no error was thrown.

### Root Cause
In `lib/ffmpeg.js:792-795`, the subtitle path escaping was incorrect and the filter syntax had unnecessary quotes:

```javascript
const escapedSubPath = subtitlesPath.replace(/:/g, '\\:').replace(/'/g, "\\'");
const ffmpegCmd = `ffmpeg -i "${inputPath}" -vf "subtitles='${escapedSubPath}':force_style='${styleOverride}'" ...`
// ❌ WRONG - quotes around path cause issues
```

### Fix
Improved path escaping and removed quotes around the path:

```javascript
const escapedSubPath = subtitlesPath
  .replace(/\\/g, '/')  // Convert backslashes to forward slashes (Windows)
  .replace(/:/g, '\\:') // Escape colons
  .replace(/\[/g, '\\[') // Escape brackets
  .replace(/\]/g, '\\]');

const ffmpegCmd = `ffmpeg -i "${inputPath}" -vf "subtitles=${escapedSubPath}:force_style='${styleOverride}'" ...`
// ✅ CORRECT - no quotes around path
```

**File**: `lib/ffmpeg.js` lines 791-802

---

## Testing Recommendations

### Test 1: Enhance Audio
```bash
curl -X POST http://localhost:3000/api/enhance-audio \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "url": "https://example.com/video.mp4",
    "voiceBoost": true,
    "noiseFloor": -20
  }'
```

Expected: Audio enhancement completes without treble filter errors.

### Test 2: Color Grade
```bash
curl -X POST http://localhost:3000/api/color-grade \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "url": "https://example.com/video.mp4",
    "preset": "cinematic",
    "intensity": 0.8
  }'
```

Expected: Color grading applies successfully without colortemperature errors.

### Test 3: Add Subtitles
```bash
curl -X POST http://localhost:3000/api/add-subtitles \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "url": "https://example.com/video.mp4",
    "subtitles": "1\n00:00:01,000 --> 00:00:04,000\nTest subtitle\n",
    "style": "bold-white",
    "fontSize": 24
  }'
```

Expected: Subtitles are burned into the video correctly.

---

## Impact

All three endpoints should now work correctly:
- ✅ Audio enhancement with voice boost
- ✅ Color grading with all presets (cinematic, vintage, cool, warm, vibrant, custom)
- ✅ Subtitle burning with proper path handling

---

## Notes

- The treble filter syntax error was preventing any audio enhancement from completing
- The colortemperature filter syntax was affecting all color grading presets
- The subtitle path escaping now handles Windows paths and special characters correctly
- All fixes maintain backward compatibility with existing API parameters
