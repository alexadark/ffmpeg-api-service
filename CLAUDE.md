# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language Policy

All code, comments, documentation, and CLAUDE.md content must be written in English, regardless of the language the user communicates in.

When implementing features or making modifications:
- All code comments must be in English
- All docstrings and function descriptions must be in English
- All variable and function names must be in English
- All console logs and error messages must be in English
- This applies even if the user communicates in French or another language

## Project Overview

FFmpeg Video Assembly API Service - a REST API wrapping FFmpeg for video assembly with crossfade (xfade) transitions. Designed for Easypanel deployment and n8n workflow integration.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Development with --watch (auto-reload)
npm start            # Production start

# Docker
docker-compose up --build   # Build and run (exposes port 3001)

# Test health endpoint
curl http://localhost:3000/api/health
```

## Architecture

```
server.js           # Express API server - handles routing, auth, job management
lib/
├── ffmpeg.js       # FFmpeg command builder - xfade transitions, audio sync
└── storage.js      # Video download from URLs, local file storage, cleanup
```

### Core Flow

1. **POST /api/assemble** receives video URLs with optional transition/output config
2. **storage.js** downloads videos from URLs to temp directory
3. **ffmpeg.js** probes each video for duration/audio, builds xfade filter chain
4. FFmpeg processes videos with crossfade transitions and audio mixing
5. Result saved to `/tmp/ffmpeg-outputs/` and served via **GET /api/download/:filename**

### FFmpeg Processing (lib/ffmpeg.js)

The `buildXfadeCommand()` function creates complex FFmpeg filter chains:
- **Video**: Scales inputs to target resolution, applies xfade transitions between clips
- **Audio**: Uses `adelay` to position each audio stream at correct offset, `afade` for transitions, then `amix` to combine all streams

Key function signatures:
- `assembleVideos(videos, transition, output)` - Main entry point for video assembly
- `buildXfadeCommand(files, outputPath, transitionDuration, width, height, includeAudio)` - Builds FFmpeg command string with xfade
- `hasAudioStream(filePath)` - Probes for audio using ffprobe
- `enhanceAudio(inputPath, outputPath, options)` - Enhance audio with noise reduction and voice clarity
- `detectSilence(inputPath, options)` - Detect silence segments with timestamps
- `trimVideo(inputPath, outputPath, options)` - Trim/cut video segments (fast copy mode by default)

### Job Management

Async processing uses in-memory `Map` for job tracking. Jobs cleaned up after 1 hour. Output files cleaned up after 2 hours.

## API Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| GET /api/health | No | Health check with FFmpeg version |
| POST /api/assemble | Yes | Assemble videos with crossfade transitions (sync or async) |
| POST /api/enhance-audio | Yes | Enhance audio with noise reduction and voice clarity (sync or async) |
| POST /api/detect-silence | Yes | Detect silence segments in video/audio (sync or async) |
| POST /api/trim | Yes | Trim video segment (sync or async) |
| GET /api/download/:filename | No | Download assembled or processed video |
| GET /api/job/:jobId | Yes | Check async job status |

## Environment Variables

Required: None (can run without config for dev)

Optional:
- `PORT` (default: 3000)
- `API_KEY` - Enable authentication
- `BASE_URL` - Override download URL generation
- `MAX_VIDEOS` (default: 20)
- `MAX_FILE_SIZE_MB` (default: 500)
- `FFMPEG_TIMEOUT` (default: 300000ms)
- `OUTPUT_DIR` (default: /tmp/ffmpeg-outputs)

Note: Supabase config in .env.example is legacy - current implementation uses local file storage.

## Key Implementation Details

- Videos require audio streams for audio processing; if any video lacks audio, output is video-only
- xfade offsets calculated based on cumulative durations minus transition overlaps
- Audio sync achieved via `adelay` filter matching video xfade offsets (not acrossfade)
- Temporary work directories created per job in `/tmp/ffmpeg-job-*`
