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

  // Build audio normalization filters for each input (AUDIO) - only if audio is included
  const audioFilters = includeAudio
    ? files.map((f, i) =>
        `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=1.0[a${i}]`
      ).join('; ')
    : '';

  // Handle two videos case (simple)
  if (files.length === 2) {
    const offset = Math.max(0, files[0].duration - transitionDuration);

    // Video crossfade
    const videoXfade = `[v0][v1]xfade=transition=fade:duration=${transitionDuration}:offset=${offset}[vout]`;

    if (includeAudio) {
      // Audio crossfade using acrossfade
      // acrossfade automatically handles the transition between two audio streams
      const audioXfade = `[a0][a1]acrossfade=d=${transitionDuration}:c1=tri:c2=tri[aout]`;
      const filterComplex = `${scaleFilters}; ${audioFilters}; ${videoXfade}; ${audioXfade}`;
      return `ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 192k -movflags +faststart -y "${outputPath}"`;
    } else {
      // Video only
      const filterComplex = `${scaleFilters}; ${videoXfade}`;
      return `ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "[vout]" -c:v libx264 -preset medium -crf 23 -movflags +faststart -y "${outputPath}"`;
    }
  }

  // Handle multiple videos (chained xfade for both video and audio)
  let filterComplex = includeAudio ? scaleFilters + '; ' + audioFilters : scaleFilters;
  let runningDuration = 0;

  // Build video crossfade chain
  for (let i = 0; i < files.length - 1; i++) {
    const inputA = i === 0 ? '[v0]' : `[xf${i - 1}]`;
    const inputB = `[v${i + 1}]`;
    const outputLabel = i === files.length - 2 ? '[vout]' : `[xf${i}]`;

    // Calculate offset for this transition
    runningDuration += files[i].duration;
    const offset = Math.max(0, runningDuration - transitionDuration * (i + 1));

    filterComplex += `; ${inputA}${inputB}xfade=transition=fade:duration=${transitionDuration}:offset=${offset}${outputLabel}`;
  }

  if (includeAudio) {
    // Build audio crossfade chain
    // For audio, we chain acrossfade filters similarly to video xfade
    for (let i = 0; i < files.length - 1; i++) {
      const inputA = i === 0 ? '[a0]' : `[af${i - 1}]`;
      const inputB = `[a${i + 1}]`;
      const outputLabel = i === files.length - 2 ? '[aout]' : `[af${i}]`;

      filterComplex += `; ${inputA}${inputB}acrossfade=d=${transitionDuration}:c1=tri:c2=tri${outputLabel}`;
    }

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

module.exports = {
  assembleVideos,
  buildXfadeCommand,
  calculateTotalDuration,
  getVideoDuration,
  hasAudioStream
};
