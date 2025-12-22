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
 * Convert JSON cookies array (browser export format) to Netscape format
 * @param {Array} cookies - Array of cookie objects from browser export
 * @returns {string} Cookies in Netscape format
 */
function convertCookiesToNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# This file was generated for yt-dlp', ''];

  for (const cookie of cookies) {
    // Netscape format: domain, hostOnly, path, secure, expiration, name, value
    const domain = cookie.domain.startsWith('.') ? cookie.domain : (cookie.hostOnly ? cookie.domain : '.' + cookie.domain);
    const hostOnly = cookie.hostOnly ? 'FALSE' : 'TRUE';
    const path = cookie.path || '/';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expiration = cookie.expirationDate ? Math.floor(cookie.expirationDate) : '0';
    const name = cookie.name;
    const value = cookie.value;

    lines.push(`${domain}\t${hostOnly}\t${path}\t${secure}\t${expiration}\t${name}\t${value}`);
  }

  return lines.join('\n');
}

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

  // If cookies provided, process them
  if (options.cookies) {
    tempCookiesFile = path.join(outputDir, 'cookies.txt');
    let cookiesData = options.cookies;

    console.log(`[YouTube] Received cookies type: ${typeof cookiesData}, isArray: ${Array.isArray(cookiesData)}`);

    // If cookies is a string, check if it's a URL first
    if (typeof cookiesData === 'string') {
      const trimmed = cookiesData.trim();

      // Check if it's a URL to a cookie file
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        console.log(`[YouTube] Downloading cookies from URL: ${trimmed}`);
        try {
          const axios = require('axios');
          const response = await axios.get(trimmed, { timeout: 30000 });
          await fs.writeFile(tempCookiesFile, response.data, 'utf8');
          cookiesFile = tempCookiesFile;
          console.log('[YouTube] Cookies downloaded from URL successfully');
        } catch (e) {
          throw new Error(`Failed to download cookies from URL: ${e.message}`);
        }
      } else if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        // Looks like JSON, try to parse it
        try {
          cookiesData = JSON.parse(trimmed);
          console.log('[YouTube] Parsed cookies from JSON string');
        } catch (e) {
          // Not valid JSON, treat as Netscape format
          console.log('[YouTube] Cookies string is not valid JSON, using as Netscape format');
          await fs.writeFile(tempCookiesFile, trimmed, 'utf8');
          cookiesFile = tempCookiesFile;
        }
      } else {
        // Raw Netscape format string
        console.log('[YouTube] Using cookies as raw Netscape format string');
        await fs.writeFile(tempCookiesFile, trimmed, 'utf8');
        cookiesFile = tempCookiesFile;
      }
    }

    // Handle single cookie object (wrap in array)
    if (cookiesData && typeof cookiesData === 'object' && !Array.isArray(cookiesData) && cookiesData.domain) {
      console.log('[YouTube] Single cookie object detected, wrapping in array');
      cookiesData = [cookiesData];
    }

    // Handle JSON array format (convert to Netscape)
    if (Array.isArray(cookiesData)) {
      console.log(`[YouTube] Converting ${cookiesData.length} cookies to Netscape format`);
      const cookieNames = cookiesData.map(c => c.name).join(', ');
      console.log(`[YouTube] Cookie names: ${cookieNames}`);
      const cookiesContent = convertCookiesToNetscape(cookiesData);
      console.log(`[YouTube] Netscape format preview (first 500 chars):\n${cookiesContent.substring(0, 500)}`);
      await fs.writeFile(tempCookiesFile, cookiesContent, 'utf8');
      cookiesFile = tempCookiesFile;
    }

    if (cookiesFile) {
      console.log(`[YouTube] Cookies file ready: ${cookiesFile}`);
    }
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
      mergeOutputFormat: 'mp4',
      // Anti-bot detection options - use mweb client for better format availability
      extractorArgs: 'youtube:player_client=mweb',
      userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    };

    // Format selection based on options
    // Use flexible format selection that works with android client
    if (audioOnly) {
      ytdlpOptions.extractAudio = true;
      ytdlpOptions.audioFormat = 'mp3';
      ytdlpOptions.audioQuality = 0; // Best quality
      ytdlpOptions.output = path.join(outputDir, '%(id)s.mp3');
      ytdlpOptions.format = 'bestaudio/best';
    } else {
      switch (format) {
        case '1080p':
          ytdlpOptions.format = 'bestvideo[height<=1080]+bestaudio/bestvideo+bestaudio/best';
          break;
        case '720p':
          ytdlpOptions.format = 'bestvideo[height<=720]+bestaudio/bestvideo+bestaudio/best';
          break;
        case '480p':
          ytdlpOptions.format = 'bestvideo[height<=480]+bestaudio/bestvideo+bestaudio/best';
          break;
        case '360p':
          ytdlpOptions.format = 'bestvideo[height<=360]+bestaudio/bestvideo+bestaudio/best';
          break;
        case 'best':
        default:
          // Flexible format: try best combo, fallback to any best available
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
    const infoOptions = {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      skipDownload: true,
      // Anti-bot detection options - use mweb client for better format availability
      extractorArgs: 'youtube:player_client=mweb',
      userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
    };

    // Add cookies to info request as well (for age-restricted content)
    if (cookiesFile) {
      infoOptions.cookies = cookiesFile;
    }

    const info = await youtubedl(url, infoOptions);

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
