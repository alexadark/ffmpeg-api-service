const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const { downloadVideo, uploadVideo } = require('./storage');

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

    for (let i = 0; i < videos.length; i++) {
      const localPath = path.join(workDir, `input-${i}.mp4`);
      console.log(`[FFmpeg] Downloading video ${i + 1}/${videos.length}: ${videos[i].url.substring(0, 80)}...`);

      await downloadVideo(videos[i].url, localPath);

      // Get actual video duration using ffprobe
      let duration = videos[i].duration;
      if (!duration) {
        duration = await getVideoDuration(localPath);
      }

      localFiles.push({
        path: localPath,
        duration: duration || 8 // Default to 8 seconds if unknown
      });

      console.log(`[FFmpeg] Video ${i + 1} downloaded, duration: ${duration}s`);
    }

    // Parse resolution
    const resolution = output.resolution || '1920x1080';
    const [width, height] = resolution.split('x').map(Number);

    // Build FFmpeg command with xfade transitions
    const outputPath = path.join(workDir, `output.${output.format || 'mp4'}`);
    const ffmpegCmd = buildXfadeCommand(localFiles, outputPath, transition.duration, width, height);

    console.log(`[FFmpeg] Executing command...`);
    console.log(`[FFmpeg] Command: ${ffmpegCmd.substring(0, 200)}...`);

    // Execute FFmpeg with timeout
    const timeout = parseInt(process.env.FFMPEG_TIMEOUT) || 300000; // 5 minutes default
    await execAsync(ffmpegCmd, { timeout, maxBuffer: 50 * 1024 * 1024 });

    console.log(`[FFmpeg] Command completed, uploading result...`);

    // Upload result to storage
    const resultUrl = await uploadVideo(outputPath, `assembled-${Date.now()}.mp4`);

    // Calculate total duration
    const totalDuration = calculateTotalDuration(localFiles, transition.duration);

    // Cleanup work directory
    console.log(`[FFmpeg] Cleaning up ${workDir}`);
    await fs.rm(workDir, { recursive: true, force: true });

    return {
      url: resultUrl,
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
 * Build FFmpeg command for multiple videos with xfade transitions
 * @param {Array} files - Array of file objects with path and duration
 * @param {string} outputPath - Output file path
 * @param {number} transitionDuration - Duration of crossfade in seconds
 * @param {number} width - Output width
 * @param {number} height - Output height
 * @returns {string} FFmpeg command string
 */
function buildXfadeCommand(files, outputPath, transitionDuration = 1, width = 1920, height = 1080) {
  if (files.length < 2) {
    throw new Error('At least 2 videos required for xfade');
  }

  // Build input arguments
  const inputs = files.map(f => `-i "${f.path}"`).join(' ');

  // Build scale and format filters for each input
  const scaleFilters = files.map((f, i) =>
    `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`
  ).join('; ');

  // Handle two videos case (simple)
  if (files.length === 2) {
    const offset = Math.max(0, files[0].duration - transitionDuration);
    const filterComplex = `${scaleFilters}; [v0][v1]xfade=transition=fade:duration=${transitionDuration}:offset=${offset}[vout]`;

    return `ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "[vout]" -c:v libx264 -preset medium -crf 23 -movflags +faststart -y "${outputPath}"`;
  }

  // Handle multiple videos (chained xfade)
  let filterComplex = scaleFilters;
  let runningDuration = 0;

  for (let i = 0; i < files.length - 1; i++) {
    const inputA = i === 0 ? '[v0]' : `[xf${i - 1}]`;
    const inputB = `[v${i + 1}]`;
    const outputLabel = i === files.length - 2 ? '[vout]' : `[xf${i}]`;

    // Calculate offset for this transition
    // Offset is the point in the combined output where the transition starts
    runningDuration += files[i].duration;
    const offset = Math.max(0, runningDuration - transitionDuration * (i + 1));

    filterComplex += `; ${inputA}${inputB}xfade=transition=fade:duration=${transitionDuration}:offset=${offset}${outputLabel}`;
  }

  return `ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "[vout]" -c:v libx264 -preset medium -crf 23 -movflags +faststart -y "${outputPath}"`;
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
  getVideoDuration
};
