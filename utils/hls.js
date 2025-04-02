const path = require('path');
const fs = require('fs').promises;
const ffmpeg = require('fluent-ffmpeg');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;

// Explicitly set the ffprobe path for fluent-ffmpeg
ffmpeg.setFfprobePath(ffprobePath);

// Define paths relative to the project root (assuming utils is one level down)
const PROJECT_ROOT = path.join(__dirname, '..');
const PROCESSED_DIR_UTILS = path.join(PROJECT_ROOT, 'processed_videos');
const VIDEOS_DIR_UTILS = path.join(PROJECT_ROOT, 'videos');

// --- Default HLS Conversion Options ---
const defaultHlsOptions = {
    resolutions: [
/*         { name: '480p', size: '854x480', bitrate: '800k' },
 */        // Add more resolutions like 1080p if needed
        // { name: '1080p', size: '1920x1080', bitrate: '2800k' }
    ],
    hlsTime: 10, // Segment duration in seconds
    hlsPlaylistType: 'vod', // 'vod' or 'event'
    copyCodecsThresholdHeight: 720, // Max height to consider copying original codecs (adjust as needed)
    audioCodec: 'aac',
    audioBitrate: '128k',
    videoCodec: 'h264',
    videoProfile: 'main',
    crf: 20, // Constant Rate Factor (lower means better quality, larger file)
    gopSize: 48, // Group of Pictures size (keyframe interval)
    proxyBaseUrlTemplate: 'http://localhost:3000/stream-resource/{basePath}{videoId}/', // Template for master playlist URLs
    masterPlaylistName: 'master.m3u8',
    segmentNameTemplate: 'segment%03d.ts',
    resolutionPlaylistName: 'playlist.m3u8'
};


// --- Ensure Directories Exist ---
const ensureDirExists = async (dirPath) => {
    try {
        await fs.access(dirPath);
        // console.log(`Directory already exists: ${dirPath}`); // Less verbose
    } catch (error) {
        if (error.code === 'ENOENT') {
            try {
                await fs.mkdir(dirPath, { recursive: true });
                console.log(`Directory created: ${dirPath}`);
            } catch (mkdirError) {
                console.error(`Error creating directory ${dirPath}:`, mkdirError);
                throw mkdirError;
            }
        } else {
            console.error(`Error accessing directory ${dirPath}:`, error);
            throw error;
        }
    }
};


// --- Helper Function to Process a Single Resolution ---
const processResolution = (inputPath, outputDir, resolutionInfo, commonOptions, videoId) => {
    return new Promise(async (resolve, reject) => {
        const { name, size, bitrate, isOriginal } = resolutionInfo;
        const {
            hlsTime, hlsPlaylistType, copyCodecsThresholdHeight,
            audioCodec, audioBitrate, videoCodec, videoProfile, crf, gopSize,
            segmentNameTemplate, resolutionPlaylistName
        } = commonOptions;

        const resOutputDir = path.join(outputDir, name);
        const playlistPath = path.join(resOutputDir, resolutionPlaylistName);
        const segmentPath = path.join(resOutputDir, segmentNameTemplate);
        const bandwidth = parseInt(String(bitrate).replace('k', '')) * 1000 || 500000; // Default if bitrate is invalid

        await ensureDirExists(resOutputDir);

        let command = ffmpeg(inputPath);
        const outputOptions = [];

        // Determine if we should copy codecs or re-encode
        const shouldCopyCodecs = isOriginal && parseInt(name) <= copyCodecsThresholdHeight;

        if (shouldCopyCodecs) {
            console.log(`[${videoId}] Segmenting resolution ${name} by copying streams.`);
            outputOptions.push(
                '-c:v copy',
                '-c:a copy'
            );
        } else {
            console.log(`[${videoId}] Re-encoding to ${name}.`);
            outputOptions.push(
                `-vf scale=${size}`,
                `-c:a ${audioCodec}`, `-ar 48000`, `-b:a ${audioBitrate}`, // Audio options
                `-c:v ${videoCodec}`, `-profile:v ${videoProfile}`, `-crf ${crf}`, `-sc_threshold 0`, // Video options
                `-g ${gopSize}`, `-keyint_min ${gopSize}`, // Keyframe options
                `-b:v ${bitrate}`, // Target video bitrate
                `-maxrate ${Math.floor(bandwidth * 1.2 / 1000)}k`, // Max bitrate
                `-bufsize ${Math.floor(bandwidth * 1.5 / 1000)}k` // Buffer size
            );
        }

        // Common HLS options
        outputOptions.push(
            `-hls_time ${hlsTime}`,
            `-hls_playlist_type ${hlsPlaylistType}`,
            `-hls_segment_filename ${segmentPath}`
        );

        command
            .outputOptions(outputOptions)
            .output(playlistPath)
            .on('start', (commandLine) => console.log(`[${videoId}] Started processing ${name}: ${commandLine.substring(0, 200)}...`)) // Log shorter command
            .on('progress', (progress) => {
                // Only log progress occasionally to avoid spamming logs
                if (progress.percent && Math.round(progress.percent) % 10 === 0) {
                     console.log(`[${videoId}] Processing ${name}: ${progress.percent.toFixed(2)}% done`);
                }
            })
            .on('end', () => {
                console.log(`[${videoId}] Finished processing ${name}`);
                resolve({ name, size, bitrate, bandwidth, playlistRelativePath: `${name}/${resolutionPlaylistName}` });
            })
            .on('error', (err) => {
                console.error(`[${videoId}] Error processing ${name}:`, err.message);
                reject(new Error(`Error processing ${name}: ${err.message}`)); // Pass a more informative error
            })
            .run();
    });
};


// --- Main HLS Conversion Function ---
const convertToHls = (inputPath, { videoId, basePath = '' }, userOptions = {}) => {
    return new Promise(async (resolve, reject) => {
        // Merge user options with defaults (shallow merge is usually sufficient)
        const options = { ...defaultHlsOptions, ...userOptions };
        const outputDir = path.join(PROCESSED_DIR_UTILS, videoId);

        try {
            await ensureDirExists(outputDir);
        } catch (err) {
            return reject(new Error(`Failed to ensure output directory exists: ${err.message}`));
        }
        // --- Get Original Video Info ---
        let originalWidth, originalHeight, originalBitrateStr;
        try {
            const metadata = await new Promise((resolveMeta, rejectMeta) => {
                ffmpeg.ffprobe(inputPath, (err, data) => {
                    if (err) return rejectMeta(new Error(`ffprobe error: ${err.message}`)); // Wrap error
                    if (!data) return rejectMeta(new Error('ffprobe returned no data.'));
                    resolveMeta(data);
                });
            });

            const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
            if (!videoStream) throw new Error('No video stream found');
            originalWidth = videoStream.width;
            originalHeight = videoStream.height;
            // Estimate bitrate if not available, ensure it's a string like '5000k'
            originalBitrateStr = videoStream.bit_rate
                ? `${Math.round(videoStream.bit_rate / 1000)}k`
                : metadata.format?.bit_rate
                    ? `${Math.round(metadata.format.bit_rate / 1000)}k`
                    : '5000k'; // Fallback bitrate

            console.log(`[${videoId}] Original resolution: ${originalWidth}x${originalHeight}, Bitrate: ${originalBitrateStr}`);

            if (!originalWidth || !originalHeight) {
                throw new Error('Could not determine original video dimensions.');
            }
        } catch (err) {
            console.error(`[${videoId}] Error probing video metadata:`, err.message);
            return reject(new Error(`Failed to get video metadata: ${err.message}`));
        }

        // --- Prepare Target Resolutions ---
        let targetResolutions = [...options.resolutions]; // Clone default resolutions
        const originalResName = `${originalHeight}p`;
        const originalAlreadyDefined = targetResolutions.some(r => r.name === originalResName);

        // Add original resolution if it's not already defined and different from others
        if (!originalAlreadyDefined && originalWidth && originalHeight) {
             // Check if original resolution is significantly different from existing ones
            const isDifferent = !targetResolutions.some(r => r.size === `${originalWidth}x${originalHeight}`);
            if (isDifferent) {
                targetResolutions.push({
                    name: originalResName,
                    size: `${originalWidth}x${originalHeight}`,
                    bitrate: originalBitrateStr,
                    isOriginal: true // Mark as original for potential codec copying
                });
                // Sort resolutions by height (numeric part of the name)
                targetResolutions.sort((a, b) => parseInt(a.name) - parseInt(b.name));
            } else {
                 // If resolution exists, mark it as original if applicable
                 const existingRes = targetResolutions.find(r => r.size === `${originalWidth}x${originalHeight}`);
                 if (existingRes) existingRes.isOriginal = true;
            }
        }
         console.log(`[${videoId}] Target resolutions:`, targetResolutions.map(r => r.name));


        // --- Process Resolutions Concurrently ---
        const processingPromises = targetResolutions.map(resInfo =>
            processResolution(inputPath, outputDir, resInfo, options, videoId)
        );

        try {
            const results = await Promise.allSettled(processingPromises);

            // Filter out successful results and check for failures
            const successfulResults = [];
            const errors = [];
            results.forEach(result => {
                if (result.status === 'fulfilled') {
                    successfulResults.push(result.value);
                } else {
                    errors.push(result.reason);
                    console.error(`[${videoId}] A resolution processing task failed:`, result.reason.message || result.reason);
                }
            });

            if (errors.length > 0) {
                // Optionally, clean up partially created files here if needed
                throw new Error(`HLS conversion failed for ${errors.length} resolution(s).`);
            }

            if (successfulResults.length === 0) {
                 throw new Error(`HLS conversion resulted in no successful resolutions.`);
            }

            // --- Create Master Playlist ---
            const newbasePath = basePath ? basePath.endsWith('/') ? basePath : `${basePath}/` : '';
            const proxyBaseUrl = options.proxyBaseUrlTemplate.replace('{videoId}', videoId).replace('{basePath}',newbasePath);
            let masterPlaylistContent = '#EXTM3U\n#EXT-X-VERSION:3\n';

            // Sort successful results by bandwidth before adding to master playlist
            successfulResults.sort((a, b) => a.bandwidth - b.bandwidth);

            successfulResults.forEach(res => {
                const newrelativepath = `${proxyBaseUrl}${res.playlistRelativePath}\n`; // Use relative path from helper
                masterPlaylistContent += `#EXT-X-STREAM-INF:BANDWIDTH=${res.bandwidth},RESOLUTION=${res.size}\n`;
                masterPlaylistContent += newrelativepath;
                console.log("newrelativepath",newrelativepath)
            });

            const masterPlaylistPath = path.join(outputDir, options.masterPlaylistName);
            await fs.writeFile(masterPlaylistPath, masterPlaylistContent);
            console.log(`[${videoId}] Master playlist created successfully: ${masterPlaylistPath}`);

            // Resolve with the path to the master playlist or a relevant URL
            resolve({
                message: 'HLS conversion successful',
                outputDir: outputDir, // Directory containing all HLS files
                masterPlaylistPath: masterPlaylistPath, // Local path to master playlist
                masterPlaylistUrl: `${proxyBaseUrl}${options.masterPlaylistName}` // URL via proxy
            });

        } catch (error) {
            console.error(`[${videoId}] Error during HLS conversion process:`, error.message);
            // Attempt cleanup? Maybe remove outputDir if partially created?
            // await fs.rm(outputDir, { recursive: true, force: true }).catch(e => console.error(`Cleanup failed: ${e.message}`));
            reject(error); // Reject the main promise
        }
    });
};

module.exports = {
    ensureDirExists,
    convertToHls,
    // No longer exporting PROCESSED_DIR from here
    VIDEOS_DIR: VIDEOS_DIR_UTILS, // Export the correctly defined path
    VIDEOS_DIR_ROOT: VIDEOS_DIR_UTILS
};
/*
// Ejemplo de uso con opciones personalizadas
const customOptions = {
    resolutions: [
        { name: '360p', size: '640x360', bitrate: '500k' },
        { name: '1080p', size: '1920x1080', bitrate: '3000k' }
    ],
    hlsTime: 6,
    proxyBaseUrlTemplate: 'https://mycdn.com/stream/{videoId}/'
};
// En routes/b2.js, podrías llamar:
// await convertToHls(originalTempPath, videoId, customOptions);
// O simplemente:
// await convertToHls(originalTempPath, videoId); // para usar las opciones por defecto
*/