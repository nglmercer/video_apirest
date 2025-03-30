const path = require('path');
const fs = require('fs').promises;
const ffmpeg = require('fluent-ffmpeg');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;

// Explicitly set the ffprobe path for fluent-ffmpeg
ffmpeg.setFfprobePath(ffprobePath);

// Define paths relative to the project root (assuming utils is one level down)
const PROJECT_ROOT = path.join(__dirname, '..'); // Adjust if your script isn't in a 'utils' subdir
const PROCESSED_DIR_UTILS = path.join(PROJECT_ROOT, 'processed_videos');
const VIDEOS_DIR_UTILS = path.join(PROJECT_ROOT, 'videos'); // Assuming you might need this elsewhere


// --- Ensure Directories Exist ---
const ensureDirExists = async (dirPath) => {
    try {
        // Use stat instead of access for better compatibility and info
        await fs.stat(dirPath);
        // console.log(`Directory already exists: ${dirPath}`); // Keep it less verbose
    } catch (error) {
        if (error.code === 'ENOENT') {
            // Directory does not exist, create it
            try {
                await fs.mkdir(dirPath, { recursive: true });
                console.log(`Directory created: ${dirPath}`);
            } catch (mkdirError) {
                console.error(`Error creating directory ${dirPath}:`, mkdirError);
                throw mkdirError; // Re-throw to be caught by caller
            }
        } else {
            // Other error accessing directory (e.g., permissions)
            console.error(`Error checking directory ${dirPath}:`, error);
            throw error; // Re-throw to be caught by caller
        }
    }
};

// --- HLS Conversion Function ---
const convertToHls = (inputPath, videoId, authorizationToken) => {
    // Input validation
    if (!inputPath || !videoId) {
        return Promise.reject(new Error('Missing required arguments: inputPath and videoId.'));
    }

    return new Promise(async (resolve, reject) => {
        const outputDir = path.join(PROCESSED_DIR_UTILS, videoId);
        try {
            await ensureDirExists(outputDir);
        } catch (err) {
            // Error already logged in ensureDirExists
            return reject(new Error(`Failed to ensure output directory exists: ${outputDir}`));
        }

        // --- Get Original Video Info ---
        let originalWidth, originalHeight, originalBitrateStr; // Use string for bitrate initially
        try {
            const metadata = await new Promise((resolveMeta, rejectMeta) => {
                ffmpeg.ffprobe(inputPath, (err, data) => {
                    // Handle ffprobe specific errors
                    if (err) {
                        console.error(`[${videoId}] ffprobe error:`, err.message);
                        // Provide more context if available in stderr
                        if (err.stderr) console.error(`[${videoId}] ffprobe stderr:`, err.stderr);
                        return rejectMeta(new Error(`ffprobe failed: ${err.message}`));
                    }
                    if (!data || !data.streams) {
                        return rejectMeta(new Error('Invalid metadata returned by ffprobe.'));
                    }
                    resolveMeta(data);
                });
            });

            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            if (!videoStream) {
                throw new Error('No video stream found in the input file.');
            }

            originalWidth = videoStream.width;
            originalHeight = videoStream.height;

            // Get bitrate and format it as string like '5000k'
            const numericBitrate = parseInt(videoStream.bit_rate || metadata.format.bit_rate);
            if (!isNaN(numericBitrate) && numericBitrate > 0) {
                originalBitrateStr = `${Math.round(numericBitrate / 1000)}k`;
            } else {
                 console.warn(`[${videoId}] Could not determine original bitrate from metadata, defaulting to 5000k.`);
                 originalBitrateStr = '5000k'; // Default if probe fails
            }

            console.log(`[${videoId}] Original resolution: ${originalWidth}x${originalHeight}, Bitrate: ${originalBitrateStr}`);

            if (!originalWidth || !originalHeight) {
                // This condition might be redundant if videoStream is required, but safe to keep
                throw new Error('Could not determine original video dimensions.');
            }
        } catch (err) {
            console.error(`[${videoId}] Error probing video metadata:`, err);
            // Ensure the specific error message is propagated
            return reject(new Error(`Failed to get video metadata: ${err.message || err}`));
        }

        // --- Define Resolutions ---
        const targetResolutions = [
            // Add standard resolutions only if they are smaller than the original
            { name: '480p', size: '854x480', bitrate: '800k', width: 854, height: 480 },
            { name: '720p', size: '1280x720', bitrate: '1500k', width: 1280, height: 720 }
        ].filter(res => res.width <= originalWidth && res.height <= originalHeight);

        // Always include original resolution if dimensions are valid
        const originalResName = `${originalHeight}p`;
        // Check if original resolution already matches one of the filtered standard ones
        const alreadyIncluded = targetResolutions.some(res => res.height === originalHeight);
        if (!alreadyIncluded && originalWidth && originalHeight) {
             targetResolutions.push({
                 name: originalResName,
                 size: `${originalWidth}x${originalHeight}`,
                 bitrate: originalBitrateStr, // Use the determined original bitrate string
                 width: originalWidth,
                 height: originalHeight,
                 isOriginal: true
             });
        }

        // Sort resolutions by height (ascending) for convention
        targetResolutions.sort((a, b) => a.height - b.height);

        // Check if any resolutions are left after filtering
        if (targetResolutions.length === 0) {
            console.error(`[${videoId}] No suitable target resolutions found for original size ${originalWidth}x${originalHeight}.`);
            return reject(new Error('No suitable target resolutions to process.'));
        }
        console.log(`[${videoId}] Target resolutions to process:`, targetResolutions.map(r => r.name));


        // Use the full path in the master playlist to match Backblaze structure
        const baseUrlPath = `${videoId}/`; // This matches the folder structure in Backblaze
        let masterPlaylistContent = '#EXTM3U\n#EXT-X-VERSION:3\n';
        const processingPromises = [];

        // --- Process Each Resolution ---
        targetResolutions.forEach(res => {
            const resOutputDir = path.join(outputDir, res.name);
            // LOCAL path for ffmpeg output m3u8 file for this specific resolution
            const playlistPath = path.join(resOutputDir, 'playlist.m3u8');
            // Calculate bandwidth, handle potential NaN from bitrate string parsing
            let bandwidth = parseInt(String(res.bitrate).replace('k', '')) * 1000;
            if (isNaN(bandwidth) || bandwidth <= 0) {
                 console.warn(`[${videoId}] Invalid bandwidth for ${res.name} (${res.bitrate}), defaulting to 500000`);
                 bandwidth = 500000; // Sensible default
            }

            // --- *** MODIFICATION START *** ---
            // Construct the URL path for the master playlist entry
            let playlistUrlInMaster = `${baseUrlPath}${res.name}/playlist.m3u8`;
            // If an authorizationToken exists, append it as a query parameter
            if (authorizationToken) {
                // IMPORTANT: Encode the token value to handle special characters in URLs
                playlistUrlInMaster += `?authorizationToken=${encodeURIComponent(authorizationToken)}`;
            }
            // Add the line to the master playlist content using the potentially modified URL
            masterPlaylistContent += `#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=${bandwidth},RESOLUTION=${res.size}\n${playlistUrlInMaster}\n`;
            // --- *** MODIFICATION END *** ---


            const promise = new Promise(async (resResolve, resReject) => {
                try {
                    await ensureDirExists(resOutputDir);
                } catch (err) {
                     console.error(`[${videoId}] Failed to ensure resolution directory exists: ${resOutputDir}`, err);
                     // Reject this specific resolution's promise
                     return resReject(new Error(`Failed to create directory for ${res.name}: ${err.message}`));
                }


                let command = ffmpeg(inputPath)
                                .native('-loglevel error'); // Reduce ffmpeg verbosity

                // Calculate reasonable maxrate and bufsize based on bitrate
                const numericBitrateK = parseInt(String(res.bitrate).replace('k', ''));
                 // Ensure maxrate/bufsize are calculated correctly even with default bandwidth
                 const calcBitrateK = !isNaN(numericBitrateK) && numericBitrateK > 0 ? numericBitrateK : (bandwidth/1000);
                const maxrate = Math.floor(calcBitrateK * 1.2); // e.g., 120% of target bitrate
                const bufsize = Math.floor(calcBitrateK * 1.5); // e.g., 150% of target bitrate

                if (res.isOriginal) {
                    console.log(`[${videoId}] Segmenting original resolution (${res.name}) by copying streams.`);
                    command = command.outputOptions([
                        '-c:v copy',              // Copy video stream without re-encoding
                        '-c:a copy',              // Copy audio stream without re-encoding
                        '-hls_time 10',           // Target segment duration (seconds)
                        '-hls_list_size 0',       // Keep all segments in the playlist (for VOD)
                        '-hls_playlist_type vod', // Indicate Video on Demand playlist
                        '-hls_flags independent_segments', // Helps with player compatibility/seeking
                        // Ensure path separator is correct for the OS, use path.join
                        `-hls_segment_filename ${path.join(resOutputDir, 'segment%03d.ts')}`
                    ]);
                } else {
                    console.log(`[${videoId}] Re-encoding to ${res.name} (${res.size} @ ${res.bitrate}).`);
                    command = command.outputOptions([
                        `-vf scale=${res.size}`, // Video filter for scaling
                        `-c:a aac`, `-ar 48000`, `-b:a 128k`, // Audio codec, sample rate, bitrate
                        `-c:v h264`, `-profile:v main`, `-crf 20`, `-preset medium`, // Video codec, profile, quality (CRF), encoding speed preset
                        `-sc_threshold 0`,        // Disable scene detection changes for GOP structure
                        `-g 48`, `-keyint_min 48`, // GOP size (frames per keyframe interval) - relates to hls_time
                        `-hls_time 10`,           // Target segment duration (seconds)
                        '-hls_list_size 0',       // Keep all segments (VOD)
                        '-hls_playlist_type vod', // VOD playlist
                        '-hls_flags independent_segments',
                        `-b:v ${res.bitrate}`,    // Target video bitrate
                        `-maxrate ${maxrate}k`,   // Maximum video bitrate constraint
                        `-bufsize ${bufsize}k`,   // Decoder buffer size constraint
                         // Ensure path separator is correct for the OS, use path.join
                        `-hls_segment_filename ${path.join(resOutputDir, 'segment%03d.ts')}`
                    ]);
                }

                command
                    .output(playlistPath) // Specify the output M3U8 file for THIS resolution
                    .on('start', (commandLine) => console.log(`[${videoId}][${res.name}] Start. Cmd: ${commandLine}`))
                    .on('progress', (progress) => {
                        // Throttle progress logs to avoid excessive output
                        const percent = progress.percent ? progress.percent.toFixed(2) : 'N/A';
                        // Basic throttling example: log every ~10% or if specific frames reported
                        if (progress.percent && (Math.floor(progress.percent) % 10 === 0)) {
                             console.log(`[${videoId}][${res.name}] Progress: ${percent}%`);
                        } else if (!progress.percent && progress.frames && progress.frames % 100 === 0) { // Log every 100 frames if no percentage
                             console.log(`[${videoId}][${res.name}] Progress: Frame ${progress.frames}`);
                        }
                    })
                    .on('end', () => {
                        console.log(`[${videoId}][${res.name}] Finished processing.`);
                        resResolve(); // Resolve this resolution's promise
                    })
                    .on('error', (err, stdout, stderr) => { // Capture stdout/stderr for detailed errors
                        console.error(`[${videoId}][${res.name}] Error processing:`, err.message);
                        // Log ffmpeg's output for debugging if available
                        if (stdout) console.error(`[${videoId}][${res.name}] FFMpeg stdout:\n${stdout}`);
                        if (stderr) console.error(`[${videoId}][${res.name}] FFMpeg stderr:\n${stderr}`);
                        // Reject this resolution's promise with a more informative error
                        resReject(new Error(`FFmpeg failed for ${res.name}: ${err.message}`));
                    })
                    .run();
            });
            processingPromises.push(promise);
        });

        // --- Wait for all resolutions and finalize ---
        try {
            // Wait for all ffmpeg commands to complete (or fail)
            const results = await Promise.allSettled(processingPromises);

            // Check if any resolution failed
            const errors = results.filter(result => result.status === 'rejected');
            if (errors.length > 0) {
                errors.forEach(errorResult => {
                    // The error is already logged in the 'error' event handler,
                    // but we can log a summary here.
                    console.error(`[${videoId}] Summary: Resolution processing step failed. Reason:`, errorResult.reason.message || errorResult.reason);
                });
                // Reject the main promise if any resolution failed
                throw new Error(`HLS conversion failed for ${errors.length} resolution(s).`);
            }

            // Write the master playlist file only if ALL resolutions succeeded
            const masterPlaylistPath = path.join(outputDir, 'master.m3u8');
            // Ensure final content has a newline
            const finalMasterPlaylistContent = masterPlaylistContent.endsWith('\n') ? masterPlaylistContent : masterPlaylistContent + '\n';
            await fs.writeFile(masterPlaylistPath, finalMasterPlaylistContent);
            console.log(`[${videoId}] Master playlist created successfully: ${masterPlaylistPath}`);

            // --- Construct the final Backblaze URL ---
            // Consider making the base URL configurable (e.g., via environment variable)
            const backblazeBaseUrl = process.env.BACKBLAZE_PUBLIC_URL || 'https://f005.backblazeb2.com/file/cloud-video-store/';
            const masterPlaylistUrl = `${backblazeBaseUrl}${videoId}/master.m3u8`;
            // Note: The token is NOT added to this master URL itself here.
            // It's added to the links *inside* the master playlist file content.

            resolve({
                message: `HLS conversion successful for ${targetResolutions.length} resolution(s).`,
                masterPlaylistUrl: masterPlaylistUrl,
                processedResolutions: targetResolutions.map(r => r.name)
            });

        } catch (error) { // Catches errors from Promise.allSettled check or fs.writeFile
            console.error(`[${videoId}] Error during HLS conversion finalization:`, error);
            // Consider cleanup of partially generated files if needed
            reject(error); // Reject the main promise
        }
    });
};

module.exports = {
    ensureDirExists,
    convertToHls,
    // Constants if needed by other modules
    PROCESSED_DIR: PROCESSED_DIR_UTILS,
    VIDEOS_DIR: VIDEOS_DIR_UTILS
};