const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client lazily
let supabaseClient = null;

function getSupabaseClient() {
  if (!supabaseClient) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required for storage operations');
    }

    supabaseClient = createClient(supabaseUrl, supabaseKey);
  }
  return supabaseClient;
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
 * Upload a video file to Supabase Storage
 * @param {string} localPath - Local path of the file to upload
 * @param {string} fileName - Desired file name in storage
 * @returns {string} Public URL of the uploaded file
 */
async function uploadVideo(localPath, fileName) {
  const bucket = process.env.SUPABASE_BUCKET || 'final-reels';
  const supabase = getSupabaseClient();

  try {
    // Read file
    const fileBuffer = await fsPromises.readFile(localPath);
    const fileSize = fileBuffer.length;

    console.log(`[Storage] Uploading ${fileName} (${Math.round(fileSize / 1024 / 1024 * 100) / 100}MB)`);

    // Upload to Supabase Storage
    const storagePath = `assembled/${fileName}`;

    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(storagePath, fileBuffer, {
        contentType: 'video/mp4',
        upsert: true // Overwrite if exists
      });

    if (error) {
      throw new Error(`Supabase upload error: ${error.message}`);
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(bucket)
      .getPublicUrl(storagePath);

    if (!urlData?.publicUrl) {
      throw new Error('Failed to get public URL for uploaded video');
    }

    console.log(`[Storage] Upload complete: ${urlData.publicUrl}`);

    return urlData.publicUrl;

  } catch (error) {
    console.error(`[Storage] Upload failed:`, error.message);
    throw new Error(`Failed to upload video: ${error.message}`);
  }
}

/**
 * Delete a file from Supabase Storage
 * @param {string} storagePath - Path of the file in storage
 */
async function deleteVideo(storagePath) {
  const bucket = process.env.SUPABASE_BUCKET || 'final-reels';
  const supabase = getSupabaseClient();

  try {
    const { error } = await supabase.storage
      .from(bucket)
      .remove([storagePath]);

    if (error) {
      console.warn(`[Storage] Failed to delete ${storagePath}: ${error.message}`);
    }
  } catch (error) {
    console.warn(`[Storage] Delete error:`, error.message);
  }
}

module.exports = {
  downloadVideo,
  uploadVideo,
  deleteVideo
};
