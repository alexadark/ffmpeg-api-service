# FFmpeg API Service

A production-ready REST API for video processing with FFmpeg. Designed for automation workflows with n8n, Make, Zapier, or any HTTP client.

## Quick Start

```bash
# Health check
curl http://localhost:3000/api/health

# Assemble videos
curl -X POST http://localhost:3000/api/assemble \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{"videos": [{"url": "https://example.com/video1.mp4"}, {"url": "https://example.com/video2.mp4"}]}'
```

---

## API Reference

### Authentication

All endpoints (except `/api/health` and `/api/download`) require authentication via API key.

**Header Options:**
```
X-API-Key: your-api-key
# or
Authorization: Bearer your-api-key
```

---

## Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/health` | GET | No | Health check with FFmpeg version |
| `/api/assemble` | POST | Yes | Combine videos with crossfade transitions |
| `/api/enhance-audio` | POST | Yes | Audio enhancement (noise reduction, voice clarity) |
| `/api/detect-silence` | POST | Yes | Detect silence segments in video/audio |
| `/api/trim` | POST | Yes | Trim/cut video segment |
| `/api/trim-smart` | POST | Yes | Smart trim using silence detection |
| `/api/extract-audio` | POST | Yes | Extract audio from video |
| `/api/auto-edit` | POST | Yes | Auto-edit (silence removal + assembly) |
| `/api/crop` | POST | Yes | Crop video to aspect ratio |
| `/api/add-subtitles` | POST | Yes | Burn subtitles into video |
| `/api/color-grade` | POST | Yes | Apply color grading presets |
| `/api/youtube-download` | POST | Yes | Download YouTube video |
| `/api/youtube-info` | POST | Yes | Get YouTube video metadata |
| `/api/download/:filename` | GET | No | Download processed file |
| `/api/job/:jobId` | GET | Yes | Check async job status |

---

## 1. Health Check

Check API status and FFmpeg availability.

### `GET /api/health`

**Response:**
```json
{
  "status": "healthy",
  "ffmpeg": "available",
  "ffmpegVersion": "6.0",
  "version": "2.2.0",
  "timestamp": "2024-12-20T10:30:00.000Z"
}
```

---

## 2. Assemble Videos

Combine multiple videos with crossfade transitions.

### `POST /api/assemble`

**Request Body:**
```json
{
  "videos": [
    { "url": "https://example.com/video1.mp4" },
    { "url": "https://example.com/video2.mp4" },
    { "url": "https://example.com/video3.mp4" }
  ],
  "transition": {
    "type": "fade",
    "duration": 1
  },
  "output": {
    "format": "mp4",
    "resolution": "1920x1080"
  },
  "callbackUrl": "https://your-webhook.com/callback"
}
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `videos` | array | Yes | - | Array of video objects (min 2, max 20) |
| `videos[].url` | string | Yes | - | Direct URL to video file |
| `videos[].duration` | number | No | auto | Video duration in seconds (auto-detected) |
| `transition.type` | string | No | `"fade"` | Transition type |
| `transition.duration` | number | No | `1` | Transition duration in seconds |
| `output.format` | string | No | `"mp4"` | Output format |
| `output.resolution` | string | No | `"1920x1080"` | Output resolution (WxH) |
| `callbackUrl` | string | No | - | Webhook URL for async processing |

**Response (Sync):**
```json
{
  "success": true,
  "videoUrl": "https://your-domain.com/api/download/assembled-1705312200000.mp4",
  "filename": "assembled-1705312200000.mp4",
  "size": 15728640,
  "duration": 24.5,
  "processingTime": 12500
}
```

**Response (Async - with callbackUrl):**
```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "message": "Video assembly started. Results will be sent to callback URL."
}
```

---

## 3. Enhance Audio

Improve audio quality with noise reduction and voice clarity.

### `POST /api/enhance-audio`

**Request Body:**
```json
{
  "url": "https://example.com/video.mp4",
  "noiseFloor": -20,
  "voiceBoost": true,
  "callbackUrl": "https://your-webhook.com/callback"
}
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | - | Video URL to enhance |
| `noiseFloor` | number | No | `-20` | Noise floor threshold in dB |
| `voiceBoost` | boolean | No | `true` | Apply voice clarity boost (5kHz) |
| `callbackUrl` | string | No | - | Webhook URL for async processing |

**Response:**
```json
{
  "success": true,
  "videoUrl": "https://your-domain.com/api/download/enhanced-audio-1705312200000.mp4",
  "filename": "enhanced-audio-1705312200000.mp4",
  "audioStats": {
    "originalLUFS": -22.5,
    "finalLUFS": -14,
    "noiseReduction": "20dB"
  },
  "processingTime": 5200
}
```

**Audio Processing Pipeline:**
1. Highpass filter (80Hz) - Remove rumble
2. Lowpass filter (12kHz) - Remove hiss
3. FFT denoiser - Noise reduction
4. Dynamic compression - Even out volume
5. Loudnorm (-14 LUFS) - Broadcast standard
6. Treble boost (5kHz) - Voice clarity (optional)

---

## 4. Detect Silence

Find silence segments in video/audio for editing.

### `POST /api/detect-silence`

**Request Body:**
```json
{
  "url": "https://example.com/video.mp4",
  "threshold": "-35dB",
  "minDuration": 0.5,
  "callbackUrl": "https://your-webhook.com/callback"
}
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | - | Video URL to analyze |
| `threshold` | string | No | `"-35dB"` | Silence threshold (dB) |
| `minDuration` | number | No | `0.5` | Minimum silence duration (seconds) |
| `callbackUrl` | string | No | - | Webhook URL for async processing |

**Response:**
```json
{
  "success": true,
  "silences": [
    { "start": 5.2, "end": 6.8, "duration": 1.6 },
    { "start": 12.1, "end": 13.5, "duration": 1.4 },
    { "start": 25.0, "end": 27.2, "duration": 2.2 }
  ],
  "totalSilenceDuration": 5.2,
  "originalDuration": 45.0,
  "processingTime": 2100
}
```

---

## 5. Trim Video

Cut a segment from a video.

### `POST /api/trim`

**Request Body:**
```json
{
  "url": "https://example.com/video.mp4",
  "start": 10,
  "end": 30,
  "callbackUrl": "https://your-webhook.com/callback"
}
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | - | Video URL to trim |
| `start` | number | Yes | - | Start time in seconds |
| `end` | number | Yes | - | End time in seconds |
| `callbackUrl` | string | No | - | Webhook URL for async processing |

**Response:**
```json
{
  "success": true,
  "videoUrl": "https://your-domain.com/api/download/trimmed-1705312200000.mp4",
  "filename": "trimmed-1705312200000.mp4",
  "duration": 20,
  "processingTime": 1500
}
```

---

## 5b. Smart Trim

Trim video with intelligent boundary detection using silence analysis. Automatically adjusts cut points to avoid cutting during speech.

### `POST /api/trim-smart`

**Request Body:**
```json
{
  "url": "https://example.com/video.mp4",
  "start": 10,
  "end": 30,
  "searchWindow": 2.0,
  "silenceThreshold": "-35dB",
  "callbackUrl": "https://your-webhook.com/callback"
}
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | - | Video URL to trim |
| `start` | number | Yes | - | Approximate start time (seconds) |
| `end` | number | Yes | - | Approximate end time (seconds) |
| `searchWindow` | number | No | `2.0` | Search range for optimal cut points (seconds) |
| `silenceThreshold` | string | No | `"-35dB"` | Silence detection threshold |
| `callbackUrl` | string | No | - | Webhook URL for async processing |

**Response:**
```json
{
  "success": true,
  "videoUrl": "https://your-domain.com/api/download/smart-trimmed-1705312200000.mp4",
  "filename": "smart-trimmed-1705312200000.mp4",
  "boundaries": {
    "requestedStart": 10,
    "requestedEnd": 30,
    "actualStart": 9.8,
    "actualEnd": 30.5,
    "startAdjusted": true,
    "endAdjusted": true
  },
  "duration": 20.7,
  "processingTime": 3200
}
```

---

## 6. Extract Audio

Extract audio track from video.

### `POST /api/extract-audio`

**Request Body:**
```json
{
  "url": "https://example.com/video.mp4",
  "format": "mp3",
  "bitrate": "192k",
  "callbackUrl": "https://your-webhook.com/callback"
}
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | - | Video URL |
| `format` | string | No | `"mp3"` | Output format: `mp3`, `wav`, `aac` |
| `bitrate` | string | No | `"192k"` | Audio bitrate |
| `callbackUrl` | string | No | - | Webhook URL for async processing |

**Response:**
```json
{
  "success": true,
  "audioUrl": "https://your-domain.com/api/download/audio-1705312200000.mp3",
  "filename": "audio-1705312200000.mp3",
  "duration": 120.5,
  "fileSize": 2887680,
  "format": "mp3",
  "processingTime": 3200
}
```

---

## 7. Auto-Edit

Automatically remove silences and assemble the result.

### `POST /api/auto-edit`

**Request Body:**
```json
{
  "url": "https://example.com/video.mp4",
  "silenceThreshold": "-35dB",
  "minSilenceDuration": 0.5,
  "strategy": "normal",
  "segments": null,
  "callbackUrl": "https://your-webhook.com/callback"
}
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | - | Video URL to edit |
| `silenceThreshold` | string | No | `"-35dB"` | Silence detection threshold |
| `minSilenceDuration` | number | No | `0.5` | Minimum silence to remove (seconds) |
| `strategy` | string | No | `"normal"` | Edit strategy: `light`, `normal`, `aggressive` |
| `segments` | array | No | - | Manual segments to keep (overrides auto-detection) |
| `segments[].start` | number | - | - | Segment start time (seconds) |
| `segments[].end` | number | - | - | Segment end time (seconds) |
| `callbackUrl` | string | No | - | Webhook URL for async processing |

**Strategy Options:**

| Strategy | Padding Before | Padding After | Description |
|----------|---------------|---------------|-------------|
| `light` | 200ms | 300ms | Preserve natural pauses |
| `normal` | 100ms | 150ms | Balanced editing |
| `aggressive` | 50ms | 50ms | Tight cuts, fast pacing |

**Response:**
```json
{
  "success": true,
  "videoUrl": "https://your-domain.com/api/download/auto-edited-1705312200000.mp4",
  "filename": "auto-edited-1705312200000.mp4",
  "originalDuration": 120.0,
  "editedDuration": 95.5,
  "timeRemoved": 24.5,
  "stats": {
    "segmentsKept": 15,
    "totalCuts": 14
  },
  "processingTime": 8500
}
```

---

## 8. Crop Video

Crop video to a specific aspect ratio.

### `POST /api/crop`

**Request Body:**
```json
{
  "url": "https://example.com/video.mp4",
  "aspectRatio": "9:16",
  "position": "center",
  "zoom": 1.0,
  "callbackUrl": "https://your-webhook.com/callback"
}
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | - | Video URL to crop |
| `aspectRatio` | string | No | `"9:16"` | Target ratio: `9:16`, `1:1`, `16:9`, `4:3` |
| `position` | string | No | `"center"` | Crop position: `center`, `top`, `bottom`, `left`, `right` |
| `zoom` | number | No | `1.0` | Zoom factor (1.0 = no zoom) |
| `callbackUrl` | string | No | - | Webhook URL for async processing |

**Response:**
```json
{
  "success": true,
  "videoUrl": "https://your-domain.com/api/download/cropped-1705312200000.mp4",
  "filename": "cropped-1705312200000.mp4",
  "originalResolution": "1920x1080",
  "croppedResolution": "608x1080",
  "aspectRatio": "9:16",
  "position": "center",
  "processingTime": 4200
}
```

---

## 9. Add Subtitles

Burn SRT subtitles into video. Supports standard sentence-level subtitles and word-level timing for dynamic effects.

### `POST /api/add-subtitles`

**Request Body (Standard):**
```json
{
  "url": "https://example.com/video.mp4",
  "subtitles": "1\n00:00:01,000 --> 00:00:04,000\nHello, welcome to this video.\n\n2\n00:00:05,000 --> 00:00:08,000\nLet me show you something cool.",
  "style": "bold-white",
  "fontSize": 24,
  "position": "bottom",
  "fontColor": "FFFFFF",
  "outlineColor": "000000",
  "outlineWidth": 2,
  "shadow": true,
  "italic": false,
  "bold": true,
  "allCaps": false,
  "backgroundColor": null,
  "callbackUrl": "https://your-webhook.com/callback"
}
```

**Request Body (Word-Level with Enhanced Styles):**
```json
{
  "url": "https://example.com/video.mp4",
  "words": [
    { "word": "Hello", "start": 1.0, "end": 1.5 },
    { "word": "world", "start": 1.5, "end": 2.0 }
  ],
  "style": "highlight",
  "fontSize": 48,
  "position": "center",
  "baseColor": "FFFFFF",
  "highlightColor": "FFFF00",
  "wordsPerGroup": 3,
  "callbackUrl": "https://your-webhook.com/callback"
}
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | - | Video URL |
| `subtitles` | string | Cond. | - | SRT content (required if no `words`) |
| `words` | array | Cond. | - | Word-level timing array (required if no `subtitles`) |
| `style` | string | No | `"bold-white"` | Style preset (see below) |
| `fontSize` | number | No | `24` | Font size in pixels |
| `position` | string | No | `"bottom"` | Position: `bottom`, `top`, `center` |
| `fontColor` | string | No | - | Custom font color (hex) |
| `outlineColor` | string | No | `"000000"` | Outline color (hex) |
| `outlineWidth` | number | No | `2` | Outline thickness (0-5) |
| `shadow` | boolean | No | `true` | Enable drop shadow |
| `italic` | boolean | No | `false` | Italic text |
| `bold` | boolean | No | `true` | Bold text |
| `allCaps` | boolean | No | `false` | Convert to uppercase |
| `backgroundColor` | string | No | - | Background box color (hex) |
| `baseColor` | string | No | `"FFFFFF"` | Base text color (word-level) |
| `highlightColor` | string | No | `"FFFF00"` | Highlight color (word-level) |
| `wordsPerGroup` | number | No | `3` | Words per display group (word-level) |
| `callbackUrl` | string | No | - | Webhook URL for async processing |

**Style Presets:**

| Style | Type | Description |
|-------|------|-------------|
| `bold-white` | Standard | White text with black outline |
| `bold-yellow` | Standard | Yellow text with black outline |
| `minimal` | Standard | Clean white text, no outline |
| `custom` | Standard | Use custom colors |
| `highlight` | Word-level | Current word highlighted in different color |
| `underline` | Word-level | Current word underlined |
| `word_by_word` | Word-level | Show one word at a time |

**Response:**
```json
{
  "success": true,
  "videoUrl": "https://your-domain.com/api/download/subtitled-1705312200000.mp4",
  "filename": "subtitled-1705312200000.mp4",
  "subtitleCount": 25,
  "style": "bold-white",
  "position": "bottom",
  "processingTime": 6800
}
```

---

## 10. Color Grade

Apply color grading presets to video.

### `POST /api/color-grade`

**Request Body:**
```json
{
  "url": "https://example.com/video.mp4",
  "preset": "cinematic",
  "intensity": 0.8,
  "lut": null,
  "adjustments": {
    "brightness": 0,
    "contrast": 0,
    "saturation": 0
  },
  "callbackUrl": "https://your-webhook.com/callback"
}
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | - | Video URL |
| `preset` | string | No | `"cinematic"` | Color preset (see below) |
| `intensity` | number | No | `1.0` | Effect strength (0.0 - 1.0) |
| `lut` | string | No | - | Custom LUT file path (overrides preset) |
| `adjustments` | object | No | - | Fine-tuning adjustments |
| `adjustments.brightness` | number | No | `0` | Brightness adjustment |
| `adjustments.contrast` | number | No | `0` | Contrast adjustment |
| `adjustments.saturation` | number | No | `0` | Saturation adjustment |
| `callbackUrl` | string | No | - | Webhook URL for async processing |

**Preset Options:**

| Preset | Description |
|--------|-------------|
| `cinematic` | Film-like look with crushed blacks |
| `vintage` | Retro faded aesthetic |
| `cool` | Blue-tinted cold tones |
| `warm` | Orange/yellow warm tones |
| `vibrant` | Boosted saturation and contrast |
| `custom` | Use with `adjustments` only |

**Response:**
```json
{
  "success": true,
  "videoUrl": "https://your-domain.com/api/download/color-graded-1705312200000.mp4",
  "filename": "color-graded-1705312200000.mp4",
  "preset": "cinematic",
  "intensity": 0.8,
  "processingTime": 7200
}
```

---

## 11. YouTube Download

Download videos from YouTube.

### `POST /api/youtube-download`

**Request Body:**
```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "format": "best",
  "audioOnly": false,
  "callbackUrl": "https://your-webhook.com/callback"
}
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | - | YouTube video URL |
| `format` | string | No | `"best"` | Quality: `best`, `1080p`, `720p`, `480p`, `360p` |
| `audioOnly` | boolean | No | `false` | Extract audio only (MP3) |
| `callbackUrl` | string | No | - | Webhook URL for async processing |

**Response:**
```json
{
  "success": true,
  "videoUrl": "https://your-domain.com/api/download/dQw4w9WgXcQ.mp4",
  "filename": "dQw4w9WgXcQ.mp4",
  "fileSize": 52428800,
  "metadata": {
    "id": "dQw4w9WgXcQ",
    "title": "Video Title",
    "duration": 212,
    "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
    "channel": "Channel Name"
  },
  "processingTime": 15000
}
```

---

## 12. YouTube Info

Get YouTube video metadata without downloading.

### `POST /api/youtube-info`

**Request Body:**
```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | string | Yes | - | YouTube video URL |

**Response:**
```json
{
  "success": true,
  "metadata": {
    "id": "dQw4w9WgXcQ",
    "title": "Video Title",
    "description": "Video description...",
    "duration": 212,
    "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
    "channel": "Channel Name",
    "channelId": "UCuAXFkgsw1L7xaCfnd5JJOw",
    "uploadDate": "20091025",
    "viewCount": 1500000000,
    "likeCount": 15000000,
    "formats": [
      {
        "formatId": "137",
        "ext": "mp4",
        "resolution": "1920x1080",
        "fps": 30,
        "vcodec": "avc1",
        "acodec": "none",
        "filesize": 52428800
      }
    ]
  }
}
```

---

## 13. Download File

Download a processed file.

### `GET /api/download/:filename`

**Example:**
```
GET /api/download/assembled-1705312200000.mp4
```

**Response:**
- Returns the video file with `Content-Type: video/mp4`
- Files are available for 2 hours after creation

**Error Response (404):**
```json
{
  "error": "File not found or expired"
}
```

---

## 14. Job Status

Check the status of an async job.

### `GET /api/job/:jobId`

**Example:**
```
GET /api/job/550e8400-e29b-41d4-a716-446655440000
```

**Response (Processing):**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "progress": 45,
  "createdAt": "2024-12-20T10:30:00.000Z"
}
```

**Response (Completed):**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "progress": 100,
  "videoUrl": "https://your-domain.com/api/download/assembled-1705312200000.mp4",
  "filename": "assembled-1705312200000.mp4",
  "duration": 24.5,
  "completedAt": "2024-12-20T10:32:15.000Z"
}
```

**Response (Failed):**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "failed",
  "error": "Video download failed: Connection timeout",
  "failedAt": "2024-12-20T10:31:00.000Z"
}
```

---

## Async Processing (Callbacks)

All processing endpoints support async mode with callbacks. Include a `callbackUrl` in your request.

**Callback Payload (Success):**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "videoUrl": "https://your-domain.com/api/download/...",
  "filename": "...",
  "duration": 24.5
}
```

**Callback Payload (Failure):**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "failed",
  "error": "Error message here"
}
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Server port |
| `API_KEY` | No | - | Authentication key (disabled if empty) |
| `BASE_URL` | No | auto | Public URL for download links |
| `MAX_VIDEOS` | No | `20` | Max videos per assembly request |
| `MAX_FILE_SIZE_MB` | No | `500` | Max file size per video (MB) |
| `FFMPEG_TIMEOUT` | No | `300000` | Processing timeout (ms, 5 min default) |
| `OUTPUT_DIR` | No | `/tmp/ffmpeg-outputs` | Output directory |

---

## Error Responses

All errors follow this format:

```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

**Common HTTP Status Codes:**

| Code | Description |
|------|-------------|
| `400` | Bad Request (invalid parameters) |
| `401` | Unauthorized (invalid or missing API key) |
| `404` | Not Found (file or job not found) |
| `500` | Internal Server Error (processing failed) |

---

## Deployment

### Docker

```bash
docker-compose up -d
```

### Easypanel

1. Create App from GitHub
2. Set environment variables
3. Memory: 2048 MB minimum (4096 MB recommended)
4. Deploy

### Railway / Render

1. Connect GitHub repository
2. Set environment variables
3. Deploy

---

## n8n Integration Example

**HTTP Request Node:**
- **Method:** POST
- **URL:** `https://your-domain.com/api/assemble`
- **Authentication:** Header Auth
  - Name: `X-API-Key`
  - Value: `{{ $env.FFMPEG_API_KEY }}`
- **Body (JSON):**
```json
{
  "videos": {{ $json.videoUrls.map(url => ({url})) }},
  "transition": { "duration": 1 },
  "output": { "resolution": "1920x1080" }
}
```

---

## License

MIT License - see [LICENSE](LICENSE) file.
