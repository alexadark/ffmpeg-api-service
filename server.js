require('dotenv').config();

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const { assembleVideos, enhanceAudio, detectSilence, trimVideo, extractAudio, autoEditSegments, cropVideo, addSubtitles, applyColorGrade } = require('./lib/ffmpeg');
const { getFilePath, cleanupOldFiles, downloadVideo, saveVideo } = require('./lib/storage');
const { parseSRT, cleanSRT, isValidSRT } = require('./lib/subtitle-parser');
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

// Audio extraction endpoint
app.post('/api/extract-audio', authenticate, async (req, res) => {
  const startTime = Date.now();

  try {
    const { url, format, bitrate, callbackUrl } = req.body;

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

    // Validate format if provided
    const validFormats = ['mp3', 'wav', 'aac'];
    const audioFormat = format || 'mp3';
    if (!validFormats.includes(audioFormat.toLowerCase())) {
      return res.status(400).json({
        error: `Invalid format: ${format}. Valid formats: ${validFormats.join(', ')}`
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
      processAudioExtractionAsync(jobId, url, { format: audioFormat, bitrate }, callbackUrl, req);

      return res.json({
        success: true,
        jobId,
        status: 'processing',
        message: 'Audio extraction started. Results will be sent to callback URL.'
      });
    }

    // Synchronous processing
    console.log(`[${new Date().toISOString()}] Starting audio extraction`);

    const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.mkdir(workDir, { recursive: true });

    try {
      const inputPath = path.join(workDir, 'input.mp4');
      await downloadVideo(url, inputPath);

      const outputExt = audioFormat.toLowerCase();
      const outputPath = path.join(workDir, `audio.${outputExt}`);
      const result = await extractAudio(inputPath, outputPath, { format: audioFormat, bitrate });

      // Save result
      const fileName = `audio-${Date.now()}.${outputExt}`;
      const savedFile = await saveVideo(outputPath, fileName);

      const baseUrl = getBaseUrl(req);
      const audioUrl = `${baseUrl}/api/download/${savedFile.filename}`;

      const processingTime = Date.now() - startTime;

      res.json({
        success: true,
        audioUrl,
        filename: savedFile.filename,
        duration: result.duration,
        fileSize: result.fileSize,
        format: audioFormat,
        processingTime
      });

    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Audio extraction error:`, error.message);

    res.status(500).json({
      success: false,
      error: error.message || 'Audio extraction failed'
    });
  }
});

// Auto-edit endpoint (silence removal + segment assembly)
app.post('/api/auto-edit', authenticate, async (req, res) => {
  const startTime = Date.now();

  try {
    const { url, silenceThreshold, minSilenceDuration, segments, strategy, output, callbackUrl } = req.body;

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
      processAutoEditAsync(jobId, url, { silenceThreshold, minSilenceDuration, segments, strategy, output }, callbackUrl, req);

      return res.json({
        success: true,
        jobId,
        status: 'processing',
        message: 'Auto-edit started. Results will be sent to callback URL.'
      });
    }

    // Synchronous processing
    console.log(`[${new Date().toISOString()}] Starting auto-edit`);

    const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.mkdir(workDir, { recursive: true });

    try {
      const inputPath = path.join(workDir, 'input.mp4');
      await downloadVideo(url, inputPath);

      let segmentsToKeep = segments;

      // If no segments provided, detect silences and create segments
      if (!segmentsToKeep || segmentsToKeep.length === 0) {
        const threshold = silenceThreshold || '-35dB';
        const minDuration = minSilenceDuration || 0.5;

        console.log(`[Auto-Edit] Detecting silences with threshold ${threshold}, min duration ${minDuration}s`);

        const silenceResult = await require('./lib/ffmpeg').detectSilence(inputPath, {
          threshold,
          minDuration
        });

        // Convert silences to segments to KEEP (inverse of silences)
        segmentsToKeep = silencesToSegments(silenceResult.silences, silenceResult.originalDuration, strategy);

        if (segmentsToKeep.length === 0) {
          return res.json({
            success: true,
            message: 'No edits needed - no significant silences detected',
            originalDuration: silenceResult.originalDuration,
            editedDuration: silenceResult.originalDuration,
            timeRemoved: 0,
            processingTime: Date.now() - startTime
          });
        }
      }

      const outputPath = path.join(workDir, 'auto-edited.mp4');
      const result = await autoEditSegments(inputPath, outputPath, segmentsToKeep, output);

      // Save result
      const fileName = `auto-edited-${Date.now()}.mp4`;
      const savedFile = await saveVideo(outputPath, fileName);

      const baseUrl = getBaseUrl(req);
      const videoUrl = `${baseUrl}/api/download/${savedFile.filename}`;

      const processingTime = Date.now() - startTime;

      res.json({
        success: true,
        videoUrl,
        filename: savedFile.filename,
        originalDuration: result.originalDuration,
        editedDuration: result.editedDuration,
        timeRemoved: result.timeRemoved,
        stats: {
          segmentsKept: segmentsToKeep.length,
          totalCuts: segmentsToKeep.length - 1
        },
        processingTime
      });

    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Auto-edit error:`, error.message);

    res.status(500).json({
      success: false,
      error: error.message || 'Auto-edit failed'
    });
  }
});

/**
 * Convert silence segments to segments to KEEP
 * @param {Array} silences - Array of silence objects {start, end, duration}
 * @param {number} totalDuration - Total video duration
 * @param {string} strategy - Edit strategy: light, normal, aggressive
 * @returns {Array} Segments to keep [{start, end}, ...]
 */
function silencesToSegments(silences, totalDuration, strategy = 'normal') {
  if (!silences || silences.length === 0) {
    return [{ start: 0, end: totalDuration }];
  }

  // Strategy affects how much padding we keep around silences
  let padBefore, padAfter;
  switch (strategy) {
    case 'aggressive':
      padBefore = 0.05; // 50ms
      padAfter = 0.05;
      break;
    case 'light':
      padBefore = 0.2; // 200ms
      padAfter = 0.3;
      break;
    case 'normal':
    default:
      padBefore = 0.1; // 100ms
      padAfter = 0.15;
      break;
  }

  const segments = [];
  let currentStart = 0;

  for (const silence of silences) {
    // End the current segment at the start of silence (with padding)
    const segmentEnd = Math.max(0, silence.start + padAfter);

    if (segmentEnd > currentStart + 0.1) { // Only add segments > 100ms
      segments.push({
        start: currentStart,
        end: segmentEnd
      });
    }

    // Start next segment after the silence (with padding)
    currentStart = Math.max(segmentEnd, silence.end - padBefore);
  }

  // Add final segment if there's content after the last silence
  if (currentStart < totalDuration - 0.1) {
    segments.push({
      start: currentStart,
      end: totalDuration
    });
  }

  return segments;
}

// Video crop endpoint
app.post('/api/crop', authenticate, async (req, res) => {
  const startTime = Date.now();

  try {
    const { url, aspectRatio, position, zoom, output, callbackUrl } = req.body;

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

    // Validate aspect ratio if provided
    const validAspectRatios = ['9:16', '1:1', '16:9', '4:3'];
    const targetRatio = aspectRatio || '9:16';
    if (!validAspectRatios.includes(targetRatio)) {
      return res.status(400).json({
        error: `Invalid aspect ratio: ${aspectRatio}. Valid ratios: ${validAspectRatios.join(', ')}`
      });
    }

    // Validate position if provided
    const validPositions = ['center', 'top', 'bottom', 'left', 'right'];
    const targetPosition = position || 'center';
    if (!validPositions.includes(targetPosition)) {
      return res.status(400).json({
        error: `Invalid position: ${position}. Valid positions: ${validPositions.join(', ')}`
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
      processCropAsync(jobId, url, { aspectRatio: targetRatio, position: targetPosition, zoom, output }, callbackUrl, req);

      return res.json({
        success: true,
        jobId,
        status: 'processing',
        message: 'Video crop started. Results will be sent to callback URL.'
      });
    }

    // Synchronous processing
    console.log(`[${new Date().toISOString()}] Starting video crop`);

    const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.mkdir(workDir, { recursive: true });

    try {
      const inputPath = path.join(workDir, 'input.mp4');
      await downloadVideo(url, inputPath);

      const outputPath = path.join(workDir, 'cropped.mp4');
      const result = await cropVideo(inputPath, outputPath, { aspectRatio: targetRatio, position: targetPosition, zoom });

      // Save result
      const fileName = `cropped-${Date.now()}.mp4`;
      const savedFile = await saveVideo(outputPath, fileName);

      const baseUrl = getBaseUrl(req);
      const videoUrl = `${baseUrl}/api/download/${savedFile.filename}`;

      const processingTime = Date.now() - startTime;

      res.json({
        success: true,
        videoUrl,
        filename: savedFile.filename,
        originalResolution: result.originalResolution,
        croppedResolution: result.croppedResolution,
        aspectRatio: result.aspectRatio,
        position: result.position,
        processingTime
      });

    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Crop error:`, error.message);

    res.status(500).json({
      success: false,
      error: error.message || 'Crop operation failed'
    });
  }
});

// Add subtitles endpoint
app.post('/api/add-subtitles', authenticate, async (req, res) => {
  const startTime = Date.now();

  try {
    const { url, subtitles, style, fontSize, position, fontColor, outlineColor, backgroundColor, output, callbackUrl } = req.body;

    // Validate request
    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'Invalid request: url is required'
      });
    }

    if (!subtitles || typeof subtitles !== 'string') {
      return res.status(400).json({
        error: 'Invalid request: subtitles (SRT content) is required'
      });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({
        error: 'Invalid video URL'
      });
    }

    // Validate SRT content
    const cleanedSRT = cleanSRT(subtitles);
    if (!isValidSRT(cleanedSRT)) {
      return res.status(400).json({
        error: 'Invalid subtitle format: must be valid SRT format'
      });
    }

    // Parse and validate subtitles
    let parsedSubs;
    try {
      parsedSubs = parseSRT(cleanedSRT);
    } catch (parseError) {
      return res.status(400).json({
        error: `Subtitle parsing error: ${parseError.message}`
      });
    }

    // Validate style if provided
    const validStyles = ['bold-white', 'bold-yellow', 'minimal', 'custom'];
    const targetStyle = style || 'bold-white';
    if (!validStyles.includes(targetStyle)) {
      return res.status(400).json({
        error: `Invalid style: ${style}. Valid styles: ${validStyles.join(', ')}`
      });
    }

    // Validate position if provided
    const validPositions = ['bottom', 'top', 'center'];
    const targetPosition = position || 'bottom';
    if (!validPositions.includes(targetPosition)) {
      return res.status(400).json({
        error: `Invalid position: ${position}. Valid positions: ${validPositions.join(', ')}`
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
      processSubtitlesAsync(jobId, url, cleanedSRT, parsedSubs.count, { style: targetStyle, fontSize, position: targetPosition, fontColor, outlineColor, output }, callbackUrl, req);

      return res.json({
        success: true,
        jobId,
        status: 'processing',
        message: 'Subtitle addition started. Results will be sent to callback URL.'
      });
    }

    // Synchronous processing
    console.log(`[${new Date().toISOString()}] Starting subtitle addition`);

    const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.mkdir(workDir, { recursive: true });

    try {
      const inputPath = path.join(workDir, 'input.mp4');
      await downloadVideo(url, inputPath);

      // Write SRT file
      const srtPath = path.join(workDir, 'subtitles.srt');
      await fs.writeFile(srtPath, cleanedSRT, 'utf8');

      const outputPath = path.join(workDir, 'subtitled.mp4');
      const result = await addSubtitles(inputPath, outputPath, srtPath, { style: targetStyle, fontSize, position: targetPosition, fontColor, outlineColor });

      // Save result
      const fileName = `subtitled-${Date.now()}.mp4`;
      const savedFile = await saveVideo(outputPath, fileName);

      const baseUrl = getBaseUrl(req);
      const videoUrl = `${baseUrl}/api/download/${savedFile.filename}`;

      const processingTime = Date.now() - startTime;

      res.json({
        success: true,
        videoUrl,
        filename: savedFile.filename,
        subtitleCount: parsedSubs.count,
        style: result.style,
        position: result.position,
        processingTime
      });

    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Subtitle addition error:`, error.message);

    res.status(500).json({
      success: false,
      error: error.message || 'Subtitle addition failed'
    });
  }
});

// POST /api/color-grade - Apply color grading to video
app.post('/api/color-grade', authenticate, async (req, res) => {
  const startTime = Date.now();

  try {
    const { url, preset, intensity, lut, adjustments, output, callbackUrl } = req.body;

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

    // Validate preset if provided
    const validPresets = ['cinematic', 'vintage', 'cool', 'warm', 'vibrant', 'custom'];
    const targetPreset = preset || 'cinematic';
    if (!validPresets.includes(targetPreset)) {
      return res.status(400).json({
        error: `Invalid preset: ${preset}. Valid presets: ${validPresets.join(', ')}`
      });
    }

    // Validate intensity if provided
    const targetIntensity = intensity !== undefined ? parseFloat(intensity) : 1.0;
    if (isNaN(targetIntensity) || targetIntensity < 0 || targetIntensity > 1.0) {
      return res.status(400).json({
        error: 'Invalid intensity: must be a number between 0.0 and 1.0'
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
      processColorGradeAsync(jobId, url, { preset: targetPreset, intensity: targetIntensity, lut, adjustments, output }, callbackUrl, req);

      return res.json({
        success: true,
        jobId,
        status: 'processing',
        message: 'Video color grading started. Results will be sent to callback URL.'
      });
    }

    // Synchronous processing
    console.log(`[${new Date().toISOString()}] Starting video color grading`);

    const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.mkdir(workDir, { recursive: true });

    try {
      const inputPath = path.join(workDir, 'input.mp4');
      await downloadVideo(url, inputPath);

      const outputPath = path.join(workDir, 'color-graded.mp4');
      const result = await applyColorGrade(inputPath, outputPath, targetPreset, targetIntensity, lut, adjustments);

      // Save result
      const fileName = `color-graded-${Date.now()}.mp4`;
      const savedFile = await saveVideo(outputPath, fileName);

      const baseUrl = getBaseUrl(req);
      const videoUrl = `${baseUrl}/api/download/${savedFile.filename}`;

      const processingTime = Date.now() - startTime;

      res.json({
        success: true,
        videoUrl,
        filename: savedFile.filename,
        preset: result.preset,
        intensity: result.intensity,
        processingTime
      });

    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Color grading error:`, error.message);

    res.status(500).json({
      success: false,
      error: error.message || 'Color grading failed'
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

// Async audio extraction processing
async function processAudioExtractionAsync(jobId, url, options, callbackUrl, req) {
  const axios = require('axios');
  const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await fs.mkdir(workDir, { recursive: true });
    jobs.set(jobId, { ...jobs.get(jobId), status: 'processing', progress: 20 });

    const inputPath = path.join(workDir, 'input.mp4');
    await downloadVideo(url, inputPath);
    jobs.set(jobId, { ...jobs.get(jobId), progress: 40 });

    const outputExt = (options.format || 'mp3').toLowerCase();
    const outputPath = path.join(workDir, `audio.${outputExt}`);
    const result = await extractAudio(inputPath, outputPath, { format: options.format, bitrate: options.bitrate });
    jobs.set(jobId, { ...jobs.get(jobId), progress: 70 });

    const fileName = `audio-${Date.now()}.${outputExt}`;
    const savedFile = await saveVideo(outputPath, fileName);

    const baseUrl = getBaseUrl(req);
    const audioUrl = `${baseUrl}/api/download/${savedFile.filename}`;

    jobs.set(jobId, {
      status: 'completed',
      progress: 100,
      audioUrl,
      filename: savedFile.filename,
      duration: result.duration,
      fileSize: result.fileSize,
      format: outputExt,
      completedAt: new Date().toISOString()
    });

    // Send callback
    if (callbackUrl) {
      await axios.post(callbackUrl, {
        jobId,
        status: 'completed',
        audioUrl,
        filename: savedFile.filename,
        duration: result.duration,
        fileSize: result.fileSize,
        format: outputExt
      });
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Async audio extraction job ${jobId} failed:`, error.message);

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

// Async auto-edit processing
async function processAutoEditAsync(jobId, url, options, callbackUrl, req) {
  const axios = require('axios');
  const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await fs.mkdir(workDir, { recursive: true });
    jobs.set(jobId, { ...jobs.get(jobId), status: 'processing', progress: 10 });

    const inputPath = path.join(workDir, 'input.mp4');
    await downloadVideo(url, inputPath);
    jobs.set(jobId, { ...jobs.get(jobId), progress: 30 });

    let segmentsToKeep = options.segments;

    // If no segments provided, detect silences and create segments
    if (!segmentsToKeep || segmentsToKeep.length === 0) {
      const threshold = options.silenceThreshold || '-35dB';
      const minDuration = options.minSilenceDuration || 0.5;

      console.log(`[Auto-Edit Async] Detecting silences with threshold ${threshold}, min duration ${minDuration}s`);

      const silenceResult = await require('./lib/ffmpeg').detectSilence(inputPath, {
        threshold,
        minDuration
      });

      jobs.set(jobId, { ...jobs.get(jobId), progress: 50 });

      // Convert silences to segments to KEEP
      segmentsToKeep = silencesToSegments(silenceResult.silences, silenceResult.originalDuration, options.strategy);

      if (segmentsToKeep.length === 0) {
        jobs.set(jobId, {
          status: 'completed',
          progress: 100,
          message: 'No edits needed - no significant silences detected',
          originalDuration: silenceResult.originalDuration,
          editedDuration: silenceResult.originalDuration,
          timeRemoved: 0,
          completedAt: new Date().toISOString()
        });

        if (callbackUrl) {
          await axios.post(callbackUrl, {
            jobId,
            status: 'completed',
            message: 'No edits needed',
            originalDuration: silenceResult.originalDuration,
            timeRemoved: 0
          });
        }
        return;
      }
    }

    jobs.set(jobId, { ...jobs.get(jobId), progress: 60 });

    const outputPath = path.join(workDir, 'auto-edited.mp4');
    const result = await autoEditSegments(inputPath, outputPath, segmentsToKeep, options.output);
    jobs.set(jobId, { ...jobs.get(jobId), progress: 85 });

    const fileName = `auto-edited-${Date.now()}.mp4`;
    const savedFile = await saveVideo(outputPath, fileName);

    const baseUrl = getBaseUrl(req);
    const videoUrl = `${baseUrl}/api/download/${savedFile.filename}`;

    jobs.set(jobId, {
      status: 'completed',
      progress: 100,
      videoUrl,
      filename: savedFile.filename,
      originalDuration: result.originalDuration,
      editedDuration: result.editedDuration,
      timeRemoved: result.timeRemoved,
      stats: {
        segmentsKept: segmentsToKeep.length,
        totalCuts: segmentsToKeep.length - 1
      },
      completedAt: new Date().toISOString()
    });

    // Send callback
    if (callbackUrl) {
      await axios.post(callbackUrl, {
        jobId,
        status: 'completed',
        videoUrl,
        filename: savedFile.filename,
        originalDuration: result.originalDuration,
        editedDuration: result.editedDuration,
        timeRemoved: result.timeRemoved,
        stats: {
          segmentsKept: segmentsToKeep.length,
          totalCuts: segmentsToKeep.length - 1
        }
      });
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Async auto-edit job ${jobId} failed:`, error.message);

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

// Async crop processing
async function processCropAsync(jobId, url, options, callbackUrl, req) {
  const axios = require('axios');
  const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await fs.mkdir(workDir, { recursive: true });
    jobs.set(jobId, { ...jobs.get(jobId), status: 'processing', progress: 20 });

    const inputPath = path.join(workDir, 'input.mp4');
    await downloadVideo(url, inputPath);
    jobs.set(jobId, { ...jobs.get(jobId), progress: 40 });

    const outputPath = path.join(workDir, 'cropped.mp4');
    const result = await cropVideo(inputPath, outputPath, { aspectRatio: options.aspectRatio, position: options.position, zoom: options.zoom });
    jobs.set(jobId, { ...jobs.get(jobId), progress: 70 });

    const fileName = `cropped-${Date.now()}.mp4`;
    const savedFile = await saveVideo(outputPath, fileName);

    const baseUrl = getBaseUrl(req);
    const videoUrl = `${baseUrl}/api/download/${savedFile.filename}`;

    jobs.set(jobId, {
      status: 'completed',
      progress: 100,
      videoUrl,
      filename: savedFile.filename,
      originalResolution: result.originalResolution,
      croppedResolution: result.croppedResolution,
      aspectRatio: result.aspectRatio,
      position: result.position,
      completedAt: new Date().toISOString()
    });

    // Send callback
    if (callbackUrl) {
      await axios.post(callbackUrl, {
        jobId,
        status: 'completed',
        videoUrl,
        filename: savedFile.filename,
        originalResolution: result.originalResolution,
        croppedResolution: result.croppedResolution,
        aspectRatio: result.aspectRatio,
        position: result.position
      });
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Async crop job ${jobId} failed:`, error.message);

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

// Async subtitles processing
async function processSubtitlesAsync(jobId, url, srtContent, subtitleCount, options, callbackUrl, req) {
  const axios = require('axios');
  const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await fs.mkdir(workDir, { recursive: true });
    jobs.set(jobId, { ...jobs.get(jobId), status: 'processing', progress: 20 });

    const inputPath = path.join(workDir, 'input.mp4');
    await downloadVideo(url, inputPath);
    jobs.set(jobId, { ...jobs.get(jobId), progress: 40 });

    // Write SRT file
    const srtPath = path.join(workDir, 'subtitles.srt');
    await fs.writeFile(srtPath, srtContent, 'utf8');
    jobs.set(jobId, { ...jobs.get(jobId), progress: 50 });

    const outputPath = path.join(workDir, 'subtitled.mp4');
    const result = await addSubtitles(inputPath, outputPath, srtPath, { style: options.style, fontSize: options.fontSize, position: options.position, fontColor: options.fontColor, outlineColor: options.outlineColor });
    jobs.set(jobId, { ...jobs.get(jobId), progress: 80 });

    const fileName = `subtitled-${Date.now()}.mp4`;
    const savedFile = await saveVideo(outputPath, fileName);

    const baseUrl = getBaseUrl(req);
    const videoUrl = `${baseUrl}/api/download/${savedFile.filename}`;

    jobs.set(jobId, {
      status: 'completed',
      progress: 100,
      videoUrl,
      filename: savedFile.filename,
      subtitleCount: subtitleCount,
      style: result.style,
      position: result.position,
      completedAt: new Date().toISOString()
    });

    // Send callback
    if (callbackUrl) {
      await axios.post(callbackUrl, {
        jobId,
        status: 'completed',
        videoUrl,
        filename: savedFile.filename,
        subtitleCount: subtitleCount,
        style: result.style,
        position: result.position
      });
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Async subtitles job ${jobId} failed:`, error.message);

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

// Async color grading processing
async function processColorGradeAsync(jobId, url, options, callbackUrl, req) {
  const axios = require('axios');
  const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await fs.mkdir(workDir, { recursive: true });
    jobs.set(jobId, { ...jobs.get(jobId), status: 'processing', progress: 20 });

    const inputPath = path.join(workDir, 'input.mp4');
    console.log(`[${new Date().toISOString()}] Async color grade job ${jobId}: Downloading video`);
    await downloadVideo(url, inputPath);
    jobs.set(jobId, { ...jobs.get(jobId), progress: 40 });

    const outputPath = path.join(workDir, 'color-graded.mp4');
    console.log(`[${new Date().toISOString()}] Async color grade job ${jobId}: Applying color grade`);
    const result = await applyColorGrade(inputPath, outputPath, options.preset, options.intensity, options.lut, options.adjustments);
    jobs.set(jobId, { ...jobs.get(jobId), progress: 80 });

    const fileName = `color-graded-${Date.now()}.mp4`;
    const savedFile = await saveVideo(outputPath, fileName);

    const baseUrl = getBaseUrl(req);
    const videoUrl = `${baseUrl}/api/download/${savedFile.filename}`;

    jobs.set(jobId, {
      status: 'completed',
      progress: 100,
      videoUrl,
      filename: savedFile.filename,
      preset: result.preset,
      intensity: result.intensity,
      completedAt: new Date().toISOString()
    });

    // Send callback
    if (callbackUrl) {
      await axios.post(callbackUrl, {
        jobId,
        status: 'completed',
        videoUrl,
        filename: savedFile.filename,
        preset: result.preset,
        intensity: result.intensity
      });
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Async color grade job ${jobId} failed:`, error.message);

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
  console.log(`FFmpeg API Service v2.1.0 running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Phase 1-2: /api/assemble, /api/enhance-audio, /api/detect-silence, /api/trim, /api/extract-audio, /api/auto-edit`);
  console.log(`Phase 3: /api/crop, /api/add-subtitles`);
  console.log(`Phase 4: /api/color-grade`);
});
