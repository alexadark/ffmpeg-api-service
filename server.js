require('dotenv').config();

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const { assembleVideos, enhanceAudio, detectSilence, trimVideo } = require('./lib/ffmpeg');
const { getFilePath, cleanupOldFiles, downloadVideo, saveVideo } = require('./lib/storage');
const { version } = require('./package.json');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Store jobs for async processing
const jobs = new Map();

// Get base URL for download links
function getBaseUrl(req) {
  // Use environment variable if set, otherwise derive from request
  if (process.env.BASE_URL) {
    return process.env.BASE_URL;
  }
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${protocol}://${host}`;
}

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

// Health check endpoint (no auth required)
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
    version,
    timestamp: new Date().toISOString()
  });
});

// Download endpoint - serve assembled videos (no auth for easy access from n8n)
app.get('/api/download/:filename', async (req, res) => {
  const { filename } = req.params;

  try {
    const filePath = await getFilePath(filename);

    if (!filePath) {
      return res.status(404).json({
        error: 'File not found or expired'
      });
    }

    // Set headers for video download
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Stream the file
    const fs = require('fs');
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);

    stream.on('error', (err) => {
      console.error(`[Download] Stream error:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream file' });
      }
    });

  } catch (error) {
    console.error(`[Download] Error:`, error.message);
    res.status(500).json({ error: 'Download failed' });
  }
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
      processAsync(jobId, videos, transitionConfig, outputConfig, callbackUrl, req);

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

    // Build download URL
    const baseUrl = getBaseUrl(req);
    const videoUrl = `${baseUrl}/api/download/${result.filename}`;

    res.json({
      success: true,
      videoUrl,
      filename: result.filename,
      size: result.size,
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
async function processAsync(jobId, videos, transition, output, callbackUrl, req) {
  const axios = require('axios');

  try {
    jobs.set(jobId, { ...jobs.get(jobId), status: 'processing', progress: 10 });

    const result = await assembleVideos(videos, transition, output);

    // Build download URL
    const baseUrl = getBaseUrl(req);
    const videoUrl = `${baseUrl}/api/download/${result.filename}`;

    jobs.set(jobId, {
      status: 'completed',
      progress: 100,
      videoUrl,
      filename: result.filename,
      duration: result.duration,
      completedAt: new Date().toISOString()
    });

    // Send callback
    if (callbackUrl) {
      await axios.post(callbackUrl, {
        jobId,
        status: 'completed',
        videoUrl,
        filename: result.filename,
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

// Audio enhancement endpoint
app.post('/api/enhance-audio', authenticate, async (req, res) => {
  const startTime = Date.now();

  try {
    const { url, noiseFloor, voiceBoost, output, callbackUrl } = req.body;

    // Validate request
    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'Invalid request: url is required'
      });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({
        error: 'Invalid video URL'
      });
    }

    // If callback URL provided, process async
    if (callbackUrl) {
      const jobId = uuidv4();

      jobs.set(jobId, {
        status: 'processing',
        progress: 0,
        createdAt: new Date().toISOString()
      });

      // Start processing in background
      processAudioEnhancementAsync(jobId, url, { noiseFloor, voiceBoost, output }, callbackUrl, req);

      return res.json({
        success: true,
        jobId,
        status: 'processing',
        message: 'Audio enhancement started. Results will be sent to callback URL.'
      });
    }

    // Synchronous processing
    console.log(`[${new Date().toISOString()}] Starting audio enhancement`);

    const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.mkdir(workDir, { recursive: true });

    try {
      const inputPath = path.join(workDir, 'input.mp4');
      await downloadVideo(url, inputPath);

      const outputPath = path.join(workDir, 'enhanced.mp4');
      const result = await enhanceAudio(inputPath, outputPath, { noiseFloor, voiceBoost });

      // Save result
      const fileName = `enhanced-audio-${Date.now()}.mp4`;
      const savedFile = await saveVideo(outputPath, fileName);

      const baseUrl = getBaseUrl(req);
      const videoUrl = `${baseUrl}/api/download/${savedFile.filename}`;

      const processingTime = Date.now() - startTime;

      res.json({
        success: true,
        videoUrl,
        filename: savedFile.filename,
        audioStats: result.audioStats,
        processingTime
      });

    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Audio enhancement error:`, error.message);

    res.status(500).json({
      success: false,
      error: error.message || 'Audio enhancement failed'
    });
  }
});

// Silence detection endpoint
app.post('/api/detect-silence', authenticate, async (req, res) => {
  const startTime = Date.now();

  try {
    const { url, threshold, minDuration, callbackUrl } = req.body;

    // Validate request
    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'Invalid request: url is required'
      });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({
        error: 'Invalid video URL'
      });
    }

    // If callback URL provided, process async
    if (callbackUrl) {
      const jobId = uuidv4();

      jobs.set(jobId, {
        status: 'processing',
        progress: 0,
        createdAt: new Date().toISOString()
      });

      // Start processing in background
      processSilenceDetectionAsync(jobId, url, { threshold, minDuration }, callbackUrl, req);

      return res.json({
        success: true,
        jobId,
        status: 'processing',
        message: 'Silence detection started. Results will be sent to callback URL.'
      });
    }

    // Synchronous processing
    console.log(`[${new Date().toISOString()}] Starting silence detection`);

    const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.mkdir(workDir, { recursive: true });

    try {
      const inputPath = path.join(workDir, 'input.mp4');
      await downloadVideo(url, inputPath);

      const result = await detectSilence(inputPath, { threshold, minDuration });

      const processingTime = Date.now() - startTime;

      res.json({
        success: true,
        silences: result.silences,
        totalSilenceDuration: result.totalSilenceDuration,
        originalDuration: result.originalDuration,
        processingTime
      });

    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Silence detection error:`, error.message);

    res.status(500).json({
      success: false,
      error: error.message || 'Silence detection failed'
    });
  }
});

// Video trim endpoint
app.post('/api/trim', authenticate, async (req, res) => {
  const startTime = Date.now();

  try {
    const { url, start, end, output, callbackUrl } = req.body;

    // Validate request
    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'Invalid request: url is required'
      });
    }

    if (typeof start !== 'number' || typeof end !== 'number') {
      return res.status(400).json({
        error: 'Invalid request: start and end times are required (in seconds)'
      });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({
        error: 'Invalid video URL'
      });
    }

    // If callback URL provided, process async
    if (callbackUrl) {
      const jobId = uuidv4();

      jobs.set(jobId, {
        status: 'processing',
        progress: 0,
        createdAt: new Date().toISOString()
      });

      // Start processing in background
      processTrimAsync(jobId, url, { start, end, output }, callbackUrl, req);

      return res.json({
        success: true,
        jobId,
        status: 'processing',
        message: 'Video trim started. Results will be sent to callback URL.'
      });
    }

    // Synchronous processing
    console.log(`[${new Date().toISOString()}] Starting video trim`);

    const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.mkdir(workDir, { recursive: true });

    try {
      const inputPath = path.join(workDir, 'input.mp4');
      await downloadVideo(url, inputPath);

      const outputPath = path.join(workDir, 'trimmed.mp4');
      const result = await trimVideo(inputPath, outputPath, { start, end, useCopy: true });

      // Save result
      const fileName = `trimmed-${Date.now()}.mp4`;
      const savedFile = await saveVideo(outputPath, fileName);

      const baseUrl = getBaseUrl(req);
      const videoUrl = `${baseUrl}/api/download/${savedFile.filename}`;

      const processingTime = Date.now() - startTime;

      res.json({
        success: true,
        videoUrl,
        filename: savedFile.filename,
        duration: result.duration,
        processingTime
      });

    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Trim error:`, error.message);

    res.status(500).json({
      success: false,
      error: error.message || 'Trim operation failed'
    });
  }
});

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

// Async audio enhancement processing
async function processAudioEnhancementAsync(jobId, url, options, callbackUrl, req) {
  const axios = require('axios');
  const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await fs.mkdir(workDir, { recursive: true });
    jobs.set(jobId, { ...jobs.get(jobId), status: 'processing', progress: 20 });

    const inputPath = path.join(workDir, 'input.mp4');
    await downloadVideo(url, inputPath);
    jobs.set(jobId, { ...jobs.get(jobId), progress: 40 });

    const outputPath = path.join(workDir, 'enhanced.mp4');
    const result = await enhanceAudio(inputPath, outputPath, { noiseFloor: options.noiseFloor, voiceBoost: options.voiceBoost });
    jobs.set(jobId, { ...jobs.get(jobId), progress: 70 });

    const fileName = `enhanced-audio-${Date.now()}.mp4`;
    const savedFile = await saveVideo(outputPath, fileName);

    const baseUrl = getBaseUrl(req);
    const videoUrl = `${baseUrl}/api/download/${savedFile.filename}`;

    jobs.set(jobId, {
      status: 'completed',
      progress: 100,
      videoUrl,
      filename: savedFile.filename,
      audioStats: result.audioStats,
      completedAt: new Date().toISOString()
    });

    // Send callback
    if (callbackUrl) {
      await axios.post(callbackUrl, {
        jobId,
        status: 'completed',
        videoUrl,
        filename: savedFile.filename,
        audioStats: result.audioStats
      });
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Async audio enhancement job ${jobId} failed:`, error.message);

    jobs.set(jobId, {
      status: 'failed',
      error: error.message,
      failedAt: new Date().toISOString()
    });

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

  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Async silence detection processing
async function processSilenceDetectionAsync(jobId, url, options, callbackUrl, req) {
  const axios = require('axios');
  const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await fs.mkdir(workDir, { recursive: true });
    jobs.set(jobId, { ...jobs.get(jobId), status: 'processing', progress: 20 });

    const inputPath = path.join(workDir, 'input.mp4');
    await downloadVideo(url, inputPath);
    jobs.set(jobId, { ...jobs.get(jobId), progress: 50 });

    const result = await detectSilence(inputPath, { threshold: options.threshold, minDuration: options.minDuration });
    jobs.set(jobId, { ...jobs.get(jobId), progress: 90 });

    jobs.set(jobId, {
      status: 'completed',
      progress: 100,
      silences: result.silences,
      totalSilenceDuration: result.totalSilenceDuration,
      originalDuration: result.originalDuration,
      completedAt: new Date().toISOString()
    });

    // Send callback
    if (callbackUrl) {
      await axios.post(callbackUrl, {
        jobId,
        status: 'completed',
        silences: result.silences,
        totalSilenceDuration: result.totalSilenceDuration,
        originalDuration: result.originalDuration
      });
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Async silence detection job ${jobId} failed:`, error.message);

    jobs.set(jobId, {
      status: 'failed',
      error: error.message,
      failedAt: new Date().toISOString()
    });

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

  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Async trim processing
async function processTrimAsync(jobId, url, options, callbackUrl, req) {
  const axios = require('axios');
  const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await fs.mkdir(workDir, { recursive: true });
    jobs.set(jobId, { ...jobs.get(jobId), status: 'processing', progress: 20 });

    const inputPath = path.join(workDir, 'input.mp4');
    await downloadVideo(url, inputPath);
    jobs.set(jobId, { ...jobs.get(jobId), progress: 40 });

    const outputPath = path.join(workDir, 'trimmed.mp4');
    const result = await trimVideo(inputPath, outputPath, { start: options.start, end: options.end, useCopy: true });
    jobs.set(jobId, { ...jobs.get(jobId), progress: 70 });

    const fileName = `trimmed-${Date.now()}.mp4`;
    const savedFile = await saveVideo(outputPath, fileName);

    const baseUrl = getBaseUrl(req);
    const videoUrl = `${baseUrl}/api/download/${savedFile.filename}`;

    jobs.set(jobId, {
      status: 'completed',
      progress: 100,
      videoUrl,
      filename: savedFile.filename,
      duration: result.duration,
      completedAt: new Date().toISOString()
    });

    // Send callback
    if (callbackUrl) {
      await axios.post(callbackUrl, {
        jobId,
        status: 'completed',
        videoUrl,
        filename: savedFile.filename,
        duration: result.duration
      });
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Async trim job ${jobId} failed:`, error.message);

    jobs.set(jobId, {
      status: 'failed',
      error: error.message,
      failedAt: new Date().toISOString()
    });

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

  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

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

// Clean up old video files periodically (keep for 2 hours)
setInterval(() => {
  cleanupOldFiles(2 * 60 * 60 * 1000);
}, 30 * 60 * 1000); // Run every 30 minutes

// Initial cleanup on startup
cleanupOldFiles(2 * 60 * 60 * 1000);

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
  console.log(`FFmpeg API Service v1.3.0 running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Download endpoint: /api/download/:filename`);
});
