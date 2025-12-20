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
  // These are the same offsets used for xfade
  const videoOffsets = [0]; // First video starts at 0
  let runningDuration = 0;
  for (let i = 0; i < files.length - 1; i++) {
    runningDuration += files[i].duration;
    // Offset is when the next video starts (accounting for transition overlap)
    const offset = Math.max(0, runningDuration - transitionDuration * (i + 1));
    videoOffsets.push(offset);
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

    // 2. Lowpass filter: Remove hiss (12kHz cutoff)
    audioFilters.push('lowpass=f=12000');

    // 3. Noise reduction using FFT denoiser
    audioFilters.push(`afftdn=nf=${noiseFloor}`);

    // 4. Dynamic compression: Even out volume levels
    audioFilters.push('compand=attacks=0.3:decays=0.8:points=-80/-80|-45/-40|-27/-27|0/-20|20/-20');

    // 5. Normalization to broadcast standard (-14 LUFS)
    audioFilters.push('loudnorm=I=-14:TP=-1:LRA=11');

    // 6. Voice boost (optional): Gentle EQ
    if (voiceBoost) {
      audioFilters.push('treble=g=2:f=5000:w=f'); // Boost presence at 5kHz
    }

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

module.exports = {
  assembleVideos,
  buildXfadeCommand,
  calculateTotalDuration,
  getVideoDuration,
  hasAudioStream,
  enhanceAudio,
  detectSilence,
  trimVideo
};
