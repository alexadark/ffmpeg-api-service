require('dotenv').config();

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { assembleVideos } = require('./lib/ffmpeg');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Store jobs for async processing
const jobs = new Map();

// API Key authentication middleware
function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!process.env.API_KEY) {
    // No API key configured, allow all requests (development mode)
    return next();
  }

  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
  }

  next();
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  const { execSync } = require('child_process');
  let ffmpegAvailable = false;
  let ffmpegVersion = 'unknown';

  try {
    const output = execSync('ffmpeg -version', { encoding: 'utf8' });
    ffmpegAvailable = true;
    const versionMatch = output.match(/ffmpeg version (\S+)/);
    if (versionMatch) {
      ffmpegVersion = versionMatch[1];
    }
  } catch (error) {
    ffmpegAvailable = false;
  }

  res.json({
    status: ffmpegAvailable ? 'healthy' : 'degraded',
    ffmpeg: ffmpegAvailable ? 'available' : 'unavailable',
    ffmpegVersion,
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Video assembly endpoint
app.post('/api/assemble', authenticate, async (req, res) => {
  const startTime = Date.now();

  try {
    const { videos, transition, output, callbackUrl } = req.body;

    // Validate request
    if (!videos || !Array.isArray(videos)) {
      return res.status(400).json({
        error: 'Invalid request: videos array is required'
      });
    }

    if (videos.length < 2) {
      return res.status(400).json({
        error: 'At least 2 videos are required for assembly'
      });
    }

    // Validate max videos
    const maxVideos = parseInt(process.env.MAX_VIDEOS) || 20;
    if (videos.length > maxVideos) {
      return res.status(400).json({
        error: `Maximum ${maxVideos} videos allowed`
      });
    }

    // Validate video URLs
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      if (!video.url || typeof video.url !== 'string') {
        return res.status(400).json({
          error: `Invalid video at index ${i}: url is required`
        });
      }

      try {
        new URL(video.url);
      } catch {
        return res.status(400).json({
          error: `Invalid video URL at index ${i}`
        });
      }
    }

    // Set defaults for transition and output
    const transitionConfig = {
      type: transition?.type || 'fade',
      duration: transition?.duration || 1
    };

    const outputConfig = {
      format: output?.format || 'mp4',
      resolution: output?.resolution || '1920x1080'
    };

    // If callback URL provided, process async
    if (callbackUrl) {
      const jobId = uuidv4();

      jobs.set(jobId, {
        status: 'processing',
        progress: 0,
        createdAt: new Date().toISOString()
      });

      // Start processing in background
      processAsync(jobId, videos, transitionConfig, outputConfig, callbackUrl);

      return res.json({
        success: true,
        jobId,
        status: 'processing',
        message: 'Video assembly started. Results will be sent to callback URL.'
      });
    }

    // Synchronous processing
    console.log(`[${new Date().toISOString()}] Starting video assembly with ${videos.length} clips`);

    const result = await assembleVideos(videos, transitionConfig, outputConfig);

    const processingTime = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] Assembly complete in ${processingTime}ms`);

    res.json({
      success: true,
      videoUrl: result.url,
      duration: result.duration,
      processingTime
    });

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Assembly error:`, error.message);

    res.status(500).json({
      success: false,
      error: error.message || 'Video assembly failed'
    });
  }
});

// Async processing function
async function processAsync(jobId, videos, transition, output, callbackUrl) {
  const axios = require('axios');

  try {
    jobs.set(jobId, { ...jobs.get(jobId), status: 'processing', progress: 10 });

    const result = await assembleVideos(videos, transition, output);

    jobs.set(jobId, {
      status: 'completed',
      progress: 100,
      videoUrl: result.url,
      duration: result.duration,
      completedAt: new Date().toISOString()
    });

    // Send callback
    if (callbackUrl) {
      await axios.post(callbackUrl, {
        jobId,
        status: 'completed',
        videoUrl: result.url,
        duration: result.duration
      });
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Async job ${jobId} failed:`, error.message);

    jobs.set(jobId, {
      status: 'failed',
      error: error.message,
      failedAt: new Date().toISOString()
    });

    // Send failure callback
    if (callbackUrl) {
      try {
        await axios.post(callbackUrl, {
          jobId,
          status: 'failed',
          error: error.message
        });
      } catch (callbackError) {
        console.error('Callback failed:', callbackError.message);
      }
    }
  }
}

// Job status endpoint
app.get('/api/job/:jobId', authenticate, (req, res) => {
  const { jobId } = req.params;

  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({
      error: 'Job not found'
    });
  }

  res.json({
    jobId,
    ...job
  });
});

// Clean up old jobs periodically (keep for 1 hour)
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  for (const [jobId, job] of jobs.entries()) {
    const jobTime = new Date(job.completedAt || job.failedAt || job.createdAt).getTime();
    if (jobTime < oneHourAgo) {
      jobs.delete(jobId);
    }
  }
}, 10 * 60 * 1000); // Run every 10 minutes

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Unhandled error:`, err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FFmpeg API Service running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
