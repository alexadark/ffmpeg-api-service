const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');

// Output directory for assembled videos (served via /api/download)
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/tmp/ffmpeg-outputs';

/**
 * Ensure output directory exists
 */
async function ensureOutputDir() {
  await fsPromises.mkdir(OUTPUT_DIR, { recursive: true });
  return OUTPUT_DIR;
}

/**
 * Download a video from URL to local file
 * @param {string} url - Video URL to download
 * @param {string} localPath - Local path to save the file
 */
async function downloadVideo(url, localPath) {
  const maxFileSizeMB = parseInt(process.env.MAX_FILE_SIZE_MB) || 500;
  const maxFileSize = maxFileSizeMB * 1024 * 1024;

  try {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      timeout: 120000, // 2 minutes timeout for download
      maxContentLength: maxFileSize,
      maxBodyLength: maxFileSize,
      headers: {
        'User-Agent': 'FFmpeg-API-Service/1.0'
      }
    });

    // Check content length if available
    const contentLength = parseInt(response.headers['content-length'], 10);
    if (contentLength && contentLength > maxFileSize) {
      throw new Error(`File too large: ${Math.round(contentLength / 1024 / 1024)}MB exceeds ${maxFileSizeMB}MB limit`);
    }

    // Create write stream
    const writer = fs.createWriteStream(localPath);

    return new Promise((resolve, reject) => {
      let downloadedBytes = 0;

      response.data.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (downloadedBytes > maxFileSize) {
          writer.destroy();
          reject(new Error(`Download exceeded ${maxFileSizeMB}MB limit`));
        }
      });

      response.data.pipe(writer);

      writer.on('finish', () => {
        resolve();
      });

      writer.on('error', (err) => {
        // Clean up partial file
        fs.unlink(localPath, () => {});
        reject(new Error(`Failed to write file: ${err.message}`));
      });

      response.data.on('error', (err) => {
        writer.destroy();
        reject(new Error(`Download stream error: ${err.message}`));
      });
    });

  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED') {
        throw new Error(`Download timeout for ${url}`);
      }
      if (error.response?.status === 404) {
        throw new Error(`Video not found: ${url}`);
      }
      if (error.response?.status === 403) {
        throw new Error(`Access denied to video: ${url}`);
      }
      throw new Error(`Failed to download video: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Save assembled video to output directory and return download info
 * @param {string} localPath - Local path of the assembled file
 * @param {string} fileName - Desired file name
 * @returns {Object} Object with filename and local path
 */
async function saveVideo(localPath, fileName) {
  await ensureOutputDir();

  const outputPath = path.join(OUTPUT_DIR, fileName);

  // Move file to output directory
  await fsPromises.copyFile(localPath, outputPath);

  const stats = await fsPromises.stat(outputPath);
  const fileSizeMB = Math.round(stats.size / 1024 / 1024 * 100) / 100;

  console.log(`[Storage] Saved ${fileName} (${fileSizeMB}MB) to ${outputPath}`);

  return {
    filename: fileName,
    path: outputPath,
    size: stats.size
  };
}

/**
 * Get file path for a given filename
 * @param {string} filename - The filename to look up
 * @returns {string|null} Full path or null if not found
 */
async function getFilePath(filename) {
  // Sanitize filename to prevent directory traversal
  const sanitized = path.basename(filename);
  const filePath = path.join(OUTPUT_DIR, sanitized);

  try {
    await fsPromises.access(filePath);
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Delete old files from output directory
 * @param {number} maxAgeMs - Maximum age in milliseconds (default: 2 hours)
 */
async function cleanupOldFiles(maxAgeMs = 2 * 60 * 60 * 1000) {
  try {
    await ensureOutputDir();
    const files = await fsPromises.readdir(OUTPUT_DIR);
    const now = Date.now();
    let deleted = 0;

    for (const file of files) {
      const filePath = path.join(OUTPUT_DIR, file);
      try {
        const stats = await fsPromises.stat(filePath);
        if (now - stats.mtimeMs > maxAgeMs) {
          await fsPromises.unlink(filePath);
          deleted++;
        }
      } catch (err) {
        console.warn(`[Storage] Could not check/delete ${file}:`, err.message);
      }
    }

    if (deleted > 0) {
      console.log(`[Storage] Cleaned up ${deleted} old files`);
    }
  } catch (error) {
    console.warn(`[Storage] Cleanup error:`, error.message);
  }
}

module.exports = {
  downloadVideo,
  saveVideo,
  getFilePath,
  cleanupOldFiles,
  OUTPUT_DIR
};
