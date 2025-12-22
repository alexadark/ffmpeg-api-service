/**
 * YouTube Download Module
 * Uses yt-dlp to download YouTube videos
 */

const youtubedl = require('youtube-dl-exec');
const path = require('path');
const fs = require('fs').promises;

// YouTube URL validation regex
const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}/;

/**
 * Validate YouTube URL
 * @param {string} url - URL to validate
 * @returns {boolean} True if valid YouTube URL
 */
function isValidYouTubeUrl(url) {
  return YOUTUBE_URL_REGEX.test(url);
}

/**
 * Get video metadata without downloading
 * @param {string} url - YouTube video URL
 * @returns {Object} Video metadata
 */
async function getVideoInfo(url) {
  if (!isValidYouTubeUrl(url)) {
    throw new Error('Invalid YouTube URL');
  }

  try {
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      skipDownload: true
    });

    return {
      id: info.id,
      title: info.title,
      description: info.description,
      duration: info.duration,
      thumbnail: info.thumbnail,
      channel: info.channel,
      channelId: info.channel_id,
      uploadDate: info.upload_date,
      viewCount: info.view_count,
      likeCount: info.like_count,
      formats: info.formats ? info.formats.map(f => ({
        formatId: f.format_id,
        ext: f.ext,
        resolution: f.resolution,
        fps: f.fps,
        vcodec: f.vcodec,
        acodec: f.acodec,
        filesize: f.filesize
      })).filter(f => f.resolution !== 'audio only').slice(0, 10) : []
    };
  } catch (error) {
    console.error('[YouTube] Error fetching video info:', error.message);
    throw new Error(`Failed to fetch video info: ${error.message}`);
  }
}

/**
 * Download YouTube video
 * @param {string} url - YouTube video URL
 * @param {string} outputDir - Directory to save the video
 * @param {Object} options - Download options
 * @param {string} options.format - Quality: 'best', '1080p', '720p', '480p', '360p', 'audio-only'
 * @param {boolean} options.audioOnly - Download audio only
 * @param {string} options.cookiesFile - Path to cookies file for age-restricted content
 * @param {string} options.cookies - Cookies content as string (Netscape format)
 * @returns {Object} Download result with file path and metadata
 */
async function downloadYouTube(url, outputDir, options = {}) {
  if (!isValidYouTubeUrl(url)) {
    throw new Error('Invalid YouTube URL');
  }

  const format = options.format || 'best';
  const audioOnly = options.audioOnly || false;
  let cookiesFile = options.cookiesFile || null;
  let tempCookiesFile = null;

  // If cookies string provided, write to temp file
  if (options.cookies && typeof options.cookies === 'string') {
    tempCookiesFile = path.join(outputDir, 'cookies.txt');
    await fs.writeFile(tempCookiesFile, options.cookies, 'utf8');
    cookiesFile = tempCookiesFile;
    console.log('[YouTube] Using provided cookies');
  }

  try {
    // Ensure output directory exists
    await fs.mkdir(outputDir, { recursive: true });

    // Build yt-dlp options
    const ytdlpOptions = {
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      output: path.join(outputDir, '%(id)s.%(ext)s'),
      // Merge formats for best quality video+audio
      mergeOutputFormat: 'mp4'
    };

    // Format selection based on options
    if (audioOnly) {
      ytdlpOptions.extractAudio = true;
      ytdlpOptions.audioFormat = 'mp3';
      ytdlpOptions.audioQuality = 0; // Best quality
      ytdlpOptions.output = path.join(outputDir, '%(id)s.mp3');
    } else {
      switch (format) {
        case '1080p':
          ytdlpOptions.format = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]';
          break;
        case '720p':
          ytdlpOptions.format = 'bestvideo[height<=720]+bestaudio/best[height<=720]';
          break;
        case '480p':
          ytdlpOptions.format = 'bestvideo[height<=480]+bestaudio/best[height<=480]';
          break;
        case '360p':
          ytdlpOptions.format = 'bestvideo[height<=360]+bestaudio/best[height<=360]';
          break;
        case 'best':
        default:
          ytdlpOptions.format = 'bestvideo+bestaudio/best';
          break;
      }
    }

    // Add cookies file if provided (for age-restricted content)
    if (cookiesFile) {
      ytdlpOptions.cookies = cookiesFile;
    }

    console.log(`[YouTube] Downloading: ${url}`);
    console.log(`[YouTube] Format: ${audioOnly ? 'audio-only' : format}`);

    // Get video info first to know the output filename
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      skipDownload: true
    });

    // Download the video
    await youtubedl(url, ytdlpOptions);

    // Determine output file path
    const ext = audioOnly ? 'mp3' : 'mp4';
    const outputFile = path.join(outputDir, `${info.id}.${ext}`);

    // Verify file exists
    try {
      await fs.access(outputFile);
    } catch {
      // Try to find the actual file (yt-dlp might use different extension)
      const files = await fs.readdir(outputDir);
      const downloadedFile = files.find(f => f.startsWith(info.id));
      if (downloadedFile) {
        return {
          success: true,
          filePath: path.join(outputDir, downloadedFile),
          filename: downloadedFile,
          metadata: {
            id: info.id,
            title: info.title,
            duration: info.duration,
            thumbnail: info.thumbnail,
            channel: info.channel
          }
        };
      }
      throw new Error('Downloaded file not found');
    }

    // Get file stats
    const stats = await fs.stat(outputFile);

    console.log(`[YouTube] Download complete: ${outputFile}`);

    return {
      success: true,
      filePath: outputFile,
      filename: `${info.id}.${ext}`,
      fileSize: stats.size,
      metadata: {
        id: info.id,
        title: info.title,
        duration: info.duration,
        thumbnail: info.thumbnail,
        channel: info.channel
      }
    };

  } catch (error) {
    console.error('[YouTube] Download error:', error.message);
    throw new Error(`YouTube download failed: ${error.message}`);
  }
}

module.exports = {
  downloadYouTube,
  getVideoInfo,
  isValidYouTubeUrl,
  YOUTUBE_URL_REGEX
};
