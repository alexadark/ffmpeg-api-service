# Smart Crop API - Guide for Screen Recordings

## Overview

The `/api/crop-smart` endpoint is optimized for converting horizontal screen recordings into vertical shorts (9:16). It provides **3 intelligent modes** to handle different content types.

---

## Endpoint

```
POST /api/crop-smart
```

### Authentication
- Header: `X-API-Key: your-api-key` or `Authorization: Bearer your-api-key`

---

## Modes

### 1. **Letterbox Mode** (Default - Recommended for Screen Recordings)

Keeps the full screen recording visible by adding colored bars (top/bottom). Perfect for tutorials, code walkthroughs, and demos.

**Use Case:**
- Screen recordings where you need to show the full interface
- Code editors, terminals, browsers
- When cropping would lose critical information

**Request:**
```json
{
  "url": "https://example.com/screen-recording.mp4",
  "mode": "letterbox",
  "aspectRatio": "9:16",
  "letterbox": {
    "barColor": "#000000"
  }
}
```

**Parameters:**
- `barColor` (optional): Hex color for bars (default: `#000000` black)
- `logoUrl` (optional): Logo image URL to overlay on bars (coming soon)
- `logoPosition` (optional): `"top"`, `"bottom"`, or `"both"` (default: `"bottom"`)
- `logoSize` (optional): Logo height in pixels (default: 80)

**Result:**
- Video scaled to fit in 9:16
- Black (or custom color) bars added top/bottom
- Full screen content visible in center

---

### 2. **Smart Zoom Mode** (For Focused Content)

Crops a specific region of the screen and zooms into it. Perfect for showing a particular area like a code editor, terminal, or app section.

**Use Case:**
- Zoom into a specific application window
- Focus on code in an editor
- Highlight a particular UI element

**Request:**
```json
{
  "url": "https://example.com/screen-recording.mp4",
  "mode": "smart-zoom",
  "aspectRatio": "9:16",
  "smartZoom": {
    "x": 200,
    "y": 100,
    "width": 1080,
    "height": 1920
  }
}
```

**Parameters:**
- `x`: X coordinate (pixels from left edge)
- `y`: Y coordinate (pixels from top edge)
- `width`: Width of crop area in pixels
- `height`: Height of crop area in pixels

**Important:**
- All values must be **even numbers** (required by video codecs)
- Crop area must fit within original video bounds
- API will auto-adjust to nearest even number if needed

**How to find coordinates:**
- Use a screenshot tool to identify the region
- macOS: Cmd+Shift+4 shows pixel coordinates
- Windows: Use Snipping Tool or similar

---

### 3. **Custom Mode** (Fallback to Standard Crop)

Falls back to the standard `/api/crop` behavior with position and zoom options.

**Use Case:**
- Simple center/top/bottom/left/right cropping
- Manual zoom control

**Request:**
```json
{
  "url": "https://example.com/video.mp4",
  "mode": "custom",
  "aspectRatio": "9:16",
  "custom": {
    "position": "center",
    "zoom": 1.2
  }
}
```

**Parameters:**
- `position`: `"center"`, `"top"`, `"bottom"`, `"left"`, or `"right"`
- `zoom`: Zoom factor (1.0 = no zoom, 1.5 = 50% zoom in)

---

## Response Format

```json
{
  "success": true,
  "videoUrl": "https://api.example.com/api/download/smart-cropped-1234567890.mp4",
  "filename": "smart-cropped-1234567890.mp4",
  "mode": "letterbox",
  "originalResolution": "1920x1080",
  "outputResolution": "1080x1920",
  "aspectRatio": "9:16",
  "processingTime": 12500
}
```

---

## Complete Examples

### Example 1: Code Tutorial (Letterbox)

```bash
curl -X POST https://n8n.cutzai.com/api/crop-smart \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://storage.example.com/code-tutorial.mp4",
    "mode": "letterbox",
    "aspectRatio": "9:16",
    "letterbox": {
      "barColor": "#1a1a1a"
    }
  }'
```

**Result:** Full screen visible with dark gray bars

---

### Example 2: VSCode Screen Recording (Smart Zoom)

```bash
curl -X POST https://n8n.cutzai.com/api/crop-smart \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://storage.example.com/vscode-demo.mp4",
    "mode": "smart-zoom",
    "aspectRatio": "9:16",
    "smartZoom": {
      "x": 300,
      "y": 100,
      "width": 1200,
      "height": 1600
    }
  }'
```

**Result:** Only the code editor area is visible, zoomed to fill 9:16

---

### Example 3: n8n Workflow (Letterbox with custom color)

```json
{
  "url": "https://storage.example.com/n8n-workflow.mp4",
  "mode": "letterbox",
  "aspectRatio": "9:16",
  "letterbox": {
    "barColor": "#ea4b71"
  }
}
```

**Result:** n8n workflow canvas visible with branded pink bars

---

## Usage in n8n Workflows

### HTTP Request Node Configuration

**Method:** POST
**URL:** `https://n8n.cutzai.com/api/crop-smart`

**Headers:**
```json
{
  "X-API-Key": "{{ $credentials.ffmpegApi.apiKey }}",
  "Content-Type": "application/json"
}
```

**Body:**
```json
{
  "url": "{{ $json.videoUrl }}",
  "mode": "letterbox",
  "aspectRatio": "9:16",
  "letterbox": {
    "barColor": "#000000"
  }
}
```

---

## Async Processing (For Long Videos)

For videos >2 minutes, use async mode:

```json
{
  "url": "https://storage.example.com/long-video.mp4",
  "mode": "letterbox",
  "aspectRatio": "9:16",
  "letterbox": {
    "barColor": "#000000"
  },
  "callbackUrl": "https://n8n.cutzai.com/webhook/crop-complete"
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "abc123-def456-ghi789",
  "status": "processing",
  "message": "Smart crop started. Results will be sent to callback URL."
}
```

**Callback (when done):**
```json
{
  "jobId": "abc123-def456-ghi789",
  "status": "completed",
  "videoUrl": "https://api.example.com/api/download/smart-cropped-1234567890.mp4",
  "filename": "smart-cropped-1234567890.mp4",
  "mode": "letterbox",
  "originalResolution": "1920x1080",
  "outputResolution": "1080x1920",
  "aspectRatio": "9:16"
}
```

---

## Supported Aspect Ratios

- `9:16` - Vertical shorts (default) - 1080x1920
- `1:1` - Square - 1080x1080
- `16:9` - Horizontal - 1920x1080
- `4:3` - Classic - 1440x1080

---

## Best Practices

### For Screen Recordings:

1. **Use Letterbox Mode** by default
   - Preserves all content
   - Works with any screen layout
   - Professional look with branded bars

2. **Use Smart Zoom** for focused content
   - Zoom into specific app windows
   - Highlight code sections
   - Show terminal output clearly

3. **Test coordinates** before batch processing
   - Record a 10-second sample
   - Find optimal crop region
   - Apply to all similar videos

### For Different Content Types:

| Content Type | Recommended Mode | Settings |
|--------------|------------------|----------|
| Full desktop demo | Letterbox | Default black bars |
| Code editor only | Smart Zoom | Crop to editor area |
| Terminal commands | Smart Zoom | Crop to terminal |
| Browser demo | Letterbox | Show full browser |
| n8n workflow canvas | Letterbox | Zoom set to center |
| Multi-window | Letterbox | Preserve all windows |

---

## Error Handling

**Invalid crop region:**
```json
{
  "success": false,
  "error": "Crop region (2000,100,1080,1920) exceeds video bounds (1920x1080)"
}
```

**Missing parameters:**
```json
{
  "success": false,
  "error": "smart-zoom mode requires smartZoom object with x, y, width, and height"
}
```

---

## Version

Added in: v2.1.6
Endpoint: `/api/crop-smart`
Related: `/api/crop` (standard crop)

---

## See Also

- [README.md](./README.md) - Full API documentation
- [Standard Crop API](./README.md#crop-video) - `/api/crop` endpoint
- [Subtitles API](./README.md#add-subtitles) - `/api/add-subtitles` endpoint
