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

// --- HLS Conversion Function ---
const convertToHls = (inputPath, videoId) => {
    return new Promise(async (resolve, reject) => {
        // Use the correctly defined path relative to project root
        const outputDir = path.join(PROCESSED_DIR_UTILS, videoId);
        await ensureDirExists(outputDir);

        // --- Get Original Video Info ---
        let originalWidth, originalHeight, originalBitrate;
        try {
            const metadata = await new Promise((resolveMeta, rejectMeta) => {
                ffmpeg.ffprobe(inputPath, (err, data) => {
                    if (err) return rejectMeta(err);
                    resolveMeta(data);
                });
            });
            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            if (!videoStream) throw new Error('No video stream found in the input file.');
            originalWidth = videoStream.width;
            originalHeight = videoStream.height;
            originalBitrate = videoStream.bit_rate || metadata.format.bit_rate || '5000k'; // Default if unknown
            console.log(`[${videoId}] Original resolution: ${originalWidth}x${originalHeight}, Bitrate: ${originalBitrate}`);

            if (!originalWidth || !originalHeight) {
                throw new Error('Could not determine original video dimensions.');
            }

        } catch (err) {
            console.error(`[${videoId}] Error probing video metadata:`, err);
            return reject(new Error(`Failed to get video metadata: ${err.message}`));
        }

        // --- Define Resolutions (including original if valid) ---
        const targetResolutions = [
            { name: '480p', size: '854x480', bitrate: '800k' },
            { name: '720p', size: '1280x720', bitrate: '1500k' }
        ];

        const originalResName = `${originalHeight}p`;
        if (originalHeight !== 480 && originalHeight !== 720 && originalWidth && originalHeight) { // Ensure dimensions are valid
             targetResolutions.push({
                 name: originalResName,
                 size: `${originalWidth}x${originalHeight}`,
                 bitrate: originalBitrate,
                 isOriginal: true
             });
             targetResolutions.sort((a, b) => parseInt(a.name) - parseInt(b.name));
        }

        let masterPlaylistContent = '#EXTM3U\n#EXT-X-VERSION:3\n';
        const processingPromises = [];

        // --- Process Each Resolution ---
        targetResolutions.forEach(res => {
            const resOutputDir = path.join(outputDir, res.name);
            const playlistPath = path.join(resOutputDir, 'playlist.m3u8');
            const bandwidth = parseInt(String(res.bitrate).replace('k', '')) * 1000 || 500000; // Default bandwidth if parse fails
            masterPlaylistContent += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${res.size}\n${res.name}/playlist.m3u8\n`;

            const promise = new Promise(async (resResolve, resReject) => {
                await ensureDirExists(resOutputDir);

                let command = ffmpeg(inputPath); // Start building the command

                if (res.isOriginal) {
                    // --- Options for Copying Original Stream ---
                    console.log(`[${videoId}] Segmenting original resolution (${res.name}) by copying streams.`);
                    command = command.outputOptions([
                        '-c:v copy', // Copy video stream
                        '-c:a copy', // Copy audio stream
                        '-hls_time 10',
                        '-hls_playlist_type vod',
                        `-hls_segment_filename ${path.join(resOutputDir, 'segment%03d.ts')}`
                    ]);
                } else {
                    // --- Options for Re-encoding Other Resolutions ---
                    console.log(`[${videoId}] Re-encoding to ${res.name}.`);
                    command = command.outputOptions([
                        `-vf scale=${res.size}`, // Scale video
                        `-c:a aac`, `-ar 48000`, `-b:a 128k`,
                        `-c:v h264`, `-profile:v main`, `-crf 20`, `-sc_threshold 0`,
                        `-g 48`, `-keyint_min 48`,
                        `-hls_time 10`, `-hls_playlist_type vod`,
                        `-b:v ${res.bitrate}`,
                        `-maxrate ${Math.floor(bandwidth * 1.2 / 1000)}k`,
                        `-bufsize ${Math.floor(bandwidth * 1.5 / 1000)}k`,
                        `-hls_segment_filename ${path.join(resOutputDir, 'segment%03d.ts')}`
                    ]);
                }

                // --- Common Output Settings and Event Handlers ---
                command
                    .output(playlistPath)
                    .on('start', (commandLine) => console.log(`[${videoId}] Started processing ${res.name}: ${commandLine}`))
                    .on('progress', (progress) => {
                        const percent = progress.percent === undefined ? 0 : progress.percent;
                        console.log(`[${videoId}] Processing ${res.name}: ${percent.toFixed(2)}% done`);
                    })
                    .on('end', () => {
                        console.log(`[${videoId}] Finished processing ${res.name}`);
                        resResolve();
                    })
                    .on('error', (err) => {
                        console.error(`[${videoId}] Error processing ${res.name}:`, err);
                        resReject(err);
                    })
                    .run();
            });
            processingPromises.push(promise);
        });

        // --- Wait for all resolutions to finish ---
        try {
            // Wait for all individual resolution processing promises to settle
            const results = await Promise.allSettled(processingPromises);

            // Check if any of the promises were rejected (i.e., an error occurred)
            const errors = results.filter(result => result.status === 'rejected');

            if (errors.length > 0) {
                // Log specific errors from failed promises
                errors.forEach(errorResult => {
                    console.error(`[${videoId}] A resolution processing step failed:`, errorResult.reason);
                });
                // Reject the main promise, indicating overall failure
                throw new Error(`HLS conversion failed for one or more resolutions. Master playlist not created.`);
            }

            // --- All resolutions processed successfully, now create Master Playlist ---
            console.log(`[${videoId}] All resolution processing successful. Creating master playlist...`);
            const masterPlaylistPath = path.join(outputDir, 'master.m3u8');
            // Ensure content ends with a newline for robustness
            const finalMasterPlaylistContent = masterPlaylistContent.endsWith('\n') ? masterPlaylistContent : masterPlaylistContent + '\n';
            await fs.writeFile(masterPlaylistPath, finalMasterPlaylistContent);
            console.log(`[${videoId}] Master playlist created successfully: ${masterPlaylistPath}`);

            // Resolve the main promise with success details
            resolve({
                message: 'HLS conversion successful',
                masterPlaylistUrl: `/processed/${videoId}/master.m3u8` // Relative URL for client
            });
        } catch (error) {
            console.error(`[${videoId}] Error during HLS conversion:`, error);
            reject(error);
        }
    });
};

module.exports = {
    ensureDirExists,
    convertToHls,
    // No longer exporting PROCESSED_DIR from here
    VIDEOS_DIR: VIDEOS_DIR_UTILS // Export the correctly defined path
};
