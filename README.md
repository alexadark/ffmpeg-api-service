# FFmpeg Video Assembly API Service

A standalone REST API service that wraps FFmpeg functionality for video assembly with crossfade (xfade) transitions. Designed for deployment on Easypanel and integration with n8n workflows.

## Features

- **Video Assembly** - Stitch multiple video clips together
- **Crossfade Transitions** - Professional xfade transitions between clips
- **Automatic Resolution Handling** - Scales and pads videos to target resolution
- **Supabase Storage Integration** - Uploads assembled videos to Supabase Storage
- **Async Processing** - Optional callback URL for long-running jobs
- **API Key Authentication** - Secure your endpoints
- **Health Checks** - Built-in health endpoint for monitoring

## Quick Start

### Local Development

1. Clone and install dependencies:
```bash
cd ffmpeg-api-service
npm install
```

2. Copy environment template:
```bash
cp .env.example .env
```

3. Edit `.env` with your Supabase credentials

4. Start the server:
```bash
npm run dev
```

5. Test the health endpoint:
```bash
curl http://localhost:3000/api/health
```

### Docker Development

```bash
# Build and run with docker-compose
docker-compose up --build

# Test (service runs on port 3001)
curl http://localhost:3001/api/health
```

## API Reference

### Health Check

```http
GET /api/health
```

**Response:**
```json
{
  "status": "healthy",
  "ffmpeg": "available",
  "ffmpegVersion": "6.0",
  "version": "1.0.0",
  "timestamp": "2024-12-18T12:00:00.000Z"
}
```

### Assemble Videos

```http
POST /api/assemble
Content-Type: application/json
X-API-Key: your-api-key
```

**Request Body:**
```json
{
  "videos": [
    {
      "url": "https://storage.supabase.co/.../scene1.mp4",
      "duration": 8
    },
    {
      "url": "https://storage.supabase.co/.../scene2.mp4",
      "duration": 8
    },
    {
      "url": "https://storage.supabase.co/.../scene3.mp4",
      "duration": 8
    }
  ],
  "transition": {
    "type": "fade",
    "duration": 1
  },
  "output": {
    "format": "mp4",
    "resolution": "1920x1080"
  }
}
```

**Response (Synchronous):**
```json
{
  "success": true,
  "videoUrl": "https://your-project.supabase.co/storage/v1/object/public/final-reels/assembled/assembled-1702900000000.mp4",
  "duration": 22,
  "processingTime": 45000
}
```

**Async Mode (with callback):**

Add `callbackUrl` to the request:
```json
{
  "videos": [...],
  "callbackUrl": "https://your-app.com/api/webhooks/assembly-complete"
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "message": "Video assembly started. Results will be sent to callback URL."
}
```

### Check Job Status

```http
GET /api/job/:jobId
X-API-Key: your-api-key
```

**Response:**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "progress": 100,
  "videoUrl": "https://...",
  "duration": 22,
  "completedAt": "2024-12-18T12:01:00.000Z"
}
```

## Easypanel Deployment

### Prerequisites

- Easypanel server with Docker support
- Supabase project with Storage bucket
- GitHub repository (optional, for Git-based deployment)

### Option 1: Docker Image Deployment

1. **Build and push Docker image:**
```bash
# Build the image
docker build -t your-registry/ffmpeg-api:latest .

# Push to your registry (Docker Hub, GitHub Container Registry, etc.)
docker push your-registry/ffmpeg-api:latest
```

2. **Create App Service in Easypanel:**
   - Go to your Easypanel dashboard
   - Click **Create Service** > **App**
   - Select **Docker Image** as source
   - Enter your image: `your-registry/ffmpeg-api:latest`

3. **Configure Environment Variables:**
   - Click on **Environment** tab
   - Add all variables from `.env.example`

4. **Configure Resources:**
   - Set memory limit: **2048 MB** minimum (4096 MB recommended)
   - CPU: 1-2 cores

5. **Configure Health Check:**
   - Path: `/api/health`
   - Port: `3000`
   - Interval: `30s`

6. **Deploy and get URL:**
   - Note your service URL (e.g., `https://ffmpeg-api.your-server.easypanel.host`)

### Option 2: GitHub Deployment

1. **Push code to GitHub repository**

2. **Create App Service in Easypanel:**
   - Click **Create Service** > **App**
   - Select **GitHub** as source
   - Connect your repository
   - Easypanel will detect the Dockerfile automatically

3. **Configure environment variables and deploy**

### Supabase Storage Setup

1. **Create Storage Bucket:**
   - Go to Supabase Dashboard > Storage
   - Create new bucket: `final-reels`
   - Set to **Public** (for video URLs to work)

2. **Get Service Role Key:**
   - Go to Settings > API
   - Copy the `service_role` key (NOT the anon key)

3. **Configure CORS (if needed):**
   - Storage > Policies > Configure CORS

## n8n Integration

### HTTP Request Node Configuration

**Node Settings:**
- Method: `POST`
- URL: `https://your-ffmpeg-api.easypanel.host/api/assemble`
- Authentication: API Key
- Header Name: `X-API-Key`
- Header Value: `{{ $env.FFMPEG_API_KEY }}`

**Request Body (Expression):**
```json
{
  "videos": {{ $json.videos }},
  "transition": {
    "type": "fade",
    "duration": 1
  },
  "output": {
    "format": "mp4",
    "resolution": "1920x1080"
  }
}
```

### Example n8n Workflow

1. **Trigger Node** - Start workflow
2. **Supabase Node** - Query scene videos
3. **Code Node** - Format videos array:
```javascript
return [{
  videos: $input.all().map(item => ({
    url: item.json.video_url,
    duration: item.json.duration || 8
  }))
}];
```
4. **HTTP Request Node** - Call FFmpeg API
5. **Supabase Node** - Update final_reels table with result URL

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Server port |
| `API_KEY` | No | - | API key for authentication |
| `SUPABASE_URL` | Yes | - | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | - | Supabase service role key |
| `SUPABASE_BUCKET` | No | `final-reels` | Storage bucket name |
| `MAX_VIDEOS` | No | `20` | Max videos per request |
| `MAX_FILE_SIZE_MB` | No | `500` | Max file size in MB |
| `FFMPEG_TIMEOUT` | No | `300000` | FFmpeg timeout (ms) |

## Transition Types

Currently supported:
- `fade` - Crossfade between clips (default)

Future support planned:
- `wipeleft`, `wiperight`
- `slideup`, `slidedown`
- `dissolve`

## Error Handling

The API returns consistent error responses:

```json
{
  "success": false,
  "error": "Descriptive error message"
}
```

Common errors:
- `401` - Invalid or missing API key
- `400` - Invalid request (missing videos, bad URLs)
- `404` - Job not found
- `500` - Processing error (FFmpeg failure, storage issues)

## Performance Considerations

- **Memory Usage:** Each video processing job uses ~500MB-1GB RAM
- **Processing Time:** ~5-10 seconds per minute of output video
- **Concurrent Jobs:** Recommended limit of 2-3 concurrent jobs with 4GB RAM
- **Cleanup:** Temporary files are automatically cleaned up after processing

## Development

### Project Structure

```
ffmpeg-api-service/
├── server.js           # Express API server
├── lib/
│   ├── ffmpeg.js       # FFmpeg command builder
│   └── storage.js      # Video download/upload
├── Dockerfile          # Production container
├── docker-compose.yml  # Local development
├── package.json        # Dependencies
├── .env.example        # Environment template
└── README.md           # This file
```

### Running Tests

```bash
# Health check
curl http://localhost:3000/api/health

# Test assembly (with sample videos)
curl -X POST http://localhost:3000/api/assemble \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "videos": [
      {"url": "https://example.com/video1.mp4", "duration": 5},
      {"url": "https://example.com/video2.mp4", "duration": 5}
    ]
  }'
```

## License

MIT
