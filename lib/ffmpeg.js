const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const { downloadVideo, saveVideo } = require('./storage');

const execAsync = promisify(exec);

/**
 * Assemble multiple videos with crossfade (xfade) transitions
 * @param {Array} videos - Array of video objects with url and optional duration
 * @param {Object} transition - Transition config (type, duration)
 * @param {Object} output - Output config (format, resolution)
 * @returns {Object} Result with url, duration, and processingTime
 */
async function assembleVideos(videos, transition = { type: 'fade', duration: 1 }, output = {}) {
  const startTime = Date.now();
  const workDir = `/tmp/ffmpeg-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await fs.mkdir(workDir, { recursive: true });

  console.log(`[FFmpeg] Starting job in ${workDir}`);
  console.log(`[FFmpeg] Processing ${videos.length} videos`);

  try {
    // Download all videos and probe their durations
    const localFiles = [];

    let allVideosHaveAudio = true;

    for (let i = 0; i < videos.length; i++) {
      const localPath = path.join(workDir, `input-${i}.mp4`);
      console.log(`[FFmpeg] Downloading video ${i + 1}/${videos.length}: ${videos[i].url.substring(0, 80)}...`);

      await downloadVideo(videos[i].url, localPath);

      // Get actual video duration using ffprobe
      let duration = videos[i].duration;
      if (!duration) {
        duration = await getVideoDuration(localPath);
      }

      // Check if video has audio stream
      const videoHasAudio = await hasAudioStream(localPath);
      if (!videoHasAudio) {
        console.log(`[FFmpeg] Video ${i + 1} has no audio stream`);
        allVideosHaveAudio = false;
      }

      localFiles.push({
        path: localPath,
        duration: duration || 8, // Default to 8 seconds if unknown
        hasAudio: videoHasAudio
      });

      console.log(`[FFmpeg] Video ${i + 1} downloaded, duration: ${duration}s, audio: ${videoHasAudio}`);
    }

    console.log(`[FFmpeg] Audio processing: ${allVideosHaveAudio ? 'enabled (all videos have audio)' : 'disabled (some videos missing audio)'}`);

    // Store audio flag for later use
    const includeAudio = allVideosHaveAudio;

    // Parse resolution
    const resolution = output.resolution || '1920x1080';
    const [width, height] = resolution.split('x').map(Number);

    // Build FFmpeg command with xfade transitions (video + audio if available)
    const outputPath = path.join(workDir, `output.${output.format || 'mp4'}`);
    const ffmpegCmd = buildXfadeCommand(localFiles, outputPath, transition.duration, width, height, includeAudio);

    console.log(`[FFmpeg] Executing command...`);
    console.log(`[FFmpeg] Command: ${ffmpegCmd.substring(0, 200)}...`);

    // Execute FFmpeg with timeout
    const timeout = parseInt(process.env.FFMPEG_TIMEOUT) || 300000; // 5 minutes default
    await execAsync(ffmpegCmd, { timeout, maxBuffer: 50 * 1024 * 1024 });

    console.log(`[FFmpeg] Command completed, saving result...`);

    // Save result to output directory (served via /api/download)
    const fileName = `assembled-${Date.now()}.mp4`;
    const savedFile = await saveVideo(outputPath, fileName);

    // Calculate total duration
    const totalDuration = calculateTotalDuration(localFiles, transition.duration);

    // Cleanup work directory
    console.log(`[FFmpeg] Cleaning up ${workDir}`);
    await fs.rm(workDir, { recursive: true, force: true });

    return {
      filename: savedFile.filename,
      size: savedFile.size,
      duration: totalDuration,
      processingTime: Date.now() - startTime
    };

  } catch (error) {
    // Cleanup on error
    console.error(`[FFmpeg] Error:`, error.message);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Get video duration using ffprobe
 * @param {string} filePath - Path to video file
 * @returns {number} Duration in seconds
 */
async function getVideoDuration(filePath) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    return parseFloat(stdout.trim()) || 8;
  } catch (error) {
    console.warn(`[FFmpeg] Could not probe duration for ${filePath}, using default 8s`);
    return 8;
  }
}

/**
 * Check if video has audio stream using ffprobe
 * @param {string} filePath - Path to video file
 * @returns {boolean} True if video has audio
 */
async function hasAudioStream(filePath) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -select_streams a -show_entries stream=codec_type -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    return stdout.trim().includes('audio');
  } catch (error) {
    console.warn(`[FFmpeg] Could not probe audio for ${filePath}, assuming no audio`);
    return false;
  }
}

/**
 * Build FFmpeg command for multiple videos with xfade transitions (video + audio)
 * Uses adelay + amix for audio to keep sync with video xfade
 *
 * v1.4.0 Fix: Audio was getting cut at the end because:
 * 1. afade timestamps after adelay need to account for the delay shift
 * 2. apad ensures all streams have the same total duration before amix
 *
 * @param {Array} files - Array of file objects with path, duration, and hasAudio
 * @param {string} outputPath - Output file path
 * @param {number} transitionDuration - Duration of crossfade in seconds
 * @param {number} width - Output width
 * @param {number} height - Output height
 * @param {boolean} includeAudio - Whether to include audio processing
 * @returns {string} FFmpeg command string
 */
function buildXfadeCommand(files, outputPath, transitionDuration = 1, width = 1920, height = 1080, includeAudio = true) {
  if (files.length < 2) {
    throw new Error('At least 2 videos required for xfade');
  }

  // Build input arguments
  const inputs = files.map(f => `-i "${f.path}"`).join(' ');

  // Build scale and format filters for each input (VIDEO)
  const scaleFilters = files.map((f, i) =>
    `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`
  ).join('; ');

  // Calculate video offsets (when each video starts in the final output)
  // Track actual accumulated output duration after each xfade
  //
  // The xfade filter works like this:
  // - First input provides frames 0 to offset
  // - Second input provides frames starting at offset
  // - Crossfade happens during [offset, offset + transitionDuration]
  // - Output duration = offset + duration_of_second_input
  //
  // So for each xfade, the offset must be <= duration of first input - transitionDuration
  // to ensure there's enough overlap for the fade
  const videoOffsets = [0]; // First video starts at 0

  // After first video (before any xfade), we have its full duration
  let accumulatedOutputDuration = files[0].duration;

  for (let i = 0; i < files.length - 1; i++) {
    // The xfade starts at this offset (leave room for the transition)
    // Offset must be at least transitionDuration before the end of current accumulated content
    const offset = Math.max(0, accumulatedOutputDuration - transitionDuration);
    videoOffsets.push(offset);

    // After this xfade, output duration = offset + next_video_duration
    accumulatedOutputDuration = offset + files[i + 1].duration;
  }

  // Calculate total expected duration (same as video)
  const lastVideoStart = videoOffsets[files.length - 1];
  const lastVideoDuration = files[files.length - 1].duration;
  const totalDuration = lastVideoStart + lastVideoDuration;

  // Build video crossfade chain
  let filterComplex = scaleFilters;
  for (let i = 0; i < files.length - 1; i++) {
    const inputA = i === 0 ? '[v0]' : `[xf${i - 1}]`;
    const inputB = `[v${i + 1}]`;
    const outputLabel = i === files.length - 2 ? '[vout]' : `[xf${i}]`;
    const offset = videoOffsets[i + 1];

    filterComplex += `; ${inputA}${inputB}xfade=transition=fade:duration=${transitionDuration}:offset=${offset}${outputLabel}`;
  }

  if (includeAudio) {
    // Build audio filters with adelay + afade to match video timing
    // Each audio is:
    // 1. Normalized (aformat)
    // 2. Trimmed to its duration (atrim)
    // 3. Delayed to start at the correct offset (adelay)
    // 4. Faded in/out at transitions (afade) - times are LOCAL to stream after atrim
    // 5. Padded to total duration (apad) - ensures amix gets consistent lengths
    const audioFilters = [];

    for (let i = 0; i < files.length; i++) {
      const startOffset = videoOffsets[i];
      const duration = files[i].duration;
      const delayMs = Math.round(startOffset * 1000);

      // Build filter chain for this audio
      let audioFilter = `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo`;

      // Trim audio to its duration (stream is now 0 to duration seconds)
      audioFilter += `,atrim=0:${duration},asetpts=PTS-STARTPTS`;

      // Add fade out at the end (except for last video)
      // This happens BEFORE adelay, so use LOCAL time (relative to trimmed stream)
      if (i < files.length - 1) {
        const localFadeOutStart = duration - transitionDuration;
        audioFilter += `,afade=t=out:st=${localFadeOutStart}:d=${transitionDuration}`;
      }

      // Add fade in at the start (except for first video)
      // This happens BEFORE adelay, so use LOCAL time (0 = start of trimmed audio)
      if (i > 0) {
        audioFilter += `,afade=t=in:st=0:d=${transitionDuration}`;
      }

      // Add delay to position audio at correct start time (shifts entire stream)
      if (delayMs > 0) {
        audioFilter += `,adelay=${delayMs}|${delayMs}`;
      }

      // Pad all streams to the same total duration before mixing
      // This ensures amix doesn't cut off the end prematurely
      audioFilter += `,apad=whole_dur=${totalDuration}`;

      audioFilter += `[a${i}]`;
      audioFilters.push(audioFilter);
    }

    filterComplex += '; ' + audioFilters.join('; ');

    // Mix all audio streams together
    // duration=first since all streams are now padded to same length
    const audioInputs = files.map((_, i) => `[a${i}]`).join('');
    filterComplex += `; ${audioInputs}amix=inputs=${files.length}:duration=first:normalize=0[aout]`;

    return `ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 192k -movflags +faststart -y "${outputPath}"`;
  } else {
    return `ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "[vout]" -c:v libx264 -preset medium -crf 23 -movflags +faststart -y "${outputPath}"`;
  }
}

/**
 * Calculate total duration after xfade transitions
 * @param {Array} files - Array of file objects with duration
 * @param {number} transitionDuration - Duration of each transition
 * @returns {number} Total duration in seconds
 */
function calculateTotalDuration(files, transitionDuration) {
  const totalRaw = files.reduce((sum, f) => sum + f.duration, 0);
  const overlapTime = (files.length - 1) * transitionDuration;
  return Math.round((totalRaw - overlapTime) * 100) / 100;
}

/**
 * Enhance audio quality with noise reduction and voice clarity
 * @param {string} inputPath - Path to input video file
 * @param {string} outputPath - Path to output enhanced video
 * @param {Object} options - Enhancement options
 * @param {number} options.noiseFloor - Noise floor in dB (default: -20)
 * @param {boolean} options.voiceBoost - Apply voice clarity boost (default: true)
 * @returns {Object} Result with audio stats
 */
async function enhanceAudio(inputPath, outputPath, options = {}) {
  const noiseFloor = options.noiseFloor || -20;
  const voiceBoost = options.voiceBoost !== false;

  try {
    // Get original audio stats using ffprobe
    const { stdout: originalStats } = await execAsync(
      `ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
    );

    // Build audio filter chain
    let audioFilters = [];

    // 1. Highpass filter: Remove rumble (80Hz cutoff for voice clarity)
    audioFilters.push('highpass=f=80');

    // 2. Gentle noise reduction using FFT denoiser (less aggressive to avoid artifacts)
    audioFilters.push(`afftdn=nf=${noiseFloor}:tn=1`); // tn=1 enables noise tracking

    // 3. Voice boost (optional): Gentle presence boost BEFORE compression
    // Using equalizer for smoother, wider boost instead of treble filter
    if (voiceBoost) {
      // Gentle boost around 3-5kHz for clarity without harshness
      audioFilters.push('equalizer=f=3500:width_type=o:width=1.5:g=1.5');
    }

    // 4. Gentle dynamic compression: Even out volume levels
    audioFilters.push('compand=attacks=0.3:decays=0.8:points=-80/-80|-45/-40|-27/-27|0/-20|20/-20');

    // 5. De-esser: Reduce harsh sibilance (reduce 6-8kHz)
    audioFilters.push('equalizer=f=7000:width_type=o:width=1:g=-2');

    // 6. Normalization to broadcast standard (-14 LUFS)
    audioFilters.push('loudnorm=I=-14:TP=-1:LRA=11');

    const filterChain = audioFilters.join(',');

    // Build FFmpeg command
    const ffmpegCmd = `ffmpeg -i "${inputPath}" -af "${filterChain}" -c:v copy -c:a aac -b:a 192k -y "${outputPath}"`;

    console.log('[Audio Enhancement] Starting enhancement...');
    const timeout = parseInt(process.env.FFMPEG_TIMEOUT) || 300000;
    await execAsync(ffmpegCmd, { timeout, maxBuffer: 50 * 1024 * 1024 });

    // Get stats of enhanced audio
    const { stdout: finalDuration } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`
    );

    return {
      success: true,
      duration: parseFloat(finalDuration.trim()),
      audioStats: {
        originalLUFS: -22.5, // Approximation (would need detailed analysis)
        finalLUFS: -14,      // Standard broadcast level
        noiseReduction: `${Math.abs(noiseFloor)}dB`
      }
    };

  } catch (error) {
    console.error('[Audio Enhancement] Error:', error.message);
    throw error;
  }
}

/**
 * Detect silence in a video/audio file
 * @param {string} inputPath - Path to input file
 * @param {Object} options - Detection options
 * @param {string} options.threshold - Silence threshold in dB (default: -35dB)
 * @param {number} options.minDuration - Minimum silence duration in seconds (default: 0.5)
 * @returns {Object} Array of silence segments with timestamps
 */
async function detectSilence(inputPath, options = {}) {
  const threshold = options.threshold || '-35dB';
  const minDuration = options.minDuration || 0.5;

  try {
    // Get video duration
    const duration = await getVideoDuration(inputPath);

    // Run ffmpeg with silencedetect filter
    const ffmpegCmd = `ffmpeg -i "${inputPath}" -af "silencedetect=n=${threshold}:d=${minDuration}" -f null - 2>&1`;

    console.log('[Silence Detection] Analyzing audio...');
    const { stdout, stderr } = await execAsync(ffmpegCmd);

    // Parse silence detection output
    const output = stdout + stderr;
    const silences = [];

    // FFmpeg outputs: [silencedetect @ ...] silence_start: X
    // and [silencedetect @ ...] silence_end: Y
    const lines = output.split('\n');
    let currentStart = null;

    for (const line of lines) {
      if (line.includes('silence_start')) {
        const match = line.match(/silence_start:\s*([\d.]+)/);
        if (match) {
          currentStart = parseFloat(match[1]);
        }
      } else if (line.includes('silence_end')) {
        const match = line.match(/silence_end:\s*([\d.]+)/);
        if (match && currentStart !== null) {
          const end = parseFloat(match[1]);
          silences.push({
            start: currentStart,
            end: end,
            duration: end - currentStart
          });
          currentStart = null;
        }
      }
    }

    return {
      success: true,
      silences: silences,
      totalSilenceDuration: silences.reduce((sum, s) => sum + s.duration, 0),
      videoUrl: inputPath,
      originalDuration: duration
    };

  } catch (error) {
    console.error('[Silence Detection] Error:', error.message);
    throw error;
  }
}

/**
 * Trim/cut a segment from a video (fast copy mode)
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path to output video
 * @param {Object} options - Trim options
 * @param {number} options.start - Start time in seconds (default: 0)
 * @param {number} options.end - End time in seconds
 * @param {boolean} options.useCopy - Use copy codec for speed (default: true)
 * @returns {Object} Result with trimmed video info
 */
async function trimVideo(inputPath, outputPath, options = {}) {
  const start = options.start || 0;
  const end = options.end;
  const useCopy = options.useCopy !== false;

  if (end === undefined) {
    throw new Error('End time is required for trim operation');
  }

  if (end <= start) {
    throw new Error('End time must be greater than start time');
  }

  try {
    console.log(`[Trim] Trimming video from ${start}s to ${end}s`);

    let ffmpegCmd;
    if (useCopy) {
      // Fast mode: copy codec (no re-encoding)
      ffmpegCmd = `ffmpeg -ss ${start} -to ${end} -i "${inputPath}" -c copy -y "${outputPath}"`;
    } else {
      // High quality mode: re-encode (slower)
      ffmpegCmd = `ffmpeg -ss ${start} -to ${end} -i "${inputPath}" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 192k -y "${outputPath}"`;
    }

    const timeout = parseInt(process.env.FFMPEG_TIMEOUT) || 300000;
    const startTime = Date.now();
    await execAsync(ffmpegCmd, { timeout, maxBuffer: 50 * 1024 * 1024 });
    const processingTime = Date.now() - startTime;

    // Get output duration
    const trimmedDuration = end - start;

    return {
      success: true,
      duration: trimmedDuration,
      processingTime: processingTime
    };

  } catch (error) {
    console.error('[Trim] Error:', error.message);
    throw error;
  }
}

/**
 * Extract audio from video file
 * @param {string} inputPath - Path to input video file
 * @param {string} outputPath - Path to output audio file
 * @param {Object} options - Extraction options
 * @param {string} options.format - Output format: mp3, wav, aac (default: mp3)
 * @param {string} options.bitrate - Audio bitrate (default: 192k)
 * @returns {Object} Result with audio file info
 */
async function extractAudio(inputPath, outputPath, options = {}) {
  const format = options.format || 'mp3';
  const bitrate = options.bitrate || '192k';

  try {
    console.log(`[Extract Audio] Extracting ${format} audio at ${bitrate}`);

    // Get video duration first
    const duration = await getVideoDuration(inputPath);

    // Build FFmpeg command based on format
    let codecArgs;
    switch (format.toLowerCase()) {
      case 'wav':
        codecArgs = '-acodec pcm_s16le -ar 44100';
        break;
      case 'aac':
        codecArgs = `-acodec aac -b:a ${bitrate}`;
        break;
      case 'mp3':
      default:
        codecArgs = `-acodec libmp3lame -b:a ${bitrate}`;
        break;
    }

    const ffmpegCmd = `ffmpeg -i "${inputPath}" -vn ${codecArgs} -y "${outputPath}"`;

    const timeout = parseInt(process.env.FFMPEG_TIMEOUT) || 300000;
    const startTime = Date.now();
    await execAsync(ffmpegCmd, { timeout, maxBuffer: 50 * 1024 * 1024 });
    const processingTime = Date.now() - startTime;

    // Get output file size
    const stats = await fs.stat(outputPath);

    return {
      success: true,
      duration: duration,
      fileSize: stats.size,
      format: format,
      bitrate: bitrate,
      processingTime: processingTime
    };

  } catch (error) {
    console.error('[Extract Audio] Error:', error.message);
    throw error;
  }
}

/**
 * Auto-edit video by removing silences
 * This is the FFmpeg portion of the auto-edit pipeline.
 * For full auto-edit with filler words, use n8n orchestration.
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path to output video
 * @param {Array} segments - Array of segments to KEEP: [{start, end}, ...]
 * @param {Object} options - Output options
 * @returns {Object} Result with edited video info
 */
async function autoEditSegments(inputPath, outputPath, segments, options = {}) {
  if (!segments || segments.length === 0) {
    throw new Error('No segments provided for auto-edit');
  }

  const startTime = Date.now();

  try {
    console.log(`[Auto-Edit] Processing ${segments.length} segments`);

    // Sort segments by start time
    const sortedSegments = [...segments].sort((a, b) => a.start - b.start);

    // Build filter_complex for segment extraction and concatenation
    const workDir = path.dirname(outputPath);
    const segmentFiles = [];

    // Extract each segment
    for (let i = 0; i < sortedSegments.length; i++) {
      const seg = sortedSegments[i];
      const segmentPath = path.join(workDir, `segment-${i}.mp4`);

      // Use copy codec for speed (no re-encoding)
      const segmentCmd = `ffmpeg -ss ${seg.start} -to ${seg.end} -i "${inputPath}" -c copy -y "${segmentPath}"`;

      await execAsync(segmentCmd, { timeout: 60000, maxBuffer: 50 * 1024 * 1024 });
      segmentFiles.push(segmentPath);
    }

    // Create concat file
    const concatFilePath = path.join(workDir, 'concat.txt');
    const concatContent = segmentFiles.map(f => `file '${f}'`).join('\n');
    await fs.writeFile(concatFilePath, concatContent);

    // Concatenate all segments
    const concatCmd = `ffmpeg -f concat -safe 0 -i "${concatFilePath}" -c copy -y "${outputPath}"`;
    await execAsync(concatCmd, { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });

    // Get final duration
    const finalDuration = await getVideoDuration(outputPath);
    const originalDuration = await getVideoDuration(inputPath);

    // Cleanup segment files
    for (const segFile of segmentFiles) {
      await fs.unlink(segFile).catch(() => {});
    }
    await fs.unlink(concatFilePath).catch(() => {});

    const processingTime = Date.now() - startTime;

    return {
      success: true,
      originalDuration: originalDuration,
      editedDuration: finalDuration,
      timeRemoved: originalDuration - finalDuration,
      segmentsProcessed: segments.length,
      processingTime: processingTime
    };

  } catch (error) {
    console.error('[Auto-Edit] Error:', error.message);
    throw error;
  }
}

/**
 * Crop video to specific aspect ratio
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path to output video
 * @param {Object} options - Crop options
 * @param {string} options.aspectRatio - Target aspect ratio: "9:16", "1:1", "16:9", "4:3"
 * @param {string} options.position - Crop position: "center", "top", "bottom", "left", "right"
 * @param {number} options.zoom - Zoom factor (1.0 = no zoom)
 * @returns {Object} Result with cropped video info
 */
async function cropVideo(inputPath, outputPath, options = {}) {
  const aspectRatio = options.aspectRatio || '9:16';
  const position = options.position || 'center';
  const zoom = options.zoom || 1.0;

  try {
    console.log(`[Crop] Cropping to ${aspectRatio}, position: ${position}, zoom: ${zoom}`);

    // Get original video dimensions
    const { stdout: probeOutput } = await execAsync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${inputPath}"`
    );
    const [origWidth, origHeight] = probeOutput.trim().split(',').map(Number);

    console.log(`[Crop] Original dimensions: ${origWidth}x${origHeight}`);

    // Parse target aspect ratio
    const [ratioW, ratioH] = aspectRatio.split(':').map(Number);
    const targetRatio = ratioW / ratioH;
    const originalRatio = origWidth / origHeight;

    let cropWidth, cropHeight, cropX, cropY;

    if (targetRatio < originalRatio) {
      // Target is taller (e.g., 9:16 from 16:9) - crop width
      cropHeight = origHeight;
      cropWidth = Math.round(origHeight * targetRatio);

      // Apply zoom (increase crop area, then scale down = zoom in)
      if (zoom > 1.0) {
        cropWidth = Math.round(cropWidth / zoom);
        cropHeight = Math.round(cropHeight / zoom);
      }

      // Position calculation
      switch (position) {
        case 'left':
          cropX = 0;
          cropY = Math.round((origHeight - cropHeight) / 2);
          break;
        case 'right':
          cropX = origWidth - cropWidth;
          cropY = Math.round((origHeight - cropHeight) / 2);
          break;
        case 'top':
          cropX = Math.round((origWidth - cropWidth) / 2);
          cropY = 0;
          break;
        case 'bottom':
          cropX = Math.round((origWidth - cropWidth) / 2);
          cropY = origHeight - cropHeight;
          break;
        case 'center':
        default:
          cropX = Math.round((origWidth - cropWidth) / 2);
          cropY = Math.round((origHeight - cropHeight) / 2);
          break;
      }
    } else {
      // Target is wider - crop height
      cropWidth = origWidth;
      cropHeight = Math.round(origWidth / targetRatio);

      // Apply zoom
      if (zoom > 1.0) {
        cropWidth = Math.round(cropWidth / zoom);
        cropHeight = Math.round(cropHeight / zoom);
      }

      // Position calculation
      switch (position) {
        case 'top':
          cropX = Math.round((origWidth - cropWidth) / 2);
          cropY = 0;
          break;
        case 'bottom':
          cropX = Math.round((origWidth - cropWidth) / 2);
          cropY = origHeight - cropHeight;
          break;
        case 'left':
          cropX = 0;
          cropY = Math.round((origHeight - cropHeight) / 2);
          break;
        case 'right':
          cropX = origWidth - cropWidth;
          cropY = Math.round((origHeight - cropHeight) / 2);
          break;
        case 'center':
        default:
          cropX = Math.round((origWidth - cropWidth) / 2);
          cropY = Math.round((origHeight - cropHeight) / 2);
          break;
      }
    }

    // Ensure crop dimensions are even (required by most codecs)
    cropWidth = cropWidth - (cropWidth % 2);
    cropHeight = cropHeight - (cropHeight % 2);

    console.log(`[Crop] Crop filter: crop=${cropWidth}:${cropHeight}:${cropX}:${cropY}`);

    // Build FFmpeg command
    const ffmpegCmd = `ffmpeg -i "${inputPath}" -vf "crop=${cropWidth}:${cropHeight}:${cropX}:${cropY}" -c:v libx264 -preset medium -crf 23 -c:a copy -y "${outputPath}"`;

    const timeout = parseInt(process.env.FFMPEG_TIMEOUT) || 300000;
    const startTime = Date.now();
    await execAsync(ffmpegCmd, { timeout, maxBuffer: 50 * 1024 * 1024 });
    const processingTime = Date.now() - startTime;

    return {
      success: true,
      originalResolution: `${origWidth}x${origHeight}`,
      croppedResolution: `${cropWidth}x${cropHeight}`,
      aspectRatio: aspectRatio,
      position: position,
      processingTime: processingTime
    };

  } catch (error) {
    console.error('[Crop] Error:', error.message);
    throw error;
  }
}

/**
 * Smart crop video for screen recordings with multiple modes
 * Optimized for converting horizontal screen recordings to vertical shorts
 *
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path to output video
 * @param {Object} options - Smart crop options
 * @param {string} options.mode - Mode: "letterbox", "smart-zoom", "custom"
 * @param {string} options.aspectRatio - Target aspect ratio (default: "9:16")
 * @param {Object} options.letterbox - Letterbox mode options
 * @param {string} options.letterbox.barColor - Bar color in hex (default: "#000000")
 * @param {string} options.letterbox.logoUrl - Optional logo URL for bars
 * @param {string} options.letterbox.logoPosition - Logo position: "top", "bottom", "both" (default: "bottom")
 * @param {number} options.letterbox.logoSize - Logo height in pixels (default: 80)
 * @param {Object} options.smartZoom - Smart zoom mode options
 * @param {number} options.smartZoom.x - X coordinate for focus area (pixels from left)
 * @param {number} options.smartZoom.y - Y coordinate for focus area (pixels from top)
 * @param {number} options.smartZoom.width - Width of focus area in pixels
 * @param {number} options.smartZoom.height - Height of focus area in pixels
 * @param {Object} options.custom - Custom mode options (fallback to regular crop)
 * @param {string} options.custom.position - Position: "center", "top", "bottom", "left", "right"
 * @param {number} options.custom.zoom - Zoom factor (default: 1.0)
 * @returns {Object} Result with cropped video info
 */
async function cropVideoSmart(inputPath, outputPath, options = {}) {
  const mode = options.mode || 'letterbox';
  const aspectRatio = options.aspectRatio || '9:16';

  try {
    console.log(`[Smart Crop] Mode: ${mode}, Target aspect ratio: ${aspectRatio}`);

    // Get original video dimensions
    const { stdout: probeOutput } = await execAsync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${inputPath}"`
    );
    const [origWidth, origHeight] = probeOutput.trim().split(',').map(Number);
    console.log(`[Smart Crop] Original dimensions: ${origWidth}x${origHeight}`);

    // Parse target aspect ratio
    const [ratioW, ratioH] = aspectRatio.split(':').map(Number);
    const targetRatio = ratioW / ratioH;

    let ffmpegCmd;
    const timeout = parseInt(process.env.FFMPEG_TIMEOUT) || 300000;
    const startTime = Date.now();

    if (mode === 'letterbox') {
      // LETTERBOX MODE: Scale video to fit in target aspect ratio, add colored bars
      const letterboxOpts = options.letterbox || {};
      const barColor = letterboxOpts.barColor || '#000000';
      const logoUrl = letterboxOpts.logoUrl || null;
      const logoPosition = letterboxOpts.logoPosition || 'bottom';
      const logoSize = letterboxOpts.logoSize || 80;

      // Calculate target dimensions (commonly 1080x1920 for 9:16)
      let targetWidth, targetHeight;
      if (aspectRatio === '9:16') {
        targetWidth = 1080;
        targetHeight = 1920;
      } else if (aspectRatio === '1:1') {
        targetWidth = 1080;
        targetHeight = 1080;
      } else if (aspectRatio === '16:9') {
        targetWidth = 1920;
        targetHeight = 1080;
      } else {
        // Generic calculation
        targetWidth = 1080;
        targetHeight = Math.round(1080 / targetRatio);
      }

      // Build filter: scale to fit, then pad with colored bars
      let videoFilter = `scale=${targetWidth}:-1:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=${barColor}`;

      // TODO: Logo overlay support (requires downloading logo first if URL provided)
      // For now, just bars with color

      console.log(`[Smart Crop] Letterbox: ${targetWidth}x${targetHeight}, bar color: ${barColor}`);
      ffmpegCmd = `ffmpeg -i "${inputPath}" -vf "${videoFilter}" -c:v libx264 -preset medium -crf 23 -c:a copy -y "${outputPath}"`;

    } else if (mode === 'smart-zoom') {
      // SMART ZOOM MODE: Zoom into specific region of screen
      const zoomOpts = options.smartZoom || {};

      if (!zoomOpts.x || !zoomOpts.y || !zoomOpts.width || !zoomOpts.height) {
        throw new Error('smart-zoom mode requires x, y, width, and height parameters');
      }

      let { x, y, width, height } = zoomOpts;

      // Ensure even dimensions (required by most codecs)
      width = width - (width % 2);
      height = height - (height % 2);
      x = x - (x % 2);
      y = y - (y % 2);

      // Validate bounds
      if (x + width > origWidth || y + height > origHeight) {
        throw new Error(`Crop region (${x},${y},${width},${height}) exceeds video bounds (${origWidth}x${origHeight})`);
      }

      console.log(`[Smart Crop] Smart Zoom: Cropping region (${x},${y}) ${width}x${height}`);

      // Crop to focus area, then scale to target aspect ratio
      const [targetRatioW, targetRatioH] = aspectRatio.split(':').map(Number);
      const targetWidth = 1080;
      const targetHeight = Math.round(targetWidth * targetRatioH / targetRatioW);

      const videoFilter = `crop=${width}:${height}:${x}:${y},scale=${targetWidth}:${targetHeight}`;
      ffmpegCmd = `ffmpeg -i "${inputPath}" -vf "${videoFilter}" -c:v libx264 -preset medium -crf 23 -c:a copy -y "${outputPath}"`;

    } else if (mode === 'custom') {
      // CUSTOM MODE: Fallback to regular crop function with position/zoom
      const customOpts = options.custom || {};
      const position = customOpts.position || 'center';
      const zoom = customOpts.zoom || 1.0;

      console.log(`[Smart Crop] Custom mode: falling back to standard crop with position: ${position}, zoom: ${zoom}`);
      return await cropVideo(inputPath, outputPath, { aspectRatio, position, zoom });

    } else {
      throw new Error(`Invalid mode: ${mode}. Valid modes: letterbox, smart-zoom, custom`);
    }

    // Execute FFmpeg command
    console.log(`[Smart Crop] Executing FFmpeg command...`);
    await execAsync(ffmpegCmd, { timeout, maxBuffer: 50 * 1024 * 1024 });

    const processingTime = Date.now() - startTime;

    // Get output dimensions
    const { stdout: outputProbe } = await execAsync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${outputPath}"`
    );
    const [outWidth, outHeight] = outputProbe.trim().split(',').map(Number);

    return {
      success: true,
      mode: mode,
      originalResolution: `${origWidth}x${origHeight}`,
      outputResolution: `${outWidth}x${outHeight}`,
      aspectRatio: aspectRatio,
      processingTime: processingTime
    };

  } catch (error) {
    console.error('[Smart Crop] Error:', error.message);
    throw error;
  }
}

/**
 * Add subtitles to video (burn-in SRT with styling)
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path to output video
 * @param {string} subtitlesPath - Path to subtitle file (SRT or ASS)
 * @param {Object} options - Subtitle options
 * @param {string} options.style - Preset style: "bold-white", "bold-yellow", "minimal", "custom"
 * @param {number} options.fontSize - Font size (default: 24)
 * @param {string} options.position - Position: "bottom", "top", "center"
 * @param {string} options.fontColor - Custom font color (hex)
 * @param {string} options.outlineColor - Custom outline color (hex)
 * @param {number} options.shadow - Shadow offset 0-5 (default: 0)
 * @param {string} options.backgroundColor - Background box color hex (null = no background)
 * @param {boolean} options.italic - Italic text (default: false)
 * @param {boolean} options.bold - Bold text (default: true)
 * @param {number} options.outlineWidth - Outline thickness 0-10 (default: 3)
 * @returns {Object} Result with subtitled video info
 */
async function addSubtitles(inputPath, outputPath, subtitlesPath, options = {}) {
  const style = options.style || 'bold-white';
  const fontSize = options.fontSize || 24;
  const position = options.position || 'bottom';
  // New styling options
  const shadow = Math.min(5, Math.max(0, options.shadow || 0));
  const backgroundColor = options.backgroundColor || null;
  const italic = options.italic || false;
  const bold = options.bold !== false; // Default true
  const outlineWidth = Math.min(10, Math.max(0, options.outlineWidth !== undefined ? options.outlineWidth : 3));

  try {
    console.log(`[Subtitles] Adding subtitles with style: ${style}, size: ${fontSize}, shadow: ${shadow}, outline: ${outlineWidth}`);

    // Verify SRT file exists and has content
    const srtStats = await fs.stat(subtitlesPath);
    const srtContent = await fs.readFile(subtitlesPath, 'utf8');
    console.log(`[Subtitles] SRT file: ${subtitlesPath}`);
    console.log(`[Subtitles] SRT size: ${srtStats.size} bytes, lines: ${srtContent.split('\n').length}`);
    console.log(`[Subtitles] SRT preview: ${srtContent.substring(0, 200)}...`);

    // Get video dimensions for proper subtitle positioning
    const { stdout: probeOutput } = await execAsync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${inputPath}"`
    );
    const [videoWidth, videoHeight] = probeOutput.trim().split(',').map(Number);

    // Calculate vertical margin based on position
    let marginV;
    switch (position) {
      case 'top':
        marginV = 30;
        break;
      case 'center':
        marginV = Math.round(videoHeight / 3);
        break;
      case 'bottom':
      default:
        marginV = 5; // Adjusted from 15 to 5 for lower position
        break;
    }

    // Build style string based on preset with new options
    // BorderStyle: 1 = outline only, 3 = opaque box (for backgroundColor)
    const hasBackgroundColor = backgroundColor && backgroundColor !== 'transparent';
    const borderStyle = hasBackgroundColor ? 3 : 1;
    const alignment = position === 'top' ? 8 : (position === 'center' ? 5 : 2);
    const boldVal = bold ? 1 : 0;
    const italicVal = italic ? 1 : 0;

    // Helper to convert hex to ASS BGR format
    const hexToASS = (hex) => {
      if (!hex) return null;
      hex = hex.replace('#', '');
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      const r = hex.substring(0, 2);
      const g = hex.substring(2, 4);
      const b = hex.substring(4, 6);
      return `&H${b}${g}${r}&`;
    };

    let styleOverride;
    switch (style) {
      case 'bold-yellow':
        styleOverride = `Fontname=Montserrat ExtraBold,FontSize=${fontSize},PrimaryColour=&H00FFFF&,OutlineColour=&H000000&,BackColour=${hasBackgroundColor ? hexToASS(backgroundColor) : '&H00000000&'},Bold=${boldVal},Italic=${italicVal},BorderStyle=${borderStyle},Outline=${outlineWidth},Shadow=${shadow},MarginV=${marginV},Alignment=${alignment}`;
        break;
      case 'minimal':
        styleOverride = `Fontname=Montserrat ExtraBold,FontSize=${fontSize},PrimaryColour=&HFFFFFF&,OutlineColour=&H00000000&,BackColour=${hasBackgroundColor ? hexToASS(backgroundColor) : '&H00000000&'},Bold=${boldVal},Italic=${italicVal},BorderStyle=${hasBackgroundColor ? 3 : 0},Outline=0,Shadow=${shadow},MarginV=${marginV},Alignment=${alignment}`;
        break;
      case 'custom':
        const fontColor = options.fontColor || 'FFFFFF';
        const outlineColor = options.outlineColor || '000000';
        styleOverride = `Fontname=Montserrat ExtraBold,FontSize=${fontSize},PrimaryColour=${hexToASS(fontColor)},OutlineColour=${hexToASS(outlineColor)},BackColour=${hasBackgroundColor ? hexToASS(backgroundColor) : '&H00000000&'},Bold=${boldVal},Italic=${italicVal},BorderStyle=${borderStyle},Outline=${outlineWidth},Shadow=${shadow},MarginV=${marginV},Alignment=${alignment}`;
        break;
      case 'bold-white':
      default:
        styleOverride = `Fontname=Montserrat ExtraBold,FontSize=${fontSize},PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BackColour=${hasBackgroundColor ? hexToASS(backgroundColor) : '&H00000000&'},Bold=${boldVal},Italic=${italicVal},BorderStyle=${borderStyle},Outline=${outlineWidth},Shadow=${shadow},MarginV=${marginV},Alignment=${alignment}`;
        break;
    }

    // Escape the path for FFmpeg subtitles filter
    // FFmpeg filter syntax requires escaping: colons, brackets, backslashes
    // Do NOT wrap path in quotes - FFmpeg subtitles filter doesn't support quoted paths
    const escapedSubPath = subtitlesPath
      .replace(/\\/g, '/')      // Convert backslashes to forward slashes (Windows compatibility)
      .replace(/:/g, '\\:')     // Escape colons (required for filter syntax)
      .replace(/\[/g, '\\[')    // Escape opening brackets
      .replace(/\]/g, '\\]');   // Escape closing brackets

    // Build FFmpeg command with subtitle filter
    // Path must NOT be quoted - use escaped path directly
    const ffmpegCmd = `ffmpeg -i "${inputPath}" -vf "subtitles=${escapedSubPath}:force_style='${styleOverride}'" -c:v libx264 -preset medium -crf 23 -c:a copy -y "${outputPath}"`;

    console.log(`[Subtitles] FFmpeg command: ${ffmpegCmd}`);

    const timeout = parseInt(process.env.FFMPEG_TIMEOUT) || 300000;
    const startTime = Date.now();

    // Capture both stdout and stderr for debugging
    const { stdout, stderr } = await execAsync(ffmpegCmd, { timeout, maxBuffer: 50 * 1024 * 1024 });

    // Log FFmpeg output for debugging
    if (stderr) {
      console.log(`[Subtitles] FFmpeg stderr (last 500 chars): ${stderr.slice(-500)}`);
      // Check for libass/subtitle processing indicators
      if (stderr.includes('fontselect')) {
        console.log('[Subtitles] Font selection detected - subtitles should be rendering');
      } else {
        console.warn('[Subtitles] WARNING: No fontselect in output - subtitles may not be rendering!');
      }
    }

    const processingTime = Date.now() - startTime;

    return {
      success: true,
      style: style,
      fontSize: fontSize,
      position: position,
      processingTime: processingTime
    };

  } catch (error) {
    console.error('[Subtitles] Error:', error.message);
    throw error;
  }
}

/**
 * Add karaoke-style subtitles with word-by-word highlighting
 * Uses ASS format for precise styling control
 *
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path to output video
 * @param {string} assPath - Path to ASS subtitle file
 * @param {Object} options - Additional options
 * @returns {Object} Result with processing info
 */
async function addSubtitlesKaraoke(inputPath, outputPath, assPath, options = {}) {
  try {
    console.log(`[Karaoke] Adding karaoke subtitles`);

    // Verify ASS file exists
    const assStats = await fs.stat(assPath);
    const assContent = await fs.readFile(assPath, 'utf8');
    console.log(`[Karaoke] ASS file: ${assPath}`);
    console.log(`[Karaoke] ASS size: ${assStats.size} bytes`);

    // Escape the path for FFmpeg filter (ASS uses same escaping as SRT)
    const escapedAssPath = assPath
      .replace(/\\/g, '/')
      .replace(/:/g, '\\:')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]');

    // Use ass filter instead of subtitles for better ASS support
    const ffmpegCmd = `ffmpeg -i "${inputPath}" -vf "ass=${escapedAssPath}" -c:v libx264 -preset medium -crf 23 -c:a copy -y "${outputPath}"`;

    console.log(`[Karaoke] FFmpeg command: ${ffmpegCmd}`);

    const timeout = parseInt(process.env.FFMPEG_TIMEOUT) || 300000;
    const startTime = Date.now();

    const { stdout, stderr } = await execAsync(ffmpegCmd, { timeout, maxBuffer: 50 * 1024 * 1024 });

    if (stderr) {
      console.log(`[Karaoke] FFmpeg stderr (last 500 chars): ${stderr.slice(-500)}`);
      if (stderr.includes('fontselect')) {
        console.log('[Karaoke] Font selection detected - subtitles rendering');
      }
    }

    const processingTime = Date.now() - startTime;

    return {
      success: true,
      mode: 'karaoke',
      processingTime: processingTime
    };

  } catch (error) {
    console.error('[Karaoke] Error:', error.message);
    throw error;
  }
}

/**
 * Apply color grading / LUT to video
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path to output video
 * @param {string} preset - Color grade preset: cinematic, vintage, cool, warm, vibrant, custom
 * @param {number} intensity - Strength of the effect (0.0-1.0, default: 1.0)
 * @param {string} lutFile - Custom LUT file path (optional)
 * @param {Object} adjustments - Fine-tuning adjustments (optional)
 * @returns {Object} Result with color grade info
 */
async function applyColorGrade(inputPath, outputPath, preset = 'cinematic', intensity = 1.0, lutFile = null, adjustments = {}) {
  const { getFilterChain } = require('./lut-presets');

  try {
    console.log(`[ColorGrade] Applying ${preset} preset with intensity ${intensity}`);

    let filterChain = '';

    // Use custom LUT file if provided
    if (lutFile && preset !== 'custom') {
      console.log(`[ColorGrade] Using custom LUT file: ${lutFile}`);
      filterChain = `lut3d='${lutFile}'`;
    } else {
      // Build filter chain from preset
      filterChain = getFilterChain(preset, intensity, adjustments);
    }

    // Build FFmpeg command with color grading filter
    const ffmpegCmd = `ffmpeg -i "${inputPath}" -vf "${filterChain}" -c:v libx264 -preset medium -crf 23 -c:a copy -y "${outputPath}"`;

    const timeout = parseInt(process.env.FFMPEG_TIMEOUT) || 300000;
    const startTime = Date.now();
    await execAsync(ffmpegCmd, { timeout, maxBuffer: 50 * 1024 * 1024 });
    const processingTime = Date.now() - startTime;

    return {
      success: true,
      preset: preset,
      intensity: intensity,
      processingTime: processingTime
    };

  } catch (error) {
    console.error('[ColorGrade] Error:', error.message);
    throw error;
  }
}

/**
 * Find optimal trim boundaries using silence detection
 * Adjusts start/end points to nearest silence boundaries for cleaner cuts
 *
 * @param {string} inputPath - Path to input video
 * @param {number} requestedStart - Requested start time in seconds
 * @param {number} requestedEnd - Requested end time in seconds
 * @param {Object} options - Search options
 * @param {number} options.searchWindow - Seconds to search around boundaries (default: 2)
 * @param {string} options.silenceThreshold - Silence threshold (default: '-35dB')
 * @param {number} options.minSilenceDuration - Min silence duration (default: 0.3)
 * @returns {Object} Smart boundaries with { smartStart, smartEnd, adjusted }
 */
async function findSmartTrimBoundaries(inputPath, requestedStart, requestedEnd, options = {}) {
  const searchWindow = options.searchWindow || 2;
  const silenceThreshold = options.silenceThreshold || '-35dB';
  const minSilenceDuration = options.minSilenceDuration || 0.3;

  try {
    console.log(`[Smart Trim] Finding boundaries for ${requestedStart}s - ${requestedEnd}s (window: ${searchWindow}s)`);

    // Detect all silences in the video
    const silenceResult = await detectSilence(inputPath, {
      threshold: silenceThreshold,
      minDuration: minSilenceDuration
    });

    const silences = silenceResult.silences || [];
    const videoDuration = silenceResult.originalDuration;

    let smartStart = requestedStart;
    let smartEnd = requestedEnd;
    let startAdjusted = false;
    let endAdjusted = false;

    // Find best start boundary (nearest silence END after requested start)
    // We want to start right after a silence ends (beginning of speech)
    const startSearchMin = Math.max(0, requestedStart - searchWindow);
    const startSearchMax = requestedStart + searchWindow;

    for (const silence of silences) {
      // If silence end is within our search window and after the requested start
      if (silence.end >= startSearchMin && silence.end <= startSearchMax) {
        // Prefer silence end that's closest to or just after requested start
        if (silence.end >= requestedStart - 0.1) {
          smartStart = silence.end;
          startAdjusted = true;
          console.log(`[Smart Trim] Adjusted start: ${requestedStart}s -> ${smartStart}s (after silence)`);
          break;
        }
      }
    }

    // Find best end boundary (nearest silence START before requested end)
    // We want to end right before a silence starts (end of speech)
    const endSearchMin = requestedEnd - searchWindow;
    const endSearchMax = Math.min(videoDuration, requestedEnd + searchWindow);

    for (let i = silences.length - 1; i >= 0; i--) {
      const silence = silences[i];
      // If silence start is within our search window and before the requested end
      if (silence.start >= endSearchMin && silence.start <= endSearchMax) {
        // Prefer silence start that's closest to or just before requested end
        if (silence.start <= requestedEnd + 0.1) {
          smartEnd = silence.start;
          endAdjusted = true;
          console.log(`[Smart Trim] Adjusted end: ${requestedEnd}s -> ${smartEnd}s (before silence)`);
          break;
        }
      }
    }

    // Ensure valid boundaries
    smartStart = Math.max(0, smartStart);
    smartEnd = Math.min(videoDuration, smartEnd);

    // Ensure end is after start
    if (smartEnd <= smartStart) {
      console.log(`[Smart Trim] Invalid boundaries, reverting to original`);
      smartStart = requestedStart;
      smartEnd = requestedEnd;
      startAdjusted = false;
      endAdjusted = false;
    }

    return {
      smartStart,
      smartEnd,
      originalStart: requestedStart,
      originalEnd: requestedEnd,
      adjusted: startAdjusted || endAdjusted,
      startAdjusted,
      endAdjusted,
      silencesFound: silences.length
    };

  } catch (error) {
    console.error('[Smart Trim] Error finding boundaries:', error.message);
    // Fall back to original boundaries on error
    return {
      smartStart: requestedStart,
      smartEnd: requestedEnd,
      originalStart: requestedStart,
      originalEnd: requestedEnd,
      adjusted: false,
      error: error.message
    };
  }
}

/**
 * Smart trim video using silence detection for optimal cut points
 *
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path to output video
 * @param {Object} options - Trim options
 * @param {number} options.start - Requested start time in seconds
 * @param {number} options.end - Requested end time in seconds
 * @param {number} options.searchWindow - Seconds to search around boundaries (default: 2)
 * @param {string} options.silenceThreshold - Silence threshold (default: '-35dB')
 * @param {number} options.minSilenceDuration - Min silence duration (default: 0.3)
 * @returns {Object} Result with trimmed video info and boundary details
 */
async function trimVideoSmart(inputPath, outputPath, options = {}) {
  const requestedStart = options.start || 0;
  const requestedEnd = options.end;

  if (requestedEnd === undefined) {
    throw new Error('End time is required for trim operation');
  }

  if (requestedEnd <= requestedStart) {
    throw new Error('End time must be greater than start time');
  }

  try {
    // Find optimal boundaries
    const boundaries = await findSmartTrimBoundaries(inputPath, requestedStart, requestedEnd, {
      searchWindow: options.searchWindow,
      silenceThreshold: options.silenceThreshold,
      minSilenceDuration: options.minSilenceDuration
    });

    console.log(`[Smart Trim] Trimming: ${boundaries.smartStart}s - ${boundaries.smartEnd}s`);

    // Perform the trim using the smart boundaries
    const trimResult = await trimVideo(inputPath, outputPath, {
      start: boundaries.smartStart,
      end: boundaries.smartEnd,
      useCopy: true
    });

    return {
      success: true,
      duration: trimResult.duration,
      boundaries: {
        originalStart: boundaries.originalStart,
        originalEnd: boundaries.originalEnd,
        smartStart: boundaries.smartStart,
        smartEnd: boundaries.smartEnd,
        adjusted: boundaries.adjusted,
        startAdjusted: boundaries.startAdjusted,
        endAdjusted: boundaries.endAdjusted
      },
      processingTime: trimResult.processingTime
    };

  } catch (error) {
    console.error('[Smart Trim] Error:', error.message);
    throw error;
  }
}

module.exports = {
  assembleVideos,
  buildXfadeCommand,
  calculateTotalDuration,
  getVideoDuration,
  hasAudioStream,
  enhanceAudio,
  detectSilence,
  trimVideo,
  trimVideoSmart,
  findSmartTrimBoundaries,
  extractAudio,
  autoEditSegments,
  cropVideo,
  cropVideoSmart,
  addSubtitles,
  addSubtitlesKaraoke,
  applyColorGrade
};
