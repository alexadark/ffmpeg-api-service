# FFmpeg Video Assembly API

A REST API service that combines multiple videos into one with smooth crossfade transitions. Perfect for automating video workflows with n8n, Make, Zapier, or any HTTP client.

## What does this API do?

You send it a list of video URLs, and it returns a single video with all clips merged together with fade transitions between them.

**Example:** Send 3 video clips → Get 1 combined video with smooth fades

## Features

- **Video Assembly** - Combine multiple video clips into one
- **Crossfade Transitions** - Professional fade transitions between clips
- **Audio Sync** - Automatic audio mixing synchronized with video transitions
- **Flexible Resolution** - Output to any resolution (default 1920x1080)
- **Async Processing** - Optional callback URL for long-running jobs
- **API Key Auth** - Optional authentication for production use

---

## Deployment Options

There are 3 ways to deploy this API. Choose the one that fits your situation:

| Method | Difficulty | Best for |
|--------|------------|----------|
| **Easypanel** | Easy | You already use Easypanel |
| **Railway / Render** | Easy | Quick cloud deployment, no server needed |
| **VPS with Docker** | Medium | You have your own server (DigitalOcean, Hetzner, OVH...) |

---

## Option 1: Deploy on Easypanel (Recommended)

**What is Easypanel?** A control panel that makes it easy to deploy apps on your own server.

### Prerequisites
- An Easypanel server already set up
- This code pushed to your GitHub account

### Steps

1. **Push this code to GitHub first** (from your computer):
   ```bash
   # On your computer, in the project folder
   git remote add origin https://github.com/YOUR_USERNAME/ffmpeg-api-service.git
   git push -u origin main
   ```

2. **In Easypanel dashboard:**
   - Click **Create Service** → **App**
   - Select **GitHub** as source
   - Connect your GitHub account and select your repository
   - Easypanel will detect the Dockerfile automatically

3. **Configure environment variables** (in Easypanel's Environment tab):
   - `API_KEY`: A secret password to protect your API (example: `my-secret-key-123`)
   - `BASE_URL`: Your app's public URL (example: `https://ffmpeg.your-domain.com`)

4. **Configure resources** (in Easypanel's Resources tab):
   - Memory: **2048 MB minimum** (4096 MB recommended)
   - CPU: 1-2 cores

5. **Click Deploy**

6. **Test it works:**
   Open `https://your-app-url.com/api/health` in your browser. You should see:
   ```json
   {"status": "healthy", "ffmpeg": "available", ...}
   ```

---

## Option 2: Deploy on Railway or Render (No server needed)

**What are Railway/Render?** Cloud platforms that host your app for you. You don't need your own server.

### Deploy on Railway

1. **Push this code to GitHub** (from your computer)

2. **Go to [railway.app](https://railway.app)** and sign in with GitHub

3. **Click "New Project"** → **"Deploy from GitHub repo"**

4. **Select your repository**

5. **Add environment variables** (in Settings → Variables):
   - `API_KEY`: Your secret password
   - `BASE_URL`: Will be provided by Railway after deploy

6. **Railway will deploy automatically**

7. **Get your URL** from the Railway dashboard and test `/api/health`

### Deploy on Render

1. **Push this code to GitHub** (from your computer)

2. **Go to [render.com](https://render.com)** and sign in with GitHub

3. **Click "New"** → **"Web Service"**

4. **Select your repository**

5. **Configure:**
   - Environment: `Docker`
   - Add environment variables: `API_KEY`, `BASE_URL`

6. **Click "Create Web Service"**

---

## Option 3: Deploy on a VPS with Docker (Advanced)

**What is a VPS?** A virtual server you rent (DigitalOcean Droplet, Hetzner Cloud, OVH, etc.)

**When to use this?** If you already have a server with Docker installed and want full control.

### Prerequisites
- A VPS with Docker installed
- SSH access to your server
- A domain pointing to your server (optional but recommended)

### Steps

**All these commands run ON YOUR SERVER, not on your computer!**

1. **Connect to your server via SSH:**
   ```bash
   # On your computer
   ssh root@your-server-ip
   ```

2. **Clone the repository ON THE SERVER:**
   ```bash
   # Now you're on the server
   git clone https://github.com/YOUR_USERNAME/ffmpeg-api-service.git
   cd ffmpeg-api-service
   ```

3. **Create environment file:**
   ```bash
   cp .env.example .env
   nano .env   # Edit and set your API_KEY
   ```

4. **Start with Docker Compose:**
   ```bash
   docker-compose up -d
   ```

5. **Test it works:**
   ```bash
   curl http://localhost:3001/api/health
   ```

6. **To update later:**
   ```bash
   cd ffmpeg-api-service
   git pull
   docker-compose up -d --build
   ```

---

## Local Development (On your computer)

**Use this only for testing/development, not for production!**

### Prerequisites
- Node.js 18 or higher installed
- FFmpeg installed on your computer

### Steps

```bash
# Install dependencies
npm install

# Start development server (auto-reloads when you change code)
npm run dev

# Test it works
curl http://localhost:3000/api/health
```

---

## How to Use the API

Once deployed, here's how to use it.

### Test if it's working

Open in your browser or use curl:
```
GET https://your-domain.com/api/health
```

### Assemble Videos

Send a POST request with your video URLs:

```bash
curl -X POST https://your-domain.com/api/assemble \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "videos": [
      {"url": "https://example.com/video1.mp4"},
      {"url": "https://example.com/video2.mp4"},
      {"url": "https://example.com/video3.mp4"}
    ],
    "transition": {"duration": 1},
    "output": {"resolution": "1920x1080"}
  }'
```

**Response:**
```json
{
  "success": true,
  "videoUrl": "https://your-domain.com/api/download/assembled-1705312200000.mp4",
  "duration": 24.5,
  "processingTime": 12500
}
```

### Download the Result

The `videoUrl` in the response is a direct link to download your assembled video.

---

## API Reference

### Endpoints Summary

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/health` | GET | No | Check if API is running |
| `/api/assemble` | POST | Yes | Combine videos |
| `/api/download/:filename` | GET | No | Download result video |
| `/api/job/:jobId` | GET | Yes | Check async job status |

### POST /api/assemble - Full Parameters

```json
{
  "videos": [
    { "url": "https://..." },
    { "url": "https://..." }
  ],
  "transition": {
    "type": "fade",
    "duration": 1
  },
  "output": {
    "format": "mp4",
    "resolution": "1920x1080"
  },
  "callbackUrl": "https://..."
}
```

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `videos` | Yes | - | Array of video objects with `url` |
| `videos[].url` | Yes | - | Direct URL to video file |
| `videos[].duration` | No | auto | Video duration (auto-detected) |
| `transition.type` | No | `fade` | Transition type |
| `transition.duration` | No | `1` | Fade duration in seconds |
| `output.format` | No | `mp4` | Output format |
| `output.resolution` | No | `1920x1080` | Output resolution |
| `callbackUrl` | No | - | URL for async callback (see below) |

### Async Mode (for long videos)

If processing might take a long time, use `callbackUrl`. The API will return immediately and send results to your callback URL when done.

**Request:**
```json
{
  "videos": [...],
  "callbackUrl": "https://your-app.com/webhook/video-done"
}
```

**Immediate Response:**
```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing"
}
```

**Callback (sent to your URL when done):**
```json
{
  "jobId": "550e8400-...",
  "status": "completed",
  "videoUrl": "https://your-domain.com/api/download/..."
}
```

---

## Usage Examples

### With n8n

**HTTP Request Node:**
- Method: `POST`
- URL: `https://your-domain.com/api/assemble`
- Authentication: Header Auth
  - Name: `X-API-Key`
  - Value: `your-api-key`
- Body:
```json
{
  "videos": {{ $json.videoUrls.map(url => ({url})) }},
  "transition": { "duration": 1 }
}
```

### With JavaScript

```javascript
const response = await fetch('https://your-domain.com/api/assemble', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': 'your-api-key'
  },
  body: JSON.stringify({
    videos: [
      { url: 'https://example.com/video1.mp4' },
      { url: 'https://example.com/video2.mp4' }
    ]
  })
});

const result = await response.json();
console.log('Download URL:', result.videoUrl);
```

### With Python

```python
import requests

response = requests.post(
    'https://your-domain.com/api/assemble',
    headers={'X-API-Key': 'your-api-key'},
    json={
        'videos': [
            {'url': 'https://example.com/video1.mp4'},
            {'url': 'https://example.com/video2.mp4'}
        ]
    }
)

print(response.json()['videoUrl'])
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_KEY` | No | - | Secret key to protect your API |
| `BASE_URL` | No | auto | Your public URL |
| `PORT` | No | `3000` | Server port |
| `MAX_VIDEOS` | No | `20` | Max videos per request |
| `FFMPEG_TIMEOUT` | No | `300000` | Timeout in ms (5 min) |

---

## Troubleshooting

### "Unauthorized" error
Your `API_KEY` header doesn't match. Check:
- Header name is `X-API-Key` (case-sensitive)
- Value matches your `API_KEY` environment variable

### "File not found" when downloading
Output files are deleted after 2 hours. Download your video promptly.

### Processing takes too long
- Increase `FFMPEG_TIMEOUT` environment variable
- Use async mode with `callbackUrl`
- Give your server more RAM (4GB recommended)

### Video has no audio
All input videos must have audio tracks. If any video is missing audio, the output will be video-only.

---

## License

MIT License - see [LICENSE](LICENSE) file.
